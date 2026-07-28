import { Router } from 'express';
import { safeReply } from '../lib/reply-claims-guard.js';
import { getFreeSlots } from '../lib/free-slots.js';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { learnFromCorrection } from '../services/ai-front-desk.js';
import { sendSMS, sendInstagramDM, sendWhatsAppText } from '../services/notifications.js';
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

  // GUARD AT THE SEND BOUNDARY, not just where the draft was written.
  //
  // Two reasons generation-time checking is not enough. Every draft already
  // sitting in the database predates the guard, so tapping Send on one would
  // put the old unchecked text on the wire. And the diary moves: a draft
  // written at 9am offering 16:30 is wrong by 2pm if someone books it.
  //
  // Only Florrie's own words are checked. If Ellie edited the reply those are
  // HER words about HER diary, and second-guessing her would be both wrong and
  // infuriating.
  let finalResponse = response || message.ai_response;

  if (action === 'send_as_is' || !response) {
    let allowedTimes = [];
    try {
      const slots = await getFreeSlots(req.beautician.id, {
        workingHours: req.beautician.working_hours,
        timezone: req.beautician.timezone || 'Europe/London',
      });
      allowedTimes = slots.map(s => s.time);
    } catch (err) {
      // Could not read the diary, so nothing can be verified. safeReply with an
      // empty allow-list refuses every time, which is the safe direction.
      logger.warn({ err }, 'escalation send: diary read failed, refusing any named time');
    }

    const guarded = safeReply(finalResponse, { allowedTimes });
    if (guarded.rejected) {
      logger.warn({
        beauticianId: req.beautician.id,
        messageId: message.id,
        reason: guarded.reason,
        offending: guarded.offending,
      }, 'BLOCKED an unverifiable claim at the send boundary');
      return res.status(409).json({
        error: 'blocked_unverified_claim',
        reason: guarded.reason,
        offending: guarded.offending,
        message: guarded.reason === 'claimed a booking change that never happened'
          ? 'This reply says the booking has been changed, but Florrie cannot move bookings. Edit it before sending.'
          : 'This reply names a time that is not free in your diary any more. Edit it before sending.',
        suggestion: guarded.text,
      });
    }
    finalResponse = guarded.text;
  }

  // If they edited the response, learn from the correction
  if (action === 'send_edited' && message.ai_response && response !== message.ai_response) {
    await learnFromCorrection(req.beautician.id, message.ai_response, response);
  }

  // Fetch client for sending
  const { data: client } = await supabase
    .from('clients')
    .select('*')
    .eq('id', message.client_id)
    .single();

  // Send on the SAME channel the client messaged on, not always SMS. A regular who
  // messaged on Instagram should get her reply on Instagram, not a stray text (and
  // may have no phone at all). Mirrors the front desk's own channel routing.
  const channel = message.channel || client?.preferred_channel || 'sms';
  let sent = false;
  let sentChannel = channel;
  try {
    if (channel === 'instagram' && client?.instagram_id) {
      sent = !!(await sendInstagramDM({ recipientId: client.instagram_id, text: finalResponse, pageToken: req.beautician.instagram_page_token }));
    } else if (channel === 'whatsapp' && req.beautician.whatsapp_phone_id && client?.whatsapp_id) {
      sent = !!(await sendWhatsAppText({ to: client.whatsapp_id, body: finalResponse, beauticianId: req.beautician.id }));
    } else if (client?.phone) {
      sentChannel = 'sms';
      sent = !!(await sendSMS({ to: client.phone, body: finalResponse, beauticianId: req.beautician.id, messageType: 'ai_reply' }));
    }
  } catch (err) {
    logger.error({ err, channel }, 'Escalation send error');
  }

  // Only record it as sent and resolved if it genuinely went out, so the inbox
  // never shows a reply the client never received.
  if (!sent) {
    logger.warn({ clientId: client?.id, channel: sentChannel }, 'Escalation send failed; leaving unresolved for retry');
    return res.status(502).json({ error: `Could not send on ${sentChannel}. Please try again.` });
  }

  await supabase.from('messages').update({
    resolved: true,
    resolved_at: new Date().toISOString(),
    ai_response: finalResponse
  }).eq('id', message.id);

  await supabase.from('messages').insert({
    beautician_id: req.beautician.id,
    client_id: message.client_id,
    channel: sentChannel,
    direction: 'outbound',
    content: finalResponse,
    ai_handled: action === 'send_as_is',
    digital_employee: 'front_desk',
  });

  logger.info({ clientId: client?.id, channel: sentChannel }, 'Escalation response sent');
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
