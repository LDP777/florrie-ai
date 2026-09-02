/**
 * The per-client, per-salon budget on inbound model calls.
 *
 * Until 2 September 2026 the only limit between a webhook and classifyIntent
 * was the IP rate limiter, and Meta delivers every salon's webhooks from the
 * same IPs. These pin the contract of lib/inbound-budget.js: twenty messages
 * per client per hour, three hundred per salon per hour, a window that slides
 * rather than resets, refusals that are not counted, and a Map that lets go
 * of keys it no longer needs.
 *
 * The module reads the clock, so every test here fixes the clock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  inboundBudget,
  __resetInboundBudget,
  __inboundBudgetSize,
  CLIENT_LIMIT_PER_HOUR,
  BEAUTICIAN_LIMIT_PER_HOUR,
} from '../../src/lib/inbound-budget.js';

const T0 = new Date('2026-09-02T09:00:00Z').getTime();
const MIN = 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  __resetInboundBudget();
});

afterEach(() => {
  vi.useRealTimers();
});

const send = (n, { beauticianId = 'b1', clientId = 'c1', now } = {}) => {
  let last;
  for (let i = 0; i < n; i += 1) last = inboundBudget({ beauticianId, clientId, now });
  return last;
};

describe('a client under the limit', () => {
  it('is allowed, and told how many she has used', () => {
    const first = inboundBudget({ beauticianId: 'b1', clientId: 'c1' });
    expect(first).toEqual({ allowed: true, count: 1, limit: CLIENT_LIMIT_PER_HOUR, reason: null });

    const nineteenth = send(18);
    expect(nineteenth.allowed).toBe(true);
    expect(nineteenth.count).toBe(19);
  });

  it('reads the clock when no `now` is passed', () => {
    send(CLIENT_LIMIT_PER_HOUR);
    expect(inboundBudget({ beauticianId: 'b1', clientId: 'c1' }).allowed).toBe(false);
    vi.setSystemTime(T0 + 61 * MIN);
    expect(inboundBudget({ beauticianId: 'b1', clientId: 'c1' }).allowed).toBe(true);
  });
});

describe('the twenty-first message in an hour', () => {
  it('is blocked, names the client limit, and is not counted', () => {
    const twentieth = send(CLIENT_LIMIT_PER_HOUR);
    expect(twentieth.allowed).toBe(true);
    expect(twentieth.count).toBe(20);

    const blocked = inboundBudget({ beauticianId: 'b1', clientId: 'c1' });
    expect(blocked).toEqual({ allowed: false, count: 20, limit: CLIENT_LIMIT_PER_HOUR, reason: 'client_limit' });

    // Trying again does not push the window out: still twenty, not twenty-one.
    const again = inboundBudget({ beauticianId: 'b1', clientId: 'c1' });
    expect(again.count).toBe(20);
  });

  it('does not block a different client of the same salon', () => {
    send(CLIENT_LIMIT_PER_HOUR);
    expect(inboundBudget({ beauticianId: 'b1', clientId: 'c2' }).allowed).toBe(true);
  });

  it('does not block the same client id at a different salon', () => {
    send(CLIENT_LIMIT_PER_HOUR);
    expect(inboundBudget({ beauticianId: 'b2', clientId: 'c1' }).allowed).toBe(true);
  });
});

describe('the window slides', () => {
  it('lets one message back in as each old one ages out, not all at once', () => {
    // Ten at 09:00, ten at 09:30. Full.
    send(10, { now: T0 });
    send(10, { now: T0 + 30 * MIN });
    expect(inboundBudget({ beauticianId: 'b1', clientId: 'c1', now: T0 + 31 * MIN }).allowed).toBe(false);

    // 09:59: the 09:00 batch is still inside the hour.
    expect(inboundBudget({ beauticianId: 'b1', clientId: 'c1', now: T0 + 59 * MIN }).allowed).toBe(false);

    // 10:01: the 09:00 batch has gone, so there is room for ten, no more.
    vi.setSystemTime(T0 + 61 * MIN);
    const tenth = send(10);
    expect(tenth.allowed).toBe(true);
    expect(tenth.count).toBe(20);
    expect(inboundBudget({ beauticianId: 'b1', clientId: 'c1' }).allowed).toBe(false);

    // 10:31: the 09:30 batch has gone too.
    vi.setSystemTime(T0 + 91 * MIN);
    expect(inboundBudget({ beauticianId: 'b1', clientId: 'c1' }).count).toBe(11);
  });
});

describe('the per-salon cap', () => {
  it('blocks the three hundred and first message across many clients', () => {
    // Fifteen clients at twenty each is exactly the salon limit, and none of
    // them individually over theirs.
    for (let c = 0; c < BEAUTICIAN_LIMIT_PER_HOUR / CLIENT_LIMIT_PER_HOUR; c += 1) {
      const last = send(CLIENT_LIMIT_PER_HOUR, { clientId: `c${c}` });
      expect(last.allowed).toBe(true);
    }

    const blocked = inboundBudget({ beauticianId: 'b1', clientId: 'brand-new' });
    expect(blocked).toEqual({ allowed: false, count: 300, limit: BEAUTICIAN_LIMIT_PER_HOUR, reason: 'beautician_limit' });

    // Another salon is unaffected.
    expect(inboundBudget({ beauticianId: 'b2', clientId: 'brand-new' }).allowed).toBe(true);

    // And the salon window slides like the client one does.
    vi.setSystemTime(T0 + 61 * MIN);
    expect(inboundBudget({ beauticianId: 'b1', clientId: 'brand-new' }).allowed).toBe(true);
  });

  it('a message with no client row still counts against the salon', () => {
    send(5, { clientId: null });
    for (let i = 0; i < 5; i += 1) inboundBudget({ beauticianId: 'b1', clientId: undefined });
    expect(__inboundBudgetSize().clients).toBe(1);
    expect(inboundBudget({ beauticianId: 'b1', clientId: null }).count).toBe(11);
  });
});

describe('eviction', () => {
  it('prunes a key in place when it is touched after its window has passed', () => {
    send(3, { clientId: 'c1' });
    send(3, { clientId: 'c2' });
    expect(__inboundBudgetSize()).toEqual({ clients: 2, beauticians: 1 });

    // An hour on, c1 speaks again: her old three are gone, so this is her
    // first, and the salon's first. c2 is untouched and waits for the sweep.
    vi.setSystemTime(T0 + 61 * MIN);
    const back = inboundBudget({ beauticianId: 'b1', clientId: 'c1' });
    expect(back.count).toBe(1);
    expect(__inboundBudgetSize()).toEqual({ clients: 2, beauticians: 1 });
  });

  it('the periodic sweep removes stale keys nobody touches again', () => {
    // Five hundred strangers, one message each: the shape that grows.
    for (let i = 0; i < 500; i += 1) inboundBudget({ beauticianId: `b${i % 7}`, clientId: `stranger-${i}` });
    expect(__inboundBudgetSize().clients).toBe(500);
    expect(__inboundBudgetSize().beauticians).toBe(7);

    // An hour on, a different salon's traffic. The sweep runs every 200 calls
    // and must not wait for the stale keys' owners to come back.
    vi.setSystemTime(T0 + 61 * MIN);
    for (let i = 0; i < 200; i += 1) inboundBudget({ beauticianId: 'b-live', clientId: `c${i % 5}` });
    const size = __inboundBudgetSize();
    expect(size.clients).toBe(5);
    expect(size.beauticians).toBe(1);
  });

  it('never grows past the live population, however long it runs', () => {
    // Twenty four hours of one new stranger a minute, plus a chatty regular.
    for (let m = 0; m < 24 * 60; m += 1) {
      vi.setSystemTime(T0 + m * MIN);
      inboundBudget({ beauticianId: 'b1', clientId: `stranger-${m}` });
      inboundBudget({ beauticianId: 'b1', clientId: 'regular' });
    }
    // At most an hour's worth of strangers, the regular, and one salon, with
    // some slack for the sweep interval.
    expect(__inboundBudgetSize().clients).toBeLessThanOrEqual(60 + 1 + 200);
    expect(__inboundBudgetSize().beauticians).toBe(1);
  });
});
