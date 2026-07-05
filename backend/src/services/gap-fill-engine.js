/**
 * Gap-Fill Engine, Proactive calendar gap matcher.
 *
 * Scans the next 7 days of each beautician's calendar, finds gaps ≥30 min,
 * then cross-references three pools of potential fills:
 *
 *   1. Waitlist, clients explicitly waiting for a slot (highest priority)
 *   2. Rebook overdue, clients past their predicted next visit (medium)
 *   3. Dormant, clients absent 60+ days (lowest, comeback offer)
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
import { guardedSend, recordOutbound } from '../lib/outbound-guard.js';
import { getFutureBookedClientIds } from '../lib/future-bookings.js';
import { getLoyaltyConfig, getClientPoints, loyaltyProximity } from './loyalty.js';
import { getActivePromos, describePromo } from '../lib/promos.js';
import logger from '../lib/logger.js';

const MAX_OFFERS_PER_CYCLE = 5;    // Don't spam, cap per beautician per run
const MAX_OFFERS_PER_GAP = 3;      // One slot goes to at most 3 people TOTAL
                                   // (cumulative across runs), or every cron
                                   // tick walks 5 more clients into the same
                                   // gap and one Monday 13:30 collects the
                                   // entire rebook pool
const GAP_MIN_MINUTES = 30;        // Ignore gaps shorter than this
const DORMANT_THRESHOLD_DAYS = 60; // 60+ days = dormant client
const REBOOK_GRACE_DAYS = 3;       // (legacy) Only nudge if overdue by 3+ days
const REBOOK_DUE_DAYS = 30;        // Lapsed 30+ days (but < dormant) = due a rebook
const DEDUP_WINDOW_DAYS = 7;       // Don't re-contact within 7 days

/**
 * Main entry, called per beautician from autonomous-scheduler.
 * Returns { matched, sent, queued } counts.
 */
