import { effectiveHours } from '../../../backend/src/lib/effective-hours.js';
// Keep the familiar grid until an early/late opening or booking needs more room.
export function calendarHoursBounds(dates, weekly, dateHours, appointments, start = 6, end = 23) {
  for (const date of dates) {
    const hours = effectiveHours(weekly, date, dateHours);
    if (hours) {
      start = Math.min(start, Math.floor(minutes(hours.start) / 60));
      end = Math.max(end, Math.ceil(minutes(hours.end) / 60));
    }
    for (const appointment of appointments.filter(a => String(a.starts_at).slice(0, 10) === date)) {
      const from = minutes(String(appointment.starts_at).slice(11, 16));
      const to = minutes(String(appointment.ends_at).slice(11, 16));
      if (Number.isFinite(from)) start = Math.min(start, Math.floor(from / 60));
      if (Number.isFinite(to)) end = Math.max(end, Math.ceil(to / 60));
    }
  }
  return { start: Math.max(0, start), end: Math.min(24, end) };
}
function minutes(time) { const [h, m] = time.split(':').map(Number); return h * 60 + m; }
