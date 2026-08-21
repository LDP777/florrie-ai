/**
 * Close the escalations that are no longer anybody's work.
 *
 * WHAT THE QUEUE ACTUALLY LOOKED LIKE, measured on 21 August:
 *
 *   237 escalations open
 *   221 of them with no reply from Florrie's side ever recorded
 *   107 of them more than THIRTY DAYS old
 *   14 of the last 177 inbound messages ever marked resolved
 *
 * A queue nobody works is not a safety mechanism. And this one was worse than
 * useless, because every row in it carries a draft reply and an approve
 * button: one tap on a five-week-old draft sends a client an answer to a
 * question she asked in July. The queue was not just noise, it was a loaded
 * gun pointed at Ellie's relationships.
 *
 * Most of the 221 were almost certainly answered — by Ellie, on her own phone,
 * in WhatsApp, where Florrie cannot see it. That is its own problem (see the
 * note at the bottom) but it does not change what to do here: a message from
 * last month is not today's decision either way.
 *
 * This is the same sweep outbound-expiry.js already does for proactive
 * messages, and the comment there describes this exact failure for a different
 * table — 103 pending approvals, oldest 15 days, badge permanently at 99+.
 * Nobody carried it across to messages.
 *
 * TWO RULES, and the first is the one that is unambiguously right:
 *
 *   MOVED ON  — something went out to that client after the escalation. The
 *               conversation continued; whatever this was, it is handled.
 *   TOO OLD   — past the window. Sending the draft now would be worse than
 *               not sending it, which is exactly the test outbound-expiry
 *               uses for a gap offer that names a slot.
 *
 * Deliberately NOT deleted, and the reason is rewritten rather than erased, so
 * the record of what was asked and what went unanswered survives.
 */
import { supabase } from '../config.js';
import logger from '../lib/logger.js';

/**
 * Seven days, matching outbound-expiry. A week is roughly the point at which
 * answering stops being late and starts being strange.
 */
export const ESCALATION_WINDOW_DAYS = 7;

export const escalationCutoff = (now = Date.now()) =>
  new Date(now - ESCALATION_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

/**
 * Which of these escalations has the thread already moved past?
 *
 * Pure, so the rule can be tested without a database. `lastOutboundByClient`
 * is the most recent outbound timestamp per client id.
 */
export function movedOn(escalations, lastOutboundByClient) {
  return (escalations || []).filter((m) => {
    if (!m.client_id) return false;
    const last = lastOutboundByClient[m.client_id];
    return !!last && last > m.created_at;
  });
}

export async function expireStaleEscalations() {
  const cutoff = escalationCutoff();
  let movedOnCount = 0;
  let tooOldCount = 0;

  try {
    // RULE 1, first, because it is the one with evidence behind it. Only the
    // rows still inside the window need checking; everything older is caught
    // by rule 2 anyway, and this keeps the query small.
    const { data: open, error: openErr } = await supabase
      .from('messages')
      .select('id, client_id, created_at')
      .eq('direction', 'inbound')
      .eq('escalated', true)
      .eq('resolved', false)
      .gte('created_at', cutoff)
      .limit(500);

    if (openErr) {
      logger.warn({ err: openErr }, 'escalation expiry: could not read open escalations');
    } else if (open?.length) {
      const clientIds = [...new Set(open.map(m => m.client_id).filter(Boolean))];
      const lastOutbound = {};
      if (clientIds.length) {
        const { data: outs, error: outErr } = await supabase
          .from('messages')
          .select('client_id, created_at')
          .eq('direction', 'outbound')
          .in('client_id', clientIds)
          .gte('created_at', cutoff)
          .order('created_at', { ascending: false })
          .limit(2000);
        // An unreadable outbound history means we cannot prove a thread moved
        // on. Prove nothing, close nothing — rule 2 still runs.
        if (outErr) logger.warn({ err: outErr }, 'escalation expiry: could not read outbound history');
        for (const o of outs || []) {
          if (!lastOutbound[o.client_id] || o.created_at > lastOutbound[o.client_id]) {
            lastOutbound[o.client_id] = o.created_at;
          }
        }
      }

      const done = movedOn(open, lastOutbound);
      if (done.length) {
        const { error: upErr } = await supabase
          .from('messages')
          .update({ resolved: true, resolved_at: new Date().toISOString(), escalated_reason: 'thread_moved_on' })
          .in('id', done.map(m => m.id));
        if (upErr) logger.warn({ err: upErr }, 'escalation expiry: moved-on update failed');
        else movedOnCount = done.length;
      }
    }

    // RULE 2. Anything past the window, whatever happened in the thread.
    const { data: aged, error: agedErr } = await supabase
      .from('messages')
      .update({ resolved: true, resolved_at: new Date().toISOString(), escalated_reason: 'too_old_to_answer' })
      .eq('direction', 'inbound')
      .eq('escalated', true)
      .eq('resolved', false)
      .lt('created_at', cutoff)
      .select('id');
    if (agedErr) logger.warn({ err: agedErr }, 'escalation expiry: age sweep failed');
    else tooOldCount = (aged || []).length;

    if (movedOnCount || tooOldCount) {
      logger.info({ movedOn: movedOnCount, tooOld: tooOldCount, windowDays: ESCALATION_WINDOW_DAYS },
        'Closed escalations that are no longer actionable');
    }
    return { movedOn: movedOnCount, tooOld: tooOldCount };
  } catch (err) {
    logger.warn({ err }, 'escalation expiry sweep threw');
    return { movedOn: movedOnCount, tooOld: tooOldCount };
  }
}

/**
 * THE THING THIS DOES NOT FIX, written down so it is not forgotten.
 *
 * 221 of the 237 open escalations had no outbound recorded after them, and
 * that is not because 221 clients were ignored. Ellie answers on her phone, in
 * WhatsApp, and those replies never reach this database — the webhook stores
 * inbound messages only. So Florrie cannot tell a handled thread from an
 * abandoned one, cannot stop nagging about something already dealt with, and
 * writes every draft without knowing what Ellie has already said in that
 * conversation.
 *
 * The fix is a Meta dashboard change: subscribe the app to `message_echoes` so
 * messages sent from the business number arrive as webhooks too. It cannot be
 * done from here, and until it is, rule 1 will keep under-counting.
 */
