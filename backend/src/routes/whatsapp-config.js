/**
 * WhatsApp Configuration Routes
 *
 * Handles phone number registration for Florrie's WABA.
 * Each beautician adds their own number — Florrie pays Meta, beauticians just connect.
 *
 * Flow:
 *   POST /api/whatsapp/register     → add number to WABA + request OTP via SMS
 *   POST /api/whatsapp/resend-code  → request another OTP (user tapped "resend")
 *   POST /api/whatsapp/verify       → verify OTP + activate number for Cloud API
 *   GET  /api/whatsapp/status       → connection status + monthly usage
 *   DELETE /api/whatsapp/disconnect → remove number from WABA
 *
 * Meta's 3-step registration (what this actually does under the hood):
 *   1. POST /{WABA_ID}/phone_numbers       → add the number as a WABA entry
 *   2. POST /{phone_number_id}/request_code → Meta sends SMS to the number
 *   3. POST /{phone_number_id}/verify_code  → confirm ownership
 *   4. POST /{phone_number_id}/register     → activate for Cloud API (with PIN)
 *
 * Env vars required:
 *   WHATSAPP_TOKEN    — Florrie's system user token (permanent)
 *   WHATSAPP_WABA_ID  — Florrie's WhatsApp Business Account ID
 *   WHATSAPP_API_VERSION — e.g. "v19.0" (defaults to v19.0)
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
const API_VER = process.env.WHATSAPP_API_VERSION || 'v19.0';
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
  // UK: 07xxx (11 digits) → 447xxx
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
 * Register a phone number with Florrie's WABA, then trigger an SMS OTP.
 *
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
        error: 'That number doesn\'t look right. UK mobiles should be 11 digits starting with 07.',
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
        error: 'Set your business name in Settings first — WhatsApp uses it as the display name your clients will see.',
      });
    }

    // Step 1: add the number to Florrie's WABA (with verified_name)
    const addRes = await fetch(`${GRAPH}/${WABA_ID}/phone_numbers`, {
      method: 'POST',
      headers: metaHeaders(),
      body: JSON.stringify({ cc, phone_number: number, verified_name: verifiedName }),
    });
    const addData = await addRes.json();

    let phoneNumberId = addData?.id;

    if (!addRes.ok) {
      const code = addData?.error?.code;
      const metaMessage = addData?.error?.message || '';

      // Meta's code 100 is a catch-all ("Invalid parameter"). One benign case:
      // the number is already on our WABA from a half-finished previous attempt.
      // Try to recover by looking it up before surfacing an error.
      if (code === 100) {
        const filter = encodeURIComponent(
          JSON.stringify([{ field: 'phone_number', operator: 'CONTAIN', value: e164 }])
        );
        const lookup = await fetch(
          `${GRAPH}/${WABA_ID}/phone_numbers?filtering=${filter}`,
          { headers: metaHeaders() }
        );
        const lookupData = await lookup.json();
        phoneNumberId = lookupData?.data?.[0]?.id;

        if (!phoneNumberId) {
          logger.error(
            { addData, lookupData, phone: e164 },
            'Meta rejected phone registration and WABA lookup found nothing'
          );
          return res.status(400).json({
            error:
              "Couldn't connect this number. Usual causes: it's still active on WhatsApp or WhatsApp Business on your phone (delete that account first — export your chat history beforehand if you need it), or it's already tied to another WhatsApp Business API provider.",
            meta_code: code,
            meta_message: metaMessage,
          });
        }
      } else {
        logger.error({ addData, phone: e164 }, 'Meta phone registration failed');
        return res.status(400).json({
          error: metaMessage || 'Failed to register number with Meta',
          meta_code: code,
        });
      }
    }

    if (!phoneNumberId) {
      logger.error({ addData }, 'Meta returned 200 but no phone_number_id');
      return res.status(500).json({ error: 'Meta didn\'t return a phone ID' });
    }

    // Step 2: actually send the SMS
    const otp = await requestOtp(phoneNumberId);
    if (!otp.ok) {
      logger.error({ metaData: otp.data, phoneNumberId, phone: e164 }, 'Meta OTP request failed');
      return res.status(400).json({
        error: otp.data?.error?.message || 'Couldn\'t send the verification code. Make sure the number isn\'t active on WhatsApp.',
        meta_code: otp.data?.error?.code,
      });
    }

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
    });
  } catch (err) {
    logger.error({ err }, 'WhatsApp register error');
    return res.status(500).json({ error: 'Something went wrong' });
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
      logger.warn({ metaData: otp.data, beauticianId }, 'Meta OTP resend failed');
      return res.status(400).json({
        error: otp.data?.error?.message || 'Couldn\'t resend the code',
        meta_code: otp.data?.error?.code,
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
 *
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
      logger.warn({ metaData: verifyData, beauticianId }, 'WhatsApp OTP verification failed');
      return res.status(400).json({ error: verifyData?.error?.message || 'Invalid verification code' });
    }

    // Step 2: activate the number for Cloud API (required — otherwise messages can't send)
    // Backfill a PIN if one is missing (e.g. legacy rows).
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
      const metaCode = registerData?.error?.code;
      // 133004 / 133005 / 133006 = PIN-related; treat the verification itself as successful
      // but flag that 2FA activation failed so Levi can retry.
      logger.error({ metaData: registerData, beauticianId, metaCode }, 'WhatsApp Cloud API register failed after verify');
      return res.status(400).json({
        error: registerData?.error?.message || 'Number verified but Cloud API activation failed — try disconnecting and reconnecting.',
        meta_code: metaCode,
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
 * Disconnect WhatsApp — removes the number from Meta's WABA and clears credentials.
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
        logger.warn({ metaData, beauticianId }, 'Meta phone delete failed — clearing locally anyway');
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
