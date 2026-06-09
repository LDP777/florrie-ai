/**
 * Notification service — email (Resend), SMS (Bird), WhatsApp (Meta).
 *
 * Email defaults to ON for all notifications unless the beautician
 * explicitly disables it. SMS and WhatsApp are opt-in.
 */
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { trackSMSUsage } from './sms-metering.js';
import { checkWhatsAppQuota, trackWhatsAppMessage, trackSmsInMonthlyQuota } from './whatsapp-metering.js';

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

// SMS delivery via the Bird platform (app.bird.com) Channels API.
// NOTE: this account is on the NEW Bird platform — the legacy rest.messagebird.com
// endpoint + AccessKey no longer authenticate (returns 401). We send through a
// workspace channel instead. Default channel is the UK long-code +44 7418 313493,
// which needs no alphanumeric brand registration. Override per-env if needed.
const BIRD_API_KEY = process.env.BIRD_API_KEY;
const BIRD_WORKSPACE_ID = process.env.BIRD_WORKSPACE_ID || 'eb945934-eb5f-42af-954b-86be8f6381e9';
const BIRD_SMS_CHANNEL_ID = process.env.BIRD_SMS_CHANNEL_ID || '7e8e2014-98b9-508d-be22-6dde76d0dd0e';
const BIRD_API_BASE = process.env.BIRD_API_BASE || 'https://api.bird.com';

// Normalise a phone number to E.164 (+<digits>) for the Bird contact identifier.
function toE164(raw) {
  if (!raw) return raw;
  const s = String(raw).trim();
  // Already international: keep the +, strip any spaces/punctuation.
  if (s.startsWith('+')) return '+' + s.slice(1).replace(/[^0-9]/g, '');
  const digits = s.replace(/[^0-9]/g, '');
  if (!digits) return raw;
  if (digits.startsWith('00')) return '+' + digits.slice(2);          // 0044... -> +44...
  if (digits.startsWith('0'))  return '+44' + digits.replace(/^0+/, ''); // UK national 07... -> +447...
  if (digits.startsWith('44')) return '+' + digits;                   // 447... -> +447...
  return '+' + digits;                                                // assume already E.164 digits
}

