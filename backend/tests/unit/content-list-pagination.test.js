import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ rows: [], reads: [], failure: false }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));
vi.mock('../../src/lib/logger.js', () => ({ default: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('../../src/services/content-autopilot.js', () => ({ createPostFromPhoto: vi.fn(), publishPost: vi.fn(), draftAvailabilityPost: vi.fn(), generateCaption: vi.fn(), planWeek: vi.fn(), imageUrlProblem: vi.fn() }));
vi.mock('../../src/config.js', () => ({ supabase: { from(table) {
  const read = { table, filters: [], orders: [], range: null };
  state.reads.push(read);
  const query = {
    select() { return query; },
    eq(key, value) { read.filters.push(row => row[key] === value); return query; },
    in(key, values) { read.filters.push(row => values.includes(row[key])); return query; },
    or(value) { if (value === 'post_type.neq.gallery,post_type.is.null') read.filters.push(row => row.post_type !== 'gallery'); else throw new Error(`Unexpected filter ${value}`); return query; },
    order(key, { ascending }) { read.orders.push({ key, ascending }); return query; },
    range(from, to) { read.range = [from, to]; return query; },
    then(resolve) {
      if (state.failure) return Promise.resolve({ data: null, error: { message: 'Database unavailable' } }).then(resolve);
      const rows = state.rows.filter(row => read.filters.every(filter => filter(row)));
      rows.sort((a, b) => {
        for (const { key, ascending } of read.orders) {
          const value = String(a[key]).localeCompare(String(b[key]));
          if (value) return ascending ? value : -value;
        }
        return 0;
      });
      return Promise.resolve({ data: rows.slice(read.range[0], read.range[1] + 1), error: null }).then(resolve);
    },
  };
  return query;
} } }));

import router from '../../src/routes/content.js';
const id = n => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const post = (n, extra = {}) => ({ id: id(n), beautician_id: 'owner', status: 'posted', post_type: 'general', created_at: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(), ...extra });
async function list(query = {}) {
  const result = { status: 200 };
  const res = { status(code) { result.status = code; return res; }, json(body) { result.body = body; return res; } };
  const route = router.stack.find(layer => layer.route?.path === '/' && layer.route.methods.get).route;
  for (const layer of route.stack) {
    let next = false;
    await layer.handle({ beautician: { id: 'owner' }, query }, res, () => { next = true; });
    if (!next) break;
  }
  return result;
}

beforeEach(() => { state.rows = []; state.reads = []; state.failure = false; });

describe('Content list pagination and exact handoffs', () => {
  it('keeps an older draft reachable after thirty newer posted records', async () => {
    state.rows = [post(0, { status: 'draft' }), ...Array.from({ length: 35 }, (_, i) => post(i + 1))];
    const first = await list();
    expect(first.body.posts).toHaveLength(30);
    expect(first.body).toMatchObject({ has_more: true, next_offset: 30 });
    const second = await list({ offset: String(first.body.next_offset) });
    expect(second.body.posts.some(row => row.id === id(0))).toBe(true);
    expect(second.body).toMatchObject({ has_more: false, next_offset: null });
    expect(new Set([...first.body.posts, ...second.body.posts].map(row => row.id)).size).toBe(36);
  });

  it('loads unfinished posts oldest first without posted history crowding them out', async () => {
    state.rows = [post(0, { status: 'draft' }), post(1, { status: 'approved' }), post(2, { status: 'failed' }), post(3, { status: 'scheduled' }), ...Array.from({ length: 35 }, (_, i) => post(i + 4))];
    const result = await list({ bucket: 'pending' });
    expect(result.body.posts.map(row => row.status)).toEqual(['draft', 'approved', 'failed', 'scheduled']);
    expect(result.body.has_more).toBe(false);
  });

  it('keeps paging stable when records share a creation time', async () => {
    state.rows = [post(2), post(3), post(1)].map(row => ({ ...row, created_at: '2026-01-01T12:00:00Z' }));
    const a = await list({ limit: '2' });
    const b = await list({ limit: '2', offset: '2' });
    expect([...a.body.posts, ...b.body.posts].map(row => row.id)).toEqual([id(3), id(2), id(1)]);
  });

  it('supports status and collection filtering without counting other salons or gallery records', async () => {
    state.rows = [post(1, { status: 'draft', stream_id: 'collection', post_type: null }), post(2, { status: 'draft', stream_id: 'collection', beautician_id: 'other' }), post(3, { status: 'draft', stream_id: 'collection', post_type: 'gallery' }), post(4, { status: 'draft', stream_id: 'different' }), post(5, { stream_id: 'collection' })];
    const result = await list({ status: 'draft', stream_id: 'collection', limit: '1' });
    expect(result.body.posts.map(row => row.id)).toEqual([id(1)]);
    expect(result.body).toMatchObject({ has_more: false, next_offset: null });
  });

  it('opens an exact older post while preserving owner and gallery boundaries', async () => {
    state.rows = [post(0, { status: 'draft' }), ...Array.from({ length: 110 }, (_, i) => post(i + 1)), post(200, { beautician_id: 'other' }), post(201, { post_type: 'gallery' })];
    expect((await list({ post_id: id(0) })).body.posts.map(row => row.id)).toEqual([id(0)]);
    for (const value of [id(200), id(201), id(999)]) {
      expect((await list({ post_id: value })).body).toEqual({ posts: [], has_more: false, next_offset: null });
    }
  });

  it.each([
    { offset: '-1' }, { offset: '1.5' }, { offset: '100001' }, { offset: ['1', '2'] },
    { limit: '0' }, { limit: '101' }, { limit: '2oops' }, { limit: {} },
    { post_id: '../post' }, { post_id: [id(1)] }, { bucket: 'all' },
    { bucket: 'pending', status: 'draft' },
  ])('rejects malformed or unbounded list options %j', async query => {
    expect((await list(query)).status).toBe(400);
    expect(state.reads).toHaveLength(0);
  });

  it('rejects an unknown status instead of returning unrelated posts', async () => {
    expect((await list({ status: 'published' })).status).toBe(400);
  });

  it('reads at most one lookahead row beyond the requested limit', async () => {
    await list({ offset: '100', limit: '100' });
    expect(state.reads[0].range).toEqual([100, 200]);
  });

  it('reports a failed read without claiming an empty queue', async () => {
    state.failure = true;
    const result = await list();
    expect(result.status).toBe(500);
    expect(result.body.posts).toBeUndefined();
  });
});
