import { it, expect, vi } from 'vitest';
vi.mock('../../src/config.js', () => ({ supabase: {} }));
const { updateClientIntelligence } = await import('../../src/services/client-intelligence.js');

function database({ duplicate = false, fail = false } = {}) {
  const writes = [], calls = [];
  return { writes, calls, from(table) {
    const filters = [], q = {}; let patch;
    calls.push({ table, filters });
    for (const method of ['select', 'eq', 'order', 'limit']) q[method] = (...args) => { filters.push([method, ...args]); return q; };
    q.upsert = (payload, options) => { patch = payload; writes.push({ payload, options }); return q; };
    q.then = resolve => resolve({ error: patch && fail ? { code: 'write_failed' } : null, data: table === 'appointments' ? [] : duplicate ? [{ id: 'legacy' }, { id: 'duplicate' }] : [{ id: 'legacy' }] });
    return q;
  } };
}
it('updates derived fields on the existing primary key without replacing notes or clinical information', async () => {
  const db = database();
  await updateClientIntelligence('owner', 'client', { db });
  const { payload, options } = db.writes[0];
  expect(payload).toMatchObject({ id: 'legacy', beautician_id: 'owner', client_id: 'client' });
  expect(options.onConflict).toBe('id');
  expect(Object.keys(payload).sort()).toEqual(['id', 'beautician_id', 'client_id', 'rebooking_rhythm_days', 'rebooking_consistency', 'favourite_treatments', 'avg_spend_cents', 'next_predicted_visit', 'updated_at'].sort());
  for (const call of db.calls.filter(c => c.filters.length)) {
    expect(call.filters).toContainEqual(['eq', 'beautician_id', 'owner']);
    expect(call.filters).toContainEqual(['eq', 'client_id', 'client']);
  }
});
it('reports a failed save and refuses to choose between duplicate legacy records', async () => {
  await expect(updateClientIntelligence('o', 'c', { db: database({ fail: true }) })).rejects.toThrow('Could not save');
  const db = database({ duplicate: true });
  await expect(updateClientIntelligence('o', 'c', { db })).rejects.toThrow('Duplicate');
  expect(db.writes).toHaveLength(0);
});
