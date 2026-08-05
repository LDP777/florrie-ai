/**
 * The pure half of booking: money arithmetic, wall clock formatting, and the
 * language a client uses to pick a slot.
 *
 * WHY THIS MODULE EXISTS
 * routes/booking.js is the source of truth for what a correct booking does,
 * but its rules were welded into an 850 line Express handler, reachable only
 * by an HTTP request carrying a Turnstile token. Booking a client from an
 * inbound WhatsApp message needs the same deposit arithmetic and the same
 * duration arithmetic, and the one thing that must never happen is a second
 * implementation of them drifting away from the first. So the arithmetic moved
 * here and BOTH callers import it. Nothing in this file touches the database,
 * the network or the clock, which is also why every rule in it is testable.
 *
 * WALL TIME
 * appointments.starts_at holds SALON WALL TIME inside a UTC slot: an 11:00
 * salon booking is stored as ...T11:00:00Z. Everything here reads that with
 * string slices and getUTC*, never getHours() and never an Intl conversion.
 * An Intl conversion here reads an hour out in BST, which is a client turning
 * up to a locked door.
 */

// ---------------------------------------------------------------------------
// Money and length
// ---------------------------------------------------------------------------

/**
 * Combined duration, buffer and price for a multi treatment booking.
 * Durations add up; buffers do NOT, the longest one wins, because a buffer is
 * cleanup time after the whole visit rather than after each item.
 */
export function combineTreatments(treatments) {
  const list = (treatments || []).filter(Boolean);
  const durationMinutes = list.reduce((sum, t) => sum + (t.duration_minutes || 0), 0);
  const bufferMinutes = list.length ? Math.max(...list.map(t => t.buffer_minutes || 0)) : 0;
  const priceCents = list.reduce((sum, t) => sum + (t.price_cents || 0), 0);
  return {
    durationMinutes,
    bufferMinutes,
    totalMinutes: durationMinutes + bufferMinutes,
    priceCents,
  };
}

/**
 * The deposit a booking must collect, in pence.
 *
 * Lifted verbatim out of POST /:slug/book so the booking page and the
 * conversational flow can never charge different amounts for the same
 * treatment. Rules, in order:
 *   1. Per treatment: a deposit_percent of the price beats a flat deposit_cents.
 *   2. If that comes to nothing, the salon's own configured deposit applies
 *      ('GBP 10' style or '50%'), because every booking secures a deposit by
 *      card whatever the balance is paid with. A salon that genuinely wants no
 *      deposit sets it to zero.
 *   3. A deposit can never exceed the price, which guards a misconfigured
 *      flat amount or percentage.
 *
 * payment_settings is free-form JSON typed by a human, so the amount is
 * coerced through String() before it is parsed. The original read it as a
 * string without checking, which throws on a numeric value.
 */
export function resolveDepositCents({ treatments, paymentSettings = {}, combinedPriceCents = null }) {
  const list = (treatments || []).filter(Boolean);
  const price = combinedPriceCents === null
    ? list.reduce((sum, t) => sum + (t.price_cents || 0), 0)
    : combinedPriceCents;

  let depositCents = list.reduce((sum, t) => {
    if (t.deposit_percent > 0 && t.price_cents > 0) {
      return sum + Math.round(t.price_cents * t.deposit_percent / 100);
    }
    return sum + (t.deposit_cents || 0);
  }, 0);

  if (depositCents === 0 && price > 0) {
    const raw = String(paymentSettings?.deposit_amount ?? '').trim() || '£10';
    if (raw.endsWith('%')) {
      const pct = parseInt(raw, 10);
      depositCents = Number.isFinite(pct) ? Math.round(price * pct / 100) : 0;
    } else {
      const pounds = parseFloat(raw.replace(/[£$€,\s]/g, ''));
      depositCents = Number.isFinite(pounds) ? Math.round(pounds * 100) : 0;
    }
  }

  if (price > 0) depositCents = Math.min(depositCents, price);
  return Math.max(0, depositCents);
}

