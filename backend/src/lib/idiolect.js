/**
 * HER IDIOLECT, MEASURED.
 *
 * Ellie's clients read a Florrie reply and knew a machine wrote it. The
 * previous engine asked a model to describe her voice and got back adjectives:
 * "warm", "friendly", "professional", plus a free-text note about her
 * "sentence style". You cannot copy an adjective. Every model handed
 * "warm and friendly, keep it short" writes the same message, and that message
 * is the one her regulars did not recognise.
 *
 * So nothing in this file is an adjective. It measures the things a person who
 * has been texted by Ellie for three years would actually notice if they
 * changed: whether she starts with a capital letter, whether the message ends
 * in a full stop or a kiss, which kiss, how many emoji and which ones, whether
 * she says the client's name, how long her messages are, and the exact phrases
 * she reaches for. All of it is counted, not described, so all of it can be
 * checked against a draft afterwards.
 *
 * Three parts:
 *   1. extractStyleProfile  measure her, from her own messages only
 *   2. renderVoiceSection   put the measurements and some of her real
 *                           sentences into the prompt
 *   3. checkDraftStyle / repairDraft  hold the output to the measurements
 *
 * Nothing here calls a model. Every function is pure, so every claim it makes
 * about Ellie is testable, and so is every repair it makes to a draft.
 */
import { tokenize } from './knowledge.js';

/**
 * Below this, a "profile" is a description of a coincidence. Three messages
 * ending in "xx" is not a habit, it is three messages, and asserting it into a
 * prompt gives a new customer a confidently wrong voice on day one. Under the
 * floor we return null and every caller falls back to plain and neutral.
 */
export const MIN_SAMPLES_FOR_ANY_PROFILE = 8;

/** Above this, rare habits become reliable enough to assert. */
export const MIN_SAMPLES_FOR_FULL_PROFILE = 25;

/**
 * A habit is only worth putting in a prompt if she does it MOST of the time.
 * At 0.6 the model is told "usually"; below 0.2 we assert the negative, which
 * matters just as much (a woman who never signs off must not be given a
 * sign-off). Between the two we say nothing, because "sometimes" is an
 * instruction no model can follow and every model averages.
 */
const HABIT = 0.6;
const NOT_A_HABIT = 0.2;

// A trailing run of x or X, optionally spaced, is a kiss. Kept separate from
// the general sign-off because it is the single most recognisable thing about
// how a British beautician ends a text, and getting it wrong (xx when she
// writes x, or a kiss when she writes none) is instantly audible.
const KISS_AT_END = /(?:^|[\s,.!?])((?:[xX][\s]?){1,4})[\s.!]*$/;

const EMOJI = /\p{Extended_Pictographic}/gu;

// Only these words may have their capital removed by the repairer. A name, a
// treatment or "I" must never be lowercased, and guessing which is which from
// text alone is exactly the kind of cleverness that produces a message reading
// "i'll see sarah then".
const SAFE_TO_LOWERCASE = new Set([
  'hi', 'hey', 'hiya', 'hello', 'heya', 'morning', 'evening', 'aw', 'aww',
  'ah', 'oh', 'yes', 'yeah', 'yep', 'no', 'nope', 'ok', 'okay', 'sure',
  'thanks', 'thank', 'sorry', 'course', 'of', 'lovely', 'perfect', 'great',
  'yay', 'omg', 'so', 'just', 'that', 'they', 'we', 'you', 'your', 'the',
  'all', 'not', 'can', 'will', 'would', 'shall', 'let', 'give', 'come',
]);

const ENDEARMENTS = [
  'lovely', 'hun', 'hunny', 'honey', 'babe', 'baby', 'darling', 'darlin',
  'sweetie', 'sweetheart', 'love', 'doll', 'gorgeous', 'petal', 'chick',
  'chuck', 'my lovely', 'lovely lady',
];

