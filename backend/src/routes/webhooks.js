import { Router } from 'express';
import crypto from 'crypto';
import { supabase } from '../index.js';
import { processInboundMessage } from '../services/ai-front-desk.js';
import logger from '../lib/logger.js';
import Anthropic from '@anthropic-ai/sdk';

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
    logger.info('WhatsApp webhook verified');
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
  // Verify HMAC-SHA256 signature from Meta (WhatsApp)
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (secret) {
    const signature = req.headers['x-hub-signature-256'];
    if (!signature) {
      logger.warn('WhatsApp webhook: missing x-hub-signature-256 header');
      return res.status(403).json({ error: 'Missing signature' });
    }

    try {
      const expected = crypto.createHmac('sha256', secret)
        .update(JSON.stringify(req.body))
        .digest('hex');

      const signatureParts = signature.split('=');
      if (signatureParts.length !== 2 || signatureParts[0] !== 'sha256') {
        logger.warn('WhatsApp webhook: invalid signature format');
        return res.status(403).json({ error: 'Invalid signature format' });
      }

      const received = signatureParts[1];
      const expectedBuffer = Buffer.from(expected);
      const receivedBuffer = Buffer.from(received);

      if (!crypto.timingSafeEqual(expectedBuffer, receivedBuffer)) {
        logger.warn({ received, expected: expected.substring(0, 8) + '...' }, 'WhatsApp webhook: signature mismatch');
        return res.status(403).json({ error: 'Signature verification failed' });
      }

      logger.debug('WhatsApp webhook signature verified');
    } catch (err) {
      logger.warn({ err }, 'WhatsApp webhook: signature verification error');
      return res.status(403).json({ error: 'Signature verification failed' });
    }
  } else {
    logger.debug('WHATSAPP_APP_SECRET not set, skipping signature verification');
  }

  // Signature verified or skipped — return 200 immediately (Meta retries on failure)
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
      logger.warn({ phoneNumberId }, 'No beautician found for WhatsApp phone ID');
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
      // Download audio from WhatsApp and transcribe
      const mimeType = message.audio?.mime_type;
      messageContent = await transcribeWhatsAppAudio(message.audio?.id, mimeType);
      if (!messageContent) messageContent = '[Voice note — transcription unavailable]';
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
      logger.info({ handled: result.handled, intent: result.intent, client: client?.first_name || waId }, 'Front Desk processed message');
    } else {
      logger.debug({ client: client?.first_name || waId, content: messageContent }, 'Inbound WhatsApp: auto-reply disabled or non-text');
    }

  } catch (err) {
    logger.error({ err }, 'WhatsApp webhook processing error');
  }
});

/**
 * GET /api/webhooks/twilio-sms
 * Twilio webhook verification (Twilio sends a GET request during setup).
 */
router.get('/twilio-sms', (req, res) => {
  // Twilio sends a challenge token during verification
  const token = req.query.token;
  if (token) {
    logger.info('Twilio SMS webhook verification requested');
    return res.status(200).send(token);
  }
  res.status(403).send('Invalid verification');
});

/**
 * POST /api/webhooks/twilio-sms
 * Receives inbound SMS messages from Twilio.
 * Twilio sends: From, To, Body, MessageSid, NumMedia, MediaUrl0, etc.
 */
