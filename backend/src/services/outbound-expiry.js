/**
 * Expire proactive messages nobody ever approved.
 *
 * Florrie queues rebook nudges and gap-fill offers for the owner's yes or no.
 * Nothing ever expired them, so Ellie had 103 sitting in pending_approval, the
 * oldest 15 days old, and the approvals badge read 99+ permanently. That is not
 * a counting artefact, it is a real backlog, and the honest fix is to admit
 * that most of it is no longer actionable.
 *
 * These messages are time-sensitive by their nature: a gap-fill offer names a
 * slot, a rebook nudge assumes a rhythm. Once the week has passed, sending it
 * would be worse than not sending it, so anything older than the window is
 * marked expired rather than left to rot in her queue.
 *
 * Deliberately NOT deleted: they stay as history so the record of what Florrie
 * suggested, and what went unanswered, survives.
 */
import { supabase } from '../config.js';
import logger from '../lib/logger.js';

const EXPIRY_DAYS = 7;

export async function expireStaleOutboundSends() {
  const cutoff = new Date(Date.now() - EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    const { data, error } = await supabase
      .from('outbound_sends')
      .update({ status: 'expired' })
      .eq('status', 'pending_approval')
      .lt('created_at', cutoff)
      .select('id');

    if (error) {
      logger.warn({ err: error }, 'outbound expiry sweep failed');
      return { expired: 0 };
    }
    const expired = (data || []).length;
    if (expired) logger.info({ expired, olderThanDays: EXPIRY_DAYS }, 'Expired stale pending approvals');
    return { expired };
  } catch (err) {
    logger.warn({ err }, 'outbound expiry sweep threw');
    return { expired: 0 };
  }
}