// ---------------------------------------------------------------------------
// Wall clock rendering
// ---------------------------------------------------------------------------

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * '15:30' becomes '3.30pm', '16:00' becomes '4pm', '09:15' becomes '9.15am'.
 * Written so the reply claims guard can normalise it straight back to the
 * original 24h string: that round trip is what proves a spoken time came off
 * the verified list rather than out of the model.
 */
export function formatWallTime(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return '';
  const hour24 = Number(m[1]);
  const minute = Number(m[2]);
  const suffix = hour24 >= 12 ? 'pm' : 'am';
  let hour12 = hour24 % 12;
  if (hour12 === 0) hour12 = 12;
  return minute === 0 ? `${hour12}${suffix}` : `${hour12}.${m[2]}${suffix}`;
}

/**
 * 'Friday 7 August', or 'today' / 'tomorrow' when that reads more naturally.
 * todayWallDate is the salon's own 'YYYY-MM-DD', never the server's.
 */
export function formatWallDate(dateStr, todayWallDate = null) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return '';
  if (todayWallDate) {
    if (dateStr === todayWallDate) return 'today';
    const t = new Date(`${todayWallDate}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + 1);
    if (dateStr === t.toISOString().slice(0, 10)) return 'tomorrow';
  }
  const d = new Date(`${dateStr}T00:00:00Z`);
  const weekday = WEEKDAYS[d.getUTCDay()];
  return `${weekday[0].toUpperCase()}${weekday.slice(1)} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** 'Friday 7 August at 3.30pm', the phrase a reply actually contains. */
export function describeSlot(slot, todayWallDate = null) {
  return `${formatWallDate(slot.date, todayWallDate)} at ${formatWallTime(slot.time)}`;
}

// ---------------------------------------------------------------------------
// Which treatment did she mean?
// ---------------------------------------------------------------------------

// Words that carry no signal about which treatment is meant. Kept short: the
// job of this list is to stop "and", "the" and "treatment" matching every row,
// not to be a linguistics project.
const TREATMENT_STOPWORDS = new Set([
  'and', 'the', 'a', 'an', 'with', 'for', 'of', 'treatment', 'appointment',
  'full', 'set', 'mini', 'plus', 'inc', 'including',
]);

function treatmentTokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    // Crude singularisation so "lashes" finds "Lash" and "brows" finds "Brow".
    // Deliberately crude: a beauty menu is a few dozen short names.
    .map(w => (w.length > 3 && w.endsWith('es') ? w.slice(0, -2) : w))
    .map(w => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w))
    .filter(w => !TREATMENT_STOPWORDS.has(w));
}

/**
 * Resolve the treatment from what the client wrote.
 *
 * Scores each bookable treatment by how many of its own significant words the
 * client used. A clear single winner is resolved; a tie is AMBIGUOUS and gets
 * one question, never a guess. "any chance of lashes friday?" ties across
 * every lash treatment on the menu, which is exactly right: Florrie should
 * ask, because booking the wrong one wastes a chair.
 *
 * @returns {{treatment?: object, candidates: object[], ambiguous: boolean}}
 */
export function matchTreatment(text, treatments) {
  const said = new Set(treatmentTokens(text));
  const list = (treatments || []).filter(t => t && t.name);
  if (!said.size || !list.length) return { candidates: [], ambiguous: false };

  const scored = list.map(t => {
    const own = treatmentTokens(t.name);
    const hits = own.filter(w => said.has(w)).length;
    // Fraction matters as well as count: "Lash Lift" fully named beats
    // "Russian Volume Lash Extensions" catching one word.
    return { treatment: t, hits, coverage: own.length ? hits / own.length : 0 };
  }).filter(s => s.hits > 0);

  if (!scored.length) return { candidates: [], ambiguous: false };

  const best = Math.max(...scored.map(s => s.hits));
  let top = scored.filter(s => s.hits === best);
  if (top.length > 1) {
    // Coverage only settles a tie when a name was said in FULL. Using it as a
    // general tie-breaker made "lashes" resolve to Lash Lift purely because
    // that name is short, which is a guess wearing a score's clothes.
    const named = top.filter(s => s.coverage === 1);
    if (named.length) top = named;
  }

  if (top.length === 1) return { treatment: top[0].treatment, candidates: [top[0].treatment], ambiguous: false };
  return { candidates: top.map(s => s.treatment), ambiguous: true };
}

