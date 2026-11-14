import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ rows: [], writes: [], failRead: false, failWrite: false }));
function builder() {
  const filters = []; let update;
  const matching = () => state.rows.filter(row => filters.every(fn => fn(row)));
  const settle = () => {
    if ((!update && state.failRead) || (update && state.failWrite)) return { data: null, error: { message: 'Synthetic storage outage' } };
    if (update) { state.writes.push({ patch: structuredClone(update), ids: matching().map(row => row.id) }); matching().forEach(row => Object.assign(row, update)); }
    return { data: structuredClone(matching()), error: null };
  };
  const chain = {
    select() { return chain; }, eq(key, value) { filters.push(row => row[key] === value); return chain; },
    gte(key, value) { filters.push(row => row[key] >= value); return chain; }, lte(key, value) { filters.push(row => row[key] <= value); return chain; },
    update(value) { update = value; return chain; },
    async maybeSingle() { const out = settle(); return { ...out, data: out.data?.[0] || null }; },
    then(resolve, reject) { return Promise.resolve(settle()).then(resolve, reject); },
  }; return chain;
}
vi.mock('../../src/config.js', () => ({ supabase: { from: table => {
  if (table !== 'hours_exceptions') throw new Error(`Block edit must not touch ${table}`);
  return builder();
} } }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));
vi.mock('../../src/lib/logger.js', () => ({ default: { error() {} } }));
const { default: router } = await import('../../src/routes/hours-exceptions.js');
const { loadBlocks, hitsBlock } = await import('../../src/lib/free-slots.js');
async function edit(body, id = 'block-owner', owner = 'owner') {
  const route = router.stack.find(layer => layer.route?.path === '/:id' && layer.route.methods.patch).route;
  const out = { status: 200, body: null };
  const response = { status(code) { out.status = code; return response; }, json(value) { out.body = value; return response; } };
  await route.stack.at(-1).handle({ body, params: { id }, beautician: { id: owner } }, response); return out;
}
const at = (day, time) => new Date(`${day}T${time}:00Z`);
beforeEach(() => {
  state.rows = [
    { id: 'block-owner', beautician_id: 'owner', date: '2026-08-08', end_date: null, type: 'amended', is_closed: false, start_time: '11:30:00', end_time: '12:30:00', custom_start: '11:30:00', custom_end: '12:30:00', reason: 'personal', note: 'School pickup', notify_clients: false, location_id: 'salon-a', created_at: '2026-07-01T12:00:00Z' },
    { id: 'block-other', beautician_id: 'other', date: '2026-08-08', type: 'closed', is_closed: true, reason: 'holiday', note: 'Private other owner' },
  ]; state.writes = []; state.failRead = false; state.failWrite = false;
});
describe('owner edits existing blocked time', () => {
  it('updates in place and public availability immediately follows the changed dates and times', async () => {
    const out = await edit({ date: '2026-08-09', end_date: '2026-08-10', start_time: '14:00', end_time: '15:00', reason: 'training', note: '  Course preparation  ' });
    expect(out.status).toBe(200);
    expect(out.body.exception).toMatchObject({ id: 'block-owner', beautician_id: 'owner', date: '2026-08-09', end_date: '2026-08-10', start_time: '14:00', end_time: '15:00', custom_start: '14:00', custom_end: '15:00', reason: 'training', note: 'Course preparation', location_id: 'salon-a', notify_clients: false, created_at: '2026-07-01T12:00:00Z' });
    expect(state.rows).toHaveLength(2);
    const blocks = await loadBlocks('owner', at('2026-08-08', '00:00'), at('2026-08-11', '23:59'));
    expect(hitsBlock(at('2026-08-08', '11:30'), at('2026-08-08', '12:00'), blocks)).toBe(false);
    for (const day of ['2026-08-09', '2026-08-10']) expect(hitsBlock(at(day, '14:15'), at(day, '14:45'), blocks)).toBe(true);
    expect(hitsBlock(at('2026-08-09', '15:00'), at('2026-08-09', '16:00'), blocks)).toBe(false);
  });
  it('converts all-day blocks, clears stale times and requires valid times when returning to a range', async () => {
    expect((await edit({ type: 'closed', note: '' })).status).toBe(200);
    expect(state.rows[0]).toMatchObject({ is_closed: true, start_time: null, end_time: null, custom_start: null, custom_end: null, note: null });
    expect((await edit({ type: 'amended' })).status).toBe(400);
    expect((await edit({ type: 'amended', start_time: '09:00', end_time: '10:00' })).status).toBe(200);
    expect(state.rows[0].is_closed).toBe(false);
  });
  it('keeps legacy times editable and preserves an unchanged multi-day range', async () => {
    Object.assign(state.rows[0], { type: null, is_closed: false, start_time: null, end_time: null, end_date: '2026-08-12' });
    expect((await edit({ note: 'Updated note' })).status).toBe(200);
    expect(state.rows[0]).toMatchObject({ type: 'amended', start_time: '11:30:00', end_time: '12:30:00', end_date: '2026-08-12' });
  });
  it('isolates owners and refuses identity and notification overrides', async () => {
    const original = structuredClone(state.rows);
    expect((await edit({ note: 'Wrong owner' }, 'block-other')).status).toBe(404);
    for (const key of ['id', 'beautician_id', 'location_id', 'notify_clients', 'is_closed']) expect((await edit({ [key]: 'override' })).status).toBe(400);
    expect(state.rows).toEqual(original); expect(state.writes).toEqual([]);
  });
  it.each([{ date: '2026-02-30' }, { date: '08/08/2026' }, { end_date: '2026-08-07' }, { end_date: 'tomorrow' }, { start_time: '24:00' }, { end_time: '11:30' }, { end_time: '10:00' }, { type: 'open' }, { reason: '' }, { reason: { key: 'personal' } }, { note: 'a'.repeat(2001) }, { note: { private: true } }, {}])('rejects invalid edits atomically: %j', async body => {
    const original = structuredClone(state.rows); expect((await edit(body)).status).toBe(400);
    expect(state.rows).toEqual(original); expect(state.writes).toEqual([]);
  });
  it('retains records and returns failure when storage read or update fails', async () => {
    const original = structuredClone(state.rows);
    state.failRead = true; expect((await edit({ note: 'New note' })).status).toBe(500);
    state.failRead = false; state.failWrite = true; expect((await edit({ note: 'New note' })).status).toBe(500);
    expect(state.rows).toEqual(original); expect(state.writes).toEqual([]);
  });
});
