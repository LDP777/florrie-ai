/**
 * Anti-slop pass for anything Florrie writes publicly (captions, posts).
 *
 * Two layers:
 * 1. Deterministic detection against a banned-pattern list (the words no
 *    real beautician types but every AI reaches for), plus the beautician's
 *    own never_say list from her voice profile.
 * 2. Only when something is caught, ONE cheap Haiku call rewrites the text
 *    without the flagged phrases, same meaning, same voice. Clean text
 *    passes through untouched and costs nothing.
 *
 * cleanReply (lib/text.js) already handles markdown and em dashes; this is
 * the vocabulary layer on top.
 */
import Anthropic from '@anthropic-ai/sdk';
import logger from './logger.js';
import { cleanReply } from './text.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Lowercase substrings. Every entry earned its place by showing up in AI
// captions and never in a real salon's feed.
const BANNED = [
  'obsessed',
  'slay',
  'treat yourself',
  'elevate your',
  'elevate the',
  'unleash',
  'indulge in',
  'pamper yourself',
  'transformation tuesday',
  'look no further',
  'stunning transformation',
  'we are thrilled',
  "we're thrilled",
  'nestled',
  'a testament to',
  'game-changer',
  'game changer',
  'say goodbye to',
  'say hello to',
  'level up',
  'the perfect way to',
  'your best self',
];

/** Which banned phrases (plus her never_say list) appear in the text? */
export function findSlop(text, neverSay = []) {
  const lower = String(text || '').toLowerCase();
  const extra = (neverSay || []).map(w => String(w).toLowerCase().trim()).filter(w => w.length > 2);
  return [...BANNED, ...extra].filter(p => lower.includes(p));
}

/**
 * Return the text guaranteed free of banned vocabulary. Fail-soft: if the
 * rewrite call fails, the original (deterministically cleaned) text returns
 * rather than blocking the feature.
 */
export async function ensureNoSlop(text, { neverSay = [], context = 'an Instagram caption for a beauty professional' } = {}) {
  const cleaned = cleanReply(String(text || '').trim());
  const hits = findSlop(cleaned, neverSay);
  if (!hits.length) return cleaned;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: `You edit ${context}. Rewrite the text so it no longer contains ANY of these words or phrases: ${hits.join(' | ')}. Keep the same meaning, length, tone and voice. Do not add new hype words. Never use em dashes or en dashes. Return ONLY the rewritten text.`,
      messages: [{ role: 'user', content: cleaned }],
    });
    const rewritten = cleanReply(response.content[0].text.trim());
    // Trust but verify: if the rewrite still contains slop, strip the worst
    // offenders mechanically rather than looping model calls.
    if (findSlop(rewritten, neverSay).length) {
      logger.warn({ hits }, 'anti-slop: rewrite still contained banned phrases, returning original cleaned text');
      return cleaned;
    }
    logger.info({ hits }, 'anti-slop: rewrote caption');
    return rewritten;
  } catch (err) {
    logger.warn({ err }, 'anti-slop rewrite failed, returning cleaned original');
    return cleaned;
  }
}
