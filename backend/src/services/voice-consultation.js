/**
 * Asking about consultation forms and patch tests by voice.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS SEPARATE
 * Ellie uses Voice Commander with a client in the chair. That is the whole
 * point of it: her hands are busy. It is also why consultation answers cannot
 * be handled like every other tool here.
 *
 * THE RULE: STATUS IS SPOKEN, ANSWERS ARE NOT.
 * The orchestrator feeds `result` back to the model and that string becomes
 * what Florrie says out loud. `data` goes straight to the app and is never
 * shown to the model at all. So every function below puts the STATUS in
 * `result` and the ANSWERS in `data`.
 *
 * This is deliberately a shape, not an instruction. A system prompt saying
 * "never read the answers aloud" is a request to a model. Never putting the
 * answers in the string the model can see is a fact about the code. If the
 * prompt is ignored, edited, or the model is swapped, the answers still
 * cannot be spoken, because they were never in the room.
 *
 * "Megan is allergic to latex and is on antibiotics" coming out of a phone
 * speaker in a home studio with the next client waiting is the same
 * disclosure the calendar and iCal leaks were, through the one channel that
 * has no access control at all.
 *
 * WHAT CANNOT BE ANSWERED, AND IS THEREFORE NOT OFFERED
 * There is no pass or fail on a consultation form. It is not a test. The only
 * judgement the app makes is structural: she asked a question with clinical
 * weight and the client answered something other than no, so it gets put in
 * front of her. The judgement stays with the human holding the tint brush.
 *
 * Patch tests do have a `result` column with 'pass' and 'fail' in its CHECK
 * constraint. It says 'pending' on all 22 rows in production, and so does
 * `status`. Worse, `confirmed_at` does NOT mean the test happened: it is
 * written when the client books the SLOT. So "did she pass her patch test" is
 * answered with the only three things the data knows, which are whether one is
 * on record, whether a slot is booked, and whether she came in for it. Never
 * with a pass. See lib/patch-test-status.js.
 */

import { shapeResponse } from '../lib/consultation-answers.js';
import { clientsOwingPatchTest, patchTestPicture } from '../lib/patch-test-status.js';

/** Everything shapeResponse needs, and nothing it does not. */
const RESPONSE_SELECT =
  'id, form_id, client_id, appointment_id, status, completed_at, created_at, answers, signature_data, form_snapshot, ' +
  'consultation_forms(name, consent_text, consultation_form_fields(id, type, label, options, sort_order))';

// in_progress is the client actually in the chair, which is precisely who she
// is asking about when she asks. The diary uses these three everywhere else.
const BOOKED = ['confirmed', 'pending', 'in_progress'];

/**
 * "14 July" for a WALL TIME column. appointments.starts_at stores the salon
 * clock inside a UTC slot, so it is read in the UTC frame and never converted.
 */
function wallDay(iso, opts = { day: 'numeric', month: 'long' }) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' });
}

/**
 * "14 July" for a REAL INSTANT. consultation_responses.completed_at is a
 * genuine timestamp (new Date().toISOString() at submit), so forcing UTC on it
 * shows a form submitted at 00.30 on the 15th as the 14th, and would disagree
 * with the client profile, which renders the same field in local time.
 */
function instantDay(iso, opts = { day: 'numeric', month: 'long' }) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString('en-GB', { ...opts, timeZone: 'Europe/London' });
}

/** "Fri 8 Aug at 10.00", in the salon's own wall clock. */
function whenOf(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).replace(':', '.');
  return `${day} at ${time}`;
}

function fullName(c) {
  return [c?.first_name, c?.last_name].filter(Boolean).join(' ').trim() || 'This client';
}

