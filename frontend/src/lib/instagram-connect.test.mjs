import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startInstagramConnection } from './instagram-connect.js';

const url = 'https://www.instagram.com/oauth/authorize?client_id=example&state=signed';
function fixture(overrides = {}) {
  const calls = [];
  return { calls, options: {
    api: 'https://api.florrie.test', native: false,
    getToken: async () => 'test-token',
    fetchImpl: async (address, options) => {
      calls.push({ address, options });
      return { ok: true, json: async () => ({ url }) };
    },
    beforeOpen: async () => calls.push('save'),
    openNative: async value => calls.push({ native: value }),
    navigateWeb: value => calls.push({ web: value }),
    ...overrides,
  } };
}
test('web setup is saved before navigation and only the API receives the session', async () => {
  const { calls, options } = fixture();
  await startInstagramConnection(options);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
  assert.deepEqual(calls.slice(1), ['save', { web: url }]);
});
test('native uses the system browser and asks for the native callback', async () => {
  const { calls, options } = fixture({ native: true });
  await startInstagramConnection(options);
  assert.ok(calls[0].address.endsWith('?platform=native'));
  assert.deepEqual(calls.slice(1), ['save', { native: url }]);
});
test('a stalled session settles without sending or opening anything', async () => {
  const { calls, options } = fixture({ getToken: () => new Promise(() => {}), timeoutMs: 10 });
  await assert.rejects(startInstagramConnection(options), /too long/);
  assert.equal(calls.length, 0);
});
test('stalled connection is aborted and a later response cannot open Instagram', async () => {
  let finish; let signal;
  const { calls, options } = fixture({ timeoutMs: 10, fetchImpl: (_url, o) => {
    signal = o.signal;
    return new Promise(resolve => { finish = resolve; });
  } });
  await assert.rejects(startInstagramConnection(options), /too long/);
  assert.equal(signal.aborted, true);
  finish({ ok: true, json: async () => ({ url }) });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls.length, 0);
});
test('failed setup save prevents leaving onboarding', async () => {
  const { calls, options } = fixture({ beforeOpen: async () => { throw new Error('save failed'); } });
  await assert.rejects(startInstagramConnection(options), /save failed/);
  assert.equal(calls.length, 1);
});
test('missing sessions, provider errors and untrusted destinations never open a browser', async () => {
  for (const overrides of [
    { getToken: async () => null },
    { fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: 'config' }) }) },
    { fetchImpl: async () => ({ ok: true, json: async () => ({ url: 'https://attacker.test/' }) }) },
    { fetchImpl: async () => ({ ok: true, json: async () => ({ url: 'javascript:alert(1)' }) }) },
  ]) {
    const { calls, options } = fixture(overrides);
    await assert.rejects(startInstagramConnection(options));
    assert.equal(calls.length, 0);
  }
});
