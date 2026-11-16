import test from 'node:test';
import assert from 'node:assert/strict';
import { emailRequest, startEmailConnection } from './email-connect.js';
const auth = { getSession: async () => ({ data: { session: { access_token: 'session' } } }) };
test('email sign-in opens only the expected provider, never an arbitrary redirect', async () => {
  for (const url of ['https://attacker.example/', 'https://accounts.google.com.evil.example/o/oauth2/v2/auth', 'https://accounts.google.com/other']) {
    let opened = false;
    await assert.rejects(startEmailConnection({ api: 'https://api.florrie.ai', auth, provider: 'google', native: true, fetchImpl: async () => Response.json({ url }), openNative: () => { opened = true; } }), /valid sign-in/);
    assert.equal(opened, false);
  }
});
test('native email signup carries explicit preferences and opens the system browser', async () => {
  let sent, opened;
  await startEmailConnection({ api: 'https://api.florrie.ai', auth, provider: 'microsoft', native: true, preferences: { ai_drafts: false, client_emails_only: true },
    fetchImpl: async (_url, options) => { sent = JSON.parse(options.body); return Response.json({ url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=abc' }); }, openNative: url => { opened = url; } });
  assert.equal(sent.platform, 'native'); assert.equal(sent.ai_drafts, false); assert.equal(sent.provider, 'microsoft'); assert.match(opened, /microsoftonline/);
});
test('session and provider stalls have a bounded recovery message', async () => {
  await assert.rejects(emailRequest({ api: '', auth: { getSession: () => new Promise(() => {}) }, path: 'status', timeoutMs: 10 }), /taking too long/);
  await assert.rejects(emailRequest({ api: '', auth, path: 'check', body: {}, fetchImpl: () => new Promise(() => {}), timeoutMs: 10 }), /check the result/);
});
test('a declined or unconfigured connection never opens another page', async () => {
  await assert.rejects(startEmailConnection({ api: '', auth, provider: 'google', fetchImpl: async () => Response.json({ error: 'Provider setup pending' }, { status: 503 }) }), /Provider setup pending/);
});
