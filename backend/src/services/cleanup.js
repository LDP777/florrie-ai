/**
 * Cleanup service, handles stale bookings and expired data.
 *
 * Runs on an interval from index.js. Each function is idempotent
 * and safe to call multiple times.
 */
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { guardedSend } from '../lib/outbound-guard.js';
import { sendOnChannel } from './messaging.js';

/**
 * Find appointments that are 'pending' (waiting for deposit payment)
 * and have passed their payment_expires_at timestamp (or were created
 * more than 15 minutes ago if no expiry was set). Cancel them to free
 * the time slot for other clients, and send the client a friendly
 * "your slot was released, rebook here" message so an abandoned payment
 * screen doesn't silently lose the booking.
 */
export async function cleanupStaleBookings() {
  const now = new Date().toISOString();
  // Fallback cutoff for appointments without payment_expires_at
  const fallbackCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  // Two separate simple queries instead of one .or():
  // (a) payment_expires_at set and passed
  // (b) no payment_expires_at and created more than 15 min ago
  // Also: deposit_paid can be NULL on older rows, and SQL `!= true` silently
  // drops NULLs, which left those pending bookings in the diary forever.
  // NOTE: the column is google_event_id in prod. The old select named a
  // nonexistent google_calendar_event_id, PostgREST errored, and the error
  // was swallowed, so this cleanup NEVER cancelled anything since launch.
  const SELECT = 'id, beautician_id, client_id, starts_at, deposit_cents, deposit_paid, payment_expires_at, google_event_id, treatments(name)';
  const unpaid = q => q.eq('status', 'pending').gt('deposit_cents', 0).or('deposit_paid.is.null,deposit_paid.eq.false');
  const [expiredRes, agedRes] = await Promise.all([
    unpaid(supabase.from('appointments').select(SELECT)).lt('payment_expires_at', now),
    unpaid(supabase.from('appointments').select(SELECT)).is('payment_expires_at', null).lt('created_at', fallbackCutoff),
  ]);

  if (expiredRes.error) logger.warn({ err: expiredRes.error }, 'Cleanup: expired query failed');
  if (agedRes.error) logger.warn({ err: agedRes.error }, 'Cleanup: aged query failed');

  const seen = new Set();
  const stale = [...(expiredRes.data || []), ...(agedRes.data || [])].filter(a => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });

  if (!stale.length) {
    return { cancelled: 0 };
  }

  // Beautician rows (slug, business name, channel creds) cached per run.
  const beauticianCache = new Map();
  async function getBeautician(id) {
    if (!beauticianCache.has(id)) {
      const { data } = await supabase.from('beauticians').select('*').eq('id', id).maybeSingle();
      beauticianCache.set(id, data || null);
    }
    return beauticianCache.get(id);
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
      if (appt.google_event_id) {
        removeFromGoogleCalendar(appt.beautician_id, appt.google_event_id).catch(err =>
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

      // Retention message: tell the client their slot was released and hand
      // them the rebook link, instead of leaving them thinking they booked.
      // Transactional (their own abandoned checkout), goes via the guard.
      // Only for FRESH expiries (last 2h): old backlog rows being swept up
      // must not fire day-old "your slot was released" texts.
      const expiredAtMs = appt.payment_expires_at ? new Date(appt.payment_expires_at).getTime() : 0;
      if (expiredAtMs && Date.now() - expiredAtMs < 2 * 60 * 60 * 1000) {
        sendSlotReleasedMessage(appt, getBeautician).catch(err =>
          logger.warn({ err, appointmentId: appt.id }, 'Slot-released message failed (non-fatal)')
        );
      }
    }
  }

  return { cancelled, checked: stale.length };
}

/**
 * "Your slot was released" note to the client after an unpaid booking
 * expires. WhatsApp first, then SMS, then email, whatever is on file.
 */
async function sendSlotReleasedMessage(appt, getBeautician) {
  if (!appt.client_id) return;
  const beautician = await getBeautician(appt.beautician_id);
  if (!beautician) return;

  const { data: client } = await supabase
    .from('clients')
    .select('id, first_name, phone, email, whatsapp_id')
    .eq('id', appt.client_id)
    .maybeSingle();
  if (!client) return;

  const channel = (client.whatsapp_id || client.phone) ? 'whatsapp'
    : client.phone ? 'sms'
    : client.email ? 'email'
    : null;
  if (!channel) return;

  // Wall-time convention: date and time read straight off the string.
  const day = String(appt.starts_at || '').slice(0, 10);
  const time = String(appt.starts_at || '').slice(11, 16);
  const dayLabel = day ? new Date(`${day}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) : 'your chosen day';
  const treatment = appt.treatments?.name || 'appointment';
  const slug = beautician.booking_slug;
  const rebookLine = slug ? ` You can rebook in seconds here: https://florrie.ai/book/${slug}` : '';
  const body = `Hi ${client.first_name || 'there'}, your ${treatment} booking for ${dayLabel}${time ? ` at ${time}` : ''} didn't complete because the deposit wasn't paid, so the slot has been released.${rebookLine}`;

  await guardedSend({
    beauticianId: appt.beautician_id,
    clientId: client.id,
    messageType: 'payment_link',
    channel,
    client,
    body,
    send: async () => {
      const result = await sendOnChannel({ beautician, clientId: client.id, channel, body });
      return !!result?.ok;
    },
  });
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
