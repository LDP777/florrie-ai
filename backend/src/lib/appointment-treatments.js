/**
 * Working out an appointment's length and price when its treatments change.
 *
 * WHY THIS IS ITS OWN FILE
 * Ellie could not add a second treatment to a booking at all. The only control
 * on the sheet was a "Change" dropdown that swapped the single treatment_id,
 * and a patch test has no treatment_id to swap, so the dropdown was pointing at
 * nothing. Adding an infill to a patch test was impossible, and every other
 * multi-treatment appointment meant she did the arithmetic herself and typed a
 * new length in by hand.
 *
 * The sums live here, away from the route, because the wall-time rule below is
 * the one thing in this codebase that silently produces a wrong answer an hour
 * out for half the year. It needs tests that do not touch Supabase.
 *
 * WALL-TIME CONVENTION (read this before touching endsAtWall)
 * appointments.starts_at holds SALON WALL TIME sitting inside a UTC-shaped
 * slot. "2026-08-05T10:00:00" means ten in the morning in the salon, in August,
 * during British Summer Time. It is NOT ten o'clock UTC. So the only safe way
 * to add minutes is to pull the digits out of the string, do the arithmetic in
 * the UTC frame (which has no daylight saving to trip over), and write the
 * digits straight back. new Date(str).toISOString() would move every summer
 * appointment an hour and quietly rewrite her diary.
 */

/** Minutes, coerced from whatever the database handed back. */
function mins(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The treatment time that belongs to the appointment itself, before extras.
 *
 * For a normal booking that is simply the base treatment's length. For a patch
 * test there IS no base treatment, so the appointment row is the only record of
 * how long it takes. We take the stored total and subtract whatever extras are
 * currently attached, which leaves the patch test's own ten minutes.
 *
 * That subtraction is what makes the operation repeatable. Without it, adding a
 * 45-minute infill to a 10-minute patch test gives 55, and then REMOVING the
 * infill would read the stored 55 as "the patch test", leaving her with a
 * 55-minute patch test she never booked. Every add would compound.
 *
 * @param {{duration_minutes?: number, price_cents?: number}} existing appointment row
 * @param {Array<object>} currentExtras treatments currently in extra_treatment_ids
 * @returns {{durationMinutes: number, priceCents: number}}
 */
export function ownTotals(existing, currentExtras = []) {
  const attachedDuration = currentExtras.reduce((s, t) => s + mins(t?.duration_minutes), 0);
  const attachedPrice = currentExtras.reduce((s, t) => s + mins(t?.price_cents), 0);
  return {
    // Never negative: legacy rows can have a duration that does not reconcile
    // with their extras, and a negative base would make the new total nonsense.
    durationMinutes: Math.max(0, mins(existing?.duration_minutes) - attachedDuration),
    priceCents: Math.max(0, mins(existing?.price_cents) - attachedPrice),
  };
}

/**
 * Recompute an appointment's length and price from the WHOLE set of treatments.
 *
 * duration_minutes is treatment time only, exactly as the existing
 * duration_minutes path in routes/appointments.js stores it. Buffer and extra
 * padding are not folded in here; they are added on top when the slot is
 * blocked out, which is what blockMinutes is for.
 *
 * @param {object} args
 * @param {object|null} args.baseTreatment the row for appointment.treatment_id, null for a patch test
 * @param {Array<object>} args.extraTreatments rows for the NEW extra_treatment_ids
 * @param {object} args.existing the appointment row (duration_minutes, price_cents, buffer_minutes, extra_padding_minutes)
 * @param {Array<object>} [args.currentExtras] rows for the extras already attached, so a patch test keeps its own time
 * @returns {{durationMinutes: number, priceCents: number, blockMinutes: number}}
 */
export function recomputeTotals({ baseTreatment, extraTreatments = [], existing = {}, currentExtras = [] }) {
  const base = baseTreatment
    ? { durationMinutes: mins(baseTreatment.duration_minutes), priceCents: mins(baseTreatment.price_cents) }
    : ownTotals(existing, currentExtras);

  const durationMinutes = base.durationMinutes
    + extraTreatments.reduce((s, t) => s + mins(t?.duration_minutes), 0);
  const priceCents = base.priceCents
    + extraTreatments.reduce((s, t) => s + mins(t?.price_cents), 0);

  // The slot she loses in the diary is the treatment time plus her turnaround.
  // Same composition as every other ends_at in routes/appointments.js.
  const blockMinutes = durationMinutes
    + mins(existing?.buffer_minutes)
    + mins(existing?.extra_padding_minutes);

  return { durationMinutes, priceCents, blockMinutes };
}

const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

/**
 * starts_at plus minutes, answered in the same wall frame it was given in.
 *
 * @param {string} startsAt stored wall-clock string, e.g. "2026-08-05T10:00:00"
 * @param {number} totalMinutes minutes to add (treatment time plus buffers)
 * @returns {string|null} "YYYY-MM-DDTHH:MM:00", or null if the start is unreadable
 */
export function endsAtWall(startsAt, totalMinutes) {
  const m = String(startsAt || '').match(WALL);
  if (!m) return null;
  const [, yy, mo, dd, hh, mi] = m;
  // Date.UTC has no daylight saving, so this is pure minute arithmetic on the
  // digits. Read the parts back with the getUTC* family for the same reason:
  // getHours() would answer in whatever timezone the server happens to run in.
  const end = new Date(Date.UTC(Number(yy), Number(mo) - 1, Number(dd), Number(hh), Number(mi) + mins(totalMinutes)));
  const p = (n) => String(n).padStart(2, '0');
  return `${end.getUTCFullYear()}-${p(end.getUTCMonth() + 1)}-${p(end.getUTCDate())}T${p(end.getUTCHours())}:${p(end.getUTCMinutes())}:00`;
}

/**
 * Validate an extra_treatment_ids body value.
 *
 * Returns the ids to store (null when she has cleared them all, so "no extras"
 * has one representation in the column rather than two), or an error message
 * fit to show her.
 *
 * @param {unknown} value req.body.extra_treatment_ids
 * @returns {{ok: true, ids: string[], store: string[]|null} | {ok: false, error: string}}
 */
export function parseExtraTreatmentIds(value) {
  if (value === null) return { ok: true, ids: [], store: null };
  if (!Array.isArray(value)) {
    return { ok: false, error: 'Extra treatments must be a list.' };
  }
  // A cap, because the length feeds a clash check and an unbounded list is an
  // unbounded number of ownership queries per request.
  if (value.length > 10) {
    return { ok: false, error: 'That is too many treatments for one appointment.' };
  }
  const ids = [];
  for (const raw of value) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      return { ok: false, error: 'One of those treatments was not recognised.' };
    }
    ids.push(raw.trim());
  }
  return { ok: true, ids, store: ids.length > 0 ? ids : null };
}

/**
 * How the appointment reads to Ellie once it has more than one treatment,
 * e.g. "Patch test + Lash infill". Shared so the sheet, the day list and the
 * week rows cannot drift apart on it.
 *
 * @param {string} baseName the base treatment name, or "Patch test"
 * @param {string[]} extraNames names of the extras, in order
 */
export function treatmentSetLabel(baseName, extraNames = []) {
  return [baseName, ...extraNames].filter(Boolean).join(' + ');
}
