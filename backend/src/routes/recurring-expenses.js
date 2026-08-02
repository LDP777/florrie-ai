/**
 * Regular costs: the rules behind the expenses nobody should have to retype.
 *
 * The rows this creates are a SCHEDULE. Nothing here writes to `expenses`
 * directly; the daily job in services/recurring-expenses.js does that, so
 * there is exactly one code path that can put a generated cost in her books.
 *
 * The migration is applied by hand, so every route survives the table not
 * existing yet: reads answer with needs_migration instead of erroring, writes
 * answer 503 with a plain explanation, nothing crashes.
 */
import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';
import {
  computeNextDueDate,
  EXPENSE_CATEGORIES,
  RECURRING_FREQUENCIES,
} from '../services/recurring-expenses.js';

const router = Router();

// 42P01 = relation does not exist, 42703 = column does not exist. Either means
// 20260802_recurring_expenses.sql has not been run yet.
const isPreMigration = (error) => Boolean(error) && (error.code === '42P01' || error.code === '42703');

const MIGRATION_MESSAGE =
  'Regular costs are not switched on for this account yet. Nothing is lost, try again once they are enabled.';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const baseFields = {
  amount_cents: z.number().int().min(1, 'Amount must be more than zero').max(100_000_00),
  vendor: z.string().max(200).nullable().optional(),
  description: z.string().max(1000).nullable().optional(),
  category: z.enum(EXPENSE_CATEGORIES),
  frequency: z.enum(RECURRING_FREQUENCIES),
  day_of_month: z.number().int().min(1).max(31).nullable().optional(),
  day_of_week: z.number().int().min(0).max(6).nullable().optional(),
  month_of_year: z.number().int().min(1).max(12).nullable().optional(),
  active: z.boolean().optional(),
};

const createSchema = z.object({
  ...baseFields,
  // The date of an expense that has ALREADY been paid, when the rule is being
  // created off the back of one. The first generated cost is then the next
  // occurrence after it, never a duplicate of the one she just logged.
  first_date: z.string().regex(DATE_RE).optional(),
  next_due_date: z.string().regex(DATE_RE).optional(),
});

const updateSchema = z.object({
  amount_cents: baseFields.amount_cents.optional(),
  vendor: baseFields.vendor,
  description: baseFields.description,
  category: baseFields.category.optional(),
  frequency: baseFields.frequency.optional(),
  day_of_month: baseFields.day_of_month,
  day_of_week: baseFields.day_of_week,
  month_of_year: baseFields.month_of_year,
  active: baseFields.active,
  next_due_date: z.string().regex(DATE_RE).optional(),
});

/** Today as a plain calendar date. The rows are DATEs; there is no wall-time
 *  question here, only a date one. */
function todayStr() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
}

/** The day before today, so "strictly after" gives "on or after today". */
function yesterdayStr() {
  const t = new Date();
  t.setUTCDate(t.getUTCDate() - 1);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

/**
 * When should this rule first fire?
 *
 * computeNextDueDate is strictly-after by design, so "on or after today" is
 * expressed by asking from yesterday. Anchoring on an already-paid expense
 * instead skips that occurrence, which is the whole point of the "this repeats"
 * tick on the add-expense form.
 */
function firstDueDate(rule, { alreadyPaidOn } = {}) {
  return computeNextDueDate(rule, alreadyPaidOn || yesterdayStr());
}

/**
 * GET /api/recurring-expenses
 * Every regular cost for this salon, soonest due first. Paused rules come last
 * rather than being hidden: a cost she paused and forgot is still a cost.
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('recurring_expenses')
      .select('*')
      .eq('beautician_id', req.beautician.id)
      .order('active', { ascending: false })
      .order('next_due_date', { ascending: true });

    if (isPreMigration(error)) {
      return res.json({ recurring: [], needs_migration: true });
    }
    if (error) {
      logger.error({ err: error }, 'Failed to fetch recurring expenses');
      return res.status(500).json({ error: 'Something went wrong' });
    }
    res.json({ recurring: data || [] });
  } catch (err) {
    logger.error({ err }, 'List recurring expenses error');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * POST /api/recurring-expenses
 * Create a rule. Nothing is charged now: the job creates the first expense on
 * next_due_date.
 */
router.post('/', requireAuth, async (req, res) => {
  const parsed = createSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const body = parsed.data;

  // The anchor is resolved BEFORE the first due date, not after. A monthly rule
  // created from a 15 August expense repeats on the 15th without her saying so,
  // and storing the anchor is what makes it survive the 31st in February. See
  // the migration header for why the anchor is not re-derived each month.
  const anchorDate = body.first_date || todayStr();
  const anchorParts = {
    day: Number(anchorDate.slice(8, 10)),
    month: Number(anchorDate.slice(5, 7)),
    weekday: new Date(`${anchorDate}T00:00:00Z`).getUTCDay(),
  };

  const rule = {
    frequency: body.frequency,
    day_of_month: body.frequency === 'weekly'
      ? null
      : (body.day_of_month ?? anchorParts.day),
    day_of_week: body.frequency === 'weekly'
      ? (body.day_of_week ?? anchorParts.weekday)
      : null,
    month_of_year: body.frequency === 'yearly'
      ? (body.month_of_year ?? anchorParts.month)
      : null,
  };

  let nextDue;
  try {
    nextDue = body.next_due_date || firstDueDate(rule, { alreadyPaidOn: body.first_date });
  } catch {
    return res.status(400).json({ error: 'Could not work out when that would next be due' });
  }

  const { data, error } = await supabase
    .from('recurring_expenses')
    .insert({
      beautician_id: req.beautician.id,
      amount_cents: body.amount_cents,
      vendor: body.vendor || null,
      description: body.description || null,
      category: body.category,
      ...rule,
      next_due_date: nextDue,
      active: body.active !== false,
    })
    .select()
    .single();

  if (isPreMigration(error)) {
    return res.status(503).json({ error: MIGRATION_MESSAGE });
  }
  if (error) {
    logger.error({ err: error }, 'Failed to create recurring expense');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ recurring: data });
});

