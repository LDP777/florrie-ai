/** Training payment state. Confirmed students and temporary checkout holds are
 * separate; both consume capacity, but only confirmed students count as enrolled.
 * The cs_ fallback keeps older cached records readable during release.
 */
export const CHECKOUT_PREFIX = 'cs_';

/** A checkout was opened for this row and never completed. */
export function checkoutAbandoned(row) {
  if (!row) return false;
  if (row.reservation_status) return row.reservation_status === 'released';
  const status = row.payment_status || 'unpaid';
  const ref = String(row.stripe_payment_intent_id || '');
  return status === 'unpaid' && ref.startsWith(CHECKOUT_PREFIX);
}

/** Is this a confirmed student (including a trainer-collected payment)? */
export function holdsAPlace(row) {
  if (!row) return false;
  return row.reservation_status ? row.reservation_status === 'confirmed' : !checkoutAbandoned(row);
}

/** The label the owner sees, and the tone it should carry. */
export function enrolmentLabel(row) {
  if (row?.reservation_status === 'held') return { text: 'Place held · payment in progress', tone: 'warning' };
  if (row?.reservation_status === 'released') return { text: 'Checkout expired', tone: 'muted' };
  const status = row?.payment_status || 'unpaid';
  if (status === 'paid') return { text: 'Paid in full', tone: 'success' };
  if (status === 'deposit_paid') return { text: 'Deposit paid', tone: 'warning' };
  if (checkoutAbandoned(row)) return { text: 'Checkout not finished', tone: 'muted' };
  return { text: 'To pay', tone: 'muted' };
}

export function spotsLeft(course) {
  return Math.max(0, Number(course?.max_students || 0) - Number(course?.enrolled || 0) - Number(course?.reserved_places || 0));
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
