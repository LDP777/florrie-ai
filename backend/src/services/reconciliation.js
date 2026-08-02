/**
 * Nightly money reconciliation.
 *
 * WHY THIS EXISTS
 * Three incidents, one root cause: nothing ever compared Stripe against the
 * ledger.
 *
 *   - Card charges failed to RECORD for weeks. transactions.payment_method
 *     was set to 'card', which the CHECK constraint rejects. Supabase returns
 *     errors in the result object rather than throwing, so the insert failed
 *     silently. Money left clients' cards. The books stayed empty.
 *   - The Stripe webhook failed signature verification for six weeks, so the
 *     fallback recorder that would have caught the above never ran either.
 *   - auto-complete.js DOES check its takings insert and logs the failure, and
 *     the money is still permanently lost, because nothing consumes that log.
 *
 * So this job reads both sides and reports the difference, every day, loudly.
 *
 * It REPORTS. It does not repair. Automatic correction of money is how you turn
 * one silent bug into a second, louder one; a human decides what to do with
 * each finding. See docs/MONEY_RECONCILIATION.sql for the manual queries this
 * automates.
 */
import Stripe from 'stripe';
import * as Sentry from '@sentry/node';
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { reconcile, RECONCILIATION_DEFAULTS } from '../lib/reconciliation-diff.js';

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const WINDOW_MS = RECONCILIATION_DEFAULTS.WINDOW_MS; // 48 hours

// Both sides are fetched over a slightly wider span than the window we report
// on, so a payment made just before the window edge and recorded just inside it
// (or the other way round) is not reported as a mismatch. The pure diff applies
// the real window; this padding only widens what it has to look at.
const FETCH_PADDING_MS = 4 * 60 * 60 * 1000;

// Cap what goes into a Sentry event. The counts matter more than a complete
// list, and an unbounded array on a bad night is how you get an event dropped
// for being too large, which would be this module failing in exactly the way
// it exists to prevent.
const MAX_IDS_IN_EVENT = 25;

/**
 * Every client payment in this codebase is a platform-account PaymentIntent
 * with transfer_data.destination set to the beautician's Connect account, so
 * the platform account is the right place to look for all of it.
 */
async function fetchStripePayments(sinceMs) {
  if (!stripe) {
    return { ok: false, reason: 'stripe_not_configured', payments: [] };
  }
  try {
    const list = await stripe.paymentIntents.list({
      created: { gte: Math.floor(sinceMs / 1000) },
      limit: 100,
    });
    // autoPagingToArray needs an explicit ceiling. Two days of a pilot salon is
    // tens of intents; 1000 is a safety valve, not a real limit.
    const intents = await list.autoPagingToArray({ limit: 1000 });

    return {
      ok: true,
      payments: intents.map((pi) => ({
        id: pi.id,
        amountPence: pi.amount_received || pi.amount || 0,
        createdMs: (pi.created || 0) * 1000,
        status: pi.status,
        destination: pi.transfer_data?.destination || null,
        appointmentId: pi.metadata?.appointment_id || null,
        beauticianId: pi.metadata?.beautician_id || null,
      })),
      truncated: intents.length >= 1000,
    };
  } catch (err) {
    // A reconciliation that fails silently is worse than none at all: it
    // reports zero findings and everyone concludes the money is fine. So the
    // Stripe leg failing is itself an alert, and classes A and B are suppressed
    // below rather than computed against an empty list.
    logger.error({ err }, 'Reconciliation: Stripe fetch failed, money check INCOMPLETE');
    Sentry.captureException(err, {
      tags: { area: 'payments', check: 'reconciliation' },
      extra: { stage: 'stripe_payment_intents_list' },
    });
    return { ok: false, reason: err?.message || 'stripe_error', payments: [] };
  }
}

async function fetchLocalTransactions(sinceIso) {
  const { data, error } = await supabase
    .from('transactions')
    .select('id, stripe_payment_intent_id, amount_cents, appointment_id, created_at, type, status')
    .gte('created_at', sinceIso)
    .limit(2000);

  // Checked, because an unchecked result object is the original sin here.
  if (error) {
    logger.error({ err: error }, 'Reconciliation: transactions fetch failed, money check INCOMPLETE');
    Sentry.captureException(error, {
      tags: { area: 'payments', check: 'reconciliation' },
      extra: { stage: 'transactions_select' },
    });
    return { ok: false, reason: error.message, rows: [] };
  }

  return {
    ok: true,
    rows: (data || []).map((t) => ({
      id: t.id,
      stripePaymentIntentId: t.stripe_payment_intent_id || null,
      amountPence: t.amount_cents || 0,
      appointmentId: t.appointment_id || null,
      createdMs: Date.parse(t.created_at),
      type: t.type,
      status: t.status,
    })),
  };
}

async function fetchCompletedAppointments(sinceIso) {
  // completed_at is a REAL timestamp (set by services/auto-complete.js and
  // routes/appointments.js), unlike starts_at, which stores salon wall time in
  // the UTC slot. Filtering on completed_at is therefore safe to compare
  // against a normal ISO timestamp; filtering on starts_at would not be.
  const { data, error } = await supabase
    .from('appointments')
    .select('id, beautician_id, client_id, price_cents, completed_at')
    .eq('status', 'completed')
    .gte('completed_at', sinceIso)
    .limit(2000);

  if (error) {
    logger.error({ err: error }, 'Reconciliation: completed appointments fetch failed, money check INCOMPLETE');
    Sentry.captureException(error, {
      tags: { area: 'payments', check: 'reconciliation' },
      extra: { stage: 'appointments_select' },
    });
    return { ok: false, reason: error.message, rows: [] };
  }

  return {
    ok: true,
    rows: (data || []).map((a) => ({
      id: a.id,
      beauticianId: a.beautician_id || null,
      clientId: a.client_id || null,
      pricePence: a.price_cents || 0,
      completedAtMs: Date.parse(a.completed_at),
    })),
  };
}

