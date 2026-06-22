/**
 * Gap-Fill Engine — Proactive calendar gap matcher.
 *
 * Scans the next 7 days of each beautician's calendar, finds gaps ≥30 min,
 * then cross-references three pools of potential fills:
 *
 *   1. Waitlist — clients explicitly waiting for a slot (highest priority)
 *   2. Rebook overdue — clients past their predicted next visit (medium)
 *   3. Dormant — clients absent 60+ days (lowest, comeback offer)
 *
 * For each match, either auto-sends a "slot opened up" message (if confidence
 * meets threshold) or queues a suggestion for the beautician to approve.
 *
 * Called by autonomous-scheduler.js every 2 hours as a 4th check.
 */
import { supabase } from '../config.js';
import { normaliseOutcome } from '../lib/ai-actions.js';
import { sendNudge } from './notifications.js';
import { shouldAutoSend } from './sms-metering.js';
import { guardedSend } from '../lib/outbound-guard.js';
import { getFutureBookedClientIds } from '../lib/future-bookings.js';
import logger from '../lib/logger.js';

const MAX_OFFERS_PER_CYCLE = 5;    // Don't spam — cap per beautician per run
const GAP_MIN_MINUTES = 30;        // Ignore gaps shorter than this
const DORMANT_THRESHOLD_DAYS = 60; // 60+ days = dormant client
const REBOOK_GRACE_DAYS = 3;       // Only nudge if overdue by 3+ days
const DEDUP_WINDOW_DAYS = 7;       // Don't re-contact within 7 days

/**
 * Main entry — called per beautician from autonomous-scheduler.
 * Returns { matched, sent, queued } counts.
 */
export async function checkGapFillOpportunities(beauticianId, threshold) {
  const result = { matched: 0, sent: 0, queued: 0 };

  try {
    // 1. Get beautician working hours + prefs
    const { data: beautician } = await supabase
      .from('beauticians')
      .select('working_hours, whatsapp_phone_id, client_reminder_prefs')
      .eq('id', beauticianId)
      .single();

    if (!beautician?.working_hours) return result;

    // 2. Get appointments for the next 7 days
    const now = new Date();
    const weekEnd = new Date(now);
    weekEnd.setDate(now.getDate() + 7);

    const { data: appointments } = await supabase
      .from('appointments')
      .select('starts_at, duration_minutes, status, treatment_id')
      .eq('beautician_id', beauticianId)
      .gte('starts_at', now.toISOString())
      .lte('starts_at', weekEnd.toISOString())
      .neq('status', 'cancelled');

    // 3. Compute gaps across the week
    const gaps = computeWeekGaps(now, appointments || [], beautician.working_hours);
    if (gaps.length === 0) return result;

    // 4. Fetch candidate pools in parallel
    const [waitlistPool, rebookPool, dormantPool] = await Promise.all([
      fetchWaitlistPool(beauticianId),
      fetchRebookPool(beauticianId),
      fetchDormantPool(beauticianId),
    ]);

    // 5. Fetch recent gap-fill actions to avoid re-contacting
    const recentlyContacted = await fetchRecentlyContacted(beauticianId);

    // 6. Match candidates to gaps
    const beauticianPrefs = {
      whatsapp_connected: !!beautician.whatsapp_phone_id,
      ...(beautician.client_reminder_prefs || {}),
    };

    let offersSent = 0;

    for (const gap of gaps) {
      if (offersSent >= MAX_OFFERS_PER_CYCLE) break;

      // Try waitlist first (highest priority)
      for (const waiter of waitlistPool) {
        if (offersSent >= MAX_OFFERS_PER_CYCLE) break;
        if (recentlyContacted.has(waiter.client_id)) continue;
        if (!fitsGap(waiter.treatment_duration, gap.duration_minutes)) continue;
        if (!matchesPreferences(waiter, gap)) continue;

        const sent = await processMatch({
          beauticianId,
          client: waiter.client,
          treatment: waiter.treatment,
          gap,
          matchType: 'waitlist',
          confidence: 0.95, // Waitlist = they asked to be notified
          threshold,
          beauticianPrefs,
        });

        result.matched++;
        if (sent === 'executed') { result.sent++; offersSent++; }
        else if (sent === 'queued') { result.queued++; offersSent++; }

        recentlyContacted.add(waiter.client_id); // Don't double-match
      }

      // Rebook overdue (medium priority)
      for (const client of rebookPool) {
        if (offersSent >= MAX_OFFERS_PER_CYCLE) break;
        if (recentlyContacted.has(client.id)) continue;
        if (!fitsGap(client.treatment_duration, gap.duration_minutes)) continue;

        const sent = await processMatch({
          beauticianId,
          client: { id: client.id, first_name: client.first_name, last_name: client.last_name, phone: client.phone, email: client.email },
          treatment: { name: client.treatment_name, duration_minutes: client.treatment_duration },
          gap,
          matchType: 'rebook_overdue',
          confidence: 0.85,
          threshold,
          beauticianPrefs,
        });

        result.matched++;
        if (sent === 'executed') { result.sent++; offersSent++; }
        else if (sent === 'queued') { result.queued++; offersSent++; }

        recentlyContacted.add(client.id);
      }

      // Dormant rescue (lowest priority)
      for (const client of dormantPool) {
        if (offersSent >= MAX_OFFERS_PER_CYCLE) break;
        if (recentlyContacted.has(client.id)) continue;

        const sent = await processMatch({
          beauticianId,
          client: { id: client.id, first_name: client.first_name, last_name: client.last_name, phone: client.phone, email: client.email },
          treatment: { name: client.last_treatment, duration_minutes: client.treatment_duration || 60 },
          gap,
          matchType: 'dormant_rescue',
          confidence: 0.75, // Lower — they've been gone a while
          threshold,
          beauticianPrefs,
        });

        result.matched++;
        if (sent === 'executed') { result.sent++; offersSent++; }
        else if (sent === 'queued') { result.queued++; offersSent++; }

        recentlyContacted.add(client.id);
      }
    }

    if (result.matched > 0) {
      logger.info({ beauticianId, ...result }, 'Gap-fill engine: matches found');
    }
  } catch (err) {
    logger.error({ err, beauticianId }, 'Gap-fill engine failed');
  }

  return result;
}

