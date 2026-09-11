import { createHash, randomUUID } from 'node:crypto';
import { salonWallInstant, readBookingPreparation } from '../lib/booking-preparation.js';

export function nextPreparationReminder(prep, appointment, { now = Date.now(), patchReminders = false } = {}) {
  if (!prep.confirmed || appointment.status !== 'confirmed') return null;
  const link = `${process.env.FRONTEND_URL || 'https://florrie.ai'}/book/${appointment.beauticians.booking_slug}/manage/${appointment.management_token}`;
  if (!appointment.management_token || !appointment.beauticians.booking_slug) return null;
  if (prep.patch.state === 'needed' && patchReminders && Date.parse(salonWallInstant(appointment.starts_at, appointment.beauticians?.timezone)) - now <= 48 * 3600000) return { stage: 'patch', messageType: 'patch_test', body: `Your appointment is within 48 hours and a patch test is still needed. Please contact your tech to arrange what happens next. Your booking details: ${link}` };
  if (prep.patch.state === 'needed' && patchReminders) return { stage: 'patch', messageType: 'patch_test',
    body: `Your booking is confirmed. Please book your patch test at least 48 hours before treatment. Available times and your preparation checklist: ${link}` };
  if (prep.patch.can_complete && prep.forms.some(f => f.status !== 'received' && f.available)) return { stage: 'consultation', messageType: 'consultation_form',
    body: `${prep.patch.required ? 'Your patch-test waiting period has finished. ' : ''}Please complete and sign your consultation before your appointment. You can do it in Manage my booking: ${link}` };
  return null;
}
function reminderId(appointmentId, stage) {
  const h = createHash('sha256').update(`booking-preparation:${appointmentId}:${stage}`).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
/** Only staged bookings enter here. Existing reminder preferences and outbound
 * checks remain in the caller; no form creation or client answers depend on delivery. */
export async function sendBookingPreparationReminder({ db, appointment, patchReminders, deliver }) {
  const prep = await readBookingPreparation(db, appointment);
  const reminder = nextPreparationReminder(prep, appointment, { patchReminders });
  if (!reminder) return false;
  const id = reminderId(appointment.id, reminder.stage);
  const { data: old, error } = await db.from('ai_actions').select('id, outcome, details').eq('id', id).maybeSingle();
  if (error) throw new Error('Could not read preparation reminder history');
  if (old?.outcome === 'success' || (old?.outcome === 'pending' && Date.parse(old.details?.lease_until) > Date.now())) return false;
  const attempt = randomUUID();
  const details = { stage: reminder.stage, attempt_id: attempt, lease_until: new Date(Date.now() + 120000).toISOString() };
  const claim = old ? db.from('ai_actions').update({ outcome: 'pending', details }).eq('id', id).eq('details->>attempt_id', old.details?.attempt_id)
    : db.from('ai_actions').insert({ id, beautician_id: appointment.beautician_id, client_id: appointment.client_id,
      appointment_id: appointment.id, action_type: 'prearrival_reminder', digital_employee: 'front_desk',
      outcome: 'pending', summary: 'Booking preparation reminder', details, confidence: 1 });
  const claimed = await claim.select('id').maybeSingle();
  if (claimed.error || !claimed.data) return false;
  let delivered = false;
  try {
    // Re-read after taking the lease: a cancellation, new patch record or form
    // submission since the scan must not trigger the old next step.
    const { data: latest, error: readError } = await db.from('appointments').select('status, starts_at, ends_at, treatment_id, extra_treatment_ids')
      .eq('id', appointment.id).eq('beautician_id', appointment.beautician_id).maybeSingle();
    if (readError || !latest) throw new Error('Could not recheck the booking');
    const current = { ...appointment, ...latest };
    const next = nextPreparationReminder(await readBookingPreparation(db, current), current, { patchReminders });
    if (next?.stage === reminder.stage) delivered = !!await deliver(next);
  } finally {
    const saved = await db.from('ai_actions').update({ outcome: delivered ? 'success' : 'failed', notification_sent: delivered,
      summary: delivered ? `Sent ${reminder.stage === 'patch' ? 'patch-test booking' : 'consultation'} reminder` : 'Preparation reminder not delivered', details })
      .eq('id', id).eq('details->>attempt_id', attempt);
    if (saved.error) throw new Error('Could not record preparation reminder delivery');
  }
  return delivered;
}
