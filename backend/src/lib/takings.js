import * as Sentry from '@sentry/node';
import { supabase } from '../config.js';
import { getTaxYear } from './time-utils.js';
import { PRICE_SETTLED_TYPES, completionTakingsCents } from './money-guards.js';
import logger from './logger.js';

/**
 * Log the "assumed" takings for a completed appointment, exactly like the
 * auto-complete sweep does. Takings = price minus any deposit already counted
 * at booking, written as a type='payment' row with payment_method=null (the
 * 'assumed/auto' marker the no_show reversal looks for, so marking a no-show
 * still removes it cleanly).
 *
 * Every path that completes an appointment must come through here. There were
 * three of them and they disagreed: this one and the cron logged the remainder,
 * POST /:id/complete logged the FULL price, so the same booking reported
 * different income depending on how it was finished.
 *
 * Idempotent: skips if the price has already been settled (canonical type list
 * in money-guards.js, which is where the missing 'payment_link' came from).
 *
 * Returns { logged, reason }. Never throws.
 */
export async function logAssumedTakings(beauticianId, appt) {
  if (!appt?.id) return { logged: false, reason: 'no_appointment' };
  const takings = completionTakingsCents(appt);
  if (takings <= 0) return { logged: false, reason: 'nothing_due' };

  const { data: prior, error: priorErr } = await supabase
    .from('transactions')
    .select('id')
    .eq('appointment_id', appt.id)
    .in('type', PRICE_SETTLED_TYPES)
    .limit(1);

  if (priorErr) {
    // Refuse rather than guess. The error was not destructured here either, so
    // a transient read failure returned null and this inserted a duplicate
    // income row on top of money already banked.
    logger.error({ err: priorErr, appointmentId: appt.id }, 'logAssumedTakings: guard unreadable, skipping');
    Sentry.captureMessage('Takings not logged: guard unreadable', {
      level: 'warning',
      tags: { area: 'payments', check: 'takings_guard' },
      extra: {
        appointmentId: appt.id,
        beauticianId,
        takingsPence: takings,
        dbError: priorErr.message,
        dbCode: priorErr.code,
      },
    });
    return { logged: false, reason: 'guard_unreadable' };
  }
  if (prior && prior.length) return { logged: false, reason: 'already_logged' };

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
  if (error) {
    // The appointment reads as completed, so Ellie believes she was paid, and
    // the Money tab counts nothing. Logged AND captured: the log alone is what
    // let weeks of takings vanish unnoticed.
    logger.error({ err: error, appointmentId: appt.id }, 'logAssumedTakings insert failed');
    Sentry.captureMessage('Takings lost: completion transaction insert failed', {
      level: 'error',
      tags: { area: 'payments', check: 'transaction_insert' },
      extra: {
        appointmentId: appt.id,
        beauticianId,
        takingsPence: takings,
        dbError: error.message,
        dbCode: error.code,
      },
    });
    return { logged: false, reason: 'insert_failed' };
  }

  return { logged: true, takings };
}
