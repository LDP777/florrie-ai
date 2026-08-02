/**
 * The Florrie-thinks feed's two gate functions, tested pure. Ranking decides
 * which three cards earn Ellie's attention (money first, urgency second);
 * dropExpired is the rule that killed the old cards' "book a June date in
 * August" failure, so its frame handling (wall vs utc) matters as much as the
 * comparison itself.
 */
import { describe, it, expect } from 'vitest';
import { rankCards, dropExpired, MAX_CARDS } from '../../src/lib/florrie-thinks-rank.js';

const card = (over = {}) => ({
  id: 'x', impact_pence: 0, urgency: 0,
  expires_at: '2099-01-01T00:00:00Z', expires_frame: 'utc',
  ...over,
});

describe('rankCards', () => {
  it('orders by money at stake, highest first', () => {
    const out = rankCards([
      card({ id: 'small', impact_pence: 500 }),
      card({ id: 'big', impact_pence: 4500 }),
      card({ id: 'mid', impact_pence: 2000 }),
    ]);
    expect(out.map(c => c.id)).toEqual(['big', 'mid', 'small']);
  });

  it('breaks money ties on urgency, highest first', () => {
    const out = rankCards([
      card({ id: 'later', impact_pence: 3000, urgency: 40 }),
      card({ id: 'now', impact_pence: 3000, urgency: 80 }),
    ]);
    expect(out.map(c => c.id)).toEqual(['now', 'later']);
  });

  it('caps the feed at three: Florrie thinks, she does not nag', () => {
    const cards = [1, 2, 3, 4, 5].map(n => card({ id: `c${n}`, impact_pence: n * 100 }));
    const out = rankCards(cards);
    expect(out).toHaveLength(MAX_CARDS);
    expect(out.map(c => c.id)).toEqual(['c5', 'c4', 'c3']);
  });

  it('treats missing figures as zero so no card wins a slot by omission', () => {
    const out = rankCards([
      card({ id: 'nofigures', impact_pence: undefined, urgency: undefined }),
      card({ id: 'penny', impact_pence: 1 }),
    ]);
    expect(out[0].id).toBe('penny');
    // NaN-ish inputs must not poison the sort either.
    const nan = rankCards([
      card({ id: 'nan', impact_pence: NaN }),
      card({ id: 'real', impact_pence: 200 }),
    ]);
    expect(nan[0].id).toBe('real');
  });

  it('does not mutate the input array', () => {
    const cards = [card({ id: 'a', impact_pence: 1 }), card({ id: 'b', impact_pence: 2 })];
    rankCards(cards);
    expect(cards.map(c => c.id)).toEqual(['a', 'b']);
  });
});

describe('dropExpired', () => {
  // A fixed pair of "nows": pretend the salon wall clock runs an hour ahead
  // of UTC, exactly the BST situation the frames exist for.
  const nowUtcMs = Date.parse('2026-08-02T12:00:00Z');
  const nowWallMs = Date.parse('2026-08-02T13:00:00Z');
  const nows = { nowUtcMs, nowWallMs };

  it('drops a card past its utc expiry and keeps a future one', () => {
    const out = dropExpired([
      card({ id: 'gone', expires_at: '2026-08-02T11:59:00Z' }),
      card({ id: 'alive', expires_at: '2026-08-02T12:01:00Z' }),
    ], nows);
    expect(out.map(c => c.id)).toEqual(['alive']);
  });

  it('compares wall stamps against the wall clock, never real UTC', () => {
    // 12:30 wall: already past on the wall clock (13:00) even though real UTC
    // (12:00) has not reached it. Comparing in the wrong frame keeps this
    // card alive for an hour it does not have; that is the BST drift bug.
    const out = dropExpired([
      card({ id: 'wall-gone', expires_at: '2026-08-02T12:30:00Z', expires_frame: 'wall' }),
      card({ id: 'wall-alive', expires_at: '2026-08-02T13:30:00Z', expires_frame: 'wall' }),
    ], nows);
    expect(out.map(c => c.id)).toEqual(['wall-alive']);
  });

  it('drops any card without a parseable expires_at: unanchored cards never render', () => {
    const out = dropExpired([
      card({ id: 'none', expires_at: null }),
      card({ id: 'junk', expires_at: 'not-a-date' }),
      card({ id: 'ok' }),
    ], nows);
    expect(out.map(c => c.id)).toEqual(['ok']);
  });

  it('handles an empty or missing list without complaint', () => {
    expect(dropExpired([], nows)).toEqual([]);
    expect(dropExpired(null, nows)).toEqual([]);
  });
});
