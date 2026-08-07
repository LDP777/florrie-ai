import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import { useBeautician, supabase, updateRow, insertRow } from '../lib/supabase.js'
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import { hapticTap, hapticSuccess } from '../lib/native.js';
import { treatmentColor, tint } from '../lib/treatmentColors.js';
import { parseDateOnly } from '../lib/dates.js';
import Icon, { iconName } from '../components/ui/Icon';

// 15-minute duration steps for the appointment-length picker (15 min to 8 h).
const DURATION_STEPS = Array.from({ length: 32 }, (_, i) => (i + 1) * 15);
function durationLabel(m) {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
}

// A patch test has no treatment_id (it is not one of her treatments), so
// `treatments.name` is null and the appointment rendered as a blank row in the
// diary. Fall back to the note we stamp on it at booking.
function baseLabel(a) {
  if (a?.treatments?.name) return a.treatments.name;
  if (a?.beautician_notes && /patch test/i.test(a.beautician_notes)) return 'Patch test';
  return '';
}

/** The extra treatment ids on an appointment, always as an array. */
function extraIdsOf(a) {
  return Array.isArray(a?.extra_treatment_ids) ? a.extra_treatment_ids : [];
}

/**
 * What the appointment is called now that a booking can hold more than one
 * treatment: "Patch test + Lash infill", "Lash lift + Brow tint".
 *
 * The extras are stored as bare uuids, so naming them needs a lookup. Where
 * there is no map to hand (or a treatment has since been deleted) it degrades
 * to the base name rather than printing a uuid at her.
 *
 * @param {object} a appointment row
 * @param {Record<string,string>} [names] treatment id -> name
 */
function apptLabel(a, names) {
  const base = baseLabel(a);
  const extras = names ? extraIdsOf(a).map(id => names[id]).filter(Boolean) : [];
  return [base, ...extras].filter(Boolean).join(' + ');
}

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
// getDay() order, so working_hours can be looked up straight off a Date. The
// week strip, the day grid's out-of-hours dimming and the week agenda all read
// her hours the same way; they used to each carry their own copy of this.
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
// Density dots on the strip stop at five. Past that the shape of the day is
// already "full" and a sixth dot tells her nothing she would act on.
const STRIP_MAX_DOTS = 5;
// A horizontal swipe has to travel a decent distance AND clearly beat the
// vertical drift, or a scroll down the diary would start flicking days past
// her. Same test for both swipes on this screen so they feel like one gesture.
const SWIPE_MIN_PX = 56;
const SWIPE_RATIO = 1.4;
/** -1 (backwards), 1 (forwards) or 0 (that was not a swipe). */
function swipeDirection(start, x, y) {
  if (!start) return 0;
  const dx = x - start.x;
  const dy = y - start.y;
  if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * SWIPE_RATIO) return 0;
  return dx < 0 ? 1 : -1;   // dragging left pulls the next day/week in from the right
}

/** Wall-clock minutes since midnight, read straight off the stored string
 *  ("2026-06-12T14:00:00..." -> 840) so no browser timezone ever shifts it. */
