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
      .select('subscription_plan, whatsapp_phone_id, whatsapp_connected')
      .eq('id', beauticianId)
      .single();

    if (bErr || !b) {
      logger.error({ beauticianId, err: bErr }, 'checkWhatsAppQuota: lookup failed — allowing send');
      return { allowed: true, error: true };
    }

    if (!b.whatsapp_connected || !b.whatsapp_phone_id) {
      return { allowed: false, reason: 'no_whatsapp_number' };
    }

    const tier = getTier(b.subscription_plan);
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
 * Atomically increment the monthly combined-quota row for one channel.
 *
 * Preferred path is the Postgres function increment_message_usage (migration
 * 064), which does the +1 and overage maths in a single atomic UPDATE so
 * concurrent sends never lose a count. If that function is not present yet
 * (migration not applied), we fall back to the old non-atomic read-modify-write
 * so sends keep being metered.
 */
async function incrementMonthlyUsage(beauticianId, channel) {
  const { data: b } = await supabase
    .from('beauticians')
    .select('subscription_plan')
    .eq('id', beauticianId)
    .single();
  const tier = getTier(b?.subscription_plan);
  const freeLimit = tier.messages_per_month || 120;
  const month = getMonthStart();

  // Atomic path.
  const { data, error } = await supabase.rpc('increment_message_usage', {
    p_beautician_id: beauticianId,
    p_month: month,
    p_free_limit: freeLimit,
    p_channel: channel,
    p_overage_pence: OVERAGE_PENCE,
  });
  if (!error && data) {
    return Array.isArray(data) ? data[0] : data;
  }
  if (error) {
    logger.warn({ err: error, beauticianId }, 'increment_message_usage RPC unavailable; using non-atomic fallback');
  }

  // Fallback: non-atomic read-modify-write (used only until migration 064 lands).
  const usage = await getOrCreateUsageRow(beauticianId, month, freeLimit);
  const totalUsed = usage.sms_sent + usage.whatsapp_sent;
  const isOverage = totalUsed >= freeLimit;
  const field = channel === 'whatsapp' ? 'whatsapp_sent' : 'sms_sent';
  const overageCountField = channel === 'whatsapp' ? 'overage_wa_count' : 'overage_sms_count';
  const overagePenceField = channel === 'whatsapp' ? 'overage_wa_pence' : 'overage_sms_pence';
  const updates = { [field]: (usage[field] || 0) + 1, updated_at: new Date().toISOString() };
  if (isOverage) {
    updates[overageCountField] = (usage[overageCountField] || 0) + 1;
    updates[overagePenceField] = (usage[overagePenceField] || 0) + OVERAGE_PENCE;
    updates.overage_total_pence = (usage.overage_total_pence || 0) + OVERAGE_PENCE;
  }
  const { data: updated, error: updErr } = await supabase
    .from('message_usage')
    .update(updates)
    .eq('id', usage.id)
    .select()
    .single();
  if (updErr) throw updErr;
  return updated;
}

/**
 * Record a sent WhatsApp message. Call AFTER a successful send.
 * Returns the updated usage row (or null on error).
 */
