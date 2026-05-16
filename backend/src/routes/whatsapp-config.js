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
