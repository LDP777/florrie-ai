/**
 * WhatsApp registration retry worker.
 *
 * Two distinct queues live in the beauticians table:
 *
 *   1. Cooldown / rate-limit retries
 *      Set when /register hits cooldown_active or rate_limit. We park
 *      whatsapp_retry_at to the time Meta says it'll be unblocked, and this
 *      worker picks it up and re-runs preflight + (if clean) requests an OTP
 *      so the user just gets the SMS in their inbox once Meta lets us through.
 *
 *   2. Pending activation polling
 *      Set when /verify succeeds at the HTTP layer but Meta's /phone_numbers
 *      status is still PENDING. We poll Meta every 5 minutes (capped at 8
 *      attempts ~= 40 minutes) and flip whatsapp_connected=true the moment
 *      Meta reports CONNECTED.
 *
 * Wired into src/index.js as a setInterval running every 30 minutes. Idempotent
 * by design — if Meta hasn't budged, we leave the row alone and bump the
 * attempt count.
 */

import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { _whatsappInternals } from '../routes/whatsapp-config.js';

const {
  runPreflight,
  verifyCloudApiActivation,
  requestOtp,
  clearBeauticianWhatsapp,
  logDiagnostic,
} = _whatsappInternals;

const MAX_ATTEMPTS = 8;
// When we successfully clear a cooldown but the OTP request is still rate
// limited, push retry_at out by this much before the next pass.
const SOFT_BACKOFF_MS = 30 * 60 * 1000;
// When pending_activation is still PENDING after a poll, re-poll in this much.
const PENDING_BACKOFF_MS = 5 * 60 * 1000;

/**
 * Pick up beauticians whose whatsapp_retry_at is due. Caps batch size to
 * keep a single pass cheap.
 */
async function fetchDue(limit = 25) {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('beauticians')
    .select(
      'id, whatsapp_phone_id, whatsapp_pending_phone, whatsapp_phone, ' +
      'whatsapp_retry_at, whatsapp_retry_reason, whatsapp_retry_attempts, ' +
      'whatsapp_pending_activation, whatsapp_connected'
    )
    .lte('whatsapp_retry_at', nowIso)
    .order('whatsapp_retry_at', { ascending: true })
    .limit(limit);

  if (error) {
    logger.error({ err: error }, 'WhatsApp retry: fetch due failed');
    return [];
  }
  return data || [];
}

/**
 * Mark a row as completed (success or terminal failure). Clears the retry
 * fields so we stop picking it up.
 */
async function clearRetry(beauticianId, extraUpdates = {}) {
  await supabase
    .from('beauticians')
    .update({
      whatsapp_retry_at: null,
      whatsapp_retry_reason: null,
      ...extraUpdates,
    })
    .eq('id', beauticianId);
}

/**
 * Bump attempt count + reschedule. If we've blown the cap, give up and clear
 * the queue entry so support can take a look.
 */
async function rescheduleOrGiveUp(b, nextDelayMs, reason) {
  const nextAttempts = (b.whatsapp_retry_attempts || 0) + 1;
  if (nextAttempts >= MAX_ATTEMPTS) {
    logger.warn(
      { beauticianId: b.id, attempts: nextAttempts, reason },
      'WhatsApp retry: max attempts reached, giving up'
    );
    await logDiagnostic({
      beautician_id: b.id,
      phone: b.whatsapp_pending_phone || b.whatsapp_phone || '',
      stage: 'retry_worker',
      success: false,
      diagnosis: 'retry_exhausted',
      suggested_action: 'contact_support',
    });
    // Set flag so frontend can show user a banner telling them to contact support
    await supabase
      .from('beauticians')
      .update({
        whatsapp_retry_at: null,
        whatsapp_retry_reason: null,
        whatsapp_retry_exhausted: true,
        whatsapp_pending_activation: false,
      })
      .eq('id', b.id);
    return;
  }

  await supabase
    .from('beauticians')
    .update({
      whatsapp_retry_at: new Date(Date.now() + nextDelayMs).toISOString(),
      whatsapp_retry_reason: reason,
      whatsapp_retry_attempts: nextAttempts,
    })
    .eq('id', b.id);
}

/**
 * Handle the pending_activation case: poll Meta, flip to connected if it's
 * CONNECTED, bump backoff otherwise.
 */
