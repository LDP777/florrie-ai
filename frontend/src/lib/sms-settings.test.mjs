import assert from 'node:assert/strict';
import test from 'node:test';
import { monthlyMessageUsage, smsSettingsChanges, writeSmsSettings } from './sms-settings.js';
const auth = { getSession: async () => ({ data: { session: { access_token: 'current-sdk-token' } } }) };
const success = () => new Response(JSON.stringify({ success: true }));

test('monthly usage requires real combined counts, and preserves a genuine zero', () => {
  for (const value of [null, {}, { usage: null }, { usage: { sms_sent: 0 } }]) assert.throws(() => monthlyMessageUsage(value), /unavailable/);
  const usage = { sms_sent: 0, whatsapp_sent: 0, total_sent: 0, free_limit: 120, remaining: 120, overage_total_pence: 0, month: '2026-09-01' };
  assert.equal(monthlyMessageUsage({ usage }), usage);
  assert.throws(() => monthlyMessageUsage({ usage: { ...usage, sms_sent: null } }), /unavailable/);
});

test('saving a name never writes routing, sms enablement or reminder preferences', () => {
  const saved = { sms_originator: 'Salon', sms_inbound_number: '+447700900123', sms_channel_id: 'existing-channel', sms_enabled: true, channel: 'email' };
  assert.deepEqual(smsSettingsChanges(saved, { name: 'New Salon', inbound: '+447700 900123', channel: 'existing-channel' }), { sms_originator: 'New Salon' });
  assert.deepEqual(smsSettingsChanges(saved, { name: 'Salon', inbound: '', channel: '' }), { sms_inbound_number: null, sms_channel_id: null });
});

test('writes use SDK session once and never replay a 401 or rejected provider send', async () => {
  for (const status of [401, 500]) {
    let calls = 0;
    await assert.rejects(writeSmsSettings({ auth, url: '/fake', method: 'POST', body: { phone: 'synthetic' }, request: async (_url, options) => {
      calls++;
      assert.equal(options.headers.Authorization, 'Bearer current-sdk-token');
      return new Response('{}', { status });
    } }));
    assert.equal(calls, 1);
  }
});

test('a hanging session times out without dispatching later or clearing auth', async () => {
  let resolve; let calls = 0;
  await assert.rejects(writeSmsSettings({ auth: { getSession: () => new Promise(r => { resolve = r; }) }, url: '/fake', method: 'PUT', body: {}, timeoutMs: 5, request: async () => { calls++; return success(); } }), /timed out/);
  resolve(await auth.getSession());
  await new Promise(r => setTimeout(r, 0));
  assert.equal(calls, 0);
});

test('stalled response bodies and unconfirmed sends are bounded, with no automatic resend', async () => {
  let calls = 0;
  await assert.rejects(writeSmsSettings({ auth, url: '/fake', method: 'POST', body: {}, timeoutMs: 5, request: async () => {
    calls++;
    return { ok: true, json: () => new Promise(() => {}) };
  } }), /Check the phone before sending another/);
  assert.equal(calls, 1);
  await assert.rejects(writeSmsSettings({ auth, url: '/fake', method: 'POST', body: {}, request: async () => new Response('{}', { status: 500 }) }), /Check the phone before sending another/);
  await assert.rejects(writeSmsSettings({ auth, url: '/fake', method: 'PUT', body: {}, request: async () => new Response('{}') }), /couldn’t confirm the save/);
});
