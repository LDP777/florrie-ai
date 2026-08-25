import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBeautician, fetchRows, supabase } from '../lib/supabase.js';
import { useCoach } from '../contexts/CoachContext.jsx';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Button from '../components/ui/Button';
import Icon from '../components/ui/Icon';
import Money from '../components/ui/Money';

/**
 * Smart Schedule, Gap Finder & Fill Assistant.
 *
 * Scans the calendar for empty slots and suggests:
 *   1. Clients who are due for a rebook
 *   2. Waitlist matches for the gap
 *   3. One-tap message to offer the slot
 *
 * Three views:
 *   Gaps    , this week's empty slots ranked by fillability
 *   Suggest , AI-powered fill suggestions per gap
 *   Insights, schedule utilisation stats
 */

const FILLABILITY = {
  high: { label: 'Easy fill', color: '#306F33', bg: '#E8F5E9' },
  medium: { label: 'Possible', color: '#8f5500', bg: '#FFF3E0' },
  low: { label: 'Tough', color: '#c32424', bg: '#FEF2F2' },
};

const DEAD_STATUSES = ['cancelled', 'cancelled_by_client', 'cancelled_by_beautician', 'no_show'];

function computeSuggestions(clients, treatments) {
  const now = new Date();
  const rebook_due = [];
  const dormant_rescue = [];

  const treatmentById = new Map((treatments || []).map(t => [t.id, t]));
  (clients || []).forEach(c => {
    const appts = (c.appointments || [])
      .map(a => ({ date: new Date(a.starts_at || a.created_at), treatment_id: a.treatment_id, price: a.price_cents, status: a.status }))
      .filter(a => !isNaN(a.date) && a.date <= now && !DEAD_STATUSES.includes(a.status))
      .sort((a, b) => b.date - a.date);

    if (appts.length === 0) return;
    const daysSince = Math.floor((now - appts[0].date) / 86400000);

    // Compute average interval
    let avgInterval = 28;
    if (appts.length >= 2) {
      const intervals = [];
      for (let i = 0; i < appts.length - 1; i++) {
        intervals.push(Math.floor((appts[i].date - appts[i + 1].date) / 86400000));
      }
      avgInterval = Math.round(intervals.reduce((s, v) => s + v, 0) / intervals.length) || 28;
    }

    const lastT = treatmentById.get(appts[0]?.treatment_id);
    const lastTreatment = lastT?.name || 'Treatment';
    const matchingTreatment = lastT || { name: lastTreatment, duration_minutes: 45, price_cents: appts[0]?.price || 3000 };
    const clientObj = { id: c.id, first_name: c.first_name || '', last_name: c.last_name || '' };

    if (daysSince >= 60) {
      dormant_rescue.push({
        client: clientObj,
        last_visit_days: daysSince,
        treatment: matchingTreatment,
        reason: `Hasn't been in ${daysSince} days, send a comeback offer?`,
      });
    } else if (daysSince > avgInterval) {
      rebook_due.push({
        client: clientObj,
        treatment: matchingTreatment,
        days_overdue: daysSince - avgInterval,
        reason: `${lastTreatment} overdue by ${daysSince - avgInterval} days, usually rebooks every ${avgInterval} days`,
      });
    }
  });

  return {
    rebook_due: rebook_due.sort((a, b) => b.days_overdue - a.days_overdue).slice(0, 5),
    waitlist_match: [], // Populated by gap-fill engine API
    dormant_rescue: dormant_rescue.sort((a, b) => b.last_visit_days - a.last_visit_days).slice(0, 5),
  };
}

