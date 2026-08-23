/**
 * Automations service.
 *
 * WHAT LIVES HERE NOW, AND WHY THE LIST GOT SHORTER
 *
 * Five processors used to be exported from this file and NONE of them was in
 * any job in jobs/register.js. Nothing imported them except createBookingSuggestion
 * at the bottom, which is called from ai-front-desk.js. So the Aftercare page,
 * the RebookReminders page and the AutomationRules page were settings screens
 * wired to nothing: Ellie filled them in and no process ever read them back.
 *
 * Two of the five have been deleted rather than wired up.
 *
 *   processReviewRequests  DELETED. services/review-requests.js already does
 *     this, is already called (from runAutonomousCycle), already dedupes
 *     through ai_actions, and already sends through guardedSend. This copy did
 *     it a second way, ungated, off a `review_requests_sent` table nothing else
 *     touches, and selected beauticians(booking_page_url), a column in no
 *     migration, so PostgREST rejected the whole select and it returned null
 *     regardless. Registering it would have double-asked every client for a
 *     review AND bypassed the gate to do it.
 *
 *   processAutomationRules  DELETED, with findTriggerTargets and
 *     executeRuleAction. Not superseded, unbuildable as written. It read
 *     `rule.config`; the columns are trigger_config and action_config. Its
 *     trigger branches ('new_client', 'no_visit_30_days') are not in the
 *     trigger_type CHECK in 007_all_features.sql, so no such row can exist.
 *     AutomationRules.jsx inserts trigger / actions / conditions /
 *     delay_minutes / enabled / runs / last_run straight to the table, none of
 *     which are columns, so no rule can be created at all and automation_rules
 *     is empty. Its one sending action read config.message, which was always
 *     undefined, and fell through to a hardcoded "Hey {name}, just a quick
 *     message from {business}!" sent ungated to every client the trigger
 *     matched. Wiring that up would have been the single most dangerous change
 *     in this sweep. The tables and the settings page stay; the engine gets
 *     written once there is an agreed answer to what an automation rule is.
 *
 * The three that remain are registered in jobs/register.js and every one of
 * them now sends through guardedSend, so consent, the per-client autonomy
 * override, quiet hours, the frequency cap and the monthly allowance all apply.
 *
 *   1. Aftercare follow-ups   (aftercare_messages, N hours after a visit)
 *   2. Rebook nudges          (rebook_reminders, the queue Ellie fills herself)
 *   3. Follow-up sequences    (follow_up_sequences, multi-step message chains)
 *
 * All three follow the processReminders() pattern from notifications.js:
 *   - Query for due items
 *   - Send via the client's preferred channel, through the gate
 *   - Mark as sent to avoid duplicates
 *   - Return { sent, total } for logging
 */
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { sendEmail, sendSMS, sendWhatsApp } from './notifications.js';
import { shouldAutoSend } from './sms-metering.js';
import { guardedSend } from '../lib/outbound-guard.js';
import { getLoyaltyConfig, getClientPoints, loyaltyProximity } from './loyalty.js';

// messageType must match a key in DEFAULT_PRIORITY_RULES (e.g. 'aftercare_followup', 'rebook_nudge', 'review_request', 'marketing').
// shouldAutoSend() is checked before any AI-initiated SMS to respect autopilot credit rules.
async function sendOnChannel({ beautician, client, body, beauticianId, messageType = 'general', clientId = null }) {
  const prefs = beautician.client_reminder_prefs || {};
  // Master pause — halt every automated send (gap offers, rebook nudges, aftercare…).
  if (prefs.paused) {
    logger.info({ beauticianId, messageType }, 'Automated send skipped — messages paused');
    return [];
  }
  const channel = prefs.channel || 'sms';
  const bizName = beautician.business_name || beautician.first_name;

  // Replace common placeholders
  const message = body
    .replace(/\{name\}/g, client.first_name || '')
    .replace(/\{business\}/g, bizName);

  const results = [];

  // Primary channel — SMS or WhatsApp
  if (channel === 'whatsapp' && client.phone) {
    results.push(await sendWhatsApp({
      to: client.phone,
      templateName: 'generic_message_v2',
      templateParams: [client.first_name, message],
      beauticianId,
      clientId,
    }));
  } else if (client.phone) {
    // Respect autopilot credit rules for AI-initiated sends
    const { shouldSend, reason } = await shouldAutoSend(beauticianId, messageType);
    if (!shouldSend) {
      logger.info({ beauticianId, messageType, reason }, 'Autopilot SMS skipped — credit headroom below threshold');
      results.push(null);
    } else {
      results.push(await sendSMS({ to: client.phone, body: message, beauticianId, messageType , clientId }));
    }
  }

  // Email fallback (always send if client has email)
  if (client.email) {
    results.push(await sendEmail({
      to: client.email,
      subject: `A message from ${bizName}`,
      text: message,
      html: `<p>${message.replace(/\n/g, '<br>')}</p>`,
    }));
  }

  return results;
}

