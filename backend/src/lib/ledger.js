/**
 * The ledger: one running total across everything, instead of another window.
 *
 * WHY THIS EXISTS
 * Every money surface in this app is a window onto a period. /api/money/pulse
 * compares this week with last week. /api/coach compares this month with last.
 * The Money page shows today. None of them ever showed a carry-over, a running
 * total, or a full history, so the honest answer to "what have I actually spent
 * this year" was to open the CSV export in a spreadsheet. The data was always
 * there. There was nowhere to see it.
 *
 * Pure on purpose. Running totals and tax-year boundaries are exactly the sort
 * of arithmetic that is quietly wrong for months, so it is testable without a
 * database.
 *
 * SIGN CONVENTION
 * Expenses are returned NEGATIVE and income POSITIVE, so the running total is a
 * real balance rather than two numbers the reader has to subtract in her head.
 * Refund rows in `transactions` are already stored negative, so they net off on
 * their own with no special case.
 */
import { getTaxYear } from './time-utils.js';

/**
 * The UK tax year runs 6 April to 5 April, NOT the calendar year. Every "year
 * to date" figure in this file uses that, because that is the year the number
 * eventually goes on a self-assessment form.
 *
 * @param {string} taxYear e.g. '2026-27'
 * @returns {{taxYear: string, start: string, end: string}} inclusive dates
 */
export function taxYearBounds(taxYear) {
  const startYear = Number(String(taxYear).split('-')[0]);
  if (!Number.isFinite(startYear)) throw new Error(`Not a tax year: ${taxYear}`);
  return {
    taxYear: `${startYear}-${String(startYear + 1).slice(2)}`,
    start: `${startYear}-04-06`,
    end: `${startYear + 1}-04-05`,
  };
}

/**
 * Which tax year does this calendar date fall in?
 *
 * getTaxYear in lib/time-utils.js is the one implementation of this rule and is
 * reused rather than rewritten. It reads LOCAL date parts, so a date-only
 * string is handed to it as a local-midnight Date built from its own parts:
 * new Date('2026-04-06') is UTC midnight, which is 5 April in any negative
 * offset zone, and 5 April is the other side of the boundary.
 *
 * @param {string} dateStr 'YYYY-MM-DD'
 */
export function taxYearOf(dateStr) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) throw new Error(`Not a YYYY-MM-DD date: ${dateStr}`);
  return getTaxYear(new Date(y, m - 1, d));
}

/** The tax year we are in right now. */
export function currentTaxYear(now = new Date()) {
  return getTaxYear(now);
}

/**
 * The tax years the filter should offer: every year from the oldest row she has
 * up to the one we are in, newest first.
 *
 * Every year in between is included even if it is empty, because a gap in the
 * list reads as a bug ("where did 2024-25 go") where an empty year reads as the
 * truth ("nothing that year").
 */
export function taxYearsFrom(oldestDate, now = new Date()) {
  const current = currentTaxYear(now);
  const currentStart = Number(current.split('-')[0]);

  let oldestStart = currentStart;
  if (oldestDate) {
    try { oldestStart = Number(taxYearOf(oldestDate).split('-')[0]); } catch { /* not a date, ignore */ }
  }
  if (!Number.isFinite(oldestStart) || oldestStart > currentStart) oldestStart = currentStart;

  const years = [];
  for (let y = currentStart; y >= oldestStart; y -= 1) {
    years.push(`${y}-${String(y + 1).slice(2)}`);
  }
  return years;
}

/**
 * The same calendar point one year earlier, clamped into a shorter month so
 * 29 February does not become 1 March. Used to compare a year to date against
 * the same slice of the year before: this year's four months against last
 * year's twelve always looks like a collapse.
 */
