/**
 * Shared formatting utilities for dates, currency, and common values
 */

/**
 * Format pence to GBP currency string
 * @param {number} cents - Amount in pence
 * @returns {string} Formatted string like "£12.50"
 */
export function formatCurrency(cents) {
  if (cents === null || cents === undefined) return '£0.00';
  return `£${(cents / 100).toFixed(2)}`;
}

/**
 * Format ISO datetime to human readable string
 * @param {string} isoDate - ISO 8601 date string
 * @param {Object} options - Intl.DateTimeFormat options
 * @returns {string} Formatted date string
 */
export function formatDate(isoDate, options = {}) {
  if (!isoDate) return '';
  const date = new Date(isoDate);
  return date.toLocaleDateString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...options
  });
}

/**
 * Format ISO datetime to human readable datetime string
 * @param {string} isoDate - ISO 8601 datetime string
 * @returns {string} Formatted string like "14 Mar 2026, 14:30"
 */
export function formatDateTime(isoDate) {
  if (!isoDate) return '';
  const date = new Date(isoDate);
  const dateStr = date.toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
  const timeStr = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${dateStr}, ${timeStr}`;
}

/**
 * Format ISO datetime to time only
 * @param {string} isoDate - ISO 8601 datetime string
 * @returns {string} Formatted string like "14:30"
 */
export function formatTime(isoDate) {
  if (!isoDate) return '';
  const date = new Date(isoDate);
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Format minutes as duration string
 * @param {number} minutes - Duration in minutes
 * @returns {string} Formatted string like "1h 30m" or "45m"
 */
export function formatDuration(minutes) {
  if (!minutes) return '0m';
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours > 0 && mins > 0) return `${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h`;
  return `${mins}m`;
}

/**
 * Format phone number to readable format
 * @param {string} phone - Phone number string
 * @returns {string} Formatted phone number
 */
export function formatPhone(phone) {
  if (!phone) return '';
  // Remove all non-digits
  const cleaned = phone.replace(/\D/g, '');
  // UK format: +44 XXXX XXXXXX
  if (cleaned.startsWith('44') && cleaned.length >= 11) {
    return `+${cleaned.slice(0, 2)} ${cleaned.slice(2, 6)} ${cleaned.slice(6)}`;
  }
  return phone;
}

/**
 * Parse currency string to pence
 * @param {string} currencyStr - Currency string like "12.50" or "£12.50"
 * @returns {number} Amount in pence
 */
export function parseCurrency(currencyStr) {
  if (!currencyStr) return 0;
  const cleaned = currencyStr.replace(/[^0-9.]/g, '');
  return Math.round(parseFloat(cleaned) * 100);
}

/**
 * Relative time string (e.g., "2 days ago", "in 3 hours")
 * @param {string} isoDate - ISO 8601 datetime string
 * @returns {string} Relative time string
 */
export function formatRelativeTime(isoDate) {
  if (!isoDate) return '';
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = Math.abs(now - date);
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  const isFuture = date > now;

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) {
    return isFuture
      ? `in ${diffMins} minute${diffMins > 1 ? 's' : ''}`
      : `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
  }
  if (diffHours < 24) {
    return isFuture
      ? `in ${diffHours} hour${diffHours > 1 ? 's' : ''}`
      : `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  }
  return isFuture
    ? `in ${diffDays} day${diffDays > 1 ? 's' : ''}`
    : `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
}

/**
 * Capitalize first letter of string
 * @param {string} str - String to capitalize
 * @returns {string} Capitalized string
 */
export function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Convert snake_case to Title Case
 * @param {string} str - Snake case string
 * @returns {string} Title case string
 */
export function toTitleCase(str) {
  if (!str) return '';
  return str
    .split('_')
    .map(word => capitalize(word))
    .join(' ');
}
