/**
 * Background jobs spend money. Only for salons that are paying, or might.
 *
 * No job in jobs/register.js gated on subscription state. The autonomous
 * scheduler (rebook nudges, gap posts, patch test reminders, the AI front
 * desk) and the comeback engine ran for every row in beauticians, so a salon
 * whose trial ended in March, or whose card died and was never replaced,
 * kept burning SMS, WhatsApp templates and Claude tokens every two hours on
 * Florrie's bill.
 *
 * lib/billable.js is the one answer: trial (unexpired), active, past_due.
 * The scheduler test below drives the real runAutonomousCycle with a mixed
 * list and watches which salons it does work for.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const DAY = 86400000;
const NOW = new Date('2026-09-02T10:00:00Z');

/* ------------------------------------------------------------ the library */
const { isBillable, splitBillable, BILLABLE_COLUMNS } = await import('../../src/lib/billable.js');

describe('isBillable', () => {
  it('active and past_due are billable whatever the trial date says', () => {
    expect(isBillable({ subscription_status: 'active', trial_ends_at: null }, NOW)).toBe(true);
    expect(isBillable({ subscription_status: 'active', trial_ends_at: new Date(NOW - 90 * DAY).toISOString() }, NOW)).toBe(true);
    expect(isBillable({ subscription_status: 'past_due', trial_ends_at: null }, NOW)).toBe(true);
  });

  it('cancelled is never billable', () => {
    expect(isBillable({ subscription_status: 'cancelled', trial_ends_at: new Date(NOW.getTime() + 5 * DAY).toISOString() }, NOW)).toBe(false);
  });

  it('a trial is billable only while trial_ends_at is null or in the future', () => {
    expect(isBillable({ subscription_status: 'trial', trial_ends_at: null }, NOW)).toBe(true);
    expect(isBillable({ subscription_status: 'trial', trial_ends_at: new Date(NOW.getTime() + DAY).toISOString() }, NOW)).toBe(true);
    expect(isBillable({ subscription_status: 'trial', trial_ends_at: new Date(NOW - 1000).toISOString() }, NOW)).toBe(false);
  });

  it('nothing, or an unknown status, is not billable', () => {
    expect(isBillable(null, NOW)).toBe(false);
    expect(isBillable({}, NOW)).toBe(false);
    expect(isBillable({ subscription_status: 'unpaid' }, NOW)).toBe(false);
  });

  it('names only columns that 001_initial_schema.sql creates', () => {
    expect(BILLABLE_COLUMNS).toEqual(['subscription_status', 'trial_ends_at']);
  });
});

describe('splitBillable', () => {
  it('returns the billable rows and counts the rest by reason', () => {
    const list = [
      { id: 'a', subscription_status: 'active' },
      { id: 'b', subscription_status: 'cancelled' },
      { id: 'c', subscription_status: 'trial', trial_ends_at: new Date(NOW - DAY).toISOString() },
      { id: 'd', subscription_status: 'trial', trial_ends_at: new Date(NOW.getTime() + DAY).toISOString() },
      { id: 'e', subscription_status: 'cancelled' },
    ];
    const r = splitBillable(list, NOW);
    expect(r.billable.map(b => b.id)).toEqual(['a', 'd']);
    expect(r.skipped).toBe(3);
    expect(r.reasons).toEqual({ cancelled: 2, trial_expired: 1 });
  });

  it('copes with an empty or missing list', () => {
    expect(splitBillable(null).billable).toEqual([]);
    expect(splitBillable([]).skipped).toBe(0);
  });
});

/* ---------------------------------------------------------- the scheduler */
const db = { beauticians: [], clients: [], appointments: [], patch_tests: [], consultation_responses: [], ai_actions: [] };
let beauticianSelect = null;

