import { beforeAll, afterAll, beforeEach, afterEach, it, expect, vi } from 'vitest';
import express from 'express';
import { signOAuthState, inspectOAuthState, OAUTH_STATE_MAX_AGE_MS } from '../../src/lib/oauth-state.js';

const fake = vi.hoisted(() => ({ mode: 'ok', profile: null, writes: [], provider: null }));
vi.mock('../../src/config.js', () => ({ supabase: { from: table => {
  let patch, owner;
  const query = {
    update(value) { patch = value; return query; },
    eq(key, value) { if (key === 'id') owner = value; return query; },
    select() { return query; },
    async single() {
      fake.writes.push({ table, owner, patch });
      if (fake.mode === 'throw') throw new Error('private database failure');
      if (fake.mode === 'error') return { error: { message: 'private database failure' }, data: null };
      if (fake.mode === 'empty') return { error: null, data: null };
      if (fake.mode === 'wrong') return { error: null, data: { id: 'another-salon' } };
      if (owner !== fake.profile.id) return { error: null, data: null };
      Object.assign(fake.profile, patch);
      return { error: null, data: { id: owner } };
    },
  };
  return query;
} } }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth: (req, res, next) => {
  if (req.headers.authorization !== 'Bearer fictional-owner') return res.status(401).json({ error: 'Sign in' });
  req.beautician = { ...fake.profile }; next();
} }));
vi.mock('../../src/lib/logger.js', () => ({ default: { error: vi.fn(), warn: vi.fn() } }));

vi.stubEnv('GOOGLE_CLIENT_ID', 'fictional-calendar-client');
vi.stubEnv('GOOGLE_CLIENT_SECRET', 'fictional-secret');
vi.stubEnv('GOOGLE_REDIRECT_URI', 'https://api.florrie.test/api/gcal/callback');
vi.stubEnv('FRONTEND_URL', 'https://florrie.test');
vi.stubEnv('OAUTH_STATE_SECRET', 'fictional-state-secret');
vi.stubEnv('ENCRYPTION_KEY', 'ab'.repeat(32));
const { default: router } = await import('../../src/routes/google-calendar.js');
const localFetch = globalThis.fetch;
let server, base;
beforeAll(async () => {
  const app = express(); app.use(express.json(), router);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); vi.unstubAllEnvs(); });
beforeEach(() => {
  fake.mode = 'ok'; fake.writes = [];
  fake.profile = { id: 'salon-a', google_calendar_connected: true, google_calendar_tokens: 'existing-encrypted-token', google_calendar_id: 'existing-calendar' };
  fake.provider = vi.fn(async () => new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }), { status: 200 }));
  vi.stubGlobal('fetch', (url, options) => {
    if (String(url).startsWith(base + '/')) return localFetch(url, options);
    if (String(url) === 'https://oauth2.googleapis.com/token') return fake.provider(url, options);
    throw new Error('Unexpected external request');
  });
});
afterEach(() => vi.unstubAllGlobals());
const state = (extra = {}, options) => signOAuthState({ beauticianId: 'salon-a', purpose: 'google-calendar', ...extra }, options);
const callback = (value = state(), query = { code: 'fictional-code' }) => localFetch(`${base}/callback?${new URLSearchParams({ state: value, ...query })}`, { redirect: 'manual' });
const disconnect = auth => localFetch(base + '/disconnect', { method: 'POST', headers: auth === false ? {} : { Authorization: 'Bearer fictional-owner' } });