router.post('/twilio-sms', async (req, res) => {
  // Verify Twilio X-Twilio-Signature
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (authToken) {
    const signature = req.headers['x-twilio-signature'];
    if (!signature) {
      logger.warn('Twilio SMS webhook: missing x-twilio-signature header');
      return res.status(403).json({ error: 'Missing signature' });
    }

    try {
      // Construct URL from request
      const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

      // Build the data string: URL + sorted POST parameters
      let dataString = url;
      const sortedKeys = Object.keys(req.body).sort();
      for (const key of sortedKeys) {
        dataString += key + req.body[key];
      }

      // Compute HMAC-SHA1 and base64 encode
      const expected = crypto.createHmac('sha1', authToken)
        .update(dataString)
        .digest('base64');

      if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        logger.warn({ received: signature.substring(0, 8) + '...', expected: expected.substring(0, 8) + '...' }, 'Twilio SMS webhook: signature mismatch');
        return res.status(403).json({ error: 'Signature verification failed' });
      }

      logger.debug('Twilio SMS webhook signature verified');
    } catch (err) {
      logger.warn({ err }, 'Twilio SMS webhook: signature verification error');
      return res.status(403).json({ error: 'Signature verification failed' });
    }
  } else {
    logger.debug('TWILIO_AUTH_TOKEN not set, skipping signature verification');
  }

  // Signature verified or skipped — return TwiML response (empty — AI handles replies via outbound SMS)
  res.type('text/xml').send('<Response></Response>');

  try {
    const { From, To, Body, MessageSid, NumMedia } = req.body;

    // Validate basic message structure
    if (!MessageSid || !From) {
      logger.warn({ MessageSid, From }, 'Twilio SMS: missing required fields');
      return;
    }

    // Use global TWILIO_PHONE_NUMBER to find beautician (MVP: single-tenant)
    // In future, match To against beautician.twilio_phone_number column
    const beautician = await findBeauticianByTwilioNumber(To || process.env.TWILIO_PHONE_NUMBER);

    if (!beautician) {
      logger.warn({ to: To, twilioNumber: process.env.TWILIO_PHONE_NUMBER }, 'No beautician found for Twilio number');
      return;
    }

    // Find or create client by matching phone number
    let client = await findOrCreateClientBySMS(beautician.id, From);

    if (!client) {
      logger.warn({ beautician_id: beautician.id, from: From }, 'Failed to find or create client for SMS');
      return;
    }

    // Extract message content (SMS doesn't have separate type field)
    let messageContent = Body || '';
    let mediaUrl = null;
    let mediaType = null;

    // Handle media attachments if present
    if (NumMedia && parseInt(NumMedia) > 0) {
      // For MVP, just log the media. In production, download and store
      mediaUrl = req.body[`MediaUrl0`];
      mediaType = req.body[`MediaContentType0`];
      if (mediaUrl) {
        messageContent = `[Media: ${mediaType}] ${messageContent}`.trim();
        logger.debug({ from: From, mediaType, mediaUrl }, 'SMS media attachment');
      }
    }

    // Store the inbound message
    const { data: storedMessage } = await supabase
      .from('messages')
      .insert({
        beautician_id: beautician.id,
        client_id: client?.id,
        channel: 'sms',
        direction: 'inbound',
        content: messageContent,
        media_url: mediaUrl,
        media_type: mediaType,
        external_message_id: MessageSid,
        ai_handled: false,
        escalated: false
      })
      .select()
      .single();

    // Pass to AI Front Desk for intent classification + autonomous response
    if (beautician.auto_reply_enabled && messageContent) {
      const result = await processInboundMessage(
        storedMessage.id, beautician, client, messageContent
      );
      logger.info({ handled: result.handled, intent: result.intent, client: client?.first_name || From }, 'Front Desk processed SMS');
    } else {
      logger.debug({ client: client?.first_name || From, content: messageContent }, 'Inbound SMS: auto-reply disabled');
    }

  } catch (err) {
    logger.error({ err }, 'Twilio SMS webhook processing error');
  }
});

// Note: Stripe webhooks are handled in src/routes/stripe.js (mounted at /api/stripe/webhook)
// This route is kept as a legacy no-op redirect for any old webhook registrations
router.post('/stripe', (req, res) => {
  res.status(301).json({ error: 'Stripe webhooks moved to /api/stripe/webhook' });
});

/**
 * Find beautician by Twilio phone number.
 * First tries to match phoneNumber against beautician columns, then falls back to first beautician.
 */
