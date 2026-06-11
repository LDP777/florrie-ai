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
