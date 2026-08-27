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

/*
 * 'arrival' was added on 27 Aug 2026 and it is the highest value entry a salon
 * can write. That morning a client sent "Im 60 seconds away!" and Florrie
 * answered on her own with "Oh I'm ready! I'll come get you xx". A minute later
 * Ellie wrote over the top of her, to a client already on the step: "Come
 * through when you're here! It's a bit hectic with the festival staff".
 *
 * Read Ellie's sentence again. A correct answer to a doorstep message EXISTS
 * and it is sayable. Florrie's failure was not that she spoke, it was that she
 * spoke from nothing: she cannot see the room, so "I'm ready" was invented, and
 * she has no body in the building, so "I'll come get you" was a promise Ellie
 * then had to contradict.
 *
 * So the fix is the shape this file already is, and lib/free-slots.js already
 * is: give the model the truth and forbid everything else. The owner writes
 * "Come through when you get here, no need to knock. Parking is on Mill
 * Street." ONCE, and every client at the door gets that answer in her words, in
 * one second, while she is still holding a brush. With no such note, Florrie
 * says nothing and the owner is buzzed instead (services/push-notifications.js,
 * pushAtTheDoor), which is the only honest thing left.
 *
 * Anything not in the note is still refused, by facet, in
 * lib/reply-claims-guard.js: a note about parking does not license "come
 * through".
 *
 * The database CHECK constraint on this column has to agree with this array or
 * an insert fails with 23514. See 20260827_backend022_knowledge_arrival.sql.
 */
const CATEGORIES = ['arrival', 'aftercare', 'policy', 'treatment', 'prep', 'faq', 'general'];

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
 *
 * `alwaysInclude` is a list of categories the CALLER knows are relevant, for
 * the case where the scorer cannot possibly know it. Scoring here is keyword
 * overlap, and "Im 60 seconds away!" shares not one word with "Come through
 * when you get here, no need to knock", so on a base of any size the one entry
 * that answers the message scores zero and is filtered out before it is ever
 * ranked. The caller can see it is a doorstep message (lib/grounded-reply.js,
 * atTheDoorPhrase) and says so. Forced entries are hoisted to the FRONT, which
 * is also what keeps the char budget below from being the thing that drops
 * them: that loop stops at the first entry it cannot fit.
 */
export async function retrieveKnowledge(beauticianId, query, { maxEntries = 5, maxChars = 3000, alwaysInclude = [] } = {}) {
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

  // Forced first, and taken out of the ranking so a forced entry can never
  // also occupy one of the scored slots.
  const forcedCategories = new Set(alwaysInclude || []);
  const forced = forcedCategories.size
    ? entries.filter(e => forcedCategories.has(e.category))
    : [];
  const forcedIds = new Set(forced.map(e => e.id));
  const rest = forced.length ? entries.filter(e => !forcedIds.has(e.id)) : entries;

  let picked;
  if (entries.length <= 8) {
    picked = [...forced, ...rest];
  } else {
    const queryTokens = tokenize(query);
    const queryText = queryTokens.join(' ');
    const ranked = rest
      .map(e => ({ entry: e, score: scoreEntry(e, queryTokens, queryText) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(x => x.entry);
    // maxEntries is still the ceiling, but a forced entry is never the one
    // given up to stay under it: it is the reason the caller asked at all.
    picked = [...forced, ...ranked.slice(0, Math.max(0, maxEntries - forced.length))];
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

/**
 * The salon's arrival instruction, as one string, or '' when she has not
 * written one.
 *
 * This is the evidence flag for the doorstep case, and it is a STRING rather
 * than a boolean on purpose: lib/reply-claims-guard.js reads the words to
 * decide, facet by facet, which parts of an answer the note actually covers.
 * A note about parking must not license "come through", so a boolean would
 * throw away the only thing that can tell them apart.
 *
 * Content only, never the title. "When you arrive" is a heading Ellie picked
 * from a starter chip, not something she said to a client.
 *
 * @param {Array<{category: string, content: string, is_active?: boolean}>} entries
 * @returns {string}
 */
export function arrivalNoteFrom(entries) {
  return (entries || [])
    .filter(e => e && e.category === 'arrival' && e.is_active !== false)
    .map(e => String(e.content || '').trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * EVERYTHING she has written, as one string, for the claims guard.
 *
 * The GATE that decides whether Florrie may speak to somebody at the door reads
 * arrivalNoteFrom above, and only the arrival category, because that is the
 * entry the owner wrote for exactly this moment.
 *
 * The GUARD that checks the wording on the way out is a different question and
 * wants a wider answer. Its facets cover where to park, where to wait and which
 * floor it is, and a salon that documented its parking under 'faq' in March
 * wrote those words just as deliberately as one that wrote them under 'arrival'
 * in August. Handing the guard the arrival note alone would refuse "free
 * parking on Mill Road" on an ordinary "is there parking near you?", which is a
 * question that has nothing to do with a doorstep and an answer that came
 * straight out of her own notes.
 *
 * Facet isolation is unaffected: the facets are independent of each other, so
 * notes about parking still license nothing about a door.
 */
export function writtenNotesFrom(entries) {
  return (entries || [])
    .filter(e => e && e.is_active !== false)
    .map(e => String(e.content || '').trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * The same notes, read straight from the table, for the callers that hold a
 * beautician id and no retrieved entries: the two SEND BOUNDARIES
 * (routes/escalations.js, routes/outbound.js).
 *
 * Those matter. A doorstep draft is written with the note in hand and then sits
 * in a row until Ellie taps send, and the boundary guard re-checks it from
 * scratch. Without this, the one draft in the system that is fully backed by
 * her own written instruction would be the one refused on the way out.
 *
 * Fails soft to '', which is the cautious direction: no notes means the facet
 * gate refuses the arrival wording rather than waving it through.
 */
export async function fetchWrittenNotes(beauticianId) {
  if (!beauticianId) return '';
  // Supabase's builder resolves with { data, error } rather than throwing, and
  // a select naming a column that does not exist rejects the WHOLE statement.
  const { data, error } = await supabase
    .from('knowledge_entries')
    .select('id, category, title, content')
    .eq('beautician_id', beauticianId)
    .eq('is_active', true)
    .limit(200);
  if (error) {
    // 42P01 before migration 019 is run by hand: no table, no notes, carry on.
    logger.warn({ err: error, beauticianId }, 'Knowledge fetch failed at the send boundary, treating her notes as unwritten');
    return '';
  }
  return writtenNotesFrom(data || []);
}

export { CATEGORIES as KNOWLEDGE_CATEGORIES };
