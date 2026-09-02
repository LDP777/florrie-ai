/**
 * Inbound webhooks fail closed when their secret is unset.
 *
 * Until 2 September 2026 all four inbound handlers (WhatsApp, Twilio SMS, Bird
 * SMS, Instagram) did the same thing: verify if the secret was set, and if it
 * was not, warn and process the payload anyway. Rejecting was opt-in through
 * a flag that was set nowhere, not in the repo and not in the deploy docs, so
 * in production a missing secret meant anybody who found the URL could feed
 * processInboundMessage a fake client message and have Florrie reply to it,
 * on the salon's number, at the salon's expense.
 *
 * The contract now: no secret means 503, unless WEBHOOK_ALLOW_UNSIGNED=true is
 * set explicitly for local development. These tests read the source so that
 * the old flag cannot quietly come back, and so that "processing unsigned"
 * never again describes a default.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => readFileSync(path.resolve(here, '../../src', rel), 'utf8');

const webhooks = src('routes/webhooks.js');
const instagram = src('routes/instagram-webhooks.js');

/** The body of one router.post handler, from its opening line to the next route. */
function handlerSource(file, route) {
  const start = file.indexOf(`router.post('${route}'`);
  if (start < 0) throw new Error(`no handler for ${route}`);
  const next = file.indexOf('\nrouter.', start + 1);
  return file.slice(start, next < 0 ? undefined : next);
}

const handlers = {
  whatsapp: handlerSource(webhooks, '/whatsapp'),
  twilio: handlerSource(webhooks, '/twilio-sms'),
  bird: handlerSource(webhooks, '/bird-sms'),
  instagram: handlerSource(instagram, '/'),
};

describe('the old opt-in flag is gone', () => {
  it('no source file mentions WEBHOOK_STRICT', () => {
    expect(webhooks).not.toContain('WEBHOOK_STRICT');
    expect(instagram).not.toContain('WEBHOOK_STRICT');
  });
});

describe('each handler has the explicit opt-out and nothing else', () => {
  for (const [name, body] of Object.entries(handlers)) {
    it(`${name}: reads WEBHOOK_ALLOW_UNSIGNED`, () => {
      expect(body).toContain("process.env.WEBHOOK_ALLOW_UNSIGNED === 'true'");
    });

    it(`${name}: unsigned processing is not a default path`, () => {
      expect(body).not.toMatch(/processing unsigned/);
      expect(body).not.toMatch(/processing unauthenticated/);
    });

    it(`${name}: the no-secret branch returns 503`, () => {
      // The opt-out branch must be immediately followed by the reject branch,
      // and that branch must be a 503, so there is no third way through.
      const optOut = body.indexOf("process.env.WEBHOOK_ALLOW_UNSIGNED === 'true'");
      const after = body.slice(optOut);
      const elseAt = after.indexOf('} else {');
      expect(elseAt).toBeGreaterThan(0);
      const rejectBranch = after.slice(elseAt, after.indexOf('\n  }\n', elseAt));
      expect(rejectBranch).toContain('res.status(503)');
    });
  }

  it('whatsapp: records the 503_no_secret hit so _debug-hits shows the reason', () => {
    expect(handlers.whatsapp).toContain("result: '503_no_secret'");
  });
});

/**
 * Behavioural check on the one handler with the most moving parts: drive the
 * WhatsApp POST with no secret and no opt-out, and confirm nothing downstream
 * runs. The GET verification handshake must keep working regardless, because
 * it authenticates with the verify token, not the app secret.
 */
describe('WhatsApp handler behaviour without a secret', () => {
  it('rejects with 503 and never reaches the processor', async () => {
    vi.resetModules();
    const processed = [];
    vi.doMock('../../src/lib/logger.js', () => ({ default: { info() {}, warn() {}, error() {}, debug() {}, fatal() {} } }));
    vi.doMock('../../src/config.js', () => {
      const b = { select: () => b, eq: () => b, insert: () => b, update: () => b, order: () => b, limit: () => b,
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        then: (r) => Promise.resolve({ data: [], error: null }).then(r) };
      const supabase = { from: () => b };
      return { supabase, supabaseAnon: supabase, supabaseAdmin: supabase };
    });
    vi.doMock('../../src/services/ai-front-desk.js', () => ({ processInboundMessage: async (...a) => { processed.push(a); return { handled: false }; } }));
    vi.doMock('../../src/services/delivery-receipts.js', () => ({ applyWhatsAppStatuses: async () => true }));
    vi.doMock('../../src/services/push-notifications.js', () => ({ pushMessagesWaiting: async () => true }));
    vi.doMock('../../src/lib/client-archive.js', () => ({ autoUnarchiveClient: async () => true }));
    vi.doMock('../../src/middleware/auth.js', () => ({ requireAuth: (_q, _s, next) => next() }));
    vi.doMock('../../src/lib/env.js', () => ({ getAppSecret: () => '', getWhatsAppVerifyToken: () => 'verify-me' }));
    vi.doMock('@anthropic-ai/sdk', () => ({ default: class { constructor() { this.messages = { create: async () => ({ content: [] }) }; } } }));

    delete process.env.WEBHOOK_ALLOW_UNSIGNED;
    const router = (await import('../../src/routes/webhooks.js')).default;

    const run = async (method, url, req) => {
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

    const post = await run('post', '/whatsapp', {
      body: {
        entry: [{
          changes: [{
            value: { messages: [{ from: '447900000001', text: { body: 'hi' } }], metadata: { phone_number_id: 'p1' } },
          }],
        }],
      },
    });
    expect(post.status).toBe(503);
    expect(post.sent).toBeNull();
    expect(processed).toHaveLength(0);

    const get = await run('get', '/whatsapp', {
      query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': 'abc123' },
    });
    expect(get.status).toBe(200);
    expect(get.body).toBe('abc123');
  });
});
