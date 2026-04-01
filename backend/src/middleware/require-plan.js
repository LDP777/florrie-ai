/**
 * require-plan middleware — blocks API access for features above the user's plan.
 *
 * Usage:
 *   router.get('/insights', requireAuth, requirePlan('pro'), async (req, res) => { ... });
 *
 * Plan hierarchy: free < starter < pro < team
 */

const PLAN_HIERARCHY = { free: 0, starter: 1, pro: 2, team: 3 };

/**
 * Returns Express middleware that checks if req.beautician.subscription_plan
 * meets the minimum required plan.
 *
 * @param {string} minimumPlan - 'starter' | 'pro' | 'team'
 */
export function requirePlan(minimumPlan) {
  return (req, res, next) => {
    const currentPlan = req.beautician?.subscription_plan || 'free';
    const currentLevel = PLAN_HIERARCHY[currentPlan] ?? 0;
    const requiredLevel = PLAN_HIERARCHY[minimumPlan] ?? 0;

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
 * Client limit check — for routes that create clients.
 * Free: 5, Starter: 50, Pro/Team: unlimited
 */
const CLIENT_LIMITS = { free: 5, starter: 50, pro: Infinity, team: Infinity };

export function checkClientLimit(supabase) {
  return async (req, res, next) => {
    const plan = req.beautician?.subscription_plan || 'free';
    const limit = CLIENT_LIMITS[plan] ?? 5;

    if (limit === Infinity) return next();

    const { count, error } = await supabase
      .from('clients')
      .select('id', { count: 'exact', head: true })
      .eq('beautician_id', req.beautician.id);

    if (error) return next(); // Don't block on count errors

    if ((count || 0) >= limit) {
      return res.status(403).json({
        error: `Client limit reached (${limit} on ${plan} plan). Upgrade to add more.`,
        required_plan: plan === 'free' ? 'starter' : 'pro',
        current_plan: plan,
      });
    }

    next();
  };
}
