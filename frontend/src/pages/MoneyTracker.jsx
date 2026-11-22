import Button from '../components/ui/Button.jsx';
import { MoneyTax } from '../components/MoneyTax.jsx';
import { parseMoneyInput, latestPayments } from '../lib/money-view.js';
import { moneyApi, saveMoneyEntry, boundedMoneyRequest } from '../lib/money-requests.js';
import { readAllMoney } from '../../../backend/src/lib/read-all-money.js';
import { moneyDate, moneyTotals, reconcileTransactions, reportingYear, reportingBounds, shiftDate, periodWindow, sumMoney, taxReport } from '../../../backend/src/lib/money-reporting.js';
import MoneyPayments from '../components/MoneyPayments.jsx';
import MoneyDiaryOverview from '../components/MoneyDiaryOverview.jsx';
import MoneyRecentPayments from '../components/MoneyRecentPayments.jsx';
import { PrivateAmount, PrivateText, useClientPrivacy } from '../contexts/ClientPrivacyContext.jsx';
import MoreLoadError from '../components/MoreLoadError.jsx';
import { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useBeautician, supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import PageHeader from '../components/ui/PageHeader.jsx';
import { hapticTap, hapticSuccess } from '../lib/native.js';
import { todayLocal, localDateStr } from '../lib/dates.js';
import { uploadFile, objectPath, signedUrlMap, PRIVATE_BUCKET } from '../lib/storage.js';
import Icon, { iconName } from '../components/ui/Icon';
import Money from '../components/ui/Money';

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
 * Five tabs preserved: Pulse, Expenses, Ledger, Income, Tax
 * All data from Supabase: expenses + transactions tables.
 */

const fmt = (cents) => {
  const pounds = Math.abs(cents) / 100;
  const str = pounds.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return cents < 0 ? `-£${str}` : `£${str}`;
};

const fmtShort = (cents) => {
  const pounds = Math.abs(cents) / 100;
  if (pounds >= 1000) return `${cents < 0 ? '-' : ''}£${(pounds / 1000).toFixed(1)}k`;
  return `${cents < 0 ? '-' : ''}£${pounds.toFixed(0)}`;
};

const CATEGORIES = [
  { value: 'products', label: 'Products', icon: 'flower', color: 'var(--primary-fixed)' },
  { value: 'rent', label: 'Rent', icon: 'map-pin', color: 'var(--tertiary-fixed)' },
  { value: 'training', label: 'Training', icon: 'file', color: 'var(--secondary-container)' },
  { value: 'travel', label: 'Travel', icon: 'map-pin', color: 'var(--success-bg)' },
  { value: 'equipment', label: 'Equipment', icon: 'sliders', color: 'var(--tertiary-fixed)' },
  { value: 'insurance', label: 'Insurance', icon: 'shield', color: 'var(--info-bg)' },
  { value: 'marketing', label: 'Marketing', icon: 'send', color: 'var(--primary-fixed)' },
  { value: 'software', label: 'Software', icon: 'link', color: 'var(--gold-light)' },
  { value: 'utilities', label: 'Utilities', icon: 'sparkles', color: 'var(--warning-bg)' },
  { value: 'other', label: 'Other', icon: 'map-pin', color: 'var(--surface-container-high)' },
];

const getCategoryMeta = (val) => CATEGORIES.find(c => c.value === val) || CATEGORIES[CATEGORIES.length - 1];

/**
 * Money that really landed, versus money Florrie ASSUMED.
 *
 * 27 August 2026. Finishing a booking writes a type 'payment' row so this page
 * adds up (backend lib/takings.js). Nobody handed anything over at that moment:
 * the row is Florrie guessing Ellie was paid in the room because the treatment
 * ended. It carries no payment_method and no Stripe payment intent, and that
 * shape is the whole of its identity. A real card charge writes the same type
 * with 'card_online' and an intent id; cash or a transfer she keys in herself
 * carries a method too.
 *
 * This page printed all of them identically as "Payment". So a week could read
 * £400 taken when nothing had left a single client's account, and there was
 * nothing on any screen that would tell her. That is the most dangerous thing
 * in the app, and it is now the difference between two words.
 *
 * No new column: the row already says which it is. Same test as
 * backend/src/lib/money-guards.js isAssumedTakingsRow, deliberately.
 */
export function isAssumedPayment(tx) {
  if (!tx) return false;
  if (!['payment', 'full_payment', 'payment_link'].includes(tx.type)) return false;
  return !tx.stripe_payment_intent_id && !tx.payment_method;
}

/** What actually happened to this money, in her words rather than the schema's. */
function paymentStory(tx) {
  if (tx?.payment_method === 'completion_record') return 'Paid on completion';
  if (tx?.payment_method === 'completion_unpaid') return 'Unpaid';
  if (tx?.reporting_status === 'duplicate') return 'Duplicate record · excluded from totals';
  if (tx?.reporting_status === 'review') return 'Conflicting payment records · excluded pending review';
  if (tx?.reporting_status === 'excluded') return `${tx?.status || 'Unverified'} · excluded from totals`;
  if (tx?.type === 'refund') return tx.amount_cents > 0 ? 'Dispute reversal' : 'Refund / chargeback';
  if (isAssumedPayment(tx)) return 'Assumed, not confirmed';
  if (tx?.stripe_payment_intent_id) return 'Paid by card';
  if (tx?.payment_method === 'cash') return 'Paid in cash';
  if (tx?.payment_method === 'bank_transfer') return 'Paid by transfer';
  if (tx?.payment_method) return 'Paid';
  return null;
}

/** transactions.type in plain English. The vocabulary is the one in the live
 *  CHECK constraint, so a type with no label here is a schema change nobody
 *  told the UI about, and it falls back to the raw value rather than hiding. */
const INCOME_LABELS = {
  payment: 'Payment',
  deposit: 'Deposit',
  full_payment: 'Paid in full',
  payment_link: 'Payment link',
  no_show_fee: 'No-show fee',
  late_cancel_fee: 'Late cancellation fee',
  tip: 'Tip',
  product_sale: 'Product sale',
  refund: 'Refund',
};

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

/**
 * "£450" rather than "£450.00" when there is nothing after the point. The
 * Regular costs line reads as a sentence, and a trailing .00 in the middle of a
 * sentence reads as a form field.
 */
const fmtNeat = (cents) => {
  const value = Math.abs(cents) / 100;
  const body = value % 1 === 0
    ? value.toLocaleString('en-GB')
    : value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${cents < 0 ? '-' : ''}£${body}`;
};

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** 1st, 2nd, 3rd, 21st. British, and worth getting right: "monthly on the 1"
 *  reads like a bug. */
function ordinal(n) {
  const num = Number(n) || 1;
  const tens = num % 100;
  if (tens >= 11 && tens <= 13) return `${num}th`;
  return `${num}${['th', 'st', 'nd', 'rd'][num % 10] || 'th'}`;
}

/** A date-only string as "1 September", with the year only when it is not this
 *  one. Parsed from its own parts, never new Date(str), which is UTC midnight
 *  and slides back a day in a negative-offset zone. */
function prettyDate(dateStr, { withYear = 'auto' } = {}) {
  if (!dateStr) return '';
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '';
  const showYear = withYear === true || (withYear === 'auto' && y !== new Date().getFullYear());
  return `${d} ${MONTH_NAMES[m - 1]}${showYear ? ` ${y}` : ''}`;
}

/** "Rent, £450, monthly on the 1st". The rule in one line, so she can check it
 *  without opening the editor. */
function describeRecurring(rule) {
  const name = rule.vendor || rule.description || (CATEGORIES.find(c => c.value === rule.category)?.label ?? 'Cost');
  const amount = fmtNeat(rule.amount_cents);
  if (rule.frequency === 'weekly') {
    return `${name}, ${amount}, weekly on ${WEEKDAY_NAMES[rule.day_of_week ?? 0]}`;
  }
  if (rule.frequency === 'yearly') {
    return `${name}, ${amount}, yearly on ${ordinal(rule.day_of_month || 1)} ${MONTH_NAMES[(rule.month_of_year || 1) - 1]}`;
  }
  return `${name}, ${amount}, monthly on the ${ordinal(rule.day_of_month || 1)}`;
}

/**
 * Authorised call to the backend.
 *
 * The page already talks to /api/money/reports this way. Collected here because
 * the Ledger, the year to date summary and Regular costs all need it, and three
 * more copies of "get the session, build the header, check res.ok" is three
 * more places to forget the check.
 */
const emptyRecurringForm = () => {
  const now = new Date();
  return {
    amount: '', vendor: '', description: '', category: 'rent',
    frequency: 'monthly',
    day_of_month: String(now.getDate()),
    day_of_week: String(now.getDay()),
    month_of_year: String(now.getMonth() + 1),
  };
};

async function apiFetch(path, options = {}) {
  return moneyApi({ auth: supabase.auth, url: `${API_BASE}${path}`, options });
}


export default function MoneyTracker() {
  const { hidden: clientDetailsHidden } = useClientPrivacy();
  const navigate = useNavigate();
  const { beautician, loading: bLoading } = useBeautician();
  const [expenses, setExpenses] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [incomeVisible, setIncomeVisible] = useState(100);
  const timezone = beautician?.timezone || 'Europe/London';
  const [reports, setReports] = useState(null);
  const [reportsLoading, setReportsLoading] = useState(true);
  const [reportsAttempt, setReportsAttempt] = useState(0);
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = ['pulse', 'expenses', 'ledger', 'income', 'tax'].includes(searchParams.get('tab')) ? searchParams.get('tab') : 'pulse';
  const setTab = value => setSearchParams(p => { p.set('tab', value); return p; });
  const [taxYear, setTaxYear] = useState('');
  const [exporting, setExporting] = useState(false);
  const [savingEntry, setSavingEntry] = useState(null);
  const entryIds = useRef({}), saveLock = useRef(false);
  const [incomeFilter, setIncomeFilter] = useState('received');
  const [incomeRange, setIncomeRange] = useState(null);
  const [ledgerRevision, setLedgerRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showAddExpense, setShowAddExpense] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [period, setPeriod] = useState('month');

  // The ledger and regular costs come from the API. Local totals use the
  // same reporting functions as that API and the accountant export.
  const [recurring, setRecurring] = useState([]);
  const [recurringOff, setRecurringOff] = useState(false); // migration not applied yet
  const [ledger, setLedger] = useState(null);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState(null);
  const [ledgerYear, setLedgerYear] = useState('');
  const [ledgerCategory, setLedgerCategory] = useState('');
  const [ledgerType, setLedgerType] = useState('all');
  const [ledgerPage, setLedgerPage] = useState(1);

  // A one-line problem that must NOT take the page away. The page-level
  // `error` state renders a retry screen instead of everything else, which is
  // right for "your money would not load" and much too heavy for "that pause
  // did not save".
  const [notice, setNotice] = useState(null);

  const [showRecurringForm, setShowRecurringForm] = useState(false);
  const [editingRecurring, setEditingRecurring] = useState(null);
  const [savingRecurring, setSavingRecurring] = useState(false);
  const [confirmDeleteRule, setConfirmDeleteRule] = useState(null);
  const [recurringForm, setRecurringForm] = useState(emptyRecurringForm());

  // The "this repeats" tick on the add-expense form. Off by default: creating a
  // standing cost by accident is worse than typing one twice.
  const [repeats, setRepeats] = useState(false);
  const [repeatFrequency, setRepeatFrequency] = useState('monthly');

  const [receiptPreview, setReceiptPreview] = useState(null);
  const [attachingReceipt, setAttachingReceipt] = useState(false);
  const [showLogTip, setShowLogTip] = useState(false);
  const [showLogSale, setShowLogSale] = useState(false);
  const [tipAmount, setTipAmount] = useState('');
  const [saleAmount, setSaleAmount] = useState('');
  const [saleDesc, setSaleDesc] = useState('');
  const receiptInputRef = useRef(null);

  // `receipt_url` holds the storage PATH inside the private bucket, not a URL.
  // A signed URL expires; a path does not. See lib/storage.js.
  const [newExpense, setNewExpense] = useState({
    amount: '', vendor: '', description: '',
    category: 'products', date: todayLocal(),
    tax_deductible: true, receipt_url: ''
  });

  // Receipts live in a private bucket, so a thumbnail needs a signed URL.
  // Signed here on read, keyed by expense id, refreshed whenever the list
  // changes. Nothing is persisted, so nothing can expire in the database.
  const [receiptThumbs, setReceiptThumbs] = useState({});

  useEffect(() => {
    const refs = expenses
      .filter(e => e.receipt_url)
      .map(e => [e.id, e.receipt_url]);
    if (!refs.length) { setReceiptThumbs({}); return undefined; }
    let cancelled = false;
    signedUrlMap(refs, { bucket: PRIVATE_BUCKET })
      .then(map => { if (!cancelled) setReceiptThumbs(map); })
      .catch(err => logger.warn({ err }, 'Receipt thumbnails could not be signed'));
    return () => { cancelled = true; };
  }, [expenses]);

  // Long-press an expense row to delete it (Ellie: duplicate receipt scans
  // need clearing out). Press-and-hold ~550ms opens a confirm sheet; any
  // scroll or early release cancels.
  const [confirmDeleteExp, setConfirmDeleteExp] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const pressTimer = useRef(null);
  function startPress(exp) {
    clearTimeout(pressTimer.current);
    pressTimer.current = setTimeout(() => {
      hapticTap();
      setConfirmDeleteExp(exp);
    }, 550);
  }
  function cancelPress() {
    clearTimeout(pressTimer.current);
  }
  async function handleDeleteExpense() {
    const exp = confirmDeleteExp;
    if (!exp || deleting) return;
    setDeleting(true);
    try {
      // .select() so a silent RLS no-op can't masquerade as a delete.
      const { data, error: delErr } = await supabase
        .from('expenses')
        .delete()
        .eq('id', exp.id)
        .eq('beautician_id', beautician.id)
        .select('id');
      if (delErr || !data?.length) {
        logger.error({ err: delErr }, 'Expense delete failed');
        setNotice('Could not confirm the deletion. Refresh your records before trying again.');
      } else {
        hapticSuccess();
        setExpenses(prev => prev.filter(e => e.id !== exp.id));
      }
    } catch (err) {
      logger.error({ err }, 'Expense delete threw');
      setNotice('Could not confirm the deletion. Refresh your records before trying again.');
    } finally {
      setDeleting(false);
      setConfirmDeleteExp(null);
    }
  }

  useEffect(() => {
    if (beautician) loadData();
  }, [beautician]);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {

      const now = new Date();
      const today = moneyDate(now, timezone);
      const [allExpenses, rawTransactions] = await Promise.all([
        readAllMoney(() => supabase.from('expenses').select('*', { count: 'exact' })
          .eq('beautician_id', beautician.id).order('date', { ascending: false }).order('id')),
        readAllMoney(() => supabase.from('transactions')
          .select('*, appointments(id, starts_at, client_id, clients(first_name, last_name), treatments(name))', { count: 'exact' })
          .eq('beautician_id', beautician.id).lte('created_at', now.toISOString()).order('created_at', { ascending: false }).order('id')),
      ]);
      const allTransactions = reconcileTransactions(rawTransactions, now);
      setExpenses(allExpenses);
      setTransactions(allTransactions);
      setLedgerYear(prev => prev || reportingYear(today));
      setReports(null);

      setLoading(false);
    } catch (err) {
      logger.error({ err }, 'Money load error');
      setError('Something went wrong loading your money data');
    } finally {
      setLoading(false);
    }
  }

  // A newly recorded receipt also changes the optional monthly comparison.
  useEffect(() => {
    if (!beautician || loading) return;
    let cancelled = false;
    setReports(null);
    setReportsLoading(true);
    apiFetch('/api/money/reports')
      .then(data => { if (!cancelled) setReports(data); })
      .catch(() => { /* A failed diary read leaves recorded receipts usable. */ })
      .finally(() => { if (!cancelled) setReportsLoading(false); });
    return () => { cancelled = true; };
  }, [beautician?.id, loading, transactions, reportsAttempt]);

  // Year to date and the regular costs load alongside the page rather than
  // blocking it: if either fails the rest of the Money page still works, which
  // is how the reports card already behaves.
  useEffect(() => {
    if (!beautician) return;
    let cancelled = false;

    (async () => {
      try {
        const data = await apiFetch('/api/recurring-expenses');
        if (cancelled) return;
        setRecurring(data.recurring || []);
        setRecurringOff(Boolean(data.needs_migration));
      } catch (err) {
        logger.warn({ err }, 'Regular costs unavailable');
      }
    })();

    return () => { cancelled = true; };
  }, [beautician]);

  // The ledger is only fetched when it is being looked at. It reads the whole
  // filtered history to build the running total, so loading it on every page
  // open would be a big query nobody asked for.
  useEffect(() => {
    if (!beautician || tab !== 'ledger') return;
    let cancelled = false;

    (async () => {
      setLedgerLoading(true);
      setLedger(null);
      setLedgerError(null);
      try {
        const params = new URLSearchParams({ page: String(ledgerPage), page_size: '50' });
        if (ledgerYear) params.set('tax_year', ledgerYear);
        if (ledgerCategory) params.set('category', ledgerCategory);
        if (ledgerType !== 'all') params.set('type', ledgerType);
        const data = await apiFetch(`/api/money/ledger?${params.toString()}`);
        if (cancelled) return;
        setLedger(data);
        // First load: settle the picker on the year the backend chose, so the
        // dropdown and the numbers cannot disagree.
        if (!ledgerYear && data.tax_years?.length) setLedgerYear(data.tax_years[0]);
      } catch (err) {
        if (!cancelled) setLedgerError('Could not load these records. Please try again.');
        logger.error({ err }, 'Ledger load failed');
      } finally {
        if (!cancelled) setLedgerLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [beautician, tab, ledgerYear, ledgerCategory, ledgerType, ledgerPage, transactions, expenses, ledgerRevision]);

  async function reloadRecurring() {
    try {
      const data = await apiFetch('/api/recurring-expenses');
      setRecurring(data.recurring || []);
      setRecurringOff(Boolean(data.needs_migration));
    } catch (err) {
      logger.error({ err }, 'Could not reload regular costs');
    }
  }

  function openRecurringEditor(rule) {
    if (rule) {
      setEditingRecurring(rule);
      setRecurringForm({
        amount: (rule.amount_cents / 100).toFixed(2),
        vendor: rule.vendor || '',
        description: rule.description || '',
        category: rule.category,
        frequency: rule.frequency,
        day_of_month: String(rule.day_of_month || 1),
        day_of_week: String(rule.day_of_week ?? 1),
        month_of_year: String(rule.month_of_year || 1),
      });
    } else {
      setEditingRecurring(null);
      setRecurringForm(emptyRecurringForm());
    }
    setShowRecurringForm(true);
  }

  /** The rule fields, shaped for the API. Anchors that do not apply to the
   *  chosen frequency are sent as null rather than left over from a previous
   *  choice, or a rule switched from yearly to monthly keeps a month nobody
   *  can see. */
  function recurringPayload(form) {
    const cents = Math.round(parseFloat(form.amount) * 100);
    return {
      amount_cents: cents,
      vendor: form.vendor.trim() || null,
      description: form.description.trim() || null,
      category: form.category,
      frequency: form.frequency,
      day_of_month: form.frequency === 'weekly' ? null : (Number(form.day_of_month) || 1),
      day_of_week: form.frequency === 'weekly' ? (Number(form.day_of_week) || 0) : null,
      month_of_year: form.frequency === 'yearly' ? (Number(form.month_of_year) || 1) : null,
    };
  }

  async function handleSaveRecurring() {
    const cents = Math.round(parseFloat(recurringForm.amount) * 100);
    if (!cents || cents <= 0) {
      setNotice('Put an amount in first.');
      return;
    }
    setSavingRecurring(true);
    try {
      const payload = recurringPayload(recurringForm);
      if (editingRecurring) {
        await apiFetch(`/api/recurring-expenses/${editingRecurring.id}`, {
          method: 'PATCH', body: JSON.stringify(payload),
        });
      } else {
        await apiFetch('/api/recurring-expenses', {
          method: 'POST', body: JSON.stringify(payload),
        });
      }
      hapticSuccess();
      setShowRecurringForm(false);
      setEditingRecurring(null);
      setRecurringForm(emptyRecurringForm());
      await reloadRecurring();
    } catch (err) {
      logger.error({ err }, 'Save regular cost failed');
      setNotice(err.message || 'Could not save that regular cost.');
    } finally {
      setSavingRecurring(false);
    }
  }

  async function handleToggleRecurring(rule) {
    hapticTap();
    // Optimistic, then reconciled from the response: pausing is a one-tap
    // action and waiting a round trip for the switch to move feels broken.
    setRecurring(prev => prev.map(r => (r.id === rule.id ? { ...r, active: !r.active } : r)));
    try {
      const data = await apiFetch(`/api/recurring-expenses/${rule.id}`, {
        method: 'PATCH', body: JSON.stringify({ active: !rule.active }),
      });
      setRecurring(prev => prev.map(r => (r.id === rule.id ? data.recurring : r)));
    } catch (err) {
      logger.error({ err }, 'Pause regular cost failed');
      setRecurring(prev => prev.map(r => (r.id === rule.id ? rule : r)));
      setNotice('Could not change that regular cost.');
    }
  }

  async function handleDeleteRecurring() {
    const rule = confirmDeleteRule;
    if (!rule) return;
    try {
      await apiFetch(`/api/recurring-expenses/${rule.id}`, { method: 'DELETE' });
      hapticSuccess();
      setRecurring(prev => prev.filter(r => r.id !== rule.id));
    } catch (err) {
      logger.error({ err }, 'Delete regular cost failed');
      setNotice('Could not remove that regular cost.');
    } finally {
      setConfirmDeleteRule(null);
    }
  }

  /** The CSV the accountant gets. Same export that already exists, reachable
   *  from the ledger where somebody looking at a full history would go for it.
   *  Fetched with the session token rather than as a bare link: the endpoint is
   *  authed, so a plain href downloads an error page. */
  async function handleExportLedgerCSV(selectedYear) {
    const year = typeof selectedYear === 'string' ? selectedYear : ledgerYear && ledgerYear !== 'all' ? ledgerYear : ytd?.current?.tax_year;
    if (!year || exporting || clientDetailsHidden) return;
    setExporting(true);
    try {
      const blob = await boundedMoneyRequest(async signal => {
        const token = (await supabase.auth.getSession())?.data?.session?.access_token;
        if (signal.aborted || !token) throw new Error('Please sign in again before exporting.');
        const res = await fetch(`${API_BASE}/api/exports/tax-quarterly?year=${encodeURIComponent(year)}`, {
          signal, headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error('Export failed');
        return res.blob();
      });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `florrie-${year}.csv`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => window.URL.revokeObjectURL(url), 1000);
      document.body.removeChild(a);
    } catch (err) {
      logger.error({ err }, 'Ledger export failed');
      setNotice('Could not build that export. Try again in a moment.');
    } finally { setExporting(false); }
  }

  function computePulse() {
    const today = moneyDate(new Date(), timezone);
    const window = periodWindow('week', today);
    const current = moneyTotals({ transactions, expenses, ...window, timezone });
    const previous = moneyTotals({ transactions, expenses, start: shiftDate(window.start, -7), end: shiftDate(window.start, -1), timezone });
    return {
      thisWeek: { income: current.income_cents, expenses: current.expenses_cents, profit: current.profit_cents },
      lastWeek: { income: previous.income_cents, expenses: previous.expenses_cents, profit: previous.profit_cents },
    };
  }



  async function handleReceiptScan(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setScanning(true);
    setNotice(null);

    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = reader.result.split(',')[1];

        // 1. Upload the receipt image. A receipt is a financial document, so
        //    it goes in the private bucket and is read back through a signed
        //    URL. What gets stored on the row is the PATH.
        //
        //    A failed upload used to be swallowed here, which left the row
        //    holding an empty string and the salon believing the photo was
        //    filed. Now she is told. The scan itself still runs, because the
        //    OCR reads the base64 in memory and does not need storage, and
        //    losing the typing as well as the photo helps nobody.
        let receiptPath = '';
        try {
          const stored = await uploadReceipt(file);
          receiptPath = stored.path;
        } catch (uploadErr) {
          setNotice(`${uploadErr.message} The details below were still read from the photo, so you can save the expense without it.`);
        }

        // 2. Send to Claude Vision OCR endpoint.
        //    The session lookup is guarded because this whole handler runs
        //    inside FileReader.onload, outside the try below it: anything that
        //    threw here left `scanning` stuck true and the Scan Receipt button
        //    disabled until the page was reloaded.
        let token = null;
        try {
          token = (await supabase.auth.getSession())?.data?.session?.access_token;
        } catch (sessionErr) {
          logger.warn('Receipt scan: session lookup failed', sessionErr);
        }
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
            date: extracted.date || todayLocal(),
            tax_deductible: true,
            receipt_url: receiptPath,
            hmrc_category: extracted.hmrc_category || '',
            line_items: extracted.line_items || [],
            ocr_confidence: confidence,
          });
        } else {
          // OCR failed - still open the form with the receipt attached
          setNewExpense(prev => ({
            ...prev,
            description: `Receipt: ${file.name}`,
            receipt_url: receiptPath,
            date: todayLocal(),
          }));
        }

        setReceiptPreview(reader.result);
        setShowAddExpense(true);
        setScanning(false);
      };
      reader.onerror = () => {
        logger.error('Receipt file could not be read');
        setNotice('Could not read that image. Try taking the photo again.');
        setScanning(false);
      };
      reader.readAsDataURL(file);
      // The File is already held, so clearing the input is safe and lets her
      // rescan the same receipt after a failure.
      if (e.target) e.target.value = '';
    } catch (err) {
      logger.error({ err }, 'Receipt scan error');
      setNotice('Could not read that receipt. Please try again.');
      setScanning(false);
    }
  }

  /**
   * Put a receipt in the private bucket and hand back where it landed.
   *
   * Throws on failure so no caller can quietly carry on. The message on the
   * error is already written for a person to read.
   */
  async function uploadReceipt(file) {
    return uploadFile({
      bucket: PRIVATE_BUCKET,
      path: objectPath(beautician.id, 'receipts', file.name),
      file,
    });
  }

  /**
   * The "Add photo" button on the expense form, as opposed to Scan Receipt.
   *
   * This used to set a blob URL as the preview and upload nothing at all, so
   * the photo existed until the screen closed and then did not exist anywhere.
   */
  async function handleReceiptAttach(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setReceiptPreview(URL.createObjectURL(file));
    setAttachingReceipt(true);
    setNotice(null);
    try {
      const stored = await uploadReceipt(file);
      setNewExpense(p => ({ ...p, receipt_url: stored.path }));
    } catch (err) {
      setNewExpense(p => ({ ...p, receipt_url: '' }));
      setReceiptPreview(null);
      setNotice(err.message);
    } finally {
      setAttachingReceipt(false);
      // Let her pick the same file again after a failure.
      if (e.target) e.target.value = '';
    }
  }

  async function handleAddExpense() {
    if (saveLock.current || clientDetailsHidden || attachingReceipt || !beautician) return;
    saveLock.current = true; setSavingEntry('expense'); setNotice(null);
    try {
      const cents = parseMoneyInput(newExpense.amount);
      if (!newExpense.date || !/^\d{4}-\d{2}-\d{2}$/.test(newExpense.date)) throw new Error('Choose the expense date.');
      const row = await saveMoneyEntry({ db: supabase, table: 'expenses', row: {
        id: entryIds.current.expense ||= crypto.randomUUID(),
        beautician_id: beautician.id,
        amount_cents: cents,
        vendor: newExpense.vendor.trim(),
        description: newExpense.description.trim(),
        category: newExpense.category,
        date: newExpense.date,
        tax_deductible: newExpense.tax_deductible,
        // The storage path, not a URL. It was computed on every scan and then
        // dropped on the floor here, so no expense has ever kept its receipt.
        receipt_url: newExpense.receipt_url || null,
      } });
      setExpenses(prev => [row, ...prev.filter(e => e.id !== row.id)]);
      delete entryIds.current.expense;
      setNotice('Expense saved. Your totals are up to date.');

      // "This repeats": the expense she just logged IS this month's, so the
      // rule is anchored on its date and first_date tells the backend to start
      // from the NEXT occurrence. Without that the expense would be logged twice for
      // the month she is standing in.
      if (repeats) {
        const [ry, rm, rd] = newExpense.date.split('-').map(Number);
        try {
          await apiFetch('/api/recurring-expenses', {
            method: 'POST',
            body: JSON.stringify({
              amount_cents: cents,
              vendor: newExpense.vendor.trim() || null,
              description: newExpense.description.trim() || null,
              category: newExpense.category,
              frequency: repeatFrequency,
              first_date: newExpense.date,
              day_of_month: repeatFrequency === 'weekly' ? null : rd,
              day_of_week: repeatFrequency === 'weekly'
                ? new Date(ry, rm - 1, rd).getDay()
                : null,
              month_of_year: repeatFrequency === 'yearly' ? rm : null,
            }),
          });
          await reloadRecurring();
        } catch (err) {
          // The expense is saved either way. Say which half failed rather than
          // letting her think the whole thing did not go in.
          logger.error({ err }, 'Could not set up the repeat');
          setNotice('Expense saved, but the repeat could not be set up. Add it under Regular costs.');
        }
      }

      setNewExpense({
        amount: '', vendor: '', description: '',
        category: 'products', date: todayLocal(),
        tax_deductible: true, receipt_url: ''
      });
      setRepeats(false);
      setRepeatFrequency('monthly');
      setReceiptPreview(null);
      setShowAddExpense(false);
    } catch (err) {
      logger.error({ err }, 'Add expense error');
      setNotice(err.message || 'Could not save that expense. Your details are still here.');
    } finally { saveLock.current = false; setSavingEntry(null); }
  }

  async function logManualIncome(type) {
    if (saveLock.current || clientDetailsHidden || !beautician) return;
    saveLock.current = true; setSavingEntry(type); setNotice(null);
    try {
      const row = await saveMoneyEntry({ db: supabase, table: 'transactions', row: {
        id: entryIds.current[type] ||= crypto.randomUUID(), beautician_id: beautician.id,
        type, status: 'completed', amount_cents: parseMoneyInput(type === 'tip' ? tipAmount : saleAmount),
        description: type === 'tip' ? 'Tip' : saleDesc.trim() || 'Product sale',
      } });
      setTransactions(prev => reconcileTransactions([row, ...prev.filter(t => t.id !== row.id)]));
      delete entryIds.current[type]; hapticSuccess();
      if (type === 'tip') { setTipAmount(''); setShowLogTip(false); }
      else { setSaleAmount(''); setSaleDesc(''); setShowLogSale(false); }
      setNotice(`${type === 'tip' ? 'Tip' : 'Product sale'} saved. Your totals are up to date.`);
    } catch (err) {
      logger.error({ err }, 'Manual money entry failed');
      setNotice(err.message || 'Could not confirm the save. Your details are still here.');
    } finally { saveLock.current = false; setSavingEntry(null); }
  }
  const handleLogTip = () => logManualIncome('tip');
  const handleLogSale = () => logManualIncome('product_sale');

  const ytd = useMemo(() => {
    const today = moneyDate(new Date(), timezone), year = reportingYear(today);
    const previousYear = `${Number(year.slice(0, 4)) - 1}-${year.slice(2, 4)}`;
    const previousAsAt = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`.replace(/-02-29$/, '-02-28');
    return { current: { tax_year: year, as_at: today, ...moneyTotals({ transactions, expenses, ...reportingBounds(year), timezone }) },
      previous: { tax_year: previousYear, as_at: previousAsAt, ...moneyTotals({ transactions, expenses, start: reportingBounds(previousYear).start, end: previousAsAt, timezone }) } };
  }, [transactions, expenses, timezone]);
  const taxYears = useMemo(() => {
    const current = reportingYear(moneyDate(new Date(), timezone));
    return [...new Set([current, ...transactions.filter(t => t.created_at).map(t => reportingYear(moneyDate(t.created_at, timezone))), ...expenses.filter(e => e.date).map(e => reportingYear(e.date))])].filter(y => y <= current).sort().reverse();
  }, [transactions, expenses, timezone]);
  const tax = useMemo(() => taxReport({ transactions, expenses, beautician: beautician || {}, year: taxYear || undefined }), [transactions, expenses, beautician, taxYear]);

  const pulse = useMemo(() => !loading ? computePulse() : null, [loading, expenses, transactions]);

  // The Today / This Week / This Month pills. These previously set state that
  // nothing read, so the hero number never changed. Everything below the
  // pills (hero, quick stats, bento breakdown) now follows the selection,
  // each compared against the equivalent previous period.
  const periodStats = useMemo(() => {
    if (loading) return null;
    const window = periodWindow(period, moneyDate(new Date(), timezone));
    const current = moneyTotals({ transactions, expenses, ...window, timezone });
    const previous = moneyTotals({ transactions, expenses, start: window.previousStart, end: window.previousEnd, timezone });
    const received = transactions.filter(t => t.reporting_status === 'received' && moneyDate(t.created_at, timezone) >= window.start && moneyDate(t.created_at, timezone) <= window.end);
    return {
      income: current.income_cents, expenses: current.expenses_cents, profit: current.profit_cents,
      completed: current.transaction_count,
      changePct: previous.income_cents > 0 ? Math.round((current.income_cents - previous.income_cents) / previous.income_cents * 1000) / 10 : null,
      changeCents: current.income_cents - previous.income_cents,
      compareLabel: period === 'today' ? 'yesterday' : period === 'week' ? 'last week through the same day' : 'the same dates last month',
      treatments: sumMoney(received.filter(t => !['tip', 'product_sale'].includes(t.type))),
      products: sumMoney(received.filter(t => t.type === 'product_sale')),
      tips: sumMoney(received.filter(t => t.type === 'tip')),
    };
  }, [loading, period, transactions, expenses, timezone]);

  const dailyRevenue = useMemo(() => Array.from({ length: 7 }, (_, i) => {
    const dayStr = shiftDate(moneyDate(new Date(), timezone), i - 6);
    const label = new Date(`${dayStr}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short' }).charAt(0);
    return { dayStr, label, total: moneyTotals({ transactions, start: dayStr, end: dayStr, timezone }).income_cents };
  }), [transactions, timezone]);

  const maxDayRevenue = useMemo(() => Math.max(...dailyRevenue.map(d => Math.abs(d.total)), 1), [dailyRevenue]);

  // Breakdown by real transaction types, following the selected period.
  const breakdown = useMemo(() => {
    if (!periodStats) return { treatments: 0, products: 0, tips: 0 };
    return {
      treatments: periodStats.treatments,
      products: periodStats.products,
      tips: periodStats.tips,
    };
  }, [periodStats]);

  const recentTx = useMemo(() => latestPayments(transactions), [transactions]);
  function openAllIncome(filter = 'received') {
    setIncomeRange(null); setIncomeFilter(filter); setIncomeVisible(100); setTab('income');
  }

  function openPeriodIncome(filter = 'received') {
    const window = periodWindow(period, moneyDate(new Date(), timezone));
    setIncomeRange({ start: window.start, end: window.end, label: { today: 'Today', week: 'This week', month: 'This month' }[period] });
    setIncomeFilter(filter); setIncomeVisible(100); setTab('income');
  }

  const reconciliation = useMemo(() => moneyTotals({ transactions, timezone }), [transactions, timezone]);

  if (bLoading || loading) return <PageLoader />;
  if (error) return <MoreLoadError title="Money" message={error} onRetry={loadData} />;

  return (
    <div className="money-workspace" style={S.page}>
      {/* ─── Page Title ─── */}
      <PageHeader title="Money" />

      {/* ─── Tab Bar (pill style) ─── */}
      <div style={S.tabBar}>
        {['pulse', 'expenses', 'ledger', 'income', 'tax'].map(t => (
          <button
            key={t}
            aria-pressed={tab === t}
            onClick={() => setTab(t)}
            style={{ ...S.tab,
              ...(tab === t ? S.tabActive : {}),
            }}
          >
            {{ pulse: 'Pulse', expenses: 'Expenses', ledger: 'Ledger', income: 'Income', tax: 'Tax' }[t]}
          </button>
        ))}
      </div>

      {notice && (
        <div style={S.noticeBar} role="status">
          <span style={{ flex: 1 }}><PrivateText placeholder="Hidden">{notice}</PrivateText></span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss" style={S.noticeClose}>
            <Icon name={iconName('close')} size={16} inline />
          </button>
        </div>
      )}

      {/* ═══ PULSE TAB ═══ */}
      {tab === 'pulse' && (
        <div>
          {pulse ? (
            <>
              {/* Period selector */}
              <div style={S.periodBar}>
                {['today', 'week', 'month'].map(p => (
                  <button
                    key={p}
                    aria-pressed={period === p}
                    onClick={() => setPeriod(p)}
                    style={{ ...S.periodBtn,
                      ...(period === p ? S.periodBtnActive : {}),
                    }}
                  >
                    {p === 'today' ? 'Today' : p === 'week' ? 'This Week' : 'This Month'}
                  </button>
                ))}
              </div>

              <MoneyDiaryOverview summary={reports?.appointments?.periods?.[period]} stats={periodStats}
                automatic={beautician.completion_receipts_enabled} loading={reportsLoading} onPayments={() => openPeriodIncome()}
                onRetry={() => setReportsAttempt(n => n + 1)} onCalendar={date => navigate('/calendar', { state: { date } })} />
              <MoneyRecentPayments payments={recentTx} timezone={timezone} onAll={() => openAllIncome()}
                onReview={() => openAllIncome('review')} needsReview={reconciliation.assumed_count + reconciliation.review_count > 0 || transactions.some(t => t.reporting_status === 'unpaid')}/>

              <div className="money-quick-actions"><Button variant="quiet" size="sm" onClick={() => setShowLogTip(value => !value)}>+ log tip</Button><Button variant="quiet" size="sm" onClick={() => setShowLogSale(value => !value)}>+ log sale</Button></div>
              {/* ─── Quick Log Tip ─── */}
              {showLogTip && (
                <section style={S.quickLogCard}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <Icon name={iconName('volunteer_activism')} size={18} inline style={{ color: 'var(--success)' }} />
                    <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Log a Tip</span>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <PrivateAmount><input
                      type="number" step="0.01" placeholder="Amount (£)"
                      value={tipAmount}
                      onChange={e => setTipAmount(e.target.value)}
                      style={{ ...S.formInput, flex: 1 }}
                      autoFocus
                    /></PrivateAmount>
                    <button className="fl-tap" disabled={clientDetailsHidden || !!savingEntry} onClick={handleLogTip} style={{ ...S.btnPrimary, flex: 'none', padding: '11px 20px', background: 'var(--success, #386F52)' }}>
                      Save
                    </button>
                    <button onClick={() => { setShowLogTip(false); setTipAmount(''); }} style={{ ...S.btnGhost, flex: 'none' }}>
                      <Icon name={iconName('close')} size={16} inline />
                    </button>
                  </div>
                </section>
              )}

              {/* ─── Quick Log Product Sale ─── */}
              {showLogSale && (
                <section style={S.quickLogCard}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <Icon name={iconName('shopping_bag')} size={18} inline style={{ color: 'var(--gold)' }} />
                    <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Log a Product Sale</span>
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <PrivateAmount><input
                      type="number" step="0.01" placeholder="Amount (£)"
                      value={saleAmount}
                      onChange={e => setSaleAmount(e.target.value)}
                      style={{ ...S.formInput, flex: 1 }}
                      autoFocus
                    /></PrivateAmount>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <PrivateText placeholder="Private field hidden"><input
                      type="text" placeholder="Product name (optional)"
                      value={saleDesc}
                      onChange={e => setSaleDesc(e.target.value)}
                      style={{ ...S.formInput, flex: 1 }}
                    /></PrivateText>
                    <button className="fl-tap" disabled={clientDetailsHidden || !!savingEntry} onClick={handleLogSale} style={{ ...S.btnPrimary, flex: 'none', padding: '11px 20px', background: 'var(--gold)' }}>
                      Save
                    </button>
                    <button onClick={() => { setShowLogSale(false); setSaleAmount(''); setSaleDesc(''); }} style={{ ...S.btnGhost, flex: 'none' }}>
                      <Icon name={iconName('close')} size={16} inline />
                    </button>
                  </div>
                </section>
              )}

              <details className="money-details"><summary>Trends &amp; breakdowns<Icon name="chevron-down" size={16}/></summary>
          {reports && (
            <div style={S.reportsCard}>
              <div style={S.reportsTitle}>Your numbers</div>
              <div style={S.reportsRow}>
                <div style={{ ...S.reportStat, gridColumn: '1 / -1' }}>
                  <span style={S.reportValue}><PrivateAmount>{fmt(reports.revenue.this_month_cents || 0)}</PrivateAmount></span>
                  <span style={S.reportLabel}>
                    payments recorded this month{reports.revenue.change_pct != null ? ` \u00B7 ${reports.revenue.change_pct >= 0 ? '+' : ''}${reports.revenue.change_pct}%` : ''}
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
              {reports.insight && <div style={S.reportInsight}><PrivateText placeholder="Hidden">{reports.insight}</PrivateText></div>}
            </div>
          )}
              {/* ─── Mini Bar Chart ─── */}
              <section style={S.chartCard}>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height: 80 }}>
                  {!dailyRevenue.some(d => d.total !== 0) ? (
                    <div style={{ flex: 1, alignSelf: 'center', textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>No takings logged this week yet</div>
                  ) : dailyRevenue.map((d, i) => {
                    const isToday = i === dailyRevenue.length - 1;
                    const h = Math.max(4, (Math.abs(d.total) / maxDayRevenue) * 72);
                    return (
                      <div key={i} title={clientDetailsHidden ? undefined : `${d.dayStr}: ${fmt(d.total)}`} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                        <div style={{ width: '100%',
                          height: h,
                          borderRadius: 'var(--radius-xs)',
                          background: d.total < 0 ? 'var(--danger)' : isToday
                            ? 'linear-gradient(180deg, #B9466D 0%, #92405e 100%)'
                            : 'rgba(146, 64, 94, 0.15)',
                          transition: 'height 0.3s ease',
                        }} />
                        <span style={{ fontSize: 9,
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
                <div style={{ ...S.bentoCard, background: 'rgba(255, 217, 226, 0.3)' }}>
                  <Icon name={iconName('content_cut')} size={20} inline style={{ color: 'var(--accent)' }} />
                  <span style={S.bentoLabel}>Treatments</span>
                  <span style={{ ...S.bentoValue, color: 'var(--accent)' }}><PrivateAmount>{fmtShort(breakdown.treatments)}</PrivateAmount></span>
                </div>
                <div
                  onClick={() => setShowLogSale(s => !s)}
                  style={{ ...S.bentoCard, background: 'rgba(254, 219, 155, 0.3)', cursor: 'pointer' }}
                >
                  <Icon name={iconName('shopping_bag')} size={20} inline style={{ color: 'var(--gold)' }} />
                  <span style={S.bentoLabel}>Products</span>
                  <span style={{ ...S.bentoValue, color: 'var(--gold)' }}><PrivateAmount>{fmtShort(breakdown.products)}</PrivateAmount></span>

                </div>
                <div
                  onClick={() => setShowLogTip(s => !s)}
                  style={{ ...S.bentoCard, background: 'rgba(91, 169, 123, 0.1)', cursor: 'pointer' }}
                >
                  <Icon name={iconName('volunteer_activism')} size={20} inline style={{ color: 'var(--success)' }} />
                  <span style={S.bentoLabel}>Tips</span>
                  <span style={{ ...S.bentoValue, color: 'var(--success)' }}><PrivateAmount>{fmtShort(breakdown.tips)}</PrivateAmount></span>

                </div>
              </section>

              {/* ─── Last Week Comparison ─── */}
              <section style={{ ...S.compCard, marginTop: 24 }}>
                <h4 style={S.compTitle}>Last Week</h4>
                <div style={S.compRow}><span style={S.compLabel}>Income</span><span style={S.compValue}><PrivateAmount>{fmt(pulse.lastWeek.income)}</PrivateAmount></span></div>
                <div style={S.compRow}><span style={S.compLabel}>Expenses</span><span style={S.compValue}><PrivateAmount>{fmt(pulse.lastWeek.expenses)}</PrivateAmount></span></div>
                <div style={{ ...S.compRow, borderBottom: 'none' }}>
                  <span style={{ ...S.compLabel, fontWeight: 600 }}>Profit</span>
                  <span style={{ ...S.compValue, fontWeight: 700, color: pulse.lastWeek.profit >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                    <PrivateAmount>{fmt(pulse.lastWeek.profit)}</PrivateAmount>
                  </span>
                </div>
              </section>
      {ytd && (
        <section style={S.ytdCard}>
          <div style={S.ytdHead}>
            <span style={S.ytdTitle}>Tax year {ytd.current.tax_year} so far</span>
            <span style={S.ytdDates}>6 April to {prettyDate(ytd.current.as_at)}</span>
          </div>
          <div style={S.ytdRow}>
            <div style={S.ytdStat}>
              <span style={S.ytdLabel}>Income</span>
              <span style={S.ytdValue}><PrivateAmount>{fmtNeat(ytd.current.income_cents)}</PrivateAmount></span>
            </div>
            <div style={S.ytdStat}>
              <span style={S.ytdLabel}>Expenses</span>
              <span style={S.ytdValue}><PrivateAmount>{fmtNeat(ytd.current.expenses_cents)}</PrivateAmount></span>
            </div>
            <div style={S.ytdStat}>
              <span style={S.ytdLabel}>Profit</span>
              <span style={{ ...S.ytdValue,
                color: ytd.current.profit_cents >= 0 ? 'var(--success)' : 'var(--danger)',
              }}><PrivateAmount>{fmtNeat(ytd.current.profit_cents)}</PrivateAmount></span>
            </div>
          </div>
          {/* ^ Income / Expenses / Profit are stacked rows, not three side-by-side
              columns. Three flex:1 thirds of a 390px card (~106px each after the
              card padding and gaps) is narrower than a four-figure tabular value
              at this weight and size ("£10,009.60" alone runs to ~135px) — the
              figure has nowhere to wrap (it is one unbroken token) and no clip is
              applied, so it spills out of its own column and lands directly on
              its neighbour, gap and all. That is what "£10,009.60£65.71" was: the
              Income figure had already overflowed onto the Expenses column
              before Expenses' text even started. A stacked row gives every value
              the full card width to itself (~300px), which holds even
              "-£100,000.00" comfortably, at any combination of income/expenses/
              profit magnitude — not just a wider gap that happens to survive
              today's numbers. */}
          {/* Cut off at the same calendar point last year on purpose. Four
              months against twelve always looks like a collapse. */}
          <div style={S.ytdCompare}>
            <span>{ytd.previous.tax_year} to the same point</span>
            <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>
              <PrivateAmount>{fmtNeat(ytd.previous.income_cents)}</PrivateAmount> in, <PrivateAmount>{fmtNeat(ytd.previous.expenses_cents)}</PrivateAmount> out,
              {' '}<PrivateAmount>{fmtNeat(ytd.previous.profit_cents)}</PrivateAmount> profit
            </span>
          </div>
        </section>
      )}

              </details>
            </>
          ) : (
            <EmptyState message="Complete appointments and log expenses to see your pulse." icon="chart" />
          )}
        </div>
      )}

      {/* ═══ EXPENSES TAB ═══ */}
      {tab === 'expenses' && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button onClick={() => setShowAddExpense(!showAddExpense)} style={S.btnPrimary}>
              <Icon name={iconName('add')} size={16} inline style={{ color: '#fff', marginRight: 4 }} />
              Add Expense
            </button>
            <label style={{ ...S.btnSecondary, opacity: scanning ? 0.6 : 1, pointerEvents: scanning ? 'none' : 'auto' }}>
              <Icon name={iconName('photo_camera')} size={16} inline style={{ marginRight: 4 }} />
              {scanning ? 'Reading receipt...' : 'Scan Receipt'}
              <input type="file" accept="image/*" capture="environment" onChange={handleReceiptScan} style={{ display: 'none' }} disabled={scanning} />
            </label>
          </div>

          {showAddExpense && (
            <div style={S.formCard}>
              <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
                <div style={{ flex: 1 }}>
                  <label style={S.formLabel}>Amount (£)</label>
                  <PrivateAmount><input
                    type="number" step="0.01" placeholder="0.00"
                    value={newExpense.amount}
                    onChange={e => setNewExpense(p => ({ ...p, amount: e.target.value }))}
                    style={S.formInput}
                  /></PrivateAmount>
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
                <PrivateText placeholder="Private field hidden"><input
                  type="text" placeholder="e.g. Sally Beauty"
                  value={newExpense.vendor}
                  onChange={e => setNewExpense(p => ({ ...p, vendor: e.target.value }))}
                  style={S.formInput}
                /></PrivateText>
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={S.formLabel}>Category</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {CATEGORIES.map(c => (
                    <button className="fl-tap"
                      key={c.value}
                      type="button"
                      onClick={() => setNewExpense(p => ({ ...p, category: c.value }))}
                      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                        padding: '8px 10px', borderRadius: 10, minWidth: 56,
                        border: newExpense.category === c.value ? '1.5px solid var(--accent)' : '1.5px solid var(--border-light)',
                        background: newExpense.category === c.value ? 'var(--accent-bg)' : 'var(--bg-card)',
                        cursor: 'pointer', fontFamily: 'inherit',
                      }}
                    >
                      <span><Icon name={c.icon} size={16} /></span>
                      <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{c.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={S.formLabel}>Description</label>
                <PrivateText placeholder="Private field hidden"><input
                  type="text" placeholder="e.g. Brow tint x3, wax strips"
                  value={newExpense.description}
                  onChange={e => setNewExpense(p => ({ ...p, description: e.target.value }))}
                  style={S.formInput}
                /></PrivateText>
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={S.formLabel}>Receipt photo</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {receiptPreview ? (
                    <div style={{ position: 'relative', display: 'inline-block' }}>
                      <PrivateText placeholder="Photo hidden"><img src={receiptPreview} alt="Receipt" style={{ width: 64, height: 64, borderRadius: 10, objectFit: 'cover', border: '1.5px solid var(--border-light)' }} /></PrivateText>
                      <button className="fl-tap" onClick={() => { setReceiptPreview(null); setNewExpense(p => ({ ...p, receipt_url: '' })); }} style={{ position: 'absolute', top: -6, right: -6,
                        width: 20, height: 20, borderRadius: 10, border: 'none',
                        background: 'var(--danger)', color: '#fff', fontSize: 12,
                        cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>×</button>
                    </div>
                  ) : (
                    <button className="fl-tap"
                      type="button"
                      onClick={() => receiptInputRef.current?.click()}
                      style={{ padding: '10px 16px', borderRadius: 10, border: '1.5px dashed var(--border)',
                        background: 'var(--bg-card)', color: 'var(--text-muted)', fontSize: 13,
                        cursor: 'pointer', fontFamily: 'inherit',
                      }}
                    >
                      <Icon name={iconName('photo_camera')} size={14} inline style={{ marginRight: 4 }} /> Add photo
                    </button>
                  )}
                  <input
                    ref={receiptInputRef}
                    type="file" accept="image/*" capture="environment"
                    onChange={handleReceiptAttach}
                    style={{ display: 'none' }}
                  />
                  {attachingReceipt && (
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Saving photo...</span>
                  )}
                  {!attachingReceipt && receiptPreview && !newExpense.receipt_url && (
                    <span style={{ fontSize: 11, color: '#E57373' }}>
                      Not saved yet. Remove it and try again.
                    </span>
                  )}
                </div>
              </div>

              {newExpense.ocr_confidence > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6,
                  padding: '8px 12px', marginBottom: 12, borderRadius: 10,
                  background: newExpense.ocr_confidence >= 0.8 ? 'var(--success-bg, #E9F0EB)' : 'var(--gold-light, #ffdea4)',
                  fontSize: 12, color: newExpense.ocr_confidence >= 0.8 ? 'var(--success, #386F52)' : 'var(--gold-text, #795f2b)',
                }}>
                  <Icon name={newExpense.ocr_confidence >= 0.8 ? 'check' : 'alert-triangle'} size={14} />
                  <span>
                    Auto-filled from receipt ({Math.round(newExpense.ocr_confidence * 100)}% confident)
                    {newExpense.ocr_confidence < 0.8 ? ' - double-check the details' : ''}
                  </span>
                </div>
              )}

              <label style={{ display: 'flex', alignItems: 'center', fontSize: 13,
                color: 'var(--text-secondary)', marginBottom: 14, cursor: 'pointer',
                minHeight: 44,
              }}>
                <input
                  type="checkbox" checked={newExpense.tax_deductible}
                  onChange={e => setNewExpense(p => ({ ...p, tax_deductible: e.target.checked }))}
                />
                <span style={{ marginLeft: 8 }}>Tax deductible</span>
              </label>

              {/* This repeats. Rent, insurance and subscriptions were being
                  retyped every month, or forgotten, which quietly overstates
                  profit. Ticking it here saves the schedule as well as the
                  expense; the one just logged counts as this month's. */}
              {!recurringOff && (
                <div style={S.repeatBox}>
                  <label style={S.repeatToggle}>
                    <input
                      type="checkbox"
                      checked={repeats}
                      onChange={e => setRepeats(e.target.checked)}
                    />
                    <span style={{ marginLeft: 8, fontWeight: 600 }}>This repeats</span>
                  </label>
                  {repeats && (
                    <>
                      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                        {[['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly']].map(([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            onClick={() => setRepeatFrequency(value)}
                            style={{ ...S.chip,
                              ...(repeatFrequency === value ? S.chipActive : {}),
                            }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <p style={S.repeatHint}>
                        Florrie will log this again by itself. The next one is due after
                        {' '}{prettyDate(newExpense.date) || 'the date above'}, so it will not be logged twice. This does not make a payment.
                      </p>
                    </>
                  )}
                </div>
              )}

              <div style={{ display: 'flex', gap: 8 }}>
                <button disabled={clientDetailsHidden || !!savingEntry || attachingReceipt} onClick={handleAddExpense} style={S.btnPrimary}>{savingEntry === 'expense' ? 'Saving…' : 'Save Expense'}</button>
                <button onClick={() => setShowAddExpense(false)} style={S.btnGhost}>Cancel</button>
              </div>
            </div>
          )}

          {/* ─── Regular costs ─── */}
          {!recurringOff && (
            <section style={{ marginBottom: 20 }}>
              <div style={S.sectionHeader}>
                <h3 style={S.sectionHeading}>Regular costs</h3>
                <button
                  onClick={() => openRecurringEditor(null)}
                  style={S.addRuleBtn}
                >
                  <Icon name={iconName('add')} size={16} inline style={{ marginRight: 4, verticalAlign: 'middle' }} />
                  Add
                </button>
              </div>

              {recurring.length === 0 && !showRecurringForm && (
                <p style={S.ledgerNote}>
                  Rent, insurance, your booking software. Add them once and Florrie logs them
                  every time they are due.
                </p>
              )}

              {showRecurringForm && (
                <div style={S.formCard}>
                  <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
                    <div style={{ flex: 1 }}>
                      <label style={S.formLabel}>Amount (£)</label>
                      <PrivateAmount><input
                        type="number" step="0.01" placeholder="0.00"
                        value={recurringForm.amount}
                        onChange={e => setRecurringForm(f => ({ ...f, amount: e.target.value }))}
                        style={S.formInput}
                      /></PrivateAmount>
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={S.formLabel}>What is it</label>
                      <PrivateText placeholder="Private field hidden"><input
                        type="text" placeholder="e.g. Rent"
                        value={recurringForm.vendor}
                        onChange={e => setRecurringForm(f => ({ ...f, vendor: e.target.value }))}
                        style={S.formInput}
                      /></PrivateText>
                    </div>
                  </div>

                  <div style={{ marginBottom: 12 }}>
                    <label style={S.formLabel}>Category</label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {CATEGORIES.map(c => (
                        <button
                          key={c.value}
                          type="button"
                          onClick={() => setRecurringForm(f => ({ ...f, category: c.value }))}
                          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                            padding: '8px 10px', borderRadius: 10, minWidth: 56, minHeight: 44,
                            border: recurringForm.category === c.value ? '1.5px solid var(--accent)' : '1.5px solid var(--border-light)',
                            background: recurringForm.category === c.value ? 'var(--accent-bg)' : 'var(--bg-card)',
                            cursor: 'pointer', fontFamily: 'inherit',
                          }}
                        >
                          <span><Icon name={c.icon} size={16} /></span>
                          <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{c.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div style={{ marginBottom: 12 }}>
                    <label style={S.formLabel}>How often</label>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {[['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly']].map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setRecurringForm(f => ({ ...f, frequency: value }))}
                          style={{ ...S.chip,
                            ...(recurringForm.frequency === value ? S.chipActive : {}),
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {recurringForm.frequency === 'weekly' && (
                    <div style={{ marginBottom: 12 }}>
                      <label style={S.formLabel}>Which day</label>
                      <select
                        value={recurringForm.day_of_week}
                        onChange={e => setRecurringForm(f => ({ ...f, day_of_week: e.target.value }))}
                        style={S.formInput}
                      >
                        {WEEKDAY_NAMES.map((name, i) => (
                          <option key={name} value={String(i)}>{name}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {recurringForm.frequency !== 'weekly' && (
                    <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
                      {recurringForm.frequency === 'yearly' && (
                        <div style={{ flex: 1 }}>
                          <label style={S.formLabel}>Which month</label>
                          <select
                            value={recurringForm.month_of_year}
                            onChange={e => setRecurringForm(f => ({ ...f, month_of_year: e.target.value }))}
                            style={S.formInput}
                          >
                            {MONTH_NAMES.map((name, i) => (
                              <option key={name} value={String(i + 1)}>{name}</option>
                            ))}
                          </select>
                        </div>
                      )}
                      <div style={{ flex: 1 }}>
                        <label style={S.formLabel}>Day of the month</label>
                        <select
                          value={recurringForm.day_of_month}
                          onChange={e => setRecurringForm(f => ({ ...f, day_of_month: e.target.value }))}
                          style={S.formInput}
                        >
                          {Array.from({ length: 31 }, (_, i) => i + 1).map(d => (
                            <option key={d} value={String(d)}>{ordinal(d)}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  )}

                  {/* Says what actually happens in a short month, because "the
                      31st" in February is the question everybody asks. */}
                  {recurringForm.frequency !== 'weekly' && Number(recurringForm.day_of_month) > 28 && (
                    <p style={S.repeatHint}>
                      In a short month this lands on the last day instead, then goes back to
                      the {ordinal(recurringForm.day_of_month)}.
                    </p>
                  )}

                  <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                    <button
                      onClick={handleSaveRecurring}
                      disabled={clientDetailsHidden || (savingRecurring)}
                      style={{ ...S.btnPrimary, opacity: savingRecurring ? 0.6 : 1, minHeight: 44 }}
                    >
                      {savingRecurring ? 'Saving...' : (editingRecurring ? 'Save changes' : 'Add regular cost')}
                    </button>
                    <button
                      onClick={() => { setShowRecurringForm(false); setEditingRecurring(null); }}
                      style={{ ...S.btnGhost, minHeight: 44 }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {recurring.map(rule => {
                  const meta = getCategoryMeta(rule.category);
                  return (
                    <div key={rule.id} style={{ ...S.txRow, opacity: rule.active ? 1 : 0.55 }}>
                      <div style={{ ...S.catBubble, background: meta.color }}>
                        <span><Icon name={meta.icon} size={16} /></span>
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
                          <PrivateText>{describeRecurring(rule)}</PrivateText>
                        </p>
                        <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '2px 0 0' }}>
                          {rule.active
                            ? `next ${prettyDate(rule.next_due_date)}`
                            : 'paused, nothing will be logged'}
                        </p>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                        <button disabled={clientDetailsHidden}
                          onClick={() => handleToggleRecurring(rule)}
                          aria-label={rule.active ? 'Pause this cost' : 'Start this cost again'}
                          style={S.iconBtn}
                        >
                          <Icon name={iconName(rule.active ? 'pause' : 'play_arrow')} size={20} inline style={{ color: 'var(--accent)' }} />
                        </button>
                        <button
                          onClick={() => openRecurringEditor(rule)}
                          aria-label="Edit this cost"
                          style={S.iconBtn}
                        >
                          <Icon name={iconName('edit')} size={18} inline style={{ color: 'var(--text-muted)' }} />
                        </button>
                        <button disabled={clientDetailsHidden}
                          onClick={() => setConfirmDeleteRule(rule)}
                          aria-label="Remove this cost"
                          style={S.iconBtn}
                        >
                          <Icon name={iconName('delete')} size={18} inline style={{ color: 'var(--text-muted)' }} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {expenses.length === 0 && (
              <EmptyState message="No expenses logged. Tap + Add Expense to start tracking." icon="file" />
            )}
            {expenses.length > 0 && (
              <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 2px', textAlign: 'center' }}>
                Press and hold an expense to delete it
              </p>
            )}
            {expenses.map(exp => {
              const catMeta = getCategoryMeta(exp.category);
              return (
                <div
                  key={exp.id}
                  style={{ ...S.txRow, userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}
                  onTouchStart={() => startPress(exp)}
                  onTouchEnd={cancelPress}
                  onTouchMove={cancelPress}
                  onMouseDown={() => startPress(exp)}
                  onMouseUp={cancelPress}
                  onMouseLeave={cancelPress}
                  onContextMenu={e => { e.preventDefault(); cancelPress(); setConfirmDeleteExp(exp); }}
                >
                  <div style={{ ...S.catBubble, background: catMeta.color }}>
                    <span><Icon name={catMeta.icon} size={16} /></span>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}><PrivateText>{exp.vendor || catMeta.label}</PrivateText></p>
                    {exp.description && <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><PrivateText placeholder="Hidden">{exp.description}</PrivateText></p>}
                    <p style={{ fontSize: 10, color: 'var(--text-muted)', margin: '2px 0 0' }}>
                      {new Date(exp.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                      {' · '}{catMeta.label}
                      {exp.hmrc_category && ` · ${HMRC_LABELS[exp.hmrc_category] || exp.hmrc_category}`}
                      {exp.tax_deductible && ' · Tax deductible'}
                    </p>
                  </div>
                  {/* The receipt itself. It lives in the private bucket, so
                      this src is a signed URL minted on read, never a value
                      out of the database. */}
                  {receiptThumbs[exp.id] && (
                    <PrivateText placeholder="Photo hidden"><img
                      src={receiptThumbs[exp.id]}
                      alt={`Receipt for ${exp.vendor || catMeta.label}`}
                      style={{ width: 34, height: 34, borderRadius: 8, objectFit: 'cover', marginLeft: 10, border: '1px solid var(--border-light)', flexShrink: 0 }}
                    /></PrivateText>
                  )}
                  <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--danger)', marginLeft: 12, whiteSpace: 'nowrap' }}>
                    -<PrivateAmount>{fmt(exp.amount_cents)}</PrivateAmount>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ═══ LEDGER TAB ═══ */}
      {tab === 'ledger' && (
        <div>
          {/* Filters. Tax year rather than calendar year, because the year the
              number eventually goes on a form runs 6 April to 5 April. */}
          <div style={S.ledgerFilters}>
            <select
              value={ledgerYear}
              onChange={e => { setLedgerYear(e.target.value); setLedgerPage(1); }}
              style={S.ledgerSelect}
            >
              {(ledger?.tax_years || []).map(y => (
                <option key={y} value={y}>Tax year {y}</option>
              ))}
              <option value="all">Everything</option>
            </select>
            <select
              value={ledgerCategory}
              onChange={e => { setLedgerCategory(e.target.value); if (e.target.value) setLedgerType('expense'); setLedgerPage(1); }}
              style={S.ledgerSelect}
            >
              <option value="">All categories</option>
              {CATEGORIES.map(c => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>

          <div style={S.ledgerTypeBar}>
            {[['all', 'Everything'], ['expense', 'Expenses'], ['income', 'Income']].map(([value, label]) => (
              <button
                key={value}
                onClick={() => { setLedgerType(value); setLedgerPage(1); }}
                disabled={Boolean(ledgerCategory) && value === 'income'}
                style={{ ...S.periodBtn,
                  ...(ledgerType === value ? S.periodBtnActive : {}),
                  minHeight: 44,
                  opacity: ledgerCategory && value === 'income' ? 0.4 : 1,
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {ledgerCategory && (
            <p style={S.ledgerNote}>
              Categories only apply to money going out, so this is expenses on their own.
            </p>
          )}

          {/* The carry-over. This is the number that was never on any screen. */}
          {ledger?.summary && (
            <section style={S.ledgerTotalCard}>
              <span style={S.ledgerTotalLabel}>Recorded net total</span>
              <span style={{ ...S.ledgerTotalValue,
                color: ledger.summary.running_total_cents >= 0 ? 'var(--success)' : 'var(--danger)',
              }}><PrivateAmount>{fmtNeat(ledger.summary.running_total_cents)}</PrivateAmount></span>
              <span style={S.ledgerTotalSub}>
                <PrivateAmount>{fmtNeat(ledger.summary.income_cents)}</PrivateAmount> in, <PrivateAmount>{fmtNeat(ledger.summary.expenses_cents)}</PrivateAmount> out,
                {' '}across {ledger.summary.row_count} {ledger.summary.row_count === 1 ? 'entry' : 'entries'}
              </span>
              {ledger.truncated && (
                <span style={{ ...S.ledgerTotalSub, color: 'var(--danger)' }}>
                  Showing the most recent entries only. Narrow the dates to see the rest.
                </span>
              )}
            </section>
          )}

          {ledgerError && <div role="alert" style={S.formCard}><p>{ledgerError}</p><Button variant="secondary" onClick={() => setLedgerRevision(n => n + 1)}>Try records again</Button></div>}

          {ledgerLoading && !ledger && (
            <p style={S.ledgerNote}>Adding it all up...</p>
          )}

          {ledger && ledger.rows.length === 0 && !ledgerLoading && (
            <EmptyState message="Nothing on the books for that filter yet." icon="file" />
          )}

          {/* Category totals, so "where did it go" is one glance rather than
              mental arithmetic down the list. */}
          {ledger?.summary?.excluded_count > 0 && <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>{ledger.summary.excluded_count} unconfirmed, duplicate or excluded records are shown for review but do not change the running total.</p>}
          {ledger?.summary && Object.keys(ledger.summary.by_category).length > 0 && (
            <section style={S.breakdownCard}>
              <h4 style={S.breakdownTitle}>By category</h4>
              {Object.entries(ledger.summary.by_category)
                .sort(([, a], [, b]) => b.total_cents - a.total_cents)
                .map(([key, bucket]) => (
                  <div key={key} style={S.breakdownRow}>
                    <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                      {bucket.kind === 'expense'
                        ? (CATEGORIES.find(c => c.value === key)?.label || key)
                        : (INCOME_LABELS[key] || key)}
                      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{` · ${bucket.count}`}</span>
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 600,
                      color: bucket.kind === 'expense' ? 'var(--danger)' : 'var(--success)',
                    }}>
                      <PrivateAmount>{fmtNeat(bucket.kind === 'expense' ? -Math.abs(bucket.total_cents) : bucket.total_cents)}</PrivateAmount>
                    </span>
                  </div>
                ))}
            </section>
          )}

          {/* Newest first, each row carrying the total as at that point. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(ledger?.rows || []).map(row => {
              const isExpense = row.kind === 'expense';
              const meta = isExpense ? getCategoryMeta(row.category) : null;
              const label = isExpense
                ? (row.vendor || row.description || meta.label)
                : (row.description || INCOME_LABELS[row.category] || 'Payment');
              // row.assumed: a completion row nobody confirmed. This is the
              // screen she reads at tax time, so it is the last place that
              // should print a guess as though it were a receipt.
              const assumed = !isExpense && row.assumed === true;
              return (
                <div key={`${row.kind}-${row.id}`} style={S.txRow}>
                  <div style={{ ...S.catBubble,
                    background: isExpense ? meta.color : assumed ? '#FDF3E7' : 'rgba(91, 169, 123, 0.15)',
                  }}>
                    <span><Icon name={isExpense ? meta.icon : 'pound'} size={16} /></span>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <PrivateText>{label}</PrivateText>
                    </p>
                    <p style={{ fontSize: 11, color: assumed ? '#8A5A22' : 'var(--text-muted)', margin: 0 }}>
                      {prettyDate(row.date)}
                      {isExpense
                        ? ` · ${meta.label}`
                        : row.reporting_status !== 'received' ? ` · ${row.reporting_status === 'assumed' ? 'Assumed, not confirmed' : row.reporting_status} · excluded from total` : ` · ${INCOME_LABELS[row.category] || row.category}`}
                      {row.recurring_expense_id ? ' · repeats' : ''}
                    </p>
                  </div>
                  <div style={{ textAlign: 'right', marginLeft: 10 }}>
                    <Money
                      pence={row.amount_cents}
                      signed
                      size={15}
                      style={{ display: 'block',
                        color: assumed ? '#8A5A22' : row.amount_cents < 0 ? 'var(--danger)' : 'var(--success)',
                      }}
                    />
                    <span style={{ fontSize: 10, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                      <PrivateAmount>{fmtNeat(row.running_total_cents)}</PrivateAmount>
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {ledger && ledger.total_rows > ledger.page_size && (
            <div style={S.ledgerPager}>
              <button
                onClick={() => setLedgerPage(p => Math.max(1, p - 1))}
                disabled={ledger.page <= 1}
                style={{ ...S.pagerBtn, opacity: ledger.page <= 1 ? 0.4 : 1 }}
              >
                Newer
              </button>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Page {ledger.page} of {Math.max(1, Math.ceil(ledger.total_rows / ledger.page_size))}
              </span>
              <button
                onClick={() => setLedgerPage(p => p + 1)}
                disabled={!ledger.has_more}
                style={{ ...S.pagerBtn, opacity: ledger.has_more ? 1 : 0.4 }}
              >
                Older
              </button>
            </div>
          )}

          <button disabled={clientDetailsHidden || exporting} onClick={handleExportLedgerCSV} style={S.exportBtn}>
            <Icon name={iconName('download')} size={16} inline style={{ marginRight: 6, verticalAlign: 'middle' }} />
            Export {ledgerYear && ledgerYear !== 'all' ? ledgerYear : 'this year'} as CSV
          </button>
        </div>
      )}

      {tab === 'income' && <MoneyPayments key={beautician.id} transactions={transactions} filter={incomeFilter}
        range={incomeRange} timezone={timezone} onClearRange={() => { setIncomeRange(null); setIncomeVisible(100); }}
        onFilter={value => { setIncomeFilter(value); setIncomeVisible(100); }} visible={incomeVisible} onMore={() => setIncomeVisible(n => n + 100)}
        today={moneyDate(new Date(), timezone)}
        onSave={(id, body) => apiFetch(`/api/money/receipts/${id}/confirm`, { method: 'POST', body: JSON.stringify(body) })}
        onPaymentStatus={(id, body) => apiFetch(`/api/money/receipts/${id}/payment-status`, { method: 'POST', body: JSON.stringify(body) })}
        onRecorded={row => { setTransactions(prev => reconcileTransactions(prev.map(t => t.id === row.id ? { ...t, ...row } : t).sort((a,b) => String(b.created_at).localeCompare(String(a.created_at))))); setLedgerRevision(n => n + 1); setReportsAttempt(n => n + 1); setNotice(row.payment_method === 'completion_unpaid' ? 'Marked unpaid. Removed from your income.' : 'Payment recorded. Your totals are up to date.'); }} />}

      {tab === 'tax' && <MoneyTax report={tax} years={taxYears} exporting={exporting} onYear={setTaxYear} onExport={handleExportLedgerCSV} onSettings={() => navigate('/settings?section=profile')} onReview={() => { setIncomeRange(null); setIncomeFilter('review'); setIncomeVisible(100); setTab('income'); }} />}

      {/* Long-press delete confirm sheet. PORTALED to <body>: the page's
          ancestors create a stacking context (backdrop filters etc.), so an
          inline fixed sheet rendered UNDER the floating nav. Portaling +
          zIndex above the nav (100) puts it on top; extra bottom padding
          clears the nav pill; user-select none stops the long-press from
          also triggering iOS text selection. */}
      {confirmDeleteExp && createPortal(
        <div
          onClick={() => setConfirmDeleteExp(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 2000,
            background: 'rgba(29,27,25,0.45)',
            display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
            userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 480, background: 'var(--bg-card, #FFFCF9)',
              borderRadius: '18px 18px 0 0',
              padding: '20px 20px calc(28px + env(safe-area-inset-bottom, 8px))',
            }}
          >
            <p style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 4px' }}>
              Delete this expense?
            </p>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 16px' }}>
              <PrivateText>{confirmDeleteExp.vendor || getCategoryMeta(confirmDeleteExp.category).label}</PrivateText>
              {' · '}-<PrivateAmount>{fmt(confirmDeleteExp.amount_cents)}</PrivateAmount>
              {' · '}{new Date(confirmDeleteExp.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
            </p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={handleDeleteExpense}
                disabled={clientDetailsHidden || (deleting)}
                style={{ flex: 1, padding: '13px 0', borderRadius: 10, border: 'none',
                  background: 'var(--danger, #9E2B32)', color: '#fff',
                  fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                  opacity: deleting ? 0.6 : 1,
                }}
              >
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
              <button
                onClick={() => setConfirmDeleteExp(null)}
                style={{ flex: 1, padding: '13px 0', borderRadius: 10,
                  border: '1.5px solid var(--border, #E8DDD4)', background: 'var(--bg-card, #FFFCF9)',
                  color: 'var(--text-primary)', fontSize: 14, fontWeight: 600,
                  cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                Keep it
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Removing a regular cost stops the schedule and nothing else. Says so,
          because "delete" next to money reads as "erase the history". */}
      {confirmDeleteRule && createPortal(
        <div
          onClick={() => setConfirmDeleteRule(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 2000,
            background: 'rgba(29,27,25,0.45)',
            display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 480, background: 'var(--bg-card, #FFFCF9)',
              borderRadius: '18px 18px 0 0',
              padding: '20px 20px calc(28px + env(safe-area-inset-bottom, 8px))',
            }}
          >
            <p style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 4px' }}>
              Remove this regular cost?
            </p>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 16px' }}>
              <PrivateText>{describeRecurring(confirmDeleteRule)}</PrivateText>. It will stop being logged from now on.
              Everything already on the books stays exactly as it is.
            </p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button disabled={clientDetailsHidden}
                onClick={handleDeleteRecurring}
                style={{ flex: 1, padding: '13px 0', borderRadius: 10, border: 'none',
                  background: 'var(--danger, #9E2B32)', color: '#fff',
                  fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                  minHeight: 44,
                }}
              >
                Remove
              </button>
              <button
                onClick={() => setConfirmDeleteRule(null)}
                style={{ flex: 1, padding: '13px 0', borderRadius: 10,
                  border: '1.5px solid var(--border, #E8DDD4)', background: 'var(--bg-card, #FFFCF9)',
                  color: 'var(--text-primary)', fontSize: 14, fontWeight: 600,
                  cursor: 'pointer', fontFamily: 'inherit', minHeight: 44,
                }}
              >
                Keep it
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

const S = {
  page: {
    minHeight: 'var(--shell-viewport)',
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
    background: 'var(--tone-2, #f6e7dd)', borderRadius: 16, padding: 4,
    marginBottom: 20,
  },
  tab: {
    flex: 1, padding: '9px 0', fontSize: 13, fontWeight: 500,
    border: 'none', borderRadius: 10, cursor: 'pointer',
    fontFamily: 'inherit', background: 'none', color: 'var(--text-muted)',
    transition: 'all 0.2s ease',
  },
  tabActive: {
    background: 'var(--bg-elevated)', color: 'var(--text-primary)',
    fontWeight: 600,
  },

  // Period selector
  reportsCard: {
    background: 'var(--tone-1, #fbf1ea)', borderRadius: 22, padding: '18px 16px', marginBottom: 16,
  },
  reportsTitle: {
    // Was #b08a98, which is 2.72:1 on this card's own #fbf1ea — a heading at
    // just over half the 4.5 AA needs. Nothing had ever measured it: the
    // /api/money/reports fixture was the wrong shape, so this whole card threw
    // and check-live graded the ErrorBoundary instead. Same plum as ytdTitle
    // right above it, which is the card title this one is a sibling of.
    fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
    color: '#92405e', marginBottom: 14,
  },
  reportsRow: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 },
  reportStat: { display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 },
  reportValue: { fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums', fontFamily: '"Plus Jakarta Sans", -apple-system, sans-serif' },
  reportLabel: { fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  reportInsight: {
    marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border-light)',
    fontSize: 13.5, lineHeight: 1.5, color: 'var(--text-secondary)',
  },
  periodBar: {
    display: 'flex', gap: 8, marginBottom: 16,
  },
  periodBtn: {
    padding: '7px 15px', borderRadius: 22,
    border: 'none', background: 'var(--tone-2, #f6e7dd)',
    fontSize: 12, fontWeight: 500, color: 'var(--text-muted)',
    cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s ease',
  },
  periodBtnActive: {
    background: 'var(--accent)', color: '#fff',
    border: 'none',
  },

  // Hero revenue card
  heroCard: {
    position: 'relative', overflow: 'hidden',
    background: 'var(--gradient-hero)',
    color: '#fff', borderRadius: 22, padding: 24, marginBottom: 16,
    boxShadow: 'var(--elev-3)',
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
    fontFamily: '"Plus Jakarta Sans", -apple-system, sans-serif',
    fontSize: 44, fontStyle: 'normal', fontWeight: 700,
    lineHeight: 1.05, margin: '0 0 8px', letterSpacing: '-0.03em',
    fontVariantNumeric: 'tabular-nums',
    fontFeatureSettings: '"tnum" 1, "lnum" 1',
  },
  changeBadge: {
    display: 'inline-block', padding: '3px 10px', borderRadius: 10,
    fontSize: 11, fontWeight: 600,
  },

  // Chart card
  chartCard: {
    background: 'var(--tone-1, #fbf1ea)', borderRadius: 22, padding: 16,
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
    background: 'var(--tone-1, #fbf1ea)', borderRadius: 22, padding: 16, marginBottom: 16,
    animation: 'fadeIn 0.2s ease',
  },

  // Quick stats row
  quickStats: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-around',
    background: 'var(--tone-1, #fbf1ea)', borderRadius: 22, padding: '14px 8px',
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
    background: 'var(--tone-1, #fbf1ea)', padding: 14, borderRadius: 16,
    display: 'flex', alignItems: 'center', gap: 12,
  },
  txAvatar: {
    width: 36, height: 36, borderRadius: 10,
    background: 'linear-gradient(135deg, #ffd9e2 0%, #ffb1c8 100%)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 14, fontWeight: 700, color: '#76344c', flexShrink: 0,
  },
  catBubble: {
    width: 36, height: 36, borderRadius: 10,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },

  // Comparison card
  compCard: {
    background: 'var(--tone-1, #fbf1ea)', borderRadius: 22, padding: 16,
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
    background: 'var(--tone-1, #fbf1ea)', borderRadius: 22, padding: 16,
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
    background: 'var(--tone-1, #fbf1ea)', borderRadius: 22, padding: 16, marginBottom: 12,
  },
  breakdownTitle: { fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 12px' },
  breakdownRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '8px 0', borderBottom: '1px solid rgba(146, 64, 94, 0.04)',
  },

  // Buttons
  btnPrimary: {
    flex: 1, padding: '11px 0', borderRadius: 10,
    border: 'none', background: 'var(--accent)', color: '#fff',
    fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxShadow: 'var(--elev-2)',
  },
  btnSecondary: {
    flex: 1, padding: '11px 0', borderRadius: 10,
    border: '1.5px solid var(--border)', background: 'var(--bg-card)',
    color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  btnGhost: {
    padding: '11px 16px', borderRadius: 10, border: 'none',
    background: 'var(--bg-hover)', color: 'var(--text-secondary)', fontSize: 13,
    cursor: 'pointer', fontFamily: 'inherit',
  },

  noticeBar: {
    display: 'flex', alignItems: 'center', gap: 8,
    background: 'var(--warning-bg, #F7EEDD)', color: 'var(--text-primary)',
    borderRadius: 10, padding: '10px 12px', marginBottom: 12,
    fontSize: 12.5, lineHeight: 1.45,
  },
  noticeClose: {
    width: 44, height: 44, marginRight: -10, border: 'none', background: 'none',
    color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'inherit',
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },

  // Year to date (UK tax year)
  ytdCard: {
    background: 'var(--tone-1, #fbf1ea)', borderRadius: 22, padding: '16px 16px 14px',
    marginBottom: 14,
  },
  ytdHead: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
    gap: 8, marginBottom: 12, flexWrap: 'wrap',
  },
  ytdTitle: {
    fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: '0.06em', color: '#92405e',
  },
  ytdDates: { fontSize: 11, color: 'var(--text-muted)' },
  // Stacked rows, not three side-by-side columns — see the comment above the
  // JSX that renders these. Each row pins its own label to the left and its
  // own value to the right, so the label-figure pairing is unambiguous no
  // matter how wide any one figure gets, and no figure ever shares a column
  // with another figure.
  ytdRow: { display: 'flex', flexDirection: 'column', gap: 8 },
  ytdStat: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
    gap: 12, minWidth: 0,
  },
  ytdLabel: {
    fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em',
    color: 'var(--text-muted)', fontWeight: 600, flexShrink: 0,
  },
  ytdValue: {
    fontFamily: '"Plus Jakarta Sans", -apple-system, sans-serif',
    fontSize: 22, fontWeight: 700, color: 'var(--text-primary)',
    fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.01em',
    textAlign: 'right', whiteSpace: 'nowrap', minWidth: 0,
  },
  ytdCompare: {
    marginTop: 12, paddingTop: 10, borderTop: '1px solid rgba(146, 64, 94, 0.08)',
    display: 'flex', flexDirection: 'column', gap: 2,
    fontSize: 11.5, color: 'var(--text-muted)',
  },

  // Ledger
  ledgerFilters: { display: 'flex', gap: 8, marginBottom: 10 },
  ledgerSelect: {
    flex: 1, minWidth: 0, minHeight: 44, padding: '10px 12px', borderRadius: 10,
    border: '1.5px solid var(--border)', background: 'var(--bg-input)',
    color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit',
  },
  ledgerTypeBar: { display: 'flex', gap: 8, marginBottom: 12 },
  ledgerNote: {
    fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5,
    margin: '0 0 12px',
  },
  ledgerTotalCard: {
    background: 'var(--tone-1, #fbf1ea)', borderRadius: 22, padding: 16,
    marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 2,
  },
  ledgerTotalLabel: {
    fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em',
    color: 'var(--text-muted)', fontWeight: 700,
  },
  ledgerTotalValue: {
    fontSize: 28, fontWeight: 800, letterSpacing: '-0.02em',
    fontVariantNumeric: 'tabular-nums', fontFamily: '"Plus Jakarta Sans", -apple-system, sans-serif' },
  ledgerTotalSub: { fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.45 },
  ledgerPager: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 10, margin: '14px 0',
  },
  pagerBtn: {
    minHeight: 44, padding: '11px 18px', borderRadius: 10,
    border: '1.5px solid var(--border)', background: 'var(--bg-card)',
    color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  exportBtn: {
    width: '100%', minHeight: 44, padding: '14px 0', borderRadius: 10,
    border: 'none', background: 'var(--accent)', color: '#fff',
    fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
    marginTop: 8,
  },

  // Regular costs
  addRuleBtn: {
    minHeight: 44, padding: '10px 16px', borderRadius: 10,
    border: '1.5px solid var(--border)', background: 'var(--bg-card)',
    color: 'var(--accent)', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  iconBtn: {
    width: 44, height: 44, borderRadius: 10, border: 'none',
    background: 'transparent', cursor: 'pointer', fontFamily: 'inherit',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  chip: {
    flex: 1, minHeight: 44, padding: '10px 12px', borderRadius: 10,
    border: '1.5px solid var(--border-light)', background: 'var(--bg-card)',
    color: 'var(--text-secondary)', fontSize: 13, fontWeight: 500,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  chipActive: {
    border: '1.5px solid var(--accent)', background: 'var(--accent-bg)',
    color: 'var(--accent)', fontWeight: 600,
  },
  repeatBox: {
    background: 'var(--bg-card)', border: '1.5px solid var(--border-light)',
    borderRadius: 16, padding: 12, marginBottom: 14,
  },
  repeatToggle: {
    display: 'flex', alignItems: 'center', minHeight: 44,
    fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer',
  },
  repeatHint: {
    fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5,
    margin: '10px 0 0',
  },

  // Form
  formCard: {
    background: 'var(--tone-1, #fbf1ea)', borderRadius: 22, padding: 16, marginBottom: 16,
  },
  formLabel: {
    display: 'block', fontSize: 12, fontWeight: 600,
    color: 'var(--text-secondary)', marginBottom: 6, letterSpacing: '0.01em',
  },
  formInput: {
    width: '100%', padding: '11px 14px', borderRadius: 10,
    border: '1.5px solid var(--border)', fontSize: 14,
    fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
    background: 'var(--bg-input)', color: 'var(--text-primary)',
    transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
  },
};
