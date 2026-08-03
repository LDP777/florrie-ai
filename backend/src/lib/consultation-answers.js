/**
 * Reading a submitted consultation form.
 *
 * WHY THIS FILE EXISTS
 * Clients have been filling in consultation forms since April. The answers
 * land in consultation_responses.answers as a jsonb blob keyed by FIELD ID:
 *
 *   { "8f1c...": "Yes", "b20a...": ["Nuts", "Latex"], "77de...": true }
 *
 * Nothing in the app has ever displayed one. The only consultation screen is
 * the form BUILDER, which edits blank templates. So the allergy and medical
 * answers she has been collecting have been unreadable, which is exactly what
 * she asked about: "where do I find a client's consultation form?".
 *
 * A uuid-keyed blob is not readable on its own. The questions live in a
 * different table (consultation_form_fields), so pairing the two back up is
 * the whole job, and it is pure: no database, no request, so it can be tested
 * against the real shapes rather than a guess.
 *
 * THE REAL SHAPES (from ConsultationFormPublic.jsx, which writes them)
 *   text          -> string, free text
 *   yes_no        -> the string 'Yes' or 'No', never a boolean
 *   checkbox      -> boolean true/false (a single "I confirm" tick)
 *   single_select -> string, one of field.options
 *   multi_select  -> array of strings, possibly empty
 *   text_block    -> NO entry in answers at all, it is a static paragraph
 *   signature     -> NOT in answers either: it is its own column,
 *                    consultation_responses.signature_data (a data URL png)
 *
 * There is no "long text" type in the schema, so a long answer is just a text
 * field with a lot in it. The renderer marks those so the UI can give them
 * room instead of squashing them onto one line.
 */

/** Answers longer than this get room to breathe in the UI. */
const LONG_ANSWER_CHARS = 80;

/** How much of an answer goes into the one line summary. */
const NOTE_ANSWER_CHARS = 120;

/**
 * Questions whose wording means the answer carries clinical weight.
 *
 * This list decides what gets flagged. It deliberately matches the QUESTION,
 * never the answer's meaning: Florrie is not making a medical judgement about
 * whether an ingredient is dangerous. It only notices that she asked about
 * allergies and the client said something other than "no", and puts that in
 * front of her. The judgement stays with the human holding the tint brush.
 */
const RISK_PATTERNS = [
  /allerg/i,
  /reaction/i,
  /sensitiv/i,
  /irritat/i,
  /medicat|medicine|prescri|tablets/i,
  /medical/i,
  /diagnos/i,
  /contraindicat/i,
  /pregnan/i,
  /breast\s*feed|breastfeeding|nursing/i,
  /diabet/i,
  /epilep|seizure/i,
  /asthma/i,
  /eczema|psoriasis|dermatitis|rosacea/i,
  /keloid|scarring/i,
  /blood\s*thin|anticoagulant|warfarin/i,
  /chemo|radiotherapy|cancer/i,
  /thyroid|autoimmune|lupus/i,
  /cold\s*sore|herpes|shingles/i,
  /botox|filler|retinol|accutane|roaccutane|isotretinoin|peel/i,
  /patch\s*test/i,
  /skin\s*(concern|condition|issue|problem)/i,
  /eye\s*(condition|infection|problem)/i,
  /surgery|operation/i,
  /infection/i,
  /implant|pacemaker/i,
  /health/i,
  /condition/i,
];

/**
 * Wordings that look like a risk question but are not one. Checked first.
 *
 * "Do you agree to the terms and conditions" matched /condition/ and turned a
 * routine consent tick into a medical flag, which is worse than useless: a
 * flag that fires on everything is a flag she learns to ignore.
 */
const NOT_RISK_PATTERNS = [
  /terms\s*(and|&)\s*conditions/i,
  /cancellation\s*policy/i,
  /how\s*did\s*you\s*(hear|find)/i,
  /marketing|newsletter|mailing\s*list/i,
];

/**
 * Wordings that mean "this field is the detail for the question above it".
 *
 * Real forms almost always split the important question in two:
 *
 *   "Do you have any allergies?"   -> Yes
 *   "If yes, please list them"     -> Nut oils
 *
 * On its own the second label carries no clinical wording at all, so flagging
 * by question text would surface the "Yes" and hide the thing she actually
 * needs to read. A follow-up inherits the risk of the question it follows.
 * This is structural, not clinical: it says the two fields belong together,
 * it does not decide what the answer means.
 */
