/**
 * SMS Metering Service
 * Tracks SMS usage and charges for surplus messages above the 50/week free limit.
 */

import { supabase } from '../index.js';
import logger from '../lib/logger.js';

const FREE_SMS_LIMIT = 30;
const SURPLUS_RATE_PENCE = 8; // 8p per surplus SMS (4p cost + 4p margin)

/**
 * Get the Monday (start of week) in UTC for a given date.
 * Assumes weeks start on Monday and timestamps are in UTC.
 */
export function getWeekStart(date = new Date()) {
  const d = new Date(date);
  // Convert to UTC to ensure consistent week boundaries
  const utcDate = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  const day = utcDate.getUTCDay();
  const diff = utcDate.getUTCDate() - day + (day === 0 ? -6 : 1); // adjust when day is Sunday
  const monday = new Date(utcDate.setUTCDate(diff));
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString().split('T')[0]; // Return as YYYY-MM-DD
}

/**
 * Track SMS usage before sending.
 * Called BEFORE every SMS is sent.
 *
 * Returns: { allowed: true, isSurplus: boolean, weekUsage: number, freeRemaining: number }
 */
export async function trackSMSUsage(beauticianId) {
  try {
    const weekStart = getWeekStart();

    // Upsert: get or create the usage record for this week
    const { data: existing, error: fetchErr } = await supabase
      .from('sms_usage')
      .select('*')
      .eq('beautician_id', beauticianId)
      .eq('week_start', weekStart)
      .maybeSingle();

    let usage;

    if (!existing) {
      // Create new week record
      const { data: newUsage, error: createErr } = await supabase
        .from('sms_usage')
        .insert({
          beautician_id: beauticianId,
          week_start: weekStart,
          messages_sent: 1,
          surplus_count: 0,
          surplus_total_pence: 0,
        })
        .select()
        .single();

      if (createErr) {
        logger.error({ err: createErr, beauticianId }, 'Failed to create SMS usage record');
        return { allowed: true, isSurplus: false, weekUsage: 1, freeRemaining: FREE_SMS_LIMIT - 1 };
      }

      usage = newUsage;
    } else {
      // Update existing week record
      const newMessageCount = existing.messages_sent + 1;
      const isSurplus = newMessageCount > FREE_SMS_LIMIT;
      const newSurplusCount = isSurplus ? existing.surplus_count + 1 : existing.surplus_count;
      const newSurplusPence = newSurplusCount * SURPLUS_RATE_PENCE;

      const { data: updated, error: updateErr } = await supabase
        .from('sms_usage')
        .update({
          messages_sent: newMessageCount,
          surplus_count: newSurplusCount,
          surplus_total_pence: newSurplusPence,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select()
        .single();

      if (updateErr) {
        logger.error({ err: updateErr, beauticianId }, 'Failed to update SMS usage');
        return { allowed: true, isSurplus: false, weekUsage: existing.messages_sent + 1, freeRemaining: 0 };
      }

      usage = updated;
    }

    const isSurplus = usage.messages_sent > FREE_SMS_LIMIT;
    const freeRemaining = Math.max(0, FREE_SMS_LIMIT - usage.messages_sent);

    logger.info(
      {
        beauticianId,
        weekStart,
        messagesSent: usage.messages_sent,
        isSurplus,
        surplusCount: usage.surplus_count,
        surplusTotalPence: usage.surplus_total_pence,
      },
      'SMS usage tracked'
    );

    return {
      allowed: true,
      isSurplus,
      weekUsage: usage.messages_sent,
      freeRemaining,
      surplusCount: usage.surplus_count,
      surplusTotalPence: usage.surplus_total_pence,
    };
  } catch (err) {
    logger.error({ err, beauticianId }, 'SMS tracking error');
    // Fail open: allow the SMS to send even if tracking fails
    return { allowed: true, isSurplus: false, weekUsage: 0, freeRemaining: FREE_SMS_LIMIT };
  }
}

/**
 * Get current week's SMS usage for display (dashboard, settings).
 */
export async function getSMSUsage(beauticianId) {
  try {
    const weekStart = getWeekStart();

    const { data: usage, error } = await supabase
      .from('sms_usage')
      .select('*')
      .eq('beautician_id', beauticianId)
      .eq('week_start', weekStart)
      .single();

    if (error && error.code !== 'PGRST116') {
      logger.error({ err: error, beauticianId }, 'Failed to fetch SMS usage');
      return null;
    }

    if (!usage) {
      // No usage this week yet
      return {
        weekStart,
        messagesSent: 0,
        freeLimit: FREE_SMS_LIMIT,
        freeRemaining: FREE_SMS_LIMIT,
        surplusCount: 0,
        surplusTotalPence: 0,
        surplusTotalFormatted: '£0.00',
      };
    }

    return {
      weekStart: usage.week_start,
      messagesSent: usage.messages_sent,
      freeLimit: usage.free_limit,
      freeRemaining: Math.max(0, usage.free_limit - usage.messages_sent),
      surplusCount: usage.surplus_count,
      surplusTotalPence: usage.surplus_total_pence,
      surplusTotalFormatted: `£${(usage.surplus_total_pence / 100).toFixed(2)}`,
    };
  } catch (err) {
    logger.error({ err, beauticianId }, 'SMS usage fetch error');
    return null;
  }
}

/**
 * Bill surplus SMS (called by billing cron).
 * Finds all unbilled weeks with surplus > 0 and creates Stripe invoice items.
 * Then marks those weeks as billed.
 */
export async function billSurplusSMS() {
  try {
    // Find all unbilled weeks with surplus
    const { data: unbilledUsage, error } = await supabase
      .from('sms_usage')
      .select('*, beauticians(stripe_customer_id)')
      .eq('billed', false)
      .gt('surplus_total_pence', 0);

    if (error) {
      logger.error({ err: error }, 'Failed to fetch unbilled SMS usage');
      return { processed: 0, failed: 0 };
    }

    if (!unbilledUsage?.length) {
      logger.info('No unbilled SMS usage found');
      return { processed: 0, failed: 0 };
    }

    let processed = 0;
    let failed = 0;

    for (const usage of unbilledUsage) {
      try {
        const beautician = usage.beauticians;
        if (!beautician?.stripe_customer_id) {
          logger.warn({ beauticianId: usage.beautician_id }, 'Beautician has no Stripe customer ID');
          failed++;
          continue;
        }

        // Create Stripe invoice item
        const stripe = await import('stripe').then(m => new m.default(process.env.STRIPE_SECRET_KEY));
        const item = await stripe.invoiceItems.create({
          customer: beautician.stripe_customer_id,
          amount: usage.surplus_total_pence,
          currency: 'gbp',
          description: `SMS surplus charges for week of ${usage.week_start}`,
        });

        // Mark as billed
        await supabase
          .from('sms_usage')
          .update({
            billed: true,
            stripe_invoice_id: item.invoice,
            updated_at: new Date().toISOString(),
          })
          .eq('id', usage.id);

        logger.info(
          {
            beauticianId: usage.beautician_id,
            weekStart: usage.week_start,
            surplusPence: usage.surplus_total_pence,
            stripeInvoiceItem: item.id,
          },
          'SMS surplus billed'
        );

        processed++;
      } catch (err) {
        logger.error({ err, usageId: usage.id }, 'Failed to bill SMS surplus');
        failed++;
      }
    }

    return { processed, failed };
  } catch (err) {
    logger.error({ err }, 'SMS billing error');
    return { processed: 0, failed: 0 };
  }
}
