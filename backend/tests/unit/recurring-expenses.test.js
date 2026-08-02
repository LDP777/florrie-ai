/**
 * Recurring expenses: the calendar arithmetic, and the promise that a cost is
 * never charged twice.
 *
 * Both halves are worth testing for the same reason: they are the two places
 * where being quietly wrong costs real money. A schedule that loses the 31st
 * understates her costs for ever; a job that writes the same expense twice
 * overstates them and she takes that number to an accountant.
 *
 * The supabase client is stubbed with a fake table that enforces the SAME
 * unique constraint the migration creates, so "idempotent" is demonstrated
 * rather than asserted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = {
  rules: [],
  expenses: [],
  readError: null,
  expenseSelectError: null,
  // Makes the read-before-write guard miss a row that is really there, which is
  // what losing the race with another replica looks like from in here.
  blindGuardOnce: false,
};

function matches(row, filters) {
  return filters.every(([key, value]) => row[key] === value);
}

function respond(builder) {
  const { table, op, filters, payload } = builder;

  if (table === 'recurring_expenses' && op === 'select') {
    if (db.readError) return { data: null, error: db.readError };
    return { data: db.rules.filter((r) => matches(r, filters.filter(([k]) => k !== '__lte'))), error: null };
  }

  if (table === 'recurring_expenses' && op === 'update') {
    // Compare-and-swap: the WHERE carries the value the caller read a moment
    // ago, so a concurrent advance must match zero rows here.
    const hit = db.rules.filter((r) => matches(r, filters));
    hit.forEach((r) => Object.assign(r, payload));
    return { data: hit.map((r) => ({ id: r.id })), error: null };
  }

  if (table === 'expenses' && op === 'select') {
    if (db.expenseSelectError) return { data: null, error: db.expenseSelectError };
    if (db.blindGuardOnce) {
      db.blindGuardOnce = false;
      return { data: [], error: null };
    }
    return { data: db.expenses.filter((e) => matches(e, filters)), error: null };
  }

  if (table === 'expenses' && op === 'insert') {
    // The partial unique index from the migration, in miniature.
    const clash = db.expenses.some(
      (e) => e.recurring_expense_id
        && e.recurring_expense_id === payload.recurring_expense_id
        && e.date === payload.date,
    );
    if (clash) {
      return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
    }
    db.expenses.push({ id: `exp-${db.expenses.length + 1}`, ...payload });
    return { data: null, error: null };
  }

  return { data: null, error: null };
}

vi.mock('../../src/config.js', () => ({
  supabase: {
    from(table) {
      const builder = { table, op: 'select', filters: [], payload: null };
      const chain = {
        select() { return chain; },
        insert(payload) { builder.op = 'insert'; builder.payload = payload; return chain; },
        update(payload) { builder.op = 'update'; builder.payload = payload; return chain; },
        eq(key, value) { builder.filters.push([key, value]); return chain; },
        lte() { return chain; },
        gte() { return chain; },
        limit() { return chain; },
        order() { return chain; },
        maybeSingle() { return chain; },
        // Thenable, so every shape (with or without a terminal .order/.limit)
        // resolves the same way under await.
        then(resolve, reject) { return Promise.resolve(respond(builder)).then(resolve, reject); },
      };
      return chain;
    },
  },
}));

vi.mock('../../src/lib/logger.js', () => ({
  default: { info() {}, warn() {}, error() {}, debug() {} },
}));

const {
  computeNextDueDate,
  dueDatesUpTo,
  buildGeneratedExpense,
  materialiseDueExpenses,
  MAX_CATCH_UP_PER_RUN,
} = await import('../../src/services/recurring-expenses.js');

beforeEach(() => {
  db.rules = [];
  db.expenses = [];
  db.readError = null;
  db.expenseSelectError = null;
  db.blindGuardOnce = false;
});

// ─────────────────────────────────────────────────────────────

describe('computeNextDueDate: weekly', () => {
  it('finds the next Monday when today is Sunday', () => {
    // 2026-08-02 is a Sunday. day_of_week 1 = Monday.
    expect(computeNextDueDate({ frequency: 'weekly', day_of_week: 1 }, '2026-08-02')).toBe('2026-08-03');
  });

  it('is strictly after, so asking on the day itself gives a week later', () => {
    // Asking from the date just materialised must never return that same date,
    // or the job loops for ever writing the same expense.
    expect(computeNextDueDate({ frequency: 'weekly', day_of_week: 0 }, '2026-08-02')).toBe('2026-08-09');
  });

  it('wraps across the end of the year', () => {
    // 2026-12-28 is a Monday, so the next Monday is in 2027.
    expect(computeNextDueDate({ frequency: 'weekly', day_of_week: 1 }, '2026-12-28')).toBe('2027-01-04');
  });

  it('falls back to the weekday it was anchored on when no day is set', () => {
    expect(computeNextDueDate({ frequency: 'weekly' }, '2026-08-05')).toBe('2026-08-12');
  });
});

describe('computeNextDueDate: monthly', () => {
  it('keeps the same day next month', () => {
    expect(computeNextDueDate({ frequency: 'monthly', day_of_month: 1 }, '2026-08-01')).toBe('2026-09-01');
  });

  it('clamps the 31st into a short February', () => {
    // 2026 is not a leap year, so the 31st lands on the 28th.
    expect(computeNextDueDate({ frequency: 'monthly', day_of_month: 31 }, '2026-01-31')).toBe('2026-02-28');
  });

  it('clamps the 31st into a LEAP February', () => {
    expect(computeNextDueDate({ frequency: 'monthly', day_of_month: 31 }, '2028-01-31')).toBe('2028-02-29');
  });

  it('does not let the clamp stick: after a short February it goes back to the 31st', () => {
    // THE bug this design exists to avoid. If the next date were derived from
    // the previous one rather than from the anchor, March would stay on the
    // 28th and the 31st would be lost for ever.
    expect(computeNextDueDate({ frequency: 'monthly', day_of_month: 31 }, '2026-02-28')).toBe('2026-03-31');
  });

  it('clamps the 30th into February and returns to the 30th in March', () => {
    expect(computeNextDueDate({ frequency: 'monthly', day_of_month: 30 }, '2026-01-30')).toBe('2026-02-28');
    expect(computeNextDueDate({ frequency: 'monthly', day_of_month: 30 }, '2026-02-28')).toBe('2026-03-30');
  });

  it('rolls the year over from December', () => {
    expect(computeNextDueDate({ frequency: 'monthly', day_of_month: 15 }, '2026-12-15')).toBe('2027-01-15');
  });

  it('catches up rather than skipping when the cursor is stale', () => {
    // A cursor left behind by a container that was down still lands on the
    // very next occurrence, not on today.
    expect(computeNextDueDate({ frequency: 'monthly', day_of_month: 1 }, '2026-05-14')).toBe('2026-06-01');
  });
});

describe('computeNextDueDate: yearly', () => {
  it('moves to the same date next year', () => {
    expect(computeNextDueDate({ frequency: 'yearly', month_of_year: 4, day_of_month: 6 }, '2026-04-06')).toBe('2027-04-06');
  });

  it('stays in this year when the date has not passed yet', () => {
    expect(computeNextDueDate({ frequency: 'yearly', month_of_year: 11, day_of_month: 3 }, '2026-08-02')).toBe('2026-11-03');
  });

  it('clamps 29 February to the 28th in a non-leap year', () => {
    expect(computeNextDueDate({ frequency: 'yearly', month_of_year: 2, day_of_month: 29 }, '2028-02-29')).toBe('2029-02-28');
  });

  it('gives the real 29th back in the next leap year', () => {
    expect(computeNextDueDate({ frequency: 'yearly', month_of_year: 2, day_of_month: 29 }, '2027-03-01')).toBe('2028-02-29');
  });
});

describe('computeNextDueDate: rejects nonsense loudly', () => {
  it('throws on an unknown frequency', () => {
    expect(() => computeNextDueDate({ frequency: 'fortnightly' }, '2026-08-02')).toThrow(/frequency/i);
  });

  it('throws on a date that is not a date', () => {
    expect(() => computeNextDueDate({ frequency: 'monthly' }, 'next tuesday')).toThrow(/YYYY-MM-DD/);
  });
});

describe('dueDatesUpTo', () => {
  it('returns nothing when the cursor is in the future', () => {
    const rule = { frequency: 'monthly', day_of_month: 1, next_due_date: '2026-09-01' };
    expect(dueDatesUpTo(rule, '2026-08-02')).toEqual([]);
  });

  it('returns every month a stale cursor owes, oldest first', () => {
    const rule = { frequency: 'monthly', day_of_month: 1, next_due_date: '2026-05-01' };
    expect(dueDatesUpTo(rule, '2026-08-02')).toEqual(['2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01']);
  });

  it('includes a date that falls exactly on today', () => {
    const rule = { frequency: 'monthly', day_of_month: 2, next_due_date: '2026-08-02' };
    expect(dueDatesUpTo(rule, '2026-08-02')).toEqual(['2026-08-02']);
  });

  it('caps a runaway rule instead of writing hundreds of rows into her books', () => {
    const rule = { frequency: 'weekly', day_of_week: 1, next_due_date: '2019-01-07' };
    expect(dueDatesUpTo(rule, '2026-08-02')).toHaveLength(MAX_CATCH_UP_PER_RUN);
  });
});

describe('buildGeneratedExpense', () => {
  it('stamps the UK tax year, not the calendar year', () => {
    // 5 April is the last day of the old year, 6 April the first of the new.
    expect(buildGeneratedExpense({ category: 'rent' }, '2026-04-05').tax_year).toBe('2025-26');
    expect(buildGeneratedExpense({ category: 'rent' }, '2026-04-06').tax_year).toBe('2026-27');
  });

  it('maps the category to its HMRC box and links back to the rule', () => {
    const row = buildGeneratedExpense({ id: 'rule-1', category: 'rent', amount_cents: 45000 }, '2026-09-01');
    expect(row.hmrc_category).toBe('premises');
    expect(row.recurring_expense_id).toBe('rule-1');
    expect(row.amount_cents).toBe(45000);
  });
});

// ─────────────────────────────────────────────────────────────

describe('materialiseDueExpenses', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T09:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function rentRule(overrides = {}) {
    return {
      id: 'rule-rent',
      beautician_id: 'b1',
      amount_cents: 45000,
      vendor: 'Landlord',
      description: 'Salon rent',
      category: 'rent',
      frequency: 'monthly',
      day_of_month: 1,
      day_of_week: null,
      month_of_year: null,
      next_due_date: '2026-08-01',
      active: true,
      last_created_at: null,
      ...overrides,
    };
  }

  it('creates the expense and moves the cursor on', async () => {
    db.rules = [rentRule()];

    const result = await materialiseDueExpenses();

    expect(result.created).toBe(1);
    expect(db.expenses).toHaveLength(1);
    expect(db.expenses[0]).toMatchObject({
      beautician_id: 'b1',
      amount_cents: 45000,
      category: 'rent',
      date: '2026-08-01',
      recurring_expense_id: 'rule-rent',
    });
    expect(db.rules[0].next_due_date).toBe('2026-09-01');
    expect(db.rules[0].last_created_at).toBeTruthy();
  });

  it('is idempotent: running it again the same day writes nothing more', async () => {
    db.rules = [rentRule()];

    await materialiseDueExpenses();
    const second = await materialiseDueExpenses();

    expect(second.created).toBe(0);
    expect(db.expenses).toHaveLength(1);
    expect(db.rules[0].next_due_date).toBe('2026-09-01');
  });

  it('treats a row another replica already wrote as done, not as a failure', async () => {
    // The cursor is still on 1 August but the expense is already there, which
    // is exactly what a crash between the insert and the cursor update leaves
    // behind. It must move the cursor on, not write a second rent.
    db.rules = [rentRule()];
    db.expenses = [{ id: 'exp-existing', recurring_expense_id: 'rule-rent', date: '2026-08-01' }];

    const result = await materialiseDueExpenses();

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    expect(db.expenses).toHaveLength(1);
    expect(db.rules[0].next_due_date).toBe('2026-09-01');
  });

  it('survives the unique index firing under a race', async () => {
    // The read-before-write guard is a race by construction: another replica
    // can commit between the look and the write. The guard is made to miss the
    // row that is already there, so the insert hits the constraint instead.
    // That is the index doing the job the guard cannot, and the pass carries on
    // rather than reporting a failure.
    db.rules = [rentRule()];
    db.expenses = [{ id: 'exp-race', recurring_expense_id: 'rule-rent', date: '2026-08-01' }];
    db.blindGuardOnce = true;

    const result = await materialiseDueExpenses();

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    expect(db.expenses).toHaveLength(1);
    expect(db.rules[0].next_due_date).toBe('2026-09-01');
  });

  it('catches up every month a stale cursor owes, once each', async () => {
    db.rules = [rentRule({ next_due_date: '2026-05-01' })];

    const result = await materialiseDueExpenses();

    expect(result.created).toBe(4);
    expect(db.expenses.map((e) => e.date)).toEqual(['2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01']);
    expect(db.rules[0].next_due_date).toBe('2026-09-01');

    // And a second pass adds nothing, which is the property that matters.
    const second = await materialiseDueExpenses();
    expect(second.created).toBe(0);
    expect(db.expenses).toHaveLength(4);
  });

  it('leaves the cursor alone when it cannot even check for an existing row', async () => {
    // A broken query must never be allowed to decide "no row exists", because
    // that decision writes money into her books.
    db.rules = [rentRule()];
    db.expenseSelectError = { code: '08006', message: 'connection failure' };

    const result = await materialiseDueExpenses();

    expect(result.created).toBe(0);
    expect(result.failed).toBe(1);
    expect(db.expenses).toHaveLength(0);
    expect(db.rules[0].next_due_date).toBe('2026-08-01');
  });

  it('says nothing is due when the migration has not been applied', async () => {
    db.readError = { code: '42P01', message: 'relation "recurring_expenses" does not exist' };

    const result = await materialiseDueExpenses();

    expect(result).toEqual({ created: 0, skipped: 0, rules: 0, failed: 0 });
  });

  it('throws on a real read failure so job_runs records it', async () => {
    // Returning "0 created" on a broken query is indistinguishable from a quiet
    // day, which is how a dead integration stays dead for five weeks.
    db.readError = { code: '08006', message: 'connection failure' };

    await expect(materialiseDueExpenses()).rejects.toThrow(/Could not read recurring expenses/);
  });
});
