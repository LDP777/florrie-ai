import { hasExplicitBookingRequest } from './booking-request.js';
import { appointmentChangeIntent } from './appointment-message-scenario.js';
import { asksForHuman, atTheDoorPhrase } from './grounded-reply.js';
import { isBookingProblem } from './booking-problem.js';
import { needsAPerson } from './needs-a-person.js';

const fold = value => String(value || '').normalize('NFKC').replace(/[’‘]/g, "'").toLowerCase().trim();
const words = text => fold(text).replace(/[\p{P}\p{S}\uFE0F\u200D]/gu, ' ').replace(/\s+/g, ' ').trim();
const undecorated = text => fold(text).replace(/[\p{S}\uFE0F\u200D]/gu, ' ').replace(/\s+/g, ' ').trim();
const outcome = (action, reason) => ({ action, reason });
const ANSWER = /^(?:yes|yeah|yep|yup|no|nope|nah|ok|okay|sure|perfect|absolutely|definitely|correct|exactly|fine|agreed|sounds good|all good|that works|that'?s (?:fine|right|it|the one)|the (?:first|second|third|last|\d+(?:st|nd|rd|th)?) (?:one|option)|either|both|neither)(?:[\s,!]*(?:please|thanks|thank you|lovely|babe|hun|gorg|x+))*[.!\s]*$/i;
const CHOICE_EMOJI = /[👍👎👌✅☑❎❌🆗🙅🙆]/u;
const SOCIAL_EMOJI = /^[❤♥💕💖💗💓💞💘💝💟🥰😍😘😚😙😊☺😁😄😀😃😆😂🤣🤗🥳🎉🎊🎂🎁🎈💐🌸🌷🌹✨🌟⭐👏🙌🥂🍾🤍🩷🤎🖤🧡💛💚💙💜🫶💋\uFE0F\u200D\u{1F3FB}-\u{1F3FF}\s!.,]+$/u;
const DAYS = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|tonight|next week)';
const MONTHS = '(?:january|february|march|april|may|june|july|august|september|october|november|december)';
const SLOT_ANSWER = new RegExp(`^(?:(?:the|at|on|around|about|after|before|any time|anytime)\\s+)?(?:${DAYS}|\\d{1,2}(?:[.:]\\d{2})?\\s*(?:am|pm)?|\\d{1,2}(?:st|nd|rd|th)(?:\\s+${MONTHS})?)(?:[\\s,/]+(?:${DAYS}|${MONTHS}|at|on|after|before|please|thanks|thank you|x+|\\d{1,2}(?:[.:]\\d{2})?\\s*(?:am|pm)?))*[.!?\\s]*$`, 'i');
const TREATMENT_WORDS = new Set(('brow brows eyebrow eyebrows lash lashes eyelash eyelashes lamination lami lam hybrid stain dye tint lift wax waxing tinting massage facial nails manicure pedicure gel shellac acrylic extensions extension infill infills refill refills maintenance korean signature classic russian volume full set lip chin threading thread bleach browshape shape tidy lashlift microblading dermaplaning consultation patch test').split(' '));
function treatmentAnswer(text) {
  const tokens = words(text).split(' ').filter(token => !/^(?:a|an|the|and|with|plus|just|only|please|if|possible|x+)$/.test(token));
  return tokens.length > 0 && tokens.every(token => TREATMENT_WORDS.has(token));
}

