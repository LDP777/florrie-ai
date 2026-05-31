/**
 * Cleanup service, handles stale bookings and expired data.
 *
 * Runs on an interval from index.js. Each function is idempotent
 * and safe to call multiple times.
 */
import { supabase } from '../config.js';
import logger from '../lib/logger.js';

/**
 * Find appointments that are 'pending' (waiting for deposit payment)
 * and have passed their payment_expires_at timestamp (or were created
 * more than 15 minutes ago if no expiry was set). Cancel them to free
 * the time slot for other clients.
 */
export async function cleanupStaleBookings() {
  const now = new Date().toISOString();
  // Fallback cutoff for appointments without payment_expires_at
  const fallbackCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  // Find pending appointments where:
  // (a) payment_expires_at is set and has passed, OR
  // (b) no payment_expires_at and created more than 15 min ago
  const { data: stale, error } = await supabase
    .from('appointments')
    .select('id, beautician_id, client_id, deposit_cents, deposit_paid, payment_expires_at, google_calendar_event_id')
    .eq('status', 'pending')
    .gt('deposit_cents', 0)
    .neq('deposit_paid', true)
    .or(`payment_expires_at.lt.${now},and(payment_expires_at.is.null,created_at.lt.${fallbackCutoff})`);

  if (error || !stale?.length) {
    return { cancelled: 0 };
  }

  let cancelled = 0;
  for (const appt of stale) {
    const { error: updateErr } = await supabase
      .from('appointments')
      .update({
        status: 'cancelled',
        cancellation_reason: 'auto_cancelled_unpaid',
        cancelled_at: new Date().toISOString(),
      })
      .eq('id', appt.id)
      .eq('status', 'pending'); // double-check it's still pending (avoid race)

    if (!updateErr) {
      cancelled++;

      // Remove from Google Calendar if an event was created
      if (appt.google_calendar_event_id) {
        removeFromGoogleCalendar(appt.beautician_id, appt.google_calendar_event_id).catch(err =>
          logger.warn({ err, appointmentId: appt.id }, 'GCal removal failed (non-fatal)')
        );
      }

      // Log the AI action
      const { error: _logErr } = await supabase.from('ai_actions').insert({
        beautician_id: appt.beautician_id,
        action_type: 'booking_auto_cancelled',
        digital_employee: 'front_desk',
        summary: `Auto-cancelled unpaid booking, payment window expired`,
        details: {
          appointment_id: appt.id,
          reason: 'deposit_not_paid',
          expired_at: appt.payment_expires_at || 'no_expiry_set',
        },
        client_id: appt.client_id,
        appointment_id: appt.id,
        confidence: 1.0,
        autonomous: true,
        outcome: 'success',
      }); // non-fatal, ignore _logErr
    }
  }

  return { cancelled, checked: stale.length };
}

/**
 * Remove a Google Calendar event when a booking is auto-cancelled.
 * Fetches the beautician's OAuth tokens and calls the GCal delete API.
 */
async function removeFromGoogleCalendar(beauticianId, eventId) {
  const { data: b } = await supabase
    .from('beauticians')
    .select('google_calendar_token, google_calendar_refresh_token, google_calendar_id')
    .eq('id', beauticianId)
    .maybeSingle();

  if (!b?.google_calendar_token) return;

  // Try with existing access token first
  let accessToken = b.google_calendar_token;
  const calendarId = b.google_calendar_id || 'primary';

  const del = async (token) => {
    return fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
    );
  };

  let res = await del(accessToken);

  // Token expired, try to refresh
  if (res.status === 401 && b.google_calendar_refresh_token) {
    const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: b.google_calendar_refresh_token,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
      }),
    });

    if (refreshRes.ok) {
      const refreshed = await refreshRes.json();
      accessToken = refreshed.access_token;

      // Persist new token
      await supabase
        .from('beauticians')
        .update({ google_calendar_token: accessToken })
        .eq('id', beauticianId);

      res = await del(accessToken);
    }
  }

  if (res.status === 204 || res.status === 404) {
    // 204 = deleted, 404 = already gone, both are fine
    logger.info({ beauticianId, eventId }, 'GCal event removed after auto-cancel');
  } else {
    const body = await res.text().catch(() => '');
    logger.warn({ beauticianId, eventId, status: res.status, body }, 'GCal delete returned unexpected status');
  }
}
