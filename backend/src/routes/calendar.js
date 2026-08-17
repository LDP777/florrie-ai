/**
 * Calendar routes , the private iCal subscribe feed plus the authed control
 * endpoint that hands the owner her subscribe URL.
 *
 *   GET  /api/calendar/feed/:token.ics   , UNAUTHENTICATED, token-gated VCALENDAR
 *   GET  /api/calendar/sync              , authed: returns (and lazily mints) the
 *                                          per-beautician token + subscribe URLs
 *   POST /api/calendar/sync/rotate       , authed: rotate the token (revoke old URL)
 *
 * iCal correctness note: appointments are stored WALL-CLOCK (ISO without a Z).
 * We emit DTSTART/DTEND as local date-times under TZID=Europe/London, with a
 * VTIMEZONE block, so 14:00 in the DB shows as 14:00 in her phone calendar all
 * year round (the client applies the GMT/BST offset, we never convert).
 */
import { Router } from 'express';
import crypto from 'crypto';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';
import { esc, toICalLocal, utcStamp, fold, VTIMEZONE_LONDON, DEAD_STATUSES } from '../lib/ical.js';

const router = Router();

// Statuses we do not surface in her personal calendar (dead bookings).

/** Public base for building absolute subscribe URLs. */
function publicBase(req) {
  const env = process.env.PUBLIC_API_URL || process.env.API_BASE_URL || process.env.BACKEND_URL;
  if (env) return env.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

/** Fresh, URL-safe, unguessable token (hex, 32 bytes). */
function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** Lazily mint and persist a token for a beautician, returning the value. */
async function ensureToken(beautician) {
  if (beautician.ical_token) return beautician.ical_token;
  const token = newToken();
  const { error } = await supabase
    .from('beauticians')
    .update({ ical_token: token })
    .eq('id', beautician.id);
  if (error) {
    // If the column does not exist yet (migration 074 not applied), surface a
    // clear, non-fatal message rather than a 500 mystery.
    logger.error({ err: error }, 'iCal token persist failed');
    throw new Error('ical_token_unavailable');
  }
  return token;
}

/**
 * GET /api/calendar/sync
 * Returns the subscribe URLs (https + webcal) for the signed-in owner, minting
 * the token on first call. The frontend shows these on the full calendar page.
 */
router.get('/sync', requireAuth, async (req, res) => {
  try {
    const token = await ensureToken(req.beautician);
    const base = publicBase(req);
    const path = `/api/calendar/feed/${token}.ics`;
    const httpsUrl = `${base}${path}`;
    const webcalUrl = httpsUrl.replace(/^https?:\/\//, 'webcal://');
    res.json({ httpsUrl, webcalUrl, token });
  } catch (err) {
    if (err.message === 'ical_token_unavailable') {
      return res.status(503).json({ error: 'ical_not_ready', message: 'Calendar sync is being set up. Apply migration 074_ical_token then try again.' });
    }
    logger.error({ err }, 'GET /calendar/sync failed');
    res.status(500).json({ error: 'sync_failed' });
  }
});

/**
 * POST /api/calendar/sync/rotate
 * Issues a new token, invalidating any previously shared subscribe URL.
 */
router.post('/sync/rotate', requireAuth, async (req, res) => {
  try {
    const token = newToken();
    const { error } = await supabase
      .from('beauticians')
      .update({ ical_token: token })
      .eq('id', req.beautician.id);
    if (error) throw error;
    const base = publicBase(req);
    const httpsUrl = `${base}/api/calendar/feed/${token}.ics`;
    const webcalUrl = httpsUrl.replace(/^https?:\/\//, 'webcal://');
    res.json({ httpsUrl, webcalUrl, token });
  } catch (err) {
    logger.error({ err }, 'POST /calendar/sync/rotate failed');
    res.status(500).json({ error: 'rotate_failed' });
  }
});

// ----------------------------- iCal helpers ------------------------------
// Moved to lib/ical.js so a client's single-appointment .ics uses the same
// escaping, folding and VTIMEZONE this feed does, rather than a second copy
// that drifts.

/** Map an appointment status to an iCal STATUS. */
function icalStatus(status) {
  if (DEAD_STATUSES.includes(status)) return 'CANCELLED';
  if (status === 'pending') return 'TENTATIVE';
  return 'CONFIRMED';
}

/**
 * GET /api/calendar/feed/:token.ics
 * UNAUTHENTICATED. Resolves the beautician by token and returns a valid
 * VCALENDAR of her recent + upcoming appointments.
 */
router.get('/feed/:token.ics', async (req, res) => {
  const token = req.params.token;
  try {
    if (!token || token.length < 16) {
      return res.status(404).type('text/plain').send('Not found');
    }
    const { data: beautician, error: bErr } = await supabase
      .from('beauticians')
      .select('id, first_name, business_name, address, ical_token')
      .eq('ical_token', token)
      .maybeSingle();
    if (bErr) throw bErr;
    if (!beautician) {
      return res.status(404).type('text/plain').send('Not found');
    }

    // Window: last 60 days through next 365 days. Calendars want recent history
    // plus the full forward book, not the entire archive.
    const now = new Date();
    const fromDate = new Date(now); fromDate.setDate(fromDate.getDate() - 60);
    const toDate = new Date(now); toDate.setDate(toDate.getDate() + 365);
    const fromStr = `${fromDate.getFullYear()}-${String(fromDate.getMonth() + 1).padStart(2, '0')}-${String(fromDate.getDate()).padStart(2, '0')}`;
    const toStr = `${toDate.getFullYear()}-${String(toDate.getMonth() + 1).padStart(2, '0')}-${String(toDate.getDate()).padStart(2, '0')}`;

    const { data: appts, error: aErr } = await supabase
      .from('appointments')
      // client_notes is deliberately NOT selected. This feed is a URL anybody
      // holding it can subscribe to, and the public booking page filled that
      // column with the JSON of a client's consultation answers, so allergy
      // and medication answers were being written into an event body that
      // leaves Florrie. Found while surfacing consultation forms. Her own
      // beautician_notes still travel: she writes those, for herself.
      .select('id, starts_at, ends_at, status, beautician_notes, updated_at, clients(first_name, last_name), treatments(name)')
      .eq('beautician_id', beautician.id)
      .gte('starts_at', `${fromStr}T00:00:00`)
      .lte('starts_at', `${toStr}T23:59:59`)
      .order('starts_at');
    if (aErr) throw aErr;

    const calName = beautician.business_name || (beautician.first_name ? `${beautician.first_name}'s diary` : 'Florrie bookings');
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Florrie//Calendar Feed//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:${esc(calName)}`,
      'X-WR-TIMEZONE:Europe/London',
      'X-PUBLISHED-TTL:PT30M',
      'REFRESH-INTERVAL;VALUE=DURATION:PT30M',
      ...VTIMEZONE_LONDON,
    ];

    const dtstamp = utcStamp(now);
    for (const a of (appts || [])) {
      const client = a.clients
        ? [a.clients.first_name, a.clients.last_name].filter(Boolean).join(' ').trim()
        : '';
      const treatment = a.treatments?.name || 'Appointment';
      const summary = client ? `${client} , ${treatment}` : treatment;
      // Her notes only. A note a client typed on a public page cannot be
      // proven to be free of health data, and this feed goes to whatever
      // calendar app holds the link, so it does not go.
      const notes = a.beautician_notes || '';
      // Stable UID so re-polls update the same event instead of duplicating it.
      const uid = `appt-${a.id}@florrie.ai`;
      const start = toICalLocal(a.starts_at);
      const end = a.ends_at ? toICalLocal(a.ends_at) : null;

      lines.push('BEGIN:VEVENT');
      lines.push(fold(`UID:${uid}`));
      lines.push(`DTSTAMP:${dtstamp}`);
      if (a.updated_at) lines.push(`LAST-MODIFIED:${utcStamp(new Date(a.updated_at))}`);
      lines.push(`DTSTART;TZID=Europe/London:${start}`);
      if (end) lines.push(`DTEND;TZID=Europe/London:${end}`);
      lines.push(fold(`SUMMARY:${esc(summary)}`));
      if (beautician.address) lines.push(fold(`LOCATION:${esc(beautician.address)}`));
      if (notes) lines.push(fold(`DESCRIPTION:${esc(notes)}`));
      lines.push(`STATUS:${icalStatus(a.status)}`);
      lines.push('TRANSP:OPAQUE');
      lines.push('END:VEVENT');
    }

    lines.push('END:VCALENDAR');
    const body = lines.join('\r\n') + '\r\n';

    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', `inline; filename="florrie.ics"`);
    res.set('Cache-Control', 'no-cache, max-age=0');
    res.send(body);
  } catch (err) {
    logger.error({ err }, 'GET /calendar/feed failed');
    res.status(500).type('text/plain').send('Calendar feed error');
  }
});

export default router;
