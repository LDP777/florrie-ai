/**
 * The ledger: a running total that means something, and tax-year boundaries
 * that land on 6 April rather than 1 January.
 *
 * Pure module, no database. The two things that go quietly wrong here are the
 * sign of an expense (which makes profit look like a loss or the other way
 * round) and the tax-year edge (which moves a whole day's takings into the
 * wrong self-assessment).
 */
import { describe, it, expect } from 'vitest';
import {
  buildLedger,
  currentTaxYear,
  paginate,
  periodTotals,
  samePointLastYear,
  taxYearBounds,
  taxYearOf,
  taxYearsFrom,
} from '../../src/lib/ledger.js';

describe('taxYearBounds', () => {
  it('runs 6 April to 5 April, not the calendar year', () => {
    expect(taxYearBounds('2026-27')).toEqual({
      taxYear: '2026-27', start: '2026-04-06', end: '2027-04-05',
    });
  });

  it('rejects something that is not a tax year', () => {
    expect(() => taxYearBounds('banana')).toThrow(/tax year/i);
  });
});

describe('taxYearOf', () => {
  it('puts 5 April in the old year and 6 April in the new one', () => {
    expect(taxYearOf('2026-04-05')).toBe('2025-26');
    expect(taxYearOf('2026-04-06')).toBe('2026-27');
  });

  it('puts New Year\'s Day in the tax year that started the previous April', () => {
    expect(taxYearOf('2027-01-01')).toBe('2026-27');
  });

  it('does not slide a date backwards through a timezone', () => {
    // new Date('2026-04-06') is UTC midnight, which is 5 April in any negative
    // offset zone, and 5 April is the other side of the boundary.
    expect(taxYearOf('2026-04-06')).toBe(taxYearOf('2026-04-06T00:00:00'));
  });
});

describe('currentTaxYear', () => {
  it('reads the year we are in from a date', () => {
    expect(currentTaxYear(new Date(2026, 7, 2))).toBe('2026-27');
    expect(currentTaxYear(new Date(2026, 0, 2))).toBe('2025-26');
  });
});

describe('taxYearsFrom', () => {
  it('offers every year between the oldest row and now, newest first', () => {
    expect(taxYearsFrom('2024-06-01', new Date(2026, 7, 2)))
      .toEqual(['2026-27', '2025-26', '2024-25']);
  });

  it('offers the current year alone when there is nothing on the books', () => {
    expect(taxYearsFrom(null, new Date(2026, 7, 2))).toEqual(['2026-27']);
  });

  it('never offers a year in the future, even from a bad row', () => {
    expect(taxYearsFrom('2099-01-01', new Date(2026, 7, 2))).toEqual(['2026-27']);
  });
});

describe('samePointLastYear', () => {
  it('gives the same calendar point a year earlier', () => {
    expect(samePointLastYear('2026-08-02')).toBe('2025-08-02');
  });

  it('clamps 29 February rather than sliding into March', () => {
    expect(samePointLastYear('2028-02-29')).toBe('2027-02-28');
  });
});