function wallMinutes(isoish) {
  const s = String(isoish || '');
  const h = parseInt(s.slice(11, 13), 10);
  const m = parseInt(s.slice(14, 16), 10);
  if (isNaN(h) || isNaN(m)) {
    const d = new Date(isoish);
    return d.getUTCHours() * 60 + d.getUTCMinutes(); // UTC frame IS the wall clock
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

/** Minutes since midnight -> "HH:MM" for labels and stored wall-time strings. */
function minToHHMM(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
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

// Controls on the treatments list. Pulled out because the same select and the
// same button appear three times on that row and inline styles drift.
// 44px minimums throughout: this is tapped with a thumb, mid-appointment.
const TAP = 44;
const treatSelectStyle = {
  minHeight: TAP,
  padding: '8px 10px',
  borderRadius: 8,
  border: `1px solid ${COLORS.outlineVariant}`,
  fontFamily: 'inherit',
  fontSize: 13,
  background: 'var(--bg-card)',
  maxWidth: '100%',
};
const dashedBtnStyle = {
  minHeight: TAP,
  minWidth: TAP,
  background: 'none',
  border: `1px dashed ${COLORS.outlineVariant}`,
  borderRadius: 8,
  padding: '3px 10px',
  color: COLORS.primary,
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
};
// Quiet on purpose: removing a treatment is a correction, not a headline
// action, so it must not compete with "+ Add treatment" for her thumb.
const quietRemoveStyle = {
  minHeight: TAP,
  minWidth: TAP,
  background: 'none',
  border: 'none',
  padding: '0 6px',
  color: COLORS.stone400,
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
  textDecoration: 'underline',
};
const quietBtnStyle = {
  minHeight: TAP,
  background: 'none',
  border: 'none',
  color: COLORS.stone400,
  fontSize: 12,
  cursor: 'pointer',
  fontFamily: 'inherit',
  padding: 0,
};
/** "Lash infill · £30 · 45m" for a picker option. */
function treatOptionLabel(t) {
  const price = t.price_cents ? ` · £${(t.price_cents / 100).toFixed(0)}` : '';
  const mins = t.duration_minutes ? ` · ${t.duration_minutes}m` : '';
  return `${t.name}${price}${mins}`;
}
export default function CalendarView({ initialView } = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { beautician, loading: bLoading } = useBeautician();
  const [view, setView] = useState(() => {
    // A ?view=day deep-link (month-day tap in the full calendar) opens the day
    // view straight away so Ellie can book into it.
    const v = new URLSearchParams(location.search).get('view');
    if (v === 'day') return 'day';
    return initialView === 'week' ? 'week' : 'day';
  });
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
    const params = new URLSearchParams(location.search);
    const q = params.get('date');
    if (q && /^\d{4}-\d{2}-\d{2}/.test(q)) setCurrentDate(new Date(`${q.slice(0, 10)}T12:00:00`));
    if (params.get('view') === 'day') setView('day');
  }, [location.search]);
  const [appointments, setAppointments] = useState([]);
  // Bookings per day for the visible week, keyed 'YYYY-MM-DD', for the strip's
  // density dots. `null` means the read failed, which is NOT the same as an
  // empty week: the strip then shows no dots at all rather than drawing seven
  // quiet days she would plan around.
  const [weekCounts, setWeekCounts] = useState(null);
  // Extra treatments are stored on the appointment as bare uuids, so the cards
  // and the week rows need a name for each one. Loaded once for the whole
  // page: it is a handful of rows and it never changes mid-session.
  const [treatNames, setTreatNames] = useState({});
  const [selectedAppointment, setSelectedAppointment] = useState(null);
  const [loading, setLoading] = useState(true);
  // A failed load used to leave the PREVIOUS week's rows in state. The render
  // filters by exact date, so none of them match the new week and it reads as
  // an empty diary rather than a failure. That is Ellie's "still not loading
  // after 5 mins": it had already given up, silently.
  const [loadError, setLoadError] = useState(null);
  const loadSeq = useRef(0);
  const detailRef = useRef(null);

  // Fail-soft: without the names the labels just read as the base treatment,
  // which is exactly how the diary looked before extras existed.
  useEffect(() => {
    if (!beautician?.id) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('treatments')
        .select('id, name')
        .eq('beautician_id', beautician.id);
      if (error || cancelled) return;
      setTreatNames(Object.fromEntries((data || []).map(t => [t.id, t.name])));
    })();
    return () => { cancelled = true; };
  }, [beautician?.id]);

  // The strip needs a count for all seven days, but day view only ever fetches
  // the one day it is showing. This is a separate, deliberately tiny query (two
  // columns, no joins) that runs alongside the main one, so the day's own
  // appointments still paint on the main fetch without waiting for the dots.
  // Keyed on the WEEK, not the day: tapping through days inside a week costs
  // nothing, which is what makes the strip feel still.
  const weekStartKey = formatDate(getWeekStart(currentDate));
  const weekEndKey = formatDate(getWeekEnd(currentDate));
  useEffect(() => {
    if (!beautician?.id) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('appointments')
        .select('starts_at, status')
        .eq('beautician_id', beautician.id)
        .gte('starts_at', `${weekStartKey}T00:00:00Z`)
        .lte('starts_at', `${weekEndKey}T23:59:59Z`);
      if (cancelled) return;
      // An unchecked select that comes back null renders as "nothing there",
      // and on a row of dots that is indistinguishable from a genuinely quiet
      // week. Say "unknown" and drop the dots instead of lying about her diary.
      if (error) {
        logger.error('Week counts error:', error);
        setWeekCounts(null);
        return;
      }
      const counts = {};
      for (const a of data || []) {
        if (DEAD_STATUSES.includes(a.status)) continue;   // a cancellation is not a booking
        const key = String(a.starts_at || '').slice(0, 10);   // stored wall date, never Intl-converted
        if (key) counts[key] = (counts[key] || 0) + 1;
      }
      setWeekCounts(counts);
    })();
    return () => { cancelled = true; };
  }, [beautician?.id, weekStartKey, weekEndKey]);

  // Deep-link to a specific appointment (?appt=<id>): once that day's
  // appointments have loaded, open its detail. The selection effect further
  // down scrolls it into view. Used by the "someone booked" push + home feed.
  useEffect(() => {
    const apptId = new URLSearchParams(location.search).get('appt');
    if (!apptId || !appointments.length) return;
    const match = appointments.find(a => a.id === apptId);
    if (match) {
      setView('day');
      setSelectedAppointment(match);
    }
  }, [appointments, location.search]);
  // Press-and-hold a row in the agenda to delete it (iOS style). The backend
  // blocks deletion when money is attached (409) and steers Ellie to cancel.
  const longPressTimer = useRef(null);
  const longPressFired = useRef(false);
  async function deleteAppointmentFromAgenda(appt) {
    const who = appt.clients?.first_name
      ? `${appt.clients.first_name}'s ${apptLabel(appt, treatNames) || 'appointment'}`
      : 'this appointment';
    if (!confirm(`Delete ${who}? This can't be undone.`)) return;
    try {
      const token = (await supabase.auth.getSession())?.data?.session?.access_token;
      const del = (force) => fetch(`${API_BASE}/api/appointments/${appt.id}${force ? '?force=true' : ''}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      let res = await del(false);
      if (res.status === 409) {
        const data = await res.json().catch(() => ({}));
        if (!data.requires_confirmation) {
          alert(data.error || "Could not delete this booking.");
          return;
        }
        if (!confirm(data.warning)) return;
        res = await del(true);
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
  // Manual appointment modal (plus button). Inbox's "Book her in" arrives
  // via location.state with the client pre-picked and the sheet open.
  const bookClient = location.state?.bookClient || null;
  const [showNewAppt, setShowNewAppt] = useState(!!bookClient);
  // Day grid scroll container + once-per-day auto-scroll tracking
  const gridScrollRef = useRef(null);
  // --- Drag-to-move (day view) ---------------------------------------------
  // Press and hold a card until it lifts (haptic cue), slide it up or down the
  // day, release to drop it on the new time, snapped to 5 minutes. The write
  // is the exact PATCH the Reschedule sheet uses, so the backend's
  // no-double-book guard keeps the final say: a 409 snaps the card back.
  const [dragMove, setDragMove] = useState(null); // { id, top, startMin, durMin }
  const dragRef = useRef(null);
  const dragClickGuard = useRef(false);
  useEffect(() => {
    // While a card is lifted, stop iOS turning finger movement into a page
    // scroll. Has to be a native passive:false listener; React's synthetic
    // onTouchMove cannot reliably preventDefault a touchmove.
    if (!dragMove) return;
    const stop = e => e.preventDefault();
    document.addEventListener('touchmove', stop, { passive: false });
    return () => document.removeEventListener('touchmove', stop);
  }, [dragMove]);
  function beginCardDrag(e, appt) {
    if (DEAD_STATUSES.includes(appt.status)) return; // a cancelled row has no time to move
    const target = e.currentTarget;
    const d = {
      appt, target, pid: e.pointerId,
      startX: e.clientX, startY: e.clientY,
      active: false, moved: false, lastStartMin: null, timer: null,
    };
    dragRef.current = d;
    d.timer = setTimeout(() => {
      if (dragRef.current !== d || d.moved) return;
      d.active = true;
      const startMin = wallMinutes(d.appt.starts_at);
      const endMin = d.appt.ends_at ? wallMinutes(d.appt.ends_at) : startMin + 30;
      d.origStartMin = startMin;
      d.durMin = Math.max(endMin - startMin, 15);
      d.lastStartMin = startMin;
      try { target.setPointerCapture(d.pid); } catch { /* older Safari: drag still works within the card */ }
      hapticTap(); // the "picked up" cue
      setDragMove({ id: d.appt.id, top: ((startMin - START_HOUR * 60) / 60) * HOUR_HEIGHT, startMin, durMin: d.durMin });
    }, 400);
  }
  function onCardDragMove(e) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.active) {
      // Finger wandered before the hold registered: that's a scroll, not a lift.
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) { d.moved = true; clearTimeout(d.timer); }
      return;
    }
    const snapped = Math.round((d.origStartMin + (dy / HOUR_HEIGHT) * 60) / 5) * 5;
    const clamped = Math.max(START_HOUR * 60, Math.min(snapped, END_HOUR * 60 - d.durMin));
    if (clamped === d.lastStartMin) return;
    d.lastStartMin = clamped;
    setDragMove({ id: d.appt.id, top: ((clamped - START_HOUR * 60) / 60) * HOUR_HEIGHT, startMin: clamped, durMin: d.durMin });
  }
  function onCardDragEnd() {
    const d = dragRef.current;
    if (!d) return;
    clearTimeout(d.timer);
    dragRef.current = null;
    if (!d.active) return; // never lifted: the click that follows opens the sheet as before
    try { d.target.releasePointerCapture(d.pid); } catch { /* fine */ }
    dragClickGuard.current = true; // swallow the click the browser fires after the drop
    setDragMove(null);
    if (d.lastStartMin == null || d.lastStartMin === d.origStartMin) return;
    commitDragMove(d.appt, d.lastStartMin, d.origStartMin);
  }
  function onCardDragCancel() {
    // Browser stole the gesture (incoming call, system swipe): snap back, no write.
    const d = dragRef.current;
    if (!d) return;
    clearTimeout(d.timer);
    dragRef.current = null;
    if (d.active) { try { d.target.releasePointerCapture(d.pid); } catch { /* fine */ } }
    setDragMove(null);
  }
  async function commitDragMove(appt, newStartMin, origStartMin) {
    const day = String(appt.starts_at || '').slice(0, 10);
    const startsAt = `${day}T${minToHHMM(newStartMin)}:00.000Z`; // wall time in the UTC slot, per convention
    // Optimistic: paint the card at its new time while the PATCH runs, so a
    // successful drop never visibly bounces. Restored wholesale on failure.
    const before = appointments;
    const delta = newStartMin - origStartMin;
    setAppointments(prev => prev.map(a => {
      if (a.id !== appt.id) return a;
      const endMin = a.ends_at ? wallMinutes(a.ends_at) + delta : null;
      return {
        ...a,
        starts_at: startsAt,
        ends_at: endMin != null && endMin > 0 && endMin < 24 * 60
          ? `${day}T${minToHHMM(endMin)}:00.000Z`
          : a.ends_at,
      };
    }));
    try {
      const token = (await supabase.auth.getSession())?.data?.session?.access_token;
      const res = await fetch(`${API_BASE}/api/appointments/${appt.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ starts_at: startsAt }),
      });
      if (res.status === 409) {
        setAppointments(before);
        alert('That time is taken. Pick another slot.');
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Could not move the appointment');
      }
      hapticSuccess();
      // Fold in the server's recomputed ends_at (treatment length + buffer).
      loadAppointments({ keepScroll: true });
    } catch (err) {
      logger.error('Drag move error:', err);
      setAppointments(before);
      alert(err.message || 'Could not move the appointment. Please try again.');
    }
  }
  // Two horizontal swipes live on this screen and the gesture has to match
  // whatever is under her thumb: sideways on the STRIP moves a week, sideways
  // on the DAY GRID moves a day. Both hold their start point here and use the
  // same intent test, so neither can be triggered by a vertical scroll.
  const stripSwipe = useRef(null);
  const gridSwipe = useRef(null);
  // A committed swipe still ends in a pointerup, which the browser can turn
  // into a click on whatever happens to be under the finger. These swallow
  // exactly one such click. Every fresh pointerdown clears them, so a guard
  // that was never spent cannot survive into a later, genuine tap.
  const stripSwipeGuard = useRef(false);
  const gridSwipeGuard = useRef(false);
  const lastScrollKey = useRef(null);
  useEffect(() => {
    if (beautician) {
      loadAppointments();
    } else if (!bLoading) {
      // useBeautician gave up (auth lock timeout / network blip) and leaves
      // beautician null forever. Without this, `loading` stays true from its
      // initial value and the spinner never ends.
      setLoading(false);
      setLoadError('Could not load your account.');
    }
  }, [beautician, bLoading, currentDate, view]); // eslint-disable-line react-hooks/exhaustive-deps
  // Time blocks are NOT date-scoped (the endpoint returns them all), so
  // refetching on every week swipe was pure waste against the rate limiter.
  useEffect(() => {
    if (beautician) loadTimeBlocks();
  }, [beautician]); // eslint-disable-line react-hooks/exhaustive-deps
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
    // Swiping weeks quickly fires overlapping fetches. Without this, an older
    // response landing last overwrites the newer range and blanks the week.
    const seq = ++loadSeq.current;
    setLoading(true);
    setLoadError(null);
    const from = view === 'day' ? formatDate(currentDate) : formatDate(getWeekStart(currentDate));
    const to = view === 'day' ? formatDate(currentDate) : formatDate(getWeekEnd(currentDate));
    // A hung request used to leave the spinner up indefinitely. Give up at 15s.
    const ac = new AbortController();
    const killer = setTimeout(() => ac.abort(), 15000);
    try {
      const { data, error } = await supabase
        .from('appointments')
        .select('*, clients(first_name, last_name), treatments(name, price_cents, color, sort_order)')
        .eq('beautician_id', beautician.id)
        .gte('starts_at', `${from}T00:00:00Z`)
        .lte('starts_at', `${to}T23:59:59Z`)
        .order('starts_at')
        .abortSignal(ac.signal);
      if (seq !== loadSeq.current) return;   // a newer range is already loading
      if (error) throw error;
      setAppointments(data || []);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      logger.error('Calendar load error:', err);
      // Never keep the previous range's rows: they are invisible to the date
      // filter, so the week silently reads as empty instead of as failed.
      setAppointments([]);
      setLoadError('Could not load this week.');
    } finally {
      clearTimeout(killer);
      if (seq === loadSeq.current) setLoading(false);
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
  /** Move the whole strip a week. The arrows meant "one day" in day view and
   *  "one week" in week view, which is one control with two meanings; days are
   *  now picked on the strip, so the arrows only ever do the one thing the
   *  strip cannot be tapped to do. */
  function navigateWeek(direction) {
    const newDate = new Date(currentDate);
    newDate.setDate(newDate.getDate() + direction * 7);
    setCurrentDate(newDate);
  }
  /** Move a day. Used by the swipe across the day grid. */
  function navigateDay(direction) {
    const newDate = new Date(currentDate);
    newDate.setDate(newDate.getDate() + direction);
    setCurrentDate(newDate);
  }
  function getAppointmentsForDate(date) {
    const dateStr = formatDate(date);
    return appointments.filter(a => a.starts_at?.startsWith(dateStr));
  }
  /**
   * Bookings on a day, for the strip's dots.
   *
   * Whatever range is already loaded into `appointments` is the authority: it
   * reflects a drag-to-move or a delete the instant it lands, where the week
   * count query would not refresh until she left the week. Anything outside
   * that range falls back to the counts. `null` means unknown, not zero, and
   * is why the caller draws nothing rather than an empty day.
   */
  function stripCountFor(day) {
    const key = formatDate(day);
    const loadedHere = view === 'week' || key === formatDate(currentDate);
    if (loadedHere && !loading) {
      return appointments.filter(a => a.starts_at?.startsWith(key) && !DEAD_STATUSES.includes(a.status)).length;
    }
    return weekCounts ? (weekCounts[key] || 0) : null;
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
  const gapsToday = countGapsToday();
  const waitlistMatches = countWaitlistMatches();
  const showInsightsPill = view === 'day' && (gapsToday > 0 || waitlistMatches > 0);
  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div style={styles.headerTop}>
          {/* Always a WEEK, in both views. Days are chosen on the strip below,
              so these are the only thing that has to stay a button: swiping is
              the fast way to move a week, and a swipe is no use on a desktop or
              to a keyboard. */}
          <button onClick={() => navigateWeek(-1)} aria-label="Previous week" style={styles.navBtn}>‹</button>
          <div style={styles.headerCenter}>
            <h1 style={styles.dateTitle}>
              {view === 'day'
                ? currentDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
                : `${getWeekStart(currentDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} - ${getWeekEnd(currentDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`}
            </h1>
            <button onClick={() => setCurrentDate(new Date())} style={styles.todayBtn}>Today</button>
          </div>
          <button onClick={() => navigateWeek(1)} aria-label="Next week" style={styles.navBtn}>›</button>
        </div>
      </div>

      {/*
        THE WEEK STRIP. It sits under the date in both views and it is the one
        thing on this screen that never moves: tapping a day changes only the
        schedule below it, so the week she is planning stays in front of her
        instead of being swapped out for it. Swipe it sideways to move a week.
      */}
      <div
        style={{ ...styles.weeklyStripContainer, touchAction: 'pan-y pinch-zoom' }}
        onPointerDown={e => {
          stripSwipeGuard.current = false;
          stripSwipe.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={e => {
          const dir = swipeDirection(stripSwipe.current, e.clientX, e.clientY);
          stripSwipe.current = null;
          if (!dir) return;
          // The finger lifts over a day button, so the browser is about to fire
          // a click on it. Swallow that one, or every week swipe would also
          // select whichever day it happened to land on.
          stripSwipeGuard.current = true;
          navigateWeek(dir);
        }}
        onPointerCancel={() => { stripSwipe.current = null; }}
        onClickCapture={e => {
          if (!stripSwipeGuard.current) return;
          stripSwipeGuard.current = false;
          e.stopPropagation();
          e.preventDefault();
        }}
      >
        <div style={styles.weeklyStrip}>
          {weekDays.map(day => {
            const selected = isSameDay(day, currentDate);
            const wh = beautician?.working_hours?.[DAY_KEYS[day.getDay()]];
            // Only call a day off once her hours have actually loaded, or every
            // day would look shut for the first frame.
            const dayOff = !!beautician?.working_hours && !(wh?.start && wh?.end);
            // A day off is dimmed and, being empty, draws no dots. It is not
            // FORCED to zero though: clients do get squeezed in on a Sunday and
            // hiding that booking would be the same silent lie as an unchecked
            // select rendering as an empty diary.
            const count = stripCountFor(day);
            const dayLabel = day.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
            const bookings = count == null ? 'bookings not loaded' : `${count} booking${count === 1 ? '' : 's'}`;
            const countLabel = dayOff ? (count ? `day off, ${bookings}` : 'day off') : bookings;
            return (
              <button
                key={day.toISOString()}
                onClick={() => { setCurrentDate(day); setView('day'); }}
                aria-current={selected ? 'date' : undefined}
                aria-label={`${dayLabel}, ${countLabel}`}
                style={{ ...styles.weeklyStripDay,
                  // Filled maroon chip follows the SELECTED day. Today, when it
                  // is not the selected one, only tints its text: a second
                  // strong marker would make her hunt for which one she is on.
                  background: selected ? COLORS.primary : 'transparent',
                  color: selected ? '#fff' : isToday(day) ? COLORS.primary : COLORS.onSurface,
                  boxShadow: selected ? '0 4px 10px rgba(146, 64, 94, 0.15)' : 'none',
                  // A day she does not work is still tappable (clients do turn
                  // up on a Sunday) but it recedes.
                  opacity: dayOff && !selected ? 0.38 : 1,
                }}
              >
                <span style={styles.weeklyStripDayName}>{day.toLocaleDateString('en-GB', { weekday: 'narrow' })}</span>
                <span style={styles.weeklyStripDayNumber}>{day.getDate()}</span>
                {/* Density, not data. Capped, never a number: she reads busy or
                    quiet off this in a glance and taps the day for the detail.
                    Fixed height so the row does not jump as the counts land. */}
                <span style={styles.weeklyStripDots} aria-hidden="true">
                  {!count ? null : Array.from({ length: Math.min(count, STRIP_MAX_DOTS) }, (_, i) => (
                    <span
                      key={i}
                      style={{ ...styles.weeklyStripDot, background: selected ? 'rgba(255, 255, 255, 0.85)' : COLORS.primary }}
                    />
                  ))}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', marginBottom: 14 }}>
        {/* ONE view control, rendered whether this is embedded on the Hub or
            routed on its own, so the screen does not change shape depending on
            how she got here. The "back to Calendar" button that used to appear
            only in the embedded case is gone: with the strip on screen, day
            view is not somewhere she needs a way out of. */}
        <div style={styles.viewToggle} role="group" aria-label="Calendar view">
          <button onClick={() => setView('day')} aria-pressed={view === 'day'} style={{ ...styles.toggleBtn, background: view === 'day' ? COLORS.primary : 'transparent', color: view === 'day' ? '#fff' : COLORS.stone400 }}>Day</button>
          <button onClick={() => setView('week')} aria-pressed={view === 'week'} style={{ ...styles.toggleBtn, background: view === 'week' ? COLORS.primary : 'transparent', color: view === 'week' ? '#fff' : COLORS.stone400 }}>Week</button>
        </div>
        <button
          onClick={() => navigate('/calendar/full')}
          title="Open full calendar"
          aria-label="Open full calendar"
          style={{ height: 36, width: 36, borderRadius: 10, border: `1px solid ${COLORS.outlineVariant}`, background: 'var(--card-bg, #fff)', color: COLORS.stone400, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
        >
          <Icon name={iconName('open_in_full')} size={18} inline style={{ }} />
        </button>
        <button
          onClick={() => setShowBlockModal(true)}
          title="Block time"
          style={{ height: 36, padding: '0 12px', borderRadius: 10, border: `1px solid ${COLORS.outlineVariant}`, background: 'var(--card-bg, #fff)', color: COLORS.stone400, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, flexShrink: 0, fontSize: 12, fontWeight: 600, fontFamily: 'inherit' }}
        >
          <Icon name={iconName('event_busy')} size={15} inline style={{ }} />
          Block
        </button>
        {view === 'day' && (
          <button
            onClick={handleMarkAllDone}
            disabled={markingAllDone}
            title="Mark all done"
            style={{ height: 36, padding: '0 12px', borderRadius: 10, border: `1px solid ${COLORS.outlineVariant}`, background: 'var(--card-bg, #fff)', color: '#5BA67F', cursor: markingAllDone ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, flexShrink: 0, fontSize: 12, fontWeight: 600, fontFamily: 'inherit', opacity: markingAllDone ? 0.6 : 1 }}
          >
            <Icon name={iconName('done_all')} size={15} inline style={{ }} />
            {markingAllDone ? '…' : 'All done'}
          </button>
        )}
      </div>
      {/* Day View with Timeline Grid */}
      {view === 'day' && (
        <div
          ref={gridScrollRef}
          // pan-y leaves the vertical scroll to the browser and hands us the
          // sideways movement, which is what makes a horizontal swipe here
          // possible at all without fighting the diary's own scrolling.
          style={{ ...styles.dayGrid, touchAction: 'pan-y pinch-zoom' }}
          onPointerDown={e => {
            gridSwipeGuard.current = false;
            gridSwipe.current = { x: e.clientX, y: e.clientY };
          }}
          onPointerMove={() => {
            // She is moving an appointment, not the day: stand down. The two
            // cannot both fire anyway (beginCardDrag drops the lift the moment
            // the finger travels 8px, long before 56px counts as a swipe) but a
            // lift that was already active before this gesture must not have
            // the day change out from under it.
            if (dragRef.current?.active) gridSwipe.current = null;
          }}
          onPointerUp={e => {
            const dir = swipeDirection(gridSwipe.current, e.clientX, e.clientY);
            gridSwipe.current = null;
            if (!dir) return;
            gridSwipeGuard.current = true;
            navigateDay(dir);
          }}
          onPointerCancel={() => { gridSwipe.current = null; }}
          onClickCapture={e => {
            // The pointerup that ended the swipe can still become a click on a
            // card or a block chip. Swallow exactly one, here at the top, so no
            // individual card has to know that swiping exists.
            if (!gridSwipeGuard.current) return;
            gridSwipeGuard.current = false;
            e.stopPropagation();
            e.preventDefault();
          }}
        >
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
              const wh = beautician?.working_hours?.[DAY_KEYS[currentDate.getDay()]];
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
              const tiny = height < 50 && cols === 1;   // e.g. a 10-min patch test
              const compact = tiny || cols > 1 || height < 72;
              const showTreatment = height >= 60 && cols < 3;
              const showMeta = cols < 3 && !tiny;   // time is inlined with the name when tiny
              const lifted = dragMove?.id === appt.id;
              return (
                <button
                  key={appt.id}
                  onClick={() => {
                    // A drop fires a click too; that click must not toggle the sheet.
                    if (dragClickGuard.current) { dragClickGuard.current = false; return; }
                    setSelectedAppointment(selectedAppointment?.id === appt.id ? null : appt);
                  }}
                  onPointerDown={e => beginCardDrag(e, appt)}
                  onPointerMove={onCardDragMove}
                  onPointerUp={onCardDragEnd}
                  onPointerCancel={onCardDragCancel}
                  style={{ ...styles.appointmentCard,
                    top: lifted ? dragMove.top : top,
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
                    // Kill the iOS long-press magnifier/text-selection so the
                    // press-and-hold reads as "pick the card up", nothing else.
                    WebkitUserSelect: 'none', userSelect: 'none', WebkitTouchCallout: 'none',
                    ...(lifted ? { zIndex: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.25)', opacity: 0.95, transform: 'scale(1.02)' } : {}),
                  }}
                >
                  {/* Paid in full must be visible WITHOUT opening the sheet:
                      Ellie plans her day off this grid, and knowing the money
                      is already banked changes how she treats a no-show. Green
                      because this is a settled STATE, not a brand accent. On
                      tiny cards a labelled chip cannot fit, so it becomes a
                      dot in the same green. */}
                  {appt.payment_type === 'full' && (
                    tiny
                      ? <span title="Paid in full" style={{ position: 'absolute', top: 3, right: 3, width: 8, height: 8, borderRadius: '50%', background: '#2E7D32' }} />
                      : <span style={{ position: 'absolute', top: 3, right: 4, background: '#2E7D32', color: '#fff', fontSize: 8, fontWeight: 700, letterSpacing: '0.04em', padding: '1px 5px', borderRadius: 6 }}>PAID</span>
                  )}
                  <div style={styles.appointmentCardContent}>
                    <div style={styles.appointmentCardHeader}>
                      <div style={{ ...styles.appointmentAvatar, background: statusColor, ...(compact ? { width: 22, height: 22, fontSize: 8 } : {}) }}>
                        {clientInitials}
                      </div>
                      <div style={styles.appointmentCardTextBlock}>
                        <div style={{ ...styles.appointmentCardClientName, ...(compact ? { fontSize: 12 } : {}), ...(dead ? { textDecoration: 'line-through' } : {}) }}>{appt.clients?.first_name} {appt.clients?.last_name || ''}</div>
                        {showTreatment && (
                          <div style={styles.appointmentCardTreatment}>{apptLabel(appt, treatNames)}</div>
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
            {/* While a card is lifted: the time it will land on, live */}
            {dragMove && (
              <div style={{ position: 'absolute', top: Math.max(0, dragMove.top - 26), right: 8, zIndex: 11, background: COLORS.primary, color: '#fff', borderRadius: 8, padding: '3px 9px', fontSize: 12, fontWeight: 700, pointerEvents: 'none', fontVariantNumeric: 'tabular-nums' }}>
                {minToHHMM(dragMove.startMin)} to {minToHHMM(dragMove.startMin + dragMove.durMin)}
              </div>
            )}
            {/* Time block overlays */}
            {timeBlocks
              .filter(b => b.date === formatDate(currentDate))
              .map(block => {
                let top = 0, height = (END_HOUR - START_HOUR) * HOUR_HEIGHT;
                const isClosed = block.type ? block.type === 'closed' : !!block.is_closed;
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
                // The block used to be one big full-width button at zIndex 3, so it
                // sat ON TOP of any appointment inside it and ate the taps: you
                // could not open a booking that fell in a blocked hour. It is now
                // a see-through backdrop (no pointer events, behind the cards) and
                // only the little label chip is tappable.
                return (
                  <div
                    key={block.id}
                    style={{ position: 'absolute', left: 0, right: 0,
                      top: Math.max(0, top),
                      height: Math.max(height, 36),
                      background: 'repeating-linear-gradient(45deg, rgba(146,64,94,0.07) 0px, rgba(146,64,94,0.07) 5px, rgba(146,64,94,0.02) 5px, rgba(146,64,94,0.02) 10px)',
                      borderLeft: '3px solid rgba(146,64,94,0.5)',
                      borderRadius: 4,
                      zIndex: 1,
                      pointerEvents: 'none',
                    }}
                  >
                    <button
                      onClick={() => setSelectedBlock(block)}
                      style={{ pointerEvents: 'auto',
                        position: 'absolute', top: 4, left: 8,
                        background: 'rgba(255,255,255,0.9)',
                        border: 'none', borderRadius: 6,
                        padding: '3px 7px',
                        fontSize: 11, fontWeight: 700, color: COLORS.primary,
                        letterSpacing: '0.04em', cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      {label}
                    </button>
                  </div>
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
                  style={{ ...styles.openSlotCard,
                    top: slot.top,
                    height: slot.height,
                  }}
                >
                  <span style={styles.openSlotText}>OPEN SLOT</span>
                </div>
              ));
            })()}
            {loading && (
              <div style={{ position: 'absolute', top: (8 - START_HOUR) * HOUR_HEIGHT + 60, left: 0, right: 0, textAlign: 'center' }}>
                <div style={{ width: 26, height: 26, margin: '0 auto 10px', border: `3px solid ${COLORS.outlineVariant}`, borderTopColor: COLORS.primary, borderRadius: '50%', animation: 'floSpin 0.8s linear infinite' }} />
                <p style={{ fontSize: 13, color: COLORS.stone400 }}>Loading…</p>
                <style>{'@keyframes floSpin{to{transform:rotate(360deg)}}'}</style>
              </div>
            )}
            {!loading && loadError && (
              <div style={{ position: 'absolute', top: (8 - START_HOUR) * HOUR_HEIGHT + 60, left: 0, right: 0, textAlign: 'center', padding: '0 16px' }}>
                <button
                  onClick={() => loadAppointments()}
                  style={{ padding: '12px 18px', borderRadius: 12, border: `1px solid ${COLORS.outlineVariant}`, background: 'var(--bg-card)', color: COLORS.primary, fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }}
                >
                  {loadError} Tap to try again.
                </button>
              </div>
            )}
            {!loading && !loadError && getAppointmentsForDate(currentDate).length === 0 && (
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
          {/* The week view had NO loading and NO error state, so a failed or
              slow fetch rendered a full seven-day "no bookings" skeleton and
              looked exactly like an empty diary. */}
          {loading && (
            <div style={{ padding: '28px 0', textAlign: 'center' }}>
              <div style={{ width: 26, height: 26, margin: '0 auto 10px', border: `3px solid ${COLORS.outlineVariant}`, borderTopColor: COLORS.primary, borderRadius: '50%', animation: 'floSpin 0.8s linear infinite' }} />
              <p style={{ fontSize: 13, color: COLORS.stone400 }}>Loading…</p>
              <style>{'@keyframes floSpin{to{transform:rotate(360deg)}}'}</style>
            </div>
          )}
          {!loading && loadError && (
            <button
              onClick={() => loadAppointments()}
              style={{ width: '100%', padding: '18px 0', borderRadius: 16, border: `1px solid ${COLORS.outlineVariant}`, background: 'var(--bg-card)', color: COLORS.primary, fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }}
            >
              {loadError} Tap to try again.
            </button>
          )}
          {!loading && !loadError && weekDays.map(day => {
            const dayAppts = getAppointmentsForDate(day)
              .slice()
              .sort((a, b) => wallMinutes(a.starts_at) - wallMinutes(b.starts_at));
            const live = dayAppts.filter(a => !DEAD_STATUSES.includes(a.status));
            const takingsPence = live.reduce((s, a) => s + (a.price_cents || a.treatments?.price_cents || 0), 0);
            const workedMins = live.reduce((s, a) => s + Math.max(0, wallMinutes(a.ends_at || a.starts_at) - wallMinutes(a.starts_at)), 0);
            const hours = workedMins / 60;
            const wh = beautician?.working_hours?.[DAY_KEYS[day.getDay()]];
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
                            {apptLabel(appt, treatNames) && <span style={styles.weekRowTreatment}>{apptLabel(appt, treatNames)}</span>}
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
          <Icon name={iconName('add')} size={26} inline />
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
          initialClient={bookClient}
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
  const [noShowFeeInfo, setNoShowFeeInfo] = useState(null); // { can_charge, amount_cents, reason }
  const [paymentLinkUrl, setPaymentLinkUrl] = useState(null);
  const [linkLoading, setLinkLoading] = useState(false);
  const [manageLink, setManageLink] = useState(null);
  // Does this client still owe a patch test? Drives the whole card's wording.
  const [needsPatchTest, setNeedsPatchTest] = useState(false);
  const [manageBusy, setManageBusy] = useState(false);
  const [manageSent, setManageSent] = useState(false);
  const [manageCopied, setManageCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = (await supabase.auth.getSession())?.data?.session?.access_token;
        const res = await fetch(`${API_BASE}/api/appointments/${appointment.id}/manage-link`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return;
        const d = await res.json();
        if (!cancelled) setNeedsPatchTest(!!d.needs_patch_test);
      } catch { /* the card just stays generic */ }
    })();
    return () => { cancelled = true; };
  }, [appointment.id]);

  async function handleGetManageLink() {
    setManageBusy(true); setManageSent(false);
    try {
      const token = (await supabase.auth.getSession())?.data?.session?.access_token;
      const res = await fetch(`${API_BASE}/api/appointments/${appointment.id}/manage-link`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.url) {
        setManageLink(data.url);
        try { await navigator.clipboard?.writeText?.(data.url); setManageCopied(true); setTimeout(() => setManageCopied(false), 2000); } catch { /* clipboard blocked; the box below is tap-to-copy */ }
      } else { alert(data.error || 'Could not get the booking link'); }
    } catch { alert('Could not get the booking link'); }
    finally { setManageBusy(false); }
  }

  async function handleSendManageLink() {
    setManageBusy(true);
    try {
      const token = (await supabase.auth.getSession())?.data?.session?.access_token;
      const res = await fetch(`${API_BASE}/api/appointments/${appointment.id}/send-manage-link`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        // Say what actually happened, on which channel. A silent tick told her
        // nothing about whether it really left.
        setManageSent(d.channel === 'sms' ? 'Sent by text' : 'Sent on WhatsApp');
        setTimeout(() => setManageSent(false), 3000);
      } else {
        alert(d.error || 'Could not send the link');
      }
    } catch { alert('Could not send the link'); }
    finally { setManageBusy(false); }
  }
  const [chargingBalance, setChargingBalance] = useState(false);
  // Charge any amount to the client's saved card. Ellie types the amount and
  // confirms; nothing is ever taken automatically.
  const [cardInfo, setCardInfo] = useState(null);      // { hasCard, brand, last4, reason }
  const [chargeOpen, setChargeOpen] = useState(false);
  const [chargeAmount, setChargeAmount] = useState('');
  const [chargeReason, setChargeReason] = useState('');
  const [chargingCard, setChargingCard] = useState(false);
  useEffect(() => {
    let off = false;
    (async () => {
      try {
        const token = (await supabase.auth.getSession())?.data?.session?.access_token;
        const res = await fetch(`${API_BASE}/api/appointments/${appointment.id}/card`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return;
        const d = await res.json();
        if (!off) setCardInfo(d);
      } catch { /* leave it unknown */ }
    })();
    return () => { off = true; };
  }, [appointment.id]);
  // No card on file: get a link the client can use to add one WITHOUT being
  // charged. This is what makes no-show protection possible on the bookings
  // Ellie adds herself, which never went through the online deposit.
  const [cardLinkBusy, setCardLinkBusy] = useState(false);
  const [cardLink, setCardLink] = useState(null);
  async function handleGetCardLink() {
    setCardLinkBusy(true);
    try {
      const token = (await supabase.auth.getSession())?.data?.session?.access_token;
      const res = await fetch(`${API_BASE}/api/stripe/save-card-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ appointment_id: appointment.id }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Could not create the card link');
      setCardLink(d.url);
      try { await navigator.clipboard?.writeText?.(d.url); } catch { /* they can still copy it */ }
      hapticSuccess();
    } catch (err) {
      alert(err.message || 'Could not create the card link');
    } finally {
      setCardLinkBusy(false);
    }
  }
  async function handleChargeCard() {
    const pounds = parseFloat(String(chargeAmount).replace(/[£,\s]/g, ''));
    if (isNaN(pounds) || pounds <= 0) { alert('Enter an amount to charge.'); return; }
    const cents = Math.round(pounds * 100);
    const who = appointment.clients?.first_name || 'this client';
    if (!confirm(`Charge £${pounds.toFixed(2)} to ${who}'s saved card${cardInfo?.last4 ? ` ending ${cardInfo.last4}` : ''}?\n\nThis takes the money straight away.`)) return;
    setChargingCard(true);
    try {
      const token = (await supabase.auth.getSession())?.data?.session?.access_token;
      const res = await fetch(`${API_BASE}/api/appointments/${appointment.id}/charge-card`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ amount_cents: cents, reason: chargeReason || 'Charge' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not charge the card');
      hapticSuccess();
      alert(`Charged £${((data.amountCents || cents) / 100).toFixed(2)}.`);
      setChargeOpen(false); setChargeAmount(''); setChargeReason('');
      onUpdate && onUpdate();
    } catch (err) {
      alert(err.message || 'Could not charge the card');
    } finally {
      setChargingCard(false);
    }
  }
  const [noteSaved, setNoteSaved] = useState(false);
  const [rebookSaving, setRebookSaving] = useState(false);
  const [rebookSent, setRebookSent] = useState(false);
  // Inline price set for bookings imported with no price (£0).
  const [priceEditing, setPriceEditing] = useState(false);
  const [priceInput, setPriceInput] = useState('');
  const [priceSaving, setPriceSaving] = useState(false);
  // Change the treatment on a booking (e.g. lamination -> maintenance). Length
  // + price follow the new treatment; there was no way to do this before.
  const [treatEditing, setTreatEditing] = useState(false);
  const [treatList, setTreatList] = useState([]);
  const [treatSaving, setTreatSaving] = useState(false);
  // "Add treatment" is a second picker on the same row. Kept separate from
  // treatEditing so opening one closes the other and she is never looking at
  // two dropdowns wondering which does what.
  const [addingTreat, setAddingTreat] = useState(false);
  // Set when the query itself failed. Without it an empty picker is
  // indistinguishable from "you have no treatments", which is what this bug
  // looked like from the salon floor.
  const [treatLoadFailed, setTreatLoadFailed] = useState(false);
  async function loadTreatList() {
    if (treatList.length > 0) return treatList;
    // No `hidden` in this select: the treatments table has never had that
    // column. PostgREST rejects the entire select when one column is unknown,
    // so data came back null and both pickers rendered empty on an account
    // with a full price list.
    //
    // The filter is is_active only, deliberately. `booking_enabled` is the
    // real column that means hidden, but it means hidden from the PUBLIC
    // booking page. A treatment she does not sell online is still one she can
    // add to a client sitting in front of her, so it belongs in this list.
    const { data, error } = await supabase
      .from('treatments')
      .select('id, name, duration_minutes, price_cents, is_active')
      .eq('beautician_id', beautician.id)
      .order('sort_order', { ascending: true });
    if (error) {
      console.error('Could not load treatments', error);
      setTreatLoadFailed(true);
      return [];
    }
    setTreatLoadFailed(false);
    const list = (data || []).filter(t => t.is_active !== false);
    setTreatList(list);
    return list;
  }
  // One line, shown wherever a picker would otherwise be silently empty.
  const treatLoadNotice = treatLoadFailed ? (
    <span style={{ fontSize: 12, color: '#B4453F', fontFamily: 'inherit', textAlign: 'right' }}>
      Could not load your treatments just now. Close this and open it again.
    </span>
  ) : null;
  // Loaded as soon as the sheet opens, not on first tap: the extras are stored
  // as bare uuids, so without this the list would show "+ 1 more" style
  // nonsense until she happened to open a picker.
  useEffect(() => { loadTreatList(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [beautician?.id]);
  const treatById = Object.fromEntries(treatList.map(t => [t.id, t]));
  const extraIds = Array.isArray(appointment.extra_treatment_ids) ? appointment.extra_treatment_ids : [];
  // The base line. A patch test has no treatment_id, so it is named from the
  // note we stamp on it, and that line has no remove control: taking the patch
  // test off a patch test would leave an appointment for nothing.
  const baseTreatName = baseLabel(appointment);
  async function handleChangeTreatment(treatmentId) {
    setTreatSaving(true);
    try {
      const token = (await supabase.auth.getSession())?.data?.session?.access_token;
      const res = await fetch(`${API_BASE}/api/appointments/${appointment.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ treatment_id: treatmentId }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) { alert('That change clashes with another booking. Move the time first.'); return; }
      if (!res.ok) throw new Error(data.error || 'Could not change the treatment');
      hapticSuccess();
      setTreatEditing(false);
      onUpdate();
    } catch (err) {
      alert(err.message || 'Could not change the treatment');
    } finally {
      setTreatSaving(false);
    }
  }
  // Add or remove extra treatments. The backend recomputes length, price and
  // the finish time from the whole set, so the answer comes back in the
  // response and the sheet redraws from that rather than guessing.
  //
  // Ellie: "add additional treatments to a client... and then the time change
  // auto also." The Time row below reads straight off appointment.ends_at, so
  // folding the response back in is what makes the new finish time appear
  // without her doing the sums.
  async function handleSetExtras(nextIds, { label } = {}) {
    setTreatSaving(true);
    try {
      const token = (await supabase.auth.getSession())?.data?.session?.access_token;
      const res = await fetch(`${API_BASE}/api/appointments/${appointment.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ extra_treatment_ids: nextIds }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        // Nothing was written. Say what happened and leave the booking alone.
        alert(data.error || 'That runs into the next booking. Move the time first, or take something off.');
        return;
      }
      if (!res.ok) throw new Error(data.error || (label ? `Could not add ${label}` : 'Could not update the treatments'));
      hapticSuccess();
      setAddingTreat(false);
      const updated = data.appointment || data;
      // Fold the recomputed row into the open panel so the Time, Duration and
      // Price rows all move together, in place, with the sheet still open.
      if (onRefresh) {
        onRefresh({
          extra_treatment_ids: Array.isArray(updated.extra_treatment_ids) ? updated.extra_treatment_ids : [],
          ...(updated.ends_at ? { ends_at: updated.ends_at } : {}),
          ...(updated.duration_minutes != null ? { duration_minutes: updated.duration_minutes } : {}),
          ...(updated.price_cents != null ? { price_cents: updated.price_cents } : {}),
        });
      } else {
        onUpdate();
      }
    } catch (err) {
      alert(err.message || 'Could not update the treatments');
    } finally {
      setTreatSaving(false);
    }
  }
  // Shorten (or lengthen) the booking. 15-minute steps from 15 min to 8 h;
  // the backend recomputes ends_at in the wall frame and rejects with 409 if
  // a longer slot would run into another booking.
  const [durEditing, setDurEditing] = useState(false);
  const [durSaving, setDurSaving] = useState(false);
  async function handleChangeDuration(minutes) {
    setDurSaving(true);
    try {
      const token = (await supabase.auth.getSession())?.data?.session?.access_token;
      const res = await fetch(`${API_BASE}/api/appointments/${appointment.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ duration_minutes: Number(minutes) }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) { alert(data.error || 'That length runs into the next booking. Move the time first.'); return; }
      if (!res.ok) throw new Error(data.error || 'Could not change the length');
      hapticSuccess();
      setDurEditing(false);
      onUpdate();
    } catch (err) {
      alert(err.message || 'Could not change the length');
    } finally {
      setDurSaving(false);
    }
  }
  // The consultation form for this client, plus whether anything booked today
  // requires one. This is the screen she has open with the client in front of
  // her, so a flagged allergy has to be readable here, not two taps away in a
  // profile she would have to leave the calendar to reach.
  //
  // One call: the endpoint is beautician-scoped and takes only the appointment
  // id, so no answer ever travels in a query string. Fail-soft, and silence
  // means silence: a failed call renders nothing rather than implying that
  // there is no form and nothing to worry about.
  const [consultation, setConsultation] = useState(null);
  const [consultOpen, setConsultOpen] = useState(false);
  const [consultSending, setConsultSending] = useState(false);
  const [consultSendResult, setConsultSendResult] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setConsultation(null);
    setConsultOpen(false);
    (async () => {
      try {
        const token = (await supabase.auth.getSession())?.data?.session?.access_token;
        const res = await fetch(`${API_BASE}/api/consultation-forms/for-appointment/${appointment.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const d = await res.json();
        if (!cancelled) setConsultation(d);
      } catch { /* the consultation panel just does not appear */ }
    })();
    return () => { cancelled = true; };
  }, [appointment.id]);

  async function handleSendConsultationForm() {
    setConsultSending(true);
    setConsultSendResult(null);
    try {
      const token = (await supabase.auth.getSession())?.data?.session?.access_token;
      const res = await fetch(`${API_BASE}/api/consultation-forms/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ client_id: appointment.client_id, appointment_id: appointment.id }),
      });
      const body = await res.json().catch(() => ({}));
      setConsultSendResult(res.ok ? 'Sent. They get a text with the link.' : (body.error || 'Could not send it just now.'));
    } catch {
      setConsultSendResult('Could not send it just now.');
    } finally {
      setConsultSending(false);
    }
  }

  // Anything this client still owes from previous visits (unpaid no-show or
  // late-cancel fee, or an unsettled remainder). Shown as a line on the sheet
  // so Ellie knows before they arrive. Fail-soft: any error hides the line.
  const [owesCents, setOwesCents] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setOwesCents(0);
    if (!appointment.client_id) return undefined;
    (async () => {
      try {
        const token = (await supabase.auth.getSession())?.data?.session?.access_token;
        const res = await fetch(`${API_BASE}/api/clients/${appointment.client_id}/outstanding-balance`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const d = await res.json();
        if (!cancelled) setOwesCents(d.owes_cents || 0);
      } catch { /* the line just stays hidden */ }
    })();
    return () => { cancelled = true; };
  }, [appointment.client_id]);
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
      const del = (force) => fetch(`${API_BASE}/api/appointments/${appointment.id}${force ? '?force=true' : ''}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });

      let res = await del(false);
      if (res.status === 409) {
        // Money on the booking. It is her diary: warn properly, then let her
        // through if she still wants it gone (it used to be a dead end).
        const data = await res.json().catch(() => ({}));
        if (!data.requires_confirmation) {
          alert(data.error || 'Could not delete this booking.');
          return;
        }
        if (!confirm(data.warning)) return;
        res = await del(true);
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
      // One-tap: show the fee prompt. If she can't charge (usually no card on
      // file because deposits are off) we still surface WHY, so it isn't silent.
      setNoShowFeeInfo(data.no_show_fee || null);
      if (data.no_show_fee && (data.no_show_fee.can_charge || data.no_show_fee.reason === 'no_card')) {
        setNoShowCharging(true);
        return; // keep the sheet open so she can act on the prompt
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
      // A pay-in-full booking owes nothing; the old fallback here would have
      // sent a paid client a link for the FULL price again.
      if (appointment.payment_type === 'full') {
        alert('This booking was paid in full at booking. There is nothing to request.');
        setLinkLoading(false);
        return;
      }
      const remaining = appointment.price_cents - (appointment.deposit_paid ? (appointment.deposit_cents || 0) : 0);
      if (remaining <= 0) {
        alert('There is no balance left to request.');
        setLinkLoading(false);
        return;
      }
      const amount = remaining;
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
    if (appointment.payment_type === 'full') { alert('This booking was paid in full at booking.'); return; }
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
    // Completion goes through the backend PATCH so takings are logged
    // server-side (service role, idempotent). The old direct transactions
    // insert could fail silently client-side, leaving appointments completed
    // with NO income row - Money read £0 for the day.
    const token = (await supabase.auth.getSession()).data.session?.access_token;
    const res = await fetch(`${API_BASE}/api/appointments/${appointment.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ status: 'completed', beautician_notes: notes || null }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || 'Could not mark complete');
    }
    // How she took payment, remembered on the appointment record. Purely
    // informational; takings are already logged by the server.
    updateRow('appointments', appointment.id, { payment_method: method, completed_at: new Date().toISOString() }).catch(() => {});
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
      const reminderDate = formatDate(d); // local date, avoids the BST day-shift
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
            {/* The treatments ON this booking, not just the one it was booked
                as. A patch test sits at the top with no remove control (there
                would be no appointment left), and every extra she has added
                gets its own line she can take back off. */}
            <div style={{ ...styles.detailRow, alignItems: 'flex-start' }}>
              <span style={styles.detailLabel}>{extraIds.length > 0 ? 'Treatments' : 'Treatment'}</span>
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, maxWidth: '72%' }}>
                {treatEditing ? (
                  <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, maxWidth: '100%' }}>
                    <select
                      defaultValue={appointment.treatment_id || ''}
                      onChange={e => e.target.value && handleChangeTreatment(e.target.value)}
                      disabled={treatSaving}
                      style={treatSelectStyle}
                    >
                      <option value="" disabled>Choose a treatment...</option>
                      {treatList.map(t => (
                        <option key={t.id} value={t.id}>{treatOptionLabel(t)}</option>
                      ))}
                    </select>
                    {treatLoadNotice}
                    <button onClick={() => setTreatEditing(false)} style={quietBtnStyle}>Cancel</button>
                  </span>
                ) : (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={styles.detailValue}>{baseTreatName || 'Not set'}</span>
                    <button
                      onClick={() => { setAddingTreat(false); setTreatEditing(true); loadTreatList(); }}
                      style={dashedBtnStyle}
                    >
                      Change
                    </button>
                  </span>
                )}

                {extraIds.map((id, i) => (
                  <span key={`${id}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={styles.detailValue}>{treatById[id]?.name || 'Treatment'}</span>
                    <button
                      onClick={() => handleSetExtras(extraIds.filter((_, j) => j !== i))}
                      disabled={treatSaving}
                      aria-label={`Remove ${treatById[id]?.name || 'this treatment'}`}
                      style={quietRemoveStyle}
                    >
                      Remove
                    </button>
                  </span>
                ))}

                {addingTreat ? (
                  <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, maxWidth: '100%' }}>
                    <select
                      defaultValue=""
                      onChange={e => e.target.value && handleSetExtras([...extraIds, e.target.value], { label: treatById[e.target.value]?.name })}
                      disabled={treatSaving}
                      style={treatSelectStyle}
                    >
                      <option value="" disabled>Add a treatment...</option>
                      {treatList.map(t => (
                        <option key={t.id} value={t.id}>{treatOptionLabel(t)}</option>
                      ))}
                    </select>
                    {treatLoadNotice}
                    <button onClick={() => setAddingTreat(false)} style={quietBtnStyle}>Cancel</button>
                  </span>
                ) : (
                  <button
                    onClick={() => { setTreatEditing(false); setAddingTreat(true); loadTreatList(); }}
                    disabled={treatSaving}
                    style={dashedBtnStyle}
                  >
                    {treatSaving ? 'Saving...' : '+ Add treatment'}
                  </button>
                )}

                {/* The whole point of the feature: she should never have to
                    work out the new length or the new finish time herself. */}
                {extraIds.length > 0 && (
                  <span style={{ fontSize: 12, color: COLORS.stone400, fontFamily: 'inherit', textAlign: 'right' }}>
                    {appointment.duration_minutes ? durationLabel(appointment.duration_minutes) : ''}
                    {appointment.duration_minutes ? ', ' : ''}
                    £{(((appointment.price_cents ?? appointment.treatments?.price_cents) || 0) / 100).toFixed(2)}
                    {appointment.ends_at ? ` · ends ${formatWallTime(appointment.ends_at)}` : ''}
                  </span>
                )}
              </span>
            </div>
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
              <span style={styles.detailLabel}>Duration</span>
              {durEditing ? (
                <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, maxWidth: '70%' }}>
                  <select
                    defaultValue={appointment.duration_minutes || ''}
                    onChange={e => e.target.value && handleChangeDuration(e.target.value)}
                    disabled={durSaving}
                    style={{ padding: '8px 10px', borderRadius: 8, border: `1px solid ${COLORS.outlineVariant}`, fontFamily: 'inherit', fontSize: 13, background: 'var(--bg-card)', maxWidth: '100%' }}
                  >
                    <option value="" disabled>Choose a length...</option>
                    {/* Keep an off-step current length selectable so the menu never lies about what is set */}
                    {appointment.duration_minutes > 0 && appointment.duration_minutes % 15 !== 0 && (
                      <option value={appointment.duration_minutes}>{durationLabel(appointment.duration_minutes)} (current)</option>
                    )}
                    {DURATION_STEPS.map(m => (
                      <option key={m} value={m}>{durationLabel(m)}</option>
                    ))}
                  </select>
                  <button onClick={() => setDurEditing(false)} style={{ background: 'none', border: 'none', color: COLORS.stone400, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}>Cancel</button>
                </span>
              ) : (
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={styles.detailValue}>{appointment.duration_minutes ? durationLabel(appointment.duration_minutes) : 'Not set'}</span>
                  <button onClick={() => setDurEditing(true)} style={{ background: 'none', border: `1px dashed ${COLORS.outlineVariant}`, borderRadius: 8, padding: '3px 8px', color: COLORS.primary, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>Change</button>
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
            {owesCents > 0 && (
              <div style={styles.detailRow}>
                <span style={styles.detailLabel}>Outstanding balance</span>
                <span style={{ ...styles.detailValue, color: 'var(--accent, #92405e)' }}>£{(owesCents / 100).toFixed(2)} from before</span>
              </div>
            )}
            {appointment.buffer_minutes > 0 && (
              <div style={styles.detailRow}><span style={styles.detailLabel}>Buffer</span><span style={styles.detailValue}>{appointment.buffer_minutes} min cleanup</span></div>
            )}
            {appointment.ai_booked && <div style={styles.detailRow}><span style={styles.detailLabel}>Booked by</span><span style={styles.aiTag}>Florrie</span></div>}
            {/* Booking audit trail: when it was made + how, and when the client
                was confirmed. This is Ellie's evidence in a no-show dispute. */}
            {appointment.created_at && (
              <div style={styles.detailRow}>
                <span style={styles.detailLabel}>Booked</span>
                <span style={styles.detailValue}>
                  {new Date(appointment.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  {appointment.booked_via === 'booking_page' ? ' · online' : appointment.booked_via === 'manual' ? ' · by you' : ''}
                </span>
              </div>
            )}
            {appointment.confirmation_sent_at && (
              <div style={styles.detailRow}>
                <span style={styles.detailLabel}>Confirmation sent</span>
                <span style={styles.detailValue}>
                  {new Date(appointment.confirmation_sent_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            )}
          </div>
          {/* Consultation form. Two states worth a line on this sheet: there
              is one on file (read it here, in place), or the treatment needs
              one and there is nothing (say so BEFORE the client arrives). */}
          {consultation && (consultation.response || consultation.requires_consultation) && (
            <div style={{ marginTop: 14, border: `1.5px solid ${COLORS.outlineVariant}`, borderRadius: 12, padding: '10px 12px' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary, #888)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>Consultation</div>

              {consultation.response ? (
                <>
                  <button
                    onClick={() => { hapticTap(); setConsultOpen(v => !v); }}
                    aria-expanded={consultOpen}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%', minHeight: TAP, padding: 0, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}
                  >
                    <span style={{ fontSize: 13, color: 'var(--text-primary)', minWidth: 0 }}>
                      {/* completed_at is a real instant, not an appointment wall
                          time, so it formats normally. slice(11,16) is for
                          appointments.starts_at and nothing else. */}
                      Consultation form, submitted {consultation.response.completed_at
                        ? new Date(consultation.response.completed_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
                        : 'date unknown'}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: COLORS.primary, flexShrink: 0 }}>
                      {consultOpen ? 'Hide' : 'Read it'}
                    </span>
                  </button>

                  {/* Flagged answers stay on screen whether or not she opens
                      the form. That is the whole point of flagging them. */}
                  {(consultation.response.worth_knowing || []).map((note, i) => (
                    <p key={i} style={{ fontSize: 12, color: COLORS.primary, fontWeight: 600, margin: '6px 0 0', lineHeight: 1.45 }}>
                      {note}
                    </p>
                  ))}

                  {consultOpen && (
                    <div style={{ marginTop: 10, borderTop: `1px solid ${COLORS.outlineVariant}66`, paddingTop: 8 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
                        {consultation.response.form_name}
                      </div>
                      {consultation.response.pairs.map(pair => (
                        <div key={pair.field_id} style={{ padding: '7px 0', borderBottom: `1px solid ${COLORS.outlineVariant}44` }}>
                          <div style={{ fontSize: 11, color: COLORS.stone400, lineHeight: 1.4 }}>{pair.question}</div>
                          <div style={{ fontSize: 13,
                            fontWeight: 500,
                            lineHeight: 1.45,
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            color: pair.answered ? 'var(--text-primary)' : COLORS.stone400,
                            fontStyle: pair.answered ? 'normal' : 'italic',
                          }}>
                            {pair.answered ? pair.answer : 'Not answered'}
                          </div>
                          {pair.worth_knowing && (
                            <span style={{ display: 'inline-block', marginTop: 4, fontSize: 11, fontWeight: 700, color: '#92405e', background: 'rgba(146, 64, 94, 0.10)', border: '1px solid rgba(146, 64, 94, 0.25)', borderRadius: 999, padding: '3px 9px' }}>
                              Worth knowing
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <p style={{ fontSize: 13, color: COLORS.primary, fontWeight: 600, margin: 0, lineHeight: 1.45 }}>
                    This treatment needs a consultation form and there is nothing on file for {appointment.clients?.first_name || 'this client'}.
                  </p>
                  {consultation.form_available && appointment.client_id && (
                    <button
                      onClick={() => { hapticTap(); handleSendConsultationForm(); }}
                      disabled={consultSending}
                      style={{ width: '100%', minHeight: TAP, marginTop: 8, padding: '10px 12px', borderRadius: 10, border: 'none', background: '#92405e', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', opacity: consultSending ? 0.6 : 1 }}
                    >
                      {consultSending ? 'Sending...' : 'Send them the form'}
                    </button>
                  )}
                  {consultSendResult && (
                    <p style={{ fontSize: 11, color: COLORS.stone400, margin: '6px 0 0', lineHeight: 1.45 }}>{consultSendResult}</p>
                  )}
                </>
              )}
            </div>
          )}
          {/* Payments, all in one place: the plain sum for THIS booking (total,
              paid, left to collect) plus what card fees would take. Outstanding
              and fees come from the same /card endpoint the charge buttons use,
              so this panel can never disagree with what a tap would charge. */}
          {(appointment.price_cents || 0) > 0 && !DEAD_STATUSES.includes(appointment.status) && (() => {
            const paidInFull = appointment.payment_type === 'full';
            const paidCents = paidInFull
              ? (appointment.price_cents || 0)
              : (appointment.deposit_paid ? (appointment.deposit_cents || 0) : 0);
            const owed = cardInfo?.outstanding_cents
              ?? (paidInFull ? 0 : Math.max(0, (appointment.price_cents || 0) - paidCents));
            const fees = cardInfo?.fees;
            return (
              <div style={{ marginTop: 14, border: `1.5px solid ${COLORS.outlineVariant}`, borderRadius: 12, padding: '10px 12px' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary, #888)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>Payments</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', fontSize: 13 }}>
                  <span>Total</span>
                  <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>£{((appointment.price_cents || 0) / 100).toFixed(2)}</span>
                </div>
                {paidCents > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', fontSize: 13, color: COLORS.stone400 }}>
                    <span>{paidInFull ? 'Paid in full at booking' : 'Deposit paid'}</span>
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>{'\u2212'}£{(paidCents / 100).toFixed(2)}</span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0 0', marginTop: 3, borderTop: `1px solid ${COLORS.outlineVariant}66`, fontSize: 14 }}>
                  <span style={{ fontWeight: 700, color: owed > 0 ? COLORS.primary : '#2E7D32', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    {owed <= 0 && <Icon name={iconName('check_circle')} size={16} inline />}
                    {owed > 0 ? 'To collect' : paidInFull ? 'Paid in full' : 'Nothing to collect'}
                  </span>
                  {owed > 0 && <span style={{ fontWeight: 700, color: COLORS.primary, fontVariantNumeric: 'tabular-nums' }}>£{(owed / 100).toFixed(2)}</span>}
                </div>
                {/* The question Ellie actually asks in front of this sheet is
                    "if they no-show, am I covered?". For a paid-in-full booking
                    the answer is yes BY DEFINITION: the money is already hers,
                    which is exactly why the charge button refuses to exist.
                    Say it, so a missing button reads as safety, not a bug. */}
                {paidInFull && appointment.status !== 'completed' && appointment.status !== 'no_show' && (
                  <p style={{ fontSize: 11, color: '#2E7D32', margin: '6px 0 0', lineHeight: 1.45 }}>
                    If they do not show, you keep this. There is nothing more to charge.
                  </p>
                )}
                {owed > 0 && fees && fees.amount_cents > 0 && (
                  <p style={{ fontSize: 11, color: COLORS.stone400, margin: '6px 0 0', lineHeight: 1.45 }}>
                    On the card that's about £{((fees.estimated_net_cents || 0) / 100).toFixed(2)} to you after
                    fees (Stripe + Florrie, estimate). Cash or bank transfer: the full £{(owed / 100).toFixed(2)}, no fees.
                  </p>
                )}
              </div>
            );
          })()}
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
                <Icon name={iconName('event_repeat')} size={16} inline />
                Reschedule
              </button>
              {/* Card fallback: only shows when there's an unpaid balance (price
                  minus the deposit they paid). NEVER for a pay-in-full booking:
                  deposit_cents still carries the standard deposit on those rows,
                  so the arithmetic would offer to charge a paid client again.
                  That is exactly the "says charge 10 to card" complaint, and one
                  tap from a double charge. The backend refuses too; this stops
                  the button existing at all. */}
              {appointment.payment_type !== 'full'
                && (((appointment.price_cents || 0) - (appointment.deposit_paid ? (appointment.deposit_cents || 0) : 0)) >= 30) && (
                <button onClick={() => { hapticTap(); handleChargeBalance(); }} disabled={chargingBalance}
                  style={{ ...styles.completeBtn, marginTop: 0, background: 'var(--bg-input, #FAFAFA)', color: COLORS.primary, border: `1.5px solid ${COLORS.outlineVariant}`, fontSize: 13, padding: '10px 0', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                  <Icon name={iconName('credit_card')} size={16} inline />
                  {chargingBalance ? 'Charging...' : `Charge £${(((appointment.price_cents || 0) - (appointment.deposit_paid ? (appointment.deposit_cents || 0) : 0)) / 100).toFixed(2)} balance to card`}
                </button>
              )}
              {/* Charge any amount to the saved card. Shows the card so she knows
                  it will work, or says plainly why it won't. */}
              {cardInfo?.hasCard && !chargeOpen && (
                <button onClick={() => { hapticTap(); setChargeOpen(true); }}
                  style={{ ...styles.completeBtn, marginTop: 0, background: 'var(--bg-input, #FAFAFA)', color: COLORS.primary, border: `1.5px solid ${COLORS.outlineVariant}`, fontSize: 13, padding: '10px 0', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                  <Icon name={iconName('payments')} size={16} inline />
                  Charge their card{cardInfo.last4 ? ` \u00b7\u00b7\u00b7\u00b7 ${cardInfo.last4}` : ''}
                </button>
              )}
              {chargeOpen && (
                <div style={{ border: `1.5px solid ${COLORS.outlineVariant}`, borderRadius: 12, padding: 12, background: 'var(--bg-card)' }}>
                  <p style={{ margin: '0 0 8px', fontSize: 12, color: COLORS.stone400 }}>
                    Charging {appointment.clients?.first_name || 'this client'}'s saved card
                    {cardInfo?.brand ? ` (${cardInfo.brand}${cardInfo.last4 ? ` \u00b7\u00b7\u00b7\u00b7 ${cardInfo.last4}` : ''})` : ''}.
                  </p>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <input
                      type="number" inputMode="decimal" step="0.01" min="0"
                      value={chargeAmount}
                      onChange={e => setChargeAmount(e.target.value)}
                      placeholder="Amount, e.g. 15.00"
                      style={{ flex: 1, minWidth: 0, padding: '10px', borderRadius: 8, border: `1px solid ${COLORS.outlineVariant}`, fontFamily: 'inherit', fontSize: 14 }}
                    />
                  </div>
                  {/* Live "what reaches you" as she types. Mirrors the server's
                      arithmetic using the model constants IT sent (ceil for the
                      platform cut, min 5p, cap £5), so no round trip per key. */}
                  {cardInfo?.fees?.model && parseFloat(chargeAmount) > 0 && (() => {
                    const m = cardInfo.fees.model;
                    const cents = Math.round(parseFloat(chargeAmount) * 100);
                    const plat = Math.min(m.platform_max_cents, Math.max(m.platform_min_cents, Math.ceil(cents * m.platform_percent / 100)));
                    const stripe = Math.round(cents * m.stripe_percent_estimate / 100) + m.stripe_fixed_cents_estimate;
                    const net = Math.max(0, cents - plat - stripe);
                    return (
                      <p style={{ fontSize: 11, color: COLORS.stone400, margin: '0 0 8px' }}>
                        You'd receive about £{(net / 100).toFixed(2)} after card fees (estimate).
                      </p>
                    );
                  })()}
                  <input
                    value={chargeReason}
                    onChange={e => setChargeReason(e.target.value)}
                    placeholder="What's it for? (shows on her receipt)"
                    style={{ width: '100%', boxSizing: 'border-box', padding: '10px', borderRadius: 8, border: `1px solid ${COLORS.outlineVariant}`, fontFamily: 'inherit', fontSize: 13, marginBottom: 10 }}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={handleChargeCard} disabled={chargingCard}
                      style={{ flex: 1, padding: '10px', borderRadius: 8, border: 'none', background: COLORS.primary, color: '#fff', fontSize: 13, fontWeight: 700, cursor: chargingCard ? 'wait' : 'pointer', fontFamily: 'inherit' }}>
                      {chargingCard ? 'Charging...' : 'Take payment'}
                    </button>
                    <button onClick={() => { setChargeOpen(false); setChargeAmount(''); setChargeReason(''); }} disabled={chargingCard}
                      style={{ flex: 1, padding: '10px', borderRadius: 8, border: `1px solid ${COLORS.outlineVariant}`, background: 'var(--bg-card)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {cardInfo && !cardInfo.hasCard && cardInfo.reason === 'no_card_on_file' && (
                <div style={{ border: `1px dashed ${COLORS.outlineVariant}`, borderRadius: 10, padding: '10px 12px' }}>
                  <p style={{ fontSize: 12, color: COLORS.stone400, margin: '0 0 8px', lineHeight: 1.45 }}>
                    No card on file for this client, so there's nothing to charge if they don't turn up.
                    Send them a link to add one. It saves the card, it doesn't take any money.
                  </p>
                  <button onClick={() => { hapticTap(); handleGetCardLink(); }} disabled={cardLinkBusy}
                    style={{ width: '100%', minHeight: 40, padding: '9px 12px', borderRadius: 9, border: `1.5px solid ${COLORS.outlineVariant}`, background: 'var(--bg-card)', color: COLORS.primary, fontSize: 13, fontWeight: 600, cursor: cardLinkBusy ? 'wait' : 'pointer', fontFamily: 'inherit' }}>
                    {cardLinkBusy ? '\u2026' : (cardLink ? '\u2713 Link copied, paste it to them' : 'Get a card-on-file link')}
                  </button>
                  {cardLink && (
                    <input readOnly value={cardLink}
                      onClick={e => { e.target.select(); navigator.clipboard?.writeText?.(cardLink); }}
                      style={{ width: '100%', marginTop: 8, padding: '8px', borderRadius: 6, border: `1px solid ${COLORS.outlineVariant}`, fontSize: 11, boxSizing: 'border-box', fontFamily: 'inherit', background: 'var(--bg-card)' }} />
                  )}
                </div>
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
              <Icon name={iconName('delete')} size={16} inline />
              {deleting ? 'Deleting…' : 'Delete appointment'}
            </button>
          </div>
          {/* No-show fee: one-tap charge, or a clear reason she can't. */}
          {noShowCharging && (
            <div style={{ marginTop: 12, padding: 12, borderRadius: 10, background: 'var(--danger-bg)', border: '1px solid var(--danger)' }}>
              {noShowFeeInfo?.can_charge ? (
                <>
                  <p style={{ fontSize: 13, color: 'var(--danger-text)', margin: '0 0 8px' }}>Charge {appointment.clients?.first_name || 'this client'} a no-show fee?</p>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={handleChargeNoShow} disabled={saving}
                      style={{ flex: 1, padding: '8px', borderRadius: 8, border: 'none', background: 'var(--danger)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                      {saving ? 'Charging...' : `Charge £${((noShowFeeInfo.amount_cents || 0) / 100).toFixed(2)}`}
                    </button>
                    <button onClick={() => setNoShowCharging(false)}
                      style={{ flex: 1, padding: '8px', borderRadius: 8, border: '1px solid var(--border-light)', background: 'var(--bg-card)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>
                      Not this time
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p style={{ fontSize: 13, color: 'var(--danger-text)', margin: '0 0 4px', fontWeight: 600 }}>Can't charge a no-show fee</p>
                  <p style={{ fontSize: 12, color: 'var(--danger-text)', margin: '0 0 8px', lineHeight: 1.45 }}>
                    {noShowFeeInfo?.reason === 'no_card'
                      ? 'There\u2019s no card saved for this client, so there\u2019s nothing to charge. To protect yourself against no-shows, turn on deposits (card required at booking) in Settings.'
                      : 'Your cancellation policy has no no-show fee set, so there\u2019s nothing to charge. You can set one in Settings > Policy.'}
                  </p>
                  <button onClick={() => setNoShowCharging(false)}
                    style={{ width: '100%', padding: '8px', borderRadius: 8, border: '1px solid var(--border-light)', background: 'var(--bg-card)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>
                    Got it
                  </button>
                </>
              )}
            </div>
          )}
          {/* Client booking-management link: copy to paste anywhere, or text it */}
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${COLORS.outlineVariant}55` }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: COLORS.stone400, marginBottom: 8 }}>
              {needsPatchTest ? 'Patch test + booking link' : 'Booking link for the client'}
            </div>
            {needsPatchTest && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start',
                background: '#FDF3E7', border: '1px solid #E9D3B4', borderRadius: 10,
                padding: '9px 11px', marginBottom: 9,
              }}>
                <span style={{ fontSize: 15, lineHeight: 1.2 }}>🩺</span>
                <p style={{ margin: 0, fontSize: 12, lineHeight: 1.45, color: '#6B4E2E' }}>
                  <strong>This client still needs a patch test.</strong> Sending this link opens straight
                  on the patch test picker, so they can book it themselves. It has to be at least 24 hours
                  before their appointment.
                </p>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button onClick={handleGetManageLink} disabled={manageBusy}
                style={{ flex: 1, minWidth: 150, minHeight: 44, padding: '10px 12px', borderRadius: 10, border: `1.5px solid ${COLORS.outlineVariant}`, background: 'var(--bg-card)', color: COLORS.primary, fontSize: 13, fontWeight: 600, cursor: manageBusy ? 'not-allowed' : 'pointer', fontFamily: 'inherit' }}>
                {manageCopied ? '\u2713 Copied' : (manageBusy ? '\u2026' : (needsPatchTest ? 'Copy patch test link' : 'Copy booking link'))}
              </button>
              <button onClick={handleSendManageLink} disabled={manageBusy}
                style={{ flex: 1, minWidth: 150, minHeight: 44, padding: '10px 12px', borderRadius: 10, border: 'none', background: COLORS.primary, color: '#fff', fontSize: 13, fontWeight: 600, cursor: manageBusy ? 'not-allowed' : 'pointer', fontFamily: 'inherit' }}>
                {manageSent ? `\u2713 ${manageSent}` : (manageBusy ? '\u2026' : (needsPatchTest ? 'Send patch test link' : 'Text link to client'))}
              </button>
            </div>
            {manageLink && (
              <input readOnly value={manageLink}
                onClick={e => { e.target.select(); navigator.clipboard?.writeText?.(manageLink); setManageCopied(true); setTimeout(() => setManageCopied(false), 2000); }}
                style={{ width: '100%', marginTop: 8, padding: '8px', borderRadius: 6, border: `1px solid ${COLORS.outlineVariant}`, fontSize: 12, boxSizing: 'border-box', fontFamily: 'inherit', background: 'var(--bg-card)' }} />
            )}
            <p style={{ fontSize: 11, color: COLORS.stone400, margin: '6px 0 0' }}>
              {needsPatchTest
                ? 'The message tells them they need a patch test and takes them straight to the times you have free. They can also reschedule or cancel on the same page.'
                : 'The link they use to view, reschedule or cancel. Copy it to paste into WhatsApp, or send it to them.'}
            </p>
          </div>
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
// LOCAL calendar date as YYYY-MM-DD, never toISOString(), which converts to UTC
// and, under British Summer Time (UTC+1), rolls every date back to the previous
// day. That's the bug that "shifted the whole calendar": blocking a day or
// grouping appointments by formatDate() landed everything on the day before.
// The rest of the diary reads stored times as wall-clock (see wallMinutes), and
// BookingPage/HoursExceptions already build their date keys from local parts,
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
  page: { minHeight: '100vh', background: 'var(--bg)', fontFamily: "var(--font-body, 'Plus Jakarta Sans', -apple-system, sans-serif)", padding: '0 16px 120px', maxWidth: 480, margin: '0 auto', color: 'var(--text-primary)', animation: 'fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)' },
  header: { paddingTop: 8 },
  headerTop: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  headerCenter: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 },
  dateTitle: { fontSize: 17, fontWeight: 600, margin: 0, textAlign: 'center', fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)" },
  todayBtn: { background: 'none', border: `1px solid ${COLORS.outlineVariant}`, borderRadius: 8, padding: '4px 12px', minHeight: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: COLORS.stone400, cursor: 'pointer', fontFamily: 'inherit' },
  navBtn: { background: 'none', border: 'none', fontSize: 28, color: COLORS.stone400, cursor: 'pointer', padding: '0 8px', minWidth: 44, minHeight: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
  viewToggle: { display: 'flex', gap: 3, background: 'var(--card-bg, #fff)', borderRadius: 12, padding: 3, border: `1px solid ${COLORS.outlineVariant}` },
  toggleBtn: { flex: 1, padding: '6px 14px', minHeight: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer', transition: 'all 0.2s', fontFamily: 'inherit' },
  // Weekly Date Strip. The month label and the made-up "WEEK 5" that used to
  // sit above it are gone: the title directly above already says the date, and
  // the closer the seven days sit to it the more they read as one control.
  weeklyStripContainer: { marginBottom: 14, background: COLORS.surfaceContainerLow, borderRadius: 24, padding: '8px 10px', position: 'relative' },
  weeklyStrip: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 },
  // 56px tall, and seven columns of a 480px page leave roughly 57px each, so
  // every day clears the 44px thumb minimum on its own.
  weeklyStripDay: { minHeight: 56, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '7px 2px', borderRadius: 14, border: 'none', cursor: 'pointer', fontFamily: 'inherit', transition: 'background 0.18s ease, color 0.18s ease, opacity 0.18s ease', WebkitTapHighlightColor: 'transparent' },
  weeklyStripDayName: { fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.7 },
  weeklyStripDayNumber: { fontSize: 16, fontWeight: 700, marginTop: 1, fontVariantNumeric: 'tabular-nums' },
  weeklyStripDots: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3, height: 4, marginTop: 5 },
  weeklyStripDot: { width: 4, height: 4, borderRadius: '50%' },
  // Day View Timeline. The grid scrolls inside its own container so the
  // full 06:00-23:00 day fits and we can auto-scroll to the first booking.
  dayGrid: { display: 'flex', gap: 0, background: 'var(--tone-1, #fbf1ea)', borderRadius: 20, overflowY: 'auto', overflowX: 'hidden', maxHeight: 'calc(100dvh - 280px)', minHeight: 420, WebkitOverflowScrolling: 'touch' },
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
  weekDaySection: { background: 'var(--tone-1, #fbf1ea)', borderRadius: 20, overflow: 'hidden' },
  weekDaySectionToday: { boxShadow: `0 0 0 1.5px ${COLORS.primary}` },
  weekDayHead: { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '12px 14px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' },
  weekDayHeadLeft: { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 },
  weekDayDow: { fontSize: 17, fontWeight: 600, fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)" },
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
  detailPanel: { background: 'var(--tone-1, #fbf1ea)', borderRadius: 20, padding: 20, marginTop: 16 },
  detailHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  detailTitle: { fontSize: 17, fontWeight: 700, margin: 0 },
  detailClose: { background: 'none', border: 'none', fontSize: 22, color: COLORS.stone400, cursor: 'pointer', minWidth: 44, minHeight: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
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
  photoRemove: { position: 'absolute', top: 8, right: 8, width: 44, height: 44, borderRadius: '50%', background: 'rgba(0,0,0,0.5)', color: '#fff', border: 'none', fontSize: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' },
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
  const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'flex-end' };
  const sheet = { background: 'var(--bg-card)', borderRadius: '20px 20px 0 0', padding: '20px 20px 40px', width: '100%', maxWidth: 480, margin: '0 auto', fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif", maxHeight: '90vh', overflowY: 'auto' };
  return createPortal(
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
            <div style={{ flex: 1, minWidth: 0 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: COLORS.stone400, textTransform: 'uppercase', letterSpacing: '0.05em' }}>From</label>
              <input
                type="time"
                value={startTime}
                onChange={e => setStartTime(e.target.value)}
                style={{ display: 'block', width: '100%', marginTop: 4, padding: '10px 12px', borderRadius: 10, border: `1.5px solid ${COLORS.outlineVariant}`, fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }}
              />
            </div>
            <span style={{ fontSize: 14, color: COLORS.stone400, marginTop: 16 }}>→</span>
            <div style={{ flex: 1, minWidth: 0 }}>
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
              style={{ padding: '7px 12px', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
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
  , document.body);
}
// BlockDetailSheet - shows an existing block + remove option
function BlockDetailSheet({ block, onDelete, onClose }) {
  const [confirming, setConfirming] = useState(false);
  const isClosed = block.type ? block.type === 'closed' : !!block.is_closed;
  const timeRange = isClosed
    ? 'All day'
    : `${block.start_time || block.custom_start || '?'} → ${block.end_time || block.custom_end || '?'}`;
  const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'flex-end' };
  const sheet = { background: 'var(--bg-card)', borderRadius: '20px 20px 0 0', padding: '20px 20px 40px', width: '100%', maxWidth: 480, margin: '0 auto', fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif" };
  return createPortal(
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
  , document.body);
}
// NewAppointmentModal - manual entry from the day calendar's plus button.
// Search an existing client or quick-create one (name + optional phone),
// pick a treatment (price autofills but stays editable), and any time to the
// minute via a native time input. "Send confirmation message" defaults
// OFF so bookings mirrored from an old system never double-message clients.
function NewAppointmentModal({ defaultDate, existingAppointments = [], initialClient = null, onClose, onSaved }) {
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
  const [selectedClient, setSelectedClient] = useState(() => {
    if (!initialClient?.id) return null;
    const parts = String(initialClient.name || '').trim().split(/\s+/);
    return { id: initialClient.id, first_name: parts[0] || 'Client', last_name: parts.slice(1).join(' ') };
  });
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
  const overlay = { position: 'fixed', left: 0, right: 0, top: vp ? vp.top : 0, height: vp ? vp.height : '100%', background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'flex-end' };
  // The sheet is a flex column: a fixed header, a scrollable body, and a STICKY
  // footer that always holds Cancel + the primary action. The body scrolls
  // under the keyboard; the footer never moves, so the Add button is always one
  // tap away without hunting, and it clears the iOS home indicator via the
  // safe-area inset.
  const sheet = { background: 'var(--bg-card)', borderRadius: '20px 20px 0 0', width: '100%', maxWidth: 480, margin: '0 auto', fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif", maxHeight: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' };
  const sheetBody = { padding: '20px 20px 16px', overflowY: 'auto', WebkitOverflowScrolling: 'touch', flex: '1 1 auto', minHeight: 0 };
  const sheetFooter = { flexShrink: 0, padding: '12px 20px calc(14px + env(safe-area-inset-bottom))', borderTop: `1px solid ${COLORS.outlineVariant}55`, background: 'var(--bg-card)', boxShadow: '0 -4px 16px rgba(0,0,0,0.06)' };
  const labelStyle = { fontSize: 12, fontWeight: 600, color: COLORS.stone400, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block' };
  const inputStyle = { display: 'block', width: '100%', minWidth: 0, maxWidth: '100%', marginTop: 4, padding: '10px 12px', borderRadius: 10, border: `1.5px solid ${COLORS.outlineVariant}`, fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', background: 'var(--bg-card)', color: COLORS.onSurface };
  return createPortal(
    <div style={overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={sheet}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 20px 12px', flexShrink: 0 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: COLORS.onSurface }}>New appointment</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: COLORS.stone400 }}>×</button>
        </div>
        {/* Scrollable body: every field lives here so it can scroll under the keyboard */}
        <div style={sheetBody}>
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
                  style={{ padding: '7px 12px', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
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
                style={{ padding: '8px 12px', borderRadius: 999, fontSize: 13, fontWeight: 600,
                  cursor: 'pointer', fontFamily: 'inherit',
                  border: `1.5px solid ${on ? COLORS.primary : COLORS.outlineVariant}`,
                  background: on ? COLORS.primary : 'var(--bg-card, #fff)',
                  color: on ? '#fff' : COLORS.onSurface,
                }}
              >
                {on ? '✓ ' : ''}{t.name} £{(t.price_cents || 0) % 100 === 0 ? ((t.price_cents || 0) / 100).toFixed(0) : ((t.price_cents || 0) / 100).toFixed(2)}
              </button>
            );
          })}
          {treatments.length === 0 && (
            <span style={{ fontSize: 13, color: COLORS.stone400 }}>No treatments yet. Add them in Treatments.</span>
          )}
        </div>
        {/* Date + time */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={labelStyle}>Date</span>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={labelStyle}>Time</span>
            {/* Native time input: on iOS this is the time wheel, so Ellie can set
                ANY minute (08:30, 14:25, 16:55). step=60 = minute granularity.
                The value is still the same "HH:MM" wall-clock string the create
                logic and clash check already expect, so nothing downstream
                changes and there is no British Summer Time day-shift. */}
            <input
              type="time"
              step={60}
              value={time}
              onChange={e => setTime(e.target.value)}
              style={inputStyle}
            />
          </div>
        </div>
        {/* Duration + price */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
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
          <div style={{ flex: 1, minWidth: 0 }}>
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
        <p style={{ fontSize: 11, color: COLORS.stone400, margin: '0 0 4px' }}>
          Leave off when copying over bookings from your old system, so clients don't get a duplicate message.
        </p>
        </div>{/* end scrollable body */}
        {/* Sticky footer: the clash note, any error, and the always-visible
            primary action. Sits above the iOS home indicator and never scrolls
            away behind the keyboard or bottom nav. */}
        <div style={sheetFooter}>
          {clash && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 10, background: 'var(--warning-bg)', border: '1px solid #FED7AA', margin: '0 0 10px' }}>
              <Icon name={iconName('warning')} size={18} inline style={{ color: '#C2410C', flexShrink: 0 }} />
              <span style={{ fontSize: 12.5, color: 'var(--warning-text)', lineHeight: 1.45 }}>
                This overlaps {clash.clients?.first_name || 'another booking'} at {formatWallTime(clash.starts_at)}
                {clash.treatments?.name ? ` (${clash.treatments.name})` : ''}. You can still add it if you mean to double-book.
              </span>
            </div>
          )}
          {error && (
            <p style={{ fontSize: 13, color: '#B91C1C', margin: '0 0 10px', fontWeight: 600 }}>{error}</p>
          )}
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              style={{ flex: '0 0 auto', padding: '14px 18px', borderRadius: 12, border: `1.5px solid ${COLORS.outlineVariant}`, background: 'var(--bg-card)', color: COLORS.onSurface, fontSize: 15, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', fontFamily: 'inherit' }}
            >
              Cancel
            </button>
            <button
              onClick={() => { hapticTap(); handleSave(); }}
              disabled={saving}
              style={{ flex: 1, padding: '14px 0', borderRadius: 12, border: 'none', background: saving ? COLORS.stone400 : COLORS.primary, color: '#fff', fontSize: 15, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', fontFamily: 'inherit' }}
            >
              {saving ? 'Saving...' : (clash ? 'Add anyway' : 'Add appointment')}
            </button>
          </div>
        </div>
      </div>
    </div>
  , document.body);
}