const HEDGES = [
  'just', 'sorry', 'no worries', 'no probs', 'not to worry', 'if that helps',
  'if you like', 'let me know', 'whenever', 'no rush', 'honestly', 'defo',
  'deffo', 'course', 'of course', 'bear with', 'i think', 'i reckon',
];

/* ────────────────────────────────────────────────────────────────────────
 * 1. MEASURE
 * ──────────────────────────────────────────────────────────────────────── */

const words = (t) => String(t || '').trim().split(/\s+/).filter(Boolean);

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function percentile(nums, p) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[idx];
}

function countEmoji(text) {
  return (String(text || '').match(EMOJI) || []).length;
}

function emojiIn(text) {
  return String(text || '').match(EMOJI) || [];
}

/**
 * Replace the client's own first name with a placeholder before anything is
 * counted or stored. Two reasons, and both matter. It turns "hey sarah" and
 * "hey emma" into the SAME opener so the habit is visible at all, and it means
 * one client's name never ends up in a prompt written for another.
 */
export function maskName(text, firstName) {
  const name = String(firstName || '').trim();
  if (name.length < 2) return String(text || '');
  const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(text || '').replace(new RegExp(`\\b${safe}\\b`, 'gi'), '{name}');
}

/** The trailing kiss exactly as she writes it: "x", "xx", "Xx". */
export function kissAtEnd(text) {
  const m = String(text || '').match(KISS_AT_END);
  if (!m) return null;
  return m[1].replace(/\s+/g, '');
}

function topOf(counts, minRate, total) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return null;
  const [value, count] = entries[0];
  const rate = count / total;
  return rate >= minRate ? { value, rate: round2(rate) } : null;
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Frequent multi-word phrases, verbatim. These are the giveaway: "let me know
 * lovely", "no worries at all", "see you then". They are not filtered through
 * the stop-word list on purpose, because almost every characteristic phrase a
 * person has is built entirely out of stop words.
 */
