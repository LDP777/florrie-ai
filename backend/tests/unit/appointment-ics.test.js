/**
 * The calendar file a client gets, and the one thing it must never do.
 *
 * A client messaged Ellie the evening before her appointment: "I have an
 * appointment with you tomorrow at 6pm correct? I can't seem to find all my
 * bookings on the florrie app." Ellie's answer was "type florrie into WhatsApp
 * or your emails", which is true, and is the whole problem — the only record
 * a client had of a booking was a text message she had to go and search for.
 *
 * So confirmations now carry a calendar invite. Which introduces the one bug
 * that would be worse than the problem it solves: `starts_at` holds salon WALL
 * time parked in the UTC slot, so treating it as a real instant moves every
 * summer appointment an hour. A client who is told 7pm because of our
 * timezone maths is worse off than one who has to search her inbox.
 *
 * That is what most of this file is about.
 */
import { describe, it, expect } from 'vitest';
import { appointmentIcs, googleCalendarUrl } from '../../src/lib/ical.js';

const BASE = {
  id: 'appt-1',
  // 18:00 in AUGUST — British Summer Time. This is the case that breaks if
  // anyone ever "fixes" the wall-clock handling by converting to UTC.
  startsAt: '2026-08-18T18:00:00',
  endsAt: '2026-08-18T19:00:00',
  treatmentName: 'Lash lift & tint',
  businessName: 'Ellindigo',
  manageUrl: 'https://florrie.ai/book/ellindigo/manage/tok-123',
};

const lines = (s) => s.split('\r\n');
/**
 * Look inside the VEVENT only. The VTIMEZONE block above it carries its own
 * `DTSTART:19700329T010000` — the DST changeover rule — so a naive "first line
 * starting with DTSTART" reads the timezone definition and reports the event
 * as happening in 1970.
 */
const find = (s, prefix) => {
  const l = lines(s);
  const from = l.indexOf('BEGIN:VEVENT');
  return l.slice(from < 0 ? 0 : from).find(x => x.startsWith(prefix));
};

describe('the appointment lands at the time it was booked for', () => {
  it('keeps 18:00 as 18:00 in August, tagged Europe/London', () => {
    const ics = appointmentIcs(BASE);
    // Not 170000Z, not 190000. The literal wall clock, with the zone named so
    // the calendar app applies BST itself.
    expect(find(ics, 'DTSTART')).toBe('DTSTART;TZID=Europe/London:20260818T180000');
    expect(find(ics, 'DTEND')).toBe('DTEND;TZID=Europe/London:20260818T190000');
  });

  it('carries a VTIMEZONE so the zone name means something', () => {
    const ics = appointmentIcs(BASE);
    expect(ics).toContain('BEGIN:VTIMEZONE');
    expect(ics).toContain('TZID:Europe/London');
    expect(ics).toContain('TZNAME:BST');
    expect(ics).toContain('TZNAME:GMT');
  });

  it('hands Google the wall clock plus a ctz, not a converted instant', () => {
    const url = new URL(googleCalendarUrl(BASE));
    expect(url.searchParams.get('ctz')).toBe('Europe/London');
    expect(url.searchParams.get('dates')).toBe('20260818T180000/20260818T190000');
  });
});

describe('a resend updates the event instead of duplicating it', () => {
  it('uses a UID derived from the appointment, so it is stable', () => {
    const a = appointmentIcs(BASE);
    const b = appointmentIcs(BASE);
    expect(find(a, 'UID:')).toBe('UID:appt-appt-1@florrie.ai');
    expect(find(a, 'UID:')).toBe(find(b, 'UID:'));
  });

  it('raises SEQUENCE when the booking has been moved', () => {
    expect(find(appointmentIcs(BASE), 'SEQUENCE:')).toBe('SEQUENCE:0');
    expect(find(appointmentIcs({ ...BASE, sequence: 2 }), 'SEQUENCE:')).toBe('SEQUENCE:2');
  });

  it('marks a cancelled booking cancelled, so it clears from her calendar', () => {
    expect(find(appointmentIcs(BASE), 'STATUS:')).toBe('STATUS:CONFIRMED');
    expect(find(appointmentIcs({ ...BASE, cancelled: true }), 'STATUS:')).toBe('STATUS:CANCELLED');
  });
});

describe('it reminds her, which is the actual fix', () => {
  it('carries an alarm the evening before and one an hour ahead', () => {
    const ics = appointmentIcs(BASE);
    expect(ics).toContain('TRIGGER:-PT18H');
    expect(ics).toContain('TRIGGER:-PT1H');
    expect(lines(ics).filter(l => l === 'BEGIN:VALARM')).toHaveLength(2);
  });
});

describe('nothing goes in it that should not leave Florrie', () => {
  it('carries no notes of any kind', () => {
    // client_notes on the public booking page has been found holding the JSON
    // of consultation answers — allergies, medication. A calendar file gets
    // forwarded, synced and backed up to wherever her calendar lives.
    const ics = appointmentIcs({ ...BASE, clientNotes: 'nut allergy', notes: 'on blood thinners' });
    expect(ics).not.toContain('allergy');
    expect(ics).not.toContain('blood thinners');
  });

  it('escapes a treatment name containing iCal punctuation', () => {
    const ics = appointmentIcs({ ...BASE, treatmentName: 'Lash lift; tint, hybrid' });
    const summary = find(ics, 'SUMMARY:');
    expect(summary).toContain('\\;');
    expect(summary).toContain('\\,');
  });
});

describe('it is a file a calendar will actually open', () => {
  it('uses CRLF line endings, which Outlook enforces', () => {
    const ics = appointmentIcs(BASE);
    expect(ics).toContain('\r\n');
    // No bare LF anywhere.
    expect(ics.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('opens and closes its blocks', () => {
    const l = lines(appointmentIcs(BASE));
    expect(l[0]).toBe('BEGIN:VCALENDAR');
    expect(l.filter(Boolean).pop()).toBe('END:VCALENDAR');
    expect(l.filter(x => x === 'BEGIN:VEVENT')).toHaveLength(1);
    expect(l.filter(x => x === 'END:VEVENT')).toHaveLength(1);
  });

  it('folds every line to 75 octets', () => {
    const ics = appointmentIcs({
      ...BASE,
      treatmentName: 'Brow lamination maintenance with hybrid dye and a full aftercare consultation bundle',
      businessName: 'Ellindigo Brow and Lash Studio of Henley-on-Thames',
    });
    for (const line of lines(ics)) expect(line.length).toBeLessThanOrEqual(75);
  });

  it('survives a booking with no end time', () => {
    const ics = appointmentIcs({ ...BASE, endsAt: null });
    expect(find(ics, 'DTSTART')).toBeTruthy();
    expect(find(ics, 'DTEND')).toBeUndefined();
  });
});
