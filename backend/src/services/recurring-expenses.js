/**
 * Recurring expenses: the schedule maths, and the daily job that turns a due
 * rule into a real expense.
 *
 * WHY THIS EXISTS
 * Every money surface in this app reads the `expenses` table. Nothing wrote to
 * it except a human typing, so a solo beautician whose biggest costs are fixed
 * (rent, insurance, software, phone) had to retype the same five rows every
 * month or her profit figure was wrong in her favour. This module is the only
 * thing that writes an expense nobody typed.
 *
 * TWO HALVES, ON PURPOSE
 *   1. computeNextDueDate / dueDatesUpTo are PURE. Calendar arithmetic is where
 *      the bugs live (the 31st in February, a leap day, a year rollover), and
 *      pure functions are the only version of it that can be tested honestly.
 *      No Date-with-timezone anywhere: dates are parsed to plain integers and
 *      put back as YYYY-MM-DD, so the answer does not depend on TZ.
 *   2. materialiseDueExpenses does the database work and nothing clever.
 *
 * WHY NOT DERIVE THE NEXT DATE FROM THE LAST ONE
 * Because short months eat the anchor. Rent on the 31st is paid on the 28th in
 * February; add a month to THAT and March becomes the 28th, and the 31st is
 * gone for ever. The rule stores day_of_month as the anchor and next_due_date
 * only as a cursor, so every month is clamped from the anchor, never from the
 * previous clamp.
 */
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { getTaxYear } from '../lib/time-utils.js';

/** The vocabulary, matching both CHECK constraints (expenses + recurring_expenses). */
export const RECURRING_FREQUENCIES = Object.freeze(['weekly', 'monthly', 'yearly']);

export const EXPENSE_CATEGORIES = Object.freeze([
  'products', 'rent', 'training', 'travel', 'equipment',
  'insurance', 'marketing', 'software', 'utilities', 'other',
]);

/**
 * How many missed occurrences one rule may catch up on in a single run.
 *
 * A container that was down for a fortnight, or a rule imported with an old
 * next_due_date, must still land every month it owes. But an unbounded loop on
 * a bad row (a weekly rule with next_due_date in 2019) would write hundreds of
 * expenses into her books before anybody noticed, so it is capped. Anything
 * still owing is picked up by tomorrow's run.
 */
export const MAX_CATCH_UP_PER_RUN = 24;

// 42P01 = relation does not exist, 42703 = column does not exist. Either means
// the migration has not been applied yet, which is not an outage: the job says
// so once and does nothing.
const isPreMigration = (error) => Boolean(error) && (error.code === '42P01' || error.code === '42703');

// 23505 = unique violation. The partial unique index on
// (recurring_expense_id, date) firing means the row we were about to write is
// already there. That is the guard working, not a failure.
const isUniqueViolation = (error) =>
  Boolean(error) && (error.code === '23505' || /duplicate key value/i.test(error.message || ''));

// ─────────────────────────────────────────────────────────────
// Pure calendar arithmetic
// ─────────────────────────────────────────────────────────────

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 'YYYY-MM-DD' to {y, m, d} with m 1-based. Throws on anything else, because a
 *  silently wrong date is worse than a loud one when it writes to her books. */
export function parseDateStr(value) {
  const match = DATE_RE.exec(String(value || '').slice(0, 10));
  if (!match) throw new Error(`Not a YYYY-MM-DD date: ${value}`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) throw new Error(`Not a real date: ${value}`);
  return { y, m, d };
}

/** {y, m, d} back to 'YYYY-MM-DD'. */
export function formatDateStr({ y, m, d }) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Days in a month, 1-based month. Date.UTC with day 0 gives the last day of
 *  the previous month, which is also the leap-year rule for free. */
export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 0 = Sunday, matching recurring_expenses.day_of_week and JS getDay(). UTC so
 *  the weekday of a calendar date never depends on the server timezone. */
function dayOfWeek({ y, m, d }) {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Negative when a is earlier than b. */
function compareDates(a, b) {
  if (a.y !== b.y) return a.y - b.y;
  if (a.m !== b.m) return a.m - b.m;
  return a.d - b.d;
}

function addDays(date, days) {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d));
  t.setUTCDate(t.getUTCDate() + days);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** The anchor day, clamped into a month that may be shorter than it. This is
 *  the whole month-end story: 31 lands on the 28th in a normal February, the
 *  29th in a leap one, and on the 31st again in March, because the anchor is
 *  never overwritten by the clamp. */
function clampToMonth(y, m, anchorDay) {
  return { y, m, d: Math.min(anchorDay, daysInMonth(y, m)) };
}

function nextMonth(y, m) {
  return m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
}

