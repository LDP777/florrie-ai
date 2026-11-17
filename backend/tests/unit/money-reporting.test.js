import { describe, it, expect } from 'vitest';
import { reconcileTransactions, moneyTotals, moneyDate, reportingYear, taxReport, soleTraderIllustration, periodWindow, reportingBounds } from '../../src/lib/money-reporting.js';
import { readAllMoney } from '../../src/lib/read-all-money.js';
import { moneyTaxCSV } from '../../src/lib/money-export.js';
import { buildLedger } from '../../src/lib/ledger.js';
const now = new Date('2026-11-17T12:00:00Z');
const tx = (id, amount, extra = {}) => ({ id, status: 'completed', type: 'payment', payment_method: 'cash', amount_cents: amount, created_at: '2026-08-01T12:00:00Z', ...extra });

describe('complete money histories', () => {
  it('reads beyond both the old 200 rows and PostgREST 1000 default, even if the server caps individual pages', async () => {
    const rows = Array.from({ length: 1143 }, (_, i) => tx(String(i), 100));
    const result = await readAllMoney(() => ({ range: async (from, to) => ({ data: rows.slice(from, Math.min(to + 1, from + 200)), count: rows.length }) }));
    expect(result).toHaveLength(1143);
    expect(moneyTotals({ transactions: result, now }).income_cents).toBe(114300);
  });
  it('fails instead of reporting a partial total on page errors, truncation or concurrent changes', async () => {
    let calls = 0;
    await expect(readAllMoney(() => ({ range: async () => ++calls === 1 ? { data: [tx('a', 100)], count: 2 } : { error: new Error('offline') } }))).rejects.toThrow('offline');
    await expect(readAllMoney(() => ({ range: async () => ({ data: [], count: 20 }) }))).rejects.toThrow('incomplete');
    await expect(readAllMoney(() => ({ range: async () => ({ data: [tx('a', 100)], count: 2 }) }))).rejects.toThrow('changed');
    calls = 0;
    await expect(readAllMoney(() => ({ range: async () => ({ data: [tx(String(++calls), 100)], count: calls + 1 }) }))).rejects.toThrow('changed');
  });
});
describe('reconciliation and cross-surface arithmetic', () => {
  const transactions = [
    tx('deposit', 1000, { type: 'deposit', stripe_payment_intent_id: 'pi_d' }),
    tx('repeat', 1000, { type: 'deposit', stripe_payment_intent_id: 'pi_d', created_at: '2026-08-02T12:00:00Z' }),
    tx('assumed', 4000, { payment_method: null }),
    tx('balance', 4000, { stripe_payment_intent_id: 'pi_b' }),
    tx('refund1', -500, { type: 'refund', stripe_payment_intent_id: 'pi_b' }),
    tx('refund2', -200, { type: 'refund', stripe_payment_intent_id: 'pi_b' }),
    tx('dispute-won', 100, { type: 'refund', stripe_payment_intent_id: 'pi_b' }),
    tx('pending', 99999, { status: 'pending' }), tx('failed', 99999, { status: 'failed' }),
    tx('future', 99999, { created_at: '2027-01-01T12:00:00Z' }),
  ];
  const expenses = [{ id: 'e', amount_cents: 600, date: '2026-08-01', tax_deductible: true, category: 'products' }];
  it('counts payment evidence once, preserves partial refunds and does not count guesses', () => {
    const rows = reconcileTransactions(transactions, now);
    const totals = moneyTotals({ transactions: rows, expenses, now });
    expect(totals).toMatchObject({ income_cents: 4400, assumed_cents: 4000, duplicate_cents: 1000, transaction_count: 5, profit_cents: 3800 });
    const ledger = buildLedger({ transactions: rows, expenses });
    const tax = taxReport({ transactions: rows, expenses, now });
    expect(ledger.summary.income_cents).toBe(4400);
    expect(ledger.summary.net_cents).toBe(3800);
    expect(tax.totalIncome).toBe(4400);
    expect(tax.taxableProfit).toBe(3800);
    expect(tax.monthlyIncome['2026-08']).toBe(4400);
    const csv = moneyTaxCSV({ transactions: rows, expenses, now });
    expect(csv).toContain('Recorded receipts after refunds,44.00');
    expect(csv).toContain('Assumed takings excluded,40.00,1');
    expect(csv).toContain('Duplicate payment records excluded,10.00,1');
    expect(ledger.rows.find(r => r.id === 'repeat').running_total_cents).toBe(3800);
  });
  it('deduplicates before filtering windows and does not deduplicate cash or distinct partial refunds', () => {
    const rows = reconcileTransactions(transactions, now);
    expect(moneyTotals({ transactions: rows, start: '2026-08-02', end: '2026-08-02', now }).income_cents).toBe(0);
    expect(moneyTotals({ transactions: [tx('cash1', 500), tx('cash2', 500)], now }).income_cents).toBe(1000);
  });
  it('quarantines conflicting amounts or booking IDs instead of guessing which is right', () => {
    const rows = [tx('a', 500, { stripe_payment_intent_id: 'pi' }), tx('b', 900, { stripe_payment_intent_id: 'pi' })];
    expect(moneyTotals({ transactions: rows, now })).toMatchObject({ income_cents: 0, review_count: 2, review_cents: 1400 });
  });
  it('excludes unknown statuses and transaction types, and future expenses', () => {
    expect(moneyTotals({ transactions: [tx('x', 500, { status: null }), tx('y', 500, { type: 'unknown' })], expenses: [{ date: '2026-12-01', amount_cents: 900 }], now })).toMatchObject({ income_cents: 0, expenses_cents: 0 });
  });
});
describe('calendar periods and tax assumptions', () => {
  it('uses UK calendar dates for real payment instants around BST and April 6', () => {
    expect(moneyDate('2026-04-05T23:30:00Z')).toBe('2026-04-06');
    expect(reportingYear('2026-04-05')).toBe('2025-26');
    expect(reportingYear('2026-04-06')).toBe('2026-27');
    const rows = [tx('before', 100, { created_at: '2026-04-05T22:59:59Z' }), tx('after', 200, { created_at: '2026-04-05T23:00:00Z' })];
    expect(taxReport({ transactions: rows, now }).totalIncome).toBe(200);
    expect(taxReport({ transactions: rows, now, year: '2025-26' }).totalIncome).toBe(100);
    expect(() => reportingBounds('2026-99')).toThrow('Invalid');
  });
  it('compares weeks and months through the same calendar day and clamps short months', () => {
    expect(periodWindow('month', '2026-03-31')).toEqual({ start: '2026-03-01', end: '2026-03-31', previousStart: '2026-02-01', previousEnd: '2026-02-28' });
    expect(periodWindow('week', '2026-11-17').previousEnd).toBe('2026-11-10');
  });
  it('does not charge compulsory Class 2, applies allowance taper and additional rate, and never taxes losses', () => {
    expect(soleTraderIllustration(-10000, '2026-27')).toEqual({ incomeTax: 0, niClass2: 0, niClass4: 0, total: 0 });
    expect(soleTraderIllustration(5027000, '2026-27')).toMatchObject({ incomeTax: 754000, niClass2: 0, niClass4: 226200 });
    expect(soleTraderIllustration(12514000, '2026-27').incomeTax).toBe(4251600);
    expect(soleTraderIllustration(15000000, '2026-27').incomeTax).toBe(5370300);
    expect(soleTraderIllustration(5000000, '2027-28')).toBeNull();
  });
  it('never invents a bill, quarterly payment, VAT return or director salary', () => {
    const report = taxReport({ transactions: [tx('a', 9000000)], beautician: { business_type: 'limited_co', vat_registered: true }, now });
    expect(report.illustration).toBeNull();
    expect(report.totalTaxLiability).toBeNull();
    expect(report.quarterlySetAside).toBeNull();
  });
});