async function handlePendingActivation(b) {
  if (!b.whatsapp_phone_id) {
    await clearRetry(b.id, { whatsapp_pending_activation: false });
    return;
  }

  const activation = await verifyCloudApiActivation(b.whatsapp_phone_id);

  if (activation.active) {
    await supabase
      .from('beauticians')
      .update({
        whatsapp_connected: true,
        whatsapp_pending_activation: false,
        whatsapp_pending_phone: null,
        whatsapp_retry_at: null,
        whatsapp_retry_reason: null,
        whatsapp_retry_exhausted: false,
      })
      .eq('id', b.id);

    await logDiagnostic({
      beautician_id: b.id,
      phone: b.whatsapp_phone || b.whatsapp_pending_phone || '',
      stage: 'retry_worker',
      success: true,
      diagnosis: 'connected_via_retry',
      raw_response: activation.raw,
    });

    logger.info(
      { beauticianId: b.id, phone: b.whatsapp_phone },
      'WhatsApp retry: pending activation flipped to CONNECTED'
    );
    return;
  }

  // Still PENDING (or worse). Reschedule.
  await rescheduleOrGiveUp(b, PENDING_BACKOFF_MS, 'pending_activation');
}

/**
 * Handle cooldown_active / rate_limit: re-run preflight against Meta. If it's
 * clear now, fire the OTP SMS automatically so the user finds it waiting in
 * their inbox. If still blocked, bump retry_at to whatever Meta now reports.
 */
async function handleCooldown(b) {
  const phone = b.whatsapp_pending_phone || b.whatsapp_phone;
  if (!phone) {
    await clearRetry(b.id);
    return;
  }

  const pre = await runPreflight({ beauticianId: b.id, phone });

  if (!pre.ready) {
    await logDiagnostic({
      beautician_id: b.id,
      phone,
      stage: 'retry_worker',
      success: false,
      meta_code: pre.meta?.code ?? null,
      meta_subcode: pre.meta?.subcode ?? null,
      meta_user_msg: pre.meta?.userMsg ?? null,
      diagnosis: `retry:${pre.diagnosis}`,
      suggested_action: pre.suggestedAction,
      retry_after: pre.retryAfter,
    });

    // Still blocked. If Meta gave us a fresh retryAfter use it; otherwise back off.
    const nextDelay = pre.retryAfter
      ? Math.max(0, new Date(pre.retryAfter).getTime() - Date.now())
      : SOFT_BACKOFF_MS;
    await rescheduleOrGiveUp(b, nextDelay || SOFT_BACKOFF_MS, pre.diagnosis);
    return;
  }

  // Cooldown cleared. Try to send the OTP.
  const phoneNumberId = pre.phoneNumberId;
  const otp = await requestOtp(phoneNumberId);

  if (!otp.ok) {
    // OTP request failed even though add succeeded. Soft-back-off and try again later.
    logger.warn(
      { beauticianId: b.id, phone, otpData: otp.data },
      'WhatsApp retry: preflight cleared but OTP request failed'
    );
    await logDiagnostic({
      beautician_id: b.id,
      phone,
      stage: 'retry_worker',
      success: false,
      raw_response: otp.data,
      diagnosis: 'retry_otp_failed',
      suggested_action: 'wait',
    });
    await rescheduleOrGiveUp(b, SOFT_BACKOFF_MS, 'otp_retry_pending');
    return;
  }

  // OTP delivered. Park phone_number_id + clear retry fields so the user can
  // come back and finish the verify step at their leisure.
  await supabase
    .from('beauticians')
    .update({
      whatsapp_pending_phone: phone,
      whatsapp_phone_id: phoneNumberId,
      whatsapp_retry_at: null,
      whatsapp_retry_reason: null,
      whatsapp_retry_attempts: 0,
    })
    .eq('id', b.id);

  await logDiagnostic({
    beautician_id: b.id,
    phone,
    stage: 'retry_worker',
    success: true,
    diagnosis: 'cooldown_cleared_otp_sent',
  });

  logger.info(
    { beauticianId: b.id, phone, phoneNumberId },
    'WhatsApp retry: cooldown cleared and OTP SMS re-sent automatically'
  );
}

/**
 * Single pass over the retry queue. Safe to call manually (e.g. from a unit
 * test) or from setInterval.
 */
export async function processRetryQueue() {
  const due = await fetchDue();
  if (due.length === 0) return { processed: 0 };

  let processed = 0;
  for (const b of due) {
    try {
      // If already connected, just clear the queue.
      if (b.whatsapp_connected && !b.whatsapp_pending_activation) {
        await clearRetry(b.id);
        continue;
      }

      if (b.whatsapp_retry_reason === 'pending_activation' || b.whatsapp_pending_activation) {
        await handlePendingActivation(b);
      } else {
        await handleCooldown(b);
      }
      processed += 1;
    } catch (err) {
      logger.error({ err, beauticianId: b.id }, 'WhatsApp retry: pass failed for row');
      // Don't kill the whole batch; just bump the attempt and move on.
      try {
        await rescheduleOrGiveUp(b, SOFT_BACKOFF_MS, b.whatsapp_retry_reason || 'unknown');
      } catch (_) { /* swallow */ }
    }
  }

  return { processed, total: due.length };
}