/**
 * The next occurrence STRICTLY AFTER `from`.
 *
 * Strictly after matters: the job calls this with the date it has just
 * materialised, so returning that same date would loop for ever writing the
 * same expense (and, with the unique index, failing for ever instead).
 *
 * @param {object} rule    { frequency, day_of_month, day_of_week, month_of_year }
 * @param {string} from    'YYYY-MM-DD'
 * @returns {string} 'YYYY-MM-DD'
 */
export function computeNextDueDate(rule, from) {
  const start = parseDateStr(from);
  const frequency = rule?.frequency;

  if (frequency === 'weekly') {
    // No day_of_week set means "same weekday as the date it was anchored on",
    // which is what a beautician who typed nothing would expect.
    const target = Number.isInteger(rule.day_of_week)
      ? ((rule.day_of_week % 7) + 7) % 7
      : dayOfWeek(start);
    let delta = (target - dayOfWeek(start) + 7) % 7;
    if (delta === 0) delta = 7;
    return formatDateStr(addDays(start, delta));
  }

  if (frequency === 'monthly') {
    const anchor = Math.min(Math.max(Number(rule.day_of_month) || start.d, 1), 31);
    let candidate = clampToMonth(start.y, start.m, anchor);
    if (compareDates(candidate, start) <= 0) {
      const { y, m } = nextMonth(start.y, start.m);
      candidate = clampToMonth(y, m, anchor);
    }
    return formatDateStr(candidate);
  }

  if (frequency === 'yearly') {
    const month = Math.min(Math.max(Number(rule.month_of_year) || start.m, 1), 12);
    const anchor = Math.min(Math.max(Number(rule.day_of_month) || start.d, 1), 31);
    let candidate = clampToMonth(start.y, month, anchor);
    if (compareDates(candidate, start) <= 0) {
      candidate = clampToMonth(start.y + 1, month, anchor);
    }
    return formatDateStr(candidate);
  }

  throw new Error(`Unknown frequency: ${frequency}`);
}

/**
 * Every date this rule owes, from its cursor up to and including `today`.
 *
 * Pure, and the reason the job has no loop logic of its own. An empty array
 * means nothing is due, which is the normal answer on most days.
 *
 * @param {object} rule  { frequency, next_due_date, ...anchors }
 * @param {string} today 'YYYY-MM-DD'
 * @param {number} [cap] most dates to return, see MAX_CATCH_UP_PER_RUN
 * @returns {string[]} oldest first
 */
export function dueDatesUpTo(rule, today, cap = MAX_CATCH_UP_PER_RUN) {
  const limit = parseDateStr(today);
  const dates = [];
  let cursor = rule?.next_due_date ? parseDateStr(rule.next_due_date) : null;
  if (!cursor) return dates;

  while (compareDates(cursor, limit) <= 0 && dates.length < cap) {
    const asString = formatDateStr(cursor);
    dates.push(asString);
    cursor = parseDateStr(computeNextDueDate(rule, asString));
  }
  return dates;
}

/**
 * The category to HMRC self-assessment box mapping, same table routes/money.js
 * uses on a hand-typed expense. Duplicated deliberately: importing a route into
 * a job drags express and the Anthropic client into the scheduler for one
 * lookup table.
 */
export function hmrcCategoryFor(category) {
  const map = {
    products: 'cost_of_goods',
    rent: 'premises',
    utilities: 'premises',
    training: 'other_expenses',
    travel: 'travel',
    equipment: 'other_expenses',
    insurance: 'insurance',
    marketing: 'advertising',
    software: 'admin',
    other: 'other_expenses',
  };
  return map[category] || 'other_expenses';
}

/** The expenses row a rule becomes on a given date. Pure, so a test can assert
 *  the shape without a database. */
export function buildGeneratedExpense(rule, date) {
  return {
    beautician_id: rule.beautician_id,
    amount_cents: rule.amount_cents,
    vendor: rule.vendor || null,
    description: rule.description || null,
    category: rule.category,
    hmrc_category: hmrcCategoryFor(rule.category),
    date,
    tax_deductible: true,
    // getTaxYear reads LOCAL date parts, so it is handed a local-midnight Date
    // built from the parts rather than new Date('2026-04-06'), which is UTC
    // midnight and lands on 5 April in any negative-offset zone.
    tax_year: getTaxYear(new Date(...dateParts(date))),
    recurring_expense_id: rule.id,
  };
}

function dateParts(dateStr) {
  const { y, m, d } = parseDateStr(dateStr);
  return [y, m - 1, d];
}

// ─────────────────────────────────────────────────────────────
// The job
// ─────────────────────────────────────────────────────────────

/** Today as a calendar date, from UTC parts. Railway runs UTC and the rows are
 *  plain DATEs; there is no wall-time question here, only a date one. */
function todayStr() {
  const now = new Date();
  return formatDateStr({ y: now.getUTCFullYear(), m: now.getUTCMonth() + 1, d: now.getUTCDate() });
}

