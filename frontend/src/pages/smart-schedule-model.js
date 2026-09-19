import { localDateStr } from '../lib/dates.js';

export const INACTIVE_APPOINTMENTS = ['cancelled', 'cancelled_by_client', 'cancelled_by_beautician', 'rescheduled', 'no_show'];
const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const requiredMinutes = treatment => Number(treatment?.duration_minutes) + Math.max(0, Number(treatment?.buffer_minutes || 0));
const pad = n => String(n).padStart(2, '0');
const time = n => `${pad(Math.floor(n / 60))}:${pad(n % 60)}`;
export const minutes = value => {
  if (!/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value || '')) return NaN;
  const [h, m] = value.split(':').map(Number); return h * 60 + m;
};
const wallStamp = value => {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return match && Number.isFinite(minutes(match[2])) ? Date.parse(`${match[1]}T${match[2]}:00Z`) / 60000 : NaN;
};
export function scheduleRange(now = new Date()) {
  const end = new Date(now); end.setDate(end.getDate() + 7);
  return { from: localDateStr(now), until: localDateStr(end) };
}
export function salonClock(now = new Date(), timeZone) {
  timeZone = timeZone || 'Europe/London';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(part => [part.type, part.value]));
  // A local Date carrying the salon's clock fields, for the wall-clock model.
  return new Date(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
}
function merge(intervals) {
  const result = [];
  for (const [start, end] of intervals.filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else result.push([start, end]);
  }
  return result;
}
const length = intervals => intervals.reduce((sum, [start, end]) => sum + end - start, 0);
function subtract(windows, busy) {
  return busy.reduce((remaining, [start, end]) => remaining.flatMap(([a, b]) =>
    end <= a || start >= b ? [[a, b]] : [[a, Math.min(b, start)], [Math.max(a, end), b]].filter(([x, y]) => y > x)
  ), windows);
}

// The app stores salon wall-clock fields in timestamps; match Calendar/public
// booking rather than shifting the stored clock by the browser's UTC offset.
export function computeSchedule({ appointments = [], exceptions = [], treatments = [], workingHours, now = new Date() }) {
  const gaps = []; let workMinutes = 0, bookedMinutes = 0, blockedMinutes = 0;
  const activeTreatments = treatments.filter(t => t.is_active !== false);
  const hasConfiguredHours = Object.values(workingHours || {}).some(h => h?.start && h?.end && h.enabled !== false && h.closed !== true);
  const busyAppointments = appointments.filter(a => !INACTIVE_APPOINTMENTS.includes(a.status)).map(a => {
    const start = wallStamp(a.starts_at);
    const end = a.ends_at ? wallStamp(a.ends_at) : start + Number(a.duration_minutes) + Math.max(0, Number(a.buffer_minutes || 0)) + Math.max(0, Number(a.extra_padding_minutes || 0));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('An appointment has no valid end time. Check it in Calendar, then refresh Schedule.');
    return [start, end];
  });
  for (let i = 0; i < 7; i++) {
    const date = new Date(now); date.setDate(date.getDate() + i);
    const dateStr = localDateStr(date), key = dayKeys[date.getDay()];
    const h = workingHours?.[key] || workingHours?.[key[0].toUpperCase() + key.slice(1)];
    if (!h || h.enabled === false || h.closed === true) continue;
    const start = minutes(h.start), end = minutes(h.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('Check your saved working hours, then refresh Schedule.');
    const from = i ? start : Math.max(start, Math.ceil((now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60) / 15) * 15);
    if (from >= end) continue;
    const applicable = exceptions.filter(e => e.date <= dateStr && dateStr <= (e.end_date || e.date));
    // A non-closed range is blocked time in the current Calendar/public booking
    // contract. Missing or malformed ranges close the day rather than sell it.
    const fullClosure = applicable.some(e => e.type === 'closed' || (!e.type && e.is_closed) || !Number.isFinite(minutes(e.start_time || e.custom_start)) || !Number.isFinite(minutes(e.end_time || e.custom_end)) || minutes(e.end_time || e.custom_end) <= minutes(e.start_time || e.custom_start));
    const blocks = fullClosure ? [[from, end]] : merge(applicable.map(e => [Math.max(from, minutes(e.start_time || e.custom_start)), Math.min(end, minutes(e.end_time || e.custom_end))]));
    const windows = subtract([[from, end]], blocks); blockedMinutes += (end - from) - length(windows);
    workMinutes += length(windows);
    const midnight = Date.parse(`${dateStr}T00:00:00Z`) / 60000;
    const appts = merge(busyAppointments.map(([a, b]) => [Math.max(from, a - midnight), Math.min(end, b - midnight)]));
    const open = subtract(windows, appts);
    bookedMinutes += length(windows) - length(open);
    for (const [a, b] of open) {
      // Keep sub-treatment gaps in totals, but don't offer sub-quarter slivers.
      if (b - a < 15) continue;
      const fitCount = activeTreatments.filter(t => Number(t.duration_minutes) > 0 && requiredMinutes(t) <= b - a).length;
      gaps.push({ id: `gap-${dateStr}-${a}`, date: dateStr, dayLabel: date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }), start: time(a), end: time(b), duration_minutes: b - a, fillability: b - a >= 60 ? 'high' : 'medium', fitCount, fitTotal: activeTreatments.length });
    }
  }
  return { gaps, workMinutes, bookedMinutes, blockedMinutes, openMinutes: workMinutes - bookedMinutes, hasConfiguredHours };
}

export function suggestionsForGap(suggestions, gap) {
  const fits = s => s.client?.id && Number(s.treatment?.duration_minutes) > 0 && requiredMinutes(s.treatment) <= gap.duration_minutes;
  return {
    rebook_due: (suggestions.rebook_due || []).filter(fits),
    waitlist_match: (suggestions.waitlist_match || []).filter(s => fits(s) && s.gap?.date === gap.date && minutes(s.gap.start) <= minutes(gap.start) && minutes(s.gap.end) >= minutes(gap.end)),
  };
}
