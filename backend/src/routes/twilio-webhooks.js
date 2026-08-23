/**
 * Twilio WhatsApp inbound webhook — mounted at /api/webhooks/twilio.
 *
 * POST /whatsapp receives inbound WhatsApp messages for beauticians on
 * wa_provider='twilio' and mirrors the Meta Cloud API pipeline in
 * webhooks.js exactly: resolve the beautician by the sender the client
 * messaged, find-or-create the client, store the inbound messages row,
 * then hand off to processInboundMessage (the AI Front Desk).
 *
 * Dormant until env exists: 503 when TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN
 * are missing, 403 when the X-Twilio-Signature doesn't verify.
 *
 * Body parsing: Twilio posts application/x-www-form-urlencoded. index.js
 * installs a global express.urlencoded({ extended: true }) parser, so
 * req.body is already populated by the time this router runs — no
 * router-local parser needed. (Signature validation also needs the parsed
 * form params, not the raw body, so this is the correct setup.)
 *
 * Configure in the Twilio console (sender or Messaging Service):
 *   "When a message comes in" -> https://api.florrie.ai/api/webhooks/twilio/whatsapp
 */
import { Router } from 'express';
import { supabase } from '../config.js';
import { processInboundMessage } from '../services/ai-front-desk.js';
import { twilioValidateSignature } from '../services/whatsapp-twilio.js';
import logger from '../lib/logger.js';
import { autoUnarchiveClient } from '../lib/client-archive.js';
import { authorship } from '../lib/authorship.js';

const router = Router();

router.post('/whatsapp', async (req, res) => {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    logger.warn('Twilio WhatsApp webhook hit but TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN not set');
    return res.status(503).json({ error: 'Twilio not configured' });
  }

  // Validate over the exact public URL Twilio called. trust proxy is set in
  // index.js, so req.protocol resolves to https behind Railway's proxy.
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  if (!twilioValidateSignature(req, url)) {
    logger.warn({ url, sig: !!req.headers['x-twilio-signature'] }, 'Twilio WhatsApp webhook: signature validation failed');
    return res.status(403).json({ error: 'Signature verification failed' });
  }

  // ACK with empty TwiML immediately — replies go out through the normal
  // outbound path (sendWhatsAppText via the Twilio service), never TwiML.
  res.type('text/xml').send('<Response/>');

  try {
    const { From, To, Body, MessageSid, ProfileName, NumMedia } = req.body || {};

    if (!MessageSid || !From) {
      logger.warn({ MessageSid, From }, 'Twilio WhatsApp: missing required fields');
      return;
    }

    // Resolve the tenant by the WhatsApp sender the client messaged
    // (e.g. To = 'whatsapp:+447418313493' = beauticians.twilio_wa_sender).
    const beautician = await findBeauticianByTwilioWaSender(To);
    if (!beautician) {
      logger.warn({ to: To }, 'No beautician found for Twilio WhatsApp sender');
      return;
    }

    // Find or create the client — same matching rules as the Meta webhook.
    let client;
    try {
      client = await findOrCreateClientByWhatsApp(beautician.id, From, ProfileName);
    } catch (clientErr) {
      logger.error({ err: clientErr, beautician_id: beautician.id, from: From }, 'Error finding/creating Twilio WhatsApp client');
      return;
    }
    if (!client) {
      logger.warn({ beautician_id: beautician.id, from: From }, 'No client found or created for Twilio WhatsApp');
      return;
    }

    // Extract message content (+ media, mirroring the twilio-sms handler).
    let messageContent = Body || '';
    let mediaUrl = null;
    let mediaType = null;
    const hasMedia = NumMedia && parseInt(NumMedia, 10) > 0;
    if (hasMedia) {
      mediaUrl = req.body.MediaUrl0 || null;
      mediaType = req.body.MediaContentType0 || null;
      if (!messageContent) {
        messageContent = mediaType?.startsWith('image/') ? '[Image]'
          : mediaType?.startsWith('audio/') ? '[Voice note: transcription unavailable]'
          : '[Media message]';
      }
    }

    // Store the inbound message — same shape as the Meta path inserts.
    const { data: storedMessage, error: storeErr } = await supabase
      .from('messages')
      .insert({
        beautician_id: beautician.id,
        client_id: client.id,
        channel: 'whatsapp',
        direction: 'inbound',
        content: messageContent,
        media_url: mediaUrl,
        media_type: mediaType,
        external_message_id: MessageSid,
        ai_handled: false,
        ...authorship('client'),
        escalated: false,
      })
      .select()
      .single();

    if (storeErr || !storedMessage) {
      logger.error({ err: storeErr, beautician_id: beautician.id }, 'Failed to store inbound Twilio WhatsApp message');
      return;
    }

    // Hand off to the AI Front Desk — text only, exactly like the Meta path
    // (which gates on message.type === 'text').
    if (beautician.auto_reply_enabled && messageContent && !hasMedia) {
      const result = await processInboundMessage(
        storedMessage.id, beautician, client, messageContent
      );
      logger.info({ handled: result.handled, intent: result.intent, client: client?.first_name || From }, 'Front Desk processed Twilio WhatsApp message');
    } else {
      logger.debug({ client: client?.first_name || From, content: messageContent }, 'Inbound Twilio WhatsApp: auto-reply disabled or non-text');
    }
  } catch (err) {
    logger.error({ err }, 'Twilio WhatsApp webhook processing error');
  }
});

