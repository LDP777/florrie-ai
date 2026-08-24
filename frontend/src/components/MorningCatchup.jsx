import { useEffect, useState } from 'react';
import { API_BASE } from '../lib/config.js';
import Icon, { iconName } from './ui/Icon';

/**
 * MorningCatchup, Day 4 of the 2026-05-28 refactor.
 *
 * One-screen "good morning" bottom sheet. Shown when:
 *   - Local time is before 10am
 *   - localStorage flag florrie_catchup_<YYYY-MM-DD> is not set
 *
 * Tap "Got it" sets the flag and dismisses. Any subsequent app visit today
 * is silent.
 *
 * Pulls:
 *   - Yesterday's revenue / no-shows from /api/money/pulse (or the activity feed)
 *   - Today's appointments from /api/appointments
 *   - Suggestion count from /api/florrie-thinks (the grounded feed)
 *   - Heads-up from the suggestion stream (first high-priority)
 */

function getToken() {
  const key = Object.keys(localStorage).find(k => /^sb-.+-auth-token$/.test(k));
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    const parsed = JSON.parse(raw);
    return parsed?.access_token || parsed?.session?.access_token || raw;
  } catch { return null; }
}

const DEAD_STATUSES = ['cancelled', 'cancelled_by_client', 'cancelled_by_beautician', 'no_show', 'rescheduled'];

/**
 * The salon's own calendar date, as YYYY-MM-DD.
 *
 * appointments.starts_at holds SALON WALL TIME in a UTC-shaped slot, so the
 * bounds sent to the API have to be wall time too. Local midnight turned into
 * an instant is not: in British Summer Time it is 23:00Z the previous day, so
 * the "yesterday" window quietly slid an hour off either end of the diary.
 */