const FOLLOW_UP_PATTERNS = [
  /^\s*if\s+(yes|so|applicable|any)\b/i,
  /^\s*(please\s+)?(list|specify|describe|give\s+details|provide\s+details)/i,
  /^\s*details\b/i,
];

/**
 * Answers that mean "nothing to report". A "no" to an allergy question is the
 * answer she wants, so flagging it would bury the real ones.
 */
const NEGATIVE_ANSWERS = new Set([
  'no', 'none', 'nope', 'nil', 'na', 'n/a', 'nothing', 'not really',
  'none of the above', 'none that i know of', 'none known', 'no allergies',
  'no known allergies', 'no medication', 'no medications', 'not applicable',
  'false', '-', '.',
]);

/**
 * Does this question's wording mean a non-negative answer is worth knowing?
 * @param {string} label question text
 * @returns {boolean}
 */
export function isRiskQuestion(label) {
  const text = String(label || '').trim();
  if (!text) return false;
  if (NOT_RISK_PATTERNS.some(re => re.test(text))) return false;
  return RISK_PATTERNS.some(re => re.test(text));
}

/**
 * Is this field the detail box for the question above it?
 * @param {string} label question text
 * @returns {boolean}
 */
export function isFollowUpQuestion(label) {
  const text = String(label || '').trim();
  if (!text) return false;
  return FOLLOW_UP_PATTERNS.some(re => re.test(text));
}

/**
 * Is this answer a plain "nothing to report"?
 * @param {string} value
 * @returns {boolean}
 */
export function isNegativeAnswer(value) {
  const text = String(value ?? '')
    .trim()
    .replace(/[.!]+$/, '')
    .toLowerCase();
  if (!text) return true;
  return NEGATIVE_ANSWERS.has(text);
}

/**
 * Turn one stored value into the sentence she reads.
 *
 * Returns null when the question was never answered, which is different from
 * an empty answer: an optional question left blank should read as "not
 * answered", not as a silent blank line she cannot interpret.
 *
 * @param {{type: string}} field
 * @param {*} raw value straight out of the answers blob
 * @returns {string|null}
 */
export function formatAnswer(field, raw) {
  const type = field?.type;

  if (type === 'checkbox') {
    // A checkbox is stored as a boolean, and false is a real answer (she
    // did not tick it), so it must not collapse into "not answered".
    if (raw === true) return 'Ticked';
    if (raw === false) return 'Not ticked';
    return null;
  }

  if (Array.isArray(raw)) {
    const picked = raw.map(v => String(v).trim()).filter(Boolean);
    return picked.length > 0 ? picked.join(', ') : null;
  }

  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'boolean') return raw ? 'Yes' : 'No';

  const text = String(raw).trim();
  return text === '' ? null : text;
}

/**
 * The one line she reads at a glance, in her own words about her own client.
 *
 * Neutral on purpose. It reports what the client typed and nothing else: no
 * "risk of reaction", no "do not proceed". Florrie has no business implying a
 * clinical conclusion from a form field.
 *
 * @param {{type: string, question: string, answer: string}} pair
 * @returns {string}
 */
export function worthKnowingNote({ type, question, answer }) {
  const label = String(question || '').trim();
  if (type === 'yes_no') return `She answered yes to: ${label}`;
  if (type === 'checkbox') return `She ticked: ${label}`;
  const short = String(answer || '').length > NOTE_ANSWER_CHARS
    ? `${String(answer).slice(0, NOTE_ANSWER_CHARS).trimEnd()}...`
    : String(answer || '');
  return `She answered "${short}" to: ${label}`;
}

/**
 * Should this question and answer carry the "Worth knowing" chip?
 *
 * Two conditions, both required: the QUESTION is one of the ones that carries
 * clinical weight, and the ANSWER is not a plain no. Everything else stays
 * unflagged.
 *
 * @param {{type: string, question: string, answer: string|null}} pair
 * @param {{inheritsRisk?: boolean}} [opts] set when this field is the detail
 *   box belonging to a question that was itself flagged
 * @returns {boolean}
 */
