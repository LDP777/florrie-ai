/**
 * Instagram DM Webhook Receiver
 *
 * Receives incoming Instagram DMs via the Instagram Messaging API.
 * Uses the same Meta webhook pattern as WhatsApp.
 * Feeds messages into the existing processInboundMessage() pipeline
 * so AI logic, tone matching, and escalation all work unchanged.
 *
 * Required env vars:
 *   INSTAGRAM_VERIFY_TOKEN - webhook verification token (set in Railway + Meta dashboard)
 *   INSTAGRAM_APP_SECRET   - for HMAC-SHA256 signature verification
 *                            (falls back to META_APP_SECRET if unset)
 *
 * Reply/profile tokens are read per-beautician from beauticians.instagram_page_token
 * (the long-lived Instagram user token saved at connect time), NOT from a global
 * env var, so this works multi-tenant.
 */
import { Router } from 'express';
import crypto from 'crypto';
import { supabase } from '../config.js';
import { processInboundMessage } from '../services/ai-front-desk.js';
import { pushMessagesWaiting } from '../services/push-notifications.js';
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
  // Visible-in-Railway receipt log: confirms Meta is actually delivering DMs.
  logger.info({ object: req.body?.object, entries: req.body?.entry?.length || 0, entryIds: (req.body?.entry || []).map(e => e.id), hasSig: !!req.headers['x-hub-signature-256'] }, 'Instagram webhook received');

  // Verify HMAC-SHA256 signature. A Meta app shares one app secret across its
  // products, so fall back to META_APP_SECRET (which is what is configured) when
  // a dedicated INSTAGRAM_APP_SECRET isn't set.
  const secret = process.env.INSTAGRAM_APP_SECRET || process.env.META_APP_SECRET;
  if (secret) {
    const signature = req.headers['x-hub-signature-256'];
    if (!signature) {
      logger.warn('Instagram webhook: missing signature');
      return res.status(403).json({ error: 'Missing signature' });
    }

    try {
      // Meta signs the RAW request bytes, not a re-serialised JSON object.
      // express.json() stashes the original buffer on req.rawBody (see index.js).
      // Using JSON.stringify(req.body) here would re-encode emoji/unicode and
      // spacing differently, so the HMAC would never match and every DM 403'd.
      const payload = req.rawBody || Buffer.from(JSON.stringify(req.body));
      const expected = crypto.createHmac('sha256', secret)
        .update(payload)
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
  } else if (process.env.WEBHOOK_STRICT === 'true') {
    logger.error('Instagram webhook: INSTAGRAM_APP_SECRET not configured; rejecting unsigned payload (WEBHOOK_STRICT)');
    return res.status(503).json({ error: 'Webhook not configured' });
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
    // NO fallback. Never attribute a DM to a random tenant: the old
    // ".limit(1).single()" hack could hand one salon's Instagram DMs to a
    // different salon. Log the pageId so a mis-stored instagram_page_id can be
    // corrected, and drop.
    logger.warn({ pageId, senderId }, 'Instagram DM: no beautician matches this instagram_page_id (entry.id); dropping. Set beauticians.instagram_page_id to this pageId to route it.');
    return;
  }

  await processInstagramDM(beautician, senderId, messageText, messageId);
}

/**
 * Build the WhatsApp redirect message for a beautician.
 * Uses their custom message if set, otherwise generates a sensible default.
 */
function buildRedirectMessage(beautician) {
  if (beautician.instagram_redirect_message) {
    return beautician.instagram_redirect_message;
  }

  // Build wa.me link from phone number
  const phone = beautician.phone || '';
  const digits = phone.replace(/\D/g, '');
  // UK numbers: strip leading 0, prefix 44
  const waNumber = digits.startsWith('44') ? digits : digits.startsWith('0') ? `44${digits.slice(1)}` : digits;
  const waLink = waNumber ? `https://wa.me/${waNumber}` : null;

  const name = beautician.first_name || 'I';
  if (waLink) {
    return `Hey! ${name} replies much faster on WhatsApp 💬 Message me here: ${waLink}`;
  }
  return `Hey! I reply much faster on WhatsApp — please message me there instead 💬`;
}

/**
 * Send a reply to an Instagram DM via the Instagram Messaging API
 * (Instagram Login flow — graph.instagram.com with the beautician's own
 * long-lived Instagram user token).
 */