describe('buildLedger', () => {
  const expenses = [
    { id: 'e1', amount_cents: 45000, category: 'rent', date: '2026-08-01', vendor: 'Landlord' },
    { id: 'e2', amount_cents: 2500, category: 'products', date: '2026-08-03', vendor: 'Sally' },
  ];
  const transactions = [
    { id: 't1', amount_cents: 6000, type: 'payment', created_at: '2026-08-02T10:00:00.000Z' },
    { id: 't2', amount_cents: -1000, type: 'refund', created_at: '2026-08-04T10:00:00.000Z' },
  ];

  it('returns expenses negative and income positive so the total is a balance', () => {
    const { rows } = buildLedger({ expenses, transactions });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.e1.amount_cents).toBe(-45000);
    expect(byId.t1.amount_cents).toBe(6000);
  });

  it('leaves a refund negative rather than counting it as income twice over', () => {
    const { rows, summary } = buildLedger({ expenses: [], transactions });
    expect(rows.find((r) => r.id === 't2').amount_cents).toBe(-1000);
    expect(summary.income_cents).toBe(5000);
  });

  it('accumulates the running total oldest first and presents it newest first', () => {
    const { rows } = buildLedger({ expenses, transactions });
    expect(rows.map((r) => r.id)).toEqual(['t2', 'e2', 't1', 'e1']);
    expect(rows.map((r) => r.running_total_cents)).toEqual([-42500, -41500, -39000, -45000]);
  });

  it('carries the grand total on the newest row, which is the point of it', () => {
    const { rows, summary } = buildLedger({ expenses, transactions });
    expect(rows[0].running_total_cents).toBe(summary.running_total_cents);
    expect(summary.running_total_cents).toBe(summary.net_cents);
  });

  it('totals by category and counts the rows', () => {
    const { summary } = buildLedger({ expenses, transactions });
    expect(summary.expenses_cents).toBe(47500);
    expect(summary.income_cents).toBe(5000);
    expect(summary.net_cents).toBe(-42500);
    expect(summary.by_category.rent).toEqual({ kind: 'expense', total_cents: 45000, count: 1 });
    expect(summary.row_count).toBe(4);
  });

  it('reads a timestamp as its calendar date by slicing, never by parsing', () => {
    // A 23:30 BST payment parsed as UTC lands on the previous day. Slicing the
    // stored string keeps it where the salon thinks it happened.
    const { rows } = buildLedger({
      expenses: [],
      transactions: [{ id: 'late', amount_cents: 100, type: 'payment', created_at: '2026-08-02T23:30:00' }],
    });
    expect(rows[0].date).toBe('2026-08-02');
  });

  it('is stable when two rows share a date, so the total does not move between loads', () => {
    const same = [
      { id: 'b', amount_cents: 100, category: 'other', date: '2026-08-01' },
      { id: 'a', amount_cents: 200, category: 'other', date: '2026-08-01' },
    ];
    const first = buildLedger({ expenses: same });
    const second = buildLedger({ expenses: [...same].reverse() });
    expect(first.rows.map((r) => r.id)).toEqual(second.rows.map((r) => r.id));
  });

  it('answers with zeroes rather than throwing on nothing at all', () => {
    const { rows, summary } = buildLedger({});
    expect(rows).toEqual([]);
    expect(summary.net_cents).toBe(0);
  });
});

describe('paginate', () => {
  const { rows } = buildLedger({
    expenses: Array.from({ length: 120 }, (_, i) => ({
      id: `e${i}`, amount_cents: 100, category: 'other',
      date: `2026-08-${String((i % 28) + 1).padStart(2, '0')}`,
    })),
  });

  it('slices without recomputing the running total', () => {
    const pageOne = paginate(rows, 1, 50);
    const pageTwo = paginate(rows, 2, 50);
    expect(pageOne.rows).toHaveLength(50);
    expect(pageTwo.rows[0].running_total_cents).toBe(rows[50].running_total_cents);
    expect(pageTwo.has_more).toBe(true);
  });

  it('reports the last page honestly', () => {
    const last = paginate(rows, 3, 50);
    expect(last.rows).toHaveLength(20);
    expect(last.has_more).toBe(false);
    expect(last.total_rows).toBe(120);
  });

  it('caps a page size somebody put a silly number in', () => {
    expect(paginate(rows, 1, 100000).page_size).toBe(200);
    expect(paginate(rows, 0, 0).page).toBe(1);
  });
});

describe('periodTotals', () => {
  const expenses = [
    { amount_cents: 1000, date: '2025-08-01' },
    { amount_cents: 2000, date: '2026-08-01' },
  ];
  const transactions = [
    { amount_cents: 5000, created_at: '2025-08-01T09:00:00.000Z' },
    { amount_cents: 9000, created_at: '2026-08-01T09:00:00.000Z' },
  ];

  it('counts only what falls inside the window', () => {
    expect(periodTotals({ expenses, transactions, start: '2026-04-06', end: '2027-04-05' }))
      .toEqual({ income_cents: 9000, expenses_cents: 2000, profit_cents: 7000 });
  });

  it('compares like for like when the window is cut off at the same point', () => {
    expect(periodTotals({ expenses, transactions, start: '2025-04-06', end: '2025-08-02' }))
      .toEqual({ income_cents: 5000, expenses_cents: 1000, profit_cents: 4000 });
  });

  it('includes both ends of the window', () => {
    expect(periodTotals({ expenses, transactions, start: '2026-08-01', end: '2026-08-01' }).expenses_cents)
      .toBe(2000);
  });
});
