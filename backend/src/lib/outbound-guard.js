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
  // 31 August 2026, Instagram's first night live. Both of these answer a
  // message the client sent seconds earlier, so the proactive machinery is the
  // wrong shape for them: quiet hours would hold a reply to somebody who is
  // awake and typing, the 7 day frequency cap would swallow it, and the trust
  // dial would turn an auto-reply the owner deliberately switched on into a
  // draft she has to approve. They are still gated, by the opt-out check
  // below; they were previously sent with no gate of any kind.
  'instagram_redirect', 'marketing_opt_out',
]);

/**
 * Transactional message types that Florrie GENERATES, rather than ones a human
 * action produced.
 *
 * A booking confirmation exists because the client booked. The Instagram
 * redirect exists because a bot decided to speak. Somebody who replied STOP to
 * that bot must not get another one, and before 31 August 2026 they did: the
 * redirect never passed through this file at all, and the only opt-out check
 * in the codebase lived in a function the redirect path never called.
 *
 * Deliberately NOT the whole transactional set. A client who opts out of
 * marketing is still owed the confirmation for the appointment she just made.
 */
const HONOURS_OPT_OUT = new Set(['instagram_redirect']);

/**
 * Has this client opted out of marketing? Reads the row we were handed when it
 * actually carries the column, and goes and looks when it does not: a select
 * that never asked for marketing_opted_out_at hands back undefined, which is
 * falsy, which reads as "no opt-out" and is how three senders shipped wrong.
 */
async function hasOptedOut(beauticianId, clientId, client) {
  if (client && typeof client === 'object' && 'marketing_opted_out_at' in client) {
    return !!client.marketing_opted_out_at;
  }
  const id = clientId || client?.id;
  if (!id) return false;
  try {
    const { data, error } = await supabase
      .from('clients')
      .select('marketing_opted_out_at')
      .eq('id', id)
      .eq('beautician_id', beauticianId)
      .maybeSingle();
    if (error) {
      // Cannot tell. An auto-reply is never worth the risk of speaking to
      // somebody who asked us to stop, so treat unknown as opted out.
      logger.warn({ err: error, beauticianId, clientId: id },
        'Could not read marketing_opted_out_at; treating as opted out and holding the auto-reply');
      return true;
    }
    return !!data?.marketing_opted_out_at;
  } catch (err) {
    logger.warn({ err, beauticianId, clientId: id },
      'Opt-out lookup threw; treating as opted out and holding the auto-reply');
    return true;
  }
}

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

// A client Ellie already knows. Florrie may only speak on her own to people
// with NO relationship to the salon at all.
//
// This used to mean "a CURRENT regular": 3+ COMPLETED appointments in the last
// 183 days. That let Florrie auto-reply to anyone below the bar, which on
// 28 Jul told a client that 4.30 Thursday was free when it was not. The client
// was asking to RESCHEDULE, so she demonstrably had a booking; she just had not
// completed three of them in six months. A rule that treats a woman with an
// appointment in the diary as a stranger is the wrong rule.
//
// Now: ANY appointment ever, in ANY status, makes her Ellie's. Cancelled and
// no-showed count too, because a relationship exists either way. Levi,
// 2026-07-28: "we shouldn't fuck with Ellie's clients."
export const KNOWN_CLIENT_MIN_VISITS = 1;
export const KNOWN_CLIENT_WINDOW_DAYS = null;
export async function isKnownClient(beauticianId, clientId, client = null) {
  if (!clientId) return false;
  try {
    if (client && (client.is_regular === true || client.vip === true)) return true;
    const { count, error } = await supabase
      .from('appointments')
      .select('id', { count: 'exact', head: true })
      .eq('beautician_id', beauticianId)
      .eq('client_id', clientId);
    if (error || !Number.isFinite(count)) {
      logger.warn({ err: error, beauticianId, clientId }, 'Client history unreadable; holding autonomous sends');
      return true;
    }
    return count > 0;
  } catch {
    // If we cannot tell, err towards asking rather than auto-sending.
    return true;
  }
}

