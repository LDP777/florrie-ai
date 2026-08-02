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
