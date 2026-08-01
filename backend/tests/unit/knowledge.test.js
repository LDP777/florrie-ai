/**
 * The knowledge base is what stands between "Florrie quotes Ellie's own
 * aftercare sheet" and "Florrie makes an aftercare sheet up". Retrieval is
 * lexical on purpose (a salon's base is dozens of entries; see
 * lib/knowledge.js for why not embeddings), so the scoring is simple enough
 * to test exhaustively, and it should stay that way.
 *
 * The supabase client is stubbed so this stays a pure logic test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = { rows: [], error: null };

// Minimal stub of the PostgREST builder: every filter returns `this`, and the
// terminal await resolves with { data, error } (Supabase does not throw).
vi.mock('../../src/config.js', () => {
  const b = {
    select: () => b, eq: () => b, gte: () => b, lte: () => b,
    lt: () => b, gt: () => b, not: () => b, order: () => b, limit: () => b,
    then: (resolve) => resolve({ data: state.error ? null : state.rows, error: state.error }),
  };
  return { supabase: { from: () => b } };
});

const { retrieveKnowledge, renderKnowledgeBlock, tokenize } = await import('../../src/lib/knowledge.js');

const entry = (id, category, title, content) => ({ id, category, title, content });

// Ten entries so the small-base "return everything" rule does NOT kick in
// and the scorer actually has to rank.
function bigBase() {
  return [
    entry('1', 'aftercare', 'Lash lift aftercare', 'Keep lashes dry for 24 hours, no mascara, no steam or saunas.'),
    entry('2', 'policy', 'Cancellation policy', 'Cancellations within 48 hours lose the deposit. No-shows are charged in full.'),
    entry('3', 'treatment', 'Brow lamination explained', 'Brows are set with a gentle solution, lasts six to eight weeks.'),
    entry('4', 'prep', 'Before your patch test', 'Come with clean skin, no retinol for 48 hours beforehand.'),
    entry('5', 'faq', 'Parking at the salon', 'Free parking on Mill Road, two minutes walk from the door.'),
    entry('6', 'general', 'Gift vouchers', 'Vouchers are valid for twelve months and can be used on any treatment.'),
    entry('7', 'aftercare', 'Brow tint aftercare', 'Avoid oil based cleansers for 48 hours so the tint settles.'),
    entry('8', 'faq', 'Do you take card', 'Yes, card and bank transfer, deposits are taken at booking.'),
    entry('9', 'treatment', 'Dermaplaning explained', 'Removes peach fuzz and dead skin, no downtime.'),
    entry('10', 'general', 'Opening hours', 'Tuesday to Saturday, nine until five.'),
  ];
}

beforeEach(() => { state.rows = []; state.error = null; });

describe('retrieveKnowledge', () => {
  it('prefers the relevant entry for the question asked', async () => {
    state.rows = bigBase();
    const out = await retrieveKnowledge('b1', 'can I wear mascara after my lash lift?');
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].id).toBe('1');
  });

  it('weights a title hit above a content hit', async () => {
    state.rows = [
      // Drop the existing parking entry so the comparison is clean.
      ...bigBase().filter(e => e.id !== '5'),
      // "parking" in the title vs "parking" buried in content of another.
      entry('t', 'faq', 'Parking', 'On Mill Road.'),
      entry('c', 'general', 'Getting here', 'Bus, train, and there is parking nearby too.'),
    ];
    const out = await retrieveKnowledge('b1', 'where is parking?');
    expect(out[0].id).toBe('t');
  });

  it('returns the whole base when it is small, regardless of score', async () => {
    state.rows = bigBase().slice(0, 3);
    const out = await retrieveKnowledge('b1', 'completely unrelated question about the weather');
    // 3 entries total: the whole base fits in the prompt, ranking it is theatre.
    expect(out.map(e => e.id).sort()).toEqual(['1', '2', '3']);
  });

  it('respects the character cap, truncating rather than flooding the prompt', async () => {
    const long = 'lash '.repeat(500); // 2500 chars, every word a query hit
    state.rows = [
      ...bigBase().slice(1),
      entry('a', 'aftercare', 'Lash lift aftercare', long),
      entry('b', 'aftercare', 'Lash extensions aftercare', long),
    ];
    const out = await retrieveKnowledge('b1', 'lash aftercare please', { maxChars: 3000 });
    const total = out.reduce((n, e) => n + e.title.length + e.content.length, 0);
    expect(total).toBeLessThanOrEqual(3000);
    expect(out.length).toBeGreaterThanOrEqual(1);
  });

  it('fails soft to [] when supabase reports an error (including missing table)', async () => {
    state.error = { code: '42P01', message: 'relation "knowledge_entries" does not exist' };
    expect(await retrieveKnowledge('b1', 'anything')).toEqual([]);
  });

  it('returns [] for an empty base and for a missing beautician id', async () => {
    expect(await retrieveKnowledge('b1', 'anything')).toEqual([]);
    expect(await retrieveKnowledge(null, 'anything')).toEqual([]);
  });
});

describe('renderKnowledgeBlock', () => {
  it('is an empty string when there is nothing, so the prompt line vanishes', () => {
    expect(renderKnowledgeBlock([])).toBe('');
    expect(renderKnowledgeBlock(null)).toBe('');
  });

  it('renders one line per entry with the grounding instruction on top', () => {
    const block = renderKnowledgeBlock([
      entry('1', 'aftercare', 'Lash lift aftercare', 'Keep dry\nfor 24 hours.'),
    ]);
    expect(block.startsWith('KNOWLEDGE (')).toBe(true);
    expect(block).toContain('ONLY from this');
    expect(block).toContain('say you will check and come back');
    // Content newlines collapsed: each entry stays on one line.
    expect(block).toContain('- [aftercare] Lash lift aftercare: Keep dry for 24 hours.');
  });
});

describe('tokenize', () => {
  it('lowercases, strips punctuation and drops noise words', () => {
    expect(tokenize("What's your CANCELLATION policy?!")).toEqual(['cancellation', 'policy']);
  });
});
