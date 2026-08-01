import { supabase } from '../config.js';
import logger from './logger.js';

/**
 * THE KNOWLEDGE BASE: Ellie's own notes, retrievable at reply time.
 *
 * Retrieval here is LEXICAL, not embeddings, and that is a decision, not a
 * shortcut. One beautician's knowledge base is dozens of entries, not
 * millions; keyword overlap over a few thousand words is instant, has no
 * moving parts, and needs no third party. There is also no embeddings API
 * key available (Anthropic does not offer embeddings), so a vector index
 * would mean a new vendor for a problem this small. If the bases ever grow
 * past what keyword scoring can rank, add an "embedding" column to
 * knowledge_entries (migration 019 left the schema ready) and swap the
 * scorer; nothing else in this file's contract changes.
 *
 * The other half of the design lives in renderKnowledgeBlock: the prompt
 * tells the model to answer ONLY from these notes, and to say it will check
 * and come back rather than guess. That mirrors the free-slots pattern
 * (lib/free-slots.js): give the model the truth, forbid everything else.
 * The reply-claims-guard still runs on the output downstream.
 */

const CATEGORIES = ['aftercare', 'policy', 'treatment', 'prep', 'faq', 'general'];

// Common words carry no signal; without this, "what is your ..." matches
// every entry equally and the ranking is noise.
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'at',
  'for', 'with', 'about', 'is', 'are', 'was', 'were', 'be', 'been', 'do',
  'does', 'did', 'can', 'could', 'will', 'would', 'should', 'i', 'me', 'my',
  'you', 'your', 'it', 'its', 'this', 'that', 'what', 'when', 'how', 'much',
  'many', 'have', 'has', 'had', 'get', 'got', 'am', 'pm', 'hi', 'hey',
  'hello', 'please', 'thanks', 'thank', 'just', 'so', 'im', 'ive', 'not',
  'no', 'yes', 'ok', 'okay', 'there', 'they', 'them', 'we', 'us', 'our',
]);

/** Lowercase words, punctuation stripped, stop words and single letters out. */
export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));
}

/**
 * Score one entry against the query tokens.
 * - Each query word found in the TITLE counts 3 (titles are dense signal:
 *   "Lash lift aftercare" matching "lash lift" is almost certainly the one).
 * - Each query word found only in the content counts 1.
 * - +2 if the query names the entry's category ("what's your cancellation
 *   POLICY", "AFTERCARE for my brows") or contains the entry's full title as
 *   a phrase, which is how clients name treatments ("lash lift").
 */
function scoreEntry(entry, queryTokens, queryText) {
  const titleSet = new Set(tokenize(entry.title));
  const contentSet = new Set(tokenize(entry.content));
  let score = 0;
  for (const tok of queryTokens) {
    if (titleSet.has(tok)) score += 3;
    else if (contentSet.has(tok)) score += 1;
  }
  const titlePhrase = tokenize(entry.title).join(' ');
  if (queryTokens.includes(entry.category) || (titlePhrase && queryText.includes(titlePhrase))) {
    score += 2;
  }
  return score;
}

/**
 * Fetch the beautician's active entries and pick the ones relevant to the
 * inbound message. Fails soft to [] on any error: a knowledge hiccup makes
 * Florrie cautious ("I'll check and come back to you"), never wrong.
 *
 * If the WHOLE base is 8 entries or fewer, all of it is returned regardless
 * of score: the entire thing fits in the prompt, and pretending to rank a
 * base that small is retrieval theatre that only risks dropping the answer.
 */
export async function retrieveKnowledge(beauticianId, query, { maxEntries = 5, maxChars = 3000 } = {}) {
  if (!beauticianId) return [];
  // Supabase's builder resolves with { data, error } rather than throwing.
  const { data, error } = await supabase
    .from('knowledge_entries')
    .select('id, category, title, content')
    .eq('beautician_id', beauticianId)
    .eq('is_active', true)
    .limit(200);
  if (error) {
    // Includes 42P01 before Levi runs migration 019 by hand: no table yet,
    // no knowledge, carry on without it.
    logger.warn({ err: error, beauticianId }, 'Knowledge fetch failed, replying without knowledge');
    return [];
  }
  const entries = data || [];
  if (entries.length === 0) return [];

  let picked;
  if (entries.length <= 8) {
    picked = entries;
  } else {
    const queryTokens = tokenize(query);
    const queryText = queryTokens.join(' ');
    picked = entries
      .map(e => ({ entry: e, score: scoreEntry(e, queryTokens, queryText) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxEntries)
      .map(x => x.entry);
  }

  // Char budget so a handful of long aftercare sheets cannot flood the
  // prompt. The entry that tips over the budget is truncated, not dropped:
  // half an aftercare sheet still beats none.
  const result = [];
  let used = 0;
  for (const e of picked) {
    const len = (e.title || '').length + (e.content || '').length;
    if (used + len <= maxChars) {
      result.push(e);
      used += len;
    } else {
      const room = maxChars - used - (e.title || '').length;
      if (room > 80) {
        result.push({ ...e, content: String(e.content || '').slice(0, room) });
      }
      break;
    }
  }
  return result;
}

/**
 * Render entries as a prompt block. Empty string when there is nothing,
 * so the template's ${...} vanishes cleanly like the other context blocks.
 */
export function renderKnowledgeBlock(entries) {
  if (!entries || entries.length === 0) return '';
  const lines = entries.map(e => {
    const oneLine = String(e.content || '').replace(/\s+/g, ' ').trim();
    return `- [${e.category}] ${String(e.title || '').trim()}: ${oneLine}`;
  });
  return `KNOWLEDGE (from the salon's own notes. Answer questions ONLY from this. If it does not cover the question, do not guess: say you will check and come back to them.)\n${lines.join('\n')}`;
}

export { CATEGORIES as KNOWLEDGE_CATEGORIES };
