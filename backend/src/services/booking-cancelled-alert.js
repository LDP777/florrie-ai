import { createHash, randomUUID } from 'node:crypto';
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { isCancelledBooking } from '../lib/booking-management-access.js';
import { pushClientCancelled } from './push-notifications.js';

const ACTION = 'booking_cancelled';
const LEASE_MS = 120000;
export function cancellationAlertId(appointmentId) {
  const h = createHash('sha256').update(`client-cancelled:${appointmentId}`).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}

/** Persist delivery intent before changing the booking. A restart after the
 * cancellation can then retry the push without cancelling or charging again. */
export async function queueClientCancellation(appt, { lateCancel, feeCents }) {
  const id = cancellationAlertId(appt.id);
  const { error } = await supabase.from('ai_actions').insert({
    id, beautician_id: appt.beautician_id, client_id: appt.client_id || null, appointment_id: appt.id,
    action_type: ACTION, digital_employee: 'front_desk', outcome: 'pending',
    summary: `${appt.clients?.first_name || 'A client'} requested cancellation of their booking`,
    autonomous: true, notification_sent: false,
    details: { delivery_version: 1, source: 'client_manage', attempt_id: randomUUID(),
      late_cancel: !!lateCancel, fee_cents: feeCents || 0, queued_at: new Date().toISOString() },
  });
  if (error && error.code !== '23505') throw new Error('Could not queue the cancellation notification');
  return id;
}

export async function announceClientCancellation(appointmentId) {
  try {
    const id = cancellationAlertId(appointmentId);
    const [{ data: old, error: ledgerError }, { data: appt, error: appointmentError }] = await Promise.all([
      supabase.from('ai_actions').select('*').eq('id', id).maybeSingle(),
      supabase.from('appointments').select('id, beautician_id, client_id, starts_at, status, clients(first_name)').eq('id', appointmentId).maybeSingle(),
    ]);
    if (ledgerError || appointmentError) throw new Error('Could not check the cancellation delivery');
    if (!old || old.details?.delivery_version !== 1 || !isCancelledBooking(appt)) return { delivered: 0, reason: 'not_cancelled' };
    if (old.outcome === 'success') return { delivered: 0, reason: 'already_announced' };
    if (Date.parse(old.details?.lease_until) > Date.now()) return { delivered: 0, reason: 'delivery_in_progress' };
    const attemptId = randomUUID();
    const details = { ...old.details, attempt_id: attemptId, last_attempt_at: new Date().toISOString(), lease_until: new Date(Date.now() + LEASE_MS).toISOString() };
    const claim = await supabase.from('ai_actions').update({ outcome: 'pending', details })
      .eq('id', id).eq('details->>attempt_id', old.details.attempt_id).select('id');
    if (claim.error || !claim.data?.length) return { delivered: 0, reason: 'delivery_claim_lost' };

    const day = String(appt.starts_at).slice(0, 10);
    const dateLabel = `${new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })} at ${String(appt.starts_at).slice(11,16)}`;
    const clientName = appt.clients?.first_name || 'A client';
    let result;
    try {
      result = await pushClientCancelled(appt.beautician_id, clientName, dateLabel, {
        appointmentId, apptDate: appt.starts_at, notificationId: id,
        lateCancel: details.late_cancel, feeCents: details.fee_cents,
        channels: { web: !details.web_delivered, apns: !details.apns_delivered },
      });
    } catch (err) { logger.warn({ err, appointmentId }, 'Cancellation push will retry'); }
    const web = (details.web_delivered || 0) + (result?.sent || 0);
    const apns = (details.apns_delivered || 0) + (result?.apns?.sent || 0);
    const delivered = web + apns;
    const nativeFailed = !apns && result?.apns?.reason && result.apns.reason !== 'no_device_registered';
    const failed = !result?.suppressed && (!delivered || nativeFailed || result?.web_failed);
    const saved = await supabase.from('ai_actions').update({
      outcome: failed ? 'failed' : 'success', notification_sent: delivered > 0,
      summary: `${clientName} cancelled their ${dateLabel} appointment`,
      details: { ...details, lease_until: null, web_delivered: web, apns_delivered: apns,
        apns_reason: result?.apns?.reason || null, suppressed: result?.suppressed || null },
    }).eq('id', id).eq('details->>attempt_id', attemptId);
    if (saved.error) throw new Error('Could not record cancellation delivery');
    return { delivered, reason: failed ? 'delivery_failed' : 'delivered' };
  } catch (err) {
    logger.error({ err, appointmentId }, 'Cancellation alert remains queued for retry');
    return { delivered: 0, reason: 'retry_pending' };
  }
}

export async function retryClientCancellationAlerts() {
  const { data, error } = await supabase.from('ai_actions').select('appointment_id')
    .eq('action_type', ACTION).eq('details->>delivery_version', '1')
    .in('outcome', ['failed', 'pending'])
    .gte('created_at', new Date(Date.now() - 7 * 86400000).toISOString())
    .order('details->>last_attempt_at', { ascending: true, nullsFirst: true }).limit(100);
  if (error) throw new Error('Could not read the cancellation notification queue');
  for (const row of data || []) await announceClientCancellation(row.appointment_id);
  return { attempted: data?.length || 0 };
}
