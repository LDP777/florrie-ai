import { createHash, randomUUID } from 'node:crypto';
import { PATCH_TEST_LEAD_HOURS } from './patch-test-policy.js';
import { patchTestWindowStart } from './patch-test-status.js';
import { managementLinkActive } from './booking-management-access.js';
import { shapeResponse } from './consultation-answers.js';

const HOUR = 3600000;
const ACTIVE = new Set(['confirmed', 'in_progress', 'completed']);
export const PREPARATION_APPOINTMENT_SELECT = 'id, beautician_id, client_id, status, starts_at, ends_at, treatment_id, extra_treatment_ids, management_token, beauticians(id, booking_slug, first_name, business_name, timezone, patch_test_expiry_months)';

export function preparationResponseId(appointmentId, formId) {
  const h = createHash('sha256').update(`booking-care-v1:${appointmentId}:${formId}`).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}

// Appointments use salon wall time in a UTC-shaped string. Patch application
// timestamps are real instants, so the observation period also works over DST.
export function salonWallInstant(value, timezone = 'Europe/London') {
  const wall = Date.parse(`${String(value || '').slice(0,19)}Z`);
  if (!Number.isFinite(wall)) return null;
  const format = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  let instant = wall;
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(format.formatToParts(new Date(instant)).map(x => [x.type,x.value]));
    const shown = Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);
    const delta = wall - shown;
    if (!delta) return new Date(instant).toISOString();
    instant += delta;
  }
  return null;
}

export function patchPreparation({ appointment, treatments, patches, visits = [], now = Date.now() }) {
  const required = treatments.filter(t => t.requires_patch_test);
  if (!required.length) return { state: 'not_required', required: false, can_complete: true };
  const tz = appointment.beauticians?.timezone || 'Europe/London';
  const expiry = patchTestWindowStart(String(appointment.starts_at).slice(0,10), appointment.beauticians?.patch_test_expiry_months || 6);
  const evidence = [];
  let missing = false;
  for (const treatment of required) {
    const relevant = patches.filter(p => p.treatment_id === treatment.id || p.covered_treatment_ids?.includes(treatment.id));
    const rows = relevant.map(p => {
      const visit = visits.find(v => v.id === p.appointment_id && v.id !== appointment.id && (!v.treatment_id || p.parent_appointment_id));
      const attended = p.performed_at || p.status === 'recorded_by_owner' || visit?.status === 'completed' || ['pass','fail','reaction'].includes(p.result);
      const day = p.test_date || String(p.performed_at || visit?.ends_at || '').slice(0,10);
      const applied = attended ? p.performed_at || (visit?.status === 'completed' ? salonWallInstant(visit.ends_at, tz) : null)
        || (day ? salonWallInstant(`${day}T23:59:59`, tz) : null) : null;
      const booked = !attended && visit && ['confirmed','pending','in_progress'].includes(visit.status);
      return { id: p.id, treatment_id: treatment.id, result: p.result, applied_at: applied,
        booked_at: booked ? visit.starts_at : null, booked_end: booked ? visit.ends_at : null, day, date_only: attended && !p.performed_at && visit?.status !== 'completed' };
    }).filter(p => (p.applied_at && (p.day >= expiry || ['fail','reaction'].includes(p.result))) || p.booked_at)
      .sort((a,b) => String(b.day).localeCompare(String(a.day))
        || Number(a.date_only) - Number(b.date_only)
        || String(b.applied_at || b.booked_at).localeCompare(String(a.applied_at || a.booked_at)));
    if (!rows.length) missing = true;
    else evidence.push(rows[0].booked_at ? rows.find(p => ['fail', 'reaction'].includes(p.result)) || rows[0] : rows[0]);
  }
  if (evidence.some(p => ['fail','reaction'].includes(p.result))) return { state: 'review', required: true, can_complete: false, evidence };
  const hasHistoricEvidence = patches.some(p => p.performed_at || p.test_date || p.status === 'recorded_by_owner' || ['pass', 'fail', 'reaction'].includes(p.result) || (p.appointment_id && p.appointment_id !== appointment.id));
  if (missing) return { state: hasHistoricEvidence || appointment.returning_client ? 'check_record' : 'needed', required: true, can_complete: false, evidence };
  const treatmentAt = Date.parse(salonWallInstant(appointment.starts_at, tz));
  if (evidence.some(p => p.booked_end && Date.parse(salonWallInstant(p.booked_end, tz)) + PATCH_TEST_LEAD_HOURS * HOUR > treatmentAt)) return { state: 'timing_review', required: true, can_complete: false, evidence };
  if (evidence.some(p => p.booked_at)) return { state: 'booked', required: true, can_complete: false, evidence, booked_at: evidence.find(p => p.booked_at)?.booked_at };
  const readyAt = new Date(Math.max(...evidence.map(p => Date.parse(p.applied_at))) + PATCH_TEST_LEAD_HOURS * HOUR).toISOString();
  if (Date.parse(readyAt) > treatmentAt) return { state: 'timing_review', required: true, can_complete: false, ready_at: readyAt, evidence };
  return { state: Date.parse(readyAt) > now ? 'waiting' : 'ready', required: true,
    can_complete: Date.parse(readyAt) <= now, ready_at: readyAt, evidence };
}

function checked(result, label) {
  if (result.error) throw new Error(`Could not read ${label}`);
  return result.data || [];
}

