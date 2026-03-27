import { Router } from 'express';
import { supabase } from '../index.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/api/gcal/callback';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// ═══════════════════════════════════════════════
// OAuth flow
// ═══════════════════════════════════════════════

/**
 * GET /api/gcal/connect
 * Initiates the Google Calendar OAuth flow.
 */
router.get('/connect', requireAuth, (req, res) => {
  const scopes = [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.readonly',
  ];

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${GOOGLE_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(GOOGLE_REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(scopes.join(' '))}` +
    `&access_type=offline` +
    `&prompt=consent` +
    `&state=${req.beautician.id}`;

  res.json({ url: authUrl });
});

/**
 * GET /api/gcal/callback
 * Handles the OAuth callback from Google.
 */
router.get('/callback', async (req, res) => {
  const { code, state: beauticianId } = req.query;

  if (!code || !beauticianId) {
    return res.redirect(`${FRONTEND_URL}/settings?gcal=error`);
  }

  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: GOOGLE_REDIRECT_URI,
      }),
    });

    const tokens = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(tokens.error_description || 'Token exchange failed');

    // Store tokens (encrypted in production — TODO)
    await supabase
      .from('beauticians')
      .update({
        google_calendar_tokens: {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expiry_date: Date.now() + tokens.expires_in * 1000,
        },
        google_calendar_connected: true,
      })
      .eq('id', beauticianId);

    res.redirect(`${FRONTEND_URL}/settings?gcal=success`);
  } catch (err) {
    console.error('Google Calendar OAuth error:', err);
    res.redirect(`${FRONTEND_URL}/settings?gcal=error`);
  }
});

/**
 * POST /api/gcal/disconnect
 * Removes Google Calendar connection.
 */
router.post('/disconnect', requireAuth, async (req, res) => {
  await supabase
    .from('beauticians')
    .update({
      google_calendar_tokens: null,
      google_calendar_connected: false,
      google_calendar_id: null,
    })
    .eq('id', req.beautician.id);

  res.json({ success: true });
});

/**
 * GET /api/gcal/status
 * Check Google Calendar connection status.
 */
router.get('/status', requireAuth, (req, res) => {
  res.json({
    connected: !!req.beautician.google_calendar_connected,
    calendar_id: req.beautician.google_calendar_id || null,
  });
});

// ═══════════════════════════════════════════════
// Sync operations
// ═══════════════════════════════════════════════

/**
 * Helper: Get a valid access token (refreshing if needed).
 */
async function getAccessToken(beautician) {
  const tokens = beautician.google_calendar_tokens;
  if (!tokens) throw new Error('Not connected to Google Calendar');

  // Refresh if expired
  if (Date.now() >= tokens.expiry_date - 60000) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: tokens.refresh_token,
        grant_type: 'refresh_token',
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error('Token refresh failed');

    const updatedTokens = {
      ...tokens,
      access_token: data.access_token,
      expiry_date: Date.now() + data.expires_in * 1000,
    };

    await supabase
      .from('beauticians')
      .update({ google_calendar_tokens: updatedTokens })
      .eq('id', beautician.id);

    return data.access_token;
  }

  return tokens.access_token;
}

/**
 * POST /api/gcal/sync
 * Push a Florrie appointment to Google Calendar.
 */
router.post('/sync', requireAuth, async (req, res) => {
  const { appointment_id } = req.body;

  try {
    const accessToken = await getAccessToken(req.beautician);

    const { data: appt } = await supabase
      .from('appointments')
      .select('*, clients(first_name, last_name), treatments(name)')
      .eq('id', appointment_id)
      .single();

    if (!appt) return res.status(404).json({ error: 'Appointment not found' });

    const calendarId = req.beautician.google_calendar_id || 'primary';
    const clientName = `${appt.clients?.first_name || ''} ${appt.clients?.last_name || ''}`.trim();

    const event = {
      summary: `${clientName} — ${appt.treatments?.name || 'Appointment'}`,
      start: { dateTime: appt.starts_at, timeZone: 'Europe/London' },
      end: { dateTime: appt.ends_at, timeZone: 'Europe/London' },
      description: `Booked via Florrie\n${appt.client_notes || ''}`,
      colorId: appt.status === 'confirmed' ? '2' : '5', // Green or Yellow
    };

    const gcalRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(event),
      }
    );

    const gcalEvent = await gcalRes.json();
    if (!gcalRes.ok) throw new Error(gcalEvent.error?.message || 'GCal API error');

    // Store the Google event ID on the appointment
    await supabase
      .from('appointments')
      .update({ google_event_id: gcalEvent.id })
      .eq('id', appointment_id);

    res.json({ success: true, event_id: gcalEvent.id });
  } catch (err) {
    console.error('GCal sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/gcal/sync-all
 * Bulk sync: push all upcoming confirmed appointments to Google Calendar.
 */
router.post('/sync-all', requireAuth, async (req, res) => {
  try {
    const { data: appointments } = await supabase
      .from('appointments')
      .select('id')
      .eq('beautician_id', req.beautician.id)
      .in('status', ['confirmed', 'pending'])
      .gte('starts_at', new Date().toISOString())
      .is('google_event_id', null);

    let synced = 0;
    for (const appt of (appointments || [])) {
      try {
        const accessToken = await getAccessToken(req.beautician);
        // Re-fetch full appointment for each sync
        const { data: fullAppt } = await supabase
          .from('appointments')
          .select('*, clients(first_name, last_name), treatments(name)')
          .eq('id', appt.id)
          .single();

        if (!fullAppt) continue;

        const calendarId = req.beautician.google_calendar_id || 'primary';
        const clientName = `${fullAppt.clients?.first_name || ''} ${fullAppt.clients?.last_name || ''}`.trim();

        const event = {
          summary: `${clientName} — ${fullAppt.treatments?.name || 'Appointment'}`,
          start: { dateTime: fullAppt.starts_at, timeZone: 'Europe/London' },
          end: { dateTime: fullAppt.ends_at, timeZone: 'Europe/London' },
          description: `Booked via Florrie`,
        };

        const gcalRes = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`,
          {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(event),
          }
        );

        const gcalEvent = await gcalRes.json();
        if (gcalRes.ok) {
          await supabase.from('appointments').update({ google_event_id: gcalEvent.id }).eq('id', appt.id);
          synced++;
        }
      } catch (e) {
        console.error(`GCal sync-all error for ${appt.id}:`, e.message);
      }
    }

    res.json({ success: true, synced, total: appointments?.length || 0 });
  } catch (err) {
    console.error('GCal sync-all error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