/**
 * GET endpoint helper — returns gap-fill suggestions for the frontend
 * without sending anything. Read-only analysis.
 */
export async function getGapFillSuggestions(beauticianId) {
  const suggestions = [];

  try {
    const { data: beautician } = await supabase
      .from('beauticians')
      .select('working_hours')
      .eq('id', beauticianId)
      .single();

    if (!beautician?.working_hours) return suggestions;

    const now = new Date();
    const weekEnd = new Date(now);
    weekEnd.setDate(now.getDate() + 7);

    const { data: appointments } = await supabase
      .from('appointments')
      .select('starts_at, duration_minutes, status, treatment_id')
      .eq('beautician_id', beauticianId)
      .gte('starts_at', now.toISOString())
      .lte('starts_at', weekEnd.toISOString())
      .neq('status', 'cancelled');

    const gaps = computeWeekGaps(now, appointments || [], beautician.working_hours);
    if (gaps.length === 0) return suggestions;

    const [waitlistPool, rebookPool, dormantPool] = await Promise.all([
      fetchWaitlistPool(beauticianId),
      fetchRebookPool(beauticianId),
      fetchDormantPool(beauticianId),
    ]);

    const recentlyContacted = await fetchRecentlyContacted(beauticianId);
    const seen = new Set();

    for (const gap of gaps) {
      const gapSuggestions = [];

      for (const waiter of waitlistPool) {
        if (seen.has(waiter.client_id)) continue;
        if (recentlyContacted.has(waiter.client_id)) continue;
        if (!fitsGap(waiter.treatment_duration, gap.duration_minutes)) continue;
        if (!matchesPreferences(waiter, gap)) continue;

        gapSuggestions.push({
          type: 'waitlist',
          client: waiter.client,
          treatment: waiter.treatment,
          reason: `On waitlist for ${waiter.treatment.name}`,
          confidence: 0.95,
        });
        seen.add(waiter.client_id);
      }

      for (const client of rebookPool) {
        if (seen.has(client.id)) continue;
        if (recentlyContacted.has(client.id)) continue;
        if (!fitsGap(client.treatment_duration, gap.duration_minutes)) continue;

        gapSuggestions.push({
          type: 'rebook_overdue',
          client: { id: client.id, first_name: client.first_name, last_name: client.last_name },
          treatment: { name: client.treatment_name, duration_minutes: client.treatment_duration },
          reason: `${client.treatment_name} overdue by ${client.days_overdue} days`,
          confidence: 0.85,
        });
        seen.add(client.id);
      }

      for (const client of dormantPool) {
        if (seen.has(client.id)) continue;
        if (recentlyContacted.has(client.id)) continue;

        gapSuggestions.push({
          type: 'dormant_rescue',
          client: { id: client.id, first_name: client.first_name, last_name: client.last_name },
          treatment: { name: client.last_treatment, duration_minutes: client.treatment_duration || 60 },
          reason: `Hasn't visited in ${client.days_absent} days`,
          confidence: 0.75,
        });
        seen.add(client.id);
      }

      if (gapSuggestions.length > 0) {
        suggestions.push({
          gap: {
            date: gap.date,
            dayLabel: gap.dayLabel,
            start: gap.start,
            end: gap.end,
            duration_minutes: gap.duration_minutes,
          },
          matches: gapSuggestions.slice(0, 3), // Top 3 per gap
        });
      }
    }
  } catch (err) {
    logger.error({ err, beauticianId }, 'Gap-fill suggestions query failed');
  }

  return suggestions;
}

