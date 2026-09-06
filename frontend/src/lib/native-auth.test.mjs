import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { parseNativeAuthCallback, createNativeAuthHandler, appleNoncePair } from './native-auth.js';
import { readOAuthProviders } from './auth-providers.js';

test('provider configuration enables only explicitly supported methods', async () => {
  const read = external => readOAuthProviders({ url: 'https://test.invalid', key: 'public-test-key', fetchImpl: async () => ({ ok: true, json: async () => ({ external }) }) });
  assert.deepEqual(await read({ apple: true, google: false }), { apple: true, google: false });
  assert.deepEqual(await read({ apple: 'true', google: 1 }), { apple: false, google: false });
  await assert.rejects(readOAuthProviders({ url: 'https://test.invalid', key: 'public-test-key', fetchImpl: async () => ({ ok: false }) }));
});

test('only exact app auth routes accept a single PKCE code', () => {
  assert.deepEqual(parseNativeAuthCallback('ai.florrie.app://auth/callback?code=one'), { code: 'one', destination: '/today' });
  assert.deepEqual(parseNativeAuthCallback('ai.florrie.app://auth/update-password?code=two'), { code: 'two', destination: '/update-password' });
  for (const url of ['https://auth/callback?code=x', 'ai.florrie.app://evil/callback?code=x', 'ai.florrie.app://auth.evil/callback?code=x', 'ai.florrie.app://auth:80/callback?code=x', 'ai.florrie.app://user@auth/callback?code=x', 'ai.florrie.app://auth/other?code=x']) {
    assert.equal(parseNativeAuthCallback(url), null);
  }
  for (const url of ['ai.florrie.app://auth/callback#access_token=bad', 'ai.florrie.app://auth/callback?code=x&code=y', 'ai.florrie.app://auth/callback?error=denied', 'ai.florrie.app://auth/callback?code=x#refresh_token=bad']) {
    assert.deepEqual(parseNativeAuthCallback(url), { error: true });
  }
});

test('warm and cold duplicate delivery exchanges the code once and waits for a session', async () => {
  let release;
  let calls = 0;
  const navigation = [];
  const handler = createNativeAuthHandler({ auth: { exchangeCodeForSession: () => { calls++; return new Promise(resolve => { release = resolve; }); } }, navigate: (...args) => navigation.push(args), closeBrowser: async () => {} });
  const first = handler('ai.florrie.app://auth/update-password?code=one');
  await handler('ai.florrie.app://auth/update-password?code=one');
  assert.equal(calls, 1);
  assert.equal(navigation.length, 0);
  release({ data: { session: { user: { id: 'test' } } }, error: null });
  await first;
  assert.deepEqual(navigation, [['/update-password', { replace: true }]]);
});

test('bad or unrequested callbacks cannot install an arbitrary session or leak errors', async () => {
  let calls = 0;
  const navigation = [];
  const handler = createNativeAuthHandler({ auth: { exchangeCodeForSession: async () => { calls++; return { error: new Error('secret provider error') }; } }, navigate: path => navigation.push(path), closeBrowser: async () => { throw new Error('closed'); } });
  await handler('https://evil/callback?code=one');
  await handler('ai.florrie.app://auth/callback#access_token=bad');
  await handler('ai.florrie.app://auth/callback?code=expired');
  assert.equal(calls, 1);
  assert.deepEqual(navigation, ['/login?auth_error=1', '/login?auth_error=1']);
});

test('Apple receives SHA-256 while Supabase receives the original unpredictable nonce', async () => {
  const first = await appleNoncePair(webcrypto);
  const second = await appleNoncePair(webcrypto);
  assert.equal(first.raw.length, 64);
  assert.notEqual(first.raw, second.raw);
  assert.notEqual(first.raw, first.hashed);
  assert.equal(first.hashed, createHash('sha256').update(first.raw).digest('hex'));
});
