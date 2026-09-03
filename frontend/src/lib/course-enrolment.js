/**
 * What an enrolment row means. Mirrors backend/src/lib/course-enrolment.js,
 * and must keep agreeing with it: the backend decides whether a place is
 * held, this decides what the owner is shown about it.
 *
 * An `unpaid` row whose Stripe reference starts cs_ is a deposit checkout
 * that was opened and never finished. It holds no place and it is not a
 * student; it is shown so the owner understands why a name she recognises
 * is not in her count.
 */
export const CHECKOUT_PREFIX = 'cs_';

export function checkoutAbandoned(row) {
  if (!row) return false;
  const status = row.payment_status || 'unpaid';
  return status === 'unpaid' && String(row.stripe_payment_intent_id || '').startsWith(CHECKOUT_PREFIX);
}

export function holdsAPlace(row) {
  return !!row && !checkoutAbandoned(row);
}

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

export function balanceDue(course, row) {
  const price = Math.round(Number(course?.price || 0) * 100);
  if ((row?.payment_status || 'unpaid') === 'paid') return 0;
  return Math.max(0, price - Number(row?.amount_paid_cents || 0)) / 100;
}

/** Paid through Stripe, so removing the student may mean a refund. */
export function paidOnline(row) {
  return Number(row?.amount_paid_cents || 0) > 0 && String(row?.stripe_payment_intent_id || '').startsWith('pi_');
}

/**
 * Where a course sits in time, for a chip and for sorting.
 * @returns {'cancelled'|'closed'|'past'|'today'|'upcoming'|'tbc'}
 */
export function courseStage(course, today = new Date().toISOString().slice(0, 10)) {
  if (course?.status === 'cancelled') return 'cancelled';
  if (course?.status && course.status !== 'active') return 'closed';
  if (!course?.date) return 'tbc';
  const d = String(course.date).slice(0, 10);
  if (d < today) return 'past';
  if (d === today) return 'today';
  return 'upcoming';
}

const STAGE_ORDER = { today: 0, upcoming: 1, tbc: 2, closed: 3, past: 4, cancelled: 5 };

/** Today first, then what is coming, then what needs a date, then the rest. */
export function sortCourses(courses, today) {
  return [...(courses || [])].sort((a, b) => {
    const sa = STAGE_ORDER[courseStage(a, today)];
    const sb = STAGE_ORDER[courseStage(b, today)];
    if (sa !== sb) return sa - sb;
    const da = a.date ? String(a.date) : '';
    const db = b.date ? String(b.date) : '';
    if (da && db && da !== db) return sa === STAGE_ORDER.past ? db.localeCompare(da) : da.localeCompare(db);
    return String(b.created_at || '').localeCompare(String(a.created_at || ''));
  });
}
