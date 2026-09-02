/**
 * The overage month that was marked billed and never charged.
 *
 * billMonthlySurplus claimed each message_usage row (billed=true) BEFORE
 * checking whether the account could be charged at all. A month that came
 * up for billing while the account was still on trial was therefore flipped
 * to billed with nothing charged, and it stayed billed forever: when the
 * salon upgraded the following week, that month's overage was gone.
 *
 * The skip now sits above the claim, so a month that cannot be charged yet
 * stays unclaimed and is picked up by the first run after the account pays.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const db = { message_usage: [] };
const claims = [];

function builder(table) {
  const filters = [];
  let pending = null;
  const rows = () => (db[table] || []).filter(r => filters.every(f => f(r)));
  const settle = () => {
    if (pending) {
      const hit = rows();
      if ('billed' in pending) claims.push({ ids: hit.map(r => r.id), billed: pending.billed });
      for (const r of hit) Object.assign(r, pending);
      return { data: hit.map(r => ({ id: r.id })), error: null };
    }
    return { data: rows(), error: null };
  };
  const b = {
    select() { return b; },
    update(p) { pending = p; return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    gt(c, v) { filters.push(r => r[c] > v); return b; },
    lt(c, v) { filters.push(r => r[c] < v); return b; },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({ supabase: { from: builder } }));
vi.mock('../../src/lib/logger.js', () => ({
  default: { info() {}, warn() {}, error() {}, debug() {} },
}));

const invoiceItems = [];
vi.mock('stripe', () => ({
  default: class FakeStripe {
    constructor() {
      return {
        invoiceItems: {
          create: async (params, opts) => { invoiceItems.push({ params, opts }); return { id: 'ii_1', invoice: null }; },
        },
      };
    }
  },
}));

process.env.STRIPE_SECRET_KEY = 'sk_test_metering';
const { billMonthlySurplus } = await import('../../src/services/whatsapp-metering.js');

const usageRow = (over = {}) => ({
  id: 'mu_1',
  beautician_id: 'biz-1',
  month: '2026-07-01',
  billed: false,
  overage_total_pence: 240,
  overage_sms_count: 4,
  overage_wa_count: 2,
  beauticians: { stripe_customer_id: 'cus_ellie', subscription_plan: 'trial' },
  ...over,
});

beforeEach(() => {
  db.message_usage = [];
  claims.length = 0;
  invoiceItems.length = 0;
});

describe('billMonthlySurplus and the trial skip', () => {
  it('leaves a trial month UNCLAIMED so it is billed once the account pays', async () => {
    db.message_usage = [usageRow()];
    const result = await billMonthlySurplus();

    expect(result.skipped).toBe(1);
    expect(invoiceItems).toHaveLength(0);
    // The row was never touched: no claim, billed still false.
    expect(claims).toHaveLength(0);
    expect(db.message_usage[0].billed).toBe(false);
  });

  it('the same month is charged by the next run after the upgrade', async () => {
    db.message_usage = [usageRow()];
    await billMonthlySurplus();

    db.message_usage[0].beauticians = { stripe_customer_id: 'cus_ellie', subscription_plan: 'florrie' };
    const result = await billMonthlySurplus();

    expect(result.charged).toBe(1);
    expect(invoiceItems).toHaveLength(1);
    expect(invoiceItems[0].params.customer).toBe('cus_ellie');
    expect(invoiceItems[0].params.amount).toBe(240);
    expect(db.message_usage[0].billed).toBe(true);
  });

  it('a salon with no Stripe customer is also left unclaimed', async () => {
    db.message_usage = [usageRow({ beauticians: { stripe_customer_id: null, subscription_plan: 'florrie' } })];
    await billMonthlySurplus();
    expect(claims).toHaveLength(0);
    expect(db.message_usage[0].billed).toBe(false);
  });

  it('a paid salon is still claimed before the Stripe call, so a double run cannot double charge', async () => {
    db.message_usage = [usageRow({ beauticians: { stripe_customer_id: 'cus_ellie', subscription_plan: 'florrie' } })];
    await billMonthlySurplus();
    expect(claims[0]).toEqual({ ids: ['mu_1'], billed: true });
    expect(invoiceItems[0].opts.idempotencyKey).toBe('msgusage_mu_1');
  });
});
