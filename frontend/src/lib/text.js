/**
 * Florrie house rule: no em/en dashes in anything a client or owner sees.
 * Use to clean stored/generated text at render time (belt-and-braces with the
 * backend strip, so historical rows display clean too).
 *   em (—) -> ", "   en (–) -> "-"
 */
export function deDash(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/\s*—\s*/g, ', ').replace(/\s*–\s*/g, '-');
}
