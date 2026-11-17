import { readAllMoney } from '../lib/read-all-money.js';
import { moneyDate, shiftDate } from '../lib/money-reporting.js';
import { postcodeToDivision } from '../lib/bank-holidays.js';
import savedHolidays from '../data/bank-holidays.json' with { type: 'json' };

const DAY = 86400000;
const active = a => ['confirmed', 'pending', 'in_progress'].includes(a.status);
const dayOf = value => String(value || '').slice(0, 10);
const minute = value => Number(String(value).slice(11, 13)) * 60 + Number(String(value).slice(14, 16));
const hm = n => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
const dateMs = day => Date.parse(`${day}T12:00:00Z`);
const days = (a, b) => Math.round((dateMs(b) - dateMs(a)) / DAY);
const weekday = day => new Date(`${day}T12:00:00Z`).getUTCDay();
const median = values => { const v = [...values].sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : 0; };
const covered = (b, d) => b.date <= d && (b.end_date || b.date) >= d;
const closed = b => b.type === 'closed' || (!b.type && b.is_closed === true);
export const thoughtDay = day => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

let calendarCache;
export async function holidayCalendar(fetcher = fetch) {
  if (calendarCache && calendarCache.until > Date.now()) return calendarCache.value;
  try {
    const response = await fetcher('https://www.gov.uk/bank-holidays.json', { signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error('Holiday calendar unavailable');
    const raw = await response.json(), value = {};
    for (const division of Object.keys(savedHolidays)) {
      const rows = raw[division]?.events;
      if (!Array.isArray(rows) || !rows.length || rows.some(e => !/^\d{4}-\d{2}-\d{2}$/.test(e.date) || typeof e.title !== 'string')) throw new Error('Invalid holiday calendar');
      value[division] = rows.map(e => ({ date: e.date, title: e.title.slice(0, 100) }));
    }
    calendarCache = { until: Date.now() + DAY, value };
    return value;
  } catch {
    // Verified official snapshot; no generated or guessed holiday dates.
    return calendarCache?.value || savedHolidays;
  }
}

export async function loadPersonalThoughts(db, owner, now = new Date()) {
  const today = moneyDate(now, owner.timezone || 'Europe/London');
  const all = factory => readAllMoney(factory, { maxRows: 50000 });
  const bounded = q => q.abortSignal(AbortSignal.timeout(6000));
  const [appointments, blocks, clients, locations, holidays] = await Promise.all([
    all(() => bounded(db.from('appointments').select('id,client_id,starts_at,ends_at,status,treatment_id,treatments(name)', { count: 'exact' })
      .eq('beautician_id', owner.id).gte('starts_at', `${shiftDate(today, -365)}T00:00:00`).order('id'))),
    all(() => bounded(db.from('hours_exceptions').select('id,date,end_date,type,is_closed,start_time,end_time,reason', { count: 'exact' })
      .eq('beautician_id', owner.id).lte('date', shiftDate(today, 90)).order('id'))),
    all(() => bounded(db.from('clients').select('id,first_name,archived_at,blocked_at', { count: 'exact' }).eq('beautician_id', owner.id).is('archived_at', null).order('id'))),
    all(() => bounded(db.from('locations').select('id,address,is_primary,created_at,status', { count: 'exact' }).eq('beautician_id', owner.id).order('id'))),
    holidayCalendar(),
  ]);
  return derivePersonalThoughts({ owner, appointments, blocks, clients, locations, holidays, now });
}

function base(id, type, title, summary, evidence, date, extra = {}) {
  return { id, type, title, summary, evidence: { label: evidence[0], facts: evidence, link_to: `/calendar/week?date=${date}` },
    icon: 'flower', impact_pence: 0, priority_band: 2, urgency: 60, confidence: 'Observed pattern',
    expires_at: `${date}T00:00:00Z`, expires_frame: 'wall', link_to: `/calendar/week?date=${date}`, action_label: 'Make a plan', ...extra };
}

/** Facts and executable choices are derived in code. AI can connect and explain them. */
export function derivePersonalThoughts({ owner, appointments, blocks, clients, locations, holidays = savedHolidays, now = new Date() }) {
  const today = moneyDate(now, owner.timezone || 'Europe/London'), cards = [];
  const future = appointments.filter(a => active(a) && dayOf(a.starts_at) >= today);
  const history = appointments.filter(a => a.status === 'completed' && dayOf(a.starts_at) < today);
  const byDay = new Map();
  for (const a of [...history, ...future]) { const d = dayOf(a.starts_at); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(a); }
  const activeLocations = locations.filter(l => !l.status || l.status === 'active');
  const location = activeLocations.find(l => l.is_primary) || (activeLocations.length === 1 ? activeLocations[0] : null);
  const postcode = String(location?.address || owner.address || '').match(/\b(?:GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})\b/i)?.[0];
  const workingDays = owner.working_hours || {};
  const normallyOpen = date => {
    if (!Object.keys(workingDays).length) return true; // unknown hours do not imply a day off
    const key = ['sun','mon','tue','wed','thu','fri','sat'][weekday(date)];
    const h = workingDays[key] || workingDays[key[0].toUpperCase() + key.slice(1)];
    return !!(h?.start && h?.end);
  };
  // Extract only the country hint; never send the street address to the model.
  if (postcode) {
    const division = postcodeToDivision(postcode);
    const calendar = holidays[division] || [];
    const next = calendar.find(h => h.date > today && days(today, h.date) <= 60 && normallyOpen(h.date) && !blocks.some(b => closed(b) && covered(b, h.date)));
    if (next) {
      const past = calendar.filter(h => h.date >= shiftDate(today, -365) && h.date < today);
      const taken = past.filter(h => blocks.some(b => closed(b) && covered(b, h.date)) && !(byDay.get(h.date) || []).length);
      const worked = past.filter(h => (byDay.get(h.date) || []).length);
      const recorded = taken.length + worked.length;
      // An empty diary is not proof of choosing a day off. Require explicit closures.
      if (taken.length >= 2 && taken.length / recorded >= .67) {
        const booked = future.filter(a => dayOf(a.starts_at) === next.date).length;
        const evidence = [`You explicitly closed ${taken.length} of ${recorded} bank holidays with a recorded closure or completed visit in the last year.`,
          `Closed: ${taken.slice(-4).map(h => thoughtDay(h.date)).join(', ')}.`, `${next.title}: ${thoughtDay(next.date)} (${division.replaceAll('-', ' ')}).`,
          booked ? `${booked} existing booking${booked === 1 ? '' : 's'} on that day. These must stay in place.` : 'No active bookings recorded on that date.'];
        cards.push(base(`holiday-${next.date}`, 'holiday_habit', 'Keep your bank holiday?',
          `You chose time off on ${taken.length} recent bank holidays. ${next.title} is ${thoughtDay(next.date)}. ${booked ? 'You already have bookings, so let’s check those first.' : 'Would you like to keep this one for yourself too?'}`,
          evidence, next.date, { urgency: days(today, next.date) <= 10 ? 85 : 60, action_label: 'Review the day',
            action: { kind: 'protect_time', date: next.date, start_time: null, end_time: null, reason: 'bank_holiday', note: next.title },
            confidence: 'Based on your recorded days off', conflict_count: booked }));
      }
    }
  }

  // A repeated personal gap on the same weekday is evidence of a preference.
  const patterns = new Map();
  for (const b of blocks) {
    if (b.date < shiftDate(today, -84) || b.date >= today || closed(b) || b.type === 'extended' || b.reason !== 'personal' || !b.start_time || !b.end_time || (b.end_date && b.end_date !== b.date)) continue;
    const start = b.start_time.slice(0, 5), end = b.end_time.slice(0, 5);
    const length = Number(end.slice(0, 2)) * 60 + Number(end.slice(3)) - Number(start.slice(0, 2)) * 60 - Number(start.slice(3));
    if (length < 20 || length > 120) continue;
    const key = `${weekday(b.date)}-${start}-${end}`;
    if (!patterns.has(key)) patterns.set(key, { start, end, weekday: weekday(b.date), dates: new Set() });
    patterns.get(key).dates.add(b.date);
  }
  for (const p of [...patterns.values()].filter(p => p.dates.size >= 3).sort((a, b) => b.dates.size - a.dates.size).slice(0, 2)) {
    const date = Array.from({ length: 7 }, (_, i) => shiftDate(today, i + 1)).find(d => weekday(d) === p.weekday);
    const rows = byDay.get(date) || [];
    if (!rows.length || blocks.some(b => covered(b, date) && b.type !== 'extended')) continue;
    const overlaps = rows.some(a => a.starts_at.slice(11, 16) < p.end && a.ends_at.slice(11, 16) > p.start);
    if (overlaps) continue;
    cards.push(base(`personal-${date}-${p.start}`, 'personal_rhythm', 'Keep a little time for you',
      `You set aside ${p.start}–${p.end} on ${p.dates.size} recent ${new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' })}s. That space is still free on ${thoughtDay(date)}. Shall I protect it?`,
      [`${p.dates.size} explicit personal blocks at ${p.start}–${p.end} in the last 12 weeks.`, `Recorded on ${[...p.dates].slice(-4).map(thoughtDay).join(', ')}.`, `${rows.length} bookings on ${thoughtDay(date)}; none overlaps this space.`], date,
      { urgency: 75, action_label: 'Review this time', action: { kind: 'protect_time', date, start_time: p.start, end_time: p.end, reason: 'personal', note: 'Personal time' } }));
  }

  // More booked treatment time than this salon's own recent days, not a claim of stress.
  const lengths = rows => rows.reduce((sum, a) => sum + Math.max(0, (Date.parse(a.ends_at) - Date.parse(a.starts_at)) / 60000), 0);
  const historicDays = [...byDay].filter(([d]) => d < today && d >= shiftDate(today, -56));
  const usual = median(historicDays.map(([, rows]) => lengths(rows)));
  if (historicDays.length >= 8 && usual > 0) {
    const busy = [...byDay].filter(([d, rows]) => d > today && days(today, d) <= 7 && lengths(rows) >= Math.max(300, usual * 1.3)).sort(([a], [b]) => a.localeCompare(b))[0];
    if (busy) {
      const [date, rows] = busy, mins = Math.round(lengths(rows));
      cards.push(base(`busy-${date}`, 'busy_day', 'Get ahead of a fuller day',
        `${thoughtDay(date)} has ${mins} minutes of treatments booked, compared with ${Math.round(usual)} on your typical recent working day. Want to get the client preparation sorted now?`,
        [`${rows.length} active bookings, ${mins} treatment minutes on ${thoughtDay(date)}.`, `Median ${Math.round(usual)} treatment minutes across ${historicDays.length} recorded working days in the last eight weeks.`, 'Overlapping appointments can inflate treatment minutes; this is not a measure of stress.'], date,
        { urgency: 80, action_label: 'Prepare this day', action: { kind: 'care_day', date } }));
    }
  }

  // Regular visit cadence colliding with an explicit upcoming closure.
  const away = blocks.filter(b => closed(b) && b.date > today && days(today, b.date) <= 42 && days(b.date, b.end_date || b.date) >= 2).sort((a, b) => a.date.localeCompare(b.date))[0];
  if (away) {
    const booked = new Set(future.map(a => a.client_id));
    const matches = [];
    for (const c of clients) {
      if (c.blocked_at || c.archived_at || !c.first_name || booked.has(c.id)) continue;
      const visits = [...new Set(history.filter(a => a.client_id === c.id).map(a => dayOf(a.starts_at)))].sort();
      if (visits.length < 3) continue;
      const intervals = visits.slice(1).map((d, i) => days(visits[i], d));
      const usualGap = median(intervals);
      if (usualGap < 14 || usualGap > 120 || intervals.filter(g => Math.abs(g - usualGap) <= usualGap * .35).length / intervals.length < .75) continue;
      const due = shiftDate(visits.at(-1), usualGap);
      if (due < away.date || due > (away.end_date || away.date)) continue;
      matches.push({ id: c.id, first_name: c.first_name.slice(0, 60), last: visits.at(-1), due, interval_days: usualGap, visits: visits.length });
    }
    if (matches.length) cards.push(base(`away-${away.id}`, 'before_time_off', 'Look after your regulars before time off',
      `${matches.length} regular${matches.length === 1 ? '’s' : 's’'} usual visit timing falls during your ${thoughtDay(away.date)}–${thoughtDay(away.end_date)} closure. They have no upcoming booking. Want a gentle message ready to review?`,
      [`An explicit closure is recorded from ${away.date} to ${away.end_date}.`, ...matches.slice(0, 3).map(c => `${c.first_name}: ${c.visits} recorded visits, usually ${c.interval_days} days apart; next estimated around ${c.due}.`), 'Visit timing is an estimate, not a booking or permission to contact anyone.'], away.date,
      { urgency: 70, action_label: 'Prepare a thoughtful message', action: { kind: 'return_before_closure', closure_from: away.date, closure_to: away.end_date, clients: matches.slice(0, 5) } }));
  }
  return cards;
}
