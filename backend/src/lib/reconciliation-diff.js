/**
 * Reconciliation diff: the pure, network-free heart of the nightly money check.
 *
 * WHY THIS EXISTS
 * Three separate incidents in this codebase had the same shape: money moved,
 * the local write failed, and nothing ever compared the two sides.
 *
 *   1. Nine code paths inserted transactions.payment_method = 'card', which
 *      violates the CHECK constraint. Supabase returns errors in the result
 *      object rather than throwing, so the insert failed silently for weeks.
 *      Cards were charged. The books stayed empty.
 *   2. The Stripe webhook failed signature verification for six weeks, so the
 *      fallback recorder that would have caught (1) never ran either.
 *   3. auto-complete.js DOES check its takings insert and logs the failure,
 *      and the money is still gone, because a log line nobody reads is the
 *      same as no check at all.
 *
 * The only defence that survives all three is a second pass that compares what
 * Stripe says happened against what the database says happened, on a schedule,
 * and shouts about the difference.
 *
 * This module is deliberately pure: no Supabase, no Stripe, no clock unless
 * you pass one in. That is what makes the rules testable, and the rules are
 * the part that has to be right.
 */

// Transaction types that represent money coming IN. A refund is money going
// back out, so it must never count as "this appointment was recorded", or a
// refunded booking would look reconciled when its income row is missing.
const INCOME_TYPES = new Set([
  'payment',
  'deposit',
  'full_payment',
  'no_show_fee',
  'late_cancel_fee',
  'tip',
]);

// Stripe states where money has genuinely left the client's card. 'processing'
// counts: the charge is in flight and will settle, and we would rather flag a
// row that is about to appear than miss one that never will.
const SETTLED_STRIPE_STATUSES = new Set(['succeeded', 'processing']);

const DEFAULT_WINDOW_MS = 48 * 60 * 60 * 1000;

// Grace at the recent edge of the window. A PaymentIntent created ninety
// seconds ago may legitimately have no local row yet: the confirm redirect or
// the webhook is still in flight. Without this, every run would report the
// last few minutes of normal traffic as missing money and the report would be
// noise, which is how a real finding gets ignored.
const DEFAULT_GRACE_MS = 15 * 60 * 1000;

const isIncome = (type) => INCOME_TYPES.has(String(type || '').toLowerCase());

/**
 * Compare Stripe against the local ledger and produce the three finding classes.
 *
 * All inputs are plain normalised objects so this can be tested without a
 * network. See toStripePayment / toLocalTransaction / toCompletedAppointment
 * in services/reconciliation.js for the mapping from live API and DB shapes.
 *
 * @param {object} input
 * @param {Array<{id:string, amountPence:number, createdMs:number, status:string,
 *                destination:?string, appointmentId:?string, beauticianId:?string}>} input.stripePayments
 * @param {Array<{id:string, stripePaymentIntentId:?string, amountPence:number,
 *                appointmentId:?string, createdMs:number, type:string, status:string}>} input.localTransactions
 * @param {Array<{id:string, beauticianId:?string, clientId:?string, pricePence:number,
 *                completedAtMs:number}>} input.completedAppointments
 * @param {object} [options]
 * @param {number} [options.nowMs]
 * @param {number} [options.windowMs]
 * @param {number} [options.graceMs]
 * @returns {object} summary with the three classes, counts and pence totals
 */
