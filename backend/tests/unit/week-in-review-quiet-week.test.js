/**
 * The week where nothing happened.
 *
 * Ellie's first Sunday on Florrie. No clients imported yet, no messages, no
 * gaps filled. The Sunday push correctly stays silent: buildPushCopy returns
 * null when there is nothing to report. But /week-review, the page that push
 * links to, rendered "~1h of admin you never had to do" under the headline "A
 * quiet week on the front desk", and the share button put the same claim in
 * her group chat.
 *
 * The floor was in the service: Math.max(1, Math.round(minutesSaved / 60)).
 * Zero work rounded up to one hour, forever, for everybody, and worst of all
 * for a brand new account whose numbers are all zero.
 *
 * These drive the real computeWeekReview against a Supabase double.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

/* ----------------------------------------------------------------- the db -- */
const db = {
  messages: [],
  ai_actions: [],
  appointments: [],
  transactions: [],
};

// Every query in computeWeekReview is "rows for this beautician in this
// window". The window is not what is under test, so the double hands back the
// seeded rows and a matching count.
function makeBuilder(table) {
  let headCount = false;
  const rows = () => db[table] || [];
  const b = {
    select(_cols, opts) { headCount = Boolean(opts?.head); return b; },
    eq() { return b; },
    neq() { return b; },
    gte() { return b; },
    lt() { return b; },
    limit() { return b; },
    then(res) {
      return Promise.resolve(
        headCount
          ? { data: null, count: rows().length, error: null }
          : { data: rows(), count: rows().length, error: null }
      ).then(res);
    },
  };
  return b;
}

const supabase = { from: table => makeBuilder(table) };

vi.mock('../../src/config.js', () => ({ supabase, supabaseAnon: supabase, supabaseAdmin: supabase }));
vi.mock('../../src/lib/logger.js', () => ({
  default: { info() {}, warn() {}, error() {}, debug() {}, fatal() {} },
}));
vi.mock('../../src/services/push-notifications.js', () => ({ pushTeamUpdate: async () => {} }));

const { computeWeekReview, formatTimeSaved } = await import('../../src/services/week-in-review.js');

beforeEach(() => {
  db.messages = [];
  db.ai_actions = [];
  db.appointments = [];
  db.transactions = [];
});

/* ================================================== the brand new account == */
describe('a week in which Florrie did nothing', () => {
  it('claims no hours saved at all', async () => {
    const stats = await computeWeekReview('brand-new-salon');

    // The bug: this was 1.
    expect(stats.hours_saved).toBe(0);
    expect(stats.minutes_saved).toBe(0);
  });

  it('reports zero for every other number too, so the page has nothing to dress up', async () => {
    const stats = await computeWeekReview('brand-new-salon');

    expect(stats.total_handled).toBe(0);
    expect(stats.messages_answered).toBe(0);
    expect(stats.gaps_filled).toBe(0);
    expect(stats.brought_back).toBe(0);
    expect(stats.bookings_taken).toBe(0);
    expect(stats.takings_pence).toBe(0);
  });
});

/* ========================================== a small but real week's work == */
describe('a week with a little real work in it', () => {
  it('reports the minutes rather than rounding them away to nothing', async () => {
    // Five AI-handled replies: 5 x 3 minutes = 15 minutes. Under an hour.
    db.messages = [1, 2, 3, 4, 5].map(i => ({ id: `m${i}` }));

    const stats = await computeWeekReview('quiet-but-not-empty');

    expect(stats.minutes_saved).toBe(15);
    expect(stats.hours_saved).toBe(0);        // honest: it was not an hour
    expect(formatTimeSaved(stats.minutes_saved)).toBe('15 minutes');
  });

  it('rounds a real hour to an hour', async () => {
    db.messages = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}` })); // 60 minutes

    const stats = await computeWeekReview('busy-enough');

    expect(stats.minutes_saved).toBe(60);
    expect(stats.hours_saved).toBe(1);
    expect(formatTimeSaved(stats.minutes_saved)).toBe('1 hour');
  });
});

/* ===================================================== the label helper === */
describe('formatTimeSaved', () => {
  it('returns null for nothing, so no caller can print a zero as an achievement', () => {
    expect(formatTimeSaved(0)).toBeNull();
    expect(formatTimeSaved(null)).toBeNull();
    expect(formatTimeSaved(undefined)).toBeNull();
    expect(formatTimeSaved(-5)).toBeNull();
  });

  it('says minutes under the hour and hours above it', () => {
    expect(formatTimeSaved(1)).toBe('1 minute');
    expect(formatTimeSaved(59)).toBe('59 minutes');
    expect(formatTimeSaved(90)).toBe('2 hours');
    expect(formatTimeSaved(360)).toBe('6 hours');
  });
});
