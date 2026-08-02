/**
 * Money guards: the shared vocabulary and the pure arithmetic behind every
 * "have we already taken this money / already written this row?" decision.
 *
 * WHY THIS EXISTS
 * The same guard was written four times, slightly differently, in four files
 * (services/policy-fees.js, services/auto-complete.js, lib/takings.js,
 * routes/booking.js). The lists drifted, and a drifted list is a real incident:
 * auto-complete's list was missing 'payment_link', so a client who paid by
 * payment link had a small deposit_cents left on the row, takings came out
 * positive, and the sweep logged a SECOND income row on top of money already
 * banked. One list, in one place, read by everybody.
 *
 * There is no supabase import here on purpose. Everything in this file is a
 * pure function of its arguments so it can be tested without a database, which
 * is the only way these rules stay honest.
 */

/**
 * CANONICAL VOCABULARY (transactions.type, per the live CHECK constraint set in
 * supabase/migrations/076):
 *
 *   payment        the treatment price, or what was left of it, collected
 *   full_payment   the whole price taken up front at booking
 *   payment_link   the whole price taken through a link Ellie sent
 *   deposit        the up-front slice taken at booking
 *   no_show_fee    policy fee, client did not turn up
 *   late_cancel_fee policy fee, client cancelled inside the notice window
 *   refund         money going back OUT to the client (amount_cents negative)
 *   tip            gratuity
 *   product_sale   retail, nothing to do with an appointment
 *
 * Two guard questions, two lists. They are different questions and always were,
 * which is how they drifted apart when each site invented its own answer.
 */

/**
 * Q1: "Has the treatment price for this appointment already been collected?"
 *
 * Any one of these rows means the client has settled the price (or the
 * remainder of it) and nothing further is owed on the treatment itself.
 *
 * Used by:
 *   - policy-fees.chargeRemainingBalance, to refuse a second charge. Ellie had
 *     a client who had paid in full showing "charge 10 to card", one tap from a
 *     double charge.
 *   - auto-complete + lib/takings.js, to refuse a second income row.
 */
export const PRICE_SETTLED_TYPES = Object.freeze(['payment', 'full_payment', 'payment_link']);

/**
 * Q2: "Has the money the client handed over AT BOOKING already been written to
 * the books?"
 *
 * The confirm-redirect in routes/booking.js is the only path that logs the
 * Checkout deposit (the webhook was dead for six weeks), and it can be replayed
 * simply by the client refreshing the tab. 'deposit' is the row it writes;
 * 'full_payment' and 'payment_link' are the same money arriving under a
 * different label when the client paid the lot up front, and either of them
 * means there is nothing left to log for this booking.
 */
export const BOOKING_MONEY_LOGGED_TYPES = Object.freeze(['deposit', 'full_payment', 'payment_link']);

/**
 * Types that represent money leaving the business again. Kept here so the
 * refund and dispute recorders agree on what counts as "already given back".
 */
export const MONEY_OUT_TYPES = Object.freeze(['refund']);

/**
 * Takings for a completed appointment: the price minus any deposit the client
 * has already paid, because that deposit was logged as its own income row at
 * booking time.
 *
 * Both completion paths must use this. They did not: POST /:id/complete logged
 * the FULL price while the auto-complete sweep logged the remainder, so the
 * same booking reported different income depending on which path happened to
 * finish it, over-reporting by exactly the deposit.
 */
export function completionTakingsCents(appt) {
  const price = Number(appt?.price_cents) || 0;
  const depositPaid = appt?.deposit_paid ? (Number(appt?.deposit_cents) || 0) : 0;
  return Math.max(0, price - depositPaid);
}

/**
 * Keep only the rows this request actually flipped to completed.
 *
 * complete-day computed this set and then ignored it for the visit-increment
 * loop, so every appointment the auto-complete cron had flipped in the seconds
 * between our read and our write got its visit counted twice and its lifetime
 * spend inflated by the price of the treatment.
 */