/**
 * sendOnChannel, but underneath the outbound safety gate.
 *
 * sendOnChannel above is the DELIVERY step and nothing else. Every processor
 * in this file is a proactive sender running on a timer with no human in the
 * loop, so none of them may call it directly: the decision about whether
 * Florrie may speak to this client at all has to come first.
 *
 * Returns { delivered, decision, reason } so callers can tell "sent" from
 * "held for approval" from "blocked", and importantly can decline to mark a
 * queue row as done when nothing actually went out.
 */
async function gatedSend({ beautician, client, body, beauticianId, clientId, messageType }) {
  const prefs = beautician?.client_reminder_prefs || {};
  const channel = prefs.channel || 'sms';
  let results = null;
  const verdict = await guardedSend({
    beauticianId,
    clientId: clientId || client?.id || null,
    messageType,
    channel,
    client,
    body,
    send: async () => {
      results = await sendOnChannel({ beautician, client, body, beauticianId, messageType, clientId });
      // sendOnChannel returns an array of per-channel results, and pushes null
      // for a channel it deliberately skipped. Delivered means at least one
      // channel actually took it.
      return Array.isArray(results) && results.some(Boolean);
    },
  });
  return { delivered: !!verdict.delivered, decision: verdict.decision, reason: verdict.reason };
}

// ═══════════════════════════════════════════════════════════════════════
// 1. AFTERCARE FOLLOW-UPS
// ═══════════════════════════════════════════════════════════════════════
/**
 * Find completed appointments that have a matching aftercare template whose
 * send window has arrived but which have not been sent yet.
 *
 * THE COLUMNS. aftercare_messages is
 *   { beautician_id, treatment_id, name, message, send_after_hours, channel,
 *     is_active }
 * (supabase/migrations/007_all_features.sql:63). `message_text` and
 * `timing_days`, which this used to read, are in neither that file nor any
 * later one.
 *
 * `timing_days` being undefined is why this could never have run even by
 * accident: `now - undefined * 86400000` is NaN, `new Date(NaN).toISOString()`
 * throws RangeError, and it threw on the first template every time.
 *
 * send_after_hours is HOURS, not days, so the arithmetic changes with the name.
 * The window is one hour wide and the job runs hourly, so nothing due falls
 * between two passes.
 *
 * We track sends via aftercare_sends: { aftercare_message_id, appointment_id,
 * sent_at }, with a UNIQUE(aftercare_message_id, appointment_id) behind it.
 */
