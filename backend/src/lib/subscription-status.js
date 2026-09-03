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

/**
 * A subscription that exists only because somebody opened the card form.
 *
 * POST /api/billing/create-subscription-intent has to create the subscription
 * BEFORE the Payment Element can show a card form (that is how Stripe hands
 * back the SetupIntent). With trial days left the subscription is born
 * `trialing` with no payment method, and `trialing` maps to 'active' above.
 * So merely opening the Team checkout and closing the tab used to mark the
 * account an active Team subscriber: free team features, and every trial
 * warning silenced. Stripe cancels these drafts itself when the trial ends
 * (trial_settings.end_behavior.missing_payment_method = 'cancel'), so the
 * right thing for the books is to write nothing until a card is on file.
 *
 * Checkout Sessions with payment_method_collection 'always' attach the card
 * to the subscription, so a real trial-with-card is not a draft.
 *
 * @param {object} sub the Stripe subscription object off the event
 * @returns {boolean}
 */
export function isCardlessDraft(sub) {
  if (!sub || sub.status !== 'trialing') return false;
  const pm = sub.default_payment_method;
  if (pm) return false;
  return sub.trial_settings?.end_behavior?.missing_payment_method === 'cancel';
}
