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
const TIME_TOKENS = [
  /\b\d{1,2}\s*[.:]\s*\d{2}\s*(?:am|pm)?\b/gi,
  /\b\d{1,2}\s*(?:am|pm)\b/gi,
  /\b(?:half|quarter past|quarter to)\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gi,
];

// Phrases that assert a booking changed. Present tense included, because
// "you're moved to Thursday" is the same lie as "I have moved you".
const ACTION_CLAIMS = [
  /\b(?:i(?:'ve| have)?\s+)?(?:moved|rescheduled|changed|switched|shifted)\s+(?:you|your|it|that|the appointment)/i,
  /\byou(?:'re| are)\s+(?:now\s+)?(?:moved|rescheduled|booked|down|in)\b/i,
  /\b(?:that(?:'s| is)|it(?:'s| is)|all)\s+(?:sorted|done|booked|confirmed|changed|moved)\b/i,
  /\bi(?:'ve| have)\s+(?:put|got|booked)\s+you\b/i,
  /\bappointment\s+(?:has been|is now)\s+(?:moved|changed|rescheduled)/i,
  /\bsee you (?:on|at)\b.*\binstead\b/i,
];

/**
 * Normalise a time so "4.30", "4:30" and "16:30" compare equal.
 * Returns null for anything that is not a real time of day, so junk can never
 * accidentally match an allowed slot.
 */
function normaliseTime(raw) {
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
  const found = new Set();
  for (const pattern of TIME_TOKENS) {
    for (const match of String(text || '').matchAll(pattern)) {
      const normalised = normaliseTime(match[0]);
      if (normalised) found.add(normalised);
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
