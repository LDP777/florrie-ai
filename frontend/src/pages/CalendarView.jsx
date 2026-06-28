import { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useBeautician, supabase, updateRow, insertRow } from '../lib/supabase.js'
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import { hapticTap, hapticSuccess } from '../lib/native.js';
import { treatmentColor, tint } from '../lib/treatmentColors.js';
import { parseDateOnly } from '../lib/dates.js';
/**
 * CalendarView - Day and Week view of appointments.
 * Wired to Supabase with client/treatment joins.
 * Redesigned to match Stitch design reference.
 */
// 112px per hour: a 30-min appointment gets 56px, enough for the card
// content without spilling into its neighbour. Grid runs the full day
// (06:00-23:00) so last-minute out-of-hours clients are visible and addable.
const HOUR_HEIGHT = 112;
const START_HOUR = 6;
const END_HOUR = 23;
const MIN_CARD_PX = 56;
// Statuses that don't count toward a day's bookings / takings / hours.
const DEAD_STATUSES = ['cancelled', 'cancelled_by_client', 'cancelled_by_beautician', 'no_show'];

/** Wall-clock minutes since midnight, read straight off the stored string
 *  ("2026-06-12T14:00:00..." -> 840) so no browser timezone ever shifts it. */
function wallMinutes(isoish) {
  const s = String(isoish || '');
  const h = parseInt(s.slice(11, 13), 10);
  const m = parseInt(s.slice(14, 16), 10);
  if (isNaN(h) || isNaN(m)) {
    const d = new Date(isoish);
    return d.getHours() * 60 + d.getMinutes();
  }
  return h * 60 + m;
}

/** "14:00" from the stored wall-clock string. */
function formatWallTime(isoish) {
  const s = String(isoish || '');
  const t = s.slice(11, 16);
  return /^\d{2}:\d{2}$/.test(t)
    ? t
    : new Date(isoish).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
}

/**
 * Google Calendar style collision layout. Each appointment becomes a pixel
 * rect (top from start time, height from duration with a content minimum).
 * Rects that intersect, whether from true time overlaps or min-height spill,
 * form a cluster; cluster members are greedily packed into columns and share
 * the width. Returns [{ appt, top, height, col, cols }].
 */
