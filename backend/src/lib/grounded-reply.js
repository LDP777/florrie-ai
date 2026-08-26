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
 * Checked before anything else, because a client asking for her beautician by
 * name and getting a machine is the single worst outcome available here.
 *
 * These are the ones that are true for EVERY salon. The beautician's own name
 * is deliberately NOT in here. This module is loaded once and serves every
 * tenant, so a name written into a module constant is a name written into
 * every other salon's messages: for months this regex matched "ellie" and
 * nothing else, which meant a client of any other salon asking to speak to
 * her own beautician by name was not recognised as asking for a human at all.
 * The per beautician half is built in nameMatcher() below.
 */
const WANTS_HUMAN_GENERIC = new RegExp([
  // "talk to a person", "chat with someone", "speak to the owner"
  /(speak|talk|chat)\s+(to|with)\s+(an?\s+human|a\s+person|an?\s+actual\s+person|a\s+real\s+person|someone|somebody|the\s+owner|the\s+manager|the\s+boss)/.source,
  // "is this a bot", "is that an AI", "are you a robot", "are you human".
  // `an?` matters: a first version required "a" and missed "is that an AI",
  // which is one of the two most natural ways to ask.
  /\b(is|are)\s+(this|that|you)\s+(an?\s+)?(bot|ai|robot|human|real\s+person|actual\s+person)\b/.source,
  /\breal\s+person\b/.source,
  /\bnot\s+a\s+bot\b/.source,
  // The bare generic word on its own. Always accepted, on every tenant, even
  // though the signature advertises her name instead: a client who has never
  // caught her name still needs a way out, and HUMAN is the word people
  // already try.
  /^\s*(human|person|a\s+human|a\s+person)\s*[.!?]*\s*$/.source,
].join('|'), 'i');

/**
 * Words the network or one of our own templates already owns. A beautician
 * called Faith keeps FAITH; one whose name collided with an opt-out keyword
 * would be handing clients a word that unsubscribes them instead, and
 * gap_fill_offer really does say "Reply YES and it's yours".
 */
const RESERVED_WORDS = new Set([
  'STOP', 'START', 'UNSTOP', 'UNSUBSCRIBE', 'END', 'QUIT', 'CANCEL',
  'HELP', 'INFO', 'YES', 'NO', 'OK', 'OKAY',
]);

/** The word every tenant accepts, and the fallback when a name cannot be shouted. */
export const GENERIC_HANDOFF_WORD = 'HUMAN';

/** Longer than this and a client mistypes it. See handoffWord. */
const MAX_HANDOFF_WORD = 12;

