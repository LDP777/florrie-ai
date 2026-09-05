import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ clients: [], messages: [], readFailure: false, logFailure: null, sms: vi.fn(), email: vi.fn(), warn: vi.fn() }));
vi.mock('../../src/config.js', () => ({ supabase: { from(table) {
  const filters = []; let inserted;
  const finish = () => {
    if (table === 'clients') return state.readFailure ? { error: { message: 'offline' } } : { data: state.clients.find(c => filters.every(([key, value]) => c[key] === value)) || null, error: null };
    if (state.logFailure === 'throw') throw new Error('connection lost');
    if (state.logFailure === 'error') return { error: { message: 'write failed' } };
    state.messages.push(inserted); return { error: null };
  };
  const q = { select: () => q, eq: (key, value) => { filters.push([key, value]); return q; },
    maybeSingle: async () => finish(), insert: row => { inserted = row; return q; },
    then: (resolve, reject) => Promise.resolve().then(finish).then(resolve, reject),
  };
  return q;
} } }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth: (req, res, next) => next() }));
vi.mock('../../src/middleware/security.js', () => ({ requireCronKey: (req, res, next) => next() }));
vi.mock('../../src/services/notifications.js', () => ({
  sendSMS: (...args) => state.sms(...args), sendEmail: (...args) => state.email(...args),
  processReminders: vi.fn(), readSmsRouting: vi.fn(), smsSchema: {}, splitLegacySmsOriginator: vi.fn(),
  toInboundNumber: vi.fn(), isSharedSmsNumber: vi.fn(), BIRD_CHANNEL_ID_RE: /x/, SHARED_SMS_NUMBERS: [],
}));
vi.mock('../../src/services/sms-metering.js', () => ({ getSMSUsage: vi.fn() }));
vi.mock('../../src/lib/logger.js', () => ({ default: { info: vi.fn(), error: vi.fn(), warn: (...args) => state.warn(...args) } }));
import router from '../../src/routes/notifications.js';
async function remind(body) {
  const req = { body, beautician: { id: 'owner' } };
  const result = { status: 200, body: null };
  const res = { status(code) { result.status = code; return res; }, json(value) { result.body = value; return res; } };
  const route = router.stack.find(layer => layer.route?.path === '/send-reminder').route;
  for (const layer of route.stack) { let next = false; await layer.handle(req, res, () => { next = true; }); if (!next) break; }
  return result;
}
beforeEach(() => {
  state.clients = [
    { id: 'sophie-1', beautician_id: 'owner', first_name: 'Sophie', phone: '+447700900001' },
    { id: 'sophie-2', beautician_id: 'owner', first_name: 'Sophie', phone: '+447700900002' },
    { id: 'foreign', beautician_id: 'other-owner', first_name: 'Sophie', phone: '+447700900003' },
  ];
  state.messages = []; state.readFailure = false; state.logFailure = null;
  state.sms.mockReset().mockResolvedValue({ id: 'bird-message' });
  state.email.mockReset().mockResolvedValue({ id: 'resend-message' }); state.warn.mockReset();
});
describe('Guardian reminder recipient and delivery contract', () => {
  it('requires a client ID, refusing ambiguous duplicate names', async () => {
    expect((await remind({ type: 'patch_test_reminder', client_name: 'Sophie' })).status).toBe(400);
    expect(state.sms).not.toHaveBeenCalled(); expect(state.messages).toEqual([]);
  });
  it('selects the exact salon-owned ID among duplicate names and logs once', async () => {
    const result = await remind({ type: 'patch_test_reminder', client_id: 'sophie-2', message: 'Book your patch test' });
    expect(result.body).toEqual({ success: true, channel: 'sms' });
    expect(state.sms).toHaveBeenCalledWith(expect.objectContaining({ to: '+447700900002', clientId: 'sophie-2', beauticianId: 'owner', skipThreadLog: true }));
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ client_id: 'sophie-2', beautician_id: 'owner', channel: 'sms', content: 'Book your patch test', direction: 'outbound' });
  });
  it('refuses another salon’s client and missing IDs without sending', async () => {
    for (const client_id of ['foreign', 'missing']) expect((await remind({ type: 'patch_test_reminder', client_id })).status).toBe(404);
    expect(state.sms).not.toHaveBeenCalled(); expect(state.email).not.toHaveBeenCalled();
  });
  it('fails closed when the client lookup fails', async () => {
    state.readFailure = true;
    expect((await remind({ type: 'patch_test_reminder', client_id: 'sophie-1' })).status).toBe(503);
    expect(state.sms).not.toHaveBeenCalled();
  });
  it('does not claim to queue a reminder with no contact address', async () => {
    delete state.clients[0].phone;
    const result = await remind({ type: 'patch_test_reminder', client_id: 'sophie-1' });
    expect(result.status).toBe(422); expect(result.body.success).toBe(false);
    expect(state.messages).toEqual([]); expect(state.email).not.toHaveBeenCalled();
  });
  it.each(['sms', 'email'])('does not log a refused %s as sent', async channel => {
    if (channel === 'email') { delete state.clients[0].phone; state.clients[0].email = 'test@example.invalid'; }
    state[channel].mockResolvedValue(null);
    const result = await remind({ type: 'patch_test_reminder', client_id: 'sophie-1' });
    expect(result.status).toBe(502); expect(result.body.success).toBe(false); expect(state.messages).toEqual([]);
  });
  it('logs the accepted email fallback against the same client', async () => {
    delete state.clients[0].phone; state.clients[0].email = 'test@example.invalid';
    const result = await remind({ type: 'patch_test_reminder', client_id: 'sophie-1' });
    expect(result.body).toEqual({ success: true, channel: 'email' }); expect(state.sms).not.toHaveBeenCalled();
    expect(state.messages).toHaveLength(1); expect(state.messages[0]).toMatchObject({ client_id: 'sophie-1', channel: 'email' });
  });
  it.each(['error', 'throw'])('keeps an accepted send successful after a logging %s', async failure => {
    state.logFailure = failure;
    const result = await remind({ type: 'patch_test_reminder', client_id: 'sophie-1' });
    expect(result.status).toBe(200); expect(result.body.success).toBe(true); expect(state.sms).toHaveBeenCalledTimes(1); expect(state.warn).toHaveBeenCalled();
  });
});
