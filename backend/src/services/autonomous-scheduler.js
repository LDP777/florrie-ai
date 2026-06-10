/**
 * Autonomous Scheduler — Florrie's proactive brain.
 *
 * Runs every 2 hours via cron in index.js. For each active beautician:
 *   1. Checks for rebook-due clients → queues nudge or auto-sends if confident
 *   2. Checks for tomorrow's calendar gaps → drafts availability post
 *   3. Checks for unanswered messages → processes via AI Front Desk
 *
 * Each action goes through the beautician's confidence_threshold:
 *   - Above threshold → auto-execute, log to ai_actions
 *   - Below threshold → queue to approval inbox (escalations), log as pending
 */
import { supabase } from '../config.js';
import { normaliseOutcome } from '../lib/ai-actions.js';
import { refreshAllIntelligence } from './client-intelligence.js';
import { draftAvailabilityPost } from './content-autopilot.js';
import { processInboundMessage } from './ai-front-desk.js';
import { sendNudge } from './notifications.js';
import { shouldAutoSend } from './sms-metering.js';
import { runValueCoaching } from './value-coaching.js';
import { processReviewRequests } from './review-requests.js';
import { pushTeamUpdate } from './push-notifications.js';
import { checkGapFillOpportunities } from './gap-fill-engine.js';
import logger from '../lib/logger.js';

const DEFAULT_CONFIDENCE = 0.90;

/**
 * Main entry point — called by cron every 2 hours.
 */
export async function runAutonomousCycle() {
  logger.info('Autonomous scheduler: starting cycle');

  try {
    // Get all beauticians with auto_reply_enabled
    const { data: beauticians, error } = await supabase
      .from('beauticians')
      .select('id, first_name, confidence_threshold, auto_reply_enabled, subscription_plan, tone_model')
      .eq('auto_reply_enabled', true);

    if (error || !beauticians?.length) {
      logger.info('Autonomous scheduler: no active beauticians or error', { error });
      return;
    }

    for (const b of beauticians) {
      try {
        await runForBeautician(b);
      } catch (err) {
        logger.error({ err, beauticianId: b.id }, 'Autonomous cycle failed for beautician');
      }
    }

    logger.info(`Autonomous scheduler: cycle complete for ${beauticians.length} beauticians`);

    // Value coaching runs weekly — check if it's been 7+ days
    try {
      const { data: lastCoaching } = await supabase
        .from('ai_actions')
        .select('created_at')
        .eq('action_type', 'value_coaching')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const daysSinceLast = lastCoaching
        ? (Date.now() - new Date(lastCoaching.created_at).getTime()) / (24 * 60 * 60 * 1000)
        : 999;

      if (daysSinceLast >= 7) {
        logger.info('Autonomous scheduler: running weekly value coaching');
        await runValueCoaching();
      }
    } catch (err) {
      logger.error({ err }, 'Value coaching trigger failed');
    }

    // Process any due review requests (2hr delayed from appointment completion)
    try {
      const reviewResult = await processReviewRequests();
      if (reviewResult.sent > 0) {
        logger.info(reviewResult, 'Review requests: sent');
      }
    } catch (err) {
      logger.error({ err }, 'Review requests processing failed');
    }
  } catch (err) {
    logger.error({ err }, 'Autonomous scheduler: fatal error');
  }
}

/**
 * Run all autonomous checks for a single beautician.
 */
