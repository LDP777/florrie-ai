/**
 * Adding a column to an insert is not free in this codebase.
 *
 * PostgREST rejects the WHOLE statement when one column name is unknown, and
 * migrations here have historically been pasted in by hand, out of band, and
 * sometimes not at all: the voice_profile columns lived only in docs/sql for a
 * month. So shipping `authored_by` on eighteen insert sites without a fallback
 * would mean that between deploying the code and running the migration, every
 * inbound and outbound message silently fails to be recorded. Ellie's inbox
 * would go blank. That is a far worse bug than the one being fixed.
 *
 * One probe at boot, then every insert spreads `authorship(...)`, which is
 * either the field or nothing. PgBouncer caches the PostgREST schema anyway, so
 * a restart is required after the migration regardless (see the migration
 * header); probing at boot lines up with that exactly.
 */
import { supabase } from '../config.js';
import logger from './logger.js';
import { isMissingColumnError } from './junk-classifier.js';

// Starts FALSE, and that is the whole point. Optimistic plus an unawaited probe
// means any webhook landing in the millisecond before the probe resolves writes
// authored_by into a table that may not have the column, and PostgREST fails
// the whole insert. That is her inbox going blank to record a nice-to-have.
// Pessimistic costs at most a few unlabelled messages at boot.
let available = false;

/** Call once at startup. Never throws: a failed probe leaves us pessimistic. */
export async function probeAuthorshipColumn() {
  try {
    const { error } = await supabase.from('messages').select('authored_by').limit(1);
    if (!error) {
      available = true;
      return true;
    }
    if (isMissingColumnError(error)) {
      available = false;
      logger.error('messages.authored_by is missing. Message authorship will not be recorded and the voice profile cannot learn her writing. Run supabase/migrations/20260805_message_authorship.sql, then RESTART (not redeploy).');
      return false;
    }
    // Anything else is transient (a network blip, a cold pool). Do not decide
    // either way: retry shortly, because sitting disabled for the life of the
    // process would silently stop the voice profile ever learning again.
    logger.warn({ err: error }, 'authorship probe failed, retrying shortly');
    scheduleRetry();
    return false;
  } catch (err) {
    logger.warn({ err }, 'authorship probe threw, retrying shortly');
    scheduleRetry();
    return false;
  }
}

let retryTimer = null;
function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; probeAuthorshipColumn(); }, 30_000);
  retryTimer.unref?.();   // never hold the process open for this
}

/** Spread into any insert into messages: `...authorship(AUTHOR.HUMAN)`. */
export function authorship(value) {
  return available && value ? { authored_by: value } : {};
}

/** Tests only. */
export function __setAuthorshipAvailable(v) { available = v; }
