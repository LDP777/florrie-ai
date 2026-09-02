/**
 * Consultation answers: purge what the link expiry says has expired.
 *
 * WHY THIS EXISTS
 * consultation_responses.expires_at was declared in migration
 * 20260409_backend009 with the comment "auto-expire after 7 days", and for
 * five months nothing read it except the public form page, which returns 410
 * for an expired link. The answers on those rows are allergies, medication,
 * pregnancy and past adverse reactions: special-category health data under
 * UK GDPR, which we told the client we would hold only as long as we needed
 * it. A retention rule that exists only as a column comment is not a
 * retention rule.
 *
 * WHAT expires_at ACTUALLY MEANS, read from the code that writes it
 * routes/consultation-forms.js sets it seven days after the form is SENT, and
 * the submit handler never clears it. So every row, completed or not, is past
 * expires_at a week after the text went out. A sweep on expires_at alone would
 * wipe the answers off every completed form seven days after it was sent,
 * usually before the appointment it was filled in for, and the whole point of
 * the form is to be read in the chair. That is why this job only touches rows
 * that were NEVER completed: the link died, nobody answered, nothing is owed
 * to anyone. Completed forms are the clinical record for as long as the client
 * is a client, and their answers are cleared by the per-client erasure route
 * (DELETE /api/clients/:id) instead.
 *
 * WHY THE ROW STAYS
 * lib/consultation-status.js reads "a completed row exists for this form" as
 * proof the consultation is on file, and the pending row is what the
 * pre-appointment chase in autonomous-scheduler.js and the "already sent"
 * check on the appointment sheet look for. Deleting rows would rewrite that
 * history, so the sensitive columns are nulled and the row is marked expired
 * (the status the public page already stamps when someone opens a dead link).
 * purged_at, added by 20260902_backend028, records that the sweep ran;
 * migrations are applied by hand so the job works without it.
 */
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { isMissingColumnError } from '../lib/junk-classifier.js';

export const PURGE_BATCH_SIZE = 500;
// A ceiling on batches per run so a first run against months of backlog is
// bounded; the next daily pass picks up where this one stopped.
const MAX_BATCHES_PER_RUN = 50;

/** Probed once per process; a missing column is not an error, it is Tuesday. */
let purgedAtKnown = null; // null = not yet probed, true/false afterwards

async function hasPurgedAtColumn(db) {
  if (purgedAtKnown !== null) return purgedAtKnown;
  const { error } = await db.from('consultation_responses').select('purged_at').limit(1);
  if (!error) { purgedAtKnown = true; return true; }
  if (isMissingColumnError(error)) {
    logger.warn('consultation-purge: consultation_responses.purged_at is missing, purging without the marker (apply migration 20260902_backend028)');
    purgedAtKnown = false;
    return false;
  }
  // Anything else is a real failure; do not cache it, and do not guess.
  throw error;
}

/** Test seam: forget the probe result. */
export function _resetPurgedAtProbe() {
  purgedAtKnown = null;
}

/**
 * One pass. Returns how many rows were purged and whether the run stopped at
 * the batch ceiling with work still waiting.
 *
 * @param {object} [deps]
 * @param {object} [deps.db] supabase client, injectable for tests
 * @param {Date} [deps.now]
 * @returns {Promise<{purged: number, batches: number, more: boolean}>}
 */
export async function purgeExpiredConsultationResponses({ db = supabase, now = new Date() } = {}) {
  const nowIso = now.toISOString();
  const withMarker = await hasPurgedAtColumn(db);
  let purged = 0;
  let batches = 0;

  while (batches < MAX_BATCHES_PER_RUN) {
    // Rows past their link expiry that were never completed. The purged_at
    // filter (when the column exists) keeps a row from being swept twice;
    // without it the signature_data IS NULL guard plus the status flip does
    // the same job one pass later.
    let select = db
      .from('consultation_responses')
      .select('id')
      .lt('expires_at', nowIso)
      .neq('status', 'completed')
      .limit(PURGE_BATCH_SIZE);
    select = withMarker ? select.is('purged_at', null) : select.not('answers', 'is', null);

    const { data: rows, error: readErr } = await select;
    if (readErr) {
      logger.error({ err: readErr }, 'consultation-purge: could not read expired responses');
      throw readErr;
    }
    if (!rows || rows.length === 0) break;

    const patch = { answers: null, signature_data: null, status: 'expired' };
    if (withMarker) patch.purged_at = nowIso;

    const ids = rows.map(r => r.id);
    const { error: writeErr } = await db
      .from('consultation_responses')
      .update(patch)
      .in('id', ids);
    if (writeErr) {
      logger.error({ err: writeErr, batch: ids.length }, 'consultation-purge: update failed');
      throw writeErr;
    }

    purged += ids.length;
    batches++;
    if (ids.length < PURGE_BATCH_SIZE) break;
  }

  const more = batches >= MAX_BATCHES_PER_RUN;
  logger.info({ purged, batches, more, withMarker }, 'consultation-purge: expired consultation answers cleared');
  return { purged, batches, more };
}
