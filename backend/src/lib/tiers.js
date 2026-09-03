/**
 * Tier configuration — single source of truth for server-side enforcement.
 *
 * Commercial model (Apr 2026):
 *   Trial       — 14 days, full access to everything, no card required
 *   Florrie     — £29/mo (annual: £290/yr, saves £58). Solo beauticians. Everything included.
 *   Florrie Team — £29/mo + £15/seat. Multi-location, staff rota, up to 10 team members.
 *
 * Messaging: 120 messages/month included (SMS + WhatsApp combined).
 *   Overages: 7p per message over the limit (flat rate, any channel).
 *
 * AI: Unlimited. Haiku for routine tasks, Sonnet for content generation.
 *   Cost to serve: ~£0.23/user/month. Not metered, not limited.
 *
 * Gross margin: ~87% at £29/mo.
 */

export const TIER_HIERARCHY = { trial: 0, florrie: 1, florrie_team: 2 };

export const TIERS = {
  trial: {
    id: 'trial',
    name: '14-day free trial',
    price_monthly_pence: 0,
    price_annual_pence: 0,
    trial_days: 14,
    max_clients: null, // unlimited during trial
    max_team_members: 1,
    messages_per_month: 120,
    ai_chats_per_month: null, // unlimited
    includes_sms: true,
    includes_whatsapp: true,
    includes_ai_front_desk: true,
    includes_content_autopilot: true,
    includes_tax_dashboard: true,
    features: [
      'Everything in the Florrie plan for 14 days',
      'Unlimited clients',
      'AI receptionist',
      'WhatsApp & SMS',
      'Tax dashboard',
      'Smart scheduling',
      'Content autopilot',
      'Compliance tracking',
      '120 messages/month',
    ],
  },
  florrie: {
    id: 'florrie',
    name: 'Florrie',
    price_monthly_pence: 2900,
    price_annual_pence: 29000, // £290/yr (save £58)
    trial_days: 0,
    max_clients: null, // unlimited
    max_team_members: 1,
    messages_per_month: 120,
    ai_chats_per_month: null, // unlimited
    includes_sms: true,
    includes_whatsapp: true,
    includes_ai_front_desk: true,
    includes_content_autopilot: true,
    includes_tax_dashboard: true,
    features: [
      'Unlimited clients',
      'AI receptionist',
      'WhatsApp & SMS automation',
      'Smart scheduling',
      'Tax dashboard & HMRC tracking',
      'Content autopilot',
      'Compliance & patch test tracking',
      'Analytics & reports',
      'Receipt scanning',
      '120 messages/month included',
    ],
  },
  florrie_team: {
    id: 'florrie_team',
    name: 'Florrie for Teams',
    price_monthly_pence: 2900, // base price same, +1500 per extra seat
    price_annual_pence: 29000,
    extra_seat_monthly_pence: 1500,
    extra_seat_annual_pence: 15000,
    trial_days: 0,
    max_clients: null, // unlimited
    max_team_members: 10,
    messages_per_month: 120, // per seat
    ai_chats_per_month: null,
    includes_sms: true,
    includes_whatsapp: true,
    includes_ai_front_desk: true,
    includes_content_autopilot: true,
    includes_tax_dashboard: true,
    features: [
      'Everything in Florrie',
      'Multi-location support',
      'Staff rota & scheduling',
      'Team performance tracking',
      'Up to 10 team members',
      '+£15/month per extra seat',
      '120 messages/month per seat',
      'Priority support',
    ],
  },
};

/**
 * Feature gates.
 *
 * With the new model, almost everything is available on all paid tiers.
 * Only multi-location and staff management features are team-gated.
 * Trial gets full access (same as florrie) for 14 days.
 */
export const FEATURE_GATES = {
  // Available to all (trial + florrie + team)
  ai_front_desk: 'trial',
  whatsapp: 'trial',
  smart_schedule: 'trial',
  content_autopilot: 'trial',
  campaigns: 'trial',
  ai_insights: 'trial',
  churn_prevention: 'trial',
  demand_forecast: 'trial',
  client_segments: 'trial',
  tax_dashboard: 'trial',
  sms: 'trial',
  reports: 'trial',
  receipt_scanning: 'trial',
  loyalty: 'trial',
  aftercare: 'trial',

  // Team only
  multi_location: 'florrie_team',
  staff_rota: 'florrie_team',
  staff_performance: 'florrie_team',
  team_management: 'florrie_team',
};

/**
 * Check if a plan has access to a feature.
 */
export function hasFeature(plan, feature) {
  const required = FEATURE_GATES[feature];
  if (!required) return true; // no gate = available to all
  return (TIER_HIERARCHY[plan] || 0) >= (TIER_HIERARCHY[required] || 0);
}

/**
 * Get the tier config for a plan.
 */
export function getTier(plan) {
  return TIERS[plan] || TIERS.trial;
}

/**
 * Check if a beautician has exceeded their monthly message limit.
 * Returns { allowed, used, limit, remaining, overage rates }
 */
export function checkMessageLimit(plan, usedThisMonth, teamMembers = 1) {
  const tier = getTier(plan);
  const limit = (tier.messages_per_month || 120) * teamMembers;
  return {
    allowed: usedThisMonth < limit,
    used: usedThisMonth,
    limit,
    remaining: Math.max(0, limit - usedThisMonth),
    overage_rate_pence: 7, // flat rate, any channel
  };
}

/**
 * Check if a trial has expired.
 */
export function isTrialExpired(plan, trialEndsAt) {
  if (plan !== 'trial') return false;
  if (!trialEndsAt) return true;
  return new Date() > new Date(trialEndsAt);
}

/**
 * Calculate total monthly cost for a team plan.
 */
export function calculateTeamCost(extraSeats, isAnnual = false) {
  const tier = TIERS.florrie_team;
  if (isAnnual) {
    return tier.price_annual_pence + (extraSeats * tier.extra_seat_annual_pence);
  }
  return tier.price_monthly_pence + (extraSeats * tier.extra_seat_monthly_pence);
}
