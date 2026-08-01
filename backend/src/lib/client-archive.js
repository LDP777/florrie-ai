import { supabase } from '../config.js';
import logger from './logger.js';

/**
 * Clear archived_at when an archived client comes back (they message, or they
 * book again). Archiving is meant to tidy the list, never to lose someone, so
 * any sign of life brings them straight back.
 *
 * Fail-soft by design: the archived_at column arrives in migration 018 which
 * is applied by hand, and an inbound message or a booking must NEVER be lost
 * because an archive flag could not be cleared. Errors are logged and
 * swallowed; this function never throws.
 */
export async function autoUnarchiveClient(clientId, reason) {
  if (!clientId) return;
  try {
    const { data, error } = await supabase
      .from('clients')
      .update({ archived_at: null })
      .eq('id', clientId)
      .not('archived_at', 'is', null)
      .select('id');
    if (error) {
      logger.warn({ err: error, clientId, reason }, 'auto-unarchive failed (migration 018 applied?)');
      return;
    }
    if (data && data.length > 0) {
      logger.info({ clientId, reason }, 'Archived client came back, unarchived');
    }
  } catch (err) {
    logger.warn({ err, clientId, reason }, 'auto-unarchive unexpected failure');
  }
}