/**
 * Find the beautician whose twilio_wa_sender matches the inbound To address.
 * Stored canonically as 'whatsapp:+44...'; also accepts a bare E.164 in case
 * the column was seeded without the prefix. No first-beautician fallback —
 * the Twilio path is multi-tenant from day one, a miss is a config error.
 */
async function findBeauticianByTwilioWaSender(to) {
  if (!to) return null;
  // Sanitise to the characters a whatsapp:+E.164 address can contain.
  const sanitised = String(to).trim().replace(/[^0-9+:a-z]/gi, '').substring(0, 40);
  const bare = sanitised.replace(/^whatsapp:/i, '');

  let { data: beautician } = await supabase
    .from('beauticians')
    .select('*')
    .eq('twilio_wa_sender', sanitised)
    .maybeSingle();

  if (!beautician && bare && bare !== sanitised) {
    ({ data: beautician } = await supabase
      .from('beauticians')
      .select('*')
      .eq('twilio_wa_sender', bare)
      .maybeSingle());
  }

  return beautician || null;
}

/**
 * Find or create a client by WhatsApp number, mirroring the Meta webhook:
 * match whatsapp_id first, then phone (link whatsapp_id when matched), then
 * create. Meta's wa_id is bare digits ('447...'), Twilio's From is
 * 'whatsapp:+447...' — we normalise to the Meta digits form so the same
 * client matches regardless of which provider the message arrived through.
 */
async function findOrCreateClientByWhatsApp(beauticianId, from, profileName) {
  const digits = String(from || '').replace(/[^0-9]/g, ''); // Meta wa_id form: 447...
  if (!digits) return null;
  const e164 = `+${digits}`;

  // 1. Existing WhatsApp identity (matches clients created by the Meta path).
  let { data: client } = await supabase
    .from('clients')
    .select('*')
    .eq('beautician_id', beauticianId)
    .eq('whatsapp_id', digits)
    .maybeSingle();
  if (client) {
    // An archived client messaging in means they are back; clear the flag (fail-soft).
    autoUnarchiveClient(client.id, 'whatsapp_message').catch(() => {});
    return client;
  }

  // 2. Phone match — stored either as bare digits (Meta-created rows) or
  //    E.164 (Bird/manual rows). Link the WhatsApp ID on first contact.
  for (const phone of [digits, e164]) {
    const { data: phoneClient } = await supabase
      .from('clients')
      .select('*')
      .eq('beautician_id', beauticianId)
      .eq('phone', phone)
      .maybeSingle();
    if (phoneClient) {
      await supabase
        .from('clients')
        .update({ whatsapp_id: digits })
        .eq('id', phoneClient.id);
      // Same as above: a message from an archived client unarchives them.
      autoUnarchiveClient(phoneClient.id, 'whatsapp_message').catch(() => {});
      return { ...phoneClient, whatsapp_id: digits };
    }
  }

  // 3. New client from WhatsApp contact — same shape the Meta path inserts.
  const { data: newClient } = await supabase
    .from('clients')
    .insert({
      beautician_id: beauticianId,
      first_name: profileName || 'Unknown',
      phone: digits,
      whatsapp_id: digits,
      status: 'new',
    })
    .select()
    .single();

  if (newClient) {
    logger.info({ beautician_id: beauticianId, whatsapp_id: digits }, 'Created new client from Twilio WhatsApp');
  }
  return newClient || null;
}

export default router;