/** Accent folding, applied to her name AND to the message, so the two meet. */
function fold(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Her name as it is written, for the possessive in the signature. */
function displayName(beauticianFirstName) {
  return String(beauticianFirstName || '').replace(/\s+/g, ' ').trim();
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The word a client sends to be put through, derived from HER first name.
 *
 * The signature shouts it, so it has to survive being read in capitals and
 * typed back on a phone keyboard:
 *
 *   - accents fold (Zoe with a diaeresis becomes ZOE) and the inbound message
 *     is folded the same way, so a client who types the accent still matches
 *   - two words take the first only (Mary Jane -> MARY), because MARYJANE is
 *     not a word anybody would type and "MARY JANE" is not one word
 *   - punctuation goes (O'Hara -> OHARA, Anne-Marie -> ANNEMARIE); the
 *     apostrophe reads as a typo in caps and half of clients omit it
 *   - a name written in a script with no Latin letters leaves nothing to
 *     type, so it falls back rather than printing a word the client's
 *     keyboard cannot produce
 *   - over MAX_HANDOFF_WORD characters it falls back too. Truncating would
 *     invent a nickname she never chose and might not answer to
 *   - a collision with a reserved word falls back, see RESERVED_WORDS
 *
 * Every fallback lands on the same generic word, which is always accepted, so
 * the escape hatch exists for every beautician whatever she is called.
 */
export function handoffWord(beauticianFirstName) {
  const first = fold(beauticianFirstName).trim().split(/\s+/)[0] || '';
  const word = first.toUpperCase().replace(/[^A-Z]/g, '');
  if (word.length < 2 || word.length > MAX_HANDOFF_WORD) return GENERIC_HANDOFF_WORD;
  if (RESERVED_WORDS.has(word)) return GENERIC_HANDOFF_WORD;
  return word;
}

/**
 * The per beautician half of the human check: her name, her handoff word, and
 * her first name where the full name is two words. Built per beautician
 * because the module cannot know whose salon a message arrived at, and cached
 * because it is rebuilt on every inbound message otherwise.
 */
const _matcherCache = new Map();

function nameMatcher(beauticianFirstName) {
  const name = displayName(fold(beauticianFirstName));
  if (!name) return null;
  const hit = _matcherCache.get(name);
  if (hit) return hit;

  const word = handoffWord(name);
  const alternatives = new Set([name.toLowerCase(), name.split(' ')[0].toLowerCase()]);
  // The generic word is already covered above; adding it here would only make
  // the same match twice.
  if (word !== GENERIC_HANDOFF_WORD) alternatives.add(word.toLowerCase());
  const group = [...alternatives].filter(Boolean).map(escapeRe).join('|');

  const re = new RegExp([
    // The bare word, on its own line, which is what the signature asks for.
    `^\\s*(?:${group})\\s*[.!?]*\\s*$`,
    // "can I speak to Priya", "talk with Mary Jane"
    `(speak|talk|chat)\\s+(to|with)\\s+(?:${group})\\b`,
  ].join('|'), 'i');

  // A platform has a bounded number of beauticians, but never let a cache
  // grow without a ceiling.
  if (_matcherCache.size > 500) _matcherCache.clear();
  _matcherCache.set(name, re);
  return re;
}

/**
 * Is this client asking for a person?
 *
 * `beauticianFirstName` is optional only so a caller that genuinely does not
 * have it still gets the generic patterns. Every real caller has the
 * beautician record in hand and must pass it: without it "can I speak to
 * Priya" is just a sentence.
 */
export function asksForHuman(message, beauticianFirstName) {
  const m = fold(message);
  if (WANTS_HUMAN_GENERIC.test(m)) return true;
  const byName = nameMatcher(beauticianFirstName);
  return byName ? byName.test(m) : false;
}

/** "I'll get her to call you" in any of the forms a model writes it. */
function promisesAHumanAction(text, beauticianFirstName) {
  const body = String(text || '');

  // Verbs that are always somebody else's job. Florrie cannot make a phone
  // ring, so "I'll get her to call you" is a promise she cannot keep whoever
  // the subject is.
  const HUMAN_VERBS = 'call|ring|text|check|get back|confirm|sort';

  // Sending is different: since 26 August Florrie CAN resend a confirmation,
  // and when she has actually done it the sentence is true and must stand.
  // The claims guard decides that, on evidence, for the first person. What it
  // cannot evidence is a promise about somebody ELSE: "Ellie will send that
  // over" is a commitment nobody made, and that is caught here.
  const SEND_VERBS = 'send|sends|sending|email|emails|emailing|forward|forwards|resend|resends';

  const firstPerson = ["i'?ll", 'i will'];
  const thirdPerson = ["she'?ll", 'she will', "we'?ll", 'we will'];
  const first = displayName(fold(beauticianFirstName)).split(' ')[0];
  if (first) thirdPerson.push(`${escapeRe(first)}\\s+will`);

  const own = new RegExp(`\\b(?:${firstPerson.join('|')})\\b.*\\b(?:${HUMAN_VERBS})\\b`, 'i');
  const other = new RegExp(`\\b(?:${thirdPerson.join('|')})\\b.*\\b(?:${HUMAN_VERBS}|${SEND_VERBS})\\b`, 'i');

  return own.test(body) || other.test(body);
}

/**
 * May Florrie send this reply herself?
 *
 * Returns { grounded, reason }. `reason` is logged and shown in the activity
 * feed, so a decision can always be explained after the fact.
 */
export function isGroundedReply({ intent, message, context, reply, beauticianFirstName }) {
  if (asksForHuman(message, beauticianFirstName)) return { grounded: false, reason: 'asked_for_a_human' };

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
  // offers a time, promises a call back or commits the beautician to anything
  // is not a lookup any more, whatever it was classified as.
  //
  // Her own name goes in the alternation rather than a hardcoded one: "Ellie
  // will ring you" was caught and "Priya will ring you" was not, which is the
  // same bug as the signature in a different clothes.
  const t = String(reply || '');
  if (promisesAHumanAction(t, beauticianFirstName)) {
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
 * it, so nobody thinks the beautician typed it, and it gives a one-word way
 * out, so a client who wants a person is never stuck talking to software. A
 * client cannot be expected to guess the word; it has to be on the message.
 *
 * The word is HERS, derived from her own first name by handoffWord. It used
 * to be the literal string ELLIE for every salon on the platform, which meant
 * a client of any other salon was told to send a word that did nothing.
 *
 * ONE word is advertised, not two. The line already names her ("Florrie,
 * Priya's assistant"), so a client who does not know her name reads it in the
 * same breath as the instruction, and a second word would add clutter to the
 * end of every single message for no new capability. asksForHuman still
 * accepts HUMAN, PERSON and the plain-English asks from anybody who types
 * them unprompted, so nothing is actually lost by advertising one.
 *
 * Kept to one short line: it goes on the end of every reply, and anything
 * longer reads as a footer people learn to skip.
 */
export function florrieSignature(beauticianFirstName) {
  const name = displayName(beauticianFirstName);
  const word = handoffWord(beauticianFirstName);
  // A fresh signup can have an empty first_name, and "Florrie, 's assistant"
  // is worse than saying nothing about who she is. There is no default name:
  // defaulting is what put the pilot's name on other people's messages.
  if (!name) return `Florrie, the salon's assistant. Reply ${word} if you'd rather speak to a person.`;
  return `Florrie, ${name}'s assistant. Reply ${word} if you'd rather speak to her.`;
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
