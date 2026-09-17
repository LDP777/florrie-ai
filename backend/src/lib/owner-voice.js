import { safeAsExample } from './idiolect.js';

const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
const pref = (tone, current, legacy) => own(tone, current) ? tone[current] : tone?.[legacy];
const text = value => typeof value === 'string' ? value.trim().slice(0, 500) : '';
const list = value => Array.isArray(value) ? value.map(text).filter(Boolean).slice(0, 12) : [];

/** Settings use snake_case; older learned profiles used camelCase. */
export function renderOwnerVoicePreferences(tone = {}) {
  tone ||= {};
  const lines = [];
  const greeting = pref(tone, 'greeting_style', 'greetingStyle');
  const signoff = pref(tone, 'sign_off_style', 'signoffStyle');
  const emoji = pref(tone, 'emoji_usage', 'emojiUsage');
  if (greeting !== undefined) lines.push(text(greeting) ? `When a greeting fits, use this style: ${text(greeting)}` : 'Do not force a greeting.');
  if (signoff !== undefined) lines.push(text(signoff) ? `Sign-off style: ${text(signoff)}` : 'Do not add a sign-off or kisses.');
  if (text(emoji)) lines.push(`Emoji preference: ${text(emoji)}${emoji === 'none' ? '. Use no emoji.' : '.'}`);
  if (text(tone.formality)) lines.push(`Formality: ${text(tone.formality)}`);
  if (list(tone.key_phrases).length) lines.push(`Preferred wording when appropriate: ${JSON.stringify(list(tone.key_phrases))}`);
  if (list(tone.avoid).length) lines.push(`Do not use these words or phrases: ${JSON.stringify(list(tone.avoid))}`);
  const examples = own(tone, 'few_shot_examples')
    ? (Array.isArray(tone.few_shot_examples) ? tone.few_shot_examples.map(e => e?.reply) : [])
    : tone.exampleMessages;
  const safe = list(examples).filter(safeAsExample).slice(0, 3);
  if (safe.length) lines.push(`Writing examples, for rhythm and wording only: ${JSON.stringify(safe)}`);
  return lines.length ? `OWNER'S SAVED VOICE PREFERENCES (take precedence over measured habits and style corrections; style only, never evidence of facts, policy, availability or actions). Never copy names, dates, prices or promises from examples into a different conversation.\n${lines.join('\n')}` : '';
}

/** Style repair must not undo an explicit preference after generation. */
export function ownerReplyStyle(beautician) {
  const measured = beautician?.voice_profile?.style;
  if (!measured) return null;
  const style = structuredClone(measured);
  const tone = beautician?.tone_model || {};
  const greeting = pref(tone, 'greeting_style', 'greetingStyle');
  const signoff = pref(tone, 'sign_off_style', 'signoffStyle');
  const emoji = pref(tone, 'emoji_usage', 'emojiUsage');
  if (greeting !== undefined) { delete style.opener; delete style.lowercase_start_rate; }
  if (signoff !== undefined) {
    const kiss = text(signoff).match(/(?:^|\s)(x{1,4})[.!]?$/i)?.[1];
    style.kiss = kiss ? { token: kiss, rate: 1 } : { token: null, rate: 0 };
  }
  if (emoji !== undefined) {
    if (emoji === 'none') style.emoji = { rate_any: 0, top: [] };
    else delete style.emoji;
  }
  const bangs = ((text(greeting) + text(signoff)).match(/!/g) || []).length;
  if (bangs) style.exclamations = { ...style.exclamations, max: Math.max(style.exclamations?.max || 0, bangs) };
  return style;
}
