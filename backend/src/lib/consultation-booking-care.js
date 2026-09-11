import { readBookingPreparation, PREPARATION_APPOINTMENT_SELECT } from './booking-preparation.js';
import { managementLinkActive } from './booking-management-access.js';
import { shapeResponse } from './consultation-answers.js';

export const CARE_RESPONSE_SELECT = 'id, form_id, appointment_id, client_id, beautician_id, status, expires_at, form_snapshot, answers, booking_care';
export const PATCH_OUTCOMES = new Set(['no_reaction', 'reaction', 'not_done', 'unsure']);
export function careError(status, message) { return Object.assign(new Error(message), { status }); }
export async function consultationBookingContext(db, response) {
  if (response.booking_care?.version !== 1) return null;
  const { data: appointment, error } = await db.from('appointments').select(PREPARATION_APPOINTMENT_SELECT)
    .eq('id', response.appointment_id).eq('beautician_id', response.beautician_id).eq('client_id', response.client_id).maybeSingle();
  if (error) throw careError(503, 'We could not check your booking. Your answers have been kept. Please try again.');
  if (!appointment || !managementLinkActive(appointment) || !['confirmed', 'in_progress', 'completed'].includes(appointment.status)) {
    throw careError(410, 'This booking is no longer active. Please use your latest booking link or contact your tech.');
  }
  const prep = await readBookingPreparation(db, appointment);
  if (!prep.forms.some(f => f.id === response.form_id)) throw careError(409, 'Your treatment has changed. Open Manage my booking for the consultation you need.');
  return prep;
}
export function assertCareSubmission(response, prep, body) {
  if (!prep) return;
  if (body.revision !== (response.booking_care?.revision || 0)) throw careError(409, 'This form was updated elsewhere. Your answers are still here; reopen the form to check the latest saved version.');
  if (prep.patch.required) {
    if (!prep.patch.can_complete) throw careError(409, 'Your patch-test record and 48-hour waiting period must be complete before you sign. You can save your answers meanwhile.');
    if (!PATCH_OUTCOMES.has(body.patch_outcome)) throw careError(400, 'Please tell us the outcome of your patch test.');
  }
  if (!body.signature_data) throw careError(400, 'Please sign your consultation before submitting.');
}
export function updatedCare(response, { answers, patch_outcome }, prep, { completed = false } = {}) {
  const previous = response.booking_care || {};
  const outcome = prep.patch.required ? patch_outcome || previous.patch_outcome || null : null;
  const flagged = (outcome && outcome !== 'no_reaction') || shapeResponse({ ...response, booking_care: null, answers }).worth_knowing.length > 0;
  return { ...previous, version: 1, revision: (previous.revision || 0) + 1, saved_at: new Date().toISOString(),
    patch_outcome: outcome, review_required: Boolean(previous.review_required || flagged),
    // A changed answer needs another look, even if the earlier draft was reviewed.
    ...(flagged ? { reviewed_at: null } : {}),
    ...(completed ? { patch_evidence: prep.patch, signed_at: new Date().toISOString() } : {}),
  };
}
export function careCompareAndSet(query, response) {
  return response.booking_care == null ? query.is('booking_care', null)
    : query.eq('booking_care->>revision', String(response.booking_care.revision || 0));
}
