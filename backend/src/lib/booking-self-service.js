import { salonWallInstant } from './booking-preparation.js';
import { cancellationNoticeHours } from './booking-policy.js';

export function bookingChangeAccess(appointment, now = Date.now()) {
  const policy = appointment.policy_snapshot || appointment.beauticians?.booking_policy || {};
  const noticeHours = cancellationNoticeHours(policy);
  const startsAt = salonWallInstant(appointment.starts_at, appointment.beauticians?.timezone || 'Europe/London');
  const start = Date.parse(startsAt || '');
  const deadline = start - noticeHours * 3600000;
  const hoursUntil = (start - now) / 3600000;
  const withinNotice = Number.isFinite(start) && noticeHours > 0 && now > deadline;
  const active = ['confirmed', 'pending'].includes(appointment.status);
  const alreadyMoved = appointment.beauticians?.booking_policy?.reschedule_once === true && !!appointment.rescheduled_at;
  return {
    cancellationNoticeHours: noticeHours,
    hoursUntil,
    withinCancellationWindow: withinNotice,
    canReschedule: active && Number.isFinite(start) && now < start && !withinNotice && !alreadyMoved,
    rescheduleDeadline: Number.isFinite(deadline) ? new Date(deadline).toISOString() : null,
    reason: !active ? 'inactive' : !Number.isFinite(start) ? 'invalid_date' : now >= start ? 'past' : withinNotice ? 'reschedule_notice_window' : alreadyMoved ? 'reschedule_used' : null,
  };
}

export function rescheduleAccessError(access) {
  return {
    code: access.reason,
    cancellationNoticeHours: access.cancellationNoticeHours,
    rescheduleDeadline: access.rescheduleDeadline,
    error: access.reason === 'reschedule_used'
      ? 'This booking has already been moved once. Please contact the salon if you need to change it again.'
      : access.reason === 'reschedule_notice_window'
        ? `Online rescheduling closes ${access.cancellationNoticeHours} hours before your appointment. Please contact the salon.`
        : 'This booking can no longer be rescheduled online. Please contact the salon.',
  };
}

/** One requested calendar month, bounded by the salon's booking horizon.
 * The old 28-day default remains available to older iPhone builds. */
export function rescheduleWindow({ month, policy, livePolicy, nowWall }) {
  const advance = [policy.max_advance_days, livePolicy.max_advance_days].map(Number).filter(n => Number.isFinite(n) && n > 0);
  const maxAdvanceDays = advance.length ? Math.min(...advance) : 0;
  const horizon = maxAdvanceDays ? new Date(nowWall.getTime() + maxAdvanceDays * 86400000) : null;
  const earliestMonth = nowWall.toISOString().slice(0, 7);
  const latestMonth = horizon?.toISOString().slice(0, 7) || null;
  if (month != null && (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))) {
    return { error: 'Choose a valid month.', code: 'invalid_month' };
  }
  if (month && (month < earliestMonth || (latestMonth && month > latestMonth))) {
    return { error: 'This month is outside the salon’s online booking window.', code: 'month_outside_booking_window', earliestMonth, latestMonth };
  }
  const fromWall = month ? new Date(`${month}-01T00:00:00Z`) : new Date(nowWall);
  if (fromWall < nowWall) fromWall.setTime(nowWall.getTime());
  let endWall;
  if (month) {
    endWall = new Date(`${month}-01T00:00:00Z`);
    endWall.setUTCMonth(endWall.getUTCMonth() + 1);
  } else endWall = new Date(nowWall.getTime() + 28 * 86400000);
  if (horizon && endWall > horizon) endWall = horizon;
  return { fromWall, endWall, days: Math.max(0, Math.ceil((endWall - fromWall) / 86400000)), maxAdvanceDays, horizon, month: month || null, earliestMonth, latestMonth };
}
