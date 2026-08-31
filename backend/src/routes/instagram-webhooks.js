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
import { classifyInboundMessage, looksLikeKnownClient } from '../lib/junk-classifier.js';
import logger from '../lib/logger.js';
import { autoUnarchiveClient } from '../lib/client-archive.js';
import { authorship } from '../lib/authorship.js';
import { deDash } from '../lib/text.js';
import { guardedSend } from '../lib/outbound-guard.js';
import { isOptOutMessage, applyOptOut, OPT_OUT_CONFIRMATION } from '../lib/opt-out.js';

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
 * Every id in a delivery that could name the receiving account.
 *
 * entry.id is the one everybody reaches for, and it is the one that was wrong
 * in production. Meta's own webhook reference calls entry.id only "the object's
 * ID" while telling you to verify a test delivery by looking at recipient.id,
 * which it describes as the professional account's Instagram-scoped ID. Those
 * are two documented names for the thing we are trying to match, so match on
 * both rather than betting the routing on which one Meta means today.
 *
 * sender.id is deliberately NOT here. On an inbound DM that is the client.
 */
export function receivingAccountIds(event, entryId) {
  const out = [];
  const add = (v) => {
    const s = v == null ? '' : String(v).trim();
    if (s && !out.includes(s)) out.push(s);
  };
  add(entryId);
  add(event?.recipient?.id);
  return out;
}

/**
 * Find the beautician this delivery belongs to, matching on ANY id we hold.
 *
 * Two lookups, in order:
 *   1. instagram_page_id, the primary. This is what every existing row has.
 *   2. instagram_account_ids, the full set the connect flow learned, which
 *      covers the case that put us here: /me returns both `id` and `user_id`
 *      and they are not the same number, so the one we stored was not the one
 *      Meta sends.
 *
 * The second lookup is fail-soft. If that column has not been added yet the
 * query errors, and an errored query must not read as "no such beautician" and
 * silently bin a DM. It is logged and we fall back to lookup 1's answer.
 */
export async function findBeauticianForIds(candidateIds) {
  if (!candidateIds?.length) return { beautician: null, matchedOn: null };

  const { data: primary, error: primaryErr } = await supabase
    .from('beauticians')
    .select('*')
    .in('instagram_page_id', candidateIds)
    .limit(1);

  if (primaryErr) {
    // A failed query and an unknown account look identical at the call site
    // unless the error is read. Say which one this was.
    logger.error({ err: primaryErr, candidateIds }, 'Instagram DM: beautician lookup by instagram_page_id failed');
  } else if (primary?.length) {
    return { beautician: primary[0], matchedOn: 'instagram_page_id' };
  }

  const { data: alt, error: altErr } = await supabase
    .from('beauticians')
    .select('*')
    .overlaps('instagram_account_ids', candidateIds)
    .limit(1);

  if (altErr) {
    logger.warn({ err: altErr, candidateIds },
      'Instagram DM: could not search instagram_account_ids (is the column there?); matched on instagram_page_id only');
    return { beautician: null, matchedOn: null };
  }
  if (alt?.length) return { beautician: alt[0], matchedOn: 'instagram_account_ids' };

  return { beautician: null, matchedOn: null };
}

/**
 * Process a single Instagram messaging event.
 */
