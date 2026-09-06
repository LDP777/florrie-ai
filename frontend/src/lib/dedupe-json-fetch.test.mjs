import test from 'node:test';
import assert from 'node:assert/strict';
import { createDedupeJsonFetch } from './dedupe-json-fetch.js';

const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function clock() {
  const timers = new Map();
  let next = 0;
  return {
    setTimeout(fn, ms) { const id = ++next; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    expire() { for (const [id, timer] of [...timers]) { timers.delete(id); timer.fn(); } },
    get size() { return timers.size; },
  };
}

test('hung headers time out, abort the request and allow a genuinely fresh retry', async () => {
  const timers = clock();
  const old = deferred();
  const signals = [];
  const read = createDedupeJsonFetch((_url, options) => {
    signals.push(options.signal);
    return signals.length === 1 ? old.promise : Promise.resolve(response({ recovered: true }));
  }, 15_000, timers);
  const first = read('/diary');
  const duplicate = read('/diary');
  const failures = [first, duplicate].map(p => assert.rejects(p, { name: 'TimeoutError' }));
  await flush();
  assert.equal(signals.length, 1);
  timers.expire();
  await Promise.all(failures);
  assert.equal(signals[0].aborted, true);
  assert.deepEqual(await read('/diary'), { ok: true, status: 200, data: { recovered: true } });
  assert.equal(signals.length, 2);
  assert.equal(timers.size, 0);
  old.resolve(response({ stale: true }));
  await flush();
});

test('the same deadline covers a body that stalls after response headers', async () => {
  const timers = clock();
  const body = deferred();
  let signal;
  let calls = 0;
  const read = createDedupeJsonFetch((_url, options) => {
    signal = options.signal;
    calls++;
    return Promise.resolve(calls === 1
      ? { ok: true, status: 200, text: () => body.promise }
      : response({ rows: [] }));
  }, 15_000, timers);
  const pending = read('/activity');
  const failure = assert.rejects(pending, { name: 'TimeoutError' });
  await flush();
  assert.equal(timers.size, 1);
  const stalledSignal = signal;
  timers.expire();
  await failure;
  assert.equal(stalledSignal.aborted, true);
  assert.deepEqual((await read('/activity')).data, { rows: [] });
  assert.equal(calls, 2);
  body.resolve('{"rows":["old"]}');
  await flush();
});

test('a late timed-out response cannot evict or replace the replacement request', async () => {
  const timers = clock();
  const requests = [];
  const read = createDedupeJsonFetch(() => {
    const request = deferred();
    requests.push(request);
    return request.promise;
  }, 15_000, timers);
  const first = read('/diary');
  const failure = assert.rejects(first, { name: 'TimeoutError' });
  await flush();
  timers.expire();
  await failure;
  const fresh = read('/diary');
  await flush();
  requests[0].resolve(response({ stale: true }));
  await flush();
  const duplicate = read('/diary');
  await flush();
  assert.equal(requests.length, 2);
  requests[1].resolve(response({ fresh: true }));
  for (const result of await Promise.all([fresh, duplicate])) assert.deepEqual(result.data, { fresh: true });
  assert.equal(timers.size, 0);
});

test('duplicates share headers and body work, but receive independent JSON objects', async () => {
  const timers = clock();
  const body = deferred();
  let calls = 0;
  let bodyReads = 0;
  const read = createDedupeJsonFetch(async () => {
    calls++;
    return { ok: true, status: 200, text() { bodyReads++; return body.promise; } };
  }, 15_000, timers);
  const first = read('/diary', { headers: { Authorization: 'Bearer owner' } });
  await flush();
  const second = read('/diary', { headers: new Headers({ authorization: 'Bearer owner' }) });
  await flush();
  assert.equal(calls, 1);
  assert.equal(bodyReads, 1);
  body.resolve('{"rows":[{"id":"real"}]}');
  const [a, b] = await Promise.all([first, second]);
  a.data.rows[0].id = 'edited locally';
  assert.equal(b.data.rows[0].id, 'real');
  assert.equal(timers.size, 0);
});

test('different owners never share a request or response', async () => {
  const seen = [];
  const read = createDedupeJsonFetch(async (_url, options) => {
    const owner = new Headers(options.headers).get('authorization');
    seen.push(owner);
    return response({ owner });
  });
  const rows = await Promise.all(['first', 'second'].map(owner =>
    read('/diary', { headers: { Authorization: `Bearer ${owner}` } })));
  assert.deepEqual(seen, ['Bearer first', 'Bearer second']);
  assert.deepEqual(rows.map(row => row.data.owner), seen);
});

test('a caller abort cannot cancel the shared request, even if fetch ignores abort', async () => {
  const timers = clock();
  const requests = [];
  const read = createDedupeJsonFetch((_url, options) => {
    const request = { ...deferred(), signal: options.signal };
    requests.push(request);
    return request.promise;
  }, 15_000, timers);
  const controller = new AbortController();
  const cancelled = read('/diary', { signal: controller.signal });
  const failure = assert.rejects(cancelled, { name: 'AbortError' });
  const shared = read('/diary');
  await flush();
  controller.abort();
  await failure;
  assert.equal(requests.length, 2);
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[1].signal.aborted, false);
  requests[1].resolve(response({ rows: [] }));
  assert.deepEqual((await shared).data, { rows: [] });
  assert.equal(timers.size, 0);
});

test('HTTP errors retain status; malformed successful JSON fails and can be retried', async () => {
  let status = 401;
  const read = createDedupeJsonFetch(async () => new Response('<html>Unavailable</html>', { status }));
  assert.deepEqual(await read('/diary'), { ok: false, status: 401, data: null });
  status = 200;
  await assert.rejects(read('/diary'), SyntaxError);
  status = 503;
  assert.deepEqual(await read('/diary'), { ok: false, status: 503, data: null });
});

test('writes are rejected without sending or retrying them', async () => {
  let calls = 0;
  const read = createDedupeJsonFetch(async () => { calls++; return response({}); });
  await assert.rejects(read('/booking', { method: 'POST' }), /only accepts GET/);
  assert.equal(calls, 0);
});
