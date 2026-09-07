import { safeAsExample } from './idiolect.js';

// Learn the edit itself, never quote a different client's facts into a reply.
// A recent explicit change takes precedence over the older measured profile.
export function correctionVoiceHints(toneModel) {
  const hints = new Map();
  for (const item of (toneModel?.corrections || []).slice(-20)) {
    const before = String(item.original || '').trim();
    const after = String(item.corrected || '').trim();
    if (!before || !after || before === after || !safeAsExample(before) || !safeAsExample(after)) continue;
    const kiss = text => text.match(/(?:^|\s)(x{1,4})[.!]?$/i)?.[1]?.toLowerCase() || '';
    if (kiss(before) !== kiss(after)) hints.set('kiss', kiss(after) ? `For an ordinary casual reply, use her sign-off "${kiss(after)}".` : 'Do not add kisses to the sign-off.');
    const opening = text => text.match(/^(hi|hey|hiya|hello)\b/i)?.[1]?.toLowerCase();
    if (opening(before) && opening(after) && opening(before) !== opening(after)) hints.set('opening', `When a greeting is needed, she prefers "${opening(after)}".`);
    if (/^[A-Z]/.test(before) && /^[a-z]/.test(after)) hints.set('case', 'She changed the opening to lower case; use lower case for casual replies.');
    if (/^[a-z]/.test(before) && /^[A-Z]/.test(after)) hints.set('case', 'She changed the opening to a capital; capitalise the start of replies.');
    const emoji = /\p{Extended_Pictographic}/u;
    if (emoji.test(before) && !emoji.test(after)) hints.set('emoji', 'Do not add emoji; she removed them from her correction.');
    if (!emoji.test(before) && emoji.test(after)) hints.delete('emoji');
  }
  return hints.size ? `RECENT STYLE CORRECTIONS (override older style habits only; never override booking facts, policy or safety):\n${[...hints.values()].join('\n')}` : '';
}
