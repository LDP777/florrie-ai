import { Router } from 'express';
import { INCOME_TYPES } from '../lib/money-guards.js';
import { z } from 'zod';
import { supabase } from '../config.js';
import { nowInSalonWall } from '../lib/free-slots.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOwned } from '../lib/ownership.js';
import Anthropic from '@anthropic-ai/sdk';
import logger from '../lib/logger.js';
import { expenseSchema } from '../lib/schemas.js';
// Kept on its own line, above the multi-line ledger import. It was once landed
// INSIDE that import's brace list, which is a SyntaxError, so index.js could
// not import this router at all and every /api/money route — the ledger loudest
// among them — died at boot. A broken import reads like a broken feature.
import { selectable, writable } from '../lib/schema-probe.js';
import {
  buildLedger,
  currentTaxYear,
  paginate,
  periodTotals,
  samePointLastYear,
  taxYearBounds,
  taxYearsFrom,
} from '../lib/ledger.js';

const router = Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * TWO CLOCKS, AND THE MONEY PAGE HAS TO KNOW WHICH IS WHICH.
 *
 * appointments.starts_at stores SALON WALL TIME parked in a UTC slot: 10:00 in
 * the salon is written 10:00Z whatever the season. transactions.created_at and
 * the rest of the audit stamps are REAL INSTANTS. Comparing one against the
 * other is an hour wrong for seven months of the year.
 *
 * That is what dropped the appointment she had just finished. `/pulse` counted
 * appointments with `.lt('starts_at', now.toISOString())`, and in BST that
 * bound is an hour behind the salon clock, so anything that finished in the
 * last hour fell outside the week and out of both completedAppts and noShows.
 * The appointment missing from the tally was always the one she opened the page
 * to look at.
 *
 * So the week is worked out ONCE on the salon's clock and then expressed in
 * both frames:
 *   wall    for starts_at
 *   instant for created_at
 *   day     for the plain DATE column on expenses
 * Nothing is "converted to UTC" that was already a real instant.
 */
const SALON_TZ = 'Europe/London';

/** Render a real instant on the salon's clock, in the wall frame. */
function toSalonWall(instant, timeZone = SALON_TZ) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(instant).reduce((a, x) => (a[x.type] = x.value, a), {});
  return new Date(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
}

/**
 * The real instant a wall-frame Date names in the salon's timezone. Two passes
 * because the offset depends on the answer: a first guess lands within an hour,
 * and re-rendering it corrects the guess. That is what makes the boundary right
 * in the week the clocks change instead of only most of the year.
 */
function fromSalonWall(wall, timeZone = SALON_TZ) {
  let guess = new Date(wall.getTime());
  for (let i = 0; i < 2; i += 1) {
    const drift = toSalonWall(guess, timeZone).getTime() - wall.getTime();
    if (drift === 0) break;
    guess = new Date(guess.getTime() - drift);
  }
  return guess;
}