export function samePointLastYear(dateStr) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) throw new Error(`Not a YYYY-MM-DD date: ${dateStr}`);
  const lastDayOfThatMonth = new Date(Date.UTC(y - 1, m, 0)).getUTCDate();
  const day = Math.min(d, lastDayOfThatMonth);
  return `${y - 1}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Income rows carry a timestamp, expenses carry a DATE. Both reduce to a
 *  calendar date by string slicing, never by Date parsing, which is what turns
 *  a 23:30 BST payment into yesterday. */
function dateOf(row) {
  return String(row?.date || row?.created_at || '').slice(0, 10);
}

/**
 * Merge expenses and income into one list, oldest first, with a running total.
 *
 * @param {object} input
 * @param {Array} input.expenses  rows from `expenses`
 * @param {Array} input.transactions rows from `transactions` (already filtered
 *   to income types by the caller, which owns INCOME_TYPES)
 * @returns {{rows: Array, summary: object}} rows are NEWEST FIRST, because that
 *   is how the screen reads, but running_total_cents was accumulated oldest
 *   first so the top row carries the grand total.
 */
export function buildLedger({ expenses = [], transactions = [] } = {}) {
  const entries = [];

  for (const e of expenses) {
    entries.push({
      id: e.id,
      kind: 'expense',
      date: dateOf(e),
      // Negative: see the sign convention at the top of this file.
      amount_cents: -Math.abs(Number(e.amount_cents) || 0),
      category: e.category || 'other',
      vendor: e.vendor || null,
      description: e.description || null,
      recurring_expense_id: e.recurring_expense_id || null,
      tax_deductible: e.tax_deductible !== false,
      sort_key: e.created_at || `${dateOf(e)}T00:00:00.000Z`,
    });
  }

  for (const t of transactions) {
    entries.push({
      id: t.id,
      kind: 'income',
      date: dateOf(t),
      // Left as stored: a refund is already negative and must stay negative.
      amount_cents: Number(t.amount_cents) || 0,
      category: t.type || 'payment',
      vendor: null,
      description: t.description || null,
      recurring_expense_id: null,
      tax_deductible: true,
      sort_key: t.created_at || `${dateOf(t)}T00:00:00.000Z`,
    });
  }

  // Oldest first to accumulate. Ties broken by timestamp then id so the order
  // is stable across requests: an unstable sort would make the running total
  // on a given row change between two identical page loads.
  entries.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.sort_key !== b.sort_key) return a.sort_key < b.sort_key ? -1 : 1;
    return String(a.id) < String(b.id) ? -1 : 1;
  });

  let running = 0;
  let incomeCents = 0;
  let expensesCents = 0;
  const byCategory = {};

  for (const entry of entries) {
    running += entry.amount_cents;
    entry.running_total_cents = running;
    delete entry.sort_key;

    if (entry.kind === 'expense') {
      expensesCents += Math.abs(entry.amount_cents);
    } else {
      incomeCents += entry.amount_cents;
    }

    const bucket = byCategory[entry.category] || (byCategory[entry.category] = {
      kind: entry.kind, total_cents: 0, count: 0,
    });
    bucket.total_cents += Math.abs(entry.amount_cents);
    bucket.count += 1;
  }

  return {
    rows: entries.reverse(),
    summary: {
      income_cents: incomeCents,
      expenses_cents: expensesCents,
      net_cents: incomeCents - expensesCents,
      running_total_cents: running,
      row_count: entries.length,
      by_category: byCategory,
    },
  };
}

/** One page of an already-built ledger. The running total is deliberately NOT
 *  recomputed per page: a running total that restarts at the top of page two is
 *  not a running total. */
export function paginate(rows, page = 1, pageSize = 50) {
  const size = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
  const current = Math.max(Number(page) || 1, 1);
  const start = (current - 1) * size;
  return {
    rows: rows.slice(start, start + size),
    page: current,
    page_size: size,
    total_rows: rows.length,
    has_more: start + size < rows.length,
  };
}

/**
 * Income, expenses and profit for a tax year, up to an optional cut-off.
 *
 * The cut-off is what makes "year to date" mean the same thing on both sides of
 * a comparison. Showing this year's nine months against last year's twelve is a
 * number that always looks like a collapse.
 */
export function periodTotals({ expenses = [], transactions = [], start, end }) {
  const within = (d) => (!start || d >= start) && (!end || d <= end);

  let incomeCents = 0;
  for (const t of transactions) {
    if (within(dateOf(t))) incomeCents += Number(t.amount_cents) || 0;
  }

  let expenseCents = 0;
  for (const e of expenses) {
    if (within(dateOf(e))) expenseCents += Math.abs(Number(e.amount_cents) || 0);
  }

  return {
    income_cents: incomeCents,
    expenses_cents: expenseCents,
    profit_cents: incomeCents - expenseCents,
  };
}
