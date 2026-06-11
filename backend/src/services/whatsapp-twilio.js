/**
 * WhatsApp via Twilio BSP — the self-serve onboarding path.
 * (docs/ONBOARDING_AT_SCALE_SPRINT_2026-06-10.md)
 *
 * Same job as the Meta Cloud API senders in notifications.js, behind Twilio's
 * Messages API instead. Selected per beautician by beauticians.wa_provider
 * ('twilio') + beauticians.twilio_wa_sender ('whatsapp:+44...').
 *
 * Deliberately dependency-free: global fetch + node:crypto, no twilio npm
 * package. Everything here is dormant until TWILIO_ACCOUNT_SID and
 * TWILIO_AUTH_TOKEN exist in env — every export no-ops with a warn instead
 * of throwing, so shipping this file changes nothing in production.
 *
 * Env:
 *   TWILIO_ACCOUNT_SID   ACxxxxxxxx... (console home page)
 *   TWILIO_AUTH_TOKEN    auth token (also used for webhook signatures)
 *   TWILIO_CONTENT_SIDS  optional JSON map templateName -> ContentSid,
 *                        e.g. {"booking_confirmation_v3":"HX..."}
 */
import crypto from 'node:crypto';
import logger from '../lib/logger.js';

const TWILIO_API_BASE = process.env.TWILIO_API_BASE || 'https://api.twilio.com';

export function twilioConfigured() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
}

function basicAuthHeader() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  return 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
}

/**
 * Normalise a destination to Twilio's WhatsApp address form: 'whatsapp:+447...'.
 * Accepts E.164 (+447...), UK national (07...), bare digits (447...), or an
 * already-prefixed 'whatsapp:+...' value.
 */
export function toTwilioWhatsAppAddress(raw) {
  if (!raw) return raw;
  let s = String(raw).trim();
  if (/^whatsapp:/i.test(s)) s = s.replace(/^whatsapp:/i, '');
  const digits = s.replace(/[^0-9]/g, '');
  if (!digits) return null;
  let e164;
  if (s.startsWith('+')) e164 = '+' + digits;
  else if (digits.startsWith('00')) e164 = '+' + digits.slice(2);
  else if (digits.startsWith('0')) e164 = '+44' + digits.replace(/^0+/, ''); // UK national
  else e164 = '+' + digits; // assume already country-coded (Meta wa_id style: 447...)
  return `whatsapp:${e164}`;
}

/**
 * POST to Twilio's Messages endpoint (form-encoded, basic auth).
 * Retries transient failures (network, 5xx, 429) twice; 4xx is permanent.
 * Returns the parsed Twilio message resource on success, null on failure.
 */
async function postTwilioMessage(params, label) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const url = `${TWILIO_API_BASE}/2010-04-01/Accounts/${sid}/Messages.json`;
  const body = new URLSearchParams(params).toString();

  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': basicAuthHeader(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
      const text = await res.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

      if (res.ok) {
        logger.info({ sid: data?.sid, to: params.To, label }, 'Twilio WhatsApp message accepted');
        return data;
      }

      const detail = data?.message || data?.raw || `HTTP ${res.status}`;
      const transient = res.status >= 500 || res.status === 429;
      if (transient && attempt < maxRetries) {
        logger.debug({ attempt: attempt + 1, status: res.status, detail }, 'Twilio send transient failure, retrying');
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      logger.error({ status: res.status, code: data?.code, detail, to: params.To, label }, 'Twilio WhatsApp send failed');
      return null;
    } catch (err) {
      if (attempt < maxRetries) {
        logger.debug({ attempt: attempt + 1, err }, 'Twilio send network error, retrying');
        await new Promise(r => setTimeout(r, 1000));
      } else {
        logger.error({ err, to: params.To, label }, 'Twilio WhatsApp send failed after retries');
        return null;
      }
    }
  }
  return null;
}

/**
 * Free-form WhatsApp text via Twilio.
 * CAVEAT: like Meta, Twilio only delivers free-form WhatsApp inside the
 * 24-hour customer service window (error 63016 outside it). Out-of-window
 * sends must use twilioSendTemplate with an approved ContentSid.
 */