function wallDay(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const dayFrom = day => `${day}T00:00:00.000Z`;
const dayTo = day => `${day}T23:59:59.999Z`;

/**
 * What this appointment was worth, in pence.
 *
 * appointments.price_cents is the stored total for the booking, extras and all
 * (see lib/appointment-treatments.js). The embedded treatment row is only a
 * fallback for a legacy row that never got a price of its own, and it is keyed
 * `treatments` because that is the table name PostgREST embeds under.
 */
function apptPricePence(a) {
  const own = Number(a?.price_cents);
  if (Number.isFinite(own) && own > 0) return own;
  const fromTreatment = Number(a?.treatments?.price_cents);
  return Number.isFinite(fromTreatment) ? fromTreatment : 0;
}

function todayKey(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `florrie_catchup_${y}-${m}-${d}`;
}

function shouldShow(now = new Date()) {
  if (now.getHours() >= 10) return false;
  try {
    return localStorage.getItem(todayKey(now)) !== '1';
  } catch {
    return false;
  }
}

function markSeen(now = new Date()) {
  try { localStorage.setItem(todayKey(now), '1'); } catch {}
}

export default function MorningCatchup({ beautician }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);

  useEffect(() => {
    if (!beautician) return;
    if (!shouldShow()) return;

    setOpen(true);
    loadData(beautician).then(setData).catch(() => {
      setData({
        yesterdayRevenue: null,
        yesterdayNoShows: null,
        todayCount: null,
        firstAppt: null,
        headsUp: null,
      });
    });
  }, [beautician?.id]);

  function dismiss() {
    markSeen();
    setOpen(false);
  }

  // Tap the heads-up row: close the sheet and slide down to the suggestion
  // cards (the "5 things") that live on the Hub just below.
  function goToSuggestions() {
    dismiss();
    setTimeout(() => {
      const el = document.getElementById('florrie-suggestions');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 320);
  }

  if (!open) return null;

  const firstName = beautician?.first_name?.trim() || 'there';

  return (
    <>
      <div style={MC.scrim} onClick={dismiss} aria-hidden />
      <section style={MC.sheet} role="dialog" aria-modal="true" aria-label="Morning catch-up">
        <div style={MC.handle} aria-hidden />
        <h2 style={MC.heading}>Good morning, {firstName}.</h2>
        <p style={MC.subhead}>Here's where you are.</p>

        <div style={MC.rows}>
          <Row
            icon="calendar"
            label="Yesterday"
            line={yesterdayLine(data)}
          />
          <Row
            icon="flower"
            label="Today"
            line={todayLine(data)}
          />
          <Row
            icon="eye"
            label="Heads-up"
            line={headsUpLine(data)}
            onClick={data?.suggestionCount > 0 ? goToSuggestions : null}
          />
        </div>

        <button onClick={dismiss} style={MC.cta}>Got it</button>
      </section>
    </>
  );
}

function Row({ icon, label, line, onClick }) {
  const clickable = typeof onClick === 'function';
  return (
    <div
      style={{ ...MC.row, ...(clickable ? MC.rowClickable : {}) }}
      onClick={clickable ? onClick : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
    >
      <span style={MC.rowIcon} aria-hidden><Icon name={icon} size={19} /></span>
      <div style={MC.rowText}>
        <div style={MC.rowLabel}>{label}</div>
        <div style={MC.rowLine}>{line}</div>
      </div>
      {clickable && (
        <Icon name={iconName('chevron_right')} inline style={MC.rowChevron} />
      )}
    </div>
  );
}

async function loadData(beautician) {
  const token = getToken();
  if (!token) return null;
  const h = { Authorization: `Bearer ${token}` };

  const now = new Date();
  const today = wallDay(now);
  const yesterday = wallDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));

  // /api/money/pulse sat in this list bound to `pulseRes` and was never read.
  // The docblock above still promises yesterday's revenue from it; that has
  // not been true for some time, and the brief renders without it.
  const [apptRes, suggRes] = await Promise.all([
    fetch(
      `${API_BASE}/api/appointments?from=${dayFrom(today)}&to=${dayTo(today)}&per_page=100`,
      { headers: h }
    ).catch(() => null),
    // Same source as the cards below, so the brief's count can never disagree
    // with what actually renders.
    fetch(`${API_BASE}/api/florrie-thinks`, { headers: h }).catch(() => null),
  ]);

  let todayCount = null, firstAppt = null;
  if (apptRes?.ok) {
    const j = await apptRes.json();
    // 'booked' is not a status this database has ever held (see migration 056:
    // pending, confirmed, in_progress, completed, the cancelled family, no_show,
    // rescheduled). Allowlisting an invented value meant a diary full of
    // pending bookings read as an empty day, so count everything that is still
    // going to happen instead.
    const todays = (j.data || []).filter(a => !DEAD_STATUSES.includes(a.status));
    todayCount = todays.length;
    const sorted = todays.sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
    firstAppt = sorted[0] || null;
  }

  // Pulse is weekly, no per-day breakdown, but we can read yesterday-only by
  // calling appointments for yesterday too. Null when we can't compute, and
  // the line degrades to "Quiet day on the books."
  //
  // This row said "£0 taken" for every salon since it was written, because it
  // summed price_pence off the appointment and price_pence off `treatment`.
  // GET /api/appointments returns neither: the column is price_cents (pence,
  // despite the name, see 001_initial_schema.sql) and the embedded relation is
  // `treatments`, plural. Both reads were undefined, every time, so the sum was
  // always exactly zero and looked like a real answer.
  let yesterdayRevenue = null, yesterdayNoShows = null;
  try {
    const yRes = await fetch(
      `${API_BASE}/api/appointments?from=${dayFrom(yesterday)}&to=${dayTo(yesterday)}&per_page=100`,
      { headers: h }
    );
    if (yRes.ok) {
      const yj = await yRes.json();
      const yAppts = yj.data || [];
      // An empty diary is not "£0 taken", it is a day with nothing on it.
      if (yAppts.length > 0) {
        const completed = yAppts.filter(a => a.status === 'completed');
        yesterdayRevenue = completed.reduce((sum, a) => sum + apptPricePence(a), 0);
        yesterdayNoShows = yAppts.filter(a => a.status === 'no_show').length;
      }
    }
  } catch {}

  let headsUp = null;
  let suggestionCount = 0;
  if (suggRes?.ok) {
    const sj = await suggRes.json();
    const list = sj.cards || [];
    suggestionCount = list.length;
    // Don't echo the first suggestion verbatim - the cards below carry the
    // detail. The brief just previews how many things need a look.
    if (list.length) headsUp = list.length === 1
      ? '1 thing worth a look below.'
      : `${list.length} things worth a look below.`;
  }

  return {
    yesterdayRevenue,
    yesterdayNoShows,
    todayCount,
    firstAppt,
    headsUp,
    suggestionCount,
  };
}

