/**
 * Local-date helpers. THE rule for the whole app: a calendar date (YYYY-MM-DD)
 * must be built from LOCAL parts, never via toISOString(), which converts to UTC
 * and rolls the date back a day under British Summer Time (UTC+1) in the evening.
 * That class of bug is what made "today" and day-grouping land on the wrong day.
 *
 * Appointment times are stored wall-clock (ISO without a Z) and read by string
 * slicing elsewhere; these helpers keep every "what day is it" decision consistent
 * with that, in the user's own timezone.
 */

/** Local YYYY-MM-DD for a Date (defaults to now). Never use toISOString for this. */
export function localDateStr(d = new Date()) {
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt)) return '';
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

/** Today's local calendar date as YYYY-MM-DD. */
export function todayLocal() {
  return localDateStr(new Date());
}

/** Parse a YYYY-MM-DD (date-only) string to a local Date at noon, avoiding the
 *  UTC-midnight parse that shifts the day in negative-offset zones. */
export function parseDateOnly(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(m)) return null;
  return new Date(`${m}T12:00:00`);
}
