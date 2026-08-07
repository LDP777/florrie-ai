/**
 * Expenses - Dedicated expense manager with budgets & recurring items.
 *
 * MoneyTracker already handles pulse + basic expense logging. This page
 * goes deeper: recurring expenses, budget limits per category, CSV export
 * for the accountant, and a month-by-month breakdown.
 */
import { useState, useEffect } from 'react';
import { useBeautician, fetchRows, insertRow, updateRow, deleteRow } from '../lib/supabase.js';
import { useCoach } from '../contexts/CoachContext.jsx';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import { todayLocal } from '../lib/dates.js';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';
import Icon from '../components/ui/Icon';

const CATEGORIES = [
  { value: 'products', label: 'Products', icon: 'flower', color: 'var(--accent, #92405e)' },
  { value: 'rent', label: 'Rent', icon: 'map-pin', color: 'var(--text-secondary, #574A42)' },
  { value: 'training', label: 'Training', icon: 'file', color: 'var(--success, #3F7D5C)' },
  { value: 'travel', label: 'Travel', icon: 'map-pin', color: 'var(--gold, #8A6420)' },
  { value: 'equipment', label: 'Equipment', icon: 'sliders', color: 'var(--info, #4A6C82)' },
  { value: 'insurance', label: 'Insurance', icon: 'shield', color: 'var(--info, #4A6C82)' },
  { value: 'marketing', label: 'Marketing', icon: 'send', color: 'var(--accent-dark, #782b49)' },
  { value: 'software', label: 'Software', icon: 'link', color: 'var(--info, #4A6C82)' },
  { value: 'utilities', label: 'Utilities', icon: 'sparkles', color: 'var(--warning, #8A6420)' },
  { value: 'other', label: 'Other', icon: 'map-pin', color: 'var(--text-muted, #6B5D54)' },
];

const getCat = (v) => CATEGORIES.find(c => c.value === v) || CATEGORIES[9];