/** Monday 00:00 on the salon clock, as a wall-frame Date. */
function salonWeekStartWall(nowWall) {
  const start = new Date(nowWall.getTime());
  // getUTCDay() is Sunday-0. Monday is the start of her week, and on a Sunday
  // that is six days back, not one day FORWARD, which is what
  // `- getDay() + 1` used to do: every Sunday the pulse showed the week that
  // had not started yet, so it read zero all day.
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

/** A wall-frame Date as the plain YYYY-MM-DD the expenses DATE column holds. */
const wallDay = (wall) => wall.toISOString().slice(0, 10);

/**
 * GET /api/money/pulse
 * Weekly business pulse — income, expenses, profit, comparison.
 * The "Money" digital employee's main output.
 */
router.get('/pulse', requireAuth, async (req, res) => {
  try {
    const nowWall = nowInSalonWall(SALON_TZ);
    const weekStartWall = salonWeekStartWall(nowWall);
    const lastWeekStartWall = new Date(weekStartWall.getTime());
    lastWeekStartWall.setUTCDate(lastWeekStartWall.getUTCDate() - 7);

    // The same two boundaries as real instants, for the columns that hold one.
    const weekStart = fromSalonWall(weekStartWall);
    const lastWeekStart = fromSalonWall(lastWeekStartWall);

    // This week's income
    const { data: thisWeekIncome, error: err1 } = await supabase
      .from('transactions')
      .select('amount_cents')
      .eq('beautician_id', req.beautician.id)
      .in('type', INCOME_TYPES)
      .eq('status', 'completed')
      .gte('created_at', weekStart.toISOString());

    if (err1) {
      logger.error({ err: err1 }, 'Failed to fetch this week income');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    // Last week's income
    const { data: lastWeekIncome, error: err2 } = await supabase
      .from('transactions')
      .select('amount_cents')
      .eq('beautician_id', req.beautician.id)
      .in('type', INCOME_TYPES)
      .eq('status', 'completed')
      .gte('created_at', lastWeekStart.toISOString())
      .lt('created_at', weekStart.toISOString());

    if (err2) {
      logger.error({ err: err2 }, 'Failed to fetch last week income');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    // This week's expenses
    const { data: thisWeekExpenses, error: err3 } = await supabase
      .from('expenses')
      .select('amount_cents, category')
      .eq('beautician_id', req.beautician.id)
      .gte('date', wallDay(weekStartWall));

    if (err3) {
      logger.error({ err: err3 }, 'Failed to fetch this week expenses');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    // Last week's expenses
    const { data: lastWeekExpenses, error: err4 } = await supabase
      .from('expenses')
      .select('amount_cents')
      .eq('beautician_id', req.beautician.id)
      .gte('date', wallDay(lastWeekStartWall))
      .lt('date', wallDay(weekStartWall));

    if (err4) {
      logger.error({ err: err4 }, 'Failed to fetch last week expenses');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    // This week's appointments
    const { data: thisWeekAppts, error: err5 } = await supabase
      .from('appointments')
      .select('id, status')
      .eq('beautician_id', req.beautician.id)
      // starts_at is wall time, so both bounds are wall time. This is the line
      // that lost the appointment she had just finished.
      .gte('starts_at', weekStartWall.toISOString())
      .lt('starts_at', nowWall.toISOString());

    if (err5) {
      logger.error({ err: err5 }, 'Failed to fetch this week appointments');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    const sumCents = (arr) => (arr || []).reduce((sum, r) => sum + (r.amount_cents || 0), 0);
    const thisIncome = sumCents(thisWeekIncome);
    const lastIncome = sumCents(lastWeekIncome);
    const thisExpense = sumCents(thisWeekExpenses);
    const lastExpense = sumCents(lastWeekExpenses);

    const completedAppts = (thisWeekAppts || []).filter(a => a.status === 'completed').length;
    const noShows = (thisWeekAppts || []).filter(a => a.status === 'no_show').length;
    const totalAppts = completedAppts + noShows;

    // Expense breakdown by category
    const expenseByCategory = {};
    (thisWeekExpenses || []).forEach(e => {
      expenseByCategory[e.category] = (expenseByCategory[e.category] || 0) + e.amount_cents;
    });

    const incomeChange = lastIncome > 0
      ? Math.round(((thisIncome - lastIncome) / lastIncome) * 100)
      : null;

    res.json({
      thisWeek: {
        income: thisIncome,
        expenses: thisExpense,
        profit: thisIncome - thisExpense,
        appointments: completedAppts,
        noShows,
        noShowRate: totalAppts > 0 ? Math.round((noShows / totalAppts) * 100) : 0,
        expenseByCategory
      },
      lastWeek: {
        income: lastIncome,
        expenses: lastExpense,
        profit: lastIncome - lastExpense
      },
      incomeChange,
      period: {
        start: weekStart.toISOString(),
        end: new Date().toISOString()
      }
    });
  } catch (err) {
    logger.error({ err }, 'Unexpected error in money pulse');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * GET /api/money/tax-summary
 * Year-end self-assessment summary for HMRC.
 * Generates categorised income/expenses for the given tax year.
 */
router.get('/tax-summary', requireAuth, async (req, res) => {
  try {
    const taxYear = req.query.year || getCurrentTaxYear();
    const [startYear] = taxYear.split('-').map(Number);

    // UK tax year: 6 April to 5 April
    const periodStart = `${startYear}-04-06`;
    const periodEnd = `${startYear + 1}-04-05`;

    // Total income
    const { data: income, error: incomeError } = await supabase
      .from('transactions')
      .select('amount_cents, type, created_at')
      .eq('beautician_id', req.beautician.id)
      .eq('status', 'completed')
      .gte('created_at', `${periodStart}T00:00:00Z`)
      .lte('created_at', `${periodEnd}T23:59:59Z`);

    if (incomeError) {
      logger.error({ err: incomeError }, 'Failed to fetch tax year income');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    // All expenses
    const { data: expenses, error: expenseError } = await supabase
      .from('expenses')
      .select(await selectable(supabase, 'expenses',
          ['amount_cents', 'category', 'vendor', 'date', 'tax_deductible'],
          ['hmrc_category']))
      .eq('beautician_id', req.beautician.id)
      .gte('date', periodStart)
      .lte('date', periodEnd);

    if (expenseError) {
      logger.error({ err: expenseError }, 'Failed to fetch tax year expenses');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    const totalIncome = (income || []).reduce((s, t) => s + t.amount_cents, 0);
    const deductible = (expenses || []).filter(e => e.tax_deductible);
    const totalExpenses = deductible.reduce((s, e) => s + e.amount_cents, 0);

    // Group expenses by category
    const expensesByCategory = {};
    deductible.forEach(e => {
      if (!expensesByCategory[e.category]) {
        expensesByCategory[e.category] = { total_cents: 0, count: 0, items: [] };
      }
      expensesByCategory[e.category].total_cents += e.amount_cents;
      expensesByCategory[e.category].count += 1;
      expensesByCategory[e.category].items.push({
        amount: e.amount_cents,
        vendor: e.vendor,
        date: e.date
      });
    });

    // Group by HMRC category
    const expensesByHmrc = {};
    deductible.forEach(e => {
      const hcat = e.hmrc_category || 'other_expenses';
      if (!expensesByHmrc[hcat]) expensesByHmrc[hcat] = { total_cents: 0, count: 0 };
      expensesByHmrc[hcat].total_cents += e.amount_cents;
      expensesByHmrc[hcat].count += 1;
    });

    // Monthly income breakdown
    const monthlyIncome = {};
    (income || []).forEach(t => {
      const month = new Date(t.created_at).toISOString().slice(0, 7); // YYYY-MM
      monthlyIncome[month] = (monthlyIncome[month] || 0) + t.amount_cents;
    });

    const taxableProfit = totalIncome - totalExpenses;
    const profitPounds = taxableProfit / 100;

    const personalAllowance = 12_570;
    const basicBand = 50_270;
    let incomeTax = 0;
    if (profitPounds > personalAllowance) {
      const taxable = profitPounds - personalAllowance;
      const basicPortion = Math.min(taxable, basicBand - personalAllowance);
      const higherPortion = Math.max(0, taxable - basicPortion);
      incomeTax = basicPortion * 0.20 + higherPortion * 0.40;
    }

    const niClass2Weekly = 3.45;
    const weeksInYear = 52;
    const niClass2 = profitPounds > personalAllowance ? niClass2Weekly * weeksInYear : 0;

    let niClass4 = 0;
    if (profitPounds > personalAllowance) {
      const band1 = Math.min(profitPounds, basicBand) - personalAllowance;
      const band2 = Math.max(0, profitPounds - basicBand);
      niClass4 = band1 * 0.06 + band2 * 0.02;
    }

    const totalTaxLiability = incomeTax + niClass2 + niClass4;

    // UK payment on account deadlines: 31 Jan (first) + 31 Jul (second)
    const quarterlySetAside = totalTaxLiability / 4;

    const deadlines = [
      { label: 'Payment on account 1', date: `${startYear + 1}-01-31` },
      { label: 'Payment on account 2', date: `${startYear + 1}-07-31` },
      { label: 'Balancing payment', date: `${startYear + 2}-01-31` },
    ];

    res.json({
      taxYear,
      period: { start: periodStart, end: periodEnd },
      totalIncome,
      totalExpenses,
      taxableProfit,
      expensesByCategory,
      expensesByHmrc,
      monthlyIncome,
      transactionCount: (income || []).length,
      expenseCount: (expenses || []).length,
      // Tax calculations (all in pence for consistency)
      incomeTax: Math.round(incomeTax * 100),
      niClass2: Math.round(niClass2 * 100),
      niClass4: Math.round(niClass4 * 100),
      totalTaxLiability: Math.round(totalTaxLiability * 100),
      quarterlySetAside: Math.round(quarterlySetAside * 100),
      deadlines,
    });
  } catch (err) {
    logger.error({ err }, 'Unexpected error in tax summary');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * POST /api/money/expenses
 * Log a new expense (manual entry).
 */
router.post('/expenses', requireAuth, async (req, res) => {
  const parsed = expenseSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { amount_cents, vendor, description, category, hmrc_category, date, tax_deductible } = parsed.data;

  // An id in the body is not permission to use it. A caller could post another
  // salon's rule id and hang a row off it; the check is what stops that, and it
  // answers 404 rather than 403 so the API is not an enumeration oracle.
  const recurringExpenseId = req.body?.recurring_expense_id || null;
  if (!await requireOwned(req, res, [
    { table: 'recurring_expenses', id: recurringExpenseId },
  ])) return;

  const { data, error } = await supabase
    .from('expenses')
    .insert(await writable(supabase, 'expenses', {
      beautician_id: req.beautician.id,
      amount_cents,
      vendor: vendor || null,
      description: description || null,
      category,
      hmrc_category: hmrc_category || autoMapHmrcCategory(category),
      date,
      tax_deductible,
      tax_year: getTaxYear(new Date(date)),
      ...(recurringExpenseId ? { recurring_expense_id: recurringExpenseId } : {}),
    }, ['hmrc_category']))
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Failed to create expense');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ expense: data });
});

/**
 * POST /api/money/expenses/scan
 * Scan a receipt photo with Claude Vision, extract amount + vendor + date + category + line items.
 *
 * Body: {
 *   image_url?: "https://...",  (public URL to image)
 *   image_base64?: "iVBORw0KG..." (base64-encoded image with optional data URI prefix)
 * }
 *
 * Returns: {
 *   extracted: { vendor, total_amount (pence), date, category, description, line_items? },
 *   confidence: 0.95 (0.0-1.0, assessed by Claude)
 * }
 */
router.post('/expenses/scan', requireAuth, async (req, res) => {
  const { image_url, image_base64 } = req.body;

  if (!image_url && !image_base64) {
    return res.status(400).json({ error: 'image_url or image_base64 is required' });
  }

  try {
    // Build image source for Claude API
    let imageSource;

    if (image_url) {
      imageSource = { type: 'url', url: image_url };
    } else if (image_base64) {
      // Handle base64 with or without data URI prefix
      let base64Data = image_base64;
      let mediaType = 'image/jpeg'; // default

      // Extract media type if data URI is provided
      const dataUriMatch = image_base64.match(/^data:([^;]+);base64,(.+)$/);
      if (dataUriMatch) {
        mediaType = dataUriMatch[1];
        base64Data = dataUriMatch[2];
      }

      imageSource = { type: 'base64', media_type: mediaType, data: base64Data };
    }

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: imageSource
          },
          {
            type: 'text',
            text: `Extract structured data from this receipt (for a UK self-employed beautician):

Required fields:
- vendor: Shop or company name (e.g., "Boots the Chemist")
- total_amount: Total price in pence (e.g., 1299 for £12.99). If not visible, estimate from line items.
- date: Date of purchase in YYYY-MM-DD format. If only month/year visible, use first day of month.
- category: One of: products, rent, training, travel, equipment, insurance, marketing, software, utilities, other
- hmrc_category: Map to HMRC self-assessment box. One of: cost_of_goods, premises, admin, travel, advertising, professional_fees, insurance, interest, phone, other_expenses
  Mapping guide: beauty products/supplies → cost_of_goods, salon rent/utilities → premises, bookkeeping/software → admin, mileage/parking → travel, social media ads/flyers → advertising, accountant/lawyer → professional_fees, business insurance → insurance, business phone/internet → phone
- description: Brief summary (e.g., "Salon products: dyes, scissors, clips")

Optional fields:
- line_items: Array of {description, amount_cents} for individual items if visible

Assess clarity and confidence:
- 0.95-1.0: All text crisp, clear vendor/amount/date visible
- 0.80-0.94: Mostly readable, minor blur or shadows, date clear
- 0.70-0.79: Partially blurry, some guessing from context
- Below 0.70: Mostly unreadable, heavy artifacts, mostly guessing

Return ONLY valid JSON (no markdown, no code blocks):
{"vendor": "...", "total_amount": 1299, "date": "2026-03-28", "category": "...", "hmrc_category": "...", "description": "...", "confidence": 0.92}`
          }
        ]
      }]
    });

    const text = response.content[0].text.trim();
    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const rawParsed = JSON.parse(jsonStr);

    // Validate AI output structure before trusting it
    const receiptOutputSchema = z.object({
      vendor: z.string().max(300).default('Unknown'),
      total_amount: z.number().int().min(0).max(100_000_00), // max £100k in pence
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}/).default(new Date().toISOString().split('T')[0]),
      category: z.enum(['products', 'rent', 'training', 'travel', 'equipment', 'insurance', 'marketing', 'software', 'utilities', 'other']).default('other'),
      hmrc_category: z.enum(['cost_of_goods', 'premises', 'admin', 'travel', 'advertising', 'professional_fees', 'insurance', 'interest', 'phone', 'other_expenses']).default('other_expenses'),
      description: z.string().max(1000).default(''),
      line_items: z.array(z.object({
        description: z.string().max(300),
        amount_cents: z.number().int().min(0)
      })).max(50).optional(),
      confidence: z.number().min(0).max(1).optional()
    });

    const validated = receiptOutputSchema.safeParse(rawParsed);
    if (!validated.success) {
      logger.warn({ issues: validated.error.issues, raw: rawParsed }, 'Receipt scan AI output failed validation');
      return res.status(422).json({ error: 'Could not extract valid receipt data. Try a clearer photo' });
    }

    const extracted = validated.data;

    // Use Claude's self-assessed confidence, default to 0.8 if not returned
    const confidence = typeof extracted.confidence === 'number'
      ? Math.min(1, Math.max(0, extracted.confidence))
      : 0.8;

    // Remove confidence from the extracted data (it's metadata, not receipt data)
    delete extracted.confidence;

    res.json({
      extracted,
      confidence,
    });

  } catch (err) {
    logger.error({ err }, 'Receipt scan error');
    res.status(500).json({ error: 'Failed to scan receipt' });
  }
});

/**
 * GET /api/money/expenses
 * List expenses with optional filters.
 */
router.get('/expenses', requireAuth, async (req, res) => {
  let query = supabase
    .from('expenses')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .order('date', { ascending: false })
    .limit(50);

  if (req.query.category) query = query.eq('category', req.query.category);
  if (req.query.from) query = query.gte('date', req.query.from);
  if (req.query.to) query = query.lte('date', req.query.to);

  const { data, error } = await query;
  if (error) {
    logger.error({ err: error }, 'Failed to fetch expenses');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ expenses: data });
});

/**
 * GET /api/money/transactions
 * List income transactions.
 */
router.get('/transactions', requireAuth, async (req, res) => {
  let query = supabase
    .from('transactions')
    .select('*, appointments(treatments(name), clients(first_name))')
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false })
    .limit(50);

  const { data, error } = await query;
  if (error) {
    logger.error({ err: error }, 'Failed to fetch transactions');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ transactions: data });
});

// Helpers
/** Auto-map existing category to HMRC category if not provided */
function autoMapHmrcCategory(category) {
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

function getTaxYear(date) {
  const year = date.getFullYear();
  const month = date.getMonth();
  if (month < 3 || (month === 3 && date.getDate() < 6)) {
    return `${year - 1}-${String(year).slice(2)}`;
  }
  return `${year}-${String(year + 1).slice(2)}`;
}

function getCurrentTaxYear() {
  return getTaxYear(new Date());
}

router.get('/reports', requireAuth, async (req, res) => {
  try {
    // Same two clocks as /pulse. The month boundaries are salon-calendar
    // boundaries: worked out on her clock, then expressed as real instants for
    // transactions.created_at and left in the wall frame for starts_at.
    const nowWall = nowInSalonWall(SALON_TZ);

    const startOfMonthWall = new Date(nowWall.getTime());
    startOfMonthWall.setUTCDate(1);
    startOfMonthWall.setUTCHours(0, 0, 0, 0);
    const startOfLastMonthWall = new Date(startOfMonthWall.getTime());
    startOfLastMonthWall.setUTCMonth(startOfLastMonthWall.getUTCMonth() - 1);

    const startOfMonth = fromSalonWall(startOfMonthWall);
    const startOfLastMonth = fromSalonWall(startOfLastMonthWall);

    const ninetyAgoWall = new Date(nowWall.getTime() - 90 * 24 * 60 * 60 * 1000);

    // Revenue: this month vs last month
    const { data: tx } = await supabase
      .from('transactions')
      .select('amount_cents, created_at')
      .eq('beautician_id', req.beautician.id)
      .eq('status', 'completed')
      .in('type', INCOME_TYPES)
      .gte('created_at', startOfLastMonth.toISOString());

    let thisMonth = 0, lastMonth = 0;
    for (const t of tx || []) {
      const d = new Date(t.created_at);
      if (d >= startOfMonth) thisMonth += t.amount_cents || 0;
      else if (d >= startOfLastMonth) lastMonth += t.amount_cents || 0;
    }
    const changePct = lastMonth > 0 ? Math.round(((thisMonth - lastMonth) / lastMonth) * 100) : null;

    // Appointments: last 90 days + all future (future bookings prove rebooking)
    const { data: appts } = await supabase
      .from('appointments')
      .select('id, client_id, starts_at, status')
      .eq('beautician_id', req.beautician.id)
      .gte('starts_at', ninetyAgoWall.toISOString());

    const all = appts || [];
    // starts_at against a wall-frame now, never against a real instant: in BST
    // the real instant is an hour behind the salon clock and the appointment
    // that has just finished still counts as "upcoming".
    const past = all.filter(a => new Date(a.starts_at) <= nowWall);

    // No-show rate over the last 90 days of terminal appointments
    const terminal = past.filter(a => ['completed', 'no_show', 'cancelled', 'rescheduled'].includes(a.status));
    const noShows = terminal.filter(a => a.status === 'no_show').length;
    const noShowRate = terminal.length > 0 ? Math.round((noShows / terminal.length) * 100) : null;

    // Rebooking rate: of completed appts, % whose client has a later booking
    const completed = past.filter(a => a.status === 'completed');
    let rebooked = 0;
    for (const a of completed) {
      const t = new Date(a.starts_at).getTime();
      if (all.some(b => b.client_id === a.client_id && b.id !== a.id
          && new Date(b.starts_at).getTime() > t
          && ['confirmed', 'completed', 'pending'].includes(b.status))) {
        rebooked++;
      }
    }
    const rebookingRate = completed.length > 0 ? Math.round((rebooked / completed.length) * 100) : null;

    // One plain-English insight, rule-based so the numbers are never invented
    let insight;
    if (terminal.length >= 5 && noShowRate != null && noShowRate >= 10) {
      insight = `${noShowRate}% of your appointments were no-shows over the last 90 days. Taking a deposit on booking would cut that.`;
    } else if (completed.length >= 5 && rebookingRate != null && rebookingRate < 50) {
      insight = `Only ${rebookingRate}% of clients rebook. A quick nudge after each visit could lift that.`;
    } else if (changePct != null && changePct >= 5) {
      insight = `You are up ${changePct}% on last month. Nice work.`;
    } else if (changePct != null && changePct <= -5) {
      insight = `You are down ${Math.abs(changePct)}% on last month. Filling a couple of gaps would close it.`;
    } else if ((tx || []).length === 0 && all.length === 0) {
      insight = `Once you have logged a few appointments, Florrie will spot patterns here.`;
    } else {
      insight = `Steady month. Florrie will flag anything worth a look as the numbers build.`;
    }

    res.json({
      revenue: { this_month_cents: thisMonth, last_month_cents: lastMonth, change_pct: changePct },
      rebooking_rate: { pct: rebookingRate, completed: completed.length, rebooked },
      no_show_rate: { pct: noShowRate, total: terminal.length, no_shows: noShows },
      insight,
    });
  } catch (err) {
    logger.error({ err }, 'money.reports failed');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * Nothing is allowed to read the whole table without a ceiling. A solo salon's
 * tax year is a few thousand rows, but a filter of "everything, ever" on an
 * imported history is not, and a running total is computed in memory.
 */
const MAX_LEDGER_ROWS = 3000;

/** Today as a plain calendar date. Expenses are a DATE column, so this is a
 *  date question, not a wall-time one. */
function todayDateStr() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
}

/** The oldest thing this salon has on the books, for the tax-year picker. Two
 *  one-row reads rather than scanning either table. */
async function oldestDatedRow(beauticianId) {
  const [expense, transaction] = await Promise.all([
    supabase.from('expenses').select('date')
      .eq('beautician_id', beauticianId)
      .order('date', { ascending: true }).limit(1).maybeSingle(),
    supabase.from('transactions').select('created_at')
      .eq('beautician_id', beauticianId)
      .order('created_at', { ascending: true }).limit(1).maybeSingle(),
  ]);

  // Supabase reports errors in the result object. A failed lookup here must not
  // silently shorten the year picker, so it degrades to "no idea" and the
  // picker offers the current year only.
  if (expense.error) logger.warn({ err: expense.error }, 'Ledger: could not read the oldest expense');
  if (transaction.error) logger.warn({ err: transaction.error }, 'Ledger: could not read the oldest transaction');

  const candidates = [
    expense.data?.date,
    transaction.data?.created_at ? String(transaction.data.created_at).slice(0, 10) : null,
  ].filter(Boolean).sort();

  return candidates[0] || null;
}

/**
 * GET /api/money/ledger
 *
 * The carry-over view. Every other money surface in this app is a window:
 * /pulse compares this week with last, /coach compares this month with last,
 * the Money page shows today. None of them ever showed a running total or a
 * full history, so "what have I actually spent this year" could only be
 * answered by opening the CSV in a spreadsheet.
 *
 * Query:
 *   from, to       YYYY-MM-DD, inclusive
 *   tax_year       '2026-27', or 'all'. Overrides from/to. UK tax years run
 *                  6 April to 5 April, which is why this is not a year filter
 *   category       an expenses category. Income has no categories, so setting
 *                  this narrows the answer to expenses only
 *   type           expense | income | all   (default all)
 *   page, page_size
 *
 * Returns rows NEWEST FIRST, each carrying the running total as at that row,
 * plus totals by category and one grand total for the whole filter. The running
 * total is accumulated over the entire filtered set before paging, because a
 * running total that restarts on page two is not a running total.
 */
router.get('/ledger', requireAuth, async (req, res) => {
  try {
    const beauticianId = req.beautician.id;
    const requestedYear = req.query.tax_year;
    const type = ['expense', 'income', 'all'].includes(req.query.type) ? req.query.type : 'all';
    const category = req.query.category || null;

    let from = req.query.from || null;
    let to = req.query.to || null;
    let taxYear = null;

    if (requestedYear && requestedYear !== 'all') {
      const bounds = taxYearBounds(requestedYear);
      taxYear = bounds.taxYear;
      from = bounds.start;
      to = bounds.end;
    }

    // A category is an expenses concept. Asking for "products" and getting a
    // deposit back would be a lie, so a category filter implies expenses only.
    const wantExpenses = type !== 'income';
    const wantIncome = type !== 'expense' && !category;

    let expenses = [];
    if (wantExpenses) {
      let q = supabase
        .from('expenses')
        .select(await selectable(supabase, 'expenses',
          ['id', 'amount_cents', 'vendor', 'description', 'category', 'date',
           'tax_deductible', 'recurring_expense_id', 'created_at'],
          ['hmrc_category']))
        .eq('beautician_id', beauticianId)
        .order('date', { ascending: false })
        .limit(MAX_LEDGER_ROWS);
      if (from) q = q.gte('date', from);
      if (to) q = q.lte('date', to);
      if (category) q = q.eq('category', category);

      const { data, error } = await q;
      if (error) {
        logger.error({ err: error }, 'Ledger: failed to fetch expenses');
        return res.status(500).json({ error: 'Something went wrong' });
      }
      expenses = data || [];
    }

    let transactions = [];
    if (wantIncome) {
      let q = supabase
        // payment_method and stripe_payment_intent_id are what separate money
        // that really landed from the row completion writes on an assumption
        // (27 August 2026). buildLedger turns them into one `assumed` flag so
        // the year total she reads here is not quietly optimistic.
        .from('transactions')
        .select('id, amount_cents, type, description, created_at, payment_method, stripe_payment_intent_id')
        .eq('beautician_id', beauticianId)
        .eq('status', 'completed')
        // INCOME_TYPES, never a hand-written list. Four copies of this list is
        // how refunds stopped coming off her totals on some screens and not
        // others. Refund rows are negative, so including the type nets them off.
        .in('type', INCOME_TYPES)
        .order('created_at', { ascending: false })
        .limit(MAX_LEDGER_ROWS);
      if (from) q = q.gte('created_at', `${from}T00:00:00.000Z`);
      if (to) q = q.lte('created_at', `${to}T23:59:59.999Z`);

      const { data, error } = await q;
      if (error) {
        logger.error({ err: error }, 'Ledger: failed to fetch transactions');
        return res.status(500).json({ error: 'Something went wrong' });
      }
      transactions = data || [];
    }

    const { rows, summary } = buildLedger({ expenses, transactions });
    const page = paginate(rows, req.query.page, req.query.page_size);

    const oldest = await oldestDatedRow(beauticianId);

    res.json({
      ...page,
      summary,
      filters: {
        from, to, category, type,
        tax_year: taxYear || (requestedYear === 'all' ? 'all' : null),
      },
      tax_years: taxYearsFrom(oldest),
      // Says so rather than quietly returning a total that is missing rows.
      truncated: expenses.length >= MAX_LEDGER_ROWS || transactions.length >= MAX_LEDGER_ROWS,
    });
  } catch (err) {
    logger.error({ err }, 'Ledger failed');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * GET /api/money/year-to-date
 *
 * Income, expenses and profit for the tax year we are in, with the same slice
 * of the year before alongside.
 *
 * The UK tax year runs 6 April to 5 April, so a calendar-year figure here would
 * disagree with the number that eventually goes on her self-assessment. The
 * comparison is cut off at the same calendar point last year on purpose: this
 * year's four months against last year's twelve always looks like a collapse.
 */
router.get('/year-to-date', requireAuth, async (req, res) => {
  try {
    const beauticianId = req.beautician.id;
    const today = todayDateStr();

    const current = taxYearBounds(req.query.year || currentTaxYear());
    const previousStartYear = Number(current.taxYear.split('-')[0]) - 1;
    const previous = taxYearBounds(`${previousStartYear}-${String(previousStartYear + 1).slice(2)}`);

    // Cut-off for "so far this year". A year already finished is shown whole.
    const asAt = today < current.end ? today : current.end;
    const previousAsAt = today < current.end ? samePointLastYear(asAt) : previous.end;

    // One read per table across both years, then split in memory. Four queries
    // would be four chances for an unchecked error object.
    const [expenseResult, incomeResult] = await Promise.all([
      supabase
        .from('expenses')
        .select('amount_cents, date, category')
        .eq('beautician_id', beauticianId)
        .gte('date', previous.start)
        .lte('date', current.end)
        .limit(MAX_LEDGER_ROWS),
      supabase
        .from('transactions')
        .select('amount_cents, created_at, type')
        .eq('beautician_id', beauticianId)
        .eq('status', 'completed')
        .in('type', INCOME_TYPES)
        .gte('created_at', `${previous.start}T00:00:00.000Z`)
        .lte('created_at', `${current.end}T23:59:59.999Z`)
        .limit(MAX_LEDGER_ROWS),
    ]);

    if (expenseResult.error) {
      logger.error({ err: expenseResult.error }, 'Year to date: failed to fetch expenses');
      return res.status(500).json({ error: 'Something went wrong' });
    }
    if (incomeResult.error) {
      logger.error({ err: incomeResult.error }, 'Year to date: failed to fetch income');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    const expenses = expenseResult.data || [];
    const transactions = incomeResult.data || [];

    res.json({
      current: {
        tax_year: current.taxYear,
        start: current.start,
        end: current.end,
        as_at: asAt,
        ...periodTotals({ expenses, transactions, start: current.start, end: asAt }),
      },
      previous: {
        tax_year: previous.taxYear,
        start: previous.start,
        end: previous.end,
        as_at: previousAsAt,
        // The like-for-like number the UI should show next to this year.
        ...periodTotals({ expenses, transactions, start: previous.start, end: previousAsAt }),
        full_year: periodTotals({ expenses, transactions, start: previous.start, end: previous.end }),
      },
    });
  } catch (err) {
    logger.error({ err }, 'Year to date failed');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

export default router;
