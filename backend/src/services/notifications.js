/**
 * Notification service — email (Resend), SMS (Twilio), WhatsApp.
 *
 * Email defaults to ON for all notifications unless the beautician
 * explicitly disables it. SMS and WhatsApp are opt-in.
 */
import { supabase } from '../index.js';
import logger from '../lib/logger.js';
import { trackSMSUsage } from './sms-metering.js';
import { checkWhatsAppQuota, trackWhatsAppMessage } from './whatsapp-metering.js';

// ── Email via Resend ─────────────────────────
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'Florrie <noreply@florrie.ai>';

export async function sendEmail({ to, subject, html, text }) {
  if (!RESEND_API_KEY) {
    logger.debug('Resend not configured, skipping email');
    return null;
  }

  const maxRetries = 2;
  const retryDelay = 1000; // 1 second

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
      logger.info({ to, subject }, 'Email sent');
      return data;
    } catch (err) {
      if (attempt < maxRetries) {
        logger.debug({ attempt: attempt + 1, err }, 'Email send failed, retrying...');
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      } else {
        logger.error({ err, attempts: maxRetries + 1 }, 'Email send failed after retries');
        return null;
      }
    }
  }
}

// ── SMS via Bird (MessageBird) ───────────────
// Bird replaced Twilio for SMS — no regulatory bundle required for UK,
// and ~90% cheaper per message. Twilio vars remain for WhatsApp config.
const BIRD_API_KEY = process.env.BIRD_API_KEY;
const BIRD_ORIGINATOR = process.env.BIRD_ORIGINATOR || 'Florrie';

export async function sendSMS({ to, body, beauticianId }) {
  if (!BIRD_API_KEY) {
    logger.debug('Bird not configured, skipping SMS');
    return null;
  }

  // Track SMS usage if beauticianId provided
  let usageInfo = null;
  if (beauticianId) {
    usageInfo = await trackSMSUsage(beauticianId);
  }

  const maxRetries = 2;
  const retryDelay = 1000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch('https://rest.messagebird.com/messages', {
        method: 'POST',
        headers: {
          'Authorization': `AccessKey ${BIRD_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          originator: BIRD_ORIGINATOR,
          recipients: [to.replace(/[^0-9]/g, '')],
          body,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.errors?.[0]?.description || 'Bird error');
      logger.info({ to }, 'SMS sent via Bird');
      return { ...data, usageInfo };
    } catch (err) {
      if (attempt < maxRetries) {
        logger.debug({ attempt: attempt + 1, err }, 'SMS send failed, retrying...');
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      } else {
        logger.error({ err, attempts: maxRetries + 1 }, 'SMS send failed after retries');
        return null;
      }
    }
  }
}

// ── WhatsApp via Meta Cloud API ──────────────
// Primary channel for clients with WhatsApp. Falls back to Twilio SMS.
// Each beautician has their own phone_number_id registered to Florrie's WABA.
// Florrie pays Meta; usage is metered against the 120 msg/month plan limit.
const WA_TOKEN = process.env.WHATSAPP_TOKEN;

/**
 * Send a WhatsApp template message (for booking confirmations, reminders etc.)
 * beauticianId is required — used to look up per-beautician phone_number_id and check quota.
 */
export async function sendWhatsApp({ to, templateName, templateParams, beauticianId }) {
  if (!WA_TOKEN) {
    logger.debug('WhatsApp token not configured, skipping');
    return null;
  }

  // Resolve phone_number_id from beautician record
  let phoneNumberId = null;
  if (beauticianId) {
    const quota = await checkWhatsAppQuota(beauticianId);
    if (!quota.allowed) {
      logger.warn({ beauticianId, reason: quota.reason }, 'WhatsApp send blocked — quota or config issue');
      return null;
    }
    const { data: b } = await supabase
      .from('beauticians')
      .select('whatsapp_phone_id')
      .eq('id', beauticianId)
      .single();
    phoneNumberId = b?.whatsapp_phone_id;
  }

  if (!phoneNumberId) {
    logger.debug({ beauticianId }, 'No WhatsApp phone_number_id, skipping');
    return null;
  }

  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(
        `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
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
      logger.info({ to, templateName }, 'WhatsApp template sent');
      if (beauticianId) await trackWhatsAppMessage(beauticianId);
      return data;
    } catch (err) {
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000));
      } else {
        logger.error({ err, attempts: maxRetries + 1 }, 'WhatsApp template send failed');
        return null;
      }
    }
  }
}

/**
 * Send a freeform WhatsApp text message.
 * Used for AI-generated replies, nudges, and non-template messages.
 * Note: freeform messages can only be sent within the 24-hour conversation window.
 */