async function findBeauticianByTwilioNumber(phoneNumber) {
  // First try to match against twilio_phone or phone column
  if (phoneNumber) {
    // Sanitise: strip non-phone characters to prevent .or() filter injection
    const sanitisedPhone = phoneNumber.replace(/[^0-9+\-() ]/g, '').substring(0, 30);
    const { data: beautician } = await supabase
      .from('beauticians')
      .select('*')
      .or(`twilio_phone.eq.${sanitisedPhone},phone.eq.${sanitisedPhone}`)
      .single();

    if (beautician) {
      return beautician;
    }

    logger.warn({ phoneNumber }, 'Twilio number not matched to beautician, falling back to first beautician');
  }

  // Fallback: assume the first beautician in the system (single-tenant MVP)
  const { data: beautician } = await supabase
    .from('beauticians')
    .select('*')
    .limit(1)
    .single();

  return beautician || null;
}

/**
 * Find or create client by SMS phone number.
 * Matches phone number against clients table, or creates a new client.
 */
async function findOrCreateClientBySMS(beauticianId, phoneNumber) {
  try {
    // First, try to find existing client by phone number
    const { data: client } = await supabase
      .from('clients')
      .select('*')
      .eq('beautician_id', beauticianId)
      .eq('phone', phoneNumber)
      .single();

    if (client) {
      return client;
    }

    // Create new client from SMS contact
    const { data: newClient } = await supabase
      .from('clients')
      .insert({
        beautician_id: beauticianId,
        first_name: 'Unknown',
        phone: phoneNumber,
        status: 'new'
      })
      .select()
      .single();

    logger.info({ beautician_id: beauticianId, phone: phoneNumber }, 'Created new client from SMS');
    return newClient;
  } catch (err) {
    logger.error({ err, beautician_id: beauticianId, phone: phoneNumber }, 'Error finding/creating SMS client');
    return null;
  }
}

/**
 * Download a WhatsApp voice note and transcribe it using Claude.
 * Supports multiple audio formats from WhatsApp: ogg, opus, mpeg, amr, aac.
 * WhatsApp media flow: get media URL → download binary → send to Claude.
 *
 * @param {string} mediaId - WhatsApp media ID
 * @param {string} mimeType - MIME type from WhatsApp message payload (e.g., 'audio/ogg')
 * @returns {Promise<string|null>} Transcribed text or null if failed
 */
async function transcribeWhatsAppAudio(mediaId, mimeType) {
  if (!mediaId || !process.env.WHATSAPP_TOKEN) return null;

  try {
    // Determine audio format with fallback
    let audioFormat = 'audio/ogg'; // default fallback

    // Supported WhatsApp audio formats
    const supportedFormats = ['audio/ogg', 'audio/opus', 'audio/mpeg', 'audio/amr', 'audio/aac'];

    if (mimeType && supportedFormats.includes(mimeType)) {
      audioFormat = mimeType;
    } else if (mimeType) {
      // Unknown format — log and use fallback
      logger.warn({ mediaId, receivedMimeType: mimeType }, 'Unsupported audio format, falling back to audio/ogg');
      audioFormat = 'audio/ogg';
    }

    logger.debug({ mediaId, audioFormat }, 'Detected audio format');

    // Step 1: Get the download URL from Meta
    const metaRes = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
      headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}` },
    });
    if (!metaRes.ok) throw new Error('Failed to get media URL');
    const { url: mediaUrl } = await metaRes.json();

    // Step 2: Download the audio binary
    const audioRes = await fetch(mediaUrl, {
      headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}` },
    });
    if (!audioRes.ok) throw new Error('Failed to download audio');
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

    // Step 3: Transcribe using Claude (supports audio input)
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: audioFormat,
              data: audioBuffer.toString('base64'),
            },
          },
          {
            type: 'text',
            text: 'Transcribe this voice note. Return only the transcription text, nothing else. If the audio is unclear, do your best to transcribe what you can hear.',
          },
        ],
      }],
    });

    const transcript = response.content[0]?.text?.trim();
    if (transcript) {
      logger.info({ mediaId, audioFormat, length: transcript.length }, 'Voice note transcribed');
      return transcript;
    }
    return null;
  } catch (err) {
    logger.error({ err, mediaId }, 'Voice note transcription failed');
    return null;
  }
}

export default router;
