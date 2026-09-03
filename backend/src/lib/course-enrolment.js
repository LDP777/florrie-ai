/**
 * What an enrolment row means, in one place.
 *
 * course_enrollments has three payment states (unpaid, deposit_paid, paid)
 * and one column for Stripe's reference. That was enough until somebody
 * started a deposit checkout and closed the tab: the row stayed `unpaid`,
 * looked exactly like a student who had agreed to pay Ellie by bank transfer,
 * and when the same person came back to try again the duplicate check told
 * her she was "already enrolled". She was not. Nobody was.
 *
 * The distinction is kept without a migration: when a checkout session is
 * opened, its id (cs_...) is written into stripe_payment_intent_id, and the
 * webhook overwrites it with the payment intent (pi_...) when the money lands.
 * So an `unpaid` row whose reference starts cs_ is a checkout that never
 * finished, and everything that reads enrolments goes through here so they
 * all agree on that.
 */

export const CHECKOUT_PREFIX = 'cs_';

/** A checkout was opened for this row and never completed. */
export function checkoutAbandoned(row) {
  if (!row) return false;
  const status = row.payment_status || 'unpaid';
  const ref = String(row.stripe_payment_intent_id || '');
  return status === 'unpaid' && ref.startsWith(CHECKOUT_PREFIX);
}

/**
 * Does this row hold a place on the course. Deposit paid, paid in full, or
 * unpaid because the trainer is collecting the money herself: yes. A
 * checkout that never finished: no, and that is why the enrol route only
 * counts the spot for the Stripe path when the webhook confirms it.
 */
export function holdsAPlace(row) {
  if (!row) return false;
  return !checkoutAbandoned(row);
}

/** The label the owner sees, and the tone it should carry. */
export function enrolmentLabel(row) {
  const status = row?.payment_status || 'unpaid';
  if (status === 'paid') return { text: 'Paid in full', tone: 'success' };
  if (status === 'deposit_paid') return { text: 'Deposit paid', tone: 'warning' };
  if (checkoutAbandoned(row)) return { text: 'Checkout not finished', tone: 'muted' };
  return { text: 'To pay', tone: 'muted' };
}

export function spotsLeft(course) {
  return Math.max(0, Number(course?.max_students || 0) - Number(course?.enrolled || 0));
}

/**
 * The pounds still owed on a place, from the course price and what has been
 * paid. Never negative: a manual "paid in full" with no recorded amount is
 * still paid in full.
 */
export function balanceDue(course, row) {
  const price = Math.round(Number(course?.price || 0) * 100);
  if ((row?.payment_status || 'unpaid') === 'paid') return 0;
  const paid = Number(row?.amount_paid_cents || 0);
  return Math.max(0, price - paid) / 100;
}