export function onlyFlipped(rows, flippedIds) {
  const ids = flippedIds instanceof Set ? flippedIds : new Set(flippedIds || []);
  return (rows || []).filter((r) => r && ids.has(r.id));
}

// ─────────────────────────────────────────────────────────────
// Refunds and disputes
// ─────────────────────────────────────────────────────────────

/**
 * A dispute and a refund can both hit the same PaymentIntent, and they are not
 * the same event. transactions has no column for a Stripe dispute id, so the
 * dispute id is tagged into `description` and these helpers read it back. Ugly,
 * but it means the guard needs no migration and works on the live table today.
 */
export function disputeTag(disputeId) {
  return `[dispute:${disputeId}]`;
}

export function disputeWonTag(disputeId) {
  return `[dispute:${disputeId}:won]`;
}

/** Has this exact dispute event already been written for this PaymentIntent? */
export function hasTag(rows, tag) {
  if (!tag) return false;
  return (rows || []).some((r) => String(r?.description || '').includes(tag));
}

/**
 * How much has already been recorded as refunded against this PaymentIntent,
 * in pence, as a positive number.
 *
 * Dispute rows are excluded: a chargeback is money removed by the bank, not a
 * refund Ellie granted, and counting it here would make a genuine later refund
 * look already recorded.
 */
export function recordedRefundCents(rows) {
  return (rows || []).reduce((sum, r) => {
    if (String(r?.description || '').includes('[dispute:')) return sum;
    const amount = Number(r?.amount_cents) || 0;
    return amount < 0 ? sum + Math.abs(amount) : sum;
  }, 0);
}

/**
 * How much of a refund still needs writing to the books.
 *
 * Stripe reports amount_refunded as a RUNNING TOTAL for the charge, and a
 * refund can reach us twice over: once from POST /api/stripe/refund when Ellie
 * taps refund, and again from the charge.refunded webhook. Recording the delta
 * rather than the total means the second arrival writes nothing, and a genuine
 * second partial refund still writes its own difference.
 */
export function refundDeltaCents(totalRefundedCents, priorRows) {
  const total = Math.max(0, Math.round(Number(totalRefundedCents) || 0));
  const already = recordedRefundCents(priorRows);
  return Math.max(0, total - already);
}

/**
 * The shape of a money-out row. Negative amount_cents, because that is how the
 * one existing refund insert wrote it and how the reconciliation reads it.
 *
 * type 'refund': the live CHECK constraint allows
 * payment / deposit / no_show_fee / refund / tip / full_payment / payment_link /
 * late_cancel_fee / product_sale. There is no 'dispute' or 'chargeback' member,
 * and inventing one is exactly what silently killed every product_sale row
 * before migration 076, so a dispute is recorded as a 'refund' and identified
 * by its description tag.
 *
 * payment_method 'card_online': plain 'card' is NOT in the CHECK constraint and
 * rejected every card row for weeks.
 */
export function buildRefundTransaction({
  beauticianId,
  appointmentId = null,
  clientId = null,
  amountCents,
  paymentIntentId = null,
  chargeId = null,
  description = null,
  taxYear = null,
}) {
  const magnitude = Math.abs(Math.round(Number(amountCents) || 0));
  return {
    beautician_id: beauticianId,
    appointment_id: appointmentId,
    client_id: clientId,
    amount_cents: -magnitude,
    type: 'refund',
    status: 'completed',
    stripe_payment_intent_id: paymentIntentId,
    stripe_charge_id: chargeId,
    payment_method: 'card_online',
    ...(taxYear ? { tax_year: taxYear } : {}),
    ...(description ? { description } : {}),
  };
}

/**
 * A dispute Ellie WON: the bank gives the money back, so the negative row
 * written when the dispute opened has to be undone or her books stay short for
 * ever. Positive amount, same 'refund' type, tagged so it is written once.
 */
export function buildDisputeReversalTransaction(args) {
  const row = buildRefundTransaction(args);
  return { ...row, amount_cents: Math.abs(row.amount_cents) };
}
