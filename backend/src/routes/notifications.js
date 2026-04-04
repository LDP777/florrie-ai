import { Router } from 'express';
import { supabase } from '../index.js';
import { requireAuth } from '../middleware/auth.js';
import { processReminders, sendSMS, sendEmail } from '../services/notifications.js';
import { getSMSUsage } from '../services/sms-metering.js';
import logger from '../lib/logger.js';

const router = Router();

/**
 * POST /api/notifications/process-reminders
 * Trigger the 24h reminder cron job.
 * Called by: Supabase Edge Function, external cron, or admin endpoint.
 * Protected by a simple API key (not user auth).
 */
router.post('/process-reminders', async (req, res) => {
  const cronKey = req.headers['x-cron-key'];
  if (cronKey !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Invalid cron key' });
  }

  try {
    const result = await processReminders();
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error({ err }, 'Reminder processing error');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * POST /api/notifications/send-sms
 * Send a manual SMS to a client. Used by campaign and rebook features.
 */
router.post('/send-sms', requireAuth, async (req, res) => {
  try {
    const { client_id, message } = req.body;

    if (!client_id || !message) {
      return res.status(400).json({ error: 'client_id and message required' });
    }

    // Get client phone
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('phone, first_name')
      .eq('id', client_id)
      .eq('beautician_id', req.beautician.id)
      .single();

    if (clientError) {
      logger.error({ err: clientError }, 'Failed to fetch client for SMS');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    if (!client?.phone) {
      return res.status(400).json({ error: 'Client has no phone number' });
    }

    const result = await sendSMS({ to: client.phone, body: message, beauticianId: req.beautician.id });

    // Log the message
    const { error: logError } = await supabase.from('messages').insert({
      beautician_id: req.beautician.id,
      client_id,
      direction: 'outbound',
      channel: 'sms',
      content: message,
      status: result ? 'sent' : 'failed',
    });

    if (logError) {
      logger.warn({ err: logError }, 'Failed to log SMS message');
    }

    res.json({ success: !!result, sid: result?.sid, usageInfo: result?.usageInfo });
  } catch (err) {
    logger.error({ err }, 'Unexpected error sending SMS');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * POST /api/notifications/send-email
 * Send a manual email to a client.
 */
router.post('/send-email', requireAuth, async (req, res) => {
  try {
    const { client_id, subject, html, text } = req.body;

    if (!client_id || !subject) {
      return res.status(400).json({ error: 'client_id and subject required' });
    }

    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('email, first_name')
      .eq('id', client_id)
      .eq('beautician_id', req.beautician.id)
      .single();

    if (clientError) {
      logger.error({ err: clientError }, 'Failed to fetch client for email');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    if (!client?.email) {
      return res.status(400).json({ error: 'Client has no email' });
    }

    const result = await sendEmail({ to: client.email, subject, html, text });

    const { error: logError } = await supabase.from('messages').insert({
      beautician_id: req.beautician.id,
      client_id,
      direction: 'outbound',
      channel: 'email',
      content: text || subject,
      status: result ? 'sent' : 'failed',
    });

    if (logError) {
      logger.warn({ err: logError }, 'Failed to log email message');
    }

    res.json({ success: !!result });
  } catch (err) {
    logger.error({ err }, 'Unexpected error sending email');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * GET /api/notifications/preferences
 * Get the beautician's notification preferences.
 */
router.get('/preferences', requireAuth, (req, res) => {
  res.json({
    notification_prefs: req.beautician.notification_prefs || {},
    client_reminder_prefs: req.beautician.client_reminder_prefs || {},
  });
});

/**
 * PATCH /api/notifications/preferences
 * Update notification preferences.
 */
router.patch('/preferences', requireAuth, async (req, res) => {
  const updates = {};
  if (req.body.notification_prefs) updates.notification_prefs = req.body.notification_prefs;
  if (req.body.client_reminder_prefs) updates.client_reminder_prefs = req.body.client_reminder_prefs;

  const { data, error } = await supabase
    .from('beauticians')
    .update(updates)
    .eq('id', req.beautician.id)
    .select('notification_prefs, client_reminder_prefs')
    .single();

  if (error) {
    logger.error({ err: error }, 'Failed to update notification preferences');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json(data);
});

/**
 * GET /api/sms/usage
 * Get current week's SMS usage stats for the authenticated beautician.
 */
router.get('/sms/usage', requireAuth, async (req, res) => {
  try {
    const usage = await getSMSUsage(req.beautician.id);
    if (!usage) {
      return res.status(500).json({ error: 'Failed to fetch SMS usage' });
    }
    res.json(usage);
  } catch (err) {
    logger.error({ err }, 'SMS usage fetch error');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * GET /api/sms/config
 * Get the SMS configuration for the authenticated beautician.
 */
router.get('/sms/config', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('beauticians')
      .select('sms_originator, sms_enabled, client_reminder_prefs')
      .eq('id', req.beautician.id)
      .maybeSingle();

    if (error) {
      logger.error({ err: error }, 'Failed to fetch SMS config');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    res.json({
      sms_originator: data?.sms_originator || 'Florrie',
      sms_enabled: data?.sms_enabled || false,
      bird_configured: !!process.env.BIRD_API_KEY,
      channel: data?.client_reminder_prefs?.channel || 'whatsapp',
    });
  } catch (err) {
    logger.error({ err }, 'SMS config fetch error');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * PUT /api/sms/config
 * Update SMS configuration for the authenticated beautician.
 * Body: { sms_originator?: string, sms_enabled?: boolean, channel?: string }
 */
router.put('/sms/config', requireAuth, async (req, res) => {
  try {
    const { sms_originator, sms_enabled, channel } = req.body;

    // Validate originator — alphanumeric, max 11 chars (Bird/GSMA limit)
    if (sms_originator !== undefined) {
      if (typeof sms_originator !== 'string' || sms_originator.length > 11 || !/^[a-zA-Z0-9 ]+$/.test(sms_originator)) {
        return res.status(400).json({ error: 'sms_originator must be alphanumeric, max 11 characters' });
      }
    }

    const updates = {};
    if (sms_originator !== undefined) updates.sms_originator = sms_originator.trim();
    if (sms_enabled !== undefined) updates.sms_enabled = Boolean(sms_enabled);

    // If channel is being set, update it inside client_reminder_prefs JSONB
    if (channel !== undefined) {
      const { data: current } = await supabase
        .from('beauticians')
        .select('client_reminder_prefs')
        .eq('id', req.beautician.id)
        .maybeSingle();

      updates.client_reminder_prefs = {
        ...(current?.client_reminder_prefs || {}),
        channel,
      };
    }

    const { data, error } = await supabase
      .from('beauticians')
      .update(updates)
      .eq('id', req.beautician.id)
      .select('sms_originator, sms_enabled, client_reminder_prefs')
      .maybeSingle();

    if (error) {
      logger.error({ err: error }, 'Failed to update SMS config');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    logger.info({ beauticianId: req.beautician.id, updates }, 'SMS config updated');
    res.json({ success: true, ...data });
  } catch (err) {
    logger.error({ err }, 'SMS config update error');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * POST /api/sms/test
 * Send a test SMS to the beautician's own phone to verify Bird is working.
 * Body: { phone: string }
 */
router.post('/sms/test', requireAuth, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone required' });

    if (!process.env.BIRD_API_KEY) {
      return res.status(503).json({ error: 'SMS not configured on this server' });
    }

    const result = await sendSMS({
      to: phone,
      body: `Florrie test message — SMS is working! Sent at ${new Date().toLocaleTimeString('en-GB')}.`,
      beauticianId: req.beautician.id,
    });

    if (!result) {
      return res.status(500).json({ error: 'SMS failed to send — check Bird API key and originator' });
    }

    res.json({ success: true, messageId: result.id });
  } catch (err) {
    logger.error({ err }, 'SMS test error');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

export default router;
