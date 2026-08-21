/**
 * Did the message actually arrive?
 *
 * The app has never known. Meta sends a delivery receipt for every message —
 * sent, delivered, read, failed — and the webhook threw all of them away on
 * one line:
 *
 *     return; // Not a message event (could be status update)
 *
 * So `send_status`, `delivered_at` and `read_at` have existed as columns since
 * the schema was written and have never held a value. Every confirmation,
 * every reminder, every reply Florrie sends is recorded as sent on the strength
 * of the API call returning 200, which only means Meta accepted it for
 * delivery.
 *
 * WHY IT MATTERS, and it is not a metrics nicety. On 21 August Lucy Walker
 * said "No I didn't" when asked whether she had received her booking link.
 * Ellie had no way to check, because there was nothing to check. The app said
 * the confirmation was sent, and the app would have said that whether Meta
 * delivered it, queued it for a phone that never came back online, or rejected
 * it outright. A confirmation nobody received is the single most expensive
 * failure this product has: the client turns up on the wrong day, or does not
 * turn up at all, and Ellie looks disorganised for something that was ours.
 *
 * A receipt is matched on the provider's message id, which is why
 * notifications.js now records it on the outbound row. Before that change
 * there was nothing to match against even if the receipts had been read.
 */
import { supabase } from '../config.js';
import logger from '../lib/logger.js';

/**
 * WhatsApp's status vocabulary, in the order a message moves through it.
 * Anything unrecognised is ignored rather than guessed at.
 */
const RANK = { sent: 1, delivered: 2, read: 3, failed: 4 };

/**
 * What a receipt changes on the row, or null if it changes nothing.
 *
 * MONOTONIC, deliberately. Receipts arrive out of order — a `read` can land
 * before the `delivered` that preceded it — and applying them blindly would
 * walk a message backwards from read to delivered. So a receipt only moves the
 * row forward. `failed` is the exception: it always wins, because a failure
 * after a delivered is real news and hiding it is how a client silently gets
 * nothing.
 *
 * @param {string} status the receipt's status
 * @param {string|null} current what the row says now
 * @param {string} at ISO timestamp for the receipt
 */
export function receiptPatch(status, current = null, at = new Date().toISOString()) {
  const next = RANK[status];
  if (!next) return null;
  const now = RANK[current] || 0;
  if (status !== 'failed' && next <= now) return null;
  if (current === 'failed' && status !== 'failed') return null;

  const patch = { send_status: status };
  if (status === 'delivered') patch.delivered_at = at;
  if (status === 'read') {
    patch.read_at = at;
    // A read implies a delivery that may never have been reported.
    patch.delivered_at = at;
  }
  return patch;
}

/** Meta gives timestamps as unix seconds, as a string. */
function receiptTime(ts) {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : new Date().toISOString();
}

/**
 * Apply one webhook's worth of statuses.
 *
 * Returns what it did rather than throwing: this runs after the webhook has
 * already answered 200, so a failure here must never become a Meta retry of a
 * message we have already processed.
 */
export async function applyWhatsAppStatuses(statuses) {
  const rows = Array.isArray(statuses) ? statuses : [];
  let applied = 0, failedSends = 0, unmatched = 0;

  for (const s of rows) {
    const id = s?.id;
    const status = String(s?.status || '').toLowerCase();
    if (!id || !RANK[status]) continue;

    try {
      const { data: msg, error } = await supabase
        .from('messages')
        .select('id, send_status, client_id, beautician_id')
        .eq('whatsapp_message_id', id)
        .maybeSingle();
      if (error) { logger.warn({ err: error, id }, 'receipt lookup failed'); continue; }
      if (!msg) {
        // Every message sent before the id was recorded is unmatchable, so
        // this will be noisy for a while and then go quiet. Counted rather
        // than logged per row.
        unmatched++;
        continue;
      }

      const patch = receiptPatch(status, msg.send_status, receiptTime(s.timestamp));
      if (!patch) continue;

      if (status === 'failed') {
        // Keep WHY. "failed" on its own tells Ellie nothing she can act on;
        // 131047 (re-engagement window) and 470 (template paused) have
        // completely different answers.
        const err = s.errors?.[0];
        failedSends++;
        logger.warn({
          messageId: msg.id, beauticianId: msg.beautician_id, clientId: msg.client_id,
          code: err?.code, title: err?.title, detail: err?.error_data?.details,
        }, 'WhatsApp reported a message as FAILED — the client did not receive it');
      }

      const { error: upErr } = await supabase.from('messages').update(patch).eq('id', msg.id);
      if (upErr) { logger.warn({ err: upErr, id: msg.id }, 'receipt update failed'); continue; }
      applied++;
    } catch (err) {
      logger.warn({ err, id }, 'receipt threw');
    }
  }

  if (applied || failedSends) {
    logger.info({ applied, failedSends, unmatched }, 'WhatsApp delivery receipts applied');
  }
  return { applied, failedSends, unmatched };
}
