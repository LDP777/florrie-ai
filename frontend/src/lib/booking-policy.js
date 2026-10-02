// Display the same effective values used by the booking/payment routes.
export function cancellationNoticeHours(policy = {}) {
  const value = policy?.cancellation_notice_hours;
  if (value == null || (typeof value === 'string' && value.trim() === '') || !['number', 'string'].includes(typeof value)) return 48;
  const hours = Number(value);
  return Number.isFinite(hours) && hours >= 0 ? hours : 48;
}

export function policyFeePercent(policy = {}, kind = 'late_cancel') {
  const value = kind === 'no_show'
    ? policy?.no_show_charge_percent ?? policy?.late_cancel_charge_percent
    : policy?.late_cancel_charge_percent;
  const percent = Number(value) || 0;
  return Math.max(0, Math.min(100, percent));
}
