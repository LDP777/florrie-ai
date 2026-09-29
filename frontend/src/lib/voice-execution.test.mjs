import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeVoiceProposal } from './voice-execution.js';

const auth = { getSession: async () => ({ data: { session: { access_token: 'test-token' } } }) };
const proposal = { auth, url: '/api/voice/execute', tool: 'book_appointment', input: { client_name: 'Demo', date: '2026-09-30' } };
const response = data => ({ ok: true, json: async () => data });
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('sends one authenticated confirmation with its exact tool and input and returns the actual result', async () => {
  let calls = 0;
  const result = { result: 'Booked for Wednesday.', data: { appointment_id: 'demo' } };
  assert.deepEqual(await executeVoiceProposal({ ...proposal, request: async (url, options) => {
    calls += 1;
    assert.equal(url, proposal.url);
    assert.equal(options.method, 'POST');
    assert.deepEqual(options.headers, { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' });
    assert.deepEqual(JSON.parse(options.body), { tool: proposal.tool, input: proposal.input });
    assert.ok(options.signal instanceof AbortSignal);
    return response(result);
  } }), result);
  assert.equal(calls, 1);
});

test('missing, invalid and rejected sessions never send an action', async () => {
  let calls = 0;
  const request = async () => { calls += 1; return response({ result: 'Unexpected' }); };
  for (const invalidAuth of [null, {}, { getSession: async () => null },
    { getSession: async () => ({ data: { session: null } }) },
    { getSession: async () => ({ error: new Error('Expired'), data: { session: { access_token: 'test' } } }) },
    { getSession: async () => ({ data: { session: { access_token: ' ' } } }) },
    { getSession: async () => { throw new Error('Auth unavailable'); } },
  ]) {
    await assert.rejects(executeVoiceProposal({ ...proposal, auth: invalidAuth, request }), error =>
      error.code === 'VOICE_AUTH_REQUIRED' && /has not been sent/.test(error.message));
  }
  assert.equal(calls, 0);
});

test('a changed conversation prevents auth and sending, including a guard that throws', async () => {
  let authCalls = 0, sendCalls = 0;
  for (const canExecute of [() => false, () => { throw new Error('Unmounted'); }]) {
    await assert.rejects(executeVoiceProposal({ ...proposal, canExecute,
      auth: { getSession: async () => { authCalls += 1; return auth.getSession(); } },
      request: async () => { sendCalls += 1; },
    }), error => error.code === 'VOICE_ACTION_CANCELLED');
  }
  assert.equal(authCalls, 0);
  assert.equal(sendCalls, 0);
});

test('an owner or conversation change while auth is pending prevents the request', async () => {
  let release, allowed = true, calls = 0;
  const pendingAuth = new Promise(resolve => { release = resolve; });
  const execution = executeVoiceProposal({ ...proposal, auth: { getSession: () => pendingAuth },
    canExecute: () => allowed, request: async () => { calls += 1; },
  });
  allowed = false;
  release(await auth.getSession());
  await assert.rejects(execution, error => error.code === 'VOICE_ACTION_CANCELLED');
  assert.equal(calls, 0);
});

test('the deadline includes auth and a late auth resolution cannot send', async () => {
  let release, calls = 0;
  const pendingAuth = new Promise(resolve => { release = resolve; });
  await assert.rejects(executeVoiceProposal({ ...proposal, timeoutMs: 5,
    auth: { getSession: () => pendingAuth }, request: async () => { calls += 1; },
  }), error => error.code === 'VOICE_NOT_SENT' && /has not been sent/.test(error.message));
  release(await auth.getSession());
  await nextTurn();
  assert.equal(calls, 0);
});

test('a hanging request is aborted once and reports an uncertain result without retrying', async () => {
  let signal, calls = 0;
  await assert.rejects(executeVoiceProposal({ ...proposal, timeoutMs: 5, request: async (_, options) => {
    signal = options.signal;
    calls += 1;
    return new Promise(() => {});
  } }), error => error.code === 'VOICE_RESULT_UNCERTAIN' && /Check the result before repeating/.test(error.message));
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
});

test('the deadline also bounds reading the response body, with no late success or second request', async () => {
  let releaseBody, calls = 0, signal;
  const body = new Promise(resolve => { releaseBody = resolve; });
  await assert.rejects(executeVoiceProposal({ ...proposal, timeoutMs: 5, request: async (_, options) => {
    calls += 1;
    signal = options.signal;
    return { ok: true, json: () => body };
  } }), error => error.code === 'VOICE_RESULT_UNCERTAIN');
  assert.equal(signal.aborted, true);
  releaseBody({ result: 'Late result' });
  await nextTurn();
  assert.equal(calls, 1);
});

test('network, HTTP, JSON and invalid result failures do not fabricate success or retry', async () => {
  const failures = [
    async () => { throw new Error('Network closed'); },
    async () => ({ ok: false, json: async () => ({ error: 'Try again.' }) }),
    async () => ({ ok: true, json: async () => { throw new Error('Invalid JSON'); } }),
    ...[null, [], {}, { result: '' }, { result: {} }, { result: 'Done', error: 'Could not save' }].map(data => async () => response(data)),
  ];
  for (const fail of failures) {
    let calls = 0;
    await assert.rejects(executeVoiceProposal({ ...proposal, request: (...args) => { calls += 1; return fail(...args); } }),
      error => error.code === 'VOICE_RESULT_UNCERTAIN' && /Check the result before repeating/.test(error.message));
    assert.equal(calls, 1);
  }
});

test('a server result describing failure is returned honestly, without a replacement Done message', async () => {
  const result = { result: 'I could not save that appointment.', data: { failed: true } };
  assert.deepEqual(await executeVoiceProposal({ ...proposal, request: async () => response(result) }), result);
});

test('unserializable inputs fail before sending', async () => {
  const input = {};
  input.self = input;
  let calls = 0;
  await assert.rejects(executeVoiceProposal({ ...proposal, input, request: async () => { calls += 1; } }),
    error => error.code === 'VOICE_NOT_SENT');
  assert.equal(calls, 0);
});