/**
 * Per-client autonomy override (clients.messaging_autonomy):
 *   'florrie' - full autonomy for this person, even where the dial would hold
 *   'drafts'  - always draft for approval, never auto-send
 *   'just_me' - Florrie never initiates; drafts are prepared SILENTLY (quiet
 *               Outbox section, no badge) so Ellie can use them if she wants
 *   null      - no override: dial + regular-classification decide
 */
export async function clientAutonomyOverride(beauticianId, clientId, client = null) {
  if (!clientId) return null;
  try {
    if (client && client.messaging_autonomy !== undefined) return client.messaging_autonomy || null;
    const { data, error } = await supabase
      .from('clients')
      .select('messaging_autonomy')
      .eq('id', clientId)
      .eq('beautician_id', beauticianId)
      .maybeSingle();
    if (error || !data || data.messaging_autonomy === undefined) {
      logger.warn({ err: error, beauticianId, clientId }, 'Client messaging preference unreadable; preparing drafts only');
      return 'drafts';
    }
    return data.messaging_autonomy || null;
  } catch (err) {
    logger.warn({ err, beauticianId, clientId }, 'Client messaging preference failed; preparing drafts only');
    return 'drafts';
  }
}

/**
 * Decide whether a proactive/transactional message may be sent right now.
 * Pass the client row if you already have it (saves a lookup).
 */
