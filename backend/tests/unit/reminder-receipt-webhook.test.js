import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
const fake = vi.hoisted(() => ({ rpc:vi.fn(), fallback:vi.fn(), applied:vi.fn(), order:[] }));
vi.mock('../../src/config.js', () => {
  const q = { select:()=>q,eq:()=>q,insert:()=>q,update:()=>q,order:()=>q,limit:()=>q,
    maybeSingle:async()=>({data:null}),single:async()=>({data:null}),then:r=>Promise.resolve({data:[]}).then(r) };
  const db = {from:()=>q,rpc:fake.rpc}; return {supabase:db,supabaseAdmin:db,supabaseAnon:db};
});
vi.mock('../../src/lib/logger.js', () => ({default:{info(){},warn(){},error(){},debug(){}}}));
vi.mock('../../src/lib/env.js', () => ({getAppSecret:()=>process.env.WHATSAPP_APP_SECRET,getWhatsAppVerifyToken:()=>''}));
vi.mock('../../src/services/ai-front-desk.js', () => ({processInboundMessage:vi.fn()}));
vi.mock('../../src/services/push-notifications.js', () => ({pushMessagesWaiting:vi.fn()}));
vi.mock('../../src/services/delivery-receipts.js', () => ({applyWhatsAppStatuses:fake.applied}));
vi.mock('../../src/services/notifications.js', () => ({isSharedSmsNumber:()=>false,sendWhatsAppText:vi.fn(),sendSMS:vi.fn(),learnPhoneParentWaba:vi.fn(),retryReminderSms:fake.fallback}));
vi.mock('@anthropic-ai/sdk', () => ({default:class {}}));
const router = (await import('../../src/routes/webhooks.js')).default;
const handler = router.stack.find(layer=>layer.route?.path==='/whatsapp'&&layer.route.methods.post).route.stack.at(-1).handle;
const payload = {entry:[{changes:[{value:{statuses:[{id:'one',status:'failed'}]}}]},{changes:[{value:{statuses:[{id:'two',status:'delivered'}]}}]}]};
async function call({forged=false}={}) {
  const rawBody=Buffer.from(JSON.stringify(payload));
  const signature='sha256='+createHmac('sha256',forged?'forged':'secret').update(rawBody).digest('hex');
  const result={status:null};
  const res={status(n){result.status=n;return res;},json(){return res;},sendStatus(n){result.status=n;fake.order.push('ack');return res;}};
  await handler({body:payload,rawBody,headers:{'x-hub-signature-256':signature}},res); return result;
}
beforeEach(()=>{
  vi.stubEnv('WHATSAPP_APP_SECRET','secret'); vi.stubEnv('WHATSAPP_TENANT_CREDENTIALS_ENABLED','false');
  fake.order.length=0; fake.rpc.mockReset();fake.fallback.mockReset();fake.applied.mockReset();
  fake.rpc.mockImplementation(async()=>{fake.order.push('save');return {data:null,error:null};});
  fake.fallback.mockImplementation(async()=>{fake.order.push('fallback');});
});
afterEach(()=>vi.unstubAllEnvs());
it('stores every signed batch entry before acknowledging and attempts fallback after acknowledgement',async()=>{
  expect((await call()).status).toBe(200);
  expect(fake.rpc.mock.calls.map(([,args])=>args.p_message_id)).toEqual(['one','two']);
  expect(fake.order).toEqual(['save','save','ack','fallback']);
  expect(fake.fallback).toHaveBeenCalledWith(['one','two']);
});
it('returns a retryable failure when receipt storage fails, with no SMS attempt',async()=>{
  fake.rpc.mockResolvedValue({error:{message:'database unavailable'}});
  expect((await call()).status).toBe(503);expect(fake.fallback).not.toHaveBeenCalled();expect(fake.order).not.toContain('ack');
});
it('cannot trigger SMS with a forged delivery receipt',async()=>{
  expect((await call({forged:true})).status).toBe(403);expect(fake.rpc).not.toHaveBeenCalled();expect(fake.fallback).not.toHaveBeenCalled();
});
it('cannot trigger SMS from an unsigned development-grace webhook',async()=>{
  vi.stubEnv('WHATSAPP_APP_SECRET','');vi.stubEnv('NODE_ENV','development');
  expect((await call()).status).toBe(503);expect(fake.rpc).not.toHaveBeenCalled();expect(fake.fallback).not.toHaveBeenCalled();
});