const fmt = (cents) => `£${(Math.abs(cents) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function Expenses() {
  const { beautician, loading: bLoading } = useBeautician();
  const { triggerNudge } = useCoach();
  const [tab, setTab] = useState('overview');
  const [month, setMonth] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; });
  const [showAdd, setShowAdd] = useState(false);
  const [expenses, setExpenses] = useState([]);
  const [budgets, setBudgets] = useState([]);
  const [editBudget, setEditBudget] = useState(null);
  const [editingExpense, setEditingExpense] = useState(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ vendor: '', description: '', amount: '', category: 'products', date: todayLocal(), tax_deductible: true, recurring: false, recurring_interval: 'monthly' });

  async function handleDeleteExpense(id) {
    if (!confirm('Delete this expense?')) return;
    try {
      await deleteRow('expenses', id);
      setExpenses(prev => prev.filter(e => e.id !== id));
    } catch (err) {
      logger.error({ err }, 'Failed to delete expense');
      alert('Failed to delete expense');
    }
  }

  function handleEditExpense(expense) {
    setEditingExpense(expense);
    setForm({
      vendor: expense.vendor,
      description: expense.description,
      amount: (expense.amount_cents / 100).toString(),
      category: expense.category,
      date: expense.date,
      tax_deductible: expense.tax_deductible,
      recurring: expense.recurring,
      recurring_interval: expense.recurring_interval || 'monthly',
    });
  }

  async function handleSaveEditedExpense() {
    if (!form.vendor || !form.amount) return;
    setSaving(true);
    try {
      const updates = {
        vendor: form.vendor.trim(),
        description: form.description.trim(),
        amount_cents: Math.round(parseFloat(form.amount) * 100),
        category: form.category,
        date: form.date,
        tax_deductible: form.tax_deductible,
        recurring: form.recurring,
        recurring_interval: form.recurring ? form.recurring_interval : null,
      };
      await updateRow('expenses', editingExpense.id, updates);
      setExpenses(prev => prev.map(e => e.id === editingExpense.id ? { ...e, ...updates } : e));
      setEditingExpense(null);
      setForm({ vendor: '', description: '', amount: '', category: 'products', date: todayLocal(), tax_deductible: true, recurring: false, recurring_interval: 'monthly' });
    } catch (err) {
      logger.error({ err }, 'Failed to save expense');
      alert('Failed to save expense');
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveBudget() {
    if (!editBudget?.category || !editBudget?.amount) return;
    const limitCents = Math.round(parseFloat(editBudget.amount) * 100);
    try {
      const existing = budgets.find(b => b.category === editBudget.category);
      if (existing?.id) {
        await updateRow('expense_budgets', existing.id, { monthly_limit_cents: limitCents });
        setBudgets(prev => prev.map(b => b.category === editBudget.category ? { ...b, monthly_limit_cents: limitCents } : b));
      } else {
        const created = await insertRow('expense_budgets', {
          beautician_id: beautician.id,
          category: editBudget.category,
          monthly_limit_cents: limitCents,
        });
        setBudgets(prev => [...prev, created]);
      }
      setEditBudget(null);
    } catch (err) {
      logger.error({ err }, 'Failed to save budget');
    }
  }

  useEffect(() => {
    if (bLoading || !beautician) return;
    // Always fetch from Supabase (dev mode shows empty state if fetchRows returns [])
    fetchRows('expenses', beautician.id, { order: 'date', ascending: false })
      .then(rows => setExpenses(rows || []))
      .catch(err => {
        logger.error({ err }, 'Failed to load expenses');
        setExpenses([]);
      });
    fetchRows('expense_budgets', beautician.id)
      .then(rows => setBudgets(rows || []))
      .catch(err => {
        logger.error({ err }, 'Failed to load budgets');
        setBudgets([]);
      });
  }, [beautician, bLoading]);

  // Filter by month
  const monthExpenses = expenses.filter(e => e.date && e.date.startsWith(month));
  const totalMonth = monthExpenses.reduce((s, e) => s + e.amount_cents, 0);
  const recurringTotal = monthExpenses.filter(e => e.recurring).reduce((s, e) => s + e.amount_cents, 0);
  const oneOffTotal = totalMonth - recurringTotal;
  const deductibleTotal = monthExpenses.filter(e => e.tax_deductible).reduce((s, e) => s + e.amount_cents, 0);

  // Category breakdown
  const catBreakdown = {};
  monthExpenses.forEach(e => {
    if (!catBreakdown[e.category]) catBreakdown[e.category] = 0;
    catBreakdown[e.category] += e.amount_cents;
  });
  const sortedCats = Object.entries(catBreakdown).sort(([, a], [, b]) => b - a);

  // Budget tracking
  const budgetStatus = budgets.map(b => {
    const spent = catBreakdown[b.category] || 0;
    const pct = b.monthly_limit_cents > 0 ? Math.min(Math.round((spent / b.monthly_limit_cents) * 100), 100) : 0;
    return { ...b, spent, pct };
  });

  // Month navigation
  const prevMonth = () => {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(y, m - 2, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  };
  const nextMonth = () => {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(y, m, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  };
  const monthLabel = () => {
    const [y, m] = month.split('-').map(Number);
    return new Date(y, m - 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  };

  // CSV export
  const exportCSV = () => {
    const header = 'Date,Vendor,Description,Category,Amount,Tax Deductible,Recurring\n';
    const rows = monthExpenses.map(e =>
      `${e.date},"${e.vendor}","${e.description}",${e.category},${(e.amount_cents / 100).toFixed(2)},${e.tax_deductible ? 'Yes' : 'No'},${e.recurring ? 'Yes' : 'No'}`
    ).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `expenses-${month}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={S.page}>
      <div style={S.header}>
        <h1 style={S.title}>Expenses</h1>
        <button style={S.addBtn} onClick={() => setShowAdd(true)}>+ Add</button>
      </div>

      {/* Month nav */}
      <div style={S.monthNav}>
        <button style={S.monthArrow} onClick={prevMonth}>‹</button>
        <span style={S.monthLabel}>{monthLabel()}</span>
        <button style={S.monthArrow} onClick={nextMonth}>›</button>
      </div>

      {/* Summary cards */}
      <div style={S.summaryGrid}>
        <div style={S.summaryCard}>
          <span style={{ ...S.summaryValue, color: 'var(--accent, #92405e)' }}>{fmt(totalMonth)}</span>
          <span style={S.summaryLabel}>Total</span>
        </div>
        <div style={S.summaryCard}>
          <span style={{ ...S.summaryValue, color: 'var(--text-secondary, #574A42)' }}>{fmt(recurringTotal)}</span>
          <span style={S.summaryLabel}>Recurring</span>
        </div>
        <div style={S.summaryCard}>
          <span style={{ ...S.summaryValue, color: 'var(--success, #3F7D5C)' }}>{fmt(deductibleTotal)}</span>
          <span style={S.summaryLabel}>Deductible</span>
        </div>
      </div>

      {/* Tabs */}
      <div style={S.tabs}>
        {['overview', 'list', 'budgets'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ ...S.tab, ...(tab === t ? S.tabActive : {}) }}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* Overview */}
      {tab === 'overview' && (
        <>
          {/* Category breakdown */}
          <div style={S.card}>
            <h3 style={S.cardTitle}>By Category</h3>
            {sortedCats.length === 0 && <p style={S.empty}>No expenses this month.</p>}
            {sortedCats.map(([cat, total]) => {
              const meta = getCat(cat);
              const pct = Math.round((total / totalMonth) * 100);
              return (
                <div key={cat} style={S.catRow}>
                  <div style={S.catLeft}>
                    <span style={{ ...S.catIcon, background: meta.color + '22' }}><Icon name={meta.icon} size={17} /></span>
                    <div style={S.catInfo}>
                      <span style={S.catName}>{meta.label}</span>
                      <span style={S.catPct}>{pct}%</span>
                    </div>
                  </div>
                  <div style={S.catRight}>
                    <div style={S.catBarBg}>
                      <div style={{ ...S.catBarFill, width: `${pct}%`, background: meta.color }} />
                    </div>
                    <span style={S.catAmount}>{fmt(total)}</span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Recurring items */}
          <div style={S.card}>
            <h3 style={S.cardTitle}>Recurring Expenses</h3>
            {monthExpenses.filter(e => e.recurring).length === 0 && <p style={S.empty}>No recurring expenses.</p>}
            {monthExpenses.filter(e => e.recurring).map(e => (
              <div key={e.id} style={S.recurringRow}>
                <div style={S.recurringInfo}>
                  <span style={S.recurringVendor}>{e.vendor}</span>
                  <span style={S.recurringDesc}>{e.description}</span>
                </div>
                <div style={S.recurringRight}>
                  <span style={S.recurringAmount}>{fmt(e.amount_cents)}</span>
                  <span style={S.recurringInterval}>{e.recurring_interval}</span>
                </div>
              </div>
            ))}
          </div>

          {/* Export */}
          <button style={S.exportBtn} onClick={exportCSV}><Icon name="download" size={16} /> Export {monthLabel()} as CSV</button>
        </>
      )}

      {/* List */}
      {tab === 'list' && (
        <div style={S.list}>
          {monthExpenses.length === 0 && <p style={S.empty}>No expenses this month.</p>}
          {monthExpenses.map(e => {
            const meta = getCat(e.category);
            return (
              <div key={e.id} style={S.expenseCard}>
                <div style={S.expenseLeft}>
                  <span style={{ ...S.catIcon, background: meta.color + '22' }}><Icon name={meta.icon} size={17} /></span>
                  <div style={S.expenseInfo}>
                    <span style={S.expenseVendor}>{e.vendor}</span>
                    <span style={S.expenseDesc}>{e.description}</span>
                    <div style={S.expenseTags}>
                      <span style={S.tagDate}>{formatDate(e.date)}</span>
                      {e.recurring && <span style={S.tagRecurring}><Icon name="repeat" size={12} /> {e.recurring_interval}</span>}
                      {e.tax_deductible && <span style={S.tagTax}>Tax deductible</span>}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                  <span style={S.expenseAmount}>{fmt(e.amount_cents)}</span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => handleEditExpense(e)} style={{ background: 'none', border: 'none', fontSize: 11, color: 'var(--success, #3F7D5C)', cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}>Edit</button>
                    <button onClick={() => handleDeleteExpense(e.id)} style={{ background: 'none', border: 'none', fontSize: 11, color: 'var(--text-muted, var(--text-muted, #6B5D54))', cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}>Delete</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Budgets */}
      {tab === 'budgets' && (
        <>
          <div style={S.budgetList}>
            {budgetStatus.map(b => {
              const meta = getCat(b.category);
              const overBudget = b.pct >= 90;
              return (
                <div key={b.category} style={S.budgetCard}>
                  <div style={S.budgetHeader}>
                    <span style={S.budgetCat}><Icon name={meta.icon} size={15} />{meta.label}</span>
                    <span style={{ ...S.budgetPct, color: overBudget ? 'var(--accent, #92405e)' : 'var(--success, #3F7D5C)' }}>{b.pct}%</span>
                  </div>
                  <div style={S.budgetBarBg}>
                    <div style={{ ...S.budgetBarFill, width: `${b.pct}%`, background: overBudget ? 'var(--accent, #92405e)' : meta.color }} />
                  </div>
                  <div style={S.budgetFooter}>
                    <span style={S.budgetSpent}>{fmt(b.spent)} spent</span>
                    <span style={S.budgetLimit}>of {fmt(b.monthly_limit_cents)}</span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Add budget */}
          <div style={S.card}>
            <h3 style={S.cardTitle}>Set Budget</h3>
            <div style={S.budgetForm}>
              <select style={S.select} value={editBudget?.category || ''} onChange={e => setEditBudget({ category: e.target.value, amount: '' })}>
                <option value="">Select category</option>
                {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
              {editBudget && (
                <>
                  <input style={S.input} type="number" placeholder="Monthly limit (£)" value={editBudget.amount} onChange={e => setEditBudget(b => ({ ...b, amount: e.target.value }))} />
                  <button style={S.saveBudgetBtn} onClick={handleSaveBudget}>Save</button>
                </>
              )}
            </div>
          </div>
        </>
      )}

      {/* Add/Edit expense modal */}
      {(showAdd || editingExpense) && (
        <div style={S.overlay} onClick={() => { setShowAdd(false); setEditingExpense(null); }}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <h2 style={S.modalTitle}>{editingExpense ? 'Edit Expense' : 'Add Expense'}</h2>

            <div style={S.fieldLabel}>Vendor</div>
            <input style={S.input} placeholder="e.g. Sally Beauty" value={form.vendor} onChange={e => setForm(f => ({ ...f, vendor: e.target.value }))} />

            <div style={S.fieldLabel}>Description</div>
            <input style={S.input} placeholder="What was it for?" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />

            <div style={S.fieldLabel}>Amount (£)</div>
            <input style={S.input} type="number" step="0.01" placeholder="0.00" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />

            <div style={S.fieldLabel}>Category</div>
            <div style={S.catGrid}>
              {CATEGORIES.map(c => (
                <button key={c.value} onClick={() => setForm(f => ({ ...f, category: c.value }))} style={{ ...S.catChip, ...(form.category === c.value ? { background: c.color, color: '#fff' } : {}) }}>
                  <Icon name={c.icon} size={15} /> {c.label}
                </button>
              ))}
            </div>

            <div style={S.fieldLabel}>Date</div>
            <input style={S.input} type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />

            <div style={S.toggleRow}>
              <span style={S.toggleLabel}>Tax deductible</span>
              <button style={{ ...S.toggle, background: form.tax_deductible ? 'var(--accent, #92405e)' : 'var(--border, #E8DDD4)' }} onClick={() => setForm(f => ({ ...f, tax_deductible: !f.tax_deductible }))}>
                <div style={{ ...S.toggleDot, transform: form.tax_deductible ? 'translateX(18px)' : 'translateX(2px)' }} />
              </button>
            </div>

            <div style={S.toggleRow}>
              <span style={S.toggleLabel}>Recurring</span>
              <button style={{ ...S.toggle, background: form.recurring ? 'var(--accent, #92405e)' : 'var(--border, #E8DDD4)' }} onClick={() => setForm(f => ({ ...f, recurring: !f.recurring }))}>
                <div style={{ ...S.toggleDot, transform: form.recurring ? 'translateX(18px)' : 'translateX(2px)' }} />
              </button>
            </div>

            {form.recurring && (
              <div style={S.intervalRow}>
                {['weekly', 'monthly', 'quarterly', 'yearly'].map(i => (
                  <button key={i} onClick={() => setForm(f => ({ ...f, recurring_interval: i }))} style={{ ...S.intervalChip, ...(form.recurring_interval === i ? S.intervalActive : {}) }}>
                    {i}
                  </button>
                ))}
              </div>
            )}

            <button style={{ ...S.saveBtn, opacity: saving ? 0.6 : 1 }} disabled={saving} onClick={() => {
              if (editingExpense) {
                handleSaveEditedExpense();
              } else {
                if (!form.vendor || !form.amount) return;
                setSaving(true);
                (async () => {
                  try {
                    const created = await insertRow('expenses', {
                      beautician_id: beautician.id,
                      vendor: form.vendor.trim(),
                      description: form.description.trim(),
                      amount_cents: Math.round(parseFloat(form.amount) * 100),
                      category: form.category,
                      date: form.date,
                      tax_deductible: form.tax_deductible,
                      recurring: form.recurring,
                      recurring_interval: form.recurring ? form.recurring_interval : null,
                    });
                    setExpenses(prev => [created, ...prev]);
                    setShowAdd(false);
                    // Coach nudge: contextual insight after saving expense
                    triggerNudge('expense_added', {
                      category: form.category,
                      amount_pence: Math.round(parseFloat(form.amount) * 100),
                      vendor: form.vendor.trim(),
                    });
                    setForm({ vendor: '', description: '', amount: '', category: 'products', date: todayLocal(), tax_deductible: true, recurring: false, recurring_interval: 'monthly' });
                  } catch (err) {
                    logger.error({ err }, 'Failed to save expense');
                    alert('Failed to save expense');
                  } finally {
                    setSaving(false);
                  }
                })();
              }
            }}>
              {saving ? 'Saving…' : editingExpense ? 'Update Expense' : 'Save Expense'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

const S = {
  page: { padding: '20px 16px 32px', fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif", maxWidth: 480, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text, var(--text-primary, #241B17))', margin: 0 },
  addBtn: { background: 'var(--accent, #92405e)', color: '#fff', border: 'none', borderRadius: 20, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  monthNav: { display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 20, marginBottom: 16 },
  monthArrow: { background: 'none', border: 'none', fontSize: 22, color: 'var(--text-muted, var(--text-muted, #6B5D54))', cursor: 'pointer', padding: '4px 8px' },
  monthLabel: { fontSize: 16, fontWeight: 600, color: 'var(--text, var(--text-primary, #241B17))' },

  summaryGrid: { display: 'flex', gap: 10, marginBottom: 16 },
  summaryCard: { flex: 1, background: 'var(--card, #FFFCF9)', borderRadius: 12, padding: '12px 8px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  summaryValue: { fontSize: 17, fontWeight: 700 },
  summaryLabel: { fontSize: 11, color: 'var(--text-muted, var(--text-muted, #6B5D54))' },

  tabs: { display: 'flex', gap: 8, marginBottom: 16 },
  tab: { flex: 1, padding: '10px 0', border: 'none', borderRadius: 10, background: 'var(--card, #FFFCF9)', color: 'var(--text-muted, var(--text-muted, #6B5D54))', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  tabActive: { background: 'var(--accent, #92405e)', color: '#fff' },

  card: { background: 'var(--card, #FFFCF9)', borderRadius: 14, padding: 16, marginBottom: 12 },
  cardTitle: { fontSize: 15, fontWeight: 700, color: 'var(--text, var(--text-primary, #241B17))', margin: '0 0 12px' },
  empty: { textAlign: 'center', color: 'var(--text-muted, var(--text-muted, #6B5D54))', fontSize: 14, padding: 20 },

  // Category breakdown
  catRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border, var(--border, #E8DDD4))' },
  catLeft: { display: 'flex', gap: 10, alignItems: 'center' },
  catIcon: { width: 32, height: 32, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0 },
  catInfo: { display: 'flex', flexDirection: 'column', gap: 1 },
  catName: { fontSize: 14, fontWeight: 600, color: 'var(--text, var(--text-primary, #241B17))' },
  catPct: { fontSize: 11, color: 'var(--text-muted, var(--text-muted, #6B5D54))' },
  catRight: { display: 'flex', alignItems: 'center', gap: 10 },
  catBarBg: { width: 60, height: 6, borderRadius: 3, background: 'var(--border, var(--border, #E8DDD4))' },
  catBarFill: { height: 6, borderRadius: 3 },
  catAmount: { fontSize: 14, fontWeight: 600, color: 'var(--text, var(--text-primary, #241B17))', minWidth: 60, textAlign: 'right' },

  // Recurring
  recurringRow: { display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--border, var(--border, #E8DDD4))' },
  recurringInfo: { display: 'flex', flexDirection: 'column', gap: 2 },
  recurringVendor: { fontSize: 14, fontWeight: 600, color: 'var(--text, var(--text-primary, #241B17))' },
  recurringDesc: { fontSize: 12, color: 'var(--text-muted, var(--text-muted, #6B5D54))' },
  recurringRight: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 },
  recurringAmount: { fontSize: 14, fontWeight: 600, color: 'var(--accent, #92405e)' },
  recurringInterval: { fontSize: 11, color: 'var(--text-muted, var(--text-muted, #6B5D54))', textTransform: 'capitalize' },

  exportBtn: { width: '100%', padding: '12px 0', borderRadius: 12, border: '1px solid var(--border, var(--border, #E8DDD4))', background: 'var(--card, #FFFCF9)', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-primary, #241B17)', marginTop: 4 },

  // List
  list: { display: 'flex', flexDirection: 'column', gap: 8 },
  expenseCard: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--card, #FFFCF9)', borderRadius: 12, padding: 12 },
  expenseLeft: { display: 'flex', gap: 10, alignItems: 'flex-start', flex: 1 },
  expenseInfo: { display: 'flex', flexDirection: 'column', gap: 2 },
  expenseVendor: { fontSize: 14, fontWeight: 600, color: 'var(--text, var(--text-primary, #241B17))' },
  expenseDesc: { fontSize: 12, color: 'var(--text-muted, var(--text-muted, #6B5D54))' },
  expenseTags: { display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' },
  tagDate: { fontSize: 10, color: 'var(--text-secondary, #574A42)', padding: '2px 6px', borderRadius: 4, background: 'var(--border, var(--border, #E8DDD4))' },
  tagRecurring: { fontSize: 10, color: '#7B6B8F', padding: '2px 6px', borderRadius: 4, background: '#F0E6F4' },
  tagTax: { fontSize: 10, color: '#6B8F7B', padding: '2px 6px', borderRadius: 4, background: 'var(--success-bg, #E9F0EB)' },
  expenseAmount: { fontSize: 15, fontWeight: 700, color: 'var(--accent, #92405e)', whiteSpace: 'nowrap' },

  // Budgets
  budgetList: { display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 },
  budgetCard: { background: 'var(--card, #FFFCF9)', borderRadius: 12, padding: 14 },
  budgetHeader: { display: 'flex', justifyContent: 'space-between', marginBottom: 8 },
  budgetCat: { fontSize: 14, fontWeight: 600, color: 'var(--text, var(--text-primary, #241B17))' },
  budgetPct: { fontSize: 14, fontWeight: 700 },
  budgetBarBg: { height: 8, borderRadius: 4, background: 'var(--border, var(--border, #E8DDD4))', marginBottom: 6 },
  budgetBarFill: { height: 8, borderRadius: 4, transition: 'width 0.3s' },
  budgetFooter: { display: 'flex', justifyContent: 'space-between' },
  budgetSpent: { fontSize: 12, color: 'var(--text-secondary, #574A42)' },
  budgetLimit: { fontSize: 12, color: 'var(--text-muted, var(--text-muted, #6B5D54))' },

  budgetForm: { display: 'flex', flexDirection: 'column', gap: 8 },

  // Modal
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 960, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  modal: { background: 'var(--bg-card, #FFFCF9)', borderRadius: '16px 16px 0 0', padding: '20px 20px 32px', width: '100%', maxWidth: 480, maxHeight: '85vh', overflowY: 'auto' },
  modalTitle: { fontSize: 18, fontWeight: 700, color: 'var(--text-primary, #241B17)', margin: '0 0 16px' },
  fieldLabel: { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary, #574A42)', marginBottom: 6, marginTop: 12 },
  input: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border, var(--border, #E8DDD4))', fontSize: 14, fontFamily: 'inherit', color: 'var(--text-primary, #241B17)', outline: 'none', boxSizing: 'border-box' },
  select: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border, var(--border, #E8DDD4))', fontSize: 14, fontFamily: 'inherit', color: 'var(--text-primary, #241B17)', background: 'var(--bg-card, #FFFCF9)', outline: 'none', boxSizing: 'border-box' },
  catGrid: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  catChip: { padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border, var(--border, #E8DDD4))', background: 'var(--card, #FFFCF9)', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-primary, #241B17)' },
  toggleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 },
  toggleLabel: { fontSize: 14, fontWeight: 500, color: 'var(--text, var(--text-primary, #241B17))' },
  toggle: { width: 44, height: 26, borderRadius: 13, border: 'none', padding: 0, cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0 },
  toggleDot: { width: 22, height: 22, borderRadius: 11, background: '#fff', position: 'absolute', top: 2, transition: 'transform 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.15)' },
  intervalRow: { display: 'flex', gap: 8, marginTop: 8 },
  intervalChip: { flex: 1, padding: '8px 0', borderRadius: 8, border: '1px solid var(--border, var(--border, #E8DDD4))', background: 'var(--bg-card, #FFFCF9)', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-primary, #241B17)', textTransform: 'capitalize' },
  intervalActive: { background: 'var(--accent, #92405e)', color: '#fff', border: '1px solid var(--accent, #92405e)' },
  saveBtn: { width: '100%', padding: '14px 0', borderRadius: 12, border: 'none', background: 'var(--accent, #92405e)', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginTop: 20 },
  saveBudgetBtn: { padding: '10px 0', borderRadius: 10, border: 'none', background: 'var(--accent, #92405e)', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
};
