/**
 * Notification service — email (Resend), SMS (Bird), WhatsApp (Meta).
 *
 * Email defaults to ON for all notifications unless the beautician
 * explicitly disables it. SMS and WhatsApp are opt-in.
 */
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { isMarketingTemplate, isMarketingSmsType, canSendMarketing, findClientByPhone } from '../lib/marketing-guard.js';
import { trackSMSUsage } from './sms-metering.js';
import { checkWhatsAppQuota, trackWhatsAppMessage, trackSmsInMonthlyQuota } from './whatsapp-metering.js';
import { twilioConfigured, twilioSendText, twilioSendTemplate, twilioContentSid } from './whatsapp-twilio.js';

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

export async function sendSMS({ to, body, beauticianId, originator, messageType = 'general', clientId = null, skipThreadLog = false }) {
  if (!BIRD_API_KEY) {
    logger.debug('Bird not configured, skipping SMS');
    return null;
  }
  if (!BIRD_WORKSPACE_ID || !BIRD_SMS_CHANNEL_ID) {
    logger.error('Bird workspace/channel not configured, cannot send SMS');
    return null;
  }

  // PECR: marketing-class SMS respects opt-outs and quiet hours.
  if (isMarketingSmsType(messageType)) {
    const gate = await canSendMarketing(beauticianId, to);
    if (!gate.allowed) {
      logger.info({ messageType, reason: gate.reason, beauticianId }, 'Marketing SMS blocked by PECR guard');
      return null;
    }
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

  // Validate the number before we bother Bird. A malformed/empty/landline value
  // is the usual cause of Bird's "one or more fields are invalid" 422, and the
  // comeback/nudge engines run over hundreds of clients, some with junk numbers.
  // Skip cleanly (and tell the beautician) instead of throwing a cryptic error.
  const e164 = toE164(to);
  if (!/^\+[1-9]\d{9,14}$/.test(e164)) {
    logger.warn({ beauticianId, last4: String(to || '').replace(/\D/g, '').slice(-4) }, 'SMS skipped: number is not a valid mobile');
    await logSendFailure({ beauticianId, to, channel: 'text message', detail: "that number doesn't look like a valid mobile" });
    return null;
  }

  const url = `${BIRD_API_BASE}/workspaces/${BIRD_WORKSPACE_ID}/channels/${channelId}/messages`;
  const payload = {
    receiver: {
      contacts: [{ identifierKey: 'phonenumber', identifierValue: e164 }],
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
        // Bird's useful detail lives in errors[].{parameter,description}; the
        // top-level message is just "one or more fields are invalid". Surface the
        // field(s) so a failure actually tells us what to fix.
        const fieldErrs = Array.isArray(data?.errors)
          ? data.errors.map(e => [e.parameter || e.key, e.description || e.message].filter(Boolean).join(' ')).filter(Boolean).join('; ')
          : '';
        const desc = fieldErrs || data?.message || data?.errors?.[0]?.description || data?.raw || `HTTP ${res.status}`;
        throw new Error(`Bird ${res.status}: ${desc}`);
      }
      logger.info({ to, channelId, id: data?.id }, 'SMS sent via Bird');
      // ai_reply texts are already written to the thread by the front desk;
      // everything else (reminders, confirmations, nudges) gets logged here.
      if (messageType !== 'ai_reply' && !skipThreadLog) logOutboundToThread({ beauticianId, to, clientId, channel: 'sms', body });
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
        await logSendFailure({ beauticianId, to, channel: 'text message', detail: err?.message || err });
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
        const approved = new Set();
        for (const t of data.data) {
          if (!map[t.name] || t.status === 'APPROVED') map[t.name] = t.language;
          if (t.status === 'APPROVED') approved.add(t.name);
        }
        _tplLangCache.set(waba, { map, approved, at: Date.now() });
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
 * Prefer a personalised _v3 template (salon name baked into the body via the
 * starter pack) when one is APPROVED on the sending WABA. Falls back to the
 * requested _v2 name so nothing breaks while v3s are still in review.
 */
async function resolvePersonalisedTemplate(templateName, wabaId) {
  if (!/_v2$/.test(templateName)) return templateName;
  const upgraded = templateName.replace(/_v2$/, '_v3');
  await resolveTemplateLanguage(upgraded, wabaId); // warms the per-WABA cache
  const waba = wabaId || WA_WABA_ID;
  const hit = _tplLangCache.get(waba);
  if (hit?.approved?.has(upgraded)) {
    logger.info({ templateName, upgraded, waba }, 'sendWhatsApp: using personalised template');
    return upgraded;
  }
  return templateName;
}

/**
 * Surface a permanent send failure in "What Florrie did" so the beautician
 * finds out from Florrie, in plain English, not from a confused client.
 */
async function logSendFailure({ beauticianId, to, channel, detail }) {
  try {
    if (!beauticianId) return;
    const client = await findClientByPhone(beauticianId, to);
    const who = client?.first_name || `the number ending ${String(to || '').replace(/\D/g, '').slice(-4)}`;
    await supabase.from('ai_actions').insert({
      beautician_id: beauticianId,
      client_id: client?.id || null,
      action_type: 'send_failed',
      digital_employee: 'front_desk',
      summary: `I couldn't reach ${who} on ${channel}, the message didn't go through`,
      details: { channel, to_last4: String(to || '').replace(/\D/g, '').slice(-4), detail: String(detail || '').slice(0, 300) },
      confidence: 1.0,
      autonomous: true,
      outcome: 'failure',
      notification_sent: false,
    });
  } catch (err) {
    logger.warn({ err }, 'logSendFailure insert failed');
  }
}

/**
 * One inbox means ONE inbox: automated sends (confirmations, reminders,
 * nudges) are written into the messages table so the client's thread shows
 * the whole conversation, not just the chatty parts. Fail-soft.
 */
const TEMPLATE_LABELS = {
  booking_confirmation: 'Booking confirmation',
  reminder_24h: 'Reminder',
  gap_fill_offer: 'Last-minute gap offer',
  rebook_nudge: 'Rebook invite',
  generic_message: null, // params[1] IS the message
};
async function logOutboundToThread({ beauticianId, to, clientId, channel, templateName, templateParams, body }) {
  try {
    if (!beauticianId) return;
    // The email/SMS callers can hand us the client id directly; otherwise match on phone.
    let resolvedClientId = clientId || null;
    if (!resolvedClientId) {
      const client = await findClientByPhone(beauticianId, to);
      if (!client) {
        // The message WAS sent but we cannot place it in a thread. This was a
        // silent return: sends vanished from the feed and Ellie stopped
        // trusting the log. Now it screams in the logs so drops are visible.
        logger.warn({ beauticianId, to: String(to).slice(-4), channel }, 'OUTBOUND SENT BUT NOT THREADED: no client matched this number');
        return;
      }
      resolvedClientId = client.id;
    }
    let content = body;
    if (!content && templateName) {
      const base = String(templateName).replace(/_v\d+$/, '');
      const params = (templateParams || []).map(String);
      // Prefer the REAL message the client received (same copy as the Twilio
      // free-form fallback), so the thread reads like a conversation rather than
      // a terse "Reminder · Korean lash lift · 12:20" system stub.
      const builder = TWILIO_FALLBACK_BODIES[base];
      if (builder) {
        const { data: biz } = await supabase
          .from('beauticians').select('business_name, first_name').eq('id', beauticianId).single();
        content = builder(params, biz?.business_name || biz?.first_name || 'us');
      } else {
        const label = TEMPLATE_LABELS[base];
        if (label === null && params[1]) content = params[1];
        else if (label) content = `${label}${params.length > 1 ? ` · ${params.slice(1).join(' · ')}` : ''}`;
        else content = `Automated message (${base.replace(/_/g, ' ')})`;
      }
    }
    if (!content) return;
    await supabase.from('messages').insert({
      beautician_id: beauticianId,
      client_id: resolvedClientId,
      direction: 'outbound',
      channel,
      content,
      ai_handled: true,
    });
  } catch (err) {
    logger.warn({ err }, 'logOutboundToThread failed (send already succeeded)');
  }
}

/**
 * Local fallback bodies for the Twilio path, mirroring the starter-pack
 * wording in whatsapp-config.js starterPackFor(). Used ONLY when a template
 * has no ContentSid mapped in TWILIO_CONTENT_SIDS yet: we render the same
 * copy with params interpolated and send it free-form.
 *
 * CAVEAT: Twilio (like Meta) only delivers free-form WhatsApp inside the
 * 24-hour customer service window. Outside it the send fails (Twilio error
 * 63016). So this fallback covers reactive sends during conversations, but
 * proactive out-of-window sends NEED the ContentSid mapping — see
 * docs/TWILIO_GO_LIVE_CHECKLIST.md.
 */
const TWILIO_FALLBACK_BODIES = {
  booking_confirmation: (p, biz) => `Hi ${p[0]}! It's ${biz} 🌸 Your appointment is confirmed for ${p[1]} at ${p[2]}. Reply here if anything needs changing. See you then!`,
  reminder_24h: (p, biz) => `Hi ${p[0]}, it's ${biz}! A little reminder that your ${p[1]} is tomorrow at ${p[2]}. Reply if you need to reschedule. See you soon 🌸`,
  gap_fill_offer: (p, biz) => `Hi ${p[0]}, it's ${biz}! A spot has just opened up on ${p[1]} at ${p[2]}. Fancy it? Reply YES and it's yours, or tell me a time that suits.`,
  rebook_nudge: (p, biz) => `Hi ${p[0]}, it's ${biz} 🌸 It's been a little while! Fancy getting booked back in? Reply here and I'll find you a time.`,
  generic_message: (p, biz) => `Hi ${p[0]}! It's ${biz} 🌸 ${p[1] || ''} Reply here anytime.`,
};

/**
 * Twilio leg of sendWhatsApp. Quota + PECR are already checked by the caller;
 * this handles ContentSid resolution (prefer the personalised _v3 name),
 * the free-form fallback, then the same post-send wrappers as the Meta path
 * (trackWhatsAppMessage, logOutboundToThread, logSendFailure).
 */
async function sendWhatsAppTemplateViaTwilio({ to, templateName, templateParams, sender, beauticianId, bizName, clientId = null, skipThreadLog = false }) {
  // Mirror resolvePersonalisedTemplate: a mapped _v3 (salon name in the body)
  // wins over the requested _v2 name.
  const upgraded = /_v2$/.test(templateName) ? templateName.replace(/_v2$/, '_v3') : null;
  const upgradedSid = upgraded ? twilioContentSid(upgraded) : null;
  const contentSid = upgradedSid || twilioContentSid(templateName);
  const sentAs = upgradedSid ? upgraded : templateName;

  let result = null;
  if (contentSid) {
    result = await twilioSendTemplate({ to, contentSid, variables: templateParams || [], sender });
  } else {
    const base = String(templateName).replace(/_v\d+$/, '');
    const render = TWILIO_FALLBACK_BODIES[base];
    if (!render) {
      logger.warn({ templateName }, 'Twilio WhatsApp: no ContentSid mapped and no local fallback body');
      await logSendFailure({ beauticianId, to, channel: 'WhatsApp', detail: `No Twilio content template for ${templateName}` });
      return null;
    }
    logger.info({ templateName }, 'Twilio WhatsApp: no ContentSid mapped, sending free-form fallback (24h window only)');
    const body = render((templateParams || []).map(String), bizName || 'your salon');
    result = await twilioSendText({ to, body, sender });
  }

  if (result) {
    logger.info({ to, templateName: sentAs, provider: 'twilio', contentSid: contentSid || null }, 'WhatsApp template sent');
    if (beauticianId) await trackWhatsAppMessage(beauticianId);
    if (!skipThreadLog) logOutboundToThread({ beauticianId, to, clientId, channel: 'whatsapp', templateName, templateParams });
    return result;
  }
  await logSendFailure({ beauticianId, to, channel: 'WhatsApp', detail: `Twilio send failed (${sentAs})` });
  return null;
}

/**
 * Send a WhatsApp template message (for booking confirmations, reminders etc.)
 * beauticianId is required — used to look up per-beautician provider config
 * (wa_provider: meta | twilio), phone_number_id / twilio_wa_sender, and quota.
 */
export async function sendWhatsApp({ to, templateName, templateParams, beauticianId, clientId = null, skipThreadLog = false }) {
  // Resolve provider + sender config from the beautician record. Twilio
  // tenants don't need the Meta token at all, so this runs before the
  // WA_TOKEN gate.
  let phoneNumberId = null;
  let useTwilio = false;
  let twilioSender = null;
  let bizName = null;
  if (beauticianId) {
    const { data: b } = await supabase
      .from('beauticians')
      .select('whatsapp_phone_id, wa_provider, twilio_wa_sender, business_name, first_name')
      .eq('id', beauticianId)
      .single();
    phoneNumberId = b?.whatsapp_phone_id;
    twilioSender = b?.twilio_wa_sender || null;
    bizName = b?.business_name || b?.first_name || null;
    useTwilio = b?.wa_provider === 'twilio' && !!twilioSender && twilioConfigured();

    const quota = await checkWhatsAppQuota(beauticianId);
    // checkWhatsAppQuota doubles as a Meta config check: it returns
    // 'no_whatsapp_number' when whatsapp_phone_id/whatsapp_connected are
    // unset. Twilio tenants legitimately have no Meta phone id, so that one
    // reason is waived for them (wa_provider + twilio_wa_sender are the
    // explicit opt-in). The allowance itself never hard-blocks — overage is
    // billed — so all other behaviour is identical across providers.
    if (!quota.allowed && !(useTwilio && quota.reason === 'no_whatsapp_number')) {
      logger.warn({ beauticianId, reason: quota.reason }, 'WhatsApp send blocked — quota or config issue');
      return null;
    }
  }

  // PECR: marketing-class templates respect opt-outs and quiet hours.
  // Provider-agnostic — guards BOTH the Meta and Twilio paths.
  if (isMarketingTemplate(templateName)) {
    const gate = await canSendMarketing(beauticianId, to);
    if (!gate.allowed) {
      logger.info({ templateName, reason: gate.reason, beauticianId }, 'Marketing WhatsApp blocked by PECR guard');
      return null;
    }
  }

  if (useTwilio) {
    return sendWhatsAppTemplateViaTwilio({ to, templateName, templateParams, sender: twilioSender, beauticianId, bizName, clientId, skipThreadLog });
  }

  if (!WA_TOKEN) {
    logger.debug('WhatsApp token not configured, skipping');
    return null;
  }

  if (!phoneNumberId) {
    logger.debug({ beauticianId }, 'No WhatsApp phone_number_id, skipping');
    return null;
  }

  // Resolve the language from the WABA that actually owns this sending phone.
  const sendingWaba = await getPhoneParentWaba(phoneNumberId);
  // Personalised _v3 templates (salon name in the body) win when approved.
  templateName = await resolvePersonalisedTemplate(templateName, sendingWaba);
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
        if (!skipThreadLog) logOutboundToThread({ beauticianId, to, clientId, channel: 'whatsapp', templateName, templateParams });
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
  await logSendFailure({ beauticianId, to, channel: 'WhatsApp', detail: lastErr?.message || JSON.stringify(lastErr || {}).slice(0, 200) });
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
  // Resolve provider + sender config from the beautician record (Twilio
  // tenants don't need the Meta token, so this runs before the WA_TOKEN gate).
  let phoneNumberId = null;
  if (beauticianId) {
    const { data: b } = await supabase
      .from('beauticians')
      .select('whatsapp_phone_id, wa_provider, twilio_wa_sender')
      .eq('id', beauticianId)
      .single();
    phoneNumberId = b?.whatsapp_phone_id;
    const twilioSender = b?.twilio_wa_sender || null;
    const useTwilio = b?.wa_provider === 'twilio' && !!twilioSender && twilioConfigured();

    const quota = await checkWhatsAppQuota(beauticianId);
    // Twilio tenants have no Meta phone id, so the 'no_whatsapp_number'
    // config half of the quota check is waived for them (see sendWhatsApp).
    if (!quota.allowed && !(useTwilio && quota.reason === 'no_whatsapp_number')) {
      logger.warn({ beauticianId, reason: quota.reason }, 'WhatsApp text blocked — quota or config issue');
      return null;
    }

    if (useTwilio) {
      // Free-form is only deliverable inside the 24h window on Twilio too —
      // same constraint as the Meta path below, same callers, same semantics.
      const result = await twilioSendText({ to, body, sender: twilioSender });
      if (result) {
        logger.info({ to, provider: 'twilio' }, 'WhatsApp text sent');
        await trackWhatsAppMessage(beauticianId);
        return result;
      }
      logger.error({ to, beauticianId }, 'WhatsApp text send failed (twilio)');
      await logSendFailure({ beauticianId, to, channel: 'WhatsApp', detail: 'Twilio free-form send failed' });
      return null;
    }
  }

  if (!WA_TOKEN) {
    logger.debug('WhatsApp token not configured, skipping freeform');
    return null;
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

  // WhatsApp: client has an active WhatsApp ID, a provider is configured
  // (Meta token or Twilio creds), and beautician has a registered number
  if (client?.whatsapp_id && (WA_TOKEN || twilioConfigured()) && beauticianPrefs?.whatsapp_connected) return 'whatsapp';

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
  // Master pause — no proactive outbound goes out on the beautician's behalf.
  if (beauticianPrefs?.paused) return { skipped: 'paused' };
  // Path 1: active WhatsApp session — send free-form, it'll land immediately
  if (client?.whatsapp_id && (WA_TOKEN || twilioConfigured()) && beauticianPrefs?.whatsapp_connected && inWhatsAppSession(client)) {
    const result = await sendWhatsAppText({ to: client.whatsapp_id, body, beauticianId });
    if (result) {
      await logComms(beauticianId, client.id, 'whatsapp', 'outbound', body);
      return { channel: 'whatsapp_freeform', result };
    }
  }

  // Path 2: WhatsApp template (client has opted in, we have a template, session not required)
  if (client?.whatsapp_id && (WA_TOKEN || twilioConfigured()) && beauticianPrefs?.whatsapp_connected && templateName) {
    const result = await sendWhatsApp({ to: client.whatsapp_id, templateName, templateParams, beauticianId, clientId: client.id, skipThreadLog: true });
    if (result) {
      await logComms(beauticianId, client.id, 'whatsapp', 'outbound', body);
      return { channel: 'whatsapp_template', result };
    }
  }

  // Path 3: SMS — universal fallback for proactive outbound
  if (client?.phone && BIRD_API_KEY) {
    const result = await sendSMS({ to: client.phone, body, beauticianId, messageType: 'ai_checkin', clientId: client.id, skipThreadLog: true });
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

function emailTemplate({ bizName, brandColor, tagline, content, logoUrl, signOff }) {
  const color = brandColor || '#C4A882';
  // Header: the beautician's own logo when she's uploaded one, otherwise the
  // flower mark. Either way the brand colour is the backdrop and her name shows.
  const header = logoUrl
    ? `<img src="${logoUrl}" alt="${bizName}" width="60" height="60" style="display:block;margin:0 auto 8px;border-radius:14px;object-fit:cover;background:#ffffff" />`
    : `<div style="font-size:24px;line-height:1;margin-bottom:6px">&#127800;</div>`;
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#fbf7f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fbf7f4;padding:28px 16px">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fbf7f4;border-radius:16px;overflow:hidden;box-shadow:0 6px 24px rgba(120,90,60,0.12)">
  <tr><td style="background:${color};padding:30px 32px 26px;text-align:center">
    ${header}
    <div style="font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:700;color:#ffffff;letter-spacing:0.3px">${bizName}</div>
    ${tagline ? `<div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:rgba(255,255,255,0.85);margin-top:5px">${tagline}</div>` : ''}
  </td></tr>
  <tr><td style="padding:0">${content}</td></tr>
  <tr><td style="background:#f4eee4;padding:18px 32px;text-align:center">
    ${signOff ? `<div style="font-size:14px;color:#6b6560;font-style:italic;margin-bottom:8px">${signOff}</div>` : ''}
    <div style="font-size:12px;color:#8a7a5e;font-weight:600">${bizName}</div>
    <div style="font-size:10px;color:#cabfae;margin-top:6px">Powered by Florrie</div>
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
    .select('*, clients(first_name, phone, email), treatments(name, duration_minutes), beauticians(business_name, first_name, client_reminder_prefs, brand_color, booking_slug, tagline, logo_url)')
    .eq('id', appointmentId)
    .single();

  if (!appt) return;

  const client = appt.clients;
  const treatment = appt.treatments;
  const biz = appt.beauticians;
  const prefs = biz?.client_reminder_prefs || {};
  // Master pause — when on, nothing automated goes out on the beautician's behalf.
  if (prefs.paused) return;
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
      const waResult = await sendWhatsApp({ to: client.phone, templateName: 'booking_confirmation_v2', templateParams: [client.first_name, shortDate, timeStr], beauticianId: appt.beautician_id });
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
      logoUrl: biz.logo_url,
      signOff: prefs.email_sign_off,
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
    logOutboundToThread({ beauticianId: appt.beautician_id, clientId: appt.client_id, channel: 'email', body: textMsg });
  }
}

/**
 * Send a 24-hour reminder.
 * Email sends by default unless explicitly disabled.
 */
export async function notifyReminder24h(appointmentId) {
  const { data: appt } = await supabase
    .from('appointments')
    .select('*, clients(first_name, phone, email), treatments(name, duration_minutes), beauticians(business_name, first_name, client_reminder_prefs, brand_color, logo_url, tagline)')
    .eq('id', appointmentId)
    .single();

  if (!appt) return;

  const client = appt.clients;
  const treatment = appt.treatments;
  const biz = appt.beauticians;
  const prefs = biz?.client_reminder_prefs || {};
  // Master pause — when on, nothing automated goes out on the beautician's behalf.
  if (prefs.paused) return;

  // Idempotency: one reminder per appointment, ever. The reminder job runs hourly
  // AND on every startup, with a 1-hour window — so each deploy re-ran it and the
  // same client got the reminder several times. Claim the appointment by INSERTING
  // the ai_actions marker FIRST. A partial UNIQUE index (migration 065) is the real
  // guard: a concurrent/duplicate run hits a unique violation (23505), which we treat
  // as "already reminded" and bail out before sending. Insert-first beats the old
  // check-then-insert race where two overlapping runs could both pass the count check.
  const { error: markerError } = await supabase.from('ai_actions').insert({
    beautician_id: appt.beautician_id,
    action_type: 'appointment_reminder',
    digital_employee: 'calendar',
    outcome: 'success',
    summary: `Sent ${appt.clients?.first_name || 'the client'}'s 24-hour reminder`,
    client_id: appt.client_id,
    appointment_id: appointmentId,
  });
  if (markerError) {
    // 23505 = unique violation → another run already claimed this reminder. Skip silently.
    if (markerError.code === '23505') return;
    // Any other insert failure: log and bail rather than risk an unguarded duplicate send.
    logger.warn({ err: markerError, appointmentId }, 'Could not record reminder marker (skipping send)');
    return;
  }

  const bizName = biz?.business_name || biz?.first_name;
  const timeStr = new Date(appt.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const dateStr = new Date(appt.starts_at).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  const textMsg = `Hi ${client.first_name}, just a reminder your ${treatment.name} with ${bizName} is tomorrow at ${timeStr}. Reply here if you need to change anything. See you then!`;

  // SMS/WhatsApp — only if opted in
  if (prefs.reminder_24h !== false) {
    const channel = prefs.channel || 'whatsapp';
    if (channel === 'whatsapp' && client.phone) {
      const waResult = await sendWhatsApp({ to: client.phone, templateName: 'reminder_24h_v2', templateParams: [client.first_name, treatment.name, timeStr], beauticianId: appt.beautician_id });
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
      tagline: biz.tagline,
      logoUrl: biz.logo_url,
      signOff: prefs.email_sign_off,
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
    // Show the emailed reminder in the client's thread too, so the beautician
    // can see exactly what went out (email sends were previously invisible here).
    logOutboundToThread({ beauticianId: appt.beautician_id, clientId: appt.client_id, channel: 'email', body: textMsg });
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
    // Only confirmed bookings get a 24h reminder. A 'pending' unpaid-deposit
    // booking can still be auto-cancelled by the 15-minute cleanup, so reminding
    // about it is wrong.
    .eq('status', 'confirmed')
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

/**
 * Send a message on the channel the client actually uses, mirroring the front
 * desk's escalation routing: Instagram for an IG regular, WhatsApp for a WA one,
 * SMS as the fallback. Returns { ok, channel } so callers can report what
 * happened. This is the SEND step only; consent, caps and the known-client hold
 * live in guardedSend and must wrap this, never the other way round.
 */
export async function sendOnPreferredChannel({ client, body, beautician, messageType = 'general' }) {
  const channel = client?.preferred_channel || 'sms';
  try {
    if (channel === 'instagram' && client?.instagram_id) {
      const sent = await sendInstagramDM({
        recipientId: client.instagram_id,
        text: body,
        pageToken: beautician?.instagram_page_token,
      });
      return { ok: !!sent, channel: 'instagram' };
    }
    if (channel === 'whatsapp' && beautician?.whatsapp_phone_id && client?.whatsapp_id) {
      const sent = await sendWhatsAppText({ to: client.whatsapp_id, body, beauticianId: beautician.id });
      return { ok: !!sent, channel: 'whatsapp' };
    }
    if (client?.phone) {
      const sent = await sendSMS({ to: client.phone, body, beauticianId: beautician?.id, messageType });
      return { ok: !!sent, channel: 'sms' };
    }
  } catch (err) {
    logger.error({ err, channel }, 'sendOnPreferredChannel failed');
  }
  return { ok: false, channel };
}
