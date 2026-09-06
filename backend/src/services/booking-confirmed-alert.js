/** Booking status and owner delivery are separate facts. ai_actions is the
 * durable delivery ledger; its primary key also serializes concurrent senders.
 * A failed attempt can be retried without undoing the confirmed booking. */
import * as Sentry from '@sentry/node';
import { createHash, randomUUID } from 'node:crypto';
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { pushBookingConfirmed } from './push-notifications.js';

export const BOOKING_CONFIRMED_ACTION = 'booking_confirmed';
const LEASE_MS = 120_000;
let reconciliationOffset = 0;
let reconciliationBoundary = null;
function actionId(id) {
  const hex = createHash('sha256').update(`booking-confirmed:${id}`).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
const skipped = reason => ({ announced: false, delivered: 0, channel: 'none', reason });

export async function claimConfirmed(appointmentId, extraFields = {}) {
  if (!appointmentId) return { won: false, reason: 'no_appointment' };
  try {
    const { data, error } = await supabase.from('appointments')
      .update({ ...extraFields, status: 'confirmed' }).eq('id', appointmentId)
      .eq('status', 'pending').select('id');
    if (error) return { won: false, reason: 'claim_unreadable' };
    return { won: !!data?.length, reason: data?.length ? 'transitioned' : 'not_pending' };
  } catch { return { won: false, reason: 'claim_unreadable' }; }
}
function labelFor(startsAt) {
  const day = String(startsAt || '').slice(0,10);
  if (!day) return 'their appointment';
  const shown = new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${shown} at ${String(startsAt).slice(11,16)}`;
}
export async function announceBookingConfirmed(appointmentId, opts = {}) {
  try { return await announce(appointmentId, opts); }
  catch (err) {
    logger.error({ err, appointmentId }, 'Booking-confirmed delivery failed; retry remains available');
    return skipped('threw');
  }
}
async function announce(appointmentId, { source = 'unknown', claim = true } = {}) {
  if (!appointmentId) return skipped('no_appointment');
  if (claim) {
    const transition = await claimConfirmed(appointmentId);
    if (transition.reason === 'claim_unreadable') return skipped(transition.reason);
  }
  const { data: appt, error } = await supabase.from('appointments')
    .select('id, status, deposit_paid, beautician_id, client_id, starts_at, clients(first_name), treatments(name)')
    .eq('id', appointmentId).maybeSingle();
  if (error || !appt) return skipped('appointment_unreadable');
  if (appt.status !== 'confirmed') return skipped('not_confirmed');
  if (!appt.beautician_id) return skipped('no_beautician');

  const id = actionId(appointmentId);
  const { data: previous, error: ledgerError } = await supabase.from('ai_actions').select('*')
    .eq('appointment_id', appointmentId).eq('action_type', BOOKING_CONFIRMED_ACTION);
  if (ledgerError) return skipped('ledger_unreadable');
  // Honour successful records written before the deterministic delivery key.
  if (previous?.some(row => row.outcome === 'success')) return skipped('already_announced');
  const old = previous?.find(row => row.id === id);
  if (old?.outcome === 'pending' && Date.parse(old.details?.lease_until) > Date.now()) return skipped('delivery_in_progress');
  const attemptId = randomUUID();
  const details = { ...(old?.details || {}), appointment_id: appointmentId, source,
    attempt_id: attemptId, last_attempt_at: new Date().toISOString(), lease_until: new Date(Date.now() + LEASE_MS).toISOString() };
  const clientName = appt.clients?.first_name || 'A client';
  const treatmentName = appt.treatments?.name || 'their treatment';
  const dateLabel = labelFor(appt.starts_at);
  const summary = `${clientName} is booked in for ${treatmentName}, ${dateLabel}`;
  let reservation;
  if (old) {
    reservation = await supabase.from('ai_actions').update({ outcome: 'pending', details })
      .eq('id', id).eq('details->>attempt_id', old.details?.attempt_id).select('id');
  } else {
    reservation = await supabase.from('ai_actions').insert({ id, beautician_id: appt.beautician_id,
      action_type: BOOKING_CONFIRMED_ACTION, digital_employee: 'front_desk', summary, details,
      appointment_id: appointmentId, client_id: appt.client_id || null, outcome: 'pending',
      confidence: 1, autonomous: true, notification_sent: false }).select('id');
  }
  if (reservation.error || !reservation.data?.length) return skipped('delivery_claim_lost');

  let result;
  try {
    result = await pushBookingConfirmed(appt.beautician_id, clientName, treatmentName, dateLabel, {
      appointmentId, apptDate: appt.starts_at, depositPaid: appt.deposit_paid === true,
      channels: { web: !details.web_delivered, apns: !details.apns_delivered },
    });
  } catch (err) { logger.warn({ err, appointmentId }, 'Booking-confirmed provider failed'); }
  const webDelivered = (details.web_delivered || 0) + (result?.sent || 0);
  const apnsDelivered = (details.apns_delivered || 0) + (result?.apns?.sent || 0);
  const delivered = webDelivered + apnsDelivered;
  const suppressed = result?.suppressed || null;
  // A web success does not turn an APNs rejection into a successful delivery.
  const nativeFailed = !apnsDelivered && result?.apns?.reason && result.apns.reason !== 'no_device_registered';
  const failed = !suppressed && (!delivered || nativeFailed || result?.web_failed);
  if (!suppressed && !delivered) Sentry.captureMessage('Booking confirmed and the owner was told nothing', { level: 'error', extra: { appointmentId, source } });
  const channel = suppressed ? 'suppressed' : delivered ? 'push' : 'none';
  const { error: saveError } = await supabase.from('ai_actions').update({
    outcome: failed ? 'failed' : 'success', notification_sent: delivered > 0,
    notification_text: summary,
    details: { ...details, web_delivered: webDelivered, apns_delivered: apnsDelivered,
      alerted_by: channel, alert_delivered: delivered, apns_reason: result?.apns?.reason || null },
  }).eq('id', id).eq('details->>attempt_id', attemptId);
  if (saveError) logger.error({ err: saveError, appointmentId }, 'Could not record booking-confirmed delivery');
  return { announced: true, delivered, channel, reason: failed ? 'delivery_failed' : 'delivered' };
}


/** Retry recent unsuccessful deliveries independently of customer redirects. */
export async function retryBookingConfirmedAlerts() {
  const rollout = Date.parse(process.env.BOOKING_ALERT_RECONCILE_FROM || '');
  if (!Number.isFinite(rollout)) return { attempted: 0 };
  const cutoff = new Date(Math.max(rollout, Date.now() - 24 * 60 * 60 * 1000)).toISOString();
  if (reconciliationBoundary !== rollout) { reconciliationOffset = 0; reconciliationBoundary = rollout; }
  const { data, error } = await supabase.from('ai_actions').select('appointment_id')
    .eq('action_type', BOOKING_CONFIRMED_ACTION).in('outcome', ['failed', 'pending'])
    .gte('created_at', cutoff)
    .order('details->>last_attempt_at', { ascending: true, nullsFirst: true }).limit(100);
  if (error) throw new Error('Could not read booking confirmation retry queue');
  let attempted = 0;
  const visited = new Set();
  for (const row of data || []) {
    visited.add(row.appointment_id);
    const result = await announceBookingConfirmed(row.appointment_id, { source: 'delivery_retry', claim: false });
    if (result.announced) attempted++;
  }
  // Explicit deployment boundary prevents announcing historic bookings. This
  // second pass finds new free/manual bookings whose initial ledger write failed.
  {
    const recent = await supabase.from('appointments').select('id')
      .eq('status', 'confirmed').gte('created_at', cutoff)
      .gte('starts_at', new Date().toISOString().slice(0, 10))
      .order('created_at', { ascending: true }).order('id', { ascending: true })
      .range(reconciliationOffset, reconciliationOffset + 99);
    if (recent.error) throw new Error('Could not reconcile recent booking confirmations');
    reconciliationOffset = recent.data?.length === 100 ? reconciliationOffset + 100 : 0;
    for (const appointment of recent.data || []) {
      if (visited.has(appointment.id)) continue;
      const result = await announceBookingConfirmed(appointment.id, { source: 'confirmation_reconcile', claim: false });
      if (result.announced) attempted++;
    }
  }
  return { attempted };
}
