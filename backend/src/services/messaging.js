/**
 * Unified messaging service. Day 2 of the 2026-05-28 refactor sprint.
 *
 * The Inbox UI thinks in terms of clients, not channels. This module is the
 * one place that knows how to physically push a message out via WhatsApp,
 * SMS, or email, given a beautician + client + channel + body. The inbox
 * route calls sendOnChannel() and gets back a normalised result.
 *
 * Existing channel-specific endpoints (POST /api/notifications/send-sms,
 * /send-email, /api/whatsapp/test-send) still work and keep their own
 * insert-into-messages logic. This module is additive.
 */
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { AUTHOR } from '../lib/idiolect.js';
import { sendSMS, sendEmail } from './notifications.js';
import { authorship } from '../lib/authorship.js';

const WA_TOKEN = process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
const API_VER = process.env.WHATSAPP_API_VERSION || 'v21.0';
const GRAPH = `https://graph.facebook.com/${API_VER}`;

/**
 * Send a free-form WhatsApp text message from a beautician's connected
 * WABA number to a client's WhatsApp-capable phone. Only works inside the
 * 24h customer-service window. Outside the window, Meta returns code
 * 131047 and you must use an approved template instead.
 *
 * Returns { ok, message_id, error }.
 */
async function sendWhatsAppText({ beautician, recipientPhone, body }) {
  if (!WA_TOKEN) return { ok: false, error: 'WhatsApp not configured on server' };
  if (!beautician?.whatsapp_phone_id) return { ok: false, error: 'WhatsApp not connected' };

  const cleanTo = String(recipientPhone || '').replace(/[^0-9]/g, '');
  if (!cleanTo) return { ok: false, error: 'Client has no WhatsApp number' };

  try {
    const res = await fetch(`${GRAPH}/${beautician.whatsapp_phone_id}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WA_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: cleanTo,
        type: 'text',
        text: { body },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = data?.error;
      const isWindow = err?.code === 131047 || /24 hour|outside.*window|re-engagement/i.test(err?.message || '');
      return {
        ok: false,
        error: isWindow
          ? 'Outside the 24h WhatsApp window. Send an approved template or switch channels.'
          : (err?.error_user_msg || err?.message || 'WhatsApp rejected the send'),
        meta_code: err?.code,
        outside_window: isWindow,
      };
    }
    return { ok: true, message_id: data?.messages?.[0]?.id || null };
  } catch (err) {
    logger.error({ err }, 'sendWhatsAppText threw');
    return { ok: false, error: 'WhatsApp send failed' };
  }
}

/**
 * Send a free-form Instagram DM reply from a beautician's connected
 * Instagram account to a client, via the Instagram Login flow
 * (graph.instagram.com with the beautician's own long-lived token).
 * Mirrors sendInstagramReply in routes/instagram-webhooks.js. Only works
 * inside Instagram's messaging window.
 *
 * Returns { ok, message_id, error }.
 */
async function sendInstagramText({ token, recipientId, body }) {
  if (!token) return { ok: false, error: 'Instagram not connected' };
  if (!recipientId) return { ok: false, error: 'Client has no Instagram on file' };

  try {
    // Match the auth form that is already proven in production for Florrie's
    // auto-replies (sendInstagramReply): bearer token in the header, no token
    // in the body. Keeps the manual-reply path identical to the working one.
    const res = await fetch('https://graph.instagram.com/v21.0/me/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text: body },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = data?.error;
      return { ok: false, error: err?.error_user_msg || err?.message || 'Instagram rejected the send' };
    }
    return { ok: true, message_id: data?.message_id || null };
  } catch (err) {
    logger.error({ err }, 'sendInstagramText threw');
    return { ok: false, error: 'Instagram send failed' };
  }
}

/**
 * Single entry point used by the unified Inbox. Validates the client
 * belongs to the beautician, routes to the right transport, and writes a
 * row into the messages table on success. Returns the inserted message
 * row (or an error envelope).
 */
/**
 * @param {string} [authoredBy] whose words these are, from lib/idiolect.js
 *        AUTHOR. Defaults to 'system', which is the safe direction: this
 *        function is called by the inbox (her), the outbox approvals
 *        (Florrie's drafts) and the auto-cancel notice (canned copy), and a
 *        caller that forgets to say must not have its text mistaken for hers
 *        and fed back into the voice profile. That mistake is the bug this
 *        parameter exists to end.
 */
export async function sendOnChannel({ beautician, clientId, channel, body, authoredBy = AUTHOR.SYSTEM }) {
  if (!beautician?.id) return { ok: false, status: 401, error: 'Missing beautician' };
  if (!clientId) return { ok: false, status: 400, error: 'client_id required' };
  if (!['whatsapp', 'sms', 'email', 'instagram'].includes(channel)) {
    return { ok: false, status: 400, error: 'channel must be whatsapp, sms, email, or instagram' };
  }
  const trimmed = String(body || '').trim();
  if (!trimmed) return { ok: false, status: 400, error: 'Message body required' };

  // Pull the client and confirm tenancy in one shot.
  const { data: client, error: clientErr } = await supabase
    .from('clients')
    .select('id, first_name, last_name, phone, email, whatsapp_id, instagram_id')
    .eq('id', clientId)
    .eq('beautician_id', beautician.id)
    .maybeSingle();

  if (clientErr) {
    logger.error({ err: clientErr }, 'sendOnChannel client lookup failed');
    return { ok: false, status: 500, error: 'Lookup failed' };
  }
  if (!client) return { ok: false, status: 404, error: 'Client not found' };

  let result = { ok: false, error: 'Unknown channel' };
  let extId = null;
  let outsideWindow = false;

  if (channel === 'whatsapp') {
    const target = client.whatsapp_id || client.phone;
    if (!target) {
      return { ok: false, status: 400, error: 'Client has no WhatsApp number on file' };
    }
    const wa = await sendWhatsAppText({ beautician, recipientPhone: target, body: trimmed });
    result = wa;
    extId = wa.message_id;
    outsideWindow = !!wa.outside_window;
  } else if (channel === 'sms') {
    if (!client.phone) {
      return { ok: false, status: 400, error: 'Client has no phone number on file' };
    }
    const sms = await sendSMS({
      to: client.phone,
      body: trimmed,
      beauticianId: beautician.id,
    });
    result = sms ? { ok: true, message_id: sms?.id || sms?.sid || null } : { ok: false, error: 'SMS send failed' };
    extId = result.message_id;
  } else if (channel === 'email') {
    if (!client.email) {
      return { ok: false, status: 400, error: 'Client has no email on file' };
    }
    const email = await sendEmail({
      to: client.email,
      subject: `Message from ${beautician.business_name || beautician.first_name || 'your beautician'}`,
      text: trimmed,
    });
    result = email ? { ok: true, message_id: email?.id || null } : { ok: false, error: 'Email send failed' };
    extId = result.message_id;
  } else if (channel === 'instagram') {
    if (!client.instagram_id) {
      return { ok: false, status: 400, error: 'Client has no Instagram on file' };
    }
    // beautician passed by the caller may not carry the page token; fetch it.
    let igToken = beautician.instagram_page_token;
    if (!igToken) {
      const { data: b } = await supabase
        .from('beauticians')
        .select('instagram_page_token')
        .eq('id', beautician.id)
        .single();
      igToken = b?.instagram_page_token || null;
    }
    const ig = await sendInstagramText({ token: igToken, recipientId: client.instagram_id, body: trimmed });
    result = ig;
    extId = ig.message_id;
  }

  if (!result.ok) {
    // Persist the outbound anyway so Ellie's message is never lost from the
    // thread just because delivery hiccuped (WhatsApp window closed, SMS down).
    // Marked 'failed' so the UI can flag it and offer a retry.
    let failMessage = null;
    try {
      const { data: fr } = await supabase
        .from('messages')
        .insert({ beautician_id: beautician.id, client_id: client.id, direction: 'outbound', channel, content: trimmed, send_status: 'failed', ...authorship(authoredBy) })
        .select('id, beautician_id, client_id, channel, direction, content, created_at, ai_handled, media_url, media_type, external_message_id, whatsapp_message_id, delivered_at, read_at, send_status')
        .single();
      failMessage = shapeMessage(fr);
    } catch (e) { logger.warn({ err: e }, 'failed-send persist failed'); }
    return {
      ok: false,
      status: result.outside_window ? 409 : 400,
      error: result.error || 'Send failed',
      meta_code: result.meta_code,
      outside_window: outsideWindow,
      delivery_failure: true,
      message: failMessage,
    };
  }

  // Insert the outbound row so the conversation reflects the send.
  const insert = {
    beautician_id: beautician.id,
    client_id: client.id,
    direction: 'outbound',
    channel,
    content: trimmed,
    ...authorship(authoredBy),
  };
  if (channel === 'whatsapp' && extId) insert.whatsapp_message_id = extId;
  if (extId) insert.external_message_id = extId;

  const { data: row, error: insertErr } = await supabase
    .from('messages')
    .insert(insert)
    .select('id, beautician_id, client_id, channel, direction, content, created_at, ai_handled, media_url, media_type, external_message_id, whatsapp_message_id, delivered_at, read_at, send_status')
    .single();

  if (insertErr) {
    logger.warn({ err: insertErr }, 'sendOnChannel: send succeeded but DB insert failed');
    // We don't want to surface this as a failure to the user, because the
    // message did go out. Return a shape that mimics a row.
    return {
      ok: true,
      message: {
        id: `tmp-${Date.now()}`,
        client_id: client.id,
        channel,
        direction: 'outbound',
        body: trimmed,
        created_at: new Date().toISOString(),
        status: 'sent',
        ai_generated: false,
        image_url: null,
      },
    };
  }

  return { ok: true, message: shapeMessage(row) };
}

/**
 * Convert a raw messages row into the lightweight shape the inbox UI
 * expects. Keeps the channel-icon mapping in one place.
 */
export function shapeMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    client_id: row.client_id,
    channel: row.channel,
    direction: row.direction,
    body: row.content,
    created_at: row.created_at,
    status: row.send_status === 'failed' ? 'failed' : row.read_at ? 'read' : row.delivered_at ? 'delivered' : 'sent',
    ai_generated: !!row.ai_handled,
    image_url: row.media_type === 'image' ? row.media_url : null,
    media_type: row.media_type || null,
  };
}