export async function sendWhatsAppText({ to, body, beauticianId }) {
  if (!WA_TOKEN) {
    logger.debug('WhatsApp token not configured, skipping freeform');
    return null;
  }

  // Resolve phone_number_id from beautician record
  let phoneNumberId = null;
  if (beauticianId) {
    const quota = await checkWhatsAppQuota(beauticianId);
    if (!quota.allowed) {
      logger.warn({ beauticianId, reason: quota.reason }, 'WhatsApp text blocked — quota or config issue');
      return null;
    }
    const { data: b } = await supabase
      .from('beauticians')
      .select('whatsapp_phone_id')
      .eq('id', beauticianId)
      .single();
    phoneNumberId = b?.whatsapp_phone_id;
  }

  if (!phoneNumberId) {
    logger.debug({ beauticianId }, 'No WhatsApp phone_number_id, skipping text');
    return null;
  }

  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(
        `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${WA_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: to.replace(/[^0-9]/g, ''),
            type: 'text',
            text: { body },
          }),
        }
      );

      const data = await res.json();
      if (!res.ok) throw new Error(JSON.stringify(data.error || data));
      logger.info({ to }, 'WhatsApp text sent');
      if (beauticianId) await trackWhatsAppMessage(beauticianId);
      return data;
    } catch (err) {
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000));
      } else {
        logger.error({ err, attempts: maxRetries + 1 }, 'WhatsApp text send failed');
        return null;
      }
    }
  }
}

// ── Instagram DM via Graph API ──────────────
// Sends replies to Instagram DMs using the page token stored per-beautician.
// Falls back to the global INSTAGRAM_PAGE_TOKEN env var for single-tenant setups.

/**
 * Send an Instagram DM reply.
 * Uses the Instagram Send API (same as Messenger platform).
 * The recipient must have messaged the page first (24-hour window).
 *
 * @param {string} recipientId - Instagram-scoped user ID (IGSID)
 * @param {string} text        - Message body
 * @param {string} [pageToken] - Per-beautician page token (falls back to env)
 */
export async function sendInstagramDM({ recipientId, text, pageToken }) {
  const token = pageToken || process.env.INSTAGRAM_PAGE_TOKEN;
  if (!token) {
    logger.debug('Instagram page token not configured, skipping DM');
    return null;
  }

  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(
        `https://graph.instagram.com/v21.0/me/messages`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            recipient: { id: recipientId },
            message: { text },
          }),
        }
      );

      const data = await res.json();
      if (!res.ok) throw new Error(JSON.stringify(data.error || data));
      logger.info({ recipientId }, 'Instagram DM sent');
      return data;
    } catch (err) {
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000));
      } else {
        logger.error({ err, attempts: maxRetries + 1 }, 'Instagram DM send failed');
        return null;
      }
    }
  }
}

/**
 * Smart channel selector — picks the best channel for a given client.
 * Priority: Instagram (if DM thread exists) > WhatsApp > SMS > Email
 *
 * Returns: 'instagram' | 'whatsapp' | 'sms' | 'email' | null
 */
export function pickChannel(client, beauticianPrefs = {}) {
  const override = beauticianPrefs.channel;
  if (override && override !== 'auto') return override;

  // Instagram: client came via Instagram DM and token is available
  if (client?.instagram_id && (beauticianPrefs.instagram_page_token || process.env.INSTAGRAM_PAGE_TOKEN)) {
    return 'instagram';
  }

  // WhatsApp: client has an active WhatsApp ID, token is configured, and beautician has a registered number
  if (client?.whatsapp_id && WA_TOKEN && beauticianPrefs?.whatsapp_connected) return 'whatsapp';

  // SMS: client has a phone and Bird is configured
  if (client?.phone && BIRD_API_KEY) return 'sms';

  // Email: last resort
  if (client?.email) return 'email';

  return null;
}

/**
 * Send a message via the best available channel.
 * Freeform text — used by AI Front Desk, nudges, etc.
 * Cascade: Instagram > WhatsApp > SMS > Email
 */
