/**
 * require-plan middleware — blocks API access for features above the user's plan.
 *
 * Usage:
 *   router.get('/team-stats', requireAuth, requirePlan('florrie_team'), async (req, res) => { ... });
 *
 * Plan hierarchy: trial < florrie < florrie_team
 *
 * New model (Apr 2026): almost everything is available to all tiers.
 * Only multi-location and staff management features are team-gated.
 * AI and clients are unlimited on all paid tiers.
 */
import { TIER_HIERARCHY, hasFeature, getTier, checkMessageLimit, isTrialExpired } from '../lib/tiers.js';
import { resolveBeautician } from './auth.js';
import logger from '../lib/logger.js';

/** Days a past_due salon keeps working while Stripe retries the card. */
export const PAST_DUE_GRACE_DAYS = 7;
export const BILLING_HEADER = 'X-Florrie-Billing';
export const BILLING_PAGE_PATH = '/pricing';

/**
 * Decide what to do with a salon whose subscription is past_due.
 *
 * Stripe marks a subscription past_due the moment its FIRST retry fails,
 * which for an expired card is the first morning of the new month. This
 * middleware used to block every non-'active' paid status, so that first
 * failed attempt locked the diary mid-day, before the owner had been told
 * anything. She now gets PAST_DUE_GRACE_DAYS measured from
 * beauticians.payment_failed_at, the marker services/dunning.js stamps on
 * invoice.payment_failed.
 *
 * The marker column is added by migration 20260902_backend027 and the
 * migrations are applied by hand, so it may not exist yet. req.beautician is
 * the whole row (select '*' in middleware/auth.js), which means "the column
 * is readable" is exactly "the key is present on the object". When it is not
 * present, past_due is allowed through unconditionally with a warning: a
 * paying customer is never locked out because the schema is behind the code.
 *
 * @returns {{ allow: boolean, reason: string, daysLeft?: number }}
 */
export function pastDueDecision(beautician, now = new Date()) {
  if (!beautician || !Object.prototype.hasOwnProperty.call(beautician, 'payment_failed_at')) {
    return { allow: true, reason: 'payment_failed_at_unreadable' };
  }
  const failedAt = beautician.payment_failed_at ? new Date(beautician.payment_failed_at) : null;
  if (!failedAt || Number.isNaN(failedAt.getTime())) {
    // past_due with no recorded failure: the status came from a
    // customer.subscription.updated without an invoice.payment_failed we saw
    // (or the marker write failed). No clock has started, so the grace
    // period cannot have run out.
    return { allow: true, reason: 'no_failure_recorded' };
  }
  const graceEnd = failedAt.getTime() + PAST_DUE_GRACE_DAYS * 86400000;
  const msLeft = graceEnd - now.getTime();
  if (msLeft > 0) {
    return { allow: true, reason: 'within_grace', daysLeft: Math.ceil(msLeft / 86400000) };
  }
  return { allow: false, reason: 'grace_expired', daysLeft: 0 };
}

/**
 * Returns Express middleware that checks if req.beautician.subscription_plan
 * meets the minimum required plan.
 *
 * @param {string} minimumPlan - 'florrie' | 'florrie_team'
 */
export function requirePlan(minimumPlan) {
  return (req, res, next) => {
    const currentPlan = req.beautician?.subscription_plan || 'trial';
    const currentLevel = TIER_HIERARCHY[currentPlan] ?? 0;
    const requiredLevel = TIER_HIERARCHY[minimumPlan] ?? 0;

    // Trial users get full access (same as florrie) for 14 days
    if (currentPlan === 'trial') {
      const expired = isTrialExpired('trial', req.beautician?.trial_ends_at);
      if (expired) {
        return res.status(403).json({
          error: 'Trial expired',
          required_plan: 'florrie',
          current_plan: 'trial',
        });
      }
      // Trial not expired — allow access to florrie-level features
      if (requiredLevel <= (TIER_HIERARCHY.florrie ?? 1)) {
        return next();
      }
    }

    if (currentLevel >= requiredLevel) {
      return next();
    }

    return res.status(403).json({
      error: 'Upgrade required',
      required_plan: minimumPlan,
      current_plan: currentPlan,
    });
  };
}