function builder(table) {
  const filters = [];
  const rows = () => (db[table] || []).filter(r => filters.every(f => f(r)));
  const b = {
    select(cols) { if (table === 'beauticians' && !beauticianSelect) beauticianSelect = cols; return b; },
    insert() { return b; }, update() { return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    neq() { return b; }, in() { return b; }, is() { return b; }, not() { return b; },
    gte() { return b; }, lte() { return b; }, gt() { return b; }, lt() { return b; },
    or() { return b; }, like() { return b; }, order() { return b; }, limit() { return b; },
    maybeSingle() { return Promise.resolve({ data: rows()[0] || null, error: null }); },
    single() { return Promise.resolve({ data: rows()[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve({ data: rows(), error: null }).then(res, rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({ supabase: { from: builder } }));
const infoLogs = [];
vi.mock('../../src/lib/logger.js', () => ({
  default: { info(...a) { infoLogs.push(a); }, warn() {}, error() {}, debug() {} },
}));
vi.mock('../../src/services/notifications.js', () => ({ sendNudge: async () => ({ channel: 'sms' }) }));
vi.mock('../../src/lib/outbound-guard.js', () => ({ guardedSend: async () => ({ decision: 'skip', delivered: false }) }));
vi.mock('../../src/services/client-intelligence.js', () => ({ refreshAllIntelligence: async () => 0 }));
vi.mock('../../src/services/content-autopilot.js', () => ({ draftAvailabilityPost: async () => ({}) }));
vi.mock('../../src/services/ai-front-desk.js', () => ({ processInboundMessage: async () => ({}) }));
vi.mock('../../src/services/sms-metering.js', () => ({ shouldAutoSend: async () => ({ shouldSend: true }) }));
vi.mock('../../src/services/value-coaching.js', () => ({ runValueCoaching: async () => ({}) }));
vi.mock('../../src/services/review-requests.js', () => ({ processReviewRequests: async () => ({ sent: 0 }) }));
vi.mock('../../src/services/push-notifications.js', () => ({ pushTeamUpdate: async () => true }));

const workedFor = [];
vi.mock('../../src/services/gap-fill-engine.js', () => ({
  checkGapFillOpportunities: async (bid) => { workedFor.push(bid); return { matched: 0 }; },
}));

const { runAutonomousCycle } = await import('../../src/services/autonomous-scheduler.js');

describe('runAutonomousCycle', () => {
  beforeEach(() => {
    for (const t of Object.keys(db)) db[t] = [];
    workedFor.length = 0;
    infoLogs.length = 0;
    beauticianSelect = null;
    const base = { first_name: 'X', confidence_threshold: 0.9, auto_reply_enabled: true, tone_model: {}, autonomy: {} };
    db.beauticians = [
      { ...base, id: 'paying', subscription_plan: 'florrie', subscription_status: 'active', trial_ends_at: null },
      { ...base, id: 'lapsed', subscription_plan: 'trial', subscription_status: 'trial', trial_ends_at: new Date(Date.now() - 30 * DAY).toISOString() },
      { ...base, id: 'gone', subscription_plan: 'florrie', subscription_status: 'cancelled', trial_ends_at: null },
      { ...base, id: 'retrying', subscription_plan: 'florrie', subscription_status: 'past_due', trial_ends_at: null },
      { ...base, id: 'fresh', subscription_plan: 'trial', subscription_status: 'trial', trial_ends_at: new Date(Date.now() + 10 * DAY).toISOString() },
    ];
  });

  it('does work only for billable salons', async () => {
    await runAutonomousCycle();
    expect(workedFor.sort()).toEqual(['fresh', 'paying', 'retrying']);
  });

  it('logs once how many were skipped and why', async () => {
    await runAutonomousCycle();
    const skipLog = infoLogs.find(([, msg]) => /skipping non-billable/.test(msg));
    expect(skipLog).toBeTruthy();
    expect(skipLog[0]).toEqual({ skipped: 2, reasons: { trial_expired: 1, cancelled: 1 } });
  });

  it('asks the database for the columns isBillable needs', async () => {
    await runAutonomousCycle();
    for (const col of BILLABLE_COLUMNS) expect(beauticianSelect).toContain(col);
  });
});
