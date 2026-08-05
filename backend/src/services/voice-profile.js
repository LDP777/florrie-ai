/**
 * Voice Profile (idiolect engine v2)
 *
 * WHAT WAS WRONG WITH v1
 *
 * Two things, and the second one is the reason Ellie's clients could tell.
 *
 * 1. It learned from the wrong messages. Its filter for "her own writing" was
 *    direction=outbound AND (ai_handled IS NULL OR ai_handled = false).
 *    messages.ai_handled DEFAULTS to false and six insert sites never set it,
 *    so the training corpus contained every Florrie draft Ellie approved from
 *    the outbox, every consultation-form SMS, every canned reminder, and the
 *    auto-cancel notice. Florrie was learning to imitate Florrie. That
 *    converges, and what it converges on is generic assistant.
 *
 * 2. It extracted adjectives. "sounds_like": "warm and friendly", plus a free
 *    text note on sentence style. Nobody can copy an adjective, and every model
 *    handed "warm and friendly" writes the same message. The things her clients
 *    would actually notice, the exact kiss, the lower case start, the missing
 *    full stop, the twelve word average, were never measured and never checked.
 *
 * WHAT v2 DOES
 *
 * Reads only messages.authored_by = 'human' (migration 20260805). Measures her
 * deterministically in lib/idiolect.js, which needs no model call and can be
 * unit tested. Keeps a set of her real messages, verbatim and name-masked, for
 * the reply prompt to show rather than describe. The one model call left does a
 * narrow job (words she would never use) and is allowed to fail without losing
 * the measured profile, which in v1 threw the whole thing away.
 *
 * Fail-soft everywhere: too little of her own writing and voice_profile stays
 * null, which every reader treats as "be plain", not "guess".
 */
import Anthropic from '@anthropic-ai/sdk';
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { isMissingColumnError } from '../lib/junk-classifier.js';
import {
  extractStyleProfile,
  looksAutomated,
  maskName,
  MIN_SAMPLES_FOR_ANY_PROFILE,
  AUTHOR,
} from '../lib/idiolect.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// How far back to look. Deliberately generous: a solo beautician sends a few
// hundred real messages a month, and the more of her own words we have the less
// any single odd message distorts the measurements.
const HISTORY_ROWS = 800;

// Verbatim examples kept for the prompt. Four are shown per reply, chosen by
// similarity, so the store only needs enough variety to cover the situations
// that come up: price, booking, cancelling, running late, thanks.
const EXAMPLES_KEPT = 40;
const EXAMPLE_MAX_CHARS = 240;

/**
 * Pull her message history in one query, both directions, so each outbound can
 * be paired with the inbound it answered. That pairing is what lets the reply
 * prompt show an example matched to the situation rather than a random message.
 */
async function loadHistory(beauticianId) {
  const { data, error } = await supabase
    .from('messages')
    .select('id, client_id, direction, content, authored_by, created_at')
    .eq('beautician_id', beauticianId)
    .order('created_at', { ascending: false })
    .limit(HISTORY_ROWS);

  if (error) {
    // Before the migration is applied, authored_by is an unknown column and
    // PostgREST rejects the WHOLE select, so `data` would be null and this
    // would look like a quiet beautician rather than a broken feature.
    if (isMissingColumnError(error)) {
      logger.warn({ beauticianId }, 'voice profile: messages.authored_by missing, run migration 20260805 and RESTART Railway');
    } else {
      logger.warn({ err: error, beauticianId }, 'voice profile: message history read failed');
    }
    return null;
  }
  return data || [];
}

