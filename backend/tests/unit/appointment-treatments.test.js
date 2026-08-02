import { describe, it, expect } from 'vitest';
import {
  ownTotals,
  recomputeTotals,
  endsAtWall,
  parseExtraTreatmentIds,
  treatmentSetLabel,
} from '../../src/lib/appointment-treatments.js';

// Ellie's actual treatments, near enough.
const LASH_LIFT = { id: 't-lift', name: 'Lash lift', duration_minutes: 60, price_cents: 4000 };
const INFILL = { id: 't-infill', name: 'Lash infill', duration_minutes: 45, price_cents: 3000 };
const BROW_TINT = { id: 't-tint', name: 'Brow tint', duration_minutes: 15, price_cents: 1000 };

describe('recomputeTotals: base treatment plus extras', () => {
  it('sums the length and the price of the whole set', () => {
    const t = recomputeTotals({
      baseTreatment: LASH_LIFT,
      extraTreatments: [BROW_TINT],
      existing: { duration_minutes: 60, price_cents: 4000, buffer_minutes: 0, extra_padding_minutes: 0 },
    });
    expect(t.durationMinutes).toBe(75);
    expect(t.priceCents).toBe(5000);
  });

  it('adds buffer and extra padding to the blocked slot but not to the duration', () => {
    const t = recomputeTotals({
      baseTreatment: LASH_LIFT,
      extraTreatments: [BROW_TINT],
      existing: { duration_minutes: 60, price_cents: 4000, buffer_minutes: 15, extra_padding_minutes: 10 },
    });
    // duration_minutes is treatment time only, exactly as the existing
    // duration change path stores it.
    expect(t.durationMinutes).toBe(75);
    expect(t.blockMinutes).toBe(100);
  });

  it('counts a treatment added twice twice', () => {
    const t = recomputeTotals({
      baseTreatment: LASH_LIFT,
      extraTreatments: [BROW_TINT, BROW_TINT],
      existing: { duration_minutes: 60, price_cents: 4000 },
    });
    expect(t.durationMinutes).toBe(90);
    expect(t.priceCents).toBe(6000);
  });

  it('clearing every extra puts the base treatment back on its own', () => {
    const t = recomputeTotals({
      baseTreatment: LASH_LIFT,
      extraTreatments: [],
      // The row still carries the combined figures from when the tint was on.
      existing: { duration_minutes: 75, price_cents: 5000, buffer_minutes: 15 },
      currentExtras: [BROW_TINT],
    });
    expect(t.durationMinutes).toBe(60);
    expect(t.priceCents).toBe(4000);
    expect(t.blockMinutes).toBe(75);
  });
});

describe('recomputeTotals: a patch test, which has no base treatment', () => {
  // This is the case Ellie could not do at all. A patch test carries no
  // treatment_id, so its ten minutes exist only on the appointment row.
  const patchTest = { duration_minutes: 10, price_cents: 0, buffer_minutes: 15, extra_padding_minutes: 0 };

  it('keeps the patch test its own ten minutes and adds the infill on top', () => {
    const t = recomputeTotals({
      baseTreatment: null,
      extraTreatments: [INFILL],
      existing: patchTest,
    });
    expect(t.durationMinutes).toBe(55);
    expect(t.priceCents).toBe(3000);
    expect(t.blockMinutes).toBe(70);
  });

  it('does not compound when a second treatment is added afterwards', () => {
    // The row now reads 55 minutes because the infill is already on it.
    const after = { duration_minutes: 55, price_cents: 3000, buffer_minutes: 15 };
    const t = recomputeTotals({
      baseTreatment: null,
      extraTreatments: [INFILL, BROW_TINT],
      existing: after,
      currentExtras: [INFILL],
    });
    // 10 for the patch test, 45 for the infill, 15 for the tint. Not 100.
    expect(t.durationMinutes).toBe(70);
    expect(t.priceCents).toBe(4000);
  });

  it('gives the patch test back untouched when the infill is removed again', () => {
    const t = recomputeTotals({
      baseTreatment: null,
      extraTreatments: [],
      existing: { duration_minutes: 55, price_cents: 3000, buffer_minutes: 15 },
      currentExtras: [INFILL],
    });
    expect(t.durationMinutes).toBe(10);
    expect(t.priceCents).toBe(0);
  });

  it('never returns a negative base when a legacy row does not reconcile', () => {
    const t = recomputeTotals({
      baseTreatment: null,
      extraTreatments: [],
      existing: { duration_minutes: 20, price_cents: 0 },
      currentExtras: [INFILL], // 45 minutes, longer than the row itself
    });
    expect(t.durationMinutes).toBe(0);
    expect(t.priceCents).toBe(0);
  });
});

