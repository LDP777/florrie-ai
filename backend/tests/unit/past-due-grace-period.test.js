/**
 * The first failed card attempt used to lock the diary mid-day.
 *
 * Stripe marks a subscription past_due the moment its first retry fails.
 * requireActiveSubscription blocked every paid status that was not 'active',
 * so an expired card meant the owner opened Florrie on the first of the month
 * and found a 403 where her appointments used to be, before any email had
 * told her why.
 *
 * Now past_due gets seven days measured from beauticians.payment_failed_at
 * (stamped by services/dunning.js), the response carries
 * X-Florrie-Billing: past_due so the frontend can show a banner, and only
 * after seven days does the door close, with a message that names the
 * billing page.
 *
 * payment_failed_at comes from a hand-applied migration. When the column is
 * not on the row at all, past_due is allowed through unconditionally with a
 * warning: schema drift must never lock out a paying customer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const warnings = [];
vi.mock('../../src/lib/logger.js', () => ({
  default: { info() {}, debug() {}, fatal() {}, error() {}, warn(...a) { warnings.push(a); } },
}));
vi.mock('../../src/middleware/auth.js', () => ({
  resolveBeautician: async () => ({ ok: false, reason: 'not_used_here' }),
}));

const { requireActiveSubscription, pastDueDecision, PAST_DUE_GRACE_DAYS, BILLING_HEADER, BILLING_PAGE_PATH } =
  await import('../../src/middleware/require-plan.js');

const DAY = 86400000;
const NOW = new Date('2026-09-02T10:00:00Z');

function run(beautician) {
  const headers = {};
  const res = {
    statusCode: 200,
    body: null,
    set(k, v) { headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  let nextCalled = false;
  requireActiveSubscription()({ beautician, originalUrl: '/api/appointments' }, res, () => { nextCalled = true; });
  return { nextCalled, headers, status: res.statusCode, body: res.body };
}

const paid = (over = {}) => ({ id: 'biz-1', subscription_plan: 'florrie', subscription_status: 'active', payment_failed_at: null, ...over });

beforeEach(() => {
  warnings.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('requireActiveSubscription', () => {
  it('active passes, with no billing header', () => {
    const r = run(paid());
    expect(r.nextCalled).toBe(true);
    expect(r.headers[BILLING_HEADER]).toBeUndefined();
  });

  it('past_due within seven days passes, with X-Florrie-Billing: past_due', () => {
    const r = run(paid({ subscription_status: 'past_due', payment_failed_at: new Date(NOW - 3 * DAY).toISOString() }));
    expect(r.nextCalled).toBe(true);
    expect(r.headers[BILLING_HEADER]).toBe('past_due');
  });

  it('past_due on the last hour of day seven still passes', () => {
    const r = run(paid({ subscription_status: 'past_due', payment_failed_at: new Date(NOW - (7 * DAY - 3600000)).toISOString() }));
    expect(r.nextCalled).toBe(true);
  });

  it('past_due after seven days is blocked, naming the billing page', () => {
    const r = run(paid({ subscription_status: 'past_due', payment_failed_at: new Date(NOW - 8 * DAY).toISOString() }));
    expect(r.nextCalled).toBe(false);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('payment_past_due');
    expect(r.body.billing_page).toBe(BILLING_PAGE_PATH);
    expect(r.body.error).toContain(BILLING_PAGE_PATH);
    expect(r.body.error).toContain(String(PAST_DUE_GRACE_DAYS));
  });

  it('past_due with the column missing from the row passes, with a warning', () => {
    const row = paid({ subscription_status: 'past_due' });
    delete row.payment_failed_at;
    const r = run(row);
    expect(r.nextCalled).toBe(true);
    expect(r.headers[BILLING_HEADER]).toBe('past_due');
    expect(warnings.some(([, msg]) => /payment_failed_at is not readable/.test(msg))).toBe(true);
  });

  it('past_due with the column present but null passes: no clock has started', () => {
    const r = run(paid({ subscription_status: 'past_due', payment_failed_at: null }));
    expect(r.nextCalled).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it('cancelled is still blocked', () => {
    const r = run(paid({ subscription_status: 'cancelled' }));
    expect(r.nextCalled).toBe(false);
    expect(r.status).toBe(403);
  });

  it('past_due on the team plan gets the same grace', () => {
    const r = run(paid({ subscription_plan: 'florrie_team', subscription_status: 'past_due', payment_failed_at: new Date(NOW - DAY).toISOString() }));
    expect(r.nextCalled).toBe(true);
  });
});

describe('pastDueDecision', () => {
  it('reports days left so a banner can count down', () => {
    const d = pastDueDecision({ payment_failed_at: new Date(NOW - 2 * DAY).toISOString() }, NOW);
    expect(d).toMatchObject({ allow: true, reason: 'within_grace', daysLeft: 5 });
  });

  it('treats an unparseable timestamp as no clock started', () => {
    expect(pastDueDecision({ payment_failed_at: 'not a date' }, NOW).allow).toBe(true);
  });

  it('is exactly seven days', () => {
    expect(PAST_DUE_GRACE_DAYS).toBe(7);
    expect(pastDueDecision({ payment_failed_at: new Date(NOW - 7 * DAY).toISOString() }, NOW).allow).toBe(false);
  });
});
