export const formatMoney = cents => `${cents < 0 ? '-' : ''}£${(Math.abs(cents) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function latestPayments(transactions, limit = 5) {
  return transactions.filter(t => t.reporting_status === 'received' && Number.isFinite(Date.parse(t.created_at)))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || String(a.id).localeCompare(String(b.id))).slice(0, limit);
}

export function paymentDateLabel(value, timezone = 'Europe/London') {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: timezone }).format(date);
}
export function parseMoneyInput(value) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(String(value).trim())) throw new Error('Enter a positive amount with up to two decimal places.');
  const cents = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > 100000000) throw new Error('Enter an amount between £0.01 and £1,000,000.');
  return cents;
}
