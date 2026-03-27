import { Router } from 'express';
import { supabase } from '../index.js';
import { requireAuth } from '../middleware/auth.js';
import Anthropic from 'anthropic';

const router = Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * GET /api/money/pulse
 * Weekly business pulse — income, expenses, profit, comparison.
 * The "Money" digital employee's main output.
 */
router.get('/pulse', requireAuth, async (req, res) => {
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1); // Monday
  weekStart.setHours(0, 0, 0, 0);

  const lastWeekStart = new Date(weekStart);
  lastWeekStart.setDate(lastWeekStart.getDate() - 7);

  // This week's income
  const { data: thisWeekIncome } = await supabase
    .from('transactions')
    .select('amount_cents')
    .eq('beautician_id', req.beautician.id)
    .in('type', ['payment', 'deposit', 'no_show_fee'])
    .eq('status', 'completed')
    .gte('created_at', weekStart.toISOString());

  // Last week's income
  const { data: lastWeekIncome } = await supabase
    .from('transactions')
    .select('amount_cents')
    .eq('beautician_id', req.beautician.id)
    .in('type', ['payment', 'deposit', 'no_show_fee'])
    .eq('status', 'completed')
    .gte('created_at', lastWeekStart.toISOString())
    .lt('created_at', weekStart.toISOString());

  // This week's expenses
  const { data: thisWeekExpenses } = await supabase
    .from('expenses')
    .select('amount_cents, category')
    .eq('beautician_id', req.beautician.id)
    .gte('date', weekStart.toISOString().split('T')[0]);

  // Last week's expenses
  const { data: lastWeekExpenses } = await supabase
    .from('expenses')
    .select('amount_cents')
    .eq('beautician_id', req.beautician.id)
    .gte('date', lastWeekStart.toISOString().split('T')[0])
    .lt('date', weekStart.toISOString().split('T')[0]);

  // This week's appointments
  const { data: thisWeekAppts } = await supabase
    .from('appointments')
    .select('id, status')
    .eq('beautician_id', req.beautician.id)
    .gte('starts_at', weekStart.toISOString())
    .lt('starts_at', now.toISOString());

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
});

/**
 * GET /api/money/tax-summary
 * Year-end self-assessment summary for HMRC.
 * Generates categorised income/expenses for the given tax year.
 */
router.get('/tax-summary', requireAuth, async (req, res) => {
  const taxYear = req.query.year || getCurrentTaxYear();
  const [startYear] = taxYear.split('-').map(Number);

  // UK tax year: 6 April to 5 April
  const periodStart = `${startYear}-04-06`;
  const periodEnd = `${startYear + 1}-04-05`;

  // Total income
  const { data: income } = await supabase
    .from('transactions')
    .select('amount_cents, type, created_at')
    .eq('beautician_id', req.beautician.id)
    .eq('status', 'completed')
    .gte('created_at', `${periodStart}T00:00:00Z`)
    .lte('created_at', `${periodEnd}T23:59:59Z`);

  // All expenses
  const { data: expenses } = await supabase
    .from('expenses')
    .select('amount_cents, category, vendor, date, tax_deductible')
    .eq('beautician_id', req.beautician.id)
    .gte('date', periodStart)
    .lte('date', periodEnd);

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
});

/**
 * POST /api/money/expenses
 * Log a new expense (manual entry).
 */
router.post('/expenses', requireAuth, async (req, res) => {
  const { amount_cents, vendor, description, category, date, tax_deductible } = req.body;

  if (!amount_cents || !category || !date) {
    return res.status(400).json({ error: 'Amount, category, and date are required' });
  }

  const { data, error } = await supabase
    .from('expenses')
    .insert({
      beautician_id: req.beautician.id,
      amount_cents,
      vendor: vendor || null,
      description: description || null,
      category,
      date,
      tax_deductible: tax_deductible !== false,
      tax_year: getTaxYear(new Date(date))
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ expense: data });
});

/**
 * POST /api/money/expenses/scan
 * Scan a receipt photo with Claude Vision, extract amount + vendor.
 */
router.post('/expenses/scan', requireAuth, async (req, res) => {
  const { image_url } = req.body;

  if (!image_url) return res.status(400).json({ error: 'image_url is required' });

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'url', url: image_url }
          },
          {
            type: 'text',
            text: `Extract from this receipt:
- total_amount (in pence, e.g. 1299 for £12.99)
- vendor (shop/company name)
- date (YYYY-MM-DD format)
- category (one of: products, rent, training, travel, equipment, insurance, marketing, software, utilities, other)
- description (brief, e.g. "Brow tint x3, wax strips")

Return JSON only: {"total_amount": 1299, "vendor": "...", "date": "...", "category": "...", "description": "..."}`
          }
        ]
      }]
    });

    const text = response.content[0].text.trim();
    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const extracted = JSON.parse(jsonStr);

    res.json({
      extracted,
      confidence: 0.9 // TODO: implement real confidence scoring
    });

  } catch (err) {
    console.error('Receipt scan error:', err);
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
  if (error) return res.status(500).json({ error: error.message });
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
  if (error) return res.status(500).json({ error: error.message });
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
