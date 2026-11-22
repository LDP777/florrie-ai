import { INCOME_TYPES, isAssumedTakingsRow } from './money-guards.js';

// Pure reporting rules shared by the app, API and accountant export. Never
// mutate the ledger or infer a cash payment from an appointment finishing.
export const sumMoney = rows => rows.reduce((sum, r) => sum + (Number(r.amount_cents) || 0), 0);
const formatters = new Map();
export function moneyDate(value, timeZone = 'Europe/London') {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '';
  if (!formatters.has(timeZone)) formatters.set(timeZone, new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }));
  const p = formatters.get(timeZone).formatToParts(d);
  const get = type => p.find(x => x.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function shiftDate(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function reportingYear(today = moneyDate(new Date())) {
  const year = Number(today.slice(0, 4)) - (today.slice(5) < '04-06' ? 1 : 0);
  return `${year}-${String(year + 1).slice(2)}`;
}
export function reportingBounds(year) {
  const match = /^(\d{4})[-/](\d{2}|\d{4})$/.exec(String(year));
  if (!match || Number(match[2]) !== (match[2].length === 2 ? (Number(match[1]) + 1) % 100 : Number(match[1]) + 1)) throw new Error('Invalid tax year');
  const y = Number(match[1]);
  return { start: `${y}-04-06`, end: `${y + 1}-04-05`, taxYear: `${y}-${String(y + 1).slice(2)}` };
}
export function reconcileTransactions(input = [], now = new Date()) {
  const rows = input.map(r => ({ ...r, reporting_status: 'excluded' }));
  const positiveIntents = new Map();
  for (const row of rows) {
    if (row.payment_method === 'completion_unpaid' && row.status === 'pending' && !row.stripe_payment_intent_id) {
      row.reporting_status = 'unpaid'; continue;
    }
    if (row.status !== 'completed' || !INCOME_TYPES.includes(row.type) || !Number.isSafeInteger(Number(row.amount_cents)) || !row.created_at || new Date(row.created_at) > now) continue;
    if (isAssumedTakingsRow(row)) { row.reporting_status = 'assumed'; continue; }
    row.reporting_status = 'received';
    // Refunds can be several partial refunds, or a signed dispute reversal.
    // Never collapse them just because they share the original payment intent.
    if (row.type !== 'refund' && row.amount_cents > 0 && row.stripe_payment_intent_id) {
      const key = row.stripe_payment_intent_id;
      if (!positiveIntents.has(key)) positiveIntents.set(key, []);
      positiveIntents.get(key).push(row);
    }
  }
  for (const group of positiveIntents.values()) {
    if (group.length < 2) continue;
    const amounts = new Set(group.map(r => Number(r.amount_cents)));
    const bookings = new Set(group.map(r => r.appointment_id).filter(Boolean));
    if (amounts.size > 1 || bookings.size > 1) {
      group.forEach(r => { r.reporting_status = 'review'; });
      continue;
    }
    group.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
    group.slice(1).forEach(r => { r.reporting_status = 'duplicate'; });
  }
  return rows;
}
export function reportableTransactions(rows, now) {
  // A filtered view must retain reconciliation against the complete history.
  return rows.every(r => r.reporting_status) ? rows : reconcileTransactions(rows, now);
}
export function moneyTotals({ transactions = [], expenses = [], start, end, timezone = 'Europe/London', now = new Date() } = {}) {
  const today = moneyDate(now, timezone);
  const within = d => d && (!start || d >= start) && d <= (end && end < today ? end : today);
  const tx = reportableTransactions(transactions, now).filter(r => within(moneyDate(r.created_at, timezone)));
  const received = tx.filter(r => r.reporting_status === 'received');
  const assumed = tx.filter(r => r.reporting_status === 'assumed');
  const duplicates = tx.filter(r => r.reporting_status === 'duplicate');
  const review = tx.filter(r => r.reporting_status === 'review');
  const costs = expenses.filter(e => within(e.date));
  const income = sumMoney(received);
  const expense = costs.reduce((s, e) => s + Math.abs(Number(e.amount_cents) || 0), 0);
  return {
    income_cents: income, expenses_cents: expense, profit_cents: income - expense,
    assumed_cents: sumMoney(assumed), assumed_count: assumed.length,
    duplicate_cents: sumMoney(duplicates), duplicate_count: duplicates.length,
    review_cents: sumMoney(review), review_count: review.length,
    transaction_count: received.length, expense_count: costs.length,
  };
}

// HMRC 2025/26 and 2026/27, England/Wales/NI, no other income or reliefs.
// gov.uk/income-tax-rates and gov.uk/self-employed-national-insurance-rates
// This is an illustration on recorded profit, never the person's actual bill.
export function soleTraderIllustration(profitCents, year) {
  if (!['2025-26', '2026-27'].includes(year)) return null;
  const profit = Math.max(0, profitCents / 100);
  const allowance = Math.max(0, 12570 - Math.max(0, profit - 100000) / 2);
  const taxable = Math.max(0, profit - allowance);
  const basic = Math.min(taxable, 37700);
  const higher = Math.min(Math.max(0, taxable - basic), 125140 - allowance - 37700);
  const incomeTax = Math.round((basic * .20 + higher * .40 + Math.max(0, taxable - basic - higher) * .45) * 100);
  const niClass4 = Math.round((Math.max(0, Math.min(profit, 50270) - 12570) * .06 + Math.max(0, profit - 50270) * .02) * 100);
  return { incomeTax, niClass2: 0, niClass4, total: incomeTax + niClass4 };
}
export function taxReport({ transactions = [], expenses = [], beautician = {}, now = new Date(), year } = {}) {
  const timezone = beautician.timezone || 'Europe/London';
  const today = moneyDate(now, timezone);
  const bounds = reportingBounds(year || reportingYear(today));
  const tx = reportableTransactions(transactions, now);
  const deductible = expenses.filter(e => e.tax_deductible === true);
  const totals = moneyTotals({ transactions: tx, expenses: deductible, ...bounds, timezone, now });
  const byCategory = {}, byHmrc = {}, monthly = {};
  for (const e of deductible.filter(e => e.date >= bounds.start && e.date <= bounds.end && e.date <= today)) {
    for (const [map, key] of [[byCategory, e.category || 'other'], [byHmrc, e.hmrc_category || 'other_expenses']]) {
      const bucket = map[key] ||= { total_cents: 0, count: 0 };
      bucket.total_cents += Math.abs(Number(e.amount_cents) || 0); bucket.count++;
    }
  }
  for (const r of tx.filter(r => r.reporting_status === 'received')) {
    const date = moneyDate(r.created_at, timezone);
    if (date >= bounds.start && date <= bounds.end && date <= today) monthly[date.slice(0, 7)] = (monthly[date.slice(0, 7)] || 0) + Number(r.amount_cents);
  }
  const businessType = beautician.business_type || 'sole_trader';
  const illustration = businessType === 'sole_trader' && !beautician.vat_registered ? soleTraderIllustration(totals.profit_cents, bounds.taxYear) : null;
  const rollingDate = new Date(`${today}T12:00:00Z`); rollingDate.setUTCFullYear(rollingDate.getUTCFullYear() - 1);
  const rolling = moneyTotals({ transactions: tx, start: rollingDate.toISOString().slice(0, 10), end: today, timezone, now });
  return {
    taxYear: bounds.taxYear, period: { start: bounds.start, end: bounds.end }, asAt: today < bounds.end ? today : bounds.end,
    totalIncome: totals.income_cents, totalExpenses: totals.expenses_cents, taxableProfit: totals.profit_cents,
    transactionCount: totals.transaction_count, expenseCount: totals.expense_count,
    assumedIncome: totals.assumed_cents, assumedCount: totals.assumed_count,
    duplicateIncome: totals.duplicate_cents, duplicateCount: totals.duplicate_count,
    reviewIncome: totals.review_cents, reviewCount: totals.review_count,
    expensesByCategory: byCategory, expensesByHmrc: byHmrc, monthlyIncome: monthly, businessType,
    illustration, incomeTax: illustration?.incomeTax ?? null, niClass2: illustration?.niClass2 ?? null, niClass4: illustration?.niClass4 ?? null,
    // Never manufacture a personal bill, quarterly saving target or VAT return.
    totalTaxLiability: null, quarterlySetAside: null, deadlines: [],
    yearProgress: Math.max(0, Math.min(1, (new Date(today) - new Date(bounds.start)) / (new Date(shiftDate(bounds.end, 1)) - new Date(bounds.start)))),
    vat: { rolling12Revenue: rolling.income_cents, unconfirmedRevenue: rolling.assumed_cents, vatThreshold: 9000000, vatPct: Math.min(100, Math.max(0, Math.round(rolling.income_cents / 90000))), registered: !!beautician.vat_registered, vatNumber: beautician.vat_number },
  };
}
export function periodWindow(period, today) {
  const day = new Date(`${today}T12:00:00Z`).getUTCDay();
  const start = period === 'today' ? today : period === 'month' ? `${today.slice(0, 7)}-01` : shiftDate(today, -((day + 6) % 7));
  let previousStart, previousEnd;
  if (period === 'month') {
    previousEnd = shiftDate(start, -1); previousStart = `${previousEnd.slice(0, 7)}-01`;
    previousEnd = `${previousStart.slice(0, 8)}${String(Math.min(Number(today.slice(8)), Number(previousEnd.slice(8)))).padStart(2, '0')}`;
  } else {
    const shift = period === 'today' ? -1 : -7;
    previousStart = shiftDate(start, shift); previousEnd = shiftDate(today, shift);
  }
  return { start, end: today, previousStart, previousEnd };
}