function topPhrases(maskedTexts, limit = 8) {
  const counts = new Map();
  for (const text of maskedTexts) {
    const w = words(text.toLowerCase().replace(/[^a-z0-9'{}\s]/g, ' '));
    for (const n of [2, 3]) {
      for (let i = 0; i + n <= w.length; i++) {
        const phrase = w.slice(i, i + n).join(' ');
        if (phrase.includes('{name}')) continue;
        counts.set(phrase, (counts.get(phrase) || 0) + 1);
      }
    }
  }
  const ranked = [...counts.entries()]
    // Twice is a coincidence. Three times in her own outbox is how she talks.
    .filter(([, c]) => c >= 3)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);

  // Prefer the longest form: keeping both "let me" and "let me know" wastes
  // prompt space saying the same thing twice.
  const picked = [];
  for (const [phrase] of ranked) {
    if (picked.some(p => p.includes(phrase))) continue;
    picked.push(phrase);
    if (picked.length >= limit) break;
  }
  return picked;
}

/**
 * @param {Array<{text: string, clientFirstName?: string}>} samples her own
 *        outbound messages, newest first. Authorship is the CALLER's problem:
 *        anything that reaches here is treated as genuinely hers.
 * @returns {object|null} null when there is not enough of her writing to say
 *          anything honest, which callers must read as "be plain and neutral".
 */
export function extractStyleProfile(samples) {
  const rows = (samples || [])
    .map(s => ({
      raw: String(s?.text || '').trim(),
      masked: maskName(String(s?.text || '').trim(), s?.clientFirstName),
      usedName: !!(s?.clientFirstName)
        && maskName(String(s?.text || ''), s.clientFirstName).includes('{name}'),
    }))
    .filter(r => r.raw.length > 1);

  const total = rows.length;
  if (total < MIN_SAMPLES_FOR_ANY_PROFILE) return null;

  const confidence = total >= MIN_SAMPLES_FOR_FULL_PROFILE ? 'good' : 'low';

  const wordCounts = rows.map(r => words(r.raw).length);
  const emojiCounts = rows.map(r => countEmoji(r.raw));
  const namedRows = rows.filter(r => r.usedName).length;
  const namedEligible = (samples || []).filter(s => String(s?.clientFirstName || '').trim().length > 1).length;

  // Openers. The two-word form is the one worth having ("hey lovely" is not
  // "hey"), so it wins whenever it is common enough to be a habit at all.
  const firstTwo = {};
  const firstOne = {};
  const kisses = {};
  const emojiUse = {};
  let lowercaseStart = 0;
  let endsFullStop = 0;
  let endsKiss = 0;
  let hasEmoji = 0;
  let questions = 0;
  let contractions = 0;
  const exclamationCounts = [];

  for (const r of rows) {
    const w = words(r.masked.toLowerCase().replace(/[^a-z0-9'{}\s]/g, ' '));
    if (w.length) {
      firstOne[w[0]] = (firstOne[w[0]] || 0) + 1;
      if (w.length > 1) {
        const two = `${w[0]} ${w[1]}`;
        firstTwo[two] = (firstTwo[two] || 0) + 1;
      }
    }
    const firstChar = r.raw.match(/[a-zA-Z]/)?.[0];
    if (firstChar && firstChar === firstChar.toLowerCase()) lowercaseStart++;

    const kiss = kissAtEnd(r.raw);
    if (kiss) { kisses[kiss] = (kisses[kiss] || 0) + 1; endsKiss++; }
    // Measured with the kiss taken off, because "all booked. xx" and
    // "all booked xx" are two different punctuation habits and the kiss would
    // otherwise hide the difference.
    if (/\.\s*$/.test(kiss ? r.raw.replace(KISS_AT_END, '') : r.raw)) endsFullStop++;

    const es = emojiIn(r.raw);
    if (es.length) hasEmoji++;
    for (const e of es) emojiUse[e] = (emojiUse[e] || 0) + 1;

    if (r.raw.includes('?')) questions++;
    if (/\b\w+['’](?:s|t|re|ll|ve|d|m)\b/i.test(r.raw)) contractions++;
    exclamationCounts.push((r.raw.match(/!/g) || []).length);
  }

  const opener = topOf(firstTwo, 0.25, total) || topOf(firstOne, 0.3, total);
  const kiss = topOf(kisses, 0.25, total);

  const endearments = ENDEARMENTS
    .map(word => ({
      word,
      rate: round2(rows.filter(r => new RegExp(`\\b${word}\\b`, 'i').test(r.raw)).length / total),
    }))
    .filter(e => e.rate >= 0.08)
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 4);

  const hedges = HEDGES
    .map(word => ({
      word,
      rate: round2(rows.filter(r => new RegExp(`\\b${word}\\b`, 'i').test(r.raw)).length / total),
    }))
    .filter(h => h.rate >= 0.1)
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 5);

  return {
    sample_count: total,
    confidence,
    length: {
      median_words: median(wordCounts),
      p10_words: percentile(wordCounts, 10),
      p90_words: percentile(wordCounts, 90),
    },
    opener: opener ? { text: opener.value, rate: opener.rate } : null,
    kiss: kiss ? { token: kiss.value, rate: round2(endsKiss / total) } : { token: null, rate: round2(endsKiss / total) },
    emoji: {
      // Her palette, in her order of preference. Anything outside it in a draft
      // is a machine's choice, not hers.
      top: Object.entries(emojiUse).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([e]) => e),
      rate_any: round2(hasEmoji / total),
      median_per_message: median(emojiCounts),
      max_per_message: emojiCounts.length ? Math.max(...emojiCounts) : 0,
    },
    lowercase_start_rate: round2(lowercaseStart / total),
    ends_full_stop_rate: round2(endsFullStop / total),
    uses_first_name_rate: namedEligible ? round2(namedRows / namedEligible) : 0,
    question_rate: round2(questions / total),
    contraction_rate: round2(contractions / total),
    exclamations: {
      median: median(exclamationCounts),
      max: exclamationCounts.length ? Math.max(...exclamationCounts) : 0,
    },
    endearments,
    hedges,
    phrases: topPhrases(rows.map(r => r.masked)),
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * 2. PUT HER IN THE PROMPT
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Pick the handful of her real messages closest to what the client just sent.
 *
 * Same lexical scoring as lib/knowledge.js, and for the same reason: a salon's
 * outbox is hundreds of messages, not millions, and there is no embeddings API
 * on this stack. Matching matters because register is situational. How she
 * answers "how much is a lash lift" and how she answers "so sorry I have to
 * cancel" are different people on paper, and showing the model the wrong one is
 * barely better than showing it none.
 *
 * Never returns nothing when there is something: with no lexical overlap at all
 * the most recent messages are still the best available evidence of her voice.
 */
export function pickExamples(examples, incoming, limit = 4) {
  const pool = (examples || []).filter(e => e && String(e.text || '').trim());
  if (!pool.length) return [];

  const queryTokens = new Set(tokenize(incoming));
  if (!queryTokens.size) return pool.slice(0, limit).map(e => e.text);

  const scored = pool.map((e, i) => {
    const tokens = tokenize(e.reply_to || e.text);
    let overlap = 0;
    for (const t of new Set(tokens)) if (queryTokens.has(t)) overlap++;
    // Normalised by length so a long rambling message cannot outrank a precise
    // one just by containing more words.
    const score = overlap / Math.sqrt(Math.max(1, new Set(tokens).size));
    return { text: e.text, score, i };
  });

  const relevant = scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit);

  // Relevance first, then the newest to top up, so the prompt always has real
  // sentences in it even when nothing in the message overlaps her outbox.
  const chosen = [];
  const seen = new Set();
  for (const r of relevant) { chosen.push(r.i); seen.add(r.i); }
  for (let i = 0; i < pool.length && chosen.length < limit; i++) {
    if (!seen.has(i)) { chosen.push(i); seen.add(i); }
  }
  return chosen.slice(0, limit).map(i => pool[i].text);
}

/**
 * The voice block for a reply prompt. Concrete instructions plus her actual
 * sentences. Returns '' when there is no usable profile, so callers can inject
 * it unconditionally and a new customer simply gets the house default.
 */
export function renderVoiceSection(voiceProfile, incoming = '') {
  const style = voiceProfile?.style;
  if (!style || !style.sample_count) return '';

  const lines = [];
  const L = style.length || {};
  const lo = Math.max(2, L.p10_words || 3);
  const hi = Math.max(lo + 2, L.p90_words || 25);
  lines.push(`LENGTH: she writes ${L.median_words || 12} words on average, almost never more than ${hi}. Match that. Do not write a complete, tidy paragraph: she is typing on her phone between clients.`);

  if (style.opener?.rate >= HABIT) {
    lines.push(`OPENING: she opens with "${style.opener.text}" (${Math.round(style.opener.rate * 100)}% of the time). Use it, with the client's real first name where {name} appears.`);
  } else if (style.opener) {
    lines.push(`OPENING: she often opens with "${style.opener.text}". Do not open with anything more formal than that.`);
  }

  if (style.kiss?.rate >= HABIT && style.kiss.token) {
    lines.push(`SIGN OFF: she ends with "${style.kiss.token}". Exactly that, not "xx" if she writes "x". No other sign off, no "Best wishes", no name.`);
  } else if (style.kiss?.rate <= NOT_A_HABIT) {
    lines.push('SIGN OFF: she does not sign off with kisses. Do not add any.');
  }

  if (style.emoji?.rate_any <= NOT_A_HABIT) {
    lines.push('EMOJI: she does not use emoji. Use none.');
  } else if (style.emoji?.top?.length) {
    lines.push(`EMOJI: only these, and at most ${Math.max(1, style.emoji.median_per_message || 1)} per message: ${style.emoji.top.join(' ')}`);
  }

  if (style.lowercase_start_rate >= HABIT) {
    lines.push('CAPITALS: she starts messages in lower case. Do the same.');
  }
  if (style.ends_full_stop_rate <= NOT_A_HABIT) {
    lines.push('PUNCTUATION: she does not put a full stop at the end of a message. Leave it off.');
  }
  if (style.exclamations?.median >= 1) {
    lines.push(`EXCLAMATION MARKS: she uses about ${style.exclamations.median} per message, never more than ${style.exclamations.max}.`);
  } else if (style.exclamations?.max === 0) {
    lines.push('EXCLAMATION MARKS: she does not use them.');
  }

  if (style.uses_first_name_rate >= HABIT) {
    lines.push("NAME: she uses the client's first name. Use it.");
  } else if (style.uses_first_name_rate <= NOT_A_HABIT) {
    lines.push("NAME: she rarely uses the client's name. Do not force it in.");
  }

  if (style.endearments?.length) {
    lines.push(`WHAT SHE CALLS PEOPLE: ${style.endearments.map(e => `"${e.word}"`).join(', ')}. Use one only where she would.`);
  }
  if (style.phrases?.length) {
    lines.push(`HER PHRASES, VERBATIM: ${style.phrases.map(p => `"${p}"`).join(' | ')}. Reach for these before inventing your own wording.`);
  }
  if (voiceProfile.never_say?.length) {
    lines.push(`NEVER: ${voiceProfile.never_say.join(' | ')}. She would not say any of these.`);
  }

  const examples = pickExamples(voiceProfile.examples, incoming, 4);
  const exampleBlock = examples.length
    ? `\n\nHER OWN MESSAGES, word for word. This is what "sounds like her" means. Copy the rhythm, the length and the punctuation, not the content:\n${examples.map(t => `  ${t}`).join('\n')}`
    : '';

  const caveat = voiceProfile.provenance === 'bootstrap' || style.confidence === 'low'
    ? '\n(These are measured from a small sample. Where the notes above are silent, stay plain rather than inventing a mannerism.)'
    : '';

  return `HOW SHE WRITES. Her clients have been texted by her for years and can tell when it is not her, so this section outranks every other style rule in this prompt.\n${lines.join('\n')}${exampleBlock}${caveat}`;
}

/**
 * What to say when we do not know how she writes. Deliberately not "warm and
 * friendly": a model told to be warm and friendly writes the exact message
 * that got us here. Plain and short is never uncanny, it is just brief.
 */
export const NEUTRAL_VOICE_SECTION = `HOW SHE WRITES: not known yet, there is not enough of her own writing on file.
Write plainly and briefly. Do not perform warmth, do not add emoji, do not add kisses, do not use pet names, do not use exclamation marks. One or two short sentences. A plain message reads as busy; an over-warm one reads as a robot pretending.`;

/* ────────────────────────────────────────────────────────────────────────
 * 3. HOLD THE OUTPUT TO IT
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Does this draft actually match her measured habits?
 *
 * A prompt is a preference; this is the check. Same argument as
 * lib/reply-claims-guard.js, applied to voice instead of truth. Everything it
 * reports is mechanical and reversible, except length, which cannot be fixed
 * by editing (truncating a message mid sentence is worse than a long one) and
 * so is the only thing that asks for a regeneration.
 *
 * @returns {{ok: boolean, problems: string[], tooLong: boolean, band: {min:number,max:number}}}
 */
export function checkDraftStyle(draft, style) {
  const text = String(draft || '');
  const problems = [];
  if (!style || !style.sample_count) {
    return { ok: true, problems, tooLong: false, band: null };
  }

  const L = style.length || {};
  const band = {
    min: Math.max(2, Math.round((L.p10_words || 3) * 0.6)),
    // 1.4x her 90th percentile, floored at twice her median. Her longest normal
    // message is a real message; the point is to catch the essay, not to police
    // a sentence that runs a few words over.
    max: Math.max(Math.round((L.p90_words || 30) * 1.4), (L.median_words || 12) * 2, 12),
  };
  const n = words(text).length;
  const tooLong = n > band.max;
  if (tooLong) problems.push('too_long');

  const kiss = kissAtEnd(text);
  if (style.kiss?.rate >= HABIT && style.kiss.token) {
    if (!kiss) problems.push('sign_off_missing');
    else if (kiss.toLowerCase() !== style.kiss.token.toLowerCase()) problems.push('sign_off_wrong');
  } else if (style.kiss?.rate <= NOT_A_HABIT && kiss) {
    problems.push('sign_off_unwanted');
  }

  const emojiFound = emojiIn(text);
  if (style.emoji?.rate_any <= NOT_A_HABIT && emojiFound.length) {
    problems.push('emoji_unwanted');
  } else if (style.emoji?.top?.length) {
    const allowed = Math.max(1, style.emoji.median_per_message || 1);
    if (emojiFound.length > allowed) problems.push('too_many_emoji');
    if (emojiFound.some(e => !style.emoji.top.includes(e))) problems.push('foreign_emoji');
  }

  if (style.ends_full_stop_rate <= NOT_A_HABIT && /\.\s*$/.test(text.replace(KISS_AT_END, ''))) {
    problems.push('terminal_full_stop');
  }
  if (style.lowercase_start_rate >= HABIT) {
    const first = text.match(/[a-zA-Z]/)?.[0];
    if (first && first !== first.toLowerCase()) problems.push('capitalised_start');
  }
  const bangs = (text.match(/!/g) || []).length;
  if (bangs > Math.max(style.exclamations?.max || 0, style.exclamations?.median || 0)) {
    problems.push('too_many_exclamations');
  }

  return { ok: problems.length === 0, problems, tooLong, band };
}

/**
 * Fix what can be fixed without a second model call.
 *
 * Every operation here is additive or subtractive at the very start or the very
 * end of the message, or removes a character. Nothing rewrites a sentence, so
 * this can never introduce a claim, a price or a time, which is what keeps the
 * reply-claims guard downstream meaningful.
 */
export function repairDraft(draft, style) {
  let text = String(draft || '').trim();
  if (!style || !style.sample_count || !text) return text;

  const { problems } = checkDraftStyle(text, style);

  if (problems.includes('emoji_unwanted')) {
    text = text.replace(EMOJI, '').replace(/\s{2,}/g, ' ').trim();
  } else if (problems.includes('foreign_emoji') || problems.includes('too_many_emoji')) {
    const allowedSet = new Set(style.emoji?.top || []);
    const budget = Math.max(1, style.emoji?.median_per_message || 1);
    let kept = 0;
    text = text.replace(EMOJI, (e) => {
      if (allowedSet.has(e) && kept < budget) { kept++; return e; }
      return '';
    }).replace(/\s{2,}/g, ' ').trim();
  }

  if (problems.includes('too_many_exclamations')) {
    const budget = Math.max(style.exclamations?.max || 0, style.exclamations?.median || 0);
    let seen = 0;
    text = text.replace(/!/g, () => (++seen <= budget ? '!' : ''));
  }

  if (problems.includes('sign_off_unwanted')) {
    text = text.replace(KISS_AT_END, '').trim();
  }
  if (problems.includes('sign_off_wrong')) {
    text = text.replace(KISS_AT_END, '').trim();
  }
  if (problems.includes('sign_off_missing') || problems.includes('sign_off_wrong')) {
    text = `${text.replace(/[\s.]+$/, '')} ${style.kiss.token}`.trim();
  }

  if (problems.includes('terminal_full_stop')) {
    // Only the final stop, and only when it is not part of an ellipsis, which
    // is a mannerism in its own right. The stop can sit BEFORE a kiss
    // ("all booked. xx"), so the kiss is lifted off and put back.
    const m = text.match(KISS_AT_END);
    if (m) {
      const head = text.slice(0, text.length - m[0].length).replace(/(?<!\.)\.\s*$/, '');
      text = `${head}${m[0]}`.trim();
    } else {
      text = text.replace(/(?<!\.)\.\s*$/, '').trim();
    }
  }

  if (problems.includes('capitalised_start')) {
    const firstWord = (text.match(/^[^\s]+/) || [''])[0].replace(/[^a-zA-Z']/g, '').toLowerCase();
    if (SAFE_TO_LOWERCASE.has(firstWord)) {
      text = text.replace(/[a-zA-Z]/, c => c.toLowerCase());
    }
  }

  return text;
}

/** Check, repair, check again. The text a caller should actually send on. */
export function styleFit(draft, style) {
  const repaired = repairDraft(draft, style);
  const verdict = checkDraftStyle(repaired, style);
  return { text: repaired, ...verdict };
}

/**
 * The extra instruction for the one retry we are willing to pay for. Only
 * length triggers it, because it is the only failure a rewrite fixes and an
 * edit does not.
 */
export function regenerationHint(band) {
  if (!band) return '';
  return `\nHARD LIMIT: your last attempt was too long for her. This message must be under ${band.max} words. Cut the explanation, not the warmth. She would not write more than that on her phone.`;
}

/* ────────────────────────────────────────────────────────────────────────
 * AUTHORSHIP
 * ──────────────────────────────────────────────────────────────────────── */

export const AUTHOR = {
  CLIENT: 'client',
  HUMAN: 'human',
  AI: 'ai',
  AI_EDITED: 'ai_edited',
  TEMPLATE: 'template',
  SYSTEM: 'system',
  UNKNOWN: 'unknown',
};

/** Character-level similarity, 0 to 1. Mirrors routes/inbox.js textSimilarity. */
function similarity(a, b) {
  const s1 = String(a || '').trim().toLowerCase();
  const s2 = String(b || '').trim().toLowerCase();
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  const m = s1.length;
  const n = s2.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s1[i - 1] === s2[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

/**
 * She tapped send in the inbox. Whose words went out?
 *
 * The inbox already passes the draft it offered her, so this is measured, not
 * assumed. The thresholds are the interesting part:
 *   identical  she sent Florrie's message. Florrie's words, not hers.
 *   >= 0.5     she edited a Florrie draft. Still anchored on Florrie's
 *              sentence, so still not safe to learn her voice from.
 *   <  0.5     she threw it away and wrote her own. That is hers.
 * The middle band is the one that matters: treating an edited draft as her own
 * writing is how a system slowly learns to sound like itself.
 */
export function authorshipForSend({ draft, sent }) {
  if (!draft || !String(draft).trim()) return AUTHOR.HUMAN;
  const flat = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  if (flat(draft) === flat(sent)) return AUTHOR.AI;
  return similarity(draft, sent) >= 0.5 ? AUTHOR.AI_EDITED : AUTHOR.HUMAN;
}

/**
 * Historical rows carry authored_by 'unknown' because nothing on them says who
 * wrote them. This is the filter that lets the bootstrap use SOME of them
 * without reopening the feedback loop: it removes anything shaped like machine
 * copy, and it is deliberately aggressive. Throwing away a real message of hers
 * costs one sample out of hundreds. Keeping a booking confirmation teaches her
 * to sound like a booking confirmation.
 */
export function looksAutomated(text) {
  const t = String(text || '');
  if (!t.trim()) return true;
  if (/https?:\/\/|www\.|florrie\.ai/i.test(t)) return true;   // she rarely pastes links, Florrie always does
  if (/\{name\}|\{business\}|\{\{\d\}\}/.test(t)) return true;  // an unrendered placeholder is a template, by definition
  if (/reply\s+stop\b/i.test(t)) return true;                   // PECR footer, only ever automated
  if (words(t).length > 60) return true;                        // nobody thumbs 60 words between clients
  return false;
}
