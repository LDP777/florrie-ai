/**
 * Automations service — cron-compatible functions for:
 *   1. Aftercare follow-ups (send aftercare messages X days after appointment)
 *   2. Rebook nudges (send rebook reminders on their due date)
 *   3. Review requests (send review link after appointment completion)
 *   4. Automation rules engine (evaluate trigger-action rules on events)
 *   5. Follow-up sequence executor (step through multi-step message chains)
 *
 * All functions follow the processReminders() pattern from notifications.js:
 *   - Query for due items
 *   - Send via the client's preferred channel
 *   - Mark as sent to avoid duplicates
 *   - Return { sent, total } for logging
 */
import { supabase } from '../index.js';
import logger from '../lib/logger.js';
import { sendEmail, sendSMS, sendWhatsApp } from './notifications.js';

// ── Shared: send a message on the beautician's preferred channel ────────
async function sendOnChannel({ beautician, client, body, beauticianId }) {
  const prefs = beautician.client_reminder_prefs || {};
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
      templateName: 'generic_message',
      templateParams: [client.first_name, message],
    }));
  } else if (client.phone) {
    results.push(await sendSMS({ to: client.phone, body: message, beauticianId, messageType: 'marketing' }));
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

// ═══════════════════════════════════════════════════════════════════════
// 1. AFTERCARE FOLLOW-UPS
// ═══════════════════════════════════════════════════════════════════════
/**
 * Find completed appointments that have matching aftercare templates
 * whose timing_days window has arrived but haven't been sent yet.
 *
 * aftercare_messages table: { beautician_id, treatment_id, message_text, timing_days }
 * We track sends via aftercare_sends: { aftercare_message_id, appointment_id, sent_at }
 */
export async function processAftercareFollowups() {
  // Get all aftercare message templates
  const { data: templates } = await supabase
    .from('aftercare_messages')
    .select('*, beauticians(business_name, first_name, client_reminder_prefs)');

  if (!templates?.length) return { sent: 0, total: 0 };

  const now = new Date();
  let sent = 0;
  let total = 0;

  for (const tpl of templates) {
    // Find completed appointments for this treatment where aftercare is due
    const targetTime = new Date(now.getTime() - tpl.timing_days * 24 * 60 * 60 * 1000);
    // Window: appointments completed between (timing_days + 1h) and (timing_days - 0h) ago
    const windowStart = new Date(targetTime.getTime() - 60 * 60 * 1000);
    const windowEnd = targetTime;

    const { data: appointments } = await supabase
      .from('appointments')
      .select('id, beautician_id, client_id, clients(first_name, phone, email)')
      .eq('beautician_id', tpl.beautician_id)
      .eq('treatment_id', tpl.treatment_id)
      .in('status', ['completed', 'confirmed'])
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
        await sendOnChannel({
          beautician: tpl.beauticians,
          client: appt.clients,
          body: tpl.message_text,
          beauticianId: appt.beautician_id,
        });

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
 */
export async function processRebookNudges() {
  const now = new Date().toISOString();

  const { data: reminders } = await supabase
    .from('rebook_reminders')
    .select('*, clients(first_name, phone, email), beauticians(business_name, first_name, client_reminder_prefs)')
    .eq('sent', false)
    .lte('reminder_date', now);

  if (!reminders?.length) return { sent: 0, total: 0 };

  let sent = 0;
  for (const reminder of reminders) {
    try {
      const defaultMsg = `Hey {name}, it's been a while! Ready for your next appointment? Book in when you're ready — would love to see you soon xx`;
      const body = reminder.message || defaultMsg;

      await sendOnChannel({
        beautician: reminder.beauticians,
        client: reminder.clients,
        body,
        beauticianId: reminder.beautician_id,
      });

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
// 3. REVIEW REQUESTS
// ═══════════════════════════════════════════════════════════════════════
/**
 * After a completed appointment (1-2 hours later), send a review request.
 * We check for appointments that ended 1-2h ago and haven't had a review
 * request sent yet.
 *
 * Uses the beautician's google_review_link or booking_page_url.
 * Tracked via review_requests_sent: { appointment_id, beautician_id, sent_at }
 */
export async function processReviewRequests() {
  const now = new Date();
  const windowStart = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2h ago
  const windowEnd = new Date(now.getTime() - 1 * 60 * 60 * 1000);   // 1h ago

  const { data: appointments } = await supabase
    .from('appointments')
    .select('id, beautician_id, client_id, clients(first_name, phone, email), beauticians(business_name, first_name, client_reminder_prefs, google_review_link, booking_page_url)')
    .eq('status', 'completed')
    .gte('ends_at', windowStart.toISOString())
    .lte('ends_at', windowEnd.toISOString());

  if (!appointments?.length) return { sent: 0, total: 0 };

  let sent = 0;
  for (const appt of appointments) {
    // Check if already sent
    const { data: existing } = await supabase
      .from('review_requests_sent')
      .select('id')
      .eq('appointment_id', appt.id)
      .limit(1);

    if (existing?.length) continue;

    try {
      const biz = appt.beauticians;
      const bizName = biz?.business_name || biz?.first_name;
      const reviewLink = biz?.google_review_link || biz?.booking_page_url || '';
      const linkLine = reviewLink ? `\n\nLeave a review here: ${reviewLink}` : '';

      const body = `Hey {name}, thanks for coming in today! If you loved your treatment, a quick review would mean the world to me.${linkLine}\n\nThank you so much xx`;

      await sendOnChannel({
        beautician: biz,
        client: appt.clients,
        body,
        beauticianId: appt.beautician_id,
      });

      await supabase.from('review_requests_sent').insert({
        appointment_id: appt.id,
        beautician_id: appt.beautician_id,
      });

      sent++;
    } catch (err) {
      logger.error({ err, appointmentId: appt.id }, 'Review request send failed');
    }
  }

  return { sent, total: appointments.length };
}

// ═══════════════════════════════════════════════════════════════════════
// 4. AUTOMATION RULES ENGINE
// ═══════════════════════════════════════════════════════════════════════
/**
 * Evaluate all enabled automation rules against recent events.
 *
 * Supported trigger types:
 *   - appointment_completed: fires when appointment status → completed
 *   - new_client: fires when a client has their first appointment
 *   - no_visit_X_days: fires when client hasn't visited in X days
 *   - birthday: fires on client's birthday
 *
 * Supported action types:
 *   - send_message: send a message to the client
 *   - add_tag: tag the client
 *   - create_task: create a daily checklist item
 *
 * We track rule firings in automation_rule_logs to avoid duplicates.
 */
export async function processAutomationRules() {
  const { data: rules } = await supabase
    .from('automation_rules')
    .select('*')
    .eq('enabled', true);

  if (!rules?.length) return { fired: 0, total: 0 };

  const now = new Date();
  let fired = 0;

  for (const rule of rules) {
    try {
      const targets = await findTriggerTargets(rule, now);

      for (const target of targets) {
        // Check if already fired for this target
        const { data: existing } = await supabase
          .from('automation_rule_logs')
          .select('id')
          .eq('rule_id', rule.id)
          .eq('target_id', target.id)
          .limit(1);

        if (existing?.length) continue;

        await executeRuleAction(rule, target);

        // Log the firing
        await supabase.from('automation_rule_logs').insert({
          rule_id: rule.id,
          beautician_id: rule.beautician_id,
          target_id: target.id,
          target_type: target.type,
          action_type: rule.action_type,
        });

        fired++;
      }
    } catch (err) {
      logger.error({ err, ruleId: rule.id }, 'Automation rule evaluation failed');
    }
  }

  return { fired, total: rules.length };
}

async function findTriggerTargets(rule, now) {
  const config = rule.config || {};

  switch (rule.trigger_type) {
    case 'appointment_completed': {
      // Appointments completed in the last hour
      const windowStart = new Date(now.getTime() - 60 * 60 * 1000);
      const { data } = await supabase
        .from('appointments')
        .select('id, client_id, beautician_id, clients(first_name, phone, email)')
        .eq('beautician_id', rule.beautician_id)
        .eq('status', 'completed')
        .gte('ends_at', windowStart.toISOString())
        .lte('ends_at', now.toISOString());
      return (data || []).map(a => ({ ...a, id: `appt_${a.id}`, type: 'appointment', raw: a }));
    }

    case 'new_client': {
      // Clients created in the last hour
      const windowStart = new Date(now.getTime() - 60 * 60 * 1000);
      const { data } = await supabase
        .from('clients')
        .select('id, first_name, phone, email')
        .eq('beautician_id', rule.beautician_id)
        .gte('created_at', windowStart.toISOString());
      return (data || []).map(c => ({ ...c, id: `client_${c.id}`, type: 'client', raw: c }));
    }

    case 'no_visit_30_days':
    case 'no_visit_60_days':
    case 'no_visit_90_days': {
      const days = parseInt(rule.trigger_type.match(/\d+/)[0], 10);
      const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

      // Find clients whose last appointment is older than the cutoff
      const { data: clients } = await supabase
        .from('clients')
        .select('id, first_name, phone, email, last_visit_at')
        .eq('beautician_id', rule.beautician_id)
        .lte('last_visit_at', cutoff)
        .not('last_visit_at', 'is', null);

      return (clients || []).map(c => ({ ...c, id: `dormant_${c.id}_${days}d`, type: 'client', raw: c }));
    }

    case 'birthday': {
      const todayMonth = now.getMonth() + 1;
      const todayDay = now.getDate();

      const { data: clients } = await supabase
        .from('clients')
        .select('id, first_name, phone, email, date_of_birth')
        .eq('beautician_id', rule.beautician_id)
        .not('date_of_birth', 'is', null);

      // Filter to clients whose birthday is today
      return (clients || [])
        .filter(c => {
          const dob = new Date(c.date_of_birth);
          return dob.getMonth() + 1 === todayMonth && dob.getDate() === todayDay;
        })
        .map(c => ({ ...c, id: `bday_${c.id}_${now.toISOString().slice(0, 10)}`, type: 'client', raw: c }));
    }

    default:
      return [];
  }
}

async function executeRuleAction(rule, target) {
  const config = rule.config || {};
  const raw = target.raw || target;

  switch (rule.action_type) {
    case 'send_message': {
      const { data: beautician } = await supabase
        .from('beauticians')
        .select('business_name, first_name, client_reminder_prefs')
        .eq('id', rule.beautician_id)
        .single();

      const client = raw.clients || raw;
      await sendOnChannel({
        beautician,
        client,
        body: config.message || 'Hey {name}, just a quick message from {business}!',
        beauticianId: rule.beautician_id,
      });
      break;
    }

    case 'add_tag': {
      if (!config.tag || !raw.client_id && !raw.id) break;
      const clientId = raw.client_id || raw.id;
      // Append tag to client's tags array
      const { data: client } = await supabase
        .from('clients')
        .select('tags')
        .eq('id', clientId)
        .single();

      const tags = client?.tags || [];
      if (!tags.includes(config.tag)) {
        await supabase
          .from('clients')
          .update({ tags: [...tags, config.tag] })
          .eq('id', clientId);
      }
      break;
    }

    case 'create_task': {
      const today = now.toISOString().slice(0, 10);
      await supabase.from('daily_checklists').insert({
        beautician_id: rule.beautician_id,
        date: today,
        items: [{ text: config.task_text || `Automation: ${rule.name}`, done: false }],
        done: false,
      });
      break;
    }

    default:
      logger.warn({ actionType: rule.action_type, ruleId: rule.id }, 'Unknown automation action type');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 5. FOLLOW-UP SEQUENCE EXECUTOR
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
 */
export async function processFollowUpSequences() {
  let enrolled = 0;
  let sent = 0;

  // ── Phase A: Enroll new clients ──────────────
  const { data: sequences } = await supabase
    .from('follow_up_sequences')
    .select('*')
    .eq('active', true);

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
        .in('status', ['completed', 'confirmed'])
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

  // ── Phase B: Send due steps ──────────────
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

        await sendOnChannel({
          beautician: enrollment.beauticians,
          client: enrollment.clients,
          body: step.message,
          beauticianId: enrollment.beautician_id,
        });

        // Advance to next step
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

        sent++;
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