/** First names, so the opener and the name habit can be measured at all. */
async function loadClientNames(clientIds) {
  const ids = [...new Set(clientIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const { data, error } = await supabase
    .from('clients')
    .select('id, first_name')
    .in('id', ids.slice(0, 400));
  if (error) {
    // Not fatal. Without names the opener reads as "hey sarah" rather than
    // "hey {name}" and the name habit measures as zero, so the profile is
    // poorer but never wrong.
    logger.warn({ err: error }, 'voice profile: client name lookup failed, measuring without names');
    return new Map();
  }
  return new Map((data || []).map(c => [c.id, c.first_name]));
}

/**
 * Every piece of text we can PROVE Florrie wrote, for the bootstrap to subtract.
 * Her drafts live in two places: messages.ai_response (the escalation path) and
 * outbound_sends.body (the outbox queue). Anything Ellie sent that matches one
 * of those word for word is Florrie's sentence, whoever tapped send.
 */
async function loadKnownDrafts(beauticianId) {
  const drafts = new Set();

  const { data: responses, error: rErr } = await supabase
    .from('messages')
    .select('ai_response')
    .eq('beautician_id', beauticianId)
    .not('ai_response', 'is', null)
    .limit(1000);
  if (rErr) logger.warn({ err: rErr, beauticianId }, 'voice profile: ai_response read failed, bootstrap will be less precise');
  for (const r of responses || []) if (r.ai_response) drafts.add(normalise(r.ai_response));

  const { data: queued, error: qErr } = await supabase
    .from('outbound_sends')
    .select('body')
    .eq('beautician_id', beauticianId)
    .limit(1000);
  if (qErr) logger.warn({ err: qErr, beauticianId }, 'voice profile: outbound_sends read failed, bootstrap will be less precise');
  for (const q of queued || []) if (q.body) drafts.add(normalise(q.body));

  return drafts;
}

const normalise = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Turn raw history into training samples, newest first.
 *
 * Two modes, and which one ran is recorded on the profile so nobody has to
 * guess later which corpus produced a given voice.
 *
 *   'human'     rows the code labelled at send time. Exact. Preferred always.
 *   'bootstrap' pre-migration rows, which carry authored_by 'unknown' because
 *               the author genuinely was not recorded. Used ONLY when there are
 *               too few labelled rows to say anything, and only after every
 *               provable Florrie draft and everything shaped like machine copy
 *               has been subtracted. Capped at low confidence, and it stops
 *               being used the moment enough real rows exist.
 */
function selectSamples(history, names, knownDrafts) {
  const outbound = history.filter(m => m.direction === 'outbound' && String(m.content || '').trim());

  const toSample = (m) => ({
    text: String(m.content).trim(),
    clientFirstName: names.get(m.client_id) || null,
    clientId: m.client_id,
    createdAt: m.created_at,
  });

  const labelled = outbound.filter(m => m.authored_by === AUTHOR.HUMAN).map(toSample);
  if (labelled.length >= MIN_SAMPLES_FOR_ANY_PROFILE) {
    return { samples: labelled, provenance: 'human' };
  }

  const bootstrap = outbound
    .filter(m => !m.authored_by || m.authored_by === AUTHOR.UNKNOWN)
    .filter(m => !looksAutomated(m.content))
    .filter(m => !knownDrafts.has(normalise(m.content)))
    .map(toSample);

  return { samples: bootstrap, provenance: 'bootstrap', labelledCount: labelled.length };
}

/**
 * The message she was answering, for each sample. Lets the reply prompt pick an
 * example that matches the SITUATION: how she answers a price question and how
 * she answers a cancellation are two different voices on paper.
 */
function attachRepliedTo(samples, history) {
  const inboundByClient = new Map();
  for (const m of history) {
    if (m.direction !== 'inbound' || !m.client_id || !m.content) continue;
    if (!inboundByClient.has(m.client_id)) inboundByClient.set(m.client_id, []);
    inboundByClient.get(m.client_id).push(m);
  }
  return samples.map(s => {
    const thread = inboundByClient.get(s.clientId) || [];
    // History is newest first, so the first inbound OLDER than this reply is
    // the one it answered.
    const prior = thread.find(m => m.created_at < s.createdAt);
    return { ...s, repliedTo: prior?.content || null };
  });
}

/**
 * Ask the model for one thing only: words she would never use. This is the
 * single part of the old design worth keeping, because it is the one thing you
 * cannot count (an absence). It is also allowed to fail: the measured profile
 * saves either way, which is the opposite of v1, where an unparseable response
 * threw away everything.
 */
async function askForNeverSay(corpus) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: `You are given real messages a British beauty professional sent her own clients. Name the words and phrases an AI would wrongly put in her mouth: marketing or customer-service vocabulary that appears NOWHERE in her writing. Examples of the kind of thing to look for: "elevate", "pamper yourself", "we are thrilled", "reach out", "at your earliest convenience", "rest assured", "I hope this message finds you well".
Respond with JSON only: {"never_say": ["..."]}, at most 10 items, lower case, no explanation. Do not include anything she actually writes.`,
      messages: [{ role: 'user', content: corpus }],
    });
    const text = response.content[0].text.trim().replace(/^```json?\s*|\s*```$/g, '');
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed?.never_say)) return [];
    return parsed.never_say.filter(s => typeof s === 'string' && s.length < 60).slice(0, 10);
  } catch (err) {
    logger.warn({ err }, 'voice profile: never_say pass failed, keeping the measured profile');
    return [];
  }
}

