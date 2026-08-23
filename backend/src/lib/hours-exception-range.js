/**
 * One answer to "is this closure a range that can actually be read back".
 *
 * There are two doors into hours_exceptions: POST /api/hours-exceptions and
 * POST /api/features/hours-exceptions. A range picker that hands back its two
 * ends in the wrong order used to be stored verbatim through either of them.
 * Nothing downstream can honour date..end_date when the end is before the
 * start, so free-slots falls back to the single day and the rest of the
 * closure stays bookable on the public page. That is a week of a holiday
 * given away, and it is the bug the multi-day closure fix exists to close.
 *
 * Both values are YYYY-MM-DD, which sorts correctly as text, so no parsing.
 * A missing end is not an error: a single day is not a range.
 */
export function exceptionRangeError(date, endDate) {
  const start = typeof date === 'string' ? date.trim() : '';
  const end = typeof endDate === 'string' ? endDate.trim() : '';
  if (!start || !end) return null;
  if (end < start) return 'end_date cannot be before date';
  return null;
}
