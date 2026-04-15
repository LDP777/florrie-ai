import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { learnFromCorrection } from '../services/ai-front-desk.js';
import { sendSMS } from '../services/notifications.js';
import logger from '../lib/logger.js';

const router = Router();

/**
 * GET /api/escalations
 * Messages that need the beautician's attention.
 */
router.get('/', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('messages')
    .select('*, clients(first_name, last_name, phone)')
    .eq('beautician_id', req.beautician.id)
    .eq('escalated', true)
    .eq('resolved', false)
    .order('created_at', { ascending: false })
    .limit(30);

  if (error) {
    logger.error({ err: error }, 'Failed to fetch escalations');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ escalations: data });
});

/**
 * POST /api/escalations/:messageId/resolve
 * Beautician approves or edits the AI's suggested response, then sends it.
 * If edited, the correction is fed back into the tone model.
 */
router.post('/:messageId/resolve', requireAuth, async (req, res) => {
  const { response, action } = req.body;
  // action: 'send_as_is', 'send_edited', 'dismiss'

  const { data: message, error } = await supabase
    .from('messages')
    .select('*')
    .eq('id', req.params.messageId)
    .eq('beautician_id', req.beautician.id)
    .single();

  if (error || !message) return res.status(404).json({ error: 'Message not found' });

  if (action === 'dismiss') {
    await supabase.from('messages').update({
      resolved: true,
      resolved_at: new Date().toISOString()
    }).eq('id', message.id);

    return res.json({ success: true });
  }

  const finalResponse = response || message.ai_response;

  // If they edited the response, learn from the correction
  if (action === 'send_edited' && message.ai_response && response !== message.ai_response) {
    await learnFromCorrection(req.beautician.id, message.ai_response, response);
  }

  // Mark as resolved
  await supabase.from('messages').update({
    resolved: true,
    resolved_at: new Date().toISOString(),
    ai_response: finalResponse
  }).eq('id', message.id);

  // Fetch client for sending
  const { data: client } = await supabase
    .from('clients')
    .select('*')
    .eq('id', message.client_id)
    .single();

  // Send the response via SMS (using Bird API)
  if (client?.phone) {
    try {
      const result = await sendSMS({ to: client.phone, body: finalResponse, beauticianId: req.beautician.id });
      if (result) {
        logger.info({ clientId: client.id }, 'Escalation response sent via SMS');
      } else {
        logger.warn({ clientId: client.id }, 'SMS send failed');
      }
    } catch (err) {
      logger.error({ err }, 'Escalation SMS send error');
    }
  }

  // Store outbound message record
  await supabase.from('messages').insert({
    beautician_id: req.beautician.id,
    client_id: message.client_id,
    channel: 'sms',
    direction: 'outbound',
    content: finalResponse,
    ai_handled: action === 'send_as_is',
    digital_employee: 'front_desk',
  });

  res.json({ success: true, sent: finalResponse });
});

/**
 * GET /api/escalations/count
 * Badge count for unresolved escalations.
 */
router.get('/count', requireAuth, async (req, res) => {
  const { count, error } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('beautician_id', req.beautician.id)
    .eq('escalated', true)
    .eq('resolved', false);

  if (error) {
    logger.error({ err: error }, 'Failed to count escalations');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ count: count || 0 });
});

export default router;
