import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBeautician, supabase, insertRow } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import ErrorCard from '../components/ErrorCard.jsx';
import EmptyState from '../components/EmptyState.jsx';
import PageHeader from '../components/ui/PageHeader.jsx';
import { hapticTap, hapticSuccess } from '../lib/native.js';
import { useCountUp } from '../lib/useCountUp.js';

/**
 * Money & Revenue - Stitch reference rebuild.
 *
 * Matches the Stitch screen:
 *   - Period selector pills (Today / This Week / This Month)
 *   - Hero revenue card (gradient, large number, % change badge)
 *   - Mini bar chart (7 day)
 *   - Breakdown bento grid (Treatments, Products, Tips)
 *   - Recent Transactions list
 *
 * Four tabs preserved: Pulse, Expenses, Income, Tax
 * All data from Supabase: expenses + transactions tables.
 */

const fmt = (cents) => {
  const pounds = Math.abs(cents) / 100;
  const str = pounds.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return cents < 0 ? `-£${str}` : `£${str}`;
};

const fmtShort = (cents) => {
  const pounds = Math.abs(cents) / 100;
  if (pounds >= 1000) return `£${(pounds / 1000).toFixed(1)}k`;
  return `£${pounds.toFixed(0)}`;
};

const CATEGORIES = [
  { value: 'products', label: 'Products', icon: '🧴', color: 'var(--primary-fixed)' },
  { value: 'rent', label: 'Rent', icon: '🏠', color: 'var(--tertiary-fixed)' },
  { value: 'training', label: 'Training', icon: '📚', color: 'var(--secondary-container)' },
  { value: 'travel', label: 'Travel', icon: '🚗', color: 'var(--success-bg)' },
  { value: 'equipment', label: 'Equipment', icon: '🔧', color: 'var(--tertiary-fixed)' },
  { value: 'insurance', label: 'Insurance', icon: '🛡️', color: 'var(--info-bg)' },
  { value: 'marketing', label: 'Marketing', icon: '📣', color: 'var(--primary-fixed)' },
  { value: 'software', label: 'Software', icon: '💻', color: 'var(--gold-light)' },
  { value: 'utilities', label: 'Utilities', icon: '⚡', color: 'var(--warning-bg)' },
  { value: 'other', label: 'Other', icon: '📌', color: 'var(--surface-container-high)' },
];

const getCategoryMeta = (val) => CATEGORIES.find(c => c.value === val) || CATEGORIES[CATEGORIES.length - 1];

const HMRC_LABELS = {
  cost_of_goods: 'COGS',
  premises: 'Premises',
  admin: 'Admin',
  travel: 'Travel',
  advertising: 'Advertising',
  professional_fees: 'Prof. Fees',
  insurance: 'Insurance',
  interest: 'Interest',
  phone: 'Phone',
  other_expenses: 'Other',
};

function startOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function MIcon({ name, fill, size, style }) {
  return (
    <span className="material-symbols-outlined" style={{
      fontSize: size || 24,
      fontVariationSettings: fill ? "'FILL' 1, 'wght' 300" : undefined,
      ...style,
    }}>{name}</span>
  );
}