export async function checkGapFillOpportunities(beauticianId, threshold) {
  const result = { matched: 0, sent: 0, queued: 0 };

  try {
    // 1. Get beautician working hours + prefs
    const { data: beautician } = await supabase
      .from('beauticians')
      .select('working_hours, whatsapp_phone_id, client_reminder_prefs, timezone, booking_slug, autonomy')
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
    const gaps = computeWeekGaps(now, appointments || [], beautician.working_hours, beautician.timezone);
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
    // Loyalty settings once per run so offers can nod to reward proximity.
    const loyaltyConfig = await getLoyaltyConfig(beauticianId);

    // A promo line is added to gap offers only when the beautician has opted in
    // (autonomy.promos_in_offers) AND a promo is actually live. Default off.
    let promoLine = '';
    if (beautician.autonomy?.promos_in_offers === true) {
      const promos = await getActivePromos(beauticianId, 1);
      if (promos.length) promoLine = ` ${describePromo(promos[0])}.`;
    }

    const beauticianPrefs = {
      whatsapp_connected: !!beautician.whatsapp_phone_id,
      booking_slug: beautician.booking_slug || null,
      loyaltyConfig,
      promoLine,
      ...(beautician.client_reminder_prefs || {}),
    };

    let offersSent = 0;

    for (const gap of gaps) {
      if (offersSent >= MAX_OFFERS_PER_CYCLE) break;

      // Cumulative cap: count offers ALREADY out for this slot (any previous
      // run) and never let the total pass MAX_OFFERS_PER_GAP.
      const slotTag = `${gap.dayLabel || gap.date} ${gap.start}`;
      let gapOffers = recentlyContacted.offersForSlot ? recentlyContacted.offersForSlot(slotTag) : 0;
      if (gapOffers >= MAX_OFFERS_PER_GAP) continue;

      // Try waitlist first (highest priority)
      for (const waiter of waitlistPool) {
        if (gapOffers >= MAX_OFFERS_PER_GAP) break;
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
        if (sent === 'executed') { result.sent++; offersSent++; gapOffers++; }
        else if (sent === 'queued') { result.queued++; offersSent++; gapOffers++; }

        recentlyContacted.add(waiter.client_id); // Don't double-match
      }

      // Rebook overdue (medium priority)
      for (const client of rebookPool) {
        if (offersSent >= MAX_OFFERS_PER_CYCLE || gapOffers >= MAX_OFFERS_PER_GAP) break;
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
        if (sent === 'executed') { result.sent++; offersSent++; gapOffers++; }
        else if (sent === 'queued') { result.queued++; offersSent++; gapOffers++; }

        recentlyContacted.add(client.id);
      }

      // Dormant rescue (lowest priority)
      for (const client of dormantPool) {
        if (offersSent >= MAX_OFFERS_PER_CYCLE || gapOffers >= MAX_OFFERS_PER_GAP) break;
        if (recentlyContacted.has(client.id)) continue;

        const sent = await processMatch({
          beauticianId,
          client: { id: client.id, first_name: client.first_name, last_name: client.last_name, phone: client.phone, email: client.email },
          treatment: { name: client.last_treatment, duration_minutes: client.treatment_duration || 60 },
          gap,
          matchType: 'dormant_rescue',
          confidence: 0.75, // Lower, they've been gone a while
          threshold,
          beauticianPrefs,
        });

        result.matched++;
        if (sent === 'executed') { result.sent++; offersSent++; gapOffers++; }
        else if (sent === 'queued') { result.queued++; offersSent++; gapOffers++; }

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
 * GET endpoint helper, returns gap-fill suggestions for the frontend
 * without sending anything. Read-only analysis.
 */
export async function getGapFillSuggestions(beauticianId) {
  const suggestions = [];

  try {
    const { data: beautician } = await supabase
      .from('beauticians')
      .select('working_hours, timezone')
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

    const gaps = computeWeekGaps(now, appointments || [], beautician.working_hours, beautician.timezone);
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
 * Read-only diagnostic: why is (or isn't) a gap-fill card being produced?
 * Returns only counts + one gap time window (no client PII). Auth-gated.
 */
export async function gapFillDiagnostic(beauticianId) {
  const out = { working_hours_days: 0, appts_next_7d: 0, gaps_found: 0, first_gap: null,
                waitlist: 0, rebook: 0, dormant: 0, recently_contacted: 0, error: null };
  try {
    const { data: beautician } = await supabase
      .from('beauticians').select('working_hours, timezone').eq('id', beauticianId).single();
    out.working_hours_days = beautician?.working_hours ? Object.keys(beautician.working_hours).length : 0;

    const now = new Date();
    const weekEnd = new Date(now); weekEnd.setDate(now.getDate() + 7);
    const { data: appointments } = await supabase
      .from('appointments')
      .select('starts_at, duration_minutes, status, treatment_id')
      .eq('beautician_id', beauticianId)
      .gte('starts_at', now.toISOString())
      .lte('starts_at', weekEnd.toISOString())
      .neq('status', 'cancelled');
    out.appts_next_7d = (appointments || []).length;

    const gaps = computeWeekGaps(now, appointments || [], beautician?.working_hours || {}, beautician?.timezone);
    out.gaps_found = gaps.length;
    if (gaps[0]) out.first_gap = { date: gaps[0].date, start: gaps[0].start, end: gaps[0].end, mins: gaps[0].duration_minutes };

    const [waitlistPool, rebookPool, dormantPool] = await Promise.all([
      fetchWaitlistPool(beauticianId), fetchRebookPool(beauticianId), fetchDormantPool(beauticianId),
    ]);
    out.waitlist = waitlistPool.length; out.rebook = rebookPool.length; out.dormant = dormantPool.length;
    out.recently_contacted = (await fetchRecentlyContacted(beauticianId)).size;
  } catch (err) {
    out.error = String(err?.message || err);
  }
  return out;
}

/**
 * Compute all gaps ≥30 min for the next 7 days.
 */
const DEFAULT_TZ = 'Europe/London'; // fallback when beauticians.timezone is null

// Salon-local parts of a TRUE instant (like `now`): calendar date,
// minute-of-day, weekday. The server runs in UTC, so the day frame and the
// "no gaps in the past" cursor must be converted to the salon's timezone.
function localParts(instant, tz = DEFAULT_TZ) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(instant);
  const g = (t) => parts.find((x) => x.type === t)?.value;
  let hh = parseInt(g('hour'), 10); if (hh === 24) hh = 0;
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[g('weekday')];
  return { date: `${g('year')}-${g('month')}-${g('day')}`, minutes: hh * 60 + parseInt(g('minute'), 10), dow };
}

// Appointment starts_at is stored as SALON WALL TIME in the timestamp string
// (11:00 salon time is saved as 11:00Z; the calendar UI reads slice(11,16)
// for exactly this reason). So wall parts come straight off the string. An
// Intl conversion here double-shifts during BST: an 11:00 booking read as
// 12:00 made the engine offer the genuinely-booked 11:00 slot as a gap.
function wallParts(isoish) {
  const str = String(isoish || '');
  const h = parseInt(str.slice(11, 13), 10);
  const m = parseInt(str.slice(14, 16), 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return { date: str.slice(0, 10), minutes: h * 60 + m };
}

function computeWeekGaps(now, appointments, workingHours, tz = DEFAULT_TZ) {
  const gaps = [];
  const dayKeyMap = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  const apptsLocal = (appointments || [])
    .filter((a) => a.starts_at)
    .map((a) => {
      const wp = wallParts(a.starts_at);
      if (!wp) return null;
      return { date: wp.date, start: wp.minutes, duration: a.duration_minutes || 60 };
    })
    .filter(Boolean);

  const nowLocal = localParts(now, tz);

  for (let i = 0; i < 7; i++) {
    const dayParts = localParts(new Date(now.getTime() + i * 86400000), tz);
    const dayKey = dayKeyMap[dayParts.dow];
    const dayHours = workingHours[dayKey];
    if (!dayHours?.start) continue;

    const dateStr = dayParts.date;
    const dayLabel = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz || DEFAULT_TZ, weekday: 'short', day: 'numeric', month: 'short',
    }).format(new Date(`${dateStr}T12:00:00Z`));

    const [startH, startM] = dayHours.start.split(':').map(Number);
    const [endH, endM] = dayHours.end.split(':').map(Number);
    const dayStartMins = startH * 60 + startM;
    const dayEndMins = endH * 60 + endM;

    const dayAppts = apptsLocal
      .filter((a) => a.date === dateStr)
      .sort((a, b) => a.start - b.start);

    let cursor = dayStartMins;
    if (i === 0) cursor = Math.max(cursor, nowLocal.minutes);

    for (const appt of dayAppts) {
      if (appt.start > cursor) {
        const gapMins = appt.start - cursor;
        if (gapMins >= GAP_MIN_MINUTES) {
          gaps.push({ date: dateStr, dayLabel, start: minsToTime(cursor), end: minsToTime(appt.start), duration_minutes: gapMins, dayOfWeek: dayParts.dow });
        }
      }
      cursor = Math.max(cursor, appt.start + appt.duration);
    }

    if (cursor < dayEndMins) {
      const gapMins = dayEndMins - cursor;
      if (gapMins >= GAP_MIN_MINUTES) {
        gaps.push({ date: dateStr, dayLabel, start: minsToTime(cursor), end: minsToTime(dayEndMins), duration_minutes: gapMins, dayOfWeek: dayParts.dow });
      }
    }
  }

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
  // "Due a rebook": last visit is past a typical cadence but not yet dormant.
  // Derived from last_visit_at (kept fresh by the 067 trigger) because there is
  // no per-client predicted-next-visit column. Window: REBOOK_DUE_DAYS..DORMANT.
  const now = Date.now();
  const dueCutoff = new Date(now - REBOOK_DUE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const dormantCutoff = new Date(now - DORMANT_THRESHOLD_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data } = await supabase
    .from('clients')
    .select('id, first_name, last_name, phone, email, last_visit_at')
    .eq('beautician_id', beauticianId)
    .eq('status', 'active')
    .not('last_visit_at', 'is', null)
    .lt('last_visit_at', dueCutoff)
    .gte('last_visit_at', dormantCutoff)
    .order('last_visit_at', { ascending: true })
    .limit(20);

  // Skip anyone already booked in for a future appointment.
  const booked = await getFutureBookedClientIds(beauticianId);

  return (data || []).filter(c => !booked.has(c.id)).map(c => {
    const daysOverdue = Math.floor((now - new Date(c.last_visit_at).getTime()) / (24 * 60 * 60 * 1000));
    return {
      id: c.id,
      first_name: c.first_name,
      last_name: c.last_name,
      phone: c.phone,
      email: c.email,
      treatment_name: 'Treatment',
      treatment_duration: 60,
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
    .select('id, first_name, last_name, phone, email, last_visit_at')
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
    .select('client_id, summary')
    .eq('beautician_id', beauticianId)
    .like('action_type', 'gap_fill%')
    .gte('created_at', windowStart);

  const rows = data || [];
  const contacted = new Set(rows.map(a => a.client_id).filter(Boolean));
  // How many offers are already out for a given slot, matched on the slot
  // string both summary formats contain ("Mon 6 Jul 13:30").
  const offersForSlot = (slotTag) => rows.filter(r => (r.summary || '').includes(slotTag)).length;
  contacted.offersForSlot = offersForSlot;
  return contacted;
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

  // Build the message based on match type. The imported rebook pool has no
  // reliable treatment name (placeholder 'Treatment'), so never say it.
  const treatName = treatment.name && treatment.name !== 'Treatment' ? treatment.name : null;
  const bookLink = beauticianPrefs.booking_slug ? ` Or book yourself in: florrie.ai/book/${beauticianPrefs.booking_slug}` : '';
  let message;
  if (matchType === 'waitlist') {
    message = `Hi ${client.first_name}! Good news, a ${gap.duration_minutes}-min slot just opened up on ${dayLabel} at ${timeLabel}.${treatName ? ` Perfect for your ${treatName}!` : ''} Reply YES to grab it 💕`;
  } else if (matchType === 'rebook_overdue') {
    message = `Hi ${client.first_name}! It's been a while since your last visit and I have a lovely slot on ${dayLabel} at ${timeLabel}. Want me to pop you in? Just reply YES 🌸${bookLink}`;
  } else {
    message = `Hi ${client.first_name}! It's been a while and we miss you 💕 I have a slot on ${dayLabel} at ${timeLabel}. Fancy popping in?${bookLink}`;
  }

  // If this client is close to their loyalty reward, add one warm nudge line.
  // Fail soft: any loyalty hiccup just leaves the message as it was.
  try {
    if (beauticianPrefs.loyaltyConfig && client.id) {
      const points = await getClientPoints(beauticianId, client.id);
      const prox = loyaltyProximity(beauticianPrefs.loyaltyConfig, points, null);
      if (prox) message += prox.hook;
    }
  } catch (err) {
    logger.warn({ err, clientId: client.id }, 'Gap-fill loyalty hook skipped');
  }

  // Opted-in promo line (already gated + resolved once per run).
  if (beauticianPrefs.promoLine) message += beauticianPrefs.promoLine;

  // Human copy for the activity feed, not an engine log line. A held draft
  // must never read like a sent message (Ellie thought Florrie was spamming
  // when most of these were drafts waiting for her OK).
  const slotBit = `${dayLabel} ${timeLabel}`;
  const summary = `Offered ${client.first_name} the ${slotBit} slot${treatName ? ` for a ${treatName}` : ''}`;
  const draftSummary = `Drafted an offer for ${client.first_name}: the ${slotBit} slot (waiting for your OK)`;

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
        await logGapFillAction(beauticianId, actionType, 'pending_approval', draftSummary, confidence, client.id);
        return 'queued';
      }
    } catch (err) {
      logger.warn({ err, clientId: client.id }, 'Gap-fill send failed');
    }

    await logGapFillAction(beauticianId, actionType, 'failed', summary, confidence, client.id);
    return 'failed';
  }

  // Below threshold: create a REAL draft in the Outbox so Ellie can actually
  // send or bin it. This used to log only an ai_actions row - the feed said
  // 'Offered X' while nothing existed anywhere she could act on (13 phantom
  // rows for one Monday slot).
  await recordOutbound({
    beauticianId,
    clientId: client.id,
    messageType: 'gap_fill',
    channel: beauticianPrefs.whatsapp_connected ? 'whatsapp' : 'sms',
    status: 'pending_approval',
    reason: 'below_confidence_threshold',
    body: message,
  });
  await logGapFillAction(beauticianId, actionType, 'pending_approval', draftSummary, confidence, client.id);
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
