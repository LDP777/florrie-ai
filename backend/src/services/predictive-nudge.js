/**
 * Predictive Nudge Service, smarter than the basic rebook check.
 *
 * Runs daily (via cron in index.js). For each active beautician:
 *   1. Finds clients whose next_predicted_visit is within the next 7 days
 *   2. Checks the beautician's calendar for available slots around that date
 *   3. Generates a personalised nudge with a suggested time
 *   4. Queues to approval or auto-sends based on confidence_threshold
 *
 * This is the "Florrie spots you're due" magic, not nagging after they're
 * overdue, but reaching out *before* they even think about rebooking.
 */
import { supabase } from '../config.js';
import { normaliseOutcome } from '../lib/ai-actions.js';
import { sendNudge } from './notifications.js';
import { shouldAutoSend } from './sms-metering.js';
import { guardedSend } from '../lib/outbound-guard.js';
import { getFutureBookedClientIds } from '../lib/future-bookings.js';
import logger from '../lib/logger.js';

/**
 * Main entry, called by daily cron.
 */
export async function runPredictiveNudges() {
  logger.info('Predictive nudge: starting daily scan');

  try {
    const { data: beauticians } = await supabase
      .from('beauticians')
      .select('id, first_name, confidence_threshold, auto_reply_enabled, working_hours')
      .eq('auto_reply_enabled', true);

    if (!beauticians?.length) {
      logger.info('Predictive nudge: no active beauticians');
      return;
    }

    let totalNudges = 0;
    for (const b of beauticians) {
      try {
        totalNudges += await nudgeForBeautician(b);
      } catch (err) {
        logger.error({ err, beauticianId: b.id }, 'Predictive nudge failed for beautician');
      }
    }

    logger.info({ totalNudges }, 'Predictive nudge: daily scan complete');
  } catch (err) {
    logger.error({ err }, 'Predictive nudge: fatal error');
  }
}

/**
 * Find clients predicted to visit soon and match them with available slots.
 */
async function nudgeForBeautician(beautician) {
  const bid = beautician.id;
  const threshold = beautician.confidence_threshold || 0.90;
  let count = 0;

  // Window: next 3-7 days (skip the immediate 2 days to avoid being pushy)
  const windowStart = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const windowEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  // Find clients with predicted visit in the window
  const { data: intelligence, error } = await supabase
    .from('client_intelligence')
    // favourite_treatment and avg_booking_gap_days were also in this select and
    // are also not columns: the real ones are favourite_treatments (a UUID
    // array) and rebooking_rhythm_days. Nothing below this line ever read
    // either, so they are dropped rather than renamed. Left in, they would keep
    // the whole select rejected even now next_predicted_visit exists.
    //
    // clients.last_whatsapp_inbound_at was in the embed too, and is in no
    // migration. Nothing below read it; it rode along only so sendNudge could
    // check the 24h WhatsApp window, which notifications.js now answers from
    // the messages table. Left in, it kept the whole select rejected even
    // after next_predicted_visit was added.
    .select('client_id, next_predicted_visit, clients(id, first_name, last_name, phone, email, whatsapp_id, status)')
    .eq('beautician_id', bid)
    .gte('next_predicted_visit', windowStart.toISOString())
    .lte('next_predicted_visit', windowEnd.toISOString());

  // client_intelligence.next_predicted_visit did not exist, so PostgREST
  // rejected this whole select and `intelligence` came back null every time.
  // The nudge quietly returned 0 and looked like a quiet week.
  if (error) {
    logger.error({ err: error, beauticianId: bid }, 'Predictive nudge intelligence query failed');
    return 0;
  }

  if (!intelligence?.length) return 0;

  // Filter to active clients with at least one reachable channel
  const eligible = intelligence.filter(ci =>
    ci.clients?.status === 'active' && (ci.clients?.phone || ci.clients?.email)
  );

  if (!eligible.length) return 0;

  // Check we haven't already nudged these clients recently (14 days)
  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const { data: recentNudges } = await supabase
    .from('ai_actions')
    .select('client_id')
    .eq('beautician_id', bid)
    .in('action_type', ['rebook_nudge', 'predictive_nudge'])
    .gte('created_at', twoWeeksAgo);

  const recentlyNudged = new Set((recentNudges || []).map(n => n.client_id));

  // Never nudge a client who's already booked in for a future appointment.
  const booked = await getFutureBookedClientIds(bid);

  // Get available slots for the window
  const slots = await findAvailableSlots(bid, beautician.working_hours, windowStart, windowEnd);

  for (const ci of eligible.slice(0, 8)) { // Max 8 per day
    if (recentlyNudged.has(ci.client_id)) continue;
    if (booked.has(ci.client_id)) continue;

    const client = ci.clients;
    const predictedDate = new Date(ci.next_predicted_visit);
    const dayLabel = predictedDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

    // Find a slot near the predicted date
    const nearSlot = findNearestSlot(slots, predictedDate);
    const slotLabel = nearSlot
      ? `${nearSlot.date.toLocaleDateString('en-GB', { weekday: 'short' })} at ${nearSlot.time}`
      : null;

    const confidence = 0.82; // Predictive nudges, moderate-high confidence
    const summary = slotLabel
      ? `${client.first_name} is predicted to rebook around ${dayLabel}. Suggest ${slotLabel}?`
      : `${client.first_name} is predicted to rebook around ${dayLabel}. Send a nudge?`;

    const message = slotLabel
      ? `Hey ${client.first_name}! Just thinking of you. You're usually due around now, and I've got a spot on ${slotLabel} if you fancy it? 💕`
      : `Hey ${client.first_name}! You're usually due around now. Fancy booking in? I'd love to see you! 💕`;

    if (confidence >= threshold && (client.phone || client.email)) {
      const { shouldSend, reason } = await shouldAutoSend(bid, 'ai_checkin');
      if (!shouldSend) {
        logger.info({ beauticianId: bid, clientId: ci.client_id, reason }, 'AI checkin skipped by autopilot rules');
        continue;
      }

      // Fetch beautician prefs for channel routing (WhatsApp connected etc.)
      const { data: bPrefs } = await supabase
        .from('beauticians')
        .select('whatsapp_phone_id, client_reminder_prefs')
        .eq('id', bid)
        .maybeSingle();
      const beauticianPrefs = {
        whatsapp_connected: !!bPrefs?.whatsapp_phone_id,
        ...(bPrefs?.client_reminder_prefs || {}),
      };

      try {
        let sent = null;
        const guard = await guardedSend({
          beauticianId: bid,
          clientId: ci.client_id,
          messageType: 'predictive_nudge',
          channel: beauticianPrefs.whatsapp_connected ? 'whatsapp' : 'sms',
          client,
          body: message,
          send: async () => {
            sent = await sendNudge({
              client,
              body: message,
              templateName: 'rebook_nudge_v2',           // pre-approved WhatsApp template
              // The rebook invite has ONE slot, the client's name. Passing the
              // suggested slot as a second param made WhatsApp reject the whole
              // send for parameter count, so the nudge never arrived. The slot
              // still reaches her on the SMS body above.
              templateParams: [client.first_name],
              beauticianId: bid,
              beauticianPrefs,
            });
            return sent;
          },
        });
        if (guard.delivered && sent) {
          logger.info({ clientId: ci.client_id, channel: sent.channel }, 'Predictive nudge sent');
          await logNudge(bid, 'executed', `${summary} (via ${sent.channel})`, confidence, ci.client_id);
          count++;
        } else if (guard.decision === 'approve') {
          await logNudge(bid, 'pending_approval', summary, confidence, ci.client_id);
          count++;
        } else {
          logger.warn({ clientId: ci.client_id, reason: guard.reason }, 'Predictive nudge: not sent');
          await logNudge(bid, 'failed', summary, confidence, ci.client_id);
        }
      } catch (err) {
        logger.warn({ err, clientId: ci.client_id }, 'Failed to send predictive nudge');
      }
    } else {
      await logNudge(bid, 'pending_approval', summary, confidence, ci.client_id);
      count++;
    }
  }

  return count;
}

