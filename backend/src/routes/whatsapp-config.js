/**
 * WhatsApp Configuration Routes
 *
 * Handles phone number registration for Florrie's WABA.
 * Each beautician adds their own number. Florrie pays Meta, beauticians just connect.
 *
 * Flow:
 *   POST   /api/whatsapp/register     add number to WABA + request OTP via SMS
 *   POST   /api/whatsapp/resend-code  request another OTP (user tapped "resend")
 *   POST   /api/whatsapp/verify       verify OTP + activate number for Cloud API
 *   POST   /api/whatsapp/diagnose     dry-run probe that returns what Meta would do, without
 *                                     sending an SMS or mutating beautician state
 *   GET    /api/whatsapp/status       connection status + monthly usage
 *   GET    /api/whatsapp/diagnostics  last 10 diagnostic rows for this beautician
 *   DELETE /api/whatsapp/disconnect   remove number from WABA
 *
 * Meta's 4-step registration (what this actually does under the hood):
 *   1. POST /{WABA_ID}/phone_numbers       add the number as a WABA entry (with verified_name)
 *   2. POST /{phone_number_id}/request_code Meta sends SMS to the number
 *   3. POST /{phone_number_id}/verify_code  confirm ownership
 *   4. POST /{phone_number_id}/register     activate for Cloud API (with PIN)
 *
 * Env vars required:
 *   WHATSAPP_TOKEN       Florrie's system user token (permanent)
 *   WHATSAPP_WABA_ID     Florrie's WhatsApp Business Account ID
 *   WHATSAPP_API_VERSION e.g. "v21.0" (defaults to v21.0)
 */

import express from 'express';
import crypto from 'crypto';
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { getMonthlyUsage } from '../services/whatsapp-metering.js';

const router = express.Router();
router.use(requireAuth);

const WA_TOKEN = process.env.WHATSAPP_TOKEN;
const WABA_ID = process.env.WHATSAPP_WABA_ID;
const API_VER = process.env.WHATSAPP_API_VERSION || 'v21.0';
const GRAPH = `https://graph.facebook.com/${API_VER}`;

