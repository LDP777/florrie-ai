import { createHash } from 'node:crypto';
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { salonWallInstant, readBookingPreparation } from '../lib/booking-preparation.js';

const ACTIVE = ['preparing', 'awaiting_whatsapp', 'sms_ready', 'sending_sms'];
const HOUR = 3600000;
const iso = () => new Date().toISOString();
const treatments = appointment => [...new Set([appointment.treatment_id, ...(appointment.extra_treatment_ids || [])].filter(Boolean))].sort().join(',');
const phoneKey = value => {
  const digits = String(value || '').replace(/\D/g, '').replace(/^00/, '');
  return digits.startsWith('0') ? `44${digits.slice(1)}` : digits;
};

async function change(row, values) {
  const result = await supabase.from('appointment_reminder_deliveries')
    .update({ ...values, updated_at: iso() }).eq('id', row.id).eq('state', row.state).select('*').maybeSingle();
  if (result.error) throw result.error;
  return result.data;
}

async function activity(row, outcome, summary) {
  // Same id for this delivery's updates, so a repeated receipt makes no new alert.
  const { error } = await supabase.from('ai_actions').upsert({
    id: row.id, beautician_id: row.beautician_id, client_id: row.client_id,
    appointment_id: row.appointment_id, action_type: 'reminder_delivery',
    digital_employee: 'calendar', outcome, summary,
    details: { delivery_id: row.id, delivery_status: row.state,
      whatsapp_message_id: row.whatsapp_message_id, sms_message_id: row.sms_message_id },
  }, { onConflict: 'id' });
  if (error) logger.warn({ deliveryId: row.id, code: error.code }, 'Reminder delivery activity could not be saved');
}

async function receipt(row) {
  if (!row.whatsapp_message_id) return null;
  const result = await supabase.from('whatsapp_delivery_receipts').select('status')
    .eq('message_id', row.whatsapp_message_id).maybeSingle();
  if (result.error) throw result.error;
  return result.data?.status;
}

async function stillRelevant(row) {
  const { data: appointment, error } = await supabase.from('appointments')
    .select('id, status, starts_at, ends_at, treatment_id, extra_treatment_ids, client_id, beautician_id, clients(id, beautician_id, phone), beauticians(timezone, patch_test_expiry_months, patch_test_auto_remind, client_reminder_prefs)')
    .eq('id', row.appointment_id).eq('beautician_id', row.beautician_id).maybeSingle();
  if (error) throw error;
  const allowed = row.message_type === 'appointment_reminder' ? ['confirmed'] : ['confirmed', 'pending'];
  if (!appointment || !allowed.includes(appointment.status)
    || appointment.client_id !== row.client_id || appointment.clients?.beautician_id !== row.beautician_id
    || Date.parse(appointment.starts_at) !== Date.parse(row.appointment_starts_at)
    || phoneKey(appointment.clients?.phone) !== phoneKey(row.phone)
    || treatments(appointment) !== row.booking_snapshot.treatments
    || (row.booking_snapshot.ends_at && Date.parse(appointment.ends_at) !== Date.parse(row.booking_snapshot.ends_at))) return false;
  const starts = Date.parse(salonWallInstant(appointment.starts_at, appointment.beauticians?.timezone || 'Europe/London'));
  if (!Number.isFinite(starts) || starts <= Date.now() || Date.parse(row.expires_at) <= Date.now()) return false;
  // Conversation pause is deliberately absent. Only the relevant care choice applies.
  if (appointment.beauticians?.client_reminder_prefs?.channel === 'email') return false;
  if (row.message_type === 'patch_test' && appointment.beauticians?.patch_test_auto_remind === false) return false;
  if (row.message_type !== 'appointment_reminder') {
    const prep = await readBookingPreparation(supabase, appointment);
    if (row.message_type === 'patch_test' && (!prep.patch.required || prep.patch.can_complete || prep.patch.state === 'booked')) return false;
    if (row.message_type === 'consultation_form' && !prep.forms.some(form => form.status !== 'received' && form.available)) return false;
  }
  return true;
}

async function attemptSms(row, sendSms) {
  const status = await receipt(row);
  if (['delivered', 'read'].includes(status)) {
    await change(row, { state: 'whatsapp_delivered' });
    return null;
  }
  if (!await stillRelevant(row)) {
    await change(row, { state: 'suppressed' });
    return null;
  }
  const claimed = await supabase.rpc('claim_appointment_reminder_sms', { p_id: row.id });
  if (claimed.error) throw claimed.error;
  const claim = claimed.data?.[0];
  if (!claim) return null;
  // Check again after the claim: a cancellation, phone edit or delivered receipt
  // may have arrived while this worker waited for the database row lock.
  if (!await stillRelevant(claim) || ['delivered', 'read'].includes(await receipt(claim))) {
    await change(claim, { state: 'suppressed' });
    return null;
  }
  let result;
  try {
    result = await sendSms({ to: claim.phone, body: claim.body, beauticianId: claim.beautician_id,
      clientId: claim.client_id, messageType: claim.message_type, singleAttempt: true });
  } catch (err) {
    const state = err.deliveryUnknown ? 'sms_unknown' : 'sms_failed';
    const updated = await change(claim, { state });
    if (updated) await activity(updated, 'failed', err.deliveryUnknown
      ? 'Please check this reminder: the text provider has not confirmed whether it was sent.'
      : 'The appointment reminder could not be sent by text. Please contact the client.');
    return null;
  }
  const updated = await change(claim, { state: result ? 'sms_sent' : 'sms_failed', sms_message_id: result?.id || null });
  if (updated) await activity(updated, result ? 'success' : 'failed', result
    ? (claim.whatsapp_message_id ? 'WhatsApp could not deliver the appointment reminder. Sent it by text instead.' : 'Appointment reminder sent by text.')
    : 'The appointment reminder could not be sent by text. Please contact the client.');
  return result ? { channel: 'sms', result } : null;
}

