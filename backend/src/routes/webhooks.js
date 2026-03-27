import { Router } from 'express';
import { supabase } from '../index.js';
import { processInboundMessage } from '../services/ai-front-desk.js';

const router = Router();

/**
 * GET /api/webhooks/whatsapp
 * WhatsApp webhook verification (Meta sends a challenge).
 */
router.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('WhatsApp webhook verified');
    return res.status(200).send(challenge);
  }

  res.status(403).send('Verification failed');
});

/**
 * POST /api/webhooks/whatsapp
 * Receives inbound WhatsApp messages from Meta Cloud API.
 * This is where the AI Front Desk starts.
 */
router.post('/whatsapp', async (req, res) => {
  // Always return 200 immediately (Meta retries on failure)
  res.sendStatus(200);

  try {
    const body = req.body;

    if (!body.entry?.[0]?.changes?.[0]?.value?.messages) {
      return; // Not a message event (could be status update)
    }

    const change = body.entry[0].changes[0].value;
    const message = change.messages[0];
    const contact = change.contacts?.[0];
    const phoneNumberId = change.metadata?.phone_number_id;

    // Find the beautician by their WhatsApp phone ID
    const { data: beautician } = await supabase
      .from('beauticians')
      .select('*')
      .eq('whatsapp_phone_id', phoneNumberId)
      .single();

    if (!beautician) {
      console.log(`No beautician found for WhatsApp phone ID: ${phoneNumberId}`);
      return;
    }

    // Find or create client by WhatsApp ID
    const waId = message.from; // WhatsApp sender ID (phone number)
    let { data: client } = await supabase
      .from('clients')
      .select('*')
      .eq('beautician_id', beautician.id)
      .eq('whatsapp_id', waId)
      .single();

    if (!client) {
      // Try matching by phone number
      const { data: phoneClient } = await supabase
        .from('clients')
        .select('*')
        .eq('beautician_id', beautician.id)
        .eq('phone', waId)
        .single();

      if (phoneClient) {
        // Link WhatsApp ID to existing client
        await supabase
          .from('clients')
          .update({ whatsapp_id: waId })
          .eq('id', phoneClient.id);
        client = phoneClient;
      } else {
        // Create new client from WhatsApp contact
        const { data: newClient } = await supabase
          .from('clients')
          .insert({
            beautician_id: beautician.id,
            first_name: contact?.profile?.name || 'Unknown',
            phone: waId,
            whatsapp_id: waId,
            status: 'new'
          })
          .select()
          .single();
        client = newClient;
      }
    }

    // Extract message content
    let messageContent = '';
    let mediaUrl = null;
    let mediaType = null;

    if (message.type === 'text') {
      messageContent = message.text.body;
    } else if (message.type === 'audio') {
      mediaType = 'audio';
      messageContent = '[Voice note]';
      // TODO: Download and transcribe with Whisper
    } else if (message.type === 'image') {
      mediaType = 'image';
      messageContent = message.image?.caption || '[Image]';
    }

    // Store the inbound message
    const { data: storedMessage } = await supabase
      .from('messages')
      .insert({
        beautician_id: beautician.id,
        client_id: client?.id,
        channel: 'whatsapp',
        direction: 'inbound',
        content: messageContent,
        media_url: mediaUrl,
        media_type: mediaType,
        external_message_id: message.id,
        ai_handled: false,
        escalated: false
      })
      .select()
      .single();

    // Pass to AI Front Desk for intent classification + autonomous response
    if (beautician.auto_reply_enabled && messageContent && message.type === 'text') {
      const result = await processInboundMessage(
        storedMessage.id, beautician, client, messageContent
      );
      console.log(`Front Desk: ${result.handled ? 'handled' : 'escalated'} message from ${client?.first_name || waId} (${result.intent})`);
    } else {
      console.log(`Inbound WhatsApp from ${client?.first_name || waId}: "${messageContent}" — auto-reply disabled or non-text`);
    }

  } catch (err) {
    console.error('WhatsApp webhook processing error:', err);
  }
});

/**
 * POST /api/webhooks/stripe
 * Stripe payment webhooks.
 */
router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  // TODO: Verify Stripe signature, handle payment events
  // - payment_intent.succeeded → mark deposit as paid
  // - charge.succeeded → log transaction
  // - account.updated → track onboarding status
  res.sendStatus(200);
});

// Need express imported for raw body parser on stripe route
import express from 'express';

export default router;
