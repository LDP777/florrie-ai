/**
 * How many seats a team checkout should ask Stripe for.
 *
 * Both subscription checkouts (routes/billing.js create-checkout and
 * routes/stripe.js subscribe) hardcoded quantity: 1, and lib/tiers.js has a
 * calculateTeamCost nobody calls. So a salon with four staff on Florrie Team
 * paid the same £44 as a salon with one.
 *
 * WHY THIS IS BEHIND A FLAG. In Stripe, quantity multiplies unit_amount on
 * any ordinary price. The 'Florrie Team' price that backend/scripts/
 * stripe-setup.js creates (around line 36) is a flat £44 a month, so sending
 * quantity 4 against it would charge £176, not £29 + 3 x £15. Passing the
 * real staff count therefore has to wait for the founder to create a
 * per-seat price in Stripe (a separate product, or a graduated tier where
 * the first unit is £29 and each further unit £15) and point
 * STRIPE_PRICE_FLORRIE_TEAM at it. Until then STRIPE_TEAM_PRICE_PER_SEAT is
 * unset, and this function answers 1 every time, which is what production
 * does today. Flip the flag and the staff count goes through unchanged.
 */
import logger from './logger.js';

export const TEAM_PLAN = 'florrie_team';
export const PER_SEAT_FLAG = 'STRIPE_TEAM_PRICE_PER_SEAT';

export function perSeatPriceConfigured(env = process.env) {
  const v = String(env[PER_SEAT_FLAG] || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Active staff on this account, from team_members (migration 002). A read
 * failure logs and answers 0, so a checkout is never blocked by a seat count.
 */
export async function countActiveStaff(supabase, beauticianId) {
  const { count, error } = await supabase
    .from('team_members')
    .select('id', { count: 'exact', head: true })
    .eq('beautician_id', beauticianId)
    .eq('is_active', true);
  if (error) {
    logger.error({ err: error, beauticianId }, 'team-seats: could not count team_members, checkout will use one seat');
    return 0;
  }
  return count || 0;
}

/**
 * @param {object} supabase
 * @param {string} beauticianId
 * @param {string} plan 'florrie' | 'florrie_team' (or a plans.id that starts with it)
 * @param {object} [opts]
 * @param {object} [opts.env] for tests
 * @returns {Promise<number>} the quantity to put on the checkout line item, never below 1
 */
export async function teamSeatQuantity(supabase, beauticianId, plan, { env = process.env } = {}) {
  const isTeam = typeof plan === 'string' && plan.startsWith(TEAM_PLAN);
  if (!isTeam) return 1;
  const staff = await countActiveStaff(supabase, beauticianId);
  const wanted = Math.max(1, staff);
  if (!perSeatPriceConfigured(env)) {
    if (wanted > 1) {
      logger.info({ beauticianId, staff }, `team-seats: ${staff} active staff but ${PER_SEAT_FLAG} is unset, charging one flat seat`);
    }
    return 1;
  }
  return wanted;
}
