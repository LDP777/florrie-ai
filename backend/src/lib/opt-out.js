/**
 * STOP, in one place.
 *
 * 31 August 2026. Instagram was connected for the first time that night
 * (@ellindigo), and the first thing the connection exposed was that STOP only
 * worked on one of the four ways a message can arrive.
 *
 * The check lived inside processInboundMessage in services/ai-front-desk.js,
 * which is the ONLY caller that ever ran it. Instagram's two quiet modes,
 * `redirect` and `off`, both return from processInstagramDM long before the
 * front desk is reached (routes/instagram-webhooks.js), so a client who
 * replied STOP to the "message me on WhatsApp" auto-reply kept
 * marketing_consent true and marketing_opted_out_at null forever, and the
 * outbound guard, which fails closed on marketing_opted_out_at and nothing
 * else, kept letting marketing through to her.
 *
 * PECR does not care which webhook the word arrived on. So the recogniser and
 * the write live here, and every inbound path calls them.
 */
import { supabase } from '../config.js';
import logger from './logger.js';

// Deliberately narrow: the whole message, nothing else. "stop by on Friday?"
// and "can you stop the reminders about my brows and also book me in" are not
// opt-outs, they are messages that need reading.
const OPT_OUT_RE = /^\s*(stop|unsubscribe|opt\s?-?out)\s*[.!]*\s*$/i;

/** Is this whole message the word STOP (or one of its cousins)? */
export function isOptOutMessage(text) {
  return OPT_OUT_RE.test(String(text || ''));
}

/**
 * What Florrie says back. Service messages keep flowing, which is both true
 * and the thing a client most wants to know before she taps send.
 */
export const OPT_OUT_CONFIRMATION =
  "No problem, you won't get any more promotional messages from us. Booking confirmations and reminders still come through. Reply here anytime to book.";

/**
 * Record the opt-out: the consent columns, then the activity row.
 *
 * Returns true when the client row was actually updated. The write is the part
 * that matters, so its error is read and logged rather than swallowed: an
 * opt-out that silently failed to save is the same defect as one that was
 * never checked for.
 *
 * The ai_actions row is best effort. Losing the activity entry costs a line in
 * a feed; losing the consent write costs a complaint to the ICO.
 */
export async function applyOptOut({ beautician, client }) {
  const clientId = client?.id;
  if (!clientId) {
    logger.warn({ beauticianId: beautician?.id }, 'Opt-out received from a sender with no client row; nothing to mark');
    return false;
  }

  const { error } = await supabase.from('clients').update({
    marketing_consent: false,
    marketing_opted_out_at: new Date().toISOString(),
  }).eq('id', clientId);

  if (error) {
    logger.error({ err: error, clientId, beauticianId: beautician?.id },
      'Could not record a marketing opt-out. This client will keep receiving marketing until it is fixed by hand.');
    return false;
  }

  try {
    await supabase.from('ai_actions').insert({
      beautician_id: beautician.id,
      client_id: clientId,
      action_type: 'marketing_opt_out',
      digital_employee: 'front_desk',
      summary: `${client?.first_name || 'A client'} opted out of marketing messages, I've stopped offers and nudges to them`,
      confidence: 1.0,
      autonomous: true,
      outcome: 'success',
      notification_sent: false,
    });
  } catch (logErr) {
    logger.warn({ err: logErr, clientId }, 'opt-out ai_action insert failed');
  }

  return true;
}
