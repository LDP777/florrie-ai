/**
 * WhatsApp Metering Service
 *
 * Tracks monthly combined message usage (SMS + WhatsApp) against the
 * 120/month plan limit defined in tiers.js.
 *
 * Overage rate (per tiers.js):
 *   All messages (SMS + WhatsApp): 7p per surplus message
 *
 * Called BEFORE every WhatsApp send. SMS sends continue to use sms-metering.js
 * for weekly tracking but ALSO write into message_usage for combined quota.
 */

import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { getTier } from '../lib/tiers.js';

const OVERAGE_PENCE = 7; // flat rate regardless of channel

/**
 * Returns the first day of the current month as YYYY-MM-DD (UTC).
 */
export function getMonthStart(date = new Date()) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/**
 * Get or create the message_usage row for this beautician + month.
 */
async function getOrCreateUsageRow(beauticianId, month, freeLimit) {
  // Try to fetch existing
  const { data: existing } = await supabase
    .from('message_usage')
    .select('*')
    .eq('beautician_id', beauticianId)
    .eq('month', month)
    .single();

  if (existing) return existing;

  // Create new row
  const { data: created, error } = await supabase
    .from('message_usage')
    .insert({
      beautician_id: beauticianId,
      month,
      free_limit: freeLimit,
      sms_sent: 0,
      whatsapp_sent: 0,
    })
    .select()
    .single();

  if (error) throw error;
  return created;
}

/**
 * Check if a beautician can send a WhatsApp message this month.
 * Call BEFORE sending.
 *
 * Returns:
 *   { allowed: true,  isOverage: false, used: number, limit: number, remaining: number }
 *   { allowed: true,  isOverage: true,  used: number, limit: number, overageRate: 5 }
 *   { allowed: false, reason: 'no_whatsapp_number' }
 */
export async function checkWhatsAppQuota(beauticianId) {
  try {
    // Get beautician plan
    const { data: b, error: bErr } = await supabase
      .from('beauticians')
      .select('plan, whatsapp_phone_id, whatsapp_connected')
      .eq('id', beauticianId)
      .single();

    if (bErr || !b) {
      logger.error({ beauticianId, err: bErr }, 'checkWhatsAppQuota: beautician not found');
      return { allowed: false, reason: 'beautician_not_found' };
    }

    if (!b.whatsapp_connected || !b.whatsapp_phone_id) {
      return { allowed: false, reason: 'no_whatsapp_number' };
    }

    const tier = getTier(b.plan);
    const freeLimit = tier.messages_per_month || 120;
    const month = getMonthStart();
    const usage = await getOrCreateUsageRow(beauticianId, month, freeLimit);
    const totalUsed = usage.sms_sent + usage.whatsapp_sent;

    if (totalUsed < freeLimit) {
      return {
        allowed: true,
        isOverage: false,
        used: totalUsed,
        limit: freeLimit,
        remaining: freeLimit - totalUsed,
      };
    }

    // Over the free limit — still allowed (we bill for overages)
    return {
      allowed: true,
      isOverage: true,
      used: totalUsed,
      limit: freeLimit,
      remaining: 0,
      overageRate: OVERAGE_PENCE,
    };
  } catch (err) {
    logger.error({ err, beauticianId }, 'checkWhatsAppQuota error');
    // Fail open — don't block sends on metering errors
    return { allowed: true, isOverage: false, error: true };
  }
}

/**
 * Record a sent WhatsApp message. Call AFTER a successful send.
 *
 * Returns the updated usage row.
 */
export async function trackWhatsAppMessage(beauticianId) {
  try {
    const { data: b } = await supabase
      .from('beauticians')
      .select('plan')
      .eq('id', beauticianId)
      .single();

    const tier = getTier(b?.plan);
    const freeLimit = tier.messages_per_month || 120;
    const month = getMonthStart();
    const usage = await getOrCreateUsageRow(beauticianId, month, freeLimit);
    const totalUsed = usage.sms_sent + usage.whatsapp_sent;
    const isOverage = totalUsed >= freeLimit;

    const updates = {
      whatsapp_sent: usage.whatsapp_sent + 1,
      updated_at: new Date().toISOString(),
    };

    if (isOverage) {
      updates.overage_wa_count = usage.overage_wa_count + 1;
      updates.overage_wa_pence = usage.overage_wa_pence + OVERAGE_PENCE;
      updates.overage_total_pence = usage.overage_total_pence + OVERAGE_PENCE;
    }

    const { data: updated, error } = await supabase
      .from('message_usage')
      .update(updates)
      .eq('id', usage.id)
      .select()
      .single();

    if (error) throw error;

    logger.info(
      { beauticianId, month, waTotal: updated.whatsapp_sent, isOverage },
      'WhatsApp message tracked'
    );

    return updated;
  } catch (err) {
    logger.error({ err, beauticianId }, 'trackWhatsAppMessage error — usage not recorded');
    return null;
  }
}

/**
 * Record a sent SMS message into the monthly combined quota.
 * Call this alongside (not instead of) the existing sms-metering.js weekly tracking.
 */
export async function trackSmsInMonthlyQuota(beauticianId) {
  try {
    const { data: b } = await supabase
      .from('beauticians')
      .select('plan')
      .eq('id', beauticianId)
      .single();

    const tier = getTier(b?.plan);
    const freeLimit = tier.messages_per_month || 120;
    const month = getMonthStart();
    const usage = await getOrCreateUsageRow(beauticianId, month, freeLimit);
    const totalUsed = usage.sms_sent + usage.whatsapp_sent;
    const isOverage = totalUsed >= freeLimit;

    const updates = {
      sms_sent: usage.sms_sent + 1,
      updated_at: new Date().toISOString(),
    };

    if (isOverage) {
      updates.overage_sms_count = usage.overage_sms_count + 1;
      updates.overage_sms_pence = usage.overage_sms_pence + OVERAGE_PENCE;
      updates.overage_total_pence = usage.overage_total_pence + OVERAGE_PENCE;
    }

    await supabase
      .from('message_usage')
      .update(updates)
      .eq('id', usage.id);
  } catch (err) {
    logger.error({ err, beauticianId }, 'trackSmsInMonthlyQuota error');
  }
}

/**
 * Get monthly usage summary for a beautician.
 * Used by the frontend usage display.
 */
export async function getMonthlyUsage(beauticianId) {
  try {
    const month = getMonthStart();
    const { data, error } = await supabase
      .from('message_usage')
      .select('*')
      .eq('beautician_id', beauticianId)
      .eq('month', month)
      .single();

    if (error && error.code !== 'PGRST116') throw error; // PGRST116 = not found

    if (!data) {
      const { data: b } = await supabase
        .from('beauticians')
        .select('plan')
        .eq('id', beauticianId)
        .single();
      const tier = getTier(b?.plan);
      return {
        sms_sent: 0,
        whatsapp_sent: 0,
        total_sent: 0,
        free_limit: tier.messages_per_month || 120,
        overage_total_pence: 0,
        month,
      };
    }

    return {
      ...data,
      total_sent: data.sms_sent + data.whatsapp_sent,
    };
  } catch (err) {
    logger.error({ err, beauticianId }, 'getMonthlyUsage error');
    return null;
  }
}
