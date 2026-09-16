import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../src/config.js',()=>({supabase:{}}));
import { applyWhatsAppLifecycle } from '../../src/services/whatsapp-lifecycle.js';
const now=Date.parse('2026-09-16T10:00:00Z');
const event=()=>({object:'whatsapp_business_account',entry:[{id:'300',time:Math.floor(now/1000),changes:[{field:'account_update',value:{event:'PARTNER_REMOVED',waba_info:{waba_id:'300'}}}]}]});
let db;
beforeEach(()=>{db={rpc:vi.fn(async()=>({data:{confirmation_code:'a'.repeat(48)}}))};});
it('processes removal events in every entry before returning',async()=>{
  const payload=event();payload.entry.unshift({id:'irrelevant',changes:[{field:'messages'}]});
  expect(await applyWhatsAppLifecycle(payload,db,now)).toBe(1);
  expect(db.rpc).toHaveBeenCalledWith('request_whatsapp_data_action',expect.objectContaining({p_kind:'waba',p_action:'deauthorize',p_issued_at:'2026-09-16T10:00:00.000Z'}));
  const first=db.rpc.mock.calls[0][1];await applyWhatsAppLifecycle(event(),db,now);expect(db.rpc.mock.calls[1][1].p_event_hash).toBe(first.p_event_hash);
  expect(JSON.stringify(first)).not.toContain('"300"');
});
it('ignores messages, account approval and foreign webhook objects',async()=>{
  const payload=event();payload.entry[0].changes[0].value.event='VERIFIED_ACCOUNT';
  expect(await applyWhatsAppLifecycle(payload,db,now)).toBe(0);
  expect(await applyWhatsAppLifecycle({...event(),object:'instagram'},db,now)).toBe(0);
  expect(db.rpc).not.toHaveBeenCalled();
});
it.each(['missing-time','future-time','bad-account','conflicting-account'])('rejects %s instead of guessing a current connection',async reason=>{
  const payload=event();
  if(reason==='missing-time')delete payload.entry[0].time;
  if(reason==='future-time')payload.entry[0].time+=600;
  if(reason==='bad-account')payload.entry[0].id='not-an-id';
  if(reason==='conflicting-account')payload.entry[0].changes[0].value.waba_info.waba_id='999';
  await expect(applyWhatsAppLifecycle(payload,db,now)).rejects.toThrow('consistent');expect(db.rpc).not.toHaveBeenCalled();
});
it('fails before acknowledgement if the atomic action cannot be saved',async()=>{
  db.rpc.mockResolvedValue({error:{message:'private database error'}});
  await expect(applyWhatsAppLifecycle(event(),db,now)).rejects.toThrow('could not be saved');
});
