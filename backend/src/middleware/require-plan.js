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
