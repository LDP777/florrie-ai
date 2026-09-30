import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { encrypt, decrypt, isEncrypted } from '../lib/crypto.js';
import { signOAuthState, inspectOAuthState, peekOAuthStateClaims, oauthStateSecretProblem } from '../lib/oauth-state.js';
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
    return res.status(500).json({ error: 'Google Calendar integration not available, contact support' });
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
  const state = signOAuthState({
    beauticianId: req.beautician.id,
    purpose: 'google-calendar',
    ...(req.query.platform === 'native' ? { platform: 'native' } : {}),
  });

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
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  // Unverified claims choose presentation only. They never authorise a token
  // exchange or identify the owner of a write below.
  const presentation = peekOAuthStateClaims(state);
  const native = presentation.purpose === 'google-calendar' && presentation.platform === 'native';
  function finish(ok, cancelled = false) {
    if (!native) return res.redirect(`${FRONTEND_URL}/settings?gcal=${ok ? 'success' : 'error'}`);
    const title = ok ? 'Google Calendar connected' : cancelled ? 'Connection cancelled' : 'Connection not confirmed';
    const message = ok
      ? 'Close this browser to return to Florrie. Your calendar connection will be checked there.'
      : 'Close this browser to return to Florrie. You can try connecting again from Calendar sync in Settings.';
    return res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="margin:0;padding:2rem;background:#FBF6F1;color:#241B17;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"><h1>${title}</h1><p>${message}</p></body></html>`);
  }

  // `state` used to BE the beautician id, straight off the query string, which
  // meant anyone could finish this flow with their own Google account and a
  // victim's public id and take over her calendar connection. It is now only
  // ever an id we signed ourselves.
  const checked = inspectOAuthState(state);
  // Accept still-valid pre-release states without a purpose for their normal
  // ten-minute lifetime, but never accept a state for another integration.
  if (!checked.ok || !checked.payload.beauticianId || (checked.payload.purpose && checked.payload.purpose !== 'google-calendar')) {
    logger.warn(
      {
        integration: 'google-calendar',
        reason: checked.reason || 'no_beautician_id',
        hasCode: !!code,
        stateLength: typeof state === 'string' ? state.length : 0,
      },
      'Google Calendar OAuth callback refused: the state did not verify',
    );
    return finish(false);
  }

  const beauticianId = checked.payload.beauticianId;

  if (req.query.error || typeof code !== 'string' || !code.trim()) {
    return finish(false, req.query.error === 'access_denied');
  }

  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
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
    if (typeof tokens.access_token !== 'string' || !tokens.access_token.trim() ||
      typeof tokens.refresh_token !== 'string' || !tokens.refresh_token.trim() ||
      !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) {
      throw new Error('Google did not return a complete calendar connection');
    }

    // Store tokens (encrypted at rest)
    const tokenData = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: Date.now() + tokens.expires_in * 1000,
    };
    const { data: saved, error: saveError } = await supabase
      .from('beauticians')
      .update({
        google_calendar_tokens: encrypt(tokenData),
        google_calendar_connected: true,
      })
      .eq('id', beauticianId)
      .select('id')
      .single();
    if (saveError || saved?.id !== beauticianId) throw new Error('Calendar connection save was not confirmed');

    return finish(true);
  } catch (err) {
    logger.error({ err }, 'Google Calendar OAuth error');
    return finish(false);
  }
});

/**
 * POST /api/gcal/disconnect
 * Removes Google Calendar connection.
 */
router.post('/disconnect', requireAuth, async (req, res) => {
  try {
    const { data: saved, error } = await supabase
      .from('beauticians')
      .update({
        google_calendar_tokens: null,
        google_calendar_connected: false,
        google_calendar_id: null,
      })
      .eq('id', req.beautician.id)
      .select('id')
      .single();
    if (error || saved?.id !== req.beautician.id) throw new Error('Calendar disconnect was not confirmed');
    return res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Google Calendar disconnect error');
    return res.status(503).json({ error: 'Could not confirm that Google Calendar was disconnected. Refresh and try again.' });
  }
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
 * Only a confirmed invalid_grant can invalidate the saved connection. An
 * outage, rate limit or app credential problem must not remove salon access.
 */
export async function getAccessToken(beautician) {
  const unavailable = () => Object.assign(new Error('Google Calendar could not be checked right now. Try again shortly.'), { code: 'GCAL_CONNECTION_UNAVAILABLE' });
  const raw = beautician.google_calendar_tokens;
  if (!raw) throw new Error('Not connected to Google Calendar');

  // Decrypt tokens (supports both encrypted strings and legacy plain objects)
  const tokens = typeof raw === 'string' && isEncrypted(raw) ? decrypt(raw) : raw;
  if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token.trim() || !Number.isFinite(tokens.expiry_date)) throw unavailable();

  // Refresh if expired
  if (Date.now() >= tokens.expiry_date - 60000) {
    if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token.trim()) throw unavailable();
    try {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          refresh_token: tokens.refresh_token,
          grant_type: 'refresh_token',
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        logger.warn({ beauticianId: beautician.id, status: res.status }, 'Google token refresh failed');
        if (res.status !== 400 || data?.error !== 'invalid_grant') throw unavailable();
        const { data: saved, error } = await supabase.from('beauticians')
          .update({ google_calendar_tokens: null, google_calendar_connected: false })
          .eq('id', beautician.id)
          // JSONB equality protects a newer reconnect/disconnect from an old
          // in-flight refresh. JSON.stringify supports encrypted strings and
          // the legacy object representation of this column.
          .eq('google_calendar_tokens', JSON.stringify(raw))
          .select('id').single();
        if (error || saved?.id !== beautician.id) throw unavailable();
        throw Object.assign(new Error('Google Calendar access expired or was revoked. Please reconnect in Settings.'), { code: 'GCAL_RECONNECT_REQUIRED' });
      }
      if (typeof data?.access_token !== 'string' || !data.access_token.trim() || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw unavailable();

      const updatedTokens = {
        ...tokens,
        access_token: data.access_token,
        expiry_date: Date.now() + data.expires_in * 1000,
      };
      const encryptedTokens = encrypt(updatedTokens);

      const { data: saved, error } = await supabase
        .from('beauticians')
        .update({ google_calendar_tokens: encryptedTokens })
        .eq('id', beautician.id)
        .eq('google_calendar_tokens', JSON.stringify(raw))
        .select('id').single();
      if (error || saved?.id !== beautician.id) throw unavailable();
      // A bulk sync reuses this request's owner record. Its next appointment
      // must use the confirmed new token rather than refresh the old one again.
      beautician.google_calendar_tokens = encryptedTokens;

      return data.access_token;
    } catch (err) {
      logger.error({ beauticianId: beautician.id, err }, 'Google token refresh exception');
      throw err.code === 'GCAL_RECONNECT_REQUIRED' ? err : unavailable();
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
      if (err.code === 'GCAL_RECONNECT_REQUIRED') {
        logger.error({ err }, 'Google Calendar token expired during sync');
        return res.status(401).json({ error: 'Google Calendar token expired. Please reconnect', disconnected: true });
      }
      if (err.code === 'GCAL_CONNECTION_UNAVAILABLE') return res.status(503).json({ error: err.message });
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
      summary: `${clientName}: ${appt.treatments?.name || 'Appointment'}`,
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

    // An event request can reject an access token without revoking its refresh
    // credential. Only the token endpoint can confirm invalid_grant.
    if (gcalRes.status === 401) {
      logger.warn({ beauticianId: req.beautician.id }, 'Google Calendar 401 — access denied');
      return res.status(503).json({ error: 'Google Calendar could not accept this sync. Try again shortly.' });
    }

    if (!gcalRes.ok) throw new Error(gcalEvent.error?.message || 'Google Calendar sync failed. Check your connection in Settings');

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
          if (err.code === 'GCAL_RECONNECT_REQUIRED') {
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
          summary: `${clientName}: ${fullAppt.treatments?.name || 'Appointment'}`,
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

        // Preserve refresh credentials after an event-level access failure.
        if (gcalRes.status === 401) {
          logger.warn({ beauticianId: req.beautician.id }, 'Google Calendar 401 during sync-all');
          errors++;
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
      message: disconnected ? 'Google Calendar token expired. Please reconnect' : undefined,
    });
  } catch (err) {
    logger.error({ err }, 'GCal sync-all error');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

export default router;
