import { supabase } from '../config.js';
import { getTaxYear } from './time-utils.js';
import logger from './logger.js';

/**
 * Log the "assumed" takings for a completed appointment, exactly like the
 * auto-complete sweep does. Takings = price minus any deposit already counted
 * at booking, written as a type='payment' row with payment_method=null (the
 * 'assumed/auto' marker the no_show reversal looks for, so marking a no-show
 * still removes it cleanly). Idempotent: skips if a payment/full_payment row
 * already exists for the appointment, so re-completing or the cron can never
 * double-count.
 */
export async function logAssumedTakings(beauticianId, appt) {
  if (!appt?.id) return;
  const depositPaid = appt.deposit_paid ? (appt.deposit_cents || 0) : 0;
  const takings = Math.max(0, (appt.price_cents || 0) - depositPaid);
  if (takings <= 0) return;

  const { data: prior } = await supabase
    .from('transactions')
    .select('id')
    .eq('appointment_id', appt.id)
    .in('type', ['payment', 'full_payment'])
    .limit(1);
  if (prior && prior.length) return;

  const { error } = await supabase.from('transactions').insert({
    beautician_id: beauticianId,
    appointment_id: appt.id,
    client_id: appt.client_id || null,
    amount_cents: takings,
    type: 'payment',
    status: 'completed',
    payment_method: null,
    tax_year: getTaxYear(new Date(appt.starts_at || Date.now())),
  });
  if (error) logger.error({ err: error, appointmentId: appt.id }, 'logAssumedTakings insert failed');
}