async function handleInstagramMessage(event, pageId) {
  // Skip echo messages (messages sent by us)
  if (event.message?.is_echo) return;

  // Skip events that are not a message at all: read receipts, reactions,
  // delivery confirmations. Those carry event.read / event.reaction /
  // event.delivery and no event.message.
  if (!event.message) return;

  const senderId = event.sender?.id;
  const messageText = typeof event.message.text === 'string' ? event.message.text : '';
  const messageId = event.message.mid;

  // EVERY NON TEXT DM USED TO BE BINNED HERE.
  //
  // 31 August 2026, the night @ellindigo connected. The gate on this line was
  // `if (!event.message?.text) return;`, so a photo, a reel share, a voice
  // note, a story mention or a sticker produced no message row, no thread, no
  // push and no log line. On Instagram that is not an edge case: sending a
  // picture of the lashes you want is how people ask for an appointment. The
  // client saw a delivered message and the salon owner saw nothing at all.
  //
  // messages already carries media_url and media_type (migration 001), the
  // WhatsApp webhook already writes them, the Inbox already renders that
  // shape, so storing it is the whole fix.
  const media = describeInstagramAttachment((event.message.attachments || [])[0]);

  if (!senderId) return;
  // Genuinely nothing to store: no words and no attachment.
  if (!messageText && !media) return;

  const candidateIds = receivingAccountIds(event, pageId);
  const { beautician, matchedOn } = await findBeauticianForIds(candidateIds);

  if (!beautician) {
    // NO fallback. Never attribute a DM to a random tenant: the old
    // ".limit(1).single()" hack could hand one salon's Instagram DMs to a
    // different salon. Log every id Meta sent so a mis-stored id can be
    // corrected without guessing, and drop.
    logger.warn(
      { candidateIds, entryId: pageId, recipientId: event?.recipient?.id, senderId },
      'Instagram DM: no beautician matches any id on this delivery; dropping. Add one of candidateIds to beauticians.instagram_account_ids (or instagram_page_id) to route it.',
    );
    return;
  }

  if (matchedOn === 'instagram_account_ids') {
    // Worth knowing: the primary id on the row is not the one Meta uses, so
    // publishing and DM routing are keyed off different numbers.
    logger.info({ beauticianId: beautician.id, candidateIds, stored: beautician.instagram_page_id },
      'Instagram DM: routed on a secondary account id, not instagram_page_id');
  }

  await processInstagramDM(beautician, senderId, messageText, messageId, media);
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
  return `Hey! I reply much faster on WhatsApp, please message me there instead 💬`;
}

/**
 * Send a reply to an Instagram DM via the Instagram Messaging API
 * (Instagram Login flow — graph.instagram.com with the beautician's own
 * long-lived Instagram user token).
 */
