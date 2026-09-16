import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
const fake = { rpc: vi.fn() };
  async function loadRouter() {
    vi.resetModules();
    const processed = [];
    vi.doMock('../../src/lib/logger.js', () => ({ default: { info() {}, warn() {}, error() {}, debug() {}, fatal() {} } }));
    vi.doMock('../../src/config.js', () => {
      const b = { select: () => b, eq: () => b, insert: () => b, update: () => b, order: () => b, limit: () => b,
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        then: (r) => Promise.resolve({ data: [], error: null }).then(r) };
      const supabase = { from: () => b, rpc: fake.rpc };
      return { supabase, supabaseAnon: supabase, supabaseAdmin: supabase };
    });
    vi.doMock('../../src/services/ai-front-desk.js', () => ({ processInboundMessage: async (...a) => { processed.push(a); return { handled: false }; } }));
    vi.doMock('../../src/services/delivery-receipts.js', () => ({ applyWhatsAppStatuses: async () => true }));
    vi.doMock('../../src/services/push-notifications.js', () => ({ pushMessagesWaiting: async () => true }));
    vi.doMock('../../src/lib/client-archive.js', () => ({ autoUnarchiveClient: async () => true }));
    vi.doMock('../../src/middleware/auth.js', () => ({ requireAuth: (_q, _s, next) => next() }));
    vi.doMock('../../src/lib/env.js', () => ({ getAppSecret: () => process.env.WHATSAPP_APP_SECRET, getWhatsAppVerifyToken: () => 'verify-me' }));
    vi.doMock('@anthropic-ai/sdk', () => ({ default: class { constructor() { this.messages = { create: async () => ({ content: [] }) }; } } }));


    const router = (await import('../../src/routes/webhooks.js')).default;
    return { router, processed };
  }

  const run = async (router, method, url, req) => {
      const layer = router.stack.find(l => l.route?.path === url && l.route.methods[method]);
      const handler = layer.route.stack[layer.route.stack.length - 1].handle;
      const out = { status: 200, body: null, sent: null };
      const res = {
        status(c) { out.status = c; return res; },
        json(p) { out.body = p; return res; },
        send(p) { out.body = p; return res; },
        sendStatus(c) { out.sent = c; return res; },
      };
      await handler({ headers: {}, query: {}, body: {}, params: {}, ...req }, res);
      return out;
  };


const payload={object:'whatsapp_business_account',entry:[{id:'900',time:Math.floor(Date.now()/1000),changes:[{field:'account_update',value:{event:'PARTNER_REMOVED',waba_info:{waba_id:'300'}}}]}]};
const uninstall=(partner='777')=>{
  const body=structuredClone(payload);const value=body.entry[0].changes[0].value;
  value.event='PARTNER_APP_UNINSTALLED';value.waba_info.partner_app_id=partner;return body;
};
const req=(body=payload)=>({body,rawBody:Buffer.from(JSON.stringify(body)),headers:{'x-hub-signature-256':'sha256='+createHmac('sha256','test-secret').update(JSON.stringify(body)).digest('hex')}});
beforeEach(()=>{vi.stubEnv('WHATSAPP_TENANT_CREDENTIALS_ENABLED','true');vi.stubEnv('WHATSAPP_APP_SECRET','test-secret');vi.stubEnv('WHATSAPP_APP_ID','777');fake.rpc.mockReset();fake.rpc.mockResolvedValue({data:{confirmation_code:'a'.repeat(48)}});});
afterEach(()=>vi.unstubAllEnvs());
it.each(['removed','uninstalled'])('saves signed %s revocation before a successful acknowledgement',async type=>{
  const {router,processed}=await loadRouter();const out=await run(router,'post','/whatsapp',req(type==='uninstalled'?uninstall():payload));
  expect(fake.rpc).toHaveBeenCalledOnce();expect(out.sent).toBe(200);expect(processed).toHaveLength(0);
});
it.each(['removed','uninstalled'])('returns a retryable response without an acknowledgement when %s storage fails',async type=>{
  fake.rpc.mockResolvedValue({error:{message:'private database error'}});
  const {router}=await loadRouter();const out=await run(router,'post','/whatsapp',req(type==='uninstalled'?uninstall():payload));
  expect(out.status).toBe(503);expect(out.sent).toBeNull();expect(JSON.stringify(out)).not.toContain('private');
});
it.each(['removed','uninstalled'])('rejects forged %s lifecycle events before any database action',async type=>{
  const {router}=await loadRouter();const out=await run(router,'post','/whatsapp',{...req(type==='uninstalled'?uninstall():payload),headers:{'x-hub-signature-256':'sha256=wrong'}});
  expect(out.status).toBe(403);expect(fake.rpc).not.toHaveBeenCalled();
});
it.each(['removed','uninstalled'])('never accepts unsigned %s revocation in development grace mode',async type=>{
  vi.stubEnv('WHATSAPP_APP_SECRET','');vi.stubEnv('WEBHOOK_ALLOW_UNSIGNED','true');vi.stubEnv('NODE_ENV','development');
  const {router}=await loadRouter();const out=await run(router,'post','/whatsapp',{body:type==='uninstalled'?uninstall():payload});
  expect(out.status).toBe(503);expect(fake.rpc).not.toHaveBeenCalled();
});
it.each(['removed','uninstalled'])('preserves the legacy handler for %s when tenant mode is disabled',async type=>{
  vi.stubEnv('WHATSAPP_TENANT_CREDENTIALS_ENABLED','false');
  const {router}=await loadRouter();const out=await run(router,'post','/whatsapp',req(type==='uninstalled'?uninstall():payload));
  expect(out.sent).toBe(200);expect(fake.rpc).not.toHaveBeenCalled();
});
it('acknowledges another app uninstall without touching this connection',async()=>{
  const {router}=await loadRouter();const out=await run(router,'post','/whatsapp',req(uninstall('888')));
  expect(out.sent).toBe(200);expect(fake.rpc).not.toHaveBeenCalled();
});
it('uses the configured Meta app alias when no WhatsApp-specific app ID exists',async()=>{
  vi.stubEnv('WHATSAPP_APP_ID','');vi.stubEnv('META_APP_ID','777');
  const {router}=await loadRouter();const out=await run(router,'post','/whatsapp',req(uninstall()));
  expect(out.sent).toBe(200);expect(fake.rpc).toHaveBeenCalledOnce();
});
it('keeps uninstall retryable if the receiving app identity is not configured',async()=>{
  vi.stubEnv('WHATSAPP_APP_ID','');vi.stubEnv('META_APP_ID','');
  const {router}=await loadRouter();const out=await run(router,'post','/whatsapp',req(uninstall()));
  expect(out.status).toBe(503);expect(out.sent).toBeNull();expect(fake.rpc).not.toHaveBeenCalled();
});
