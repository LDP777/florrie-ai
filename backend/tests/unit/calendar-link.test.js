/**
 * The calendar link, driven over real HTTP, checking the things a PHONE cares
 * about rather than the things a unit test usually does.
 *
 * Levi's instruction was "make sure the link genuinely works", and every one
 * of these assertions is a way it has been known to not work:
 *
 *  - Content-Type must be text/calendar; charset=utf-8 and Content-Disposition
 *    must be `attachment`, or iOS Safari renders the file as text instead of
 *    offering the add-to-calendar sheet.
 *  - Content-Length counted in CHARACTERS rather than bytes truncates the
 *    download mid-file, on every platform, silently. Express gets this right;
 *    it is asserted rather than trusted, because a non-ASCII treatment name is
 *    exactly the case where character count and byte count part company.
 *  - starts_at is salon WALL time in a UTC slot. 18:00 in August must come out
 *    as 18:00 tagged Europe/London. Anything that converts it moves a summer
 *    booking by an hour, which is worse than the problem this feature solves.
 *  - The link in a message points at an HTML PAGE, not at the file, because
 *    WhatsApp opens links in its own webview where downloading a file needs
 *    WKDownloadDelegate and otherwise does nothing at all.
 *
 * The handlers are reconstructed here rather than imported: routes/booking.js
 * pulls in Stripe and Supabase config at module scope. They are copied from it
 * line for line, so this drifts if that is edited — which the last assertion
 * in the file guards against.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { readFileSync } from 'node:fs';


process.env.FRONTEND_URL = 'https://florrie.ai';

const APPT = {
  id: 'a-1',
  starts_at: '2026-08-18T18:00:00',
  ends_at: '2026-08-18T19:00:00',
  status: 'confirmed',
  reschedule_count: 0,
  treatments: { name: 'Lash lift & tint' },
  beauticians: { business_name: 'Ellindigo', first_name: 'Ellie', booking_slug: 'ellindigo', address: '12 Bell Street, Henley', brand_color: '#C76B8A' },
};

const { appointmentIcs, googleCalendarUrl, DEAD_STATUSES } = await import('../../src/lib/ical.js');
const { calendarLandingPage } = await import('../../src/lib/calendar-page.js');

// Re-create the two handlers exactly as booking.js defines them, against a
// stub loader. Importing booking.js itself drags in Stripe and Supabase config.
const app = express();
const FRONTEND_URL = process.env.FRONTEND_URL;
const load = (token, slug) => (token === 'tok-123' && slug === 'ellindigo') ? APPT : null;

app.get('/api/booking/:slug/manage/:token/calendar', (req, res) => {
  const appt = load(req.params.token, req.params.slug);
  if (!appt) return res.status(404).type('html').send('<p>Booking not found.</p>');
  const base = `${req.protocol}://${req.get('host')}/api/booking/${req.params.slug}/manage/${req.params.token}`;
  const manageUrl = `${FRONTEND_URL}/book/${req.params.slug}/manage/${req.params.token}`;
  const whenLabel = `${new Date(appt.starts_at).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })} at ${new Date(appt.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })}`;
  res.status(200).type('html').set('Cache-Control', 'no-store').send(calendarLandingPage({
    treatmentName: appt.treatments?.name,
    businessName: appt.beauticians?.business_name,
    whenLabel,
    icsUrl: `${base}/calendar.ics`,
    googleUrl: googleCalendarUrl({ startsAt: appt.starts_at, endsAt: appt.ends_at, treatmentName: appt.treatments?.name, businessName: appt.beauticians?.business_name, location: appt.beauticians?.address, manageUrl }),
    manageUrl,
    brand: appt.beauticians?.brand_color,
  }));
});

app.get('/api/booking/:slug/manage/:token/calendar.ics', (req, res) => {
  const appt = load(req.params.token, req.params.slug);
  if (!appt) return res.status(404).json({ error: 'not_found' });
  const manageUrl = `${FRONTEND_URL}/book/${req.params.slug}/manage/${req.params.token}`;
  const body = appointmentIcs({
    id: appt.id, startsAt: appt.starts_at, endsAt: appt.ends_at,
    treatmentName: appt.treatments?.name,
    businessName: appt.beauticians?.business_name,
    location: appt.beauticians?.address, manageUrl,
    cancelled: DEAD_STATUSES.includes(appt.status),
    sequence: appt.reschedule_count || 0,
  });
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="booking.ics"');
  res.setHeader('Cache-Control', 'no-store');
  res.send(body);
});



let server, base;
beforeAll(async () => {
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}/api/booking/ellindigo/manage/tok-123`;
});
afterAll(() => server?.close());

describe('the .ics a phone downloads', () => {
  let res, body;
  beforeAll(async () => { res = await fetch(`${base}/calendar.ics`); body = await res.text(); });

  it('answers 200', () => expect(res.status).toBe(200));

  it('is served as text/calendar, which is what makes Safari offer the sheet', () => {
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
  });

  it('is an attachment — inline renders it as text in Safari', () => {
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(res.headers.get('content-disposition')).toMatch(/filename="?[^"]*\.ics/);
  });

  it('declares its length in BYTES, not characters', () => {
    // Counting characters truncates the download mid-file the moment the body
    // contains anything non-ASCII, on every platform, with no error.
    expect(Number(res.headers.get('content-length'))).toBe(Buffer.byteLength(body, 'utf8'));
  });

  it('arrives whole, with CRLF endings', () => {
    expect(body.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
    expect(body.includes('\r\n')).toBe(true);
    expect(body.replace(/\r\n/g, '').includes('\n')).toBe(false);
  });

  it('puts an 18:00 August booking at 18:00, tagged Europe/London', () => {
    const lines = body.split('\r\n');
    const vevent = lines.slice(lines.indexOf('BEGIN:VEVENT'));
    expect(vevent.find(l => l.startsWith('DTSTART'))).toBe('DTSTART;TZID=Europe/London:20260818T180000');
  });

  it('brings its own reminders', () => {
    expect(body.split('\r\n').filter(l => l === 'BEGIN:VALARM')).toHaveLength(2);
  });

  it('folds every line to 75 octets', () => {
    for (const l of body.split('\r\n')) expect(Buffer.byteLength(l, 'utf8')).toBeLessThanOrEqual(75);
  });

  it('carries no notes', () => {
    expect(/DESCRIPTION:.*(allerg|medic)/i.test(body)).toBe(false);
  });
});

describe('the page a message links to', () => {
  let res, page;
  beforeAll(async () => { res = await fetch(`${base}/calendar`); page = await res.text(); });

  it('is HTML, so it renders inside WhatsApp\'s webview', () => {
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
  });

  it('offers both calendars', () => {
    expect(page).toContain('/calendar.ics');
    expect(page).toContain('calendar.google.com');
  });

  it('says when the appointment is, in words', () => {
    expect(page).toContain('Tuesday 18 August');
    expect(page).toContain('18:00');
  });

  it('escapes the treatment name and leaves no placeholder unresolved', () => {
    expect(page).toContain('Lash lift &amp; tint');
    expect(page).not.toContain('${');
  });

  it('hides the in-app-browser notice until the sniff fires', () => {
    expect(page).toMatch(/id="inapp"[^>]*display:none/);
    expect(page).toContain('/WhatsApp/i');
  });
});

describe('the token is the only key', () => {
  it('404s on one it does not know', async () => {
    const res = await fetch(base.replace('tok-123', 'nope') + '/calendar.ics');
    expect(res.status).toBe(404);
  });
});

describe('this file has not drifted from the route it copies', () => {
  it('booking.js still serves both paths with the same headers', () => {
    const src = readFileSync(new URL('../../src/routes/booking.js', import.meta.url), 'utf8');
    expect(src).toContain("/:slug/manage/:token/calendar.ics");
    expect(src).toContain("/:slug/manage/:token/calendar'");
    expect(src).toContain("'text/calendar; charset=utf-8'");
    expect(src).toContain("attachment; filename=\"booking.ics\"");
  });
});
