/**
 * Stops Florrie sending a client something that is not true.
 *
 * On 28 Jul 2026 Florrie told one of Ellie's clients that "4.30 on Thursday" was
 * available. It was not, and the appointment was never moved. Neither could have
 * been otherwise: the reply prompts are given NO clock times and NO diary, and
 * nothing in the inbound-message path is able to move a booking at all.
 *
 * The prompts have since been told not to do this. That is not enough. A model
 * handed "can I do 4.30 Thursday instead?" will agree, because the client
 * supplied the time and nothing contradicts it. An instruction is a preference;
 * this file is the check.
 *
 * Three claims are refused unless they can be backed:
 *   1. Naming a clock time that is not on the verified list of free slots.
 *   2. Saying a booking has been moved, changed or made, when no such write
 *      happened in the same request.
 *   3. Saying something has been, or is about to be, SENT to the client, when
 *      no send happened in the same request.
 *
 * The third was added on 26 Aug 2026. A client wrote "...don't think I got a
 * confirmation. Do you know what the email is called?" and Florrie answered
 * "Hey, i'll send you a new one now. should come through in a min xx". Nothing
 * was sent. Nothing COULD have been sent: notifyBookingConfirmed is never
 * called from this service, and Florrie has no tools, so she described the
 * action instead of taking it and a real client sat waiting for an email that
 * was never coming.
 *
 * Every pattern in ACTION_CLAIMS is about a booking CHANGE (moved,
 * rescheduled, booked, sorted). A promise to send is a different sentence and
 * it walked straight through. That is the lesson worth writing down: the guard
 * had been scoped to the last incident rather than to the problem, which is
 * Florrie narrating an action nobody performed.
 *
 * Refusing means the draft is thrown away and replaced with a holding reply.
 * A warm "let me check my book and come straight back to you" is always safe,
 * and is what the prompt was supposed to fall back to on its own.
 */

// "4.30", "4:30", "16:30", "4pm", "half four". Deliberately greedy: a false
// positive costs a holding reply, a false negative costs a client turning up
// to a locked door.
// The lookbehind on the second pattern is load bearing. Without it "3.15pm"
// matches TWICE: once in full as 15:15, and again as the fragment "15pm",
// which normalises to 15:00. A reply offering a genuinely free quarter past
// was therefore refused for naming a time nobody wrote, and quarter past is
// one slot in four. This narrows the token, it does not widen the check: the
// only matches it drops are ones already consumed whole by the pattern above,
// because no standalone time is ever preceded by a digit, a dot or a colon.
const DIGIT_TIME_TOKENS = [
  /\b\d{1,2}\s*[.:]\s*\d{2}\s*(?:am|pm)?\b/gi,
  /(?<![\d.:])\b\d{1,2}\s*(?:am|pm)\b/gi,
];

const SPOKEN_TIME_TOKENS = [
  /\b(?:half|quarter past|quarter to)\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gi,
];

// A number that is money or a duration is not a clock time. Without this,
// "It is £35.50 and lasts 90 minutes" reads as 35:50 and gets refused.
const NOT_A_TIME = [
  /[£$€]\s*\d/,
  /\d\s*(?:minutes|minute|mins|min|hours|hour|hrs|hr)\b/i,
  /\bpoints?\b/i,
];

function looksLikeMoneyOrDuration(text, index, token) {
  const before = text.slice(Math.max(0, index - 2), index + token.length);
  const after = text.slice(index, index + token.length + 12);
  return NOT_A_TIME.some(p => p.test(before) || p.test(after));
}