/**
 * Find available time slots in the given date range.
 */
async function findAvailableSlots(beauticianId, workingHours, start, end) {
  if (!workingHours) return [];

  // Get existing appointments in the window
  const { data: appointments } = await supabase
    .from('appointments')
    .select('starts_at, duration_minutes')
    .eq('beautician_id', beauticianId)
    .gte('starts_at', start.toISOString())
    .lte('starts_at', end.toISOString())
    .neq('status', 'cancelled');

  const bookedSlots = (appointments || []).map(a => ({
    start: new Date(a.starts_at),
    end: new Date(new Date(a.starts_at).getTime() + (a.duration_minutes || 60) * 60000),
  }));

  const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const slots = [];

  // Walk each day in the window
  const current = new Date(start);
  while (current <= end) {
    const dayKey = dayKeys[current.getDay()];
    const dayHours = workingHours[dayKey];

    if (dayHours?.start) {
      const [startH, startM] = dayHours.start.split(':').map(Number);
      const [endH, endM] = dayHours.end.split(':').map(Number);

      // Check each 30-minute slot
      for (let h = startH; h < endH || (h === endH && 0 < endM); h++) {
        for (const m of [0, 30]) {
          if (h === startH && m < startM) continue;
          if (h === endH && m >= endM) continue;

          const slotStart = new Date(current);
          slotStart.setHours(h, m, 0, 0);
          const slotEnd = new Date(slotStart.getTime() + 60 * 60000); // 1hr slot

          // Check if this slot overlaps any booking
          const isBooked = bookedSlots.some(b =>
            slotStart < b.end && slotEnd > b.start
          );

          if (!isBooked) {
            slots.push({
              date: new Date(slotStart),
              time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
            });
          }
        }
      }
    }

    current.setDate(current.getDate() + 1);
  }

  return slots;
}

/**
 * Find the nearest available slot to a target date.
 */
function findNearestSlot(slots, targetDate) {
  if (!slots.length) return null;

  let nearest = null;
  let nearestDiff = Infinity;

  for (const slot of slots) {
    const diff = Math.abs(slot.date.getTime() - targetDate.getTime());
    if (diff < nearestDiff) {
      nearestDiff = diff;
      nearest = slot;
    }
  }

  return nearest;
}

/**
 * Log a predictive nudge action.
 */
async function logNudge(beauticianId, status, summary, confidence, clientId) {
  try {
    await supabase.from('ai_actions').insert({
      beautician_id: beauticianId,
      action_type: 'predictive_nudge',
      outcome: normaliseOutcome(status),
      summary,
      confidence,
      client_id: clientId,
      digital_employee: 'comeback',
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to log predictive nudge');
  }
}