/**
 * Compute all gaps ≥30 min for the next 7 days.
 */
function computeWeekGaps(now, appointments, workingHours) {
  const gaps = [];
  const dayKeyMap = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  for (let i = 0; i < 7; i++) {
    const date = new Date(now);
    date.setDate(now.getDate() + i);
    date.setHours(0, 0, 0, 0);

    const dayKey = dayKeyMap[date.getDay()];
    const dayHours = workingHours[dayKey];
    if (!dayHours?.start) continue;

    const dateStr = date.toISOString().split('T')[0];
    const dayLabel = date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

    const [startH, startM] = dayHours.start.split(':').map(Number);
    const [endH, endM] = dayHours.end.split(':').map(Number);
    const dayStartMins = startH * 60 + startM;
    const dayEndMins = endH * 60 + endM;

    // Get appointments for this specific day
    const dayAppts = appointments
      .filter(a => a.starts_at?.slice(0, 10) === dateStr)
      .map(a => {
        const [h, m] = a.starts_at.slice(11, 16).split(':').map(Number);
        return { start: h * 60 + m, duration: a.duration_minutes || 60 };
      })
      .sort((a, b) => a.start - b.start);

    // Walk through the day finding gaps
    let cursor = dayStartMins;

    // For today, skip past the current time
    if (i === 0) {
      const nowMins = now.getHours() * 60 + now.getMinutes();
      cursor = Math.max(cursor, nowMins);
    }

    for (const appt of dayAppts) {
      if (appt.start > cursor) {
        const gapMins = appt.start - cursor;
        if (gapMins >= GAP_MIN_MINUTES) {
          gaps.push({
            date: dateStr,
            dayLabel,
            start: minsToTime(cursor),
            end: minsToTime(appt.start),
            duration_minutes: gapMins,
            dayOfWeek: date.getDay(),
          });
        }
      }
      cursor = Math.max(cursor, appt.start + appt.duration);
    }

    // Closing gap after last appointment
    if (cursor < dayEndMins) {
      const gapMins = dayEndMins - cursor;
      if (gapMins >= GAP_MIN_MINUTES) {
        gaps.push({
          date: dateStr,
          dayLabel,
          start: minsToTime(cursor),
          end: minsToTime(dayEndMins),
          duration_minutes: gapMins,
          dayOfWeek: date.getDay(),
        });
      }
    }
  }

  // Sort by date, then by gap size descending (fill biggest gaps first)
  return gaps.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return b.duration_minutes - a.duration_minutes;
  });
}

