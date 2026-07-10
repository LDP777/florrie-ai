import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';
import { sendOnChannel, shapeMessage } from '../services/messaging.js';
import { generateReplySuggestions } from '../services/ai-front-desk.js';

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

router.get('/threads', requireAuth, async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));

  try {
    const { data, error } = await supabase
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
        digital_employee,
        ai_intent,
        clients ( id, first_name, last_name, phone, email, whatsapp_id, instagram_id )
      `)
      .eq('beautician_id', req.beautician.id)
      .order('created_at', { ascending: false })
      .limit(THREAD_FETCH_CAP);

    if (error) {
      logger.error({ err: error }, 'inbox.threads supabase failed');
      return res.status(500).json({ error: 'Failed to load threads' });
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
            _hasInboundText: false,
          };
          buckets.set(row.client_id, bucket);
          for (const k of keys) identityToBucket.set(k, bucket);
        }
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
      }
    }

    // Clean up internal scaffolding and guarantee no blank preview survives.
    for (const bucket of new Set(buckets.values())) {
      if (!bucket.last_message_preview) {
        bucket.last_message_preview = bucket.last_inbound_preview || 'Sent a message';
      }
      delete bucket.client_ids;
      delete bucket._hasInboundText;
      delete bucket._lastTextLocked;
    }

    // De-dup: buckets.values() now contains each thread once per client_id key,
    // but folded duplicates share the SAME object. Collapse to unique objects.
    const threads = Array.from(new Set(buckets.values()))
      .sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at))
      .slice(0, limit);

    res.json({ threads, count: threads.length });
  } catch (err) {
    logger.error({ err }, 'inbox.threads threw');
    res.status(500).json({ error: 'Failed to load threads' });
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
    const { data: client, error: cErr } = await supabase
      .from('clients')
      .select('id, first_name, last_name, phone, email, whatsapp_id, instagram_id, messaging_autonomy')
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
      }));

    // Compute the default channel the UI should preselect: the channel of
    // the most recent inbound message, falling back to the client's
    // preferred channel implied by which contact info exists.
    const lastInbound = data?.find(m => m.direction === 'inbound');
    const defaultChannel =
      lastInbound?.channel
      || (client.whatsapp_id ? 'whatsapp' : client.phone ? 'sms' : client.email ? 'email' : 'sms');

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

  const result = await sendOnChannel({
    beautician: req.beautician,
    clientId: client_id,
    channel,
    body,
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
