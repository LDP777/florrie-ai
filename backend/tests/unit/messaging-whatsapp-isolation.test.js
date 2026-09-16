import { beforeEach, afterEach, it, expect, vi } from 'vitest';

const state = vi.hoisted(() => ({ connection: null, connectionError: null, inserts: [], filters: [] }));
vi.mock('../../src/config.js', () => ({ supabase: { from(table) {
  const query = {
    select() { return query; },
    eq(key, value) { state.filters.push({ table, key, value }); return query; },
    async maybeSingle() {
      if (table === 'clients') return { data: { id: 'client-1', whatsapp_id: '447700900001' } };
      if (table === 'whatsapp_connections') return { data: state.connection, error: state.connectionError };
      throw new Error('Unexpected table');
    },
    insert(row) { state.inserts.push(row); return query; },
    async single() { return { data: { id: 'message-1', ...state.inserts.at(-1) } }; },
  };
  return query;
} } }));
vi.mock('../../src/services/notifications.js', () => ({ sendSMS: vi.fn(), sendEmail: vi.fn() }));
vi.mock('../../src/lib/logger.js', () => ({ default: { error: vi.fn(), warn: vi.fn() } }));
import { encrypt } from '../../src/lib/crypto.js';
import { sendOnChannel } from '../../src/services/messaging.js';

const salon = { id: 'salon-1', whatsapp_phone_id: 'phone-1' };
const send = () => sendOnChannel({ beautician: salon, clientId: 'client-1', channel: 'whatsapp', body: 'Your appointment is confirmed.' });
function embedded(overrides = {}) {
  return { mode: 'embedded', phone_id: 'phone-1', waba_id: 'waba-1', credentials: encrypt({ token: 'customer-token', beauticianId: salon.id, phoneId: 'phone-1', wabaId: 'waba-1', ...overrides }, process.env.WHATSAPP_CREDENTIALS_KEY) };
}
beforeEach(() => {
  vi.stubEnv('WHATSAPP_TENANT_CREDENTIALS_ENABLED', 'true');
  vi.stubEnv('WHATSAPP_CREDENTIALS_KEY', 'cd'.repeat(32));
  vi.stubEnv('WHATSAPP_TOKEN', 'legacy-token');
  state.connection = embedded(); state.connectionError = null; state.inserts = []; state.filters = [];
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ messages: [{ id: 'provider-message' }] }) })));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('sends a manual Inbox reply using only this salon’s decrypted token and records the provider id', async () => {
  const result = await send();
  expect(result.ok).toBe(true);
  expect(fetch).toHaveBeenCalledOnce();
  const [url, options] = fetch.mock.calls[0];
  expect(url).toContain('/phone-1/messages');
  expect(options.headers.Authorization).toBe('Bearer customer-token');
  expect(state.filters).toContainEqual({ table: 'whatsapp_connections', key: 'beautician_id', value: salon.id });
  expect(state.inserts[0].external_message_id).toBe('provider-message');
});
it('keeps an explicitly registered legacy salon on its existing token', async () => {
  state.connection = { mode: 'legacy', phone_id: 'phone-1' };
  expect((await send()).ok).toBe(true);
  expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer legacy-token');
});
it.each(['missing', 'wrong-salon', 'wrong-phone', 'expired', 'database-error'])('does not send or fall back when the connection is %s; retains the failed reply', async reason => {
  if (reason === 'missing') state.connection = null;
  if (reason === 'wrong-salon') state.connection = embedded({ beauticianId: 'another-salon' });
  if (reason === 'wrong-phone') state.connection.phone_id = 'different-phone';
  if (reason === 'expired') state.connection = embedded({ expiresAt: '2020-01-01T00:00:00Z' });
  if (reason === 'database-error') state.connectionError = { code: 'connection_failure' };
  const result = await send();
  expect(result.ok).toBe(false); expect(fetch).not.toHaveBeenCalled();
  expect(result.message.status).toBe('failed');
  expect(result.message.body).toBe('Your appointment is confirmed.');
});
it('retains the message and reports the closed service window when Meta rejects it', async () => {
  fetch.mockResolvedValue({ ok: false, json: async () => ({ error: { code: 131047 } }) });
  const result = await send();
  expect(result).toMatchObject({ ok: false, status: 409, outside_window: true });
  expect(result.message.status).toBe('failed');
});
