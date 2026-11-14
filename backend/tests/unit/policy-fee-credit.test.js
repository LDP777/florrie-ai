import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ appointment: null, rows: [], queries: [], readError: false, creates: [] }));
vi.mock('../../src/config.js', () => ({ supabase: { from(table) {
  const filters = [];
  const read = () => {
    state.queries.push({ table, filters });
    if (table === 'appointments') return { data: state.appointment, error: null };
    if (table === 'transactions') return state.readError
      ? { data: null, error: { message: 'unavailable' } }
      : { data: state.rows.filter(row => filters.every(([op, key, value]) => op === 'in' ? value.includes(row[key]) : row[key] === value)), error: null };
    return { data: null, error: null };
  };
  const query = {
    select() { return query; }, eq(key, value) { filters.push(['eq', key, value]); return query; },
    in(key, value) { filters.push(['in', key, value]); return query; },
    maybeSingle() { return Promise.resolve(read()); },
    then(resolve, reject) { return Promise.resolve(read()).then(resolve, reject); },
  };
  return query;
} } }));
vi.mock('stripe', () => ({ default: class { constructor() {
  this.paymentIntents = { create: async (...args) => { state.creates.push(args); throw new Error('Unexpected charge'); } };
} } }));
vi.mock('../../src/lib/logger.js', () => ({ default: { info() {}, warn() {}, error() {} } }));
const { computePolicyFee, quotePolicyFee, chargePolicyFee } = await import('../../src/services/policy-fees.js');
const policy = { late_cancel_charge_percent: 100 };
const receipt = (type, cents, extra = {}) => ({
  id: 'r' + state.rows.length, beautician_id: 'owner', appointment_id: 'appt', type,
  amount_cents: cents, status: 'completed', payment_method: 'bank_transfer', ...extra,
});
beforeEach(() => {
  state.appointment = {
    id: 'appt', beautician_id: 'owner', price_cents: 3500, deposit_cents: 700,
    deposit_amount_cents: 0, deposit_paid: true, payment_type: 'deposit', policy_snapshot: policy,
  };
  state.rows = []; state.queries = []; state.readError = false; state.creates = [];
});

describe('policy fees credit actual money already received', () => {
  it('credits legacy paid deposits despite the database default zero', async () => {
    expect(computePolicyFee(state.appointment, policy, 'late_cancel').feeCents).toBe(2800);
    expect(await quotePolicyFee(state.appointment, policy, 'late_cancel')).toMatchObject({ feeCents: 2800, creditedCents: 700 });
  });

  it('counts a deposit receipt once and credits a recorded bank-transfer balance', async () => {
    state.rows = [receipt('deposit', 700), receipt('payment', 2800)];
    expect(await quotePolicyFee(state.appointment, policy, 'late_cancel')).toMatchObject({ feeCents: 0, creditedCents: 3500 });
    expect(await chargePolicyFee('appt', 'late_cancel')).toMatchObject({ charged: false, reason: 'no_fee_configured' });
    expect(state.creates).toEqual([]);
  });

  it('credits a partial real balance without treating it as full settlement', async () => {
    state.rows = [receipt('deposit', 700), receipt('payment', 1000)];
    expect(await quotePolicyFee(state.appointment, policy, 'late_cancel')).toMatchObject({ feeCents: 1800, creditedCents: 1700 });
  });

  it('keeps a legacy deposit when the only later receipt is a real balance', async () => {
    state.rows = [receipt('payment', 2800)];
    expect((await quotePolicyFee(state.appointment, policy, 'late_cancel')).feeCents).toBe(0);
  });

  it.each(['full_payment', 'payment_link'])('credits %s without counting the field deposit twice', async type => {
    state.rows = [receipt(type, 3500, { stripe_payment_intent_id: 'pi_full' })];
    expect(await quotePolicyFee(state.appointment, policy, 'late_cancel')).toMatchObject({ feeCents: 0, creditedCents: 3500 });
  });

  it('credits a payment-link remainder when the deposit has its own receipt', async () => {
    state.rows = [receipt('deposit', 700), receipt('payment_link', 2800, { stripe_payment_intent_id: 'pi_balance' })];
    expect((await quotePolicyFee(state.appointment, policy, 'late_cancel')).feeCents).toBe(0);
  });

  it('does not guess whether an unreceipted legacy deposit is part of a partial payment link', async () => {
    state.rows = [receipt('payment_link', 700, { stripe_payment_intent_id: 'pi_link' })];
    await expect(quotePolicyFee(state.appointment, policy, 'late_cancel')).rejects.toThrow('need review');
    await chargePolicyFee('appt', 'late_cancel');
    expect(state.creates).toEqual([]);
  });

  it('ignores assumed takings, unpaid receipts, tips and another owner or appointment', async () => {
    state.rows = [
      receipt('payment', 2800, { payment_method: null, stripe_payment_intent_id: null }),
      receipt('payment', 2800, { status: 'pending' }), receipt('tip', 3500),
      receipt('payment', 3500, { beautician_id: 'someone-else' }),
      receipt('payment', 3500, { appointment_id: 'other-appt' }),
    ];
    expect((await quotePolicyFee(state.appointment, policy, 'late_cancel')).feeCents).toBe(2800);
    expect(state.queries.at(-1).filters).toContainEqual(['eq', 'beautician_id', 'owner']);
    expect(state.queries.at(-1).filters).toContainEqual(['eq', 'appointment_id', 'appt']);
  });

  it('subtracts recorded refunds from paid credit and clamps the fee at zero', async () => {
    state.rows = [receipt('full_payment', 3500), receipt('refund', -700)];
    expect((await quotePolicyFee(state.appointment, policy, 'late_cancel')).feeCents).toBe(700);
    state.rows = [receipt('deposit', 700), receipt('payment', 4000)];
    expect((await quotePolicyFee(state.appointment, policy, 'late_cancel')).feeCents).toBe(0);
  });

  it('does not credit a refunded deposit flag with no paid receipt', () => {
    expect(computePolicyFee({ ...state.appointment, deposit_status: 'refunded' }, policy, 'late_cancel').feeCents).toBe(3500);
  });

  it('refuses to charge if the ledger is unreadable', async () => {
    state.readError = true;
    await expect(quotePolicyFee(state.appointment, policy, 'late_cancel')).rejects.toThrow('Could not check');
    expect(await chargePolicyFee('appt', 'late_cancel')).toMatchObject({ charged: false, reason: 'error' });
    expect(state.creates).toEqual([]);
  });

  it('stops a queued charge if a real payment arrived after its quote', async () => {
    state.rows = [receipt('deposit', 700), receipt('payment', 1000)];
    expect(await chargePolicyFee('appt', 'late_cancel', { recovery: { expectedFeeCents: 2800 } })).toMatchObject({ charged: false, reason: 'fee_changed' });
    expect(state.creates).toEqual([]);
  });

  it('does not depend on a ledger read when the policy charges no fee', async () => {
    state.readError = true;
    expect(await quotePolicyFee(state.appointment, { late_cancel_charge_percent: 0 }, 'late_cancel')).toMatchObject({ feeCents: 0, percent: 0 });
    expect(state.queries).toEqual([]);
  });

  it('does not bypass a previous charge anchor for a fresh recovery intent', async () => {
    state.appointment.policy_fee_charged_at = '2026-11-14T10:00:00Z';
    expect(await chargePolicyFee('appt', 'late_cancel', { recovery: { expectedFeeCents: 2800 } })).toMatchObject({ charged: false, reason: 'already_charged' });
    expect(state.creates).toEqual([]);
  });
});
