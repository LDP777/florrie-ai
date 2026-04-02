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
 * AI chat limit check — for routes that trigger AI chat/actions.
 * Free: 5/mo, Starter: 50/mo, Pro/Team: unlimited
 */
const AI_CHAT_LIMITS = { free: 5, starter: 50, pro: Infinity, team: Infinity };

export function checkAiChatLimit(supabase) {
  return async (req, res, next) => {
    const plan = req.beautician?.subscription_plan || 'free';
    const limit = AI_CHAT_LIMITS[plan] ?? 5;

    if (limit === Infinity) return next();

    const bid = req.beautician.id;

    // Check if we need to reset the counter (new month)
    const resetAt = req.beautician.ai_chats_reset_at ? new Date(req.beautician.ai_chats_reset_at) : new Date(0);
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    let used = req.beautician.ai_chats_this_month || 0;

    if (resetAt < monthStart) {
      // Reset counter for new month
      await supabase
        .from('beauticians')
        .update({ ai_chats_this_month: 0, ai_chats_reset_at: now.toISOString() })
        .eq('id', bid);
      used = 0;
    }

    if (used >= limit) {
      return res.status(403).json({
        error: `AI chat limit reached (${limit}/month on ${plan} plan). Upgrade for more.`,
        required_plan: plan === 'free' ? 'starter' : 'pro',
        current_plan: plan,
        used,
        limit,
      });
    }

    // Increment counter
    await supabase
      .from('beauticians')
      .update({ ai_chats_this_month: used + 1 })
      .eq('id', bid);

    next();
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
