import * as Sentry from '@sentry/node';
import { supabase } from '../config.js';
import { getTaxYear } from './time-utils.js';
import { PRICE_SETTLED_TYPES, completionTakingsCents, isAssumedTakingsRow, supersedeAssumedPlan } from './money-guards.js';
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

/**
 * A real charge has landed, so retract the guess it replaces.
 *
 * 27 August 2026, the incident this whole change comes from: the salon owner
 * asked how to charge a card after a booking says completed. Completion has
 * already written an assumed takings row (above) claiming she was paid in the
 * room. If the charge she then makes simply adds a second row, the same GBP 45
 * is counted twice: once as a guess, once as fact. Her Money tab, her Pulse and
 * the tax she sets aside against them would all be overstated by the price of
 * every booking she ever chased.
 *
 * So the assumption gives way to the evidence, pound for pound and no further
 * (supersedeAssumedPlan). Call this only AFTER the real transaction row is
 * safely inserted: retract first and lose the insert, and the books would show
 * nothing at all for money that has left a client's card.
 *
 * Returns { superseded, reason }. Never throws.
 */
export async function supersedeAssumedTakings(appointmentId, chargedCents) {
  const charged = Math.max(0, Math.round(Number(chargedCents) || 0));
  if (!appointmentId || charged <= 0) return { superseded: 0, reason: 'nothing_to_supersede' };

  // Read the error. PostgREST resolves with { data: null, error } rather than
  // throwing, and an unread error here would look exactly like "no assumed row
  // to worry about", which is the one wrong answer.
  const { data: rows, error } = await supabase
    .from('transactions')
    .select('id, type, amount_cents, payment_method, stripe_payment_intent_id')
    .eq('appointment_id', appointmentId)
    .in('type', PRICE_SETTLED_TYPES)
    .order('created_at', { ascending: true });

  if (error) {
    logger.error({ err: error, appointmentId, charged }, 'assumed takings not superseded: read failed, income may be double counted');
    Sentry.captureMessage('Assumed takings not superseded: read failed', {
      level: 'error',
      tags: { area: 'payments', check: 'assumed_supersede' },
      extra: { appointmentId, chargedPence: charged, dbError: error.message, dbCode: error.code },
    });
    return { superseded: 0, reason: 'read_failed' };
  }

  const assumed = (rows || []).filter(isAssumedTakingsRow);
  if (!assumed.length) return { superseded: 0, reason: 'no_assumed_row' };

  const plan = supersedeAssumedPlan(assumed, charged);

  if (plan.deleteIds.length) {
    const { error: delErr } = await supabase
      .from('transactions')
      .delete()
      .in('id', plan.deleteIds);
    if (delErr) {
      logger.error({ err: delErr, appointmentId, ids: plan.deleteIds }, 'assumed takings row could not be removed, income is double counted');
      Sentry.captureMessage('Assumed takings not superseded: delete failed', {
        level: 'error',
        tags: { area: 'payments', check: 'assumed_supersede' },
        extra: { appointmentId, chargedPence: charged, dbError: delErr.message, dbCode: delErr.code },
      });
      return { superseded: 0, reason: 'delete_failed' };
    }
  }

  for (const row of plan.reduce) {
    const { error: updErr } = await supabase
      .from('transactions')
      .update({ amount_cents: row.amountCents })
      .eq('id', row.id);
    if (updErr) {
      logger.error({ err: updErr, appointmentId, transactionId: row.id }, 'assumed takings row could not be reduced, income is double counted');
      Sentry.captureMessage('Assumed takings not superseded: reduce failed', {
        level: 'error',
        tags: { area: 'payments', check: 'assumed_supersede' },
        extra: { appointmentId, chargedPence: charged, dbError: updErr.message, dbCode: updErr.code },
      });
      return { superseded: 0, reason: 'reduce_failed' };
    }
  }

  logger.info({ appointmentId, chargedPence: charged, supersededPence: plan.supersededCents },
    'Assumed takings superseded by a real charge');
  return { superseded: plan.supersededCents, reason: 'superseded' };
}
