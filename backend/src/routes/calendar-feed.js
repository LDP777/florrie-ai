/**
 * calendar-feed.js — Public ICS subscription feed.
 *
 * Exposes an .ics URL per beautician (keyed by booking_slug) that any
 * calendar app (Apple Calendar, Google Calendar, Outlook) can subscribe to.
 *
 * GET /api/cal/:slug/feed.ics
 *   → Returns an iCalendar feed of upcoming + recent appointments.
 *
 * No auth required — calendar apps can't send tokens.
 * Security: uses the booking_slug (not beautician ID) and only exposes
 * the client first name + treatment name. No emails, phones, or notes.
 */

import { Router } from 'express';
import { supabase } from '../index.js';
import logger from '../lib/logger.js';

const router = Router();

/**
 * Generate a deterministic UID for an appointment.
 * ICS spec requires UIDs to be globally unique and stable across refreshes.
 */
function eventUid(apptId) {
  return `${apptId}@florrie.ai`;
}

/**
 * Format a JS Date to ICS DTSTART/DTEND format (UTC).
 * e.g. 20260331T140000Z
 */
function icsDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    'Z'
  );
}

/**
 * Escape text for ICS (fold lines, escape special chars).
 */
function icsEscape(text) {
  if (!text) return '';
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/**
 * GET /api/cal/:slug/feed.ics
 *
 * Returns appointments from 30 days ago → 90 days ahead.
 * Calendar apps typically refresh every 15-60 minutes.
 */
router.get('/:slug/feed.ics', async (req, res) => {
  try {
    const { slug } = req.params;

    // Look up beautician by booking slug
    const { data: beautician, error: bErr } = await supabase
      .from('beauticians')
      .select('id, business_name, first_name, last_name, booking_slug')
      .eq('booking_slug', slug)
      .maybeSingle();

    if (bErr || !beautician) {
      return res.status(404).type('text/plain').send('Calendar not found');
    }

    // Date range: 30 days back, 90 days forward
    const now = new Date();
    const from = new Date(now);
    from.setDate(from.getDate() - 30);
    const to = new Date(now);
    to.setDate(to.getDate() + 90);

    const { data: appointments, error: aErr } = await supabase
      .from('appointments')
      .select('id, starts_at, ends_at, duration_minutes, status, client_notes, clients(first_name), treatments(name)')
      .eq('beautician_id', beautician.id)
      .gte('starts_at', from.toISOString())
      .lte('starts_at', to.toISOString())
      .in('status', ['confirmed', 'pending', 'completed'])
      .order('starts_at', { ascending: true });

    if (aErr) {
      logger.error({ err: aErr }, 'ICS feed query error');
      return res.status(500).type('text/plain').send('Something went wrong');
    }

    const calName = beautician.business_name || `${beautician.first_name || ''} ${beautician.last_name || ''}`.trim() || 'Florrie Calendar';

    // Build ICS
    const events = (appointments || []).map(appt => {
      const clientName = appt.clients?.first_name || 'Client';
      const treatment = appt.treatments?.name || 'Appointment';
      const summary = `${clientName} — ${treatment}`;

      // Calculate end time from starts_at + duration if ends_at is missing
      let endIso = appt.ends_at;
      if (!endIso && appt.starts_at && appt.duration_minutes) {
        const end = new Date(new Date(appt.starts_at).getTime() + appt.duration_minutes * 60000);
        endIso = end.toISOString();
      }

      const statusText = appt.status === 'completed' ? 'CONFIRMED' :
                         appt.status === 'confirmed' ? 'CONFIRMED' :
                         'TENTATIVE';

      return [
        'BEGIN:VEVENT',
        `UID:${eventUid(appt.id)}`,
        `DTSTART:${icsDate(appt.starts_at)}`,
        `DTEND:${icsDate(endIso || appt.starts_at)}`,
        `SUMMARY:${icsEscape(summary)}`,
        `STATUS:${statusText}`,
        `DESCRIPTION:${icsEscape(`Booked via Florrie`)}`,
        'END:VEVENT',
      ].join('\r\n');
    });

    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Florrie AI//Calendar Feed//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:${icsEscape(calName)}`,
      'X-WR-TIMEZONE:Europe/London',
      // Refresh interval hint (1 hour)
      'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
      'X-PUBLISHED-TTL:PT1H',
      ...events,
      'END:VCALENDAR',
    ].join('\r\n');

    res.set({
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `inline; filename="${slug}.ics"`,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    res.send(ics);
  } catch (err) {
    logger.error({ err }, 'ICS feed error');
    res.status(500).type('text/plain').send('Something went wrong');
  }
});

export default router;
