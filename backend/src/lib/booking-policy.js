/** A saved zero disables the notice window; absent or invalid values use 48h. */
export function cancellationNoticeHours(policy = {}) {
  const value = policy?.cancellation_notice_hours;
  if (value == null || !['number', 'string'].includes(typeof value)
      || (typeof value === 'string' && !value.trim())) return 48;
  const hours = Number(value);
  return Number.isFinite(hours) && hours >= 0 ? hours : 48;
}

/** Exactly on the boundary is outside; a disabled window is never late. */
export function isWithinCancellationWindow(hoursUntil, policy = {}) {
  const notice = cancellationNoticeHours(policy);
  return notice > 0 && Number.isFinite(hoursUntil) && hoursUntil < notice;
}
