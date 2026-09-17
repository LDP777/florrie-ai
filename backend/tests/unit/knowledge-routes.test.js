import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
const state = vi.hoisted(() => ({ rows: [], writes: [], preview: vi.fn() }));
vi.mock('../../src/services/ai-front-desk.js', () => ({ previewClientQuestion: state.preview }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth(req, res, next) {
  if (req.headers.authorization !== 'Bearer owner') return res.status(401).json({ error: 'Unauthorized' });
  req.beautician = { id: 'owner', first_name: 'Alex' }; next();
} }));
vi.mock('../../src/config.js', () => ({ supabase: { from(table) {
  const filters = []; let update, insert, single = false;
  const q = { select: () => q, order: () => q,
    eq: (key, value) => { filters.push([key, value]); return q; },
    update: value => { update = value; return q; },
    insert: value => { insert = value; return q; },
    single: () => { single = true; return q; },
    then: resolve => {
      let rows = state.rows.filter(row => filters.every(([key, value]) => row[key] === value));
      if (insert) { rows = insert.map(row => ({ id: `new-${state.rows.length}`, is_active: true, ...row })); state.rows.push(...rows); }
      if (update) rows.forEach(row => Object.assign(row, update));
      if (insert || update) state.writes.push({ table, insert, update, filters });
      resolve(single && !rows.length ? { data: null, error: { code: 'PGRST116' } } : { data: single ? rows[0] : rows, error: null });
    },
  }; return q;
} } }));
const { default: router } = await import('../../src/routes/knowledge.js');
let server, base;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/api/knowledge', router);
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/knowledge`;
});
afterAll(() => new Promise(resolve => server.close(resolve)));
beforeEach(() => { state.rows = []; state.writes = []; state.preview.mockReset(); });
const call = (path, body, method = 'POST', token = 'owner') => fetch(base + path, {
  method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body),
});

describe('approved knowledge and private preview', () => {
  it('previews only for the authenticated owner and does not write or expose extra pipeline fields', async () => {
    state.preview.mockResolvedValue({ reply: 'Dates open two months ahead.', canAnswer: true, reason: 'policy', sources: [{ id: 'rule', title: 'Booking dates', category: 'policy', private_value: 'hidden' }], secret: 'hidden' });
    const response = await call('/preview', { question: '  When do dates open?  ', beautician_id: 'victim', client_id: 'victim-client' });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(state.preview).toHaveBeenCalledExactlyOnceWith({ beautician: { id: 'owner', first_name: 'Alex' }, question: 'When do dates open?' });
    expect(await response.json()).toEqual({ reply: 'Dates open two months ahead.', canAnswer: true, reason: 'policy', sources: [{ id: 'rule', title: 'Booking dates', category: 'policy' }] });
    expect(state.writes).toEqual([]);
  });
  it('rejects missing auth and malformed or oversized questions before the pipeline', async () => {
    expect((await call('/preview', { question: 'Hello' }, 'POST', 'wrong')).status).toBe(401);
    for (const question of [undefined, null, 3, {}, '', '   ', 'x'.repeat(1001)]) expect((await call('/preview', { question })).status).toBe(400);
    expect(state.preview).not.toHaveBeenCalled(); expect(state.writes).toEqual([]);
  });
  it('shows missing guidance as unavailable, not a fabricated successful answer', async () => {
    state.preview.mockResolvedValue({ reply: null, canAnswer: false, reason: 'no_knowledge_match', sources: [] });
    const response = await call('/preview', { question: 'Can I have treatment again?' });
    expect(await response.json()).toEqual({ reply: null, canAnswer: false, reason: 'no_knowledge_match', sources: [] });
    state.preview.mockRejectedValue(new Error('provider error with private details'));
    const failed = await call('/preview', { question: 'Try again?' });
    expect(failed.status).toBe(503); expect(JSON.stringify(await failed.json())).not.toContain('private details');
    state.preview.mockResolvedValue({ canAnswer: false, reason: 'training:answer_unavailable', sources: [] });
    const unavailable = await call('/preview', { question: 'Try again?' });
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).error).toContain('saved answers are unchanged');
  });
  it('saves approved answers under the owner and permits pause, edit while paused, and resume', async () => {
    const created = await call('', { category: 'faq', title: '  Booking dates? ', content: ' Two months ahead. ', beautician_id: 'victim' });
    const { entry } = await created.json(); expect(created.status).toBe(201); expect(entry.beautician_id).toBe('owner');
    expect(entry.title).toBe('Booking dates?'); expect(entry.content).toBe('Two months ahead.');
    expect((await (await call(`/${entry.id}`, { is_active: false }, 'PATCH')).json()).entry.is_active).toBe(false);
    const edited = await (await call(`/${entry.id}`, { content: 'Check current diary settings.' }, 'PATCH')).json();
    expect(edited.entry.is_active).toBe(false);
    expect((await (await call(`/${entry.id}`, { is_active: true }, 'PATCH')).json()).entry.is_active).toBe(true);
  });
  it('cannot change another salon answer or enable a note using a truthy string', async () => {
    state.rows = [{ id: 'other-note', beautician_id: 'victim', content: 'Private', is_active: false }];
    expect((await call('/other-note', { is_active: 'false' }, 'PATCH')).status).toBe(400);
    expect((await call('/other-note', { is_active: true }, 'PATCH')).status).toBe(404);
    expect(state.rows[0].is_active).toBe(false);
    expect(await (await call('', undefined, 'GET')).json()).toEqual({ entries: [] });
  });
});
