import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ db: {}, fail: null, writes: [] }));
vi.mock('../../src/config.js', () => ({ supabase: { from(table) {
  const filters = []; let payload, remove = false, one = false;
  const query = {
    select: () => query, order: () => query,
    eq: (key, value) => { filters.push(row => row[key] === value); return query; },
    gte: (key, value) => { filters.push(row => row[key] >= value); return query; },
    lte: (key, value) => { filters.push(row => row[key] <= value); return query; },
    not: (key, _op, value) => { const values = value.replace(/[()]/g, '').split(','); filters.push(row => !values.includes(row[key])); return query; },
    upsert: rows => { payload = rows; return query; }, delete: () => { remove = true; return query; },
    then(resolve, reject) {
      if (state.fail === table) return Promise.resolve({ data: null, error: { message: 'Storage unavailable' } }).then(resolve, reject);
      const rows = state.db[table] || []; let result;
      if (payload) {
        state.writes.push({ table, rows: structuredClone(payload) });
        for (const row of payload) { const old = rows.find(item => item.beautician_id === row.beautician_id && item.date === row.date); if (old) Object.assign(old, row); else rows.push({ ...row }); }
        state.db[table] = rows; result = payload;
      } else if (remove) { state.db[table] = rows.filter(row => !filters.every(f => f(row))); result = []; }
      else result = rows.filter(row => filters.every(f => f(row)));
      return Promise.resolve({ data: structuredClone(result), count: result.length, error: null }).then(resolve, reject);
    },
  }; return query;
} } }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));
vi.mock('../../src/lib/logger.js', () => ({ default: { error() {} } }));
const { default: router } = await import('../../src/routes/working-hours.js');
const { getFreeSlots } = await import('../../src/lib/free-slots.js');
const { loadDateHours } = await import('../../src/lib/date-working-hours.js');
const { effectiveHours } = await import('../../src/lib/effective-hours.js');
const day = '2026-11-23', weekly = { mon: { start: '09:00', end: '17:00' } };
const values = { dates: [day, '2026-11-25'], start_time: '09:00', end_time: '20:00' };
const slots = (date = day, options = {}) => getFreeSlots('owner', { workingHours: weekly, fromWall: new Date(`${date}T00:00:00Z`), days: 1, leadHours: 0, durationMinutes: 60, ...options });
async function request(method, path, body = {}, params = {}, owner = 'owner', query = {}) {
  const handler = router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route.stack.at(-1).handle;
  const result = { status: 200 }; const response = { status(code) { result.status = code; return response; }, json(data) { result.body = data; return response; } };
  await handler({ beautician: { id: owner }, body, params, query }, response); return result;
}
beforeEach(() => { state.db = { date_working_hours: [], hours_exceptions: [], appointments: [] }; state.fail = null; state.writes = []; });

describe('one-off opening hours reach the real availability engine', () => {
  it('saves several dates atomically, extends an evening and opens a normally closed Wednesday', async () => {
    expect((await request('put', '/dates', values)).status).toBe(200);
    expect(state.writes).toHaveLength(1); expect(state.writes[0].rows).toHaveLength(2);
    expect((await slots()).at(-1).time).toBe('19:00');
    expect((await slots('2026-11-25')).at(-1).time).toBe('19:00');
    expect((await slots('2026-11-30')).at(-1).time).toBe('16:00');
    expect(await slots('2026-12-02')).toEqual([]);
  });
  it('honours appointments, buffer and personal breaks within the extra hours', async () => {
    await request('put', '/dates', values);
    state.db.appointments.push({ beautician_id: 'owner', id: 'busy', status: 'confirmed', starts_at: `${day}T17:00:00Z`, ends_at: `${day}T18:00:00Z` });
    state.db.hours_exceptions.push({ beautician_id: 'owner', date: day, type: 'amended', start_time: '18:30', end_time: '19:00' });
    const times = (await slots(day, { durationMinutes: 75 })).map(row => row.time);
    expect(times).not.toContain('17:00'); expect(times).not.toContain('18:00'); expect(times).not.toContain('19:00');
    expect(times).toContain('15:45');
    expect(state.db.appointments[0].starts_at).toBe(`${day}T17:00:00Z`);
  });
  it('does not reopen a holiday or reinterpret an existing extended block', async () => {
    await request('put', '/dates', values);
    state.db.hours_exceptions.push({ beautician_id: 'owner', date: '2026-11-22', end_date: '2026-11-24', type: 'closed' });
    expect(await slots()).toEqual([]);
    state.db.hours_exceptions = [{ beautician_id: 'owner', date: day, type: 'extended', start_time: '17:00', end_time: '20:00' }];
    expect((await slots()).at(-1).time).toBe('16:00');
  });
  it('restores the usual day without changing other dates or the weekly schedule', async () => {
    await request('put', '/dates', values);
    expect((await request('delete', '/dates/:date', {}, { date: day })).body.restored).toBe(day);
    expect((await slots()).at(-1).time).toBe('16:00');
    expect((await slots('2026-11-25')).at(-1).time).toBe('19:00');
    expect(weekly).toEqual({ mon: { start: '09:00', end: '17:00' } });
  });
  it('does not offer times if the dated hours cannot be read', async () => {
    state.fail = 'date_working_hours';
    await expect(slots()).rejects.toThrow('Could not check the hours');
    expect((await request('put', '/dates', values)).status).toBe(503);
    expect(state.writes).toEqual([]);
  });
  it('uses salon date fields across the British clock change', () => {
    const dates = [{ date: '2027-03-28', start_time: '10:00:00', end_time: '19:00:00' }];
    expect(effectiveHours({}, '2027-03-28', dates)).toEqual({ start: '10:00', end: '19:00' });
    expect(effectiveHours({}, '2027-03-29', dates)).toBeNull();
  });
  it('respects a closed weekday even when legacy keys remain', () => {
    expect(effectiveHours({ mon: null, Mon: { start: '09:00', end: '17:00' } }, day)).toBeNull();
    expect(effectiveHours({ Mon: { start: '09:00', end: '17:00' } }, day)).toEqual({ start: '09:00', end: '17:00' });
    expect(() => effectiveHours({}, day, [{ date: day, start_time: '09:00', end_time: '09:00:00' }])).toThrow();
  });
});

describe('dated hours validation and ownership', () => {
  it.each([
    { ...values, beautician_id: 'other' }, { ...values, dates: [] }, { ...values, dates: [day, day] },
    { ...values, dates: ['2026-02-30'] }, { ...values, start_time: '24:00' },
    { ...values, start_time: '20:00', end_time: '09:00' }, { ...values, end_time: '09:00' },
    { ...values, end_time: '09:00:00' }, { ...values, end_time: '20:00:01' },
  ])('refuses invalid input without saving %j', async body => {
    expect((await request('put', '/dates', body)).status).toBe(400); expect(state.writes).toEqual([]);
  });
  it('reads, changes and removes only the signed-in salon’s dated hours', async () => {
    await request('put', '/dates', values, {}, 'other');
    expect(await loadDateHours('owner', day, '2026-11-25')).toEqual([]);
    await request('put', '/dates', { ...values, end_time: '18:00' });
    await request('delete', '/dates/:date', {}, { date: day });
    expect((await loadDateHours('other', day))[0].end_time).toBe('20:00');
    expect(state.db.date_working_hours).toHaveLength(3);
  });
});
