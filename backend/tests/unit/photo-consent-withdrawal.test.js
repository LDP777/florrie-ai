import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ db: {}, fail: false }));
vi.mock('../../src/config.js', () => ({ supabase: { from(table) {
  const filters = []; let write = null;
  const finish = () => {
    if (state.fail) return { data: null, error: { message: 'unavailable' } };
    const all = state.db[table] || [];
    let rows = all.filter(row => filters.every(([key, value]) => row[key] === value));
    if (write?.kind === 'insert') { rows = [{ id: 'consent', ...write.value }]; state.db[table] = [...all, ...rows]; }
    if (write?.kind === 'update') rows.forEach(row => Object.assign(row, write.value));
    return { data: rows[0] || null, error: null };
  };
  const q = { select: () => q, eq: (key, value) => { filters.push([key, value]); return q; },
    insert: value => { write = { kind: 'insert', value: Array.isArray(value) ? value[0] : value }; return q; },
    update: value => { write = { kind: 'update', value }; return q; },
    single: async () => finish(), then: (resolve, reject) => Promise.resolve().then(finish).then(resolve, reject),
  }; return q;
} } }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth: (req, res, next) => next() }));
vi.mock('../../src/middleware/validate.js', () => ({ validate: () => (req, res, next) => next() }));
vi.mock('../../src/lib/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import router from '../../src/routes/photo-consent.js';
async function run(method, path, body = {}, id = 'consent') {
  const req = { body, params: { id }, beautician: { id: 'owner' } };
  const result = { status: 200, body: null };
  const res = { status(code) { result.status = code; return res; }, json(body) { result.body = body; return res; } };
  const route = router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route;
  for (const layer of route.stack) { let next = false; await layer.handle(req, res, () => { next = true; }); if (!next) break; }
  return result;
}
beforeEach(() => {
  state.fail = false;
  state.db = { clients: [{ id: 'client', beautician_id: 'owner', first_name: 'Sarah', last_name: 'Jones' }], photo_consents: [] };
});
describe('photo consent withdrawal evidence', () => {
  it('records then withdraws without erasing scope, original notes or client label', async () => {
    const created = await run('post', '/', { client_id: 'client', permitted_uses: ['portfolio', 'instagram'], notes: 'Face must stay out of frame', method: 'paper' });
    expect(created.status).toBe(201); expect(created.body.data.client_name).toBe('Sarah Jones');
    const original = { ...state.db.photo_consents[0] };
    const result = await run('patch', '/:id/revoke', { notes: 'Client asked us to stop' });
    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({ status: 'declined', granted: false, permitted_uses: original.permitted_uses, method: 'paper', created_at: original.created_at });
    expect(result.body.data.notes).toBe('Face must stay out of frame\n\nWithdrawal: Client asked us to stop');
    expect(result.body.data.revoked_at).toBeTruthy();
  });
  it('preserves notes when no withdrawal note is supplied and removes active permission', async () => {
    state.db.photo_consents.push({ id: 'consent', beautician_id: 'owner', status: 'granted', granted: true, permitted_uses: ['training'], notes: 'Signed on paper' });
    const result = await run('patch', '/:id/revoke');
    expect(result.body.data).toMatchObject({ status: 'declined', granted: false, notes: 'Signed on paper', permitted_uses: ['training'] });
  });
  it('cannot withdraw or expose another salon’s consent', async () => {
    const foreign = { id: 'consent', beautician_id: 'other', status: 'granted', granted: true, permitted_uses: ['portfolio'], notes: 'Private evidence' };
    state.db.photo_consents.push(foreign);
    expect((await run('patch', '/:id/revoke', { notes: 'overwrite' })).status).toBe(404);
    expect(foreign.status).toBe('granted'); expect(foreign.notes).toBe('Private evidence');
  });
  it('preserves the original withdrawal timestamp on repeat requests', async () => {
    state.db.photo_consents.push({ id: 'consent', beautician_id: 'owner', status: 'declined', granted: false, permitted_uses: ['portfolio'], revoked_at: '2026-09-01T10:00:00Z' });
    expect((await run('patch', '/:id/revoke')).body.data.revoked_at).toBe('2026-09-01T10:00:00Z');
  });
});
