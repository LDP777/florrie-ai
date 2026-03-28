import { useState, useEffect, useRef } from 'react';
import { useBeautician, supabase, isDevMode, insertRow } from '../lib/supabase.js';
import logger from '../lib/logger.js';

/**
 * Money Tracker — Ellie's #2 pain point.
 *
 * Four tabs:
 *   Pulse    — weekly income, expenses, profit at a glance
 *   Expenses — log manually, categorise, flag as tax-deductible
 *   Income   — payments from completed appointments
 *   Tax      — HMRC-ready annual summary
 *
 * All data from Supabase: expenses + transactions tables.
 * Pulse and tax computed client-side from raw rows.
 */

const fmt = (cents) => {
  const pounds = Math.abs(cents) / 100;
  const str = pounds.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return cents < 0 ? `-£${str}` : `£${str}`;
};

const CATEGORIES = [
  { value: 'products', label: 'Products', icon: '🧴', color: '#E8D5E0' },
  { value: 'rent', label: 'Rent', icon: '🏠', color: '#D5E0E8' },
  { value: 'training', label: 'Training', icon: '📚', color: '#E8E0D5' },
  { value: 'travel', label: 'Travel', icon: '🚗', color: '#D5E8E0' },
  { value: 'equipment', label: 'Equipment', icon: '🔧', color: '#E0D5E8' },
  { value: 'insurance', label: 'Insurance', icon: '🛡️', color: '#D5E8E8' },
  { value: 'marketing', label: 'Marketing', icon: '📣', color: '#E8D5D5' },
  { value: 'software', label: 'Software', icon: '💻', color: '#D8D5E8' },
  { value: 'utilities', label: 'Utilities', icon: '⚡', color: '#E8E8D5' },
  { value: 'other', label: 'Other', icon: '📌', color: '#E0E0E0' },
];

const getCategoryMeta = (val) => CATEGORIES.find(c => c.value === val) || CATEGORIES[CATEGORIES.length - 1];

function startOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday start
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

