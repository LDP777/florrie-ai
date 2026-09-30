import { beforeAll, afterAll, beforeEach, afterEach, it, expect, vi } from 'vitest';
import express from 'express';
import { encrypt, decrypt } from '../../src/lib/crypto.js';

const fake = vi.hoisted(() => ({ rows: {}, updates: [], failWrite: false, tokenResponse: null, eventResponse: null }));
vi.mock('../../src/config.js', () => ({ supabase: { from: table => {
  let patch; const filters = [];
  const settle = () => {
    if (table === 'appointments') return { data: patch ? [{ id: 'appointment-a' }] : [{ id: 'appointment-a' }], error: null };
    const id = filters.find(([key]) => key === 'id')?.[1], row = fake.rows[id];
    if (patch) fake.updates.push({ id, patch, filters });
    if (fake.failWrite) return { error: { message: 'storage unavailable' }, data: null };
    if (!row || !filters.every(([key, value]) => key === 'google_calendar_tokens' ? JSON.stringify(row[key]) === value : row[key] === value)) return { data: null, error: null };
    if (patch) Object.assign(row, patch);
    return { data: { id }, error: null };
  };
  const q = {
    select: () => q, eq: (key, value) => { filters.push([key, value]); return q; },
    update: value => { patch = value; return q; }, in: () => q, gte: () => q, is: () => q,
    single: async () => settle(), maybeSingle: async () => ({ data: { id: 'appointment-a', starts_at: '2026-10-01T10:00:00Z', ends_at: '2026-10-01T11:00:00Z' }, error: null }),
    then: (resolve, reject) => Promise.resolve(settle()).then(resolve, reject),
  };
  return q;
} } }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth: (req, res, next) => {
  if (req.headers.authorization !== 'Bearer salon-a') return res.status(401).end();
  req.beautician = structuredClone(fake.rows['salon-a']); next();
} }));
vi.mock('../../src/lib/logger.js', () => ({ default: { warn: vi.fn(), error: vi.fn() } }));
vi.stubEnv('ENCRYPTION_KEY', 'ab'.repeat(32));
vi.stubEnv('GOOGLE_CLIENT_ID', 'fictional-client'); vi.stubEnv('GOOGLE_CLIENT_SECRET', 'fictional-secret');
const { default: router, getAccessToken } = await import('../../src/routes/google-calendar.js');
const localFetch = globalThis.fetch;
let server, base;
beforeAll(async () => {
  const app = express(); app.use(express.json(), router); server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); vi.unstubAllEnvs(); });
const tokens = () => ({ access_token: 'expired-access', refresh_token: 'existing-refresh', expiry_date: Date.now() - 1000 });
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
beforeEach(() => {
  fake.rows = Object.fromEntries(['salon-a', 'salon-b'].map(id => [id, { id, google_calendar_connected: true, google_calendar_tokens: encrypt(tokens()) }]));
  fake.updates = []; fake.failWrite = false;
  fake.tokenResponse = vi.fn(async () => response({ access_token: 'renewed-access', expires_in: 3600 }));
  fake.eventResponse = vi.fn(async () => response({ id: 'fictional-event' }));
  vi.stubGlobal('fetch', (url, options) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') return fake.tokenResponse(url, options);
    if (String(url).startsWith('https://www.googleapis.com/calendar/v3/')) return fake.eventResponse(url, options);
    throw Error('Unexpected external call');
  });
});
afterEach(() => vi.unstubAllGlobals());
const owner = () => structuredClone(fake.rows['salon-a']);
const sync = (path = '/sync') => localFetch(base + path, { method: 'POST', headers: { Authorization: 'Bearer salon-a', 'Content-Type': 'application/json' }, body: JSON.stringify({ appointment_id: 'appointment-a', beautician_id: 'salon-b' }) });