async function sendInstagramReply(recipientId, text, token) {
  // House rule choke point for the Instagram auto-reply. Body only.
  text = deDash(text);
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

/**
 * Meta's attachment types, mapped onto the media vocabulary the rest of the
 * product already speaks: routes/webhooks.js writes these same strings for
 * WhatsApp, routes/inbox.js turns them into thread previews ("Sent a photo"),
 * and services/messaging.js renders media_type 'image' inline in the thread.
 *
 * The label is what goes in messages.content, because a row with no text at
 * all reads as a bug in the Inbox. Same reasoning as the WhatsApp path's
 * "[Video]" placeholders.
 */
const IG_ATTACHMENT_KINDS = {
  image: ['image', '[Photo]'],
  video: ['video', '[Video]'],
  audio: ['audio', '[Voice note]'],
  file: ['document', '[File]'],
  share: ['share', '[Shared a post]'],
  story_mention: ['story_mention', '[Mentioned you in a story]'],
  ig_reel: ['video', '[Shared a reel]'],
  reel: ['video', '[Shared a reel]'],
  like_heart: ['sticker', '[Sent a like]'],
  sticker: ['sticker', '[Sticker]'],
  template: ['share', '[Shared something]'],
  fallback: ['attachment', '[Attachment]'],
};

/**
 * Turn Meta's attachments[0] into { media_type, media_url, label }, or null
 * when there is no attachment. Exported so the shape can be pinned by a test
 * without posting a whole webhook.
 */
export function describeInstagramAttachment(attachment) {
  if (!attachment) return null;
  const key = String(attachment.type || '').toLowerCase();
  const [mediaType, label] = IG_ATTACHMENT_KINDS[key] || ['attachment', '[Attachment]'];
  return {
    media_type: mediaType,
    // Meta's CDN urls are short lived. Stored anyway: an expired thumbnail is
    // recoverable, a message that was never written down is not.
    media_url: attachment.payload?.url || null,
    label,
  };
}

const PLACEHOLDER_NAME = 'Instagram User';

/**
 * Write the @handle onto the client record.
 *
 * Deliberately separate from the insert/update that creates the client: the
 * column arrives in migration 016, which is applied by hand, and a client
 * record failing to save because of a missing column would lose the DM
 * entirely. Best effort, logged, never thrown.
 */
async function saveInstagramUsername(clientId, username) {
  if (!clientId || !username) return;
  const { error } = await supabase
    .from('clients')
    .update({ instagram_username: username })
    .eq('id', clientId);
  if (error) {
    logger.warn({ err: error, clientId }, 'Could not save instagram_username (migration 016 applied?)');
  }
}

/**
 * Mark a stored message as junk.
 *
 * Same reasoning as saveInstagramUsername: the flag is a nice-to-have on the
 * row, and the suppression decisions below are already made in memory, so a
 * failed write costs us a label rather than a message.
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

/**
 * Find or create client, store message, and pass to AI Front Desk.
 */
async function processInstagramDM(beautician, senderId, messageText, messageId, media = null) {
  // A NULL MODE MEANS SILENCE, NOT A REDIRECT.
  //
  // 31 August 2026. This line read `|| 'redirect'`, so a salon that had never
  // opened the Instagram DM setting at all auto-replied "message me on
  // WhatsApp" to every person who wrote in. Nobody chose that. routes/
  // instagram.js already settled the question for the connect flow: an unset
  // mode is treated as not chosen, and not chosen means Florrie says nothing.
  // frontend/src/pages/Settings.jsx shows the same default so the screen and
  // the server agree about what is switched on.
  const dmMode = beautician.instagram_dm_mode || 'off';

  // Find client by Instagram sender ID.
  //
  // maybeSingle, not single. `single` resolves with { data: null, error } the
  // moment there are two matching rows, and there could be two: migration 021
  // built a NON unique index on (beautician_id, instagram_id), so two DMs
  // arriving together both missed the lookup and both inserted. From that
  // point on EVERY message from that person found two rows, read as "no
  // client", and inserted a third. The unique index in migration
  // 20260831_backend024 stops it happening; maybeSingle stops the existing
  // duplicates from making it worse. 053_clients_whatsapp_id_unique.sql is the
  // same fix for the same defect on WhatsApp.
  let { data: client, error: clientLookupErr } = await supabase
    .from('clients')
    .select('*')
    .eq('beautician_id', beautician.id)
    .eq('instagram_id', senderId)
    .maybeSingle();

  if (clientLookupErr) {
    logger.error({ err: clientLookupErr, beauticianId: beautician.id, instagramId: senderId },
      'Instagram DM: client lookup failed. A new client row is about to be created for somebody who may already have one.');
  }

  if (!client) {
    // Try to get profile info from Instagram
    const { name, username } = await fetchInstagramIdentity(senderId, beautician.instagram_page_token);

    // Create new client
    const { data: newClient, error: clientInsertErr } = await supabase
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

    if (clientInsertErr) {
      // This error was swallowed until 31 August 2026, and swallowing it was
      // expensive: the message below was then written with client_id
      // undefined, and routes/inbox.js:233 skips every row with no client_id,
      // so the DM existed in the table and nowhere in the product. Say it out
      // loud instead.
      logger.error({ err: clientInsertErr, beauticianId: beautician.id, instagramId: senderId },
        'Instagram DM: could not create the client. The message will be stored with no client attached and will NOT appear in the Inbox.');
    }

    client = newClient;
    if (newClient) {
      await saveInstagramUsername(newClient.id, username);
      if (username) client = { ...newClient, instagram_username: username };
      logger.info({ beauticianId: beautician.id, instagramId: senderId, named: !!name, handled: !!username }, 'Created new client from Instagram DM');
    }
  } else if (client.first_name === PLACEHOLDER_NAME || client.instagram_username === null) {
    // Self-heal. Everyone who DM'd before the lookup worked is stuck as
    // "Instagram User" with no handle; retry on their next message and keep
    // whatever Instagram gives us. While her token is expired this is a no-op.
    //
    // `instagram_username === null` means the column is there and empty, so it
    // is worth asking again. `undefined` means migration 016 has not landed,
    // and chasing a handle we cannot store would burn a Graph call per DM.
    const { name, username } = await fetchInstagramIdentity(senderId, beautician.instagram_page_token);
    if (name && name !== PLACEHOLDER_NAME && client.first_name === PLACEHOLDER_NAME) {
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
    if (username && client.instagram_username === null) {
      await saveInstagramUsername(client.id, username);
      client = { ...client, instagram_username: username };
    }
  }

  // A DM from an archived client means they are back: quietly clear the
  // archive flag so their thread and profile reappear. Fail-soft inside the
  // helper - DM handling never depends on it.
  if (client?.id) autoUnarchiveClient(client.id, 'instagram_dm').catch(() => {});

  // Is this a client, or is it outreach? A cold pitch, a follower seller or a
  // wingman message gets stored and stays findable, but it must not escalate,
  // must not buzz her phone, and must not spend one of her monthly messages on
  // an auto-reply. The classifier is heavily biased towards letting real
  // clients through, and anyone she already deals with is exempt outright.
  const junk = classifyInboundMessage(messageText, {
    isKnownClient: looksLikeKnownClient(client, { channel: 'instagram' }),
  });

  // Store the inbound message. A media DM carries a placeholder in `content`
  // (never blank, see describeInstagramAttachment) plus the media columns, so
  // the thread preview and the inline image both have something to read.
  const { data: storedMessage, error: storeErr } = await supabase
    .from('messages')
    .insert({
      beautician_id: beautician.id,
      client_id: client?.id,
      channel: 'instagram',
      direction: 'inbound',
      content: messageText || media?.label || '[Message]',
      media_url: media?.media_url || null,
      media_type: media?.media_type || null,
      external_message_id: messageId,
      ai_handled: false,
      ...authorship('client'),
      escalated: false,
    })
    .select()
    .single();

  if (storeErr) {
    // Also swallowed until 31 August 2026. A failed insert here means the DM
    // is gone: no row, no thread, nothing to escalate later. It has to be
    // findable in the logs, because it is findable nowhere else.
    logger.error({ err: storeErr, beauticianId: beautician.id, clientId: client?.id, instagramId: senderId, mediaType: media?.media_type || null },
      'Instagram DM: could not store the inbound message. This DM is lost.');
  }

  if (junk.isJunk) {
    await flagMessageAsJunk(storedMessage?.id, junk.reason);
    logger.info({ beauticianId: beautician.id, senderId, reason: junk.reason, signals: junk.signals }, 'Instagram DM classified as junk: stored, not escalated, no push, no reply');
    return;
  }

  // Non-invasive nudge: "You have Instagram messages waiting for you"
  // (throttled to at most one per 15 min inside the helper). Fire-and-forget.
  pushMessagesWaiting(beautician.id, 'instagram').catch(() => {});

  // STOP, BEFORE THE MODE BRANCH, BECAUSE TWO OF THE THREE MODES END HERE.
  //
  // 31 August 2026. The only opt-out handler in the codebase lived inside
  // processInboundMessage, and 'redirect' and 'off' both return below without
  // ever calling it. So a client who replied STOP to the WhatsApp redirect,
  // which is the single most likely message to be replied to with STOP, never
  // got marketing_opted_out_at set, and every marketing engine went on
  // treating her as opted in. The word does not mean something different
  // because it arrived on Instagram.
  if (isOptOutMessage(messageText)) {
    await applyOptOut({ beautician, client });
    logger.info({ beauticianId: beautician.id, clientId: client?.id, senderId, mode: dmMode },
      'Instagram DM: marketing opt-out honoured');

    // Confirm it, unless the owner has asked for total silence on Instagram.
    // The confirmation goes through the same gate as everything else: it is
    // typed transactional in lib/outbound-guard.js precisely so a person who
    // has just opted out still gets told that it worked.
    if (dmMode !== 'off') {
      await guardedSend({
        beauticianId: beautician.id,
        clientId: client?.id || null,
        messageType: 'marketing_opt_out',
        channel: 'instagram',
        client,
        body: OPT_OUT_CONFIRMATION,
        send: () => sendInstagramReply(senderId, OPT_OUT_CONFIRMATION, beautician.instagram_page_token),
      });
    }
    return;
  }

  if (dmMode === 'off') {
    logger.info({ senderId, mode: 'off' }, 'Instagram DM stored, no reply (mode=off)');
    return;
  }

  // A PHOTO IS NOT A QUESTION FLORRIE CAN ANSWER.
  //
  // 31 August 2026: media DMs are stored from today (see
  // describeInstagramAttachment), which means for the first time they reach
  // this point. Neither auto-reply below has seen the picture: the front desk
  // classifier is handed text only, and the redirect would answer a photo of
  // somebody's lashes with "message me on WhatsApp". Store it, push it, let
  // Ellie look at it herself.
  if (media) {
    logger.info({ beauticianId: beautician.id, senderId, mediaType: media.media_type, mode: dmMode },
      'Instagram DM with an attachment: stored and pushed, no automatic reply');
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

      // THE ONLY AUTO-SEND IN THE CODEBASE THAT REACHED A CLIENT WITH NOTHING
      // ON THE PATH. Until 31 August 2026 this called sendInstagramReply
      // directly: no consent check, no opt-out check, no outbound_sends row,
      // so it was invisible to the outbox, invisible to the caps, and it kept
      // talking to people who had asked it to stop.
      //
      // messageType 'instagram_redirect' is typed TRANSACTIONAL in
      // lib/outbound-guard.js on purpose: it answers a message the client sent
      // seconds ago, so quiet hours and the 7 day proactive cap are the wrong
      // shape for it, and the trust dial would turn a reply the owner switched
      // on herself into something she has to approve. What it does get is the
      // opt-out check, which is the gate that was actually missing.
      const verdict = await guardedSend({
        beauticianId: beautician.id,
        clientId: client?.id || null,
        messageType: 'instagram_redirect',
        channel: 'instagram',
        client,
        body: redirectMsg,
        send: () => sendInstagramReply(senderId, redirectMsg, beautician.instagram_page_token),
      });

      if (verdict.delivered) {
        // Record redirect sent time on client
        if (client?.id) {
          const { error: throttleErr } = await supabase
            .from('clients')
            .update({ instagram_redirect_sent_at: new Date().toISOString() })
            .eq('id', client.id);
          if (throttleErr) {
            // Unread until 31 August 2026. This write IS the throttle: if it
            // silently fails, the redirect fires again on the client's very
            // next DM, and on the one after that, forever. Loud, because the
            // symptom (a client being told to use WhatsApp five times in an
            // afternoon) looks like nothing at all from the server side.
            logger.error({ err: throttleErr, clientId: client.id, beauticianId: beautician.id },
              'Instagram redirect throttle NOT saved. This client will be sent the redirect again on their next DM.');
          }
        }

        // Store outbound redirect message for the inbox
        const { error: outboundErr } = await supabase.from('messages').insert({
          beautician_id: beautician.id,
          client_id: client?.id,
          channel: 'instagram',
          direction: 'outbound',
          content: redirectMsg,
          ai_handled: true,
          ...authorship('template'),
          escalated: false,
        });
        if (outboundErr) {
          logger.error({ err: outboundErr, clientId: client?.id, beauticianId: beautician.id },
            'Instagram redirect was sent but not written to the thread; the Inbox will not show it');
        }

        logger.info({ senderId, clientName: client?.first_name }, 'Sent WhatsApp redirect via Instagram DM');
      } else {
        logger.info({ senderId, clientId: client?.id, decision: verdict.decision, reason: verdict.reason },
          'Instagram redirect not sent');
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
      const result = await processInboundMessage(storedMessage.id, beautician, client, messageText, 'instagram');
      logger.info({ handled: result?.handled, intent: result?.intent, client: client?.first_name || senderId }, 'Front Desk answered Instagram DM');
    } catch (err) {
      logger.error({ err, messageId }, 'AI Front Desk failed on Instagram DM');
    }
    return;
  }

  // Legacy: honour the older auto_reply_enabled flag for any other mode.
  if (beautician.auto_reply_enabled && messageText && storedMessage?.id) {
    try {
      const result = await processInboundMessage(storedMessage.id, beautician, client, messageText, 'instagram');
      logger.info({ handled: result?.handled, intent: result?.intent, client: client?.first_name || senderId }, 'Front Desk processed Instagram DM');
    } catch (err) {
      logger.error({ err, messageId }, 'AI Front Desk failed on Instagram DM');
    }
  }
}

/**
 * Ask Instagram who this sender actually is.
 * Returns { name, username }, either of which may be null.
 *
 * This was failing silently for every DM (every client landed as "Instagram
 * User"), because a non-ok response was swallowed with no log. It now logs the
 * Graph error so we can see WHY.
 *
 * The username is what Ellie recognises people by, so it is returned in its
 * own right rather than being melted into the display name. Note that as of
 * 2026-06-21 her token is expired, so every one of these calls comes back as
 * an OAuthException. That is survivable by design: callers treat a null
 * identity as "not known yet" and try again on the next message or on the
 * nightly backfill, so this starts working the moment she reconnects.
 */
export async function fetchInstagramIdentity(userId, token) {
  const empty = { name: null, username: null };
  const igToken = token || process.env.INSTAGRAM_PAGE_TOKEN;
  if (!igToken) {
    logger.warn({ userId }, 'IG profile lookup skipped: no page token');
    return empty;
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
      const username = normaliseHandle(data.username);
      const name = data.name || (username ? `@${username}` : null);
      if (name || username) return { name, username };
      lastErr = { reason: 'no name/username in response', data };
    } catch (err) {
      lastErr = { message: String(err) };
    }
  }
  logger.warn({ userId, lastErr }, 'IG profile lookup failed after all field attempts');
  return empty;
}

/** Store handles bare, with no leading @, so lookups and display agree. */
function normaliseHandle(raw) {
  const h = String(raw || '').trim().replace(/^@+/, '');
  return h || null;
}

export default router;
