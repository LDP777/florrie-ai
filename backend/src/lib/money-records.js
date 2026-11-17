import { readAllMoney } from './read-all-money.js';
import { moneyDate, reconcileTransactions } from './money-reporting.js';

export async function loadMoneyRecords(db, beautician, now = new Date()) {
  const [transactions, expenses] = await Promise.all([
    readAllMoney(() => db.from('transactions').select('id, appointment_id, amount_cents, type, status, description, created_at, payment_method, stripe_payment_intent_id', { count: 'exact' })
      .eq('beautician_id', beautician.id).lte('created_at', now.toISOString()).order('created_at').order('id')),
    readAllMoney(() => db.from('expenses').select('id, amount_cents, vendor, description, category, date, tax_deductible, recurring_expense_id, created_at', { count: 'exact' })
      .eq('beautician_id', beautician.id).lte('date', moneyDate(now, beautician.timezone || 'Europe/London')).order('date').order('id')),
  ]);
  return { transactions: reconcileTransactions(transactions, now), expenses, now };
}
