import { Router } from 'express';
import crypto from 'crypto';
import { supabase } from '../config.js';
import { processInboundMessage } from '../services/ai-front-desk.js';
import { applyWhatsAppStatuses } from '../services/delivery-receipts.js';
import { pushMessagesWaiting } from '../services/push-notifications.js';
import { classifyInboundMessage, looksLikeKnownClient } from '../lib/junk-classifier.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';
import { getAppSecret, getWhatsAppVerifyToken } from '../lib/env.js';
import { autoUnarchiveClient } from '../lib/client-archive.js';
import Anthropic from '@anthropic-ai/sdk';
import { authorship } from '../lib/authorship.js';
import { hasColumn } from '../lib/schema-probe.js';
import { isSharedSmsNumber } from '../services/notifications.js';

const router = Router();

// In-memory ring buffer of recent WhatsApp webhook hits. Used for live
// diagnosis when inbound messages aren't arriving. Stores at most 20 entries.
// Single-instance only — fine since Florrie API is single-replica today.
const webhookHits = [];
function recordWebhookHit(entry) {
  webhookHits.unshift({ at: new Date().toISOString(), ...entry });
  if (webhookHits.length > 20) webhookHits.length = 20;
}

/**
 * Mark a stored message as junk.
 *
 * Kept separate from the insert on purpose: is_junk / junk_reason arrive in
 * migration 016, which is applied by hand, so a missing column must cost us a
 * label and not the message itself. The suppression decisions are already made
 * in memory by the time this runs. Best effort, logged, never thrown.
 */
async function flagMessageAsJunk(messageId, reason) {
  if (!messageId) return;
  const { error } = await supabase
    .from('messages')
    .update({ is_junk: true, junk_reason: reason })
    .eq('id', messageId);
  if (error) {
    logger.warn({ err: error, messageId }, 'Could not set messages.is_junk (migration 016 applied?)');
  }
}

// Constant-time token comparison. Avoids leaking length/match position via timing.
// Length-mismatched inputs are hashed to equal-length buffers so timingSafeEqual
// never throws on differing lengths.
function safeTokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) {
    return false;
  }
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

router.get('/whatsapp/_debug-hits', requireAuth, (req, res) => {
  // Behind beautician JWT so any logged-in beautician can debug their own
  // webhook delivery. Cheap to expose — no sensitive payload in the buffer.
  res.json({ hits: webhookHits, count: webhookHits.length });
});

/**
 * GET /api/webhooks/whatsapp
 * WhatsApp webhook verification (Meta sends a challenge).
 */
