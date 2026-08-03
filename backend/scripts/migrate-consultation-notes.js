#!/usr/bin/env node
/**
 * Move consultation answers out of appointments.client_notes and into
 * consultation_responses, where something can actually read them.
 *
 * WHY THIS EXISTS
 * Found while surfacing consultation forms. The public booking page stored the
 * consultation answers it collected as a JSON string in
 * appointments.client_notes:
 *
 *     JSON.stringify({ notes, consultation })
 *
 * so they never reached consultation_responses, and client_notes was pasted
 * verbatim into a Google Calendar event body and into the unauthenticated iCal
 * feed. Both outward paths are fixed in code. This is for the rows written
 * before the fix.
 *
 * There is a SQL version of this in docs/MIGRATE_CONSULTATION_NOTES.sql, and
 * its STEP 1 is worth running first for the census. It can only handle the
 * rows whose answer keys are real field ids, because the booking page also
 * asks five hard coded questions when no form is linked to the treatment, and
 * those answers have no form behind them at all. Filing those needs a form
 * created and the answers re-keyed onto its fields by label, which is this
 * script's job.
 *
 * IT WRITES NOTHING BY DEFAULT.
 *
 *   node backend/scripts/migrate-consultation-notes.js             dry run
 *   node backend/scripts/migrate-consultation-notes.js --apply     do it
 *   node backend/scripts/migrate-consultation-notes.js --limit 5   first 5 only
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment, the same two
 * the backend runs on.
 *
 * IDEMPOTENT. Every appointment that already has a completed
 * consultation_responses row is skipped, and client_notes is only rewritten
 * for a row whose answers were all filed. A blob it cannot parse is reported
 * and left exactly as it is: it is the only copy of what that client wrote.
 *
 * NOTHING HERE PRINTS AN ANSWER. Keys, counts, and the plain note that would
 * remain. These are health answers.
 */
import process from 'node:process';
import { supabase } from '../src/config.js';
import { recordBookingConsultation } from '../src/routes/consultation-forms.js';
import {
  parseStoredClientNote,
  groupAnswersByForm,
  splitDefaultAnswers,
  DEFAULT_BOOKING_FORM_NAME,
} from '../src/lib/client-notes.js';

const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) || 0 : 0;

function die(message) {
  console.error(message);
  process.exit(1);
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  die('Set SUPABASE_URL and SUPABASE_SERVICE_KEY first.');
}

/** Every treatment on an appointment, including the ones added on the day. */
function treatmentIdsOf(appt) {
  return [
    appt.treatment_id,
    ...(Array.isArray(appt.extra_treatment_ids) ? appt.extra_treatment_ids : []),
  ].filter(Boolean);
}