function metaHeaders() {
  return {
    'Authorization': `Bearer ${WA_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

/** Normalise a UK/intl phone number to E.164 digits only (no +) */
function normalisePhone(raw) {
  let cleaned = raw.replace(/\s+/g, '').replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) cleaned = cleaned.slice(1);
  // UK: 07xxx (11 digits) becomes 447xxx
  if (cleaned.startsWith('07') && cleaned.length === 11) {
    cleaned = '44' + cleaned.slice(1);
  }
  return cleaned;
}

/** Basic sanity check for a UK/intl E.164 number (digits only, no +) */
function isValidE164(digits) {
  if (!/^\d{10,15}$/.test(digits)) return false;
  // UK mobile sanity: 44 + 10 digits, starting 447
  if (digits.startsWith('44')) {
    return digits.length === 12 && digits[2] === '7';
  }
  return true;
}

/** Split E.164 number into country code + national number */
function splitPhone(e164) {
  if (e164.startsWith('44')) return { cc: '44', number: e164.slice(2) };
  if (e164.startsWith('1') && e164.length === 11) return { cc: '1', number: e164.slice(1) };
  return { cc: e164.slice(0, 2), number: e164.slice(2) };
}

/** Generate a random 6-digit PIN for WhatsApp 2FA */
function generatePin() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Pull out every useful field from Meta's error response shape.
 * Meta's error payloads look like:
 *   { error: { code, error_subcode, message, type, error_user_msg, error_user_title, fbtrace_id } }
 */
function extractMetaError(responseBody) {
  const err = responseBody?.error || {};
  return {
    code: err.code ?? null,
    subcode: err.error_subcode ?? null,
    type: err.type ?? null,
    message: err.message ?? null,
    userMsg: err.error_user_msg ?? null,
    userTitle: err.error_user_title ?? null,
    fbtraceId: err.fbtrace_id ?? null,
  };
}

/**
 * Translate a Meta error into a diagnosis the frontend can render and an
 * action we can recommend. This is the whole point of this refactor: turn
 * opaque Meta errors into specific guidance.
 *
 * Returns { diagnosis, suggestedAction, retryAfter, userMessage }.
 *
 * Meta error codes we care about (documented + observed in the wild):
 *   100 / 33            unknown path components (usually bad WABA/token config)
 *   100 / 2388008       phone number already associated with another WABA
 *   100 / 2388009       verified_name already in use (allow_duplicate fixes)
 *   100 / 2388023       phone number still active on WhatsApp consumer app
 *   100 / 2388024       phone migration pending (Meta-side cooldown)
 *   131005              phone number not registered with Cloud API
 *   131031              phone number migration to new WABA required
 *   133004/5/6          PIN-related register failures
 *   190                 invalid OAuth token
 *   368                 rate limit / temp block
 */
function interpretMetaError(meta, { context = 'register', now = new Date() } = {}) {
  const code = meta.code;
  const sub = meta.subcode;
  const userMsg = (meta.userMsg || meta.message || '').toLowerCase();

  // consumer WhatsApp app conflict
  if (sub === 2388023 || /already.*whatsapp|registered.*consumer|already active on whatsapp/i.test(userMsg)) {
    return {
      diagnosis: 'on_consumer_whatsapp',
      suggestedAction: 'delete_account',
      retryAfter: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
      userMessage:
        "This number is currently registered on WhatsApp or WhatsApp Business. Open that app, go to Settings then Account then Delete my account, and confirm with this exact number. Wait 2 hours for Meta to release it, then try again.",
    };
  }

  // number held by another WhatsApp Business API provider
  if (sub === 2388008 || /associated with.*business|already.*business account|tied to/i.test(userMsg)) {
    return {
      diagnosis: 'on_other_waba',
      suggestedAction: 'contact_bsp',
      retryAfter: null,
      userMessage:
        "This number is already registered with another WhatsApp Business API provider. Only they can release it. Sign into that provider's dashboard and remove the number, or contact Meta support.",
    };
  }

  // verified_name collision (Meta rejects duplicate display names unless allow_duplicate set)
  if (sub === 2388009 || /verified.name|display name.*exists/i.test(userMsg)) {
    return {
      diagnosis: 'verified_name_collision',
      suggestedAction: 'retry_now',
      retryAfter: null,
      userMessage:
        "Your business display name is already in use elsewhere on WhatsApp. We've retried with the duplicate-name override, but if this persists, change your business name in Settings to something unique.",
    };
  }

  // Meta-side cooldown after deletion
  if (sub === 2388024 || /migration.*pending|pending.*review|still processing/i.test(userMsg)) {
    return {
      diagnosis: 'cooldown_active',
      suggestedAction: 'wait',
      retryAfter: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      userMessage:
        "Meta is still processing a recent change to this number. This usually clears within a few hours but can take up to 24 hours. Try again later.",
    };
  }

  // invalid number format / country
  if (code === 100 && /invalid.*phone|phone.*invalid|country code/i.test(userMsg)) {
    return {
      diagnosis: 'invalid_number',
      suggestedAction: 'retry_now',
      retryAfter: null,
      userMessage:
        "Meta didn't recognise this as a valid mobile number. Check the country code and try again.",
    };
  }

  // rate limit / temp block
  if (code === 368 || code === 4 || code === 17 || /rate.?limit|too many requests/i.test(userMsg)) {
    return {
      diagnosis: 'rate_limit',
      suggestedAction: 'wait',
      retryAfter: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      userMessage:
        "Too many attempts in a short time. Wait an hour and try again.",
    };
  }

  // WABA not approved / token invalid
  if (code === 190 || code === 200 || /access token|permission|not approved/i.test(userMsg)) {
    return {
      diagnosis: 'waba_not_approved',
      suggestedAction: 'contact_support',
      retryAfter: null,
      userMessage:
        "There's a configuration issue on Florrie's side. We've been notified and will investigate. Try again later or contact support.",
    };
  }

  // Fallback: unknown
  return {
    diagnosis: 'unknown',
    suggestedAction: 'contact_support',
    retryAfter: null,
    userMessage:
      meta.userMsg ||
      meta.message ||
      "Meta rejected the connection but didn't tell us why. Take a screenshot of this and send it to support.",
  };
}

/**
 * Write a diagnostic row. Silent on failure (diagnostics must never break the primary flow).
 */
async function logDiagnostic(row) {
  try {
    await supabase.from('whatsapp_diagnostics').insert(row);
  } catch (err) {
    logger.warn({ err }, 'Failed to write whatsapp_diagnostics row');
  }
}

/** Ask Meta to send an OTP to the given phone_number_id via SMS */
async function requestOtp(phoneNumberId) {
  const res = await fetch(`${GRAPH}/${phoneNumberId}/request_code`, {
    method: 'POST',
    headers: metaHeaders(),
    body: JSON.stringify({ code_method: 'SMS', language: 'en' }),
  });
  const data = await res.json();
  return { ok: res.ok, data };
}

/**
 * Try to add a phone number to our WABA, with full error capture + interpretation.
 * Shared by /register and /diagnose.
 *
 * Returns one of:
 *   { ok: true, phoneNumberId, alreadyOnWaba: boolean }
 *   { ok: false, diagnostic, raw }
 */
async function addPhoneNumberToWaba({ cc, number, verifiedName, e164 }) {
  // First, check if it's already on our WABA from a previous half-finished attempt.
  // Cheaper than POSTing and getting rejected, and doesn't count towards rate limits.
  const filter = encodeURIComponent(
    JSON.stringify([{ field: 'phone_number', operator: 'CONTAIN', value: e164 }])
  );
  try {
    const lookup = await fetch(`${GRAPH}/${WABA_ID}/phone_numbers?filtering=${filter}`, {
      headers: metaHeaders(),
    });
    const lookupData = await lookup.json();
    const existing = lookupData?.data?.[0]?.id;
    if (existing) {
      return { ok: true, phoneNumberId: existing, alreadyOnWaba: true };
    }
  } catch (err) {
    // non-fatal, fall through to POST attempt
    logger.debug({ err }, 'WABA lookup before add failed, attempting POST');
  }

  // Actually try to add. allow_duplicate_verified_names prevents rejections when
  // another beautician already has the same business display name registered,
  // which is a common cause of generic 100 errors on shared WABAs.
  const body = {
    cc,
    phone_number: number,
    verified_name: verifiedName,
    allow_duplicate_verified_names: true,
  };

  const addRes = await fetch(`${GRAPH}/${WABA_ID}/phone_numbers`, {
    method: 'POST',
    headers: metaHeaders(),
    body: JSON.stringify(body),
  });
  const addData = await addRes.json();

  if (addRes.ok && addData?.id) {
    return { ok: true, phoneNumberId: addData.id, alreadyOnWaba: false };
  }

  // Failed. Try one more lookup in case the number was added but the response was odd.
  try {
    const lookup2 = await fetch(`${GRAPH}/${WABA_ID}/phone_numbers?filtering=${filter}`, {
      headers: metaHeaders(),
    });
    const lookup2Data = await lookup2.json();
    const existing = lookup2Data?.data?.[0]?.id;
    if (existing) {
      return { ok: true, phoneNumberId: existing, alreadyOnWaba: true };
    }
  } catch {}

  const meta = extractMetaError(addData);
  const diagnostic = interpretMetaError(meta, { context: 'add_number' });
  return { ok: false, diagnostic, raw: addData, meta };
}

/**
 * POST /register
 * Register a phone number with Florrie's WABA, then trigger an SMS OTP.
 * Body: { phone: "+447700900123" }
 */
router.post('/register', async (req, res) => {
  if (!WA_TOKEN || !WABA_ID) {
    return res.status(503).json({ error: 'WhatsApp not configured on this server' });
  }

  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone is required' });

  const beauticianId = req.beautician.id;

  try {
    const e164 = normalisePhone(phone);
    if (!isValidE164(e164)) {
      return res.status(400).json({
        error: "That number doesn't look right. UK mobiles should be 11 digits starting with 07.",
      });
    }
    const { cc, number } = splitPhone(e164);

    // Meta requires a verified_name (the display name clients see) on every new
    // WABA number. Source it from the beautician's business_name; bail early
    // with a clear message if they haven't set one.
    const { data: profile } = await supabase
      .from('beauticians')
      .select('business_name')
      .eq('id', beauticianId)
      .single();

    const verifiedName = (profile?.business_name || '').trim();
    if (!verifiedName) {
      return res.status(400).json({
        error: "Set your business name in Settings first. WhatsApp uses it as the display name your clients will see.",
      });
    }

    // Step 1: add the number to Florrie's WABA
    const add = await addPhoneNumberToWaba({ cc, number, verifiedName, e164 });

    if (!add.ok) {
      const { diagnostic, raw, meta } = add;
      await logDiagnostic({
        beautician_id: beauticianId,
        phone: `+${e164}`,
        stage: 'add_number',
        success: false,
        meta_code: meta.code,
        meta_subcode: meta.subcode,
        meta_type: meta.type,
        meta_user_msg: meta.userMsg,
        meta_user_title: meta.userTitle,
        meta_message: meta.message,
        fbtrace_id: meta.fbtraceId,
        raw_response: raw,
        diagnosis: diagnostic.diagnosis,
        suggested_action: diagnostic.suggestedAction,
        retry_after: diagnostic.retryAfter,
      });
      logger.warn(
        { beauticianId, phone: `+${e164}`, meta, diagnosis: diagnostic.diagnosis },
        'WhatsApp add-number failed'
      );
      return res.status(400).json({
        error: diagnostic.userMessage,
        diagnostic: {
          code: diagnostic.diagnosis,
          suggestedAction: diagnostic.suggestedAction,
          retryAfter: diagnostic.retryAfter,
        },
        meta_code: meta.code,
        meta_subcode: meta.subcode,
        meta_user_title: meta.userTitle,
        fbtrace_id: meta.fbtraceId,
      });
    }

    const phoneNumberId = add.phoneNumberId;

    // Step 2: actually send the SMS
    const otp = await requestOtp(phoneNumberId);
    if (!otp.ok) {
      const meta = extractMetaError(otp.data);
      const diagnostic = interpretMetaError(meta, { context: 'request_otp' });
      await logDiagnostic({
        beautician_id: beauticianId,
        phone: `+${e164}`,
        stage: 'request_otp',
        success: false,
        meta_code: meta.code,
        meta_subcode: meta.subcode,
        meta_type: meta.type,
        meta_user_msg: meta.userMsg,
        meta_user_title: meta.userTitle,
        meta_message: meta.message,
        fbtrace_id: meta.fbtraceId,
        raw_response: otp.data,
        diagnosis: diagnostic.diagnosis,
        suggested_action: diagnostic.suggestedAction,
        retry_after: diagnostic.retryAfter,
      });
      logger.warn({ beauticianId, phone: `+${e164}`, meta, phoneNumberId }, 'Meta OTP request failed');
      return res.status(400).json({
        error: diagnostic.userMessage,
        diagnostic: {
          code: diagnostic.diagnosis,
          suggestedAction: diagnostic.suggestedAction,
          retryAfter: diagnostic.retryAfter,
        },
        meta_code: meta.code,
        meta_subcode: meta.subcode,
        fbtrace_id: meta.fbtraceId,
      });
    }

    // Log the successful add so we can see the whole journey in diagnostics
    await logDiagnostic({
      beautician_id: beauticianId,
      phone: `+${e164}`,
      stage: 'add_number',
      success: true,
      diagnosis: add.alreadyOnWaba ? 'already_on_waba' : 'clean_add',
    });

    // Generate + persist a PIN now so /verify can use it
    const pin = generatePin();

    await supabase
      .from('beauticians')
      .update({
        whatsapp_pending_phone: `+${e164}`,
        whatsapp_phone_id: phoneNumberId,
        whatsapp_pin: pin,
        whatsapp_connected: false,
      })
      .eq('id', beauticianId);

    logger.info({ beauticianId, phoneNumberId, phone: `+${e164}` }, 'WhatsApp number registered, OTP SMS sent');

    return res.json({
      success: true,
      phone_number_id: phoneNumberId,
      message: `Verification code sent to +${e164}`,
      already_on_waba: add.alreadyOnWaba,
    });
  } catch (err) {
    logger.error({ err }, 'WhatsApp register error');
    return res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * POST /diagnose
 * Dry-run probe. Same Meta calls as /register but no SMS sent and no beautician row
 * mutated. Safe to call from the UI repeatedly to give the user a live status check.
 * Body: { phone: "+447700900123" }
 */
router.post('/diagnose', async (req, res) => {
  if (!WA_TOKEN || !WABA_ID) {
    return res.status(503).json({ error: 'WhatsApp not configured on this server' });
  }

  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone is required' });

  const beauticianId = req.beautician.id;

  try {
    const e164 = normalisePhone(phone);
    if (!isValidE164(e164)) {
      return res.json({
        status: 'invalid_format',
        ready: false,
        userMessage: "That number doesn't look right. UK mobiles should be 11 digits starting with 07.",
      });
    }

    const { cc, number } = splitPhone(e164);

    const { data: profile } = await supabase
      .from('beauticians')
      .select('business_name')
      .eq('id', beauticianId)
      .single();
    const verifiedName = (profile?.business_name || '').trim() || 'Florrie Beautician';

    const add = await addPhoneNumberToWaba({ cc, number, verifiedName, e164 });

    if (add.ok) {
      return res.json({
        status: add.alreadyOnWaba ? 'already_on_waba' : 'ready',
        ready: true,
        phone_number_id: add.phoneNumberId,
        userMessage: add.alreadyOnWaba
          ? "This number is already registered on our side from a previous attempt. Tap Send verification code to finish connecting."
          : "This number is clean and ready to connect. Tap Send verification code to continue.",
      });
    }

    const { diagnostic, raw, meta } = add;
    await logDiagnostic({
      beautician_id: beauticianId,
      phone: `+${e164}`,
      stage: 'add_number',
      success: false,
      meta_code: meta.code,
      meta_subcode: meta.subcode,
      meta_type: meta.type,
      meta_user_msg: meta.userMsg,
      meta_user_title: meta.userTitle,
      meta_message: meta.message,
      fbtrace_id: meta.fbtraceId,
      raw_response: raw,
      diagnosis: `diagnose:${diagnostic.diagnosis}`,
      suggested_action: diagnostic.suggestedAction,
      retry_after: diagnostic.retryAfter,
    });

    return res.json({
      status: diagnostic.diagnosis,
      ready: false,
      userMessage: diagnostic.userMessage,
      suggestedAction: diagnostic.suggestedAction,
      retryAfter: diagnostic.retryAfter,
      meta_code: meta.code,
      meta_subcode: meta.subcode,
      fbtrace_id: meta.fbtraceId,
    });
  } catch (err) {
    logger.error({ err }, 'WhatsApp diagnose error');
    return res.status(500).json({ error: 'Diagnostic failed' });
  }
});

/**
 * Trigger another OTP SMS for the beautician's pending number.
 * Used when the first SMS didn't arrive.
 */
router.post('/resend-code', async (req, res) => {
  if (!WA_TOKEN) return res.status(503).json({ error: 'WhatsApp not configured on this server' });

  const beauticianId = req.beautician.id;

  try {
    const { data: b } = await supabase
      .from('beauticians')
      .select('whatsapp_phone_id, whatsapp_pending_phone')
      .eq('id', beauticianId)
      .single();

    if (!b?.whatsapp_phone_id) {
      return res.status(400).json({ error: 'No pending WhatsApp registration found' });
    }

    const otp = await requestOtp(b.whatsapp_phone_id);
    if (!otp.ok) {
      const meta = extractMetaError(otp.data);
      const diagnostic = interpretMetaError(meta, { context: 'request_otp' });
      await logDiagnostic({
        beautician_id: beauticianId,
        phone: b.whatsapp_pending_phone || '',
        stage: 'request_otp_resend',
        success: false,
        meta_code: meta.code,
        meta_subcode: meta.subcode,
        meta_type: meta.type,
        meta_user_msg: meta.userMsg,
        meta_user_title: meta.userTitle,
        meta_message: meta.message,
        fbtrace_id: meta.fbtraceId,
        raw_response: otp.data,
        diagnosis: diagnostic.diagnosis,
        suggested_action: diagnostic.suggestedAction,
        retry_after: diagnostic.retryAfter,
      });
      logger.warn({ beauticianId, meta }, 'Meta OTP resend failed');
      return res.status(400).json({
        error: diagnostic.userMessage,
        diagnostic: {
          code: diagnostic.diagnosis,
          suggestedAction: diagnostic.suggestedAction,
          retryAfter: diagnostic.retryAfter,
        },
        meta_code: meta.code,
      });
    }

    return res.json({ success: true, message: `New code sent to ${b.whatsapp_pending_phone}` });
  } catch (err) {
    logger.error({ err }, 'WhatsApp resend-code error');
    return res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * Verify the OTP sent by Meta, then activate the number for Cloud API use.
 * Body: { code: "123456" }
 */
router.post('/verify', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code is required' });

  const beauticianId = req.beautician.id;

  try {
    const { data: b, error: bErr } = await supabase
      .from('beauticians')
      .select('whatsapp_phone_id, whatsapp_pending_phone, whatsapp_pin')
      .eq('id', beauticianId)
      .single();

    if (bErr || !b?.whatsapp_phone_id) {
      return res.status(400).json({ error: 'No pending WhatsApp registration found' });
    }

    // Step 1: verify ownership
    const verifyRes = await fetch(`${GRAPH}/${b.whatsapp_phone_id}/verify_code`, {
      method: 'POST',
      headers: metaHeaders(),
      body: JSON.stringify({ code }),
    });
    const verifyData = await verifyRes.json();

    if (!verifyRes.ok) {
      const meta = extractMetaError(verifyData);
      const diagnostic = interpretMetaError(meta, { context: 'verify_code' });
      await logDiagnostic({
        beautician_id: beauticianId,
        phone: b.whatsapp_pending_phone || '',
        stage: 'verify_code',
        success: false,
        meta_code: meta.code,
        meta_subcode: meta.subcode,
        meta_type: meta.type,
        meta_user_msg: meta.userMsg,
        meta_user_title: meta.userTitle,
        meta_message: meta.message,
        fbtrace_id: meta.fbtraceId,
        raw_response: verifyData,
        diagnosis: diagnostic.diagnosis === 'unknown' ? 'invalid_code' : diagnostic.diagnosis,
        suggested_action: diagnostic.suggestedAction,
      });
      logger.warn({ beauticianId, meta }, 'WhatsApp OTP verification failed');
      return res.status(400).json({
        error: meta.userMsg || meta.message || 'Invalid verification code',
        meta_code: meta.code,
        fbtrace_id: meta.fbtraceId,
      });
    }

    // Step 2: activate the number for Cloud API (required; otherwise messages can't send)
    const pin = b.whatsapp_pin || generatePin();
    if (!b.whatsapp_pin) {
      await supabase.from('beauticians').update({ whatsapp_pin: pin }).eq('id', beauticianId);
    }

    const registerRes = await fetch(`${GRAPH}/${b.whatsapp_phone_id}/register`, {
      method: 'POST',
      headers: metaHeaders(),
      body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
    });
    const registerData = await registerRes.json();

    if (!registerRes.ok) {
      const meta = extractMetaError(registerData);
      const diagnostic = interpretMetaError(meta, { context: 'register_cloud_api' });
      await logDiagnostic({
        beautician_id: beauticianId,
        phone: b.whatsapp_pending_phone || '',
        stage: 'register_cloud_api',
        success: false,
        meta_code: meta.code,
        meta_subcode: meta.subcode,
        meta_type: meta.type,
        meta_user_msg: meta.userMsg,
        meta_user_title: meta.userTitle,
        meta_message: meta.message,
        fbtrace_id: meta.fbtraceId,
        raw_response: registerData,
        diagnosis: diagnostic.diagnosis,
        suggested_action: diagnostic.suggestedAction,
      });
      logger.error({ beauticianId, meta }, 'WhatsApp Cloud API register failed after verify');
      return res.status(400).json({
        error:
          meta.userMsg ||
          meta.message ||
          'Number verified but Cloud API activation failed. Try disconnecting and reconnecting.',
        meta_code: meta.code,
        fbtrace_id: meta.fbtraceId,
      });
    }

    await supabase
      .from('beauticians')
      .update({
        whatsapp_phone: b.whatsapp_pending_phone,
        whatsapp_connected: true,
        whatsapp_registered_at: new Date().toISOString(),
        whatsapp_pending_phone: null,
      })
      .eq('id', beauticianId);

    await logDiagnostic({
      beautician_id: beauticianId,
      phone: b.whatsapp_pending_phone || '',
      stage: 'register_cloud_api',
      success: true,
      diagnosis: 'connected',
    });

    logger.info({ beauticianId, phone: b.whatsapp_pending_phone }, 'WhatsApp number verified and activated for Cloud API');

    return res.json({
      success: true,
      phone: b.whatsapp_pending_phone,
      message: 'WhatsApp connected successfully',
    });
  } catch (err) {
    logger.error({ err }, 'WhatsApp verify error');
    return res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * GET /status
 * Returns connection status + monthly usage for the dashboard.
 */
router.get('/status', async (req, res) => {
  const beauticianId = req.beautician.id;

  try {
    const { data: b, error: bErr } = await supabase
      .from('beauticians')
      .select('whatsapp_connected, whatsapp_phone, whatsapp_phone_id, whatsapp_registered_at, whatsapp_pending_phone, business_name')
      .eq('id', beauticianId)
      .single();

    if (bErr || !b) return res.status(404).json({ error: 'Beautician not found' });

    const usage = await getMonthlyUsage(beauticianId);

    return res.json({
      connected: !!b.whatsapp_connected,
      phone: b.whatsapp_phone || null,
      phone_number_id: b.whatsapp_phone_id || null,
      pending_phone: b.whatsapp_pending_phone || null,
      registered_at: b.whatsapp_registered_at || null,
      business_name: b.business_name || null,
      usage: usage
        ? {
            sms_sent: usage.sms_sent,
            whatsapp_sent: usage.whatsapp_sent,
            total_sent: usage.total_sent,
            free_limit: usage.free_limit,
            remaining: Math.max(0, usage.free_limit - usage.total_sent),
            overage_total_pence: usage.overage_total_pence,
            month: usage.month,
          }
        : null,
    });
  } catch (err) {
    logger.error({ err }, 'WhatsApp status error');
    return res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * GET /diagnostics
 * Returns the last 10 diagnostic rows for this beautician. Used by the UI
 * to show a history of Meta responses.
 */
router.get('/diagnostics', async (req, res) => {
  const beauticianId = req.beautician.id;
  try {
    const { data } = await supabase
      .from('whatsapp_diagnostics')
      .select('*')
      .eq('beautician_id', beauticianId)
      .order('created_at', { ascending: false })
      .limit(10);
    return res.json({ diagnostics: data || [] });
  } catch (err) {
    logger.error({ err }, 'WhatsApp diagnostics fetch error');
    return res.status(500).json({ error: 'Failed to load diagnostics' });
  }
});

/**
 * DELETE /disconnect
 * Removes the number from Meta's WABA and clears credentials.
 */
router.delete('/disconnect', async (req, res) => {
  const beauticianId = req.beautician.id;

  try {
    const { data: b } = await supabase
      .from('beauticians')
      .select('whatsapp_phone_id')
      .eq('id', beauticianId)
      .single();

    if (b?.whatsapp_phone_id && WA_TOKEN) {
      const metaRes = await fetch(`${GRAPH}/${b.whatsapp_phone_id}`, {
        method: 'DELETE',
        headers: metaHeaders(),
      });

      if (!metaRes.ok) {
        const metaData = await metaRes.json();
        logger.warn({ metaData, beauticianId }, 'Meta phone delete failed, clearing locally anyway');
      }
    }

    await supabase
      .from('beauticians')
      .update({
        whatsapp_connected: false,
        whatsapp_phone: null,
        whatsapp_phone_id: null,
        whatsapp_pending_phone: null,
        whatsapp_pin: null,
        whatsapp_registered_at: null,
      })
      .eq('id', beauticianId);

    logger.info({ beauticianId }, 'WhatsApp disconnected');
    return res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'WhatsApp disconnect error');
    return res.status(500).json({ error: 'Something went wrong' });
  }
});

export default router;