async function runForBeautician(beautician) {
  const bid = beautician.id;
  const threshold = beautician.confidence_threshold || DEFAULT_CONFIDENCE;

  // Run all checks in parallel
  const [rebookResults, gapResults, messageResults, gapFillResults, patchTestResults] = await Promise.allSettled([
    checkRebookDueClients(bid, threshold),
    checkCalendarGaps(bid, threshold),
    checkUnansweredMessages(bid, beautician, threshold),
    checkGapFillOpportunities(bid, threshold),
    checkPatchTestsExpiring(bid, beautician),
  ]);

  // Log summary
  const rebook = rebookResults.status === 'fulfilled' ? rebookResults.value : 0;
  const gaps = gapResults.status === 'fulfilled' ? gapResults.value : 0;
  const msgs = messageResults.status === 'fulfilled' ? messageResults.value : 0;
  const gapFill = gapFillResults.status === 'fulfilled' ? gapFillResults.value : { matched: 0 };
  const patchTests = patchTestResults.status === 'fulfilled' ? patchTestResults.value : 0;

  if (rebook + gaps + msgs + (gapFill.matched || 0) + patchTests > 0) {
    logger.info({ bid, rebook, gaps, msgs, gapFill: gapFill.matched || 0, patchTests }, 'Autonomous actions taken');
  }
}

/**
 * 1. Find clients overdue for a rebook and nudge them.
 */
async function checkRebookDueClients(beauticianId, threshold) {
  let actionsCount = 0;

  // Get clients with predicted next visit that's overdue
  const { data: clients } = await supabase
    .from('clients')
    .select('id, first_name, last_name, phone, email, whatsapp_id, last_whatsapp_inbound_at, next_predicted_visit')
    .eq('beautician_id', beauticianId)
    .not('next_predicted_visit', 'is', null)
    .lt('next_predicted_visit', new Date().toISOString())
    .eq('status', 'active');

  if (!clients?.length) return 0;

  // Only process clients overdue by 3+ days (avoid nagging)
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const overdue = clients.filter(c => c.next_predicted_visit < threeDaysAgo);

  for (const client of overdue.slice(0, 5)) { // Max 5 per cycle
    // Check if we already nudged recently
    const { count } = await supabase
      .from('ai_actions')
      .select('id', { count: 'exact', head: true })
      .eq('beautician_id', beauticianId)
      .eq('action_type', 'rebook_nudge')
      .eq('client_id', client.id)
      .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

    if ((count || 0) > 0) continue; // Already nudged this week

    const confidence = 0.85; // Rebook nudges are moderate confidence
    const summary = `${client.first_name} is overdue for a rebook. Send nudge?`;

    if (confidence >= threshold && (client.phone || client.email)) {
      const { shouldSend, reason } = await shouldAutoSend(beauticianId, 'rebook_nudge');
      if (!shouldSend) {
        logger.info({ beauticianId, clientId: client.id, reason }, 'Rebook nudge skipped by autopilot rules');
        continue;
      }

      // Fetch beautician prefs for channel routing
      const { data: bPrefs } = await supabase
        .from('beauticians')
        .select('whatsapp_phone_id, client_reminder_prefs')
        .eq('id', beauticianId)
        .maybeSingle();
      const beauticianPrefs = {
        whatsapp_connected: !!bPrefs?.whatsapp_phone_id,
        ...(bPrefs?.client_reminder_prefs || {}),
      };

      const nudgeBody = `Hey ${client.first_name}! It's been a while since your last visit. We'd love to see you again — fancy booking in? 💕`;
      try {
        const sent = await sendNudge({
          client,
          body: nudgeBody,
          templateName: 'rebook_nudge_v2',
          templateParams: [client.first_name],
          beauticianId,
          beauticianPrefs,
        });
        if (sent) {
          await logAction(beauticianId, 'rebook_nudge', 'executed', `${summary} (via ${sent.channel})`, confidence, client.id);
        } else {
          await logAction(beauticianId, 'rebook_nudge', 'failed', summary, confidence, client.id);
        }
        actionsCount++;
      } catch (err) {
        logger.warn({ err, clientId: client.id }, 'Failed to send rebook nudge');
      }
    } else {
      // Queue for approval
      await logAction(beauticianId, 'rebook_nudge', 'pending_approval', summary, confidence, client.id);
      actionsCount++;
    }
  }

  return actionsCount;
}

/**
 * 2. Check for calendar gaps tomorrow and draft an availability post.
 */
