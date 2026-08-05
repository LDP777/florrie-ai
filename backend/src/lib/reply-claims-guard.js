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
 * Two claims are refused unless they can be backed:
 *   1. Naming a clock time that is not on the verified list of free slots.
 *   2. Saying a booking has been moved, changed or made, when no such write
 *      happened in the same request.
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
 * @returns {{ok: boolean, reason?: string, offending?: string[]}}
 */
export function checkReplyClaims(text, { allowedTimes = [], actionPerformed = false } = {}) {
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
