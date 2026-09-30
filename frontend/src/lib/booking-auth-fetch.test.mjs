import assert from 'node:assert/strict';
import test from 'node:test';
import { createBookingAuthFetch, waitForBookingAuth } from './booking-auth-fetch.js';

test('booking transport aborts a stalled request once, without retrying', async () => {
  let requests = 0;
  const request = createBookingAuthFetch((_url, { signal }) => {
    requests++;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, 5);
  await assert.rejects(request('https://fictional.invalid'), error => error.name === 'TimeoutError');
  assert.equal(requests, 1);
});

test('booking transport respects an already cancelled caller signal', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException('Caller cancelled', 'AbortError'));
  const request = createBookingAuthFetch(async (_url, { signal }) => {
    assert.equal(signal.aborted, true);
    throw signal.reason;
  }, 100);
  await assert.rejects(request('https://fictional.invalid', { signal: controller.signal }), error => error.name === 'AbortError');
});

test('booking transport releases a caller abort listener after success', async () => {
  const controller = new AbortController();
  let added = 0, removed = 0;
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => { added++; add(...args); };
  controller.signal.removeEventListener = (...args) => { removed++; remove(...args); };
  const response = { ok: true };
  const request = createBookingAuthFetch(async () => response, 100);
  assert.equal(await request('https://fictional.invalid', { signal: controller.signal }), response);
  assert.equal(added, 1); assert.equal(removed, 1);
});

test('SDK deadline releases an unresolved lock without another operation', async () => {
  let calls = 0, complete;
  const operation = waitForBookingAuth(() => {
    calls++;
    return new Promise(resolve => { complete = resolve; });
  }, 5);
  await assert.rejects(operation, error => error.name === 'TimeoutError');
  complete({ accepted: true });
  await Promise.resolve();
  assert.equal(calls, 1);
  await assert.rejects(operation, error => error.name === 'TimeoutError');
});

test('SDK deadline preserves a confirmed result and synchronous errors', async () => {
  const result = { data: { session: null } };
  assert.equal(await waitForBookingAuth(() => result, 100), result);
  const failure = new Error('Synthetic SDK failure');
  await assert.rejects(waitForBookingAuth(() => { throw failure; }, 100), error => error === failure);
});
