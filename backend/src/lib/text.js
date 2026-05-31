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
