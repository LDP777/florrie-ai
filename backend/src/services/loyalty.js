import { supabase } from '../config.js';
import logger from '../lib/logger.js';

/**
 * Loyalty Service: awards points automatically when an appointment completes.
 *
 * Earn rule: loyalty_config.points_per_pound per £1 of the appointment price.
 * Only runs when the beautician has a loyalty_config row with is_active = true.
 *
 * Idempotent: at most one 'appointment' award per appointment, enforced both
 * by a pre-check and by the partial unique index in migration 057
 * (idx_loyalty_points_appointment_award). Never throws; callers fire and forget.
 */
export async function awardLoyaltyPoints(beauticianId, appointment) {
  try {
    if (!appointment?.id || !appointment.client_id) return;

    const { data: config } = await supabase
      .from('loyalty_config')
      .select('is_active, points_per_pound')
      .eq('beautician_id', beauticianId)
      .maybeSingle();

    if (!config?.is_active) return;

    // Already awarded for this appointment?
    const { data: existing } = await supabase
      .from('loyalty_points')
      .select('id')
      .eq('appointment_id', appointment.id)
      .eq('reason', 'appointment')
      .maybeSingle();

    if (existing) return;

    const pounds = Math.round((appointment.price_cents || 0) / 100);
    const points = pounds * (config.points_per_pound || 1);
    if (points <= 0) return;

    // Current balance for this client (sum of the ledger)
    const { data: ledger } = await supabase
      .from('loyalty_points')
      .select('points')
      .eq('beautician_id', beauticianId)
      .eq('client_id', appointment.client_id);

    const balance = (ledger || []).reduce((sum, row) => sum + (row.points || 0), 0);

    const { error } = await supabase.from('loyalty_points').insert({
      beautician_id: beauticianId,
      client_id: appointment.client_id,
      points,
      reason: 'appointment',
      appointment_id: appointment.id,
      balance_after: balance + points,
    });

    // 23505 = unique violation: another writer awarded first. That's fine.
    if (error && error.code !== '23505') {
      logger.warn({ err: error, appointmentId: appointment.id }, 'Loyalty accrual insert failed');
    }
  } catch (err) {
    logger.warn({ err, appointmentId: appointment?.id }, 'Loyalty accrual failed');
  }
}

/**
 * Wire 1: give Florrie's front desk and proactive engines a sense of a
 * client's loyalty standing so replies and offers can mention reward
 * proximity naturally. All helpers below fail soft (null / 0), never throw,
 * and only ever surface loyalty when the beautician has it switched on.
 */

// The beautician's loyalty settings, or null when loyalty is off.
export async function getLoyaltyConfig(beauticianId) {
  try {
    const { data } = await supabase
      .from('loyalty_config')
      .select('is_active, points_per_pound, reward_threshold, reward_name, reward_type, reward_value_cents')
      .eq('beautician_id', beauticianId)
      .maybeSingle();
    return data?.is_active ? data : null;
  } catch (err) {
    logger.warn({ err, beauticianId }, 'Loyalty config read failed');
    return null;
  }
}

// Sum of a client's points ledger. 0 on any error or unknown client.
export async function getClientPoints(beauticianId, clientId) {
  if (!clientId) return 0;
  try {
    const { data } = await supabase
      .from('loyalty_points')
      .select('points')
      .eq('beautician_id', beauticianId)
      .eq('client_id', clientId);
    return (data || []).reduce((sum, row) => sum + (row.points || 0), 0);
  } catch (err) {
    logger.warn({ err, beauticianId, clientId }, 'Loyalty points read failed');
    return 0;
  }
}

// A short, human name for the reward a client is working towards.
export function rewardLabel(config) {
  const named = config?.reward_name && config.reward_name.trim();
  if (named) return named;
  if (config?.reward_type === 'free_treatment') return 'a free treatment';
  if (config?.reward_type === 'gift') return 'a gift';
  const pounds = (config?.reward_value_cents || 0) / 100;
  if (pounds > 0) return `£${pounds % 1 === 0 ? pounds : pounds.toFixed(2)} off`;
  return 'a loyalty reward';
}

/**
 * Describe how close a client is to their reward. Returns null unless they
 * are close enough that a mention would land well (within roughly one visit,
 * or 60%+ of the way there), or have already earned it.
 *   - summary: third person, for a model instruction ("they have 80 of 100…").
 *   - hook: second person, ready to append to a message we send the client.
 */
export function loyaltyProximity(config, pointsBalance, avgSpendPounds) {
  if (!config) return null;
  const threshold = config.reward_threshold || 0;
  if (threshold <= 0) return null;
  const label = rewardLabel(config);
  const balance = pointsBalance || 0;
  const toGo = threshold - balance;

  if (toGo <= 0) {
    return {
      earned: true,
      pointsBalance: balance,
      threshold,
      toGo: 0,
      label,
      summary: `${balance} of ${threshold} points: they have already earned their reward (${label}).`,
      hook: ` You have also earned your ${label} loyalty reward, so this is a lovely time to use it.`,
    };
  }

  const ppp = config.points_per_pound || 1;
  const pointsPerVisit = avgSpendPounds ? Math.round(avgSpendPounds) * ppp : 0;
  const withinOneVisit = pointsPerVisit > 0 && toGo <= pointsPerVisit;
  const closeByRatio = balance >= threshold * 0.6;
  if (!withinOneVisit && !closeByRatio) return null;

  return {
    earned: false,
    pointsBalance: balance,
    threshold,
    toGo,
    label,
    withinOneVisit,
    summary: `${balance} of ${threshold} points towards their reward (${label}), about ${toGo} to go${withinOneVisit ? ', roughly one more visit' : ''}.`,
    hook: withinOneVisit
      ? ` You are also just ${toGo} points from your ${label} loyalty reward, so this visit could tip you over.`
      : ` You are also ${toGo} points from your ${label} loyalty reward.`,
  };
}
