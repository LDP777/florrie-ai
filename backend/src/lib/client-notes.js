/**
 * What lives in appointments.client_notes, and what is allowed to leave Florrie.
 *
 * WHY THIS FILE EXISTS
 * Found while surfacing consultation forms (the client profile and appointment
 * sheet that finally read consultation_responses). Two things turned up.
 *
 * 1. The public booking page has always stored its consultation answers as a
 *    JSON string inside appointments.client_notes:
 *
 *      JSON.stringify({ notes, consultation })
 *
 *    That path never touches consultation_responses, so the answers are
 *    invisible to every consultation surface. A client can say yes to a latex
 *    allergy on the booking page and the appointment sheet shows nothing.
 *
 * 2. client_notes was pasted verbatim into third parties: the Google Calendar
 *    event body took it straight, and so did the unauthenticated iCal feed.
 *    Whatever sat in that column travelled with it, raw JSON of medical
 *    answers included.
 *
 * No account has google_calendar_connected set, so (2) has never actually
 * happened. It was one setting away from happening.
 *
 * THE RULE THIS FILE ENFORCES
 * A free text note from a client is not medical data and stays in client_notes
 * as plain text. Consultation answers belong in consultation_responses, keyed
 * by field id, in exactly the shape POST /public/:token/submit writes, so both
 * routes produce one readable thing. Nothing derived from client_notes is sent
 * to a third party unless it has been proven to be a plain note.
 *
 * Pure on purpose: no database, no request, so the separation can be tested
 * against the real shapes rather than a guess.
 */

/**
 * The questions the booking page asks when a treatment requires a consultation
 * but no form is linked to it.
 *
 * These MIRROR DEFAULT_CONSULTATION_QUESTIONS in frontend/src/pages/BookingPage.jsx.
 * The page posts them keyed by these short keys, not by a field id, because
 * there is no form behind them. Nothing can read a uuid-less answer, so when
 * they arrive the backing form is created from this list and the answers are
 * re-keyed onto its field ids. Keep the labels identical to the page or the
 * re-keying stops matching and the answers stay unreadable.
 */
export const DEFAULT_BOOKING_QUESTIONS = [
  { key: 'allergies', label: 'Do you have any known allergies? (e.g. latex, adhesive, tint)', type: 'text' },
  { key: 'patch_test', label: 'Have you had a patch test in the last 6 months?', type: 'yes_no' },
  { key: 'medical', label: 'Any medical conditions, medications, or recent treatments we should know about?', type: 'text' },
  { key: 'pregnant', label: 'Are you pregnant or breastfeeding?', type: 'yes_no' },
  { key: 'previous_reactions', label: 'Have you had any adverse reactions to beauty treatments before?', type: 'text' },
];

/** The name given to the form created to back the built in questions. */
export const DEFAULT_BOOKING_FORM_NAME = 'Booking page questions';

const DEFAULT_KEYS = new Set(DEFAULT_BOOKING_QUESTIONS.map(q => q.key));

/** A plain note longer than this is trimmed before it is stored. */
const MAX_NOTE_CHARS = 2000;

