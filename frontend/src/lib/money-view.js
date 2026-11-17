export const formatMoney = cents => `${cents < 0 ? '-' : ''}£${(Math.abs(cents) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export function parseMoneyInput(value) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(String(value).trim())) throw new Error('Enter a positive amount with up to two decimal places.');
  const cents = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > 100000000) throw new Error('Enter an amount between £0.01 and £1,000,000.');
  return cents;
}
