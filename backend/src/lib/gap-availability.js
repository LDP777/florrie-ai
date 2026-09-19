import { supabase } from '../config.js';
import { loadBlocks, wallDayHours } from './free-slots.js';

const IGNORED = new Set(['cancelled', 'cancelled_by_client', 'cancelled_by_beautician', 'no_show', 'rescheduled']);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export function gapError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function gapRequest(body = {}) {
  const { date, start_time: start, end_time: end } = body;
  const hasDate = date !== undefined && date !== null;
  const hasTime = start !== undefined || end !== undefined;
  if (!hasDate && !hasTime) return {};
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
    || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw gapError('invalid_gap', 'Choose a valid date for the gap.');
  }
  if (!hasTime) return { date };
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  if (typeof start !== 'string' || typeof end !== 'string' || !time.test(start) || !time.test(end) || end <= start) {
    throw gapError('invalid_gap', 'Choose both a valid start and end time for the gap.');
  }
  return { date, start, end };
}

function salonWallNow(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone || 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
  return new Date(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
}

function wallStamp(value) {
  if (!value) return NaN;
  const wall = String(value).slice(0, 19).replace(' ', 'T');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(wall)) return NaN;
  const stamp = Date.parse(`${wall}Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 19) === wall ? stamp : NaN;
}

/** Appointment timestamps already contain salon wall time; do not shift them. */
export function computeCalendarGaps(now, appointments, hours, timezone, blocks = { closedDays: new Set(), intervals: [] }) {
  const wallNow = salonWallNow(now, timezone);
  const firstDay = wallNow.toISOString().slice(0, 10);
  const midnight = Date.parse(`${firstDay}T00:00:00Z`);
  const busy = appointments.filter(a => !IGNORED.has(a.status)).map(a => {
    const start = wallStamp(a.starts_at);
    const storedEnd = wallStamp(a.ends_at);
    let end = storedEnd;
    if (a.ends_at == null) {
      const duration = Number(a.duration_minutes);
      const buffer = Number(a.buffer_minutes ?? 0);
      const padding = Number(a.extra_padding_minutes ?? 0);
      if (![duration, buffer, padding].every(Number.isFinite) || duration <= 0 || buffer < 0 || padding < 0) {
        throw gapError('availability_unavailable', 'Could not check the diary. Please try again.');
      }
      end = start + (duration + buffer + padding) * MINUTE;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw gapError('availability_unavailable', 'Could not check the diary. Please try again.');
    }
    return { start, end };
  });
  busy.push(...blocks.intervals.map(b => ({ start: b.start.getTime(), end: b.end.getTime() })));
  const gaps = [];
  for (let offset = 0; offset < 7; offset++) {
    const day = new Date(midnight + offset * DAY);
    const date = day.toISOString().slice(0, 10);
    if (blocks.closedDays.has(date)) continue;
    const dayHours = wallDayHours(hours, day);
    if (!dayHours || dayHours.enabled === false || dayHours.closed === true) continue;
    const open = wallStamp(`${date}T${String(dayHours.start).slice(0, 5)}:00`);
    const close = wallStamp(`${date}T${String(dayHours.end).slice(0, 5)}:00`);
    if (!Number.isFinite(open) || !Number.isFinite(close) || close <= open) continue;
    let cursor = Math.max(open, Math.ceil(wallNow.getTime() / MINUTE) * MINUTE);
    if (cursor >= close) continue;
    const add = (start, end) => {
      if (end <= start) return;
      gaps.push({ date, start: new Date(start).toISOString().slice(11, 16), end: new Date(end).toISOString().slice(11, 16),
        duration_minutes: (end - start) / MINUTE, dayOfWeek: day.getUTCDay(),
        dayLabel: new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(day) });
    };
    for (const block of busy.filter(b => b.start < close && b.end > cursor).sort((a, b) => a.start - b.start)) {
      add(cursor, Math.min(close, block.start));
      cursor = Math.max(cursor, block.end);
      if (cursor >= close) break;
    }
    add(cursor, close);
  }
  return gaps;
}

/** One fresh, fail-closed diary read shared by matching and dispatch. */
export async function currentGapCalendar(beauticianId, now = new Date()) {
  try {
    const profile = await supabase.from('beauticians')
      .select('working_hours, timezone, whatsapp_phone_id, client_reminder_prefs, booking_slug, autonomy')
      .eq('id', beauticianId).single();
    if (profile.error || !profile.data) throw new Error('Working hours unavailable');
    const beautician = profile.data;
    const wallNow = salonWallNow(now, beautician.timezone);
    const from = new Date(`${wallNow.toISOString().slice(0, 10)}T00:00:00Z`);
    const to = new Date(from.getTime() + 7 * DAY - 1);
    const [appointments, blocks] = await Promise.all([
      supabase.from('appointments').select('starts_at, ends_at, duration_minutes, buffer_minutes, extra_padding_minutes, status, treatment_id', { count: 'exact' })
        .eq('beautician_id', beauticianId)
        .lte('starts_at', to.toISOString())
        .or(`ends_at.gt.${from.toISOString()},starts_at.gte.${new Date(from.getTime() - DAY).toISOString()}`)
        .not('status', 'in', `(${[...IGNORED].join(',')})`),
      loadBlocks(beauticianId, from, to, { requireComplete: true }),
    ]);
    if (appointments.error) throw new Error('Appointments unavailable');
    if (!Array.isArray(appointments.data) || !Number.isSafeInteger(appointments.count)
      || appointments.count !== appointments.data.length) {
      throw new Error('Appointments lookup incomplete');
    }
    if (blocks.intervals.some(b => !Number.isFinite(b.start.getTime()) || !Number.isFinite(b.end.getTime()) || b.end <= b.start)) {
      throw new Error('Blocked time is invalid');
    }
    return { beautician, appointments: appointments.data || [],
      gaps: computeCalendarGaps(now, appointments.data || [], beautician.working_hours || {}, beautician.timezone, blocks) };
  } catch (error) {
    throw gapError('availability_unavailable', 'Could not check the diary. Please try again.');
  }
}

export function selectCurrentGaps(gaps, target = {}) {
  const dated = target.date ? gaps.filter(g => g.date === target.date) : gaps;
  if (!target.start) return dated.filter(g => g.duration_minutes >= 30);
  const containing = dated.find(g => g.start <= target.start && g.end >= target.end);
  if (!containing) throw gapError('gap_unavailable', 'That time is no longer free. Refresh Schedule to see the current gaps.');
  return [{ ...containing, start: target.start, end: target.end,
    duration_minutes: (Date.parse(`${target.date}T${target.end}:00Z`) - Date.parse(`${target.date}T${target.start}:00Z`)) / MINUTE }];
}

export async function assertGapAvailable(beauticianId, gap) {
  const { gaps } = await currentGapCalendar(beauticianId);
  return selectCurrentGaps(gaps, { date: gap.date, start: gap.start, end: gap.end })[0];
}
