import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';

const router = Router();

/**
 * GET /api/push/vapid-key
 * Returns the public VAPID key so the frontend can subscribe.
 */
router.get('/vapid-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(503).json({ error: 'Push not configured' });
  res.json({ publicKey: key });
});

/**
 * POST /api/push/subscribe
 * Store a push subscription for the current beautician.
 */
router.post('/subscribe', requireAuth, async (req, res) => {
  const { subscription } = req.body;

  if (!subscription?.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription object' });
  }

  // Upsert: replace existing sub with same endpoint
  const { error } = await supabase
    .from('push_subscriptions')
    .upsert({
      beautician_id: req.beautician.id,
      subscription,
      endpoint: subscription.endpoint,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'endpoint' });

  if (error) {
    logger.error({ err: error }, 'Failed to store push subscription');
    return res.status(500).json({ error: 'Something went wrong' });
  }

  res.json({ success: true });
});

/**
 * POST /api/push/native-token
 * Store a native (APNs/FCM) device token for the current beautician.
 * Upserts on token so re-registration just refreshes last_seen_at.
 */
router.post('/native-token', requireAuth, async (req, res) => {
  const { token, platform } = req.body;

  if (!token || typeof token !== 'string' || token.length > 512) {
    return res.status(400).json({ error: 'token is required' });
  }

  const { error } = await supabase
    .from('native_push_tokens')
    .upsert({
      beautician_id: req.beautician.id,
      token,
      platform: platform === 'android' ? 'android' : 'ios',
      last_seen_at: new Date().toISOString(),
    }, { onConflict: 'token' });

  if (error) {
    logger.error({ err: error }, 'Failed to store native push token');
    return res.status(500).json({ error: 'Something went wrong' });
  }

  res.json({ success: true });
});

/**
 * DELETE /api/push/subscribe
 * Remove a push subscription (when user disables notifications).
 */
router.delete('/subscribe', requireAuth, async (req, res) => {
  const { endpoint } = req.body;

  if (!endpoint) {
    return res.status(400).json({ error: 'endpoint is required' });
  }

  await supabase
    .from('push_subscriptions')
    .delete()
    .eq('beautician_id', req.beautician.id)
    .eq('endpoint', endpoint);

  res.json({ success: true });
});

export default router;