function computeDayStats(appts) {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const counts = Array(7).fill(0);
  appts.forEach(a => {
    if (!a.starts_at || DEAD_STATUSES.includes(a.status)) return;
    const d = new Date(a.starts_at);
    if (!isNaN(d)) counts[d.getDay()]++;
  });
  const workingDays = [1, 2, 3, 4, 5, 6, 0].filter(d => counts[d] > 0);
  const max = Math.max(...workingDays.map(d => counts[d]), 1);
  return workingDays
    .map(d => ({ name: dayNames[d], count: counts[d], pct: Math.round((counts[d] / max) * 100) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}

/** Minutes since midnight, from a "HH:MM" working-hours string. */
function minsOfDay(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** The next quarter hour on or after now, the granularity a slot is offered at. */
function nextQuarter(nowMins) {
  return Math.ceil(nowMins / 15) * 15;
}

/**
 * The part of a working day that can still be sold.
 *
 * Yesterday's afternoon is not capacity, and neither is this morning. The gap
 * finder has always known that (it drops finished gaps and clamps the one in
 * progress), but the utilisation sum did not, so every hour that had already
 * gone by today was counted as WORK BOOKED. Open the tab at 3pm on a Wednesday
 * with the default 9 to 5 and an empty diary and it read "15% booked, 6h
 * booked". Nobody had booked anything.
 *
 * Both sides use this now, with the same 15 minute rounding, so an empty diary
 * subtracts to exactly zero at any hour of the day.
 *
 * @returns {{start: number, end: number}|null} null when nothing sellable is left
 */
function bookableWindow(dayStartMins, dayEndMins, isToday, nowMins) {
  if (!(dayEndMins > dayStartMins)) return null;
  if (!isToday) return { start: dayStartMins, end: dayEndMins };
  const start = Math.max(dayStartMins, nextQuarter(nowMins));
  // Under a quarter of an hour left is not a slot, and the gap finder bins it
  // for the same reason.
  if (dayEndMins - start < 15) return null;
  return { start, end: dayEndMins };
}

/**
 * Total sellable minutes across the next 7 days, today counted from now on.
 *
 * Returns 0 when she has no working hours set, rather than inventing a 9 to 5
 * week. A fabricated denominator with no gaps to subtract from it reported
 * "100% booked" to an account that had never taken a booking.
 */
function computeTotalWorkMinutes(workingHours, now = new Date()) {
  if (!workingHours) return 0;
  const dayMap = { 0: 'sun', 1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri', 6: 'sat' };
  const nowMins = now.getHours() * 60 + now.getMinutes();
  let total = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    const hours = workingHours[dayMap[d.getDay()]];
    if (!hours?.start || !hours?.end) continue;
    const win = bookableWindow(minsOfDay(hours.start), minsOfDay(hours.end), i === 0, nowMins);
    if (!win) continue;
    total += win.end - win.start;
  }
  return total;
}

/**
 * Blended price of an hour of her actual price list, in pence.
 *
 * "Revenue at risk" used to be gap hours times a hardcoded £35, a number that
 * had nothing to do with anybody's prices. Null when there is nothing to work
 * it out from, and the tile says so instead of printing a made-up figure.
 */
function hourlyRatePence(treatments) {
  const rows = (treatments || []).filter(
    t => Number(t?.price_cents) > 0 && Number(t?.duration_minutes) > 0
  );
  if (!rows.length) return null;
  const pence = rows.reduce((s, t) => s + Number(t.price_cents), 0);
  const minutes = rows.reduce((s, t) => s + Number(t.duration_minutes), 0);
  if (!minutes) return null;
  return (pence / minutes) * 60;
}

export default function SmartSchedule() {
  const { beautician } = useBeautician();
  const { triggerNudge } = useCoach();
  const [gaps, setGaps] = useState([]);
  const [suggestions, setSuggestions] = useState({ rebook_due: [], waitlist_match: [], dormant_rescue: [] });
  const [allAppts, setAllAppts] = useState([]);
  const [treatments, setTreatments] = useState([]);
  const [tab, setTab] = useState('gaps');
  const [loading, setLoading] = useState(true);
  const [selectedGap, setSelectedGap] = useState(null);
  const [messageSent, setMessageSent] = useState({});
  const [copied, setCopied] = useState(false);
  const navigate = useNavigate();

  function copyBookingLink() {
    const slug = beautician?.booking_slug;
    if (!slug) { navigate('/business'); return; }
    const url = `https://florrie.ai/book/${slug}`;
    try {
      navigator.clipboard?.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      navigate('/content');
    }
  }

  // Shown when a gap (or the whole Fill Ideas tab) has no client to chase.
  // A gap with nobody due is not a dead end, you advertise it.
  function FillFallback({ compact }) {
    const slug = beautician?.booking_slug;
    return (
      <div style={compact ? styles.fillFallbackCompact : styles.fillFallback}>
        <p style={styles.fillFallbackText}>
          No clients are due for this yet. Fill it by getting the slot in front of people:
        </p>
        <button
          style={styles.offerBtn}
          onClick={e => { e.stopPropagation(); navigate('/content'); }}
        >
          Post this opening
        </button>
        <button
          style={styles.fillSecondaryBtn}
          onClick={e => { e.stopPropagation(); copyBookingLink(); }}
        >
          {copied ? 'Booking link copied' : (slug ? 'Copy booking link' : 'Set up booking link')}
        </button>
      </div>
    );
  }

  useEffect(() => {
    loadData();
  }, [beautician]);

  async function loadData() {
    setLoading(true);
    if (!beautician) {
      setLoading(false);
      return;
    }
    const now = new Date();
    const weekEnd = new Date(now);
    weekEnd.setDate(now.getDate() + 7);
    const startStr = now.toISOString().slice(0, 10);
    const endStr = weekEnd.toISOString().slice(0, 10);

    try {
      const appts = await fetchRows('appointments', beautician.id, {
        order: 'starts_at',
        ascending: true,
      });

      const thisWeekAppts = appts.filter(a =>
        a.starts_at && a.starts_at.slice(0, 10) >= startStr && a.starts_at.slice(0, 10) <= endStr
      );

      const treatmentRows = await fetchRows('treatments', beautician.id);
      setTreatments(treatmentRows || []);
      const computedGaps = computeGapsFromAppointments(thisWeekAppts, beautician.working_hours, treatmentRows);
      setGaps(computedGaps);

      // Coach nudge: alert about gap revenue if schedule has openings.
      // The nudge is a money warning, and the money has to be hers: the £35 an
      // hour that used to be hardcoded here went straight into the prompt as
      // fact. No priced treatments means no honest figure, so no warning about
      // a number we would have had to invent.
      const ratePence = hourlyRatePence(treatmentRows);
      if (computedGaps.length > 0 && ratePence) {
        const totalGapMins = computedGaps.reduce((s, g) => s + g.duration_minutes, 0);
        const totalWorkMins = computeTotalWorkMinutes(beautician.working_hours);
        const utilisation = totalWorkMins > 0 ? Math.round(((totalWorkMins - totalGapMins) / totalWorkMins) * 100) : 0;
        const revenueAtRisk = Math.round((totalGapMins / 60) * (ratePence / 100));
        triggerNudge('calendar_gaps', {
          gap_count: computedGaps.length,
          gap_hours: Math.round(totalGapMins / 60),
          revenue_at_risk: revenueAtRisk,
          utilisation,
        });
      }

      // Fetch clients for fill suggestions + real gap-fill matches
      const token = (await supabase?.auth.getSession())?.data?.session?.access_token;
      const [clientsResult, gapFillResult] = await Promise.all([
        supabase
          // treatment_name is NOT an appointments column; selecting it made
          // PostgREST reject the whole query, so Fill Ideas + Insights have
          // been silently empty since this page was built.
          ? supabase.from('clients').select('*, appointments(created_at, price_cents, starts_at, status, treatment_id)').eq('beautician_id', beautician.id)
          : Promise.resolve({ data: null }),
        token
          ? fetch(`${API_BASE}/api/features/gap-fill-suggestions`, {
              headers: { Authorization: `Bearer ${token}` },
            }).then(r => r.ok ? r.json() : { suggestions: [] }).catch(() => ({ suggestions: [] }))
          : Promise.resolve({ suggestions: [] }),
      ]);

      const clients = clientsResult?.data;
      if (clients) {
        const computed = computeSuggestions(clients, treatments);
        // Merge real waitlist matches from gap-fill engine
        const waitlistMatches = (gapFillResult.suggestions || []).flatMap(s =>
          (s.matches || []).filter(m => m.type === 'waitlist').map(m => ({
            client: m.client,
            treatment: m.treatment,
            reason: m.reason,
            gap: s.gap,
          }))
        );
        computed.waitlist_match = waitlistMatches.slice(0, 5);
        setSuggestions(computed);

        // Backfill real suggestions count onto each gap
        const totalSuggestions = computed.rebook_due.length + computed.dormant_rescue.length + computed.waitlist_match.length;
        if (totalSuggestions > 0) {
          setGaps(prev => prev.map(g => ({ ...g, suggestions: totalSuggestions })));
        }

        // Store flat appointments for insights tab
        const flat = clients.flatMap(c => c.appointments || []);
        setAllAppts(flat);
      }
    } catch (err) {
      logger.error('Failed to load appointments:', err);
      setGaps([]);
    } finally {
      setLoading(false);
    }
  }

  // Helper to compute gaps from real appointments and working hours
  function computeGapsFromAppointments(appts, workingHours, treatments) {
    const gaps = [];
    const now = new Date();
    // Wall-clock "now" in minutes + local today string, so this-morning's
    // gaps stop being offered at 8pm (they were listed all day).
    const pad2 = n => String(n).padStart(2, '0');
    const todayStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const durations = (treatments || []).map(t => t.duration_minutes || 60);
    const fitInfo = mins => {
      const fit = durations.filter(d => d <= mins).length;
      return { fitCount: fit, fitTotal: durations.length };
    };
    const liveAppts = (appts || []).filter(a => !DEAD_STATUSES.includes(a.status));
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const workingDaysMap = { 1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri', 0: 'sun', 6: 'sat' };

    for (let i = 0; i < 7; i++) {
      const date = new Date(now);
      date.setDate(now.getDate() + i);
      const dow = date.getDay();
      const dayKey = workingDaysMap[dow];
      const dayHours = workingHours?.[dayKey];
      if (!dayHours) continue;

      const dateStr = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
      const dayLabel = date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      const [startH, startM] = dayHours.start.split(':').map(Number);
      const [endH, endM] = dayHours.end.split(':').map(Number);
      const dayStartMins = startH * 60 + startM;
      const dayEndMins = endH * 60 + endM;

      const dayAppts = liveAppts
        .filter(a => a.starts_at?.slice(0, 10) === dateStr)
        .map(a => {
          const [h, m] = a.starts_at?.slice(11, 16).split(':').map(Number) || [0, 0];
          return { start: h * 60 + m, duration: a.duration_minutes || 0 };
        })
        .sort((a, b) => a.start - b.start);

      // Build gaps
      let currentTime = dayStartMins;
      dayAppts.forEach(appt => {
        if (appt.start > currentTime) {
          gaps.push({
            id: `gap-${dateStr}-${currentTime}`,
            date: dateStr,
            dayLabel,
            start: `${String(Math.floor(currentTime / 60)).padStart(2, '0')}:${String(currentTime % 60).padStart(2, '0')}`,
            end: `${String(Math.floor(appt.start / 60)).padStart(2, '0')}:${String(appt.start % 60).padStart(2, '0')}`,
            duration_minutes: appt.start - currentTime,
            fillability: appt.start - currentTime >= 60 ? 'high' : 'medium',
            ...fitInfo(appt.start - currentTime),
            suggestions: 0, // Updated after suggestions computed
          });
        }
        currentTime = appt.start + appt.duration;
      });

      // Closing gap
      if (currentTime < dayEndMins) {
        gaps.push({
          id: `gap-${dateStr}-${currentTime}`,
          date: dateStr,
          dayLabel,
          start: `${String(Math.floor(currentTime / 60)).padStart(2, '0')}:${String(currentTime % 60).padStart(2, '0')}`,
          end: `${String(Math.floor(dayEndMins / 60)).padStart(2, '0')}:${String(dayEndMins % 60).padStart(2, '0')}`,
          duration_minutes: dayEndMins - currentTime,
          fillability: dayEndMins - currentTime >= 90 ? 'high' : 'low',
          ...fitInfo(dayEndMins - currentTime),
          suggestions: 0, // Updated after suggestions computed
        });
      }
    }

    // Today: a gap that has already passed is not a gap. Drop finished ones,
    // clamp in-progress ones to the next quarter hour, bin sub-15min slivers.
    // Same bookableWindow() the utilisation total uses, so the two agree to
    // the minute and an empty diary subtracts to exactly zero booked.
    const toMins = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
    const cleaned = gaps.filter(g => {
      if (g.date !== todayStr) return true;
      const startM = toMins(g.start);
      const win = bookableWindow(startM, toMins(g.end), true, nowMins);
      if (!win) return false;
      if (win.start !== startM) {
        g.start = `${String(Math.floor(win.start / 60)).padStart(2, '0')}:${String(win.start % 60).padStart(2, '0')}`;
        g.duration_minutes = win.end - win.start;
        const fi = fitInfo(g.duration_minutes);
        g.fitCount = fi.fitCount; g.fitTotal = fi.fitTotal;
      }
      return true;
    });
    return cleaned;
  }

  // One tap: ask the gap-fill engine to offer this day's gap to its matched
  // clients, THROUGH the outbound guard (so with the dial on 'ask' the offers
  // land in the Outbox for approval, never raw sends).
  const [fillGapState, setFillGapState] = useState({});
  async function handleFillGap(gap) {
    setFillGapState(prev => ({ ...prev, [gap.id]: { busy: true } }));
    try {
      const token = (await supabase?.auth.getSession())?.data?.session?.access_token;
      const res = await fetch(`${API_BASE}/api/suggestions/fill-gap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ date: gap.date }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'failed');
      let note;
      if (d.sent > 0 && d.held > 0) note = `Offered to ${d.sent}, ${d.held} more waiting for your OK in the Outbox`;
      else if (d.sent > 0) note = `Offered to ${d.sent} client${d.sent === 1 ? '' : 's'}`;
      else if (d.held > 0) note = `${d.held} offer${d.held === 1 ? '' : 's'} waiting for your OK in the Outbox`;
      else note = d.reason || 'No clients are a fit for this slot right now';
      setFillGapState(prev => ({ ...prev, [gap.id]: { done: true, note, held: d.held > 0 } }));
    } catch (err) {
      logger.error('fill-gap failed:', err);
      setFillGapState(prev => ({ ...prev, [gap.id]: { done: true, note: 'Could not send offers, try again in a moment' } }));
    }
  }

  async function handleSendOffer(suggestion, context) {
    // context is either a gap object (has .start, .end, .date, .id) or a string ('sugg' | 'dormant')
    const isGapContext = context && typeof context === 'object';
    const key = `${suggestion.client.first_name}-${isGapContext ? context.id : context}`;

    // Optimistically mark sent so button doesn't double-fire
    setMessageSent(prev => ({ ...prev, [key]: true }));

    if (!suggestion.client.id) {
      // Dev mode or waitlist entry with no real ID, nothing to send
      return;
    }

    try {
      let message;
      if (isGapContext) {
        // Slot offer, "I have a slot free on X at Y, want it?"
        const day = context.dayLabel || context.date;
        message = `Hi ${suggestion.client.first_name}! I have a ${context.duration_minutes}-min slot free on ${day} at ${context.start}${suggestion.treatment?.name ? `, perfect for your ${suggestion.treatment.name}` : ''}. Want to grab it? Just reply YES and I'll book you in 💕`;
      } else if (context === 'dormant') {
        message = `Hi ${suggestion.client.first_name}! It's been a while and we miss you 💕 We have some slots coming up, want to come back in for your ${suggestion.treatment?.name || 'treatment'}?`;
      } else {
        // 'sugg', rebook nudge
        message = `Hi ${suggestion.client.first_name}! Just a little nudge, your ${suggestion.treatment?.name || 'appointment'} is due! Would you like to book in? Just reply and I'll sort a time for you 🌸`;
      }

      const token = (await supabase?.auth.getSession())?.data?.session?.access_token;
      const res = await fetch(`${API_BASE}/api/notifications/send-sms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ client_id: suggestion.client.id, message }),
      });

      if (!res.ok) {
        logger.error('send-sms failed', await res.text());
        // Revert optimistic update on failure
        setMessageSent(prev => ({ ...prev, [key]: false }));
      }
    } catch (err) {
      logger.error('handleSendOffer error:', err);
      setMessageSent(prev => ({ ...prev, [key]: false }));
    }
  }

  // Utilisation stats, over the hours that are still sellable: the rest of
  // today plus the next six days. Hours that have already gone by are not
  // capacity, so they can be neither booked nor open.
  const totalWorkMinutes = computeTotalWorkMinutes(beautician?.working_hours);
  const totalGapMinutes = gaps.reduce((sum, g) => sum + g.duration_minutes, 0);
  const bookedMins = Math.max(0, totalWorkMinutes - totalGapMinutes);
  const hasHours = totalWorkMinutes > 0;
  const utilisation = hasHours ? Math.round((bookedMins / totalWorkMinutes) * 100) : 0;
  const bookedHours = Math.round(bookedMins / 60);
  const gapHours = (totalGapMinutes / 60).toFixed(1);
  const ratePence = useMemo(() => hourlyRatePence(treatments), [treatments]);
  const revenueAtRisk = ratePence == null ? null : Math.round((totalGapMinutes / 60) * (ratePence / 100));

  // Insights computed from real data
  const dayStats = useMemo(() => computeDayStats(allAppts), [allAppts]);
  const hardSlots = useMemo(() => {
    const hourBuckets = {};
    gaps.forEach(g => {
      const h = g.start?.split(':')[0];
      if (!h) return;
      if (!hourBuckets[h]) hourBuckets[h] = { mins: 0, count: 0, end: g.end };
      hourBuckets[h].mins += g.duration_minutes;
      hourBuckets[h].count++;
    });
    return Object.entries(hourBuckets)
      .sort((a, b) => b[1].mins - a[1].mins)
      .slice(0, 3)
      .map(([h, v]) => ({
        slot: `${h}:00`,
        note: `${v.mins}min unused this week`,
      }));
  }, [gaps]);

  const tip = useMemo(() => {
    if (dayStats.length === 0) return null;
    const quietest = [...dayStats].sort((a, b) => a.count - b.count)[0];
    const busiest = dayStats[0];
    if (!quietest || quietest.count === 0) return null;
    return `${quietest.name}s are your quietest day. Consider a limited-time slot offer to shift demand from ${busiest.name}s.`;
  }, [dayStats]);

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>Florrie's Schedule</h1>
          <p style={styles.subtitle}>Fill gaps, maximise your week</p>
        </div>
      </div>

      {/* Utilisation bar. "This week" means the hours left in it: today from
          now on, plus the next six days. */}
      <div style={styles.utilisationCard}>
        {hasHours ? (
          <>
            <div style={styles.utilisationHeader}>
              <span style={styles.utilisationLabel}>Rest of this week</span>
              <span style={styles.utilisationPct}>{utilisation}% booked</span>
            </div>
            <div style={styles.utilisationBar}>
              <div style={{ ...styles.utilisationFill, width: `${utilisation}%` }} />
            </div>
            <div style={styles.utilisationStats}>
              <span style={styles.utilisationStat}>{bookedHours}h booked</span>
              <span style={styles.utilisationStat}>{gapHours}h open</span>
              <span style={styles.utilisationStat}>{gaps.length} gaps</span>
            </div>
          </>
        ) : (
          <>
            <div style={styles.utilisationHeader}>
              <span style={styles.utilisationLabel}>Rest of this week</span>
            </div>
            <p style={styles.utilisationEmpty}>
              No working hours set, so there is nothing to measure yet.
            </p>
            <Button variant="secondary" size="sm" onClick={() => navigate('/business')}>
              Set your hours
            </Button>
          </>
        )}
      </div>

      {/* Tabs */}
      <div style={styles.tabs}>
        {['gaps', 'suggestions', 'insights'].map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{ ...styles.tab,
              borderBottomColor: tab === t ? 'var(--accent, #92405e)' : 'transparent',
              color: tab === t ? 'var(--accent, #92405e)' : 'var(--text-muted, #6B5D54)',
            }}
          >
            {t === 'gaps' ? 'Gaps' : t === 'suggestions' ? 'Fill Ideas' : 'Insights'}
          </button>
        ))}
      </div>

      {/* === GAPS TAB === */}
      {tab === 'gaps' && (
        <div>
          {loading ? (
            <PageLoader />
          ) : gaps.length === 0 ? (
            <EmptyState icon="sparkles" title="Fully booked!" subtitle="No gaps this week. You're crushing it." />
          ) : (
            <div style={styles.gapList}>
              {gaps.map(gap => {
                // Plain English: say what actually fits in the gap, from her
                // real treatment durations, not a vague Easy/Possible/Tough.
                const fit = gap.fitTotal > 0 && gap.fitCount === gap.fitTotal
                  ? { label: 'Any treatment fits', color: '#306F33', bg: '#E8F5E9' }
                  : gap.fitCount > 0
                  ? { label: `${gap.fitCount} treatment${gap.fitCount === 1 ? '' : 's'} fit${gap.fitCount === 1 ? 's' : ''}`, color: '#8f5500', bg: '#FFF3E0' }
                  : { label: 'Too short to book', color: 'var(--text-muted, #6B5D54)', bg: 'var(--bg-subtle, #ede7e3)' };
                const fgs = fillGapState[gap.id] || {};
                return (
                  <div key={gap.id} style={styles.gapCard} onClick={() => setSelectedGap(selectedGap?.id === gap.id ? null : gap)}>
                    <div style={styles.gapHeader}>
                      <div style={styles.gapTime}>
                        <span style={styles.gapDay}>{gap.dayLabel}</span>
                        <span style={styles.gapSlot}>{gap.start} to {gap.end}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={styles.gapDuration}>{gap.duration_minutes}min</span>
                        <span style={{ ...styles.fillBadge, background: fit.bg, color: fit.color }}>
                          {fit.label}
                        </span>
                      </div>
                    </div>

                    {gap.suggestions > 0 && (
                      <span style={styles.gapSuggestHint}>
                        {gap.suggestions} idea{gap.suggestions > 1 ? 's' : ''} to fill it, tap to see
                      </span>
                    )}

                    {/* Expanded suggestions */}
                    {selectedGap?.id === gap.id && (
                      <div style={styles.gapExpanded}>
                        {/* One tap: Florrie offers this slot to matched clients,
                            through the outbound guard (Outbox approval). */}
                        {fgs.done ? (
                          <div style={{ padding: '10px 12px', borderRadius: 10, background: fgs.held ? '#FDF8EE' : 'var(--bg-subtle, #ede7e3)', fontSize: 13, color: 'var(--text-secondary, #574A42)', marginBottom: 8 }}>
                            {fgs.note}
                            {fgs.held && (
                              <button
                                onClick={e => { e.stopPropagation(); navigate('/outbox'); }}
                                style={{ ...styles.fillSecondaryBtn, marginTop: 8 }}
                              >
                                Review in Outbox
                              </button>
                            )}
                          </div>
                        ) : (
                          <button
                            onClick={e => { e.stopPropagation(); handleFillGap(gap); }}
                            disabled={!!fgs.busy}
                            style={{ ...styles.offerBtn, opacity: fgs.busy ? 0.6 : 1, marginBottom: 8 }}
                          >
                            {fgs.busy ? 'Finding who to offer it to...' : 'Have Florrie offer this slot'}
                          </button>
                        )}
                        {/* Rebook due */}
                        {suggestions.rebook_due.slice(0, gap.fillability === 'high' ? 2 : 1).map((s, i) => (
                          <div key={`rb-${i}`} style={styles.suggestionCard}>
                            <div style={styles.suggestionTop}>
                              <div style={styles.suggAvatar}>{s.client.first_name[0]}</div>
                              <div style={styles.suggInfo}>
                                <span style={styles.suggName}>{s.client.first_name} {s.client.last_name}</span>
                                <span style={styles.suggReason}>{s.reason}</span>
                              </div>
                            </div>
                            <div style={styles.suggTreatment}>
                              <span style={styles.suggTreatLabel}>{s.treatment.name}</span>
                              <span style={styles.suggTreatDur}>{s.treatment.duration_minutes}min · <Money pence={s.treatment.price_cents} /></span>
                            </div>
                            <button
                              onClick={e => { e.stopPropagation(); navigate(`/inbox?client=${s.client.id}`); }}
                              style={styles.fillSecondaryBtn}
                            >
                              Message her instead
                            </button>
                          </div>
                        ))}

                        {/* Waitlist match */}
                        {suggestions.waitlist_match.length > 0 && gap.fillability !== 'low' && (
                          <div style={styles.suggestionCard}>
                            <div style={styles.suggestionTop}>
                              <div style={{ ...styles.suggAvatar, background: '#E3F2FD' }}>
                                <span style={{ color: '#1976D2' }}>{suggestions.waitlist_match[0].client.first_name[0]}</span>
                              </div>
                              <div style={styles.suggInfo}>
                                <span style={styles.suggName}>{suggestions.waitlist_match[0].client.first_name} {suggestions.waitlist_match[0].client.last_name}</span>
                                <span style={styles.suggReason}>On waitlist, wants {suggestions.waitlist_match[0].preferred_day} {suggestions.waitlist_match[0].preferred_time}</span>
                              </div>
                            </div>
                            <button
                              onClick={e => { e.stopPropagation(); navigate(`/inbox?client=${suggestions.waitlist_match[0].client.id}`); }}
                              style={styles.fillSecondaryBtn}
                            >
                              Message her instead
                            </button>
                          </div>
                        )}

                        {/* No client due, offer to advertise the gap instead */}
                        {suggestions.rebook_due.slice(0, gap.fillability === 'high' ? 2 : 1).length === 0 &&
                          !(suggestions.waitlist_match.length > 0 && gap.fillability !== 'low') && (
                          <FillFallback compact />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* === SUGGESTIONS TAB === */}
      {tab === 'suggestions' && (
        <div>
          {suggestions.rebook_due.length === 0 &&
           suggestions.dormant_rescue.length === 0 &&
           suggestions.waitlist_match.length === 0 && (
            <div style={styles.fillHeroCard}>
              <span style={styles.fillHeroTitle}>Nobody's due to chase right now</span>
              <p style={styles.fillHeroText}>
                As soon as clients are overdue or go quiet, Florrie lists them here ready to nudge.
                Until then, the fastest way to fill {gaps.length > 0 ? `your ${gaps.length} open gap${gaps.length > 1 ? 's' : ''}` : 'your week'} is to put your slots out there.
              </p>
              <button style={styles.offerBtn} onClick={() => navigate('/content')}>Post your availability</button>
              <button style={styles.fillSecondaryBtn} onClick={copyBookingLink}>
                {copied ? 'Booking link copied' : (beautician?.booking_slug ? 'Copy booking link' : 'Set up booking link')}
              </button>
            </div>
          )}
          <div style={styles.suggSection}>
            <h3 style={styles.suggSectionTitle}><Icon name="refresh" size={14} inline /> Rebook due</h3>
            <p style={styles.suggSectionDesc}>Clients overdue for their regular appointment</p>
            {suggestions.rebook_due.map((s, i) => (
              <div key={`rb-${i}`} style={styles.suggFullCard}>
                <div style={styles.suggestionTop}>
                  <div style={styles.suggAvatar}>{s.client.first_name[0]}</div>
                  <div style={styles.suggInfo}>
                    <span style={styles.suggName}>{s.client.first_name} {s.client.last_name}</span>
                    <span style={styles.suggDetail}>{s.treatment.name}</span>
                  </div>
                  <span style={styles.overdueBadge}>{s.days_overdue}d overdue</span>
                </div>
                <p style={styles.suggReasonText}>{s.reason}</p>
                <button
                  onClick={() => navigate(`/inbox?client=${s.client.id}`)}
                  style={styles.offerBtn}
                >
                  Message her
                </button>
              </div>
            ))}
            {suggestions.rebook_due.length === 0 && (
              <p style={styles.suggEmpty}>No clients are overdue right now.</p>
            )}
          </div>

          <div style={styles.suggSection}>
            <h3 style={styles.suggSectionTitle}><Icon name="moon" size={14} inline /> Dormant rescue</h3>
            <p style={styles.suggSectionDesc}>Clients going cold, win them back</p>
            {suggestions.dormant_rescue.map((s, i) => (
              <div key={`dr-${i}`} style={styles.suggFullCard}>
                <div style={styles.suggestionTop}>
                  <div style={{ ...styles.suggAvatar, background: '#FFF3E0' }}>
                    <span style={{ color: '#B33F00' }}>{s.client.first_name[0]}</span>
                  </div>
                  <div style={styles.suggInfo}>
                    <span style={styles.suggName}>{s.client.first_name} {s.client.last_name}</span>
                    <span style={styles.suggDetail}>{s.treatment.name}</span>
                  </div>
                  <span style={{ ...styles.overdueBadge, background: '#FFF3E0', color: '#B33F00' }}>{s.last_visit_days}d ago</span>
                </div>
                <p style={styles.suggReasonText}>{s.reason}</p>
                <button
                  onClick={() => navigate(`/inbox?client=${s.client.id}`)}
                  style={styles.offerBtn}
                >
                  Message her
                </button>
              </div>
            ))}
            {suggestions.dormant_rescue.length === 0 && (
              <p style={styles.suggEmpty}>No clients have gone quiet. Nice work keeping them coming back.</p>
            )}
          </div>

          <div style={styles.suggSection}>
            <h3 style={styles.suggSectionTitle}><Icon name="list" size={14} inline /> Waitlist ready</h3>
            <p style={styles.suggSectionDesc}>Clients waiting for a slot that matches</p>
            {suggestions.waitlist_match.map((s, i) => (
              <div key={`wl-${i}`} style={styles.suggFullCard}>
                <div style={styles.suggestionTop}>
                  <div style={{ ...styles.suggAvatar, background: '#E3F2FD' }}>
                    <span style={{ color: '#1976D2' }}>{s.client.first_name[0]}</span>
                  </div>
                  <div style={styles.suggInfo}>
                    <span style={styles.suggName}>{s.client.first_name} {s.client.last_name}</span>
                    <span style={styles.suggDetail}>Wants {s.preferred_day} {s.preferred_time}</span>
                  </div>
                </div>
                <p style={styles.suggReasonText}>{s.treatment.name}, {s.treatment.duration_minutes}min</p>
              </div>
            ))}
            {suggestions.waitlist_match.length === 0 && (
              <p style={styles.suggEmpty}>Nobody on the waitlist yet. Clients who ask for a full slot land here.</p>
            )}
          </div>
        </div>
      )}

      {/* === INSIGHTS TAB === */}
      {tab === 'insights' && (
        <div>
          <div style={styles.insightGrid}>
            <div style={styles.insightCard}>
              <span style={styles.insightNum}>{utilisation}%</span>
              <span style={styles.insightLabel}>Utilisation</span>
            </div>
            <div style={styles.insightCard}>
              <span style={styles.insightNum}>{gaps.length}</span>
              <span style={styles.insightLabel}>Open gaps</span>
            </div>
            <div style={styles.insightCard}>
              <span style={styles.insightNum}>{gapHours}h</span>
              <span style={styles.insightLabel}>Empty hours</span>
            </div>
            {/* Was gap hours times a hardcoded £35, which was nobody's price.
                Now it is an hour of her own price list, and if she has not
                priced anything yet it says so rather than making one up. */}
            {revenueAtRisk == null ? (
              <div
                style={{ ...styles.insightCard, cursor: 'pointer' }}
                onClick={() => navigate('/treatments')}
                role="button"
              >
                <span style={styles.insightPrompt}>Add your prices</span>
                <span style={styles.insightLabel}>To see revenue at risk</span>
              </div>
            ) : (
              <div style={styles.insightCard}>
                <span style={styles.insightNum}>£{revenueAtRisk}</span>
                <span style={styles.insightLabel}>Revenue at risk</span>
              </div>
            )}
          </div>

          <div style={styles.insightSection}>
            <h3 style={styles.insightSectionTitle}>Busiest days</h3>
            {dayStats.length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>No appointment history yet.</p>
            ) : dayStats.map(day => (
              <div key={day.name} style={styles.dayRow}>
                <span style={styles.dayName}>{day.name}</span>
                <div style={styles.dayBar}>
                  <div style={{ ...styles.dayBarFill, width: `${day.pct}%`, background: day.pct > 85 ? '#306F33' : day.pct > 60 ? '#FF9800' : '#E57373' }} />
                </div>
                <span style={styles.dayPct}>{day.pct}%</span>
              </div>
            ))}
          </div>

          <div style={styles.insightSection}>
            <h3 style={styles.insightSectionTitle}>This week's hard slots</h3>
            {hardSlots.length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>No gaps this week, fully booked {<Icon name="sparkles" inline />}</p>
            ) : (
              <div style={styles.hardSlotList}>
                {hardSlots.map(s => (
                  <div key={s.slot} style={styles.hardSlot}>
                    <span style={styles.hardSlotText}>{s.slot}</span>
                    <span style={styles.hardSlotNote}>{s.note}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {tip && (
            <div style={styles.tipCard}>
              <span style={{ fontSize: 16, marginRight: 8 }}><Icon name="info" size={15} /></span>
              <div>
                <span style={styles.tipTitle}>Florrie's suggestion</span>
                <span style={styles.tipText}>{tip}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const styles = {
  page: {
    minHeight: 'var(--shell-viewport)', background: 'var(--bg, var(--bg, #FBF6F1))',
    fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif",
    padding: '0 16px var(--scroll-pad-bottom)', maxWidth: 480, margin: '0 auto', color: 'var(--text-primary, #241B17)',
  },
  header: { paddingTop: 8, paddingBottom: 8 },
  title: { fontSize: 22, fontWeight: 700, margin: '0 0 2px' },
  subtitle: { fontSize: 13, color: 'var(--accent, #92405e)', margin: 0, fontWeight: 500 },

  // Utilisation
  utilisationCard: {
    background: 'var(--bg-card, #FFFCF9)', borderRadius: 16, padding: 16,
    boxShadow: 'var(--elev-1)', marginBottom: 16,
  },
  utilisationHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  utilisationLabel: { fontSize: 12, color: 'var(--text-muted, #6B5D54)', textTransform: 'uppercase', letterSpacing: '0.04em' },
  utilisationPct: { fontSize: 14, fontWeight: 700, color: 'var(--text-primary, #241B17)' },
  utilisationBar: {
    height: 8, borderRadius: 'var(--radius-xs)', background: '#F0ECE8', overflow: 'hidden', marginBottom: 8,
  },
  utilisationFill: {
    height: '100%', borderRadius: 'var(--radius-xs)',
    background: 'linear-gradient(90deg, #B9466D, #C9315D)',
    transition: 'width 0.6s ease',
  },
  utilisationStats: { display: 'flex', justifyContent: 'space-between' },
  utilisationStat: { fontSize: 11, color: 'var(--text-muted, #6B5D54)' },
  utilisationEmpty: { fontSize: 13, color: 'var(--text-secondary, #574A42)', margin: '6px 0 10px', lineHeight: 1.45 },

  tabs: { display: 'flex', gap: 16, borderBottom: '1px solid #F0ECE8', marginBottom: 16 },
  tab: {
    padding: '10px 0', background: 'none', border: 'none',
    borderBottom: '2px solid transparent', fontSize: 14, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },

  // Gap cards
  gapList: { display: 'flex', flexDirection: 'column', gap: 10 },
  gapCard: {
    background: 'var(--bg-card, #FFFCF9)', borderRadius: 16, padding: 14,
    boxShadow: 'var(--elev-1)', cursor: 'pointer',
    transition: 'box-shadow 0.2s',
  },
  gapHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  gapTime: { display: 'flex', flexDirection: 'column', gap: 2 },
  gapDay: { fontSize: 12, fontWeight: 600, color: 'var(--accent, #92405e)' },
  gapSlot: { fontSize: 15, fontWeight: 700, color: 'var(--text-primary, #241B17)' },
  gapDuration: { fontSize: 11, color: 'var(--text-muted, #6B5D54)' },
  fillBadge: {
    padding: '4px 10px', borderRadius: 'var(--radius-xs)', fontSize: 11, fontWeight: 600,
  },
  gapSuggestHint: { fontSize: 12, color: '#6b6560', marginTop: 8, display: 'block' },

  // Expanded gap suggestions
  gapExpanded: {
    marginTop: 12, paddingTop: 12, borderTop: '1px solid #F5F2EF',
    display: 'flex', flexDirection: 'column', gap: 10,
  },
  suggestionCard: {
    background: 'var(--bg, var(--bg, #FBF6F1))', borderRadius: 10, padding: 12,
  },
  suggestionTop: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 },
  suggAvatar: {
    width: 34, height: 34, borderRadius: 16, background: '#FBF0F3',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 14, fontWeight: 600, color: 'var(--accent, #92405e)', flexShrink: 0,
  },
  suggInfo: { flex: 1, display: 'flex', flexDirection: 'column', gap: 1 },
  suggName: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary, #241B17)' },
  suggReason: { fontSize: 11, color: '#6b6560', lineHeight: 1.3 },
  suggDetail: { fontSize: 11, color: 'var(--text-muted, #6B5D54)' },
  suggTreatment: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '6px 0', marginBottom: 6,
  },
  suggTreatLabel: { fontSize: 12, fontWeight: 500, color: '#5A5550' },
  suggTreatDur: { fontSize: 11, color: 'var(--text-muted, #6B5D54)' },
  offerBtn: {
    width: '100%', padding: '8px 0', borderRadius: 10, border: 'none',
    background: 'var(--accent, #92405e)', color: 'var(--bg-card, #FFFCF9)', fontSize: 12, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  sentBadge: {
    display: 'block', textAlign: 'center', padding: '8px 0',
    fontSize: 12, fontWeight: 600, color: '#306F33',
  },

  // Fill fallback (gap with nobody due) + Fill Ideas empty states
  fillFallback: {
    marginTop: 4, display: 'flex', flexDirection: 'column', gap: 8,
  },
  fillFallbackCompact: {
    display: 'flex', flexDirection: 'column', gap: 8,
  },
  fillFallbackText: {
    fontSize: 12, color: '#6b6560', lineHeight: 1.45, margin: 0,
  },
  fillSecondaryBtn: {
    width: '100%', padding: '8px 0', borderRadius: 10,
    border: '1px solid var(--accent, #92405e)', background: 'transparent',
    color: 'var(--accent, #92405e)', fontSize: 12, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  fillHeroCard: {
    background: 'var(--bg-card, #FFFCF9)', borderRadius: 16, padding: 16,
    boxShadow: 'var(--elev-1)', marginBottom: 20,
    display: 'flex', flexDirection: 'column', gap: 8,
  },
  fillHeroTitle: { fontSize: 15, fontWeight: 600, color: 'var(--text-primary, #241B17)' },
  fillHeroText: { fontSize: 12.5, color: '#6b6560', lineHeight: 1.5, margin: 0 },
  suggEmpty: {
    fontSize: 12.5, color: 'var(--text-muted, #6B5D54)', lineHeight: 1.4,
    margin: 0, padding: '4px 2px',
  },

  // Full suggestion cards
  suggSection: { marginBottom: 20 },
  suggSectionTitle: { fontSize: 15, fontWeight: 600, margin: '0 0 2px', color: 'var(--text-primary, #241B17)' },
  suggSectionDesc: { fontSize: 12, color: 'var(--text-muted, #6B5D54)', margin: '0 0 12px' },
  suggFullCard: {
    background: 'var(--bg-card, #FFFCF9)', borderRadius: 16, padding: 14,
    boxShadow: 'var(--elev-1)', marginBottom: 10,
  },
  suggReasonText: { fontSize: 12, color: '#6b6560', margin: '8px 0', lineHeight: 1.4 },
  overdueBadge: {
    padding: '3px 8px', borderRadius: 'var(--radius-xs)', fontSize: 10, fontWeight: 600,
    background: '#FEF2F2', color: '#c32424', flexShrink: 0,
  },

  // Insights
  insightGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 },
  insightCard: {
    background: 'var(--bg-card, #FFFCF9)', borderRadius: 16, padding: '16px 14px', textAlign: 'center',
    boxShadow: 'var(--elev-1)',
  },
  insightNum: { display: 'block', fontSize: 22, fontWeight: 700, color: 'var(--accent, #92405e)' },
  insightPrompt: { display: 'block', fontSize: 15, fontWeight: 700, color: 'var(--accent, #92405e)', lineHeight: 1.3 },
  insightLabel: { display: 'block', fontSize: 11, color: 'var(--text-muted, #6B5D54)', textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 4 },

  insightSection: {
    background: 'var(--bg-card, #FFFCF9)', borderRadius: 16, padding: 16, marginBottom: 12,
    boxShadow: 'var(--elev-1)',
  },
  insightSectionTitle: { fontSize: 14, fontWeight: 600, margin: '0 0 12px', color: 'var(--text-primary, #241B17)' },
  dayRow: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 },
  dayName: { fontSize: 12, color: '#5A5550', width: 70, flexShrink: 0 },
  dayBar: { flex: 1, height: 6, borderRadius: 'var(--radius-xs)', background: '#F0ECE8', overflow: 'hidden' },
  dayBarFill: { height: '100%', borderRadius: 'var(--radius-xs)', transition: 'width 0.6s ease' },
  dayPct: { fontSize: 11, fontWeight: 600, color: 'var(--text-primary, #241B17)', width: 30, textAlign: 'right' },

  hardSlotList: { display: 'flex', flexDirection: 'column', gap: 8 },
  hardSlot: { display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 0', borderBottom: '1px solid #FAF8F5' },
  hardSlotText: { fontSize: 13, fontWeight: 600, color: '#E57373' },
  hardSlotNote: { fontSize: 11, color: 'var(--text-muted, #6B5D54)' },

  tipCard: {
    display: 'flex', alignItems: 'flex-start', gap: 4,
    background: '#FBF0F3', borderRadius: 16, padding: 14,
  },
  tipTitle: { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--accent, #92405e)', marginBottom: 4 },
  tipText: { display: 'block', fontSize: 12, color: '#5A5550', lineHeight: 1.5 },

  // Empty
  loadingText: { textAlign: 'center', color: 'var(--text-muted, #6B5D54)', padding: 40, fontSize: 14 },
  emptyState: { textAlign: 'center', padding: '40px 20px' },
  emptyTitle: { fontSize: 16, fontWeight: 600, margin: '0 0 4px', color: 'var(--text-primary, #241B17)' },
  emptyDesc: { fontSize: 13, color: 'var(--text-muted, #6B5D54)', margin: 0, lineHeight: 1.5 },
};
