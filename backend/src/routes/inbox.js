import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';
import { sendOnChannel, shapeMessage } from '../services/messaging.js';
import { authorshipForSend } from '../lib/idiolect.js';
import { generateReplySuggestions, replyIsOwed } from '../services/ai-front-desk.js';
import { isMissingColumnError } from '../lib/junk-classifier.js';
import { isSocialLead, clientsEverBooked } from '../lib/inbox-space.js';

const router = Router();

/**
 * Inbox routes. Day 2 of the 2026-05-28 refactor sprint. A salon owner
 * thinks "Sarah", not "Sarah on WhatsApp". These endpoints group the
 * messages table by client_id so the UI can show one thread per client
 * with channels interleaved as metadata.
 *
 *   GET  /api/inbox/threads             list of thread summaries
 *   GET  /api/inbox/thread/:client_id   full conversation, oldest first
 *   POST /api/inbox/send                send a reply on any channel
 */

const PREVIEW_MAX = 90;
const THREAD_MESSAGE_LIMIT = 200;
const THREAD_FETCH_CAP = 1000;

function previewOf(content) {
  if (!content) return '';
  const flat = String(content).replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX - 1)}…` : flat;
}

// A quiet stand-in when a message carries no text (a photo, sticker, voice
// note). Never let a row render a blank preview line.
function mediaPlaceholder(mediaType) {
  const t = String(mediaType || '').toLowerCase();
  if (t.includes('image') || t === 'photo' || t === 'sticker') return 'Sent a photo';
  if (t.includes('video')) return 'Sent a video';
  if (t.includes('audio') || t === 'voice') return 'Sent a voice note';
  if (t) return 'Sent an attachment';
  // A row with no text and no known media type is usually a template send or
  // a system-logged touch. 'No message text' read like a bug to Ellie.
  return 'Sent a message';
}

// Build the preview for a single row: its text if it has any, otherwise a
// media placeholder. Used for both the latest message and the latest text.
function rowPreview(row) {
  const text = previewOf(row.content);
  if (text) return text;
  return mediaPlaceholder(row.media_type);
}

// Phone, email, whatsapp and instagram handles that identify the SAME person
// across duplicate client records. Normalised so "+44 7..." and "447..." match.
function identityKeys(c) {
  if (!c) return [];
  const keys = [];
  const phone = String(c.phone || '').replace(/[^0-9]/g, '');
  if (phone) keys.push('p:' + phone.slice(-10));
  const wa = String(c.whatsapp_id || '').replace(/[^0-9]/g, '');
  if (wa) keys.push('p:' + wa.slice(-10));
  const email = String(c.email || '').trim().toLowerCase();
  if (email) keys.push('e:' + email);
  const ig = String(c.instagram_id || '').trim().toLowerCase();
  if (ig) keys.push('i:' + ig);
  return keys;
}

/**
 * GET /api/inbox/threads?limit=50
 *
 * Pulls the most recent N messages for this beautician (capped at 1000 to
 * keep latency sane on big tenants), then collapses them into one entry
 * per client. last_message_at drives the sort.
 */
/**
 * Classify a message row into a coarse type the inbox UI can label and
 * filter on. Read-only derivation, no gating logic. Order matters: a
 * client message is always "inbound"; an outbound message is then split
 * by how it was produced (escalated > proactive engine > auto-reply > you).
 */
function messageType(row) {
  if (row.direction === 'inbound') return 'inbound';
  if (row.escalated && !row.resolved) return 'escalated';
  const engine = row.digital_employee;
  // front_desk replies are answers to a client message (auto-reply).
  if (row.ai_handled && engine === 'front_desk') return 'auto_reply';
  // Any other engine (comeback, calendar, content, money, scout) is a
  // proactive nudge Florrie initiated, not a reply.
  if (engine && engine !== 'front_desk') return 'proactive';
  if (row.ai_handled) return 'auto_reply';
  return 'you';
}

/**
 * Thread segmentation, shared contract with the Inbox UI.
 *
 * The frontend used to work all of this out for itself in Inbox.jsx, which
 * meant the nav badge and the "Waiting on you" list could disagree about what
 * was owed. The backend now says which bucket a thread belongs in and both
 * sides read the same answer.
 *
 * A pure thank-you or sign-off does not owe a reply, so it should never nag
 * her. Mirrors HANDLED_INTENTS in frontend/src/pages/Inbox.jsx.
 */
const HANDLED_INTENTS = new Set(['review_thanks', 'greeting']);
const NEEDS_YOU_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * "A human reply is genuinely owed."
 *
 * ONE rule: the client had the last word, recently, and that last word asks
 * something of her.
 *
 * It deliberately no longer keys off needs_attention (any escalated row in the
 * thread never formally resolved). That flag is sticky: Ellie could answer a
 * client five times and the thread still counted as waiting, because a row
 * from three weeks ago was never marked resolved. That is what put 132 clients
 * on the badge when only 15 were genuinely waiting. If Florrie or Ellie has
 * spoken since, nobody is waiting, whatever the old rows say.
 */
function needsYou(bucket) {
  if (bucket.last_message_direction !== 'inbound') return false;
  if (Date.now() - new Date(bucket.last_message_at).getTime() > NEEDS_YOU_WINDOW_MS) return false;
  return replyIsOwed(bucket.last_inbound_preview || bucket.last_message_preview, {
    intent: bucket.last_inbound_intent,
  });
}

/**
 * Which of the four buckets this thread belongs in.
 *
 * Order matters. Junk is tested FIRST, ahead of 'needs', which is a deliberate
 * departure from a strict "needs beats everything" rule: junk no longer
 * escalates, but an unanswered cold pitch still looks like "client spoke last,
 * within a week, intent unknown", so it would walk straight back into Waiting
 * and the classifier would have achieved nothing. Everything that is not junk
 * keeps 'needs' on top.
 */
function segmentOf(bucket, { isJunk, isKnownClient, instagramOnly }) {
  if (isJunk) return 'social';
  if (needsYou(bucket)) return 'needs';
  if (isKnownClient) return 'client';
  if (instagramOnly) return 'social';
  return 'new';
}

// The select without the columns that migration 016 adds. Until Levi has
// applied it (and restarted Railway, because PgBouncer caches the schema), the
// query falls back to this and the inbox still loads instead of 500ing.
const THREAD_BASE_COLUMNS = `
        id,
        client_id,
        channel,
        direction,
        content,
        media_type,
        created_at,
        resolved,
        read_at,
        ai_handled,
        escalated,
        ai_response,
        digital_employee,
        ai_intent,
        clients ( id, first_name, last_name, phone, email, whatsapp_id, instagram_id )`;

/**
 * The thread computation, extracted so /threads and /clear-social read the
 * SAME buckets. If clear-social judged "Instagram stranger, not a lead" with
 * its own logic, the two would drift and one day it would bulk-resolve a
 * thread the inbox was showing as a lead. One copy of the rule, two callers.
 *
 * Returns { error } on failure, else { threads } where every thread still
 * carries client_ids (all duplicate client records folded into it) so
 * clear-social can target the whole person. /threads strips it before
 * responding.
 */
async function computeThreads(beauticianId, limit) {
    let { data, error } = await supabase
      .from('messages')
      .select(`
        id,
        client_id,
        channel,
        direction,
        content,
        media_type,
        created_at,
        resolved,
        read_at,
        ai_handled,
        escalated,
        ai_response,
        digital_employee,
        ai_intent,
        is_junk,
        clients ( id, first_name, last_name, phone, email, whatsapp_id, instagram_id, instagram_username )
      `)
      .eq('beautician_id', beauticianId)
      .order('created_at', { ascending: false })
      .limit(THREAD_FETCH_CAP);

    if (error && isMissingColumnError(error)) {
      logger.warn({ err: error }, 'inbox.threads falling back: migration 016 not applied yet');
      ({ data, error } = await supabase
        .from('messages')
        .select(THREAD_BASE_COLUMNS)
        .eq('beautician_id', beauticianId)
        .order('created_at', { ascending: false })
        .limit(THREAD_FETCH_CAP));
    }

    if (error) {
      logger.error({ err: error }, 'inbox.threads supabase failed');
      return { error };
    }

    // Bucket every message into exactly one thread. We key first on client_id,
    // then collapse buckets that are the SAME person held as duplicate client
    // records (one from SMS, one from Instagram, etc.) by matching contact
    // details. Rows arrive newest-first, so the first row we see for a bucket
    // is its most recent message.
    const buckets = new Map();          // client_id -> bucket
    const identityToBucket = new Map(); // identity key -> bucket (for de-dup)

    for (const row of data || []) {
      // Orphan rows (webhook fired before the client lookup) carry no client.
      // Skip them rather than render a useless "Unknown" thread.
      if (!row.client_id) continue;

      let bucket = buckets.get(row.client_id);

      if (!bucket) {
        // New client_id. Before creating a fresh thread, see if this person
        // already has one under a different client record (same phone, email,
        // whatsapp or instagram). If so, fold this client_id into it.
        const keys = identityKeys(row.clients);
        for (const k of keys) {
          const existing = identityToBucket.get(k);
          if (existing) { bucket = existing; break; }
        }
        if (bucket) {
          // Map this duplicate client_id at it so its later rows land here too.
          buckets.set(row.client_id, bucket);
          bucket.client_ids.add(row.client_id);
        } else {
          bucket = {
            // Represent the thread by the most recent message's client_id, so
            // opening it lands on the record the client last used.
            client_id: row.client_id,
            client_ids: new Set([row.client_id]),
            client_first_name: row.clients?.first_name || 'Client',
            client_last_name: row.clients?.last_name || '',
            client_avatar_url: null, // no avatar column; UI shows the initial
            last_message_preview: rowPreview(row),
            last_message_at: row.created_at,
            last_message_direction: row.direction,
            last_message_type: messageType(row),
            last_channel: row.channel,
            unread_count: 0,
            needs_attention: false,
            last_inbound_intent: null,
            // The client's own most recent words. On a thread that is waiting
            // on her, this is what she needs to answer, even if Florrie spoke
            // last. Filled from the newest inbound row with usable text.
            last_inbound_preview: null,
            last_inbound_at: null,
            // Florrie's suggested reply for the newest inbound she escalated.
            // Carried on the thread so the messages page can show the answer
            // and send it WITHOUT Ellie opening the conversation. That one
            // change is what turns the page from a list into something she can
            // clear between clients.
            draft_reply: null,
            draft_message_id: null,
            // The @handle, so she recognises an Instagram thread by the name
            // she actually knows. Null on every other channel, and null on
            // Instagram until her token is reconnected.
            instagram_username: row.clients?.instagram_username || null,
            _hasInboundText: false,
            // Scaffolding for segment(), all stripped before the response.
            _inbound: 0,
            _junkInbound: 0,
            _hasIdentity: false,
            _instagramOnly: true,
          };
          buckets.set(row.client_id, bucket);
          for (const k of keys) identityToBucket.set(k, bucket);
        }
      }

      // A handle can turn up on a later duplicate client record than the one
      // that opened the bucket, so keep the first one we see either way.
      if (!bucket.instagram_username && row.clients?.instagram_username) {
        bucket.instagram_username = row.clients.instagram_username;
      }
      // Contact details she holds on file are what make someone a client
      // rather than a stranger who found her on Instagram.
      if (row.clients?.phone || row.clients?.email || row.clients?.whatsapp_id) {
        bucket._hasIdentity = true;
      }
      if (row.channel !== 'instagram') bucket._instagramOnly = false;

      // A thread only counts as junk when EVERY inbound message in it was
      // flagged. One real question anywhere in the conversation pulls the
      // whole thread back into the normal inbox, which is the safe direction.
      if (row.direction === 'inbound') {
        bucket._inbound += 1;
        if (row.is_junk) bucket._junkInbound += 1;
      }

      // Unread = inbound, not read, not resolved.
      if (row.direction === 'inbound' && !row.read_at && !row.resolved) {
        bucket.unread_count += 1;
      }
      // Newest-first: the first inbound we meet is the most recent one.
      if (row.direction === 'inbound' && bucket.last_inbound_intent === null) {
        bucket.last_inbound_intent = row.ai_intent || 'unknown';
        bucket.last_inbound_at = row.created_at;
      }
      // Latest inbound preview: prefer the newest inbound that actually has
      // text, so "Waiting on you" shows her the question, not a media stub.
      if (row.direction === 'inbound') {
        const text = previewOf(row.content);
        if (text && !bucket._hasInboundText) {
          bucket.last_inbound_preview = text;
          bucket._hasInboundText = true;
        } else if (!bucket.last_inbound_preview) {
          // No text yet anywhere; hold a media stub as a fallback.
          bucket.last_inbound_preview = rowPreview(row);
        }
      }
      // Latest-message preview: the first row set it via rowPreview (never
      // blank). If that was a media placeholder because the newest message had
      // no text, upgrade it to the newest row that DOES have text, so the row
      // reads as a real message rather than "Sent a photo" when avoidable.
      if (!bucket._lastTextLocked) {
        const text = previewOf(row.content);
        if (text) {
          bucket.last_message_preview = text;
          bucket._lastTextLocked = true;
        }
      }
      if (row.escalated && !row.resolved) {
        bucket.needs_attention = true;
        // Rows arrive newest-first, so the FIRST unresolved escalation we meet
        // is the live one. Its draft is what the card offers her to send, so
        // she can answer without opening the conversation at all.
        if (!bucket.draft_reply && row.ai_response) {
          bucket.draft_reply = row.ai_response;
          bucket.draft_message_id = row.id;
        }
      }
    }

    // Guarantee no blank preview survives.
    for (const bucket of new Set(buckets.values())) {
      if (!bucket.last_message_preview) {
        bucket.last_message_preview = bucket.last_inbound_preview || 'Sent a message';
      }
    }

    // De-dup: buckets.values() now contains each thread once per client_id key,
    // but folded duplicates share the SAME object. Collapse to unique objects.
    const threads = Array.from(new Set(buckets.values()))
      .sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at))
      .slice(0, limit);

    // Someone who has ever been in the chair is a client, whatever contact
    // details are on the record. Asked only for the threads we are actually
    // returning (at most 100 buckets), so it stays one small query. Fails
    // soft to an empty set: worst case a regular is labelled 'new' for one
    // page load, far better than the inbox failing to load at all.
    const idsInPlay = [];
    for (const t of threads) for (const id of t.client_ids) idsInPlay.push(id);
    const everBooked = (await clientsEverBooked(beauticianId, idsInPlay)) || new Set();

    for (const t of threads) {
      const isJunk = t._inbound > 0 && t._junkInbound === t._inbound;
      const isKnownClient = t._hasIdentity
        || Array.from(t.client_ids).some((id) => everBooked.has(id));

      t.is_junk = isJunk;
      // Surfaced so the card can say "Regular" or "New" from evidence rather
      // than guessing off whether a name happens to be on file. A one-time
      // named client is NOT a regular, and a webhook stranger with a real
      // profile name is not a returning one.
      t.is_known_client = isKnownClient;
      t.segment = segmentOf(t, {
        isJunk,
        isKnownClient,
        instagramOnly: t._instagramOnly && !isKnownClient,
      });

      // The two-space split, decided HERE so the page, the badge and
      // clear-social all read one answer. A relationship of any kind puts the
      // thread in Clients; only a stranger who exists purely as an Instagram
      // DM lands in the Instagram space, and within that space is_social_lead
      // marks the handful with actual buying intent.
      const igStranger = t._instagramOnly && !isKnownClient;
      t.space = igStranger ? 'instagram' : 'clients';
      t.is_social_lead = igStranger && isSocialLead({
        content: t.last_inbound_preview,
        intent: t.last_inbound_intent,
        isJunk,
      });

      // Kept (as a plain array) for clear-social; /threads strips it.
      t.client_ids = Array.from(t.client_ids);
      delete t._hasInboundText;
      delete t._lastTextLocked;
      delete t._inbound;
      delete t._junkInbound;
      delete t._hasIdentity;
      delete t._instagramOnly;
    }

    return { threads };
}

router.get('/threads', requireAuth, async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));

  try {
    const result = await computeThreads(req.beautician.id, limit);
    if (result.error) return res.status(500).json({ error: 'Failed to load threads' });

    const threads = result.threads;
    for (const t of threads) delete t.client_ids;
    res.json({ threads, count: threads.length });
  } catch (err) {
    logger.error({ err }, 'inbox.threads threw');
    res.status(500).json({ error: 'Failed to load threads' });
  }
});

/**
 * POST /api/inbox/clear-social
 *
 * The one-tap "Clear all" under the Instagram space. Bulk-resolves the
 * non-lead pile (compliments, story replies, sign-offs, junk) so Ellie never
 * has to work through it thread by thread.
 *
 * Guard rails, in order of importance:
 *   - targets come from the SAME computeThreads buckets the page renders, so
 *     it can only touch threads in the 'instagram' space that are NOT leads
 *   - a lead, or anyone with a booking or contact details on file, can never
 *     be swept up, because those threads are never in that pile
 *   - every write is scoped to this beautician
 */
router.post('/clear-social', requireAuth, async (req, res) => {
  try {
    // THREAD_FETCH_CAP as the limit: clear the whole pile, not just the page
    // the UI happens to be showing.
    const result = await computeThreads(req.beautician.id, THREAD_FETCH_CAP);
    if (result.error) return res.status(500).json({ error: 'Could not load conversations' });

    const targets = result.threads.filter(t => t.space === 'instagram' && !t.is_social_lead);
    const clientIds = [];
    for (const t of targets) for (const id of t.client_ids || []) clientIds.push(id);

    if (!clientIds.length) return res.json({ cleared: 0, messages_resolved: 0 });

    const nowIso = new Date().toISOString();
    const { data: resolvedRows, error } = await supabase
      .from('messages')
      .update({ resolved: true, resolved_at: nowIso })
      .eq('beautician_id', req.beautician.id)
      .in('client_id', clientIds)
      .eq('escalated', true)
      .eq('resolved', false)
      .select('id');

    if (error) {
      logger.error({ err: error }, 'inbox.clearSocial resolve failed');
      return res.status(500).json({ error: 'Could not clear those messages' });
    }

    // Also mark their unread inbound as read, so the pile stops feeding the
    // unread badges. Fail-soft: the resolve above is the part that matters.
    const { error: readErr } = await supabase
      .from('messages')
      .update({ read_at: nowIso })
      .eq('beautician_id', req.beautician.id)
      .in('client_id', clientIds)
      .eq('direction', 'inbound')
      .is('read_at', null);
    if (readErr) logger.warn({ err: readErr }, 'inbox.clearSocial mark-read failed');

    res.json({ cleared: targets.length, messages_resolved: (resolvedRows || []).length });
  } catch (err) {
    logger.error({ err }, 'inbox.clearSocial threw');
    res.status(500).json({ error: 'Could not clear those messages' });
  }
});

/**
 * GET /api/inbox/thread/:client_id
 *
 * Returns the last 200 messages for this client, oldest first so the UI
 * can append-render straight into the DOM. Gated on tenancy: a beautician
 * can only see their own clients' messages.
 */
router.get('/thread/:client_id', requireAuth, async (req, res) => {
  const clientId = req.params.client_id;
  if (!clientId) return res.status(400).json({ error: 'client_id required' });

  try {
    // Verify the client belongs to this beautician first. Cheap query.
    // select('*') rather than a column list on purpose: instagram_username
    // only exists once migration 016 is applied, and naming it explicitly
    // would 400 the whole thread view until then.
    const { data: client, error: cErr } = await supabase
      .from('clients')
      .select('*')
      .eq('id', clientId)
      .eq('beautician_id', req.beautician.id)
      .maybeSingle();

    if (cErr) {
      logger.error({ err: cErr }, 'inbox.thread client lookup failed');
      return res.status(500).json({ error: 'Lookup failed' });
    }
    if (!client) return res.status(404).json({ error: 'Client not found' });

    // Messages + client meta + pending drafts in parallel. The meta powers the
    // client-card header (visits, last in, next booked); the drafts render
    // inline in the thread as dashed bubbles with Send / Edit / Bin.
    const [msgRes, apptRes, draftRes] = await Promise.all([
      supabase
        .from('messages')
        .select(`
          id, client_id, channel, direction, content, created_at,
          ai_handled, media_url, media_type,
          external_message_id, whatsapp_message_id,
          escalated, escalated_reason, resolved, digital_employee, ai_intent,
          delivered_at, read_at, send_status
        `)
        .eq('beautician_id', req.beautician.id)
        .eq('client_id', clientId)
        .order('created_at', { ascending: false })
        .limit(THREAD_MESSAGE_LIMIT),
      supabase
        .from('appointments')
        .select('id, starts_at, status')
        .eq('beautician_id', req.beautician.id)
        .eq('client_id', clientId)
        .order('starts_at', { ascending: false })
        .limit(300),
      supabase
        .from('outbound_sends')
        .select('id, body, channel, message_type, created_at, reason')
        .eq('beautician_id', req.beautician.id)
        .eq('client_id', clientId)
        .eq('status', 'pending_approval')
        .order('created_at', { ascending: true })
        .limit(10),
    ]);
    const { data, error } = msgRes;

    if (error) {
      logger.error({ err: error }, 'inbox.thread supabase failed');
      return res.status(500).json({ error: 'Failed to load thread' });
    }

    // Opening the thread = reading it. Clear the unread flag on this client's
    // inbound messages so the inbox badge / notification drops. Fire-and-forget
    // so it never delays or fails the read.
    supabase
      .from('messages')
      .update({ read_at: new Date().toISOString() })
      .eq('beautician_id', req.beautician.id)
      .eq('client_id', clientId)
      .eq('direction', 'inbound')
      .is('read_at', null)
      .then(() => {}, (err) => logger.warn({ err }, 'inbox.thread mark-read failed'));

    // WHAT FLORRIE ACTUALLY DID, attached to the message that claimed it.
    //
    // On 26 August a client was told "i'll send you a new one now" and nothing
    // was sent, because nothing in the reply path could send anything. Ellie's
    // question was "How will I know if it actioned this?" and the honest
    // answer was that she could not: the only evidence anything happened, or
    // failed to happen, is an ai_actions row, and the thread never showed it.
    //
    // ONE query for the whole thread, keyed on message_id, not one per
    // message: a 200-message thread would otherwise be 200 round trips.
    // `ok` is the plain reading the UI needs -- true when the action completed,
    // false when it was attempted and did not. A failed resend has to be as
    // visible as a successful one, because a silent failure here is the exact
    // bug being fixed.
    const messageIds = (data || []).map(m => m.id).filter(Boolean);
    const actionsByMessage = new Map();
    if (messageIds.length) {
      const { data: actionRows, error: actErr } = await supabase
        .from('ai_actions')
        .select('id, action_type, summary, created_at, outcome, message_id')
        .eq('beautician_id', req.beautician.id)
        .in('message_id', messageIds)
        .order('created_at', { ascending: true });
      if (actErr) {
        // Never 500 the thread over the action strip. An inbox that will not
        // open is worse than an inbox with no badges on it.
        logger.warn({ err: actErr }, 'inbox.thread actions lookup failed, rendering without them');
      } else {
        for (const a of actionRows || []) {
          if (!a?.message_id) continue;
          if (!actionsByMessage.has(a.message_id)) actionsByMessage.set(a.message_id, []);
          actionsByMessage.get(a.message_id).push({
            id: a.id,
            action_type: a.action_type,
            summary: a.summary,
            created_at: a.created_at,
            ok: a.outcome === 'success',
          });
        }
      }
    }

    // Re-sort ascending (we queried desc + limit to get the most recent N,
    // then flip for display).
    const messages = (data || [])
      .slice()
      .reverse()
      .map((row) => ({
        ...shapeMessage(row),
        message_type: messageType(row),
        digital_employee: row.digital_employee || null,
        escalated_reason: row.escalated && !row.resolved ? (row.escalated_reason || null) : null,
        // Always an array. The frontend renders straight off it, so a message
        // with nothing logged against it must not be undefined.
        actions: actionsByMessage.get(row.id) || [],
      }));

    // Compute the default channel the UI should preselect: the channel of
    // the most recent inbound message, falling back to the client's
    // preferred channel implied by which contact info exists.
    const lastInbound = data?.find(m => m.direction === 'inbound');
    // Instagram goes at the HEAD of the fallback chain. 31 August 2026: an
    // Instagram-only client has no whatsapp_id and often no phone at all, and
    // this chain ended at 'sms' for her, so the composer preselected a channel
    // there was no way to reach her on. The chain only runs when there is no
    // inbound message to read a channel off, which is exactly the case where
    // the contact details on file are all we have.
    const defaultChannel =
      lastInbound?.channel
      || (client.instagram_id ? 'instagram'
        : client.whatsapp_id ? 'whatsapp'
        : client.phone ? 'sms'
        : client.email ? 'email'
        : 'sms');

    // Visits meta. starts_at is SALON WALL TIME in the UTC slot - compare on
    // the ISO string against "now" rendered in the same convention, never
    // through timezone conversion.
    const appts = apptRes.data || [];
    const nowIso = new Date().toISOString();
    const completed = appts.filter(a => a.status === 'completed');
    const upcoming = appts
      .filter(a => a.starts_at > nowIso && !['cancelled', 'no_show'].includes(a.status))
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at));

    res.json({
      client: {
        id: client.id,
        first_name: client.first_name,
        last_name: client.last_name || '',
        has_phone: !!client.phone,
        has_email: !!client.email,
        has_whatsapp: !!(client.whatsapp_id || client.phone),
        has_instagram: !!client.instagram_id,
        instagram_username: client.instagram_username || null,
        messaging_autonomy: client.messaging_autonomy || null,
      },
      meta: {
        visits: completed.length,
        last_visit_at: completed.length ? completed[0].starts_at : null,
        next_appointment_at: upcoming.length ? upcoming[0].starts_at : null,
      },
      drafts: draftRes.data || [],
      default_channel: defaultChannel,
      messages,
      count: messages.length,
    });
  } catch (err) {
    logger.error({ err }, 'inbox.thread threw');
    res.status(500).json({ error: 'Failed to load thread' });
  }
});

/**
 * POST /api/inbox/send
 * Body: { client_id, channel, body }
 *
 * One endpoint, three transports. The unified Inbox uses this for every
 * reply, regardless of which channel the conversation started on.
 */
router.post('/send', requireAuth, async (req, res) => {
  const { client_id, channel, body, draft_text } = req.body || {};

  // THE ONLY RELIABLE SOURCE OF HER OWN WRITING.
  // The inbox already knows whether it handed her a Florrie draft, so this is
  // measured rather than assumed: send the draft untouched and it is Florrie's
  // message, rewrite it and it is hers, and the middle band (she moved a few
  // words) counts as Florrie's too. Learning her voice from a lightly edited
  // machine draft is how the system taught itself to sound like itself.
  const authoredBy = authorshipForSend({ draft: draft_text, sent: body });

  const result = await sendOnChannel({
    beautician: req.beautician,
    clientId: client_id,
    channel,
    body,
    authoredBy,
  });

  if (!result.ok) {
    // Delivery failed but the message was still saved to the thread: return it
    // (200) with delivered:false so the UI keeps the bubble and flags it, rather
    // than the message vanishing.
    if (result.delivery_failure && result.message) {
      return res.status(200).json({
        ok: false,
        delivered: false,
        message: result.message,
        error: result.error,
        outside_window: result.outside_window || undefined,
      });
    }
    return res.status(result.status || 400).json({
      error: result.error,
      meta_code: result.meta_code,
      outside_window: result.outside_window || undefined,
    });
  }

  // Voice-moat metric: if this reply started life as a Florrie draft, record
  // how much of it survived. Fire and forget, never blocks the send.
  recordVoiceMetric({ beauticianId: req.beautician.id, clientId: client_id, draft: draft_text, sent: body });

  res.json({ ok: true, message: result.message });
});

/** Normalised Levenshtein similarity, 0..1. Texts capped to keep it cheap. */
function textSimilarity(a, b) {
  const x = String(a).trim().slice(0, 600);
  const y = String(b).trim().slice(0, 600);
  if (x === y) return 1;
  if (!x.length || !y.length) return 0;
  const m = x.length, n = y.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

async function recordVoiceMetric({ beauticianId, clientId, draft, sent }) {
  try {
    if (!draft || !sent) return;
    const similarity = textSimilarity(draft, sent);
    await supabase.from('voice_metrics').insert({
      beautician_id: beauticianId,
      client_id: clientId || null,
      draft_text: String(draft).slice(0, 2000),
      sent_text: String(sent).slice(0, 2000),
      similarity,
      untouched: similarity >= 0.98,
    });
  } catch (err) {
    logger.warn({ err }, 'voice metric insert failed');
  }
}

/**
 * GET /api/inbox/suggestions/:client_id
 * 3 tap-to-send candidate replies for the latest inbound message. Fails soft
 * (returns an empty list) so the Inbox never breaks if generation hiccups.
 */
router.get('/suggestions/:client_id', requireAuth, async (req, res) => {
  const clientId = req.params.client_id;
  if (!clientId) return res.status(400).json({ error: 'client_id required' });
  try {
    const { data: client } = await supabase
      .from('clients')
      .select('*')
      .eq('id', clientId)
      .eq('beautician_id', req.beautician.id)
      .maybeSingle();
    if (!client) return res.status(404).json({ error: 'client not found' });

    const { data: lastInbound } = await supabase
      .from('messages')
      .select('content, created_at')
      .eq('client_id', clientId)
      .eq('beautician_id', req.beautician.id)
      .eq('direction', 'inbound')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!lastInbound?.content) return res.json({ suggestions: [] });

    const suggestions = await generateReplySuggestions(req.beautician, client, lastInbound.content);
    res.json({ suggestions });
  } catch (err) {
    logger.warn({ err, clientId }, 'inbox.suggestions failed');
    res.json({ suggestions: [] });
  }
});


// DELETE /api/inbox/thread/:client_id
// Remove an entire conversation from the inbox (declutter). Threads are derived
// from the messages table, so deleting this client's messages removes the thread.
router.delete('/thread/:client_id', requireAuth, async (req, res) => {
  const { client_id } = req.params;
  try {
    const { error } = await supabase
      .from('messages')
      .delete()
      .eq('beautician_id', req.beautician.id)
      .eq('client_id', client_id);
    if (error) {
      logger.error({ err: error, client_id }, 'inbox.deleteThread failed');
      return res.status(500).json({ error: 'Failed to delete conversation' });
    }
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'inbox.deleteThread unexpected');
    res.status(500).json({ error: 'Something went wrong' });
  }
});


export default router;
