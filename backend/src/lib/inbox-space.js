import { supabase } from '../config.js';
import logger from './logger.js';

/**
 * The two-space inbox contract, shared by the inbox, the badge counter and
 * the escalations feed so they can never disagree about who matters.
 *
 * Space 1 (Clients) is about RELATIONSHIP, not channel: anyone Ellie has any
 * real link to. An Instagram DM from a regular sits next to her WhatsApps.
 *
 * Space 2 (Instagram) is the strangers who only exist as a DM. Within it,
 * a LEAD is the narrow thing worth her time: the latest inbound shows buying
 * intent, or literally asks a question, and the classifier did not junk it.
 * Compliments, story replies and sign-offs are not leads, so they never make
 * a badge tick up or occupy a For-you card.
 */
export const LEAD_INTENTS = new Set(['booking_request', 'price_enquiry', 'availability_check']);

/**
 * Is this inbound message a lead? Deliberately STRICTER than replyIsOwed:
 * replyIsOwed errs towards nagging (unknown intent with real content is owed),
 * which is right for a client she knows and wrong for an Instagram stranger.
 * A stranger earns attention only by asking for something concrete.
 */
export function isSocialLead({ content, intent, isJunk } = {}) {
  if (isJunk) return false;
  if (LEAD_INTENTS.has(intent)) return true;
  // A question mark is the plainest buying signal text can carry.
  return String(content || '').includes('?');
}

/**
 * Which of these client ids have EVER had an appointment, in any status.
 * Same definition as isKnownClient in lib/outbound-guard.js (any appointment
 * ever makes them hers), batched so list endpoints pay one query, not N.
 *
 * Returns a Set on success and NULL on failure, so callers can pick their own
 * safe direction: the inbox treats null as "nobody matched" (worst case a
 * regular is mislabelled for one page load), while the badge treats null as
 * "cannot tell, count everyone" (worst case the badge reads a little high).
 */
export async function clientsEverBooked(beauticianId, clientIds) {
  const ids = Array.from(new Set((clientIds || []).filter(Boolean)));
  if (!ids.length) return new Set();

  const { data, error } = await supabase
    .from('appointments')
    .select('client_id')
    .eq('beautician_id', beauticianId)
    .in('client_id', ids);

  if (error) {
    logger.warn({ err: error, beauticianId }, 'clientsEverBooked lookup failed');
    return null;
  }
  const found = new Set();
  for (const row of data || []) if (row.client_id) found.add(row.client_id);
  return found;
}

/** Contact details on file are relationship evidence in their own right. */
export function hasContactIdentity(client) {
  return !!(client && (client.phone || client.email || client.whatsapp_id));
}
