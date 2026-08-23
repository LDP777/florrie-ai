import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';
import { selectable } from '../lib/schema-probe.js';

const router = Router();

/**
 * CSV Escaping utility
 * Properly escapes CSV fields with quotes and handles commas, newlines, quotes
 */
function escapeCSVField(field) {
  if (field === null || field === undefined) {
    return '';
  }

  const str = String(field);

  // If field contains comma, newline, or quote, wrap in quotes and escape internal quotes
  if (str.includes(',') || str.includes('\n') || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

/**
 * Converts an array of objects to CSV format
 */
function toCSV(data, headers) {
  if (!data || data.length === 0) {
    return headers.join(',');
  }

  const rows = [headers.join(',')];

  for (const row of data) {
    const values = headers.map(header => escapeCSVField(row[header]));
    rows.push(values.join(','));
  }

  return rows.join('\n');
}

/**
 * GET /api/exports/clients
 * Export all clients as CSV
 */
router.get('/clients', requireAuth, async (req, res) => {
  try {
    const { data: clients, error } = await supabase
      .from('clients')
      .select('*')
      .eq('beautician_id', req.beautician.id)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error({ err: error }, 'Failed to export clients');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    const headers = [
      'id',
      'first_name',
      'last_name',
      'email',
      'phone',
      'preferred_channel',
      'status',
      'notes',
      'marketing_consent',
      'health_data_consent',
      'created_at',
      'updated_at',
      'last_visit_at'
    ];

    const csv = toCSV(clients || [], headers);

    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `clients-${timestamp}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    logger.error({ err }, 'Failed to generate clients export');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * GET /api/exports/appointments
 * Export appointments as CSV
 * Optional query params:
 *   - from=2026-03-24 (ISO date filter)
 *   - to=2026-03-30 (ISO date filter)
 */
router.get('/appointments', requireAuth, async (req, res) => {
  try {
    let query = supabase
      .from('appointments')
      .select('*, clients(first_name, last_name, email, phone), treatments(name, duration_minutes, price_cents)')
      .eq('beautician_id', req.beautician.id)
      .order('starts_at', { ascending: true });

    if (req.query.from) {
      query = query.gte('starts_at', req.query.from);
    }
    if (req.query.to) {
      query = query.lte('starts_at', req.query.to);
    }

    const { data: appointments, error } = await query;

    if (error) {
      logger.error({ err: error }, 'Failed to export appointments');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    // Flatten nested relationships for CSV
    const flattenedData = (appointments || []).map(apt => ({
      id: apt.id,
      client_name: apt.clients ? `${apt.clients.first_name} ${apt.clients.last_name || ''}`.trim() : '',
      client_email: apt.clients?.email || '',
      client_phone: apt.clients?.phone || '',
      treatment_name: apt.treatments?.name || '',
      duration_minutes: apt.treatments?.duration_minutes || '',
      price_cents: apt.treatments?.price_cents || '',
      starts_at: apt.starts_at,
      ends_at: apt.ends_at,
      status: apt.status,
      notes: apt.beautician_notes,
      created_at: apt.created_at,
      updated_at: apt.updated_at
    }));

    const headers = [
      'id',
      'client_name',
      'client_email',
      'client_phone',
      'treatment_name',
      'duration_minutes',
      'price_cents',
      'starts_at',
      'ends_at',
      'status',
      'notes',
      'created_at',
      'updated_at'
    ];

    const csv = toCSV(flattenedData, headers);

    const timestamp = new Date().toISOString().split('T')[0];
    const fromDate = req.query.from ? req.query.from.split('T')[0] : '';
    const toDate = req.query.to ? req.query.to.split('T')[0] : '';
    const dateRange = fromDate && toDate ? `-${fromDate}-to-${toDate}` : '';
    const filename = `appointments${dateRange}-${timestamp}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    logger.error({ err }, 'Failed to generate appointments export');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * GET /api/exports/tax-quarterly
 * Export quarterly tax summary as CSV for accountants.
 * Query: ?year=2025-26 (UK tax year, defaults to current)
 *
 * Generates a single CSV with sections:
 *   1. Summary (income, expenses, profit, tax estimates)
 *   2. Income by month
 *   3. Expenses by HMRC category
 *   4. Expense detail list
 */
router.get('/tax-quarterly', requireAuth, async (req, res) => {
  try {
    const taxYear = req.query.year || getCurrentTaxYear();
    const [startYear] = taxYear.split('-').map(Number);
    const periodStart = `${startYear}-04-06`;
    const periodEnd = `${startYear + 1}-04-05`;

    // Fetch data
    const [{ data: income }, { data: expenses }] = await Promise.all([
      supabase
        .from('transactions')
        .select('amount_cents, type, created_at')
        .eq('beautician_id', req.beautician.id)
        .eq('status', 'completed')
        .gte('created_at', `${periodStart}T00:00:00Z`)
        .lte('created_at', `${periodEnd}T23:59:59Z`),
      supabase
        .from('expenses')
        .select(await selectable(supabase, 'expenses',
            ['amount_cents', 'category', 'vendor', 'description', 'date', 'tax_deductible'],
            ['hmrc_category']))
        .eq('beautician_id', req.beautician.id)
        .gte('date', periodStart)
        .lte('date', periodEnd)
        .order('date', { ascending: true })
    ]);

    const totalIncome = (income || []).reduce((s, t) => s + t.amount_cents, 0);
    const deductible = (expenses || []).filter(e => e.tax_deductible);
    const totalExpenses = deductible.reduce((s, e) => s + e.amount_cents, 0);
    const taxableProfit = totalIncome - totalExpenses;
    const profitPounds = taxableProfit / 100;

    // Tax calc
    const personalAllowance = 12_570;
    const basicBand = 50_270;
    let incomeTax = 0;
    if (profitPounds > personalAllowance) {
      const taxable = profitPounds - personalAllowance;
      const basicPortion = Math.min(taxable, basicBand - personalAllowance);
      const higherPortion = Math.max(0, taxable - basicPortion);
      incomeTax = basicPortion * 0.20 + higherPortion * 0.40;
    }
    const niClass2 = profitPounds > personalAllowance ? 3.45 * 52 : 0;
    let niClass4 = 0;
    if (profitPounds > personalAllowance) {
      const b1 = Math.min(profitPounds, basicBand) - personalAllowance;
      const b2 = Math.max(0, profitPounds - basicBand);
      niClass4 = b1 * 0.06 + b2 * 0.02;
    }
    const totalTax = incomeTax + niClass2 + niClass4;

    const fmtP = (cents) => (cents / 100).toFixed(2);

    // Build CSV sections
    const lines = [];

    // Section 1: Summary
    lines.push('FLORRIE.AI: QUARTERLY TAX EXPORT');
    lines.push(`Tax Year,${taxYear}`);
    lines.push(`Period,${periodStart} to ${periodEnd}`);
    lines.push(`Generated,${new Date().toISOString().split('T')[0]}`);
    lines.push('');
    lines.push('SUMMARY');
    lines.push(`Total Income,${fmtP(totalIncome)}`);
    lines.push(`Total Deductible Expenses,${fmtP(totalExpenses)}`);
    lines.push(`Taxable Profit,${fmtP(taxableProfit)}`);
    lines.push('');
    lines.push('ESTIMATED TAX LIABILITY');
    lines.push(`Income Tax (20% basic rate),${incomeTax.toFixed(2)}`);
    lines.push(`NI Class 2 (£3.45/wk),${niClass2.toFixed(2)}`);
    lines.push(`NI Class 4 (6%),${niClass4.toFixed(2)}`);
    lines.push(`Total Estimated Tax,${totalTax.toFixed(2)}`);
    lines.push('');

    // Section 2: Income by month
    lines.push('INCOME BY MONTH');
    lines.push('Month,Amount');
    const monthlyIncome = {};
    (income || []).forEach(t => {
      const month = new Date(t.created_at).toISOString().slice(0, 7);
      monthlyIncome[month] = (monthlyIncome[month] || 0) + t.amount_cents;
    });
    Object.entries(monthlyIncome).sort(([a], [b]) => a.localeCompare(b)).forEach(([m, c]) => {
      lines.push(`${m},${fmtP(c)}`);
    });
    lines.push('');

    // Section 3: Expenses by HMRC category
    const HMRC_LABELS = {
      cost_of_goods: 'Cost of Goods Sold', premises: 'Premises', admin: 'Admin Costs',
      travel: 'Travel', advertising: 'Advertising', professional_fees: 'Professional Fees',
      insurance: 'Insurance', interest: 'Interest', phone: 'Phone & Internet',
      other_expenses: 'Other Allowable Expenses'
    };
    lines.push('EXPENSES BY HMRC CATEGORY');
    lines.push('HMRC Category,Count,Amount');
    const byHmrc = {};
    deductible.forEach(e => {
      const hcat = e.hmrc_category || 'other_expenses';
      if (!byHmrc[hcat]) byHmrc[hcat] = { count: 0, total: 0 };
      byHmrc[hcat].count += 1;
      byHmrc[hcat].total += e.amount_cents;
    });
    Object.entries(byHmrc).sort(([, a], [, b]) => b.total - a.total).forEach(([cat, d]) => {
      lines.push(`${escapeCSVField(HMRC_LABELS[cat] || cat)},${d.count},${fmtP(d.total)}`);
    });
    lines.push('');

    // Section 4: Expense detail
    lines.push('EXPENSE DETAIL');
    lines.push('Date,Vendor,Description,Category,HMRC Category,Amount,Tax Deductible');
    (expenses || []).forEach(e => {
      lines.push([
        e.date,
        escapeCSVField(e.vendor || ''),
        escapeCSVField(e.description || ''),
        e.category,
        HMRC_LABELS[e.hmrc_category] || e.hmrc_category || '',
        fmtP(e.amount_cents),
        e.tax_deductible ? 'Yes' : 'No'
      ].join(','));
    });

    lines.push('');
    lines.push('NOTE: These figures are estimates only. Please consult your accountant before filing your self-assessment.');

    const csv = lines.join('\n');
    const filename = `florrie-tax-${taxYear.replace('/', '-')}-${new Date().toISOString().split('T')[0]}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    logger.error({ err }, 'Failed to generate tax export');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

function getCurrentTaxYear() {
  const now = new Date();
  const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}-${String(year + 1).slice(2)}`;
}

export default router;