export async function sendMessage({ client, body, beauticianId, beauticianPrefs }) {
  const channel = pickChannel(client, beauticianPrefs);

  if (channel === 'instagram') {
    const result = await sendInstagramDM({
      recipientId: client.instagram_id,
      text: body,
      pageToken: beauticianPrefs?.instagram_page_token,
    });
    if (result) {
      await logComms(beauticianId, client.id, 'instagram', 'outbound', body);
      return { channel: 'instagram', result };
    }
    // Fall through to WhatsApp if Instagram fails
  }

  if (channel === 'whatsapp' || (channel === 'instagram')) {
    const result = await sendWhatsAppText({ to: client.whatsapp_id || client.phone, body });
    if (result) {
      await logComms(beauticianId, client.id, 'whatsapp', 'outbound', body);
      return { channel: 'whatsapp', result };
    }
    // Fall through to SMS
  }

  if (channel === 'sms' || ['whatsapp', 'instagram'].includes(channel)) {
    if (client?.phone) {
      const result = await sendSMS({ to: client.phone, body, beauticianId });
      if (result) {
        await logComms(beauticianId, client.id, 'sms', 'outbound', body);
        return { channel: 'sms', result };
      }
    }
  }

  if (client?.email) {
    const result = await sendEmail({ to: client.email, subject: 'Message from your beautician', text: body, html: `<p>${body}</p>` });
    if (result) {
      await logComms(beauticianId, client.id, 'email', 'outbound', body);
      return { channel: 'email', result };
    }
  }

  logger.warn({ clientId: client?.id }, 'No channel available for client');
  return null;
}

/**
 * Log outbound communication to comms_log table.
 */
