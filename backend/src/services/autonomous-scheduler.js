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
import { guardedSend } from '../lib/outbound-guard.js';
import { getFutureBookedClientIds } from '../lib/future-bookings.js';
import { patchTestEvidence, patchTestStance, wallDate } from '../lib/patch-test-status.js';
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
      .select('id, first_name, confidence_threshold, auto_reply_enabled, subscription_plan, tone_model, autonomy')
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

    // Value coaching self-gates per beautician (weekly cadence lives inside
    // runValueCoaching now), so just run it each cycle - it skips anyone already
    // coached this week and only does real work for those due.
    try {
      await runValueCoaching();
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

  // Run all checks in parallel.
  //
  // Six names were being destructured from five promises. That is what was
  // left when checkUnansweredMessages was deleted from the middle of the array
  // and the name list was not shortened with it, so every result after the
  // second was reported under the label of the check before it, and
  // `prearrivalResults` was undefined. Reading `.status` off undefined threw a
  // TypeError, per beautician, every cycle. The work had already been done by
  // then, so the only casualty was the log line that says what was done, which
  // is the one thing that could have shown any of the rest of this file was
  // broken.
  const [rebookResults, gapResults, gapFillResults, patchTestResults, prearrivalResults] = await Promise.allSettled([
    checkRebookDueClients(bid, threshold),
    checkCalendarGaps(bid, threshold),
    checkGapFillOpportunities(bid, threshold),
    checkPatchTestsExpiring(bid, beautician),
    checkPreAppointmentRequirements(bid),
  ]);

  // Log summary
  const rebook = rebookResults.status === 'fulfilled' ? rebookResults.value : 0;
  const gaps = gapResults.status === 'fulfilled' ? gapResults.value : 0;
  const gapFill = gapFillResults.status === 'fulfilled' ? gapFillResults.value : { matched: 0 };
  const patchTests = patchTestResults.status === 'fulfilled' ? patchTestResults.value : 0;
  const prearrival = prearrivalResults.status === 'fulfilled' ? prearrivalResults.value : 0;

  if (rebook + gaps + (gapFill.matched || 0) + patchTests + prearrival > 0) {
    logger.info({ bid, rebook, gaps, gapFill: gapFill.matched || 0, patchTests, prearrival }, 'Autonomous actions taken');
  }
}

/**
 * 1. Find clients overdue for a rebook and nudge them.
 */
