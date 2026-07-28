/**
 * getFreeSlots is now the single source of truth for what times Florrie is
 * allowed to say out loud: the claims guard checks her replies against it. An
 * off-by-one here silently narrows what she can offer, or worse, lets through a
 * time that is not really free. That is the 28 Jul incident again.
 *
 * The supabase client is stubbed so this stays a pure logic test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const appointments = [];
const exceptions = [];

// Minimal stub of the PostgREST builder: every filter returns `this`, and the
// terminal await resolves with whichever table was selected.
vi.mock('../../src/config.js', () => {
  const builder = (rows) => {
    const b = {
      select: () => b, eq: () => b, gte: () => b, lte: () => b,
      lt: () => b, gt: () => b, not: () => b, order: () => b, limit: () => b,
      then: (resolve) => resolve({ data: rows, error: null }),
    };
    return b;
  };
  return {
    supabase: { from: (table) => builder(table === 'appointments' ? appointments : exceptions) },
  };
});

const { getFreeSlots } = await import('../../src/lib/free-slots.js');

const HOURS = {
  mon: { start: '09:00', end: '17:00' },
  tue: { start: '09:00', end: '17:00' },
  wed: { start: '09:00', end: '17:00' },
  thu: { start: '09:00', end: '17:00' },
  fri: { start: '09:00', end: '17:00' },
  sat: null,
  sun: null,
};

// A Thursday, in the wall frame.
const THU = new Date('2026-07-30T08:00:00.000Z');

const run = (opts = {}) => getFreeSlots('b1', {
  workingHours: HOURS, fromWall: THU, days: 1, leadHours: 0, durationMinutes: 60, ...opts,
});

beforeEach(() => { appointments.length = 0; exceptions.length = 0; });

describe('getFreeSlots', () => {
  it('returns wall-clock times, never converted', async () => {
    const slots = await run();
    // If anything Intl-converted, these would shift by an hour in BST.
    expect(slots[0].time).toBe('09:00');
    expect(slots[0].date).toBe('2026-07-30');
    expect(slots.every(s => s.time === s.iso.slice(11, 16))).toBe(true);
  });

  it('stops early enough for the treatment to finish before closing', async () => {
    const slots = await run();
    // 17:00 close, 60 minute treatment, so the last start is 16:00.
    expect(slots[slots.length - 1].time).toBe('16:00');
  });

  it('does not offer a slot that overlaps an existing appointment', async () => {
    appointments.push({ starts_at: '2026-07-30T10:00:00.000Z', ends_at: '2026-07-30T11:00:00.000Z' });
    const times = (await run()).map(s => s.time);
    // A 60 minute slot starting anywhere from 09:15 to 10:45 would collide.
    expect(times).toContain('09:00');
    expect(times).not.toContain('09:15');
    expect(times).not.toContain('10:00');
    expect(times).not.toContain('10:45');
    expect(times).toContain('11:00');
  });

  it('respects a partial block, which is what the AI path never used to see', async () => {
    exceptions.push({ date: '2026-07-30', type: 'block', start_time: '12:00', end_time: '14:00' });
    const times = (await run()).map(s => s.time);
    expect(times).not.toContain('12:00');
    expect(times).not.toContain('13:45');
    expect(times).toContain('14:00');
  });

  it('returns nothing at all on a closed day', async () => {
    exceptions.push({ date: '2026-07-30', type: 'closed' });
    expect(await run()).toEqual([]);
  });

  it('returns nothing when the salon does not work that day', async () => {
    // Saturday.
    expect(await run({ fromWall: new Date('2026-08-01T08:00:00.000Z') })).toEqual([]);
  });

  it('honours the lead time so she cannot offer a slot ten minutes away', async () => {
    const slots = await run({ leadHours: 2 });
    expect(slots[0].time).toBe('10:00');
  });
});
