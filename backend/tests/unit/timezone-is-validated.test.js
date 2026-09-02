/**
 * beauticians.timezone was never collected: the column defaulted to
 * Europe/London and nothing let the owner change it, yet it drives reminder
 * timing, quiet hours and gap-fill. Now that Settings and Onboarding write
 * it, the profile route has to accept the field and refuse a zone that Intl
 * cannot resolve, because every reader hands it straight to a formatter that
 * throws on an unknown zone, inside the reminder job.
 */
import { describe, it, expect } from 'vitest';
import { profileUpdateSchema } from '../../src/lib/schemas.js';
import { isValidTimeZone } from '../../src/lib/time-utils.js';

describe('isValidTimeZone', () => {
  it('accepts every zone on the curated Settings list', () => {
    const curated = [
      'Europe/London', 'Europe/Dublin', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid',
      'Europe/Lisbon', 'Europe/Amsterdam', 'Europe/Brussels', 'Europe/Rome', 'Europe/Stockholm',
      'Europe/Oslo', 'Europe/Copenhagen', 'Europe/Warsaw', 'Europe/Athens', 'America/New_York',
      'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto',
      'Australia/Sydney', 'Australia/Melbourne', 'Australia/Perth', 'Pacific/Auckland',
      'Asia/Dubai', 'Asia/Singapore',
    ];
    for (const zone of curated) expect(isValidTimeZone(zone), zone).toBe(true);
  });

  it('rejects zones Intl does not know, and non-strings', () => {
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('   ')).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
    expect(isValidTimeZone('x'.repeat(65))).toBe(false);
  });
});

describe('PATCH /api/auth/me schema', () => {
  it('accepts a real timezone', () => {
    const r = profileUpdateSchema.safeParse({ timezone: 'Europe/Dublin' });
    expect(r.success).toBe(true);
    expect(r.data.timezone).toBe('Europe/Dublin');
  });

  it('rejects an unknown timezone, which the route turns into a 400', () => {
    const r = profileUpdateSchema.safeParse({ timezone: 'Europe/Narnia' });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error.issues)).toMatch(/Unknown timezone/);
  });
});
