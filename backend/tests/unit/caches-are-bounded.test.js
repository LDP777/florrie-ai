/**
 * Module-scope Maps that grow with the customer base must evict.
 *
 * Six of them did not: payment idempotency keys, the "messages waiting" push
 * throttle, the coach rate limiter, the per-beautician name matcher and the
 * two WhatsApp WABA caches. Each was a slow leak that would only ever show up
 * as a container restarted more and more often. These tests drive the ones
 * that can be driven without a network and assert the ceiling holds, and
 * that pruning never changes the answer for an entry still inside its window.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { pruneExpired, capSize, touch } from '../../src/lib/bounded-cache.js';

vi.mock('../../src/config.js', () => ({ supabase: { from: () => { throw new Error('no database here'); } } }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth: (req, _res, next) => next() }));

describe('bounded-cache helpers', () => {
  it('capSize evicts oldest first and touch moves an entry to the young end', () => {
    const m = new Map([['a', 1], ['b', 2], ['c', 3]]);
    touch(m, 'a', 1);
    expect(capSize(m, 2)).toBe(1);
    expect([...m.keys()]).toEqual(['c', 'a']);
  });

  it('pruneExpired removes exactly what the predicate calls stale', () => {
    const m = new Map([['old', 1], ['new', 100]]);
    expect(pruneExpired(m, v => v < 50)).toBe(1);
    expect([...m.keys()]).toEqual(['new']);
  });
});

describe('coach rate limiter', () => {
  it('prunes closed windows and caps live ones, without loosening the limit', async () => {
    const { checkRateLimit, rateLimitEntryCount } = await import('../../src/routes/coach.js');
    const t0 = 1_000_000;
    // One beautician uses up her window.
    for (let i = 0; i < 8; i++) expect(checkRateLimit('hot', t0 + i)).toBe(true);
    expect(checkRateLimit('hot', t0 + 9)).toBe(false);

    // A tide of other beauticians inside the same window: the map is capped.
    for (let i = 0; i < 6000; i++) checkRateLimit(`b${i}`, t0 + 10);
    expect(rateLimitEntryCount()).toBeLessThanOrEqual(5000);

    // Eleven minutes on, every window has closed and the sweep clears them.
    checkRateLimit('later', t0 + 11 * 60 * 1000);
    expect(rateLimitEntryCount()).toBeLessThan(10);
    // And the limit itself still works for a fresh window.
    for (let i = 0; i < 8; i++) checkRateLimit('again', t0 + 12 * 60 * 1000);
    expect(checkRateLimit('again', t0 + 12 * 60 * 1000 + 1)).toBe(false);
  });
});

describe('payment idempotency keys', () => {
  it('still blocks a double tap and stays under its ceiling in a burst', async () => {
    const sec = await import('../../src/middleware/security.js');
    sec.resetIdempotencyKeys();
    const finishers = [];
    const mkReq = (key) => ({ headers: { 'idempotency-key': key }, path: '/refund', method: 'POST', ip: '1.1.1.1' });
    const mkRes = () => {
      const res = { statusCode: 200, status(s) { res.statusCode = s; return res; }, json() { return res; }, on(_e, fn) { finishers.push(fn); } };
      return res;
    };
    let passed = 0;
    const next = () => { passed++; };

    sec.idempotencyGuard(mkReq('same'), mkRes(), next);
    sec.idempotencyGuard(mkReq('same'), mkRes(), next);
    expect(passed).toBe(1);

    for (let i = 0; i < 3000; i++) sec.idempotencyGuard(mkReq(`k${i}`), mkRes(), next);
    expect(sec.idempotencyKeyCount()).toBeLessThanOrEqual(2000);
    sec.resetIdempotencyKeys();
  });
});

describe('name matcher cache', () => {
  it('holds at most 500 beauticians and keeps answering correctly past that', async () => {
    const { asksForHuman, _matcherCacheSize } = await import('../../src/lib/grounded-reply.js');
    for (let i = 0; i < 700; i++) asksForHuman('hello', `Owner${i}`);
    expect(_matcherCacheSize()).toBeLessThanOrEqual(500);
    // The oldest were evicted, not the whole cache, and a rebuilt matcher
    // gives the same answer.
    expect(asksForHuman('can I speak to Owner0', 'Owner0')).toBe(true);
    expect(_matcherCacheSize()).toBeLessThanOrEqual(500);
  });
});

describe('messages-waiting push throttle', () => {
  it('prunes entries past the window once the map is worth pruning', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const base = Date.now();
    vi.setSystemTime(base);
    // sendPush reads the database; the throttle decision happens before it.
    const push = await import('../../src/services/push-notifications.js');
    const attempts = [];
    for (let i = 0; i < 300; i++) {
      attempts.push(push.pushMessagesWaiting(`b${i}`, 'whatsapp').catch(() => null));
    }
    await Promise.all(attempts);
    expect(push._msgWaitingThrottleSize()).toBe(300);

    // Inside the window the same beautician is throttled, and nothing is pruned.
    expect(await push.pushMessagesWaiting('b1', 'whatsapp')).toEqual({ skipped: 'throttled' });

    // Sixteen minutes on, one new arrival sweeps the lot.
    vi.setSystemTime(base + 16 * 60 * 1000);
    await push.pushMessagesWaiting('fresh', 'whatsapp').catch(() => null);
    expect(push._msgWaitingThrottleSize()).toBe(1);
    vi.useRealTimers();
  });
});
