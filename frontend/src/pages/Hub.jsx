import { lazy, Suspense, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useBeautician } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import ActivityFeed from '../components/ActivityFeed.jsx';
import SuggestionCards from '../components/SuggestionCards.jsx';
import MorningCatchup from '../components/MorningCatchup.jsx';
import UsagePanel from '../components/UsagePanel.jsx';

const CalendarView = lazy(() => import('./CalendarView.jsx'));
const SmartSchedule = lazy(() => import('./SmartSchedule.jsx'));

/**
 * Hub (Today) , the new home of the 3-tab nav.
 *
 * Day 3 of the refactor sprint folds Calendar + Smart Schedule into Today
 * as sub-tabs. The pathname picks the default sub-tab so deep links keep
 * working:
 *   /hub, /today                 -> Day
 *   /calendar                    -> Day
 *   /calendar/week               -> Week
 *   /smart-schedule              -> Smart Schedule
 *
 * Day view (the default) is the original slim Hub: greeting + today summary
 * + activity feed + Ask Florrie pill. Week embeds CalendarView in week
 * mode. Smart Schedule embeds the existing page.
 *
 * Everything else (search, recently visited, four feature cards, the agent
 * team grid) lives in More.jsx behind the new "More" affordance.
 */

const SUB_TABS = [
  { id: 'day',   label: 'Day',            path: '/today' },
  { id: 'week',  label: 'Week',           path: '/calendar/week' },
  { id: 'smart', label: 'Smart Schedule', path: '/smart-schedule' },
];

function subTabFromPath(pathname) {
  if (pathname === '/calendar/week') return 'week';
  if (pathname === '/smart-schedule') return 'smart';
  return 'day';
}

function getToken() {
  const key = Object.keys(localStorage).find(k => /^sb-.+-auth-token$/.test(k));
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    const parsed = JSON.parse(raw);
    return parsed?.access_token || parsed?.session?.access_token || raw;
  } catch { return null; }
}

function greetingFor(now = new Date()) {
  const h = now.getHours();
  if (h < 12)  return 'Good morning';
  if (h < 17)  return 'Good afternoon';
  return 'Good evening';
}