async function logComms(beauticianId, clientId, channel, direction, content) {
  try {
    await supabase.from('messages').insert({
      beautician_id: beauticianId,
      client_id: clientId,
      channel,
      direction,
      content,
      ai_handled: true,
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to log comms');
  }
}

// ── Branded HTML email wrapper ───────────────
function emailTemplate({ bizName, brandColor, content }) {
  const color = brandColor || '#C4A882';
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#faf9f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#faf9f7;padding:32px 16px">
<tr><td align="center">
<table width="100%" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08)">
  <tr><td style="background:${color};padding:24px 32px">
    <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;letter-spacing:-0.3px">${bizName}</h1>
    <p style="margin:4px 0 0;color:rgba(255,255,255,0.85);font-size:12px">Powered by Florrie</p>
  </td></tr>
  <tr><td style="padding:32px">${content}</td></tr>
  <tr><td style="padding:16px 32px 24px;border-top:1px solid #f0eeeb">
    <p style="margin:0;color:#a09a93;font-size:12px;text-align:center">Sent via Florrie — the AI-powered booking assistant</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// ── Template-based notifications ─────────────

/**
 * Send a booking confirmation to the client.
 * Email sends by default unless explicitly disabled.
 */
export async function notifyBookingConfirmed(appointmentId) {
  const { data: appt } = await supabase
    .from('appointments')
    .select('*, clients(first_name, phone, email), treatments(name, duration_minutes), beauticians(business_name, first_name, client_reminder_prefs, brand_color)')
    .eq('id', appointmentId)
    .single();

  if (!appt) return;

  const client = appt.clients;
  const treatment = appt.treatments;
  const biz = appt.beauticians;
  const prefs = biz?.client_reminder_prefs || {};
  const bizName = biz?.business_name || biz?.first_name;
  const dateStr = new Date(appt.starts_at).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const timeStr = new Date(appt.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const shortDate = new Date(appt.starts_at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

  const textMsg = `Hi ${client.first_name}, your ${treatment.name} with ${bizName} is confirmed for ${shortDate} at ${timeStr}.`;

  // SMS/WhatsApp — only if beautician has opted in
  if (prefs.booking_confirmation !== false) {
    const channel = prefs.channel || 'email';
    if (channel === 'whatsapp' && client.phone) {
      await sendWhatsApp({ to: client.phone, templateName: 'booking_confirmation', templateParams: [client.first_name, treatment.name, shortDate, timeStr] });
    } else if (channel === 'sms' && client.phone) {
      await sendSMS({ to: client.phone, body: textMsg, beauticianId: appt.beautician_id });
    }
  }

  // Email — always send unless explicitly disabled (prefs.email_confirmation === false)
  if (client.email && prefs.email_confirmation !== false) {
    const depositLine = appt.deposit_cents > 0
      ? `<p style="margin:12px 0 0;color:#6b6560;font-size:14px">Deposit paid: <strong>&pound;${(appt.deposit_cents / 100).toFixed(2)}</strong></p>`
      : '';

    const html = emailTemplate({
      bizName,
      brandColor: biz.brand_color,
      content: `
        <h2 style="margin:0 0 8px;color:#2d2a26;font-size:18px;font-weight:600">Booking Confirmed</h2>
        <p style="margin:0 0 20px;color:#6b6560;font-size:14px">Hi ${client.first_name}, you're all booked in.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#faf9f7;border-radius:8px;padding:20px">
          <tr><td>
            <p style="margin:0;color:#a09a93;font-size:12px;text-transform:uppercase;letter-spacing:0.5px">Treatment</p>
            <p style="margin:4px 0 16px;color:#2d2a26;font-size:16px;font-weight:600">${treatment.name}</p>
            <p style="margin:0;color:#a09a93;font-size:12px;text-transform:uppercase;letter-spacing:0.5px">When</p>
            <p style="margin:4px 0 16px;color:#2d2a26;font-size:16px;font-weight:600">${dateStr} at ${timeStr}</p>
            <p style="margin:0;color:#a09a93;font-size:12px;text-transform:uppercase;letter-spacing:0.5px">Duration</p>
            <p style="margin:4px 0 0;color:#2d2a26;font-size:16px;font-weight:600">${treatment.duration_minutes} minutes</p>
            ${depositLine}
          </td></tr>
        </table>
        <p style="margin:20px 0 0;color:#6b6560;font-size:14px">Need to cancel or reschedule? Get in touch with ${bizName} directly.</p>
      `,
    });

    await sendEmail({
      to: client.email,
      subject: `Confirmed: ${treatment.name} — ${shortDate} at ${timeStr}`,
      text: textMsg,
      html,
    });
  }
}

/**
 * Send a 24-hour reminder.
 * Email sends by default unless explicitly disabled.
 */
export async function notifyReminder24h(appointmentId) {
  const { data: appt } = await supabase
    .from('appointments')
    .select('*, clients(first_name, phone, email), treatments(name, duration_minutes), beauticians(business_name, first_name, client_reminder_prefs, brand_color)')
    .eq('id', appointmentId)
    .single();

  if (!appt) return;

  const client = appt.clients;
  const treatment = appt.treatments;
  const biz = appt.beauticians;
  const prefs = biz?.client_reminder_prefs || {};
  const bizName = biz?.business_name || biz?.first_name;
  const timeStr = new Date(appt.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const dateStr = new Date(appt.starts_at).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  const textMsg = `Reminder: ${client.first_name}, your ${treatment.name} with ${bizName} is tomorrow at ${timeStr}. See you then!`;

  // SMS/WhatsApp — only if opted in
  if (prefs.reminder_24h !== false) {
    const channel = prefs.channel || 'email';
    if (channel === 'whatsapp' && client.phone) {
      await sendWhatsApp({ to: client.phone, templateName: 'reminder_24h', templateParams: [client.first_name, treatment.name, timeStr] });
    } else if (channel === 'sms' && client.phone) {
      await sendSMS({ to: client.phone, body: textMsg, beauticianId: appt.beautician_id });
    }
  }

  // Email — always send unless explicitly disabled
  if (client.email && prefs.email_reminder !== false) {
    const html = emailTemplate({
      bizName,
      brandColor: biz.brand_color,
      content: `
        <h2 style="margin:0 0 8px;color:#2d2a26;font-size:18px;font-weight:600">Appointment Tomorrow</h2>
        <p style="margin:0 0 20px;color:#6b6560;font-size:14px">Hi ${client.first_name}, just a quick reminder about your appointment.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#faf9f7;border-radius:8px;padding:20px">
          <tr><td>
            <p style="margin:0;color:#a09a93;font-size:12px;text-transform:uppercase;letter-spacing:0.5px">Treatment</p>
            <p style="margin:4px 0 16px;color:#2d2a26;font-size:16px;font-weight:600">${treatment.name}</p>
            <p style="margin:0;color:#a09a93;font-size:12px;text-transform:uppercase;letter-spacing:0.5px">When</p>
            <p style="margin:4px 0 16px;color:#2d2a26;font-size:16px;font-weight:600">${dateStr} at ${timeStr}</p>
            <p style="margin:0;color:#a09a93;font-size:12px;text-transform:uppercase;letter-spacing:0.5px">Duration</p>
            <p style="margin:4px 0 0;color:#2d2a26;font-size:16px;font-weight:600">${treatment.duration_minutes} minutes</p>
          </td></tr>
        </table>
        <p style="margin:20px 0 0;color:#6b6560;font-size:14px">If you can't make it, please let ${bizName} know as soon as possible.</p>
      `,
    });

    await sendEmail({
      to: client.email,
      subject: `Reminder: ${treatment.name} tomorrow at ${timeStr}`,
      text: textMsg,
      html,
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
    try {
      await notifyReminder24h(appt.id);
      sent++;
    } catch (err) {
      logger.error({ appointmentId: appt.id, err }, 'Reminder failed');
    }
  }

  return { sent, total: appointments.length };
}