export async function sendSMS({ to, body, beauticianId, originator, messageType = 'general' }) {
  if (!BIRD_API_KEY) {
    logger.debug('Bird not configured, skipping SMS');
    return null;
  }
  if (!BIRD_WORKSPACE_ID || !BIRD_SMS_CHANNEL_ID) {
    logger.error('Bird workspace/channel not configured, cannot send SMS');
    return null;
  }

  // Usage is metered only AFTER a confirmed send (see the success branch below),
  // so failed/rejected messages never count against the allowance or get billed.
  let usageInfo = null;

  // On the new Bird platform the *channel* is the sender. The legacy per-beautician
  // alphanumeric originator ("Florrie"/"FlorrieAI") is brand-gated and currently
  // rejected, so we route through the long-code channel by default. We still allow
  // a per-beautician channel override via sms_originator when it looks like a
  // Bird channel id (UUID); plain alphanumeric values are ignored for sending.
  let channelId = BIRD_SMS_CHANNEL_ID;
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (originator && uuidRe.test(originator)) {
    channelId = originator;
  } else if (!originator && beauticianId) {
    const { data: b } = await supabase
      .from('beauticians')
      .select('sms_originator')
      .eq('id', beauticianId)
      .maybeSingle();
    if (b?.sms_originator && uuidRe.test(b.sms_originator)) channelId = b.sms_originator;
  }

  const url = `${BIRD_API_BASE}/workspaces/${BIRD_WORKSPACE_ID}/channels/${channelId}/messages`;
  const payload = {
    receiver: {
      contacts: [{ identifierKey: 'phonenumber', identifierValue: toE164(to) }],
    },
    body: {
      type: 'text',
      text: { text: body },
    },
  };

  const maxRetries = 2;
  const retryDelay = 1000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `AccessKey ${BIRD_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const text = await res.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
      if (!res.ok) {
        const desc = data?.message || data?.errors?.[0]?.description || data?.raw || `HTTP ${res.status}`;
        throw new Error(`Bird ${res.status}: ${desc}`);
      }
      logger.info({ to, channelId, id: data?.id }, 'SMS sent via Bird');
      // Meter the confirmed send: weekly counter (legacy/display) + the monthly
      // combined quota (message_usage), which is the meter we actually bill from.
      if (beauticianId) {
        try {
          usageInfo = await trackSMSUsage(beauticianId);
          await trackSmsInMonthlyQuota(beauticianId);
        } catch (mErr) {
          logger.error({ err: mErr, beauticianId }, 'SMS metering failed (send already succeeded)');
        }
      }
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

// Primary channel for clients with WhatsApp. Falls back to Bird SMS.
// Each beautician has their own phone_number_id registered to Florrie's WABA.
// Florrie pays Meta; usage is metered against the 120 msg/month plan limit.
const WA_TOKEN = process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
const WA_WABA_ID = process.env.WHATSAPP_WABA_ID || process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
const WA_GRAPH = 'https://graph.facebook.com/v21.0';

// A WABA owns the approved templates AND the phone numbers that send them.
// The template lookup MUST happen on the SAME WABA the sending phone is parented
// to (not a central env WABA, which may differ, e.g. a sandbox WABA). So we
// resolve the phone's real parent WABA, then read that WABA's templates to find
// the exact approved language for the template. Both are cached.

const _phoneWabaCache = new Map(); // phoneNumberId -> { wabaId, at }
async function getPhoneParentWaba(phoneNumberId) {
  if (!WA_TOKEN || !phoneNumberId) return null;
  const hit = _phoneWabaCache.get(phoneNumberId);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.wabaId;
  try {
    const r = await fetch(
      `${WA_GRAPH}/${phoneNumberId}?fields=whatsapp_business_account{id}`,
      { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
    );
    const data = await r.json();
    const wabaId = data?.whatsapp_business_account?.id || null;
    if (wabaId) _phoneWabaCache.set(phoneNumberId, { wabaId, at: Date.now() });
    else logger.warn({ status: r.status, body: data, phoneNumberId }, 'getPhoneParentWaba: no WABA on phone node');
    return wabaId;
  } catch (err) {
    logger.warn({ err, phoneNumberId }, 'getPhoneParentWaba: fetch failed');
    return null;
  }
}

// Cache of wabaId -> { map: templateName->approvedLanguage, at }
const _tplLangCache = new Map();
async function resolveTemplateLanguage(templateName, wabaId) {
  const waba = wabaId || WA_WABA_ID;
  if (!WA_TOKEN || !waba) return null;
  const hit = _tplLangCache.get(waba);
  if (!hit || Date.now() - hit.at >= 10 * 60 * 1000) {
    try {
      const r = await fetch(
        `${WA_GRAPH}/${waba}/message_templates?fields=name,language,status&limit=200`,
        { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
      );
      const data = await r.json();
      if (r.ok && Array.isArray(data?.data)) {
        const map = {};
        for (const t of data.data) {
          if (!map[t.name] || t.status === 'APPROVED') map[t.name] = t.language;
        }
        _tplLangCache.set(waba, { map, at: Date.now() });
        logger.info(
          { waba, templates: data.data.map((t) => `${t.name}:${t.language}:${t.status}`) },
          'resolveTemplateLanguage: template list loaded'
        );
      } else {
        logger.warn({ waba, status: r.status, body: data }, 'resolveTemplateLanguage: template list fetch non-ok');
      }
    } catch (err) {
      logger.warn({ err, waba }, 'resolveTemplateLanguage: template list fetch failed');
    }
  }
  const entry = _tplLangCache.get(waba);
  return entry ? entry.map[templateName] || null : null;
}

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

  // Resolve the language from the WABA that actually owns this sending phone.
  const sendingWaba = await getPhoneParentWaba(phoneNumberId);
  const resolvedLang = await resolveTemplateLanguage(templateName, sendingWaba);
  const languages = [...new Set([resolvedLang, 'en_GB', 'en', 'en_US'].filter(Boolean))];
  logger.info({ templateName, phoneNumberId, sendingWaba, resolvedLang, languages }, 'sendWhatsApp: locale candidates');
  let lastErr = null;
  for (const lang of languages) {
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
              language: { code: lang },
              components: templateParams ? [{
                type: 'body',
                parameters: templateParams.map(p => ({ type: 'text', text: String(p) })),
              }] : undefined,
            },
          }),
        }
      );

      const data = await res.json();
      if (res.ok) {
        logger.info({ to, templateName, lang }, 'WhatsApp template sent');
        if (beauticianId) await trackWhatsAppMessage(beauticianId);
        return data;
      }
      lastErr = data?.error || data;
      // 132001 = template/locale mismatch -> try next locale; any other error -> stop.
      if (data?.error?.code !== 132001) break;
    } catch (err) {
      lastErr = err;
      break;
    }
  }
  logger.error({ err: lastErr, templateName, phoneNumberId, languagesTried: languages }, 'WhatsApp template send failed (all locales)');
  // Diagnostic: is the sending phone number actually on the env WABA whose templates we read?
  if (WA_WABA_ID && WA_TOKEN) {
    try {
      const pr = await fetch(
        `${WA_GRAPH}/${WA_WABA_ID}/phone_numbers?fields=id,display_phone_number,verified_name&limit=50`,
        { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
      );
      const pj = await pr.json();
      const ids = Array.isArray(pj?.data) ? pj.data.map((p) => `${p.id}:${p.display_phone_number}`) : pj;
      const onEnvWaba = Array.isArray(pj?.data) && pj.data.some((p) => p.id === phoneNumberId);
      logger.warn({ envWaba: WA_WABA_ID, phoneNumberId, onEnvWaba, envWabaPhones: ids }, 'WhatsApp diag: phone vs env WABA');
    } catch (e) {
      logger.warn({ e }, 'WhatsApp diag: phone_numbers fetch failed');
    }
  }
  return null;
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
 * Check whether we're inside the 24-hour WhatsApp free-form messaging window.
 * Meta only allows free-form text to a number that messaged us within the last 24h.
 */
function inWhatsAppSession(client) {
  if (!client?.last_whatsapp_inbound_at) return false;
  const lastInbound = new Date(client.last_whatsapp_inbound_at);
  const hoursSince = (Date.now() - lastInbound.getTime()) / (1000 * 60 * 60);
  return hoursSince < 24;
}

/**
 * Send a proactive nudge via the best available channel.
 *
 * Proactive outbound is different from reactive replies:
 *   - WhatsApp free-form only works within the 24h session window
 *   - Outside that window, WhatsApp requires a pre-approved template
 *   - If no template channel is available, fall back to SMS → Email
 *
 * @param {object} opts
 * @param {object} opts.client         - Client record (needs whatsapp_id, last_whatsapp_inbound_at, phone, email)
 * @param {string} opts.body           - Message text (used for SMS/email and in-session WhatsApp)
 * @param {string} [opts.templateName] - WhatsApp template name for out-of-session sends
 * @param {string[]} [opts.templateParams] - Template variable substitutions
 * @param {string} opts.beauticianId
 * @param {object} [opts.beauticianPrefs]
 */
export async function sendNudge({ client, body, templateName, templateParams, beauticianId, beauticianPrefs = {} }) {
  // Path 1: active WhatsApp session — send free-form, it'll land immediately
  if (client?.whatsapp_id && WA_TOKEN && beauticianPrefs?.whatsapp_connected && inWhatsAppSession(client)) {
    const result = await sendWhatsAppText({ to: client.whatsapp_id, body, beauticianId });
    if (result) {
      await logComms(beauticianId, client.id, 'whatsapp', 'outbound', body);
      return { channel: 'whatsapp_freeform', result };
    }
  }

  // Path 2: WhatsApp template (client has opted in, we have a template, session not required)
  if (client?.whatsapp_id && WA_TOKEN && beauticianPrefs?.whatsapp_connected && templateName) {
    const result = await sendWhatsApp({ to: client.whatsapp_id, templateName, templateParams, beauticianId });
    if (result) {
      await logComms(beauticianId, client.id, 'whatsapp', 'outbound', body);
      return { channel: 'whatsapp_template', result };
    }
  }

  // Path 3: SMS — universal fallback for proactive outbound
  if (client?.phone && BIRD_API_KEY) {
    const result = await sendSMS({ to: client.phone, body, beauticianId, messageType: 'ai_checkin' });
    if (result) {
      await logComms(beauticianId, client.id, 'sms', 'outbound', body);
      return { channel: 'sms', result };
    }
  }

  // Path 4: Email — last resort
  if (client?.email) {
    const result = await sendEmail({
      to: client.email,
      subject: 'A message from your beautician',
      text: body,
      html: `<p>${body}</p>`,
    });
    if (result) {
      await logComms(beauticianId, client.id, 'email', 'outbound', body);
      return { channel: 'email', result };
    }
  }

  logger.warn({ clientId: client?.id }, 'sendNudge: no channel available');
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
    const result = await sendWhatsAppText({ to: client.whatsapp_id || client.phone, body, beauticianId });
    if (result) {
      await logComms(beauticianId, client.id, 'whatsapp', 'outbound', body);
      return { channel: 'whatsapp', result };
    }
    // Fall through to SMS
  }

  if (channel === 'sms' || ['whatsapp', 'instagram'].includes(channel)) {
    if (client?.phone) {
      const result = await sendSMS({ to: client.phone, body, beauticianId, messageType: 'ai_reply' });
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

function emailTemplate({ bizName, brandColor, tagline, content }) {
  const color = brandColor || '#C4A882';
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#fbf7f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fbf7f4;padding:28px 16px">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fbf7f4;border-radius:16px;overflow:hidden;box-shadow:0 6px 24px rgba(120,90,60,0.12)">
  <tr><td style="background:${color};padding:30px 32px 26px;text-align:center">
    <div style="font-size:24px;line-height:1;margin-bottom:6px">&#127800;</div>
    <div style="font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:700;color:#ffffff;letter-spacing:0.3px">${bizName}</div>
    ${tagline ? `<div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:rgba(255,255,255,0.85);margin-top:5px">${tagline}</div>` : ''}
  </td></tr>
  <tr><td style="padding:0">${content}</td></tr>
  <tr><td style="background:#f4eee4;padding:18px 32px;text-align:center">
    <div style="font-size:12px;color:#8a7a5e;font-weight:600">${bizName}</div>
    <div style="font-size:11px;color:#b3a890;margin-top:4px">Booked with Florrie</div>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/**
 * Send a booking confirmation to the client.
 * Email sends by default unless explicitly disabled.
 */
export async function notifyBookingConfirmed(appointmentId) {
  const { data: appt } = await supabase
    .from('appointments')
    .select('*, clients(first_name, phone, email), treatments(name, duration_minutes), beauticians(business_name, first_name, client_reminder_prefs, brand_color, booking_slug, tagline)')
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

  const manageUrl = (appt.management_token && biz?.booking_slug && process.env.FRONTEND_URL)
    ? `${process.env.FRONTEND_URL}/book/${biz.booking_slug}/manage/${appt.management_token}`
    : null;
  const textMsg = `Hi ${client.first_name}, your ${treatment.name} with ${bizName} is confirmed for ${shortDate} at ${timeStr}.${manageUrl ? ` Manage or reschedule: ${manageUrl}` : ''}`;

  // SMS/WhatsApp — only if beautician has opted in
  if (prefs.booking_confirmation !== false) {
    const channel = prefs.channel || 'whatsapp';
    if (channel === 'whatsapp' && client.phone) {
      const waResult = await sendWhatsApp({ to: client.phone, templateName: 'booking_confirmation', templateParams: [client.first_name, shortDate, timeStr], beauticianId: appt.beautician_id });
      // Fall through to SMS if WhatsApp not available
      if (!waResult && client.phone && BIRD_API_KEY) {
        await sendSMS({ to: client.phone, body: textMsg, beauticianId: appt.beautician_id, messageType: 'booking_confirmation' });
      }
    } else if ((channel === 'sms' || !biz?.whatsapp_phone_id) && client.phone) {
      await sendSMS({ to: client.phone, body: textMsg, beauticianId: appt.beautician_id, messageType: 'booking_confirmation' });
    }
  }

  // Email — always send unless explicitly disabled (prefs.email_confirmation === false)
  if (client.email && prefs.email_confirmation !== false) {
    const depositLine = appt.deposit_cents > 0
      ? `<p style="margin:12px 0 0;color:#6b6560;font-size:14px">Deposit paid: <strong>&pound;${(appt.deposit_cents / 100).toFixed(2)}</strong></p>`
      : '';

    const accent = biz.brand_color || '#C4A882';
    const depositRow = appt.deposit_cents > 0
      ? `<tr><td style="padding:14px 20px">
            <div style="font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#b3a890">Deposit paid</div>
            <div style="font-size:16px;color:#2d2a26;font-weight:600;margin-top:3px">&pound;${(appt.deposit_cents / 100).toFixed(2)} <span style="font-size:12px;font-weight:400;color:#9c9388">&middot; balance on the day</span></div>
          </td></tr>`
      : '';
    const html = emailTemplate({
      bizName,
      brandColor: accent,
      tagline: biz.tagline,
      content: `
        <div style="padding:30px 32px 4px;text-align:center">
          <div style="font-size:30px;line-height:1;margin-bottom:10px">&#9989;</div>
          <div style="font-family:Georgia,'Times New Roman',serif;font-size:22px;color:#2d2a26;margin-bottom:6px">You're booked in, ${client.first_name}</div>
          <p style="margin:0;font-size:14px;line-height:1.6;color:#7a716a">Can't wait to see you. Here are your details.</p>
        </div>
        <div style="padding:22px 32px 6px">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #efe7da;border-radius:14px">
            <tr><td style="padding:14px 20px;border-bottom:1px solid #f4eee4">
              <div style="font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#b3a890">Treatment</div>
              <div style="font-size:16px;color:#2d2a26;font-weight:600;margin-top:3px">${treatment.name}</div>
            </td></tr>
            <tr><td style="padding:14px 20px;border-bottom:1px solid #f4eee4">
              <div style="font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#b3a890">When</div>
              <div style="font-size:16px;color:#2d2a26;font-weight:600;margin-top:3px">${dateStr} &middot; ${timeStr}</div>
            </td></tr>
            <tr><td style="padding:14px 20px;${appt.deposit_cents > 0 ? 'border-bottom:1px solid #f4eee4' : ''}">
              <div style="font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#b3a890">Duration</div>
              <div style="font-size:16px;color:#2d2a26;font-weight:600;margin-top:3px">${treatment.duration_minutes} minutes</div>
            </td></tr>
            ${depositRow}
          </table>
        </div>
        ${manageUrl ? `<div style="padding:18px 32px 4px;text-align:center">
          <a href="${manageUrl}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:13px 30px;border-radius:999px;letter-spacing:0.2px">Manage or reschedule</a>
        </div>` : ''}
        <div style="padding:14px 32px 28px;text-align:center">
          <p style="margin:0;font-size:13px;line-height:1.6;color:#9c9388">Need to change something? Just reply to this email and ${biz.first_name || bizName} will sort it.</p>
        </div>
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
    const channel = prefs.channel || 'whatsapp';
    if (channel === 'whatsapp' && client.phone) {
      const waResult = await sendWhatsApp({ to: client.phone, templateName: 'reminder_24h', templateParams: [client.first_name, treatment.name, timeStr], beauticianId: appt.beautician_id });
      // Fall through to SMS if WhatsApp not available
      if (!waResult && client.phone && BIRD_API_KEY) {
        await sendSMS({ to: client.phone, body: textMsg, beauticianId: appt.beautician_id, messageType: 'appointment_reminder' });
      }
    } else if ((channel === 'sms' || !biz?.whatsapp_phone_id) && client.phone) {
      await sendSMS({ to: client.phone, body: textMsg, beauticianId: appt.beautician_id, messageType: 'appointment_reminder' });
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
