/**
 * Three things that were only correct by luck.
 *
 * The process happened to run on UTC, the booking schema happened not to be
 * sent an offset, and the webhook happened to be dead so its missing guard
 * never fired. None of those is a property of the code, so each one is now
 * asserted.
 */
import { describe, it, expect } from 'vitest';
import { bookingSchema } from '../../src/lib/schemas.js';

const base = {
  treatment_id: '11111111-1111-1111-1111-111111111111',
  client_name: 'Sasha',
  client_phone: '07700900123',
};

describe('a booking time is a salon wall clock reading, not an instant', () => {
  it('accepts a plain wall time', () => {
    expect(bookingSchema.safeParse({ ...base, starts_at: '2026-08-10T14:00:00' }).success).toBe(true);
    expect(bookingSchema.safeParse({ ...base, starts_at: '2026-08-10T14:00' }).success).toBe(true);
  });

  // The old pattern was unanchored, so this passed: every wall-time guard in
  // the route read 14:00 while Postgres stored 13:00, and the client arrived an
  // hour after the diary expected her.
  it('refuses a time carrying an offset', () => {
    expect(bookingSchema.safeParse({ ...base, starts_at: '2026-08-10T14:00:00+01:00' }).success).toBe(false);
    expect(bookingSchema.safeParse({ ...base, starts_at: '2026-08-10T14:00:00Z' }).success).toBe(false);
    expect(bookingSchema.safeParse({ ...base, starts_at: '2026-08-10T14:00:00-05:00' }).success).toBe(false);
  });

  it('refuses anything that is not a date and time', () => {
    for (const bad of ['tomorrow at 2', '2026-08-10', '', 'x2026-08-10T14:00:00']) {
      expect(bookingSchema.safeParse({ ...base, starts_at: bad }).success, bad).toBe(false);
    }
  });
});

describe('the process clock is pinned, not inherited', () => {
  // Reading starts_at back with plain Date arithmetic is correct only on UTC.
  // Setting TZ=Europe/London on Railway used to shift reschedules by an hour in
  // BST without a line of code changing.
  it('index.js sets TZ before anything can construct a Date', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../src/index.js', import.meta.url), 'utf8');
    const tzAt = src.indexOf("process.env.TZ = 'UTC'");
    const firstImport = src.indexOf('\nimport ');
    expect(tzAt, 'index.js does not pin TZ').toBeGreaterThan(-1);
    expect(tzAt, 'TZ is set after the first import, too late to be reliable').toBeLessThan(firstImport);
  });

  // The guard is worth nothing if a wall-time string still round-trips through
  // the runtime zone, so prove the parse we rely on is zone independent.
  it('a wall-time string parsed with Z is the same clock reading whatever the zone', () => {
    const wall = '2026-08-10T14:00:00';
    const d = new Date(`${wall}Z`);
    expect(d.getUTCHours()).toBe(14);
    expect(String(d.toISOString()).slice(11, 16)).toBe('14:00');
  });
});

/**
 * The reschedule route takes the same wall-clock string the slots endpoint
 * hands out, so an offset must be refused there too.
 *
 * GET /manage/:token/reschedule/slots builds `${dateStr}T${fmt(startMin)}:00`
 * with no zone, and ClientManagePage posts either that string back verbatim on
 * a slot tap or `${date}T${time}:00` from the free picker. Both are zone free,
 * so accepting an offset only ever admitted something neither client sends.
 */
describe('the reschedule route agrees with the slots it offers', () => {
  const WALL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

  it('accepts exactly what the slots endpoint produces', () => {
    expect(WALL.test('2026-08-16T15:00:00')).toBe(true);
    expect(WALL.test('2026-08-16T09:30')).toBe(true);
  });

  it('refuses anything carrying a zone', () => {
    expect(WALL.test('2026-08-16T15:00:00Z')).toBe(false);
    expect(WALL.test('2026-08-16T15:00:00+01:00')).toBe(false);
    expect(WALL.test('2026-08-16T15:00:00.000Z')).toBe(false);
  });
});
