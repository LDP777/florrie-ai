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
import * as Sentry from '@sentry/node';
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { getTaxYear } from '../lib/time-utils.js';

const WINDOW_MS = 48 * 60 * 60 * 1000;

// Current time as Europe/London WALL-CLOCK, formatted in the UTC slot
// ('YYYY-MM-DDTHH:MM:SS.000Z') to match how appointment starts_at/ends_at are
// stored (salon wall time placed in the UTC slot). In GMT this equals real UTC;
// in British Summer Time it is +1h - which is the whole point: comparing wall
// ends_at against real UTC made everything auto-complete an hour late in summer.
function londonWallISO(date = new Date()) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date).reduce((acc, x) => (acc[x.type] = x.value, acc), {});
  const hh = p.hour === '24' ? '00' : p.hour; // en-GB renders midnight as 24
  return `${p.year}-${p.month}-${p.day}T${hh}:${p.minute}:${p.second}.000Z`;
}

export async function autoCompletePastAppointments() {
  const nowWall = londonWallISO();                                     // wall-clock now (UTC-slot form)
  const windowStart = londonWallISO(new Date(Date.now() - WINDOW_MS)); // wall-clock 48h ago
  const completedAt = new Date().toISOString();                        // real timestamp for the record

  const { data: appts, error } = await supabase
    .from('appointments')
    .select('id, beautician_id, client_id, treatment_id, price_cents, deposit_cents, deposit_paid, starts_at, treatments(name), clients(first_name)')
    .eq('status', 'confirmed')
    .lt('ends_at', nowWall)
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
      .update({ status: 'completed', completed_at: completedAt })
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

    // Count the visit and the spend on the client record. The cron completes
    // most appointments, and it never told the client profile, which is why
    // regulars showed 0 pounds spent. Same RPC the manual paths use.
    if (appt.client_id) {
      const { error: visitErr } = await supabase.rpc('increment_client_visit', {
        p_client_id: appt.client_id,
        p_amount: appt.price_cents || 0,
      });
      if (visitErr) logger.error({ err: visitErr, id: appt.id }, 'auto-complete: visit increment failed');
    }

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
      // The appointment is now marked completed, so Ellie believes she was
      // paid, and the Money tab counts nothing. This error WAS being checked
      // and logged, and the money was still permanently lost, because nothing
      // consumed the log. Sentry now does, and the nightly reconciliation
      // (services/reconciliation.js, class c) catches any that slip past.
      logger.error({ err: txErr, id: appt.id }, 'auto-complete: takings insert failed');
      Sentry.captureMessage('Takings lost: auto-complete transaction insert failed', {
        level: 'error',
        tags: { area: 'payments', check: 'transaction_insert' },
        extra: {
          appointmentId: appt.id,
          beauticianId: appt.beautician_id,
          takingsPence: takings,
          dbError: txErr.message,
          dbCode: txErr.code,
        },
      });
    }
  }

  if (completed) logger.info({ completed }, 'Auto-completed past appointments');
  return { completed };
}
