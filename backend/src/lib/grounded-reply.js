/**
 * Which replies Florrie may send to a client Ellie already knows.
 *
 * THE PROBLEM THIS EXISTS FOR. ai-front-desk.js held every message from a
 * known client for approval, and `isKnownClient` means "any appointment ever,
 * in any status" — so Florrie auto-replied to complete strangers and nobody
 * else. Every regular got drafted and queued.
 *
 * Ellie's verdict after a month: she still has just as much admin. She is
 * right, and the number does not lie — her admin did not go away, it changed
 * shape. She stopped writing messages and started approving them. Same volume
 * of decisions, now with a badge nagging her.
 *
 * The guard was not wrong to exist. On 28 July Florrie told a client 4.30
 * Thursday was free when it was not, and Levi's instruction was "we shouldn't
 * fuck with Ellie's clients." The correction was simply too wide: it treats
 * "when am I booked in?" and "can you squeeze me in Saturday?" as the same
 * risk, and they are not remotely the same risk.
 *
 * THE LINE, and it is about EVIDENCE rather than about topic:
 *
 *   GROUNDED   — the answer is already a fact in the database, and answering
 *                it wrongly would require the database to be wrong. When is my
 *                appointment. Have I had a patch test. What time do you open.
 *                What does a lash lift cost. Florrie answers these instantly.
 *
 *   UNGROUNDED — the answer requires a judgement, a negotiation, or a claim
 *                about the future. Is Saturday free. Can you fit me in. I want
 *                to move it. I'm not happy. These still go to Ellie, exactly
 *                as they do today.
 *
 * The 28 July incident was ungrounded — an availability claim. It stays gated.
 * Tonight's client asking "I have an appointment with you tomorrow at 6pm
 * correct?" is grounded, and Florrie should have answered it in two seconds
 * instead of interrupting Ellie mid-client.
 *
 * Nothing here decides whether Florrie may WRITE. It decides whether she may
 * SEND without asking. Everything ungrounded still gets drafted, so Ellie's
 * queue is unchanged for the things she actually needs to see.
 */

/**
 * Intents whose answer is a lookup, not a judgement.
 *
 * PRICE_ENQUIRY is here because the price list is the source of truth and the
 * reply-claims guard already refuses a price that is not on it.
 * AVAILABILITY_CHECK is deliberately NOT here: a free slot is a claim about
 * the future that a stale read can get wrong, which is exactly what happened.
 */
const GROUNDED_INTENTS = new Set([
  'booking_lookup',      // "when am I booked in?" — the one this was built for
  'price_enquiry',
  'general_question',    // answered ONLY from the knowledge base; see below
  'greeting',
  'review_thanks',
]);

const UNGROUNDED_INTENTS = new Set([
  'booking_request',
  'availability_check',
  'reschedule',
  'cancellation',
  'complaint',
  'unknown',
]);

/**
 * Phrases that mean the person wants a human, whatever else the message says.
 * Checked before anything else, because a client asking for Ellie by name and
 * getting a machine is the single worst outcome available here.
 */
const WANTS_HUMAN = new RegExp([
  // "can I speak to Ellie", "talk to a person", "chat with someone"
  /(speak|talk|chat)\s+(to|with)\s+(ellie|a\s+human|a\s+person|someone|somebody)/.source,
  // "is this a bot", "is that an AI", "are you a robot", "are you human".
  // `an?` matters: a first version required "a" and missed "is that an AI",
  // which is one of the two most natural ways to ask.
  /\b(is|are)\s+(this|that|you)\s+(an?\s+)?(bot|ai|robot|human|real\s+person|actual\s+person)\b/.source,
  /\breal\s+person\b/.source,
  /\bnot\s+a\s+bot\b/.source,
  // The bare word, on its own — what the signature tells them to send.
  /^\s*ellie\s*[.!?]*\s*$/.source,
].join('|'), 'i');

/** The word a client sends to be put through. Matched on its own line only. */
const HUMAN_HANDOFF_WORD = /^\s*(ellie|human|person)\s*[.!?]*\s*$/i;

export function asksForHuman(message) {
  const m = String(message || '');
  return HUMAN_HANDOFF_WORD.test(m) || WANTS_HUMAN.test(m);
}

/**
 * May Florrie send this reply herself?
 *
 * Returns { grounded, reason }. `reason` is logged and shown in the activity
 * feed, so a decision can always be explained after the fact.
 */
export function isGroundedReply({ intent, message, context, reply }) {
  if (asksForHuman(message)) return { grounded: false, reason: 'asked_for_a_human' };

  const key = String(intent || '').toLowerCase();
  if (UNGROUNDED_INTENTS.has(key)) return { grounded: false, reason: `ungrounded_intent:${key}` };
  if (!GROUNDED_INTENTS.has(key)) return { grounded: false, reason: `unknown_intent:${key}` };

  // A general question is only grounded if the knowledge base actually had
  // something to say. Otherwise the model is answering from the prompt, which
  // is the definition of ungrounded however confident it sounds.
  if (key === 'general_question' && !(context?.knowledge || []).length) {
    return { grounded: false, reason: 'no_knowledge_match' };
  }

  // A price reply with no price list behind it is a guess.
  if (key === 'price_enquiry' && !(context?.treatments || []).length) {
    return { grounded: false, reason: 'no_price_list' };
  }

  // A booking lookup with nothing in the diary is not a lookup — it is Florrie
  // telling a client she has no appointment, which is a claim worth a human
  // eye when the client clearly believes otherwise.
  if (key === 'booking_lookup' && !(context?.clientUpcoming || []).length) {
    return { grounded: false, reason: 'no_upcoming_booking_to_confirm' };
  }

  // Last line of defence, on the TEXT rather than the intent. A reply that
  // offers a time, promises a call back or commits Ellie to anything is not a
  // lookup any more, whatever it was classified as.
  const t = String(reply || '');
  if (/\b(i'?ll|i will|she'?ll|ellie will|we'?ll)\b.*\b(call|ring|text|check|get back|confirm|sort)\b/i.test(t)) {
    return { grounded: false, reason: 'reply_promises_a_human_action' };
  }
  if (/\b(free|available|open|got a slot|squeeze you|fit you)\b/i.test(t) && !/\bnot\b/i.test(t)) {
    return { grounded: false, reason: 'reply_claims_availability' };
  }

  return { grounded: true, reason: `grounded:${key}` };
}

/**
 * The signature on every message Florrie sends by herself.
 *
 * Two jobs, and the second is the one Levi asked for. It says a machine wrote
 * it, so nobody thinks Ellie typed it — and it gives a one-word way out, so a
 * client who wants a person is never stuck talking to software. A client
 * cannot be expected to guess that "ELLIE" works; it has to be on the message.
 *
 * Kept to one short line: it goes on the end of every reply, and anything
 * longer reads as a footer people learn to skip.
 */
export function florrieSignature(beauticianFirstName = 'Ellie') {
  return `— Florrie, ${beauticianFirstName}'s assistant. Reply ELLIE if you'd rather speak to her.`;
}

/** Append the signature, without doubling it if it is somehow already there. */
export function signAsFlorrie(reply, beauticianFirstName) {
  const body = String(reply || '').trimEnd();
  if (/—\s*Florrie[,.]/i.test(body)) return body;
  return `${body}\n\n${florrieSignature(beauticianFirstName)}`;
}
