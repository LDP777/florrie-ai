/**
 * WhatsApp Configuration Routes
 *
 * Handles phone number registration for Florrie's WABA.
 * Each beautician adds their own number. Florrie pays Meta, beauticians just connect.
 *
 * Flow:
 *   POST   /api/whatsapp/preflight    dry-run that actively checks Meta state without SMS
 *   POST   /api/whatsapp/register     add number to WABA + request OTP via SMS (runs preflight first)
 *   POST   /api/whatsapp/resend-code  request another OTP (user tapped "resend")
 *   POST   /api/whatsapp/verify       verify OTP + activate number for Cloud API
 *   POST   /api/whatsapp/diagnose     lightweight version of preflight (kept for legacy UI)
 *   POST   /api/whatsapp/reset        nuclear reset: delete from Meta + clear DB columns
 *   GET    /api/whatsapp/status       connection status + monthly usage + activation state
 *   GET    /api/whatsapp/activation-status
 *                                     poll endpoint the UI hits after /verify; returns
 *                                     true once Meta confirms Cloud API is truly live
 *   GET    /api/whatsapp/diagnostics  last 10 diagnostic rows for this beautician
 *   DELETE /api/whatsapp/disconnect   remove number from WABA (alias for /reset)
 *
 * Meta's 4-step registration (what this actually does under the hood):
 *   1. POST /{WABA_ID}/phone_numbers       add the number as a WABA entry (with verified_name)
 *   2. POST /{phone_number_id}/request_code Meta sends SMS to the number
 *   3. POST /{phone_number_id}/verify_code  confirm ownership
 *   4. POST /{phone_number_id}/register     activate for Cloud API (with PIN)
 *
 * After step 4 we also GET /{phone_number_id}?fields=status to confirm the
 * number actually went live, because step 4 can succeed at the HTTP layer
 * while Meta silently fails to flip the number into CONNECTED state.
 *
 * Env vars required:
 *   WHATSAPP_TOKEN                or WHATSAPP_ACCESS_TOKEN       Florrie's system user token (permanent)
 *   WHATSAPP_WABA_ID              or WHATSAPP_BUSINESS_ACCOUNT_ID Florrie's WhatsApp Business Account ID
 *   WHATSAPP_API_VERSION          e.g. "v21.0" (defaults to v21.0)
 */

import express from 'express';
import crypto from 'crypto';
import * as Sentry from '@sentry/node';
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { getAppSecret } from '../lib/env.js';
import { requireAuth } from '../middleware/auth.js';
import { getMonthlyUsage } from '../services/whatsapp-metering.js';

const router = express.Router();
router.use(requireAuth);

// Accept Meta's official Railway env names as fallbacks so we don't have to
// rename dashboard variables mid-flight. Keep the short names as primary.
const WA_TOKEN = process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
const WABA_ID = process.env.WHATSAPP_WABA_ID || process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
const API_VER = process.env.WHATSAPP_API_VERSION || 'v21.0';
const GRAPH = `https://graph.facebook.com/${API_VER}`;

