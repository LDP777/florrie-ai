import { supabase } from '../config.js';

/**
 * FREE SLOTS, IN THE SALON WALL FRAME.
 *
 * appointments.starts_at / ends_at store SALON WALL TIME inside the UTC slot
 * (an 11:00 salon booking is saved as ...T11:00:00Z). Every comparison in this
 * file therefore happens in that same "wall frame": a Date whose UTC fields ARE
 * the wall clock. Mixing a real UTC "now" into this frame is what made
 * patch-test slots ignore the real diary and drift by an hour in BST, so read
 * with getUTC* and slice(11, 16), never getHours() and never Intl conversion.
 *
 * This lived inside routes/booking.js, where only the booking page could reach
 * it. On 28 Jul 2026 Florrie told a client "4.30 on Thursday is available"
 * because the reply prompts had no diary at all: the correct generator existed
 * three files away and was never called. It is shared now so the AI front desk
 * answers from the same source of truth the booking page does.
 */

const WALL_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// How far back to look for a closure that started before the window and is still
// running. A year covers any real salon closure; anything longer is a data entry
// mistake, not a holiday.
const MAX_BLOCK_LOOKBACK_DAYS = 366;

/** The lower bound a hours_exceptions query needs to catch a closure already in progress. */
export function blockLookbackFrom(day) {
  return shiftDay(day, -MAX_BLOCK_LOOKBACK_DAYS);
}

