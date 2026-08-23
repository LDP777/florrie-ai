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
  // And the one that got Leanne: a reply that names a DAY has to name the
  // right one. See dateClaimCheck below for what went wrong and why neither
  // guard above caught it.
  const dates = dateClaimCheck(t, context?.clientUpcoming);
  if (!dates.ok) return { grounded: false, reason: dates.reason };

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
  return `Florrie, ${beauticianFirstName}'s assistant. Reply ELLIE if you'd rather speak to her.`;
}

/**
 * Append the signature, without doubling it if it is somehow already there.
 *
 * The already-signed test still recognises the older `— Florrie,` form, because
 * that string is sitting in thousands of stored messages and a reply quoted back
 * through here must not pick up a second signature. It is anchored to the start
 * of a line so a client saying "thanks Florrie, see you then" is not mistaken
 * for one.
 */
export function signAsFlorrie(reply, beauticianFirstName) {
  const body = String(reply || '').trimEnd();
  if (/(?:^|\n)\s*(?:—\s*)?Florrie,[^\n]*assistant\./i.test(body)) return body;
  return `${body}\n\n${florrieSignature(beauticianFirstName)}`;
}

/**
 * Does this reply claim WHEN an appointment is, and is that claim true?
 *
 * Leanne Hill said "Haha hello you". Florrie replied "Hi Leanne, hey! How are
 * you doing, all set for tomorrow!" — signed as Florrie, sent on its own, on
 * Wednesday 19 August. Leanne's appointment is Wednesday 26 August. Leanne
 * then wrote back "For my appointment NEXT WEEK, if possible, could you order
 * me a tube of the nourish conditioner?", correcting a machine that had just
 * told her the wrong day.
 *
 * The intent was `greeting`, which is grounded — answering "hello" needs no
 * evidence. The failure was that the reply did not stay a greeting: the model
 * added "all set for tomorrow!" as ordinary warmth, the way a person would,
 * without that being a fact it had checked. The two text guards above catch a
 * reply that offers a time or promises a callback; neither catches one that
 * asserts a date.
 *
 * So: if a reply names a day, the day has to match the diary. Not "is there a
 * booking" — the actual day. A wrong date is worse than no date, because the
 * client acts on it.
 */
const RELATIVE_DAYS = /\b(today|tonight|tomorrow|this evening|this afternoon|this morning)\b/i;
const WEEKDAYS = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const VAGUE_WHEN = /\b(next week|this week|next month)\b/i;

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Whole days between two instants, by CALENDAR day rather than by 24-hour
 * blocks — "tomorrow" at 23:00 tonight is one day away, not zero.
 * Wall clock throughout: starts_at parks salon time in the UTC slot.
 */
function daysBetween(fromIso, toIso) {
  const a = new Date(`${String(fromIso).slice(0, 10)}T12:00:00Z`);
  const b = new Date(`${String(toIso).slice(0, 10)}T12:00:00Z`);
  return Math.round((b - a) / 86400000);
}

export function dateClaimCheck(reply, clientUpcoming = [], now = new Date()) {
  const t = String(reply || '');
  const saysRelative = RELATIVE_DAYS.test(t);
  const saysWeekday = WEEKDAYS.test(t);
  const saysVague = VAGUE_WHEN.test(t);
  if (!saysRelative && !saysWeekday && !saysVague) return { ok: true };

  const next = (clientUpcoming || [])[0];
  // Naming a day for somebody with nothing booked is the worst version of
  // this: it invents an appointment out of nothing.
  if (!next?.starts_at) return { ok: false, reason: 'reply_names_a_day_with_nothing_booked' };

  const todayIso = now.toISOString().slice(0, 10);
  const away = daysBetween(todayIso, next.starts_at);

  if (saysRelative) {
    const saidToday = /\b(today|tonight|this evening|this afternoon|this morning)\b/i.test(t);
    const saidTomorrow = /\btomorrow\b/i.test(t);
    if (saidToday && away !== 0) return { ok: false, reason: `reply_said_today_but_booking_is_${away}_days_away` };
    if (saidTomorrow && away !== 1) return { ok: false, reason: `reply_said_tomorrow_but_booking_is_${away}_days_away` };
  }

  if (saysWeekday) {
    const claimed = DAY_NAMES.findIndex(d => new RegExp(`\\b${d}\\b`, 'i').test(t));
    const actual = new Date(`${String(next.starts_at).slice(0, 10)}T12:00:00Z`).getUTCDay();
    if (claimed >= 0 && claimed !== actual) {
      return { ok: false, reason: `reply_said_${DAY_NAMES[claimed]}_but_booking_is_${DAY_NAMES[actual]}` };
    }
    // Right weekday, but more than a week out — "see you Wednesday" for a
    // booking three Wednesdays away is still misleading.
    if (claimed >= 0 && away > 7) return { ok: false, reason: 'reply_named_a_weekday_more_than_a_week_out' };
  }

  if (saysVague) {
    const saidNextWeek = /\bnext week\b/i.test(t);
    const saidThisWeek = /\bthis week\b/i.test(t);
    if (saidThisWeek && away > 7) return { ok: false, reason: 'reply_said_this_week_but_booking_is_further_out' };
    if (saidNextWeek && (away < 2 || away > 14)) return { ok: false, reason: 'reply_said_next_week_but_booking_is_not' };
  }

  return { ok: true };
}
