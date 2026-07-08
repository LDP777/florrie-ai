/**
 * Voice Profile (idiolect engine v1)
 *
 * Distils how each beautician ACTUALLY writes from her own words: outbound
 * messages she typed herself (ai_handled false) and captions she published.
 * The result is a compact JSON style card stored on beauticians.voice_profile
 * and injected into every caption and front-desk reply prompt, so Florrie
 * sounds like her, not like an AI.
 *
 * Runs weekly from index.js. Fail-soft everywhere: a beautician with too
 * little history simply keeps voice_profile = null and prompts fall back to
 * the generic tone rules.
 */
import Anthropic from '@anthropic-ai/sdk';
import { supabase } from '../config.js';
import logger from '../lib/logger.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MIN_SAMPLES = 20; // fewer than this and a profile would just be noise

/**
 * Build (or refresh) the voice profile for one beautician.
 * Returns the profile or null if there is not enough of her own writing yet.
 */
export async function buildVoiceProfile(beauticianId) {
  // Her OWN words only: outbound messages not authored by Florrie.
  const { data: msgs } = await supabase
    .from('messages')
    .select('content, ai_handled, direction, created_at')
    .eq('beautician_id', beauticianId)
    .eq('direction', 'outbound')
    .or('ai_handled.is.null,ai_handled.eq.false')
    .order('created_at', { ascending: false })
    .limit(300);

  const { data: posts } = await supabase
    .from('content_posts')
    .select('caption, status')
    .eq('beautician_id', beauticianId)
    .in('status', ['posted', 'approved'])
    .order('created_at', { ascending: false })
    .limit(50);

  const messageSamples = (msgs || [])
    .map(m => (m.content || '').trim())
    .filter(t => t.length > 5 && t.length < 500);
  const captionSamples = (posts || [])
    .map(p => (p.caption || '').trim())
    .filter(t => t.length > 10);

  if (messageSamples.length + captionSamples.length < MIN_SAMPLES) {
    logger.info({ beauticianId, samples: messageSamples.length + captionSamples.length }, 'voice profile: not enough own writing yet');
    return null;
  }

  // Cap the corpus so the prompt stays cheap (Haiku, ~1 call/week/user).
  const corpus = [
    ...messageSamples.slice(0, 150).map(t => `MSG: ${t}`),
    ...captionSamples.slice(0, 30).map(t => `CAPTION: ${t}`),
  ].join('\n');

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: `You analyse how a beauty professional writes to her clients and distil her voice into a compact JSON style card. Study the samples for what SHE actually does, not what a generic beautician would do. Respond with JSON only, exactly this shape:
{
  "sounds_like": "one sentence describing her voice",
  "phrases": ["up to 8 words or phrases she really uses, verbatim from samples"],
  "never_say": ["up to 6 words/phrases absent from her writing that an AI would wrongly add, e.g. 'elevate', 'treat yourself', 'we are thrilled'"],
  "emoji": ["the 3-6 emoji she actually uses, in her frequency order, [] if she uses none"],
  "sign_off": "how she typically ends messages, or null",
  "sentence_style": "short note on length/rhythm/punctuation habits (e.g. lowercase starts, xx endings, exclamation marks)",
  "greeting": "how she typically opens messages, or null"
}`,
    messages: [{ role: 'user', content: `Samples of her real writing:\n\n${corpus}` }]
  });

  let profile = null;
  try {
    const text = response.content[0].text.trim().replace(/^```json?\s*|\s*```$/g, '');
    profile = JSON.parse(text);
  } catch (err) {
    logger.warn({ err, beauticianId }, 'voice profile: model returned unparseable JSON, skipping');
    return null;
  }

  profile.sample_count = messageSamples.length + captionSamples.length;

  const { error: upErr } = await supabase
    .from('beauticians')
    .update({ voice_profile: profile, voice_profile_updated_at: new Date().toISOString() })
    .eq('id', beauticianId);
  if (upErr) {
    logger.warn({ err: upErr, beauticianId }, 'voice profile: save failed');
    return null;
  }

  logger.info({ beauticianId, samples: profile.sample_count }, 'voice profile refreshed');
  return profile;
}

/**
 * Weekly sweep: refresh every active beautician's profile.
 */
export async function runVoiceProfileRefresh() {
  const { data: beauticians, error } = await supabase
    .from('beauticians')
    .select('id')
    .limit(500);
  if (error) {
    logger.warn({ err: error }, 'voice profile sweep: beautician list failed');
    return { refreshed: 0 };
  }

  let refreshed = 0;
  for (const b of beauticians || []) {
    try {
      const p = await buildVoiceProfile(b.id);
      if (p) refreshed++;
    } catch (err) {
      logger.warn({ err, beauticianId: b.id }, 'voice profile sweep: one beautician failed');
    }
  }
  return { refreshed, total: (beauticians || []).length };
}

/**
 * Render a voice profile as a prompt section. Shared by the front desk and
 * the content engine so her voice is consistent everywhere. Returns '' when
 * no profile exists, so callers can inject unconditionally.
 */
export function buildVoiceGuide(voiceProfile) {
  if (!voiceProfile || typeof voiceProfile !== 'object') return '';
  const parts = [];
  if (voiceProfile.sounds_like) parts.push(`Her voice: ${voiceProfile.sounds_like}.`);
  if (voiceProfile.phrases?.length) parts.push(`Words and phrases she really uses (use them naturally, never force all in): ${voiceProfile.phrases.join(' | ')}.`);
  if (voiceProfile.greeting) parts.push(`She usually opens with: "${voiceProfile.greeting}".`);
  if (voiceProfile.sign_off) parts.push(`She usually signs off with: "${voiceProfile.sign_off}".`);
  if (voiceProfile.emoji?.length) parts.push(`Emoji she uses: ${voiceProfile.emoji.join(' ')} (and only these).`);
  else if (voiceProfile.emoji) parts.push('She does not use emoji.');
  if (voiceProfile.sentence_style) parts.push(`Style: ${voiceProfile.sentence_style}.`);
  if (voiceProfile.never_say?.length) parts.push(`NEVER use these words or phrases, she never would: ${voiceProfile.never_say.join(' | ')}.`);
  if (!parts.length) return '';
  return `VOICE (write exactly like her, this beats every generic style rule):\n${parts.join('\n')}`;
}