export async function trackWhatsAppMessage(beauticianId) {
  try {
    const updated = await incrementMonthlyUsage(beauticianId, 'whatsapp');
    logger.info({ beauticianId, waTotal: updated?.whatsapp_sent }, 'WhatsApp message tracked');
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
    await incrementMonthlyUsage(beauticianId, 'sms');
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
        .select('subscription_plan')
        .eq('id', beauticianId)
        .single();
      const tier = getTier(b?.subscription_plan);
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


/**
 * Mark a message_usage row billed (idempotency guard for billMonthlySurplus).
 */
async function markUsageBilled(rowId, stripeInvoiceId) {
  await supabase
    .from('message_usage')
    .update({ billed: true, stripe_invoice_id: stripeInvoiceId, updated_at: new Date().toISOString() })
    .eq('id', rowId);
}

/**
 * Bill surplus over the 120/month COMBINED (SMS + WhatsApp) allowance.
 *
 * Source of truth: message_usage.overage_total_pence — accumulated live by
 * trackWhatsAppMessage + trackSmsInMonthlyQuota as messages are sent. Only
 * COMPLETED months (month < current month) are billed, so a month's total is
 * final before we charge.
 *
 * Idempotent two ways: only rows with billed=false are fetched, and each Stripe
 * call carries an idempotencyKey keyed to the row id (so a double-run before the
 * billed flag flips still can't double-charge). After charging, the row flips to
 * billed=true.
 *
 * Stripe: creates a pending invoiceItem on the customer; Stripe auto-attaches it to
 * their next subscription invoice and charges the saved card. Trial / no-Stripe
 * customers are flagged billed with nothing charged (overage is free on trial).
 *
 * Replaces the old weekly sms_usage billing (billSurplusSMS) — do not run both.
 */
export async function billMonthlySurplus() {
  const currentMonth = getMonthStart();
  try {
    const { data: rows, error } = await supabase
      .from('message_usage')
      .select('*, beauticians(stripe_customer_id, subscription_plan)')
      .eq('billed', false)
      .gt('overage_total_pence', 0)
      .lt('month', currentMonth);

    if (error) {
      logger.error({ err: error }, 'billMonthlySurplus: fetch failed');
      return { processed: 0, charged: 0, skipped: 0, failed: 0 };
    }
    if (!rows?.length) {
      logger.info('billMonthlySurplus: nothing to bill');
      return { processed: 0, charged: 0, skipped: 0, failed: 0 };
    }

    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    let charged = 0, skipped = 0, failed = 0;
    for (const row of rows) {
      const b = row.beauticians;
      const amount = row.overage_total_pence;

      // Optimistic claim: flip billed=true ONLY if it is still false. If no row
      // comes back, a concurrent run (or a previous boot) already claimed it, so
      // we skip. This is the inter-instance lock that stops double-billing when
      // the cron and a startup run overlap.
      const { data: claimed, error: claimErr } = await supabase
        .from('message_usage')
        .update({ billed: true, updated_at: new Date().toISOString() })
        .eq('id', row.id)
        .eq('billed', false)
        .select('id');
      if (claimErr || !claimed?.length) { skipped++; continue; }

      try {
        // Trial or no Stripe customer: overage is free — row already flagged billed.
        if (!b?.stripe_customer_id || !b?.subscription_plan || b.subscription_plan === 'trial') {
          skipped++;
          continue;
        }

        const count = (row.overage_sms_count || 0) + (row.overage_wa_count || 0);
        const label = new Date(row.month).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

        const item = await stripe.invoiceItems.create(
          {
            customer: b.stripe_customer_id,
            amount,
            currency: 'gbp',
            description: `Florrie message overage for ${label} (${count} over your 120 allowance)`,
          },
          { idempotencyKey: `msgusage_${row.id}` }
        );

        await markUsageBilled(row.id, item.invoice || item.id);
        charged++;
        logger.info(
          { beauticianId: row.beautician_id, month: row.month, amount, count, invoiceItem: item.id },
          'Monthly message surplus billed'
        );
      } catch (err) {
        // Charge failed after we claimed the row: release the claim so a later
        // run retries it. The Stripe idempotencyKey still guards against a
        // double-charge if the create actually succeeded before throwing.
        await supabase
          .from('message_usage')
          .update({ billed: false, updated_at: new Date().toISOString() })
          .eq('id', row.id)
          .then(() => {}, () => {});
        logger.error({ err, rowId: row.id }, 'billMonthlySurplus: row failed, released claim for retry');
        failed++;
      }
    }

    logger.info({ processed: rows.length, charged, skipped, failed }, 'billMonthlySurplus done');
    return { processed: rows.length, charged, skipped, failed };
  } catch (err) {
    logger.error({ err }, 'billMonthlySurplus error');
    return { processed: 0, charged: 0, skipped: 0, failed: 0 };
  }
}