/** A spoken list of names reads better than a bulleted one. */
function andList(items) {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Default window when she does not name one: today plus the next 7 days. */
function resolveRange(start_date, end_date) {
  const today = new Date().toISOString().slice(0, 10);
  const start = start_date || today;
  const end = end_date || new Date(Date.parse(`${start}T12:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
  return { start, end };
}

function rangeWords(start, end) {
  const today = new Date().toISOString().slice(0, 10);
  if (start === end) return start === today ? 'today' : `on ${wallDay(`${start}T12:00:00Z`)}`;
  return `between ${wallDay(`${start}T12:00:00Z`)} and ${wallDay(`${end}T12:00:00Z`)}`;
}

/**
 * Has this client filled in a consultation form, when, and is anything on it
 * worth knowing?
 *
 * Looked up by CLIENT, never by appointment: a regular fills one in once at
 * their first booking and it is still the form on file two years later.
 */
export async function consultationStatusForClient({ supabase, beauticianId, client }) {
  const { data: rows, error, count } = await supabase
    .from('consultation_responses')
    .select(RESPONSE_SELECT, { count: 'exact' })
    .eq('beautician_id', beauticianId)
    .eq('client_id', client.id)
    .eq('status', 'completed')
    .order('completed_at', { ascending: false })
    .limit(1);

  // Read the error. An unchecked one here says "nothing on file" for a client
  // who has a form with an allergy on it, which is the worst answer this tool
  // could give.
  if (error) {
    return {
      result: `I could not read ${client.first_name}'s consultation forms just now. Have a look on her profile rather than take my word for it.`,
      data: { failed: true },
    };
  }

  if ((rows || []).length === 0) {
    return {
      result: `Nothing on file for ${fullName(client)}. Ask me to send her one if you want it before she comes in.`,
      data: { client, consultation: null, count: 0 },
    };
  }

  // Only the latest is shaped. The older ones were being shipped to the app
  // and rendered by nothing: five submissions of somebody's medical history
  // travelling for no reason.
  const latest = shapeResponse(rows[0]);
  const flagged = (latest.worth_knowing || []).length;
  const when = instantDay(latest.completed_at);
  // A real count, not the page size. `.limit(5)` then "she has 5 on file" is a
  // spoken number that is wrong for anyone with six.
  const onFile = typeof count === 'number' ? count : rows.length;
  const older = onFile > 1 ? ` She has ${onFile} on file.` : '';

  // The COUNT of flagged answers is spoken. The notes themselves are not:
  // "she answered yes to any allergies" is still her medical record read out
  // in a room Florrie cannot see.
  const headline = flagged === 0
    ? `${fullName(client)} filled in her ${latest.form_name.toLowerCase()} on ${when}. Nothing flagged.`
    : `${fullName(client)} filled in her ${latest.form_name.toLowerCase()} on ${when}. ${flagged} thing${flagged === 1 ? '' : 's'} worth knowing, on screen below.`;

  return {
    result: `${headline}${older}`,
    data: { client, consultation: latest, count: onFile },
  };
}

/**
 * Who is booked in this window whose treatment needs a consultation form and
 * has nothing on file?
 *
 * Extras count. A brow tint added on the day can be the treatment that needs
 * the consultation, and it lives in extra_treatment_ids.
 */
export async function consultationsOutstanding({ supabase, beauticianId, start_date, end_date }) {
  const { start, end } = resolveRange(start_date, end_date);
  const words = rangeWords(start, end);

  const { data: appts, error } = await supabase
    .from('appointments')
    .select('id, starts_at, client_id, treatment_id, extra_treatment_ids, clients(id, first_name, last_name)')
    .eq('beautician_id', beauticianId)
    .gte('starts_at', `${start}T00:00:00`)
    .lte('starts_at', `${end}T23:59:59`)
    .in('status', BOOKED)
    .order('starts_at', { ascending: true });

  if (error) {
    return { result: `I could not read the diary just now, so I cannot tell you who still needs a form. Try again in a moment.`, data: { failed: true } };
  }
  if (!(appts || []).length) {
    return { result: `Nothing booked ${words}.`, data: { needed: [] } };
  }

  const treatmentIds = [...new Set((appts || []).flatMap(a => [
    a.treatment_id,
    ...(Array.isArray(a.extra_treatment_ids) ? a.extra_treatment_ids : []),
  ]).filter(Boolean))];

  let needsForm = new Set();
  if (treatmentIds.length > 0) {
    const { data: treats, error: tErr } = await supabase
      .from('treatments')
      .select('id, requires_consultation')
      .eq('beautician_id', beauticianId)
      .in('id', treatmentIds);
    // A failed treatment lookup must not read as "nobody needs one". That is
    // a reassurance, and this tool exists to stop her being reassured wrongly.
    if (tErr) {
      return { result: `I could not check which treatments need a consultation. Have a look at the diary rather than take my word for it.`, data: { failed: true } };
    }
    needsForm = new Set((treats || []).filter(t => t.requires_consultation === true).map(t => t.id));
  }

  const relevant = (appts || []).filter(a => [
    a.treatment_id,
    ...(Array.isArray(a.extra_treatment_ids) ? a.extra_treatment_ids : []),
  ].filter(Boolean).some(id => needsForm.has(id)));

  if (relevant.length === 0) {
    return { result: `Nothing booked ${words} needs a consultation form.`, data: { needed: [] } };
  }

  const clientIds = [...new Set(relevant.map(a => a.client_id).filter(Boolean))];
  const { data: done, error: dErr } = await supabase
    .from('consultation_responses')
    .select('client_id')
    .eq('beautician_id', beauticianId)
    .eq('status', 'completed')
    .in('client_id', clientIds);

  if (dErr) {
    return { result: `I could not check who has already filled one in. Have a look on their profiles rather than take my word for it.`, data: { failed: true } };
  }
  const haveOne = new Set((done || []).map(r => r.client_id));

  const needed = relevant
    .filter(a => a.client_id && !haveOne.has(a.client_id))
    .map(a => ({
      appointment_id: a.id,
      client_id: a.client_id,
      name: fullName(a.clients),
      first_name: a.clients?.first_name || 'This client',
      when: whenOf(a.starts_at),
      starts_at: a.starts_at,
    }));

  // One line per person, not one per booking: two appointments for the same
  // client is still one form.
  const byClient = [];
  const seen = new Set();
  for (const n of needed) {
    if (seen.has(n.client_id)) continue;
    seen.add(n.client_id);
    byClient.push(n);
  }

  if (byClient.length === 0) {
    return { result: `Everyone booked ${words} who needs a consultation form has already done one.`, data: { needed: [] } };
  }

  const lines = byClient.map(n => `${n.name}, ${n.when}`);
  return {
    result: `${byClient.length} ${byClient.length === 1 ? 'person needs' : 'people need'} a consultation form ${words}: ${andList(lines)}.`,
    data: { needed: byClient },
  };
}

/**
 * Where is this client's patch test up to?
 *
 * Reports one of four true things and never a fifth invented one. See
 * lib/patch-test-status.js: confirmed_at means a slot got booked, not that
 * anybody turned up, and no row in production has ever carried a result.
 */
export async function patchTestStatusForClient({ supabase, beauticianId, client, logger = null }) {
  const { state, when } = await patchTestPicture(supabase, beauticianId, client.id, logger);
  const name = fullName(client);

  // "I could not check" and "she is fine" are opposite answers and must not
  // share a code path. This is the tool she uses with the client already sat
  // down, so the failure has to be loud.
  if (state === 'unknown') {
    return {
      result: `I could not check ${client.first_name}'s patch test just now. Have a look on her profile rather than take my word for it.`,
      data: { failed: true },
    };
  }

  const lines = {
    none: `There is no patch test on record for ${name} at all.`,
    unbooked: `${name} has a patch test on her record with no slot booked. She still needs to book it in.`,
    booked: `${name} has her patch test booked${when ? ` for ${wallDay(when)}` : ''}. It has not been marked as done yet.`,
    attended: `${name} came in for her patch test${when ? ` on ${wallDay(when)}` : ''}.`,
  };

  return {
    // Deliberately no verdict. Nothing writes a pass or a fail anywhere, so
    // "she is patch tested" would be Florrie deciding it for her.
    result: lines[state],
    data: { client, patch_test_state: state, when },
  };
}

/** Everyone booked in this window who still owes a patch test. */
export async function patchTestsOutstanding({ supabase, beauticianId, start_date, end_date, logger = null }) {
  const { start, end } = resolveRange(start_date, end_date);
  const words = rangeWords(start, end);

  const { data: appts, error } = await supabase
    .from('appointments')
    .select('id, starts_at, client_id, clients(id, first_name, last_name)')
    .eq('beautician_id', beauticianId)
    .gte('starts_at', `${start}T00:00:00`)
    .lte('starts_at', `${end}T23:59:59`)
    .in('status', BOOKED)
    .order('starts_at', { ascending: true });

  if (error) {
    return { result: `I could not read the diary just now. Try again in a moment.`, data: { failed: true } };
  }
  if (!(appts || []).length) {
    return { result: `Nothing booked ${words}.`, data: { needed: [] } };
  }

  const { outstanding, failed } = await clientsOwingPatchTest(
    supabase, beauticianId, (appts || []).map(a => a.client_id), logger,
  );
  // "I could not check" and "nobody needs one" are opposite answers and must
  // not share a code path.
  if (failed) {
    return { result: `I could not check patch tests just now. Have a look rather than take my word for it.`, data: { failed: true } };
  }

  const needed = [];
  const seen = new Set();
  for (const a of appts || []) {
    if (!a.client_id || seen.has(a.client_id) || !outstanding.has(a.client_id)) continue;
    seen.add(a.client_id);
    needed.push({
      appointment_id: a.id,
      client_id: a.client_id,
      name: fullName(a.clients),
      when: whenOf(a.starts_at),
      starts_at: a.starts_at,
    });
  }

  if (needed.length === 0) {
    // Not "everyone is patch tested". All this knows is that nobody booked in
    // is sitting on a patch test with no slot against it.
    return { result: `Nobody booked ${words} has a patch test waiting to be booked in.`, data: { needed: [] } };
  }

  const lines = needed.map(n => `${n.name}, ${n.when}`);
  return {
    result: `${needed.length} ${needed.length === 1 ? 'person has' : 'people have'} a patch test still to book ${words}: ${andList(lines)}.`,
    data: { needed },
  };
}

/**
 * Which form would actually be sent to this client, if any.
 *
 * Mirrors sendConsultationFormSMS exactly: a treatment linked form wins, then
 * the account's default active form. It exists because the two are allowed to
 * disagree in production right now. Ellie has three active forms and NO
 * default one, so a proposal that assumed "she has forms, so it will send"
 * would come back "no consultation form set up yet" only after she had tapped
 * confirm. Better to say it before the card appears.
 */
export async function resolveSendableForm({ supabase, beauticianId, treatmentId }) {
  if (treatmentId) {
    const { data: treatment } = await supabase
      .from('treatments')
      .select('consultation_form_id')
      .eq('id', treatmentId)
      .eq('beautician_id', beauticianId)
      .maybeSingle();
    if (treatment?.consultation_form_id) return { formId: treatment.consultation_form_id, via: 'treatment' };
  }

  const { data: defaultForm } = await supabase
    .from('consultation_forms')
    .select('id')
    .eq('beautician_id', beauticianId)
    .eq('is_default', true)
    .eq('is_active', true)
    .maybeSingle();

  if (defaultForm?.id) return { formId: defaultForm.id, via: 'default' };
  return { formId: null, via: null };
}
