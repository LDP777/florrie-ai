import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startGoogleCalendarConnection, createGoogleCalendarReturnCheck } from './google-calendar-connect.js';

const url = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=fictional&state=signed';
function fixture(overrides = {}) {
  const calls = [];
  return { calls, options: {
    api: 'https://api.florrie.test', native: false, getToken: async () => 'fictional-session',
    fetchImpl: async (address, options) => { calls.push({ address, options }); return { ok: true, json: async () => ({ url }) }; },
    openNative: async value => calls.push({ native: value }), navigateWeb: value => calls.push({ web: value }),
    ...overrides,
  } };
}
test('native starts Calendar with its native marker and opens the system browser', async () => {
  const { calls, options } = fixture({ native: true });
  await startGoogleCalendarConnection(options);
  assert.ok(calls[0].address.endsWith('/api/gcal/connect?platform=native'));
  assert.equal(calls[0].options.headers.Authorization, 'Bearer fictional-session');
  assert.deepEqual(calls[1], { native: url });
});
test('web Calendar keeps the existing browser flow', async () => {
  const { calls, options } = fixture(); await startGoogleCalendarConnection(options);
  assert.ok(calls[0].address.endsWith('/api/gcal/connect')); assert.deepEqual(calls[1], { web: url });
});
test('failed or malformed provider responses cannot open a browser', async () => {
  for (const result of [
    { ok: false, json: async () => ({ url, error: 'private configuration detail' }) },
    ...['https://evil.test/', 'javascript:alert(1)', 'https://user:pass@accounts.google.com/o/oauth2/v2/auth', 'https://accounts.google.com:444/o/oauth2/v2/auth', 'https://accounts.google.com/other'].map(value => ({ ok: true, json: async () => ({ url: value }) })),
  ]) {
    const { calls, options } = fixture({ fetchImpl: async () => result });
    await assert.rejects(startGoogleCalendarConnection(options), error => !error.message.includes('private configuration'));
    assert.deepEqual(calls, []);
  }
});
test('stalled sessions and provider responses settle and late responses never open Google', async () => {
  const session = fixture({ getToken: () => new Promise(() => {}), timeoutMs: 10 });
  await assert.rejects(startGoogleCalendarConnection(session.options), /too long/); assert.deepEqual(session.calls, []);
  let resolve, signal;
  const late = fixture({ timeoutMs: 10, fetchImpl: (_url, options) => { signal = options.signal; return new Promise(r => { resolve = r; }); } });
  await assert.rejects(startGoogleCalendarConnection(late.options), /too long/);
  assert.equal(signal.aborted, true);
  resolve({ ok: true, json: async () => ({ url }) });
  await new Promise(r => setTimeout(r, 0)); assert.deepEqual(late.calls, []);
});
test('changing owner while preparing the connection prevents navigation', async () => {
  let current = true;
  const { calls, options } = fixture({ getToken: async () => { current = false; return 'old-owner-token'; }, isCurrent: () => current });
  await assert.rejects(startGoogleCalendarConnection(options), /salon changed/); assert.deepEqual(calls, []);
});
function returnFixture(overrides = {}) {
  const results = [], checking = []; let reads = 0, refreshes = 0;
  const check = createGoogleCalendarReturnCheck({
    readStatus: async () => { reads++; return { connected: true }; },
    refresh: async () => { refreshes++; }, isCurrent: () => true,
    onChecking: value => checking.push(value), onResult: value => results.push(value),
    ...overrides,
  });
  return { check, results, checking, reads: () => reads, refreshes: () => refreshes };
}
test('browser return confirms only saved status, with duplicate and unrelated events ignored', async () => {
  const f = returnFixture();
  await f.check.finish(); assert.equal(f.reads(), 0);
  f.check.begin(); await Promise.all([f.check.finish(), f.check.finish(), f.check.finish()]);
  assert.equal(f.reads(), 1); assert.equal(f.refreshes(), 1); assert.deepEqual(f.results, ['success']);
});
test('cancellation, failed checks and malformed status never report success', async () => {
  for (const [readStatus, expected] of [
    [async () => ({ connected: false }), 'not_connected'],
    [async () => { throw Error('unavailable'); }, 'error'],
    [async () => ({}), 'error'],
  ]) {
    const f = returnFixture({ readStatus }); f.check.begin(); await f.check.finish();
    assert.deepEqual(f.results, [expected]); assert.deepEqual(f.checking, [true, false]);
  }
});
test('owner change during status read discards the previous salon result and refresh', async () => {
  let current = true, resolve;
  const f = returnFixture({ isCurrent: () => current, readStatus: () => new Promise(r => { resolve = r; }) });
  f.check.begin(); const pending = f.check.finish(); current = false; resolve({ connected: true }); await pending;
  assert.deepEqual(f.results, []); assert.equal(f.refreshes(), 0);
});
test('unmount or a new connection attempt invalidates a late browser-return result', async () => {
  for (const action of ['cancel', 'begin']) {
    let resolve;
    const f = returnFixture({ readStatus: () => new Promise(r => { resolve = r; }) });
    f.check.begin(); const pending = f.check.finish(); f.check[action](); resolve({ connected: true }); await pending;
    assert.deepEqual(f.results, []); assert.equal(f.refreshes(), 0);
  }
});
test('owner change during profile refresh cannot display prior-owner success', async () => {
  let current = true;
  const f = returnFixture({ isCurrent: () => current, refresh: async () => { current = false; } });
  f.check.begin(); await f.check.finish(); assert.deepEqual(f.results, []);
});
test('a stalled status check or profile refresh settles without leaving Calendar busy', async () => {
  for (const slow of ['readStatus', 'refresh']) {
    let resolve;
    const f = returnFixture({ timeoutMs: 10, [slow]: () => new Promise(r => { resolve = r; }) });
    f.check.begin(); await f.check.finish();
    assert.deepEqual(f.results, ['error']); assert.deepEqual(f.checking, [true, false]);
    resolve({ connected: true }); await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(f.results, ['error'], 'late completion cannot replace the timed-out result');
  }
});
