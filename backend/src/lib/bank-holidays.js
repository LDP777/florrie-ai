/**
 * UK bank holidays — verified against gov.uk/bank-holidays.json (fetched 2026-06-07).
 *
 * Covers all three British divisions so Florrie surfaces the RIGHT holidays for
 * the salon's nation (e.g. St Andrew's Day in Scotland, St Patrick's Day +
 * Battle of the Boyne in Northern Ireland, plus the shared ones). Division is
 * derived from the beautician's postcode; England & Wales is the safe default.
 *
 * Dates run 2026–2028. Refresh from gov.uk when extending further out.
 */

const EVENTS = {
  'england-and-wales': [
    { title: 'New Year’s Day', date: '2026-01-01' },
    { title: 'Good Friday', date: '2026-04-03' },
    { title: 'Easter Monday', date: '2026-04-06' },
    { title: 'Early May bank holiday', date: '2026-05-04' },
    { title: 'Spring bank holiday', date: '2026-05-25' },
    { title: 'Summer bank holiday', date: '2026-08-31' },
    { title: 'Christmas Day', date: '2026-12-25' },
    { title: 'Boxing Day', date: '2026-12-28' },
    { title: 'New Year’s Day', date: '2027-01-01' },
    { title: 'Good Friday', date: '2027-03-26' },
    { title: 'Easter Monday', date: '2027-03-29' },
    { title: 'Early May bank holiday', date: '2027-05-03' },
    { title: 'Spring bank holiday', date: '2027-05-31' },
    { title: 'Summer bank holiday', date: '2027-08-30' },
    { title: 'Christmas Day', date: '2027-12-27' },
    { title: 'Boxing Day', date: '2027-12-28' },
    { title: 'New Year’s Day', date: '2028-01-03' },
    { title: 'Good Friday', date: '2028-04-14' },
    { title: 'Easter Monday', date: '2028-04-17' },
    { title: 'Early May bank holiday', date: '2028-05-01' },
    { title: 'Spring bank holiday', date: '2028-05-29' },
    { title: 'Summer bank holiday', date: '2028-08-28' },
    { title: 'Christmas Day', date: '2028-12-25' },
    { title: 'Boxing Day', date: '2028-12-26' },
  ],
  scotland: [
    { title: 'New Year’s Day', date: '2026-01-01' },
    { title: '2nd January', date: '2026-01-02' },
    { title: 'Good Friday', date: '2026-04-03' },
    { title: 'Early May bank holiday', date: '2026-05-04' },
    { title: 'Spring bank holiday', date: '2026-05-25' },
    { title: 'World Cup bank holiday', date: '2026-06-15' },
    { title: 'Summer bank holiday', date: '2026-08-03' },
    { title: 'St Andrew’s Day', date: '2026-11-30' },
    { title: 'Christmas Day', date: '2026-12-25' },
    { title: 'Boxing Day', date: '2026-12-28' },
    { title: 'New Year’s Day', date: '2027-01-01' },
    { title: '2nd January', date: '2027-01-04' },
    { title: 'Good Friday', date: '2027-03-26' },
    { title: 'Early May bank holiday', date: '2027-05-03' },
    { title: 'Spring bank holiday', date: '2027-05-31' },
    { title: 'Summer bank holiday', date: '2027-08-02' },
    { title: 'St Andrew’s Day', date: '2027-11-30' },
    { title: 'Christmas Day', date: '2027-12-27' },
    { title: 'Boxing Day', date: '2027-12-28' },
    { title: 'New Year’s Day', date: '2028-01-03' },
    { title: '2nd January', date: '2028-01-04' },
    { title: 'Good Friday', date: '2028-04-14' },
    { title: 'Early May bank holiday', date: '2028-05-01' },
    { title: 'Spring bank holiday', date: '2028-05-29' },
    { title: 'Summer bank holiday', date: '2028-08-07' },
    { title: 'St Andrew’s Day', date: '2028-11-30' },
    { title: 'Christmas Day', date: '2028-12-25' },
    { title: 'Boxing Day', date: '2028-12-26' },
  ],
  'northern-ireland': [
    { title: 'New Year’s Day', date: '2026-01-01' },
    { title: 'St Patrick’s Day', date: '2026-03-17' },
    { title: 'Good Friday', date: '2026-04-03' },
    { title: 'Easter Monday', date: '2026-04-06' },
    { title: 'Early May bank holiday', date: '2026-05-04' },
    { title: 'Spring bank holiday', date: '2026-05-25' },
    { title: 'Battle of the Boyne (Orangemen’s Day)', date: '2026-07-13' },
    { title: 'Summer bank holiday', date: '2026-08-31' },
    { title: 'Christmas Day', date: '2026-12-25' },
    { title: 'Boxing Day', date: '2026-12-28' },
    { title: 'New Year’s Day', date: '2027-01-01' },
    { title: 'St Patrick’s Day', date: '2027-03-17' },
    { title: 'Good Friday', date: '2027-03-26' },
    { title: 'Easter Monday', date: '2027-03-29' },
    { title: 'Early May bank holiday', date: '2027-05-03' },
    { title: 'Spring bank holiday', date: '2027-05-31' },
    { title: 'Battle of the Boyne (Orangemen’s Day)', date: '2027-07-12' },
    { title: 'Summer bank holiday', date: '2027-08-30' },
    { title: 'Christmas Day', date: '2027-12-27' },
    { title: 'Boxing Day', date: '2027-12-28' },
    { title: 'New Year’s Day', date: '2028-01-03' },
    { title: 'St Patrick’s Day', date: '2028-03-17' },
    { title: 'Good Friday', date: '2028-04-14' },
    { title: 'Easter Monday', date: '2028-04-17' },
    { title: 'Early May bank holiday', date: '2028-05-01' },
    { title: 'Spring bank holiday', date: '2028-05-29' },
    { title: 'Battle of the Boyne (Orangemen’s Day)', date: '2028-07-12' },
    { title: 'Summer bank holiday', date: '2028-08-28' },
    { title: 'Christmas Day', date: '2028-12-25' },
    { title: 'Boxing Day', date: '2028-12-26' },
  ],
};