export async function evaluateOutbound({ beauticianId, clientId, messageType, channel = 'whatsapp', client = null }) {
  clientId ||= client?.id;
  const tier = classifyTier(messageType);
  if (tier === 'transactional') {
    // Direct AI replies to a client Ellie already knows can land out of context,
    // especially on Instagram where we may be missing the earlier conversation.
    // Hold those for her yes/no. Pure transactional messages (confirmations,
    // reminders, receipts, payment links) still go straight through.
    if (messageType === 'ai_reply' && await isKnownClient(beauticianId, clientId, client)) {
      return decision('approve', tier, 'known_client_reply');
    }
    // A message Florrie writes on her own initiative, even a transactional
    // one, stops when the client says STOP. See HONOURS_OPT_OUT above.
    if (HONOURS_OPT_OUT.has(messageType) && await hasOptedOut(beauticianId, clientId, client)) {
      return decision('block', tier, 'opted_out');
    }
    return decision('send', tier, 'transactional');
  }

  try {
    // 1) Consent. Fail CLOSED: a proactive message needs a matched, opted-in
    //    client. (The old guard allowed sends when it could not match a phone.)
    let c = client;
    // A client row is only evidence if it carries the columns this decision
    // needs. A select that never asked for marketing_opted_out_at hands back a
    // row where it is undefined, which is falsy, so the opt-out branch below
    // reads a missing column as a yes and texts somebody who replied STOP.
    // Three senders shipped that way. Treat a row with no consent columns as
    // no row and go and read them.
    //
    // Re-read rather than block: blocking would break every caller that still
    // under-selects, and a caller that under-selects is the one case where we
    // most need the true answer rather than a refusal.
    if (c && typeof c === 'object' && (!('marketing_opted_out_at' in c) || !('marketing_consent' in c))) {
      logger.warn(
        { beauticianId, messageType, clientId: clientId || c.id || null },
        'evaluateOutbound was handed a client row with no consent columns, re-reading it',
      );
      c = null;
    }
    if (!c && (clientId || client?.id)) {
      const id = clientId || client.id;
      const { data } = await supabase
        .from('clients')
        .select('id, marketing_consent, marketing_opted_out_at, messaging_autonomy')
        .eq('id', id)
        .eq('beautician_id', beauticianId)
        .maybeSingle();
      c = data ? { ...client, ...data } : null;
    }
    if (!c) return decision('block', tier, 'no_client_match');
    if (c.marketing_opted_out_at) return decision('block', tier, 'opted_out');
    if (c.marketing_consent !== true) return decision('block', tier, 'no_consent');

    // 2) Sociable hours only (marketing), in the salon's own timezone. Held, not killed.
    let salonTz = null;
    try {
      const { data: b } = await supabase
        .from('beauticians')
        .select('timezone')
        .eq('id', beauticianId)
        .maybeSingle();
      salonTz = b?.timezone || null;
    } catch { /* default applies */ }
    if (inMarketingQuietHours(new Date(), salonTz || undefined)) return decision('block', tier, 'quiet_hours');

    // 3) Cross-engine frequency cap: nothing proactive within the last N days,
    //    counting anything already sent, approved, or waiting for approval.
    const sinceIso = new Date(Date.now() - GUARD.FREQUENCY_MIN_DAYS * 86400000).toISOString();
    const { count: recent, error: recentError } = await supabase
      .from('outbound_sends')
      .select('id', { count: 'exact', head: true })
      .eq('beautician_id', beauticianId)
      .eq('client_id', clientId)
      .eq('tier', 'proactive')
      .in('status', ['sent', 'approved', 'pending_approval'])
      .gte('created_at', sinceIso);
    if (recentError || !Number.isFinite(recent)) return decision('block', tier, 'frequency_unavailable');
    if (recent && recent > 0) return decision('block', tier, 'frequency_cap');

    // 4) Monthly per-client cap.
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const { count: monthCount, error: monthError } = await supabase
      .from('outbound_sends')
      .select('id', { count: 'exact', head: true })
      .eq('beautician_id', beauticianId)
      .eq('client_id', clientId)
      .eq('tier', 'proactive')
      .in('status', ['sent', 'approved'])
      .gte('created_at', monthStart.toISOString());
    if (monthError || !Number.isFinite(monthCount)) return decision('block', tier, 'frequency_unavailable');
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
    const { data: b, error: autonomyError } = await supabase
      .from('beauticians')
      .select('autonomy')
      .eq('id', beauticianId)
      .maybeSingle();
    if (autonomyError || !b) return decision('block', tier, 'autonomy_unavailable');
    // Per-client override beats the global dial: the relationship is
    // per-person knowledge only Ellie has.
    const override = await clientAutonomyOverride(beauticianId, clientId, c);
    if (override === 'just_me') return decision('approve', tier, 'just_me_silent_draft');
    if (override === 'drafts') return decision('approve', tier, 'client_prefers_drafts');

    const mode = b?.autonomy?.[messageType] || b?.autonomy?.proactive || 'ask';
    if (mode === 'off') return decision('block', tier, 'autonomy_off'); // Ellie turned this type off
    if (override === 'florrie') {
      return mode === 'off' ? decision('block', tier, 'autonomy_off') : decision('send', tier, 'client_trusted_florrie');
    }
    // A client Ellie knows is a relationship she manages personally. Never auto-send
    // to them, even on 'auto': hold for her explicit yes/no so a proactive message
    // never lands out of context with someone she has a rapport with.
    if (mode === 'auto' && await isKnownClient(beauticianId, clientId, c)) {
      return decision('approve', tier, 'known_client_review');
    }
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
    // Senders may return the provider's own message id instead of a bare true.
    // Kept rather than collapsed to a boolean: on Instagram it is the only way
    // to recognise our own message when the platform echoes it back to the
    // webhook, and mistaking Florrie's echo for the owner's would silence her
    // in every thread she has ever answered. See routes/instagram-webhooks.js.
    let deliveryId = null;
    try {
      const result = await send();
      ok = !!result;
      if (typeof result === 'string') deliveryId = result;
    } catch (err) {
      logger.error({ err, beauticianId, messageType }, 'guardedSend: delivery threw');
    }
    await recordOutbound({
      beauticianId, clientId, messageType, channel, tier: verdict.tier,
      status: ok ? 'sent' : 'blocked', reason: ok ? verdict.reason : 'send_failed', body,
    });
    return { ...verdict, delivered: ok, deliveryId };
  }
  // approve or block: never deliver, just record intent.
  await recordOutbound({
    beauticianId, clientId, messageType, channel, tier: verdict.tier,
    status: verdict.decision === 'approve' ? 'pending_approval' : 'blocked',
    reason: verdict.reason, body,
  });
  return { ...verdict, delivered: false, deliveryId: null };
}
