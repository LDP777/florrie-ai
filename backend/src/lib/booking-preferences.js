import { dayPreferenceFrom, timeCandidates } from './booking-rules.js';

const day = date => date.toISOString().slice(0, 10);
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const HOURS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const HOUR = `(?:\\d{1,2}|${HOURS.join('|')})`;
const CLOCK = `(?:(?:half(?: past)?|quarter past|quarter to)\\s+${HOUR}|${HOUR}(?:[.:]\\d{2})?)(?:\\s*(?:am|pm))?`;
function clocksAfter(text, cue) {
  const match = new RegExp(`\\b(?:${cue})\\s+(${CLOCK}(?:\\s*(?:/|or)\\s*${CLOCK})*)(?!\\d)\\b`).exec(text);
  if (!match) return [];
  const remainder = text.slice(match.index + match[0].length);
  if (new RegExp(`^\\s+(?:${MONTHS.join('|')})\\b`).test(remainder)) return [];
  const clocks = match[1].replace(new RegExp(`\\b(${HOURS.join('|')})\\b`, 'g'), word => String(HOURS.indexOf(word) + 1));
  return timeCandidates(clocks);
}

/** Carry only explicit diary constraints between booking questions. */
export function bookingPreferencesFrom(message, fromWall, previous = {}) {
  const text = String(message || '').toLowerCase();
  const prefs = { ...previous };
  if (!fromWall || !Number.isFinite(fromWall.getTime())) return prefs;
  const dates = dayPreferenceFrom(text, fromWall);
  if (dates) {
    prefs.dates = dates;
    delete prefs.fromDate; delete prefs.toDate;
  } else {
    let range;
    if (/\b(?:this|next) month\b/.test(text)) {
      const month = fromWall.getUTCMonth() + (/\bnext month\b/.test(text) ? 1 : 0);
      range = [new Date(Date.UTC(fromWall.getUTCFullYear(), month, 1)), new Date(Date.UTC(fromWall.getUTCFullYear(), month + 1, 0))];
    } else if (/\b(?:this|next) week\b/.test(text)) {
      const start = new Date(fromWall); start.setUTCHours(0, 0, 0, 0);
      const mondayOffset = (start.getUTCDay() + 6) % 7;
      start.setUTCDate(start.getUTCDate() - mondayOffset + (/\bnext week\b/.test(text) ? 7 : 0));
      const end = new Date(start); end.setUTCDate(end.getUTCDate() + 6);
      range = [start, end];
    } else {
      const match = new RegExp(`\\b(?:in|during|for)\\s+(${MONTHS.join('|')})(?:\\s+(20\\d{2}))?\\b`).exec(text);
      if (match) {
        const month = MONTHS.indexOf(match[1]);
        const year = match[2] ? Number(match[2]) : fromWall.getUTCFullYear() + (month < fromWall.getUTCMonth() ? 1 : 0);
        range = [new Date(Date.UTC(year, month, 1)), new Date(Date.UTC(year, month + 1, 0))];
      }
    }
    if (range) {
      prefs.fromDate = day(range[0]); prefs.toDate = day(range[1]); delete prefs.dates;
    } else if (/\b(?:any day|any date|whenever)\b/.test(text)) {
      delete prefs.dates; delete prefs.fromDate; delete prefs.toDate;
    }
  }

  if (/\b(?:any time|anytime)\b/.test(text)) {
    delete prefs.afterTime; delete prefs.beforeTime; delete prefs.times;
  } else {
    const afterTimes = clocksAfter(text, 'after|from|no earlier than');
    const beforeTimes = clocksAfter(text, 'before|until|no later than');
    if (afterTimes.length) { prefs.afterTime = [...afterTimes].sort().at(-1); delete prefs.times; }
    if (beforeTimes.length) { prefs.beforeTime = [...beforeTimes].sort()[0]; delete prefs.times; }
    if (!afterTimes.length && !beforeTimes.length && /\bat\s+|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/.test(text)) {
      const atTimes = clocksAfter(text, 'at');
      const explicitClocks = text.match(/\b\d{1,2}(?:[.:]\d{2})?\s*(?:am|pm)\b/g) || [];
      const times = atTimes.length ? atTimes : [...new Set(explicitClocks.flatMap(clock => timeCandidates(clock)))];
      if (times.length) { prefs.times = times; delete prefs.afterTime; delete prefs.beforeTime; }
    }
  }
  return prefs;
}

export function bookingPreferencesFromState(state) {
  return (Array.isArray(state?.offered) ? state.offered : []).find(item => item?.booking_preferences)?.booking_preferences || {};
}

/** Metadata stays on the first menu/slot item, so ordinal choices do not move. */
export function withBookingPreferences(offered, preferences) {
  return offered.map((item, index) => index === 0 && Object.keys(preferences || {}).length
    ? { ...item, booking_preferences: preferences } : item);
}

export function slotsWithinBookingPreferences(slots, preferences = {}) {
  const inWindow = (slots || []).filter(slot => (!preferences.dates || preferences.dates.includes(slot.date))
    && (!preferences.fromDate || slot.date >= preferences.fromDate)
    && (!preferences.toDate || slot.date <= preferences.toDate)
    && (!preferences.afterTime || slot.time >= preferences.afterTime)
    && (!preferences.beforeTime || slot.time <= preferences.beforeTime));
  // An exact requested time is a preference: if it is gone, offer alternatives
  // on the requested date for the client to choose. Explicit bounds stay firm.
  const exact = preferences.times ? inWindow.filter(slot => preferences.times.includes(slot.time)) : [];
  return exact.length ? exact : inWindow;
}
