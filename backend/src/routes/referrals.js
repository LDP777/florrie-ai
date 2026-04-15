import { Router } from 'express';
import crypto from 'crypto';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import logger from '../lib/logger.js';
import { referralConfigSchema } from '../lib/schemas.js';

const router = Router();

/**
 * GET /api/referrals
 * List all referrals for the current beautician.
 */
router.get('/', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('referrals')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    logger.error({ err: error }, 'Failed to fetch referrals');
    return res.status(500).json({ error: 'Something went wrong' });
  }

  res.json({ referrals: data });
});

/**
 * GET /api/referrals/stats
 * Aggregated referral stats for the dashboard.
 */
router.get('/stats', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('referrals')
    .select('status, reward_value_cents')
    .eq('beautician_id', req.beautician.id);

  if (error) {
    return res.status(500).json({ error: 'Something went wrong' });
  }

  const stats = {
    total: data?.length || 0,
    pending: data?.filter(r => r.status === 'pending').length || 0,
    completed: data?.filter(r => ['completed', 'rewarded'].includes(r.status)).length || 0,
    totalRewardsCents: data?.filter(r => r.status === 'rewarded').reduce((s, r) => s + (r.reward_value_cents || 0), 0) || 0,
  };

  res.json({ stats });
});

/**
 * GET /api/referrals/config
 * Get the beautician's referral program settings.
 */
router.get('/config', requireAuth, async (req, res) => {
  const { data } = await supabase
    .from('beauticians')
    .select('referral_enabled, referral_reward_type, referral_reward_value_cents, referral_code, booking_slug')
    .eq('id', req.beautician.id)
    .single();

  // Auto-generate referral code if missing
  if (data && !data.referral_code) {
    const code = generateCode(req.beautician.first_name || req.beautician.business_name || 'florrie');
    await supabase.from('beauticians').update({ referral_code: code }).eq('id', req.beautician.id);
    data.referral_code = code;
  }

  res.json({
    config: data,
    shareLink: data?.booking_slug
      ? `https://florrie.ai/book/${data.booking_slug}?ref=${data.referral_code}`
      : null,
  });
});

/**
 * PATCH /api/referrals/config
 * Update referral program settings.
 */
router.patch('/config', requireAuth, validate(referralConfigSchema), async (req, res) => {
  const updates = { ...req.body };

  const { data, error } = await supabase
    .from('beauticians')
    .update(updates)
    .eq('id', req.beautician.id)
    .select('referral_enabled, referral_reward_type, referral_reward_value_cents, referral_code')
    .single();

  if (error) {
    return res.status(500).json({ error: 'Failed to update config' });
  }

  res.json({ config: data });
});

/**
 * POST /api/referrals/track
 * Called when a booking is made via a referral link.
 * Public endpoint — called from the booking page.
 */
router.post('/track', async (req, res) => {
  const { referral_code, client_name, client_id, appointment_id, beautician_id } = req.body;

  if (!referral_code || !beautician_id) {
    return res.status(400).json({ error: 'referral_code and beautician_id required' });
  }

  // Find the beautician and validate the code
  const { data: beautician } = await supabase
    .from('beauticians')
    .select('id, referral_enabled, referral_reward_type, referral_reward_value_cents')
    .eq('id', beautician_id)
    .eq('referral_code', referral_code)
    .single();

  if (!beautician || !beautician.referral_enabled) {
    return res.status(404).json({ error: 'Invalid referral code' });
  }

  // Find who shared this code (the referrer) — look at recent clients who used this link
  // For now, the referral_code is beautician-level, so we track the referred client
  const { data: referral, error } = await supabase
    .from('referrals')
    .insert({
      beautician_id: beautician.id,
      referred_client_id: client_id || null,
      referred_name: client_name || null,
      referral_code,
      status: 'booked',
      reward_type: beautician.referral_reward_type,
      reward_value_cents: beautician.referral_reward_value_cents,
      appointment_id: appointment_id || null,
      source: 'link',
    })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Failed to track referral');
    return res.status(500).json({ error: 'Something went wrong' });
  }

  res.status(201).json({ referral });
});

/**
 * POST /api/referrals/:id/complete
 * Mark a referral as completed (after appointment done) and issue reward.
 */
router.post('/:id/complete', requireAuth, async (req, res) => {
  const { data: referral } = await supabase
    .from('referrals')
    .select('*')
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .single();

  if (!referral || referral.status === 'rewarded') {
    return res.status(404).json({ error: 'Referral not found or already rewarded' });
  }

  const updates = {
    status: 'rewarded',
    reward_issued_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('referrals')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: 'Failed to complete referral' });
  }

  // Log AI action
  await supabase.from('ai_actions').insert({
    beautician_id: req.beautician.id,
    action_type: 'referral_rewarded',
    digital_employee: 'marketing',
    summary: `Referral reward issued: £${(referral.reward_value_cents / 100).toFixed(2)} discount for ${referral.referred_name || 'client'}`,
    details: { referral_id: data.id, reward_type: data.reward_type, reward_value_cents: data.reward_value_cents },
    confidence: 1.0,
    autonomous: true,
    outcome: 'success',
  });

  res.json({ referral: data });
});

function generateCode(name) {
  const clean = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  const suffix = crypto.randomBytes(3).toString('hex').slice(0, 4);
  return `${clean}-${suffix}`;
}

export default router;
