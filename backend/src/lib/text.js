/**
 * Florrie house rule: no em dashes (or en dashes) anywhere a client or owner
 * sees text. Models emit them despite prompt instructions, so we GUARANTEE it
 * by stripping at every AI-text egress instead of trusting the prompt.
 *
 *   em dash (—)  ->  ", "  (its near-universal use is a parenthetical pause)
 *   en dash (–)  ->  "-"   (ranges like 9-5)
 */
export function deDash(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\s*—\s*/g, ', ')
    .replace(/\s*–\s*/g, '-');
}

/**
 * Strip basic markdown emphasis so it never reaches a chat bubble, an SMS, or
 * a WhatsApp message as literal asterisks/backticks. Models love to bold things.
 */
export function stripMarkdown(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '');
}

/** One call for cleaning any AI text shown to a user: no markdown, no dashes. */
export function cleanReply(text) {
  return deDash(stripMarkdown(text));
}
