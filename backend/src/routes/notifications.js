import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import {
  processReminders, sendSMS, sendEmail,
  readSmsRouting, smsSchema, splitLegacySmsOriginator,
  toInboundNumber, isSharedSmsNumber,
  BIRD_CHANNEL_ID_RE, SHARED_SMS_NUMBERS,
} from '../services/notifications.js';
import { getSMSUsage } from '../services/sms-metering.js';
import logger from '../lib/logger.js';
import { authorship } from '../lib/authorship.js';
import { requireCronKey } from '../middleware/security.js';

const router = Router();

/**
 * POST /api/notifications/process-reminders
 * Trigger the 24h reminder cron job.
 * Called by: Supabase Edge Function, external cron, or admin endpoint.
 * Protected by a simple API key (not user auth).
 *
 * requireCronKey fails CLOSED. The inline check it replaced was
 * `cronKey !== process.env.CRON_SECRET`, and with CRON_SECRET unset on the
 * server that is `undefined !== undefined`, so a request with no header at all
 * ran the reminder pass for every tenant. Anyone who knew the path could burn
 * the SMS allowance and re-text clients on demand.
 */
router.post('/process-reminders', requireCronKey, async (req, res) => {
  try {
    const result = await processReminders();
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error({ err }, 'Reminder processing error');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * POST /api/notifications/send-reminder
 * Generic reminder endpoint — used by Consultations (appointment reminders),
 * PatchTests (patch test reminders), and any future reminder types.
 * Looks up client by name or ID and sends via SMS.
 * Body: { type, client_name?, client_id?, message?, consultation_id?, treatment_name?, date?, time? }
 */
router.post('/send-reminder', requireAuth, async (req, res) => {
  try {
    const { type, client_name, client_id, message } = req.body;

    if (!type) {
      return res.status(400).json({ error: 'type is required' });
    }

    // Resolve client — by ID first, then by name
    let client = null;
    if (client_id) {
      const { data, error } = await supabase
        .from('clients')
        .select('id, phone, email, first_name')
        .eq('id', client_id)
        .eq('beautician_id', req.beautician.id)
        .single();
      if (!error) client = data;
    } else if (client_name) {
      const { data, error } = await supabase
        .from('clients')
        .select('id, phone, email, first_name')
        .eq('beautician_id', req.beautician.id)
        .ilike('first_name', client_name.split(' ')[0])
        .limit(1)
        .maybeSingle();
      if (!error) client = data;
    }

    // Build a default message if none provided
    const body = message || `Hi${client?.first_name ? ` ${client.first_name}` : ''}, this is a reminder from your beautician. Please get in touch to book in!`;

    // If we found a client with a phone, send the SMS
    if (client?.phone) {
      const result = await sendSMS({ to: client.phone, body, beauticianId: req.beautician.id });

      // Log the message. Read the error rather than reaching for .catch —
      // a Supabase query builder has none, so `.catch(() => {})` threw a
      // TypeError right here, AFTER the reminder text had gone, and the route
      // then reported a failure for a message the client had received.
      const { error: logErr } = await supabase.from('messages').insert({
        beautician_id: req.beautician.id,
        client_id: client.id,
        direction: 'outbound',
        channel: 'sms',
        content: body,
        // Reminder copy is assembled from a fixed shape a few lines above,
        // not typed by her.
        ...authorship('template'),
      });
      if (logErr) logger.warn({ err: logErr, clientId: client.id }, 'Reminder sent but not logged to the thread');

      return res.json({ success: !!result, channel: 'sms' });
    }

    // If we found a client with email but no phone, send email
    if (client?.email) {
      const result = await sendEmail({ to: client.email, subject: 'Reminder from your beautician', text: body });
      return res.json({ success: !!result, channel: 'email' });
    }

    // No contact info or client not found — log and return success (queued)
    logger.warn({ type, client_name, client_id }, 'Reminder requested but no contact info found');
    return res.json({ success: true, channel: 'queued', note: 'Client contact not found, reminder queued' });
  } catch (err) {
    logger.error({ err }, 'Unexpected error sending reminder');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * POST /api/notifications/send-sms
 * Send a manual SMS to a client. Used by campaign and rebook features.
 */
router.post('/send-sms', requireAuth, async (req, res) => {
  try {
    const { client_id, message } = req.body;

    if (!client_id || !message) {
      return res.status(400).json({ error: 'client_id and message required' });
    }

    // Get client phone
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('phone, first_name')
      .eq('id', client_id)
      .eq('beautician_id', req.beautician.id)
      .single();

    if (clientError) {
      logger.error({ err: clientError }, 'Failed to fetch client for SMS');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    if (!client?.phone) {
      return res.status(400).json({ error: 'Client has no phone number' });
    }

    const result = await sendSMS({ to: client.phone, body: message, beauticianId: req.beautician.id });

    // Log the message
    const { error: logError } = await supabase.from('messages').insert({
      beautician_id: req.beautician.id,
      client_id,
      direction: 'outbound',
      channel: 'sms',
      content: message,
      // She typed this into the app and pressed send. Training data.
      ...authorship('human'),
    });

    if (logError) {
      logger.warn({ err: logError }, 'Failed to log SMS message');
    }

    res.json({ success: !!result, sid: result?.sid, usageInfo: result?.usageInfo });
  } catch (err) {
    logger.error({ err }, 'Unexpected error sending SMS');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * POST /api/notifications/send-email
 * Send a manual email to a client.
 */
router.post('/send-email', requireAuth, async (req, res) => {
  try {
    const { client_id, subject, html, text } = req.body;

    if (!client_id || !subject) {
      return res.status(400).json({ error: 'client_id and subject required' });
    }

    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('email, first_name')
      .eq('id', client_id)
      .eq('beautician_id', req.beautician.id)
      .single();

    if (clientError) {
      logger.error({ err: clientError }, 'Failed to fetch client for email');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    if (!client?.email) {
      return res.status(400).json({ error: 'Client has no email' });
    }

    const result = await sendEmail({ to: client.email, subject, html, text });

    const { error: logError } = await supabase.from('messages').insert({
      beautician_id: req.beautician.id,
      client_id,
      direction: 'outbound',
      channel: 'email',
      content: text || subject,
      // Hers, but email is a different register from a text: lib/idiolect.js
      // measures length and sign off across everything she writes, so this is
      // recorded honestly and the channel mix is a known limitation.
      ...authorship('human'),
    });

    if (logError) {
      logger.warn({ err: logError }, 'Failed to log email message');
    }

    res.json({ success: !!result });
  } catch (err) {
    logger.error({ err }, 'Unexpected error sending email');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * GET /api/notifications/preferences
 * Get the beautician's notification preferences.
 */
router.get('/preferences', requireAuth, (req, res) => {
  res.json({
    notification_prefs: req.beautician.notification_prefs || {},
    client_reminder_prefs: req.beautician.client_reminder_prefs || {},
  });
});

/**
 * PATCH /api/notifications/preferences
 * Update notification preferences.
 */
router.patch('/preferences', requireAuth, async (req, res) => {
  const updates = {};
  if (req.body.notification_prefs) updates.notification_prefs = req.body.notification_prefs;
  if (req.body.client_reminder_prefs) updates.client_reminder_prefs = req.body.client_reminder_prefs;

  const { data, error } = await supabase
    .from('beauticians')
    .update(updates)
    .eq('id', req.beautician.id)
    .select('notification_prefs, client_reminder_prefs')
    .single();

  if (error) {
    logger.error({ err: error }, 'Failed to update notification preferences');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json(data);
});

/**
 * GET /api/sms/usage
 * Get current week's SMS usage stats for the authenticated beautician.
 */
router.get('/sms/usage', requireAuth, async (req, res) => {
  try {
    const usage = await getSMSUsage(req.beautician.id);
    if (!usage) {
      return res.status(500).json({ error: 'Failed to fetch SMS usage' });
    }
    res.json(usage);
  } catch (err) {
    logger.error({ err }, 'SMS usage fetch error');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * GET /api/sms/config
 * Get the SMS configuration for the authenticated beautician.
 *
 * Outbound sender and inbound routing number are now two separate things (see
 * the long note in services/notifications.js). This reports both, plus whether
 * the split columns exist yet, so the UI never has to guess a salon's 2-way
 * status from the shape of one string.
 */
router.get('/sms/config', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('beauticians')
      .select('sms_originator, sms_enabled, client_reminder_prefs')
      .eq('id', req.beautician.id)
      .maybeSingle();

    if (error) {
      logger.error({ err: error }, 'Failed to fetch SMS config');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    const routing = await readSmsRouting(req.beautician.id);

    // The display sender: the brand name that appears in copy. It is NOT what
    // Bird puts in the From field (that is the channel), and it is no longer
    // what inbound routes on.
    const displayName = routing.senderName || process.env.BIRD_ORIGINATOR || 'Florrie';
    const displaySource = routing.senderName
      ? 'beautician'
      : process.env.BIRD_ORIGINATOR ? 'platform' : 'default';

    res.json({
      // Kept under the old key: Settings, Messaging and Integrations all read
      // it as the sender name to show, and that is now all it means.
      sms_originator: displayName,
      sms_originator_source: displaySource,
      sms_channel_id: routing.channelId,
      sms_inbound_number: routing.inboundNumber,
      // The one thing the UI actually needs: can her clients reply to her?
      two_way: !!routing.inboundNumber,
      shared_sms_number: SHARED_SMS_NUMBERS[0] || null,
      schema_split: routing.split,
      sms_enabled: data?.sms_enabled || false,
      bird_configured: !!process.env.BIRD_API_KEY,
      channel: data?.client_reminder_prefs?.channel || 'whatsapp',
    });
  } catch (err) {
    logger.error({ err }, 'SMS config fetch error');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/** Nobody else may already hold this inbound number. */
async function inboundNumberIsFree(column, number, beauticianId) {
  const { data, error } = await supabase
    .from('beauticians')
    .select('id')
    .eq(column, number)
    .neq('id', beauticianId)
    .limit(1);
  // A failed check is not a pass. Refusing to save is recoverable; two salons
  // sharing an inbound number drops every inbound SMS for both of them.
  if (error) {
    logger.error({ err: error, column }, 'SMS inbound number uniqueness check failed');
    return false;
  }
  return (data || []).length === 0;
}

/**
 * PUT /api/sms/config
 * Update SMS configuration for the authenticated beautician.
 *
 * Body: {
 *   sms_inbound_number?: string|null,  the number clients text her on
 *   sms_channel_id?:     string|null,  her Bird channel id, for outbound
 *   sms_originator?:     string,       LEGACY: one field that meant all three.
 *                                      Still accepted and split, so older
 *                                      clients keep working.
 *   sms_enabled?: boolean, channel?: string
 * }
 */
router.put('/sms/config', requireAuth, async (req, res) => {
  try {
    const { sms_originator, sms_inbound_number, sms_channel_id, sms_enabled, channel } = req.body;

    // What the caller is asking for, whichever field shape it used.
    let wantInbound;      // string | null | undefined
    let wantChannel;      // string | null | undefined
    let wantName;         // string | undefined

    const clears = (v) => v === null || v === '';

    if (sms_inbound_number !== undefined) {
      if (clears(sms_inbound_number)) wantInbound = null;
      else if (typeof sms_inbound_number !== 'string') {
        return res.status(400).json({ error: 'sms_inbound_number must be a phone number or null' });
      } else {
        const number = toInboundNumber(sms_inbound_number);
        if (!number) {
          return res.status(400).json({ error: 'sms_inbound_number must be a mobile number in international format, e.g. +447700900123' });
        }
        if (isSharedSmsNumber(number)) {
          return res.status(400).json({
            error: 'That is the shared Florrie number, not yours. Every salon sends from it, so it cannot tell us whose client is replying. Leave the inbound number empty until you have bought your own Bird number.',
          });
        }
        wantInbound = number;
      }
    }

    if (sms_channel_id !== undefined) {
      if (clears(sms_channel_id)) wantChannel = null;
      else if (typeof sms_channel_id !== 'string' || !BIRD_CHANNEL_ID_RE.test(sms_channel_id.trim())) {
        return res.status(400).json({ error: 'sms_channel_id must be a Bird channel id (a UUID), or null' });
      } else wantChannel = sms_channel_id.trim();
    }

    // LEGACY single field. Split it the same way the migration does, so an old
    // client that posts a phone number here still ends up routing inbound, and
    // one that posts "Ellindigo" still ends up with a sender name.
    if (sms_originator !== undefined) {
      if (typeof sms_originator !== 'string' || sms_originator.trim().length === 0) {
        return res.status(400).json({ error: 'sms_originator must be a non-empty string' });
      }
      const trimmed = sms_originator.trim();
      const parts = splitLegacySmsOriginator(trimmed);
      if (parts.channelId && wantChannel === undefined) wantChannel = parts.channelId;
      else if (parts.inboundNumber && wantInbound === undefined) wantInbound = parts.inboundNumber;
      else if (parts.senderName) {
        if (parts.senderName.length > 11 || !/^[a-zA-Z0-9 ]+$/.test(parts.senderName)) {
          return res.status(400).json({
            error: 'sms_originator must be your own mobile number (e.g. +447700900123), a Bird channel id, or a sender name of up to 11 letters and numbers',
          });
        }
        wantName = parts.senderName;
      } else if (!parts.channelId && !parts.inboundNumber && isSharedSmsNumber(trimmed)) {
        // The onboarding default used to land here and take every tenant down.
        return res.status(400).json({
          error: 'That is the shared Florrie number, not yours. Every salon sends from it, so it cannot tell us whose client is replying. Leave the sender empty until you have bought your own Bird number.',
        });
      }
    }

    const schema = await smsSchema();
    const updates = {};
    const warnings = [];

    if (schema.inbound) {
      if (wantInbound !== undefined) updates.sms_inbound_number = wantInbound;
      if (schema.channel && wantChannel !== undefined) updates.sms_channel_id = wantChannel;
      if (wantName !== undefined) updates.sms_originator = wantName;
    } else {
      // BEFORE the split SQL runs there is one column, so one of the three can
      // be stored. Inbound routing wins: it is the direction that is broken.
      if (wantInbound !== undefined && wantInbound !== null) {
        updates.sms_originator = wantInbound;
        if (wantChannel) warnings.push('Your Bird channel id was not saved: this database still has a single sms_originator column and the inbound number needs it. Re-save once the SMS split migration has run.');
        if (wantName) warnings.push('Your sender name was not saved: the inbound number needs the one column that exists today.');
      } else if (wantChannel !== undefined && wantChannel !== null) {
        updates.sms_originator = wantChannel;
        if (wantName) warnings.push('Your sender name was not saved: the Bird channel id needs the one column that exists today.');
      } else if (wantName !== undefined) {
        updates.sms_originator = wantName;
      } else if (wantInbound === null || wantChannel === null) {
        updates.sms_originator = null;
      }
    }

    // Uniqueness. The DB index does not exist until the migration runs, so this
    // check is the only thing standing between two salons and a shared number.
    const inboundColumn = schema.inbound ? 'sms_inbound_number' : 'sms_originator';
    const inboundValue = schema.inbound ? updates.sms_inbound_number : updates.sms_originator;
    if (inboundValue && toInboundNumber(inboundValue)) {
      if (!await inboundNumberIsFree(inboundColumn, inboundValue, req.beautician.id)) {
        return res.status(409).json({
          error: 'Another salon already receives SMS on that number. Two salons cannot share one inbound number: the reply would not say whose client sent it, so both would lose every text.',
        });
      }
    }

    if (sms_enabled !== undefined) updates.sms_enabled = Boolean(sms_enabled);

    // If channel is being set, update it inside client_reminder_prefs JSONB
    if (channel !== undefined) {
      const { data: current } = await supabase
        .from('beauticians')
        .select('client_reminder_prefs')
        .eq('id', req.beautician.id)
        .maybeSingle();

      updates.client_reminder_prefs = {
        ...(current?.client_reminder_prefs || {}),
        channel,
      };
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    const { error } = await supabase
      .from('beauticians')
      .update(updates)
      .eq('id', req.beautician.id);

    if (error) {
      // 23505 is the unique index on sms_inbound_number, once it exists. It is
      // the same refusal as the 409 above, reached by the database instead.
      if (error.code === '23505') {
        return res.status(409).json({
          error: 'Another salon already receives SMS on that number. Two salons cannot share one inbound number.',
        });
      }
      logger.error({ err: error }, 'Failed to update SMS config');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    const routing = await readSmsRouting(req.beautician.id);
    const { data: after } = await supabase
      .from('beauticians')
      .select('sms_enabled, client_reminder_prefs')
      .eq('id', req.beautician.id)
      .maybeSingle();

    logger.info({ beauticianId: req.beautician.id, fields: Object.keys(updates) }, 'SMS config updated');
    res.json({
      success: true,
      sms_originator: routing.senderName || process.env.BIRD_ORIGINATOR || 'Florrie',
      sms_channel_id: routing.channelId,
      sms_inbound_number: routing.inboundNumber,
      two_way: !!routing.inboundNumber,
      schema_split: routing.split,
      sms_enabled: after?.sms_enabled || false,
      channel: after?.client_reminder_prefs?.channel || 'whatsapp',
      ...(warnings.length ? { warnings } : {}),
    });
  } catch (err) {
    logger.error({ err }, 'SMS config update error');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * POST /api/sms/test
 * Send a test SMS to the beautician's own phone to verify Bird is working.
 * Body: { phone: string }
 */
router.post('/sms/test', requireAuth, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone required' });

    if (!process.env.BIRD_API_KEY) {
      return res.status(503).json({ error: 'SMS not configured on this server' });
    }

    const result = await sendSMS({
      to: phone,
      body: `Florrie test message: SMS is working! Sent at ${new Date().toLocaleTimeString('en-GB')}.`,
      beauticianId: req.beautician.id,
    });

    if (!result) {
      return res.status(500).json({ error: 'SMS failed to send. Check the Bird API key and originator' });
    }

    res.json({ success: true, messageId: result.id });
  } catch (err) {
    logger.error({ err }, 'SMS test error');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

export default router;

// touch: redeploy to refresh DB schema cache after sms_originator/sms_enabled column add (2026-06-02)
