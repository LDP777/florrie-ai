/**
 * Instagram DM Webhook Receiver
 *
 * Receives incoming Instagram DMs via the Instagram Messaging API.
 * Uses the same Meta webhook pattern as WhatsApp.
 * Feeds messages into the existing processInboundMessage() pipeline
 * so AI logic, tone matching, and escalation all work unchanged.
 *
 * Required env vars:
 *   INSTAGRAM_VERIFY_TOKEN - webhook verification token
 *   INSTAGRAM_APP_SECRET   - for HMAC-SHA256 signature verification
 *   INSTAGRAM_PAGE_TOKEN   - page access token for sending replies
 */
import { Router } from 'express';
import crypto from 'crypto';
import { supabase } from '../index.js';
import { processInboundMessage } from '../services/ai-front-desk.js';
import logger from '../lib/logger.js';

const router = Router();

/**
 * GET /api/webhooks/instagram
 * Webhook verification — Meta sends a challenge during setup.
 */
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.INSTAGRAM_VERIFY_TOKEN) {
    logger.info('Instagram webhook verified');
    return res.status(200).send(challenge);
  }

  res.status(403).send('Verification failed');
});

/**
 * POST /api/webhooks/instagram
 * Receives incoming Instagram DMs.
 *
 * Meta sends:
 * {
 *   object: 'instagram',
 *   entry: [{
 *     id: '<page_id>',
 *     time: 1234567890,
 *     messaging: [{
 *       sender: { id: '<sender_igsid>' },
 *       recipient: { id: '<page_igsid>' },
 *       timestamp: 1234567890,
 *       message: { mid: '<msg_id>', text: 'Hello!' }
 *     }]
 *   }]
 * }
 */
router.post('/', async (req, res) => {
  // Verify HMAC-SHA256 signature
  const secret = process.env.INSTAGRAM_APP_SECRET;
  if (secret) {
    const signature = req.headers['x-hub-signature-256'];
    if (!signature) {
      logger.warn('Instagram webhook: missing signature');
      return res.status(403).json({ error: 'Missing signature' });
    }

    try {
      const expected = crypto.createHmac('sha256', secret)
        .update(JSON.stringify(req.body))
        .digest('hex');

      const parts = signature.split('=');
      if (parts.length !== 2 || parts[0] !== 'sha256') {
        return res.status(403).json({ error: 'Invalid signature format' });
      }

      if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[1]))) {
        logger.warn('Instagram webhook: signature mismatch');
        return res.status(403).json({ error: 'Signature verification failed' });
      }
    } catch (err) {
      logger.warn({ err }, 'Instagram webhook: signature error');
      return res.status(403).json({ error: 'Signature verification failed' });
    }
  }

  // Return 200 immediately (Meta retries on failure)
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'instagram') return;

    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        await handleInstagramMessage(event, entry.id);
      }
    }
  } catch (err) {
    logger.error({ err }, 'Instagram webhook processing error');
  }
});

/**
 * Process a single Instagram messaging event.
 */
async function handleInstagramMessage(event, pageId) {
  // Skip echo messages (messages sent by us)
  if (event.message?.is_echo) return;

  // Skip non-message events (read receipts, reactions, etc.)
  if (!event.message?.text) return;

  const senderId = event.sender?.id;
  const messageText = event.message.text;
  const messageId = event.message.mid;
  const timestamp = event.timestamp;

  if (!senderId || !messageText) return;

  // Find beautician by Instagram page ID
  const { data: beautician } = await supabase
    .from('beauticians')
    .select('*')
    .eq('instagram_page_id', pageId)
    .single();

  if (!beautician) {
    // Fallback: try first beautician (single-tenant MVP)
    const { data: fallback } = await supabase
      .from('beauticians')
      .select('*')
      .limit(1)
      .single();

    if (!fallback) {
      logger.warn({ pageId }, 'No beautician found for Instagram page');
      return;
    }

    return processInstagramDM(fallback, senderId, messageText, messageId);
  }

  await processInstagramDM(beautician, senderId, messageText, messageId);
}

/**
 * Find or create client, store message, and pass to AI Front Desk.
 */
async function processInstagramDM(beautician, senderId, messageText, messageId) {
  // Find client by Instagram sender ID
  let { data: client } = await supabase
    .from('clients')
    .select('*')
    .eq('beautician_id', beautician.id)
    .eq('instagram_id', senderId)
    .single();

  if (!client) {
    // Try to get profile info from Instagram
    const name = await fetchInstagramProfile(senderId);

    // Create new client
    const { data: newClient } = await supabase
      .from('clients')
      .insert({
        beautician_id: beautician.id,
        first_name: name || 'Instagram User',
        instagram_id: senderId,
        preferred_channel: 'instagram',
        status: 'new',
      })
      .select()
      .single();

    client = newClient;
    if (newClient) {
      logger.info({ beauticianId: beautician.id, instagramId: senderId }, 'Created new client from Instagram DM');
    }
  }

  // Store the inbound message
  const { data: storedMessage } = await supabase
    .from('messages')
    .insert({
      beautician_id: beautician.id,
      client_id: client?.id,
      channel: 'instagram',
      direction: 'inbound',
      content: messageText,
      external_message_id: messageId,
      ai_handled: false,
      escalated: false,
    })
    .select()
    .single();

  // Pass to AI Front Desk
  if (beautician.auto_reply_enabled && messageText) {
    try {
      const result = await processInboundMessage(
        storedMessage.id, beautician, client, messageText
      );
      logger.info({
        handled: result.handled,
        intent: result.intent,
        client: client?.first_name || senderId,
      }, 'Front Desk processed Instagram DM');
    } catch (err) {
      logger.error({ err, messageId }, 'AI Front Desk failed on Instagram DM');
    }
  }
}

/**
 * Fetch Instagram user profile name.
 * Uses the Instagram Graph API.
 */
async function fetchInstagramProfile(userId) {
  const token = process.env.INSTAGRAM_PAGE_TOKEN;
  if (!token) return null;

  try {
    const res = await fetch(
      `https://graph.instagram.com/v21.0/${userId}?fields=name,username&access_token=${token}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.name || data.username || null;
  } catch {
    return null;
  }
}

export default router;