export default function Hub() {
  const { beautician } = useBeautician();
  const navigate = useNavigate();
  const location = useLocation();
  const activeTab = subTabFromPath(location.pathname);

  const now      = new Date();
  const greeting = greetingFor(now);
  const dayPill  = now.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
  const name = beautician?.first_name?.trim() || beautician?.display_name?.split(' ')?.[0] || 'there';

  return (
    <div style={S.page}>
      {/* Morning catch-up bottom sheet, only fires before 10am and once per day */}
      <MorningCatchup beautician={beautician} />

      {/* 1. Greeting + date pill */}
      <header style={S.header}>
        <h1 style={S.greeting}>{greeting}, {name}</h1>
        <span style={S.datePill}>{dayPill}</span>
      </header>

      {/* 2. Sub-tab strip , Day / Week / Smart Schedule */}
      <div role="tablist" aria-label="Today views" style={S.subTabs}>
        {SUB_TABS.map(tab => {
          const active = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={active}
              onClick={() => navigate(tab.path)}
              style={{ ...S.subTab, ...(active ? S.subTabActive : {}) }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab === 'day' && (
        <>
          {/* Today summary , the hero card */}
          <TodaySummary beautician={beautician} onNav={navigate} />

          {/* Usage panel, Day 5: slim line showing message quota for the month */}
          <UsagePanel />

          {/* Florrie suggestions , Day 4 wow moment */}
          <SuggestionCards />

          {/* Activity feed , the proof of work */}
          <ActivityFeed limit={50} />

        </>
      )}

      {activeTab === 'week' && (
        <div style={S.subPane}>
          <Suspense fallback={<SubPaneLoader />}>
            <CalendarView initialView="week" />
          </Suspense>
        </div>
      )}

      {activeTab === 'smart' && (
        <div style={S.subPane}>
          <Suspense fallback={<SubPaneLoader />}>
            <SmartSchedule />
          </Suspense>
        </div>
      )}
    </div>
  );
}

function SubPaneLoader() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 0' }}>
      <div style={{
        width: 28, height: 28,
        border: '2.5px solid #EDE9E4',
        borderTopColor: '#C76B8A',
        borderRadius: '50%',
        animation: 'spin 0.8s linear infinite',
      }} />
    </div>
  );
}

/**
 * TodaySummary , pulls today's appointments + unresolved messages and
 * surfaces the four numbers a salon owner cares about first thing:
 * revenue forecast, next client, messages waiting, WhatsApp connection.
 */
function TodaySummary({ beautician, onNav }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!beautician) return;
    let cancelled = false;
    async function load() {
      const token = getToken();
      if (!token) { setError(true); return; }
      const h = { Authorization: `Bearer ${token}` };

      const now   = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const end   = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

      try {
        const [apptRes, msgRes] = await Promise.all([
          fetch(`${API_BASE}/api/appointments?from=${start}&to=${end}&per_page=100`, { headers: h }),
          fetch(`${API_BASE}/api/ai-actions/summary`, { headers: h }).catch(() => null),
        ]);

        if (cancelled) return;

        if (!apptRes.ok) { setError(true); return; }
        const json = await apptRes.json();
        const appts = json.data || [];

        const today = appts.filter(a => ['confirmed', 'booked', 'completed'].includes(a.status));
        const revenuePence = today.reduce((sum, a) => sum + (a.price_pence || a.treatment?.price_pence || 0), 0);

        const upcoming = today
          .filter(a => new Date(a.starts_at) > now)
          .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
        const next = upcoming[0] || null;

        // Messages waiting: derive from /api/agents/counts if possible.
        let messagesWaiting = 0;
        try {
          const cRes = await fetch(`${API_BASE}/api/agents/counts`, { headers: h });
          if (cRes.ok) {
            const cJson = await cRes.json();
            messagesWaiting = cJson?.inbox || 0;
          }
        } catch {}

        setData({
          revenuePence,
          next,
          messagesWaiting,
          totalToday: today.length,
        });
      } catch {
        if (!cancelled) setError(true);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [beautician?.id]);

  const connected = !!beautician?.whatsapp_connected;
  const pending   = !!beautician?.whatsapp_pending_activation;

  if (error || !data) {
    // Skeleton + WhatsApp pill still visible so the user can connect early.
    return (
      <section style={TS.wrap}>
        <div style={TS.skeletonRow}>
          <div style={TS.skel} />
          <div style={TS.skel} />
          <div style={TS.skel} />
        </div>
        <WhatsAppPill connected={connected} pending={pending} onNav={onNav} />
      </section>
    );
  }

  const revenue = formatGbp(data.revenuePence);
  const nextLabel = data.next
    ? `${formatTime(data.next.starts_at)} · ${nextClientName(data.next)}`
    : 'No clients booked';
  const nextSub = data.next?.treatment?.name || data.next?.treatment_name || (data.next ? 'Booked in' : 'Enjoy the breathing room');

  return (
    <section style={TS.wrap}>
      <div style={TS.row}>
        <Stat label="Today" value={revenue} sub={`${data.totalToday} booked`} />
        <div style={TS.divider} />
        <Stat label="Next" value={nextLabel} sub={nextSub} wide />
      </div>

      <button
        onClick={() => onNav('/inbox')}
        style={TS.msgRow}
        aria-label={`${data.messagesWaiting} messages waiting`}
      >
        <span className="material-symbols-outlined" style={TS.msgIcon}>forum</span>
        <span style={TS.msgText}>
          {data.messagesWaiting > 0
            ? `${data.messagesWaiting} message${data.messagesWaiting === 1 ? '' : 's'} waiting`
            : 'Inbox is clear'}
        </span>
        <span className="material-symbols-outlined" style={TS.msgChev}>chevron_right</span>
      </button>

      <WhatsAppPill connected={connected} pending={pending} onNav={onNav} />
    </section>
  );
}

function Stat({ label, value, sub, wide }) {
  return (
    <div style={{ ...TS.stat, ...(wide ? { flex: 2, minWidth: 0 } : {}) }}>
      <span style={TS.statLabel}>{label}</span>
      <span style={{
        ...TS.statValue,
        ...(wide ? { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } : {}),
      }}>
        {value}
      </span>
      {sub && <span style={TS.statSub}>{sub}</span>}
    </div>
  );
}

function WhatsAppPill({ connected, pending, onNav }) {
  let label = 'Connect WhatsApp';
  let dotColour = '#fff';
  let dotOpacity = 0.4;
  if (connected) { label = 'WhatsApp connected'; dotColour = '#7AE6A0'; dotOpacity = 1; }
  else if (pending) { label = 'WhatsApp activating'; dotColour = '#F4C97A'; dotOpacity = 1; }

  return (
    <button
      onClick={() => onNav('/whatsapp')}
      style={TS.waPill}
      aria-label={label}
    >
      <span style={{ ...TS.waDot, background: dotColour, opacity: dotOpacity }} />
      <span style={TS.waText}>{label}</span>
      <span className="material-symbols-outlined" style={TS.waChev}>chevron_right</span>
    </button>
  );
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

function nextClientName(appt) {
  const c = appt?.client;
  if (!c) return appt?.client_name || 'Client';
  const first = c.first_name?.trim();
  const last  = c.last_name?.trim();
  if (first && last) return `${first} ${last[0]}`;
  return first || last || 'Client';
}

const S = {
  page: {
    minHeight: '100vh',
    background: '#fef8f4',
    fontFamily: "'Plus Jakarta Sans', 'DM Sans', sans-serif",
    padding: '16px 16px 120px',
    maxWidth: 480,
    margin: '0 auto',
    color: '#1d1b19',
  },
  header: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    marginBottom: 14,
  },
  greeting: {
    fontSize: 22,
    fontWeight: 700,
    color: '#1d1b19',
    fontFamily: "'Noto Serif', Georgia, serif",
    fontStyle: 'italic',
    margin: 0,
    lineHeight: 1.2,
  },
  datePill: {
    alignSelf: 'flex-start',
    fontSize: 11,
    fontWeight: 600,
    color: '#92405e',
    background: '#ffd9e2',
    padding: '4px 10px',
    borderRadius: 20,
    letterSpacing: '0.04em',
  },
  askPill: {
    position: 'sticky',
    bottom: 88,
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    background: '#fff',
    border: '1.5px solid rgba(199,107,138,0.18)',
    borderRadius: 16,
    padding: '12px 16px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    WebkitTapHighlightColor: 'transparent',
    boxSizing: 'border-box',
    boxShadow: '0 4px 16px rgba(146,64,94,0.08)',
    marginTop: 8,
  },
  askText: { flex: 1, fontSize: 14, color: '#534247', textAlign: 'left', fontWeight: 500 },

  subTabs: {
    display: 'flex',
    gap: 6,
    padding: 4,
    background: '#fff',
    borderRadius: 999,
    marginBottom: 14,
    boxShadow: '0 1px 3px rgba(146,64,94,0.06)',
  },
  subTab: {
    flex: 1,
    padding: '8px 10px',
    borderRadius: 999,
    border: 'none',
    background: 'transparent',
    color: '#867277',
    fontSize: 12,
    fontWeight: 600,
    fontFamily: 'inherit',
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
    transition: 'background 0.15s ease, color 0.15s ease',
  },
  subTabActive: {
    background: '#ffd9e2',
    color: '#92405e',
  },
  subPane: {
    marginTop: 4,
    background: '#fff',
    borderRadius: 16,
    overflow: 'hidden',
    border: '1px solid rgba(146,64,94,0.07)',
    boxShadow: '0 1px 4px rgba(146,64,94,0.05)',
  },
};

const TS = {
  wrap: {
    background: 'linear-gradient(135deg, #C76B8A 0%, #9b4d6e 100%)',
    borderRadius: 22,
    padding: '16px 16px 14px',
    marginBottom: 14,
    boxShadow: '0 6px 22px rgba(199,107,138,0.28)',
    color: '#fff',
  },
  row: {
    display: 'flex',
    alignItems: 'stretch',
    gap: 14,
    marginBottom: 12,
  },
  divider: {
    width: 1,
    background: 'rgba(255,255,255,0.18)',
    alignSelf: 'stretch',
  },
  stat: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    flex: 1,
    minWidth: 0,
  },
  statLabel: {
    fontSize: 10,
    fontWeight: 700,
    color: 'rgba(255,255,255,0.65)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },
  statValue: {
    fontSize: 22,
    fontWeight: 800,
    color: '#fff',
    lineHeight: 1.15,
  },
  statSub: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.72)',
    fontWeight: 500,
  },
  msgRow: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    background: 'rgba(255,255,255,0.12)',
    border: 'none',
    borderRadius: 12,
    padding: '9px 12px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    color: '#fff',
    marginBottom: 10,
    WebkitTapHighlightColor: 'transparent',
  },
  msgIcon: { fontSize: 18, color: '#fff', opacity: 0.85 },
  msgText: { flex: 1, fontSize: 13, fontWeight: 600, textAlign: 'left' },
  msgChev: { fontSize: 18, color: '#fff', opacity: 0.7 },

  waPill: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    background: 'rgba(255,255,255,0.08)',
    border: '1px solid rgba(255,255,255,0.18)',
    borderRadius: 999,
    padding: '7px 12px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    color: '#fff',
    WebkitTapHighlightColor: 'transparent',
  },
  waDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
  },
  waText: { flex: 1, fontSize: 12, fontWeight: 600, textAlign: 'left' },
  waChev: { fontSize: 16, color: '#fff', opacity: 0.7 },

  skeletonRow: {
    display: 'flex', gap: 10, marginBottom: 12,
  },
  skel: {
    flex: 1, height: 40, borderRadius: 10,
    background: 'rgba(255,255,255,0.12)',
  },
};

if (typeof document !== 'undefined' && !document.getElementById('hub-keyframes')) {
  const s = document.createElement('style');
  s.id = 'hub-keyframes';
  s.textContent = `
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to   { opacity: 1; transform: translateY(0); }
    }
  `;
  document.head.appendChild(s);
}
