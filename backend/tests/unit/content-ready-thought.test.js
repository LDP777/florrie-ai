import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/config.js', () => ({ supabase: {} }));
import { contentReadyThought } from '../../src/services/content-ready-thought.js';

// content_posts columns are declared in 001, backend025 and Content v2.
const columns = new Set(['id','beautician_id','status','post_type','kind','deleted_at','publish_claimed_at','created_at']);
function fake(rows, fail = false) {
  return { from(table) {
    expect(table).toBe('content_posts');
    const filters = []; let countRequested = false;
    const column = key => { if (!columns.has(key)) throw new Error(`42703: unknown column ${key}`); };
    const q = {
      select(key, options) { column(key); countRequested = options.count === 'exact'; return q; },
      eq(key, value) { column(key); filters.push(row => row[key] === value); return q; },
      neq(key, value) { column(key); filters.push(row => row[key] !== value); return q; },
      is(key, value) { column(key); filters.push(row => (row[key] ?? null) === value); return q; },
      order(key) { column(key); return q; }, limit() { return q; },
      then(resolve, reject) { const found = rows.filter(row => filters.every(filter => filter(row))); return Promise.resolve({ data: found.slice(0, 1), count: countRequested ? found.length : null, error: fail ? { code: '42703' } : null }).then(resolve, reject); },
    }; return q;
  } };
}
const owner = { id: 'fictional-salon', content_v2: true };
const ready = id => ({ id, beautician_id: owner.id, status: 'draft', post_type: 'general', kind: 'post' });
describe('Content ready suggestion', () => {
  it('counts only the owner’s posts to check and opens the existing deck route', async () => {
    const cards = await contentReadyThought(owner, { db: fake([ready('a'), ready('b'), ready('c'),
      { ...ready('other'), beautician_id: 'another-salon' }, { ...ready('photo'), post_type: 'gallery' },
      { ...ready('reel'), kind: 'reel_plan' }, { ...ready('removed'), deleted_at: '2026-11-22T12:00:00Z' },
      { ...ready('publishing'), publish_claimed_at: '2026-11-22T12:00:00Z' }]) });
    expect(cards).toHaveLength(1); expect(cards[0].title).toBe('3 posts ready to check');
    expect(cards[0].action).toEqual({ kind: 'navigate' }); expect(cards[0].link_to).toBe('/content?view=drafts');
  });
  it('does not query for salons outside the rollout', async () => {
    const db = { from: vi.fn() }; expect(await contentReadyThought({ id: owner.id }, { db })).toEqual([]); expect(db.from).not.toHaveBeenCalled();
  });
  it('keeps failed reads distinct from an empty queue', async () => {
    expect(await contentReadyThought(owner, { db: fake([]) })).toEqual([]);
    await expect(contentReadyThought(owner, { db: fake([], true) })).rejects.toThrow('Could not check');
  });
});