export async function processAftercareFollowups() {
  // Get all active aftercare message templates
  const { data: templates, error } = await supabase
    .from('aftercare_messages')
    .select('id, beautician_id, treatment_id, name, message, send_after_hours, is_active, beauticians(business_name, first_name, client_reminder_prefs)')
    .eq('is_active', true);

  if (error) {
    logger.error({ err: error }, 'Aftercare template query failed');
    return { sent: 0, total: 0 };
  }
  if (!templates?.length) return { sent: 0, total: 0 };

  const now = new Date();
  let sent = 0;
  let total = 0;

  for (const tpl of templates) {
    if (!tpl.message) continue; // nothing to say
    // Find completed appointments for this treatment where aftercare is due.
    // Default 24h matches the column default, so a template saved without one
    // still behaves like the UI says it will.
    const afterHours = Number.isFinite(tpl.send_after_hours) ? tpl.send_after_hours : 24;
    const targetTime = new Date(now.getTime() - afterHours * 60 * 60 * 1000);
    // Window: appointments that ended between (afterHours + 1h) and afterHours ago
    const windowStart = new Date(targetTime.getTime() - 60 * 60 * 1000);
    const windowEnd = targetTime;

    // 'completed' only. This used to accept 'confirmed' as well, which meant a
    // booking nobody had marked as happened could still trigger "hope you're
    // loving your lashes". auto-complete runs every ten minutes and the
    // shortest aftercare delay is an hour, so anything genuinely finished is
    // 'completed' by the time this looks; anything still 'confirmed' is a
    // no-show or a cancellation waiting to be recorded.
    const { data: appointments } = await supabase
      .from('appointments')
      .select('id, beautician_id, client_id, clients(id, first_name, phone, email)')
      .eq('beautician_id', tpl.beautician_id)
      .eq('treatment_id', tpl.treatment_id)
      .eq('status', 'completed')
      .gte('ends_at', windowStart.toISOString())
      .lte('ends_at', windowEnd.toISOString());

    if (!appointments?.length) continue;

    for (const appt of appointments) {
      total++;

      // Check if already sent
      const { data: existing } = await supabase
        .from('aftercare_sends')
        .select('id')
        .eq('aftercare_message_id', tpl.id)
        .eq('appointment_id', appt.id)
        .limit(1);

      if (existing?.length) continue;

      try {
        const { delivered, decision, reason } = await gatedSend({
          beautician: tpl.beauticians,
          client: appt.clients,
          body: tpl.message,
          beauticianId: appt.beautician_id,
          messageType: 'aftercare_followup',
          clientId: appt.client_id || appt.clients?.id || null,
        });

        if (!delivered) {
          // Held or blocked. Do NOT write the aftercare_sends row: that row is
          // the dedup key, and claiming a send that never happened would
          // suppress this aftercare message for this appointment forever.
          logger.info({ appointmentId: appt.id, templateId: tpl.id, decision, reason },
            'Aftercare follow-up not delivered');
          continue;
        }

        // Record send
        await supabase.from('aftercare_sends').insert({
          aftercare_message_id: tpl.id,
          appointment_id: appt.id,
          beautician_id: appt.beautician_id,
        });

        sent++;
      } catch (err) {
        logger.error({ err, appointmentId: appt.id, templateId: tpl.id }, 'Aftercare send failed');
      }
    }
  }

  return { sent, total };
}

// ═══════════════════════════════════════════════════════════════════════
// 2. REBOOK NUDGES
// ═══════════════════════════════════════════════════════════════════════
/**
 * Find rebook_reminders where reminder_date <= now and sent = false.
 * Send the nudge, mark sent = true.
 *
 * WHY THIS ONE IS WORTH REGISTERING RATHER THAN DELETING, given that
 * autonomous-scheduler.checkRebookDueClients and predictive-nudge already send
 * rebook nudges: those two are Florrie INFERRING that somebody is due, from
 * clients.next_expected_visit and from client_intelligence. This queue is Ellie
 * DECIDING, at the chair, with the client in front of her. CalendarView's
 * "Send rebook reminder in 4 weeks" button on a completed appointment writes
 * the row (POST /api/features/rebook-reminders). It is the one rebook path
 * that carries an actual human intention, and it is the one that has never
 * fired: nothing in the codebase has ever read this table back.
 *
 * The overlap with the inference-based nudges is handled where it should be,
 * in the gate: guardedSend's cross-engine frequency cap sees a nudge sent by
 * any engine in the last 7 days and holds this one.
 *
 * The columns are real. client_id, reminder_date, message and sent were added
 * by supabase/migrations/078_schema_sweep_repairs.sql, whose own comment
 * records that the cron read reminder_date/sent and the feature wrote
 * client_id/message and none of them existed. The columns arrived; the cron
 * never did.
 *
 * reminder_date is a DATE, so it is compared against a date string, not a full
 * ISO timestamp. Comparing a date column to '2026-08-23T16:04:11.244Z' relies
 * on a cast that will not do what anyone expects at the boundary.
 */