export default function MoneyTracker() {
  const { beautician, loading: bLoading } = useBeautician();
  const [expenses, setExpenses] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [tab, setTab] = useState('pulse');
  const [loading, setLoading] = useState(true);
  const [showAddExpense, setShowAddExpense] = useState(false);
  const [scanning, setScanning] = useState(false);

  const [receiptPreview, setReceiptPreview] = useState(null);
  const receiptInputRef = useRef(null);

  // New expense form
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
    try {
      if (isDevMode) {
        setExpenses(DEV_EXPENSES);
        setTransactions(DEV_TRANSACTIONS);
        setLoading(false);
        return;
      }

      const [expRes, txRes] = await Promise.all([
        supabase.from('expenses')
          .select('*')
          .eq('beautician_id', beautician.id)
          .order('date', { ascending: false })
          .limit(200),
        supabase.from('transactions')
          .select('*, appointments(starts_at, clients(first_name, last_name), treatments(name))')
          .eq('beautician_id', beautician.id)
          .order('created_at', { ascending: false })
          .limit(200),
      ]);

      setExpenses(expRes.data || []);
      setTransactions(txRes.data || []);
    } catch (err) {
      logger.error('Money load error:', err);
    } finally {
      setLoading(false);
    }
  }

  // ── Pulse computation (client-side) ──

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

  // ── Tax computation (client-side) ──

  function computeTax() {
    // UK tax year: 6 April to 5 April
    const now = new Date();
    const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    const start = new Date(year, 3, 6); // April 6
    const end = new Date(year + 1, 3, 5); // April 5 next year

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

    return {
      taxYear: `${year}/${year + 1}`,
      period: {
        start: start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
        end: end.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
      },
      totalIncome,
      totalExpenses,
      taxableProfit: totalIncome - totalExpenses,
      transactionCount: yearTx.length,
      expenseCount: yearExp.length,
      expensesByCategory,
      monthlyIncome,
    };
  }

  // ── Receipt scanning ──

  async function handleReceiptScan(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setScanning(true);

    try {
      // Upload to Supabase Storage for processing
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = reader.result.split(',')[1];

        if (isDevMode) {
          // Mock OCR result for dev mode
          setNewExpense({
            amount: '23.50',
            vendor: 'Sally Beauty',
            description: 'Brow tint x2, wax strips',
            category: 'products',
            date: new Date().toISOString().split('T')[0],
            tax_deductible: true
          });
          setShowAddExpense(true);
          setScanning(false);
          return;
        }

        // Upload receipt image
        const path = `${beautician.id}/receipts/${Date.now()}-${file.name}`;
        await supabase.storage.from('content-images').upload(path, file);

        // Call edge function for OCR (or use AI service)
        // For now, open the form with the image attached so user can fill manually
        // TODO: Wire to Supabase Edge Function with Claude Vision OCR
        const { data: urlData } = supabase.storage.from('content-images').getPublicUrl(path);

        setNewExpense(prev => ({
          ...prev,
          description: `Receipt: ${file.name}`,
          receipt_url: urlData?.publicUrl || '',
          date: new Date().toISOString().split('T')[0],
        }));
        setShowAddExpense(true);
        setScanning(false);
      };
      reader.readAsDataURL(file);
    } catch (err) {
      logger.error('Receipt scan error:', err);
      setScanning(false);
    }
  }

  // ── Add expense ──

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
      logger.error('Add expense error:', err);
    }
  }

  if (bLoading) {
    return <p style={{ textAlign: 'center', color: '#AAA5A0', padding: 60, fontSize: 14, fontFamily: '"DM Sans", sans-serif' }}>Loading...</p>;
  }

  const pulse = !loading ? computePulse() : null;
  const changeArrow = pulse?.incomeChange != null ? (pulse.incomeChange >= 0 ? '↑' : '↓') : '';
  const changeColor = pulse?.incomeChange >= 0 ? '#4CAF50' : '#E57373';

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>Money</h1>
          <p style={styles.subtitle}>Your Financial Tracker</p>
        </div>
      </div>

      {/* Tabs */}
      <div style={styles.tabs}>
        {['pulse', 'expenses', 'income', 'tax'].map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              ...styles.tab,
              borderBottomColor: tab === t ? '#C76B8A' : 'transparent',
              color: tab === t ? '#C76B8A' : '#AAA5A0'
            }}
          >
            {t === 'pulse' ? 'Pulse' : t === 'expenses' ? 'Expenses' : t === 'income' ? 'Income' : 'Tax'}
          </button>
        ))}
      </div>

      {/* === PULSE TAB === */}
      {tab === 'pulse' && (
        <div>
          {loading ? (
            <p style={styles.loadingText}>Loading your numbers...</p>
          ) : pulse ? (
            <>
              <div style={styles.pulseGrid}>
                <div style={styles.pulseCard}>
                  <span style={styles.pulseLabel}>Income</span>
                  <span style={styles.pulseValue}>{fmt(pulse.thisWeek.income)}</span>
                  {pulse.incomeChange != null && (
                    <span style={{ ...styles.pulseChange, color: changeColor }}>
                      {changeArrow} {Math.abs(pulse.incomeChange)}% vs last week
                    </span>
                  )}
                </div>
                <div style={styles.pulseCard}>
                  <span style={styles.pulseLabel}>Expenses</span>
                  <span style={styles.pulseValue}>{fmt(pulse.thisWeek.expenses)}</span>
                </div>
                <div style={{ ...styles.pulseCard, ...styles.profitCard }}>
                  <span style={styles.pulseLabel}>Profit</span>
                  <span style={{
                    ...styles.pulseValue,
                    color: pulse.thisWeek.profit >= 0 ? '#4CAF50' : '#E57373'
                  }}>
                    {fmt(pulse.thisWeek.profit)}
                  </span>
                </div>
              </div>

              <div style={styles.statsRow}>
                <div style={styles.statBox}>
                  <span style={styles.statNum}>{pulse.thisWeek.appointments}</span>
                  <span style={styles.statLabel}>Completed</span>
                </div>
                <div style={styles.statBox}>
                  <span style={styles.statNum}>{pulse.thisWeek.noShows}</span>
                  <span style={styles.statLabel}>No-shows</span>
                </div>
                <div style={styles.statBox}>
                  <span style={styles.statNum}>{pulse.thisWeek.noShowRate}%</span>
                  <span style={styles.statLabel}>No-show rate</span>
                </div>
              </div>

              {Object.keys(pulse.thisWeek.expenseByCategory).length > 0 && (
                <div style={styles.breakdownSection}>
                  <h3 style={styles.sectionTitle}>Expenses this week</h3>
                  {Object.entries(pulse.thisWeek.expenseByCategory)
                    .sort(([, a], [, b]) => b - a)
                    .map(([cat, cents]) => (
                      <div key={cat} style={styles.breakdownRow}>
                        <span style={styles.breakdownCat}>{cat}</span>
                        <span style={styles.breakdownAmt}>{fmt(cents)}</span>
                      </div>
                    ))
                  }
                </div>
              )}

              <div style={styles.comparisonCard}>
                <h3 style={styles.sectionTitle}>Last week</h3>
                <div style={styles.compRow}><span>Income</span><span>{fmt(pulse.lastWeek.income)}</span></div>
                <div style={styles.compRow}><span>Expenses</span><span>{fmt(pulse.lastWeek.expenses)}</span></div>
                <div style={{ ...styles.compRow, fontWeight: 600 }}><span>Profit</span><span>{fmt(pulse.lastWeek.profit)}</span></div>
              </div>
            </>
          ) : (
            <div style={styles.emptyState}>
              <p style={styles.emptyTitle}>No data yet</p>
              <p style={styles.emptyDesc}>Complete appointments and log expenses to see your pulse.</p>
            </div>
          )}
        </div>
      )}

      {/* === EXPENSES TAB === */}
      {tab === 'expenses' && (
        <div>
          <div style={styles.expenseActions}>
            <button onClick={() => setShowAddExpense(!showAddExpense)} style={styles.addBtn}>
              + Add Expense
            </button>
            <label style={styles.scanBtn}>
              📷 Scan Receipt
              <input type="file" accept="image/*" capture="environment" onChange={handleReceiptScan} style={{ display: 'none' }} />
            </label>
          </div>

          {showAddExpense && (
            <div style={styles.addForm}>
              <div style={styles.formRow}>
                <div style={styles.formGroup}>
                  <label style={styles.formLabel}>Amount (£)</label>
                  <input
                    type="number" step="0.01" placeholder="0.00"
                    value={newExpense.amount}
                    onChange={e => setNewExpense(p => ({ ...p, amount: e.target.value }))}
                    style={styles.formInput}
                  />
                </div>
                <div style={styles.formGroup}>
                  <label style={styles.formLabel}>Date</label>
                  <input
                    type="date" value={newExpense.date}
                    onChange={e => setNewExpense(p => ({ ...p, date: e.target.value }))}
                    style={styles.formInput}
                  />
                </div>
              </div>

              <div style={styles.formGroup}>
                <label style={styles.formLabel}>Vendor</label>
                <input
                  type="text" placeholder="e.g. Sally Beauty"
                  value={newExpense.vendor}
                  onChange={e => setNewExpense(p => ({ ...p, vendor: e.target.value }))}
                  style={styles.formInput}
                />
              </div>

              <div style={styles.formGroup}>
                <label style={styles.formLabel}>Category</label>
                <div style={styles.categoryGrid}>
                  {CATEGORIES.map(c => (
                    <button
                      key={c.value}
                      type="button"
                      onClick={() => setNewExpense(p => ({ ...p, category: c.value }))}
                      style={{
                        ...styles.categoryChip,
                        background: newExpense.category === c.value ? c.color : '#fff',
                        borderColor: newExpense.category === c.value ? c.color : '#F0ECE8',
                      }}
                    >
                      <span>{c.icon}</span>
                      <span style={{ fontSize: 11 }}>{c.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div style={styles.formGroup}>
                <label style={styles.formLabel}>Description</label>
                <input
                  type="text" placeholder="e.g. Brow tint x3, wax strips"
                  value={newExpense.description}
                  onChange={e => setNewExpense(p => ({ ...p, description: e.target.value }))}
                  style={styles.formInput}
                />
              </div>

              <div style={styles.formGroup}>
                <label style={styles.formLabel}>Receipt photo</label>
                <div style={styles.receiptRow}>
                  {receiptPreview ? (
                    <div style={styles.receiptThumbWrap}>
                      <img src={receiptPreview} alt="Receipt" style={styles.receiptThumb} />
                      <button onClick={() => { setReceiptPreview(null); }} style={styles.receiptRemoveBtn}>×</button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => receiptInputRef.current?.click()}
                      style={styles.receiptAddBtn}
                    >
                      📷 Add photo
                    </button>
                  )}
                  <input
                    ref={receiptInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={e => {
                      const file = e.target.files?.[0];
                      if (file) setReceiptPreview(URL.createObjectURL(file));
                    }}
                    style={{ display: 'none' }}
                  />
                </div>
              </div>

              <label style={styles.checkboxLabel}>
                <input
                  type="checkbox" checked={newExpense.tax_deductible}
                  onChange={e => setNewExpense(p => ({ ...p, tax_deductible: e.target.checked }))}
                />
                <span style={{ marginLeft: 8 }}>Tax deductible</span>
              </label>

              <div style={styles.formActions}>
                <button onClick={handleAddExpense} style={styles.saveBtn}>Save Expense</button>
                <button onClick={() => setShowAddExpense(false)} style={styles.cancelBtn}>Cancel</button>
              </div>
            </div>
          )}

          <div style={styles.list}>
            {expenses.length === 0 && (
              <div style={styles.emptyState}>
                <p style={styles.emptyTitle}>No expenses logged</p>
                <p style={styles.emptyDesc}>Tap + Add Expense to start tracking.</p>
              </div>
            )}
            {expenses.map(exp => {
              const catMeta = getCategoryMeta(exp.category);
              return (
                <div key={exp.id} style={styles.listItem}>
                  <div style={{ ...styles.catIconBubble, background: catMeta.color }}>
                    <span style={{ fontSize: 16 }}>{catMeta.icon}</span>
                  </div>
                  <div style={styles.listLeft}>
                    <span style={styles.listTitle}>{exp.vendor || catMeta.label}</span>
                    {exp.description && <span style={styles.listDesc}>{exp.description}</span>}
                    <span style={styles.listMeta}>
                      {new Date(exp.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                      {' · '}{catMeta.label}
                      {exp.tax_deductible && ' · Tax ✓'}
                    </span>
                  </div>
                  <span style={styles.listAmount}>-{fmt(exp.amount_cents)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* === INCOME TAB === */}
      {tab === 'income' && (
        <div style={styles.list}>
          {transactions.length === 0 && (
            <div style={styles.emptyState}>
              <p style={styles.emptyTitle}>No income yet</p>
              <p style={styles.emptyDesc}>Payments from completed appointments will show here.</p>
            </div>
          )}
          {transactions.map(tx => (
            <div key={tx.id} style={styles.listItem}>
              <div style={styles.listLeft}>
                <span style={styles.listTitle}>
                  {tx.appointments?.clients?.first_name || 'Payment'}
                  {tx.appointments?.treatments?.name ? ` — ${tx.appointments.treatments.name}` : ''}
                </span>
                <span style={styles.listMeta}>
                  {new Date(tx.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                  {' · '}
                  {tx.type === 'payment' ? 'Payment' : tx.type === 'deposit' ? 'Deposit' : tx.type === 'no_show_fee' ? 'No-show fee' : tx.type}
                </span>
              </div>
              <span style={{ ...styles.listAmount, color: '#4CAF50' }}>+{fmt(tx.amount_cents)}</span>
            </div>
          ))}
        </div>
      )}

      {/* === TAX TAB === */}
      {tab === 'tax' && (
        <div>
          {loading ? (
            <p style={styles.loadingText}>Generating your tax summary...</p>
          ) : (() => {
            const taxSummary = computeTax();
            return (
              <>
                <div style={styles.taxHeader}>
                  <h3 style={styles.sectionTitle}>Tax Year {taxSummary.taxYear}</h3>
                  <span style={styles.taxPeriod}>{taxSummary.period.start} to {taxSummary.period.end}</span>
                </div>

                <div style={styles.pulseGrid}>
                  <div style={styles.pulseCard}>
                    <span style={styles.pulseLabel}>Total Income</span>
                    <span style={styles.pulseValue}>{fmt(taxSummary.totalIncome)}</span>
                    <span style={styles.pulseChange}>{taxSummary.transactionCount} transactions</span>
                  </div>
                  <div style={styles.pulseCard}>
                    <span style={styles.pulseLabel}>Deductible Expenses</span>
                    <span style={styles.pulseValue}>{fmt(taxSummary.totalExpenses)}</span>
                    <span style={styles.pulseChange}>{taxSummary.expenseCount} items</span>
                  </div>
                  <div style={{ ...styles.pulseCard, ...styles.profitCard }}>
                    <span style={styles.pulseLabel}>Taxable Profit</span>
                    <span style={styles.pulseValue}>{fmt(taxSummary.taxableProfit)}</span>
                  </div>
                </div>

                {Object.keys(taxSummary.expensesByCategory).length > 0 && (
                  <div style={styles.breakdownSection}>
                    <h3 style={styles.sectionTitle}>Expenses by category</h3>
                    {Object.entries(taxSummary.expensesByCategory)
                      .sort(([, a], [, b]) => b.total_cents - a.total_cents)
                      .map(([cat, data]) => (
                        <div key={cat} style={styles.breakdownRow}>
                          <div>
                            <span style={styles.breakdownCat}>{cat}</span>
                            <span style={styles.breakdownCount}> ({data.count} items)</span>
                          </div>
                          <span style={styles.breakdownAmt}>{fmt(data.total_cents)}</span>
                        </div>
                      ))
                    }
                  </div>
                )}

                {Object.keys(taxSummary.monthlyIncome).length > 0 && (
                  <div style={styles.breakdownSection}>
                    <h3 style={styles.sectionTitle}>Monthly income</h3>
                    {Object.entries(taxSummary.monthlyIncome)
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([month, cents]) => {
                        const [y, m] = month.split('-');
                        const label = new Date(y, parseInt(m) - 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
                        return (
                          <div key={month} style={styles.breakdownRow}>
                            <span style={styles.breakdownCat}>{label}</span>
                            <span style={styles.breakdownAmt}>{fmt(cents)}</span>
                          </div>
                        );
                      })
                    }
                  </div>
                )}

                <p style={styles.taxNote}>
                  These figures are for reference. Always check with your accountant before filing your self-assessment.
                </p>
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}

// ── Dev mode mock data ──
const DEV_EXPENSES = [
  { id: 'dev-e1', vendor: 'Sally Beauty', description: 'Brow tint x3, wax strips', category: 'products', amount_cents: 3450, date: '2026-03-24', tax_deductible: true },
  { id: 'dev-e2', vendor: 'Salon Rent', description: 'March chair rental', category: 'rent', amount_cents: 40000, date: '2026-03-01', tax_deductible: true },
  { id: 'dev-e3', vendor: 'Timely', description: 'Monthly subscription', category: 'software', amount_cents: 2500, date: '2026-03-15', tax_deductible: true },
];

const DEV_TRANSACTIONS = [
  { id: 'dev-tx1', type: 'payment', amount_cents: 4500, created_at: '2026-03-24T14:00:00Z', appointments: { clients: { first_name: 'Shauna' }, treatments: { name: 'Lamination & Hybrid Dye' } } },
  { id: 'dev-tx2', type: 'payment', amount_cents: 4000, created_at: '2026-03-24T11:00:00Z', appointments: { clients: { first_name: 'Daisy' }, treatments: { name: 'Lamination & Tint' } } },
  { id: 'dev-tx3', type: 'payment', amount_cents: 2500, created_at: '2026-03-23T15:00:00Z', appointments: { clients: { first_name: 'Jasmin' }, treatments: { name: 'HD Brows' } } },
];

const styles = {
  page: {
    minHeight: '100vh',
    background: '#FAF8F5',
    fontFamily: '"DM Sans", -apple-system, sans-serif',
    padding: '0 16px 40px',
    maxWidth: 480,
    margin: '0 auto',
    color: '#2D2A26'
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 28,
    paddingBottom: 8
  },
  title: { fontSize: 22, fontWeight: 700, margin: '0 0 2px' },
  subtitle: { fontSize: 13, color: '#C76B8A', margin: 0, fontWeight: 500 },
  tabs: {
    display: 'flex',
    gap: 16,
    borderBottom: '1px solid #F0ECE8',
    marginBottom: 16,
    overflowX: 'auto'
  },
  tab: {
    padding: '10px 0',
    background: 'none',
    border: 'none',
    borderBottom: '2px solid transparent',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'all 0.2s',
    whiteSpace: 'nowrap'
  },
  loadingText: { textAlign: 'center', color: '#AAA5A0', padding: 40, fontSize: 14 },

  // Pulse
  pulseGrid: { display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 },
  pulseCard: {
    background: '#fff',
    borderRadius: 14,
    padding: '16px 18px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)'
  },
  profitCard: { border: '1.5px solid #F0ECE8' },
  pulseLabel: { display: 'block', fontSize: 12, color: '#AAA5A0', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 },
  pulseValue: { display: 'block', fontSize: 24, fontWeight: 700, color: '#2D2A26' },
  pulseChange: { display: 'block', fontSize: 12, color: '#AAA5A0', marginTop: 4 },

  statsRow: { display: 'flex', gap: 10, marginBottom: 16 },
  statBox: {
    flex: 1,
    background: '#fff',
    borderRadius: 12,
    padding: '14px 12px',
    textAlign: 'center',
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)'
  },
  statNum: { display: 'block', fontSize: 20, fontWeight: 700, color: '#C76B8A' },
  statLabel: { display: 'block', fontSize: 10, color: '#AAA5A0', textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 2 },

  breakdownSection: {
    background: '#fff',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)'
  },
  sectionTitle: { fontSize: 14, fontWeight: 600, margin: '0 0 12px', color: '#2D2A26' },
  breakdownRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 0',
    borderBottom: '1px solid #FAF8F5'
  },
  breakdownCat: { fontSize: 13, textTransform: 'capitalize', color: '#5A5550' },
  breakdownCount: { fontSize: 11, color: '#C4BDB6' },
  breakdownAmt: { fontSize: 13, fontWeight: 600, color: '#2D2A26' },

  comparisonCard: {
    background: '#fff',
    borderRadius: 14,
    padding: 16,
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)'
  },
  compRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '6px 0',
    fontSize: 13,
    color: '#5A5550'
  },

  // Expenses
  expenseActions: { display: 'flex', gap: 8, marginBottom: 14 },
  addBtn: {
    flex: 1,
    padding: '10px 0',
    borderRadius: 10,
    border: 'none',
    background: '#C76B8A',
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit'
  },
  scanBtn: {
    flex: 1,
    padding: '10px 0',
    borderRadius: 10,
    border: '1.5px solid #E8E4E0',
    background: '#fff',
    color: '#666',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },

  addForm: {
    background: '#fff',
    borderRadius: 14,
    padding: 16,
    marginBottom: 14,
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)'
  },
  formRow: { display: 'flex', gap: 10, marginBottom: 10 },
  formGroup: { flex: 1, marginBottom: 10 },
  formLabel: { display: 'block', fontSize: 12, color: '#AAA5A0', marginBottom: 4, fontWeight: 500 },
  formInput: {
    width: '100%',
    padding: '10px 12px',
    borderRadius: 8,
    border: '1.5px solid #F0ECE8',
    fontSize: 14,
    fontFamily: 'inherit',
    outline: 'none',
    boxSizing: 'border-box',
    transition: 'border-color 0.2s'
  },
  formSelect: {
    width: '100%',
    padding: '10px 12px',
    borderRadius: 8,
    border: '1.5px solid #F0ECE8',
    fontSize: 14,
    fontFamily: 'inherit',
    outline: 'none',
    background: '#fff',
    boxSizing: 'border-box'
  },
  checkboxLabel: {
    display: 'flex',
    alignItems: 'center',
    fontSize: 13,
    color: '#5A5550',
    marginBottom: 12,
    cursor: 'pointer'
  },
  formActions: { display: 'flex', gap: 8 },
  saveBtn: {
    flex: 1,
    padding: '10px 0',
    borderRadius: 10,
    border: 'none',
    background: '#C76B8A',
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit'
  },
  cancelBtn: {
    padding: '10px 16px',
    borderRadius: 10,
    border: 'none',
    background: '#F5F2EF',
    color: '#8A8580',
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit'
  },

  // Lists
  list: { display: 'flex', flexDirection: 'column', gap: 8 },
  listItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    background: '#fff',
    borderRadius: 12,
    padding: '14px 16px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)'
  },
  listLeft: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 },
  listTitle: { fontSize: 14, fontWeight: 600, color: '#2D2A26', textTransform: 'capitalize' },
  listDesc: { fontSize: 12, color: '#8A8580', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  listMeta: { fontSize: 11, color: '#C4BDB6' },
  listAmount: { fontSize: 15, fontWeight: 700, color: '#E57373', marginLeft: 12, whiteSpace: 'nowrap' },

  // Tax
  taxHeader: { marginBottom: 16 },
  taxPeriod: { fontSize: 12, color: '#AAA5A0' },
  taxNote: {
    fontSize: 12,
    color: '#C4BDB6',
    textAlign: 'center',
    padding: '16px 20px',
    lineHeight: 1.5,
    fontStyle: 'italic'
  },

  // Category grid (in form)
  categoryGrid: {
    display: 'flex', flexWrap: 'wrap', gap: 6,
  },
  categoryChip: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
    padding: '8px 10px', borderRadius: 10, border: '1.5px solid #F0ECE8',
    cursor: 'pointer', fontFamily: 'inherit', minWidth: 56,
  },

  // Category icon in list
  catIconBubble: {
    width: 36, height: 36, borderRadius: 10,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },

  // Receipt photo
  receiptRow: { display: 'flex', alignItems: 'center', gap: 8 },
  receiptAddBtn: {
    padding: '10px 16px', borderRadius: 10, border: '1.5px dashed #E8E4E0',
    background: '#fff', color: '#8A8580', fontSize: 13,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  receiptThumbWrap: { position: 'relative', display: 'inline-block' },
  receiptThumb: {
    width: 64, height: 64, borderRadius: 10, objectFit: 'cover',
    border: '1.5px solid #F0ECE8',
  },
  receiptRemoveBtn: {
    position: 'absolute', top: -6, right: -6,
    width: 20, height: 20, borderRadius: 10, border: 'none',
    background: '#E57373', color: '#fff', fontSize: 12,
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
  },

  // Empty
  emptyState: { textAlign: 'center', padding: '40px 20px' },
  emptyTitle: { fontSize: 16, fontWeight: 600, margin: '0 0 6px' },
  emptyDesc: { fontSize: 13, color: '#AAA5A0', margin: 0, lineHeight: 1.5 }
};
