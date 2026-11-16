/**
 * Setup routes, powers the Setup Hub page.
 *
 *   GET /api/setup/status
 *     -> one JSON snapshot of what the beautician has and hasn't switched on.
 *
 * Every check fails soft and independently: a broken table or missing column
 * never reports a missing item as a known fact: failed counts return null.
 * Counts use { count: 'exact', head: true } so no rows cross the wire.
 */
import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';
import { salonDepositIsConfigured } from '../lib/booking-rules.js';
import { validWorkingHours, setupChecklist, replySettings, validateConnectionProof } from '../lib/setup-readiness.js';

const router = Router();
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

/** Run a bounded count query; an unavailable count is unknown. */
async function safeCount(label, build) {
  try {
    const { count, error } = await build().abortSignal(AbortSignal.timeout(6000));
    if (error) throw error;
    return Number.isInteger(count) ? count : null;
  } catch (err) {
    logger.warn({ err, label }, 'setup.status count failed');
    return null;
  }
}

router.get('/status', requireAuth, async (req, res) => {
  try {
    const b = req.beautician;
    const bId = b.id;
    // Start all evidence reads together. A slow table cannot add sequential
    // six-second waits to a page used during setup on a phone.
    const menuRead = (async () => {
      let menu = null, menuError = null;
      try {
        const result = await supabase.from('treatments')
          .select('id,price_cents,duration_minutes,requires_consultation,consultation_form_id')
          .eq('beautician_id', bId).eq('is_active', true).eq('booking_enabled', true)
          .limit(1001).abortSignal(AbortSignal.timeout(6000));
        menu = result.data; menuError = result.error;
      } catch (error) { menuError = error; }
      return { menu, menuError };
    })();
    const receiptRead = (async () => {
      let receipt = null;
      try {
        const { data, error } = await supabase.from('messages').select('channel,content,created_at')
          .eq('beautician_id', bId).eq('direction', 'inbound').in('channel', ['instagram', 'whatsapp'])
          .gte('created_at', new Date(Date.now() - 7 * 86400000).toISOString()).ilike('content', 'FLORRIE-%')
          .order('created_at', { ascending: false }).limit(20).abortSignal(AbortSignal.timeout(6000));
        if (!error && Array.isArray(data)) receipt = data.find(row => /^FLORRIE-[A-F0-9]{12}$/i.test(row.content || '')
          && (row.channel === 'instagram' ? b.instagram_page_id && b.instagram_page_token : b.whatsapp_connected)
          && Date.parse(row.created_at) >= (Date.parse(row.channel === 'instagram' ? b.instagram_connected_at : b.whatsapp_registered_at) || 0)) || false;
      } catch { /* Unknown is not a failed connection. */ }
      return receipt;
    })();

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

    const [{ menu, menuError }, receipt] = await Promise.all([menuRead, receiptRead]);
    const menuKnown = !menuError && Array.isArray(menu) && menu.length <= 1000;
    const bookable = menuKnown ? menu.filter(t => Number.isSafeInteger(t.price_cents) && t.price_cents > 0
      && Number.isInteger(t.duration_minutes) && t.duration_minutes > 0) : null;
    const paySettings = b.payment_settings || {};

    const status = {
      business: {
        name: !!(b.business_name && String(b.business_name).trim()),
        hours: validWorkingHours(b.working_hours),
        booking_slug: !!b.booking_slug,
        slug: b.booking_slug || null,
      },
      services: {
        treatments_count: treatmentsCount,
        has_prices: pricedCount == null ? null : pricedCount > 0,
        bookable_count: bookable?.length ?? null,
        incomplete_count: menuKnown ? menu.length - bookable.length : null,
        missing_forms: menuKnown ? menu.filter(t => t.requires_consultation && !t.consultation_form_id).length : null,
        // Any treatment with its own deposit amount/percent set, or the
        // salon-level switch on WITH a readable amount behind it.
        //
        // This has to be the same question lib/booking-rules.js asks when it
        // prices a booking, or the checklist says "deposits: not done" while
        // her booking page charges one, which is the shape the bug had: the
        // checklist read require_deposit and the booking page read only
        // deposit_amount, so the two disagreed on every fresh account.
        // salonDepositIsConfigured is the single answer both now use.
        deposits: salonDepositIsConfigured(paySettings) || (depositTreatments == null ? null : depositTreatments > 0),
      },
      channels: {
        whatsapp: !!(b.whatsapp_phone_id || b.twilio_wa_sender),
        instagram: !!(b.instagram_page_id && b.instagram_page_token),
        sms: !!b.sms_enabled,
        auto_reply: !!b.auto_reply_enabled,
        test_receipt: receipt ? { channel: receipt.channel, received_at: receipt.created_at } : receipt,
      },
      clients: {
        count: clientsCount,
        // Any client at all. This was `>= 5`, so a salon whose first four
        // clients booked themselves in read as "not done" on the only
        // progress bar it has, and the nudge never went away.
        imported: clientsCount == null ? null : clientsCount >= 1,
      },
      protection: {
        forms_built: formsBuilt,
        forms_attached: formsAttached,
        patch_tests: patchTests,
      },
      money: {
        stripe: b.stripe_onboarding_complete === true,
      },
      replies: replySettings(b),
      checked_at: new Date().toISOString(),
    };
    status.readiness = setupChecklist(status, b);
    res.json(status);
  } catch (err) {
    logger.error({ err }, 'setup.status threw');
    res.status(500).json({ error: 'Failed to load setup status' });
  }
});

// Read evidence only. Never send a message, enable AI, or return client details.
router.get('/channel-proof', requireAuth, async (req, res) => {
  const input = validateConnectionProof(req.query);
  if (!input) return res.status(400).json({ error: 'Start a fresh connection check in Florrie.' });
  try {
    const { data, error } = await supabase.from('messages').select('created_at')
      .eq('beautician_id', req.beautician.id).eq('channel', input.channel).eq('direction', 'inbound')
      .gte('created_at', input.since).ilike('content', input.code)
      .order('created_at', { ascending: false }).limit(1).abortSignal(AbortSignal.timeout(6000));
    if (error || !Array.isArray(data)) throw error || new Error('Unreadable evidence');
    res.json({ received: data.length > 0, received_at: data[0]?.created_at || null });
  } catch (err) {
    logger.warn({ err, beauticianId: req.beautician.id }, 'setup channel proof unavailable');
    res.status(503).json({ error: 'Could not check Inbox. Try again.' });
  }
});

export default router;
