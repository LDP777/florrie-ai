/**
 * Outbound guard: the single gate every PROACTIVE message Florrie wants to send
 * on the beautician's behalf must pass through, so we never:
 *   - send marketing to someone who hasn't consented (PECR, fail CLOSED),
 *   - pester the same client from two different engines (cross-engine cap),
 *   - quietly burn the 120/month allowance that transactional sends rely on.
 *
 * Transactional messages (confirmations, reminders, direct replies, receipts)
 * are expected and low-risk, so they pass straight through. Everything else is
 * "proactive" and is held for the daily approval review unless the beautician
 * has explicitly trusted that category (the autonomy dial).
 *
 * Decision values:
 *   'send'    -> caller may send now, then recordOutbound({status:'sent'})
 *   'approve' -> do NOT send; recordOutbound({status:'pending_approval', body})
 *                so it surfaces in Florrie's daily outbox for a one-tap approve
 *   'block'   -> do NOT send; recordOutbound({status:'blocked', reason})
 *
 * Fails safe: any unexpected error on the proactive path blocks the send. A
 * missed nudge is recoverable; a wrong/over-limit send is not.
 */
import { supabase } from '../config.js';
import logger from './logger.js';
import { getMonthlyUsage } from '../services/whatsapp-metering.js';
import { inMarketingQuietHours } from './marketing-guard.js';

// Expected, low-risk message types that always go (never gated).
const TRANSACTIONAL = new Set([
  'booking_confirmation', 'appointment_reminder', 'reminder', 'payment_request',
  'payment_link', 'cancellation', 'reschedule', 'patch_test', 'consultation_form',
  'ai_reply', 'receipt',
]);

// Tunables (kept here so they are easy to find and adjust).
export const GUARD = {
  FREQUENCY_MIN_DAYS: 7,   // no two proactive messages to the same client within 7 days
  MONTHLY_CLIENT_CAP: 4,   // most proactive messages one client gets in a calendar month
  ALLOWANCE_RESERVE: 20,   // keep this many of the monthly allowance back for transactional
};

export function classifyTier(messageType) {
  return TRANSACTIONAL.has(String(messageType || '')) ? 'transactional' : 'proactive';
}

function decision(d, tier, reason) {
  return { decision: d, tier, reason };
}

/**
 * Decide whether a proactive/transactional message may be sent right now.
 * Pass the client row if you already have it (saves a lookup).
 */
