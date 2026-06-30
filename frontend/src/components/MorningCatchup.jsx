import { useEffect, useState } from 'react';
import { API_BASE } from '../lib/config.js';

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
 *   - Suggestion count from /api/suggestions
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
            icon="📅"
            label="Yesterday"
            line={yesterdayLine(data)}
          />
          <Row
            icon="🌷"
            label="Today"
            line={todayLine(data)}
          />
          <Row
            icon="👀"
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
      <span style={MC.rowIcon} aria-hidden>{icon}</span>
      <div style={MC.rowText}>
        <div style={MC.rowLabel}>{label}</div>
        <div style={MC.rowLine}>{line}</div>
      </div>
      {clickable && (
        <span className="material-symbols-outlined" style={MC.rowChevron} aria-hidden>chevron_right</span>
      )}
    </div>
  );
}

async function loadData(beautician) {
  const token = getToken();
  if (!token) return null;
  const h = { Authorization: `Bearer ${token}` };

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayEnd = new Date(todayStart); todayEnd.setDate(todayEnd.getDate() + 1);

  const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(yesterdayStart.getDate() - 1);

  const [apptRes, pulseRes, suggRes] = await Promise.all([
    fetch(
      `${API_BASE}/api/appointments?from=${todayStart.toISOString()}&to=${todayEnd.toISOString()}&per_page=100`,
      { headers: h }
    ).catch(() => null),
    fetch(`${API_BASE}/api/money/pulse`, { headers: h }).catch(() => null),
    fetch(`${API_BASE}/api/suggestions`, { headers: h }).catch(() => null),
  ]);

  let todayCount = null, firstAppt = null;
  if (apptRes?.ok) {
    const j = await apptRes.json();
    const todays = (j.data || []).filter(a => ['confirmed', 'booked'].includes(a.status));
    todayCount = todays.length;
    const sorted = todays.sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
    firstAppt = sorted[0] || null;
  }

  // Pulse is weekly, no per-day breakdown, but we can read yesterday-only by
  // calling appointments for yesterday too. For Day 4 demo, we surface
  // "yesterday's income" as null when we can't compute, and gracefully degrade.
  let yesterdayRevenue = null, yesterdayNoShows = null;
  try {
    const yRes = await fetch(
      `${API_BASE}/api/appointments?from=${yesterdayStart.toISOString()}&to=${todayStart.toISOString()}&per_page=100`,
      { headers: h }
    );
    if (yRes.ok) {
      const yj = await yRes.json();
      const yAppts = yj.data || [];
      const completed = yAppts.filter(a => a.status === 'completed');
      yesterdayRevenue = completed.reduce(
        (sum, a) => sum + (a.price_pence || a.treatment?.price_pence || 0), 0
      );
      yesterdayNoShows = yAppts.filter(a => a.status === 'no_show').length;
    }
  } catch {}

  let headsUp = null;
  let suggestionCount = 0;
  if (suggRes?.ok) {
    const sj = await suggRes.json();
    const list = sj.suggestions || [];
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
  try {
    return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
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
    background: '#fef8f4',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: '12px 20px calc(96px + env(safe-area-inset-bottom, 0px))',
    maxHeight: '88vh',
    overflowY: 'auto',
    WebkitOverflowScrolling: 'touch',
    zIndex: 1101,
    maxWidth: 480,
    margin: '0 auto',
    boxShadow: '0 -10px 40px rgba(146,64,94,0.18)',
    fontFamily: "'Plus Jakarta Sans', 'DM Sans', sans-serif",
    animation: 'mcSlideUp 0.28s ease-out',
  },
  handle: {
    width: 42,
    height: 4,
    background: '#E0D6CF',
    borderRadius: 2,
    margin: '0 auto 14px',
  },
  heading: {
    fontFamily: "'Noto Serif', Georgia, serif",
    fontStyle: 'italic',
    fontSize: 22,
    fontWeight: 700,
    color: '#1d1b19',
    margin: '0 0 4px',
    lineHeight: 1.2,
  },
  subhead: {
    fontSize: 13,
    color: '#867277',
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
    borderRadius: 14,
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
    fontSize: 20,
    lineHeight: 1,
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
    borderRadius: 14,
    padding: '14px 16px',
    fontSize: 15,
    fontWeight: 700,
    fontFamily: 'inherit',
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
    boxShadow: '0 4px 14px rgba(146,64,94,0.22)',
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
