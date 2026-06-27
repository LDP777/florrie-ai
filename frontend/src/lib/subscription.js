/**
 * Subscription helpers — feature gating based on plan tier.
 *
 * Plans (Apr 2026 pricing):
 *   trial        — 14 days, full access, card required up front, billed after day 14
 *   florrie      — £29/mo (annual: £290/yr, saves £58). Solo beauticians.
 *   florrie_team — £29/mo base + £15/seat. Multi-location, staff rota, up to 10 team.
 *
 * Messaging: 120 messages/month included (SMS + WhatsApp combined).
 *   Overages: 6p/SMS, 5p/WhatsApp over the limit.
 *
 * AI: Unlimited. Not metered, not limited.
 */

const PLAN_HIERARCHY = { trial: 0, florrie: 1, florrie_team: 2 };

const FEATURE_GATES = {
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
 * Check if the current plan has access to a feature.
 * @param {string} currentPlan - 'trial' | 'florrie' | 'florrie_team'
 * @param {string} feature - feature key from FEATURE_GATES
 * @returns {boolean}
 */
export function hasFeature(currentPlan, feature) {
  const requiredPlan = FEATURE_GATES[feature];
  if (!requiredPlan) return true; // No gate = available to all
  return (PLAN_HIERARCHY[currentPlan] || 0) >= (PLAN_HIERARCHY[requiredPlan] || 0);
}

/**
 * Get team member limit for the plan.
 */
export function getTeamLimit(plan) {
  if (plan === 'florrie_team') return 10;
  return 1;
}

/**
 * Check if the trial has expired.
 */
export function isTrialExpired(beautician) {
  if (!beautician) return false;
  if (beautician.subscription_status === 'active') return false;
  if (beautician.subscription_plan !== 'trial') return false;
  if (!beautician.trial_ends_at) return true;
  return new Date(beautician.trial_ends_at) < new Date();
}

/**
 * Get the minimum plan required for a feature (for upgrade prompts).
 */
export function getRequiredPlan(feature) {
  return FEATURE_GATES[feature] || 'trial';
}

/**
 * Check if a plan is a paid plan (not trial).
 */
export function isPaidPlan(plan) {
  return plan === 'florrie' || plan === 'florrie_team';
}

/**
 * Get plan display name.
 */
export function getPlanName(plan) {
  const names = { trial: 'Free Trial', florrie: 'Florrie', florrie_team: 'Florrie for Teams' };
  return names[plan] || 'Free Trial';
}

/**
 * Plan config for the pricing page.
 */
export const PLAN = {
  id: 'florrie',
  name: 'Florrie',
  monthlyPence: 2900,
  annualPence: 29000,
  monthlyLabel: '£29/mo',
  annualLabel: '£290/yr',
  annualSaving: '2 months free',
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
};

export const TEAM_ADDON = {
  id: 'florrie_team',
  name: 'Florrie for Teams',
  seatMonthlyPence: 1500,
  seatAnnualPence: 15000,
  seatMonthlyLabel: '+£15/mo per seat',
  seatAnnualLabel: '+£150/yr per seat',
  maxSeats: 10,
  extras: [
    'Multi-location support',
    'Staff rota & scheduling',
    'Team performance tracking',
    'Up to 10 team members',
    'Priority support',
  ],
};
