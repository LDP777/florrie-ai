import { moneyDate, taxReport } from './money-reporting.js';
const field = value => {
  let s = String(value ?? '');
  if (/^[=+@\t\r]/.test(s) || (s.startsWith('-') && !/^-\d+(?:\.\d+)?$/.test(s))) s = `'${s}`;
  return /[,"\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
export function moneyTaxCSV(input) {
  const t = taxReport(input), lines = [];
  const row = (...values) => lines.push(values.map(field).join(','));
  const pounds = value => (value / 100).toFixed(2);
  row('FLORRIE.AI: RECORDED MONEY EXPORT');
  row('Tax year', t.taxYear); row('Period', t.period.start, t.period.end); row('As at', t.asAt);
  row('Basis', 'Completed recorded receipts less refunds; duplicates and assumed takings excluded. Gross of processing fees unless entered as expenses.');
  row('Recorded receipts after refunds', pounds(t.totalIncome));
  row('Logged deductible expenses', pounds(t.totalExpenses));
  row('Receipts less logged deductible expenses', pounds(t.taxableProfit));
  row('Assumed takings excluded', pounds(t.assumedIncome), t.assumedCount);
  row('Duplicate payment records excluded', pounds(t.duplicateIncome), t.duplicateCount);
  row('Conflicting records excluded pending review', pounds(t.reviewIncome), t.reviewCount);
  row('Tax bill', 'Not calculated. Other income, tax region, reliefs, missing receipts and costs must be checked.');
  if (t.illustration) {
    row(); row('ILLUSTRATION ONLY', 'England/Wales/Northern Ireland; no other income or reliefs; full personal allowance before taper; recorded profit only; not a forecast or payment on account.');
    row('Income Tax illustration', pounds(t.illustration.incomeTax));
    row('Compulsory Class 2 NI', '0.00'); row('Class 4 NI illustration', pounds(t.illustration.niClass4));
    row('Illustration total', pounds(t.illustration.total));
  }
  row(); row('RECORDED RECEIPTS BY MONTH'); row('Month', 'GBP');
  Object.entries(t.monthlyIncome).sort(([a], [b]) => a.localeCompare(b)).forEach(([month, cents]) => row(month, pounds(cents)));
  row(); row('TRANSACTION DETAIL'); row('Date', 'Type', 'GBP', 'Reporting treatment', 'Record ID');
  const timezone = input.beautician?.timezone || 'Europe/London';
  for (const tx of input.transactions) {
    const date = moneyDate(tx.created_at, timezone);
    if (date >= t.period.start && date <= t.asAt) row(date, tx.type, pounds(tx.amount_cents), tx.reporting_status, tx.id);
  }
  row(); row('EXPENSE DETAIL'); row('Date', 'Vendor', 'Description', 'Category', 'GBP', 'Tax deductible');
  for (const e of input.expenses) if (e.date >= t.period.start && e.date <= t.asAt) row(e.date, e.vendor, e.description, e.category, pounds(Math.abs(e.amount_cents)), e.tax_deductible === true ? 'Yes' : 'No');
  row(); row('Review with your accountant before filing. This export does not assert that all bank, cash or expense records are present.');
  return lines.join('\n');
}