function metaHeaders() {
  return {
    'Authorization': `Bearer ${WA_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

/**
 * In-memory idempotency cache for /verify. Keyed on `beauticianId:code`.
 * A network flake can retrigger the POST before the first response lands;
 * without this, Meta sees the second call, returns "code already used",
 * and the user gets an "Invalid code" screen despite having succeeded.
 *
 * Single-instance cache. If we ever horizontally scale the API, swap this
 * for Redis or Supabase row-level coordination.
 */
const VERIFY_IDEMPOTENCY_TTL_MS = 60 * 1000;
const verifyIdempotencyCache = new Map();

function idempotencyKey(beauticianId, code) {
  return `${beauticianId}:${String(code).trim()}`;
}

function getCachedVerify(key) {
  const entry = verifyIdempotencyCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > VERIFY_IDEMPOTENCY_TTL_MS) {
    verifyIdempotencyCache.delete(key);
    return null;
  }
  return entry;
}

function cacheVerify(key, status, body) {
  verifyIdempotencyCache.set(key, { at: Date.now(), status, body });
  // Lightweight GC so the map doesn't grow unbounded.
  if (verifyIdempotencyCache.size > 500) {
    const cutoff = Date.now() - VERIFY_IDEMPOTENCY_TTL_MS;
    for (const [k, v] of verifyIdempotencyCache) {
      if (v.at < cutoff) verifyIdempotencyCache.delete(k);
    }
  }
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
 *   100 / 2388386       WABA is at its phone-number quota (our problem, not the beautician's)
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

  if (sub === 2388023 || /already.*whatsapp|registered.*consumer|already active on whatsapp/i.test(userMsg)) {
    return {
      diagnosis: 'on_consumer_whatsapp',
      suggestedAction: 'delete_account',
      retryAfter: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
      userMessage:
        "This number is currently registered on WhatsApp or WhatsApp Business. Open that app, go to Settings then Account then Delete my account, and confirm with this exact number. Wait 2 hours for Meta to release it, then try again.",
    };
  }

  if (sub === 2388008 || /associated with.*business|already.*business account|tied to/i.test(userMsg)) {
    return {
      diagnosis: 'on_other_waba',
      suggestedAction: 'contact_bsp',
      retryAfter: null,
      userMessage:
        "This number is already registered with another WhatsApp Business API provider. Only they can release it. Sign into that provider's dashboard and remove the number, or contact Meta support.",
    };
  }

  if (sub === 2388009 || /verified.name|display name.*exists/i.test(userMsg)) {
    return {
      diagnosis: 'verified_name_collision',
      suggestedAction: 'retry_now',
      retryAfter: null,
      userMessage:
        "Your business display name is already in use elsewhere on WhatsApp. We've retried with the duplicate-name override, but if this persists, change your business name in Settings to something unique.",
    };
  }

  if (sub === 2388024 || /migration.*pending|pending.*review|still processing/i.test(userMsg)) {
    return {
      diagnosis: 'cooldown_active',
      suggestedAction: 'wait',
      retryAfter: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      userMessage:
        "Meta is still processing a recent change to this number. This usually clears within a few hours but can take up to 24 hours. We'll retry automatically in the background.",
    };
  }

  // 2388386: our shared WABA has hit Meta's per-business phone number cap.
  // This is a Florrie operations problem, not the beautician's — don't tell them
  // to go digging in Meta Business Suite. We need to free a slot on our side.
  const userTitle = (meta.userTitle || '').toLowerCase();
  if (
    sub === 2388386 ||
    /phone numbers? count exceeded|exceeded limit per business|numbers count exceeded limit/i.test(userMsg) ||
    /phone numbers? count exceeded|exceeded limit per business/i.test(userTitle)
  ) {
    return {
      diagnosis: 'waba_capacity',
      suggestedAction: 'contact_support',
      retryAfter: null,
      userMessage:
        "Florrie's WhatsApp account has hit its number limit. This is on our side, not yours. We've been notified and will free up space as soon as we can, usually within a few hours.",
    };
  }

  if (code === 100 && /invalid.*phone|phone.*invalid|country code/i.test(userMsg)) {
    return {
      diagnosis: 'invalid_number',
      suggestedAction: 'retry_now',
      retryAfter: null,
      userMessage:
        "Meta didn't recognise this as a valid mobile number. Check the country code and try again.",
    };
  }

  if (code === 368 || code === 4 || code === 17 || /rate.?limit|too many requests/i.test(userMsg)) {
    return {
      diagnosis: 'rate_limit',
      suggestedAction: 'wait',
      retryAfter: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      userMessage:
        "Meta is rate-limiting this number. Too many attempts in a short time. We'll retry automatically in an hour.",
    };
  }

  if (sub === 133004 || sub === 133005 || sub === 133006 || /pin|register.*fail|cloud.*api/i.test(userMsg)) {
    return {
      diagnosis: 'pin_error',
      suggestedAction: 'reset_and_retry',
      retryAfter: null,
      userMessage:
        "Cloud API registration failed. This is usually a temporary issue. Try the Reset button to clear and start again.",
    };
  }

  if (code === 190 || code === 200 || /access token|permission|not approved/i.test(userMsg)) {
    return {
      diagnosis: 'waba_not_approved',
      suggestedAction: 'contact_support',
      retryAfter: null,
      userMessage:
        "There's a configuration issue on Florrie's side. We've been notified and will investigate. Try again later or contact support.",
    };
  }

  // Final fallback: surface Meta's own human-readable copy when they gave us some,
  // so beauticians at least see the real reason instead of "Meta rejected the request".
  const metaTitle = meta.userTitle;
  const metaCopy = meta.userMsg || meta.message;
  const combined = metaTitle && metaCopy
    ? `${metaTitle}: ${metaCopy}`
    : (metaTitle || metaCopy || '');
  return {
    diagnosis: 'unknown',
    suggestedAction: 'contact_support',
    retryAfter: null,
    userMessage:
      combined ||
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
 * Look up a phone number on our WABA. Returns phone_number_id if it already
 * exists on our side, null if not.
 */
async function findExistingOnWaba(e164) {
  const filter = encodeURIComponent(
    JSON.stringify([{ field: 'phone_number', operator: 'CONTAIN', value: e164 }])
  );
  try {
    const lookup = await fetch(`${GRAPH}/${WABA_ID}/phone_numbers?filtering=${filter}`, {
      headers: metaHeaders(),
    });
    const data = await lookup.json();
    return data?.data?.[0]?.id || null;
  } catch (err) {
    logger.debug({ err }, 'WABA lookup failed, assuming not present');
    return null;
  }
}

/**
 * Delete a phone_number_id from Meta's WABA. Idempotent: returns ok even when
 * Meta says the id is unknown (meaning: already gone, which is the outcome we want).
 */
async function deleteFromMeta(phoneNumberId) {
  if (!phoneNumberId || !WA_TOKEN) return { ok: true, alreadyGone: true };
  try {
    const res = await fetch(`${GRAPH}/${phoneNumberId}`, {
      method: 'DELETE',
      headers: metaHeaders(),
    });
    if (res.ok) return { ok: true, alreadyGone: false };
    const data = await res.json();
    const meta = extractMetaError(data);
    // code 100 + "does not exist" means already deleted — treat as success
    const alreadyGone = /does not exist|cannot be loaded|unknown.*path/i.test(
      (meta.userMsg || meta.message || '')
    );
    return { ok: alreadyGone, alreadyGone, meta, raw: data };
  } catch (err) {
    logger.warn({ err, phoneNumberId }, 'Meta phone delete threw');
    return { ok: false, err: err.message };
  }
}

/**
 * Clear every whatsapp_* column on a beautician row. Used by the nuclear reset.
 */
async function clearBeauticianWhatsapp(beauticianId) {
  await supabase
    .from('beauticians')
    .update({
      whatsapp_connected: false,
      whatsapp_phone: null,
      whatsapp_phone_id: null,
      whatsapp_pending_phone: null,
      whatsapp_pin: null,
      whatsapp_registered_at: null,
      whatsapp_pending_activation: false,
      whatsapp_retry_at: null,
      whatsapp_retry_reason: null,
      whatsapp_retry_attempts: 0,
      whatsapp_retry_exhausted: false,
    })
    .eq('id', beauticianId);
}

/**
 * Try to add a phone number to our WABA, with full error capture + interpretation.
 * Shared by /register, /diagnose, /preflight, and the retry worker.
 *
 * Returns one of:
 *   { ok: true, phoneNumberId, alreadyOnWaba: boolean }
 *   { ok: false, diagnostic, raw, meta }
 */
async function addPhoneNumberToWaba({ cc, number, verifiedName, e164 }) {
  // First, check if it's already on our WABA from a previous half-finished attempt.
  const existing = await findExistingOnWaba(e164);
  if (existing) {
    return { ok: true, phoneNumberId: existing, alreadyOnWaba: true };
  }

  // allow_duplicate_verified_names prevents rejections when another beautician
  // already has the same business display name registered, which is a common
  // cause of generic 100 errors on shared WABAs.
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
  const reexisting = await findExistingOnWaba(e164);
  if (reexisting) {
    return { ok: true, phoneNumberId: reexisting, alreadyOnWaba: true };
  }

  const meta = extractMetaError(addData);
  const diagnostic = interpretMetaError(meta, { context: 'add_number' });

  // waba_capacity is an operational incident on our side — page it immediately
  // so we free up a slot before more beauticians get blocked.
  if (diagnostic.diagnosis === 'waba_capacity') {
    Sentry.captureMessage('WhatsApp WABA at phone-number capacity — beautician blocked', {
      level: 'error',
      tags: {
        route: 'whatsapp/add_number',
        diagnosis: 'waba_capacity',
        meta_subcode: String(meta.subcode ?? ''),
      },
      extra: {
        e164,
        meta_title: meta.userTitle,
        meta_msg: meta.userMsg,
        fbtrace_id: meta.fbtraceId,
      },
    });
  }

  return { ok: false, diagnostic, raw: addData, meta };
}

/**
 * Comprehensive pre-flight: validates everything we can without burning an SMS.
 * Returns { ready: true, ... } or { ready: false, diagnosis, userMessage, ... }.
 *
 * Checks, in order:
 *   1. Format
 *   2. Business name present on beautician
 *   3. Meta token health (GET /{WABA_ID})
 *   4. Number is addable (POST /{WABA_ID}/phone_numbers with our full context)
 *
 * Step 4 is the same call as /register does, but because it doesn't hit
 * /request_code, no SMS is sent. If it succeeds, we keep the resulting
 * phone_number_id so /register can skip the add step and jump straight to OTP.
 */
async function runPreflight({ beauticianId, phone }) {
  const e164 = normalisePhone(phone || '');
  if (!isValidE164(e164)) {
    return {
      ready: false,
      diagnosis: 'invalid_format',
      userMessage: "That number doesn't look right. UK mobiles should be 11 digits starting with 07.",
      e164: null,
    };
  }

  const { cc, number } = splitPhone(e164);

  const { data: profile } = await supabase
    .from('beauticians')
    .select('business_name')
    .eq('id', beauticianId)
    .single();

  const verifiedName = (profile?.business_name || '').trim();
  if (!verifiedName) {
    return {
      ready: false,
      diagnosis: 'missing_business_name',
      userMessage: "Set your business name in Settings first. WhatsApp uses it as the display name your clients will see.",
      e164,
    };
  }

  // Meta token health check. Cheap and bails fast with a clear message if the
  // system-user token expired or the WABA id env var is wrong.
  try {
    const tokenProbe = await fetch(`${GRAPH}/${WABA_ID}?fields=id,name`, {
      headers: metaHeaders(),
    });
    if (!tokenProbe.ok) {
      const probeData = await tokenProbe.json();
      const meta = extractMetaError(probeData);
      const diagnostic = interpretMetaError(meta, { context: 'preflight' });
      return {
        ready: false,
        diagnosis: diagnostic.diagnosis === 'unknown' ? 'waba_not_approved' : diagnostic.diagnosis,
        userMessage: diagnostic.userMessage,
        suggestedAction: diagnostic.suggestedAction,
        meta,
        e164,
      };
    }
  } catch (err) {
    logger.warn({ err }, 'Preflight token probe threw');
    // non-fatal, carry on to the real add
  }

  // The real test. If this succeeds we reuse the phoneNumberId in /register.
  const add = await addPhoneNumberToWaba({ cc, number, verifiedName, e164 });

  if (add.ok) {
    return {
      ready: true,
      phoneNumberId: add.phoneNumberId,
      alreadyOnWaba: add.alreadyOnWaba,
      verifiedName,
      e164,
      cc,
      number,
      userMessage: add.alreadyOnWaba
        ? "This number is already on our side from a previous attempt. We'll send a verification code now."
        : "This number looks clean and ready. We'll send a verification code now.",
    };
  }

  const { diagnostic, meta, raw } = add;
  return {
    ready: false,
    diagnosis: diagnostic.diagnosis,
    userMessage: diagnostic.userMessage,
    suggestedAction: diagnostic.suggestedAction,
    retryAfter: diagnostic.retryAfter,
    meta,
    raw,
    e164,
  };
}

/**
 * After /register activates the Cloud API, confirm with Meta that the number
 * is actually CONNECTED. Meta's /register endpoint sometimes returns success
 * at the HTTP layer while leaving the number in a PENDING or MIGRATED state,
 * which means messages silently fail. We GET the phone number status to find
 * out for sure.
 *
 * Returns { active: true } when Meta reports CONNECTED, otherwise details.
 */
async function verifyCloudApiActivation(phoneNumberId) {
  try {
    const res = await fetch(
      `${GRAPH}/${phoneNumberId}?fields=status,code_verification_status,name_status,quality_rating`,
      { headers: metaHeaders() }
    );
    const data = await res.json();
    if (!res.ok) {
      const meta = extractMetaError(data);
      return { active: false, meta, raw: data };
    }
    const status = (data?.status || '').toUpperCase();
    const codeStatus = (data?.code_verification_status || '').toUpperCase();
    // CONNECTED is the only value that means messages can actually send.
    // PENDING usually becomes CONNECTED on its own within a few minutes.
    const active = status === 'CONNECTED';
    return {
      active,
      status,
      codeStatus,
      nameStatus: data?.name_status,
      qualityRating: data?.quality_rating,
      raw: data,
    };
  } catch (err) {
    logger.warn({ err, phoneNumberId }, 'verifyCloudApiActivation threw');
    return { active: false, err: err.message };
  }
}

/**
 * POST /preflight
 * Non-destructive check. Runs the same Meta calls /register does (token probe
 * + add_number lookup/attempt) but never calls /request_code. Safe to call
 * from the UI to gate the Send code button.
 */
router.post('/preflight', async (req, res) => {
  if (!WA_TOKEN || !WABA_ID) {
    return res.status(503).json({ error: 'WhatsApp not configured on this server' });
  }
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone is required' });

  try {
    const beauticianId = req.beautician.id;
    const result = await runPreflight({ beauticianId, phone });

    if (!result.ready && result.meta) {
      await logDiagnostic({
        beautician_id: beauticianId,
        phone: `+${result.e164 || normalisePhone(phone)}`,
        stage: 'preflight',
        success: false,
        meta_code: result.meta.code,
        meta_subcode: result.meta.subcode,
        meta_type: result.meta.type,
        meta_user_msg: result.meta.userMsg,
        meta_user_title: result.meta.userTitle,
        meta_message: result.meta.message,
        fbtrace_id: result.meta.fbtraceId,
        raw_response: result.raw,
        diagnosis: `preflight:${result.diagnosis}`,
        suggested_action: result.suggestedAction,
        retry_after: result.retryAfter,
      });
    }

    return res.json({
      ready: !!result.ready,
      status: result.ready ? (result.alreadyOnWaba ? 'already_on_waba' : 'clean') : result.diagnosis,
      userMessage: result.userMessage,
      suggestedAction: result.suggestedAction,
      retryAfter: result.retryAfter,
      phone_number_id: result.phoneNumberId || null,
      already_on_waba: !!result.alreadyOnWaba,
      meta_code: result.meta?.code,
      meta_subcode: result.meta?.subcode,
      fbtrace_id: result.meta?.fbtraceId,
    });
  } catch (err) {
    logger.error({ err }, 'WhatsApp preflight error');
    Sentry.captureException(err, { tags: { route: 'whatsapp/preflight' } });
    return res.status(500).json({ error: 'Preflight failed', code: 'preflight_failed' });
  }
});

/**
 * POST /diagnose
 * Kept for legacy UI, now a thin alias of /preflight.
 */
router.post('/diagnose', async (req, res) => {
  if (!WA_TOKEN || !WABA_ID) {
    return res.status(503).json({ error: 'WhatsApp not configured on this server' });
  }
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone is required' });

  try {
    const beauticianId = req.beautician.id;
    const result = await runPreflight({ beauticianId, phone });
    return res.json({
      status: result.ready ? (result.alreadyOnWaba ? 'already_on_waba' : 'ready') : result.diagnosis,
      ready: !!result.ready,
      userMessage: result.userMessage,
      suggestedAction: result.suggestedAction,
      retryAfter: result.retryAfter,
      phone_number_id: result.phoneNumberId || null,
      meta_code: result.meta?.code,
      meta_subcode: result.meta?.subcode,
      fbtrace_id: result.meta?.fbtraceId,
    });
  } catch (err) {
    logger.error({ err }, 'WhatsApp diagnose error');
    Sentry.captureException(err, { tags: { route: 'whatsapp/diagnose' } });
    return res.status(500).json({ error: 'Diagnostic failed', code: 'diagnose_failed' });
  }
});

/**
 * POST /reset
 * Nuclear option. For stuck numbers on a shared WABA, the cleanest thing we
 * can do is force-delete from Meta's side and wipe local state, so the next
 * /register starts from zero.
 *
 * Body: {} or { phone: "+447..." } (if no phone given, uses stored phone_id)
 *
 * Safe to call repeatedly. Returns { success: true, cleared: {...} }.
 */
router.post('/reset', async (req, res) => {
  if (!WA_TOKEN || !WABA_ID) {
    return res.status(503).json({ error: 'WhatsApp not configured on this server' });
  }
  const beauticianId = req.beautician.id;
  const cleared = { meta_phone_id: null, meta_deleted: false, meta_already_gone: false, db_cleared: false };

  try {
    // 1. What's currently on this beautician's row?
    const { data: b } = await supabase
      .from('beauticians')
      .select('whatsapp_phone_id, whatsapp_pending_phone, whatsapp_phone')
      .eq('id', beauticianId)
      .single();

    // 2. If a phone was passed in the body, also force a WABA lookup so we
    //    catch phone_number_ids that exist on Meta's side but aren't in our DB
    //    (the typical "stuck half-finished attempt" situation).
    let targetId = b?.whatsapp_phone_id || null;
    const bodyPhone = req.body?.phone;
    if (bodyPhone) {
      const e164 = normalisePhone(bodyPhone);
      if (isValidE164(e164)) {
        const found = await findExistingOnWaba(e164);
        if (found && !targetId) targetId = found;
      }
    }

    cleared.meta_phone_id = targetId;

    // 3. Delete from Meta (idempotent)
    if (targetId) {
      const del = await deleteFromMeta(targetId);
      cleared.meta_deleted = del.ok && !del.alreadyGone;
      cleared.meta_already_gone = !!del.alreadyGone;
      if (!del.ok) {
        logger.warn({ del, targetId, beauticianId }, 'Meta delete during reset failed, clearing locally anyway');
      }
    }

    // 4. Clear every whatsapp_* column
    await clearBeauticianWhatsapp(beauticianId);
    cleared.db_cleared = true;

    await logDiagnostic({
      beautician_id: beauticianId,
      phone: b?.whatsapp_phone || b?.whatsapp_pending_phone || bodyPhone || 'unknown',
      stage: 'reset',
      success: true,
      diagnosis: 'nuclear_reset',
      raw_response: cleared,
    });

    logger.info({ beauticianId, cleared }, 'WhatsApp nuclear reset complete');
    return res.json({ success: true, cleared });
  } catch (err) {
    logger.error({ err }, 'WhatsApp reset error');
    Sentry.captureException(err, { tags: { route: 'whatsapp/reset' } });
    return res.status(500).json({ error: 'Reset failed', code: 'reset_failed' });
  }
});

/**
 * POST /register
 * Register a phone number with Florrie's WABA, then trigger an SMS OTP.
 * Body: { phone: "+447700900123", reset?: boolean }
 *
 * If reset is true, we wipe the beautician's whatsapp_* columns and
 * force-delete any stuck phone_number_id from Meta's side before attempting.
 * This is the "try again from scratch" path for stuck flows.
 */
router.post('/register', async (req, res) => {
  if (!WA_TOKEN || !WABA_ID) {
    return res.status(503).json({ error: 'WhatsApp not configured on this server' });
  }

  const { phone, reset } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone is required' });

  const beauticianId = req.beautician.id;

  try {
    // Optional nuclear reset before retry
    if (reset) {
      const { data: b } = await supabase
        .from('beauticians')
        .select('whatsapp_phone_id')
        .eq('id', beauticianId)
        .single();
      const e164 = normalisePhone(phone);
      const existing = isValidE164(e164) ? await findExistingOnWaba(e164) : null;
      const targetId = b?.whatsapp_phone_id || existing;
      if (targetId) await deleteFromMeta(targetId);
      await clearBeauticianWhatsapp(beauticianId);
    }

    // Unified preflight. This does format, business_name, token probe, and add_number.
    // On success, we already have the phone_number_id in hand and can skip straight to OTP.
    const pre = await runPreflight({ beauticianId, phone });

    if (!pre.ready) {
      const retryAfter = pre.retryAfter;

      await logDiagnostic({
        beautician_id: beauticianId,
        phone: `+${pre.e164 || normalisePhone(phone)}`,
        stage: pre.diagnosis === 'invalid_format' || pre.diagnosis === 'missing_business_name'
          ? 'preflight'
          : 'add_number',
        success: false,
        meta_code: pre.meta?.code ?? null,
        meta_subcode: pre.meta?.subcode ?? null,
        meta_type: pre.meta?.type ?? null,
        meta_user_msg: pre.meta?.userMsg ?? null,
        meta_user_title: pre.meta?.userTitle ?? null,
        meta_message: pre.meta?.message ?? null,
        fbtrace_id: pre.meta?.fbtraceId ?? null,
        raw_response: pre.raw ?? null,
        diagnosis: pre.diagnosis,
        suggested_action: pre.suggestedAction,
        retry_after: retryAfter,
      });

      // If we know when Meta will release the number, schedule a background retry
      if (pre.diagnosis === 'cooldown_active' || pre.diagnosis === 'rate_limit') {
        await supabase
          .from('beauticians')
          .update({
            whatsapp_retry_at: retryAfter,
            whatsapp_retry_reason: pre.diagnosis,
            whatsapp_retry_attempts: 0,
            whatsapp_pending_phone: `+${pre.e164}`,
          })
          .eq('id', beauticianId);
      }

      logger.warn(
        { beauticianId, phone, diagnosis: pre.diagnosis },
        'WhatsApp register blocked at preflight'
      );

      return res.status(400).json({
        error: pre.userMessage,
        diagnostic: {
          code: pre.diagnosis,
          suggestedAction: pre.suggestedAction,
          retryAfter,
          autoRetryScheduled: pre.diagnosis === 'cooldown_active' || pre.diagnosis === 'rate_limit',
        },
        meta_code: pre.meta?.code ?? null,
        meta_subcode: pre.meta?.subcode ?? null,
        meta_user_title: pre.meta?.userTitle ?? null,
        fbtrace_id: pre.meta?.fbtraceId ?? null,
      });
    }

    const phoneNumberId = pre.phoneNumberId;

    // Preflight succeeded, actually send the SMS
    const otp = await requestOtp(phoneNumberId);
    if (!otp.ok) {
      const meta = extractMetaError(otp.data);
      const diagnostic = interpretMetaError(meta, { context: 'request_otp' });

      // If OTP request fails, queue for retry via background worker so SMS arrives
      // automatically once Meta clears the issue.
      if (diagnostic.diagnosis === 'rate_limit' || diagnostic.diagnosis === 'cooldown_active') {
        await supabase
          .from('beauticians')
          .update({
            whatsapp_retry_at: diagnostic.retryAfter,
            whatsapp_retry_reason: 'otp_retry_pending',
            whatsapp_retry_attempts: 0,
            whatsapp_pending_phone: `+${pre.e164}`,
          })
          .eq('id', beauticianId);
      }

      await logDiagnostic({
        beautician_id: beauticianId,
        phone: `+${pre.e164}`,
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
      logger.warn({ beauticianId, phone: `+${pre.e164}`, meta, phoneNumberId }, 'Meta OTP request failed');
      return res.status(400).json({
        error: diagnostic.userMessage,
        diagnostic: {
          code: diagnostic.diagnosis,
          suggestedAction: diagnostic.suggestedAction,
          retryAfter: diagnostic.retryAfter,
          autoRetryScheduled: diagnostic.diagnosis === 'rate_limit' || diagnostic.diagnosis === 'cooldown_active',
        },
        meta_code: meta.code,
        meta_subcode: meta.subcode,
        fbtrace_id: meta.fbtraceId,
      });
    }

    await logDiagnostic({
      beautician_id: beauticianId,
      phone: `+${pre.e164}`,
      stage: 'add_number',
      success: true,
      diagnosis: pre.alreadyOnWaba ? 'already_on_waba' : 'clean_add',
    });

    const pin = generatePin();

    await supabase
      .from('beauticians')
      .update({
        whatsapp_pending_phone: `+${pre.e164}`,
        whatsapp_phone_id: phoneNumberId,
        whatsapp_pin: pin,
        whatsapp_connected: false,
        whatsapp_pending_activation: false,
        whatsapp_retry_at: null,
        whatsapp_retry_reason: null,
        whatsapp_retry_attempts: 0,
      })
      .eq('id', beauticianId);

    logger.info(
      { beauticianId, phoneNumberId, phone: `+${pre.e164}` },
      'WhatsApp number registered, OTP SMS sent'
    );

    return res.json({
      success: true,
      phone_number_id: phoneNumberId,
      message: `Verification code sent to +${pre.e164}`,
      already_on_waba: !!pre.alreadyOnWaba,
    });
  } catch (err) {
    logger.error({ err }, 'WhatsApp register error');
    Sentry.captureException(err, { tags: { route: 'whatsapp/register' } });
    return res.status(500).json({ error: 'Something went wrong', code: 'register_failed' });
  }
});

/**
 * Trigger another OTP SMS for the beautician's pending number.
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
    Sentry.captureException(err, { tags: { route: 'whatsapp/resend-code' } });
    return res.status(500).json({ error: 'Something went wrong', code: 'resend_failed' });
  }
});

/**
 * Verify the OTP sent by Meta, then activate the number for Cloud API use.
 * After Cloud API activation, GET the phone number status to confirm it's
 * truly CONNECTED. If it's not, mark pending_activation and let the UI poll
 * /activation-status until it flips.
 */
router.post('/verify', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code is required' });

  const beauticianId = req.beautician.id;
  const idempKey = idempotencyKey(beauticianId, code);
  const cached = getCachedVerify(idempKey);
  if (cached) {
    logger.info({ beauticianId }, 'WhatsApp verify hit idempotency cache, replaying response');
    return res.status(cached.status).json({ ...cached.body, idempotent: true });
  }

  const respondAndCache = (status, body) => {
    cacheVerify(idempKey, status, body);
    return res.status(status).json(body);
  };

  try {
    const { data: b, error: bErr } = await supabase
      .from('beauticians')
      .select('whatsapp_phone_id, whatsapp_pending_phone, whatsapp_pin')
      .eq('id', beauticianId)
      .single();

    if (bErr || !b?.whatsapp_phone_id) {
      return res.status(400).json({ error: 'No pending WhatsApp registration found' });
    }

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
      return respondAndCache(400, {
        error: meta.userMsg || meta.message || 'Invalid verification code',
        meta_code: meta.code,
        fbtrace_id: meta.fbtraceId,
      });
    }

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
      return respondAndCache(400, {
        error:
          meta.userMsg ||
          meta.message ||
          'Number verified but Cloud API activation failed. Try the Reset button in Settings and start again.',
        meta_code: meta.code,
        fbtrace_id: meta.fbtraceId,
      });
    }

    // Cloud API register returned OK. Confirm with Meta that the number is
    // actually CONNECTED. If it's still PENDING, flag pending_activation and
    // let the retry worker/poller flip it to connected later.
    const activation = await verifyCloudApiActivation(b.whatsapp_phone_id);

    if (activation.active) {
      await supabase
        .from('beauticians')
        .update({
          whatsapp_phone: b.whatsapp_pending_phone,
          whatsapp_connected: true,
          whatsapp_pending_activation: false,
          whatsapp_registered_at: new Date().toISOString(),
          whatsapp_pending_phone: null,
          whatsapp_retry_exhausted: false,
        })
        .eq('id', beauticianId);

      await logDiagnostic({
        beautician_id: beauticianId,
        phone: b.whatsapp_pending_phone || '',
        stage: 'register_cloud_api',
        success: true,
        diagnosis: 'connected',
      });

      logger.info(
        { beauticianId, phone: b.whatsapp_pending_phone },
        'WhatsApp number verified, activated, and confirmed CONNECTED'
      );

      return respondAndCache(200, {
        success: true,
        phone: b.whatsapp_pending_phone,
        connected: true,
        pendingActivation: false,
        message: 'WhatsApp connected successfully',
      });
    }

    // Register returned OK but status is not CONNECTED. Park it and let the
    // UI poll /activation-status. Meta usually flips this within a few minutes.
    await supabase
      .from('beauticians')
      .update({
        whatsapp_phone: b.whatsapp_pending_phone,
        whatsapp_connected: false,
        whatsapp_pending_activation: true,
        whatsapp_registered_at: new Date().toISOString(),
        whatsapp_retry_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        whatsapp_retry_reason: 'pending_activation',
      })
      .eq('id', beauticianId);

    await logDiagnostic({
      beautician_id: beauticianId,
      phone: b.whatsapp_pending_phone || '',
      stage: 'register_cloud_api',
      success: true,
      diagnosis: 'pending_activation',
      raw_response: activation.raw,
    });

    logger.warn(
      { beauticianId, phone: b.whatsapp_pending_phone, metaStatus: activation.status },
      'Cloud API register returned OK but status not yet CONNECTED, polling scheduled'
    );

    return respondAndCache(200, {
      success: true,
      phone: b.whatsapp_pending_phone,
      connected: false,
      pendingActivation: true,
      metaStatus: activation.status || null,
      message: "Number verified. Meta is still bringing it online, this usually clears within a few minutes. We'll keep watching.",
    });
  } catch (err) {
    logger.error({ err }, 'WhatsApp verify error');
    Sentry.captureException(err, { tags: { route: 'whatsapp/verify' } });
    return res.status(500).json({ error: 'Something went wrong', code: 'verify_failed' });
  }
});

/**
 * POST /reconcile
 *
 * Recovery endpoint for the case where a beautician's number was added to
 * Florrie's WABA out-of-band (e.g. directly in Meta Business Manager) and
 * Florrie's findExistingOnWaba lookup misses it on retry, causing the app to
 * keep trying to add fresh and hit waba_capacity.
 *
 * Given a Meta phone_number_id, this:
 *   1. Validates the phone_number_id is on Florrie's WABA (Meta GET).
 *   2. Verifies the number's verified_name matches the beautician's
 *      business_name (case-insensitive). This prevents one beautician from
 *      claiming another's number.
 *   3. Runs Cloud API register with a fresh PIN.
 *   4. Writes the reconciliation into the beauticians row.
 *
 * Returns 4xx with diagnostic on validation failure, 200 on success.
 */
router.post('/reconcile', async (req, res) => {
  const beauticianId = req.beautician.id;
  const phoneNumberId = String(req.body?.phone_number_id || '').trim();

  if (!/^\d{12,18}$/.test(phoneNumberId)) {
    return res.status(400).json({
      error: 'phone_number_id required (12-18 digits)',
      code: 'invalid_phone_number_id',
    });
  }

  if (!WA_TOKEN || !WABA_ID) {
    return res.status(503).json({
      error: 'WhatsApp env not configured',
      code: 'whatsapp_env_missing',
    });
  }

  try {
    // 1. Read beautician profile (need business_name for verified_name check)
    const { data: profile, error: profileErr } = await supabase
      .from('beauticians')
      .select('id, business_name')
      .eq('id', beauticianId)
      .single();
    if (profileErr || !profile) {
      return res.status(404).json({ error: 'Beautician not found', code: 'beautician_not_found' });
    }
    const expectedName = (profile.business_name || '').trim();
    if (!expectedName) {
      return res.status(400).json({
        error: 'Set your business name in Settings before reconciling.',
        code: 'missing_business_name',
      });
    }

    // 2. Check this phone_number_id isn't already claimed by another beautician
    const { data: existing } = await supabase
      .from('beauticians')
      .select('id, email')
      .eq('whatsapp_phone_id', phoneNumberId)
      .neq('id', beauticianId);
    if (existing && existing.length > 0) {
      return res.status(409).json({
        error: 'This phone_number_id is already linked to another beautician.',
        code: 'phone_number_id_in_use',
      });
    }

    // 3. Validate against Meta — does this phone_number_id exist on Florrie's WABA?
    const lookupRes = await fetch(
      `${GRAPH}/${phoneNumberId}?fields=display_phone_number,verified_name,code_verification_status,quality_rating,id`,
      { headers: metaHeaders() }
    );
    const lookup = await lookupRes.json();
    if (!lookupRes.ok || !lookup?.id) {
      const meta = extractMetaError(lookup);
      logger.warn({ phoneNumberId, meta }, 'Reconcile: Meta lookup failed');
      return res.status(400).json({
        error: meta.userMsg || meta.message || 'phone_number_id not found in Florrie WABA',
        code: 'phone_number_id_not_on_waba',
        meta,
      });
    }

    // 4. Verified-name security check
    const actualName = (lookup.verified_name || '').trim();
    if (actualName.toLowerCase() !== expectedName.toLowerCase()) {
      logger.warn(
        { beauticianId, expectedName, actualName, phoneNumberId },
        'Reconcile: verified_name mismatch'
      );
      return res.status(403).json({
        error: `Verified name mismatch. Meta says "${actualName}", your business name is "${expectedName}". Update business_name to match, or pick a different phone_number_id.`,
        code: 'verified_name_mismatch',
        expectedName,
        actualName,
      });
    }

    // 5. Cloud API register (idempotent: succeeds if already registered)
    const pin = String(Math.floor(100000 + Math.random() * 900000));
    const regRes = await fetch(`${GRAPH}/${phoneNumberId}/register`, {
      method: 'POST',
      headers: metaHeaders(),
      body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
    });
    const regData = await regRes.json();
    const registerOk = regRes.ok && regData.success === true;
    if (!registerOk) {
      const meta = extractMetaError(regData);
      logger.warn({ phoneNumberId, meta }, 'Reconcile: Cloud API register failed');
      // Still write the phone_number_id to DB so subsequent retries can finish
      // the registration. Mark pending_activation so the retry worker picks it up.
    }

    // 6. Normalise the phone number from Meta's response (handles formatting variants)
    const displayPhone = String(lookup.display_phone_number || '').replace(/[^\d+]/g, '');
    const normalisedPhone = displayPhone.startsWith('+') ? displayPhone : `+${displayPhone}`;

    // 7. Write the reconciliation
    const { error: updateErr } = await supabase
      .from('beauticians')
      .update({
        whatsapp_phone: normalisedPhone,
        whatsapp_phone_id: phoneNumberId,
        whatsapp_connected: registerOk,
        whatsapp_registered_at: new Date().toISOString(),
        whatsapp_pin: pin,
        whatsapp_pending_phone: null,
        whatsapp_pending_activation: !registerOk,
        whatsapp_retry_at: null,
        whatsapp_retry_reason: null,
        whatsapp_retry_attempts: 0,
        whatsapp_retry_exhausted: false,
      })
      .eq('id', beauticianId);

    if (updateErr) {
      logger.error({ updateErr }, 'Reconcile: DB update failed');
      Sentry.captureException(updateErr, { tags: { route: 'whatsapp/reconcile' } });
      return res.status(500).json({
        error: 'Database update failed',
        code: 'db_update_failed',
        detail: updateErr.message,
      });
    }

    await logDiagnostic({
      beautician_id: beauticianId,
      phone: normalisedPhone,
      stage: 'reconcile',
      success: registerOk,
      meta_code: regData?.error?.code ?? null,
      meta_subcode: regData?.error?.error_subcode ?? null,
      meta_user_msg: regData?.error?.error_user_msg ?? null,
      meta_user_title: regData?.error?.error_user_title ?? null,
      meta_message: regData?.error?.message ?? null,
      raw_response: { lookup, register: regData },
      diagnosis: registerOk ? 'reconciled_and_registered' : 'reconciled_pending_register',
      suggested_action: registerOk ? null : 'retry_register',
    });

    return res.json({
      ok: true,
      phone_number_id: phoneNumberId,
      display_phone_number: lookup.display_phone_number,
      verified_name: lookup.verified_name,
      code_verification_status: lookup.code_verification_status,
      quality_rating: lookup.quality_rating,
      cloud_api_registered: registerOk,
      register_response: regData,
      message: registerOk
        ? 'Number reconciled and registered for Cloud API. WhatsApp is live.'
        : 'Number reconciled. Cloud API register pending — retry worker will finish.',
    });
  } catch (err) {
    logger.error({ err }, 'WhatsApp reconcile error');
    Sentry.captureException(err, { tags: { route: 'whatsapp/reconcile' } });
    return res.status(500).json({ error: 'Reconcile failed', code: 'reconcile_failed', detail: err.message });
  }
});

/**
 * POST /webhook-self-test
 *
 * Bypasses the webhook signature check and pushes a synthetic inbound
 * WhatsApp message directly into Florrie's processing pipeline. Used to
 * isolate whether inbound delivery is failing because of:
 *   (a) Meta isn't calling Florrie at all   → this endpoint succeeds, inbox shows message
 *   (b) Signature verification fails        → this endpoint succeeds, inbox shows message
 *   (c) Florrie's processing logic is broken → this endpoint fails
 *
 * Body: { from: "+447...", text: "test message" }
 * Requires the beautician calling it to have whatsapp_phone_id set; uses
 * their phone id so the synthetic message routes to their account.
 */
router.post('/webhook-self-test', async (req, res) => {
  const beauticianId = req.beautician.id;
  const from = String(req.body?.from || '').trim();
  const text = String(req.body?.text || 'self-test message').trim();

  if (!from || !/^\+?\d{10,15}$/.test(from)) {
    return res.status(400).json({ error: 'from required (E.164)' });
  }

  try {
    const { data: b } = await supabase
      .from('beauticians')
      .select('whatsapp_phone_id, whatsapp_phone')
      .eq('id', beauticianId)
      .single();
    if (!b?.whatsapp_phone_id) {
      return res.status(400).json({ error: 'No whatsapp_phone_id on beautician' });
    }

    // Dynamic import to avoid circular requires; mirror the real webhook shape
    const { processInboundMessage } = await import('../services/ai-front-desk.js');

    const senderDigits = from.startsWith('+') ? from.slice(1) : from;
    const fakeBody = {
      object: 'whatsapp_business_account',
      entry: [{
        id: WABA_ID,
        changes: [{
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: b.whatsapp_phone,
              phone_number_id: b.whatsapp_phone_id,
            },
            contacts: [{
              profile: { name: 'Self Test' },
              wa_id: senderDigits,
            }],
            messages: [{
              from: senderDigits,
              id: `wamid.self_test_${Date.now()}`,
              timestamp: String(Math.floor(Date.now() / 1000)),
              type: 'text',
              text: { body: text },
            }],
          },
        }],
      }],
    };

    // Run the same logic the real webhook would run
    const change = fakeBody.entry[0].changes[0].value;
    const message = change.messages[0];
    const contact = change.contacts?.[0];
    const phoneNumberId = change.metadata.phone_number_id;

    const { data: beautician } = await supabase
      .from('beauticians')
      .select('*')
      .eq('whatsapp_phone_id', phoneNumberId)
      .single();

    if (!beautician) {
      return res.status(404).json({ error: 'No beautician matched phone_number_id', phoneNumberId });
    }

    const waId = message.from;
    let { data: client } = await supabase
      .from('clients')
      .select('*')
      .eq('beautician_id', beautician.id)
      .eq('whatsapp_id', waId)
      .single();

    if (!client) {
      const { data: newClient } = await supabase
        .from('clients')
        .insert({
          beautician_id: beautician.id,
          first_name: contact?.profile?.name || 'WhatsApp User',
          last_name: '',
          phone: `+${waId}`,
          whatsapp_id: waId,
          source: 'whatsapp',
        })
        .select()
        .single();
      client = newClient;
    }

    // Store the inbound message first, exactly like the real webhook, then hand
    // off to the AI Front Desk positionally (messageId, beautician, client, content).
    // The old call passed a single object, so beautician/client/content were all
    // undefined: it threw inside, was swallowed, and the route still reported
    // success. That made the self-test a false positive.
    const { data: storedMessage } = await supabase
      .from('messages')
      .insert({
        beautician_id: beautician.id,
        client_id: client?.id,
        channel: 'whatsapp',
        direction: 'inbound',
        content: message.text.body,
        external_message_id: message.id,
        ai_handled: false,
        escalated: false,
      })
      .select()
      .single();

    const result = await processInboundMessage(
      storedMessage.id, beautician, client, message.text.body
    );

    return res.json({
      ok: true,
      processed: true,
      handled: !!result?.handled,
      escalated: !!result?.escalated,
      intent: result?.intent || null,
      beautician_id: beautician.id,
      client_id: client?.id,
      stored_message_id: storedMessage.id,
      message_text: message.text.body,
      note: 'handled=true means a reply actually sent, escalated=true means it was held as a draft for you to approve. If this stored a message and returned an intent, the inbound pipeline works and any real-world failure is at the webhook delivery layer (signature verification or Meta not delivering).',
    });
  } catch (err) {
    logger.error({ err }, 'webhook-self-test failed');
    Sentry.captureException(err, { tags: { route: 'whatsapp/webhook-self-test' } });
    return res.status(500).json({ error: 'Self-test failed', detail: err.message, stack: err.stack?.split('\n').slice(0, 5) });
  }
});

/**
 * POST /test-email
 *
 * Diagnostic that sends a real Resend email to the authenticated beautician's
 * own email address. Used to verify email-confirmation plumbing is live end-
 * to-end: env var set, Resend reachable, FROM domain verified, payload accepted.
 *
 * Returns ok:true with Resend's message id on success.
 */
router.post('/test-email', async (req, res) => {
  const beauticianId = req.beautician.id;
  if (!process.env.RESEND_API_KEY) {
    return res.status(503).json({ ok: false, code: 'no_resend_key', error: 'RESEND_API_KEY not set on Railway' });
  }
  try {
    const { data: b } = await supabase
      .from('beauticians')
      .select('email, first_name, business_name')
      .eq('id', beauticianId)
      .single();
    if (!b?.email) return res.status(400).json({ ok: false, error: 'No email on beautician' });

    const { sendEmail } = await import('../services/notifications.js');
    const result = await sendEmail({
      to: b.email,
      subject: 'Florrie email diagnostic — confirmation plumbing live',
      text: `Hi ${b.first_name || ''}, this is an automated test to confirm Florrie can send you booking confirmations via Resend. If this lands, email confirmation for appointments is fully wired up.`,
      html: `<p>Hi ${b.first_name || ''},</p><p>This is an automated test to confirm Florrie can send you booking confirmations via Resend.</p><p>If this lands, email confirmation for appointments is fully wired up.</p><p>Business: <strong>${b.business_name || 'n/a'}</strong></p>`,
    });
    if (!result) {
      return res.status(500).json({ ok: false, code: 'send_failed', error: 'sendEmail returned null — see Sentry for Resend error' });
    }
    return res.json({
      ok: true,
      to: b.email,
      from: process.env.FROM_EMAIL || 'Florrie <noreply@florrie.ai>',
      resend_response: result,
      next_step: 'Check your inbox. If nothing arrives within 60s, FROM domain (florrie.ai) likely isnt verified at Resend.',
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Test email failed', detail: err.message });
  }
});

/**
 * ─── Template WABA resolution ───
 * env WABA_ID can point at Florrie's sandbox WABA, but a beautician's
 * templates live on the WABA that owns THEIR sending phone (the send path
 * already resolves this). Template management must look at the same WABA.
 */
const _tplWabaCache = new Map();
async function resolveTemplateWaba(beauticianId) {
  const hit = _tplWabaCache.get(beauticianId);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.val;
  let val = { wabaId: WABA_ID, wabaName: null, source: 'env' };
  try {
    const { data: b } = await supabase
      .from('beauticians')
      .select('whatsapp_phone_id')
      .eq('id', beauticianId)
      .single();
    if (b?.whatsapp_phone_id) {
      const r = await fetch(
        `${GRAPH}/${b.whatsapp_phone_id}?fields=whatsapp_business_account{id,name}`,
        { headers: metaHeaders() }
      );
      const data = await r.json();
      if (r.ok && data?.whatsapp_business_account?.id) {
        val = {
          wabaId: data.whatsapp_business_account.id,
          wabaName: data.whatsapp_business_account.name || null,
          source: 'phone',
        };
      }
    }
  } catch (err) {
    logger.warn({ err, beauticianId }, 'resolveTemplateWaba failed, falling back to env WABA');
  }
  _tplWabaCache.set(beauticianId, { val, at: Date.now() });
  return val;
}

/**
 * Build Meta template components from plain text fields, attaching the
 * example values Meta requires for every {{n}} placeholder.
 */
function buildTemplateComponents({ headerText, bodyText, footerText }) {
  const sampleValues = ['Sarah', 'Friday 6 June', '2pm', 'Brow Lamination', 'Monday', '10am'];
  const placeholderCount = (t) => {
    const nums = [...String(t).matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => parseInt(m[1], 10));
    return nums.length ? Math.max(...nums) : 0;
  };
  const exampleList = (n) => Array.from({ length: n }, (_, i) => sampleValues[i] || `Example ${i + 1}`);
  const components = [];
  if (headerText) {
    const hc = { type: 'HEADER', format: 'TEXT', text: headerText };
    const hn = placeholderCount(headerText);
    if (hn > 0) hc.example = { header_text: exampleList(hn) };
    components.push(hc);
  }
  const bodyComp = { type: 'BODY', text: bodyText };
  const bn = placeholderCount(bodyText);
  if (bn > 0) bodyComp.example = { body_text: [exampleList(bn)] };
  components.push(bodyComp);
  if (footerText) components.push({ type: 'FOOTER', text: footerText });
  return components;
}

/**
 * The personalised starter pack: the five standard templates Florrie sends,
 * with the salon's own name written into every body so clients always know
 * who is messaging them (display names only show on the contact card, the
 * message itself is what people read). Placeholder counts MUST match what
 * the senders in notifications.js / gap-fill-engine.js / automations.js /
 * autonomous-scheduler.js pass for the matching _v2 names.
 */
function starterPackFor(businessName) {
  const biz = String(businessName || '').trim() || 'your salon';
  return [
    { name: 'booking_confirmation_v3', category: 'UTILITY', label: 'Booking confirmation',
      body: `Hi {{1}}! It's ${biz} 🌸 Your appointment is confirmed for {{2}} at {{3}}. Reply here if anything needs changing. See you then!` },
    { name: 'reminder_24h_v3', category: 'UTILITY', label: '24-hour reminder',
      body: `Hi {{1}}, it's ${biz}! A little reminder that your {{2}} is tomorrow at {{3}}. Reply if you need to reschedule. See you soon 🌸` },
    { name: 'gap_fill_offer_v3', category: 'MARKETING', label: 'Last-minute gap offer',
      body: `Hi {{1}}, it's ${biz}! A spot has just opened up on {{2}} at {{3}}. Fancy it? Reply YES and it's yours, or tell me a time that suits.` },
    { name: 'rebook_nudge_v3', category: 'MARKETING', label: 'Rebook invite',
      body: `Hi {{1}}, it's ${biz} 🌸 It's been a little while! Fancy getting booked back in? Reply here and I'll find you a time.` },
    { name: 'generic_message_v3', category: 'MARKETING', label: 'General message',
      body: `Hi {{1}}! It's ${biz} 🌸 {{2}} Reply here anytime.` },
  ];
}