async function checkCalendarGaps(beauticianId, threshold) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStart = new Date(tomorrow);
  tomorrowStart.setHours(0, 0, 0, 0);
  const tomorrowEnd = new Date(tomorrow);
  tomorrowEnd.setHours(23, 59, 59, 999);

  // Get tomorrow's appointments
  const { data: appointments } = await supabase
    .from('appointments')
    .select('starts_at, duration_minutes, status')
    .eq('beautician_id', beauticianId)
    .gte('starts_at', tomorrowStart.toISOString())
    .lte('starts_at', tomorrowEnd.toISOString())
    .neq('status', 'cancelled');

  // Get working hours for tomorrow's day
  const { data: beautician } = await supabase
    .from('beauticians')
    .select('working_hours')
    .eq('id', beauticianId)
    .single();

  if (!beautician?.working_hours) return 0;

  const dayKey = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][tomorrow.getDay()];
  const dayHours = beautician.working_hours[dayKey];
  if (!dayHours || !dayHours.start) return 0; // Not working tomorrow

  // Calculate total available hours
  const [startH, startM] = dayHours.start.split(':').map(Number);
  const [endH, endM] = dayHours.end.split(':').map(Number);
  const totalMinutes = (endH * 60 + endM) - (startH * 60 + startM);
  const bookedMinutes = (appointments || []).reduce((sum, a) => sum + (a.duration_minutes || 60), 0);
  const gapMinutes = totalMinutes - bookedMinutes;

  // If more than 2 hours of gaps, draft availability post
  if (gapMinutes >= 120) {
    // Check if we already drafted a post for tomorrow
    const { count } = await supabase
      .from('ai_actions')
      .select('id', { count: 'exact', head: true })
      .eq('beautician_id', beauticianId)
      .eq('action_type', 'gap_post')
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    if ((count || 0) > 0) return 0; // Already drafted today

    const gapHours = Math.round(gapMinutes / 60);
    const tomorrowLabel = tomorrow.toLocaleDateString('en-GB', { weekday: 'long' });
    const summary = `${tomorrowLabel} has ${gapHours}h of gaps. Draft availability post?`;
    const confidence = 0.80;

    if (confidence >= threshold) {
      try {
        await draftAvailabilityPost(beauticianId, tomorrow.toISOString(), dayHours.start, []);
        await logAction(beauticianId, 'gap_post', 'executed', summary, confidence);
      } catch (err) {
        logger.warn({ err }, 'Failed to draft gap post');
      }
    } else {
      await logAction(beauticianId, 'gap_post', 'pending_approval', summary, confidence);
    }

    return 1;
  }

  return 0;
}

/**
 * 3. Check for unanswered messages and process them.
 */
async function checkUnansweredMessages(beauticianId, beautician, threshold) {
  let actionsCount = 0;

  // Find messages received in the last 4 hours with no reply
  const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

  const { data: unanswered } = await supabase
    .from('messages')
    .select('id, content, client_id, clients(first_name, last_name, phone)')
    .eq('beautician_id', beauticianId)
    .eq('direction', 'inbound')
    .eq('replied', false)
    .gte('created_at', fourHoursAgo)
    .order('created_at', { ascending: true })
    .limit(10);

  if (!unanswered?.length) return 0;

  for (const msg of unanswered) {
    try {
      const result = await processInboundMessage(
        msg.id,
        beautician,
        msg.clients,
        msg.content
      );
      actionsCount++;
    } catch (err) {
      logger.warn({ err, messageId: msg.id }, 'Failed to process unanswered message');
    }
  }

  return actionsCount;
}

/**
 * 5. Check for patch tests expiring soon and remind clients.
 *    Only runs if beautician has patch_test_auto_remind = true.
 *    Deduped: won't re-send within 7 days per client.
 */
