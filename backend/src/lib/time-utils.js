/**
 * Shared time and date utilities for appointments, billing, and scheduling
 */

/**
 * Get UK tax year string for a given date
 * UK tax year runs April 6 to April 5
 * @param {Date} date - Date to get tax year for
 * @returns {string} Tax year like "2025-26"
 */
export function getTaxYear(date) {
  const year = date.getFullYear();
  const month = date.getMonth(); // 0-indexed
  const day = date.getDate();

  // Before April 6 → previous year's tax year
  if (month < 3 || (month === 3 && day < 6)) {
    return `${year - 1}-${String(year).slice(2)}`;
  }
  // April 6 onwards → current year's tax year
  return `${year}-${String(year + 1).slice(2)}`;
}

/**
 * Get the start of day in UTC
 * @param {Date|string} date - Date or ISO string
 * @returns {Date} Start of day (00:00:00 UTC)
 */
export function getDayStart(date) {
  const d = typeof date === 'string' ? new Date(date) : new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0));
}

/**
 * Get the end of day in UTC
 * @param {Date|string} date - Date or ISO string
 * @returns {Date} End of day (23:59:59 UTC)
 */
export function getDayEnd(date) {
  const d = typeof date === 'string' ? new Date(date) : new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

/**
 * Parse time string (HH:MM) to minutes since midnight
 * @param {string} timeStr - Time like "14:30"
 * @returns {number} Minutes since midnight
 */
export function parseTimeToMinutes(timeStr) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Format minutes since midnight to time string (HH:MM)
 * @param {number} minutes - Minutes since midnight
 * @returns {string} Time like "14:30"
 */
export function minutesToTimeString(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

/**
 * Check if a time falls within working hours
 * @param {Date} appointmentTime - Appointment datetime
 * @param {string} startTime - Working start time like "09:00"
 * @param {string} endTime - Working end time like "17:00"
 * @returns {boolean} True if appointment is within working hours
 */
export function isWithinWorkingHours(appointmentTime, startTime, endTime) {
  const apptMinutes = appointmentTime.getUTCHours() * 60 + appointmentTime.getUTCMinutes();
  const startMinutes = parseTimeToMinutes(startTime);
  const endMinutes = parseTimeToMinutes(endTime);

  return apptMinutes >= startMinutes && apptMinutes < endMinutes;
}

/**
 * Get day of week key for working hours lookup
 * @param {Date|string} date - Date
 * @returns {string} Lowercase day name like "mon", "tue", etc.
 */
export function getDayOfWeekKey(date) {
  const d = typeof date === 'string' ? new Date(date) : new Date(date);
  return d.toLocaleDateString('en-US', { weekday: 'short' }).toLowerCase();
}

/**
 * Add minutes to a date
 * @param {Date|string} date - Starting date
 * @param {number} minutes - Minutes to add
 * @returns {Date} New date
 */
export function addMinutes(date, minutes) {
  const d = typeof date === 'string' ? new Date(date) : new Date(date);
  return new Date(d.getTime() + minutes * 60 * 1000);
}

/**
 * Calculate overlap between two time ranges
 * @param {string} start1 - First range start (ISO)
 * @param {string} end1 - First range end (ISO)
 * @param {string} start2 - Second range start (ISO)
 * @param {string} end2 - Second range end (ISO)
 * @returns {boolean} True if ranges overlap
 */
export function timeRangesOverlap(start1, end1, start2, end2) {
  const s1 = new Date(start1).getTime();
  const e1 = new Date(end1).getTime();
  const s2 = new Date(start2).getTime();
  const e2 = new Date(end2).getTime();

  return s1 < e2 && s2 < e1;
}

/**
 * Get next available time slot given duration and existing bookings
 * @param {Date} startSearch - Start searching from this time
 * @param {number} durationMinutes - Slot duration needed
 * @param {number} intervalMinutes - Search interval (default 15)
 * @param {Array} existingSlots - Array of { starts_at, ends_at }
 * @param {string} dayEndTime - End of working day like "17:00"
 * @returns {Date|null} First available slot or null if none found
 */
export function findNextAvailableSlot(
  startSearch,
  durationMinutes,
  intervalMinutes = 15,
  existingSlots = [],
  dayEndTime = '17:00'
) {
  const dayEnd = getDayEnd(startSearch);
  dayEnd.setUTCHours(parseInt(dayEndTime.split(':')[0]), parseInt(dayEndTime.split(':')[1]));

  let current = new Date(startSearch);
  while (current.getTime() + durationMinutes * 60000 <= dayEnd.getTime()) {
    const slotEnd = new Date(current.getTime() + durationMinutes * 60000);

    const hasConflict = existingSlots.some(slot => {
      const slotStart = new Date(slot.starts_at);
      const existingEnd = new Date(slot.ends_at);
      return current < existingEnd && slotEnd > slotStart;
    });

    if (!hasConflict) {
      return current;
    }

    current = new Date(current.getTime() + intervalMinutes * 60000);
  }

  return null;
}

/**
 * Format duration in minutes to readable string
 * @param {number} minutes - Duration in minutes
 * @returns {string} Formatted like "1h 30m" or "45m"
 */
export function formatDurationMinutes(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours > 0 && mins > 0) return `${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h`;
  return `${mins}m`;
}

/**
 * Is this an IANA zone the runtime can actually resolve?
 *
 * beauticians.timezone drives reminder timing, quiet hours and gap-fill, and
 * every reader hands it straight to Intl / toLocaleString. A zone Node does
 * not know throws RangeError inside the reminder job, which is a job that
 * then never runs for that salon. So the value is checked at the one place it
 * is written, and the reminder path never meets a bad one.
 *
 * @param {unknown} zone
 * @returns {boolean}
 */
export function isValidTimeZone(zone) {
  if (typeof zone !== 'string' || !zone.trim() || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
