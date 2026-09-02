/**
 * Stripe subscription status -> beauticians.subscription_status.
 *
 * beauticians.subscription_status carries a CHECK constraint (migration 001)
 * that allows exactly four words: 'trial', 'active', 'past_due', 'cancelled'.
 * Stripe speaks a different language: 'canceled' with one L, 'unpaid',
 * 'incomplete', 'incomplete_expired', 'paused', 'trialing'.
 *
 * The webhooks used to write Stripe's word straight into the column. So when
 * a salon's card died and Stripe finished dunning, moving the subscription to
 * 'unpaid' or 'canceled', the UPDATE violated the CHECK, PostgREST resolved
 * with { error } rather than throwing, nobody read the error, and the row
 * stayed 'active' forever. A salon whose card had been declined for months
 * kept the whole product for free, and nothing anywhere said so.
 *
 * This is the one translation table. Every write of subscription_status that
 * starts from a Stripe status goes through it. The rule for anything not on
 * the list is to fail towards "you owe us", never towards free access.
 */
import logger from './logger.js';

export const INTERNAL_STATUSES = ['trial', 'active', 'past_due', 'cancelled'];

const MAP = {
  active: 'active',
  trialing: 'active',
  past_due: 'past_due',
  // Started checkout, never finished paying. Not a trial: a trial is something
  // we granted, this is a card that has not gone through yet.
  incomplete: 'past_due',
  // Paused by the owner or by a trial ending with no card on file. Still not
  // paying, and the diary should say so rather than staying open for free.
  paused: 'past_due',
  canceled: 'cancelled',
  cancelled: 'cancelled',
  unpaid: 'cancelled',
  incomplete_expired: 'cancelled',
};

/**
 * @param {string} stripeStatus subscription.status straight off the Stripe object
 * @returns {'active'|'past_due'|'cancelled'} always a word the CHECK accepts
 */
export function internalStatusFor(stripeStatus) {
  const key = typeof stripeStatus === 'string' ? stripeStatus.trim().toLowerCase() : '';
  const mapped = MAP[key];
  if (mapped) return mapped;
  // A status Stripe added after this table was written. 'past_due' keeps the
  // salon in the grace period (a banner, not a lock-out) while a human looks,
  // and it never resolves to 'active', which is the one answer that would
  // repeat the original bug.
  logger.warn({ stripeStatus }, 'Unknown Stripe subscription status, treating as past_due');
  return 'past_due';
}