it.each([
  [503, 'temporarily_unavailable'], [500, 'server_error'], [429, 'rate_limit'], [401, 'invalid_client'],
  [400, 'invalid_client'], [400, 'unknown_error'], [503, 'invalid_grant'], [401, 'invalid_grant'],
])('preserves connection on refresh HTTP %s / %s', async (status, error) => {
  const before = structuredClone(fake.rows);
  fake.tokenResponse.mockResolvedValue(response({ error, error_description: 'token expired is untrusted provider wording' }, status));
  await expect(getAccessToken(owner())).rejects.toMatchObject({ code: 'GCAL_CONNECTION_UNAVAILABLE' });
  expect(fake.rows).toEqual(before); expect(fake.updates).toEqual([]);
});
it.each([null, {}, { access_token: 'a' }, { access_token: '', expires_in: 3600 }, { access_token: 'a', expires_in: '3600' }, { access_token: 'a', expires_in: -1 }])('preserves saved credentials after malformed refresh response %j', async value => {
  const before = structuredClone(fake.rows);
  fake.tokenResponse.mockResolvedValue(response(value));
  await expect(getAccessToken(owner())).rejects.toMatchObject({ code: 'GCAL_CONNECTION_UNAVAILABLE' });
  expect(fake.rows).toEqual(before); expect(fake.updates).toEqual([]);
});
it('preserves credentials when the provider times out or returns non-JSON', async () => {
  const before = structuredClone(fake.rows);
  fake.tokenResponse.mockRejectedValueOnce(new Error('token expired from a proxy'));
  await expect(getAccessToken(owner())).rejects.toMatchObject({ code: 'GCAL_CONNECTION_UNAVAILABLE' });
  fake.tokenResponse.mockResolvedValueOnce(new Response('<html>unavailable</html>', { status: 503 }));
  await expect(getAccessToken(owner())).rejects.toMatchObject({ code: 'GCAL_CONNECTION_UNAVAILABLE' });
  expect(fake.rows).toEqual(before); expect(fake.updates).toEqual([]);
});
it.each(['encrypted', 'legacy'])('only confirmed invalid_grant clears the same owner and saved %s credentials', async format => {
  if (format === 'legacy') fake.rows['salon-a'].google_calendar_tokens = tokens();
  const other = structuredClone(fake.rows['salon-b']);
  fake.tokenResponse.mockResolvedValue(response({ error: 'invalid_grant' }, 400));
  await expect(getAccessToken(owner())).rejects.toMatchObject({ code: 'GCAL_RECONNECT_REQUIRED' });
  expect(fake.rows['salon-a']).toMatchObject({ google_calendar_connected: false, google_calendar_tokens: null });
  expect(fake.rows['salon-b']).toEqual(other); expect(fake.updates[0].id).toBe('salon-a');
});
it.each(['revoked', 'refreshed'])('an old %s response cannot change a newer connection', async outcome => {
  const snapshot = owner(), replacement = encrypt({ ...tokens(), access_token: 'new-account-access' });
  fake.tokenResponse.mockImplementation(async () => {
    fake.rows['salon-a'].google_calendar_tokens = replacement;
    return outcome === 'revoked' ? response({ error: 'invalid_grant' }, 400) : response({ access_token: 'late-access', expires_in: 3600 });
  });
  await expect(getAccessToken(snapshot)).rejects.toMatchObject({ code: 'GCAL_CONNECTION_UNAVAILABLE' });
  expect(fake.rows['salon-a'].google_calendar_tokens).toBe(replacement);
  expect(fake.rows['salon-a'].google_calendar_connected).toBe(true);
});
it.each(['revoked', 'refreshed'])('a failed %s save cannot claim a confirmed connection change', async outcome => {
  const before = structuredClone(fake.rows); fake.failWrite = true;
  if (outcome === 'revoked') fake.tokenResponse.mockResolvedValue(response({ error: 'invalid_grant' }, 400));
  await expect(getAccessToken(owner())).rejects.toMatchObject({ code: 'GCAL_CONNECTION_UNAVAILABLE' });
  expect(fake.rows).toEqual(before);
});
it.each(['encrypted', 'legacy'])('persists successful %s refresh encrypted, retains refresh credentials and reuses it in this request', async format => {
  if (format === 'legacy') fake.rows['salon-a'].google_calendar_tokens = tokens();
  const snapshot = owner(), other = structuredClone(fake.rows['salon-b']);
  expect(await getAccessToken(snapshot)).toBe('renewed-access');
  expect(decrypt(fake.rows['salon-a'].google_calendar_tokens)).toMatchObject({ access_token: 'renewed-access', refresh_token: 'existing-refresh' });
  expect(fake.rows['salon-a'].google_calendar_connected).toBe(true); expect(fake.rows['salon-b']).toEqual(other);
  expect(await getAccessToken(snapshot)).toBe('renewed-access'); expect(fake.tokenResponse).toHaveBeenCalledTimes(1);
  expect(fake.updates).toHaveLength(1); expect(fake.updates[0].id).toBe('salon-a');
});
it.each(['/sync', '/sync-all'])('%s does not call a transient/config failure disconnected', async path => {
  const before = structuredClone(fake.rows);
  fake.tokenResponse.mockResolvedValue(response({ error: 'invalid_client', error_description: 'token expired' }, 401));
  const result = await sync(path), body = await result.json();
  expect(body.disconnected).not.toBe(true); expect(fake.rows).toEqual(before); expect(fake.eventResponse).not.toHaveBeenCalled();
  if (path === '/sync') expect(result.status).toBe(503); else expect(body.errors).toBe(1);
});
it.each(['/sync', '/sync-all'])('%s reports reconnect only after confirmed invalid_grant', async path => {
  fake.tokenResponse.mockResolvedValue(response({ error: 'invalid_grant' }, 400));
  const result = await sync(path), body = await result.json();
  expect(body.disconnected).toBe(true); expect(fake.rows['salon-a'].google_calendar_connected).toBe(false);
  expect(fake.rows['salon-b'].google_calendar_connected).toBe(true); expect(fake.eventResponse).not.toHaveBeenCalled();
});
it.each(['/sync', '/sync-all'])('%s preserves refresh credentials when only the event request returns 401', async path => {
  fake.rows['salon-a'].google_calendar_tokens = encrypt({ ...tokens(), expiry_date: Date.now() + 3600000 });
  const before = structuredClone(fake.rows);
  fake.eventResponse.mockResolvedValue(response({ error: { message: 'Access token unavailable' } }, 401));
  const result = await sync(path), body = await result.json();
  expect(body.disconnected).not.toBe(true); expect(fake.rows).toEqual(before); expect(fake.updates).toEqual([]);
  expect(fake.eventResponse).toHaveBeenCalledTimes(1);
});
