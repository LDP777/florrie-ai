import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { encrypt, decrypt, isEncrypted } from '../lib/crypto.js';
import { signOAuthState, inspectOAuthState, oauthStateSecretProblem } from '../lib/oauth-state.js';
import logger from '../lib/logger.js';
import { calendarDescription } from '../lib/client-notes.js';

const router = Router();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/api/gcal/callback';
const FRONTEND_URL = process.env.FRONTEND_URL;

// Validate required Google OAuth credentials
function validateGoogleConfig() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    const missing = [
      !GOOGLE_CLIENT_ID && 'GOOGLE_CLIENT_ID',
      !GOOGLE_CLIENT_SECRET && 'GOOGLE_CLIENT_SECRET',
    ].filter(Boolean);
    throw new Error(`Google Calendar not configured. Missing: ${missing.join(', ')}`);
  }
}

// ═══════════════════════════════════════════════
// OAuth flow
// ═══════════════════════════════════════════════

/**
 * GET /api/gcal/connect
 * Initiates the Google Calendar OAuth flow.
 */
router.get('/connect', requireAuth, (req, res) => {
  try {
    validateGoogleConfig();
  } catch (err) {
    logger.error({ err }, 'Google Calendar config error');
    return res.status(500).json({ error: 'Google Calendar integration not available — contact support' });
  }

  // Refuse to start a flow we will not be able to finish. Issuing state we
  // cannot verify on the way back would either lock her out at the callback or,
  // worse, tempt someone into accepting it unverified.
  const secretProblem = oauthStateSecretProblem();
  if (secretProblem) {
    logger.error({ integration: 'google-calendar' }, secretProblem);
    return res.status(503).json({ error: secretProblem });
  }

  const scopes = [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.readonly',
  ];

  // Signed at connect time, when requireAuth has already told us who is asking.
  // The callback has no session, so this string is the only thing tying the
  // tokens Google is about to hand back to the account that asked for them.
  const state = signOAuthState({ beauticianId: req.beautician.id });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${GOOGLE_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(GOOGLE_REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(scopes.join(' '))}` +
    `&access_type=offline` +
    `&prompt=consent` +
    `&state=${encodeURIComponent(state)}`;

  res.json({ url: authUrl });
});

/**
 * GET /api/gcal/callback
 * Handles the OAuth callback from Google.
 */
router.get('/callback', async (req, res) => {
  const { code, state } = req.query;

  // `state` used to BE the beautician id, straight off the query string, which
  // meant anyone could finish this flow with their own Google account and a
  // victim's public id and take over her calendar connection. It is now only
  // ever an id we signed ourselves.
  const checked = inspectOAuthState(state);
  if (!checked.ok || !checked.payload.beauticianId) {
    logger.warn(
      {
        integration: 'google-calendar',
        reason: checked.reason || 'no_beautician_id',
        hasCode: !!code,
        stateLength: typeof state === 'string' ? state.length : 0,
      },
      'Google Calendar OAuth callback refused: the state did not verify',
    );
    return res.redirect(`${FRONTEND_URL}/settings?gcal=error&reason=state`);
  }

  const beauticianId = checked.payload.beauticianId;

  if (!code) {
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

    // Store tokens (encrypted at rest)
    const tokenData = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: Date.now() + tokens.expires_in * 1000,
    };
    await supabase
      .from('beauticians')
      .update({
        google_calendar_tokens: encrypt(tokenData),
        google_calendar_connected: true,
      })
      .eq('id', beauticianId);

    res.redirect(`${FRONTEND_URL}/settings?gcal=success`);
  } catch (err) {
    logger.error({ err }, 'Google Calendar OAuth error');
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
 * Returns null if token is invalid/expired and refresh fails.
 * Marks integration as disconnected if refresh fails.
 */
async function getAccessToken(beautician) {
  const raw = beautician.google_calendar_tokens;
  if (!raw) throw new Error('Not connected to Google Calendar');

  // Decrypt tokens (supports both encrypted strings and legacy plain objects)
  const tokens = typeof raw === 'string' && isEncrypted(raw) ? decrypt(raw) : raw;

  // Refresh if expired
  if (Date.now() >= tokens.expiry_date - 60000) {
    try {
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

      // If refresh fails (401, invalid_grant, etc), disconnect the integration
      if (!res.ok) {
        const errorMsg = data?.error_description || data?.error || 'Unknown error';
        logger.warn({ beauticianId: beautician.id, error: errorMsg }, 'Google token refresh failed');

        // Mark integration as disconnected
        await supabase
          .from('beauticians')
          .update({
            google_calendar_tokens: null,
            google_calendar_connected: false,
          })
          .eq('id', beautician.id);

        throw new Error('Google Calendar token expired — please reconnect in Settings');
      }

      const updatedTokens = {
        ...tokens,
        access_token: data.access_token,
        expiry_date: Date.now() + data.expires_in * 1000,
      };

      await supabase
        .from('beauticians')
        .update({ google_calendar_tokens: encrypt(updatedTokens) })
        .eq('id', beautician.id);

      return data.access_token;
    } catch (err) {
      logger.error({ beauticianId: beautician.id, err }, 'Google token refresh exception');
      throw err;
    }
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
    let accessToken;
    try {
      accessToken = await getAccessToken(req.beautician);
    } catch (err) {
      if (err.message.includes('token expired')) {
        logger.error({ err }, 'Google Calendar token expired during sync');
        return res.status(401).json({ error: 'Google Calendar token expired — please reconnect', disconnected: true });
      }
      throw err;
    }

    // Named columns, not '*'. This route builds a body that goes to Google, so
    // it should only ever hold what a diary entry needs. Selecting the whole
    // row is how client_notes ended up in the event description in the first
    // place, and a select nobody has to read twice is the cheapest guard
    // against the next person putting it back.
    const { data: appt, error: apptErr } = await supabase
      .from('appointments')
      .select('id, starts_at, ends_at, status, duration_minutes, clients(first_name, last_name), treatments(name)')
      .eq('id', appointment_id)
      .eq('beautician_id', req.beautician.id)
      .maybeSingle();

    if (apptErr) {
      logger.error({ err: apptErr }, 'Failed to load the appointment for Google Calendar sync');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    if (!appt) return res.status(404).json({ error: 'Appointment not found' });

    const calendarId = req.beautician.google_calendar_id || 'primary';
    const clientName = `${appt.clients?.first_name || ''} ${appt.clients?.last_name || ''}`.trim();

    const event = {
      summary: `${clientName} — ${appt.treatments?.name || 'Appointment'}`,
      start: { dateTime: appt.starts_at, timeZone: 'Europe/London' },
      end: { dateTime: appt.ends_at, timeZone: 'Europe/London' },
      // client_notes used to be pasted in here verbatim. It is the column the
      // public booking page filled with the JSON of a client's consultation
      // answers, so a connected Google account would have received allergy and
      // medication answers in a calendar event body. Found while surfacing
      // consultation forms. A diary entry gets what it is, how long it takes
      // and the way back into Florrie. Notes of any kind stay in Florrie.
      description: calendarDescription({
        treatmentName: appt.treatments?.name,
        durationMinutes: appt.duration_minutes,
        appointmentId: appt.id,
        appUrl: FRONTEND_URL ? `${FRONTEND_URL}/calendar` : null,
      }),
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

    // Handle 401 specifically — token was revoked or access denied
    if (gcalRes.status === 401) {
      logger.warn({ beauticianId: req.beautician.id }, 'Google Calendar 401 — access denied');
      await supabase
        .from('beauticians')
        .update({
          google_calendar_tokens: null,
          google_calendar_connected: false,
        })
        .eq('id', req.beautician.id);
      return res.status(401).json({ error: 'Google Calendar access denied — please reconnect in Settings', disconnected: true });
    }

    if (!gcalRes.ok) throw new Error(gcalEvent.error?.message || 'Google Calendar sync failed — check your connection in Settings');

    // Store the Google event ID on the appointment
    await supabase
      .from('appointments')
      .update({ google_event_id: gcalEvent.id })
      .eq('id', appointment_id);

    res.json({ success: true, event_id: gcalEvent.id });
  } catch (err) {
    logger.error({ err }, 'GCal sync error');
    res.status(500).json({ error: 'Something went wrong' });
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
    let errors = 0;
    let disconnected = false;

    for (const appt of (appointments || [])) {
      try {
        let accessToken;
        try {
          accessToken = await getAccessToken(req.beautician);
        } catch (err) {
          if (err.message.includes('token expired')) {
            logger.warn({ beauticianId: req.beautician.id }, 'Google Calendar token expired during sync-all');
            disconnected = true;
            break;
          }
          throw err;
        }

        // Re-fetch full appointment for each sync
        const { data: fullAppt } = await supabase
          .from('appointments')
          .select('id, starts_at, ends_at, status, duration_minutes, clients(first_name, last_name), treatments(name)')
          .eq('id', appt.id)
          .maybeSingle();

        if (!fullAppt) continue;

        const calendarId = req.beautician.google_calendar_id || 'primary';
        const clientName = `${fullAppt.clients?.first_name || ''} ${fullAppt.clients?.last_name || ''}`.trim();

        const event = {
          summary: `${clientName} — ${fullAppt.treatments?.name || 'Appointment'}`,
          start: { dateTime: fullAppt.starts_at, timeZone: 'Europe/London' },
          end: { dateTime: fullAppt.ends_at, timeZone: 'Europe/London' },
          // Same body as the single sync, from the same builder, so the two
          // can never drift into one of them carrying a note again.
          description: calendarDescription({
            treatmentName: fullAppt.treatments?.name,
            durationMinutes: fullAppt.duration_minutes,
            appointmentId: fullAppt.id,
            appUrl: FRONTEND_URL ? `${FRONTEND_URL}/calendar` : null,
          }),
        };

        const gcalRes = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`,
          {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(event),
          }
        );

        // Handle 401 specifically
        if (gcalRes.status === 401) {
          logger.warn({ beauticianId: req.beautician.id }, 'Google Calendar 401 during sync-all');
          await supabase
            .from('beauticians')
            .update({
              google_calendar_tokens: null,
              google_calendar_connected: false,
            })
            .eq('id', req.beautician.id);
          disconnected = true;
          break;
        }

        const gcalEvent = await gcalRes.json();
        if (gcalRes.ok) {
          await supabase.from('appointments').update({ google_event_id: gcalEvent.id }).eq('id', appt.id);
          synced++;
        } else {
          errors++;
          logger.warn({ appointmentId: appt.id, gcalError: gcalEvent.error?.message }, 'Failed to sync appointment');
        }
      } catch (e) {
        errors++;
        logger.error({ appointmentId: appt.id, err: e }, 'GCal sync-all error');
      }
    }

    res.json({
      success: !disconnected,
      synced,
      total: appointments?.length || 0,
      errors,
      disconnected,
      message: disconnected ? 'Google Calendar token expired — please reconnect' : undefined,
    });
  } catch (err) {
    logger.error({ err }, 'GCal sync-all error');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

export default router;
