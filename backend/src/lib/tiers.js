/**
 * Tier configuration — single source of truth for server-side enforcement.
 *
 * Prices (master plan revision, Apr 2026):
 *   Free    — £0     5 clients, 5 AI chats/mo, no WhatsApp, no content autopilot
 *   Starter — £19/mo 50 clients, basic AI (50 chats/mo), SMS, reports
 *   Pro     — £39/mo Unlimited clients + AI, WhatsApp, Content Autopilot, tax dashboard
 *   Team    — £69/mo Everything + multi-location, staff rota, performance, up to 10 seats
 *
 * Annual = 10 months (2 months free, ~17% discount).
 */

export const TIER_HIERARCHY = { free: 0, starter: 1, pro: 2, team: 3 };

export const TIERS = {
  free: {
    id: 'free',
    name: 'Free',
    price_monthly_pence: 0,
    price_annual_pence: 0,
    max_clients: 5,
    max_team_members: 1,
    ai_chats_per_month: 5,
    includes_sms: false,
    includes_whatsapp: false,
    includes_ai_front_desk: false,
    includes_content_autopilot: false,
    includes_tax_dashboard: false,
    features: ['5 clients', 'Basic calendar', 'Manual bookings', 'Public booking page', '5 AI chats/month'],
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    price_monthly_pence: 1900,
    price_annual_pence: 19000,
    max_clients: 50,
    max_team_members: 1,
    ai_chats_per_month: 50,
    includes_sms: true,
    includes_whatsapp: false,
    includes_ai_front_desk: false,
    includes_content_autopilot: false,
    includes_tax_dashboard: false,
    features: ['50 clients', 'Online booking', 'SMS reminders', 'Receipt scanning', 'Basic reports', '50 AI chats/month'],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    price_monthly_pence: 3900,
    price_annual_pence: 39000,
    max_clients: null, // unlimited
    max_team_members: 2,
    ai_chats_per_month: null, // unlimited
    includes_sms: true,
    includes_whatsapp: true,
    includes_ai_front_desk: true,
    includes_content_autopilot: true,
    includes_tax_dashboard: true,
    features: ['Unlimited clients', 'AI Front Desk', 'WhatsApp automation', 'Smart Schedule', 'Content Autopilot', 'Tax dashboard', 'Full analytics'],
  },
  team: {
    id: 'team',
    name: 'Team',
    price_monthly_pence: 6900,
    price_annual_pence: 69000,
    max_clients: null,
    max_team_members: 10,
    ai_chats_per_month: null,
    includes_sms: true,
    includes_whatsapp: true,
    includes_ai_front_desk: true,
    includes_content_autopilot: true,
    includes_tax_dashboard: true,
    features: ['Everything in Pro', 'Multi-location', 'Staff rota & KPIs', 'Up to 10 team members', 'Priority support'],
  },
};

/**
 * Feature → minimum tier required.
 * Backend mirror of frontend FEATURE_GATES for server-side enforcement.
 */
export const FEATURE_GATES = {
  ai_front_desk: 'pro',
  whatsapp: 'pro',
  smart_schedule: 'pro',
  content_autopilot: 'pro',
  campaigns: 'pro',
  ai_insights: 'pro',
  churn_prevention: 'pro',
  demand_forecast: 'pro',
  client_segments: 'pro',
  tax_dashboard: 'pro',
  sms: 'starter',
  reports: 'starter',
  receipt_scanning: 'starter',
  loyalty: 'starter',
  aftercare: 'starter',
  multi_location: 'team',
  staff_rota: 'team',
  staff_performance: 'team',
  team_management: 'team',
};

/**
 * Check if a plan has access to a feature.
 */
export function hasFeature(plan, feature) {
  const required = FEATURE_GATES[feature];
  if (!required) return true;
  return (TIER_HIERARCHY[plan] || 0) >= (TIER_HIERARCHY[required] || 0);
}

/**
 * Get the tier config for a plan.
 */
export function getTier(plan) {
  return TIERS[plan] || TIERS.free;
}

/**
 * Check if a beautician has exceeded their AI chat limit for the current month.
 * Returns { allowed: boolean, used: number, limit: number|null }
 */
export function checkAiChatLimit(plan, usedThisMonth) {
  const tier = getTier(plan);
  if (tier.ai_chats_per_month === null) return { allowed: true, used: usedThisMonth, limit: null };
  return {
    allowed: usedThisMonth < tier.ai_chats_per_month,
    used: usedThisMonth,
    limit: tier.ai_chats_per_month,
  };
}