export async function processRebookNudges() {
  const today = new Date().toISOString().slice(0, 10);

  const { data: reminders, error } = await supabase
    .from('rebook_reminders')
    .select('id, beautician_id, client_id, appointment_id, reminder_date, message, sent, clients(id, first_name, phone, email), beauticians(business_name, first_name, client_reminder_prefs, booking_slug)')
    .eq('sent', false)
    .not('client_id', 'is', null)
    .lte('reminder_date', today);

  if (error) {
    logger.error({ err: error }, 'Rebook reminder queue query failed');
    return { sent: 0, total: 0 };
  }
  if (!reminders?.length) return { sent: 0, total: 0 };

  let sent = 0;
  for (const reminder of reminders) {
    if (!reminder.clients) continue; // client deleted since the reminder was set
    try {
      const slug = reminder.beauticians?.booking_slug;
      const linkLine = slug ? ` Book in here: florrie.ai/book/${slug}` : '';
      // DELIBERATELY NOT reminder.message.
      //
      // The only thing that writes that field is CalendarView's rebook button,
      // and what it writes is a note to ELLIE: "Time to rebook Sarah for their
      // brow lamination." Sending it as-is would text that sentence to Sarah.
      // The field is a reminder note, the body below is what the client reads.
      // See the report: the frontend should either write a client-facing body
      // or the column should be renamed to `note`, and until one of those
      // happens this is the safe reading.
      let body = `Hey {name}, it's been a while! Ready for your next appointment?${linkLine} Would love to see you soon xx`;

      // Nudge towards their loyalty reward when they are close. Fail soft.
      try {
        const loyaltyConfig = await getLoyaltyConfig(reminder.beautician_id);
        if (loyaltyConfig && reminder.client_id) {
          const points = await getClientPoints(reminder.beautician_id, reminder.client_id);
          const prox = loyaltyProximity(loyaltyConfig, points, null);
          if (prox) body += prox.hook;
        }
      } catch (err) {
        logger.warn({ err, reminderId: reminder.id }, 'Rebook nudge loyalty hook skipped');
      }

      const { delivered, decision, reason } = await gatedSend({
        beautician: reminder.beauticians,
        client: reminder.clients,
        body,
        beauticianId: reminder.beautician_id,
        messageType: 'rebook_nudge',
        clientId: reminder.client_id || null,
      });

      if (!delivered) {
        // Blocked means the answer is no and will stay no (opted out, cap
        // reached, allowance spent): retire the row so it is not retried
        // hourly forever. Held for approval means the decision has moved to
        // Ellie's outbox and this row's job is done either way.
        logger.info({ reminderId: reminder.id, decision, reason }, 'Rebook nudge not delivered');
        await supabase
          .from('rebook_reminders')
          .update({ sent: true })
          .eq('id', reminder.id);
        continue;
      }

      // Mark as sent
      await supabase
        .from('rebook_reminders')
        .update({ sent: true })
        .eq('id', reminder.id);

      sent++;
    } catch (err) {
      logger.error({ err, reminderId: reminder.id }, 'Rebook nudge send failed');
    }
  }

  return { sent, total: reminders.length };
}

