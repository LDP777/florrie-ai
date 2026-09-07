import { it, expect, vi, beforeEach } from 'vitest';
const state = vi.hoisted(() => ({ delivered: true, learn: vi.fn(), events: [] }));
vi.mock('../../src/services/ai-front-desk.js', () => ({ learnFromCorrection: (...args) => state.learn(...args), generateReplySuggestions: vi.fn(), replyIsOwed: vi.fn() }));
vi.mock('../../src/services/messaging.js', () => ({
  shapeMessage: x => x,
  sendOnChannel: async () => { state.events.push('sent'); return state.delivered ? { ok: true, message: { id: 'sent' } } : { ok: false, status: 503, error: 'Provider unavailable' }; },
}));
vi.mock('../../src/config.js', () => ({ supabase: { from: () => ({ insert: () => Promise.resolve({ error: null }) }) } }));
const { default: router } = await import('../../src/routes/inbox.js');
const handler = router.stack.find(l => l.route?.path === '/send' && l.route.methods.post).route.stack.at(-1).handle;
async function send() {
  const result = { status: 200 };
  const res = { status(code) { result.status = code; return res; }, json(body) { state.events.push('responded'); result.body = body; return res; } };
  await handler({ beautician: { id: 'owner' }, body: { client_id: 'client', channel: 'sms', body: 'hey lovely, see you soon xx', draft_text: 'Hello lovely, see you soon.' } }, res);
  return result;
}
beforeEach(() => { state.delivered = true; state.learn.mockReset(); state.events = []; });
it('finishes delivery and responds while learning is still waiting', async () => {
  state.learn.mockImplementation(() => { state.events.push('learning'); return new Promise(() => {}); });
  const result = await send();
  expect(result.body.ok).toBe(true);
  expect(state.events).toEqual(['sent', 'responded', 'learning']);
});
it('a learning outage does not turn a delivered reply into a failed send', async () => {
  state.learn.mockRejectedValue(new Error('Database unavailable'));
  const result = await send();
  expect(result.status).toBe(200); expect(result.body.ok).toBe(true);
});
it('does not learn from a draft that failed to send', async () => {
  state.delivered = false;
  const result = await send();
  expect(result.status).toBe(503); expect(state.learn).not.toHaveBeenCalled();
});