router.get('/whatsapp', (req, res) => {
  const verifyToken = getWhatsAppVerifyToken();
  if (!verifyToken) {
    // Without a configured token, both sides would be undefined and any caller
    // could re-verify the webhook. Refuse rather than compare undefined.
    logger.error('WHATSAPP_VERIFY_TOKEN not set; refusing webhook verification');
    return res.status(503).send('Webhook verification not configured');
  }

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === verifyToken) {
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
  // Record the hit immediately so we know Meta is calling us, regardless of
  // what happens next (signature failures, parsing errors, etc.)
  const bodyShape = (() => {
    try {
      const b = req.body;
      const change = b?.entry?.[0]?.changes?.[0]?.value;
      return {
        has_entry: !!b?.entry,
        has_messages: !!change?.messages,
        has_statuses: !!change?.statuses,
        phone_number_id: change?.metadata?.phone_number_id || null,
        from: change?.messages?.[0]?.from || null,
        text_preview: change?.messages?.[0]?.text?.body?.slice(0, 60) || null,
      };
    } catch (e) {
      return { parse_error: e.message };
    }
  })();
  const hitBase = {
    method: 'POST',
    signature_header_present: !!req.headers['x-hub-signature-256'],
    body_size: JSON.stringify(req.body || {}).length,
    body_shape: bodyShape,
  };

  // Verify HMAC-SHA256 signature from Meta (WhatsApp)
  const secret = getAppSecret();
  if (secret) {
    const signature = req.headers['x-hub-signature-256'];
    if (!signature) {
      logger.warn('WhatsApp webhook: missing x-hub-signature-256 header');
      recordWebhookHit({ ...hitBase, result: '403_no_signature' });
      return res.status(403).json({ error: 'Missing signature' });
    }

    try {
      // Verify over the raw request bytes (captured in index.js), not a re-serialised
      // body — JSON.stringify can differ from what Meta actually signed.
      const expected = crypto.createHmac('sha256', secret)
        .update(req.rawBody || Buffer.from(JSON.stringify(req.body)))
        .digest('hex');

      const signatureParts = signature.split('=');
      if (signatureParts.length !== 2 || signatureParts[0] !== 'sha256') {
        logger.warn('WhatsApp webhook: invalid signature format');
        recordWebhookHit({ ...hitBase, result: '403_bad_signature_format' });
        return res.status(403).json({ error: 'Invalid signature format' });
      }

      const received = signatureParts[1];
      const expectedBuffer = Buffer.from(expected);
      const receivedBuffer = Buffer.from(received);

      if (expectedBuffer.length !== receivedBuffer.length ||
          !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)) {
        logger.warn({ received: received.slice(0, 8), expected: expected.slice(0, 8) }, 'WhatsApp webhook: signature mismatch');
        recordWebhookHit({
          ...hitBase,
          result: '403_signature_mismatch',
          received_prefix: received.slice(0, 12),
          expected_prefix: expected.slice(0, 12),
        });
        return res.status(403).json({ error: 'Signature verification failed' });
      }

      logger.debug('WhatsApp webhook signature verified');
    } catch (err) {
      logger.warn({ err }, 'WhatsApp webhook: signature verification error');
      recordWebhookHit({ ...hitBase, result: '403_signature_error', error: err.message });
      return res.status(403).json({ error: 'Signature verification failed' });
    }
  } else if (process.env.WEBHOOK_STRICT === 'true') {
    // Fail closed: without the app secret we cannot verify the sender, so an
    // unsigned payload could spoof client messages and drive outbound sends.
    // Opt-in via WEBHOOK_STRICT=true so enabling it can't accidentally break a
    // live tenant whose secret isn't set yet. Turn it on once the secret is in.
    logger.error('WhatsApp webhook: WHATSAPP_APP_SECRET not configured; rejecting unsigned payload (WEBHOOK_STRICT)');
    recordWebhookHit({ ...hitBase, result: '503_no_secret' });
    return res.status(503).json({ error: 'Webhook not configured' });
  } else {
    logger.warn('WHATSAPP_APP_SECRET not set; processing unsigned (set the secret + WEBHOOK_STRICT=true to fail closed)');
  }

  recordWebhookHit({ ...hitBase, result: '200_accepted' });

  // Signature verified or skipped — return 200 immediately (Meta retries on failure)
  res.sendStatus(200);

  try {
    const body = req.body;

    // Delivery receipts. Meta sends one for every message — sent, delivered,
    // read, failed — and this line used to throw all of them away, which is
    // why send_status, delivered_at and read_at have been columns with no
    // values in them since the schema was written. "Was the confirmation
    // actually delivered?" was unanswerable, and it is the question that
    // matters most: a client who never gets one turns up on the wrong day.
    const statuses = body.entry?.[0]?.changes?.[0]?.value?.statuses;
    if (Array.isArray(statuses) && statuses.length) {
      await applyWhatsAppStatuses(statuses);
      return;
    }

    if (!body.entry?.[0]?.changes?.[0]?.value?.messages) {
      return; // Neither a message nor a receipt
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
      // Try matching by phone number. Clients added by SMS/Bird or by hand may
      // be stored in E.164 ('+447...'), while WhatsApp delivers bare digits
      // ('447...'). Try both forms so a person Ellie already knows gets linked
      // to their existing record instead of spawning a duplicate 'Unknown'
      // thread. (Mirrors the Twilio WhatsApp path's dual-format match.)
      let phoneClient = null;
      for (const candidate of [waId, `+${waId}`]) {
        const { data: match } = await supabase
          .from('clients')
          .select('*')
          .eq('beautician_id', beautician.id)
          .eq('phone', candidate)
          .maybeSingle();
        if (match) { phoneClient = match; break; }
      }

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

    // An archived client messaging in means they are back: quietly clear the
    // archive flag so their thread and profile reappear. Fail-soft inside the
    // helper - message handling never depends on it.
    if (client?.id) autoUnarchiveClient(client.id, 'whatsapp_message').catch(() => {});

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
      try {
        messageContent = await transcribeWhatsAppAudio(message.audio?.id, mimeType);
      } catch (transcriptErr) {
        logger.warn({ err: transcriptErr, mediaId: message.audio?.id }, 'Voice note transcription failed');
      }
      if (!messageContent) messageContent = '[Voice note, transcription unavailable]';
    } else if (message.type === 'image') {
      mediaType = 'image';
      messageContent = message.image?.caption || '[Photo]';
    } else if (message.type === 'interactive') {
      const i = message.interactive || {};
      messageContent = i.button_reply?.title || i.list_reply?.title || i.list_reply?.description || '[Reply]';
    } else if (message.type === 'button') {
      messageContent = message.button?.text || message.button?.payload || '[Reply]';
    } else if (message.type === 'reaction') {
      messageContent = message.reaction?.emoji ? `Reacted ${message.reaction.emoji}` : '[Reaction]';
    } else if (message.type === 'video') {
      mediaType = 'video';
      messageContent = message.video?.caption || '[Video]';
    } else if (message.type === 'document') {
      mediaType = 'document';
      messageContent = message.document?.caption || message.document?.filename || '[Document]';
    } else if (message.type === 'sticker') {
      mediaType = 'sticker';
      messageContent = '[Sticker]';
    } else if (message.type === 'location') {
      messageContent = '[Location shared]';
    } else if (message.type === 'contacts') {
      messageContent = '[Contact shared]';
    }

    // Never store a blank inbound - the thread must always show something, so a
    // client's reply (a button tap, a reaction, any type) is never lost.
    if (!messageContent || !String(messageContent).trim()) {
      messageContent = message.text?.body || '[Message]';
    }

    // Same junk test as Instagram. She publishes her wa.me link in the
    // Instagram redirect reply, so the cold pitches that used to land in her
    // DMs now follow her onto WhatsApp. A flagged message is stored and stays
    // findable, but it does not escalate, does not buzz her phone, and does
    // not spend one of her metered monthly messages on an auto-reply.
    const junk = classifyInboundMessage(messageContent, {
      isKnownClient: looksLikeKnownClient(client, { channel: 'whatsapp' }),
    });

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
        ...authorship('client'),
        escalated: false
      })
      .select()
      .single();

    if (junk.isJunk) {
      await flagMessageAsJunk(storedMessage?.id, junk.reason);
      logger.info({ beauticianId: beautician.id, from: waId, reason: junk.reason, signals: junk.signals }, 'WhatsApp message classified as junk: stored, not escalated, no push, no reply');
      return;
    }

    // Non-invasive nudge: "You have WhatsApp messages waiting for you"
    // (throttled to at most one per 15 min inside the helper). Fire-and-forget.
    pushMessagesWaiting(beautician.id, 'whatsapp').catch(() => {});

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
  } else if (process.env.WEBHOOK_STRICT === 'true') {
    logger.error('Twilio SMS webhook: TWILIO_AUTH_TOKEN not configured; rejecting unsigned payload (WEBHOOK_STRICT)');
    return res.status(503).json({ error: 'Webhook not configured' });
  } else {
    logger.warn('TWILIO_AUTH_TOKEN not set; processing unsigned (set the token + WEBHOOK_STRICT=true to fail closed)');
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

    // Route strictly on the number the client actually texted. No env-level
    // default: TWILIO_PHONE_NUMBER is the shared platform number, so using it
    // as a stand-in re-creates the guess we are trying to remove.
    const beautician = await findBeauticianByTwilioNumber(To);

    if (!beautician) {
      // Dropped on purpose. See findBeauticianByTwilioNumber for why.
      logger.error(
        { to: To, from: From },
        'Inbound SMS could not be routed to a salon; dropping rather than guessing a tenant. Set beauticians.twilio_phone to the recipient number to route it.'
      );
      return;
    }

    // Find or create client by matching phone number
    let client;
    try {
      client = await findOrCreateClientBySMS(beautician.id, From);
    } catch (clientErr) {
      logger.error({ err: clientErr, beautician_id: beautician.id, from: From }, 'Error finding/creating SMS client');
      return;
    }

    if (!client) {
      logger.warn({ beautician_id: beautician.id, from: From }, 'No client found or created for SMS');
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
        ...authorship('client'),
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

/**
 * Find the beautician whose number an inbound SMS was sent TO.
 * Matches twilio_phone, then phone. Returns null when nothing matches.
 *
 * There is deliberately NO "first beautician in the table" fallback. Every
 * salon sends from the same shared long code, so a guess is not a guess about
 * a rare edge case, it is a coin flip on every unmatched message. Getting it
 * wrong puts a stranger's client into another salon's inbox, and with
 * auto_reply_enabled on Florrie then answers that client in the wrong salon's
 * voice, using the wrong salon's prices and diary.
 *
 * Dropping is the safer failure. A message that lands nowhere is recoverable:
 * the sender still has it in their own SMS thread, and once the routing config
 * is fixed they can be answered. A message that lands in the wrong salon's
 * inbox cannot be un-seen, and it is a data leak between two paying customers.
 */
async function findBeauticianByTwilioNumber(phoneNumber) {
  if (!phoneNumber) return null;

  // Sanitise: strip non-phone characters to prevent .or() filter injection
  const sanitisedPhone = String(phoneNumber).replace(/[^0-9+\-() ]/g, '').substring(0, 30);
  if (!sanitisedPhone) return null;

  const { data: beautician, error } = await supabase
    .from('beauticians')
    .select('*')
    .or(`twilio_phone.eq.${sanitisedPhone},phone.eq.${sanitisedPhone}`)
    .maybeSingle();

  if (error) {
    // maybeSingle() also errors when more than one row matches. Two tenants
    // claiming the same number is a config error, and picking one of them is
    // precisely the leak this function exists to prevent, so we drop instead.
    logger.error({ err: error, phoneNumber: sanitisedPhone }, 'Twilio SMS: beautician lookup failed or was ambiguous, cannot route');
    return null;
  }

  return beautician || null;
}

/**
 * Find or create client by SMS phone number.
 * Matches phone number against clients table, or creates a new client.
 */
async function findOrCreateClientBySMS(beauticianId, phoneNumber) {
  // First, try to find existing client by phone number
  const { data: client } = await supabase
    .from('clients')
    .select('*')
    .eq('beautician_id', beauticianId)
    .eq('phone', phoneNumber)
    .single();

  if (client) {
    // A text from an archived client = they are back; clear the flag (fail-soft).
    autoUnarchiveClient(client.id, 'sms_message').catch(() => {});
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
}

/**
 * GET /api/webhooks/bird-sms
 * Verification endpoint (Bird/MessageBird may issue a challenge during setup).
 */
router.get('/bird-sms', (req, res) => {
  const token = req.query.token;
  const challenge = req.query.challenge;
  if (challenge) {
    logger.info('Bird SMS webhook challenge received');
    return res.status(200).send(challenge);
  }
  if (token) {
    return res.status(200).send(token);
  }
  res.status(200).send('ok');
});

/**
 * POST /api/webhooks/bird-sms
 * Receives inbound SMS from Bird (MessageBird).
 *
 * Auth: Bird's v2 signatures use JWT (Messagebird-Signature-JWT header), and the
 * classic API uses HMAC. Because body-parser consumes the raw body before this
 * handler runs, we use a query-param token as the primary auth — set
 * BIRD_WEBHOOK_TOKEN in env and include it in the webhook URL configured in the
 * Bird dashboard: https://api.florrie.ai/api/webhooks/bird-sms?token=YOUR_TOKEN
 *
 * Handles two payload shapes:
 *  - Classic MessageBird: { id, originator, recipient, payload/body, ... }
 *  - Bird v2 Channels API: { type: 'sms.inbound' | 'channels.message.created',
 *                            payload: { message: { body }, sender, receiver } }
 */
router.post('/bird-sms', async (req, res) => {
  const expectedToken = process.env.BIRD_WEBHOOK_TOKEN;
  if (expectedToken) {
    // Prefer the header (not logged, not in URLs/access logs); fall back to the
    // query param for backward-compat with the dashboard-configured webhook URL.
    const receivedToken = req.headers['x-webhook-token']
      || req.headers['x-bird-token']
      || req.query.token
      || '';
    if (!safeTokenEqual(receivedToken, expectedToken)) {
      logger.warn('Bird SMS webhook: invalid or missing token');
      return res.status(403).json({ error: 'Forbidden' });
    }
  } else if (process.env.WEBHOOK_STRICT === 'true') {
    // Fail closed: an unauthenticated inbound endpoint would let anyone inject
    // fake client SMS. Opt-in via WEBHOOK_STRICT=true so it can't break a live
    // tenant before the token is set; turn it on once BIRD_WEBHOOK_TOKEN is in.
    logger.error('Bird SMS webhook: BIRD_WEBHOOK_TOKEN not set, refusing request (WEBHOOK_STRICT)');
    return res.status(503).json({ error: 'Webhook auth not configured' });
  } else {
    logger.warn('BIRD_WEBHOOK_TOKEN not set; processing unauthenticated (set the token + WEBHOOK_STRICT=true to fail closed)');
  }

  // ACK early — Bird retries on non-2xx
  res.sendStatus(200);

  try {
    const body = req.body || {};

    // Normalise payload across classic + v2 shapes
    let from;
    let to;
    let messageBody;
    let externalId;

    if (body.type && body.payload) {
      // v2 Channels API format
      const p = body.payload;
      from = p.sender?.phoneNumber
        || p.sender?.identifierValue
        || p.from
        || p.message?.from;
      to = p.receiver?.phoneNumber
        || p.receiver?.identifierValue
        || p.to
        || p.message?.to;
      messageBody = p.message?.body || p.message?.text || p.body || '';
      externalId = body.id || p.id || p.message?.id;
    } else {
      // Classic MessageBird SMS inbound
      from = body.originator || body.from || body.msisdn;
      to = body.recipient || body.to;
      messageBody = body.payload || body.body || body.message || '';
      externalId = body.id || body.messageId;
    }

    if (!from || !messageBody) {
      logger.warn({ bodyKeys: Object.keys(body) }, 'Bird SMS: missing from or body');
      return;
    }

    // Normalise phone numbers to E.164-ish (ensure leading +)
    const fromPhone = normalisePhoneNumber(from);
    const toPhone = to ? normalisePhoneNumber(to) : null;

    // Route strictly on the number the client actually texted. No env-level
    // default: BIRD_ORIGINATOR is the shared platform long code, so using it as
    // a stand-in re-creates the guess we are trying to remove.
    const beautician = await findBeauticianByBirdNumber(toPhone);

    if (!beautician) {
      // Dropped on purpose. See findBeauticianByBirdNumber for why.
      logger.error(
        { to: toPhone, from: fromPhone },
        'Inbound Bird SMS could not be routed to a salon; dropping rather than guessing a tenant. Set beauticians.sms_inbound_number to that salon own Bird number to route it (the shared platform long code is never routable).'
      );
      return;
    }

    // Find or create client
    let client;
    try {
      client = await findOrCreateClientBySMS(beautician.id, fromPhone);
    } catch (clientErr) {
      logger.error({ err: clientErr, beautician_id: beautician.id, from: fromPhone }, 'Error finding/creating Bird SMS client');
      return;
    }

    if (!client) {
      logger.warn({ beautician_id: beautician.id, from: fromPhone }, 'No client found or created for Bird SMS');
      return;
    }

    // Store inbound message
    const { data: storedMessage, error: storeErr } = await supabase
      .from('messages')
      .insert({
        beautician_id: beautician.id,
        client_id: client.id,
        channel: 'sms',
        direction: 'inbound',
        content: messageBody,
        external_message_id: externalId,
        ai_handled: false,
        ...authorship('client'),
        escalated: false,
      })
      .select()
      .single();

    if (storeErr) {
      logger.error({ err: storeErr, beautician_id: beautician.id }, 'Failed to store inbound Bird SMS');
      return;
    }

    // Route to AI Front Desk
    if (beautician.auto_reply_enabled && messageBody) {
      const result = await processInboundMessage(
        storedMessage.id, beautician, client, messageBody
      );
      logger.info({ handled: result.handled, intent: result.intent, client: client?.first_name || fromPhone }, 'Front Desk processed Bird SMS');
    } else {
      logger.debug({ client: client?.first_name || fromPhone, content: messageBody }, 'Inbound Bird SMS: auto-reply disabled');
    }
  } catch (err) {
    logger.error({ err }, 'Bird SMS webhook processing error');
  }
});

/**
 * Normalise an inbound phone number string to E.164-ish format.
 * Bird sometimes sends without the leading +; add one if missing.
 */
function normalisePhoneNumber(raw) {
  if (!raw) return raw;
  const s = raw.toString().trim();
  if (s.startsWith('+')) return s;
  // Drop any leading zeroes (common in classic MessageBird payloads that strip +)
  return `+${s.replace(/^0+/, '')}`;
}

/**
 * Every spelling of one number that could be sitting in the column, so a row
 * saved as "07700 900123" still matches an inbound "+447700900123". Matching on
 * more spellings never widens WHO can be matched: the exactly-one rule below
 * still applies, and two rows spelling the same number differently stay
 * ambiguous and stay dropped.
 */

/**
 * The last nine digits of a phone number, or '' if there are not nine.
 *
 * Nine because a UK mobile written +447700900123 and 07700900123 differ only in
 * the country prefix and both end in the same nine. It is also how this
 * codebase already matches a CLIENT's phone, so routing a salon uses the same
 * rule rather than a second, weaker one. Fewer than nine digits is not a phone
 * number, which is what stops the text value this column defaults to
 * ('Florrie') from matching anything at all.
 */
function lastNineDigits(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : '';
}

// A routing lookup reads salon rows, not client rows, so it is bounded by how
// many salons exist rather than by traffic. The cap is a backstop: past it the
// lookup would be reading one page of a larger table and could miss a match it
// should have found, so it sits far above any plausible tenant count.
const MAX_ROUTING_CANDIDATES = 1000;

/**
 * Look up exactly one beautician by a routing column, or nobody.
 *
 * `.limit(2)` and an explicit count, NOT `.maybeSingle()`. maybeSingle turns
 * "two salons claim this number" into a PostgREST error, which reads at the
 * call site like any other query failure; the count says out loud which of the
 * two happened, and the number gets logged either way.
 */
async function beauticianByRoutingColumn(column, phoneNumber) {
  // Two reads on purpose. The first pulls only the id and the routing column,
  // because the match cannot be expressed as a filter (see below) and pulling
  // whole salon rows to throw nearly all of them away would be wasteful. The
  // second fetches the one row that matched.
  const { data, error } = await supabase
    .from('beauticians')
    .select(`id, ${column}`)
    .limit(MAX_ROUTING_CANDIDATES);

  if (error) {
    logger.error({ err: error, column, phoneNumber }, 'Bird SMS: routing lookup failed, cannot route');
    return null;
  }

  // Compared in JS on the last nine digits, not with an .in() over spellings.
  // A salon types her number into a box: '07700 900123', '+44 7700 900123',
  // '(07700) 900123' are all the same number and an exact match catches none of
  // them. The last-nine rule is already how this codebase matches a client's
  // phone (+44 versus a leading 0), so routing uses the same rule rather than a
  // second, weaker one.
  const target = lastNineDigits(phoneNumber);
  if (!target) return null;

  const rows = (data || []).filter(r => lastNineDigits(r?.[column]) === target);

  if (rows.length > 1) {
    // The exact failure this split exists to prevent. Never pick one.
    logger.error(
      { column, phoneNumber, matches: rows.length, beauticianIds: rows.map(r => r.id) },
      'Bird SMS: more than one salon claims this number, dropping rather than guessing a tenant'
    );
    return null;
  }
  if (rows.length === 0) return null;

  const { data: full, error: fullErr } = await supabase
    .from('beauticians')
    .select('*')
    .eq('id', rows[0].id)
    .maybeSingle();

  if (fullErr) {
    logger.error({ err: fullErr, column, phoneNumber }, 'Bird SMS: matched a salon but could not read her row');
    return null;
  }
  return full || null;
}

/**
 * Find the beautician whose Bird virtual mobile number an inbound SMS was sent
 * TO. Returns null on no match, on an ambiguous match, and on the shared long
 * code, all of which mean the same thing: we do not know whose client this is.
 *
 * There is deliberately NO "first beautician in the table" fallback here.
 * See findBeauticianByTwilioNumber above for the full reasoning: a message in
 * the wrong salon's inbox is worse than a message lost, because the sender
 * still holds the original in their own SMS thread but the leak cannot be
 * undone. The Instagram incident in this codebase is the same fallback.
 */
async function findBeauticianByBirdNumber(phoneNumber) {
  if (!phoneNumber) return null;

  const sanitised = phoneNumber.toString().replace(/[^0-9+\-() ]/g, '').substring(0, 30);
  if (!sanitised) return null;

  // The shared platform long code identifies Florrie, not a salon. Whatever any
  // row happens to say, a text to it cannot name a tenant, so it never routes.
  // This is the guard that holds BEFORE the split columns exist: today the
  // onboarding default puts this very number in sms_originator.
  if (isSharedSmsNumber(sanitised)) {
    logger.error(
      { to: sanitised },
      'Inbound Bird SMS was sent to the SHARED platform long code, which identifies no single salon. Dropping. Give the salon its own Bird number and set beauticians.sms_inbound_number.'
    );
    return null;
  }

  // Post-migration: the dedicated inbound column. Pre-migration: the single
  // legacy column, which is what the live database still has.
  const inboundColumn = await hasColumn(supabase, 'beauticians', 'sms_inbound_number')
    ? 'sms_inbound_number'
    : 'sms_originator';

  const byNumber = await beauticianByRoutingColumn(inboundColumn, sanitised);
  if (byNumber) return byNumber;

  // A salon whose own mobile IS the Bird number she bought, and who has not set
  // the routing column yet (M6). Same exactly-one rule: `phone` has no unique
  // constraint, so two salons sharing one is possible and is not routable.
  return beauticianByRoutingColumn('phone', sanitised);
}

/**
 * Download a WhatsApp voice note and transcribe it using Claude.
 * Supports multiple audio formats from WhatsApp: ogg, opus, mpeg, amr, aac.
 * WhatsApp media flow: get media URL → download binary → send to Claude.
 *
 * @param {string} mediaId - WhatsApp media ID
 * @param {string} mimeType - MIME type from WhatsApp message payload (e.g., 'audio/ogg')
 * @returns {Promise<string|null>} Transcribed text or null if no transcript
 * @throws {Error} Network or API errors
 */
async function transcribeWhatsAppAudio(mediaId, mimeType) {
  const waToken = process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
  if (!mediaId || !waToken) return null;

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
    headers: { 'Authorization': `Bearer ${waToken}` },
  });
  if (!metaRes.ok) throw new Error('Failed to get media URL');
  const { url: mediaUrl } = await metaRes.json();

  // Step 2: Download the audio binary
  const audioRes = await fetch(mediaUrl, {
    headers: { 'Authorization': `Bearer ${waToken}` },
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
}

export default router;