/** Normalise a label for matching: trimmed, collapsed whitespace, lower case. */
function labelKey(label) {
  return String(label || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Is this value an answer worth keeping?
 *
 * An untouched text box posts an empty string and an untouched multi select
 * posts an empty array. Storing those adds rows of "not answered" to a medical
 * record, which reads as though the question was asked and refused. A ticked
 * or unticked checkbox is a real answer either way, so booleans always count.
 */
function hasValue(raw) {
  if (raw === null || raw === undefined) return false;
  if (typeof raw === 'boolean') return true;
  if (Array.isArray(raw)) return raw.some(v => String(v).trim() !== '');
  return String(raw).trim() !== '';
}

/**
 * Split what the booking page posted into the two things it actually is.
 *
 * The client's free text note and the client's consultation answers arrive in
 * the same request and used to be welded into one JSON string. They are not
 * the same kind of data and they do not belong in the same column, so they are
 * separated here, once, before anything is written.
 *
 * @param {{notes?: string|null, consultation?: object|null}} body
 * @returns {{plainNote: string|null, answers: object|null}} plainNote is safe
 *   for client_notes, answers is null when nothing was actually answered
 */
export function splitBookingSubmission({ notes, consultation } = {}) {
  const text = typeof notes === 'string' ? notes.trim() : '';
  const plainNote = text === '' ? null : text.slice(0, MAX_NOTE_CHARS);

  const blob = (consultation && typeof consultation === 'object' && !Array.isArray(consultation))
    ? consultation
    : {};

  const answers = {};
  for (const [key, value] of Object.entries(blob)) {
    if (!hasValue(value)) continue;
    answers[key] = value;
  }

  return {
    plainNote,
    answers: Object.keys(answers).length > 0 ? answers : null,
  };
}

/**
 * Work out which form each answer came from.
 *
 * A booking can carry two forms at once (brows and lashes booked together ask
 * both), and consultation_responses holds one form per row, so the answers are
 * grouped by the form that owns the field id. A key that belongs to no known
 * field is NOT guessed at: it comes back in `unmatched` so the caller can deal
 * with it, because attaching an answer to the wrong question on a medical form
 * is worse than not showing it at all.
 *
 * @param {object} args
 * @param {Array<{id: string, fields: Array<{id: string, type?: string}>}>} args.forms
 * @param {object} args.answers keyed by field id
 * @returns {{groups: Array<{form_id: string, answers: object, signature: string|null}>, unmatched: object}}
 */
export function groupAnswersByForm({ forms = [], answers = {} } = {}) {
  const blob = (answers && typeof answers === 'object' && !Array.isArray(answers)) ? answers : {};
  const owner = new Map();   // field id -> form id
  const fieldType = new Map(); // field id -> type

  for (const form of (Array.isArray(forms) ? forms : [])) {
    if (!form?.id) continue;
    for (const field of (Array.isArray(form.fields) ? form.fields : [])) {
      if (!field?.id) continue;
      owner.set(String(field.id), String(form.id));
      fieldType.set(String(field.id), field.type || 'text');
    }
  }

  const byForm = new Map();
  const unmatched = {};

  for (const [key, value] of Object.entries(blob)) {
    const formId = owner.get(String(key));
    if (!formId) {
      unmatched[key] = value;
      continue;
    }
    if (!byForm.has(formId)) byForm.set(formId, { form_id: formId, answers: {}, signature: null });
    const group = byForm.get(formId);

    // A signature is not an answer. renderResponse skips signature fields and
    // reports from the signature_data column instead, so a signature left in
    // the answers blob would simply never be shown. On the booking page the
    // client types their full name to sign, so that string is the signature.
    if (fieldType.get(String(key)) === 'signature') {
      const typed = String(value ?? '').trim();
      if (typed !== '') group.signature = typed;
      continue;
    }

    group.answers[key] = value;
  }

  // A group that ends up holding nothing would insert a blank medical record
  // row. Only a form that actually collected something gets one.
  const groups = [...byForm.values()]
    .filter(g => Object.keys(g.answers).length > 0 || g.signature);

  return { groups, unmatched };
}

/**
 * Separate the built in booking questions from keys nothing can explain.
 *
 * @param {object} unmatched keys left over from groupAnswersByForm
 * @returns {{defaults: object, leftover: object}}
 */
export function splitDefaultAnswers(unmatched = {}) {
  const defaults = {};
  const leftover = {};
  for (const [key, value] of Object.entries(unmatched || {})) {
    if (DEFAULT_KEYS.has(key)) defaults[key] = value;
    else leftover[key] = value;
  }
  return { defaults, leftover };
}

/**
 * Re-key the built in questions onto a real form's field ids.
 *
 * Matched on LABEL, never on position. If she edits that form and deletes a
 * question, positions shift and every answer below it would land under the
 * question above: the wrong answer under the wrong question on a medical form.
 * A label that no longer matches simply does not map, and the caller keeps the
 * answer rather than filing it somewhere false.
 *
 * @param {object} args
 * @param {object} args.answers keyed by DEFAULT_BOOKING_QUESTIONS keys
 * @param {Array<{id: string, label: string}>} args.fields the backing form's fields
 * @returns {{answers: object, unmapped: object}} answers keyed by field id
 */
export function mapDefaultAnswersToFields({ answers = {}, fields = [] } = {}) {
  const byLabel = new Map();
  for (const field of (Array.isArray(fields) ? fields : [])) {
    if (!field?.id) continue;
    byLabel.set(labelKey(field.label), String(field.id));
  }

  const mapped = {};
  const unmapped = {};
  for (const [key, value] of Object.entries(answers || {})) {
    const question = DEFAULT_BOOKING_QUESTIONS.find(q => q.key === key);
    const fieldId = question ? byLabel.get(labelKey(question.label)) : undefined;
    if (!fieldId) {
      unmapped[key] = value;
      continue;
    }
    mapped[fieldId] = value;
  }

  return { answers: mapped, unmapped };
}

/**
 * Does this stored client_notes value hold consultation answers?
 *
 * The legacy shape is a JSON object with a `consultation` key. Anything that
 * parses as JSON at all is treated as structured, because a note that a human
 * typed does not parse as an object, and the point of the check is to be sure
 * rather than clever.
 *
 * @param {*} raw the raw client_notes column value
 * @returns {boolean}
 */
export function isStructuredClientNote(raw) {
  if (typeof raw !== 'string') return false;
  const text = raw.trim();
  if (text === '') return false;
  if (text[0] !== '{' && text[0] !== '[') return false;
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object';
  } catch {
    // It opens like structured data but does not parse: a truncated blob, most
    // likely, since the column is capped at 2000 characters. Still not a note.
    return true;
  }
}

/**
 * Read a stored client_notes value back into its two parts.
 *
 * Used by the backfill, which has to cope with rows written before the split
 * existed. A value it cannot parse comes back whole, as the note, so nothing
 * is ever thrown away on the way through.
 *
 * @param {*} raw the raw client_notes column value
 * @returns {{plainNote: string|null, answers: object|null, structured: boolean, parseFailed: boolean}}
 */
export function parseStoredClientNote(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { plainNote: null, answers: null, structured: false, parseFailed: false };
  }
  const text = raw.trim();
  if (text[0] !== '{' && text[0] !== '[') {
    return { plainNote: text, answers: null, structured: false, parseFailed: false };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Unparseable but structured looking. Keep it exactly as it is: it is the
    // only copy of whatever the client wrote, and guessing at it loses data.
    return { plainNote: text, answers: null, structured: true, parseFailed: true };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { plainNote: text, answers: null, structured: true, parseFailed: true };
  }

  const consultation = (parsed.consultation && typeof parsed.consultation === 'object' && !Array.isArray(parsed.consultation))
    ? parsed.consultation
    : null;

  if (!consultation) {
    // JSON, but not the shape the booking page wrote. Not safe to rewrite.
    return { plainNote: text, answers: null, structured: true, parseFailed: true };
  }

  const { plainNote, answers } = splitBookingSubmission({
    notes: typeof parsed.notes === 'string' ? parsed.notes : null,
    consultation,
  });

  return { plainNote, answers, structured: true, parseFailed: false };
}