function minsToTime(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

/**
 * Fetch active waitlist entries with treatment + client details.
 */
async function fetchWaitlistPool(beauticianId) {
  const { data } = await supabase
    .from('waitlist')
    .select('id, client_id, preferred_days, preferred_times, treatments(name, duration_minutes), clients(id, first_name, last_name, phone, email)')
    .eq('beautician_id', beauticianId)
    .in('status', ['active', 'waiting'])
    .is('notified_at', null) // Haven't been notified yet
    .order('created_at', { ascending: true });

  return (data || []).map(w => ({
    waitlist_id: w.id,
    client_id: w.clients?.id || w.client_id,
    client: {
      id: w.clients?.id || w.client_id,
      first_name: w.clients?.first_name || 'there',
      last_name: w.clients?.last_name || '',
      phone: w.clients?.phone,
      email: w.clients?.email,
    },
    treatment: {
      name: w.treatments?.name || 'Treatment',
      duration_minutes: w.treatments?.duration_minutes || 60,
    },
    treatment_duration: w.treatments?.duration_minutes || 60,
    preferred_days: w.preferred_days || [],
    preferred_times: w.preferred_times || [],
  }));
}

/**
 * Fetch clients overdue for a rebook (past predicted next visit by 3+ days).
 */
async function fetchRebookPool(beauticianId) {
  const cutoff = new Date(Date.now() - REBOOK_GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data } = await supabase
    .from('clients')
    .select('id, first_name, last_name, phone, email, next_predicted_visit, last_treatment_name, last_treatment_duration')
    .eq('beautician_id', beauticianId)
    .eq('status', 'active')
    .not('next_predicted_visit', 'is', null)
    .lt('next_predicted_visit', cutoff)
    .order('next_predicted_visit', { ascending: true })
    .limit(20);

  // Skip anyone already booked in for a future appointment.
  const booked = await getFutureBookedClientIds(beauticianId);

  return (data || []).filter(c => !booked.has(c.id)).map(c => {
    const daysOverdue = Math.floor((Date.now() - new Date(c.next_predicted_visit).getTime()) / (24 * 60 * 60 * 1000));
    return {
      ...c,
      treatment_name: c.last_treatment_name || 'Treatment',
      treatment_duration: c.last_treatment_duration || 60,
      days_overdue: daysOverdue,
    };
  });
}

/**
 * Fetch dormant clients (60+ days since last appointment).
 */
async function fetchDormantPool(beauticianId) {
  const dormantCutoff = new Date(Date.now() - DORMANT_THRESHOLD_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Clients whose last appointment was 60+ days ago
  const { data } = await supabase
    .from('clients')
    .select('id, first_name, last_name, phone, email, last_visit_at, last_treatment_name, last_treatment_duration')
    .eq('beautician_id', beauticianId)
    .eq('status', 'active')
    .not('last_visit_at', 'is', null)
    .lt('last_visit_at', dormantCutoff)
    .order('last_visit_at', { ascending: false })
    .limit(15);

  return (data || []).map(c => ({
    ...c,
    last_treatment: c.last_treatment_name || 'Treatment',
    treatment_duration: c.last_treatment_duration || 60,
    days_absent: Math.floor((Date.now() - new Date(c.last_visit_at).getTime()) / (24 * 60 * 60 * 1000)),
  }));
}

/**
 * Get set of client IDs contacted about gap-fill in the last 7 days.
 */
async function fetchRecentlyContacted(beauticianId) {
  const windowStart = new Date(Date.now() - DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data } = await supabase
    .from('ai_actions')
    .select('client_id')
    .eq('beautician_id', beauticianId)
    .in('action_type', ['gap_fill', 'gap_fill_waitlist', 'gap_fill_rebook', 'gap_fill_dormant'])
    .gte('created_at', windowStart);

  return new Set((data || []).map(a => a.client_id).filter(Boolean));
}

/**
 * Check if a treatment fits inside a gap (with 5-min buffer).
 */
function fitsGap(treatmentDuration, gapDuration) {
  return (treatmentDuration || 60) <= gapDuration + 5; // 5-min grace
}

/**
 * Check if a waitlist entry's preferred days/times match the gap.
 */
function matchesPreferences(waiter, gap) {
  // No preferences = matches everything
  if ((!waiter.preferred_days || waiter.preferred_days.length === 0) &&
      (!waiter.preferred_times || waiter.preferred_times.length === 0)) {
    return true;
  }

  // Check day preference
  if (waiter.preferred_days?.length > 0) {
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const gapDay = dayNames[gap.dayOfWeek]?.toLowerCase();
    const prefDays = waiter.preferred_days.map(d => d.toLowerCase());
    if (!prefDays.includes(gapDay)) return false;
  }

  // Check time preference (morning/afternoon/evening)
  if (waiter.preferred_times?.length > 0) {
    const [h] = gap.start.split(':').map(Number);
    const period = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
    const prefTimes = waiter.preferred_times.map(t => t.toLowerCase());
    if (!prefTimes.includes(period)) return false;
  }

  return true;
}

/**
 * Process a single gap-fill match: send or queue depending on confidence.
 */
async function processMatch({ beauticianId, client, treatment, gap, matchType, confidence, threshold, beauticianPrefs }) {
  const actionType = `gap_fill_${matchType}`;
  const dayLabel = gap.dayLabel || gap.date;
  const timeLabel = gap.start;

  // Build the message based on match type
  let message;
  if (matchType === 'waitlist') {
    message = `Hi ${client.first_name}! Great news — a ${gap.duration_minutes}-min slot just opened up on ${dayLabel} at ${timeLabel}. Perfect for your ${treatment.name}! Reply YES to grab it 💕`;
  } else if (matchType === 'rebook_overdue') {
    message = `Hi ${client.first_name}! Your ${treatment.name} is overdue and I have a lovely slot on ${dayLabel} at ${timeLabel}. Want me to pop you in? Just reply YES 🌸`;
  } else {
    message = `Hi ${client.first_name}! It's been a while and we miss you 💕 I have a slot on ${dayLabel} at ${timeLabel} — fancy popping in for your ${treatment.name}?`;
  }

  const summary = `Gap-fill: ${client.first_name} → ${dayLabel} ${timeLabel} (${matchType}, ${treatment.name})`;

  if (confidence >= threshold && (client.phone || client.email)) {
    // Check SMS metering
    const { shouldSend, reason } = await shouldAutoSend(beauticianId, 'gap_fill');
    if (!shouldSend) {
      logger.info({ beauticianId, clientId: client.id, reason }, 'Gap-fill send blocked by autopilot rules');
      return 'blocked';
    }

    try {
      let sent = null;
      const guard = await guardedSend({
        beauticianId,
        clientId: client.id,
        messageType: 'gap_fill',
        channel: beauticianPrefs.whatsapp_connected ? 'whatsapp' : 'sms',
        client,
        body: message,
        send: async () => {
          sent = await sendNudge({
            client,
            body: message,
            templateName: 'gap_fill_offer_v2',
            templateParams: [client.first_name, dayLabel, timeLabel],
            beauticianId,
            beauticianPrefs,
          });
          return sent;
        },
      });

      if (guard.delivered && sent) {
        await logGapFillAction(beauticianId, actionType, 'executed', `${summary} (via ${sent.channel})`, confidence, client.id);

        // Mark waitlist entry as notified
        if (matchType === 'waitlist' && client.waitlist_id) {
          await supabase.from('waitlist').update({ notified_at: new Date().toISOString() }).eq('id', client.waitlist_id);
        }

        return 'executed';
      }

      if (guard.decision === 'approve') {
        await logGapFillAction(beauticianId, actionType, 'pending_approval', summary, confidence, client.id);
        return 'queued';
      }
    } catch (err) {
      logger.warn({ err, clientId: client.id }, 'Gap-fill send failed');
    }

    await logGapFillAction(beauticianId, actionType, 'failed', summary, confidence, client.id);
    return 'failed';
  }

  // Below threshold — queue for approval
  await logGapFillAction(beauticianId, actionType, 'pending_approval', summary, confidence, client.id);
  return 'queued';
}

/**
 * Log a gap-fill action to ai_actions.
 */
async function logGapFillAction(beauticianId, actionType, status, summary, confidence, clientId) {
  try {
    await supabase.from('ai_actions').insert({
      beautician_id: beauticianId,
      action_type: actionType,
      outcome: normaliseOutcome(status),
      summary,
      confidence,
      client_id: clientId,
      digital_employee: 'calendar',
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to log gap-fill action');
  }
}
