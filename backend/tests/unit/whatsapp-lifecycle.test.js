import { beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
vi.mock('../../src/config.js',()=>({supabase:{}}));
import { applyWhatsAppLifecycle } from '../../src/services/whatsapp-lifecycle.js';
const now=Date.parse('2026-09-16T10:00:00Z');
const event=()=>({object:'whatsapp_business_account',entry:[{id:'900',time:Math.floor(now/1000),changes:[{field:'account_update',value:{event:'PARTNER_REMOVED',waba_info:{waba_id:'300'}}}]}]});
const hash=id=>createHash('sha256').update('whatsapp:waba:'+id).digest('hex');
let db;
beforeEach(()=>{db={rpc:vi.fn(async()=>({data:{confirmation_code:'a'.repeat(48)}}))};});
it('processes removal events in every entry before returning',async()=>{
  const payload=event();payload.entry.unshift({id:'irrelevant',changes:[{field:'messages'}]});
  expect(await applyWhatsAppLifecycle(payload,db,now)).toBe(1);
  expect(db.rpc).toHaveBeenCalledWith('request_whatsapp_data_action',expect.objectContaining({p_account_hash:hash('300'),p_kind:'waba',p_action:'deauthorize',p_issued_at:'2026-09-16T10:00:00.000Z'}));
  const first=db.rpc.mock.calls[0][1];await applyWhatsAppLifecycle(event(),db,now);expect(db.rpc.mock.calls[1][1].p_event_hash).toBe(first.p_event_hash);
  expect(JSON.stringify(first)).not.toContain('"300"');
});
it('ignores messages, account approval and foreign webhook objects',async()=>{
  const payload=event();payload.entry[0].changes[0].value.event='VERIFIED_ACCOUNT';
  expect(await applyWhatsAppLifecycle(payload,db,now)).toBe(0);
  expect(await applyWhatsAppLifecycle({...event(),object:'instagram'},db,now)).toBe(0);
  expect(db.rpc).not.toHaveBeenCalled();
});
it.each(['missing-time','future-time','bad-envelope','missing-customer','bad-customer','unsafe-numeric-customer'])('rejects %s instead of guessing a current connection',async reason=>{
  const payload=event();
  if(reason==='missing-time')delete payload.entry[0].time;
  if(reason==='future-time')payload.entry[0].time+=600;
  if(reason==='bad-envelope')payload.entry[0].id='not-an-id';
  if(reason==='missing-customer')delete payload.entry[0].changes[0].value.waba_info;
  if(reason==='bad-customer')payload.entry[0].changes[0].value.waba_info.waba_id='not-an-id';
  if(reason==='unsafe-numeric-customer')payload.entry[0].changes[0].value.waba_info.waba_id=Number.MAX_SAFE_INTEGER+1;
  await expect(applyWhatsAppLifecycle(payload,db,now)).rejects.toThrow('valid customer');expect(db.rpc).not.toHaveBeenCalled();
});
it('fails before acknowledgement if the atomic action cannot be saved',async()=>{
  db.rpc.mockResolvedValue({error:{message:'private database error'}});
  await expect(applyWhatsAppLifecycle(event(),db,now)).rejects.toThrow('could not be saved');
});

// Meta account_update reference, updated 21 May 2026. These exact example IDs
// establish that entry.id is not the affected customer's WABA for partner events.
// https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update
it.each([
  ['PARTNER_REMOVED', {waba_id:'980198427658004',owner_business_id:'2329417887457253'}],
  ['PARTNER_APP_UNINSTALLED', {waba_id:'184943124712545',owner_business_id:'1284923862322270',partner_app_id:'869361281603019'}],
])('routes the documented %s example by customer WABA, retaining its original timestamp',async(type,info)=>{
  const payload={object:'whatsapp_business_account',entry:[{id:'2949482758682047',time:1748477359,changes:[{field:'account_update',value:{event:type,waba_info:info}}]}]};
  expect(await applyWhatsAppLifecycle(payload,db,now,'869361281603019')).toBe(1);
  const args=db.rpc.mock.calls[0][1];
  expect(args.p_account_hash).toBe(hash(info.waba_id));
  expect(args.p_account_hash).not.toBe(hash(payload.entry[0].id));
  expect(args.p_account_hash).not.toBe(hash(info.owner_business_id));
  expect(args.p_issued_at).toBe(new Date(1748477359*1000).toISOString());
  await applyWhatsAppLifecycle(payload,db,now,'869361281603019');
  expect(db.rpc.mock.calls[1][1].p_event_hash).toBe(args.p_event_hash);
});
const uninstall=(partner='777')=>{
  const payload=event();const value=payload.entry[0].changes[0].value;
  value.event='PARTNER_APP_UNINSTALLED';value.waba_info.partner_app_id=partner;return payload;
};
it('ignores another partner uninstall even on the same WABA',async()=>{
  expect(await applyWhatsAppLifecycle(uninstall('888'),db,now,'777')).toBe(0);
  expect(db.rpc).not.toHaveBeenCalled();
});
it.each(['missing-partner','missing-own-app','bad-partner'])('does not guess app identity for %s',async reason=>{
  const payload=uninstall();
  if(reason==='missing-partner')delete payload.entry[0].changes[0].value.waba_info.partner_app_id;
  if(reason==='bad-partner')payload.entry[0].changes[0].value.waba_info.partner_app_id='not-an-id';
  await expect(applyWhatsAppLifecycle(payload,db,now,reason==='missing-own-app'?'':'777')).rejects.toThrow('app identity');
  expect(db.rpc).not.toHaveBeenCalled();
});
it('handles mixed partner events without revoking for a foreign app',async()=>{
  const payload=event();payload.entry.push(...uninstall('888').entry,...uninstall('777').entry);
  expect(await applyWhatsAppLifecycle(payload,db,now,'777')).toBe(2);
  expect(db.rpc).toHaveBeenCalledTimes(2);
  expect(db.rpc.mock.calls[0][1].p_event_hash).not.toBe(db.rpc.mock.calls[1][1].p_event_hash);
});
