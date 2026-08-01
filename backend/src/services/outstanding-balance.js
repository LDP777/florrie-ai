import { supabase } from '../config.js';
import { computePolicyFee } from './policy-fees.js';
import logger from '../lib/logger.js';

/**
 * What does this client still owe from previous visits?
 *
 * The data model has no single "balance" column, so the owing figure is
 * derived from the three places unpaid money can actually be seen:
 *
 *   1. An unpaid no-show fee: status 'no_show' with a chargeable fee under
 *      the policy but policy_fee_charged_at still NULL (the charge failed,
 *      or there was no card, or Ellie has not tapped Charge).
 *   2. An unpaid late-cancel fee: late_cancel_charged flagged at cancel time
 *      (meaning "a fee applies") but policy_fee_charged_at still NULL.
 *   3. An unsettled remainder: a 'completed' appointment with a price but no
 *      payment / full_payment transaction. Completion normally writes an
 *      assumed-takings row, so a completed appointment with no payment row
 *      means the income was reversed or removed, i.e. not actually settled.
 *
 * CAUTION - this check must FAIL OPEN. It feeds a warning on the public
 * booking page and a line on the appointment sheet; a broken query must
 * never block a booking or an appointment view. Every Supabase result is
 * error-checked (supabase does not throw) and any failure returns zero.
 *
 * Returns { owesCents, sources } where sources is a small breakdown for
 * logging/debugging. Never throws.
 */
export async function getOutstandingBalanceCents(beauticianId, clientId) {
  const nothing = { owesCents: 0, sources: [] };
  if (!beauticianId || !clientId) return nothing;

  try {
    // Most recent 100 finished/broken appointments is plenty: owing money on
    // something older than that is not a warning worth showing anyway.
    const [{ data: appts, error: apptErr }, { data: bRow, error: bErr }] = await Promise.all([
      supabase
        .from('appointments')
        .select('id, status, price_cents, deposit_cents, deposit_paid, policy_snapshot, policy_fee_charged_at, late_cancel_charged, starts_at')
        .eq('beautician_id', beauticianId)
        .eq('client_id', clientId)
        .in('status', ['no_show', 'cancelled', 'completed'])
        .order('starts_at', { ascending: false })
        .limit(100),
      supabase
        .from('beauticians')
        .select('booking_policy')
        .eq('id', beauticianId)
        .maybeSingle(),
    ]);

    if (apptErr) {
      logger.warn({ err: apptErr, clientId }, 'outstanding-balance: appointment query failed, failing open');
      return nothing;
    }
    if (bErr) {
      logger.warn({ err: bErr, clientId }, 'outstanding-balance: policy query failed, failing open');
      return nothing;
    }
    if (!appts || appts.length === 0) return nothing;

    const livePolicy = bRow?.booking_policy || {};
    // Same snapshot merge as policy-fees.js: the frozen snapshot the client
    // agreed to wins, except a no-show percent added after booking still
    // applies (old snapshots simply lack the key).
    const policyFor = (appt) => {
      const snap = appt.policy_snapshot || {};
      return appt.policy_snapshot
        ? { ...snap, ...(snap.no_show_charge_percent === undefined && livePolicy.no_show_charge_percent !== undefined
              ? { no_show_charge_percent: livePolicy.no_show_charge_percent } : {}) }
        : livePolicy;
    };

    let owesCents = 0;
    const sources = [];
    const completedIds = [];

    for (const appt of appts) {
      if (appt.status === 'no_show' && !appt.policy_fee_charged_at) {
        const { feeCents } = computePolicyFee(appt, policyFor(appt), 'no_show');
        if (feeCents > 0) {
          owesCents += feeCents;
          sources.push({ appointment_id: appt.id, kind: 'no_show_fee', cents: feeCents });
        }
      } else if (appt.status === 'cancelled' && appt.late_cancel_charged && !appt.policy_fee_charged_at) {
        const { feeCents } = computePolicyFee(appt, policyFor(appt), 'late_cancel');
        if (feeCents > 0) {
          owesCents += feeCents;
          sources.push({ appointment_id: appt.id, kind: 'late_cancel_fee', cents: feeCents });
        }
      } else if (appt.status === 'completed' && (appt.price_cents || 0) > 0) {
        completedIds.push(appt.id);
      }
    }

    if (completedIds.length > 0) {
      // One round trip: which completed appointments have a settled payment?
      const { data: paid, error: txErr } = await supabase
        .from('transactions')
        .select('appointment_id')
        .in('appointment_id', completedIds)
        .in('type', ['payment', 'full_payment']);
      if (txErr) {
        // Fail open on this leg only: the fee legs above are still valid.
        logger.warn({ err: txErr, clientId }, 'outstanding-balance: transactions query failed, skipping remainder check');
      } else {
        const paidSet = new Set((paid || []).map(t => t.appointment_id));
        for (const appt of appts) {
          if (appt.status !== 'completed' || paidSet.has(appt.id)) continue;
          const depositPaid = appt.deposit_paid ? (appt.deposit_cents || 0) : 0;
          const remainder = Math.max(0, (appt.price_cents || 0) - depositPaid);
          if (remainder > 0) {
            owesCents += remainder;
            sources.push({ appointment_id: appt.id, kind: 'unsettled_remainder', cents: remainder });
          }
        }
      }
    }

    return { owesCents, sources };
  } catch (err) {
    logger.warn({ err, clientId }, 'outstanding-balance: unexpected failure, failing open');
    return nothing;
  }
}