// Postcode AREA codes (the leading letters) that belong to Scotland / NI.
const SCOTLAND_AREAS = new Set([
  'AB','DD','DG','EH','FK','G','HS','IV','KA','KW','KY','ML','PA','PH','TD','ZE',
]);

/**
 * Map a UK postcode to its bank-holiday division. England & Wales is the default
 * (covers the large majority of users and is the safe fallback when unknown).
 */
export function postcodeToDivision(postcode) {
  if (!postcode || typeof postcode !== 'string') return 'england-and-wales';
  const pc = postcode.toUpperCase().replace(/\s+/g, '');
  if (!pc) return 'england-and-wales';
  if (pc.startsWith('BT')) return 'northern-ireland';
  const area = (pc.match(/^[A-Z]{1,2}/) || [''])[0];
  if (SCOTLAND_AREAS.has(area)) return 'scotland';
  return 'england-and-wales';
}

function todayUTCDateString() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function daysBetween(fromISO, toISO) {
  const a = Date.UTC(+fromISO.slice(0, 4), +fromISO.slice(5, 7) - 1, +fromISO.slice(8, 10));
  const b = Date.UTC(+toISO.slice(0, 4), +toISO.slice(5, 7) - 1, +toISO.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

/**
 * The next bank holiday on or after `from` (YYYY-MM-DD, defaults to today UTC)
 * for the given division. Returns { title, date, daysAway } or null.
 */
export function nextBankHoliday(division = 'england-and-wales', from = todayUTCDateString()) {
  const list = EVENTS[division] || EVENTS['england-and-wales'];
  const upcoming = list
    .filter(e => e.date >= from)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!upcoming.length) return null;
  const next = upcoming[0];
  return { title: next.title, date: next.date, daysAway: daysBetween(from, next.date) };
}

export { EVENTS };