function yesterdayLine(d) {
  if (!d) return 'Loading...';
  if (d.yesterdayRevenue === null && d.yesterdayNoShows === null) {
    return 'Quiet day on the books.';
  }
  const parts = [];
  if (d.yesterdayRevenue !== null) {
    parts.push(`${formatGbp(d.yesterdayRevenue)} taken`);
  }
  if (d.yesterdayNoShows !== null && d.yesterdayNoShows > 0) {
    parts.push(`${d.yesterdayNoShows} no-show${d.yesterdayNoShows === 1 ? '' : 's'}`);
  }
  return parts.length ? parts.join(' · ') : 'Quiet day on the books.';
}

function todayLine(d) {
  if (!d) return 'Loading...';
  if (d.todayCount === null) return 'Calendar loading...';
  if (d.todayCount === 0) {
    return 'No bookings yet. Good day for catch-up.';
  }
  const first = d.firstAppt;
  const time = first ? formatTime(first.starts_at) : null;
  return `${d.todayCount} booked${time ? `, first at ${time}` : ''}.`;
}

function headsUpLine(d) {
  if (!d) return 'Loading...';
  if (d.headsUp) return d.headsUp;
  return 'All clear. Have a good day.';
}

function formatGbp(pence) {
  if (!pence) return '£0';
  const pounds = pence / 100;
  if (Number.isInteger(pounds)) return `£${pounds.toLocaleString('en-GB')}`;
  return `£${pounds.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatTime(iso) {
  // starts_at stores salon WALL time in the UTC slot; read it off the string.
  // Intl-converting it showed "first at 11:30" for a 10:30 booking in BST.
  const t = String(iso || '').slice(11, 16);
  return /^\d\d:\d\d$/.test(t) ? t : '';
}

const MC = {
  scrim: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(29,27,25,0.45)',
    zIndex: 1100,
    animation: 'mcFadeIn 0.22s ease-out',
  },
  sheet: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    background: '#FBF6F1',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: '12px 20px calc(96px + env(safe-area-inset-bottom, 0px))',
    maxHeight: '88vh',
    overflowY: 'auto',
    WebkitOverflowScrolling: 'touch',
    zIndex: 1101,
    maxWidth: 480,
    margin: '0 auto',
    boxShadow: 'var(--elev-3)',
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    animation: 'mcSlideUp 0.28s ease-out',
  },
  handle: {
    width: 42,
    height: 4,
    background: '#E0D6CF',
    borderRadius: 6,
    margin: '0 auto 14px',
  },
  heading: {
    fontFamily: "'Playfair Display', Georgia, serif",
    fontStyle: 'italic',
    fontSize: 22,
    fontWeight: 700,
    color: '#1d1b19',
    margin: '0 0 4px',
    lineHeight: 1.2,
  },
  subhead: {
    fontSize: 13,
    color: 'var(--text-muted)',
    margin: '0 0 18px',
  },
  rows: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    marginBottom: 18,
  },
  row: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 12,
    background: '#fff',
    border: '1px solid rgba(146,64,94,0.08)',
    borderRadius: 16,
    padding: '12px 14px',
  },
  rowClickable: {
    cursor: 'pointer',
    border: '1px solid rgba(146,64,94,0.18)',
    WebkitTapHighlightColor: 'transparent',
  },
  rowChevron: {
    fontSize: 20,
    color: '#92405e',
    alignSelf: 'center',
    flexShrink: 0,
  },
  rowIcon: {
    lineHeight: 1,
    color: 'var(--accent, #92405E)',
    flexShrink: 0,
    marginTop: 2,
  },
  rowText: { flex: 1, minWidth: 0 },
  rowLabel: {
    fontSize: 10,
    fontWeight: 700,
    color: '#92405e',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    marginBottom: 2,
  },
  rowLine: {
    fontSize: 14,
    color: '#1d1b19',
    fontWeight: 500,
    lineHeight: 1.35,
  },
  cta: {
    width: '100%',
    background: '#92405e',
    color: '#fff',
    border: 'none',
    borderRadius: 16,
    padding: '14px 16px',
    fontSize: 15,
    fontWeight: 700,
    fontFamily: 'inherit',
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
    boxShadow: 'var(--elev-2)',
  },
};

if (typeof document !== 'undefined' && !document.getElementById('mc-keyframes')) {
  const s = document.createElement('style');
  s.id = 'mc-keyframes';
  s.textContent = `
    @keyframes mcFadeIn { from { opacity: 0; } to { opacity: 1; } }
    @keyframes mcSlideUp {
      from { transform: translateY(40px); opacity: 0; }
      to   { transform: translateY(0);    opacity: 1; }
    }
  `;
  document.head.appendChild(s);
}