// These are language about the assistant's decision format, not instructions
// this module follows. Quoted/forwarded snippets cannot become a social closure.
const FRAME = /(?:ignore|disregard|override).{0,70}(?:instructions?|prompts?|rules?)|(?:system|developer|assistant)\s*[:>]|<\/?(?:system|developer|assistant)>|["']?(?:participation|decision|evidence)["']?\s*[:=]|```|\bclassify.{0,40}\b(?:social|service|quiet)|\breply (?:only|exactly) with\b|^\s*(?:forwarded(?: message)?|quoted message|she said|he said)\s*:/is;
const SERVICE_CUES = /\b(?:book(?:ing|ed)?|rebook|appointments?|appts?|slots?|availability|reschedul\w*|rearrang\w*|cancel\w*|refund\w*|receipts?|invoices?|charged|charging|payment|deposit|verification|confirmation|password|log\s?in|error|failed|broken|not working|complaint|unhappy|upset|disappoint\w*|incorrect|wrong|reaction|rash|pain|redness|swelling|irritat\w*|allerg\w*|pregnan\w*|aftercare|patch test|training|course|enrol\w*)\b/i;
const DIRECT_REQUEST = /\b(?:can|could|may|should)\s+i\s+(?:book|have|get|come|use|wear|wash|pay)|\b(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:book|check|change|cancel|move|reschedule|send|resend|confirm|help|explain|tell|let|refund)|\b(?:please|help me)\s+(?:book|check|change|cancel|send|resend|confirm|help)|\b(?:i need|i want|i would like|i'd like)\b|\b(?:how much|what (?:price|time|address)|where (?:is|are) (?:the|your) (?:salon|studio))\b/i;
const SERVICE_QUESTION = /\b(?:(?:which|what)\s+(?:treatment|service|time|date|day|option)|which (?:one|of those|works|suits)|would (?:that|this|any|one of)\b.{0,50}\b(?:work|suit)|does (?:that|this) work|(?:any|do you have) allerg|please (?:choose|confirm|pick)|(?:can|could) you confirm)\b/i;
const OFFER_QUESTION = new RegExp(`\\bwould you like\\b.{0,100}\\b(?:book|appointment|slot|treatment|${DAYS}|\\d{1,2}(?::\\d{2})?\\s*(?:am|pm))\\b`, 'i');
const MAX_ANSWER_AGE_MS = 24 * 60 * 60 * 1000;

function fullSocialClosure(message, ownerName) {
  if (FRAME.test(message) || /[?？]/u.test(message) || /^\s*["“].+["”]\s*$/s.test(message)) return false;
  const text = words(message);
  if (!text) return /\p{Extended_Pictographic}/u.test(message) && SOCIAL_EMOJI.test(message);
  const owner = words(ownerName);
  const endearments = new Set(['gorg', 'gorgeous', 'beautiful', 'beauty', 'lovely', 'love', 'babe', 'babes', 'babygirl', 'hun', 'hunni', 'hunny', 'honey', 'darling', 'girl', 'girlie', 'chick', 'sweetheart', ...owner.split(' ').filter(Boolean)]);
  const tailIs = (tail, allowed) => tail.split(' ').filter(Boolean).every(token => allowed.has(token) || endearments.has(token) || /^x+$/.test(token));
  const thanks = /^(?:(?:aw+|ah+|oh)\s+)?(?:thank you|thankyou|thanks|tysm)(?:\s+(.*))?$/.exec(text);
  if (thanks && tailIs(thanks[1] || '', new Set(['so', 'very', 'much', 'really', 'a', 'lot', 'million', 'again', 'for', 'that', 'this', 'everything']))) return true;
  const bookingThanks = /^(?:thank you|thankyou|thanks) (?:so much |very much )?for (?:booking me in|fitting me in|my appointment|the appointment)(?:\s+(.*))?$/.exec(text);
  if (bookingThanks && tailIs(bookingThanks[1] || '', new Set())) return true;
  const birthday = /^(?:happy (?:birthday|bday)|have (?:an? |the )?(?:lovely|great|wonderful|amazing|best) (?:birthday|day)|hope you (?:have|had) (?:an? |the )?(?:lovely|great|wonderful|amazing|best) (?:birthday|day))(?:\s+(.*))?$/.exec(text);
  if (birthday && tailIs(birthday[1] || '', new Set(['to', 'you', 'hope', 'have', 'had', 'a', 'the', 'best', 'lovely', 'great', 'wonderful', 'amazing', 'day', 'ever', 'enjoy', 'your', 'birthday']))) return true;
  return /^(?:bye|goodbye|take care|speak soon|see you soon|see you (?:tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|you re welcome|no worries|no problem)(?: (?:lovely|gorg|babe|hun|love|x+))*$/.test(text);
}

/**
 * Supplied conversation is chronological, tenant/client-scoped, with direction,
 * content, channel, created_at, authored_by, ai_handled, digital_employee and
 * optional send_status. Only the immediately preceding, actually sent AI
 * question can ground an answer. Older deployments omitted send_status, but
 * saved AI front-desk rows only after a successful send.
 */
function priorServiceQuestion({ message, conversation, messageId, channel, now }) {
  if (!messageId || !channel || !Array.isArray(conversation) || !Number.isFinite(now)) return false;
  const currentIndex = conversation.findIndex(row => row.id === messageId);
  if (currentIndex < 1) return false;
  const current = conversation[currentIndex];
  const last = conversation[currentIndex - 1];
  const currentAt = Date.parse(current?.created_at || '');
  const questionAt = Date.parse(last?.created_at || '');
  if (current.direction !== 'inbound' || current.channel !== channel || fold(current.content) !== fold(message)
    || !Number.isFinite(currentAt) || !Number.isFinite(questionAt)
    || currentAt > now || questionAt > currentAt || now - questionAt > MAX_ANSWER_AGE_MS
    || last.direction !== 'outbound' || last.channel !== channel || last.authored_by !== 'ai'
    || last.ai_handled !== true || last.digital_employee !== 'front_desk' || last.escalated === true) return false;
  if (last.send_status && !['sent', 'delivered', 'read'].includes(String(last.send_status).toLowerCase())) return false;
  return SERVICE_QUESTION.test(String(last.content || '')) || OFFER_QUESTION.test(String(last.content || ''));
}

/**
 * `classification: null` is the pre-classifier pass. For a completed classifier
 * response with no participation field, pass that object (or {} on failure).
 * Continue means normal eligibility/grounding checks still have to run; it is
 * never permission to send, reserve, charge or waive an owner's settings.
 */
export function participationDecision({ message, classification = null, conversation = [], conversationReadable = true,
  messageId, channel, ownerName, bookingContinuation = null, now = Date.now() } = {}) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) return outcome('review', 'participation_invalid');
  const framed = FRAME.test(text) || /^\s*["“].+["”]\s*$/s.test(text);
  const acknowledgementQuestion = /[?？]/u.test(text) && fullSocialClosure(text.replace(/[?？]/gu, ''), ownerName);
  const answerFragment = ANSWER.test(undecorated(text)) || SLOT_ANSWER.test(undecorated(text))
    || treatmentAnswer(text) || (!words(text) && CHOICE_EMOJI.test(text));
  const explicitAction = Boolean(bookingContinuation || asksForHuman(text, ownerName) || atTheDoorPhrase(text)
    || appointmentChangeIntent(text) || hasExplicitBookingRequest(text) || isBookingProblem(text)
    || needsAPerson(text).yes || DIRECT_REQUEST.test(text)
    || answerFragment
    || CHOICE_EMOJI.test(text) || acknowledgementQuestion);
  const actionable = explicitAction || SERVICE_CUES.test(text);
  // A whole social closing needs no inference from client history or owner
  // echoes. Mixed messages cannot enter this branch through a friendly prefix.
  if (!framed && !explicitAction && fullSocialClosure(text, ownerName)) return outcome('quiet', 'social_closure');
  if (classification == null) return outcome('continue', 'classification_needed');

  const participation = classification?.participation;
  if (!participation || typeof participation !== 'object' || Array.isArray(participation)) return outcome('review', 'participation_missing');
  if (participation.decision === 'uncertain') return outcome('review', 'participation_uncertain');
  if (!['service', 'social'].includes(participation.decision) || typeof participation.evidence !== 'string') return outcome('review', 'participation_invalid');
  const evidence = participation.evidence.trim();
  if (!evidence || evidence.length > 500 || !text.includes(evidence) || framed) return outcome('review', 'participation_invalid');
  if (typeof classification.confidence !== 'number' || !Number.isFinite(classification.confidence)
    || classification.confidence < 0.9 || classification.confidence > 1) return outcome('review', 'participation_uncertain');
  // A gratitude intent is not a request for another reply. A contradictory
  // model label cannot turn praise into permission to run the reply writer.
  const freshQuestion = conversationReadable !== false
    && priorServiceQuestion({ message: text, conversation, messageId, channel, now });
  if (participation.decision === 'service') {
    if (answerFragment && !bookingContinuation && !freshQuestion) return outcome('review', 'answer_context_unverified');
    if (classification.intent === 'review_thanks' && !explicitAction) return outcome('review', 'thanks_without_request');
    return outcome('continue', 'service_participation');
  }
  if (actionable || freshQuestion) return outcome('review', 'social_evidence_conflict');
  if (conversationReadable === false) return outcome('review', 'conversation_context_unavailable');
  return outcome('quiet', 'social_participation');
}