export async function readBookingPreparation(db, appointment, { now = Date.now() } = {}) {
  if (!appointment?.id || !appointment.beautician_id || !appointment.client_id) throw new Error('Booking details unavailable');
  const ids = [...new Set([appointment.treatment_id, ...(appointment.extra_treatment_ids || [])].filter(Boolean))];
  if (!ids.length) return { confirmed: ACTIVE.has(appointment.status), patch: { state: 'not_required', required: false, can_complete: true }, forms: [], required: false };
  const [tr, fr, rr, pr, cr, hr] = await Promise.all([
    db.from('treatments').select('id, name, requires_patch_test, requires_consultation, consultation_form_id').eq('beautician_id', appointment.beautician_id).in('id', ids),
    db.from('consultation_forms').select('id, name, is_default, consent_text, consultation_form_fields(*)').eq('beautician_id', appointment.beautician_id).eq('is_active', true),
    db.from('consultation_responses').select('id, form_id, status, completed_at, expires_at, token, answers, signature_data, form_snapshot, booking_care').eq('beautician_id', appointment.beautician_id).eq('client_id', appointment.client_id).eq('appointment_id', appointment.id),
    db.from('patch_tests').select('id, treatment_id, covered_treatment_ids, parent_appointment_id, appointment_id, status, result, test_date, performed_at').eq('beautician_id', appointment.beautician_id).eq('client_id', appointment.client_id).order('test_date', { ascending: false, nullsFirst: true }).limit(100),
    db.from('clients').select('id, total_visits, last_visit_at').eq('beautician_id', appointment.beautician_id).eq('id', appointment.client_id).maybeSingle(),
    db.from('appointments').select('id').eq('beautician_id', appointment.beautician_id).eq('client_id', appointment.client_id).eq('status', 'completed').neq('id', appointment.id).limit(1),
  ]);
  const treatments = checked(tr, 'treatments');
  if (treatments.length !== ids.length) throw new Error('Some booked treatments could not be checked');
  const templates = checked(fr, 'consultation templates');
  const responses = checked(rr, 'consultation records');
  const patches = checked(pr, 'patch tests');
  const visitIds = [...new Set(patches.map(p => p.appointment_id).filter(Boolean))];
  const visits = visitIds.length ? checked(await db.from('appointments').select('id, starts_at, ends_at, status, treatment_id')
    .eq('beautician_id', appointment.beautician_id).eq('client_id', appointment.client_id).in('id', visitIds), 'patch-test visits') : [];
  const client = checked(cr, 'client history');
  if (!client?.id) throw new Error('Client history unavailable');
  const history = checked(hr, 'appointment history');
  const patch = patchPreparation({ appointment: { ...appointment, returning_client: client.total_visits > 0 || !!client.last_visit_at || history.length > 0 }, treatments, patches, visits, now });
  patch.timezone = appointment.beauticians?.timezone || 'Europe/London';
  const defaultForm = templates.find(f => f.is_default);
  const formIds = [...new Set(treatments.map(t => t.consultation_form_id || ((t.requires_consultation || t.requires_patch_test) ? defaultForm?.id : null)).filter(Boolean))];
  if (!formIds.length) formIds.push(...responses.filter(r => r.booking_care?.draft_from_booking).map(r => r.form_id));
  const forms = [...new Set(formIds)].map(id => {
    const template = templates.find(f => f.id === id);
    const candidates = responses.filter(r => r.form_id === id);
    const response = candidates.find(r => r.status === 'completed') || candidates.find(r => r.id === preparationResponseId(appointment.id,id)) || candidates[0];
    const flagged = response?.booking_care?.review_required || (response?.status === 'completed' && shapeResponse(response).worth_knowing.length > 0);
    return { id, name: response?.form_snapshot?.name || template?.name || 'Consultation form',
      status: response?.status === 'completed' ? 'received' : 'pending', completed_at: response?.completed_at || null,
      review_required: !!flagged && !response?.booking_care?.reviewed_at, available: !!template || !!response?.form_snapshot,
      response, template };
  });
  const missingTemplate = treatments.some(t => (t.requires_consultation || t.requires_patch_test) && !t.consultation_form_id && !defaultForm);
  return { confirmed: ACTIVE.has(appointment.status), required: forms.length > 0 || patch.required || missingTemplate,
    patch, forms, missing_template: missingTemplate, appointment };
}

export function publicPreparation(prep) {
  return { confirmed: prep.confirmed, required: prep.required, patch: prep.patch,
    missing_template: !!prep.missing_template,
    forms: prep.forms.map(({ id, name, status, completed_at, review_required, available }) => ({ id, name, status, completed_at, review_required, available })) };
}

export async function ensureBookingConsultations(db, appointment) {
  const prep = await readBookingPreparation(db, appointment);
  if (!prep.confirmed || !managementLinkActive(appointment)) return prep;
  for (const form of prep.forms) {
    if (form.response || !form.available) continue;
    const expires = Date.parse(salonWallInstant(appointment.ends_at || appointment.starts_at, appointment.beauticians?.timezone));
    const inserted = await db.from('consultation_responses').insert({ id: preparationResponseId(appointment.id,form.id),
      form_id: form.id, beautician_id: appointment.beautician_id, client_id: appointment.client_id, appointment_id: appointment.id,
      token: randomUUID(), status: 'pending', expires_at: new Date(expires + 7*24*HOUR).toISOString(), booking_care: { version: 1, revision: 0 } });
    if (inserted.error && inserted.error.code !== '23505') throw new Error('Could not prepare the consultation');
  }
  return prep;
}
