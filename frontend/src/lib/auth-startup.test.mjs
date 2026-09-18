import test from 'node:test';
import assert from 'node:assert/strict';
import { startAuthStartup } from './auth-startup.js';

const owner = { user: { id: 'owner' }, access_token: 'fixture-token' };
const result = session => ({ data: { session }, error: null });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(predicate(), 'state should settle within its bounded deadline');
}
function fixture(t, getSession, options = {}) {
  const states = [];
  let callback, calls = 0, unsubscribed = 0;
  const auth = {
    getSession() { calls++; return getSession(calls); },
    onAuthStateChange(fn) { callback = fn; return { data: { subscription: { unsubscribe() { unsubscribed++; } } } }; },
    signOut() { assert.fail('startup must never sign out'); },
  };
  const startup = startAuthStartup({ auth, onChange: state => states.push(state), timeoutMs: 20, retryDelayMs: 1, ...options });
  t.after(() => startup.dispose());
  return { startup, states, auth, event: (event, session) => callback(event, session), state: () => states.at(-1), calls: () => calls, unsubscribed: () => unsubscribed };
}

test('initial authenticated and confirmed anonymous states both finish loading', async t => {
  for (const session of [owner, null]) {
    const f = fixture(t, () => Promise.resolve(result(session)));
    await until(() => f.state().status === 'ready');
    assert.equal(f.state().session, session);
    assert.equal(f.calls(), 1);
  }
});

test('a rejected read retries once and can recover without sign-out', async t => {
  const f = fixture(t, count => count === 1 ? Promise.reject(new Error('auth lock')) : result(owner));
  await until(() => f.state().status === 'ready');
  assert.equal(f.calls(), 2);
  assert.equal(f.state().session, owner);
  assert.ok(f.states.every(state => !state.error));
});

test('resolved auth errors remain unknown and produce a retryable error', async t => {
  const f = fixture(t, () => ({ data: { session: null }, error: new Error('offline') }));
  await until(() => f.state().status === 'error');
  assert.equal(f.calls(), 2);
  assert.match(f.state().error, /check your sign-in/);
  assert.ok(f.states.every(state => state.status !== 'ready'));
});

test('two stalled reads stop loading; an explicit retry recovers and duplicate clicks do not queue reads', async t => {
  const f = fixture(t, count => count <= 2 ? new Promise(() => {}) : result(owner));
  await until(() => f.state().status === 'error');
  assert.equal(f.calls(), 2);
  f.startup.retry();
  f.startup.retry();
  await until(() => f.state().status === 'ready');
  assert.equal(f.calls(), 3);
  assert.equal(f.state().session, owner);
});

test('sign-in event releases a stalled loader and wins over a late anonymous read', async t => {
  const pending = deferred();
  const f = fixture(t, () => pending.promise);
  await tick();
  f.event('SIGNED_IN', owner);
  assert.deepEqual(f.state(), { status: 'ready', session: owner, error: null });
  pending.resolve(result(null));
  await tick();
  assert.equal(f.state().session, owner);
  assert.equal(f.calls(), 1);
});

test('authoritative sign-out wins over a late authenticated read', async t => {
  const pending = deferred();
  const f = fixture(t, () => pending.promise);
  await tick();
  f.event('SIGNED_OUT', null);
  pending.resolve(result(owner));
  await tick();
  assert.deepEqual(f.state(), { status: 'ready', session: null, error: null });
});

test('a null refresh or late initial event cannot clear an established session', async t => {
  const f = fixture(t, () => result(owner));
  await until(() => f.state().status === 'ready');
  f.event('TOKEN_REFRESHED', null);
  f.event('INITIAL_SESSION', null);
  assert.equal(f.state().session, owner);
  const refreshed = { ...owner, access_token: 'refreshed-fixture-token' };
  f.event('TOKEN_REFRESHED', refreshed);
  assert.equal(f.state().session, refreshed);
});

test('null INITIAL_SESSION on a failed provider read is not proof of sign-out', async t => {
  const f = fixture(t, () => ({ data: { session: null }, error: new Error('offline') }));
  f.event('INITIAL_SESSION', null);
  assert.equal(f.state().status, 'loading');
  await until(() => f.state().status === 'error');
  assert.ok(f.states.every(state => state.status !== 'ready'));
});

test('an auth event recovers an error screen and cancels pending retry work', async t => {
  const f = fixture(t, () => Promise.reject(new Error('offline')));
  await until(() => f.state().status === 'error');
  f.event('SIGNED_IN', owner);
  assert.equal(f.state().status, 'ready');
  assert.equal(f.state().error, null);
  f.startup.retry();
  assert.equal(f.calls(), 2);
});

test('obsolete timed-out read cannot overwrite a successful retry', async t => {
  const old = deferred();
  const f = fixture(t, count => count === 1 ? old.promise : result(owner));
  await until(() => f.state().status === 'ready');
  old.resolve(result(null));
  await tick();
  assert.equal(f.state().session, owner);
});

test('dispose removes subscription and ignores late promises/events', async t => {
  const pending = deferred();
  const f = fixture(t, () => pending.promise);
  await tick();
  const count = f.states.length;
  f.startup.dispose();
  pending.reject(new Error('late failure'));
  f.event('SIGNED_IN', owner);
  await tick();
  assert.equal(f.states.length, count);
  assert.equal(f.unsubscribed(), 1);
  assert.equal(f.calls(), 1);
});

test('synchronous throws and malformed responses fail safely', async t => {
  for (const read of [() => { throw new Error('lock'); }, () => ({}), () => result(undefined)]) {
    const f = fixture(t, read);
    await until(() => f.state().status === 'error');
    assert.equal(f.calls(), 2);
    assert.ok(f.states.every(state => state.status !== 'ready'));
  }
});

test('missing auth configuration finishes with an error, not an endless loader', () => {
  const states = [];
  const startup = startAuthStartup({ auth: null, onChange: state => states.push(state) });
  assert.equal(states.at(-1).status, 'error');
  startup.dispose();
});

test('synchronous initial auth event is accepted without another lookup', () => {
  const states = [];
  const startup = startAuthStartup({
    auth: {
      onAuthStateChange(fn) { fn('INITIAL_SESSION', owner); return { data: { subscription: { unsubscribe() {} } } }; },
      getSession() { assert.fail('initial event already resolved auth'); },
    },
    onChange: state => states.push(state),
  });
  assert.equal(states.at(-1).session, owner);
  startup.dispose();
});