export default function MoneyTracker() {
  const navigate = useNavigate();
  const { beautician, loading: bLoading } = useBeautician();
  const [expenses, setExpenses] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [reports, setReports] = useState(null);
  const [tab, setTab] = useState('pulse');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showAddExpense, setShowAddExpense] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [period, setPeriod] = useState('week');

  const [receiptPreview, setReceiptPreview] = useState(null);
  const [showLogTip, setShowLogTip] = useState(false);
  const [showLogSale, setShowLogSale] = useState(false);
  const [tipAmount, setTipAmount] = useState('');
  const [saleAmount, setSaleAmount] = useState('');
  const [saleDesc, setSaleDesc] = useState('');
  const receiptInputRef = useRef(null);

  const [newExpense, setNewExpense] = useState({
    amount: '', vendor: '', description: '',
    category: 'products', date: new Date().toISOString().split('T')[0],
    tax_deductible: true
  });

  useEffect(() => {
    if (beautician) loadData();
  }, [beautician]);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {

      const [expRes, txRes] = await Promise.all([
        supabase.from('expenses')
          .select('*')
          .eq('beautician_id', beautician.id)
          .order('date', { ascending: false })
          .limit(200),
        supabase.from('transactions')
          .select('*, appointments(id, starts_at, client_id, clients(first_name, last_name), treatments(name))')
          .eq('beautician_id', beautician.id)
          .order('created_at', { ascending: false })
          .limit(200),
      ]);

      if (expRes.error) throw expRes.error;
      if (txRes.error) throw txRes.error;

      setExpenses(expRes.data || []);
      setTransactions(txRes.data || []);

      // Reports: revenue MoM, rebooking + no-show rate, one insight (server-computed)
      try {
        const token = (await supabase.auth.getSession())?.data?.session?.access_token;
        const rep = await fetch(`${API_BASE}/api/money/reports`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (rep.ok) setReports(await rep.json());
      } catch { /* non-critical, the rest of the page still works */ }
    } catch (err) {
      logger.error({ err }, 'Money load error');
      setError('Something went wrong loading your money data');
    } finally {
      setLoading(false);
    }
  }

  function computePulse() {
    const now = new Date();
    const thisWeekStart = startOfWeek(now);
    const lastWeekStart = new Date(thisWeekStart);
    lastWeekStart.setDate(lastWeekStart.getDate() - 7);

    const thisWeekIncome = transactions
      .filter(t => new Date(t.created_at) >= thisWeekStart)
      .reduce((sum, t) => sum + (t.amount_cents || 0), 0);

    const lastWeekIncome = transactions
      .filter(t => {
        const d = new Date(t.created_at);
        return d >= lastWeekStart && d < thisWeekStart;
      })
      .reduce((sum, t) => sum + (t.amount_cents || 0), 0);

    const thisWeekExpenses = expenses
      .filter(e => new Date(e.date) >= thisWeekStart)
      .reduce((sum, e) => sum + (e.amount_cents || 0), 0);

    const lastWeekExpenses = expenses
      .filter(e => {
        const d = new Date(e.date);
        return d >= lastWeekStart && d < thisWeekStart;
      })
      .reduce((sum, e) => sum + (e.amount_cents || 0), 0);

    const expenseByCategory = {};
    expenses
      .filter(e => new Date(e.date) >= thisWeekStart)
      .forEach(e => {
        expenseByCategory[e.category] = (expenseByCategory[e.category] || 0) + (e.amount_cents || 0);
      });

    const incomeChange = lastWeekIncome > 0
      ? Math.round(((thisWeekIncome - lastWeekIncome) / lastWeekIncome) * 100)
      : null;

    const thisWeekAppts = transactions.filter(t => new Date(t.created_at) >= thisWeekStart && t.type === 'payment').length;

    return {
      thisWeek: {
        income: thisWeekIncome,
        expenses: thisWeekExpenses,
        profit: thisWeekIncome - thisWeekExpenses,
        appointments: thisWeekAppts,
        noShows: 0,
        noShowRate: 0,
        expenseByCategory,
      },
      lastWeek: {
        income: lastWeekIncome,
        expenses: lastWeekExpenses,
        profit: lastWeekIncome - lastWeekExpenses,
      },
      incomeChange,
    };
  }

  function computeTax() {
    const now = new Date();
    const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    const start = new Date(year, 3, 6);
    const end = new Date(year + 1, 3, 5);

    const yearTx = transactions.filter(t => {
      const d = new Date(t.created_at);
      return d >= start && d <= end;
    });
    const yearExp = expenses.filter(e => {
      const d = new Date(e.date);
      return d >= start && d <= end && e.tax_deductible;
    });

    const totalIncome = yearTx.reduce((sum, t) => sum + (t.amount_cents || 0), 0);
    const totalExpenses = yearExp.reduce((sum, e) => sum + (e.amount_cents || 0), 0);

    const expensesByCategory = {};
    yearExp.forEach(e => {
      if (!expensesByCategory[e.category]) expensesByCategory[e.category] = { total_cents: 0, count: 0 };
      expensesByCategory[e.category].total_cents += e.amount_cents || 0;
      expensesByCategory[e.category].count += 1;
    });

    const monthlyIncome = {};
    yearTx.forEach(t => {
      const d = new Date(t.created_at);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      monthlyIncome[key] = (monthlyIncome[key] || 0) + (t.amount_cents || 0);
    });

    const taxableProfit = totalIncome - totalExpenses;
    const profitPounds = taxableProfit / 100;

    const businessType = beautician?.business_type || 'sole_trader';
    const personalAllowance = 12_570;
    const basicBand = 50_270;

    let incomeTax = 0, niClass2 = 0, niClass4 = 0;
    let corpTax = 0, dividendTax = 0;
    let taxBreakdown = [];

    if (businessType === 'sole_trader') {
      // UK Income Tax 2025/26 bands
      if (profitPounds > personalAllowance) {
        const taxable = profitPounds - personalAllowance;
        const basicPortion = Math.min(taxable, basicBand - personalAllowance);
        const higherPortion = Math.max(0, taxable - basicPortion);
        incomeTax = basicPortion * 0.20 + higherPortion * 0.40;
      }
      // NI Class 2 (£3.45/week if profit > £12,570)
      niClass2 = profitPounds > personalAllowance ? 3.45 * 52 : 0;
      // NI Class 4 (6% on £12,570–£50,270, 2% above)
      if (profitPounds > personalAllowance) {
        const band1 = Math.min(profitPounds, basicBand) - personalAllowance;
        const band2 = Math.max(0, profitPounds - basicBand);
        niClass4 = band1 * 0.06 + band2 * 0.02;
      }
      taxBreakdown = [
        { label: 'Income Tax', hint: '20% basic rate (over £12,570)', value: Math.round(incomeTax * 100) },
        { label: 'NI Class 2', hint: '£3.45/week if profit over threshold', value: Math.round(niClass2 * 100) },
        { label: 'NI Class 4', hint: '6% on £12,570–£50,270', value: Math.round(niClass4 * 100) },
      ];
    } else {
      // Limited company: corporation tax + dividend extraction model
      // Corp tax: 19% (≤£50k), marginal relief £50k–£250k, 25% above
      if (profitPounds <= 50_000) {
        corpTax = profitPounds * 0.19;
      } else if (profitPounds <= 250_000) {
        // Marginal relief: effective rate rises from 19% to 25%
        // Marginal relief fraction = (250,000 - profit) / 200,000 * 3/200
        const marginalRelief = (250_000 - profitPounds) * (3 / 200);
        corpTax = profitPounds * 0.25 - marginalRelief;
      } else {
        corpTax = profitPounds * 0.25;
      }
      // Director salary: £9,100 (NI threshold, tax-free under personal allowance)
      // Post-tax profit extracted as dividends
      const afterTax = profitPounds - corpTax;
      const dividendAllowance = 500;
      const taxableDividends = Math.max(0, afterTax - dividendAllowance);
      dividendTax = taxableDividends * 0.0875; // 8.75% basic rate
      taxBreakdown = [
        { label: 'Corporation Tax', hint: `${profitPounds <= 50_000 ? '19%' : 'marginal rate'} on company profit`, value: Math.round(corpTax * 100) },
        { label: 'Dividend Tax', hint: '8.75% basic rate (over £500 allowance)', value: Math.round(dividendTax * 100) },
        { label: 'Director salary', hint: '£9,100 - within personal allowance, no tax', value: 0 },
      ];
    }

    const totalTaxLiability = businessType === 'sole_trader'
      ? incomeTax + niClass2 + niClass4
      : corpTax + dividendTax;
    const quarterlySetAside = totalTaxLiability / 4;

    // VAT threshold tracking - rolling 12 months of gross income
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);
    const rolling12Revenue = transactions
      .filter(t => new Date(t.created_at || t.date) >= twelveMonthsAgo)
      .reduce((sum, t) => sum + (t.amount_cents || 0), 0);
    const vatThreshold = 90_000 * 100; // in cents
    const vatPct = Math.min(100, Math.round((rolling12Revenue / vatThreshold) * 100));

    // Days until next payment deadline
    const now2 = new Date();
    const deadlines = [
      { label: 'Payment on account 1', date: new Date(year + 1, 0, 31) },
      { label: 'Payment on account 2', date: new Date(year + 1, 6, 31) },
      { label: 'Balancing payment', date: new Date(year + 2, 0, 31) },
    ];
    const nextDeadline = deadlines.find(d => d.date > now2) || deadlines[deadlines.length - 1];
    const daysUntilDeadline = Math.max(0, Math.ceil((nextDeadline.date - now2) / (1000 * 60 * 60 * 24)));

    // Progress through tax year (for progress bar)
    const yearProgress = Math.min(1, Math.max(0, (now2 - start) / (end - start)));

    return {
      taxYear: `${year}/${year + 1}`,
      period: {
        start: start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
        end: end.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
      },
      totalIncome,
      totalExpenses,
      taxableProfit,
      transactionCount: yearTx.length,
      expenseCount: yearExp.length,
      expensesByCategory,
      monthlyIncome,
      taxBreakdown,
      businessType,
      totalTaxLiability: Math.round(totalTaxLiability * 100),
      quarterlySetAside: Math.round(quarterlySetAside * 100),
      nextDeadline: { label: nextDeadline.label, daysLeft: daysUntilDeadline },
      yearProgress,
      vat: { rolling12Revenue, vatThreshold, vatPct, registered: beautician?.vat_registered, vatNumber: beautician?.vat_number },
    };
  }

  async function handleReceiptScan(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setScanning(true);

    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = reader.result.split(',')[1];

        // 1. Upload receipt image to Supabase Storage
        const path = `${beautician.id}/receipts/${Date.now()}-${file.name}`;
        await supabase.storage.from('content-images').upload(path, file);
        const { data: urlData } = supabase.storage.from('content-images').getPublicUrl(path);
        const receiptUrl = urlData?.publicUrl || '';

        // 2. Send to Claude Vision OCR endpoint
        const token = (await supabase.auth.getSession())?.data?.session?.access_token;
        let extracted = null;
        let confidence = 0;

        try {
          const scanRes = await fetch(`${API_BASE}/api/money/expenses/scan`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({ image_base64: base64 }),
          });

          if (scanRes.ok) {
            const scanData = await scanRes.json();
            extracted = scanData.extracted;
            confidence = scanData.confidence || 0;
          } else {
            const errData = await scanRes.json().catch(() => ({}));
            logger.warn('Receipt OCR failed:', errData.error || scanRes.status);
          }
        } catch (ocrErr) {
          logger.warn('Receipt OCR request failed:', ocrErr);
        }

        // 3. Populate expense form - use OCR data if available, fallback to manual
        if (extracted) {
          const amountPounds = extracted.total_amount
            ? (extracted.total_amount / 100).toFixed(2)
            : '';

          setNewExpense({
            amount: amountPounds,
            vendor: extracted.vendor || '',
            description: extracted.description || '',
            category: extracted.category || 'other',
            date: extracted.date || new Date().toISOString().split('T')[0],
            tax_deductible: true,
            receipt_url: receiptUrl,
            hmrc_category: extracted.hmrc_category || '',
            line_items: extracted.line_items || [],
            ocr_confidence: confidence,
          });
        } else {
          // OCR failed - still open the form with the receipt attached
          setNewExpense(prev => ({
            ...prev,
            description: `Receipt: ${file.name}`,
            receipt_url: receiptUrl,
            date: new Date().toISOString().split('T')[0],
          }));
        }

        setReceiptPreview(reader.result);
        setShowAddExpense(true);
        setScanning(false);
      };
      reader.readAsDataURL(file);
    } catch (err) {
      logger.error({ err }, 'Receipt scan error');
      setScanning(false);
    }
  }

  async function handleAddExpense() {
    if (!newExpense.amount || !newExpense.date || !beautician) return;

    try {
      const row = await insertRow('expenses', {
        beautician_id: beautician.id,
        amount_cents: Math.round(parseFloat(newExpense.amount) * 100),
        vendor: newExpense.vendor.trim(),
        description: newExpense.description.trim(),
        category: newExpense.category,
        date: newExpense.date,
        tax_deductible: newExpense.tax_deductible,
      });
      setExpenses(prev => [row, ...prev]);
      setNewExpense({
        amount: '', vendor: '', description: '',
        category: 'products', date: new Date().toISOString().split('T')[0],
        tax_deductible: true
      });
      setReceiptPreview(null);
      setShowAddExpense(false);
    } catch (err) {
      logger.error({ err }, 'Add expense error');
    }
  }

  async function handleLogTip() {
    const cents = Math.round(parseFloat(tipAmount) * 100);
    if (!cents || cents <= 0 || !beautician) return;
    try {
      const payload = {
        beautician_id: beautician.id,
        type: 'tip',
        amount_cents: cents,
        description: 'Tip',
      };
      const row = await insertRow('transactions', payload);
      // Ensure created_at exists for breakdown computation (dev mode doesn't set it)
      const enriched = { ...row, created_at: row.created_at || new Date().toISOString() };
      setTransactions(prev => [enriched, ...prev]);
      hapticSuccess();
      setTipAmount('');
      setShowLogTip(false);
    } catch (err) {
      logger.error({ err }, 'Log tip error');
    }
  }

  async function handleLogSale() {
    const cents = Math.round(parseFloat(saleAmount) * 100);
    if (!cents || cents <= 0 || !beautician) return;
    try {
      const payload = {
        beautician_id: beautician.id,
        type: 'product_sale',
        amount_cents: cents,
        description: saleDesc.trim() || 'Product sale',
      };
      const row = await insertRow('transactions', payload);
      const enriched = { ...row, created_at: row.created_at || new Date().toISOString() };
      setTransactions(prev => [enriched, ...prev]);
      hapticSuccess();
      setSaleAmount('');
      setSaleDesc('');
      setShowLogSale(false);
    } catch (err) {
      logger.error({ err }, 'Log product sale error');
    }
  }

  const pulse = useMemo(() => !loading ? computePulse() : null, [loading, expenses, transactions]);

  const dailyRevenue = useMemo(() => {
    const days = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dayStr = d.toISOString().slice(0, 10);
      const label = d.toLocaleDateString('en-GB', { weekday: 'short' }).charAt(0);
      const total = transactions
        .filter(t => t.created_at?.slice(0, 10) === dayStr)
        .reduce((sum, t) => sum + (t.amount_cents || 0), 0);
      days.push({ label, total, dayStr });
    }
    return days;
  }, [transactions]);

  const maxDayRevenue = useMemo(() => Math.max(...dailyRevenue.map(d => d.total), 1), [dailyRevenue]);

  // Breakdown by real transaction types
  const breakdown = useMemo(() => {
    if (!pulse) return { treatments: 0, products: 0, tips: 0 };
    const weekStart = startOfWeek(new Date());
    const weekTx = transactions.filter(t => new Date(t.created_at) >= weekStart);
    return {
      treatments: weekTx.filter(t => ['service', 'payment', 'payment_link', 'deposit', 'no_show_fee', 'late_cancel_fee'].includes(t.type)).reduce((s, t) => s + (t.amount_cents || 0), 0),
      products: weekTx.filter(t => t.type === 'product_sale').reduce((s, t) => s + (t.amount_cents || 0), 0),
      tips: weekTx.filter(t => t.type === 'tip').reduce((s, t) => s + (t.amount_cents || 0), 0),
    };
  }, [pulse, transactions]);

  const recentTx = useMemo(() => transactions.slice(0, 5), [transactions]);

  // Today's takings, surfaced at the very top so the number Ellie wants is the
  // first thing on the Money page (was buried inside the Pulse tab).
  const todayRevenue = useMemo(() => {
    const todayStr = new Date().toISOString().slice(0, 10);
    return transactions
      .filter(t => t.created_at?.slice(0, 10) === todayStr)
      .reduce((sum, t) => sum + (t.amount_cents || 0), 0);
  }, [transactions]);

  // Roll today's takings up when the Money page opens (Monzo-style).
  const animatedToday = useCountUp(todayRevenue);

  if (bLoading || loading) return <PageLoader />;
  if (error) return <ErrorCard message={error} onDismiss={() => setError(null)} />;

  const changeArrow = pulse?.incomeChange != null ? (pulse.incomeChange >= 0 ? '↑' : '↓') : '';
  const changeColor = pulse?.incomeChange >= 0 ? 'var(--success)' : 'var(--danger)';

  return (
    <div style={S.page}>
      {/* ─── Page Title ─── */}
      <PageHeader title="Money & Revenue" />

      {/* Today's takings, always visible at the top of the page */}
      <div style={{
        background: 'var(--gradient-hero)',
        borderRadius: 18, padding: '16px 18px', color: '#fff',
        boxShadow: '0 6px 20px rgba(146,64,94,0.22)', marginBottom: 14,
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12,
      }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.85 }}>Revenue today</div>
          <div style={{ fontSize: 30, fontWeight: 800, lineHeight: 1.1, marginTop: 2 }}>{fmt(Math.round(animatedToday))}</div>
          {todayRevenue === 0 && (
            <div style={{ fontSize: 11.5, opacity: 0.85, marginTop: 4, maxWidth: 220 }}>
              Tap a client and Mark complete to log their takings here.
            </div>
          )}
        </div>
        {pulse && (
          <div style={{ textAlign: 'right', opacity: 0.92 }}>
            <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.85 }}>This week</div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>{fmt(pulse.thisWeek.income)}</div>
          </div>
        )}
      </div>

      {/* ─── Tab Bar (pill style) ─── */}
      <div style={S.tabBar}>
        {['pulse', 'expenses', 'income', 'tax'].map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              ...S.tab,
              ...(tab === t ? S.tabActive : {}),
            }}
          >
            {t === 'pulse' ? 'Pulse' : t === 'expenses' ? 'Expenses' : t === 'income' ? 'Income' : 'Tax'}
          </button>
        ))}
      </div>

      {/* ═══ PULSE TAB ═══ */}
      {tab === 'pulse' && (
        <div>
          {reports && (
            <div style={S.reportsCard}>
              <div style={S.reportsTitle}>Your numbers</div>
              <div style={S.reportsRow}>
                <div style={S.reportStat}>
                  <span style={S.reportValue}>{`\u00A3${Math.round((reports.revenue.this_month_cents || 0) / 100).toLocaleString('en-GB')}`}</span>
                  <span style={S.reportLabel}>
                    this month{reports.revenue.change_pct != null ? ` \u00B7 ${reports.revenue.change_pct >= 0 ? '+' : ''}${reports.revenue.change_pct}%` : ''}
                  </span>
                </div>
                <div style={S.reportStat}>
                  <span style={S.reportValue}>{reports.rebooking_rate.pct != null ? `${reports.rebooking_rate.pct}%` : '-'}</span>
                  <span style={S.reportLabel}>rebook (90d)</span>
                </div>
                <div style={S.reportStat}>
                  <span style={S.reportValue}>{reports.no_show_rate.pct != null ? `${reports.no_show_rate.pct}%` : '-'}</span>
                  <span style={S.reportLabel}>no-shows (90d)</span>
                </div>
              </div>
              {reports.insight && <div style={S.reportInsight}>{reports.insight}</div>}
            </div>
          )}
          {pulse ? (
            <>
              {/* Period selector */}
              <div style={S.periodBar}>
                {['today', 'week', 'month'].map(p => (
                  <button
                    key={p}
                    onClick={() => setPeriod(p)}
                    style={{
                      ...S.periodBtn,
                      ...(period === p ? S.periodBtnActive : {}),
                    }}
                  >
                    {p === 'today' ? 'Today' : p === 'week' ? 'This Week' : 'This Month'}
                  </button>
                ))}
              </div>

              {/* ─── Hero Revenue Card ─── */}
              <section style={S.heroCard}>
                <div style={S.heroDecor} />
                <div style={{ position: 'relative', zIndex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <MIcon name="payments" fill size={16} style={{ color: 'rgba(255,255,255,0.8)' }} />
                    <span style={S.heroLabel}>Total Revenue</span>
                  </div>
                  <h2 style={S.heroValue}>{fmt(pulse.thisWeek.income)}</h2>
                  {pulse.incomeChange != null && (
                    <span style={{
                      ...S.changeBadge,
                      background: pulse.incomeChange >= 0 ? 'rgba(91,169,123,0.2)' : 'rgba(186,26,26,0.2)',
                      color: pulse.incomeChange >= 0 ? '#8EE0AE' : '#F08080',
                    }}>
                      {changeArrow} {Math.abs(pulse.incomeChange)}% vs last week
                    </span>
                  )}
                </div>
                <div style={S.heroIcon}>
                  <MIcon name="trending_up" size={64} style={{ opacity: 0.15, color: '#fff' }} />
                </div>
              </section>

              {/* ─── Mini Bar Chart ─── */}
              <section style={S.chartCard}>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height: 80 }}>
                  {!dailyRevenue.some(d => d.total > 0) ? (
                    <div style={{ flex: 1, alignSelf: 'center', textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>No takings logged this week yet</div>
                  ) : dailyRevenue.map((d, i) => {
                    const isToday = i === dailyRevenue.length - 1;
                    const h = Math.max(4, (d.total / maxDayRevenue) * 72);
                    return (
                      <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                        <div style={{
                          width: '100%',
                          height: h,
                          borderRadius: 6,
                          background: isToday
                            ? 'linear-gradient(180deg, #c76b8a 0%, #92405e 100%)'
                            : 'rgba(146, 64, 94, 0.15)',
                          transition: 'height 0.3s ease',
                        }} />
                        <span style={{
                          fontSize: 9,
                          fontWeight: isToday ? 700 : 500,
                          color: isToday ? 'var(--accent)' : 'var(--text-muted)',
                          textTransform: 'uppercase',
                        }}>{d.label}</span>
                      </div>
                    );
                  })}
                </div>
              </section>

              {/* ─── Breakdown Bento ─── */}
              <section style={S.bentoGrid}>
                <div style={{ ...S.bentoCard, background: 'rgba(255, 217, 226, 0.3)', border: '1px solid rgba(146, 64, 94, 0.08)' }}>
                  <MIcon name="content_cut" size={20} style={{ color: 'var(--accent)' }} />
                  <span style={S.bentoLabel}>Treatments</span>
                  <span style={{ ...S.bentoValue, color: 'var(--accent)' }}>{fmtShort(breakdown.treatments)}</span>
                </div>
                <div
                  onClick={() => setShowLogSale(s => !s)}
                  style={{ ...S.bentoCard, background: 'rgba(254, 219, 155, 0.3)', border: '1px solid rgba(116, 90, 39, 0.08)', cursor: 'pointer' }}
                >
                  <MIcon name="shopping_bag" size={20} style={{ color: 'var(--gold)' }} />
                  <span style={S.bentoLabel}>Products</span>
                  <span style={{ ...S.bentoValue, color: 'var(--gold)' }}>{fmtShort(breakdown.products)}</span>
                  <span style={{ fontSize: 9, color: 'var(--gold)', opacity: 0.6, marginTop: -2 }}>+ log sale</span>
                </div>
                <div
                  onClick={() => setShowLogTip(s => !s)}
                  style={{ ...S.bentoCard, background: 'rgba(91, 169, 123, 0.1)', border: '1px solid rgba(91, 169, 123, 0.08)', cursor: 'pointer' }}
                >
                  <MIcon name="volunteer_activism" size={20} style={{ color: 'var(--success)' }} />
                  <span style={S.bentoLabel}>Tips</span>
                  <span style={{ ...S.bentoValue, color: 'var(--success)' }}>{fmtShort(breakdown.tips)}</span>
                  <span style={{ fontSize: 9, color: 'var(--success)', opacity: 0.6, marginTop: -2 }}>+ log tip</span>
                </div>
              </section>

              {/* ─── Quick Log Tip ─── */}
              {showLogTip && (
                <section style={S.quickLogCard}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <MIcon name="volunteer_activism" size={18} style={{ color: 'var(--success)' }} />
                    <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Log a Tip</span>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      type="number" step="0.01" placeholder="Amount (£)"
                      value={tipAmount}
                      onChange={e => setTipAmount(e.target.value)}
                      style={{ ...S.formInput, flex: 1 }}
                      autoFocus
                    />
                    <button onClick={handleLogTip} style={{ ...S.btnPrimary, flex: 'none', padding: '11px 20px', background: 'var(--success, #5ba97b)' }}>
                      Save
                    </button>
                    <button onClick={() => { setShowLogTip(false); setTipAmount(''); }} style={{ ...S.btnGhost, flex: 'none' }}>
                      <MIcon name="close" size={16} />
                    </button>
                  </div>
                </section>
              )}

              {/* ─── Quick Log Product Sale ─── */}
              {showLogSale && (
                <section style={S.quickLogCard}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <MIcon name="shopping_bag" size={18} style={{ color: 'var(--gold)' }} />
                    <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Log a Product Sale</span>
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <input
                      type="number" step="0.01" placeholder="Amount (£)"
                      value={saleAmount}
                      onChange={e => setSaleAmount(e.target.value)}
                      style={{ ...S.formInput, flex: 1 }}
                      autoFocus
                    />
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      type="text" placeholder="Product name (optional)"
                      value={saleDesc}
                      onChange={e => setSaleDesc(e.target.value)}
                      style={{ ...S.formInput, flex: 1 }}
                    />
                    <button onClick={handleLogSale} style={{ ...S.btnPrimary, flex: 'none', padding: '11px 20px', background: 'var(--gold)' }}>
                      Save
                    </button>
                    <button onClick={() => { setShowLogSale(false); setSaleAmount(''); setSaleDesc(''); }} style={{ ...S.btnGhost, flex: 'none' }}>
                      <MIcon name="close" size={16} />
                    </button>
                  </div>
                </section>
              )}

              {/* ─── Quick Stats ─── */}
              <section style={S.quickStats}>
                <div style={S.qStat}>
                  <span style={S.qStatValue}>{pulse.thisWeek.appointments}</span>
                  <span style={S.qStatLabel}>Completed</span>
                </div>
                <div style={{ width: 1, height: 28, background: 'rgba(146, 64, 94, 0.1)' }} />
                <div style={S.qStat}>
                  <span style={S.qStatValue}>{fmt(pulse.thisWeek.expenses)}</span>
                  <span style={S.qStatLabel}>Expenses</span>
                </div>
                <div style={{ width: 1, height: 28, background: 'rgba(146, 64, 94, 0.1)' }} />
                <div style={S.qStat}>
                  <span style={{
                    ...S.qStatValue,
                    color: pulse.thisWeek.profit >= 0 ? 'var(--success)' : 'var(--danger)',
                  }}>{fmt(pulse.thisWeek.profit)}</span>
                  <span style={S.qStatLabel}>Profit</span>
                </div>
              </section>

              {/* ─── Recent Transactions ─── */}
              <section>
                <div style={S.sectionHeader}>
                  <h3 style={S.sectionHeading}>Recent Transactions</h3>
                  <button onClick={() => setTab('income')} style={S.seeAll}>See All</button>
                </div>
                {recentTx.length === 0 ? (
                  <EmptyState message="No transactions yet" icon="💰" />
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {recentTx.map(tx => {
                      const isTipOrSale = tx.type === 'tip' || tx.type === 'product_sale';
                      const name = isTipOrSale ? (tx.description || (tx.type === 'tip' ? 'Tip' : 'Product Sale')) : (tx.appointments?.clients?.first_name || 'Payment');
                      const treatment = isTipOrSale ? '' : (tx.appointments?.treatments?.name || '');
                      const initial = isTipOrSale ? (tx.type === 'tip' ? '♥' : '🛍') : name.charAt(0).toUpperCase();
                      const time = new Date(tx.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
                      const isIncome = tx.amount_cents >= 0;
                      const clientId = tx.appointments?.client_id;
                      const apptDate = tx.appointments?.starts_at?.slice(0, 10);
                      return (
                        <div key={tx.id} style={S.txRow}>
                          <div style={{
                            ...S.txAvatar,
                            ...(tx.type === 'tip' ? { background: 'linear-gradient(135deg, #d4f5e0 0%, #a3e4b8 100%)' } :
                                tx.type === 'product_sale' ? { background: 'linear-gradient(135deg, #fedb9b 0%, #f5c563 100%)' } : {}),
                          }}>{initial}</div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
                              {clientId ? (
                                <button
                                  onClick={() => navigate('/clients', { state: { clientId } })}
                                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit', fontWeight: 'inherit', color: 'inherit', textDecoration: 'underline', textDecorationColor: 'rgba(146,64,94,0.25)', textUnderlineOffset: 2 }}
                                >
                                  {name}
                                </button>
                              ) : name}
                            </p>
                            <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>
                              {treatment}{treatment ? ' · ' : ''}
                              {apptDate ? (
                                <button
                                  onClick={() => navigate('/calendar', { state: { date: apptDate } })}
                                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit', color: 'var(--accent, #92405e)', fontWeight: 600 }}
                                >
                                  {time}
                                </button>
                              ) : time}
                            </p>
                          </div>
                          <span style={{
                            fontSize: 14, fontWeight: 700,
                            color: isIncome ? 'var(--success)' : 'var(--danger)',
                          }}>
                            {isIncome ? '+' : '-'}{fmt(tx.amount_cents)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* ─── Last Week Comparison ─── */}
              <section style={{ ...S.compCard, marginTop: 24 }}>
                <h4 style={S.compTitle}>Last Week</h4>
                <div style={S.compRow}><span style={S.compLabel}>Income</span><span style={S.compValue}>{fmt(pulse.lastWeek.income)}</span></div>
                <div style={S.compRow}><span style={S.compLabel}>Expenses</span><span style={S.compValue}>{fmt(pulse.lastWeek.expenses)}</span></div>
                <div style={{ ...S.compRow, borderBottom: 'none' }}>
                  <span style={{ ...S.compLabel, fontWeight: 600 }}>Profit</span>
                  <span style={{ ...S.compValue, fontWeight: 700, color: pulse.lastWeek.profit >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                    {fmt(pulse.lastWeek.profit)}
                  </span>
                </div>
              </section>
            </>
          ) : (
            <EmptyState message="Complete appointments and log expenses to see your pulse." icon="📊" />
          )}
        </div>
      )}

      {/* ═══ EXPENSES TAB ═══ */}
      {tab === 'expenses' && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button onClick={() => setShowAddExpense(!showAddExpense)} style={S.btnPrimary}>
              <MIcon name="add" size={16} style={{ color: '#fff', marginRight: 4 }} />
              Add Expense
            </button>
            <label style={{ ...S.btnSecondary, opacity: scanning ? 0.6 : 1, pointerEvents: scanning ? 'none' : 'auto' }}>
              <MIcon name="photo_camera" size={16} style={{ marginRight: 4 }} />
              {scanning ? 'Reading receipt...' : 'Scan Receipt'}
              <input type="file" accept="image/*" capture="environment" onChange={handleReceiptScan} style={{ display: 'none' }} disabled={scanning} />
            </label>
          </div>

          {showAddExpense && (
            <div style={S.formCard}>
              <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
                <div style={{ flex: 1 }}>
                  <label style={S.formLabel}>Amount (£)</label>
                  <input
                    type="number" step="0.01" placeholder="0.00"
                    value={newExpense.amount}
                    onChange={e => setNewExpense(p => ({ ...p, amount: e.target.value }))}
                    style={S.formInput}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={S.formLabel}>Date</label>
                  <input
                    type="date" value={newExpense.date}
                    onChange={e => setNewExpense(p => ({ ...p, date: e.target.value }))}
                    style={S.formInput}
                  />
                </div>
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={S.formLabel}>Vendor</label>
                <input
                  type="text" placeholder="e.g. Sally Beauty"
                  value={newExpense.vendor}
                  onChange={e => setNewExpense(p => ({ ...p, vendor: e.target.value }))}
                  style={S.formInput}
                />
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={S.formLabel}>Category</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {CATEGORIES.map(c => (
                    <button
                      key={c.value}
                      type="button"
                      onClick={() => setNewExpense(p => ({ ...p, category: c.value }))}
                      style={{
                        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                        padding: '8px 10px', borderRadius: 10, minWidth: 56,
                        border: newExpense.category === c.value ? '1.5px solid var(--accent)' : '1.5px solid var(--border-light)',
                        background: newExpense.category === c.value ? 'var(--accent-bg)' : 'var(--bg-card)',
                        cursor: 'pointer', fontFamily: 'inherit',
                      }}
                    >
                      <span>{c.icon}</span>
                      <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{c.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={S.formLabel}>Description</label>
                <input
                  type="text" placeholder="e.g. Brow tint x3, wax strips"
                  value={newExpense.description}
                  onChange={e => setNewExpense(p => ({ ...p, description: e.target.value }))}
                  style={S.formInput}
                />
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={S.formLabel}>Receipt photo</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {receiptPreview ? (
                    <div style={{ position: 'relative', display: 'inline-block' }}>
                      <img src={receiptPreview} alt="Receipt" style={{ width: 64, height: 64, borderRadius: 10, objectFit: 'cover', border: '1.5px solid var(--border-light)' }} />
                      <button onClick={() => setReceiptPreview(null)} style={{
                        position: 'absolute', top: -6, right: -6,
                        width: 20, height: 20, borderRadius: 10, border: 'none',
                        background: 'var(--danger)', color: '#fff', fontSize: 12,
                        cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>×</button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => receiptInputRef.current?.click()}
                      style={{
                        padding: '10px 16px', borderRadius: 10, border: '1.5px dashed var(--border)',
                        background: 'var(--bg-card)', color: 'var(--text-muted)', fontSize: 13,
                        cursor: 'pointer', fontFamily: 'inherit',
                      }}
                    >
                      <MIcon name="photo_camera" size={14} style={{ marginRight: 4 }} /> Add photo
                    </button>
                  )}
                  <input
                    ref={receiptInputRef}
                    type="file" accept="image/*" capture="environment"
                    onChange={e => {
                      const file = e.target.files?.[0];
                      if (file) setReceiptPreview(URL.createObjectURL(file));
                    }}
                    style={{ display: 'none' }}
                  />
                </div>
              </div>

              {newExpense.ocr_confidence > 0 && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '8px 12px', marginBottom: 12, borderRadius: 8,
                  background: newExpense.ocr_confidence >= 0.8 ? 'var(--success-bg, #E8F5E9)' : 'var(--gold-light, #FDF8EE)',
                  fontSize: 12, color: newExpense.ocr_confidence >= 0.8 ? 'var(--success, #5BA97B)' : 'var(--gold-text, #8A7245)',
                }}>
                  <span>{newExpense.ocr_confidence >= 0.8 ? '✓' : '⚠'}</span>
                  <span>
                    Auto-filled from receipt ({Math.round(newExpense.ocr_confidence * 100)}% confident)
                    {newExpense.ocr_confidence < 0.8 ? ' - double-check the details' : ''}
                  </span>
                </div>
              )}

              <label style={{
                display: 'flex', alignItems: 'center', fontSize: 13,
                color: 'var(--text-secondary)', marginBottom: 14, cursor: 'pointer',
              }}>
                <input
                  type="checkbox" checked={newExpense.tax_deductible}
                  onChange={e => setNewExpense(p => ({ ...p, tax_deductible: e.target.checked }))}
                />
                <span style={{ marginLeft: 8 }}>Tax deductible</span>
              </label>

              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={handleAddExpense} style={S.btnPrimary}>Save Expense</button>
                <button onClick={() => setShowAddExpense(false)} style={S.btnGhost}>Cancel</button>
              </div>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {expenses.length === 0 && (
              <EmptyState message="No expenses logged. Tap + Add Expense to start tracking." icon="🧾" />
            )}
            {expenses.map(exp => {
              const catMeta = getCategoryMeta(exp.category);
              return (
                <div key={exp.id} style={S.txRow}>
                  <div style={{ ...S.catBubble, background: catMeta.color }}>
                    <span style={{ fontSize: 16 }}>{catMeta.icon}</span>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>{exp.vendor || catMeta.label}</p>
                    {exp.description && <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{exp.description}</p>}
                    <p style={{ fontSize: 10, color: 'var(--text-muted)', margin: '2px 0 0' }}>
                      {new Date(exp.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                      {' · '}{catMeta.label}
                      {exp.hmrc_category && ` · ${HMRC_LABELS[exp.hmrc_category] || exp.hmrc_category}`}
                      {exp.tax_deductible && ' · Tax ✓'}
                    </p>
                  </div>
                  <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--danger)', marginLeft: 12, whiteSpace: 'nowrap' }}>
                    -{fmt(exp.amount_cents)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ═══ INCOME TAB ═══ */}
      {tab === 'income' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {transactions.length === 0 && (
            <EmptyState message="Payments from completed appointments will show here." icon="💳" />
          )}
          {transactions.map(tx => {
            const isTipOrSale = tx.type === 'tip' || tx.type === 'product_sale';
            const name = isTipOrSale ? (tx.description || (tx.type === 'tip' ? 'Tip' : 'Product Sale')) : (tx.appointments?.clients?.first_name || 'Payment');
            const treatment = isTipOrSale ? '' : (tx.appointments?.treatments?.name || '');
            const initial = isTipOrSale ? (tx.type === 'tip' ? '♥' : '🛍') : name.charAt(0).toUpperCase();
            const typeLabel = { payment: 'Payment', deposit: 'Deposit', no_show_fee: 'No-show fee', tip: 'Tip', product_sale: 'Product sale' }[tx.type] || tx.type;
            return (
              <div key={tx.id} style={S.txRow}>
                <div style={{
                  ...S.txAvatar,
                  ...(tx.type === 'tip' ? { background: 'linear-gradient(135deg, #d4f5e0 0%, #a3e4b8 100%)' } :
                      tx.type === 'product_sale' ? { background: 'linear-gradient(135deg, #fedb9b 0%, #f5c563 100%)' } : {}),
                }}>{initial}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
                    {name}{treatment ? ` - ${treatment}` : ''}
                  </p>
                  <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>
                    {new Date(tx.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                    {' · '}{typeLabel}
                  </p>
                </div>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--success)', marginLeft: 12 }}>
                  +{fmt(tx.amount_cents)}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* ═══ TAX TAB ═══ */}
      {tab === 'tax' && (
        <div>
          {(() => {
            const t = computeTax();
            return (
              <>
                {/* Header */}
                <div style={{ marginBottom: 20 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <MIcon name="receipt_long" size={18} style={{ color: 'var(--accent)' }} />
                    <h3 style={S.sectionHeading}>Tax Year {t.taxYear}</h3>
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t.period.start} to {t.period.end}</span>

                  {/* Year progress bar */}
                  <div style={{ marginTop: 10, background: 'var(--border, #EDE9E4)', borderRadius: 4, height: 6, overflow: 'hidden' }}>
                    <div style={{ width: `${Math.round(t.yearProgress * 100)}%`, height: '100%', background: 'var(--accent, #C76B8A)', borderRadius: 4, transition: 'width 0.3s ease' }} />
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>{Math.round(t.yearProgress * 100)}% through tax year</span>
                </div>

                {/* Set aside hero card */}
                <div style={S.setAsideCard}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.7)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    {t.businessType === 'limited_co' ? 'Set aside (corp tax + dividends)' : 'Set aside this quarter'}
                  </span>
                  <span style={{ fontSize: 32, fontWeight: 700, color: '#fff', margin: '6px 0' }}>{fmt(t.quarterlySetAside)}</span>
                  <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)' }}>
                    {t.businessType === 'limited_co'
                      ? 'Corp tax due 9 months after year end'
                      : `${t.nextDeadline.label} - ${t.nextDeadline.daysLeft} days away`
                    }
                  </span>
                </div>

                {/* Profit + Tax summary */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
                  <div style={S.taxCard}>
                    <span style={S.taxCardLabel}>Total Income</span>
                    <span style={S.taxCardValue}>{fmt(t.totalIncome)}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t.transactionCount} transactions</span>
                  </div>
                  <div style={S.taxCard}>
                    <span style={S.taxCardLabel}>Deductible Expenses</span>
                    <span style={S.taxCardValue}>{fmt(t.totalExpenses)}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t.expenseCount} items</span>
                  </div>
                  <div style={{ ...S.taxCard, border: '1.5px solid rgba(146, 64, 94, 0.15)' }}>
                    <span style={S.taxCardLabel}>Taxable Profit</span>
                    <span style={{ ...S.taxCardValue, color: 'var(--accent)' }}>{fmt(t.taxableProfit)}</span>
                  </div>
                </div>

                {/* VAT section - registered users get full quarterly view, unregistered get threshold tracker */}
                {t.vat.registered ? (() => {
                  // VAT-registered: standard rate 20% on taxable supplies
                  // Beauty treatments are generally standard-rated (cosmetic) unless medical
                  const vatRate = 0.20;
                  const vatCollected = Math.round(t.totalIncome * vatRate); // output tax
                  const vatOnExpenses = Math.round(t.totalExpenses * vatRate * 0.5); // rough input tax (not all expenses have VAT)
                  const vatOwed = Math.max(0, vatCollected - vatOnExpenses);
                  const vatOwedPerQuarter = Math.round(vatOwed / 4);

                  // MTD quarterly return deadlines (1 month + 7 days after quarter end)
                  const now3 = new Date();
                  const vatDeadlines = [
                    { label: 'Q1 Apr–Jun', due: new Date(now3.getFullYear(), 7, 7) },   // 7 Aug
                    { label: 'Q2 Jul–Sep', due: new Date(now3.getFullYear(), 10, 7) },  // 7 Nov
                    { label: 'Q3 Oct–Dec', due: new Date(now3.getFullYear() + 1, 1, 7) }, // 7 Feb
                    { label: 'Q4 Jan–Mar', due: new Date(now3.getFullYear() + 1, 4, 7) }, // 7 May
                  ];
                  const nextVatDeadline = vatDeadlines.find(d => d.due > now3) || vatDeadlines[vatDeadlines.length - 1];
                  const daysToVat = Math.max(0, Math.ceil((nextVatDeadline.due - now3) / 86400000));

                  return (
                    <div style={{ ...S.breakdownCard, border: '1.5px solid #22c55e30' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                        <h4 style={{ ...S.breakdownTitle, margin: 0 }}>VAT (registered)</h4>
                        <span style={{ fontSize: 11, fontWeight: 600, color: '#22c55e', background: '#f0fdf4', padding: '2px 8px', borderRadius: 10 }}>
                          {t.vat.vatNumber || 'No VAT number set'}
                        </span>
                      </div>
                      <div style={S.breakdownRow}>
                        <div>
                          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Output tax (VAT collected)</span>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block' }}>20% on your income</span>
                        </div>
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{fmt(vatCollected)}</span>
                      </div>
                      <div style={S.breakdownRow}>
                        <div>
                          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Input tax (VAT on expenses)</span>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block' }}>Estimated - confirm with receipts</span>
                        </div>
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>−{fmt(vatOnExpenses)}</span>
                      </div>
                      <div style={{ ...S.breakdownRow, borderBottom: 'none', paddingTop: 12 }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--accent)' }}>VAT owed to HMRC</span>
                        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--accent)' }}>{fmt(vatOwed)}</span>
                      </div>
                      <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 10, background: daysToVat <= 30 ? '#fef3c7' : '#f0fdf4', border: `1px solid ${daysToVat <= 30 ? '#fcd34d' : '#86efac'}` }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: daysToVat <= 30 ? '#92400e' : '#166534' }}>
                          📅 {nextVatDeadline.label} return due in {daysToVat} days ({nextVatDeadline.due.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })})
                        </span>
                        <span style={{ display: 'block', fontSize: 11, color: '#534247', marginTop: 2 }}>
                          Set aside ~{fmt(vatOwedPerQuarter)} per quarter for VAT
                        </span>
                      </div>
                      <button
                        onClick={() => { window.location.href = '/settings?section=tax'; }}
                        style={{ marginTop: 8, padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'none', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', cursor: 'pointer', fontFamily: 'inherit' }}
                      >
                        Update VAT number in Settings →
                      </button>
                    </div>
                  );
                })() : (
                  <div style={S.breakdownCard}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <h4 style={{ ...S.breakdownTitle, margin: 0 }}>VAT Threshold</h4>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Not registered</span>
                    </div>
                    <div style={{ background: 'var(--border, #EDE9E4)', borderRadius: 4, height: 8, overflow: 'hidden', marginBottom: 6 }}>
                      <div style={{
                        width: `${t.vat.vatPct}%`, height: '100%', borderRadius: 4, transition: 'width 0.4s ease',
                        background: t.vat.vatPct >= 90 ? '#ef4444' : t.vat.vatPct >= 75 ? '#f59e0b' : '#22c55e',
                      }} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                      <div>
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>{fmt(t.vat.rolling12Revenue)}</span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}> of £90,000 threshold (rolling 12 months)</span>
                      </div>
                      <span style={{ fontSize: 13, fontWeight: 700, color: t.vat.vatPct >= 75 ? '#ef4444' : 'var(--text-muted)' }}>{t.vat.vatPct}%</span>
                    </div>
                    {t.vat.vatPct >= 75 && (
                      <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 8, background: '#fef3c7', border: '1px solid #fcd34d' }}>
                        <span style={{ fontSize: 12, color: '#92400e', fontWeight: 500 }}>
                          ⚠️ You're {t.vat.vatPct}% of the way to the VAT threshold. HMRC requires registration within 30 days of exceeding £90,000.
                        </span>
                      </div>
                    )}
                    <button
                      onClick={() => { window.location.href = '/settings'; }}
                      style={{ marginTop: 8, padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'none', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', cursor: 'pointer', fontFamily: 'inherit' }}
                    >
                      Update VAT status in Settings →
                    </button>
                  </div>
                )}

                {/* Tax breakdown */}
                <div style={S.breakdownCard}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <h4 style={{ ...S.breakdownTitle, margin: 0 }}>Tax Breakdown</h4>
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', background: 'var(--border-light)', padding: '2px 8px', borderRadius: 10 }}>
                      {t.businessType === 'limited_co' ? 'Ltd company' : 'Sole trader'}
                    </span>
                  </div>
                  {t.taxBreakdown.map((row, i) => (
                    <div key={i} style={S.breakdownRow}>
                      <div>
                        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{row.label}</span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block' }}>{row.hint}</span>
                      </div>
                      <span style={{ fontSize: 13, fontWeight: 600, color: row.value === 0 ? 'var(--text-muted)' : 'var(--text-primary)' }}>
                        {row.value === 0 ? '-' : fmt(row.value)}
                      </span>
                    </div>
                  ))}
                  <div style={{ ...S.breakdownRow, borderBottom: 'none', paddingTop: 12 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--accent)' }}>Total estimated liability</span>
                    <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--accent)' }}>{fmt(t.totalTaxLiability)}</span>
                  </div>
                </div>

                {/* Expense breakdown by category */}
                {Object.keys(t.expensesByCategory).length > 0 && (
                  <div style={S.breakdownCard}>
                    <h4 style={S.breakdownTitle}>Expenses by Category</h4>
                    {Object.entries(t.expensesByCategory)
                      .sort(([, a], [, b]) => b.total_cents - a.total_cents)
                      .map(([cat, data]) => (
                        <div key={cat} style={S.breakdownRow}>
                          <div>
                            <span style={{ fontSize: 13, textTransform: 'capitalize', color: 'var(--text-secondary)' }}>{cat}</span>
                            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}> ({data.count})</span>
                          </div>
                          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{fmt(data.total_cents)}</span>
                        </div>
                      ))
                    }
                  </div>
                )}

                {/* Monthly income */}
                {Object.keys(t.monthlyIncome).length > 0 && (
                  <div style={S.breakdownCard}>
                    <h4 style={S.breakdownTitle}>Monthly Income</h4>
                    {Object.entries(t.monthlyIncome)
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([month, cents]) => {
                        const [y, m] = month.split('-');
                        const label = new Date(y, parseInt(m) - 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
                        return (
                          <div key={month} style={S.breakdownRow}>
                            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{label}</span>
                            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{fmt(cents)}</span>
                          </div>
                        );
                      })
                    }
                  </div>
                )}

                {/* Export for accountant */}
                <button
                  onClick={() => {
                    const a = document.createElement('a');
                    a.href = `/api/exports/tax-quarterly?year=${t.taxYear.replace('/', '-')}`;
                    a.download = '';
                    a.click();
                  }}
                  style={{
                    width: '100%', padding: '14px 0', borderRadius: 12,
                    border: 'none', background: 'var(--accent)', color: '#fff',
                    fontSize: 14, fontWeight: 600, cursor: 'pointer',
                    fontFamily: 'inherit', marginBottom: 12,
                  }}
                >
                  <MIcon name="download" size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} />
                  Export for Accountant
                </button>

                <p style={{
                  fontSize: 12, color: 'var(--text-muted)', textAlign: 'center',
                  padding: '16px 20px', lineHeight: 1.5, fontStyle: 'italic',
                }}>
                  Estimate only. Consult an accountant for your specific situation.
                </p>
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}

const S = {
  page: {
    minHeight: '100vh',
    background: 'var(--bg)',
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)",
    padding: '16px 24px 120px',
    maxWidth: 480,
    margin: '0 auto',
    color: 'var(--text-primary)',
    animation: 'fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
  },
  pageTitle: {
    fontFamily: "var(--font-display, 'Playfair Display', serif)",
    fontSize: 24, fontStyle: 'italic', fontWeight: 400,
    color: 'var(--accent)', margin: '0 0 16px',
  },

  // Tab bar - pill style
  tabBar: {
    display: 'flex', gap: 4,
    background: 'var(--bg-hover)', borderRadius: 14, padding: 4,
    marginBottom: 20,
  },
  tab: {
    flex: 1, padding: '9px 0', fontSize: 13, fontWeight: 500,
    border: 'none', borderRadius: 11, cursor: 'pointer',
    fontFamily: 'inherit', background: 'none', color: 'var(--text-muted)',
    transition: 'all 0.2s ease',
  },
  tabActive: {
    background: 'var(--bg-card)', color: 'var(--text-primary)',
    boxShadow: '0 1px 3px rgba(146, 64, 94, 0.06), 0 1px 2px rgba(146, 64, 94, 0.04)',
    fontWeight: 600,
  },

  // Period selector
  reportsCard: {
    background: 'var(--bg-card)', borderRadius: 18, padding: '18px 16px', marginBottom: 16,
    boxShadow: '0 10px 30px rgba(146, 64, 94, 0.06)',
  },
  reportsTitle: {
    fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
    color: '#b08a98', marginBottom: 14,
  },
  reportsRow: { display: 'flex', gap: 12, justifyContent: 'space-between' },
  reportStat: { display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 },
  reportValue: { fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.1 },
  reportLabel: { fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  reportInsight: {
    marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border-light)',
    fontSize: 13.5, lineHeight: 1.5, color: 'var(--text-secondary)',
  },
  periodBar: {
    display: 'flex', gap: 8, marginBottom: 16,
  },
  periodBtn: {
    padding: '6px 14px', borderRadius: 20,
    border: '1px solid rgba(146, 64, 94, 0.1)', background: 'transparent',
    fontSize: 12, fontWeight: 500, color: 'var(--text-muted)',
    cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s ease',
  },
  periodBtnActive: {
    background: 'var(--accent)', color: '#fff',
    border: '1px solid var(--accent)',
    boxShadow: '0 2px 8px rgba(146, 64, 94, 0.2)',
  },

  // Hero revenue card
  heroCard: {
    position: 'relative', overflow: 'hidden',
    background: 'var(--gradient-hero)',
    color: '#fff', borderRadius: 24, padding: 24, marginBottom: 16,
    boxShadow: '0 8px 32px rgba(146, 64, 94, 0.15)',
  },
  heroDecor: {
    position: 'absolute', top: 0, right: 0,
    width: 128, height: 128,
    background: 'rgba(255,255,255,0.1)',
    borderRadius: '50%', marginRight: -64, marginTop: -64,
    filter: 'blur(32px)',
  },
  heroIcon: { position: 'absolute', bottom: 16, right: 24 },
  heroLabel: {
    fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.12em',
    fontWeight: 700, opacity: 0.8,
  },
  heroValue: {
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)",
    fontSize: 36, fontStyle: 'normal', fontWeight: 700,
    lineHeight: 1.15, margin: '0 0 8px', letterSpacing: '-0.02em',
  },
  changeBadge: {
    display: 'inline-block', padding: '3px 10px', borderRadius: 12,
    fontSize: 11, fontWeight: 600,
  },

  // Chart card
  chartCard: {
    background: 'var(--bg-card)', borderRadius: 16, padding: 16,
    border: '1px solid rgba(146, 64, 94, 0.05)',
    boxShadow: '0 1px 3px rgba(146, 64, 94, 0.04)',
    marginBottom: 16,
  },

  // Bento breakdown
  bentoGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 16 },
  bentoCard: {
    borderRadius: 16, padding: 14,
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
  },
  bentoLabel: {
    fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em',
    color: 'var(--text-muted)', fontWeight: 600,
  },
  bentoValue: {
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)",
    fontSize: 18, fontStyle: 'normal', fontWeight: 700, letterSpacing: '-0.01em',
  },

  // Quick log card
  quickLogCard: {
    background: 'var(--bg-card)', borderRadius: 16, padding: 16, marginBottom: 16,
    border: '1px solid rgba(146, 64, 94, 0.08)',
    boxShadow: '0 2px 8px rgba(146, 64, 94, 0.06)',
    animation: 'fadeIn 0.2s ease',
  },

  // Quick stats row
  quickStats: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-around',
    background: 'var(--bg-card)', borderRadius: 16, padding: '14px 8px',
    border: '1px solid rgba(146, 64, 94, 0.05)',
    boxShadow: '0 1px 3px rgba(146, 64, 94, 0.04)',
    marginBottom: 24,
  },
  qStat: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  qStatValue: { fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' },
  qStatLabel: { fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', fontWeight: 600 },

  // Section headers
  sectionHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
    marginBottom: 12,
  },
  sectionHeading: {
    fontFamily: "var(--font-display, 'Playfair Display', serif)",
    fontSize: 20, fontStyle: 'italic', fontWeight: 400,
    color: 'var(--accent)', margin: 0,
  },
  seeAll: {
    fontSize: 10, fontWeight: 700, color: 'var(--text-muted)',
    textTransform: 'uppercase', letterSpacing: '0.12em',
    background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
  },

  // Transaction rows
  txRow: {
    background: 'var(--bg-card)', padding: 14, borderRadius: 16,
    display: 'flex', alignItems: 'center', gap: 12,
    border: '1px solid rgba(146, 64, 94, 0.05)',
    boxShadow: '0 1px 2px rgba(146, 64, 94, 0.04)',
  },
  txAvatar: {
    width: 36, height: 36, borderRadius: 12,
    background: 'linear-gradient(135deg, #ffd9e2 0%, #ffb1c8 100%)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 14, fontWeight: 700, color: '#92405e', flexShrink: 0,
  },
  catBubble: {
    width: 36, height: 36, borderRadius: 10,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },

  // Comparison card
  compCard: {
    background: 'var(--bg-card)', borderRadius: 16, padding: 16,
    border: '1px solid rgba(146, 64, 94, 0.05)',
    boxShadow: '0 1px 3px rgba(146, 64, 94, 0.04)',
  },
  compTitle: {
    fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 12px',
  },
  compRow: {
    display: 'flex', justifyContent: 'space-between', padding: '8px 0',
    borderBottom: '1px solid rgba(146, 64, 94, 0.05)',
  },
  compLabel: { fontSize: 13, color: 'var(--text-secondary)' },
  compValue: { fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' },

  // Tax cards
  setAsideCard: {
    background: 'linear-gradient(135deg, #92405e 0%, #6d2e46 100%)',
    borderRadius: 16, padding: 20, marginBottom: 16,
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    textAlign: 'center',
  },
  taxCard: {
    background: 'var(--bg-card)', borderRadius: 16, padding: 16,
    border: '1px solid rgba(146, 64, 94, 0.05)',
    boxShadow: '0 1px 3px rgba(146, 64, 94, 0.04)',
  },
  taxCardLabel: {
    display: 'block', fontSize: 10, textTransform: 'uppercase',
    letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 4, fontWeight: 600,
  },
  taxCardValue: {
    display: 'block', fontSize: 22, fontWeight: 700, color: 'var(--text-primary)',
    fontFamily: "var(--font-body)",
  },

  // Breakdown sections
  breakdownCard: {
    background: 'var(--bg-card)', borderRadius: 16, padding: 16, marginBottom: 12,
    border: '1px solid rgba(146, 64, 94, 0.05)',
    boxShadow: '0 1px 3px rgba(146, 64, 94, 0.04)',
  },
  breakdownTitle: { fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 12px' },
  breakdownRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '8px 0', borderBottom: '1px solid rgba(146, 64, 94, 0.04)',
  },

  // Buttons
  btnPrimary: {
    flex: 1, padding: '11px 0', borderRadius: 12,
    border: 'none', background: 'var(--accent)', color: '#fff',
    fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 2px 8px rgba(146, 64, 94, 0.25)',
  },
  btnSecondary: {
    flex: 1, padding: '11px 0', borderRadius: 12,
    border: '1.5px solid var(--border)', background: 'var(--bg-card)',
    color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  btnGhost: {
    padding: '11px 16px', borderRadius: 12, border: 'none',
    background: 'var(--bg-hover)', color: 'var(--text-secondary)', fontSize: 13,
    cursor: 'pointer', fontFamily: 'inherit',
  },

  // Form
  formCard: {
    background: 'var(--bg-card)', borderRadius: 16, padding: 16, marginBottom: 16,
    border: '1px solid rgba(146, 64, 94, 0.05)',
    boxShadow: '0 1px 3px rgba(146, 64, 94, 0.04)',
  },
  formLabel: {
    display: 'block', fontSize: 12, fontWeight: 600,
    color: 'var(--text-secondary)', marginBottom: 6, letterSpacing: '0.01em',
  },
  formInput: {
    width: '100%', padding: '11px 14px', borderRadius: 12,
    border: '1.5px solid var(--border)', fontSize: 14,
    fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
    background: 'var(--bg-input)', color: 'var(--text-primary)',
    transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
  },
};