async function sendInstagramReply(recipientId, text, token) {
  const igToken = token || process.env.INSTAGRAM_PAGE_TOKEN;
  if (!igToken) {
    logger.warn('No Instagram token available — cannot send Instagram reply');
    return false;
  }

  try {
    const res = await fetch(
      `https://graph.instagram.com/v21.0/me/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${igToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          recipient: { id: recipientId },
          message: { text },
        }),
      }
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      logger.warn({ err, recipientId }, 'Instagram reply send failed');
      return false;
    }

    return true;
  } catch (err) {
    logger.error({ err, recipientId }, 'Instagram reply network error');
    return false;
  }
}

const PLACEHOLDER_NAME = 'Instagram User';

/**
 * Find or create client, store message, and pass to AI Front Desk.
 */
async function processInstagramDM(beautician, senderId, messageText, messageId) {
  const dmMode = beautician.instagram_dm_mode || 'redirect';

  // Find client by Instagram sender ID
  let { data: client } = await supabase
    .from('clients')
    .select('*')
    .eq('beautician_id', beautician.id)
    .eq('instagram_id', senderId)
    .single();

  if (!client) {
    // Try to get profile info from Instagram
    const name = await fetchInstagramProfile(senderId, beautician.instagram_page_token);

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
      logger.info({ beauticianId: beautician.id, instagramId: senderId, named: !!name }, 'Created new client from Instagram DM');
    }
  } else if (client.first_name === PLACEHOLDER_NAME) {
    // Self-heal. Everyone who DM'd before the lookup worked is stuck as
    // "Instagram User"; retry on their next message and keep the real name.
    const name = await fetchInstagramProfile(senderId, beautician.instagram_page_token);
    if (name && name !== PLACEHOLDER_NAME) {
      const { data: renamed } = await supabase
        .from('clients')
        .update({ first_name: name })
        .eq('id', client.id)
        .select()
        .single();
      if (renamed) {
        client = renamed;
        logger.info({ clientId: client.id, instagramId: senderId }, 'Backfilled Instagram client name');
      }
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

  // Non-invasive nudge: "You have Instagram messages waiting for you"
  // (throttled to at most one per 15 min inside the helper). Fire-and-forget.
  pushMessagesWaiting(beautician.id, 'instagram').catch(() => {});

  if (dmMode === 'off') {
    logger.info({ senderId, mode: 'off' }, 'Instagram DM stored, no reply (mode=off)');
    return;
  }

  if (dmMode === 'redirect') {
    const lastSent = client?.instagram_redirect_sent_at
      ? new Date(client.instagram_redirect_sent_at)
      : null;
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const alreadySent = lastSent && lastSent > sevenDaysAgo;

    if (!alreadySent) {
      const redirectMsg = buildRedirectMessage(beautician);
      const sent = await sendInstagramReply(senderId, redirectMsg, beautician.instagram_page_token);

      if (sent) {
        // Record redirect sent time on client
        if (client?.id) {
          await supabase
            .from('clients')
            .update({ instagram_redirect_sent_at: new Date().toISOString() })
            .eq('id', client.id);
        }

        // Store outbound redirect message for the inbox
        await supabase.from('messages').insert({
          beautician_id: beautician.id,
          client_id: client?.id,
          channel: 'instagram',
          direction: 'outbound',
          content: redirectMsg,
          ai_handled: true,
          escalated: false,
        });

        logger.info({ senderId, clientName: client?.first_name }, 'Sent WhatsApp redirect via Instagram DM');
      }
    } else {
      logger.info({ senderId }, 'Instagram redirect already sent recently, skipping');
    }
    return;
  }

  // dmMode 'ai' (or 'reply'): Florrie answers the DM herself through the same
  // AI front desk pipeline as WhatsApp, replying on Instagram. Note: Instagram
  // only allows replies within 24h of the client's message and does NOT permit
  // messaging someone who hasn't messaged first, so this is reactive only.
  // Requires the instagram_manage_messages permission to be live on the app.
  if ((dmMode === 'ai' || dmMode === 'reply') && storedMessage?.id) {
    try {
      const result = await processInboundMessage(storedMessage.id, beautician, client, messageText);
      logger.info({ handled: result?.handled, intent: result?.intent, client: client?.first_name || senderId }, 'Front Desk answered Instagram DM');
    } catch (err) {
      logger.error({ err, messageId }, 'AI Front Desk failed on Instagram DM');
    }
    return;
  }

  // Legacy: honour the older auto_reply_enabled flag for any other mode.
  if (beautician.auto_reply_enabled && messageText && storedMessage?.id) {
    try {
      const result = await processInboundMessage(storedMessage.id, beautician, client, messageText);
      logger.info({ handled: result?.handled, intent: result?.intent, client: client?.first_name || senderId }, 'Front Desk processed Instagram DM');
    } catch (err) {
      logger.error({ err, messageId }, 'AI Front Desk failed on Instagram DM');
    }
  }
}

/**
 * Fetch an Instagram sender's profile name via the Instagram Graph API,
 * using the beautician's own long-lived Instagram token.
 */
/**
 * Ask Instagram who this sender actually is. Returns a display name, or null.
 *
 * This was failing silently for every DM (every client landed as "Instagram
 * User"), because a non-ok response was swallowed with no log. It now logs the
 * Graph error so we can see WHY, and falls back to @username when Instagram
 * gives us a handle but no display name.
 */
export async function fetchInstagramProfile(userId, token) {
  const igToken = token || process.env.INSTAGRAM_PAGE_TOKEN;
  if (!igToken) {
    logger.warn({ userId }, 'IG profile lookup skipped: no page token');
    return null;
  }

  // Try richest -> simplest. Requesting `username` for a sender on a personal
  // Instagram account makes the WHOLE call 400 (username is only exposed for
  // pro accounts / with advanced access), which is why every DM was landing as
  // "Instagram User". `name` is available for any sender who messaged you, so
  // fall back to it alone.
  const attempts = ['name,username', 'name', 'username'];
  let lastErr = null;
  for (const fields of attempts) {
    try {
      const res = await fetch(
        `https://graph.instagram.com/v21.0/${userId}?fields=${fields}`,
        { headers: { Authorization: `Bearer ${igToken}` } }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        lastErr = data?.error || { status: res.status };
        continue; // drop a field and retry
      }
      const name = data.name || (data.username ? `@${data.username}` : null);
      if (name) return name;
      lastErr = { reason: 'no name/username in response', data };
    } catch (err) {
      lastErr = { message: String(err) };
    }
  }
  logger.warn({ userId, lastErr }, 'IG profile lookup failed after all field attempts');
  return null;
}

export default router;
