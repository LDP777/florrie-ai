import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../index.js';
import { requireAuth } from '../middleware/auth.js';
import Anthropic from '@anthropic-ai/sdk';
import logger from '../lib/logger.js';

const expenseSchema = z.object({
  amount_cents: z.number().int().min(1, 'Amount must be positive'),
  vendor: z.string().max(200).nullable().optional(),
  description: z.string().max(1000).nullable().optional(),
  category: z.string().min(1).max(100),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'Date must be YYYY-MM-DD format'),
  tax_deductible: z.boolean().optional().default(true)
});

const router = Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * GET /api/money/pulse
 * Weekly business pulse — income, expenses, profit, comparison.
 * The "Money" digital employee's main output.
 */
router.get('/pulse', requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1); // Monday
    weekStart.setHours(0, 0, 0, 0);

    const lastWeekStart = new Date(weekStart);
    lastWeekStart.setDate(lastWeekStart.getDate() - 7);

    // This week's income
    const { data: thisWeekIncome, error: err1 } = await supabase
      .from('transactions')
      .select('amount_cents')
      .eq('beautician_id', req.beautician.id)
      .in('type', ['payment', 'deposit', 'no_show_fee'])
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
      .in('type', ['payment', 'deposit', 'no_show_fee'])
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
      .gte('date', weekStart.toISOString().split('T')[0]);

    if (err3) {
      logger.error({ err: err3 }, 'Failed to fetch this week expenses');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    // Last week's expenses
    const { data: lastWeekExpenses, error: err4 } = await supabase
      .from('expenses')
      .select('amount_cents')
      .eq('beautician_id', req.beautician.id)
      .gte('date', lastWeekStart.toISOString().split('T')[0])
      .lt('date', weekStart.toISOString().split('T')[0]);

    if (err4) {
      logger.error({ err: err4 }, 'Failed to fetch last week expenses');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    // This week's appointments
    const { data: thisWeekAppts, error: err5 } = await supabase
      .from('appointments')
      .select('id, status')
      .eq('beautician_id', req.beautician.id)
      .gte('starts_at', weekStart.toISOString())
      .lt('starts_at', now.toISOString());

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
        end: now.toISOString()
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
      .select('amount_cents, category, vendor, date, tax_deductible')
      .eq('beautician_id', req.beautician.id)
      .gte('date', periodStart)
      .lte('date', periodEnd);

    if (expenseError) {
      logger.error({ err: expenseError }, 'Failed to fetch tax year expenses');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    const totalIncome = (income || []).reduce((s, t) => s + t.amount_cents, 0);
    const totalExpenses = (expenses || []).filter(e => e.tax_deductible).reduce((s, e) => s + e.amount_cents, 0);

    // Group expenses by category
    const expensesByCategory = {};
    (expenses || []).filter(e => e.tax_deductible).forEach(e => {
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

    // Monthly income breakdown
    const monthlyIncome = {};
    (income || []).forEach(t => {
      const month = new Date(t.created_at).toISOString().slice(0, 7); // YYYY-MM
      monthlyIncome[month] = (monthlyIncome[month] || 0) + t.amount_cents;
    });

    res.json({
      taxYear,
      period: { start: periodStart, end: periodEnd },
      totalIncome,
      totalExpenses,
      taxableProfit: totalIncome - totalExpenses,
      expensesByCategory,
      monthlyIncome,
      transactionCount: (income || []).length,
      expenseCount: (expenses || []).length
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

  const { amount_cents, vendor, description, category, date, tax_deductible } = parsed.data;

  const { data, error } = await supabase
    .from('expenses')
    .insert({
      beautician_id: req.beautician.id,
      amount_cents,
      vendor: vendor || null,
      description: description || null,
      category,
      date,
      tax_deductible,
      tax_year: getTaxYear(new Date(date))
    })
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
            text: `Extract structured data from this receipt:

Required fields:
- vendor: Shop or company name (e.g., "Boots the Chemist")
- total_amount: Total price in pence (e.g., 1299 for £12.99). If not visible, estimate from line items.
- date: Date of purchase in YYYY-MM-DD format. If only month/year visible, use first day of month.
- category: One of: products, rent, training, travel, equipment, insurance, marketing, software, utilities, other
- description: Brief summary (e.g., "Salon products: dyes, scissors, clips")

Optional fields:
- line_items: Array of {description, amount_cents} for individual items if visible
- confidence: (You provide this, don't make Claude guess)

Assess clarity and confidence:
- 0.95-1.0: All text crisp, clear vendor/amount/date visible
- 0.80-0.94: Mostly readable, minor blur or shadows, date clear
- 0.70-0.79: Partially blurry, some guessing from context
- Below 0.70: Mostly unreadable, heavy artifacts, mostly guessing

Return ONLY valid JSON (no markdown, no code blocks):
{"vendor": "...", "total_amount": 1299, "date": "2026-03-28", "category": "...", "description": "...", "confidence": 0.92}`
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
      return res.status(422).json({ error: 'Could not extract valid receipt data — try a clearer photo' });
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

export default router;
