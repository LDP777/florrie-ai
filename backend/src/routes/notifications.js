import { Router } from 'express';
import { supabase } from '../index.js';
import { requireAuth } from '../middleware/auth.js';
import { processReminders, sendSMS, sendEmail } from '../services/notifications.js';

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
    console.error('Reminder processing error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/notifications/send-sms
 * Send a manual SMS to a client. Used by campaign and rebook features.
 */
router.post('/send-sms', requireAuth, async (req, res) => {
  const { client_id, message } = req.body;

  if (!client_id || !message) {
    return res.status(400).json({ error: 'client_id and message required' });
  }

  // Get client phone
  const { data: client } = await supabase
    .from('clients')
    .select('phone, first_name')
    .eq('id', client_id)
    .eq('beautician_id', req.beautician.id)
    .single();

  if (!client?.phone) {
    return res.status(400).json({ error: 'Client has no phone number' });
  }

  const result = await sendSMS({ to: client.phone, body: message });

  // Log the message
  await supabase.from('messages').insert({
    beautician_id: req.beautician.id,
    client_id,
    direction: 'outbound',
    channel: 'sms',
    content: message,
    status: result ? 'sent' : 'failed',
  });

  res.json({ success: !!result, sid: result?.sid });
});

/**
 * POST /api/notifications/send-email
 * Send a manual email to a client.
 */
router.post('/send-email', requireAuth, async (req, res) => {
  const { client_id, subject, html, text } = req.body;

  if (!client_id || !subject) {
    return res.status(400).json({ error: 'client_id and subject required' });
  }

  const { data: client } = await supabase
    .from('clients')
    .select('email, first_name')
    .eq('id', client_id)
    .eq('beautician_id', req.beautician.id)
    .single();

  if (!client?.email) {
    return res.status(400).json({ error: 'Client has no email' });
  }

  const result = await sendEmail({ to: client.email, subject, html, text });

  await supabase.from('messages').insert({
    beautician_id: req.beautician.id,
    client_id,
    direction: 'outbound',
    channel: 'email',
    content: text || subject,
    status: result ? 'sent' : 'failed',
  });

  res.json({ success: !!result });
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

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

export default router;