/**
 * The event body for a diary entry in somebody else's calendar.
 *
 * Deliberately carries no note of any kind. client_notes is free text a client
 * typed on a public page, and the only thing that can be proven about it is
 * that it is not the structured consultation blob. It cannot be proven that it
 * does not say "I am on antibiotics", so it does not go to Google or into a
 * feed anybody with the URL can subscribe to. What a diary entry needs is
 * what it is, how long it takes, and how to get back to the real record.
 *
 * @param {{treatmentName?: string, durationMinutes?: number, appointmentId?: string, appUrl?: string}} args
 * @returns {string}
 */
export function calendarDescription({ treatmentName, durationMinutes, appointmentId, appUrl } = {}) {
  const lines = ['Booked via Florrie'];

  const name = String(treatmentName || '').trim();
  if (name) lines.push(name);

  const mins = Number(durationMinutes);
  if (Number.isFinite(mins) && mins > 0) lines.push(`${Math.round(mins)} minutes`);

  const id = String(appointmentId || '').trim();
  if (id) lines.push(`Ref ${id.slice(0, 8)}`);

  const url = String(appUrl || '').trim();
  lines.push(url
    ? `Notes and consultation answers stay in Florrie: ${url}`
    : 'Notes and consultation answers stay in Florrie.');

  return lines.join('\n');
}
