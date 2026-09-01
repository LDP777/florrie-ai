/**
 * Some messages are not questions. They are somebody being nervous at you.
 *
 * 1 September 2026, a new client, first message:
 *
 *   "Hey lovely, I hope you're okay! Just to let you know I've just booked in
 *    for a Korean lash lift on the 9th Sept at 11am. Super nervous as I've been
 *    a lash extension girly for as long as I can remember. When would you be
 *    free for a patch test? Xx"
 *
 * She is about to give up something she has worn for years, she is telling the
 * salon owner she is frightened about it, and she is doing it warmly, with a
 * laugh, in the way you talk to a person you have chosen. What came back was a
 * list of times and a note about a deposit.
 *
 * Every other guard in this codebase asks whether Florrie's ANSWER is right.
 * This one asks whether an answer is the thing that was wanted. Reading that
 * message and replying with slots is not a factual error. It is worse than a
 * factual error, because it is the moment where a nervous first-timer decides
 * whether these are people she trusts near her eyes, and a correct slot list
 * loses that moment exactly as thoroughly as an incorrect one.
 *
 * This is also the commercial case, not the soft one. She is a lash extension
 * client considering a switch. Reassure her and she is a regular for years.
 * Hand her a timetable and she books nothing and tells her friends the salon
 * was a bit cold.
 *
 * WHAT IT DOES NOT DO. It does not make Florrie write something warmer. A
 * machine improvising comfort at somebody who is scared is a worse failure
 * than a slot list, and it is not repairable by prompt. Florrie still drafts;
 * the draft goes to Ellie; Ellie sends the sentence that only she can write.
 *
 * DELIBERATELY NARROW. These are words people use about themselves and rarely
 * otherwise, and the cost of a false positive is that Ellie answers a message
 * she would have answered anyway.
 */

/** Fear, said plainly. Not "excited", not "can't wait": those need nobody. */
const APPREHENSION = /\b(?:nervous|anxious|scared|terrified|petrified|worried|apprehensive|dreading|panicking|freaking out|second thoughts|cold feet)\b/i;

/**
 * First person somewhere in the message. Without this, "my friend was scared
 * of getting a lift done" would hand over a message that is really a question.
 */
const ABOUT_HERSELF = /\b(?:i|i'?m|im|i'?ve|ive|me|my|myself)\b/i;

/**
 * Someone else's fear, or a reassurance ABOUT fear, is not the client's own.
 * "don't be nervous" and "you were nervous last time" need no handover.
 */
const NOT_HERS = new RegExp(
  // The whole alternation is grouped, and that is not a style choice. Written
  // as `A|B suffix` the suffix binds only to B, so this matched a bare "you"
  // anywhere in the message. Her message opened "Just to let you know", so the
  // guard that was meant to exclude somebody else's nerves excluded hers. A
  // test written from the real words caught it; reasoning about it did not.
  '(?:' + [
    String.raw`\b(?:you(?:'?re| are| were)?|she(?:'?s| was)?|he(?:'?s| was)?|they(?:'?re| were)?|don'?t be|dont be|no need to be|not)`,
    // Somebody else's nerves, relayed. "My friend was really nervous but she
    // loved it" is a compliment with a question attached, not a person who
    // needs holding. `my` makes it match ABOUT_HERSELF, so it is excluded here.
    String.raw`\b(?:friend|friends|sister|brother|mum|mom|mate|colleague|daughter|cousin|niece|nan|neighbour)\s+(?:was|were|is|are|had been)`,
  ].join('|') + ')'
  + String.raw` (?:so |really |very |too |a bit )*(?:nervous|anxious|scared|terrified|worried|apprehensive)\b`,
  'i',
);

/**
 * Should this message go to a person rather than be answered by Florrie.
 *
 * @param {string} message the client's own words
 * @returns {{yes: boolean, reason: string|null}}
 */
export function needsAPerson(message) {
  const body = String(message || '');
  if (!body.trim()) return { yes: false, reason: null };

  if (APPREHENSION.test(body) && ABOUT_HERSELF.test(body) && !NOT_HERS.test(body)) {
    return { yes: true, reason: 'client_expressed_apprehension' };
  }

  return { yes: false, reason: null };
}