/** Shift a YYYY-MM-DD wall day by n days, staying in the wall frame. */
function shiftDay(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "Now", rendered in the salon's wall clock, in the wall frame. */
export function nowInSalonWall(timezone = 'Europe/London') {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  return new Date(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
}

/** Working hours for the day a wall-frame Date falls on. null = salon closed. */
/**
 * Ellie's personal blocks live in hours_exceptions (a date plus an optional
 * start/end wall time; no range = the whole day is closed). The public picker
 * respected them but the patch-test slot generator did not, so a client could
 * book a patch test straight over a block. Load them once, in the wall frame.
 */
export async function loadBlocks(beauticianId, fromWall, toWall) {
  const from = fromWall.toISOString().slice(0, 10);
  const to = toWall.toISOString().slice(0, 10);

  // A block is a RANGE, date..end_date, not a single day. This used to filter
  // on `date` alone, so a holiday entered as 24 to 30 August closed the 24th
  // and left the other six days bookable.
  //
  // The row that matters may START before the window (a fortnight off that began
  // last Tuesday still closes today), so the lower bound is widened by
  // MAX_BLOCK_LOOKBACK_DAYS and the exact date..end_date test is done in JS
  // below. A plain range predicate would need `coalesce(end_date, date)`, which
  // PostgREST cannot express without an `or(...)` string, and a malformed one of
  // those fails the whole availability lookup.
  const { data: rows, error } = await supabase
    .from('hours_exceptions')
    .select('date, end_date, type, start_time, end_time')
    .eq('beautician_id', beauticianId)
    .gte('date', blockLookbackFrom(from))
    .lte('date', to);

  // A failed block lookup used to come back as `rows = null`, which reads as
  // "she has no days off" and offers her holiday to a client. Throw instead:
  // every caller already treats a thrown lookup as "I could not check".
  if (error) throw new Error(`hours_exceptions lookup failed: ${error.message}`);

  const closedDays = new Set();
  const intervals = [];
  for (const r of rows || []) {
    // Walk the row's own days, clamped to the window so one long range cannot
    // expand into thousands of entries. Filtering here as well as in the query
    // keeps this correct even if the query ever comes back wider than asked.
    for (const day of blockDays(r, from, to)) {
      if (r.type !== 'closed' && r.start_time && r.end_time) {
        intervals.push({
          start: new Date(`${day}T${String(r.start_time).slice(0, 5)}:00Z`),
          end: new Date(`${day}T${String(r.end_time).slice(0, 5)}:00Z`),
        });
      } else {
        closedDays.add(day); // whole day off
      }
    }
  }
  return { closedDays, intervals };
}

/** The last day a block covers. Null/blank end_date, or one before the start, = a single day. */
export function blockEndDate(row) {
  const start = String(row?.date || '').slice(0, 10);
  const end = String(row?.end_date || '').slice(0, 10);
  return end && end >= start ? end : start;
}

/** Does a date..end_date block cover this YYYY-MM-DD wall day? */
export function blockCoversDay(row, day) {
  const start = String(row?.date || '').slice(0, 10);
  if (!start) return false;
  return start <= day && day <= blockEndDate(row);
}

/** Every YYYY-MM-DD a block covers, clamped to [from, to]. */
export function blockDays(row, from, to) {
  const start = String(row?.date || '').slice(0, 10);
  if (!start) return [];
  const first = start > from ? start : from;
  const last = (() => { const e = blockEndDate(row); return e < to ? e : to; })();
  const days = [];
  // Step in the wall frame (UTC fields ARE the wall clock), never with getDate().
  const cursor = new Date(`${first}T00:00:00Z`);
  const stop = new Date(`${last}T00:00:00Z`);
  while (cursor <= stop) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

export function hitsBlock(slotStart, slotEnd, blocks) {
  if (blocks.closedDays.has(slotStart.toISOString().slice(0, 10))) return true;
  return blocks.intervals.some(b => slotStart < b.end && slotEnd > b.start);
}

export function wallDayHours(workingHours, wallDate) {
  const k = WALL_DAYS[wallDate.getUTCDay()];
  const h = workingHours?.[k] || workingHours?.[k[0].toUpperCase() + k.slice(1)];
  return h && h.start && h.end ? h : null;
}

// Cancelled and no-show rows must never hold a slot hostage: the whole point of
// cancelling is that the time comes back.
const FREE_SLOT_IGNORED_STATUSES = '(cancelled,cancelled_by_client,cancelled_by_beautician,no_show)';

/**
 * The appointments that must NOT count as busy for this question.
 *
 * A client moving her 1pm to 1.30pm is blocked by her own booking otherwise:
 * the diary quite correctly says 1pm to 2pm is taken, and the thing taking it
 * is the very appointment she is trying to move. The back-to-back reschedule
 * path has always known this and excludes with `.neq('id', appt.id)`; this is
 * the same rule, written once, so both paths mean the same thing by it.
 *
 * Ids are compared as strings because a uuid is a string on both sides and a
 * stray number would otherwise slip through a `===`.
 */
export function excludedAppointmentIds(ids) {
  if (ids === null || ids === undefined) return new Set();
  const list = Array.isArray(ids) ? ids : [ids];
  return new Set(list.filter(Boolean).map(String));
}

/**
 * Every genuinely free slot in the diary, verified against working hours, her
 * hours_exceptions blocks and the real bookings. This is the ONLY list a reply
 * is allowed to quote a time from.
 *
 * @param {string} beauticianId
 * @param {object} opts
 * @param {object} opts.workingHours   beauticians.working_hours, keyed sun..sat
 * @param {string} [opts.timezone]     salon timezone, for "now" only
 * @param {number} [opts.durationMinutes]  length the slot must accommodate
 * @param {Date}   [opts.fromWall]     wall-frame start, defaults to now
 * @param {number} [opts.days]         how far ahead to scan
 * @param {number} [opts.leadHours]    minimum notice before the first slot
 * @param {number} [opts.maxSlots]     hard cap so a quiet diary cannot run away
 * @param {string|string[]} [opts.excludeAppointmentIds]  appointment(s) that must
 *        not count as busy, because they are the ones being moved. Without this
 *        a client rescheduling 1pm to 1.30pm is blocked by her own booking.
 * @returns {Promise<Array<{iso: string, date: string, time: string}>>}
 */
export async function getFreeSlots(beauticianId, {
  workingHours,
  timezone = 'Europe/London',
  durationMinutes = 60,
  fromWall = null,
  days = 7,
  leadHours = 1,
  maxSlots = 200,
  excludeAppointmentIds = null,
} = {}) {
  if (!beauticianId) return [];

  const hours = workingHours || {};
  const startWall = fromWall || nowInSalonWall(timezone);
  const scanEnd = new Date(startWall.getTime() + days * 24 * 60 * 60 * 1000);

  // Look back a day as well: an appointment that started this morning and runs
  // long still blocks this afternoon, and filtering on starts_at alone misses it.
  const busyFrom = new Date(startWall.getTime() - 24 * 60 * 60 * 1000);

  const excluded = excludedAppointmentIds(excludeAppointmentIds);

  const { data: existing, error: busyError } = await supabase
    .from('appointments')
    .select('id, starts_at, ends_at')
    .eq('beautician_id', beauticianId)
    .not('status', 'in', FREE_SLOT_IGNORED_STATUSES)
    .gte('starts_at', busyFrom.toISOString())
    .lte('starts_at', scanEnd.toISOString())
    .order('starts_at', { ascending: true });

  // THE DANGEROUS FAILURE. PostgREST returns its errors in the result object
  // rather than throwing, so an unchecked destructure leaves `existing` null,
  // `busy` empty, and EVERY hour of the day looking free. That does not fail
  // quietly, it fails loudly at the client: Florrie offers a time somebody is
  // already sitting in the chair for. A thrown error becomes "let me check my
  // book and come back to you", which is always safe.
  if (busyError) throw new Error(`appointments lookup failed: ${busyError.message}`);

  // The exclusion is applied HERE, in JS, rather than as another PostgREST
  // filter: one place, one meaning, and it cannot be silently dropped by a
  // query builder that never saw the option.
  const busy = (existing || [])
    .filter(a => a.starts_at && a.ends_at)
    .filter(a => !excluded.has(String(a.id)))
    .map(a => ({ start: new Date(a.starts_at), end: new Date(a.ends_at) }));

  const blocks = await loadBlocks(beauticianId, startWall, scanEnd);

  // Same walk as the patch-test generator: quarter-hour granularity, because
  // that is the grain the booking page offers and a reply must not offer a time
  // the client then cannot pick.
  const cursor = new Date(startWall.getTime() + leadHours * 60 * 60 * 1000);
  cursor.setUTCSeconds(0, 0);
  const cm = cursor.getUTCMinutes();
  if (cm % 15 !== 0) cursor.setUTCMinutes(Math.ceil(cm / 15) * 15, 0, 0);

  const slots = [];
  while (cursor < scanEnd && slots.length < maxSlots) {
    const slotEnd = new Date(cursor.getTime() + durationMinutes * 60 * 1000);
    const dh = wallDayHours(hours, cursor);
    if (dh) {
      const [sh, sm] = dh.start.split(':').map(Number);
      const [eh, em] = dh.end.split(':').map(Number);
      const dayOpen = new Date(cursor); dayOpen.setUTCHours(sh, sm, 0, 0);
      const dayShut = new Date(cursor); dayShut.setUTCHours(eh, em, 0, 0);

      if (cursor >= dayOpen && slotEnd <= dayShut) {
        const clash = busy.some(b => cursor < b.end && slotEnd > b.start)
          || hitsBlock(cursor, slotEnd, blocks);
        if (!clash) {
          const iso = cursor.toISOString();
          // slice, not any Date accessor: the wall clock is already in the string.
          slots.push({ iso, date: iso.slice(0, 10), time: iso.slice(11, 16) });
        }
      }
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 15);
  }

  return slots;
}