/**
 * Message limit check — for routes that send SMS/WhatsApp.
 * 120 messages/month included on all plans. Overages allowed but tracked.
 */
export function checkMessageLimitMiddleware(supabase) {
  return async (req, res, next) => {
    const plan = req.beautician?.subscription_plan || 'trial';
    const bid = req.beautician.id;

    // Get current month's usage
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const { count } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('beautician_id', bid)
      .gte('created_at', monthStart);

    const used = count || 0;
    const teamMembers = req.beautician.team_member_count || 1;
    const { allowed, limit, remaining } = checkMessageLimit(plan, used, teamMembers);

    // Attach usage info to request for downstream use
    req.messageUsage = { used, limit, remaining, overLimit: !allowed };

    // We don't block — overages are billed. Just attach the info.
    next();
  };
}

/**
 * Trial expiry check — blocks access if trial has expired.
 * Used on routes where we want to enforce the paywall.
 */
export function requireActiveSubscription() {
  return (req, res, next) => {
    const plan = req.beautician?.subscription_plan || 'trial';
    const status = req.beautician?.subscription_status;

    // Active paid subscription — always pass
    if (status === 'active' && (plan === 'florrie' || plan === 'florrie_team')) {
      return next();
    }

    // Past due on a paid plan: the card is being retried. Grace period, with
    // a header so the frontend can show a banner rather than a locked door.
    if (status === 'past_due' && (plan === 'florrie' || plan === 'florrie_team')) {
      const decision = pastDueDecision(req.beautician);
      if (decision.allow) {
        if (decision.reason === 'payment_failed_at_unreadable') {
          logger.warn({ beauticianId: req.beautician?.id, path: req.originalUrl }, 'paywall: past_due but payment_failed_at is not readable, allowing through (apply migration 20260902_backend027)');
        }
        res.set(BILLING_HEADER, 'past_due');
        return next();
      }
      return res.status(403).json({
        error: `Your Florrie payment has not gone through for ${PAST_DUE_GRACE_DAYS} days. Update your card on the billing page (${BILLING_PAGE_PATH}) to carry on.`,
        code: 'payment_past_due',
        billing_page: BILLING_PAGE_PATH,
        required_plan: plan,
        current_plan: plan,
      });
    }

    // Trial — check expiry
    if (plan === 'trial') {
      const expired = isTrialExpired('trial', req.beautician?.trial_ends_at);
      if (!expired) return next();

      return res.status(403).json({
        error: 'Trial expired',
        required_plan: 'florrie',
        current_plan: 'trial',
      });
    }

    // Cancelled or unknown — block
    return res.status(403).json({
      error: 'Subscription required',
      required_plan: 'florrie',
      current_plan: plan,
    });
  };
}

/**
 * Router-level paywall. Mount in index.js in front of a router:
 *
 *   app.use('/api/clients', apiLimiter, paywall, clientRoutes);
 *
 * requireActiveSubscription() above needs req.beautician, which normally only
 * exists after a route's own requireAuth has run. This wrapper resolves the
 * session first so the check can sit at the mount point, where it is visible
 * next to every other router and cannot be forgotten on a newly added route.
 *
 * If there is no usable session it calls next() instead of rejecting. That is
 * deliberate, not a hole: a request with no valid token cannot reach anything
 * private, because the router's own requireAuth still rejects it. Rejecting
 * here would instead break the handful of genuinely public endpoints that live
 * inside otherwise-private routers, such as the booking page's free-slots
 * lookup. A client trying to book is not the subscriber and must never be told
 * the salon has not paid.
 */
export async function paywall(req, res, next) {
  try {
    const result = await resolveBeautician(req);
    if (!result.ok) return next();
    return requireActiveSubscription()(req, res, next);
  } catch (err) {
    // Fail OPEN. A Supabase blip must not take a paying salon's diary offline
    // mid-appointment; the worst case is one request served past expiry.
    logger.error({ err, path: req.originalUrl }, 'paywall: subscription check failed, allowing request through');
    return next();
  }
}
