// Pure wall-clock rules shared by the API and the app. A dated window replaces
// that day's usual opening hours; personal blocks are still subtracted separately.
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export function validHoursDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T12:00:00Z`))
    && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}
export function validHoursTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d(?::00)?$/.test(value);
}
export function effectiveHours(weekly, date, dated = []) {
  if (!validHoursDate(date)) throw new Error('Choose a valid date.');
  const row = Array.isArray(dated) ? dated.find(item => item.date === date) : dated?.[date];
  if (row) {
    if (!validHoursTime(row.start_time) || !validHoursTime(row.end_time) || row.end_time.slice(0, 5) <= row.start_time.slice(0, 5)) {
      throw new Error('Check the hours saved for this date.');
    }
    return { start: row.start_time.slice(0, 5), end: row.end_time.slice(0, 5) };
  }
  const key = DAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
  const hours = Object.hasOwn(weekly || {}, key) ? weekly[key] : weekly?.[key[0].toUpperCase() + key.slice(1)];
  if (!hours || hours.enabled === false || hours.closed === true) return null;
  if (!validHoursTime(hours.start) || !validHoursTime(hours.end) || hours.end.slice(0, 5) <= hours.start.slice(0, 5)) {
    throw new Error('Check your usual working hours.');
  }
  return { start: hours.start.slice(0, 5), end: hours.end.slice(0, 5) };
}
