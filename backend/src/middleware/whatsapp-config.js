/**
 * WhatsApp Configuration Routes
 *
 * Handles phone number registration for Florrie's WABA.
 * Each beautician adds their own number — Florrie pays Meta, beauticians just connect.
 *
 * Flow:
 *   POST /api/whatsapp/register  → send OTP to phone via Meta
 *   POST /api/whatsapp/verify    → verify OTP, store phone_number_id
 *   GET  /api/whatsapp/status    → connection status + monthly usage
 *   DELETE /api/whatsapp/disconnect → remove number from WABA
 *
 * Env vars required:
 *   WHATSAPP_TOKEN    — Florrie's system user token (permanent)
 *   WHATSAPP_WABA_ID  — Florrie's WhatsApp Business Account ID
 *   WHATSAPP_API_VERSION — e.g. "v19.0" (defaults to v19.0)
 */

import express from 'express';
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { getMonthlyUsage } from '../services/whatsapp-metering.js';

const router = express.Router();
router.use(requireAuth);

// Accept Meta's official Railway env names as fallbacks.
const WA_TOKEN = process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
const WABA_ID = process.env.WHATSAPP_WABA_ID || process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
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
  // Strip everything except digits and leading +
  let cleaned = raw.replace(/\s+/g, '').replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) cleaned = cleaned.slice(1);
  // UK: 07xxx → 447xxx
  if (cleaned.startsWith('07') && cleaned.length === 11) {
    cleaned = '44' + cleaned.slice(1);
  }
  return cleaned;
}

/** Split E.164 number into country code + national number */
function splitPhone(e164) {
  // Simple: UK = 44, US = 1. Expand as needed.
  if (e164.startsWith('44')) return { cc: '44', number: e164.slice(2) };
  if (e164.startsWith('1') && e164.length === 11) return { cc: '1', number: e164.slice(1) };
  // Fallback: first 2 digits as cc
  return { cc: e164.slice(0, 2), number: e164.slice(2) };
}

/**
 * Register a phone number with Florrie's WABA.
 * Triggers Meta to send an OTP to that number via SMS.
 *
 * Body: { phone: "+447700900123" }
 */
router.post('/register', async (req, res) => {
  if (!WA_TOKEN || !WABA_ID) {
    return res.status(503).json({ error: 'WhatsApp not configured on this server' });
  }

  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone is required' });

  const beauticianId = req.user.id;

  try {
    const e164 = normalisePhone(phone);
    const { cc, number } = splitPhone(e164);

    // Call Meta: register the number to Florrie's WABA
    const metaRes = await fetch(`${GRAPH}/${WABA_ID}/phone_numbers`, {
      method: 'POST',
      headers: metaHeaders(),
      body: JSON.stringify({
        cc,
        phone_number: number,
        method: 'SMS', // or VOICE — SMS is standard
        certificate: undefined, // optional display name verification cert
      }),
    });

    const metaData = await metaRes.json();

    if (!metaRes.ok) {
      const code = metaData?.error?.code;
      // 100 = number already registered to this WABA — not an error for us
      if (code !== 100) {
        logger.error({ metaData, phone }, 'Meta phone registration failed');
        return res.status(400).json({
          error: metaData?.error?.message || 'Failed to register number with Meta',
          meta_code: code,
        });
      }
    }

    const phoneNumberId = metaData.id;

    // Store the pending number + phone_number_id on the beautician
    // (not yet connected — awaiting OTP verification)
    await supabase
      .from('beauticians')
      .update({
        whatsapp_pending_phone: `+${e164}`,
        whatsapp_phone_id: phoneNumberId,
        whatsapp_connected: false,
      })
      .eq('id', beauticianId);

    logger.info({ beauticianId, phoneNumberId, phone: `+${e164}` }, 'WhatsApp number registered, OTP sent');

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
 * Verify the OTP sent by Meta. Marks the number as active.
 *
 * Body: { code: "123456" }
 */
router.post('/verify', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code is required' });

  const beauticianId = req.user.id;

  try {
    // Get the pending phone_number_id for this beautician
    const { data: b, error: bErr } = await supabase
      .from('beauticians')
      .select('whatsapp_phone_id, whatsapp_pending_phone')
      .eq('id', beauticianId)
      .single();

    if (bErr || !b?.whatsapp_phone_id) {
      return res.status(400).json({ error: 'No pending WhatsApp registration found' });
    }

    // Verify with Meta
    const metaRes = await fetch(`${GRAPH}/${b.whatsapp_phone_id}/verify_code`, {
      method: 'POST',
      headers: metaHeaders(),
      body: JSON.stringify({ code }),
    });

    const metaData = await metaRes.json();

    if (!metaRes.ok) {
      logger.warn({ metaData, beauticianId }, 'WhatsApp OTP verification failed');
      return res.status(400).json({
        error: metaData?.error?.message || 'Invalid verification code',
      });
    }

    // Mark as connected
    await supabase
      .from('beauticians')
      .update({
        whatsapp_phone: b.whatsapp_pending_phone,
        whatsapp_connected: true,
        whatsapp_registered_at: new Date().toISOString(),
        whatsapp_pending_phone: null,
      })
      .eq('id', beauticianId);

    logger.info({ beauticianId, phone: b.whatsapp_pending_phone }, 'WhatsApp number verified and connected');

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
  const beauticianId = req.user.id;

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
  const beauticianId = req.user.id;

  try {
    const { data: b } = await supabase
      .from('beauticians')
      .select('whatsapp_phone_id')
      .eq('id', beauticianId)
      .single();

    // Delete from Meta if we have a phone_number_id
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

    // Clear WhatsApp data from Supabase regardless
    await supabase
      .from('beauticians')
      .update({
        whatsapp_connected: false,
        whatsapp_phone: null,
        whatsapp_phone_id: null,
        whatsapp_pending_phone: null,
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
