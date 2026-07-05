/**
 * Auto-complete past appointments.
 *
 * Ellie's workflow (decided 2026-06-21): assume every appointment happened -
 * mark it completed and count the takings - UNLESS she flags a no-show. This
 * removes the daily admin of tapping each one complete.
 *
 * This sweep flips CONFIRMED appointments whose end time has passed to
 * 'completed' and records the takings as a 'payment' transaction, which is what
 * the Money tab counts as income (see routes/money.js).
 *
 * Takings = the REMAINING balance: price minus any deposit already paid (the
 * deposit is logged as its own income row at booking, so logging the full price
 * here would double-count it). A fully-paid appointment still flips to completed
 * but logs no extra takings.
 *
 * The takings row is written with payment_method = null - the "assumed / auto"
 * marker. If Ellie later marks the appointment a no-show, the no_show branch in
 * routes/appointments.js deletes exactly those rows (type 'payment', null
 * method) and charges the policy fee instead, so the Money tab updates. Real
 * card charges (deposits, balance charges) carry a payment_method and are never
 * touched by the reversal.
 *
 * Safety:
 *  - Only 'confirmed' appointments (never pending / cancelled / already done).
 *  - Only a recent window (ended in the last 48h) so it never retroactively
 *    completes a big lump of ancient un-actioned bookings.
 *  - Idempotent: the status update is guarded (.eq('status','confirmed')) and
 *    the takings insert is skipped if a payment row already exists.
 */
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { getTaxYear } from '../lib/time-utils.js';

const WINDOW_MS = 48 * 60 * 60 * 1000;

export async function autoCompletePastAppointments() {
  const nowIso = new Date().toISOString();
  const windowStart = new Date(Date.now() - WINDOW_MS).toISOString();

  const { data: appts, error } = await supabase
    .from('appointments')
    .select('id, beautician_id, client_id, treatment_id, price_cents, deposit_cents, deposit_paid, starts_at, treatments(name), clients(first_name)')
    .eq('status', 'confirmed')
    .lt('ends_at', nowIso)
    .gte('ends_at', windowStart);

  if (error) {
    logger.error({ err: error }, 'auto-complete: fetch failed');
    return { completed: 0 };
  }
  if (!appts || appts.length === 0) return { completed: 0 };

  let completed = 0;
  for (const appt of appts) {
    // Flip to completed. The status guard makes this a no-op if a manual
    // complete / no-show already moved it between fetch and write.
    const { data: updated, error: upErr } = await supabase
      .from('appointments')
      .update({ status: 'completed', completed_at: nowIso })
      .eq('id', appt.id)
      .eq('status', 'confirmed')
      .select('id')
      .maybeSingle();

    if (upErr) {
      logger.error({ err: upErr, id: appt.id }, 'auto-complete: status update failed');
      continue;
    }
    if (!updated) continue; // already moved by another path
    completed++;

    // Takings = remaining balance (price minus any deposit already counted).
    const depositPaid = appt.deposit_paid ? (appt.deposit_cents || 0) : 0;
    const takings = Math.max(0, (appt.price_cents || 0) - depositPaid);
    if (takings <= 0) continue;

    // Don't double-log if a payment / full payment already exists.
    const { data: prior } = await supabase
      .from('transactions')
      .select('id')
      .eq('appointment_id', appt.id)
      .in('type', ['payment', 'full_payment'])
      .limit(1);
    if (prior && prior.length) continue;

    const { error: txErr } = await supabase.from('transactions').insert({
      beautician_id: appt.beautician_id,
      appointment_id: appt.id,
      client_id: appt.client_id || null,
      // transactions has no treatment_id column - its presence rejected the
      // WHOLE insert, so cron-completed appointments logged no takings.
      amount_cents: takings,
      type: 'payment',
      status: 'completed',
      payment_method: null, // assumed / auto - lets the no-show reversal find it
      tax_year: getTaxYear(new Date(appt.starts_at)),
      description: `${appt.treatments?.name || 'Appointment'}${appt.clients?.first_name ? ` - ${appt.clients.first_name}` : ''}`,
    });
    if (txErr) {
      logger.error({ err: txErr, id: appt.id }, 'auto-complete: takings insert failed');
    }
  }

  if (completed) logger.info({ completed }, 'Auto-completed past appointments');
  return { completed };
}
