import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthenticatedJsonReader } from './authenticated-json.js';

const session = token => ({ data: { session: token ? { access_token: token } : null } });
const result = (status, data = []) => ({ ok: status >= 200 && status < 300, status, data });

test('simultaneous cards share session work and one refresh for rejected tokens', async () => {
  const read = createAuthenticatedJsonReader();
  let sessions = 0, refreshes = 0;
  const auth = {
    getSession: async () => { sessions++; return session('old'); },
    refreshSession: async () => { refreshes++; return session('new'); },
  };
  const sent = [];
  const request = async (url, opts) => {
    sent.push([url, opts.headers.Authorization]);
    return result(opts.headers.Authorization === 'Bearer old' ? 401 : 200, { url });
  };
  assert.deepEqual(await Promise.all(['/diary', '/drafts'].map(url => read({ auth, url, request }))), [{ url: '/diary' }, { url: '/drafts' }]);
  assert.equal(sessions, 1);
  assert.equal(refreshes, 1);
  assert.equal(sent.length, 4);
});

test('a stalled session releases the UI deadline and the next read can recover', async () => {
  const read = createAuthenticatedJsonReader({ sessionTimeoutMs: 10 });
  let stalled = true;
  const auth = { getSession: () => stalled ? new Promise(() => {}) : Promise.resolve(session('valid')) };
  const request = async () => result(200, { loaded: true });
  await assert.rejects(read({ auth, url: '/diary', request }), /taking too long/);
  stalled = false;
  assert.deepEqual(await read({ auth, url: '/diary', request }), { loaded: true });
});

test('a second 401 is not retried forever, and server errors do not refresh auth', async () => {
  const read = createAuthenticatedJsonReader();
  let refreshes = 0, requests = 0;
  const auth = {
    getSession: async () => session('old'),
    refreshSession: async () => { refreshes++; return session('new'); },
  };
  await assert.rejects(read({ auth, url: '/diary', request: async () => { requests++; return result(401); } }), /session has expired/);
  assert.equal(requests, 2);
  assert.equal(refreshes, 1);
  await assert.rejects(read({ auth, url: '/diary', request: async () => result(503) }), error => error.status === 503);
  assert.equal(refreshes, 1);
});

test('separate auth clients cannot share sessions', async () => {
  const read = createAuthenticatedJsonReader();
  const request = async (_url, opts) => result(200, opts.headers.Authorization);
  const results = await Promise.all(['one', 'two'].map(token => read({ auth: { getSession: async () => session(token) }, url: '/diary', request })));
  assert.deepEqual(results, ['Bearer one', 'Bearer two']);
});

test('auth changes invalidate pending session reads on the same client', async () => {
  const read = createAuthenticatedJsonReader();
  let resolveOld;
  let current = new Promise(resolve => { resolveOld = resolve; });
  const auth = { getSession: () => current };
  const request = async (_url, opts) => result(200, opts.headers.Authorization);
  const oldRead = read({ auth, url: '/diary', request });
  await Promise.resolve();
  read.invalidateSession(auth);
  current = Promise.resolve(session('new-owner'));
  assert.equal(await read({ auth, url: '/diary', request }), 'Bearer new-owner');
  resolveOld(session('old-owner'));
  assert.equal(await oldRead, 'Bearer old-owner');
});
