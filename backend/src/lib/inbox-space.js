import { supabase } from '../config.js';
import logger from './logger.js';
import { clientQuestionScenario } from './client-question.js';
import { INSTAGRAM_STORY_UNAVAILABLE_MARKER, isUnavailableStoryContext } from './instagram-story-context.js';

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
 * Compliments, story reactions and sign-offs are not leads. A question about
 * a story still needs an answer when Florrie cannot see the story itself.
 */
export const LEAD_INTENTS = new Set(['booking_request', 'price_enquiry', 'availability_check']);

/**
 * Is this inbound message a lead? Deliberately STRICTER than replyIsOwed:
 * replyIsOwed errs towards nagging (unknown intent with real content is owed),
 * which is right for a client she knows and wrong for an Instagram stranger.
 * A stranger earns attention only by asking for something concrete.
 */
export function isSocialLead({ content, intent, isJunk, media_type, escalated_reason } = {}) {
  if (isJunk) return false;
  if (LEAD_INTENTS.has(intent)) return true;
  const text = String(content || '');
  // A question mark is the plainest buying signal text can carry.
  if (text.includes('?')) return true;
  // Keep the classifier and inbox in agreement when a diary-release question
  // is general_question rather than a request for an appointment right now.
  // Strip the metadata first so the story scenario does not mask that question.
  const question = text.split(INSTAGRAM_STORY_UNAVAILABLE_MARKER)[0].trim();
  if (clientQuestionScenario(question)?.kind === 'diary_release') return true;
  if (!isUnavailableStoryContext({ content: text, media_type, escalated_reason })) return false;

  // The story marker alone is not a lead: hearts, compliments and thanks stay
  // quiet. Recognise actual questions/requests even when typed without "?".
  const normalised = question.replace(/[’‘]/g, "'");
  return /\b(?:when|where|why|what|which|how)\s+(?:is|are|do|does|did|will|would|can|could|should|have|has)\b/i.test(normalised)
    || /\bhow\s+(?:much|long|soon|often|many)\b/i.test(normalised)
    || /\b(?:can|could|would|will|do|does|have|has|is|are)\s+(?:i|you|we|it|this|that|these|those)\b/i.test(normalised)
    || /\b(?:need|want|would like|looking|trying)\b.{0,40}\b(?:book|booking|appointment|price|cost|patch test|treatment)\b/i.test(normalised)
    || /\b(?:let me know|tell me)\b/i.test(normalised);
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
