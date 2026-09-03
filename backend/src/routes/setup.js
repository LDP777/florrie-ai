/**
 * Setup routes, powers the Setup Hub page.
 *
 *   GET /api/setup/status
 *     -> one JSON snapshot of what the beautician has and hasn't switched on.
 *
 * Every check fails soft and independently: a broken table or missing column
 * never takes the whole status down, it just reports false/0 for that check.
 * Counts use { count: 'exact', head: true } so no rows cross the wire.
 */
import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';
import { salonDepositIsConfigured } from '../lib/booking-rules.js';

const router = Router();

/** Run a count query, return 0 on any failure. */
async function safeCount(label, build) {
  try {
    const { count, error } = await build();
    if (error) throw error;
    return count || 0;
  } catch (err) {
    logger.warn({ err, label }, 'setup.status count failed');
    return 0;
  }
}

/** Working hours count as set when at least one day has a start time. */
function hasWorkingHours(hours) {
  if (!hours || typeof hours !== 'object') return false;
  try {
    return Object.values(hours).some(
      (d) => d && typeof d === 'object' && (d.start || d.open)
    );
  } catch {
    return false;
  }
}

router.get('/status', requireAuth, async (req, res) => {
  try {
    const b = req.beautician;
    const bId = b.id;

    const [
      treatmentsCount,
      pricedCount,
      depositTreatments,
      clientsCount,
      formsBuilt,
      formsAttached,
      patchTests,
    ] = await Promise.all([
      safeCount('treatments', () =>
        supabase
          .from('treatments')
          .select('id', { count: 'exact', head: true })
          .eq('beautician_id', bId)
      ),
      safeCount('treatments_priced', () =>
        supabase
          .from('treatments')
          .select('id', { count: 'exact', head: true })
          .eq('beautician_id', bId)
          .gt('price_cents', 0)
      ),
      safeCount('treatments_deposit', () =>
        supabase
          .from('treatments')
          .select('id', { count: 'exact', head: true })
          .eq('beautician_id', bId)
          .or('deposit_cents.gt.0,deposit_percent.gt.0')
      ),
      safeCount('clients', () =>
        supabase
          .from('clients')
          .select('id', { count: 'exact', head: true })
          .eq('beautician_id', bId)
      ),
      safeCount('consultation_forms', () =>
        supabase
          .from('consultation_forms')
          .select('id', { count: 'exact', head: true })
          .eq('beautician_id', bId)
      ),
      safeCount('treatments_with_form', () =>
        supabase
          .from('treatments')
          .select('id', { count: 'exact', head: true })
          .eq('beautician_id', bId)
          .not('consultation_form_id', 'is', null)
      ),
      safeCount('patch_tests', () =>
        supabase
          .from('patch_tests')
          .select('id', { count: 'exact', head: true })
          .eq('beautician_id', bId)
      ),
    ]);

    const paySettings = b.payment_settings || {};

    res.json({
      business: {
        name: !!(b.business_name && String(b.business_name).trim()),
        hours: hasWorkingHours(b.working_hours),
        booking_slug: !!b.booking_slug,
        slug: b.booking_slug || null,
      },
      services: {
        treatments_count: treatmentsCount,
        has_prices: pricedCount > 0,
        // Any treatment with its own deposit amount/percent set, or the
        // salon-level switch on WITH a readable amount behind it.
        //
        // This has to be the same question lib/booking-rules.js asks when it
        // prices a booking, or the checklist says "deposits: not done" while
        // her booking page charges one, which is the shape the bug had: the
        // checklist read require_deposit and the booking page read only
        // deposit_amount, so the two disagreed on every fresh account.
        // salonDepositIsConfigured is the single answer both now use.
        deposits: depositTreatments > 0 || salonDepositIsConfigured(paySettings),
      },
      channels: {
        whatsapp: !!(b.whatsapp_phone_id || b.twilio_wa_sender),
        instagram: !!(b.instagram_page_id && b.instagram_page_token),
        sms: !!b.sms_enabled,
        auto_reply: !!b.auto_reply_enabled,
      },
      clients: {
        count: clientsCount,
        // Any client at all. This was `>= 5`, so a salon whose first four
        // clients booked themselves in read as "not done" on the only
        // progress bar it has, and the nudge never went away.
        imported: clientsCount >= 1,
      },
      protection: {
        forms_built: formsBuilt,
        forms_attached: formsAttached,
        patch_tests: patchTests,
      },
      money: {
        stripe: !!(b.stripe_onboarding_complete || b.stripe_account_id),
      },
    });
  } catch (err) {
    logger.error({ err }, 'setup.status threw');
    res.status(500).json({ error: 'Failed to load setup status' });
  }
});

export default router;