describe('recomputeTotals: empty and missing values', () => {
  it('an empty extras list leaves a normal booking exactly as it was', () => {
    const t = recomputeTotals({
      baseTreatment: LASH_LIFT,
      extraTreatments: [],
      existing: { duration_minutes: 60, price_cents: 4000, buffer_minutes: 15, extra_padding_minutes: 0 },
    });
    expect(t).toEqual({ durationMinutes: 60, priceCents: 4000, blockMinutes: 75 });
  });

  it('treats null durations, prices and buffers as zero rather than NaN', () => {
    const t = recomputeTotals({
      baseTreatment: { duration_minutes: null, price_cents: null },
      extraTreatments: [{ duration_minutes: 30, price_cents: 2000 }],
      existing: { duration_minutes: null, price_cents: null, buffer_minutes: null, extra_padding_minutes: null },
    });
    expect(t).toEqual({ durationMinutes: 30, priceCents: 2000, blockMinutes: 30 });
  });
});

describe('ownTotals', () => {
  it('is the row itself when nothing is attached', () => {
    expect(ownTotals({ duration_minutes: 10, price_cents: 0 }, [])).toEqual({
      durationMinutes: 10,
      priceCents: 0,
    });
  });

  it('subtracts what is currently attached', () => {
    expect(ownTotals({ duration_minutes: 55, price_cents: 3000 }, [INFILL])).toEqual({
      durationMinutes: 10,
      priceCents: 0,
    });
  });
});

describe('endsAtWall: the wall frame, in August, in British Summer Time', () => {
  it('a 10 minute patch test plus a 45 minute infill plus 15 buffer ends at 11:10', () => {
    // 5 August 2026 is BST. new Date(start).toISOString() would answer 12:10
    // here, which is the bug this function exists to prevent.
    const totals = recomputeTotals({
      baseTreatment: null,
      extraTreatments: [INFILL],
      existing: { duration_minutes: 10, price_cents: 0, buffer_minutes: 15, extra_padding_minutes: 0 },
    });
    expect(totals.blockMinutes).toBe(70);
    expect(endsAtWall('2026-08-05T10:00:00', totals.blockMinutes)).toBe('2026-08-05T11:10:00');
  });

  it('answers the same string whichever timezone the server runs in', () => {
    const before = process.env.TZ;
    const answers = new Set();
    for (const tz of ['UTC', 'Europe/London', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
      process.env.TZ = tz;
      answers.add(endsAtWall('2026-08-05T10:00:00', 70));
    }
    process.env.TZ = before;
    expect([...answers]).toEqual(['2026-08-05T11:10:00']);
  });

  it('accepts the full stored string and the ISO-looking one the app sends', () => {
    expect(endsAtWall('2026-08-05T10:00:00.000Z', 70)).toBe('2026-08-05T11:10:00');
    expect(endsAtWall('2026-08-05T10:00', 70)).toBe('2026-08-05T11:10:00');
  });

  it('rolls over midnight and over the end of the month', () => {
    expect(endsAtWall('2026-08-31T23:30:00', 45)).toBe('2026-09-01T00:15:00');
  });

  it('does not shift across the October clock change', () => {
    // 25 October 2026 is the day BST ends. Wall time is wall time regardless.
    expect(endsAtWall('2026-10-25T01:30:00', 60)).toBe('2026-10-25T02:30:00');
  });

  it('returns null when the start is unreadable rather than guessing', () => {
    expect(endsAtWall(null, 60)).toBeNull();
    expect(endsAtWall('', 60)).toBeNull();
    expect(endsAtWall('not a date', 60)).toBeNull();
  });
});

describe('parseExtraTreatmentIds', () => {
  it('accepts a list of ids', () => {
    expect(parseExtraTreatmentIds(['a', 'b'])).toEqual({ ok: true, ids: ['a', 'b'], store: ['a', 'b'] });
  });

  it('stores null for an empty list, so "no extras" has one representation', () => {
    expect(parseExtraTreatmentIds([])).toEqual({ ok: true, ids: [], store: null });
    expect(parseExtraTreatmentIds(null)).toEqual({ ok: true, ids: [], store: null });
  });

  it('rejects anything that is not a list', () => {
    expect(parseExtraTreatmentIds('t-infill').ok).toBe(false);
    expect(parseExtraTreatmentIds({ id: 't-infill' }).ok).toBe(false);
  });

  it('rejects entries that are not ids', () => {
    expect(parseExtraTreatmentIds([null]).ok).toBe(false);
    expect(parseExtraTreatmentIds([{ id: 'x' }]).ok).toBe(false);
    expect(parseExtraTreatmentIds(['  ']).ok).toBe(false);
  });

  it('caps the list, because every id costs an ownership query', () => {
    expect(parseExtraTreatmentIds(Array(11).fill('a')).ok).toBe(false);
    expect(parseExtraTreatmentIds(Array(10).fill('a')).ok).toBe(true);
  });
});

describe('treatmentSetLabel', () => {
  it('reads the way she would say it', () => {
    expect(treatmentSetLabel('Patch test', ['Lash infill'])).toBe('Patch test + Lash infill');
    expect(treatmentSetLabel('Lash lift', ['Brow tint'])).toBe('Lash lift + Brow tint');
  });

  it('is just the base when there are no extras', () => {
    expect(treatmentSetLabel('Lash lift', [])).toBe('Lash lift');
  });

  it('drops blanks rather than leaving a stray plus sign', () => {
    expect(treatmentSetLabel('', ['Brow tint'])).toBe('Brow tint');
    expect(treatmentSetLabel('Lash lift', ['', null])).toBe('Lash lift');
  });
});