/**
 * GET /meta-templates
 *
 * Lists all WhatsApp message templates registered on Florrie's WABA via
 * Meta's Graph API. Returns the lean shape the UI needs: name, language,
 * status (APPROVED / PENDING_REVIEW / REJECTED etc.), category, components.
 *
 * Wraps the whatsapp_business_management permission so the demo screencast
 * for Meta App Review has a real, audited surface to exercise.
 */
router.get('/meta-templates', async (req, res) => {
  if (!WA_TOKEN || !WABA_ID) {
    return res.status(503).json({ error: 'WhatsApp env not configured', code: 'whatsapp_env_missing' });
  }
  try {
    const waba = await resolveTemplateWaba(req.beautician.id);
    const url = `${GRAPH}/${waba.wabaId}/message_templates?fields=name,language,status,category,components&limit=100`;
    const r = await fetch(url, { headers: metaHeaders() });
    const data = await r.json();
    if (!r.ok) {
      const meta = extractMetaError(data);
      Sentry.captureMessage('meta-templates list failed', {
        level: 'warning',
        tags: { route: 'whatsapp/meta-templates', op: 'list' },
        extra: { meta, status: r.status },
      });
      return res.status(r.status).json({
        error: meta.userMsg || meta.message || 'Meta rejected the request',
        meta_code: meta.code,
        meta_subcode: meta.subcode,
        fbtrace_id: meta.fbtraceId,
      });
    }
    const templates = (data?.data || []).map((t) => ({
      name: t.name,
      language: t.language,
      status: t.status,
      category: t.category,
      components: t.components || [],
    }));
    const waba2 = await resolveTemplateWaba(req.beautician.id);
    return res.json({ templates, waba: waba2 });
  } catch (err) {
    logger.error({ err }, 'meta-templates list threw');
    Sentry.captureException(err, { tags: { route: 'whatsapp/meta-templates', op: 'list' } });
    return res.status(500).json({ error: 'List templates failed', detail: err.message });
  }
});