// ---------------------------------------------------------------------------
// Which day did she ask for?
// ---------------------------------------------------------------------------

const DAY_WORDS = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tues: 2, tue: 2,
  wednesday: 3, weds: 3, wed: 3,
  thursday: 4, thurs: 4, thur: 4, thu: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

/**
 * The days the client asked about, as wall dates, or null for "no preference".
 * fromWall is a wall frame Date (a Date whose UTC fields ARE the salon clock).
 * A named weekday means the NEXT one, today included, because "any chance of
 * lashes friday?" sent on a Friday morning means this Friday.
 */
export function dayPreferenceFrom(text, fromWall, horizonDays = 14) {
  const body = String(text || '').toLowerCase();
  if (!fromWall) return null;
  const today = new Date(Date.UTC(fromWall.getUTCFullYear(), fromWall.getUTCMonth(), fromWall.getUTCDate()));
  const dates = new Set();

  const push = (d) => dates.add(d.toISOString().slice(0, 10));

  if (/\btoday\b|\btonight\b/.test(body)) push(today);
  if (/\btomorrow\b|\btomoz\b|\btmrw\b/.test(body)) {
    const d = new Date(today); d.setUTCDate(d.getUTCDate() + 1); push(d);
  }

  const nextWeek = /\bnext week\b/.test(body);
  for (const [word, dow] of Object.entries(DAY_WORDS)) {
    if (!new RegExp(`\\b${word}\\b`).test(body)) continue;
    const d = new Date(today);
    let delta = (dow - d.getUTCDay() + 7) % 7;
    // "next week" pushes past this coming one. Anything vaguer is left alone:
    // narrowing to the wrong week is worse than not narrowing at all.
    if (nextWeek) delta += 7;
    d.setUTCDate(d.getUTCDate() + delta);
    push(d);
  }

  // "the 13th", "friday 13th": a day of month inside the horizon.
  for (const m of body.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)\b/g)) {
    const dom = Number(m[1]);
    if (dom < 1 || dom > 31) continue;
    for (let i = 0; i <= horizonDays; i++) {
      const d = new Date(today); d.setUTCDate(d.getUTCDate() + i);
      if (d.getUTCDate() === dom) { push(d); break; }
    }
  }

  return dates.size ? Array.from(dates).sort() : null;
}

// ---------------------------------------------------------------------------
// Choosing what to offer
// ---------------------------------------------------------------------------

function groupByDate(slots) {
  const groups = [];
  const index = new Map();
  for (const s of slots) {
    if (!index.has(s.date)) { index.set(s.date, []); groups.push({ date: s.date, slots: index.get(s.date) }); }
    index.get(s.date).push(s);
  }
  return groups;
}

/** First, last and evenly spaced in between, so one day still reads as a choice. */
function spreadWithin(daySlots, n) {
  if (daySlots.length <= n) return daySlots.slice();
  if (n <= 1) return [daySlots[0]];
  const out = [];
  for (let i = 0; i < n; i++) {
    const pick = daySlots[Math.round(i * (daySlots.length - 1) / (n - 1))];
    if (!out.includes(pick)) out.push(pick);
  }
  return out;
}

/**
 * Two to four genuinely free times, never the whole diary.
 *
 * A wall of times is not an offer, it is a menu, and it invites the client to
 * name a time that is not on it. Small and spread is easier to answer and
 * easier to verify. Every slot returned came from getFreeSlots, so every time
 * in the reply is one the claims guard will accept.
 *
 * @returns {{offers: object[], narrowedToRequestedDays: boolean}}
 */
