import { describe, it, expect } from 'vitest';
import { reconcile, RECONCILIATION_DEFAULTS } from '../../src/lib/reconciliation-diff.js';

// The nightly reconciliation is the only thing standing between a rejected
// insert and money that quietly disappears. These pin the three finding
// classes, each of which maps to an incident that actually happened.

const NOW = Date.parse('2026-08-02T22:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const ago = (hours) => NOW - hours * HOUR;

const stripePayment = (over = {}) => ({
  id: 'pi_test',
  amountPence: 1000,
  createdMs: ago(6),
  status: 'succeeded',
  destination: 'acct_ellie',
  appointmentId: null,
  beauticianId: null,
  ...over,
});

const localTx = (over = {}) => ({
  id: 'tx_test',
  stripePaymentIntentId: 'pi_test',
  amountPence: 1000,
  appointmentId: null,
  createdMs: ago(6),
  type: 'payment',
  status: 'completed',
  ...over,
});

const completedAppt = (over = {}) => ({
  id: 'appt_test',
  beauticianId: 'b1',
  clientId: 'c1',
  pricePence: 4500,
  completedAtMs: ago(6),
  ...over,
});

const run = (input) => reconcile(input, { nowMs: NOW });

describe('reconciliation diff', () => {
  it('reports nothing when Stripe and the ledger agree', () => {
    const out = run({
      stripePayments: [stripePayment({ id: 'pi_1', amountPence: 1000 })],
      localTransactions: [localTx({ id: 'tx_1', stripePaymentIntentId: 'pi_1', appointmentId: 'a1', amountPence: 1000 })],
      completedAppointments: [completedAppt({ id: 'a1', pricePence: 1000 })],
    });
    expect(out.clean).toBe(true);
    expect(out.findingCount).toBe(0);
    expect(out.counts).toEqual({ missingLocally: 0, missingAtStripe: 0, completedWithoutTakings: 0 });
  });

  // ── Class A: money at Stripe with no local transaction row ─────────────────
  // The payment_method = 'card' CHECK-constraint incident: cards were charged,
  // the insert was rejected, nothing was recorded.
  describe('class a, money at Stripe with no local row', () => {
    it('flags a settled destination charge that was never recorded', () => {
      const out = run({
        stripePayments: [stripePayment({ id: 'pi_lost', amountPence: 2500 })],
        localTransactions: [],
      });
      expect(out.counts.missingLocally).toBe(1);
      expect(out.missingLocally[0].paymentIntentId).toBe('pi_lost');
      expect(out.totals.missingLocallyPence).toBe(2500);
      expect(out.clean).toBe(false);
    });

    it('counts a processing charge, because the money has already left the card', () => {
      const out = run({ stripePayments: [stripePayment({ status: 'processing' })], localTransactions: [] });
      expect(out.counts.missingLocally).toBe(1);
    });

    it('ignores intents that never took money', () => {
      const out = run({
        stripePayments: [
          stripePayment({ id: 'pi_a', status: 'requires_payment_method' }),
          stripePayment({ id: 'pi_b', status: 'canceled' }),
        ],
        localTransactions: [],
      });
      expect(out.counts.missingLocally).toBe(0);
    });

    it('ignores platform subscription charges, which have no destination and no ledger row by design', () => {
      // Florrie billing her own subscribers is a platform PaymentIntent with
      // NO transfer_data.destination. Without this filter every monthly
      // subscription payment would be reported as lost client money.
      const out = run({
        stripePayments: [stripePayment({ id: 'pi_sub', destination: null })],
        localTransactions: [],
      });
      expect(out.counts.missingLocally).toBe(0);
    });

    it('ignores charges outside the 48 hour window', () => {
      const out = run({
        stripePayments: [stripePayment({ id: 'pi_old', createdMs: ago(60) })],
        localTransactions: [],
      });
      expect(out.counts.missingLocally).toBe(0);
    });

    it('gives very recent charges a grace period so in flight payments are not reported as lost', () => {
      const out = run({
        stripePayments: [stripePayment({ id: 'pi_fresh', createdMs: NOW - 60 * 1000 })],
        localTransactions: [],
      });
      expect(out.counts.missingLocally).toBe(0);
    });

    it('matches on payment intent id, not on amount', () => {
      const out = run({
        stripePayments: [stripePayment({ id: 'pi_x', amountPence: 1000 })],
        // Same money, different intent: a coincidental amount match must not
        // count as reconciled.
        localTransactions: [localTx({ id: 'tx_y', stripePaymentIntentId: 'pi_y', amountPence: 1000 })],
      });
      expect(out.counts.missingLocally).toBe(1);
      expect(out.counts.missingAtStripe).toBe(1);
    });
  });

  // ── Class B: local rows with no Stripe counterpart ─────────────────────────
  describe('class b, ledger rows with no Stripe counterpart', () => {
    it('flags a row claiming an intent Stripe has never heard of', () => {
      const out = run({
        stripePayments: [],
        localTransactions: [localTx({ id: 'tx_ghost', stripePaymentIntentId: 'pi_ghost', amountPence: 750 })],
      });
      expect(out.counts.missingAtStripe).toBe(1);
      expect(out.missingAtStripe[0].transactionId).toBe('tx_ghost');
      expect(out.totals.missingAtStripePence).toBe(750);
    });

    it('never flags cash, bank transfer or assumed takings rows', () => {
      // These carry no payment intent id at all. They have no Stripe
      // counterpart by design, and flagging them would bury the real findings.
      const out = run({
        stripePayments: [],
        localTransactions: [
          localTx({ id: 'tx_cash', stripePaymentIntentId: null }),
          localTx({ id: 'tx_auto', stripePaymentIntentId: undefined }),
        ],
      });
      expect(out.counts.missingAtStripe).toBe(0);
    });

    it('ignores refunds, which are money going the other way', () => {
      const out = run({
        stripePayments: [],
        localTransactions: [localTx({ id: 'tx_ref', stripePaymentIntentId: 'pi_ref', type: 'refund' })],
      });
      expect(out.counts.missingAtStripe).toBe(0);
    });

    it('ignores rows outside the window', () => {
      const out = run({
        stripePayments: [],
        localTransactions: [localTx({ stripePaymentIntentId: 'pi_old', createdMs: ago(72) })],
      });
      expect(out.counts.missingAtStripe).toBe(0);
    });
  });

  // ── Class C: completed appointments with nothing on the books ──────────────
  // The auto-complete silent loss: the appointment flips to completed, the
  // takings insert is rejected, Ellie believes she was paid.
  describe('class c, completed appointments with no takings', () => {
    it('flags a completed appointment with no income row at all', () => {
      const out = run({
        stripePayments: [],
        localTransactions: [],
        completedAppointments: [completedAppt({ id: 'a_lost', pricePence: 6000 })],
      });
      expect(out.counts.completedWithoutTakings).toBe(1);
      expect(out.completedWithoutTakings[0].appointmentId).toBe('a_lost');
      expect(out.totals.completedWithoutTakingsPence).toBe(6000);
    });

    it('accepts a deposit row as evidence the appointment is on the books', () => {
      const out = run({
        stripePayments: [],
        localTransactions: [localTx({ appointmentId: 'a_ok', type: 'deposit', amountPence: 1000, stripePaymentIntentId: null })],
        completedAppointments: [completedAppt({ id: 'a_ok', pricePence: 6000 })],
      });
      // Partial recording is a bookkeeping habit, not a system failure, so it
      // is deliberately not reported. Only a completely empty ledger is.
      expect(out.counts.completedWithoutTakings).toBe(0);
    });

    it('does not count a refund as income', () => {
      const out = run({
        stripePayments: [],
        localTransactions: [localTx({ appointmentId: 'a_ref', type: 'refund', stripePaymentIntentId: null })],
        completedAppointments: [completedAppt({ id: 'a_ref' })],
      });
      expect(out.counts.completedWithoutTakings).toBe(1);
    });

    it('ignores zero price appointments, which owe nothing', () => {
      const out = run({
        stripePayments: [],
        localTransactions: [],
        completedAppointments: [completedAppt({ id: 'a_free', pricePence: 0 })],
      });
      expect(out.counts.completedWithoutTakings).toBe(0);
    });

    it('ignores appointments completed outside the window', () => {
      const out = run({
        stripePayments: [],
        localTransactions: [],
        completedAppointments: [completedAppt({ id: 'a_old', completedAtMs: ago(72) })],
      });
      expect(out.counts.completedWithoutTakings).toBe(0);
    });

    it('sums income across several rows for the same appointment', () => {
      const out = run({
        stripePayments: [],
        localTransactions: [
          localTx({ id: 't1', appointmentId: 'a_multi', type: 'deposit', amountPence: 1000, stripePaymentIntentId: null }),
          localTx({ id: 't2', appointmentId: 'a_multi', type: 'payment', amountPence: 5000, stripePaymentIntentId: null }),
        ],
        completedAppointments: [completedAppt({ id: 'a_multi', pricePence: 6000 })],
      });
      expect(out.counts.completedWithoutTakings).toBe(0);
    });
  });

  describe('robustness', () => {
    it('handles empty and missing input without throwing', () => {
      expect(reconcile().clean).toBe(true);
      expect(reconcile({}, {}).findingCount).toBe(0);
      expect(reconcile({ stripePayments: null, localTransactions: null }).clean).toBe(true);
    });

    it('skips malformed rows rather than crashing the whole check', () => {
      const out = run({
        stripePayments: [null, stripePayment({ id: null }), stripePayment({ id: 'pi_real' })],
        localTransactions: [null, localTx({ stripePaymentIntentId: 'pi_real' })],
        completedAppointments: [null, { id: null }],
      });
      expect(out.counts.missingLocally).toBe(0);
      expect(out.findingCount).toBe(0);
    });

    it('reports all three classes together', () => {
      const out = run({
        stripePayments: [stripePayment({ id: 'pi_lost', amountPence: 2000 })],
        localTransactions: [localTx({ id: 'tx_ghost', stripePaymentIntentId: 'pi_ghost', amountPence: 500 })],
        completedAppointments: [completedAppt({ id: 'a_lost', pricePence: 3000 })],
      });
      expect(out.counts).toEqual({ missingLocally: 1, missingAtStripe: 1, completedWithoutTakings: 1 });
      expect(out.findingCount).toBe(3);
      expect(out.clean).toBe(false);
    });

    it('exposes the window and grace defaults the service relies on', () => {
      expect(RECONCILIATION_DEFAULTS.WINDOW_MS).toBe(48 * HOUR);
      expect(RECONCILIATION_DEFAULTS.GRACE_MS).toBe(15 * 60 * 1000);
    });
  });
});
