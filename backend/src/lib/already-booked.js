/**
 * Florrie does not offer somebody a time for a thing they are already booked in for.
 *
 * 1 September 2026, 21:26, Instagram. A new client, warmly, and slightly
 * frightened:
 *
 *   "Hey lovely, I hope you're okay! Just to let you know I've just booked in
 *    for a Korean lash lift on the 9th Sept at 11am. Super nervous as I've been
 *    a lash extension girly for as long as I can remember. When would you be
 *    free for a patch test? Xx"
 *
 * Florrie:
 *
 *   "For Korean lash lift I've got Wednesday 9 September at 1.45pm or 2pm.
 *    Which one suits you? There's a quick patch test to do at least 24 hours
 *    before, I'll sort that with you once the deposit is in."
 *
 * She had booked. She said so in her first sentence. She was told about slots
 * on the same day she is already booked on, at times that are not hers, and
 * then told her deposit was outstanding. Read as a customer, that message says
 * your booking did not go through and you owe us money. She asked one question,
 * about a patch test, and it was not answered.
 *
 * THE TEXT GATE WAS THERE AND IT MISSED BY ONE PHRASE. lib/booking-rules.js
 * already refuses to open a booking on "I'm booked" and "already booked". She
 * wrote "I've just booked in". Widening that pattern is worth doing and is not
 * the fix, because the next client will phrase it a third way.
 *
 * THE DIARY IS THE FIX. Her appointment was in it, on the date she named, for
 * the treatment she named. No sentence she could have written would have made
 * that untrue, and no sentence she could have written would have made it true
 * either. So the question this module asks is not "do these words sound like
 * an existing booking" but "is she already booked for this".
 *
 * DELIBERATELY NARROW. A client with a lash lift booked may perfectly well want
 * to add a wax, and refusing every booking conversation from anyone with
 * anything in the diary would cost Ellie the bookings this feature exists to
 * win. It fires only when the treatment she is naming is one she already has
 * coming up. Wanting to MOVE that booking is a reschedule, which is a different
 * intent with its own flow, and this does not touch it.
 */
import { matchTreatment } from './booking-rules.js';

/** Appointment statuses that mean a slot is really hers. */
const REAL = new Set(['confirmed', 'pending']);

/**
 * Is this client already booked for the treatment she is talking about.
 *
 * @param {object} a
 * @param {string} a.message the client's own words
 * @param {Array<{id?:string, starts_at?:string, status?:string, treatments?:{name?:string}}>} a.clientUpcoming
 *   context.clientUpcoming: her bookings, confirmed or pending, from twelve
 *   hours ago to ninety days out.
 * @param {Array<{name?:string}>} a.treatments the salon's bookable menu
 * @returns {{booked: boolean, appointment: object|null, treatmentName: string|null}}
 */
export function alreadyBookedForThis({ message, clientUpcoming, treatments = [] }) {
  const rows = (Array.isArray(clientUpcoming) ? clientUpcoming : [])
    .filter((a) => a && REAL.has(String(a.status || '').toLowerCase()));
  if (rows.length === 0) return { booked: false, appointment: null, treatmentName: null };

  // What she named, read with the salon's own menu so "Korean lash lift",
  // "korean lift" and "the korean one" all land on the same treatment. Reusing
  // matchTreatment means this cannot drift from what the booking flow itself
  // would have matched, which is the whole point: if the booker would have
  // offered slots for it, this has to recognise it.
  const named = matchTreatment(message, treatments);
  const wanted = named?.treatment?.name;
  if (!wanted) return { booked: false, appointment: null, treatmentName: null };

  const key = normalise(wanted);
  const hit = rows.find((a) => normalise(a?.treatments?.name) === key);
  if (!hit) return { booked: false, appointment: null, treatmentName: null };

  return { booked: true, appointment: hit, treatmentName: hit?.treatments?.name || wanted };
}

function normalise(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