async function checkPatchTestsExpiring(beauticianId, beautician) {
  // Re-fetch full beautician row if we only have a partial object
  const { data: b } = await supabase
    .from('beauticians')
    .select('patch_test_auto_remind, patch_test_remind_days_before, patch_test_expiry_months, whatsapp_phone_id, client_reminder_prefs, first_name, phone')
    .eq('id', beauticianId)
    .maybeSingle();

  if (!b?.patch_test_auto_remind) return 0;

  const expiryMonths = b.patch_test_expiry_months || 6;
  const remindDaysBefore = b.patch_test_remind_days_before || 7;

  // Calculate the date window: tests that will expire within remindDaysBefore days
  const now = new Date();
  const expiryWindowEnd = new Date(now.getTime() + remindDaysBefore * 24 * 60 * 60 * 1000);

  // test_date + expiryMonths months = expiry date
  // We want: test_date = expiry - expiryMonths
  // So: test_date <= windowEnd - expiryMonths && test_date >= windowEnd - expiryMonths - 1 day (so we don't keep hitting already-expired ones)
  const cutoffDate = new Date(expiryWindowEnd);
  cutoffDate.setMonth(cutoffDate.getMonth() - expiryMonths);
  const lowerBound = new Date(cutoffDate);
  lowerBound.setDate(lowerBound.getDate() - 1);

  const { data: expiringTests } = await supabase
    .from('patch_tests')
    .select('id, client_id, test_date, clients(id, first_name, last_name, phone, whatsapp_id, email)')
    .eq('beautician_id', beauticianId)
    .eq('result', 'pass')
    .gte('test_date', lowerBound.toISOString().split('T')[0])
    .lte('test_date', cutoffDate.toISOString().split('T')[0]);

  if (!expiringTests?.length) return 0;

  const beauticianPrefs = {
    whatsapp_connected: !!b.whatsapp_phone_id,
    ...(b.client_reminder_prefs || {}),
  };

  let sent = 0;

  for (const test of expiringTests) {
    const client = test.clients;
    if (!client) continue;

    // Dedup: check if we've already sent a patch test reminder in the last 7 days
    const { count } = await supabase
      .from('ai_actions')
      .select('id', { count: 'exact', head: true })
      .eq('beautician_id', beauticianId)
      .eq('action_type', 'patch_test_reminder')
      .eq('client_id', client.id)
      .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

    if ((count || 0) > 0) continue;

    const expiryDate = new Date(test.test_date);
    expiryDate.setMonth(expiryDate.getMonth() + expiryMonths);
    const daysLeft = Math.ceil((expiryDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));

    const nudgeBody = `Hi ${client.first_name}! Just a heads up — your patch test is expiring in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}. You'll need a fresh one before your next tint or lift appointment. Give us a message to book one in 💕`;

    try {
      const result = await sendNudge({
        client,
        body: nudgeBody,
        beauticianId,
        beauticianPrefs,
      });

      if (result) {
        await logAction(
          beauticianId,
          'patch_test_reminder',
          'executed',
          `Patch test reminder sent to ${client.first_name} — expires in ${daysLeft} days`,
          0.95,
          client.id
        );
        sent++;
      }
    } catch (err) {
      logger.warn({ err, clientId: client.id }, 'Failed to send patch test reminder');
    }
  }

  return sent;
}

/**
 * Log an AI action to the ai_actions table.
 */
async function logAction(beauticianId, actionType, status, summary, confidence, clientId = null) {
  try {
    await supabase.from('ai_actions').insert({
      beautician_id: beauticianId,
      action_type: actionType,
      outcome: normaliseOutcome(status),
      summary,
      confidence,
      client_id: clientId,
      digital_employee: actionType.includes('nudge') ? 'comeback'
        : actionType.includes('gap') ? 'calendar'
        : actionType.includes('message') ? 'front_desk'
        : 'general',
      created_at: new Date().toISOString(),
    });

    // Fire push notification for executed actions (not pending/escalated ones)
    if (status === 'executed') {
      pushTeamUpdate(beauticianId, actionType, summary).catch((err) =>
        logger.debug({ err }, 'Push notification failed (non-critical)')
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to log AI action');
  }
}