export function isWorthKnowing({ type, question, answer }, { inheritsRisk = false } = {}) {
  if (answer === null || answer === undefined) return false;
  if (type === 'text_block' || type === 'signature') return false;
  if (!inheritsRisk && !isRiskQuestion(question)) return false;

  if (type === 'yes_no') return /^yes$/i.test(String(answer).trim());
  if (type === 'checkbox') return answer === 'Ticked';

  // text, single_select, multi_select: anything that is not a plain no.
  // A multi_select is already joined with commas, so "None, Latex" still
  // reads as something to know about, which is the right way round.
  return !isNegativeAnswer(answer);
}

/**
 * Pair a submission's answers back up with the questions that produced them.
 *
 * @param {object} args
 * @param {Array<{id: string, type: string, label: string, options?: any, sort_order?: number}>} args.fields
 *   the form's field definitions
 * @param {object} args.answers the stored answers blob, keyed by field id
 * @param {boolean} [args.hasSignature] whether signature_data is set
 * @returns {{pairs: Array<object>, worth_knowing: string[], answered_count: number}}
 */
export function renderResponse({ fields, answers, hasSignature = false } = {}) {
  const blob = (answers && typeof answers === 'object' && !Array.isArray(answers)) ? answers : {};
  const defs = Array.isArray(fields) ? [...fields] : [];

  // The builder stores display order in sort_order. Reading a consent form
  // out of order changes what it says, so the order is restored here rather
  // than left to whatever PostgREST happened to return.
  defs.sort((a, b) => (a?.sort_order ?? 0) - (b?.sort_order ?? 0));

  const pairs = [];
  const worthKnowing = [];
  let answeredCount = 0;
  // Whether the question immediately above this one was flagged, so its
  // "if yes, please list them" box gets read as part of the same answer.
  let previousWasFlagged = false;

  for (const field of defs) {
    if (!field) continue;

    // A text block is a paragraph the client reads, not a question they
    // answer, so it never appears in the answers blob. Rendering it as a
    // question with no answer would read as a gap in the form.
    if (field.type === 'text_block') continue;

    // The signature is not in the answers blob at all: it has its own
    // column. It is reported once, at the end, from hasSignature.
    if (field.type === 'signature') continue;

    const answer = formatAnswer(field, blob[field.id]);
    const question = String(field.label || '').trim();
    const pair = {
      field_id: field.id,
      type: field.type,
      question,
      answer,
      answered: answer !== null,
      long: (answer || '').length > LONG_ANSWER_CHARS,
      worth_knowing: false,
      note: null,
    };

    if (answer !== null) answeredCount += 1;

    const inheritsRisk = previousWasFlagged && isFollowUpQuestion(question);
    if (isWorthKnowing(pair, { inheritsRisk })) {
      pair.worth_knowing = true;
      pair.note = worthKnowingNote(pair);
      worthKnowing.push(pair.note);
    }

    // A follow-up keeps the chain alive so a question split across three
    // boxes does not lose the thread halfway down.
    previousWasFlagged = pair.worth_knowing;

    pairs.push(pair);
  }

  if (hasSignature) {
    pairs.push({
      field_id: 'signature',
      type: 'signature',
      question: 'Signature',
      answer: 'Signed by the client',
      answered: true,
      long: false,
      worth_knowing: false,
      note: null,
    });
  }

  return { pairs, worth_knowing: worthKnowing, answered_count: answeredCount };
}

/**
 * Everything one submission needs to render, ready for the wire.
 *
 * Deliberately does NOT pass signature_data through. It is a base64 png of a
 * real person's signature and it is not needed to display the answers, so it
 * stays out of list payloads. The single response endpoint serves it on
 * demand when she actually opens the signature.
 *
 * @param {object} row a consultation_responses row with consultation_forms joined
 * @returns {object}
 */
export function shapeResponse(row) {
  const form = row?.consultation_forms || null;
  const hasSignature = Boolean(row?.signature_data);
  const { pairs, worth_knowing, answered_count } = renderResponse({
    fields: form?.consultation_form_fields || [],
    answers: row?.answers,
    hasSignature,
  });

  return {
    id: row?.id,
    form_id: row?.form_id,
    form_name: form?.name || 'Consultation form',
    client_id: row?.client_id || null,
    appointment_id: row?.appointment_id || null,
    completed_at: row?.completed_at || row?.created_at || null,
    // What they actually signed up to. Kept with the answers because a
    // consent paragraph read separately from the answers is not evidence of
    // anything.
    consent_text: form?.consent_text || null,
    has_signature: hasSignature,
    answered_count,
    pairs,
    worth_knowing,
  };
}