// Phrases that assert a booking changed. Present tense included, because
// "you're moved to Thursday" is the same lie as "I have moved you".
const ACTION_CLAIMS = [
  /\b(?:i(?:'ve| have)?\s+)?(?:moved|rescheduled|changed|switched|shifted)\s+(?:you|your|it|that|the appointment)/i,
  /\byou(?:'re| are)\s+(?:now\s+)?(?:moved|rescheduled|booked|down|in)\b/i,
  /\b(?:that(?:'s| is)|it(?:'s| is)|all)\s+(?:sorted|done|booked|confirmed|changed|moved)\b/i,
  /\bi(?:'ve| have)\s+(?:put|got|booked)\s+you\b/i,
  /\bappointment\s+(?:has been|is now|)\s*(?:moved|changed|rescheduled|booked)/i,
  /\bsee you (?:on|at)\b.*\binstead\b/i,
  // Bare past-tense claims with no subject: "Appointment moved!", "Booking
  // changed", "Moved!". A full stop or exclamation is still a promise.
  /(?:^|[.!?]\s*)(?:appointment|booking|it)?\s*(?:moved|rescheduled|swapped|switched|changed)\b/i,
  /\bchanged\s+(?:it|that|your appointment|the booking)\b/i,
];

/* -------------------------------------------------------------- send claims --
 * Phrases that assert something has been, or is about to be, dispatched to the
 * client: a confirmation, an email, a text, a link, a receipt.
 *
 * WHAT IS DELIBERATELY NOT HERE, because over-blocking is its own failure:
 *
 *   "I'll check my book and come straight back to you" is the sanctioned
 *   holding reply. It promises attention, not a dispatch, and it is the one
 *   sentence the prompts are told to fall back to. It must always pass.
 *
 *   "Ellie will send that over" / "she'll pop it over" is a claim about a
 *   HUMAN, not about the machine. That is a different fact with a different
 *   owner: the draft goes to Ellie, who reads it and knows she has to do it.
 *   lib/grounded-reply.js already owns third-party promises
 *   (promisesAHumanAction), so duplicating them here would ban a legitimate
 *   handover. See the report note: that verb list is missing "send".
 *
 * Idiomatic verbs (pop, ping, text, whizz, fire, chuck) only count when they
 * carry something somewhere. "Pop onto the link" and "I'll pop you in the
 * diary" are ordinary salon English and must not be read as a send.
 */
const SEND_VERB_CORE =
  '(?:re-?)?(?:send|sends|sending|sent|email|emails|emailing|emailed|forward|forwards|forwarding|forwarded)';
const SEND_VERB_IDIOM =
  '(?:pop|popping|ping|pinging|text|texting|whizz|whizzing|fire|firing|shoot|shooting|chuck|chucking)';
// Where the thing is going. Without one of these an idiom verb is not a send.
const SEND_DIRECTION = '(?:over|across|through|out|round|to you|your way)';
// The -ing forms only, for the subjectless "popping that over now" shape.
const SEND_IDIOM_PARTICIPLE =
  '(?:popping|pinging|texting|whizzing|firing|shooting|chucking)';
// First person, present or future. Florrie writes AS the beautician, so "we"
// is her too. No third-person subject on purpose (see the note above).
const I_WILL = "(?:i'll|i will|i'm going to|i am going to|i'm|i am|we'll|we will|we're|we are)";
const I_HAVE = "(?:i've|i have|we've|we have|just|i just|i've just|i have just)";

const SEND_CLAIMS = [
  // "I'll send you a new one now", "I'll email that across", "I'm sending it
  // over", "we'll resend it". THE 26 AUGUST SENTENCE.
  new RegExp(`\\b${I_WILL}\\s+(?:just\\s+|now\\s+|quickly\\s+|get\\s+)?${SEND_VERB_CORE}\\b`, 'i'),
  new RegExp(`\\b${I_WILL}\\s+(?:just\\s+|now\\s+|quickly\\s+)?${SEND_VERB_IDIOM}\\s+(?:\\w+\\s+){0,3}?${SEND_DIRECTION}\\b`, 'i'),

  // Already gone: "just sent you a new one", "I've resent it", "I have
  // emailed it over".
  new RegExp(`\\b${I_HAVE}\\s+(?:just\\s+)?(?:re-?)?(?:sent|emailed|forwarded|texted|popped|pinged)\\b`, 'i'),

  // Bare participle, no subject: "sending it over now", "popping that over",
  // "emailing it across". The existing list already bothers with the bare
  // forms ("Appointment moved!") because a model writes them constantly.
  /(?:^|[.!?,]\s*|\band\s+|\bso\s+)(?:just\s+|now\s+)?(?:re-?)?(?:sending|emailing|forwarding)\b/i,
  new RegExp(`(?:^|[.!?,]\\s*|\\band\\s+|\\bso\\s+)(?:just\\s+|now\\s+)?${SEND_IDIOM_PARTICIPLE}\\s+(?:\\w+\\s+){0,3}?${SEND_DIRECTION}\\b`, 'i'),

  // Bare past tense with no subject: "Sent!", "Resent it", "All sent".
  /(?:^|[.!?]\s*)(?:all\s+)?(?:re-?)?sent\b/i,
  // Bare subject forms: "Confirmation sent", "the email has been resent",
  // "your link is on the way".
  /\b(?:confirmation|email|e-?mail|text|link|receipt|invoice|reminder|it|that|one)\s+(?:has been|have been|is|was|been)?\s*(?:re-?)?sent\b/i,

  // The delivery promise with no verb of sending in it at all, which is the
  // half of the 26 August reply that would have survived on its own:
  // "should come through in a min xx".
  /\bcomes?\s+through\b/i,
  /\bcoming\s+through\b/i,
  /\bon\s+(?:its|it's|the)\s+way\b/i,
  /\bin\s+your\s+inbox\b/i,
  /\b(?:should|will|shall)\s+be\s+with\s+you\s+(?:shortly|in\b|any\b)/i,
  /\b(?:arrive|arrives|arriving|land|lands|landing)\s+(?:shortly|in\s+a\b|in\s+your\b|any\s+(?:minute|second|moment))/i,
];

/**
 * Normalise a time so "4.30", "4:30" and "16:30" compare equal.
 * Returns null for anything that is not a real time of day, so junk can never
 * accidentally match an allowed slot.
 */
const WORD_HOURS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

function normaliseTime(raw) {
  const spoken = String(raw).toLowerCase().trim()
    .match(/^(half|quarter past|quarter to)\s+(\w+)$/);
  if (spoken) {
    const base = WORD_HOURS[spoken[2]];
    if (!base) return null;
    // Salon hours, so "half four" is the afternoon. "half four" = 16:30,
    // "quarter to five" = 16:45 (the hour BEFORE the one named).
    const pm = base < 8 ? base + 12 : base;
    if (spoken[1] === 'half') return `${String(pm).padStart(2, '0')}:30`;
    if (spoken[1] === 'quarter past') return `${String(pm).padStart(2, '0')}:15`;
    return `${String(pm - 1).padStart(2, '0')}:45`;
  }

  const text = String(raw).toLowerCase().replace(/\s+/g, '');
  const withMinutes = text.match(/^(\d{1,2})[.:](\d{2})(am|pm)?$/);
  const hourOnly = text.match(/^(\d{1,2})(am|pm)$/);

  let hour;
  let minute;
  let suffix;

  if (withMinutes) {
    [, hour, minute, suffix] = withMinutes;
  } else if (hourOnly) {
    [, hour, suffix] = hourOnly;
    minute = '00';
  } else {
    return null;
  }

  hour = parseInt(hour, 10);
  minute = parseInt(minute, 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (minute > 59) return null;

  if (suffix === 'pm' && hour < 12) hour += 12;
  if (suffix === 'am' && hour === 12) hour = 0;

  // Without am/pm, a salon time under 8 is an afternoon appointment: "4.30"
  // means half four, never half four in the morning. This is why the allow-list
  // must hold 24h strings, so the comparison is unambiguous.
  if (!suffix && hour < 8) hour += 12;

  if (hour > 23) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** Every time-like token in a piece of text, normalised. Junk tokens dropped. */
export function timesMentionedIn(text) {
  const body = String(text || '');
  const found = new Set();

  for (const pattern of DIGIT_TIME_TOKENS) {
    for (const match of body.matchAll(pattern)) {
      if (looksLikeMoneyOrDuration(body, match.index, match[0])) continue;
      const normalised = normaliseTime(match[0]);
      // A digit token that will not parse as a clock time (35:50, 90:00) is
      // not a time at all, so it is dropped rather than counted against her.
      if (normalised) found.add(normalised);
    }
  }

  for (const pattern of SPOKEN_TIME_TOKENS) {
    for (const match of body.matchAll(pattern)) {
      const normalised = normaliseTime(match[0]);
      // A SPOKEN token that will not parse genuinely is an unverifiable time,
      // so it must count. Dropping these is how "half four Thursday" got out.
      found.add(normalised || `unparsed:${match[0].trim().toLowerCase()}`);
    }
  }

  return Array.from(found);
}

/**
 * @param {string} text            the draft about to go to a client
 * @param {object} opts
 * @param {string[]} opts.allowedTimes  free slots VERIFIED against the diary,
 *                                      as 24h "HH:MM". Empty means the reply
 *                                      may not name any time at all.
 * @param {boolean} opts.actionPerformed  true only if a booking really was
 *                                      written in this same request.
 * @param {boolean} opts.sendPerformed   true only if something really was SENT
 *                                      to this client in this same request,
 *                                      and the send reported success.
 * @returns {{ok: boolean, reason?: string, offending?: string[]}}
 */
/*
 * WHY TWO FLAGS AND NOT ONE.
 *
 * They are different facts about different machinery, and a single flag would
 * launder one into the other. A request that genuinely resent a confirmation
 * would set the one flag, and the same reply could then say "you're all moved
 * to Thursday" and pass -- which is the 28 July incident, waved through by the
 * fix for the 26 August one. A booking write and a message dispatch have to be
 * evidenced separately because they are evidenced by separate code.
 */
export function checkReplyClaims(text, { allowedTimes = [], actionPerformed = false, sendPerformed = false } = {}) {
  const body = String(text || '');

  const allowed = new Set(
    allowedTimes.map(normaliseTime).filter(Boolean),
  );
  const unverified = timesMentionedIn(body).filter(t => !allowed.has(t));
  if (unverified.length) {
    return {
      ok: false,
      reason: 'named a time that was not verified against the diary',
      offending: unverified,
    };
  }

  if (!actionPerformed) {
    for (const pattern of ACTION_CLAIMS) {
      const hit = body.match(pattern);
      if (hit) {
        return {
          ok: false,
          reason: 'claimed a booking change that never happened',
          offending: [hit[0]],
        };
      }
    }
  }

  // A promise to send is allowed the moment it is TRUE. The point of giving
  // Florrie the capability (services/ai-front-desk.js, resendConfirmation) is
  // that this sentence stops being a lie, so the gate is evidence of a real
  // send in this same request, never a ban on the words.
  if (!sendPerformed) {
    for (const pattern of SEND_CLAIMS) {
      const hit = body.match(pattern);
      if (hit) {
        return {
          ok: false,
          reason: 'claimed something was sent when nothing was sent',
          offending: [hit[0].trim()],
        };
      }
    }
  }

  return { ok: true };
}

// Always true, always sendable, and the thing the prompts were meant to fall
// back to unprompted. Ellie picks it up from her inbox either way.
export const HOLDING_REPLY = 'Let me check my book and come straight back to you.';

/**
 * The wrapper to use at every point a generated reply leaves the building.
 * Returns safe text, plus what was rejected so it can be logged and counted.
 */
export function safeReply(text, opts = {}) {
  const verdict = checkReplyClaims(text, opts);
  if (verdict.ok) return { text, rejected: false };
  return { text: HOLDING_REPLY, rejected: true, ...verdict };
}