async function main() {
  console.log(APPLY
    ? '\nAPPLYING. Rows will be written.\n'
    : '\nDRY RUN. Nothing will be written. Add --apply when the plan below reads right.\n');

  // Only rows that look like the legacy blob. A note a human typed does not
  // start with a brace.
  let query = supabase
    .from('appointments')
    .select('id, beautician_id, client_id, treatment_id, extra_treatment_ids, starts_at, created_at, client_notes')
    .not('client_notes', 'is', null)
    .like('client_notes', '{%')
    .order('starts_at', { ascending: false });
  if (LIMIT > 0) query = query.limit(LIMIT);

  const { data: rows, error } = await query;
  if (error) die(`Could not read appointments: ${error.message}`);

  if (!rows || rows.length === 0) {
    console.log('No appointment holds a structured note. Nothing to do.');
    return;
  }

  const tally = {
    scanned: rows.length,
    would_move: 0,
    already_done: 0,
    cannot_parse: 0,
    nothing_to_move: 0,
    needs_a_form_created: 0,
    unfilable_keys: 0,
    moved: 0,
    failed: 0,
  };

  for (const appt of rows) {
    const when = String(appt.starts_at || '').slice(0, 10);
    const label = `${appt.id.slice(0, 8)}  ${when}`;
    const parsed = parseStoredClientNote(appt.client_notes);

    if (!parsed.structured) {
      // Starts with a brace but is not JSON at all. Not our shape.
      tally.nothing_to_move += 1;
      continue;
    }

    if (parsed.parseFailed) {
      tally.cannot_parse += 1;
      console.log(`${label}  CANNOT PARSE. Left exactly as it is (${appt.client_notes.length} characters).`);
      continue;
    }

    if (!parsed.answers) {
      tally.nothing_to_move += 1;
      console.log(`${label}  no answers inside. client_notes would become: ${parsed.plainNote === null ? '(empty)' : JSON.stringify(parsed.plainNote)}`);
      continue;
    }

    const { data: existing, error: exErr } = await supabase
      .from('consultation_responses')
      .select('id')
      .eq('appointment_id', appt.id)
      .eq('status', 'completed')
      .limit(1);
    if (exErr) die(`Could not check existing responses for ${appt.id}: ${exErr.message}`);

    if ((existing || []).length > 0) {
      tally.already_done += 1;
      console.log(`${label}  already has a consultation response. Skipped.`);
      continue;
    }

    // Which forms could own these keys: the ones linked to what was booked.
    const treatmentIds = treatmentIdsOf(appt);
    let formIds = [];
    if (treatmentIds.length > 0) {
      const { data: treats, error: tErr } = await supabase
        .from('treatments')
        .select('id, consultation_form_id')
        .in('id', treatmentIds)
        .eq('beautician_id', appt.beautician_id);
      if (tErr) die(`Could not read treatments for ${appt.id}: ${tErr.message}`);
      formIds = [...new Set((treats || []).map(t => t.consultation_form_id).filter(Boolean))];
    }

    let forms = [];
    if (formIds.length > 0) {
      const { data: formRows, error: fErr } = await supabase
        .from('consultation_forms')
        .select('id, consultation_form_fields(id, type)')
        .eq('beautician_id', appt.beautician_id)
        .in('id', formIds);
      if (fErr) die(`Could not read forms for ${appt.id}: ${fErr.message}`);
      forms = (formRows || []).map(f => ({ id: f.id, fields: f.consultation_form_fields || [] }));
    }

    const { groups, unmatched } = groupAnswersByForm({ forms, answers: parsed.answers });
    const { defaults, leftover } = splitDefaultAnswers(unmatched);

    const keys = Object.keys(parsed.answers);
    const placed = groups.reduce((n, g) => n + Object.keys(g.answers).length + (g.signature ? 1 : 0), 0);
    const bits = [];
    if (groups.length > 0) bits.push(`${placed} onto ${groups.length === 1 ? 'form ' + groups[0].form_id.slice(0, 8) : groups.length + ' forms'}`);
    if (Object.keys(defaults).length > 0) bits.push(`${Object.keys(defaults).length} onto "${DEFAULT_BOOKING_FORM_NAME}"`);
    if (Object.keys(leftover).length > 0) bits.push(`${Object.keys(leftover).length} UNFILABLE`);

    console.log(`${label}  ${keys.length} answers: ${bits.join(', ') || 'nowhere to file them'}`);
    console.log(`${' '.repeat(label.length)}  keys: ${keys.join(', ')}`);
    console.log(`${' '.repeat(label.length)}  client_notes would become: ${parsed.plainNote === null ? '(empty)' : JSON.stringify(parsed.plainNote)}`);

    if (Object.keys(defaults).length > 0) tally.needs_a_form_created += 1;
    if (Object.keys(leftover).length > 0) {
      tally.unfilable_keys += 1;
      console.log(`${' '.repeat(label.length)}  the unfilable keys stay in client_notes. Nothing is deleted.`);
    }
    tally.would_move += 1;

    if (!APPLY) continue;

    const result = await recordBookingConsultation({
      beauticianId: appt.beautician_id,
      clientId: appt.client_id,
      appointmentId: appt.id,
      answers: parsed.answers,
      formIds,
    });

    if (result.failed) {
      tally.failed += 1;
      console.log(`${' '.repeat(label.length)}  WRITE FAILED. client_notes untouched.`);
      continue;
    }

    const stillUnfiled = Object.keys(result.unrecorded || {});
    // Only what could not be filed stays behind, in the shape it was already
    // in. A note is never destroyed, and an answer is never dropped.
    const nextNotes = stillUnfiled.length > 0
      ? JSON.stringify({ notes: parsed.plainNote || '', consultation: result.unrecorded })
      : parsed.plainNote;

    const { error: upErr } = await supabase
      .from('appointments')
      .update({ client_notes: nextNotes })
      .eq('id', appt.id);

    if (upErr) {
      tally.failed += 1;
      console.log(`${' '.repeat(label.length)}  answers filed but client_notes could not be rewritten: ${upErr.message}`);
      continue;
    }

    tally.moved += 1;
    console.log(`${' '.repeat(label.length)}  moved ${result.recorded} response row(s).`);
  }

  console.log('\n' + JSON.stringify(tally, null, 2));
  if (!APPLY && tally.would_move > 0) {
    console.log('\nRe-run with --apply to do it.');
  }
}

main().catch(err => die(err?.stack || String(err)));
