/**
 * Notification service — email (Resend), SMS (Twilio), WhatsApp.
 *
 * Each channel is opt-in per beautician (notification_prefs).
 * Falls back gracefully if credentials aren't configured.
 */
import { supabase } from '../index.js';

// ── Email via Resend ─────────────────────────
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'Florrie <noreply@florrie.ai>';

export async function sendEmail({ to, subject, html, text }) {
  if (!RESEND_API_KEY) {
    console.log('[Notifications] Resend not configured, skipping email');
    return null;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [to],
        subject,
        html,
        text,
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Resend error');
    return data;
  } catch (err) {
    console.error('[Notifications] Email send error:', err.message);
    return null;
  }
}

// ── SMS via Twilio ───────────────────────────
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_PHONE_NUMBER;

export async function sendSMS({ to, body }) {
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) {
    console.log('[Notifications] Twilio not configured, skipping SMS');
    return null;
  }

  try {
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: TWILIO_FROM, Body: body }),
      }
    );

    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Twilio error');
    return data;
  } catch (err) {
    console.error('[Notifications] SMS send error:', err.message);
    return null;
  }
}

// ── WhatsApp via Meta Cloud API ──────────────
const WA_TOKEN = process.env.WHATSAPP_TOKEN;
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

export async function sendWhatsApp({ to, templateName, templateParams }) {
  if (!WA_TOKEN || !WA_PHONE_ID) {
    console.log('[Notifications] WhatsApp not configured, skipping');
    return null;
  }

  try {
    const res = await fetch(
      `https://graph.facebook.com/v18.0/${WA_PHONE_ID}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${WA_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: to.replace(/[^0-9]/g, ''),
          type: 'template',
          template: {
            name: templateName,
            language: { code: 'en' },
            components: templateParams ? [{
              type: 'body',
              parameters: templateParams.map(p => ({ type: 'text', text: p })),
            }] : undefined,
          },
        }),
      }
    );

    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data.error || data));
    return data;
  } catch (err) {
    console.error('[Notifications] WhatsApp send error:', err.message);
    return null;
  }
}

// ── Template-based notifications ─────────────

/**
 * Send a booking confirmation to the client.
 */
export async function notifyBookingConfirmed(appointmentId) {
  const { data: appt } = await supabase
    .from('appointments')
    .select('*, clients(first_name, phone, email), treatments(name), beauticians(business_name, first_name, client_reminder_prefs)')
    .eq('id', appointmentId)
    .single();

  if (!appt) return;

  const client = appt.clients;
  const treatment = appt.treatments;
  const biz = appt.beauticians;
  const prefs = biz?.client_reminder_prefs || {};
  const bizName = biz?.business_name || biz?.first_name;
  const dateStr = new Date(appt.starts_at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const timeStr = new Date(appt.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  if (!prefs.booking_confirmation) return;

  const msg = `Hi ${client.first_name}, your ${treatment.name} is confirmed for ${dateStr} at ${timeStr}. Reply CANCEL to cancel. — ${bizName}`;

  // Send via preferred channel
  const channel = prefs.channel || 'sms';
  if (channel === 'whatsapp' && client.phone) {
    await sendWhatsApp({ to: client.phone, templateName: 'booking_confirmation', templateParams: [client.first_name, treatment.name, dateStr, timeStr] });
  } else if (client.phone) {
    await sendSMS({ to: client.phone, body: msg });
  }

  // Always send email if available
  if (client.email) {
    await sendEmail({
      to: client.email,
      subject: `Booking confirmed — ${treatment.name} on ${dateStr}`,
      text: msg,
      html: `<p>${msg}</p>`,
    });
  }
}

/**
 * Send a 24-hour reminder.
 */
export async function notifyReminder24h(appointmentId) {
  const { data: appt } = await supabase
    .from('appointments')
    .select('*, clients(first_name, phone, email), treatments(name), beauticians(business_name, first_name, client_reminder_prefs)')
    .eq('id', appointmentId)
    .single();

  if (!appt) return;

  const client = appt.clients;
  const treatment = appt.treatments;
  const biz = appt.beauticians;
  const prefs = biz?.client_reminder_prefs || {};
  const bizName = biz?.business_name || biz?.first_name;
  const timeStr = new Date(appt.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  if (!prefs.reminder_24h) return;

  const msg = `Reminder: ${client.first_name}, your ${treatment.name} is tomorrow at ${timeStr}. See you then! — ${bizName}`;

  const channel = prefs.channel || 'sms';
  if (channel === 'whatsapp' && client.phone) {
    await sendWhatsApp({ to: client.phone, templateName: 'reminder_24h', templateParams: [client.first_name, treatment.name, timeStr] });
  } else if (client.phone) {
    await sendSMS({ to: client.phone, body: msg });
  }

  if (client.email) {
    await sendEmail({
      to: client.email,
      subject: `Reminder: ${treatment.name} tomorrow at ${timeStr}`,
      text: msg,
      html: `<p>${msg}</p>`,
    });
  }
}

/**
 * Cron-compatible: find appointments 24h from now and send reminders.
 * Call this via Supabase Edge Function, external cron, or setInterval.
 */
export async function processReminders() {
  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const windowStart = new Date(in24h.getTime() - 30 * 60 * 1000); // 23.5h from now
  const windowEnd = new Date(in24h.getTime() + 30 * 60 * 1000);   // 24.5h from now

  const { data: appointments } = await supabase
    .from('appointments')
    .select('id, status')
    .in('status', ['confirmed', 'pending'])
    .gte('starts_at', windowStart.toISOString())
    .lte('starts_at', windowEnd.toISOString());

  if (!appointments?.length) return { sent: 0 };

  let sent = 0;
  for (const appt of appointments) {
    await notifyReminder24h(appt.id);
    sent++;
  }

  return { sent, total: appointments.length };
}