async function checkRebookDueClients(beauticianId, threshold) {
  let actionsCount = 0;

  // Get clients with predicted next visit that's overdue.
  //
  // The column is next_expected_visit. This queried next_expected_visit,
  // which has never existed on clients (it exists on client_intelligence),
  // so PostgREST rejected the WHOLE select and this nudge found nobody, ever.
  // The error was discarded, which is why nothing ever said so.
  //
  // Same story a second time with last_whatsapp_inbound_at, which is in no
  // migration either, so the select stayed rejected even after the first
  // rename. Nothing here read it: it was carried only so sendNudge could
  // decide whether the 24h WhatsApp window was open, and sendNudge now asks
  // the messages table itself (notifications.js inWhatsAppSession).
  //
  // marketing_opted_out_at, marketing_consent and messaging_autonomy are here
  // because this row is handed to guardedSend as `client`, and the gate only
  // re-reads the client when it is given none. A row without those columns has
  // marketing_opted_out_at === undefined, the opt-out branch never fires, and
  // a client who replied STOP is nudged anyway. Under-selecting here is a PECR
  // breach, not a missing field.
  const { data: clients, error: clientsErr } = await supabase
    .from('clients')
    .select('id, first_name, last_name, phone, email, whatsapp_id, next_expected_visit, marketing_consent, marketing_opted_out_at, messaging_autonomy')
    .eq('beautician_id', beauticianId)
    .not('next_expected_visit', 'is', null)
    .lt('next_expected_visit', new Date().toISOString())
    .eq('status', 'active');

  if (clientsErr) {
    logger.error({ err: clientsErr, beauticianId }, 'rebook-due lookup failed');
    return 0;
  }
  if (!clients?.length) return 0;

  // Only process clients overdue by 3+ days (avoid nagging), and never nudge a
  // client who's already booked in for a future appointment.
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const booked = await getFutureBookedClientIds(beauticianId);
  const overdue = clients.filter(c => c.next_expected_visit < threeDaysAgo && !booked.has(c.id));

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

      const nudgeBody = `Hey ${client.first_name}! It's been a while since your last visit. We'd love to see you again. Fancy booking in? 💕`;
      try {
        let sent = null;
        const guard = await guardedSend({
          beauticianId,
          clientId: client.id,
          messageType: 'rebook_nudge',
          channel: beauticianPrefs.whatsapp_connected ? 'whatsapp' : 'sms',
          client,
          body: nudgeBody,
          send: async () => {
            sent = await sendNudge({
              client,
              body: nudgeBody,
              templateName: 'rebook_nudge_v2',
              templateParams: [client.first_name],
              beauticianId,
              beauticianPrefs,
            });
            return sent;
          },
        });
        if (guard.delivered && sent) {
          await logAction(beauticianId, 'rebook_nudge', 'executed', `${summary} (via ${sent.channel})`, confidence, client.id);
        } else if (guard.decision === 'approve') {
          await logAction(beauticianId, 'rebook_nudge', 'pending_approval', summary, confidence, client.id);
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
 * 3. REMOVED: checkUnansweredMessages.
 *
 * It queried `.eq('replied', false)`. There is no `replied` column on messages
 * and never has been, so the query errored 42703 every run, `data` came back
 * null, and the function returned 0. It had never once done anything.
 *
 * It was not harmless. It selected `clients(first_name, last_name, phone)` with
 * NO id, so `isKnownClient(bid, undefined, ...)` returned false, the
 * known-client hold was skipped entirely, and every inbound message from the
 * last four hours would have been auto-replied by SMS, every two hours. The
 * moment anyone added a `replied` column it would have woken up as a full
 * auto-send bypass, straight past the guard that exists precisely to stop
 * Florrie speaking to Ellie's clients unprompted.
 *
 * Deleted rather than fixed. Inbound messages are already handled the moment
 * they arrive, by the webhook calling processInboundMessage. A second sweep
 * over the same messages was only ever going to double-reply.
 */

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

  /* THE FILTER THAT MEANT THIS REMINDER HAD NEVER FIRED FOR ANYBODY.
   *
   * This selected `.eq('result', 'pass')`. Every patch_tests row in production
   * says result = 'pending': nothing in this codebase has ever written 'pass'
   * except the one form where a human types it, and nobody has. So the query
   * matched zero rows on every run since it shipped and not one client has
   * ever been told her patch test was about to lapse.
   *
   * The filter is gone. A row is a candidate on its DATE, which is the thing
   * this function is actually about, and whether it counts as a patch test at
   * all is then decided by the one implementation of that rule, below. The
   * error is read too: PostgREST reports a bad select by RESOLVING with
   * { data: null, error }, and a swallowed error here looks exactly like
   * "nobody is due", which is how this went unnoticed for so long.
   */
  const { data: expiringTests, error: expiringErr } = await supabase
    .from('patch_tests')
    .select('id, client_id, test_date, clients(id, first_name, last_name, phone, whatsapp_id, email, marketing_consent, marketing_opted_out_at, messaging_autonomy)')
    .eq('beautician_id', beauticianId)
    .gte('test_date', lowerBound.toISOString().split('T')[0])
    .lte('test_date', cutoffDate.toISOString().split('T')[0]);

  if (expiringErr) {
    logger.warn({ err: expiringErr, beauticianId }, 'Patch test expiry sweep could not read patch_tests; nobody reminded');
    return 0;
  }
  if (!expiringTests?.length) return 0;

  const beauticianPrefs = {
    whatsapp_connected: !!b.whatsapp_phone_id,
    ...(b.client_reminder_prefs || {}),
  };

  let sent = 0;

  const remindedClients = new Set();

  for (const test of expiringTests) {
    const client = test.clients;
    if (!client) continue;
    // One row per client, not per test: she may have several on file.
    if (remindedClients.has(client.id)) continue;

    /* IS THIS ACTUALLY A PATCH TEST THAT IS ABOUT TO LAPSE?
     *
     * The date window above found a row. Only the shared rule can say whether
     * it counts, and the shared rule is also the only thing that knows the
     * owner may have recorded a NEWER one herself, in which case there is
     * nothing lapsing and this message would be wrong.
     *
     * Judged as of today, because "your patch test is expiring" is a statement
     * about now. patchTestEvidence keeps its asOf contract for the callers
     * that are asking about a specific booking.
     */
    const stance = patchTestStance(await patchTestEvidence(supabase, beauticianId, client.id, {
      expiryMonths, logger,
    }));
    // Covered today and lapsing shortly is exactly who this is for. Anything
    // else (no record, a reaction, a failed read) is not a client to text a
    // cheerful expiry note to, and the ones with nothing on file are already
    // the owner's list on the Patch Tests page.
    if (stance.status !== 'satisfied') continue;
    remindedClients.add(client.id);

    // Dedup: check if we've already sent a patch test reminder in the last 7 days
    const { count } = await supabase
      .from('ai_actions')
      .select('id', { count: 'exact', head: true })
      .eq('beautician_id', beauticianId)
      .eq('action_type', 'patch_test_reminder')
      .eq('client_id', client.id)
      .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

    if ((count || 0) > 0) continue;

    // Count from the most recent thing ON RECORD, not from the row the date
    // window happened to match. If Ellie recorded a fresher test last week,
    // that is the one that expires, and it is not expiring this month.
    const expiryDate = new Date(stance.evidenceDate || test.test_date);
    expiryDate.setMonth(expiryDate.getMonth() + expiryMonths);
    const daysLeft = Math.ceil((expiryDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
    // The date window matched a row; the record may hold a fresher one. Only
    // send when the thing actually on record is the thing actually lapsing, so
    // "expiring in 4 days" is never said about a test with five months left.
    if (daysLeft < 0 || daysLeft > remindDaysBefore) continue;

    const nudgeBody = `Hi ${client.first_name}! Just a heads up, your patch test is expiring in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}. You'll need a fresh one before your next tint or lift appointment. Give us a message to book one in 💕`;

    try {
      // BELOW THE GATE. This called sendNudge directly, so a client set to
      // 'just me', a client already at the frequency cap, and a client it is
      // 23:00 for all got the text anyway, and none of it was recorded in
      // outbound_sends where the cross-engine cap reads from. Ten lines further
      // up the same file, checkRebookDueClients had been doing it correctly.
      //
      // 'patch_test_reminder' is deliberately NOT one of the transactional
      // types. Nobody asked for this message; it is Florrie noticing a date and
      // reaching out, which is the definition of proactive. It gets consent,
      // quiet hours, the cap, the allowance reserve and the autonomy dial, and
      // on the default 'ask' setting it lands in Ellie's outbox for a one-tap
      // approve rather than going out on its own.
      let result = null;
      const guard = await guardedSend({
        beauticianId,
        clientId: client.id,
        messageType: 'patch_test_reminder',
        channel: beauticianPrefs.whatsapp_connected ? 'whatsapp' : 'sms',
        client,
        body: nudgeBody,
        send: async () => {
          result = await sendNudge({
            client,
            body: nudgeBody,
            beauticianId,
            beauticianPrefs,
          });
          return result;
        },
      });

      if (guard.delivered && result) {
        await logAction(
          beauticianId,
          'patch_test_reminder',
          'executed',
          `Patch test reminder sent to ${client.first_name}, expires in ${daysLeft} days`,
          0.95,
          client.id
        );
        sent++;
      } else if (guard.decision === 'approve') {
        await logAction(
          beauticianId,
          'patch_test_reminder',
          'pending_approval',
          `Patch test reminder for ${client.first_name}, expires in ${daysLeft} days`,
          0.95,
          client.id
        );
      } else {
        logger.info({ clientId: client.id, reason: guard.reason }, 'Patch test reminder held by the outbound gate');
      }
    } catch (err) {
      logger.warn({ err, clientId: client.id }, 'Failed to send patch test reminder');
    }
  }

  return sent;
}

/**
 * 6. Pre-appointment requirements reminder. For NEW clients only (first visit,
 *    no prior completed appointment), for appointments 24-72h away, nudge them if
 *    their treatment needs a patch test they haven't got/booked, or if they have
 *    an outstanding consultation form. Reminds, never blocks. One per appointment.
 */
async function checkPreAppointmentRequirements(beauticianId) {
  const { data: b } = await supabase
    .from('beauticians')
    .select('booking_slug, patch_test_auto_remind, patch_test_expiry_months, whatsapp_phone_id, client_reminder_prefs')
    .eq('id', beauticianId)
    .maybeSingle();
  if (!b) return 0;

  const now = new Date();
  // 24-72h out: enough lead time to act (a patch test must be booked >=24h before).
  const windowStart = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const windowEnd = new Date(now.getTime() + 72 * 60 * 60 * 1000);

  const { data: appts } = await supabase
    .from('appointments')
    // clients.last_whatsapp_inbound_at was in this embed and is in no
    // migration, so PostgREST rejected the whole select, `appts` came back
    // null, and this returned 0 on every run since it shipped. That is not a
    // cosmetic miss: a first-time client booked for a lash lift was never told
    // she needs a patch test at least 24 hours beforehand, and that reminder
    // exists for a safety reason. The 24h-window question it was fetched for
    // is answered from the messages table now.
    .select('id, starts_at, client_id, management_token, treatments(name, requires_patch_test, requires_consultation), clients(id, first_name, last_name, phone, whatsapp_id, email, imported_from, marketing_consent, marketing_opted_out_at, messaging_autonomy)')
    .eq('beautician_id', beauticianId)
    .in('status', ['confirmed', 'pending'])
    .gte('starts_at', windowStart.toISOString())
    .lte('starts_at', windowEnd.toISOString());
  if (!appts?.length) return 0;

  const expiryMonths = b.patch_test_expiry_months || 6;
  const beauticianPrefs = { whatsapp_connected: !!b.whatsapp_phone_id, ...(b.client_reminder_prefs || {}) };
  const FRONTEND = process.env.FRONTEND_URL || 'https://florrie.ai';
  let sent = 0;

  for (const appt of appts) {
    const client = appt.clients;
    const t = appt.treatments;
    if (!client || !t) continue;
    if (!t.requires_patch_test && !t.requires_consultation) continue;

    /* WHO IS ACTUALLY NEW, AND WHY BOTH OF THE OLD TESTS WERE WRONG.
     *
     * This used to skip on `client.imported_from`, with the comment "they're
     * established clients from the old system, already past patch tests /
     * forms". 926 of the pilot salon's 1,151 clients are imported from Timely
     * and 277 of them have no history of any kind: total_visits = 0,
     * last_visit_at NULL, no completed appointment. They are first timers, and
     * this line silently withheld the one safety reminder they needed. One of
     * them wrote at 01:18 on 27 August 2026 asking whether she needed a patch
     * test for the 3rd of September, because nothing had told her.
     *
     * Then it skipped anyone with a completed appointment, which counts
     * Florrie-era appointments only. 673 imported regulars have none, so that
     * test called every one of them new.
     *
     * The right question is the one lib/patch-test-status.js answers: has she
     * been here before, on ANY history, pre-Florrie included. Only a true
     * first timer gets a "just so you are set" message.
     */
    const stance = patchTestStance(await patchTestEvidence(supabase, beauticianId, client.id, {
      expiryMonths,
      // Judged against HER APPOINTMENT, not today: a test has to cover the day
      // she is booked in for. starts_at is salon wall time in a UTC slot.
      asOf: wallDate(appt.starts_at),
      logger,
    }));
    if (stance.returningClient) continue;

    // Dedup: one pre-appointment reminder per appointment.
    const { count } = await supabase
      .from('ai_actions')
      .select('id', { count: 'exact', head: true })
      .eq('beautician_id', beauticianId)
      .eq('action_type', 'prearrival_reminder')
      .eq('appointment_id', appt.id);
    if ((count || 0) > 0) continue;

    const parts = [];
    let needsPatchTest = false;

    /* Patch test gap (gated on the same toggle as expiry reminders).
     *
     * THE SECOND BROKEN COPY OF THE RULE. It tested `p.status === 'passed'`,
     * a spelling nothing writes and the CHECK constraint on patch_tests.result
     * rejects with 23514, so `hasValid` was false for everybody. An owner could
     * record a patch test herself, on the page built for it, and this would
     * still text the client telling her to book one. It also missed a test the
     * client had come in and had, because a completed patch test appointment
     * was never read as evidence.
     *
     * One implementation now, and `tellClient` is true for exactly one
     * population: the client we know has never been here.
     */
    if (t.requires_patch_test && b.patch_test_auto_remind) {
      if (stance.tellClient) {
        needsPatchTest = true;
        const link = appt.management_token ? `${FRONTEND}/book/${b.booking_slug}/manage/${appt.management_token}?book=patch` : null;
        parts.push(`you'll need a quick patch test beforehand${link ? `, you can book one here: ${link}` : ''}`);
      }
    }

    // Outstanding consultation form (a pending response for this client).
    if (t.requires_consultation) {
      const { data: forms } = await supabase
        .from('consultation_responses')
        .select('token, form_url')
        .eq('client_id', client.id)
        .eq('beautician_id', beauticianId)
        .eq('status', 'pending')
        .limit(1);
      const form = (forms || [])[0];
      if (form) {
        const formLink = form.form_url || (form.token ? `${FRONTEND}/form/${form.token}` : null);
        parts.push(`please fill in your consultation form${formLink ? `: ${formLink}` : ''}`);
      }
    }

    if (!parts.length) continue;

    const apptDay = new Date(appt.starts_at).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    const body = `Hi ${client.first_name}! Looking forward to your ${t.name} on ${apptDay}. Just so you're all set, ${parts.join(', and ')}. Any questions, message me 💕`;

    try {
      // BELOW THE GATE, same bypass as the patch-test expiry reminder above.
      //
      // This one is TRANSACTIONAL, and deliberately so: it is about a booking
      // this client has already made, in the next 24 to 72 hours, and it tells
      // her the one thing she has to do before she can be treated. 'patch_test'
      // and 'consultation_form' are both in the guard's transactional set
      // (lib/outbound-guard.js), so it passes straight through rather than
      // waiting in an approvals queue that would not be read in time. Going
      // through guardedSend still means the master pause applies, the send is
      // recorded in outbound_sends so other engines' frequency caps can see it,
      // and if this category is ever reclassified this sender obeys without
      // anyone having to remember it exists.
      const messageType = needsPatchTest ? 'patch_test' : 'consultation_form';
      let result = null;
      const guard = await guardedSend({
        beauticianId,
        clientId: client.id,
        messageType,
        channel: beauticianPrefs.whatsapp_connected ? 'whatsapp' : 'sms',
        client,
        body,
        send: async () => {
          result = await sendNudge({ client, body, beauticianId, beauticianPrefs });
          return result;
        },
      });
      if (guard.delivered && result) {
        await supabase.from('ai_actions').insert({
          beautician_id: beauticianId,
          action_type: 'prearrival_reminder',
          outcome: normaliseOutcome('executed'),
          summary: `Pre-appointment reminder sent to ${client.first_name} (${parts.length} thing${parts.length > 1 ? 's' : ''} to do before ${t.name})`,
          confidence: 0.95,
          client_id: client.id,
          appointment_id: appt.id,
          digital_employee: 'front_desk',
          created_at: new Date().toISOString(),
        });
        sent++;
      } else {
        logger.warn({ apptId: appt.id, decision: guard.decision, reason: guard.reason },
          'Pre-appointment requirements reminder not delivered');
      }
    } catch (err) {
      logger.warn({ err, apptId: appt.id }, 'Failed to send pre-appointment reminder');
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