export function reconcile(input = {}, options = {}) {
  const stripePayments = Array.isArray(input.stripePayments) ? input.stripePayments : [];
  const localTransactions = Array.isArray(input.localTransactions) ? input.localTransactions : [];
  const completedAppointments = Array.isArray(input.completedAppointments) ? input.completedAppointments : [];

  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const windowMs = Number.isFinite(options.windowMs) ? options.windowMs : DEFAULT_WINDOW_MS;
  const graceMs = Number.isFinite(options.graceMs) ? options.graceMs : DEFAULT_GRACE_MS;

  const windowStartMs = nowMs - windowMs;
  const settledBeforeMs = nowMs - graceMs;
  const inWindow = (ms) => Number.isFinite(ms) && ms >= windowStartMs && ms <= settledBeforeMs;

  // Index the local ledger once. Two indexes because the two directions ask
  // different questions: "is this Stripe intent on the books" and "does this
  // appointment have any income at all".
  const localByIntent = new Map();
  const incomeByAppointment = new Map();
  for (const tx of localTransactions) {
    if (!tx) continue;
    const intentId = tx.stripePaymentIntentId || null;
    if (intentId && !localByIntent.has(intentId)) localByIntent.set(intentId, tx);
    if (tx.appointmentId && isIncome(tx.type) && Number(tx.amountPence) > 0) {
      const prior = incomeByAppointment.get(tx.appointmentId) || 0;
      incomeByAppointment.set(tx.appointmentId, prior + Number(tx.amountPence));
    }
  }

  const stripeIntentIds = new Set();
  for (const sp of stripePayments) {
    if (sp && sp.id) stripeIntentIds.add(sp.id);
  }

  // ── Class A: money at Stripe with no local transaction row ─────────────────
  // The 'card' CHECK-constraint incident, seen from the Stripe side. The card
  // was charged; the insert was rejected; nobody looked.
  const missingLocally = [];
  for (const sp of stripePayments) {
    if (!sp || !sp.id) continue;
    if (!SETTLED_STRIPE_STATUSES.has(String(sp.status || '').toLowerCase())) continue;

    // Only destination charges. Every client payment in this codebase is a
    // platform PaymentIntent with transfer_data.destination pointing at the
    // beautician's Connect account (see routes/stripe.js, routes/booking.js,
    // services/policy-fees.js). A PaymentIntent WITHOUT a destination is
    // Florrie billing her own subscribers, which has no transactions row by
    // design and would otherwise be reported as missing money every night.
    if (!sp.destination) continue;
    if (!inWindow(sp.createdMs)) continue;
    if (localByIntent.has(sp.id)) continue;

    missingLocally.push({
      paymentIntentId: sp.id,
      amountPence: Number(sp.amountPence) || 0,
      createdMs: sp.createdMs,
      destination: sp.destination,
      appointmentId: sp.appointmentId || null,
      beauticianId: sp.beauticianId || null,
    });
  }

  // ── Class B: local rows with no Stripe counterpart ─────────────────────────
  // A row claiming a Stripe payment intent that Stripe has never heard of means
  // the books are overstating income: a bad backfill, a test-mode id in live,
  // or a row written from a charge that was actually declined.
  const missingAtStripe = [];
  for (const tx of localTransactions) {
    if (!tx || !tx.stripePaymentIntentId) continue;
    // Cash, bank transfer and the "assumed" auto-complete rows carry no intent
    // id at all and are filtered out above. They have no Stripe counterpart by
    // design and flagging them would bury the real findings.
    if (String(tx.type || '').toLowerCase() === 'refund') continue;
    if (!inWindow(tx.createdMs)) continue;
    if (stripeIntentIds.has(tx.stripePaymentIntentId)) continue;

    missingAtStripe.push({
      transactionId: tx.id,
      paymentIntentId: tx.stripePaymentIntentId,
      amountPence: Number(tx.amountPence) || 0,
      createdMs: tx.createdMs,
      appointmentId: tx.appointmentId || null,
      type: tx.type || null,
    });
  }

  // ── Class C: completed appointments with no income row at all ──────────────
  // This is the auto-complete silent loss and the one-tap-complete gap. The
  // appointment is marked done, so Ellie believes she was paid, and the Money
  // tab counts nothing because the takings insert was rejected. Only zero rows
  // counts: a partially recorded appointment (deposit logged, balance taken in
  // cash and never keyed in) is a bookkeeping habit, not a system failure, and
  // reporting it nightly would train everyone to ignore this report.
  const completedWithoutTakings = [];
  for (const appt of completedAppointments) {
    if (!appt || !appt.id) continue;
    const pricePence = Number(appt.pricePence) || 0;
    // A zero-price appointment (comp, training model, price never set) owes no
    // money, so its empty ledger is correct rather than lost.
    if (pricePence <= 0) continue;
    if (!Number.isFinite(appt.completedAtMs)) continue;
    if (appt.completedAtMs < windowStartMs || appt.completedAtMs > nowMs) continue;
    if ((incomeByAppointment.get(appt.id) || 0) > 0) continue;

    completedWithoutTakings.push({
      appointmentId: appt.id,
      beauticianId: appt.beauticianId || null,
      clientId: appt.clientId || null,
      expectedPence: pricePence,
      completedAtMs: appt.completedAtMs,
    });
  }

  const sumPence = (rows, key) => rows.reduce((acc, r) => acc + (Number(r[key]) || 0), 0);

  const counts = {
    missingLocally: missingLocally.length,
    missingAtStripe: missingAtStripe.length,
    completedWithoutTakings: completedWithoutTakings.length,
  };

  return {
    windowStartMs,
    windowEndMs: nowMs,
    graceMs,
    missingLocally,
    missingAtStripe,
    completedWithoutTakings,
    counts,
    totals: {
      missingLocallyPence: sumPence(missingLocally, 'amountPence'),
      missingAtStripePence: sumPence(missingAtStripe, 'amountPence'),
      completedWithoutTakingsPence: sumPence(completedWithoutTakings, 'expectedPence'),
    },
    findingCount: counts.missingLocally + counts.missingAtStripe + counts.completedWithoutTakings,
    clean: counts.missingLocally === 0
      && counts.missingAtStripe === 0
      && counts.completedWithoutTakings === 0,
  };
}

export const RECONCILIATION_DEFAULTS = {
  WINDOW_MS: DEFAULT_WINDOW_MS,
  GRACE_MS: DEFAULT_GRACE_MS,
  INCOME_TYPES: [...INCOME_TYPES],
};