/**
 * POST /meta-templates
 *
 * Creates a new WhatsApp message template on Florrie's WABA. Meta queues it
 * for review (usually approved within a few hours) and the template becomes
 * sendable once status flips to APPROVED.
 *
 * Body: { name, category, language, body_text, header_text?, footer_text? }
 *   name        lowercase + underscores only, no spaces (Meta requirement)
 *   category    UTILITY | MARKETING | AUTHENTICATION
 *   language    e.g. en, en_GB, en_US
 *   body_text   required, the main message body
 *   header_text optional, plain-text header
 *   footer_text optional, plain-text footer
 */
router.post('/meta-templates', async (req, res) => {
  if (!WA_TOKEN || !WABA_ID) {
    return res.status(503).json({ error: 'WhatsApp env not configured', code: 'whatsapp_env_missing' });
  }

  const name = String(req.body?.name || '').trim();
  const category = String(req.body?.category || '').trim().toUpperCase();
  const language = String(req.body?.language || '').trim();
  const bodyText = String(req.body?.body_text || '').trim();
  const headerText = req.body?.header_text ? String(req.body.header_text).trim() : '';
  const footerText = req.body?.footer_text ? String(req.body.footer_text).trim() : '';

  if (!name) return res.status(400).json({ error: 'name required', code: 'missing_name' });
  if (!/^[a-z0-9_]+$/.test(name)) {
    return res.status(400).json({
      error: 'name must be lowercase letters, numbers, and underscores only (no spaces)',
      code: 'invalid_name_format',
    });
  }
  const validCategories = ['UTILITY', 'MARKETING', 'AUTHENTICATION'];
  if (!validCategories.includes(category)) {
    return res.status(400).json({
      error: `category must be one of ${validCategories.join(', ')}`,
      code: 'invalid_category',
    });
  }
  if (!language) return res.status(400).json({ error: 'language required', code: 'missing_language' });
  if (!bodyText) return res.status(400).json({ error: 'body_text required', code: 'missing_body' });

  // Meta REJECTS any template whose text contains {{n}} placeholders unless we
  // also supply example values for them. Derive realistic samples per placeholder.
  const sampleValues = ['Sarah', 'Friday 6 June', '2pm', 'Brow Lamination', 'Ellindigo', 'Monday', '10am'];
  const placeholderCount = (t) => {
    const nums = [...String(t).matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => parseInt(m[1], 10));
    return nums.length ? Math.max(...nums) : 0;
  };
  const exampleList = (n) => Array.from({ length: n }, (_, i) => sampleValues[i] || `Example ${i + 1}`);

  const components = [];
  if (headerText) {
    const hc = { type: 'HEADER', format: 'TEXT', text: headerText };
    const hn = placeholderCount(headerText);
    if (hn > 0) hc.example = { header_text: exampleList(hn) };
    components.push(hc);
  }
  const bodyComp = { type: 'BODY', text: bodyText };
  const bn = placeholderCount(bodyText);
  if (bn > 0) bodyComp.example = { body_text: [exampleList(bn)] };
  components.push(bodyComp);
  if (footerText) {
    components.push({ type: 'FOOTER', text: footerText });
  }

  const payload = { name, category, language, components };

  try {
    const waba = await resolveTemplateWaba(req.beautician.id);
    const r = await fetch(`${GRAPH}/${waba.wabaId}/message_templates`, {
      method: 'POST',
      headers: metaHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) {
      const meta = extractMetaError(data);
      Sentry.captureMessage('meta-templates create failed', {
        level: 'warning',
        tags: { route: 'whatsapp/meta-templates', op: 'create' },
        extra: { meta, status: r.status, payload },
      });
      return res.status(r.status).json({
        error: meta.userMsg || meta.message || 'Meta rejected the template',
        meta_code: meta.code,
        meta_subcode: meta.subcode,
        fbtrace_id: meta.fbtraceId,
      });
    }
    return res.status(201).json({
      ok: true,
      id: data?.id || null,
      status: data?.status || 'PENDING_REVIEW',
      category: data?.category || category,
      name,
      language,
    });
  } catch (err) {
    logger.error({ err }, 'meta-templates create threw');
    Sentry.captureException(err, { tags: { route: 'whatsapp/meta-templates', op: 'create' } });
    return res.status(500).json({ error: 'Create template failed', detail: err.message });
  }
});

/**
 * GET /meta-templates/starter-pack
 * Returns the personalised starter pack (named after the salon) without
 * creating anything, plus which of the five already exist on the WABA.
 */
router.get('/meta-templates/starter-pack', async (req, res) => {
  if (!WA_TOKEN || !WABA_ID) {
    return res.status(503).json({ error: 'WhatsApp env not configured', code: 'whatsapp_env_missing' });
  }
  try {
    const { data: b } = await supabase
      .from('beauticians')
      .select('business_name, first_name')
      .eq('id', req.beautician.id)
      .single();
    const biz = b?.business_name || b?.first_name || '';
    const pack = starterPackFor(biz);
    const waba = await resolveTemplateWaba(req.beautician.id);
    const r = await fetch(
      `${GRAPH}/${waba.wabaId}/message_templates?fields=name,status&limit=200`,
      { headers: metaHeaders() }
    );
    const data = await r.json();
    const existing = new Map((data?.data || []).map((t) => [t.name, t.status]));
    return res.json({
      business_name: biz,
      waba,
      pack: pack.map((t) => ({ ...t, existing_status: existing.get(t.name) || null })),
    });
  } catch (err) {
    logger.error({ err }, 'starter-pack preview threw');
    return res.status(500).json({ error: 'Could not load starter pack', detail: err.message });
  }
});

/**
 * POST /meta-templates/starter-pack
 * Creates every missing starter-pack template on the beautician's WABA and
 * submits them to Meta for review. Idempotent: existing names are skipped.
 */
router.post('/meta-templates/starter-pack', async (req, res) => {
  if (!WA_TOKEN || !WABA_ID) {
    return res.status(503).json({ error: 'WhatsApp env not configured', code: 'whatsapp_env_missing' });
  }
  try {
    const { data: b } = await supabase
      .from('beauticians')
      .select('business_name, first_name')
      .eq('id', req.beautician.id)
      .single();
    const biz = b?.business_name || b?.first_name || '';
    if (!biz) {
      return res.status(400).json({
        error: 'Set your business name in Settings first, it goes into every template.',
        code: 'missing_business_name',
      });
    }
    const waba = await resolveTemplateWaba(req.beautician.id);
    const listRes = await fetch(
      `${GRAPH}/${waba.wabaId}/message_templates?fields=name,status&limit=200`,
      { headers: metaHeaders() }
    );
    const listData = await listRes.json();
    const existing = new Map((listData?.data || []).map((t) => [t.name, t.status]));

    const results = [];
    for (const tpl of starterPackFor(biz)) {
      if (existing.has(tpl.name)) {
        results.push({ name: tpl.name, label: tpl.label, action: 'skipped', status: existing.get(tpl.name) });
        continue;
      }
      try {
        const r = await fetch(`${GRAPH}/${waba.wabaId}/message_templates`, {
          method: 'POST',
          headers: metaHeaders(),
          body: JSON.stringify({
            name: tpl.name,
            category: tpl.category,
            language: 'en',
            components: buildTemplateComponents({ bodyText: tpl.body, footerText: tpl.category === 'MARKETING' ? 'Reply STOP to opt out' : undefined }),
          }),
        });
        const data = await r.json();
        if (r.ok) {
          results.push({ name: tpl.name, label: tpl.label, action: 'created', status: data?.status || 'PENDING_REVIEW' });
        } else {
          const meta = extractMetaError(data);
          results.push({ name: tpl.name, label: tpl.label, action: 'failed', error: meta.userMsg || meta.message || 'Meta rejected the template' });
        }
      } catch (err) {
        results.push({ name: tpl.name, label: tpl.label, action: 'failed', error: err.message });
      }
    }
    logger.info({ beauticianId: req.beautician.id, waba: waba.wabaId, results }, 'starter pack submitted');
    return res.json({ ok: true, business_name: biz, waba, results });
  } catch (err) {
    logger.error({ err }, 'starter-pack create threw');
    Sentry.captureException(err, { tags: { route: 'whatsapp/meta-templates', op: 'starter-pack' } });
    return res.status(500).json({ error: 'Starter pack failed', detail: err.message });
  }
});

/**
 * DELETE /meta-templates/:name
 *
 * Removes a template by name from Florrie's WABA. Meta deletes every
 * language variant that shares the name. Templates already sent to users
 * are unaffected (the message stays in their chat history).
 */
router.delete('/meta-templates/:name', async (req, res) => {
  if (!WA_TOKEN || !WABA_ID) {
    return res.status(503).json({ error: 'WhatsApp env not configured', code: 'whatsapp_env_missing' });
  }
  const name = String(req.params.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required', code: 'missing_name' });

  try {
    const waba = await resolveTemplateWaba(req.beautician.id);
    const url = `${GRAPH}/${waba.wabaId}/message_templates?name=${encodeURIComponent(name)}`;
    const r = await fetch(url, {
      method: 'DELETE',
      headers: metaHeaders(),
    });
    const data = await r.json();
    if (!r.ok) {
      const meta = extractMetaError(data);
      Sentry.captureMessage('meta-templates delete failed', {
        level: 'warning',
        tags: { route: 'whatsapp/meta-templates', op: 'delete' },
        extra: { meta, status: r.status, name },
      });
      return res.status(r.status).json({
        error: meta.userMsg || meta.message || 'Meta rejected the delete',
        meta_code: meta.code,
        meta_subcode: meta.subcode,
        fbtrace_id: meta.fbtraceId,
      });
    }
    return res.json({ ok: true, name, success: data?.success !== false });
  } catch (err) {
    logger.error({ err }, 'meta-templates delete threw');
    Sentry.captureException(err, { tags: { route: 'whatsapp/meta-templates', op: 'delete' } });
    return res.status(500).json({ error: 'Delete template failed', detail: err.message });
  }
});

/**
 * GET /full-meta-state
 *
 * One-shot diagnostic that pulls every relevant Meta state field for
 * Florrie's WABA + Ellie's phone + the App. Used when webhook delivery
 * silently fails despite every individual probe looking healthy.
 */
router.get('/full-meta-state', async (req, res) => {
  const beauticianId = req.beautician.id;
  const out = {};

  try {
    const { data: b } = await supabase
      .from('beauticians')
      .select('whatsapp_phone_id')
      .eq('id', beauticianId)
      .single();

    if (WA_TOKEN && WABA_ID) {
      const wabaRes = await fetch(
        `${GRAPH}/${WABA_ID}?fields=id,name,timezone_id,message_template_namespace,currency,on_behalf_of_business_info,business_verification_status,account_review_status,health_status,country,phone_numbers{id,display_phone_number,verified_name,status,code_verification_status,name_status,quality_rating,account_mode,messaging_limit_tier,platform_type,throughput}`,
        { headers: metaHeaders() }
      );
      out.waba = await wabaRes.json();

      if (b?.whatsapp_phone_id) {
        const phoneRes = await fetch(
          `${GRAPH}/${b.whatsapp_phone_id}?fields=id,display_phone_number,verified_name,status,code_verification_status,name_status,quality_rating,account_mode,messaging_limit_tier,platform_type,throughput,is_official_business_account,is_pin_enabled,certificate,new_certificate`,
          { headers: metaHeaders() }
        );
        out.phone = await phoneRes.json();
      }

      const subAppsRes = await fetch(`${GRAPH}/${WABA_ID}/subscribed_apps`, { headers: metaHeaders() });
      out.waba_subscribed_apps = await subAppsRes.json();
    }

    const appId = out.waba_subscribed_apps?.data?.[0]?.whatsapp_business_api_data?.id;
    const appSecret = getAppSecret();
    if (appId && appSecret) {
      const appToken = `${appId}|${appSecret}`;
      const subRes = await fetch(`${GRAPH}/${appId}/subscriptions?access_token=${encodeURIComponent(appToken)}`);
      out.app_subscriptions = await subRes.json();

      const appRes = await fetch(`${GRAPH}/${appId}?fields=id,name,namespace,app_type,category,link,migrations&access_token=${encodeURIComponent(appToken)}`);
      out.app_info = await appRes.json();
    }

    return res.json(out);
  } catch (err) {
    return res.status(500).json({ error: 'Full state probe failed', detail: err.message, partial: out });
  }
});

/**
 * POST /resubscribe-app-webhook
 *
 * Force-reverify the App-level webhook subscription. Meta sometimes leaves
 * a subscription in "configured" state (active:true) but stops delivering
 * because the initial verify handshake never completed or got invalidated.
 * Re-POSTing the subscription forces Meta to re-issue the GET hub.challenge
 * handshake against our callback URL.
 *
 * Uses APP_ID|WHATSAPP_APP_SECRET as the access token (app token).
 * Re-uses existing WHATSAPP_VERIFY_TOKEN so the handshake passes.
 */
router.post('/resubscribe-app-webhook', async (req, res) => {
  try {
    // Derive app id from WABA subscribed_apps (env doesn't have META_APP_ID).
    const subRes = await fetch(`${GRAPH}/${WABA_ID}/subscribed_apps`, { headers: metaHeaders() });
    const subData = await subRes.json();
    const appId = subData?.data?.[0]?.whatsapp_business_api_data?.id || process.env.META_APP_ID;
    if (!appId) return res.status(500).json({ error: 'Cannot determine app id' });

    const appSecret = getAppSecret();
    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
    if (!appSecret) return res.status(500).json({ error: 'WHATSAPP_APP_SECRET not set' });
    if (!verifyToken) return res.status(500).json({ error: 'WHATSAPP_VERIFY_TOKEN not set' });

    const appToken = `${appId}|${appSecret}`;
    const callbackUrl = 'https://florriebackend-production.up.railway.app/api/webhooks/whatsapp';

    const params = new URLSearchParams({
      object: 'whatsapp_business_account',
      callback_url: callbackUrl,
      verify_token: verifyToken,
      fields: 'messages',
      access_token: appToken,
    });

    const r = await fetch(`${GRAPH}/${appId}/subscriptions?${params.toString()}`, {
      method: 'POST',
    });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch (e) { body = text; }
    return res.json({ ok: r.ok, status: r.status, app_id: appId, callback_url: callbackUrl, body });
  } catch (err) {
    return res.status(500).json({ error: 'Resubscribe failed', detail: err.message });
  }
});

/**
 * POST /subscribe-phone
 *
 * Subscribes Florrie's app to the specific phone_number_id (in addition to
 * the WABA-level subscribe). Some setups need both. Uses the beauticians
 * own whatsapp_phone_id.
 */
router.post('/subscribe-phone', async (req, res) => {
  const beauticianId = req.beautician.id;
  if (!WA_TOKEN) return res.status(503).json({ error: 'WhatsApp env not configured' });
  try {
    const { data: b } = await supabase
      .from('beauticians')
      .select('whatsapp_phone_id')
      .eq('id', beauticianId)
      .single();
    if (!b?.whatsapp_phone_id) {
      return res.status(400).json({ error: 'No whatsapp_phone_id on beautician' });
    }
    const r = await fetch(`${GRAPH}/${b.whatsapp_phone_id}/subscribed_apps`, {
      method: 'POST',
      headers: metaHeaders(),
    });
    const data = await r.json();
    return res.json({ ok: r.ok, status: r.status, body: data });
  } catch (err) {
    return res.status(500).json({ error: 'Subscribe-phone failed', detail: err.message });
  }
});

/**
 * POST /subscribe-waba
 *
 * Subscribes Florrie's app to the configured WABA's webhooks at the WABA level
 * (POST /{WABA_ID}/subscribed_apps). This is what makes inbound customer messages
 * reach the /api/webhooks/whatsapp handler. Phone-level subscribe is not always
 * supported, so this is the reliable path. Idempotent: re-subscribing is a no-op.
 */
router.post('/subscribe-waba', async (req, res) => {
  if (!WA_TOKEN || !WABA_ID) return res.status(503).json({ error: 'WhatsApp env not configured' });
  try {
    const r = await fetch(`${GRAPH}/${WABA_ID}/subscribed_apps`, {
      method: 'POST',
      headers: metaHeaders(),
    });
    const data = await r.json();
    return res.json({ ok: r.ok, status: r.status, waba_id: WABA_ID, body: data });
  } catch (err) {
    return res.status(500).json({ error: 'Subscribe-waba failed', detail: err.message });
  }
});

/**
 * GET /phone-details
 *
 * Returns Meta's full state for the beautician's phone, including
 * messaging_limit_tier, throughput, quality_rating, status, and platform_type.
 * Used to confirm the phone is provisioned for inbound traffic.
 */
router.get('/phone-details', async (req, res) => {
  const beauticianId = req.beautician.id;
  try {
    const { data: b } = await supabase
      .from('beauticians')
      .select('whatsapp_phone_id')
      .eq('id', beauticianId)
      .single();
    if (!b?.whatsapp_phone_id) return res.status(400).json({ error: 'No whatsapp_phone_id' });
    const fields = 'display_phone_number,verified_name,code_verification_status,quality_rating,status,platform_type,throughput,messaging_limit_tier,name_status,is_official_business_account,is_pin_enabled,account_mode,id';
    const r = await fetch(`${GRAPH}/${b.whatsapp_phone_id}?fields=${fields}`, { headers: metaHeaders() });
    return res.json({ status: r.status, body: await r.json() });
  } catch (err) {
    return res.status(500).json({ error: 'Phone-details failed', detail: err.message });
  }
});

/**
 * GET /webhook-status
 *
 * Diagnostic: returns the current webhook plumbing state so we can debug
 * why inbound WhatsApp messages aren't reaching Florrie's webhook handler.
 *
 * Returns:
 *   env: which env vars are set (without values)
 *   waba_subscribed_apps: Meta WABA's subscribed apps (should include Florries app)
 *   app_subscriptions: Meta App's webhook subscriptions (URL + fields)
 */
router.get('/webhook-status', async (req, res) => {
  const out = {
    env: {
      WHATSAPP_TOKEN: !!WA_TOKEN,
      WHATSAPP_WABA_ID: !!WABA_ID,
      WHATSAPP_VERIFY_TOKEN: !!process.env.WHATSAPP_VERIFY_TOKEN,
      WHATSAPP_APP_SECRET: !!process.env.WHATSAPP_APP_SECRET,
      META_APP_ID: !!process.env.META_APP_ID,
      META_APP_SECRET: !!process.env.META_APP_SECRET,
      WHATSAPP_API_VERSION: API_VER,
    },
    waba_id: WABA_ID || null,
    meta_app_id: process.env.META_APP_ID || null,
  };

  if (WA_TOKEN && WABA_ID) {
    try {
      const r = await fetch(`${GRAPH}/${WABA_ID}/subscribed_apps`, { headers: metaHeaders() });
      out.waba_subscribed_apps = await r.json();
    } catch (err) {
      out.waba_subscribed_apps_error = err.message;
    }
  }

  // Derive app id from the subscribed_apps response (Meta returns it under
  // whatsapp_business_api_data.id). Fall back to env if those vars exist.
  const derivedAppId = out.waba_subscribed_apps?.data?.[0]?.whatsapp_business_api_data?.id || null;
  const appId = process.env.META_APP_ID || derivedAppId;
  const appSecret = getAppSecret();
  out.using_app_id = appId;
  if (appId && appSecret) {
    const appToken = `${appId}|${appSecret}`;
    try {
      const r = await fetch(`${GRAPH}/${appId}/subscriptions?access_token=${encodeURIComponent(appToken)}`);
      out.app_subscriptions = await r.json();
    } catch (err) {
      out.app_subscriptions_error = err.message;
    }
  } else {
    out.app_subscriptions_skipped = 'no app id (META_APP_ID + WABA subscribed_apps both empty) or no app secret';
  }

  return res.json(out);
});

/**
 * POST /subscribe-webhook
 *
 * Subscribes Florrie's app to receive inbound WhatsApp webhooks for this
 * beautician's WABA. Required for inbound messages to actually reach
 * /api/webhooks/whatsapp. Registration alone (the reconcile endpoint or the
 * usual register/verify flow) does NOT do this — it's a separate Meta step.
 *
 * Idempotent: Meta returns success even if already subscribed.
 *
 * No body required. Uses Florrie's env WABA_ID.
 */
router.post('/subscribe-webhook', async (req, res) => {
  const beauticianId = req.beautician.id;
  if (!WA_TOKEN || !WABA_ID) {
    return res.status(503).json({ error: 'WhatsApp env not configured', code: 'whatsapp_env_missing' });
  }
  try {
    const subRes = await fetch(`${GRAPH}/${WABA_ID}/subscribed_apps`, {
      method: 'POST',
      headers: metaHeaders(),
    });
    const subData = await subRes.json();
    if (!subRes.ok) {
      const meta = extractMetaError(subData);
      logger.warn({ meta, beauticianId }, 'WABA subscribe-webhook failed');
      return res.status(400).json({
        ok: false,
        error: meta.userMsg || meta.message || 'Meta rejected the subscription',
        meta_code: meta.code,
        meta_subcode: meta.subcode,
        raw: subData,
      });
    }
    // Verify
    const checkRes = await fetch(`${GRAPH}/${WABA_ID}/subscribed_apps`, { headers: metaHeaders() });
    const checkData = await checkRes.json();
    return res.json({
      ok: true,
      subscribed: subData,
      subscribed_apps: checkData?.data || [],
    });
  } catch (err) {
    logger.error({ err }, 'WABA subscribe-webhook threw');
    Sentry.captureException(err, { tags: { route: 'whatsapp/subscribe-webhook' } });
    return res.status(500).json({ error: 'Subscribe failed', detail: err.message });
  }
});

/**
 * POST /test-send
 *
 * End-to-end audit endpoint. Sends Meta's hello_world template from the
 * beautician's own WABA number to a target recipient. Returns the Meta
 * messages.0.id on success. Used to prove the Cloud API stack actually
 * delivers messages, not just that the registration paperwork looks right.
 *
 * Body: { to: "+447..." }   — target recipient in E.164
 * Requires beautician to be connected (whatsapp_phone_id set).
 * Uses Meta's built-in "hello_world" template (en) which is pre-approved
 * on every WABA, so no template-creation step is needed.
 */
router.post('/test-send', async (req, res) => {
  const beauticianId = req.beautician.id;
  const to = String(req.body?.to || '').trim();
  const explicitTemplate = String(req.body?.template || '').trim() || null;
  const explicitLang = String(req.body?.language || '').trim() || null;
  const freeText = typeof req.body?.text === 'string' ? req.body.text.trim() : '';

  if (!to || !/^\+?\d{10,15}$/.test(to)) {
    return res.status(400).json({
      error: 'to required (E.164 phone, e.g. +447951413513)',
      code: 'invalid_recipient',
    });
  }

  if (!WA_TOKEN) {
    return res.status(503).json({ error: 'WhatsApp env not configured', code: 'whatsapp_env_missing' });
  }

  try {
    const { data: b, error: bErr } = await supabase
      .from('beauticians')
      .select('whatsapp_phone_id, whatsapp_connected')
      .eq('id', beauticianId)
      .single();
    if (bErr || !b) return res.status(404).json({ error: 'Beautician not found' });
    if (!b.whatsapp_phone_id) {
      return res.status(400).json({
        error: 'Connect WhatsApp first',
        code: 'whatsapp_not_connected',
      });
    }

    const recipient = to.startsWith('+') ? to.slice(1) : to;

    // Free-form text path. Only works inside the 24h customer-service
    // window (i.e., the recipient has sent the beautician a message in the
    // last 24h). Outside that window Meta returns code 131047.
    if (freeText) {
      if (freeText.length > 4096) {
        return res.status(400).json({
          ok: false,
          error: 'Message body too long (4096 char max)',
          code: 'text_too_long',
        });
      }
      const sendRes = await fetch(`${GRAPH}/${b.whatsapp_phone_id}/messages`, {
        method: 'POST',
        headers: metaHeaders(),
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: recipient,
          type: 'text',
          text: { body: freeText },
        }),
      });
      const sendData = await sendRes.json();
      if (!sendRes.ok) {
        const meta = extractMetaError(sendData);
        return res.status(400).json({
          ok: false,
          error: meta?.userMsg || meta?.message || 'Meta rejected the send',
          meta_code: meta?.code,
          meta_subcode: meta?.subcode,
          meta_user_title: meta?.userTitle,
          fbtrace_id: meta?.fbtraceId,
          raw: sendData,
        });
      }
      return res.json({
        ok: true,
        message_id: sendData?.messages?.[0]?.id || null,
        to: `+${recipient}`,
        type: 'text',
        raw: sendData,
      });
    }

    // Try hello_world first across common UK/intl locales. If it's not on the
    // WABA, auto-discover an APPROVED template with zero required parameters
    // and use that. This lets the audit succeed regardless of which sample
    // templates are present.
    async function tryTemplate(name, lang) {
      const res = await fetch(`${GRAPH}/${b.whatsapp_phone_id}/messages`, {
        method: 'POST',
        headers: metaHeaders(),
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: recipient,
          type: 'template',
          template: { name, language: { code: lang } },
        }),
      });
      const data = await res.json();
      return { res, data };
    }

    const attempted = [];
    let result = null;
    let usedTemplate = null;
    let usedLanguage = null;
    let lastMeta = null;

    // If caller specified an explicit template, just try that one and report.
    if (explicitTemplate) {
      const langs = explicitLang ? [explicitLang] : ['en', 'en_US', 'en_GB'];
      for (const lang of langs) {
        const t = await tryTemplate(explicitTemplate, lang);
        attempted.push({ name: explicitTemplate, lang, status: t.res.status });
        if (t.res.ok) {
          return res.json({
            ok: true,
            message_id: t.data?.messages?.[0]?.id || null,
            to: `+${recipient}`,
            template: explicitTemplate,
            language: lang,
            attempted,
            raw: t.data,
          });
        }
        lastMeta = extractMetaError(t.data);
      }
      return res.status(400).json({
        ok: false,
        error: lastMeta?.userMsg || lastMeta?.message || 'Meta rejected the send',
        meta_code: lastMeta?.code,
        meta_subcode: lastMeta?.subcode,
        attempted,
      });
    }

    // Pass 1: hello_world in common UK/intl locales
    for (const lang of ['en_US', 'en', 'en_GB']) {
      const t = await tryTemplate('hello_world', lang);
      attempted.push({ name: 'hello_world', lang, status: t.res.status });
      if (t.res.ok) {
        result = t.data;
        usedTemplate = 'hello_world';
        usedLanguage = lang;
        break;
      }
      lastMeta = extractMetaError(t.data);
      // Anything that's not "template not found" is a real error; stop.
      if (lastMeta?.code !== 132001 && lastMeta?.code !== 132012) {
        return res.status(400).json({
          ok: false,
          error: lastMeta?.userMsg || lastMeta?.message || 'Meta rejected the send',
          meta_code: lastMeta?.code,
          meta_subcode: lastMeta?.subcode,
          attempted,
          raw: t.data,
        });
      }
    }

    // Pass 2: auto-discover an APPROVED template with no required body params
    if (!result) {
      const tplList = await fetch(
        `${GRAPH}/${WABA_ID}/message_templates?fields=name,language,status,components&limit=50`,
        { headers: metaHeaders() }
      );
      const tplJson = await tplList.json();
      const candidates = (tplJson?.data || []).filter((t) => {
        if (t.status !== 'APPROVED') return false;
        const body = (t.components || []).find((c) => c.type === 'BODY');
        const params = body?.text?.match(/\{\{\d+\}\}/g) || [];
        return params.length === 0;
      });
      for (const tpl of candidates) {
        const t = await tryTemplate(tpl.name, tpl.language);
        attempted.push({ name: tpl.name, lang: tpl.language, status: t.res.status });
        if (t.res.ok) {
          result = t.data;
          usedTemplate = tpl.name;
          usedLanguage = tpl.language;
          break;
        }
        lastMeta = extractMetaError(t.data);
      }

      if (!result) {
        const approvedCount = (tplJson?.data || []).filter((t) => t.status === 'APPROVED').length;
        return res.status(400).json({
          ok: false,
          error: 'No usable template found for test send',
          approved_templates: approvedCount,
          zero_param_templates: candidates.length,
          attempted,
          last_meta: lastMeta,
          template_list_sample: (tplJson?.data || []).slice(0, 10).map((t) => ({
            name: t.name,
            language: t.language,
            status: t.status,
          })),
        });
      }
    }

    return res.json({
      ok: true,
      message_id: result?.messages?.[0]?.id || null,
      to: `+${recipient}`,
      template: usedTemplate,
      language: usedLanguage,
      attempted,
      raw: result,
    });
  } catch (err) {
    logger.error({ err }, 'Test send threw');
    Sentry.captureException(err, { tags: { route: 'whatsapp/test-send' } });
    return res.status(500).json({ error: 'Test send failed', code: 'test_send_failed', detail: err.message });
  }
});