// ═══════════════════════════════════════════════════════════════════════
// 3 and 4, DELETED. See the header of this file for the full reasoning.
//
//   processReviewRequests   superseded by services/review-requests.js, which
//                           is called, deduped through ai_actions and gated.
//                           This copy was ungated and selected
//                           beauticians(booking_page_url), which is a column
//                           in no migration.
//
//   processAutomationRules  with findTriggerTargets and executeRuleAction.
//                           Read rule.config (the columns are trigger_config
//                           and action_config), branched on trigger types the
//                           CHECK constraint forbids, and its send_message
//                           action would have sent a hardcoded placeholder,
//                           ungated, to every matching client. automation_rules
//                           cannot hold a row today because the page inserts
//                           seven columns that do not exist. The feature needs
//                           a data model, not a rename.
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// 3. FOLLOW-UP SEQUENCE EXECUTOR
// ═══════════════════════════════════════════════════════════════════════
/**
 * Step through active follow-up sequences.
 *
 * follow_up_sequences: { beautician_id, name, trigger, treatments[], steps[], active }
 * follow_up_enrollments: { sequence_id, client_id, appointment_id, beautician_id,
 *                          enrolled_at, current_step, next_send_at, status }
 *
 * Two phases:
 *   A. Enroll new clients (completed appointments matching active sequences)
 *   B. Send due steps for existing enrollments
 *
 * REGISTERED, not deleted. This is the one of the five that works end to end
 * on both sides and was only ever missing its caller. AutomationRules.jsx's
 * Sequences tab inserts exactly { beautician_id, name, trigger, steps, active,
 * stats } and every one of those is a real column
 * (supabase/migrations/20260802_schema_drift_catchup.sql, written FROM this
 * function). Ellie can build a sequence today, it saves, it shows in the list
 * with an on/off toggle, and nothing has ever sent a step of it.
 *
 * Not a duplicate of anything: no other engine walks a multi-step chain.
 */
