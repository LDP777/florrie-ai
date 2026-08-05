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

let available = true;

/** Call once at startup. Never throws: a failed probe leaves us optimistic. */
export async function probeAuthorshipColumn() {
  try {
    const { error } = await supabase.from('messages').select('authored_by').limit(1);
    if (error && isMissingColumnError(error)) {
      available = false;
      logger.error('messages.authored_by is missing. Message authorship will not be recorded and the voice profile cannot learn her writing. Run supabase/migrations/20260805_message_authorship.sql, then RESTART (not redeploy).');
      return false;
    }
    if (error) {
      // Transient. Assuming the column is gone on a network blip would quietly
      // disable authorship for the life of the process.
      logger.warn({ err: error }, 'authorship probe failed, assuming the column is present');
      return available;
    }
    available = true;
    return true;
  } catch (err) {
    logger.warn({ err }, 'authorship probe threw, assuming the column is present');
    return available;
  }
}

/** Spread into any insert into messages: `...authorship(AUTHOR.HUMAN)`. */
export function authorship(value) {
  return available && value ? { authored_by: value } : {};
}

/** Tests only. */
export function __setAuthorshipAvailable(v) { available = v; }