/**
 * GET /activation-status
 * Polled by the UI after /verify to detect when Meta's Cloud API actually
 * flips from PENDING to CONNECTED. When it does, we flip
 * whatsapp_connected=true and the UI swaps out of the spinner.
 */
router.get('/activation-status', async (req, res) => {
  const beauticianId = req.beautician.id;

  try {
    const { data: b } = await supabase
      .from('beauticians')
      .select('whatsapp_phone, whatsapp_phone_id, whatsapp_connected, whatsapp_pending_activation')
      .eq('id', beauticianId)
      .single();

    if (!b) return res.status(404).json({ error: 'Beautician not found' });
    if (!b.whatsapp_phone_id) {
      return res.json({ connected: false, pendingActivation: false, status: 'no_number' });
    }
    if (b.whatsapp_connected) {
      return res.json({ connected: true, pendingActivation: false, status: 'connected' });
    }

    // Live poll Meta
    const activation = await verifyCloudApiActivation(b.whatsapp_phone_id);

    if (activation.active) {
      await supabase
        .from('beauticians')
        .update({
          whatsapp_connected: true,
          whatsapp_pending_activation: false,
          whatsapp_pending_phone: null,
          whatsapp_retry_at: null,
          whatsapp_retry_reason: null,
        })
        .eq('id', beauticianId);

      await logDiagnostic({
        beautician_id: beauticianId,
        phone: b.whatsapp_phone || '',
        stage: 'register_cloud_api',
        success: true,
        diagnosis: 'connected_delayed',
      });

      logger.info({ beauticianId }, 'WhatsApp Cloud API flipped to CONNECTED on poll');

      return res.json({ connected: true, pendingActivation: false, status: 'connected' });
    }

    return res.json({
      connected: false,
      pendingActivation: !!b.whatsapp_pending_activation,
      status: activation.status || 'pending',
      metaStatus: activation.status || null,
    });
  } catch (err) {
    logger.error({ err }, 'WhatsApp activation-status error');
    Sentry.captureException(err, { tags: { route: 'whatsapp/activation-status' } });
    return res.status(500).json({ error: 'Could not check activation status', code: 'activation_status_failed' });
  }
});