const pence = (n) => `GBP ${((n || 0) / 100).toFixed(2)}`;

/**
 * Run the reconciliation over the last 48 hours.
 *
 * Throws only if something truly unexpected happens; the scheduler wraps this
 * in recordJobRun so a throw is recorded and sent to Sentry rather than lost.
 *
 * @returns {Promise<object>} summary. Never contains corrections, only findings.
 */
export async function runReconciliation({ nowMs = Date.now(), windowMs = WINDOW_MS } = {}) {
  const fetchSinceMs = nowMs - windowMs - FETCH_PADDING_MS;
  const fetchSinceIso = new Date(fetchSinceMs).toISOString();

  const [stripeResult, localResult, apptResult] = await Promise.all([
    fetchStripePayments(fetchSinceMs),
    fetchLocalTransactions(fetchSinceIso),
    fetchCompletedAppointments(fetchSinceIso),
  ]);

  const incomplete = [];
  if (!stripeResult.ok) incomplete.push(`stripe:${stripeResult.reason}`);
  if (!localResult.ok) incomplete.push(`transactions:${localResult.reason}`);
  if (!apptResult.ok) incomplete.push(`appointments:${apptResult.reason}`);

  const diff = reconcile({
    stripePayments: stripeResult.payments,
    localTransactions: localResult.rows,
    completedAppointments: apptResult.rows,
  }, { nowMs, windowMs });

  // Suppress the two cross-system classes when either side failed to load. With
  // an empty Stripe list every local row looks orphaned and every real finding
  // drowns in hundreds of false ones. An incomplete check must say so, not
  // invent findings and not pretend everything is clean.
  const crossSystemUsable = stripeResult.ok && localResult.ok;
  const summary = {
    ranAt: new Date(nowMs).toISOString(),
    windowHours: Math.round(windowMs / (60 * 60 * 1000)),
    complete: incomplete.length === 0,
    incomplete,
    // (a) money at Stripe with no local transaction row
    missingLocally: crossSystemUsable ? diff.missingLocally : [],
    // (b) local rows with no Stripe counterpart
    missingAtStripe: crossSystemUsable ? diff.missingAtStripe : [],
    // (c) completed appointments with no takings recorded
    completedWithoutTakings: apptResult.ok && localResult.ok ? diff.completedWithoutTakings : [],
    stripeTruncated: Boolean(stripeResult.truncated),
  };

  summary.counts = {
    missingLocally: summary.missingLocally.length,
    missingAtStripe: summary.missingAtStripe.length,
    completedWithoutTakings: summary.completedWithoutTakings.length,
  };
  summary.totals = {
    missingLocallyPence: summary.missingLocally.reduce((a, r) => a + (r.amountPence || 0), 0),
    missingAtStripePence: summary.missingAtStripe.reduce((a, r) => a + (r.amountPence || 0), 0),
    completedWithoutTakingsPence: summary.completedWithoutTakings.reduce((a, r) => a + (r.expectedPence || 0), 0),
  };
  summary.findingCount = summary.counts.missingLocally
    + summary.counts.missingAtStripe
    + summary.counts.completedWithoutTakings;

  if (summary.findingCount === 0 && summary.complete) {
    logger.info({
      windowHours: summary.windowHours,
      stripePayments: stripeResult.payments.length,
      localTransactions: localResult.rows.length,
      completedAppointments: apptResult.rows.length,
    }, 'Reconciliation: clean, Stripe and the ledger agree');
    return summary;
  }

  if (summary.findingCount > 0) {
    // Loud on purpose. The whole point of this job is that these lines exist
    // somewhere a person will see them within a day, not six weeks later.
    logger.error({
      counts: summary.counts,
      totals: summary.totals,
      missingLocally: summary.missingLocally.slice(0, MAX_IDS_IN_EVENT),
      missingAtStripe: summary.missingAtStripe.slice(0, MAX_IDS_IN_EVENT),
      completedWithoutTakings: summary.completedWithoutTakings.slice(0, MAX_IDS_IN_EVENT),
      incomplete: summary.incomplete,
    }, 'RECONCILIATION FOUND MONEY MISMATCHES: Stripe and the ledger disagree');

    Sentry.captureMessage('Reconciliation found money mismatches', {
      level: 'error',
      tags: { area: 'payments', check: 'reconciliation' },
      extra: {
        counts: summary.counts,
        moneyAtStripeNotRecorded: pence(summary.totals.missingLocallyPence),
        recordedButNotAtStripe: pence(summary.totals.missingAtStripePence),
        completedWithNoTakings: pence(summary.totals.completedWithoutTakingsPence),
        paymentIntentIdsMissingLocally: summary.missingLocally.slice(0, MAX_IDS_IN_EVENT).map((r) => r.paymentIntentId),
        transactionIdsMissingAtStripe: summary.missingAtStripe.slice(0, MAX_IDS_IN_EVENT).map((r) => r.transactionId),
        appointmentIdsWithNoTakings: summary.completedWithoutTakings.slice(0, MAX_IDS_IN_EVENT).map((r) => r.appointmentId),
        incomplete: summary.incomplete,
        windowHours: summary.windowHours,
      },
    });
  }

  if (!summary.complete) {
    logger.error({ incomplete: summary.incomplete }, 'RECONCILIATION INCOMPLETE: one side could not be read, treat a clean result as unknown');
    Sentry.captureMessage('Reconciliation could not complete', {
      level: 'error',
      tags: { area: 'payments', check: 'reconciliation' },
      extra: { incomplete: summary.incomplete },
    });
  }

  return summary;
}

export default runReconciliation;