/**
 * Has this rule already produced an expense on this date?
 *
 * Belt to the unique index's braces. The index is what makes a double row
 * impossible; this read is what stops the job treating its own previous
 * success as a failure, and what lets it advance the cursor past a date it
 * already covered.
 *
 * @returns {Promise<{exists: boolean, error: object|null}>}
 */
async function alreadyMaterialised(ruleId, date) {
  const { data, error } = await supabase
    .from('expenses')
    .select('id')
    .eq('recurring_expense_id', ruleId)
    .eq('date', date)
    .limit(1);

  // Supabase returns errors in the result object rather than throwing. An
  // unchecked result here reads as "no rows", which would mean writing a
  // second expense every time the database hiccuped.
  if (error) return { exists: false, error };
  return { exists: Array.isArray(data) && data.length > 0, error: null };
}

/**
 * Move the cursor on, without letting two runs move it twice.
 *
 * The WHERE includes the value we read a moment ago, so a concurrent run that
 * already advanced it updates zero rows here and we know to stop. Same
 * compare-and-swap the scheduler uses to elect a leader, for the same reason:
 * the atomicity has to be inside one statement to survive PgBouncer.
 */
async function advanceCursor(rule, fromDate, nextDate, stampCreated) {
  const updates = { next_due_date: nextDate };
  if (stampCreated) updates.last_created_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('recurring_expenses')
    .update(updates)
    .eq('id', rule.id)
    .eq('next_due_date', fromDate)
    .select('id');

  if (error) return { moved: false, error };
  return { moved: Array.isArray(data) && data.length > 0, error: null };
}

/**
 * Create the expenses rows for every rule that is due, and move each cursor on.
 *
 * Registered as a daily job in jobs/register.js. Idempotent by construction:
 *   - the scheduler runs it on one replica at a time;
 *   - a row that already exists for (rule, date) is not written again;
 *   - the unique index refuses a second one even if both checks are raced;
 *   - the cursor only moves once the expense for that date exists, so a crash
 *     halfway through means tomorrow's run finishes the work rather than
 *     skipping it.
 *
 * @returns {Promise<{created:number, skipped:number, rules:number, failed:number}>}
 */
export async function materialiseDueExpenses() {
  const today = todayStr();

  const { data: rules, error } = await supabase
    .from('recurring_expenses')
    .select('*')
    .eq('active', true)
    .lte('next_due_date', today)
    .order('next_due_date', { ascending: true });

  if (isPreMigration(error)) {
    logger.warn('recurring-expenses: table not there yet, migration 20260802_recurring_expenses.sql has not been applied');
    return { created: 0, skipped: 0, rules: 0, failed: 0 };
  }
  if (error) {
    // Thrown, not swallowed: recordJobRun stamps the failure into job_runs and
    // /health reports it. A job that returns "0 created" on a broken query is
    // indistinguishable from a quiet day, which is how the Instagram token
    // stayed dead for five weeks.
    throw new Error(`Could not read recurring expenses: ${error.message}`);
  }

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const rule of rules || []) {
    const dates = dueDatesUpTo(rule, today);

    for (const date of dates) {
      const seen = await alreadyMaterialised(rule.id, date);
      if (seen.error) {
        logger.error({ err: seen.error, ruleId: rule.id, date }, 'recurring-expenses: could not check for an existing row, leaving the cursor where it is');
        failed += 1;
        break; // Never advance past a date we could not verify.
      }

      let wrote = false;
      if (seen.exists) {
        skipped += 1;
      } else {
        const { error: insertError } = await supabase
          .from('expenses')
          .insert(buildGeneratedExpense(rule, date));

        if (insertError && isUniqueViolation(insertError)) {
          // The index caught a race with another run. The row exists, which is
          // all this job wanted, so carry on and advance the cursor.
          skipped += 1;
        } else if (insertError) {
          logger.error({ err: insertError, ruleId: rule.id, date }, 'recurring-expenses: could not create the expense');
          failed += 1;
          break;
        } else {
          created += 1;
          wrote = true;
        }
      }

      const nextDate = computeNextDueDate(rule, date);
      const advanced = await advanceCursor(rule, date, nextDate, wrote);
      if (advanced.error) {
        logger.error({ err: advanced.error, ruleId: rule.id, date }, 'recurring-expenses: expense written but the cursor did not move, tomorrow will skip it as already done');
        failed += 1;
        break;
      }
      if (!advanced.moved) {
        // Somebody else moved it. Their run owns the rest of this rule.
        break;
      }
      // Keep the in-memory copy in step so the next iteration's
      // compare-and-swap matches what is now in the database.
      rule.next_due_date = nextDate;
    }
  }

  logger.info({ rules: (rules || []).length, created, skipped, failed }, 'recurring-expenses: pass finished');
  return { created, skipped, rules: (rules || []).length, failed };
}