it('only confirms connection after the requesting salon credential save succeeds', async () => {
  const response = await callback();
  expect(response.headers.get('location')).toBe('https://florrie.test/settings?gcal=success');
  expect(fake.writes).toHaveLength(1); expect(fake.writes[0].owner).toBe('salon-a');
  expect(fake.profile.google_calendar_tokens).not.toContain('new-access');
  expect(fake.profile.google_calendar_tokens).not.toBe('existing-encrypted-token');
});
it.each(['error', 'empty', 'wrong', 'throw'])('does not confirm or replace existing credentials when the save is %s', async mode => {
  fake.mode = mode;
  const response = await callback();
  expect(response.headers.get('location')).toBe('https://florrie.test/settings?gcal=error');
  expect(fake.profile.google_calendar_tokens).toBe('existing-encrypted-token');
});
it('does not save an incomplete provider response or provider rejection', async () => {
  for (const value of [{ access_token: 'a', expires_in: 3600 }, { access_token: 'a', refresh_token: 'r', expires_in: -1 }]) {
    fake.provider.mockResolvedValueOnce(new Response(JSON.stringify(value), { status: 200 }));
    expect((await callback()).headers.get('location')).toContain('gcal=error');
  }
  fake.provider.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'access_denied' }), { status: 400 }));
  expect((await callback()).headers.get('location')).toContain('gcal=error');
  expect(fake.writes).toEqual([]);
});
it.each(['error', 'empty', 'wrong', 'throw'])('reports failed disconnect honestly when the write is %s', async mode => {
  fake.mode = mode;
  const response = await disconnect();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'Could not confirm that Google Calendar was disconnected. Refresh and try again.' });
  expect(fake.profile.google_calendar_connected).toBe(true);
  expect(fake.profile.google_calendar_tokens).toBe('existing-encrypted-token');
});
it('disconnects only the authenticated owner and confirms the saved change', async () => {
  expect((await disconnect(false)).status).toBe(401); expect(fake.writes).toEqual([]);
  const response = await disconnect();
  expect(await response.json()).toEqual({ success: true });
  expect(fake.profile).toMatchObject({ google_calendar_connected: false, google_calendar_tokens: null, google_calendar_id: null });
  expect(fake.writes[0].owner).toBe('salon-a');
});
it('signs the native presentation and Calendar purpose without changing callback or scopes', async () => {
  const response = await localFetch(base + '/connect?platform=native&beauticianId=other', { headers: { Authorization: 'Bearer fictional-owner' } });
  const url = new URL((await response.json()).url);
  expect(inspectOAuthState(url.searchParams.get('state')).payload).toMatchObject({ beauticianId: 'salon-a', purpose: 'google-calendar', platform: 'native' });
  expect(url.searchParams.get('redirect_uri')).toBe('https://api.florrie.test/api/gcal/callback');
  expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly');
});
it('returns native success to the app without redirecting into a separate website session', async () => {
  const response = await callback(state({ platform: 'native' }));
  expect(response.headers.get('location')).toBeNull();
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(await response.text()).toContain('Close this browser to return to Florrie');
  expect(fake.writes).toHaveLength(1);
});
it('native cancellation gives a safe return page and never exchanges or saves tokens', async () => {
  const response = await callback(state({ platform: 'native' }), { error: 'access_denied', error_description: '<script>secret</script>' });
  const html = await response.text();
  expect(response.headers.get('location')).toBeNull(); expect(html).toContain('Connection cancelled');
  expect(html).not.toContain('<script>'); expect(html).not.toContain('secret');
  expect(fake.provider).not.toHaveBeenCalled(); expect(fake.writes).toEqual([]);
});
it('expired and forged native state can choose only the safe failure presentation', async () => {
  const expired = state({ platform: 'native' }, { now: Date.now() - OAUTH_STATE_MAX_AGE_MS - 1000 });
  const valid = state({ platform: 'native' });
  const forged = valid.slice(0, valid.lastIndexOf('.') + 1) + 'invalid';
  for (const value of [expired, forged]) {
    const response = await callback(value);
    expect(response.headers.get('location')).toBeNull(); expect(await response.text()).toContain('Connection not confirmed');
  }
  expect(fake.provider).not.toHaveBeenCalled(); expect(fake.writes).toEqual([]);
});
it('native failed saves and provider errors give return instructions without success', async () => {
  fake.mode = 'error';
  let response = await callback(state({ platform: 'native' }));
  expect(await response.text()).toContain('Connection not confirmed');
  fake.provider.mockRejectedValueOnce(new Error('provider unavailable'));
  response = await callback(state({ platform: 'native' }));
  expect(await response.text()).toContain('Connection not confirmed');
  expect(fake.profile.google_calendar_tokens).toBe('existing-encrypted-token');
});
it('rejects another integration purpose but preserves already-started legacy Calendar callbacks', async () => {
  expect((await callback(state({ purpose: 'google-reviews' }))).headers.get('location')).toContain('gcal=error');
  expect(fake.provider).not.toHaveBeenCalled();
  const legacy = signOAuthState({ beauticianId: 'salon-a' });
  expect((await callback(legacy)).headers.get('location')).toContain('gcal=success');
});
