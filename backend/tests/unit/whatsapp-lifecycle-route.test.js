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


const payload={object:'whatsapp_business_account',entry:[{id:'300',time:Math.floor(Date.now()/1000),changes:[{field:'account_update',value:{event:'PARTNER_REMOVED'}}]}]};
const req=(body=payload)=>({body,rawBody:Buffer.from(JSON.stringify(body)),headers:{'x-hub-signature-256':'sha256='+createHmac('sha256','test-secret').update(JSON.stringify(body)).digest('hex')}});
beforeEach(()=>{vi.stubEnv('WHATSAPP_TENANT_CREDENTIALS_ENABLED','true');vi.stubEnv('WHATSAPP_APP_SECRET','test-secret');fake.rpc.mockReset();fake.rpc.mockResolvedValue({data:{confirmation_code:'a'.repeat(48)}});});
afterEach(()=>vi.unstubAllEnvs());
it('saves signed revocation before a successful acknowledgement',async()=>{
  const {router,processed}=await loadRouter();const out=await run(router,'post','/whatsapp',req());
  expect(fake.rpc).toHaveBeenCalledOnce();expect(out.sent).toBe(200);expect(processed).toHaveLength(0);
});
it('returns a retryable response without an acknowledgement when storage fails',async()=>{
  fake.rpc.mockResolvedValue({error:{message:'private database error'}});
  const {router}=await loadRouter();const out=await run(router,'post','/whatsapp',req());
  expect(out.status).toBe(503);expect(out.sent).toBeNull();expect(JSON.stringify(out)).not.toContain('private');
});
it('rejects forged lifecycle events before any database action',async()=>{
  const {router}=await loadRouter();const out=await run(router,'post','/whatsapp',{...req(),headers:{'x-hub-signature-256':'sha256=wrong'}});
  expect(out.status).toBe(403);expect(fake.rpc).not.toHaveBeenCalled();
});
it('never accepts an unsigned revocation in development grace mode',async()=>{
  vi.stubEnv('WHATSAPP_APP_SECRET','');vi.stubEnv('WEBHOOK_ALLOW_UNSIGNED','true');vi.stubEnv('NODE_ENV','development');
  const {router}=await loadRouter();const out=await run(router,'post','/whatsapp',{body:payload});
  expect(out.status).toBe(503);expect(fake.rpc).not.toHaveBeenCalled();
});
it('preserves the legacy handler when tenant mode is disabled',async()=>{
  vi.stubEnv('WHATSAPP_TENANT_CREDENTIALS_ENABLED','false');
  const {router}=await loadRouter();const out=await run(router,'post','/whatsapp',req());
  expect(out.sent).toBe(200);expect(fake.rpc).not.toHaveBeenCalled();
});