export async function evaluateOutbound({ beauticianId, clientId, messageType, channel = 'whatsapp', client = null }) {
  const tier = classifyTier(messageType);
  if (tier === 'transactional') {
    return decision('send', tier, 'transactional');
  }

  try {
    // 1) Consent. Fail CLOSED: a proactive message needs a matched, opted-in
    //    client. (The old guard allowed sends when it could not match a phone.)
    let c = client;
    if (!c && clientId) {
      const { data } = await supabase
        .from('clients')
        .select('id, marketing_consent, marketing_opted_out_at')
        .eq('id', clientId)
        .eq('beautician_id', beauticianId)
        .maybeSingle();
      c = data;
    }
    if (!c) return decision('block', tier, 'no_client_match');
    if (c.marketing_opted_out_at) return decision('block', tier, 'opted_out');

    // 2) Sociable hours only (marketing). Held, not killed.
    if (inMarketingQuietHours()) return decision('block', tier, 'quiet_hours');

    // 3) Cross-engine frequency cap: nothing proactive within the last N days,
    //    counting anything already sent, approved, or waiting for approval.
    const sinceIso = new Date(Date.now() - GUARD.FREQUENCY_MIN_DAYS * 86400000).toISOString();
    const { count: recent } = await supabase
      .from('outbound_sends')
      .select('id', { count: 'exact', head: true })
      .eq('beautician_id', beauticianId)
      .eq('client_id', clientId)
      .eq('tier', 'proactive')
      .in('status', ['sent', 'approved', 'pending_approval'])
      .gte('created_at', sinceIso);
    if (recent && recent > 0) return decision('block', tier, 'frequency_cap');

    // 4) Monthly per-client cap.
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const { count: monthCount } = await supabase
      .from('outbound_sends')
      .select('id', { count: 'exact', head: true })
      .eq('beautician_id', beauticianId)
      .eq('client_id', clientId)
      .eq('tier', 'proactive')
      .in('status', ['sent', 'approved'])
      .gte('created_at', monthStart.toISOString());
    if (monthCount && monthCount >= GUARD.MONTHLY_CLIENT_CAP) {
      return decision('block', tier, 'monthly_cap');
    }

    // 5) Allowance: never let proactive sends eat into the reserve kept back for
    //    transactional. Held until the allowance frees up (next month) or the
    //    beautician tops up.
    const usage = await getMonthlyUsage(beauticianId);
    if (usage) {
      const used = usage.total_sent ?? ((usage.sms_sent || 0) + (usage.whatsapp_sent || 0));
      const limit = usage.free_limit || 120;
      if (used >= limit - GUARD.ALLOWANCE_RESERVE) {
        return decision('block', tier, 'allowance_reserved');
      }
    }

    // 6) Trust dial. Auto-send only if the beautician has trusted this category
    //    (or all proactive). Otherwise it waits in the daily outbox.
    const { data: b } = await supabase
      .from('beauticians')
      .select('autonomy')
      .eq('id', beauticianId)
      .maybeSingle();
    const mode = b?.autonomy?.[messageType] || b?.autonomy?.proactive || 'ask';
    if (mode === 'off') return decision('block', tier, 'autonomy_off'); // Ellie turned this type off
    if (mode === 'auto') return decision('send', tier, 'trusted_auto');
    return decision('approve', tier, 'awaiting_approval');
  } catch (err) {
    logger.warn({ err, beauticianId, messageType }, 'evaluateOutbound failed; blocking proactive send (fail-safe)');
    return decision('block', tier, 'error_failsafe');
  }
}

/**
 * Log the outcome of a send decision. This row is the source of truth for the
 * frequency caps above and for the daily outbox UI.
 */
export async function recordOutbound({ beauticianId, clientId, messageType, channel, tier, status, reason, body }) {
  try {
    const { data, error } = await supabase
      .from('outbound_sends')
      .insert({
        beautician_id: beauticianId,
        client_id: clientId || null,
        message_type: messageType,
        tier: tier || classifyTier(messageType),
        channel: channel || null,
        status,
        reason: reason || null,
        body: body || null,
        decided_at: status === 'pending_approval' ? null : new Date().toISOString(),
      })
      .select('id')
      .maybeSingle();
    if (error) throw error;
    return data?.id || null;
  } catch (err) {
    logger.warn({ err, beauticianId, messageType }, 'recordOutbound failed');
    return null;
  }
}

/**
 * Convenience for engines: evaluate, then either run `send` (an async fn that
 * actually delivers and returns truthy on success) or queue/skip. Returns the
 * decision plus whether it was delivered. Engines that need custom handling can
 * call evaluateOutbound + recordOutbound directly instead.
 */
export async function guardedSend({ beauticianId, clientId, messageType, channel = 'whatsapp', client = null, body = null, send }) {
  const verdict = await evaluateOutbound({ beauticianId, clientId, messageType, channel, client });
  if (verdict.decision === 'send') {
    let ok = false;
    try { ok = !!(await send()); } catch (err) {
      logger.error({ err, beauticianId, messageType }, 'guardedSend: delivery threw');
    }
    await recordOutbound({
      beauticianId, clientId, messageType, channel, tier: verdict.tier,
      status: ok ? 'sent' : 'blocked', reason: ok ? verdict.reason : 'send_failed', body,
    });
    return { ...verdict, delivered: ok };
  }
  // approve or block: never deliver, just record intent.
  await recordOutbound({
    beauticianId, clientId, messageType, channel, tier: verdict.tier,
    status: verdict.decision === 'approve' ? 'pending_approval' : 'blocked',
    reason: verdict.reason, body,
  });
  return { ...verdict, delivered: false };
}