export async function twilioSendText({ to, body, sender }) {
  if (!twilioConfigured()) {
    logger.warn('Twilio not configured (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN missing), skipping WhatsApp text');
    return null;
  }
  if (!sender) {
    logger.warn('twilioSendText: no sender (beauticians.twilio_wa_sender unset)');
    return null;
  }
  const To = toTwilioWhatsAppAddress(to);
  const From = toTwilioWhatsAppAddress(sender);
  if (!To || !From) {
    logger.warn({ to, sender }, 'twilioSendText: could not normalise addresses');
    return null;
  }
  return postTwilioMessage({ To, From, Body: body }, 'text');
}

/**
 * Templated WhatsApp message via Twilio Content API templates.
 * @param {string} contentSid  Approved content template SID (HX...)
 * @param {object|array} variables  Positional vars; arrays are converted to
 *                                  Twilio's {"1": "...", "2": "..."} shape.
 */
export async function twilioSendTemplate({ to, contentSid, variables, sender }) {
  if (!twilioConfigured()) {
    logger.warn('Twilio not configured (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN missing), skipping WhatsApp template');
    return null;
  }
  if (!sender) {
    logger.warn('twilioSendTemplate: no sender (beauticians.twilio_wa_sender unset)');
    return null;
  }
  if (!contentSid) {
    logger.warn('twilioSendTemplate: no contentSid');
    return null;
  }
  const To = toTwilioWhatsAppAddress(to);
  const From = toTwilioWhatsAppAddress(sender);
  if (!To || !From) {
    logger.warn({ to, sender }, 'twilioSendTemplate: could not normalise addresses');
    return null;
  }

  let vars = variables || {};
  if (Array.isArray(vars)) {
    const obj = {};
    vars.forEach((v, i) => { obj[String(i + 1)] = String(v); });
    vars = obj;
  }

  return postTwilioMessage({
    To,
    From,
    ContentSid: contentSid,
    ContentVariables: JSON.stringify(vars),
  }, 'template');
}

/**
 * Content SID lookup: env-driven JSON map, parsed once.
 * TWILIO_CONTENT_SIDS = {"booking_confirmation_v3":"HX...", ...}
 * This stands in for a proper DB-backed template registry until the Week 1
 * template-sync job (sprint item 4) lands. Returns null when unmapped.
 */
let _contentSids = null;
export function twilioContentSid(templateName) {
  if (_contentSids === null) {
    try {
      _contentSids = JSON.parse(process.env.TWILIO_CONTENT_SIDS || '{}');
      if (!_contentSids || typeof _contentSids !== 'object') _contentSids = {};
    } catch (err) {
      logger.warn({ err }, 'TWILIO_CONTENT_SIDS is not valid JSON, treating as empty');
      _contentSids = {};
    }
  }
  return _contentSids[templateName] || null;
}

/**
 * Validate Twilio's X-Twilio-Signature header on an inbound webhook.
 * Scheme (https://www.twilio.com/docs/usage/security#validating-requests):
 * HMAC-SHA1 over (full URL + each form param key+value, keys sorted
 * alphabetically), base64-encoded, compared with timingSafeEqual.
 *
 * @param {object} req  Express request (urlencoded body already parsed)
 * @param {string} url  The exact public URL Twilio called
 * @returns {boolean}   true only when TWILIO_AUTH_TOKEN is set AND matches
 */
export function twilioValidateSignature(req, url) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return false;
  const signature = req.headers['x-twilio-signature'];
  if (!signature) return false;

  try {
    let data = url;
    const body = req.body || {};
    for (const key of Object.keys(body).sort()) {
      data += key + body[key];
    }
    const expected = crypto.createHmac('sha1', token).update(data, 'utf8').digest('base64');
    const a = Buffer.from(String(signature));
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (err) {
    logger.warn({ err }, 'twilioValidateSignature error');
    return false;
  }
}
