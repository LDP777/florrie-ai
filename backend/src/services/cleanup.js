/**
 * Cleanup service — handles stale bookings and expired data.
 *
 * Runs on an interval from index.js. Each function is idempotent
 * and safe to call multiple times.
 */
import { supabase } from '../index.js';

const STALE_MINUTES = 15; // Cancel unpaid bookings after 15 minutes

/**
 * Find appointments that are 'pending' (waiting for deposit payment)
 * and were created more than STALE_MINUTES ago. Cancel them to free
 * the time slot for other clients.
 */
export async function cleanupStaleBookings() {
  const cutoff = new Date(Date.now() - STALE_MINUTES * 60 * 1000).toISOString();

  // Find pending appointments where deposit is required but not paid
  const { data: stale, error } = await supabase
    .from('appointments')
    .select('id, beautician_id, client_id, deposit_cents, deposit_paid')
    .eq('status', 'pending')
    .gt('deposit_cents', 0)
    .neq('deposit_paid', true)
    .lt('created_at', cutoff);

  if (error || !stale?.length) {
    return { cancelled: 0 };
  }

  let cancelled = 0;
  for (const appt of stale) {
    const { error: updateErr } = await supabase
      .from('appointments')
      .update({
        status: 'cancelled',
        cancellation_reason: 'auto_cancelled_unpaid',
        cancelled_at: new Date().toISOString(),
      })
      .eq('id', appt.id)
      .eq('status', 'pending'); // double-check it's still pending (avoid race)

    if (!updateErr) {
      cancelled++;

      // Log the AI action
      await supabase.from('ai_actions').insert({
        beautician_id: appt.beautician_id,
        action_type: 'booking_auto_cancelled',
        digital_employee: 'front_desk',
        summary: `Auto-cancelled unpaid booking after ${STALE_MINUTES} minutes`,
        details: { appointment_id: appt.id, reason: 'deposit_not_paid' },
        client_id: appt.client_id,
        appointment_id: appt.id,
        confidence: 1.0,
        autonomous: true,
        outcome: 'success',
      }).catch(() => {}); // non-fatal
    }
  }

  return { cancelled, checked: stale.length };
}