/**
 * Build (or refresh) the voice profile for one beautician.
 * Returns the profile, or null when there is not enough of her own writing yet.
 */
export async function buildVoiceProfile(beauticianId) {
  const history = await loadHistory(beauticianId);
  if (!history) return null;

  const names = await loadClientNames(history.map(m => m.client_id));
  const knownDrafts = await loadKnownDrafts(beauticianId);
  const { samples, provenance, labelledCount } = selectSamples(history, names, knownDrafts);

  if (samples.length < MIN_SAMPLES_FOR_ANY_PROFILE) {
    logger.info({ beauticianId, samples: samples.length, provenance }, 'voice profile: not enough of her own writing yet, staying neutral');
    return null;
  }

  const style = extractStyleProfile(samples);
  if (!style) return null;

  // A bootstrap profile is inferred from rows whose author was never recorded,
  // so it must never claim to be as certain as a measured one.
  if (provenance === 'bootstrap') style.confidence = 'low';

  const withContext = attachRepliedTo(samples, history);
  const examples = withContext
    .filter(s => s.text.length > 8 && s.text.length <= EXAMPLE_MAX_CHARS)
    .slice(0, EXAMPLES_KEPT)
    .map(s => ({
      // Masked before storage, not just before display: one client's name has
      // no business sitting in a prompt written for another.
      text: maskName(s.text, s.clientFirstName),
      reply_to: s.repliedTo ? maskName(s.repliedTo, s.clientFirstName).slice(0, 200) : null,
    }));

  const neverSay = await askForNeverSay(
    examples.slice(0, 30).map(e => e.text).join('\n')
  );

  const profile = {
    style,
    examples,
    never_say: neverSay,
    provenance,
    sample_count: samples.length,
    labelled_count: labelledCount ?? samples.length,
    built_at: new Date().toISOString(),
  };

  const { error: upErr } = await supabase
    .from('beauticians')
    .update({ voice_profile: profile, voice_profile_updated_at: profile.built_at })
    .eq('id', beauticianId);
  if (upErr) {
    // This failed silently every week for anyone whose database never got the
    // voice_profile column, which lived only in docs/sql. Loud now.
    logger.error({ err: upErr, beauticianId }, 'voice profile: SAVE FAILED, replies will keep using the neutral voice');
    return null;
  }

  logger.info({
    beauticianId,
    samples: samples.length,
    provenance,
    confidence: style.confidence,
    medianWords: style.length.median_words,
    kiss: style.kiss?.token,
  }, 'voice profile refreshed');
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
 * Prompt section for the CONTENT engine (captions), which is a different job
 * from a text to a client: a caption is written at a desk, a reply is thumbed
 * between clients, so the length and punctuation measurements do not transfer.
 * Captions get her vocabulary and her emoji palette, nothing more.
 * Reply prompts use renderVoiceSection in lib/idiolect.js instead.
 */
export function buildVoiceGuide(voiceProfile) {
  if (!voiceProfile || typeof voiceProfile !== 'object') return '';
  const style = voiceProfile.style;
  const parts = [];

  if (style?.phrases?.length) {
    parts.push(`Words and phrases she really uses (use them naturally, never force all in): ${style.phrases.join(' | ')}.`);
  }
  if (style?.endearments?.length) {
    parts.push(`What she calls people: ${style.endearments.map(e => e.word).join(', ')}.`);
  }
  if (style?.emoji?.rate_any <= 0.2) parts.push('She does not use emoji.');
  else if (style?.emoji?.top?.length) parts.push(`Emoji she uses, and only these: ${style.emoji.top.join(' ')}.`);
  if (style?.lowercase_start_rate >= 0.6) parts.push('She writes in lower case.');
  if (voiceProfile.never_say?.length) {
    parts.push(`NEVER use these words or phrases, she never would: ${voiceProfile.never_say.join(' | ')}.`);
  }

  if (!parts.length) return '';
  return `VOICE (write exactly like her, this beats every generic style rule):\n${parts.join('\n')}`;
}
