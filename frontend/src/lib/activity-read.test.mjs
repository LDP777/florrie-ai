import test from 'node:test';
import assert from 'node:assert/strict';
import { readActivity } from './activity-read.js';
const session = token => ({ data: { session: token ? { access_token: token } : null } });
const response = (status, body = { rows: [] }) => new Response(JSON.stringify(body), { status });

test('a rejected cached token is refreshed once and the new token loads activity', async () => {
  const sent = [];
  let refreshes = 0;
  const rows = await readActivity({ auth: {
    getSession: async () => session('old'),
    refreshSession: async () => { refreshes++; return session('fresh'); },
  }, request: async (_url, opts) => {
    sent.push(opts.headers.Authorization);
    return sent.length === 1 ? response(401) : response(200, { rows: [{ id: 'real' }] });
  }, url: '/feed' });
  assert.deepEqual(sent, ['Bearer old', 'Bearer fresh']);
  assert.equal(refreshes, 1);
  assert.deepEqual(rows, [{ id: 'real' }]);
});

test('no session is an error, not a successful empty feed; a later signed-in read recovers', async () => {
  let token = null, requests = 0;
  const args = { auth: { getSession: async () => session(token) }, request: async () => { requests++; return response(200); }, url: '/feed' };
  await assert.rejects(readActivity(args), /session is unavailable/);
  assert.equal(requests, 0);
  token = 'new';
  assert.deepEqual(await readActivity(args), []);
});

test('API failure remains an error and a later retry recovers', async () => {
  let status = 503;
  const args = { auth: { getSession: async () => session('valid') }, request: async () => response(status), url: '/feed' };
  await assert.rejects(readActivity(args), /Could not load activity/);
  status = 200;
  assert.deepEqual(await readActivity(args), []);
});

test('a refresh failure and malformed response are not rendered as empty activity', async () => {
  await assert.rejects(readActivity({ auth: { getSession: async () => session('old'), refreshSession: async () => session(null) }, request: async () => response(401), url: '/feed' }), /session has expired/);
  await assert.rejects(readActivity({ auth: { getSession: async () => session('valid') }, request: async () => response(200, {}), url: '/feed' }), /Could not load activity/);
});