/** Reserve a new reminder before contacting either provider. Never backfill old failures. */
export async function sendTrackedReminder({ appointment, client, body, messageType, sendWhatsApp, sendSms }) {
  const owner = appointment.beautician_id;
  const sourceKey = createHash('sha256').update(`${appointment.id}:${appointment.starts_at}:${messageType}:${body}`).digest('hex');
  const created = await supabase.from('appointment_reminder_deliveries').insert({
    beautician_id: owner, client_id: client.id || appointment.client_id, appointment_id: appointment.id,
    appointment_starts_at: appointment.starts_at, phone: client.phone, body, message_type: messageType,
    booking_snapshot: { treatments: treatments(appointment), ends_at: appointment.ends_at || null },
    source_key: sourceKey, expires_at: new Date(Date.now() + 12 * HOUR).toISOString(),
  }).select('*').maybeSingle();
  if (created.error?.code === '23505') return null;
  if (created.error || !created.data) throw created.error || new Error('Reminder delivery could not be reserved');
  const row = created.data;
  if (!await stillRelevant(row)) { await change(row, { state: 'suppressed' }); return null; }
  let wa;
  try { wa = sendWhatsApp ? await sendWhatsApp() : null; }
  catch (err) {
    if (err.deliveryUnknown) {
      const updated = await change(row, { state: 'attention' });
      if (updated) await activity(updated, 'failed', 'Please check this reminder: WhatsApp has not confirmed whether it was sent.');
      return null;
    }
    // A configuration/preflight error must not prevent an available SMS route.
    logger.warn({ deliveryId: row.id, code: err.code }, 'WhatsApp reminder unavailable; trying SMS');
  }
  if (wa) {
    const id = wa.messages?.[0]?.id || wa.sid || null;
    const updated = await change(row, { state: id ? 'awaiting_whatsapp' : 'attention', whatsapp_message_id: id });
    if (updated && id) {
      const fallback = await attemptSms(updated, sendSms); // A receipt may beat the POST response.
      if (fallback) return fallback;
      if (await receipt(updated) === 'failed') return null;
    }
    return { channel: 'whatsapp', result: wa };
  }
  const ready = await change(row, { state: 'sms_ready' });
  return ready ? attemptSms(ready, sendSms) : null;
}

/** Persist verified receipts BEFORE acknowledging Meta, including all entries in a batch. */
export async function saveWhatsAppReceipts(statuses) {
  for (const status of statuses) {
    if (!status?.id || !['sent', 'delivered', 'read', 'failed'].includes(status.status)) continue;
    const millis = Number(status.timestamp) * 1000;
    const at = Number.isFinite(millis) && millis > 0 && millis <= Date.now() + HOUR ? new Date(millis).toISOString() : iso();
    const { error } = await supabase.rpc('record_whatsapp_delivery_receipt', {
      p_message_id: String(status.id), p_status: status.status, p_at: at,
      p_error_code: status.errors?.[0]?.code == null ? null : String(status.errors[0].code),
    });
    if (error) throw error;
  }
}

export async function processReminderSmsFallbacks(sendSms, providerIds = null) {
  let query = supabase.from('appointment_reminder_deliveries').select('*').in('state', ACTIVE);
  if (providerIds) query = query.in('whatsapp_message_id', providerIds);
  const { data, error } = await query.order('updated_at').order('id').limit(100);
  if (error) throw error;
  let sent = 0;
  for (const row of data || []) {
    try {
      if (['preparing', 'sending_sms'].includes(row.state)) {
        if (Date.now() - Date.parse(row.updated_at) > 5 * 60000) {
          const updated = await change(row, { state: row.state === 'sending_sms' ? 'sms_unknown' : 'attention' });
          if (updated) await activity(updated, 'failed', 'Please check this appointment reminder. Delivery was interrupted and has not been confirmed.');
        }
        continue;
      }
      if (await attemptSms(row, sendSms)) sent++;
      else if (row.state === 'awaiting_whatsapp') {
        // Rotate unconfirmed messages through the bounded sweep so they cannot
        // starve newer failed reminders. The original expiry stays unchanged.
        await change(row, {});
      }
    } catch (err) { logger.warn({ deliveryId: row.id, code: err.code }, 'Reminder SMS fallback will be checked again'); }
  }
  if (!providerIds) {
    // Provider ids and message bodies are retained only as long as this retry needs them.
    const before = new Date(Date.now() - 14 * 24 * HOUR).toISOString();
    const old = await supabase.from('appointment_reminder_deliveries').delete().lt('created_at', before);
    if (old.error) throw old.error;
    const receipts = await supabase.from('whatsapp_delivery_receipts').delete().lt('updated_at', before);
    if (receipts.error) throw receipts.error;
  }
  return { sent };
}