export function chooseOffers(slots, { dates = null, max = 3 } = {}) {
  const all = (slots || []).filter(s => s && s.iso);
  if (!all.length) return { offers: [], narrowedToRequestedDays: false };

  const wanted = dates?.length ? all.filter(s => dates.includes(s.date)) : [];
  const pool = wanted.length ? wanted : all;
  const groups = groupByDate(pool);

  let picks;
  if (groups.length === 1) {
    picks = spreadWithin(groups[0].slots, max);
  } else {
    picks = [];
    for (const g of groups) { if (picks.length >= max) break; picks.push(g.slots[0]); }
    for (const g of groups) {
      if (picks.length >= max) break;
      const last = g.slots[g.slots.length - 1];
      if (!picks.includes(last)) picks.push(last);
    }
    picks.sort((a, b) => (a.iso < b.iso ? -1 : 1));
  }

  return {
    offers: picks.slice(0, max),
    narrowedToRequestedDays: Boolean(dates?.length) && wanted.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Which one did she pick?
// ---------------------------------------------------------------------------

const WORD_HOURS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

// A salon does not open at four in the morning, so a bare hour under eight is
// the afternoon. Same assumption the reply claims guard makes, deliberately:
// the two must agree or a time Florrie offered could be refused on the way out.
function salonHour(h) {
  return h < 8 ? h + 12 : h;
}

const hhmm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

/**
 * Every clock time a client's reply could plausibly mean.
 *
 * Deliberately different from the guard's extractor, which is greedy because a
 * false positive there only costs a holding reply. Here a false positive can
 * select the WRONG slot, so each pattern eats the text it matched before the
 * next one runs: "half 3" is consumed as 15:30 and never re-read as a bare 3.
 */
export function timeCandidates(text) {
  let body = ` ${String(text || '').toLowerCase()} `;
  const found = new Set();
  const eat = (re, fn) => {
    body = body.replace(re, (...args) => {
      const value = fn(...args);
      if (value) found.add(value);
      return ' ';
    });
  };

  const hourOf = (token) => {
    if (WORD_HOURS[token] !== undefined) return WORD_HOURS[token];
    const n = Number(token);
    return Number.isInteger(n) && n >= 1 && n <= 23 ? n : null;
  };

  // "half four", "half past 3", "quarter past four", "quarter to five".
  eat(/\b(half past|half|quarter past|quarter to)\s+([a-z]+|\d{1,2})\b/g, (_all, phrase, token) => {
    const base = hourOf(token);
    if (base === null) return null;
    const h = salonHour(base);
    if (phrase === 'quarter to') return hhmm(h - 1, 45);
    if (phrase === 'quarter past') return hhmm(h, 15);
    return hhmm(h, 30);
  });

  // A date ordinal is not a clock time. Eaten before bare numbers are read.
  eat(/\b\d{1,2}(?:st|nd|rd|th)\b/g, () => null);

  // "4.30", "4:30pm", "16:30".
  eat(/\b(\d{1,2})[.:](\d{2})\s*(am|pm)?\b/g, (_all, h, m, suffix) => {
    let hour = Number(h);
    const minute = Number(m);
    if (minute > 59) return null;
    if (suffix === 'pm' && hour < 12) hour += 12;
    else if (suffix === 'am' && hour === 12) hour = 0;
    else if (!suffix) hour = salonHour(hour);
    return hour > 23 ? null : hhmm(hour, minute);
  });

  // "4pm", "11 am".
  eat(/\b(\d{1,2})\s*(am|pm)\b/g, (_all, h, suffix) => {
    let hour = Number(h);
    if (hour > 12) return null;
    if (suffix === 'pm' && hour < 12) hour += 12;
    if (suffix === 'am' && hour === 12) hour = 0;
    return hhmm(hour, 0);
  });

  // Whatever bare number is left: "the 4 one", "make it 7".
  eat(/\b(\d{1,2})\b/g, (_all, h) => {
    const n = Number(h);
    if (n < 1 || n > 23) return null;
    return hhmm(salonHour(n), 0);
  });

  return Array.from(found);
}

const ORDINALS = {
  first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3,
  fourth: 4, '4th': 4, fifth: 5, '5th': 5,
};

const REJECTIONS = [
  /\bnone of (?:those|them|these)\b/i,
  /\bnothing (?:works|suits|there)\b/i,
  /\bcan(?:'|no)?t do (?:any|either|those|them)\b/i,
  /\bany(?:thing)? (?:else|other|later|earlier)\b/i,
  /\bno good\b/i,
  /\bdoesn'?t work\b/i,
  /\bdon'?t work\b/i,
];

export function looksLikeRejection(text) {
  const body = String(text || '');
  return REJECTIONS.some(p => p.test(body));
}

const BARE_YES = /^\s*(?:yes|yeah|yep|yh|ok|okay|please|yes please|that one|perfect|lovely|great|sounds good|go on|do it|book it|sure)[\s.!,]*$/i;

/**
 * Turn "the 4 one" into the slot Florrie actually offered.
 *
 * The whole design rests on this only ever returning a slot that is IN the
 * offered list. It never invents, never rounds to the nearest, and returns
 * ambiguous rather than guessing, because guessing books the wrong hour and
 * that is the same class of harm as the 28 Jul incident.
 *
 * @returns {{slot?: object, ambiguous?: boolean, rejected?: boolean,
 *            unclear?: boolean, candidates?: object[]}}
 */
export function matchSlotChoice(text, offered, { fromWall = null } = {}) {
  const list = (offered || []).filter(s => s && s.iso);
  if (!list.length) return { unclear: true };
  const body = String(text || '').toLowerCase();

  if (looksLikeRejection(body)) return { rejected: true };
  if (list.length === 1 && BARE_YES.test(body)) return { slot: list[0] };

  // "the last one" / "the second one". Position, not clock time, so it is read
  // before any number is treated as an hour.
  if (/\b(?:the\s+)?(?:last|final|latest)\s*(?:one|slot|time)?\b/.test(body)) {
    return { slot: list[list.length - 1] };
  }
  for (const [word, position] of Object.entries(ORDINALS)) {
    if (!new RegExp(`\\b${word}\\b`).test(body)) continue;
    if (position <= list.length) return { slot: list[position - 1] };
    return { ambiguous: true, candidates: list };
  }

  let pool = list;

  const days = dayPreferenceFrom(body, fromWall);
  if (days?.length) {
    const byDay = pool.filter(s => days.includes(s.date));
    // A day she never offered is not a pick, it is a new request.
    if (!byDay.length) return { unclear: true, wantedDates: days };
    pool = byDay;
  }

  const times = timeCandidates(body);
  if (times.length) {
    let byTime = pool.filter(s => times.includes(s.time));

    // "the 3 one" when the offer was 3.30pm. A bare hour reads as o'clock, so
    // an exact match finds nothing, and Florrie used to ask again. She is not
    // wrong to be careful, but a person offered "3.30pm, 4pm or 7pm" who says
    // "the 3 one" means the 3.30, and being asked twice reads as not listening.
    //
    // Only when the hour lands on exactly ONE offered slot. Offer both 3pm and
    // 3.30pm and this stays ambiguous, because at that point "the 3 one"
    // genuinely is, and booking the wrong half hour and taking a deposit for it
    // is the same class of harm as naming a time that was never free.
    if (!byTime.length) {
      const hours = new Set(times.map(t => t.slice(0, 2)));
      const withinHour = pool.filter(s => hours.has(s.time.slice(0, 2)));
      if (withinHour.length === 1) byTime = withinHour;
    }

    if (!byTime.length) return { unclear: true, wantedTimes: times };
    pool = byTime;
  } else if (!days?.length) {
    return { unclear: true };
  }

  if (pool.length === 1) return { slot: pool[0] };
  return { ambiguous: true, candidates: pool };
}

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

/**
 * Is this stored negotiation still the one we are having?
 *
 * An offer nobody answered is dead within a day: the diary has moved on, and a
 * week old "the 4 one" landing on a fresh "hi" would book a slot nobody asked
 * for. Expiry is checked here as well as in the query so the rule is testable
 * without a database and cannot be lost to a filter being dropped.
 */
export function isLive(row, now = new Date()) {
  if (!row?.expires_at) return false;
  return new Date(row.expires_at).getTime() > now.getTime();
}