/**
 * GET /status
 * Returns connection status + monthly usage + retry queue state for the dashboard.
 */
router.get('/status', async (req, res) => {
  const beauticianId = req.beautician.id;

  try {
    const { data: b, error: bErr } = await supabase
      .from('beauticians')
      .select('whatsapp_connected, whatsapp_phone, whatsapp_phone_id, whatsapp_registered_at, whatsapp_pending_phone, whatsapp_pending_activation, whatsapp_retry_at, whatsapp_retry_reason, whatsapp_retry_attempts, whatsapp_retry_exhausted, business_name')
      .eq('id', beauticianId)
      .single();

    if (bErr || !b) return res.status(404).json({ error: 'Beautician not found' });

    const usage = await getMonthlyUsage(beauticianId);

    return res.json({
      connected: !!b.whatsapp_connected,
      phone: b.whatsapp_phone || null,
      phone_number_id: b.whatsapp_phone_id || null,
      pending_phone: b.whatsapp_pending_phone || null,
      pending_activation: !!b.whatsapp_pending_activation,
      registered_at: b.whatsapp_registered_at || null,
      business_name: b.business_name || null,
      retry_exhausted: !!b.whatsapp_retry_exhausted,
      retry: b.whatsapp_retry_at
        ? {
            retry_at: b.whatsapp_retry_at,
            reason: b.whatsapp_retry_reason,
            attempts: b.whatsapp_retry_attempts || 0,
          }
        : null,
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
    Sentry.captureException(err, { tags: { route: 'whatsapp/status' } });
    return res.status(500).json({ error: 'Something went wrong', code: 'status_failed' });
  }
});

/**
 * GET /diagnostics
 * Returns the last 10 diagnostic rows for this beautician.
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
    Sentry.captureException(err, { tags: { route: 'whatsapp/diagnostics' } });
    return res.status(500).json({ error: 'Failed to load diagnostics', code: 'diagnostics_failed' });
  }
});

/**
 * DELETE /disconnect
 * Same as /reset but bound to DELETE for back-compat with older frontend code.
 */
router.delete('/disconnect', async (req, res) => {
  const beauticianId = req.beautician.id;

  try {
    const { data: b } = await supabase
      .from('beauticians')
      .select('whatsapp_phone_id')
      .eq('id', beauticianId)
      .single();

    if (b?.whatsapp_phone_id) {
      const del = await deleteFromMeta(b.whatsapp_phone_id);
      if (!del.ok) {
        logger.warn({ del, beauticianId }, 'Meta phone delete failed during disconnect, clearing locally');
      }
    }

    await clearBeauticianWhatsapp(beauticianId);

    logger.info({ beauticianId }, 'WhatsApp disconnected');
    return res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'WhatsApp disconnect error');
    Sentry.captureException(err, { tags: { route: 'whatsapp/disconnect' } });
    return res.status(500).json({ error: 'Something went wrong', code: 'disconnect_failed' });
  }
});

/**
 * GET /template-debug
 *
 * Read-only deep-dive for Meta error 132001 ("Template name does not exist
 * in the translation"). The error fires even when the template shows
 * APPROVED on /{WABA_ID}/message_templates, so we need a way to compare
 * the WABA the templates live on, the WABA the phone reports as parent,
 * and what exact language enum Meta will accept on a real send.
 *
 * Query params:
 *   name      template name (defaults to "generic_message" for the Ellie pilot)
 *   language  optional. If supplied, only this exact language code is tried.
 *             If omitted, we try a sweep: ["en", "en_US", "en_GB"] plus
 *             whatever language(s) the WABA list reports for that template.
 *   to        optional E.164 recipient. If absent we use the beautician's
 *             own whatsapp_phone (the Cloud API allows self-send for tests).
 *
 * Returns:
 *   env_waba_id              the WHATSAPP_WABA_ID Florrie expects to own this phone
 *   beautician_phone_id      what we stored in the DB
 *   phone_meta               Meta's view of the phone, including whatsapp_business_account
 *                            (so we can detect if the phone is on a different WABA)
 *   phone_parent_waba_id     the WABA id Meta reports for this phone
 *   waba_match               true if phone_parent_waba_id === env_waba_id
 *   name_status_warning      true if Meta shows name_status === DECLINED (may gate sends)
 *   template_in_list         the matching template object from
 *                            /{env_waba_id}/message_templates?name=...
 *                            (or null if not present on env WABA)
 *   template_in_phone_waba   if waba_match=false, the same lookup against the
 *                            phone's actual parent WABA (this is usually the
 *                            real fix when the env is mis-set)
 *   send_attempts            array of { language, http_status, ok, meta_error,
 *                            request_body, response_body } for every language
 *                            code we tried
 *   verdict                  best-guess root cause (waba_mismatch | name_status_declined |
 *                            template_not_on_waba | language_enum_mismatch | unknown)
 *
 * No DB writes. No production-affecting side effects. Safe to hammer.
 */
router.get('/template-debug', async (req, res) => {
  const beauticianId = req.beautician.id;
  const templateName = String(req.query?.name || 'generic_message').trim();
  const explicitLang = req.query?.language ? String(req.query.language).trim() : null;
  const explicitTo = req.query?.to ? String(req.query.to).trim() : null;

  if (!WA_TOKEN || !WABA_ID) {
    return res.status(503).json({ error: 'WhatsApp env not configured', code: 'whatsapp_env_missing' });
  }

  const out = {
    template_name: templateName,
    env_waba_id: WABA_ID,
    api_version: API_VER,
    beautician_phone_id: null,
    phone_meta: null,
    phone_parent_waba_id: null,
    waba_match: null,
    name_status_warning: false,
    template_in_list: null,
    template_in_phone_waba: null,
    send_attempts: [],
    verdict: 'unknown',
    notes: [],
  };

  try {
    // 1. Load beautician phone id + a sensible default recipient (self-send).
    const { data: b, error: bErr } = await supabase
      .from('beauticians')
      .select('whatsapp_phone_id, whatsapp_phone')
      .eq('id', beauticianId)
      .single();
    if (bErr || !b) return res.status(404).json({ error: 'Beautician not found' });
    if (!b.whatsapp_phone_id) {
      return res.status(400).json({ error: 'Connect WhatsApp first', code: 'whatsapp_not_connected' });
    }
    out.beautician_phone_id = b.whatsapp_phone_id;

    const recipientRaw = explicitTo || b.whatsapp_phone || '';
    const recipient = recipientRaw.startsWith('+') ? recipientRaw.slice(1) : recipientRaw;
    if (!/^\d{10,15}$/.test(recipient)) {
      out.notes.push('No valid recipient available. Send attempts skipped.');
    }

    // 2. Phone meta with whatsapp_business_account so we can compare parent WABA.
    const phoneFields = [
      'id',
      'display_phone_number',
      'verified_name',
      'status',
      'code_verification_status',
      'name_status',
      'account_mode',
      'messaging_limit_tier',
      'platform_type',
      'whatsapp_business_account{id,name,message_template_namespace}',
    ].join(',');
    const phoneRes = await fetch(`${GRAPH}/${b.whatsapp_phone_id}?fields=${phoneFields}`, {
      headers: metaHeaders(),
    });
    const phoneJson = await phoneRes.json();
    out.phone_meta = phoneJson;
    out.phone_parent_waba_id = phoneJson?.whatsapp_business_account?.id || null;
    out.waba_match = out.phone_parent_waba_id ? out.phone_parent_waba_id === WABA_ID : null;

    if (phoneJson?.name_status && phoneJson.name_status !== 'APPROVED') {
      out.name_status_warning = true;
      out.notes.push(
        `name_status is ${phoneJson.name_status}. Meta sometimes blocks template sends until a verified_name is APPROVED, even on otherwise CONNECTED numbers.`
      );
    }

    // 3. Template lookup against env WABA (filter by name).
    const listEnvRes = await fetch(
      `${GRAPH}/${WABA_ID}/message_templates?name=${encodeURIComponent(templateName)}&fields=name,language,status,category,id,components&limit=50`,
      { headers: metaHeaders() }
    );
    const listEnv = await listEnvRes.json();
    const envMatches = (listEnv?.data || []).filter((t) => t.name === templateName);
    out.template_in_list = {
      raw_query_status: listEnvRes.status,
      raw_query_error: listEnv?.error || null,
      matches: envMatches,
      match_count: envMatches.length,
    };

    // 4. If the phone reports a different parent WABA, look the template up
    //    there too. This is the smoking gun for hypothesis 1.
    if (out.phone_parent_waba_id && out.phone_parent_waba_id !== WABA_ID) {
      const listPhoneRes = await fetch(
        `${GRAPH}/${out.phone_parent_waba_id}/message_templates?name=${encodeURIComponent(templateName)}&fields=name,language,status,category,id,components&limit=50`,
        { headers: metaHeaders() }
      );
      const listPhone = await listPhoneRes.json();
      const phoneMatches = (listPhone?.data || []).filter((t) => t.name === templateName);
      out.template_in_phone_waba = {
        raw_query_status: listPhoneRes.status,
        raw_query_error: listPhone?.error || null,
        matches: phoneMatches,
        match_count: phoneMatches.length,
      };
    }

    // 5. Build the language sweep. Always probe what the WABA list told us
    //    the template's language is, then top up with common UK/intl codes.
    const fromList = envMatches.map((t) => t.language).filter(Boolean);
    const langs = explicitLang
      ? [explicitLang]
      : Array.from(new Set([...fromList, 'en', 'en_US', 'en_GB']));

    if (/^\d{10,15}$/.test(recipient)) {
      for (const lang of langs) {
        const requestBody = {
          messaging_product: 'whatsapp',
          to: recipient,
          type: 'template',
          template: { name: templateName, language: { code: lang } },
        };
        let sendRes, sendJson;
        try {
          sendRes = await fetch(`${GRAPH}/${b.whatsapp_phone_id}/messages`, {
            method: 'POST',
            headers: metaHeaders(),
            body: JSON.stringify(requestBody),
          });
          sendJson = await sendRes.json();
        } catch (sendErr) {
          out.send_attempts.push({
            language: lang,
            ok: false,
            http_status: null,
            request_body: requestBody,
            transport_error: sendErr.message,
          });
          continue;
        }
        out.send_attempts.push({
          language: lang,
          ok: sendRes.ok,
          http_status: sendRes.status,
          meta_error: sendRes.ok ? null : extractMetaError(sendJson),
          request_body: requestBody,
          response_body: sendJson,
        });
        // Stop early on first success so we don't spam Ellie's phone.
        if (sendRes.ok) break;
      }
    }

    // 6. Best-guess verdict the UI can render in one line.
    const anySuccess = out.send_attempts.some((a) => a.ok);
    if (anySuccess) {
      out.verdict = 'send_succeeded';
    } else if (out.waba_match === false) {
      out.verdict = 'waba_mismatch';
      out.notes.push(
        `Phone is on WABA ${out.phone_parent_waba_id} but env WHATSAPP_WABA_ID is ${WABA_ID}. Update the env var or move the phone.`
      );
    } else if (out.template_in_list.match_count === 0) {
      out.verdict = 'template_not_on_waba';
      out.notes.push(
        `No template named "${templateName}" exists on env WABA ${WABA_ID}. Check spelling or create it.`
      );
    } else if (out.name_status_warning) {
      out.verdict = 'name_status_declined';
    } else {
      // Templates exist, WABA matches, name is fine, but every send still
      // fails with 132001. That's the language-enum mismatch case.
      const tried = out.send_attempts.map((a) => a.language);
      const listed = fromList;
      out.verdict = 'language_enum_mismatch';
      out.notes.push(
        `Template language(s) per Meta list: [${listed.join(', ') || 'none'}]. Tried: [${tried.join(', ')}]. None accepted.`
      );
    }

    return res.json(out);
  } catch (err) {
    logger.error({ err }, 'template-debug threw');
    Sentry.captureException(err, { tags: { route: 'whatsapp/template-debug' } });
    return res.status(500).json({ error: 'template-debug failed', detail: err.message, partial: out });
  }
});

// Expose helpers for the retry worker. Kept at the bottom so the public
// route surface stays readable above.
export const _whatsappInternals = {
  runPreflight,
  verifyCloudApiActivation,
  requestOtp,
  deleteFromMeta,
  findExistingOnWaba,
  clearBeauticianWhatsapp,
  logDiagnostic,
  normalisePhone,
  isValidE164,
  splitPhone,
  // Exposed for unit tests
  idempotencyKey,
  getCachedVerify,
  cacheVerify,
  verifyIdempotencyCache,
};

export default router;