function layoutDayAppointments(appts) {
  const rects = appts
    .map(appt => {
      const startMin = wallMinutes(appt.starts_at);
      const endMin = Math.max(appt.ends_at ? wallMinutes(appt.ends_at) : startMin + 30, startMin + 15);
      const top = Math.max(0, ((startMin - START_HOUR * 60) / 60) * HOUR_HEIGHT);
      const height = Math.max(((endMin - startMin) / 60) * HOUR_HEIGHT, MIN_CARD_PX);
      return { appt, top, height, bottom: top + height, col: 0, cols: 1 };
    })
    .sort((a, b) => a.top - b.top || b.height - a.height);

  let cluster = [];
  let clusterBottom = -Infinity;
  function flushCluster() {
    if (cluster.length === 0) return;
    const colBottoms = [];
    for (const r of cluster) {
      let placed = false;
      for (let c = 0; c < colBottoms.length; c++) {
        if (colBottoms[c] <= r.top + 1) {
          r.col = c;
          colBottoms[c] = r.bottom;
          placed = true;
          break;
        }
      }
      if (!placed) {
        r.col = colBottoms.length;
        colBottoms.push(r.bottom);
      }
    }
    for (const r of cluster) r.cols = colBottoms.length;
    cluster = [];
  }
  for (const r of rects) {
    if (r.top >= clusterBottom - 1) flushCluster();
    cluster.push(r);
    clusterBottom = Math.max(clusterBottom, r.bottom);
  }
  flushCluster();
  return rects;
}
// Color palette (Stitch design)
const COLORS = {
  primary: 'var(--accent)',
  secondary: 'var(--gold)',
  surface: 'var(--bg)',
  primaryContainer: '#b05877',
  secondaryContainer: 'var(--gold-light)',
  surfaceContainerLow: 'var(--bg-input)',
  onSurface: 'var(--text-primary)',
  outlineVariant: '#d8c1c6',
  stone400: '#78716b',
};
export default function CalendarView({ initialView } = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { beautician, loading: bLoading } = useBeautician();
  const [view, setView] = useState(initialView === 'week' ? 'week' : 'day');
  // Deep-link to a specific day from either navigation state (in-app pushes) or a
  // ?date=YYYY-MM-DD query param (the activity feed / "What Florrie did" links).
  const [currentDate, setCurrentDate] = useState(() => {
    if (location.state?.date) return new Date(location.state.date);
    const q = new URLSearchParams(location.search).get('date');
    if (q && /^\d{4}-\d{2}-\d{2}/.test(q)) return new Date(`${q.slice(0, 10)}T12:00:00`);
    return new Date();
  });
  // Navigating from the Hub to /calendar reuses this component instance (both
  // routes render Hub), so the initializer above won't re-run. Sync the day when
  // the ?date= param changes so "What Florrie did" links land on the right day.
  useEffect(() => {
    const q = new URLSearchParams(location.search).get('date');
    if (q && /^\d{4}-\d{2}-\d{2}/.test(q)) setCurrentDate(new Date(`${q.slice(0, 10)}T12:00:00`));
  }, [location.search]);
  const [appointments, setAppointments] = useState([]);
  const [selectedAppointment, setSelectedAppointment] = useState(null);
  const [loading, setLoading] = useState(true);
  const detailRef = useRef(null);
  // Press-and-hold a row in the agenda to delete it (iOS style). The backend
  // blocks deletion when money is attached (409) and steers Ellie to cancel.
  const longPressTimer = useRef(null);
  const longPressFired = useRef(false);
  async function deleteAppointmentFromAgenda(appt) {
    const who = appt.clients?.first_name
      ? `${appt.clients.first_name}'s ${appt.treatments?.name || 'appointment'}`
      : 'this appointment';
    if (!confirm(`Delete ${who}? This can't be undone.`)) return;
    try {
      const token = (await supabase.auth.getSession())?.data?.session?.access_token;
      const res = await fetch(`${API_BASE}/api/appointments/${appt.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 409) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "This booking has a payment attached, so it can't be deleted. Cancel it instead.");
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Could not delete the appointment');
      }
      hapticSuccess();
      loadAppointments();
    } catch (err) {
      logger.error('Agenda delete error:', err);
      alert(err.message || 'Could not delete the appointment. Please try again.');
    }
  }
  function startLongPress(appt) {
    longPressFired.current = false;
    clearTimeout(longPressTimer.current);
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      hapticTap(); // tactile cue the hold registered
      deleteAppointmentFromAgenda(appt);
    }, 500);
  }
  function cancelLongPress() {
    clearTimeout(longPressTimer.current);
  }
  // When an in-place edit (price set, time change) reloads the list we want
  // the page to stay exactly where Ellie was, not jump to the bottom. We stash
  // the scrollY here and restore it once the reload's render has settled.
  const preserveScrollRef = useRef(null);
  const [markingAllDone, setMarkingAllDone] = useState(false);
  // Time blocking state
  const [timeBlocks, setTimeBlocks] = useState([]);
  const [showBlockModal, setShowBlockModal] = useState(false);
  const [selectedBlock, setSelectedBlock] = useState(null); // existing block tapped
  const [savingBlock, setSavingBlock] = useState(false);
  // Manual appointment modal (plus button)
  const [showNewAppt, setShowNewAppt] = useState(false);
  // Day grid scroll container + once-per-day auto-scroll tracking
  const gridScrollRef = useRef(null);
  const lastScrollKey = useRef(null);
  useEffect(() => {
    if (beautician) {
      loadAppointments();
      loadTimeBlocks();
    }
  }, [beautician, currentDate, view]); // eslint-disable-line react-hooks/exhaustive-deps
  // Auto-scroll to appointment detail when selected
  useEffect(() => {
    if (selectedAppointment && detailRef.current) {
      setTimeout(() => {
        detailRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 50);
    }
  }, [selectedAppointment]);
  // Auto-scroll the day grid so the first appointment (or 08:00 if none)
  // sits near the top. Once per viewed day, not on every refresh.
  useEffect(() => {
    if (view !== 'day' || loading || !gridScrollRef.current) return;
    const key = formatDate(currentDate);
    if (lastScrollKey.current === key) return;
    lastScrollKey.current = key;
    const dayAppts = getAppointmentsForDate(currentDate);
    const targetMin = dayAppts.length > 0
      ? Math.min(...dayAppts.map(a => wallMinutes(a.starts_at)))
      : 8 * 60;
    gridScrollRef.current.scrollTop = Math.max(0, ((targetMin - START_HOUR * 60) / 60) * HOUR_HEIGHT - 24);
  }, [loading, currentDate, view, appointments]); // eslint-disable-line react-hooks/exhaustive-deps
  // Restore the stashed page scroll after an in-place edit reload settles, so
  // setting a price / editing a time never throws Ellie to the bottom.
  useEffect(() => {
    if (loading || preserveScrollRef.current == null) return;
    const y = preserveScrollRef.current;
    preserveScrollRef.current = null;
    // The page scrolls inside #app-scroll now, not the body - restore there.
    requestAnimationFrame(() => {
      const sc = document.getElementById('app-scroll');
      if (sc) sc.scrollTop = y;
      else window.scrollTo(0, y);
    });
  }, [loading, appointments]);
  async function loadAppointments({ keepScroll = false } = {}) {
    // For in-place edits (price/time set) hold the current scroll position so
    // the reload doesn't bounce the page to the bottom.
    if (keepScroll) preserveScrollRef.current = document.getElementById('app-scroll')?.scrollTop ?? window.scrollY;
    setLoading(true);
    const from = view === 'day' ? formatDate(currentDate) : formatDate(getWeekStart(currentDate));
    const to = view === 'day' ? formatDate(currentDate) : formatDate(getWeekEnd(currentDate));
    try {
      const { data, error } = await supabase
        .from('appointments')
        .select('*, clients(first_name, last_name), treatments(name, price_cents, color, sort_order)')
        .eq('beautician_id', beautician.id)
        .gte('starts_at', `${from}T00:00:00Z`)
        .lte('starts_at', `${to}T23:59:59Z`)
        .order('starts_at');
      if (error) logger.error('Calendar load:', error);
      setAppointments(data || []);
    } catch (err) {
      logger.error('Calendar load error:', err);
    } finally {
      setLoading(false);
    }
  }
  // Batch-complete every still-open booking on the viewed day. One tap at the
  // end of a busy day instead of opening each client in turn.
  async function handleMarkAllDone() {
    const dayLabel = currentDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    if (!confirm(`Mark all remaining appointments on ${dayLabel} as complete?`)) return;
    hapticTap();
    setMarkingAllDone(true);
    try {
      const token = (await supabase.auth.getSession())?.data?.session?.access_token;
      const res = await fetch(`${API_BASE}/api/appointments/complete-day`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ date: formatDate(currentDate) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not mark the day complete');
      hapticSuccess();
      const count = data.count ?? data.completed ?? 0;
      alert(count > 0 ? `Marked ${count} appointment${count === 1 ? '' : 's'} as complete.` : 'Nothing left to complete today.');
      setSelectedAppointment(null);
      loadAppointments();
    } catch (err) {
      logger.error('Mark all done error:', err);
      alert(err.message || 'Could not mark the day complete');
    } finally {
      setMarkingAllDone(false);
    }
  }
  // Time block functions
  async function loadTimeBlocks() {
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const res = await fetch(`${API_BASE}/api/hours-exceptions`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();
      setTimeBlocks(data.exceptions || []);
    } catch (err) {
      logger.error('Load time blocks error:', err);
    }
  }
  async function createTimeBlock({ date, type, reason, note, start_time, end_time }) {
    setSavingBlock(true);
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const res = await fetch(`${API_BASE}/api/hours-exceptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ date, type, reason, note, start_time, end_time, notify_clients: false }),
      });
      if (res.ok) {
        await loadTimeBlocks();
        setShowBlockModal(false);
      }
    } catch (err) {
      logger.error('Create time block error:', err);
    } finally {
      setSavingBlock(false);
    }
  }
  async function deleteTimeBlock(blockId) {
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      await fetch(`${API_BASE}/api/hours-exceptions/${blockId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      setTimeBlocks(prev => prev.filter(b => b.id !== blockId));
      setSelectedBlock(null);
    } catch (err) {
      logger.error('Delete time block error:', err);
    }
  }
  function navigateDate(direction) {
    const delta = view === 'day' ? 1 : 7;
    const newDate = new Date(currentDate);
    newDate.setDate(newDate.getDate() + (direction * delta));
    setCurrentDate(newDate);
  }
  function getAppointmentsForDate(date) {
    const dateStr = formatDate(date);
    return appointments.filter(a => a.starts_at?.startsWith(dateStr));
  }
  // After a one-tap complete, jump straight to the next client still needing
  // action that day (earliest first), so Ellie never scrolls back up the list.
  // If nothing's left, close the panel.
  function advanceToNextAppointment(completed) {
    const COMPLETABLE = ['confirmed', 'pending', 'in_progress'];
    const day = getAppointmentsForDate(currentDate)
      .slice()
      .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
    const idx = day.findIndex(a => a.id === completed.id);
    const next = (idx >= 0 ? day.slice(idx + 1) : day)
      .find(a => a.id !== completed.id && COMPLETABLE.includes(a.status));
    loadAppointments();
    setSelectedAppointment(next || null);
  }
  function getStatusColor(status) {
    const colors = { confirmed: '#5BA67F', pending: '#D4A843', in_progress: '#4A90D9', completed: '#8A8580', cancelled_by_client: '#DC2626', cancelled_by_beautician: '#DC2626', no_show: '#EF4444', rescheduled: '#7C6EAF' };
    return colors[status] || '#8A8580';
  }
  function getAppointmentCardStyle(appointment) {
    // Determine card style based on tier/special status
    // For now, default style; can be extended with VIP/gold tier detection
    return {
      background: 'var(--bg-card)',
      borderColor: COLORS.primary,
    };
  }
  function getWeekDays() {
    const start = getWeekStart(currentDate);
    return Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d; });
  }
  function countGapsToday() {
    const dayAppts = getAppointmentsForDate(currentDate).sort((a, b) => new Date(a.ends_at) - new Date(b.ends_at));
    let gaps = 0;
    for (let i = 0; i < dayAppts.length - 1; i++) {
      const endTime = new Date(dayAppts[i].ends_at);
      const nextStart = new Date(dayAppts[i + 1].starts_at);
      const diffMinutes = (nextStart - endTime) / (1000 * 60);
      if (diffMinutes > 15) gaps++;
    }
    return gaps;
  }
  function countWaitlistMatches() {
    // Placeholder: would come from waitlist data
    return 0;
  }
  const weekDays = getWeekDays();
  const weekMonthName = getWeekStart(currentDate).toLocaleDateString('en-GB', { month: 'long' });
  const weekNumber = Math.ceil((currentDate.getDate() + 6 - currentDate.getDay()) / 7);
  const gapsToday = countGapsToday();
  const waitlistMatches = countWaitlistMatches();
  const showInsightsPill = view === 'day' && (gapsToday > 0 || waitlistMatches > 0);
  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div style={styles.headerTop}>
          <button onClick={() => navigateDate(-1)} style={styles.navBtn}>‹</button>
          <div style={styles.headerCenter}>
            <h1 style={styles.dateTitle}>
              {view === 'day'
                ? currentDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
                : `${getWeekStart(currentDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} - ${getWeekEnd(currentDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`}
            </h1>
            <button onClick={() => setCurrentDate(new Date())} style={styles.todayBtn}>Today</button>
          </div>
          <button onClick={() => navigateDate(1)} style={styles.navBtn}>›</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={styles.viewToggle}>
            <button onClick={() => setView('day')} style={{ ...styles.toggleBtn, background: view === 'day' ? COLORS.primary : 'transparent', color: view === 'day' ? '#fff' : COLORS.stone400 }}>Day</button>
            <button onClick={() => setView('week')} style={{ ...styles.toggleBtn, background: view === 'week' ? COLORS.primary : 'transparent', color: view === 'week' ? '#fff' : COLORS.stone400 }}>Week</button>
          </div>
          <button
            onClick={() => setShowBlockModal(true)}
            title="Block time"
            style={{ height: 36, padding: '0 12px', borderRadius: 10, border: `1px solid ${COLORS.outlineVariant}`, background: 'var(--card-bg, #fff)', color: COLORS.stone400, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, flexShrink: 0, fontSize: 12, fontWeight: 600, fontFamily: 'inherit' }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 15, fontVariationSettings: "'FILL' 0, 'wght' 300" }}>event_busy</span>
            Block
          </button>
          {view === 'day' && (
            <button
              onClick={handleMarkAllDone}
              disabled={markingAllDone}
              title="Mark all done"
              style={{ height: 36, padding: '0 12px', borderRadius: 10, border: `1px solid ${COLORS.outlineVariant}`, background: 'var(--card-bg, #fff)', color: '#5BA67F', cursor: markingAllDone ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, flexShrink: 0, fontSize: 12, fontWeight: 600, fontFamily: 'inherit', opacity: markingAllDone ? 0.6 : 1 }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 15, fontVariationSettings: "'FILL' 0, 'wght' 300" }}>done_all</span>
              {markingAllDone ? '…' : 'All done'}
            </button>
          )}
        </div>
      </div>
      {/* Weekly Date Strip (shared for both views) */}
      <div style={styles.weeklyStripContainer}>
        <div style={styles.weeklyStripHeader}>
          <span style={styles.weeklyStripMonth}>{weekMonthName} WEEK {weekNumber}</span>
        </div>
        <div style={styles.weeklyStrip}>
          {weekDays.map(day => (
            <button
              key={day.toISOString()}
              onClick={() => { setCurrentDate(day); setView('day'); }}
              style={{
                ...styles.weeklyStripDay,
                // The filled pill follows the SELECTED day; today keeps a soft
                // outline when it isn't the one selected.
                background: isSameDay(day, currentDate) ? COLORS.primary : 'transparent',
                color: isSameDay(day, currentDate) ? '#fff' : isToday(day) ? COLORS.primary : COLORS.onSurface,
                boxShadow: isSameDay(day, currentDate) ? `0 4px 10px rgba(146, 64, 94, 0.15)` : 'none',
                border: !isSameDay(day, currentDate) && isToday(day) ? `1.5px solid rgba(146, 64, 94, 0.35)` : '1.5px solid transparent',
              }}
            >
              <span style={styles.weeklyStripDayName}>{day.toLocaleDateString('en-GB', { weekday: 'short' })}</span>
              <span style={styles.weeklyStripDayNumber}>{day.getDate()}</span>
            </button>
          ))}
        </div>
      </div>
      {/* Day View with Timeline Grid */}
      {view === 'day' && (
        <div ref={gridScrollRef} style={styles.dayGrid}>
          <div style={{ ...styles.timeColumn, height: (END_HOUR - START_HOUR) * HOUR_HEIGHT }}>
            {Array.from({ length: END_HOUR - START_HOUR + 1 }, (_, i) => (
              <div key={i} style={{ ...styles.timeLabel, top: i * HOUR_HEIGHT }}>
                {`${(START_HOUR + i).toString().padStart(2, '0')}:00`}
              </div>
            ))}
          </div>
          <div style={{ ...styles.appointmentColumn, height: (END_HOUR - START_HOUR) * HOUR_HEIGHT }}>
            {/* Outside-working-hours dimming. Visual only, never blocks taps. */}
            {(() => {
              const dayKey = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][currentDate.getDay()];
              const wh = beautician?.working_hours?.[dayKey];
              const fullHeight = (END_HOUR - START_HOUR) * HOUR_HEIGHT;
              const bands = [];
              if (wh?.start && wh?.end) {
                const [sh, sm] = wh.start.split(':').map(Number);
                const [eh, em] = wh.end.split(':').map(Number);
                const startPx = Math.max(0, ((sh * 60 + (sm || 0) - START_HOUR * 60) / 60) * HOUR_HEIGHT);
                const endPx = Math.min(fullHeight, ((eh * 60 + (em || 0) - START_HOUR * 60) / 60) * HOUR_HEIGHT);
                if (startPx > 0) bands.push({ id: 'pre', top: 0, height: startPx });
                if (endPx < fullHeight) bands.push({ id: 'post', top: endPx, height: fullHeight - endPx });
              } else if (beautician?.working_hours) {
                // Closed day: dim the lot, still fully interactive
                bands.push({ id: 'all', top: 0, height: fullHeight });
              }
              return bands.map(b => (
                <div
                  key={b.id}
                  style={{ position: 'absolute', left: 0, right: 0, top: b.top, height: b.height, background: 'rgba(120, 113, 107, 0.06)', pointerEvents: 'none', zIndex: 0 }}
                />
              ));
            })()}
            {/* Hour lines and grid */}
            {Array.from({ length: END_HOUR - START_HOUR + 1 }, (_, i) => (
              <div key={i} style={{ ...styles.hourLine, top: i * HOUR_HEIGHT }} />
            ))}
            {/* Now-line indicator */}
            {isToday(currentDate) && getNowPosition() >= 0 && getNowPosition() <= (END_HOUR - START_HOUR) * HOUR_HEIGHT && (
              <div style={{ ...styles.nowLine, top: getNowPosition() }}>
                <div style={styles.nowDot} />
              </div>
            )}
            {/* Appointment cards. Collision-aware: overlapping cards share the width. */}
            {layoutDayAppointments(getAppointmentsForDate(currentDate)).map(({ appt, top, height, col, cols }) => {
              const cardStyle = getAppointmentCardStyle(appt);
              const statusColor = getStatusColor(appt.status);
              // Treatment colour drives the block (left stripe + soft tint) so each
              // service type is distinct; status stays readable on the avatar.
              const treatColor = treatmentColor(appt.treatments);
              const dead = DEAD_STATUSES.includes(appt.status);
              const clientInitials = `${appt.clients?.first_name?.[0] || ''}${appt.clients?.last_name?.[0] || ''}`.toUpperCase();
              const compact = cols > 1 || height < 72;
              const showTreatment = height >= 60 && cols < 3;
              const showMeta = cols < 3;
              return (
                <button
                  key={appt.id}
                  onClick={() => setSelectedAppointment(selectedAppointment?.id === appt.id ? null : appt)}
                  style={{
                    ...styles.appointmentCard,
                    top,
                    height,
                    left: `calc(${(col / cols) * 100}% + 4px)`,
                    width: `calc(${100 / cols}% - 8px)`,
                    right: 'auto',
                    minHeight: 0,
                    overflow: 'hidden',
                    padding: compact ? '4px 8px' : '6px 10px',
                    background: tint(treatColor, 0.1),
                    borderLeftColor: treatColor,
                    opacity: dead ? 0.55 : 1,
                  }}
                >
                  <div style={styles.appointmentCardContent}>
                    <div style={styles.appointmentCardHeader}>
                      <div style={{ ...styles.appointmentAvatar, background: statusColor, ...(compact ? { width: 22, height: 22, fontSize: 8 } : {}) }}>
                        {clientInitials}
                      </div>
                      <div style={styles.appointmentCardTextBlock}>
                        <div style={{ ...styles.appointmentCardClientName, ...(compact ? { fontSize: 12 } : {}), ...(dead ? { textDecoration: 'line-through' } : {}) }}>{appt.clients?.first_name} {appt.clients?.last_name || ''}</div>
                        {showTreatment && (
                          <div style={styles.appointmentCardTreatment}>{appt.treatments?.name}</div>
                        )}
                      </div>
                    </div>
                    {showMeta && (
                      <div style={styles.appointmentCardMeta}>
                        <span style={styles.appointmentCardTime}>{formatWallTime(appt.starts_at)}</span>
                        {appt.ai_booked && !compact && <span style={styles.aiTag}>AI</span>}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
            {/* Time block overlays */}
            {timeBlocks
              .filter(b => b.date === formatDate(currentDate))
              .map(block => {
                let top = 0, height = (END_HOUR - START_HOUR) * HOUR_HEIGHT;
                const isClosed = block.type === 'closed' || block.is_closed;
                if (!isClosed) {
                  const st = block.start_time || block.custom_start;
                  const et = block.end_time || block.custom_end;
                  if (st && et) {
                    const [sh, sm] = st.split(':').map(Number);
                    const [eh, em] = et.split(':').map(Number);
                    top = ((sh * 60 + sm - START_HOUR * 60) / 60) * HOUR_HEIGHT;
                    height = ((eh * 60 + em - (sh * 60 + sm)) / 60) * HOUR_HEIGHT;
                  }
                }
                const label = isClosed ? 'CLOSED ALL DAY'
                  : `🚫 ${(block.reason || block.note || 'BLOCKED').toUpperCase()}`;
                return (
                  <button
                    key={block.id}
                    onClick={() => setSelectedBlock(block)}
                    style={{
                      position: 'absolute', left: 0, right: 0,
                      top: Math.max(0, top),
                      height: Math.max(height, 36),
                      background: 'repeating-linear-gradient(45deg, rgba(146,64,94,0.07) 0px, rgba(146,64,94,0.07) 5px, rgba(146,64,94,0.02) 5px, rgba(146,64,94,0.02) 10px)',
                      border: 'none',
                      borderLeft: '3px solid rgba(146,64,94,0.5)',
                      borderRadius: 4,
                      display: 'flex', alignItems: 'center', paddingLeft: 10,
                      cursor: 'pointer', zIndex: 3,
                    }}
                  >
                    <span style={{ fontSize: 11, fontWeight: 700, color: COLORS.primary, letterSpacing: '0.04em' }}>
                      {label}
                    </span>
                  </button>
                );
              })
            }
            {/* Open slot placeholders */}
            {(() => {
              const appts = getAppointmentsForDate(currentDate).sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
              const slots = [];
              // Check for gap at start of day
              if (appts.length > 0) {
                const firstStartMinutes = wallMinutes(appts[0].starts_at);
                if (firstStartMinutes > START_HOUR * 60 + 30) {
                  const top = 0;
                  const height = ((firstStartMinutes - START_HOUR * 60) / 60) * HOUR_HEIGHT;
                  slots.push({ id: 'start', top, height });
                }
              }
              // Check for gaps between appointments
              for (let i = 0; i < appts.length - 1; i++) {
                const endMinutes = wallMinutes(appts[i].ends_at);
                const nextStartMinutes = wallMinutes(appts[i + 1].starts_at);
                const diffMinutes = (nextStartMinutes - endMinutes);
                if (diffMinutes > 30) {
                  const top = ((endMinutes - START_HOUR * 60) / 60) * HOUR_HEIGHT;
                  const height = (diffMinutes / 60) * HOUR_HEIGHT;
                  slots.push({ id: `gap-${i}`, top, height });
                }
              }
              // Check for gap at end of day
              if (appts.length > 0) {
                const lastEndMinutes = wallMinutes(appts[appts.length - 1].ends_at);
                if (lastEndMinutes < END_HOUR * 60 - 30) {
                  const top = ((lastEndMinutes - START_HOUR * 60) / 60) * HOUR_HEIGHT;
                  const height = ((END_HOUR * 60 - lastEndMinutes) / 60) * HOUR_HEIGHT;
                  slots.push({ id: 'end', top, height });
                }
              }
              return slots.map(slot => (
                <div
                  key={slot.id}
                  style={{
                    ...styles.openSlotCard,
                    top: slot.top,
                    height: slot.height,
                  }}
                >
                  <span style={styles.openSlotText}>OPEN SLOT</span>
                </div>
              ));
            })()}
            {!loading && getAppointmentsForDate(currentDate).length === 0 && (
              <div style={{ position: 'absolute', top: (8 - START_HOUR) * HOUR_HEIGHT + 80, left: 0, right: 0, textAlign: 'center' }}>
                <p style={{ fontSize: 13, color: COLORS.stone400 }}>No appointments</p>
              </div>
            )}
          </div>
        </div>
      )}
      {/* Week View - agenda by day. Each day shows its shape at a glance:
          how many bookings, money on the books, hours worked, then the
          appointments themselves as readable rows. Far easier to actually
          work from on a phone than seven thin columns of tiny chips. */}
      {view === 'week' && (
        <div style={styles.weekAgenda}>
          {weekDays.map(day => {
            const dayAppts = getAppointmentsForDate(day)
              .slice()
              .sort((a, b) => wallMinutes(a.starts_at) - wallMinutes(b.starts_at));
            const live = dayAppts.filter(a => !DEAD_STATUSES.includes(a.status));
            const takingsPence = live.reduce((s, a) => s + (a.price_cents || a.treatments?.price_cents || 0), 0);
            const workedMins = live.reduce((s, a) => s + Math.max(0, wallMinutes(a.ends_at || a.starts_at) - wallMinutes(a.starts_at)), 0);
            const hours = workedMins / 60;
            const dayKey = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][day.getDay()];
            const wh = beautician?.working_hours?.[dayKey];
            const dayOff = !!beautician?.working_hours && !(wh?.start && wh?.end);
            const today = isToday(day);
            return (
              <div key={day.toISOString()} style={{ ...styles.weekDaySection, ...(today ? styles.weekDaySectionToday : {}) }}>
                <button
                  onClick={() => { setCurrentDate(day); setView('day'); }}
                  style={styles.weekDayHead}
                >
                  <span style={styles.weekDayHeadLeft}>
                    <span style={{ ...styles.weekDayDow, color: today ? COLORS.primary : COLORS.onSurface }}>
                      {day.toLocaleDateString('en-GB', { weekday: 'long' })}
                    </span>
                    <span style={styles.weekDayDate}>{day.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
                    {today && <span style={styles.weekTodayTag}>Today</span>}
                  </span>
                  {live.length > 0 ? (
                    <span style={styles.weekDayStats}>
                      <span style={styles.weekDayCount}>{live.length} booking{live.length === 1 ? '' : 's'}</span>
                      {takingsPence > 0 && <span style={styles.weekDayMoney}>£{(takingsPence / 100).toFixed(0)}</span>}
                      <span style={styles.weekDayHours}>{hours % 1 === 0 ? hours : hours.toFixed(1)}h</span>
                    </span>
                  ) : (
                    <span style={styles.weekDayQuiet}>{dayOff ? 'Day off' : 'No bookings'}</span>
                  )}
                </button>
                {live.length > 0 && (
                  <div style={styles.weekDayRows}>
                    {dayAppts.map(appt => {
                      const dotColor = treatmentColor(appt.treatments);
                      const dead = DEAD_STATUSES.includes(appt.status);
                      const firstName = appt.clients?.first_name || '';
                      const lastInitial = appt.clients?.last_name ? ' ' + appt.clients.last_name.charAt(0) + '.' : '';
                      const clientLabel = firstName ? `${firstName}${lastInitial}` : 'Client';
                      const price = appt.price_cents || appt.treatments?.price_cents || 0;
                      return (
                        <button
                          key={appt.id}
                          onClick={() => {
                            // Swallow the click that follows a long-press delete.
                            if (longPressFired.current) { longPressFired.current = false; return; }
                            setSelectedAppointment(selectedAppointment?.id === appt.id ? null : appt);
                          }}
                          onTouchStart={() => startLongPress(appt)}
                          onTouchEnd={cancelLongPress}
                          onTouchMove={cancelLongPress}
                          onMouseDown={() => startLongPress(appt)}
                          onMouseUp={cancelLongPress}
                          onMouseLeave={cancelLongPress}
                          onContextMenu={(e) => { e.preventDefault(); cancelLongPress(); deleteAppointmentFromAgenda(appt); }}
                          style={{ ...styles.weekRow, opacity: dead ? 0.5 : 1 }}
                        >
                          <span style={styles.weekRowTime}>{formatWallTime(appt.starts_at)}</span>
                          <span style={{ ...styles.weekRowDot, background: dotColor }} />
                          <span style={styles.weekRowBody}>
                            <span style={{ ...styles.weekRowName, textDecoration: dead ? 'line-through' : 'none' }}>{clientLabel}</span>
                            {appt.treatments?.name && <span style={styles.weekRowTreatment}>{appt.treatments.name}</span>}
                          </span>
                          {price > 0 && <span style={styles.weekRowPrice}>£{(price / 100).toFixed(0)}</span>}
                          {appt.ai_booked && <span style={styles.aiTag}>AI</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Floating add button (day view only). Sits above the mic FAB. */}
      {view === 'day' && (
        <button
          onClick={() => setShowNewAppt(true)}
          aria-label="New appointment"
          title="New appointment"
          style={styles.addFab}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 26 }}>add</span>
        </button>
      )}
      {/* Floating Insights Pill (day view only) */}
      {showInsightsPill && (
        <div style={styles.insightsPill}>
          <span style={styles.insightsPillIcon}>⚡</span>
          <span style={styles.insightsPillText}>
            {gapsToday} gap{gapsToday !== 1 ? 's' : ''} today {waitlistMatches > 0 ? `· ${waitlistMatches} waitlist match${waitlistMatches !== 1 ? 'es' : ''}` : ''}
          </span>
        </div>
      )}
      {/* Selected appointment detail + completion flow */}
      {selectedAppointment && (
        <div ref={detailRef}>
          <AppointmentDetail
            key={selectedAppointment.id}
            appointment={selectedAppointment}
            beautician={beautician}
            onClose={() => setSelectedAppointment(null)}
            onUpdate={() => { loadAppointments(); setSelectedAppointment(null); }}
            onRefresh={(patched) => {
              // In-place refresh: keep the panel open, hold scroll position, and
              // swap the freshly-edited row into the open detail so the panel
              // shows the new time/price immediately.
              if (patched) setSelectedAppointment(prev => (prev ? { ...prev, ...patched } : prev));
              // If the appointment was moved to a different day, follow it there
              // (parseDateOnly = local noon, no British Summer Time shift) so it
              // doesn't just vanish off the day she's looking at. loadAppointments
              // re-runs from the effect on currentDate, so no double fetch.
              if (patched && patched._movedToDay) {
                const d = parseDateOnly(patched._movedToDay);
                if (d) setCurrentDate(d);
                else loadAppointments({ keepScroll: true });
              } else {
                loadAppointments({ keepScroll: true });
              }
            }}
            onCompleted={(completed) => advanceToNextAppointment(completed)}
            getStatusColor={getStatusColor}
            onViewClient={(clientId) => navigate('/clients', { state: { clientId } })}
          />
        </div>
      )}
      {/* New appointment modal (plus button) */}
      {showNewAppt && (
        <NewAppointmentModal
          defaultDate={formatDate(currentDate)}
          existingAppointments={appointments}
          onClose={() => setShowNewAppt(false)}
          onSaved={() => { setShowNewAppt(false); loadAppointments(); }}
        />
      )}
      {/* Block Time modal */}
      {showBlockModal && (
        <BlockTimeModal
          defaultDate={formatDate(currentDate)}
          onSave={createTimeBlock}
          onClose={() => setShowBlockModal(false)}
          saving={savingBlock}
        />
      )}
      {/* Existing block detail (tap to remove) */}
      {selectedBlock && (
        <BlockDetailSheet
          block={selectedBlock}
          onDelete={() => deleteTimeBlock(selectedBlock.id)}
          onClose={() => setSelectedBlock(null)}
        />
      )}
    </div>
  );
}
/**
 * AppointmentDetail - detail panel with completion flow.
 * Mark done → log payment → add notes → rebook prompt → before/after photo.
 */
function AppointmentDetail({ appointment, beautician, onClose, onUpdate, onRefresh, onCompleted, getStatusColor, onViewClient }) {
  const [mode, setMode] = useState('detail'); // detail | completing | done
  const [notes, setNotes] = useState(appointment.beautician_notes || '');
  const [paymentMethod, setPaymentMethod] = useState('card');
  const [rebookWeeks, setRebookWeeks] = useState(4);
  const [beforeAfterUrl, setBeforeAfterUrl] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [noShowCharging, setNoShowCharging] = useState(false);
  const [paymentLinkUrl, setPaymentLinkUrl] = useState(null);
  const [linkLoading, setLinkLoading] = useState(false);
  const [chargingBalance, setChargingBalance] = useState(false);
  const [noteSaved, setNoteSaved] = useState(false);
  const [rebookSaving, setRebookSaving] = useState(false);
  const [rebookSent, setRebookSent] = useState(false);
  // Inline price set for bookings imported with no price (£0).
  const [priceEditing, setPriceEditing] = useState(false);
  const [priceInput, setPriceInput] = useState('');
  const [priceSaving, setPriceSaving] = useState(false);
  // Editing / rescheduling the appointment time. The datetime-local value is
  // the stored wall-clock (no timezone shift), so what she sees is what saves.
  const [timeEditing, setTimeEditing] = useState(false);
  const [timeInput, setTimeInput] = useState('');
  const [timeSaving, setTimeSaving] = useState(false);
  function openTimeEdit() {
    // "2026-06-21T14:00:00..." -> "2026-06-21T14:00" for the input.
    const s = String(appointment.starts_at || '');
    setTimeInput(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) ? s.slice(0, 16) : '');
    setTimeEditing(true);
    hapticTap();
  }
  // PATCH the new start (date AND time). Backend recomputes ends_at from the
  // treatment length and enforces the no-double-book / no-overlap DB guards.
  async function handleSaveTime() {
    if (!timeInput || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(timeInput)) return;
    // datetime-local gives "YYYY-MM-DDTHH:MM" (wall-clock). Send it as a stable
    // ISO string the backend slices back to wall-clock, so the day she picked is
    // the day that saves (no British Summer Time shift).
    const startsAt = `${timeInput.slice(0, 16)}:00.000Z`;
    const newDay = timeInput.slice(0, 10); // YYYY-MM-DD she picked
    const oldDay = String(appointment.starts_at || '').slice(0, 10);
    setTimeSaving(true);
    try {
      const token = (await supabase.auth.getSession())?.data?.session?.access_token;
      const res = await fetch(`${API_BASE}/api/appointments/${appointment.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ starts_at: startsAt }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        // The DB guard rejected it: that slot already has an appointment. The
        // original time is untouched, so she just picks another.
        alert('That time is taken. Pick another slot.');
        return;
      }
      if (!res.ok) throw new Error(data.error || 'Could not move the appointment');
      hapticSuccess();
      setTimeEditing(false);
      // ends_at comes back recalculated; fold both into the open panel.
      // PATCH responds { appointment: {...} }, so read from there (fall back flat).
      const updated = data.appointment || data;
      const patch = { starts_at: updated.starts_at || startsAt };
      if (updated.ends_at) patch.ends_at = updated.ends_at;
      // On a cross-day move tell the parent the new day so the calendar can
      // follow the appointment instead of losing it off the current day.
      if (newDay !== oldDay) patch._movedToDay = newDay;
      if (onRefresh) onRefresh(patch);
      else onUpdate();
    } catch (err) {
      logger.error('Save time error:', err);
      alert(err.message || 'Could not move the appointment. Please try again.');
    } finally {
      setTimeSaving(false);
    }
  }
  // Permanently remove a mistaken booking. Backend blocks (409) when money is
  // attached, so we surface that and steer her to cancel instead.
  const [deleting, setDeleting] = useState(false);
  async function handleDeleteAppointment() {
    if (!confirm('Delete this appointment? This cannot be undone.')) return;
    setDeleting(true);
    try {
      const token = (await supabase.auth.getSession())?.data?.session?.access_token;
      const res = await fetch(`${API_BASE}/api/appointments/${appointment.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 409) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'This booking has a deposit or fee attached, so it can\'t be deleted. Cancel it instead.');
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Could not delete the appointment');
      }
      hapticSuccess();
      onUpdate(); // closes the panel + refreshes the calendar
    } catch (err) {
      logger.error('Delete appointment error:', err);
      alert(err.message || 'Could not delete the appointment. Please try again.');
    } finally {
      setDeleting(false);
    }
  }
  async function handleSavePrice() {
    const pounds = parseFloat(String(priceInput).replace(/[£,\s]/g, ''));
    if (isNaN(pounds) || pounds < 0) return;
    setPriceSaving(true);
    try {
      const cents = Math.round(pounds * 100);
      await updateRow('appointments', appointment.id, { price_cents: cents });
      setPriceEditing(false);
      // Refresh in place (panel stays open, scroll held) rather than jumping.
      if (onRefresh) onRefresh({ price_cents: cents });
      else onUpdate();
    } catch (err) {
      logger.error('Save price error:', err);
    } finally {
      setPriceSaving(false);
    }
  }
  async function handleSaveNote() {
    try {
      await updateRow('appointments', appointment.id, { beautician_notes: notes || null });
      setNoteSaved(true);
      setTimeout(() => setNoteSaved(false), 1500);
    } catch (err) {
      logger.error('Save note error:', err);
    }
  }
  async function handleMarkNoShow() {
    if (!confirm('Mark this appointment as a no-show?')) return;
    setSaving(true);
    try {
      const token = (await supabase.auth.getSession())?.data?.session?.access_token;
      const res = await fetch(`${API_BASE}/api/booking/appointments/${appointment.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: 'no_show' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      // If backend says we can charge, show the option
      if (data.no_show_fee?.can_charge) {
        setNoShowCharging(true);
      }
      onUpdate();
    } catch (err) {
      logger.error('No-show error:', err);
    } finally {
      setSaving(false);
    }
  }
  async function handleChargeNoShow() {
    setSaving(true);
    try {
      const token = (await supabase.auth.getSession())?.data?.session?.access_token;
      const res = await fetch(`${API_BASE}/api/stripe/charge-no-show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ appointment_id: appointment.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      alert(`No-show fee of £${(data.amount_cents / 100).toFixed(2)} charged successfully.`);
      setNoShowCharging(false);
      onUpdate();
    } catch (err) {
      logger.error('No-show charge error:', err);
      alert(err.message || 'Failed to charge no-show fee');
    } finally {
      setSaving(false);
    }
  }
  async function handleSendPaymentLink() {
    setLinkLoading(true);
    try {
      const token = (await supabase.auth.getSession())?.data?.session?.access_token;
      const remaining = appointment.price_cents - (appointment.deposit_cents || 0);
      const amount = remaining > 0 ? remaining : appointment.price_cents;
      const res = await fetch(`${API_BASE}/api/stripe/payment-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          amount_cents: amount,
          description: `${appointment.treatments?.name} - ${appointment.clients?.first_name}`,
          client_id: appointment.client_id,
          appointment_id: appointment.id,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setPaymentLinkUrl(data.url);
    } catch (err) {
      logger.error('Payment link error:', err);
      alert(err.message || 'Failed to create payment link');
    } finally {
      setLinkLoading(false);
    }
  }
  // Card fallback: take the remaining balance off the client's saved card when
  // they haven't paid the rest by bank transfer. Off-session, confirmed first.
  async function handleChargeBalance() {
    const remaining = (appointment.price_cents || 0) - (appointment.deposit_paid ? (appointment.deposit_cents || 0) : 0);
    if (remaining < 30) { alert('There is no balance left to charge.'); return; }
    if (!confirm(`Charge the remaining £${(remaining / 100).toFixed(2)} to ${appointment.clients?.first_name || 'this client'}'s saved card?`)) return;
    setChargingBalance(true);
    try {
      const token = (await supabase.auth.getSession())?.data?.session?.access_token;
      const res = await fetch(`${API_BASE}/api/appointments/${appointment.id}/charge-balance`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not charge the balance');
      hapticSuccess();
      alert(`Charged £${((data.amountCents || 0) / 100).toFixed(2)} to the saved card.`);
      onUpdate && onUpdate();
    } catch (err) {
      logger.error('Charge balance error:', err);
      alert(err.message || 'Could not charge the balance');
    } finally {
      setChargingBalance(false);
    }
  }
  // Shared write: mark completed + log the takings. `method` defaults to the
  // last one Ellie used (remembered silently) so she never has to type it.
  async function writeCompletion(method) {
    await updateRow('appointments', appointment.id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      beautician_notes: notes || null,
      payment_method: method,
    });
    await insertRow('transactions', {
      beautician_id: beautician.id,
      appointment_id: appointment.id,
      client_id: appointment.client_id,
      treatment_id: appointment.treatment_id,
      amount_cents: appointment.price_cents,
      // 'payment' is the only type the Money tab counts and the DB CHECK allows.
      // 'service' was silently rejected by the CHECK, so completing an appointment
      // marked it done but logged no takings (and threw an error every time).
      type: 'payment',
      status: 'completed',
      payment_method: method,
      description: `${appointment.treatments?.name} - ${appointment.clients?.first_name}`,
    });
  }
  // One-tap complete: the default action. Logs takings and jumps to the next
  // client in the day, no payment screen. Payment type isn't the point here,
  // completed-vs-no-show is, so we keep it to a single tap.
  async function handleQuickComplete() {
    if (saving) return;
    hapticTap();
    setSaving(true);
    const method = (() => {
      try { return localStorage.getItem('florrie_last_payment_method') || 'card'; }
      catch { return 'card'; }
    })();
    try {
      await writeCompletion(method);
      hapticSuccess();
      if (onCompleted) onCompleted(appointment);
      else onUpdate();
    } catch (err) {
      logger.error('Quick complete error:', err);
      alert('Could not mark complete. Please try again.');
    } finally {
      setSaving(false);
    }
  }
  // Detailed path (kept for when she wants to log payment method + photo).
  async function handleComplete() {
    setSaving(true);
    try {
      try { localStorage.setItem('florrie_last_payment_method', paymentMethod); } catch {}
      await writeCompletion(paymentMethod);
      hapticSuccess();
      setMode('done');
    } catch (err) {
      logger.error('Complete error:', err);
    } finally {
      setSaving(false);
    }
  }
  async function handlePhotoUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const path = `${beautician.id}/before-after/${Date.now()}-${file.name}`;
      const { error } = await supabase.storage.from('content-images').upload(path, file);
      if (!error) {
        const { data } = supabase.storage.from('content-images').getPublicUrl(path);
        setBeforeAfterUrl(data?.publicUrl);
      } else {
        setBeforeAfterUrl(URL.createObjectURL(file));
      }
    } catch (err) {
      logger.error('Upload error:', err);
    } finally {
      setUploading(false);
    }
  }
  function handleDone() {
    onUpdate();
  }
  // Schedule a real rebook reminder N weeks out via the rebook_reminders table.
  async function handleSendRebook() {
    if (rebookSaving || rebookSent) return;
    if (!appointment.client_id) { alert('This booking has no linked client to remind.'); return; }
    hapticTap();
    setRebookSaving(true);
    try {
      const d = new Date();
      d.setDate(d.getDate() + rebookWeeks * 7);
      const reminderDate = formatDate(d); // local date — avoids the BST day-shift
      const token = (await supabase.auth.getSession())?.data?.session?.access_token;
      const res = await fetch(`${API_BASE}/api/features/rebook-reminders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          client_id: appointment.client_id,
          appointment_id: appointment.id,
          reminder_date: reminderDate,
          message: `Time to rebook ${appointment.clients?.first_name || 'your client'} for ${appointment.treatments?.name || 'their treatment'}.`,
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Failed');
      hapticSuccess();
      setRebookSent(true);
    } catch (err) {
      logger.error('Rebook reminder error:', err);
      alert('Could not schedule the rebook reminder. Please try again.');
    } finally {
      setRebookSaving(false);
    }
  }
  const isCompleted = appointment.status === 'completed';
  const canComplete = ['confirmed', 'pending', 'in_progress'].includes(appointment.status);
  return (
    <div style={styles.detailPanel}>
      <div style={styles.detailHeader}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={styles.detailTitle}>{appointment.clients?.first_name} {appointment.clients?.last_name || ''}</h3>
          {appointment.client_id && onViewClient && (
            <button
              onClick={() => { onClose(); onViewClient(appointment.client_id); }}
              style={{ fontSize: 11, color: 'var(--accent, #92405e)', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, opacity: 0.8 }}
            >
              View profile →
            </button>
          )}
        </div>
        <button onClick={onClose} style={styles.detailClose}>×</button>
      </div>
      {mode === 'detail' && (
        <>
          <div style={styles.detailGrid}>
            <div style={styles.detailRow}><span style={styles.detailLabel}>Treatment</span><span style={styles.detailValue}>{appointment.treatments?.name}</span></div>
            <div style={styles.detailRow}>
              <span style={styles.detailLabel}>Time</span>
              {timeEditing ? (
                <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <input
                      type="datetime-local" autoFocus
                      value={timeInput}
                      onChange={e => setTimeInput(e.target.value)}
                      style={{ padding: '5px 8px', borderRadius: 8, border: `1.5px solid ${COLORS.outlineVariant}`, fontSize: 12.5, fontFamily: 'inherit', outline: 'none' }}
                    />
                    <button onClick={handleSaveTime} disabled={timeSaving}
                      style={{ padding: '5px 10px', borderRadius: 8, border: 'none', background: COLORS.primary, color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                      {timeSaving ? '…' : 'Move'}
                    </button>
                    <button onClick={() => setTimeEditing(false)} disabled={timeSaving}
                      style={{ background: 'none', border: 'none', fontSize: 12, fontWeight: 600, color: COLORS.stone400, cursor: 'pointer', fontFamily: 'inherit', padding: '5px 4px' }}>
                      Cancel
                    </button>
                  </span>
                  <span style={{ fontSize: 10.5, color: COLORS.stone400, fontFamily: 'inherit' }}>Pick any day and time</span>
                </span>
              ) : (
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={styles.detailValue}>{formatWallTime(appointment.starts_at)}{appointment.ends_at ? ` - ${formatWallTime(appointment.ends_at)}` : ''}</span>
                  <button onClick={openTimeEdit}
                    style={{ background: 'none', border: `1.5px dashed ${COLORS.outlineVariant}`, borderRadius: 8, padding: '3px 9px', fontSize: 11, fontWeight: 600, color: COLORS.primary, cursor: 'pointer', fontFamily: 'inherit' }}>
                    Move
                  </button>
                </span>
              )}
            </div>
            <div style={styles.detailRow}>
              <span style={styles.detailLabel}>Price</span>
              {priceEditing ? (
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 13, color: COLORS.stone400 }}>£</span>
                  <input
                    type="number" inputMode="decimal" autoFocus
                    value={priceInput}
                    onChange={e => setPriceInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleSavePrice(); }}
                    placeholder="0.00"
                    style={{ width: 72, padding: '5px 8px', borderRadius: 8, border: `1.5px solid ${COLORS.outlineVariant}`, fontSize: 13, fontFamily: 'inherit', outline: 'none', textAlign: 'right' }}
                  />
                  <button onClick={handleSavePrice} disabled={priceSaving}
                    style={{ padding: '5px 10px', borderRadius: 8, border: 'none', background: COLORS.primary, color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                    {priceSaving ? '…' : 'Save'}
                  </button>
                </span>
              ) : (
                // Price is always editable (tap to change), not just when it's £0.
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {appointment.price_cents > 0 && (
                    <span style={styles.detailValue}>£{(appointment.price_cents / 100).toFixed(2)}</span>
                  )}
                  <button
                    onClick={() => { setPriceInput(appointment.price_cents > 0 ? (appointment.price_cents / 100).toFixed(2) : ''); setPriceEditing(true); }}
                    style={{ background: 'none', border: `1.5px dashed ${COLORS.outlineVariant}`, borderRadius: 8, padding: '4px 10px', fontSize: 12, fontWeight: 600, color: COLORS.primary, cursor: 'pointer', fontFamily: 'inherit' }}>
                    {appointment.price_cents > 0 ? 'Edit' : 'Set price'}
                  </button>
                </span>
              )}
            </div>
            <div style={styles.detailRow}>
              <span style={styles.detailLabel}>Status</span>
              <span style={{ ...styles.statusBadge, background: getStatusColor(appointment.status) + '20', color: getStatusColor(appointment.status) }}>{appointment.status?.replace(/_/g, ' ')}</span>
            </div>
            {appointment.buffer_minutes > 0 && (
              <div style={styles.detailRow}><span style={styles.detailLabel}>Buffer</span><span style={styles.detailValue}>{appointment.buffer_minutes} min cleanup</span></div>
            )}
            {appointment.ai_booked && <div style={styles.detailRow}><span style={styles.detailLabel}>Booked by</span><span style={styles.aiTag}>Florrie</span></div>}
          </div>
          {/* Persistent notes - always visible, save without completing */}
          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary, #888)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Notes</span>
              {notes !== (appointment.beautician_notes || '') && (
                <button onClick={handleSaveNote}
                  style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, border: 'none', background: noteSaved ? 'var(--success-bg, #E8F5E9)' : 'var(--accent)', color: noteSaved ? 'var(--success, #5BA97B)' : '#fff', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, transition: 'all 0.15s' }}>
                  {noteSaved ? '✓ Saved' : 'Save'}
                </button>
              )}
              {noteSaved && notes === (appointment.beautician_notes || '') && (
                <span style={{ fontSize: 11, color: 'var(--success, #5BA97B)', fontWeight: 600 }}>✓ Saved</span>
              )}
            </div>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Colour mix, skin notes, preferences, anything worth remembering..."
              rows={3}
              style={{ width: '100%', padding: '9px 11px', borderRadius: 8, border: '1.5px solid var(--border, #E5E5E5)', fontSize: 13, fontFamily: 'inherit', outline: 'none', resize: 'vertical', boxSizing: 'border-box', color: 'var(--text, #333)', background: 'var(--bg-input, #FAFAFA)' }}
              onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); handleSaveNote(); } }}
            />
            <p style={{ fontSize: 11, color: 'var(--text-muted, #aaa)', margin: '4px 0 0' }}>⌘S to save · notes shown next time this client books</p>
          </div>
          {canComplete && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
              <button onClick={handleQuickComplete} disabled={saving} style={{ ...styles.completeBtn, opacity: saving ? 0.7 : 1 }}>
                {saving ? 'Saving…' : 'Mark as complete'}
              </button>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => { hapticTap(); handleMarkNoShow(); }} disabled={saving}
                  style={{ ...styles.completeBtn, flex: 1, background: 'var(--danger)', fontSize: 12, padding: '8px 0' }}>
                  No-show
                </button>
                <button onClick={() => { hapticTap(); handleSendPaymentLink(); }} disabled={linkLoading}
                  style={{ ...styles.completeBtn, flex: 1, background: 'var(--accent)', fontSize: 12, padding: '8px 0' }}>
                  {linkLoading ? 'Creating...' : 'Send payment link'}
                </button>
              </div>
              {/* Reschedule: move the client to another day/time instead of
                  marking them a no-show (traffic, swapped to Friday, etc.). */}
              <button onClick={openTimeEdit} disabled={saving}
                style={{ ...styles.completeBtn, marginTop: 0, background: 'var(--bg-input, #FAFAFA)', color: COLORS.primary, border: `1.5px solid ${COLORS.outlineVariant}`, fontSize: 13, padding: '10px 0', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>event_repeat</span>
                Reschedule
              </button>
              {/* Card fallback: only shows when there's an unpaid balance (price
                  minus the deposit they paid). For when they didn't bank-transfer. */}
              {(((appointment.price_cents || 0) - (appointment.deposit_paid ? (appointment.deposit_cents || 0) : 0)) >= 30) && (
                <button onClick={() => { hapticTap(); handleChargeBalance(); }} disabled={chargingBalance}
                  style={{ ...styles.completeBtn, marginTop: 0, background: 'var(--bg-input, #FAFAFA)', color: COLORS.primary, border: `1.5px solid ${COLORS.outlineVariant}`, fontSize: 13, padding: '10px 0', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>credit_card</span>
                  {chargingBalance ? 'Charging...' : `Charge £${(((appointment.price_cents || 0) - (appointment.deposit_paid ? (appointment.deposit_cents || 0) : 0)) / 100).toFixed(2)} balance to card`}
                </button>
              )}
              <button onClick={() => setMode('completing')}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted, #9E9790)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', padding: '2px 0' }}>
                Add payment method or photo
              </button>
            </div>
          )}
          {/* Delete a mistaken booking. Destructive, confirmed, and the backend
              refuses (409) if a deposit/fee is attached. */}
          <div style={{ marginTop: 16, paddingTop: 12, borderTop: `1px solid ${COLORS.outlineVariant}33` }}>
            <button onClick={() => { hapticTap(); handleDeleteAppointment(); }} disabled={deleting}
              style={{ width: '100%', padding: '10px 0', borderRadius: 10, border: '1px solid #FECACA', background: '#FEF2F2', color: '#B91C1C', fontSize: 13, fontWeight: 600, cursor: deleting ? 'not-allowed' : 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, opacity: deleting ? 0.6 : 1 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>delete</span>
              {deleting ? 'Deleting…' : 'Delete appointment'}
            </button>
          </div>
          {/* No-show fee charge prompt */}
          {noShowCharging && (
            <div style={{ marginTop: 12, padding: 12, borderRadius: 10, background: 'var(--danger-bg)', border: '1px solid var(--danger-bg)' }}>
              <p style={{ fontSize: 13, color: 'var(--danger-text)', margin: '0 0 8px' }}>Client has a saved card. Charge no-show fee?</p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={handleChargeNoShow} disabled={saving}
                  style={{ flex: 1, padding: '8px', borderRadius: 8, border: 'none', background: 'var(--danger)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                  {saving ? 'Charging...' : `Charge £${((appointment.deposit_cents || appointment.price_cents) / 100).toFixed(2)}`}
                </button>
                <button onClick={() => setNoShowCharging(false)}
                  style={{ flex: 1, padding: '8px', borderRadius: 8, border: '1px solid var(--border-light)', background: 'var(--bg-card)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>
                  Skip
                </button>
              </div>
            </div>
          )}
          {/* Payment link result */}
          {paymentLinkUrl && (
            <div style={{ marginTop: 12, padding: 12, borderRadius: 10, background: 'var(--success-bg)', border: '1px solid #C6F6D5' }}>
              <p style={{ fontSize: 13, color: 'var(--success-text)', margin: '0 0 8px', fontWeight: 600 }}>Payment link ready</p>
              <input readOnly value={paymentLinkUrl} style={{ width: '100%', padding: '8px', borderRadius: 6, border: '1px solid #C6F6D5', fontSize: 12, boxSizing: 'border-box' }}
                onClick={e => { e.target.select(); navigator.clipboard?.writeText?.(paymentLinkUrl); }} />
              <p style={{ fontSize: 11, color: 'var(--success-text)', margin: '6px 0 0' }}>Tap to copy. Send to client via WhatsApp or SMS.</p>
            </div>
          )}
          {/* Show status for already no-show or completed */}
          {appointment.status === 'no_show' && (
            <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: 'var(--danger-bg)', textAlign: 'center' }}>
              <span style={{ fontSize: 13, color: 'var(--danger-text)', fontWeight: 600 }}>Marked as no-show</span>
              {!appointment.no_show_fee_charged && (
                <button onClick={handleSendPaymentLink} disabled={linkLoading}
                  style={{ ...styles.completeBtn, marginTop: 8, background: 'var(--danger)', fontSize: 12, padding: '8px 0' }}>
                  {linkLoading ? 'Creating...' : 'Send no-show fee link'}
                </button>
              )}
            </div>
          )}
          {/* Completed (incl. auto-completed/assumed). Ellie can still flag a
              no-show at the end of the day - the backend reverses the takings
              and charges the policy fee, so the Money tab updates. */}
          {isCompleted && (
            <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: 'var(--success-bg, #F0FBF4)', textAlign: 'center' }}>
              <span style={{ fontSize: 13, color: 'var(--success-text, #2F7A4F)', fontWeight: 600 }}>
                {appointment.payment_method ? 'Completed' : 'Done (assumed)'}
              </span>
              <button onClick={() => { hapticTap(); handleMarkNoShow(); }} disabled={saving}
                style={{ ...styles.completeBtn, marginTop: 8, background: 'var(--bg-input, #FAFAFA)', color: COLORS.primary, border: `1.5px solid ${COLORS.outlineVariant}`, fontSize: 12, padding: '8px 0' }}>
                Actually a no-show
              </button>
            </div>
          )}
        </>
      )}
      {mode === 'completing' && (
        <div style={styles.completionFlow}>
          {/* Payment method */}
          <div style={styles.completionSection}>
            <span style={styles.completionLabel}>Payment</span>
            <div style={styles.paymentOptions}>
              {['card', 'cash', 'transfer', 'unpaid'].map(m => (
                <button key={m} onClick={() => setPaymentMethod(m)}
                  style={{ ...styles.paymentChip, background: paymentMethod === m ? 'var(--accent)' : 'var(--border-light)', color: paymentMethod === m ? '#fff' : 'var(--text-secondary)' }}>
                  {m === 'card' ? '💳' : m === 'cash' ? '💵' : m === 'transfer' ? '🏦' : '⏳'} {m}
                </button>
              ))}
            </div>
          </div>
          {/* Notes */}
          <div style={styles.completionSection}>
            <span style={styles.completionLabel}>Treatment notes</span>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Colour mix, skin reaction, preferences..."
              style={styles.notesInput}
              rows={3}
            />
          </div>
          {/* Before/After photo */}
          <div style={styles.completionSection}>
            <span style={styles.completionLabel}>Before/after photo</span>
            <p style={styles.photoHint}>Feeds into Content Autopilot for Instagram posts</p>
            {beforeAfterUrl ? (
              <div style={styles.photoPreview}>
                <img src={beforeAfterUrl} alt="Before/after" style={styles.photoImg} />
                <button onClick={() => setBeforeAfterUrl(null)} style={styles.photoRemove}>×</button>
              </div>
            ) : (
              <label style={styles.photoUploadBtn}>
                📸 {uploading ? 'Uploading...' : 'Take or upload photo'}
                <input type="file" accept="image/*" capture="environment" onChange={handlePhotoUpload} style={{ display: 'none' }} />
              </label>
            )}
          </div>
          <button onClick={handleComplete} disabled={saving} style={styles.confirmCompleteBtn}>
            {saving ? 'Saving...' : `Complete - £${(appointment.price_cents / 100).toFixed(2)} ${paymentMethod}`}
          </button>
        </div>
      )}
      {mode === 'done' && (
        <div style={styles.doneScreen}>
          <span style={{ fontSize: 40 }}>✅</span>
          <h3 style={{ fontSize: 18, fontWeight: 700, margin: '12px 0 4px' }}>Done!</h3>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 16 }}>
            £{(appointment.price_cents / 100).toFixed(2)} logged via {paymentMethod}
          </p>
          {/* Rebook prompt */}
          <div style={styles.rebookSection}>
            <span style={styles.completionLabel}>Rebook {appointment.clients?.first_name}?</span>
            <div style={styles.rebookOptions}>
              {[3, 4, 5, 6, 8].map(w => (
                <button key={w} onClick={() => setRebookWeeks(w)}
                  style={{ ...styles.rebookChip, background: rebookWeeks === w ? 'var(--accent)' : 'var(--border-light)', color: rebookWeeks === w ? '#fff' : 'var(--text-secondary)' }}>
                  {w} weeks
                </button>
              ))}
            </div>
            <button
              style={{ ...styles.rebookSendBtn, opacity: rebookSaving || rebookSent ? 0.7 : 1 }}
              disabled={rebookSaving || rebookSent}
              onClick={handleSendRebook}>
              {rebookSent ? '✓ Reminder scheduled' : rebookSaving ? 'Scheduling…' : `Send rebook reminder in ${rebookWeeks} weeks`}
            </button>
          </div>
          <button onClick={handleDone} style={styles.doneCloseBtn}>Close</button>
        </div>
      )}
    </div>
  );
}
// LOCAL calendar date as YYYY-MM-DD — never toISOString(), which converts to UTC
// and, under British Summer Time (UTC+1), rolls every date back to the previous
// day. That's the bug that "shifted the whole calendar": blocking a day or
// grouping appointments by formatDate() landed everything on the day before.
// The rest of the diary reads stored times as wall-clock (see wallMinutes), and
// BookingPage/HoursExceptions already build their date keys from local parts —
// this keeps day-grouping consistent with both.
function formatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function isToday(d) { return d.toDateString() === new Date().toDateString(); }
function isSameDay(a, b) { return a.toDateString() === b.toDateString(); }
function getWeekStart(d) { const s = new Date(d); const day = s.getDay(); s.setDate(s.getDate() + (day === 0 ? -6 : 1 - day)); return s; }
function getWeekEnd(d) { const e = getWeekStart(d); e.setDate(e.getDate() + 6); return e; }
function getNowPosition() { const now = new Date(); return ((now.getHours() * 60 + now.getMinutes() - START_HOUR * 60) / 60) * HOUR_HEIGHT; }
const styles = {
  page: { minHeight: '100vh', background: 'var(--bg)', fontFamily: "var(--font-body, 'DM Sans', -apple-system, sans-serif)", padding: '0 16px 120px', maxWidth: 480, margin: '0 auto', color: 'var(--text-primary)', animation: 'fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)' },
  header: { paddingTop: 20, paddingBottom: 16 },
  headerTop: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  headerCenter: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 },
  dateTitle: { fontSize: 17, fontWeight: 600, margin: 0, textAlign: 'center', fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)" },
  todayBtn: { background: 'none', border: `1px solid ${COLORS.outlineVariant}`, borderRadius: 8, padding: '4px 12px', fontSize: 12, color: COLORS.stone400, cursor: 'pointer', fontFamily: 'inherit' },
  navBtn: { background: 'none', border: 'none', fontSize: 28, color: COLORS.stone400, cursor: 'pointer', padding: '0 8px' },
  viewToggle: { display: 'flex', gap: 3, background: 'var(--card-bg, #fff)', borderRadius: 12, padding: 3, border: `1px solid ${COLORS.outlineVariant}` },
  toggleBtn: { flex: 1, padding: '6px 14px', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer', transition: 'all 0.2s', fontFamily: 'inherit' },
  // Weekly Date Strip
  weeklyStripContainer: { marginBottom: 20, background: COLORS.surfaceContainerLow, borderRadius: 24, padding: '12px 16px', position: 'relative' },
  weeklyStripHeader: { marginBottom: 12 },
  weeklyStripMonth: { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: COLORS.stone400 },
  weeklyStrip: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 8 },
  weeklyStripDay: { display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '8px 4px', borderRadius: 12, border: 'none', cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.2s ease' },
  weeklyStripDayName: { fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' },
  weeklyStripDayNumber: { fontSize: 16, fontWeight: 700, marginTop: 2 },
  // Day View Timeline. The grid scrolls inside its own container so the
  // full 06:00-23:00 day fits and we can auto-scroll to the first booking.
  dayGrid: { display: 'flex', gap: 0, background: 'var(--bg-card)', borderRadius: 16, overflowY: 'auto', overflowX: 'hidden', maxHeight: 'calc(100dvh - 300px)', minHeight: 420, boxShadow: '0 10px 30px rgba(146, 64, 94, 0.06)', WebkitOverflowScrolling: 'touch' },
  timeColumn: { width: 56, position: 'relative', borderRight: `1px solid ${COLORS.outlineVariant}33`, flexShrink: 0 },
  timeLabel: { position: 'absolute', right: 8, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: COLORS.stone400, transform: 'translateY(-6px)' },
  appointmentColumn: { flex: 1, position: 'relative' },
  // Floating add button: 140px up keeps clear of the mic FAB at +78px
  addFab: { position: 'fixed', bottom: 'calc(env(safe-area-inset-bottom, 0px) + 140px)', right: 16, width: 52, height: 52, borderRadius: 26, border: 'none', background: COLORS.primary, color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 6px 18px rgba(146, 64, 94, 0.35)', zIndex: 840, fontFamily: 'inherit', WebkitTapHighlightColor: 'transparent' },
  hourLine: { position: 'absolute', left: 0, right: 0, height: 1, background: `${COLORS.outlineVariant}33` },
  nowLine: { position: 'absolute', left: -4, right: 0, height: 2, background: '#E53E3E', zIndex: 10 },
  nowDot: { width: 8, height: 8, borderRadius: '50%', background: '#E53E3E', position: 'absolute', left: -2, top: -3 },
  // Appointment Cards
  appointmentCard: { position: 'absolute', left: 4, right: 4, borderRadius: 12, padding: '6px 10px', cursor: 'pointer', transition: 'all 0.15s', fontFamily: 'inherit', textAlign: 'left', border: 'none', borderLeft: '4px solid', boxShadow: '0 10px 30px rgba(146, 64, 94, 0.06)', overflow: 'visible', width: 'calc(100% - 8px)', zIndex: 2, minHeight: 56 },
  appointmentCardContent: { display: 'flex', alignItems: 'center', gap: 8 },
  appointmentCardHeader: { display: 'flex', gap: 8, alignItems: 'center', flex: 1, minWidth: 0 },
  appointmentAvatar: { width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 10, fontWeight: 700, flexShrink: 0 },
  appointmentCardTextBlock: { flex: 1, display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 },
  appointmentCardClientName: { fontSize: 13, fontWeight: 700, color: COLORS.onSurface, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  appointmentCardTreatment: { fontSize: 10, fontWeight: 500, textTransform: 'uppercase', color: COLORS.stone400, letterSpacing: '0.02em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  appointmentCardMeta: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, flexShrink: 0 },
  appointmentCardTime: { fontWeight: 600, color: COLORS.stone400, textTransform: 'uppercase' },
  aiTag: { display: 'inline-block', padding: '2px 6px', borderRadius: 4, fontSize: 9, fontWeight: 600, background: '#EEF4FC', color: '#4A90D9', letterSpacing: '0.03em' },
  // Open Slot Cards
  openSlotCard: { position: 'absolute', left: 4, right: 4, borderRadius: 16, border: `2px dashed ${COLORS.outlineVariant}80`, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 'calc(100% - 8px)' },
  openSlotText: { fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: COLORS.stone400 },
  // Week View - agenda by day
  weekAgenda: { display: 'flex', flexDirection: 'column', gap: 12 },
  weekDaySection: { background: 'var(--bg-card)', borderRadius: 16, boxShadow: '0 10px 30px rgba(146, 64, 94, 0.06)', overflow: 'hidden' },
  weekDaySectionToday: { boxShadow: `0 0 0 1.5px ${COLORS.primary}, 0 10px 30px rgba(146, 64, 94, 0.10)` },
  weekDayHead: { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '12px 14px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' },
  weekDayHeadLeft: { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 },
  weekDayDow: { fontSize: 15, fontWeight: 700 },
  weekDayDate: { fontSize: 12, fontWeight: 500, color: COLORS.stone400 },
  weekTodayTag: { fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#fff', background: COLORS.primary, padding: '2px 6px', borderRadius: 5 },
  weekDayStats: { display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 },
  weekDayCount: { fontSize: 12, fontWeight: 600, color: COLORS.onSurface },
  weekDayMoney: { fontSize: 12, fontWeight: 700, color: COLORS.primary },
  weekDayHours: { fontSize: 11, fontWeight: 600, color: COLORS.stone400 },
  weekDayQuiet: { fontSize: 12, fontWeight: 500, color: COLORS.stone400, flexShrink: 0 },
  weekDayRows: { borderTop: `1px solid ${COLORS.outlineVariant}33`, padding: '4px 0' },
  weekRow: { width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' },
  weekRowTime: { fontSize: 12, fontWeight: 700, color: COLORS.onSurface, width: 42, flexShrink: 0, fontVariantNumeric: 'tabular-nums' },
  weekRowDot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  weekRowBody: { display: 'flex', flexDirection: 'column', gap: 1, flex: 1, minWidth: 0 },
  weekRowName: { fontSize: 13, fontWeight: 600, color: COLORS.onSurface, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  weekRowTreatment: { fontSize: 11, color: COLORS.stone400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  weekRowPrice: { fontSize: 12, fontWeight: 700, color: COLORS.onSurface, flexShrink: 0 },
  // Floating Insights Pill
  insightsPillIcon: { fontSize: 14 },
  insightsPillText: { fontSize: 12, fontWeight: 600 },
  // Detail Panel
  detailPanel: { background: 'var(--bg-card)', borderRadius: 16, padding: 20, marginTop: 16, boxShadow: '0 10px 30px rgba(146, 64, 94, 0.06)' },
  detailHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  detailTitle: { fontSize: 17, fontWeight: 700, margin: 0 },
  detailClose: { background: 'none', border: 'none', fontSize: 22, color: COLORS.stone400, cursor: 'pointer' },
  detailGrid: { display: 'flex', flexDirection: 'column', gap: 0 },
  detailRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: `1px solid ${COLORS.outlineVariant}33` },
  detailLabel: { fontSize: 13, color: COLORS.stone400, fontWeight: 500 },
  detailValue: { fontSize: 13, fontWeight: 600, textAlign: 'right' },
  statusBadge: { padding: '3px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, textTransform: 'capitalize' },
  completeBtn: { width: '100%', padding: '12px 0', borderRadius: 12, border: 'none', background: '#5BA67F', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginTop: 14 },
  completionFlow: { display: 'flex', flexDirection: 'column', gap: 16 },
  completionSection: { display: 'flex', flexDirection: 'column', gap: 6 },
  completionLabel: { fontSize: 11, fontWeight: 700, color: COLORS.stone400, textTransform: 'uppercase', letterSpacing: '0.05em' },
  paymentOptions: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  paymentChip: { padding: '8px 14px', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', textTransform: 'capitalize', transition: 'all 0.15s' },
  notesInput: { width: '100%', padding: '10px 12px', borderRadius: 8, border: `1.5px solid ${COLORS.outlineVariant}`, fontSize: 14, fontFamily: 'inherit', outline: 'none', resize: 'vertical', boxSizing: 'border-box' },
  photoHint: { fontSize: 12, color: COLORS.stone400, margin: 0 },
  photoUploadBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '14px 0', borderRadius: 12, border: `2px dashed ${COLORS.outlineVariant}`, fontSize: 14, fontWeight: 500, color: COLORS.stone400, cursor: 'pointer', fontFamily: 'inherit' },
  photoPreview: { position: 'relative', borderRadius: 12, overflow: 'hidden' },
  photoImg: { width: '100%', borderRadius: 12, maxHeight: 200, objectFit: 'cover' },
  photoRemove: { position: 'absolute', top: 8, right: 8, width: 28, height: 28, borderRadius: '50%', background: 'rgba(0,0,0,0.5)', color: '#fff', border: 'none', fontSize: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  confirmCompleteBtn: { width: '100%', padding: '14px 0', borderRadius: 12, border: 'none', background: '#5BA67F', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  doneScreen: { textAlign: 'center', padding: '20px 0' },
  rebookSection: { background: COLORS.surfaceContainerLow, borderRadius: 12, padding: 16, textAlign: 'left', marginBottom: 12 },
  rebookOptions: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 },
  rebookChip: { padding: '6px 12px', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s' },
  rebookSendBtn: { width: '100%', padding: '10px 0', borderRadius: 8, border: 'none', background: COLORS.primary, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  doneCloseBtn: { width: '100%', padding: '10px 0', borderRadius: 8, border: 'none', background: `${COLORS.outlineVariant}33`, color: COLORS.stone400, fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' },
};
// BlockTimeModal - create a new time block
const BLOCK_REASONS = [
  { key: 'lunch', label: '🍽️ Lunch' },
  { key: 'holiday', label: '🏖️ Holiday' },
  { key: 'personal', label: '🏠 Personal' },
  { key: 'sick', label: '🤒 Sick' },
  { key: 'training', label: '📚 Training' },
  { key: 'other', label: '✏️ Other' },
];
function BlockTimeModal({ defaultDate, onSave, onClose, saving }) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const nowTime = `${pad(now.getHours())}:${pad(Math.ceil(now.getMinutes() / 15) * 15 === 60 ? 0 : Math.ceil(now.getMinutes() / 15) * 15)}`;
  const plusOneHour = `${pad(now.getHours() + 1)}:${pad(Math.ceil(now.getMinutes() / 15) * 15 === 60 ? 0 : Math.ceil(now.getMinutes() / 15) * 15)}`;
  const [date, setDate] = useState(defaultDate);
  const [type, setType] = useState('amended'); // 'closed' = all day, 'amended' = time range
  const [startTime, setStartTime] = useState(nowTime);
  const [endTime, setEndTime] = useState(plusOneHour);
  const [reason, setReason] = useState('personal');
  const [note, setNote] = useState('');
  const PRESETS = [
    {
      label: 'Lunch (1hr)',
      apply: () => {
        setType('amended');
        setStartTime('12:00');
        setEndTime('13:00');
        setReason('lunch');
      },
    },
    {
      label: 'Rest of day',
      apply: () => {
        setType('amended');
        setStartTime(nowTime);
        setEndTime('20:00');
        setReason('personal');
      },
    },
    {
      label: 'All day',
      apply: () => {
        setType('closed');
        setReason('holiday');
      },
    },
    {
      label: '1 hour',
      apply: () => {
        setType('amended');
        setStartTime(nowTime);
        setEndTime(plusOneHour);
        setReason('personal');
      },
    },
  ];
  function handleSave() {
    onSave({
      date,
      type,
      reason,
      note: note.trim() || undefined,
      start_time: type === 'closed' ? undefined : startTime,
      end_time: type === 'closed' ? undefined : endTime,
    });
  }
  const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 50, display: 'flex', alignItems: 'flex-end' };
  const sheet = { background: 'var(--bg-card)', borderRadius: '20px 20px 0 0', padding: '20px 20px 40px', width: '100%', maxWidth: 480, margin: '0 auto', fontFamily: '"DM Sans", -apple-system, sans-serif', maxHeight: '90vh', overflowY: 'auto' };
  return (
    <div style={overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={sheet}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: COLORS.onSurface }}>Block time</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: COLORS.stone400 }}>×</button>
        </div>
        {/* Quick presets */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
          {PRESETS.map(p => (
            <button
              key={p.label}
              onClick={p.apply}
              style={{ padding: '7px 12px', borderRadius: 8, border: `1.5px solid ${COLORS.outlineVariant}`, background: 'var(--bg-card)', color: COLORS.onSurface, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
            >
              {p.label}
            </button>
          ))}
        </div>
        {/* Date */}
        <label style={{ fontSize: 12, fontWeight: 600, color: COLORS.stone400, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Date</label>
        <input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
          style={{ display: 'block', width: '100%', marginTop: 4, marginBottom: 14, padding: '10px 12px', borderRadius: 10, border: `1.5px solid ${COLORS.outlineVariant}`, fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }}
        />
        {/* All day toggle */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <span style={{ fontSize: 14, fontWeight: 500, color: COLORS.onSurface }}>All day</span>
          <button
            onClick={() => setType(type === 'closed' ? 'amended' : 'closed')}
            style={{ width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer', position: 'relative', transition: 'background 0.2s', padding: 0, background: type === 'closed' ? COLORS.primary : COLORS.outlineVariant }}
          >
            <div style={{ width: 20, height: 20, borderRadius: 10, background: '#fff', position: 'absolute', top: 2, transition: 'transform 0.2s', transform: type === 'closed' ? 'translateX(20px)' : 'translateX(2px)' }} />
          </button>
        </div>
        {/* Time range - only when not all day */}
        {type !== 'closed' && (
          <div style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'center' }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: COLORS.stone400, textTransform: 'uppercase', letterSpacing: '0.05em' }}>From</label>
              <input
                type="time"
                value={startTime}
                onChange={e => setStartTime(e.target.value)}
                style={{ display: 'block', width: '100%', marginTop: 4, padding: '10px 12px', borderRadius: 10, border: `1.5px solid ${COLORS.outlineVariant}`, fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }}
              />
            </div>
            <span style={{ fontSize: 14, color: COLORS.stone400, marginTop: 16 }}>→</span>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: COLORS.stone400, textTransform: 'uppercase', letterSpacing: '0.05em' }}>To</label>
              <input
                type="time"
                value={endTime}
                onChange={e => setEndTime(e.target.value)}
                style={{ display: 'block', width: '100%', marginTop: 4, padding: '10px 12px', borderRadius: 10, border: `1.5px solid ${COLORS.outlineVariant}`, fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }}
              />
            </div>
          </div>
        )}
        {/* Reason */}
        <label style={{ fontSize: 12, fontWeight: 600, color: COLORS.stone400, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 8 }}>Reason</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
          {BLOCK_REASONS.map(r => (
            <button
              key={r.key}
              onClick={() => setReason(r.key)}
              style={{
                padding: '7px 12px', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                background: reason === r.key ? COLORS.primary : `${COLORS.outlineVariant}33`,
                color: reason === r.key ? '#fff' : COLORS.onSurface,
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
        {/* Note */}
        <label style={{ fontSize: 12, fontWeight: 600, color: COLORS.stone400, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Note (optional)</label>
        <input
          type="text"
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder="e.g. School pickup, dentist..."
          style={{ display: 'block', width: '100%', marginTop: 4, marginBottom: 20, padding: '10px 12px', borderRadius: 10, border: `1.5px solid ${COLORS.outlineVariant}`, fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }}
        />
        <button
          onClick={handleSave}
          disabled={saving}
          style={{ width: '100%', padding: '14px 0', borderRadius: 12, border: 'none', background: saving ? COLORS.stone400 : COLORS.primary, color: '#fff', fontSize: 15, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', fontFamily: 'inherit' }}
        >
          {saving ? 'Saving…' : 'Block this time'}
        </button>
      </div>
    </div>
  );
}
// BlockDetailSheet - shows an existing block + remove option
function BlockDetailSheet({ block, onDelete, onClose }) {
  const [confirming, setConfirming] = useState(false);
  const isClosed = block.type === 'closed' || block.is_closed;
  const timeRange = isClosed
    ? 'All day'
    : `${block.start_time || block.custom_start || '?'} → ${block.end_time || block.custom_end || '?'}`;
  const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 50, display: 'flex', alignItems: 'flex-end' };
  const sheet = { background: 'var(--bg-card)', borderRadius: '20px 20px 0 0', padding: '20px 20px 40px', width: '100%', maxWidth: 480, margin: '0 auto', fontFamily: '"DM Sans", -apple-system, sans-serif' };
  return (
    <div style={overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={sheet}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: COLORS.onSurface }}>Time block</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: COLORS.stone400 }}>×</button>
        </div>
        <div style={{ background: `${COLORS.outlineVariant}22`, borderRadius: 12, padding: 14, marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: COLORS.stone400 }}>Date</span>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{block.date}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: COLORS.stone400 }}>Time</span>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{timeRange}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: block.note ? 8 : 0 }}>
            <span style={{ fontSize: 12, color: COLORS.stone400 }}>Reason</span>
            <span style={{ fontSize: 13, fontWeight: 600, textTransform: 'capitalize' }}>{block.reason || '-'}</span>
          </div>
          {block.note && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12, color: COLORS.stone400 }}>Note</span>
              <span style={{ fontSize: 13, fontWeight: 500, textAlign: 'right', maxWidth: '65%' }}>{block.note}</span>
            </div>
          )}
        </div>
        {confirming ? (
          <div>
            <p style={{ fontSize: 14, color: COLORS.onSurface, marginBottom: 12, textAlign: 'center' }}>Remove this block?</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setConfirming(false)} style={{ flex: 1, padding: '12px 0', borderRadius: 10, border: `1.5px solid ${COLORS.outlineVariant}`, background: 'var(--bg-card)', color: COLORS.onSurface, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                Cancel
              </button>
              <button onClick={onDelete} style={{ flex: 1, padding: '12px 0', borderRadius: 10, border: 'none', background: '#E57373', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                Remove
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            style={{ width: '100%', padding: '13px 0', borderRadius: 12, border: 'none', background: '#FEE2E2', color: '#B91C1C', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}
          >
            Remove this block
          </button>
        )}
      </div>
    </div>
  );
}
// NewAppointmentModal - manual entry from the day calendar's plus button.
// Search an existing client or quick-create one (name + optional phone),
// pick a treatment (price autofills but stays editable), any 15-min time
// across the full 06:00-23:00 day. "Send confirmation message" defaults
// OFF so bookings mirrored from an old system never double-message clients.
const TIME_OPTIONS = (() => {
  const opts = [];
  for (let h = START_HOUR; h < END_HOUR; h++) {
    for (let m = 0; m < 60; m += 15) {
      opts.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  return opts;
})();
function NewAppointmentModal({ defaultDate, existingAppointments = [], onClose, onSaved }) {
  const [treatments, setTreatments] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]); // one or more treatments
  const [price, setPrice] = useState('');
  const [duration, setDuration] = useState(60);
  const [date, setDate] = useState(defaultDate);
  const [time, setTime] = useState('10:00');
  const [sendConfirmation, setSendConfirmation] = useState(false);
  // Client picking: search an existing client, or quick-create a new one
  const [clientMode, setClientMode] = useState('search'); // search | new
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selectedClient, setSelectedClient] = useState(null);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  // Keep the bottom sheet above the on-screen keyboard (and its accessory bar)
  // by sizing the overlay to the visual viewport, so the fields and the Add
  // button never end up hidden or overlapped when the number pad opens.
  const [vp, setVp] = useState(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setVp({ height: vv.height, top: vv.offsetTop });
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update); };
  }, []);
  async function authedFetch(path, opts = {}) {
    const token = (await supabase.auth.getSession()).data.session?.access_token;
    return fetch(`${API_BASE}${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, ...(opts.headers || {}) },
    });
  }
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authedFetch('/api/treatments');
        const data = await res.json();
        if (!cancelled) setTreatments((data.treatments || []).filter(t => t.is_active !== false));
      } catch (err) {
        logger.error('Load treatments error:', err);
      }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Debounced client search against /api/clients?search=
  useEffect(() => {
    if (selectedClient || clientMode !== 'search') return;
    const q = query.trim();
    if (q.length < 2) { setResults([]); return; }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await authedFetch(`/api/clients?search=${encodeURIComponent(q)}&per_page=8`);
        const data = await res.json();
        setResults(data.data || []);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query, clientMode, selectedClient]); // eslint-disable-line react-hooks/exhaustive-deps
  // Tap to add/remove a treatment. Price + duration auto-sum across all chosen,
  // and stay editable below so she can tweak the total.
  function toggleTreatment(id) {
    setSelectedIds(prev => {
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
      const chosen = treatments.filter(t => next.includes(t.id));
      const sumPence = chosen.reduce((s, t) => s + (t.price_cents || 0), 0);
      const sumDur = chosen.reduce((s, t) => s + (t.duration_minutes || 0), 0);
      setPrice((sumPence / 100).toFixed(2));
      setDuration(sumDur || 60);
      return next;
    });
  }
  async function handleSave() {
    setError(null);
    if (!selectedClient && !newName.trim()) { setError('Pick a client or enter a name'); return; }
    if (!selectedIds.length) { setError('Pick at least one treatment'); return; }
    const priceNum = parseFloat(price);
    if (isNaN(priceNum) || priceNum < 0) { setError('Enter a valid price'); return; }
    const durNum = parseInt(duration, 10);
    if (isNaN(durNum) || durNum < 5) { setError('Enter a valid duration'); return; }
    setSaving(true);
    try {
      const chosen = treatments.filter(t => selectedIds.includes(t.id));
      const payload = {
        treatment_id: selectedIds[0], // primary; combined time + price below
        date,
        time,
        duration_minutes: durNum,
        price_cents: Math.round(priceNum * 100),
        send_confirmation: sendConfirmation,
      };
      if (chosen.length > 1) {
        payload.notes = 'Includes: ' + chosen.map(t => t.name).join(' + ');
      }
      if (selectedClient) {
        payload.client_id = selectedClient.id;
      } else {
        payload.client_name = newName.trim();
        if (newPhone.trim()) payload.client_phone = newPhone.trim();
      }
      const res = await authedFetch('/api/appointments/manual', { method: 'POST', body: JSON.stringify(payload) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save the appointment');
      onSaved();
    } catch (err) {
      logger.error('Manual appointment save error:', err);
      setError(err.message || 'Could not save the appointment');
    } finally {
      setSaving(false);
    }
  }
  // Does the chosen slot overlap an appointment already in the book? Warn,
  // don't block, so Ellie can still double-book on purpose if she means to.
  const clash = (() => {
    const durNum = parseInt(duration, 10);
    if (!date || !time || isNaN(durNum)) return null;
    const [hh, mm] = time.split(':').map(Number);
    if (isNaN(hh) || isNaN(mm)) return null;
    const newStart = hh * 60 + mm;
    const newEnd = newStart + durNum;
    return existingAppointments.find(a => {
      if (!a.starts_at?.startsWith(date)) return false;
      if (DEAD_STATUSES.includes(a.status)) return false;
      const aStart = wallMinutes(a.starts_at);
      const aEnd = a.ends_at ? wallMinutes(a.ends_at) : aStart + 60;
      return newStart < aEnd && aStart < newEnd;
    }) || null;
  })();
  const overlay = { position: 'fixed', left: 0, right: 0, top: vp ? vp.top : 0, height: vp ? vp.height : '100%', background: 'rgba(0,0,0,0.4)', zIndex: 900, display: 'flex', alignItems: 'flex-end' };
  const sheet = { background: 'var(--bg-card)', borderRadius: '20px 20px 0 0', padding: '20px 20px calc(28px + env(safe-area-inset-bottom))', width: '100%', maxWidth: 480, margin: '0 auto', fontFamily: '"DM Sans", -apple-system, sans-serif', maxHeight: '100%', overflowY: 'auto', WebkitOverflowScrolling: 'touch' };
  const labelStyle = { fontSize: 12, fontWeight: 600, color: COLORS.stone400, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block' };
  const inputStyle = { display: 'block', width: '100%', marginTop: 4, padding: '10px 12px', borderRadius: 10, border: `1.5px solid ${COLORS.outlineVariant}`, fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', background: 'var(--bg-card)', color: COLORS.onSurface };
  return (
    <div style={overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={sheet}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: COLORS.onSurface }}>New appointment</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: COLORS.stone400 }}>×</button>
        </div>
        {/* Client */}
        <span style={labelStyle}>Client</span>
        {selectedClient ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, marginBottom: 14, padding: '9px 12px', borderRadius: 10, background: `${COLORS.outlineVariant}33` }}>
            <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: COLORS.onSurface }}>
              {selectedClient.first_name} {selectedClient.last_name || ''}
            </span>
            <button onClick={() => { setSelectedClient(null); setQuery(''); }} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: COLORS.stone400, padding: 0 }}>×</button>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 6, marginTop: 6, marginBottom: 8 }}>
              {[{ key: 'search', label: 'Existing' }, { key: 'new', label: 'New client' }].map(opt => (
                <button
                  key={opt.key}
                  onClick={() => { setClientMode(opt.key); setError(null); }}
                  style={{
                    padding: '7px 12px', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                    background: clientMode === opt.key ? COLORS.primary : `${COLORS.outlineVariant}33`,
                    color: clientMode === opt.key ? '#fff' : COLORS.onSurface,
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {clientMode === 'search' ? (
              <div style={{ marginBottom: 14 }}>
                <input
                  type="text"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Search by name..."
                  style={inputStyle}
                />
                {searching && <p style={{ fontSize: 12, color: COLORS.stone400, margin: '6px 0 0' }}>Searching...</p>}
                {!searching && results.length > 0 && (
                  <div style={{ marginTop: 6, borderRadius: 10, border: `1.5px solid ${COLORS.outlineVariant}`, overflow: 'hidden' }}>
                    {results.map(c => (
                      <button
                        key={c.id}
                        onClick={() => { setSelectedClient(c); setResults([]); }}
                        style={{ display: 'block', width: '100%', padding: '10px 12px', border: 'none', borderBottom: `1px solid ${COLORS.outlineVariant}33`, background: 'var(--bg-card)', textAlign: 'left', fontSize: 14, fontFamily: 'inherit', cursor: 'pointer', color: COLORS.onSurface }}
                      >
                        <span style={{ fontWeight: 600 }}>{c.first_name} {c.last_name || ''}</span>
                        {c.phone && <span style={{ fontSize: 12, color: COLORS.stone400, marginLeft: 8 }}>{c.phone}</span>}
                      </button>
                    ))}
                  </div>
                )}
                {!searching && query.trim().length >= 2 && results.length === 0 && (
                  <p style={{ fontSize: 12, color: COLORS.stone400, margin: '6px 0 0' }}>
                    No matches. Switch to New client to add them.
                  </p>
                )}
              </div>
            ) : (
              <div style={{ marginBottom: 14 }}>
                <input
                  type="text"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  placeholder="Name"
                  style={inputStyle}
                />
                <input
                  type="tel"
                  value={newPhone}
                  onChange={e => setNewPhone(e.target.value)}
                  placeholder="Phone (optional)"
                  style={{ ...inputStyle, marginTop: 8 }}
                />
              </div>
            )}
          </>
        )}
        {/* Treatments , tap to add one or more. Time and price sum below. */}
        <span style={labelStyle}>Treatments{selectedIds.length > 1 ? ` (${selectedIds.length})` : ''}</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '6px 0 14px' }}>
          {treatments.map(t => {
            const on = selectedIds.includes(t.id);
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => toggleTreatment(t.id)}
                style={{
                  padding: '8px 12px', borderRadius: 999, fontSize: 13, fontWeight: 600,
                  cursor: 'pointer', fontFamily: 'inherit',
                  border: `1.5px solid ${on ? COLORS.primary : COLORS.outlineVariant}`,
                  background: on ? COLORS.primary : 'var(--bg-card, #fff)',
                  color: on ? '#fff' : COLORS.onSurface,
                }}
              >
                {on ? '✓ ' : ''}{t.name} £{((t.price_cents || 0) / 100).toFixed(0)}
              </button>
            );
          })}
          {treatments.length === 0 && (
            <span style={{ fontSize: 13, color: COLORS.stone400 }}>No treatments yet. Add them in Treatments.</span>
          )}
        </div>
        {/* Date + time */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <span style={labelStyle}>Date</span>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle} />
          </div>
          <div style={{ flex: 1 }}>
            <span style={labelStyle}>Time</span>
            <select value={time} onChange={e => setTime(e.target.value)} style={inputStyle}>
              {TIME_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </div>
        {/* Duration + price */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <span style={labelStyle}>Duration (min)</span>
            <input
              type="number"
              min={5}
              step={5}
              value={duration}
              onChange={e => setDuration(e.target.value)}
              style={inputStyle}
            />
          </div>
          <div style={{ flex: 1 }}>
            <span style={labelStyle}>Price (£)</span>
            <input
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              value={price}
              onChange={e => setPrice(e.target.value)}
              placeholder="0.00"
              style={inputStyle}
            />
          </div>
        </div>
        {/* Send confirmation toggle, OFF by default */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span style={{ fontSize: 14, fontWeight: 500, color: COLORS.onSurface }}>Send confirmation message</span>
          <button
            onClick={() => setSendConfirmation(v => !v)}
            aria-pressed={sendConfirmation}
            style={{ width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer', position: 'relative', transition: 'background 0.2s', padding: 0, background: sendConfirmation ? COLORS.primary : COLORS.outlineVariant }}
          >
            <div style={{ width: 20, height: 20, borderRadius: 10, background: '#fff', position: 'absolute', top: 2, transition: 'transform 0.2s', transform: sendConfirmation ? 'translateX(20px)' : 'translateX(2px)' }} />
          </button>
        </div>
        <p style={{ fontSize: 11, color: COLORS.stone400, margin: '0 0 18px' }}>
          Leave off when copying over bookings from your old system, so clients don't get a duplicate message.
        </p>
        {clash && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 10, background: 'var(--warning-bg)', border: '1px solid #FED7AA', margin: '0 0 12px' }}>
            <span className="material-symbols-outlined" style={{ fontSize: 18, color: '#C2410C', flexShrink: 0 }}>warning</span>
            <span style={{ fontSize: 12.5, color: 'var(--warning-text)', lineHeight: 1.45 }}>
              This overlaps {clash.clients?.first_name || 'another booking'} at {formatWallTime(clash.starts_at)}
              {clash.treatments?.name ? ` (${clash.treatments.name})` : ''}. You can still add it if you mean to double-book.
            </span>
          </div>
        )}
        {error && (
          <p style={{ fontSize: 13, color: '#B91C1C', margin: '0 0 12px', fontWeight: 600 }}>{error}</p>
        )}
        <button
          onClick={() => { hapticTap(); handleSave(); }}
          disabled={saving}
          style={{ width: '100%', padding: '14px 0', borderRadius: 12, border: 'none', background: saving ? COLORS.stone400 : COLORS.primary, color: '#fff', fontSize: 15, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', fontFamily: 'inherit' }}
        >
          {saving ? 'Saving...' : (clash ? 'Add anyway' : 'Add appointment')}
        </button>
      </div>
    </div>
  );
}
