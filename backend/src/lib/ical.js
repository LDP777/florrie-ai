/**
 * iCalendar primitives, in one place.
 *
 * These lived inside routes/calendar.js, which serves Ellie's whole diary as a
 * subscribable feed. A client's single appointment needs exactly the same
 * escaping, folding and VTIMEZONE and none of the feed, so they move here and
 * routes/calendar.js imports them rather than the other way round — a route
 * file that other code has to import to get at a helper is a route file that
 * will one day be imported for its side effects.
 */

/** Statuses that mean the appointment is not happening. */
export const DEAD_STATUSES = ['cancelled', 'cancelled_by_client', 'cancelled_by_beautician', 'no_show'];

/** Escape a value for an iCal text field (RFC 5545 3.3.11). */
export function esc(v) {
  return String(v == null ? '' : v)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * "2026-06-12T14:00:00..." -> "20260612T140000" (local, no Z).
 *
 * The wall clock is kept deliberately. starts_at holds salon wall time in the
 * UTC slot, so converting here would move a 6pm appointment to 7pm in summer —
 * which is precisely the failure a client would notice and nobody would
 * believe.
 */
export function toICalLocal(isoish) {
  const s = String(isoish || '');
  const date = s.slice(0, 10).replace(/-/g, '');
  const time = s.slice(11, 19).replace(/:/g, '') || '000000';
  return `${date}T${time.padEnd(6, '0')}`;
}

/** UTC stamp for DTSTAMP / LAST-MODIFIED (this one IS a real instant). */
export function utcStamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Fold long lines to 75 octets per RFC 5545 (simple char-based fold). */
export function fold(line) {
  if (line.length <= 73) return line;
  const out = [];
  let s = line;
  out.push(s.slice(0, 73));
  s = s.slice(73);
  while (s.length > 72) {
    out.push(' ' + s.slice(0, 72));
    s = s.slice(72);
  }
  if (s.length) out.push(' ' + s);
  return out.join('\r\n');
}

// A static VTIMEZONE for Europe/London so calendar apps render GMT/BST
// correctly without us doing any offset maths. Standard UK DST rules.
export const VTIMEZONE_LONDON = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/London',
  'X-LIC-LOCATION:Europe/London',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0000',
  'TZOFFSETTO:+0100',
  'TZNAME:BST',
  'DTSTART:19700329T010000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0000',
  'TZNAME:GMT',
  'DTSTART:19701025T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
];

/**
 * One appointment, as a calendar file a client can open.
 *
 * Why this exists at all: a client messaged Ellie the day before her
 * appointment asking "I have an appointment with you tomorrow at 6pm correct?
 * I can't seem to find all my bookings on the florrie app." Ellie's answer was
 * "type florrie into WhatsApp or your emails" — which is the honest answer and
 * also the whole problem. The only record a client had was a text message she
 * had to go and search for.
 *
 * A confirmation with one of these attached lands in the phone's own calendar,
 * where she was going to look anyway, and brings its own reminder with it.
 *
 * Deliberately NOT included: notes of any kind. `client_notes` on the public
 * booking page has been found holding the JSON of consultation answers —
 * allergies, medication — and this file gets forwarded, synced and backed up
 * to wherever her calendar lives. The same reasoning already keeps it out of
 * Ellie's diary feed.
 */
export function appointmentIcs({
  id, startsAt, endsAt, treatmentName, businessName, location, manageUrl,
  cancelled = false, sequence = 0,
}) {
  const summary = businessName ? `${treatmentName || 'Appointment'} at ${businessName}` : (treatmentName || 'Appointment');
  const description = [
    treatmentName ? `Treatment: ${treatmentName}` : null,
    businessName ? `With ${businessName}` : null,
    manageUrl ? `Change or cancel: ${manageUrl}` : null,
  ].filter(Boolean).join('\n');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Florrie//Appointment//EN',
    'CALSCALE:GREGORIAN',
    // REQUEST would make some clients treat it as a meeting invitation with
    // an organiser to RSVP to, which it is not. PUBLISH is "here is an event".
    'METHOD:PUBLISH',
    ...VTIMEZONE_LONDON,
    'BEGIN:VEVENT',
    // Stable across resends, so a second confirmation UPDATES the event in her
    // calendar rather than adding a duplicate beside it. SEQUENCE goes up when
    // the appointment moves, which is what tells the calendar to take the new
    // time seriously.
    fold(`UID:appt-${id}@florrie.ai`),
    `SEQUENCE:${Number(sequence) || 0}`,
    `DTSTAMP:${utcStamp()}`,
    `DTSTART;TZID=Europe/London:${toICalLocal(startsAt)}`,
  ];
  if (endsAt) lines.push(`DTEND;TZID=Europe/London:${toICalLocal(endsAt)}`);
  lines.push(fold(`SUMMARY:${esc(summary)}`));
  if (description) lines.push(fold(`DESCRIPTION:${esc(description)}`));
  if (location) lines.push(fold(`LOCATION:${esc(location)}`));
  if (manageUrl) lines.push(fold(`URL:${esc(manageUrl)}`));
  lines.push(`STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`);
  lines.push('TRANSP:OPAQUE');
  // A reminder the evening before and one an hour ahead. This is the part that
  // actually answers "I couldn't find it" — she does not have to find it.
  lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', fold(`DESCRIPTION:${esc(summary)} tomorrow`), 'TRIGGER:-PT18H', 'END:VALARM');
  lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', fold(`DESCRIPTION:${esc(summary)} in an hour`), 'TRIGGER:-PT1H', 'END:VALARM');
  lines.push('END:VEVENT', 'END:VCALENDAR');

  // CRLF, not \n. RFC 5545 requires it and Outlook is the one that enforces it.
  return lines.join('\r\n') + '\r\n';
}

/**
 * A Google Calendar "add event" url, for Android and webmail where an .ics
 * attachment is a file to download rather than a banner to tap.
 *
 * Google reads these as UTC when they end in Z, so the wall clock has to be
 * converted here — the one place in this file where that is correct.
 */
export function googleCalendarUrl({ startsAt, endsAt, treatmentName, businessName, location, manageUrl, timeZone = 'Europe/London' }) {
  const stamp = (isoish) => toICalLocal(isoish).replace(/[-:]/g, '');
  const text = businessName ? `${treatmentName || 'Appointment'} at ${businessName}` : (treatmentName || 'Appointment');
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text,
    // ctz tells Google these are wall-clock times in this zone, which means we
    // hand over exactly the string we store and let Google do the offset.
    ctz: timeZone,
    dates: `${stamp(startsAt)}/${stamp(endsAt || startsAt)}`,
  });
  if (manageUrl) params.set('details', `Change or cancel: ${manageUrl}`);
  if (location) params.set('location', location);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
