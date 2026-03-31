/**
 * Subscription helpers — feature gating based on plan tier.
 *
 * Plans:
 *   free    — 5 clients, basic calendar, manual bookings
 *   starter — 50 clients, SMS, receipt scanning, reports           (£39/mo or £390/yr)
 *   pro     — Unlimited, AI Front Desk, WhatsApp, Smart Schedule   (£59/mo or £590/yr)
 *   team    — Everything + multi-location, staff rota, team KPIs   (£89/mo or £890/yr)
 *
 * Annual billing = 2 months free (~17% discount).
 */

const PLAN_HIERARCHY = { free: 0, starter: 1, pro: 2, team: 3 };

const FEATURE_GATES = {
  // Feature → minimum plan required
  'ai_front_desk':      'pro',
  'whatsapp':           'pro',
  'smart_schedule':     'pro',
  'content_autopilot':  'pro',
  'campaigns':          'pro',
  'ai_insights':        'pro',
  'churn_prevention':   'pro',
  'demand_forecast':    'pro',
  'client_segments':    'pro',
  'sms':                'starter',
  'reports':            'starter',
  'receipt_scanning':   'starter',
  'loyalty':            'starter',
  'aftercare':          'starter',
  'multi_location':     'team',
  'staff_rota':         'team',
  'staff_performance':  'team',
  'team_management':    'team',
};

const CLIENT_LIMITS = {
  free: 5,
  starter: 50,
  pro: Infinity,
  team: Infinity,
};

const TEAM_LIMITS = {
  free: 1,
  starter: 1,
  pro: 2,
  team: 10,
};

/**
 * Check if the current plan has access to a feature.
 * @param {string} currentPlan - 'free' | 'starter' | 'pro' | 'team'
 * @param {string} feature - feature key from FEATURE_GATES
 * @returns {boolean}
 */
export function hasFeature(currentPlan, feature) {
  const requiredPlan = FEATURE_GATES[feature];
  if (!requiredPlan) return true; // No gate → available on all plans
  return (PLAN_HIERARCHY[currentPlan] || 0) >= (PLAN_HIERARCHY[requiredPlan] || 0);
}

/**
 * Get client limit for the plan.
 */
export function getClientLimit(plan) {
  return CLIENT_LIMITS[plan] || 5;
}

/**
 * Get team member limit for the plan.
 */
export function getTeamLimit(plan) {
  return TEAM_LIMITS[plan] || 1;
}

/**
 * Check if the trial has expired.
 */
export function isTrialExpired(beautician) {
  if (!beautician) return false;
  if (beautician.subscription_status === 'active') return false;
  if (beautician.subscription_plan !== 'free' && beautician.subscription_plan !== 'trial') return false;
  if (!beautician.trial_ends_at) return false;
  return new Date(beautician.trial_ends_at) < new Date();
}

/**
 * Get the minimum plan required for a feature (for upgrade prompts).
 */
export function getRequiredPlan(feature) {
  return FEATURE_GATES[feature] || 'free';
}

export const PLANS = [
  {
    id: 'free', name: 'Free', price: 0, priceLabel: 'Free',
    annualPrice: 0, annualPriceLabel: 'Free',
    features: ['5 clients', 'Basic calendar', 'Manual bookings', 'Public booking page'],
  },
  {
    id: 'starter', name: 'Starter', price: 3900, priceLabel: '£39/mo',
    annualPrice: 39000, annualPriceLabel: '£390/yr',
    annualSaving: '2 months free',
    features: ['50 clients', 'Online booking', 'SMS reminders (30/wk included)', 'Receipt scanning', 'Basic reports'],
  },
  {
    id: 'pro', name: 'Pro', price: 5900, priceLabel: '£59/mo',
    annualPrice: 59000, annualPriceLabel: '£590/yr',
    annualSaving: '2 months free',
    popular: true,
    features: ['Unlimited clients', 'AI Front Desk', 'WhatsApp automation', 'Smart Schedule', 'Content Autopilot', 'Full analytics'],
  },
  {
    id: 'team', name: 'Team', price: 8900, priceLabel: '£89/mo',
    annualPrice: 89000, annualPriceLabel: '£890/yr',
    annualSaving: '2 months free',
    features: ['Everything in Pro', 'Multi-location', 'Staff rota & KPIs', 'Up to 10 team members', 'Priority support'],
  },
];