export async function processFollowUpSequences() {
  let enrolled = 0;
  let sent = 0;

  const { data: sequences, error: seqErr } = await supabase
    .from('follow_up_sequences')
    .select('id, beautician_id, name, trigger, treatments, steps, active')
    .eq('active', true);

  if (seqErr) {
    logger.error({ err: seqErr }, 'Follow-up sequence query failed');
    return { enrolled: 0, sent: 0 };
  }

  if (sequences?.length) {
    const now = new Date();
    const windowStart = new Date(now.getTime() - 60 * 60 * 1000); // last hour

    for (const seq of sequences) {
      if (seq.trigger !== 'after-appointment') continue;

      // Find completed appointments for matching treatments in the last hour
      let query = supabase
        .from('appointments')
        .select('id, beautician_id, client_id, treatment_id, treatments(name)')
        .eq('beautician_id', seq.beautician_id)
        // 'completed' only, same reasoning as the aftercare pass: a booking
        // still marked 'confirmed' an hour after it ended is a no-show or a
        // cancellation waiting to be recorded, and enrolling it starts a chain
        // of "hope you loved it" messages to somebody who never came.
        .eq('status', 'completed')
        .gte('ends_at', windowStart.toISOString())
        .lte('ends_at', now.toISOString());

      const { data: appointments } = await query;
      if (!appointments?.length) continue;

      for (const appt of appointments) {
        // Check if treatment matches the sequence
        const treatmentName = appt.treatments?.name;
        if (seq.treatments?.length && !seq.treatments.includes(treatmentName)) continue;

        // Check if already enrolled
        const { data: existing } = await supabase
          .from('follow_up_enrollments')
          .select('id')
          .eq('sequence_id', seq.id)
          .eq('appointment_id', appt.id)
          .limit(1);

        if (existing?.length) continue;

        // Parse the first step delay to calculate next_send_at
        const firstStep = seq.steps?.[0];
        const nextSendAt = firstStep
          ? new Date(now.getTime() + parseDelay(firstStep.delay))
          : now;

        await supabase.from('follow_up_enrollments').insert({
          sequence_id: seq.id,
          client_id: appt.client_id,
          appointment_id: appt.id,
          beautician_id: seq.beautician_id,
          enrolled_at: now.toISOString(),
          current_step: 0,
          next_send_at: nextSendAt.toISOString(),
          status: 'active',
        });

        enrolled++;
      }
    }
  }

  const now = new Date();
  const { data: dueEnrollments } = await supabase
    .from('follow_up_enrollments')
    .select('*, clients(first_name, phone, email), beauticians(business_name, first_name, client_reminder_prefs), follow_up_sequences(steps, name)')
    .eq('status', 'active')
    .lte('next_send_at', now.toISOString());

  if (dueEnrollments?.length) {
    for (const enrollment of dueEnrollments) {
      try {
        const seq = enrollment.follow_up_sequences;
        const steps = seq?.steps || [];
        const stepIndex = enrollment.current_step;

        if (stepIndex >= steps.length) {
          // Sequence complete
          await supabase
            .from('follow_up_enrollments')
            .update({ status: 'completed' })
            .eq('id', enrollment.id);
          continue;
        }

        const step = steps[stepIndex];

        let stepDelivered = false;
        if (!step?.message) {
          // A step with no body is nothing to send. Advance past it rather
          // than sending an empty message or stalling the whole enrolment.
          logger.warn({ enrollmentId: enrollment.id, stepIndex }, 'Follow-up step has no message, skipping');
        } else {
          const { delivered, decision, reason } = await gatedSend({
            beautician: enrollment.beauticians,
            client: enrollment.clients,
            body: step.message,
            beauticianId: enrollment.beautician_id,
            messageType: 'marketing',
            clientId: enrollment.client_id || null,
          });
          stepDelivered = delivered;
          if (!delivered) {
            logger.info({ enrollmentId: enrollment.id, stepIndex, decision, reason },
              'Follow-up sequence step not delivered');
          }
        }

        // Advance to next step. Deliberately advances whether or not the step
        // was delivered: a sequence is a schedule, and holding the whole chain
        // because step 2 hit the frequency cap would deliver step 3 weeks late,
        // out of context, referring to a visit nobody remembers. The gate has
        // already recorded what it held, and every later step goes through it
        // again on its own merits.
        const nextStep = stepIndex + 1;
        const nextDelay = nextStep < steps.length ? parseDelay(steps[nextStep].delay) : 0;
        const nextSendAt = nextStep < steps.length
          ? new Date(now.getTime() + nextDelay).toISOString()
          : null;

        await supabase
          .from('follow_up_enrollments')
          .update({
            current_step: nextStep,
            next_send_at: nextSendAt,
            status: nextStep >= steps.length ? 'completed' : 'active',
          })
          .eq('id', enrollment.id);

        // Count what actually went out, not what was walked past. A step the
        // gate held is progress through the sequence but it is not a send, and
        // the number this returns is what the job log reports.
        if (stepDelivered) sent++;
      } catch (err) {
        logger.error({ err, enrollmentId: enrollment.id }, 'Follow-up sequence step failed');
      }
    }
  }

  return { enrolled, sent };
}

/**
 * Parse delay strings like '0h', '24h', '3d', '7d' into milliseconds.
 */
function parseDelay(delay) {
  if (!delay) return 0;
  const match = delay.match(/^(\d+)(h|d)$/);
  if (!match) return 0;
  const val = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === 'h') return val * 60 * 60 * 1000;
  if (unit === 'd') return val * 24 * 60 * 60 * 1000;
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════
// 6. BOOKING SUGGESTIONS (suggest-and-confirm)
// ═══════════════════════════════════════════════════════════════════════
/**
 * Insert a booking suggestion for the beautician to approve.
 * Called from ai-front-desk.js instead of auto-booking.
 * The beautician sees it on their dashboard + gets a push notification.
 */
export async function createBookingSuggestion({
  beauticianId, clientId, treatmentName, suggestedDate, suggestedTime, source, messageId
}) {
  const { data, error } = await supabase
    .from('booking_suggestions')
    .insert({
      beautician_id: beauticianId,
      client_id: clientId,
      treatment_name: treatmentName,
      suggested_date: suggestedDate,
      suggested_time: suggestedTime,
      source: source || 'ai_front_desk',
      message_id: messageId || null,
      status: 'pending',
    })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Failed to create booking suggestion');
    return null;
  }

  logger.info({ suggestionId: data.id, clientId, treatmentName }, 'Booking suggestion created for beautician review');
  return data;
}