/**
 * PATCH /api/recurring-expenses/:id
 * Edit or pause a rule. Owner scoped by the WHERE, not by anything in the body.
 */
router.patch('/:id', requireAuth, async (req, res) => {
  const parsed = updateSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const body = parsed.data;

  // Read first, because the new schedule may depend on fields the request did
  // not send, and because un-pausing needs to know it was paused.
  const { data: existing, error: readError } = await supabase
    .from('recurring_expenses')
    .select('*')
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .maybeSingle();

  if (isPreMigration(readError)) {
    return res.status(503).json({ error: MIGRATION_MESSAGE });
  }
  if (readError) {
    logger.error({ err: readError }, 'Failed to read recurring expense');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const updates = {};
  for (const field of ['amount_cents', 'vendor', 'description', 'category', 'frequency', 'day_of_month', 'day_of_week', 'month_of_year', 'active', 'next_due_date']) {
    if (body[field] !== undefined) updates[field] = body[field];
  }

  const merged = { ...existing, ...updates };

  const scheduleChanged = ['frequency', 'day_of_month', 'day_of_week', 'month_of_year']
    .some((f) => body[f] !== undefined && body[f] !== existing[f]);

  const beingResumed = body.active === true && existing.active === false;

  // Two cases where the cursor has to be recomputed rather than left alone:
  //
  //   - the schedule changed, so the old cursor answers the old question;
  //   - the rule is coming off pause with a cursor in the past. Advancing it to
  //     the next FUTURE occurrence is the whole point of pause. Leaving it would
  //     make the job catch up every month she was paused and dump them all into
  //     her books at once, which is the opposite of what she asked for.
  if (body.next_due_date === undefined && (scheduleChanged || (beingResumed && existing.next_due_date < todayStr()))) {
    try {
      updates.next_due_date = firstDueDate(merged);
    } catch {
      return res.status(400).json({ error: 'Could not work out when that would next be due' });
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.json({ recurring: existing });
  }

  const { data, error } = await supabase
    .from('recurring_expenses')
    .update(updates)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select()
    .single();

  if (error || !data) {
    logger.error({ err: error }, 'Failed to update recurring expense');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ recurring: data });
});

/**
 * DELETE /api/recurring-expenses/:id
 * Stop the rule. The expenses it already generated stay: deleting a schedule
 * must never rewrite what was actually spent.
 */
router.delete('/:id', requireAuth, async (req, res) => {
  // .select() so a WHERE that matched nothing cannot report success. A delete
  // that silently no-ops reads to the user as "it worked" and the cost keeps
  // appearing every month.
  const { data, error } = await supabase
    .from('recurring_expenses')
    .delete()
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select('id');

  if (isPreMigration(error)) {
    return res.status(503).json({ error: MIGRATION_MESSAGE });
  }
  if (error) {
    logger.error({ err: error }, 'Failed to delete recurring expense');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  if (!data || data.length === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

export default router;
