import { lazy, Suspense, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useBeautician } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import ActivityFeed from '../components/ActivityFeed.jsx';
import SuggestionCards from '../components/SuggestionCards.jsx';
import MorningCatchup from '../components/MorningCatchup.jsx';
import UsagePanel from '../components/UsagePanel.jsx';
import ValueReceipt from '../components/ValueReceipt.jsx';
import SetupNudge from '../components/SetupNudge.jsx';
import { milestoneBloom } from '../lib/bloom.js';
import Icon from '../components/ui/Icon';
import { TodaySummary, ApprovalCard } from '../components/TodayCards.jsx';

const CalendarView = lazy(() => import('./CalendarView.jsx'));
const SmartSchedule = lazy(() => import('./SmartSchedule.jsx'));

/** Today keeps the diary, owner decisions and activity close together.
 * Calendar and Schedule retain their existing routes and behaviour.
 */

const SUB_TABS = [
  { id: 'day',   label: 'Day',            path: '/today' },
  { id: 'week',  label: 'Calendar',       path: '/calendar/week' },
  { id: 'smart', label: 'Schedule', path: '/smart-schedule' },
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

/**
 * Milestones: the rare, big bloom. Checks Florrie's cumulative proof-of-work
 * once per Hub mount, fires at most ONE unseen milestone (the biggest), and
 * remembers what has been celebrated per device. Scarcity is the mechanic.
 */
const MILESTONES = [
  { id: 'booking_1', test: st => st.bookings_created >= 1, title: 'Florrie took her first booking for you', sub: 'A client booked in without you lifting a finger.', share: n => 'My AI receptionist Florrie just took her first booking for me 🌸 florrie.ai' },
  { id: 'gaps_10', test: st => st.gaps_closed >= 10, title: 'Ten gaps filled and counting', sub: 'Cancellations that would have been dead time, back in the diary.', share: n => 'My AI receptionist Florrie has refilled 10 cancelled slots for me 🌸 florrie.ai' },
  { id: 'messages_100', test: st => st.messages_handled >= 100, title: 'Florrie has answered 100 client messages', sub: 'A hundred replies you never had to type.', share: n => 'My AI receptionist Florrie just answered her 100th client message for me 🌸 florrie.ai' },
  { id: 'messages_500', test: st => st.messages_handled >= 500, title: '500 client messages handled', sub: 'Five hundred conversations, handled in your voice.', share: n => 'My AI receptionist Florrie has handled 500 client messages for me 🌸 florrie.ai' },
  { id: 'actions_500', test: st => st.total_actions >= 500, title: '500 things handled for you', sub: 'Bookings, replies, reminders, chased deposits. Florrie keeps count so you do not have to.', share: n => 'My AI assistant Florrie has now handled 500 things for my salon 🌸 florrie.ai' },
  { id: 'actions_1000', test: st => st.total_actions >= 1000, title: 'One thousand things, handled', sub: 'Florrie has now done a thousand jobs for your salon.', share: n => '1,000 salon jobs handled by my AI assistant Florrie 🌸 florrie.ai' },
];

function MilestoneWatcher() {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = getToken();
        if (!token) return;
        const res = await fetch(`${API_BASE}/api/activity/stats`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return;
        const st = await res.json();
        if (cancelled) return;
        let seen = [];
        try { seen = JSON.parse(localStorage.getItem('florrie_milestones_seen') || '[]'); } catch { seen = []; }
        // Highest-value unseen milestone wins; later entries are bigger.
        const due = [...MILESTONES].reverse().find(m => !seen.includes(m.id) && m.test(st));
        if (!due) return;
        // Mark the due one AND everything smaller as seen, so a long-running
        // account gets one big moment, not a backlog of six overlays.
        const dueIdx = MILESTONES.findIndex(m => m.id === due.id);
        const nowSeen = [...new Set([...seen, ...MILESTONES.slice(0, dueIdx + 1).map(m => m.id)])];
        try { localStorage.setItem('florrie_milestones_seen', JSON.stringify(nowSeen)); } catch { /* ignore */ }
        setTimeout(() => {
          if (!cancelled) milestoneBloom({ title: due.title, sub: due.sub, shareText: due.share(st) });
        }, 1200);
      } catch { /* milestones are a garnish */ }
    })();
    return () => { cancelled = true; };
  }, []);
  return null;
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
    <div className={activeTab === 'day' ? 'today-page' : undefined} style={S.page}>
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
          <div className="today-layout">
            <div className="today-main">
              <TodaySummary beautician={beautician} onNav={navigate} />
              <ApprovalCard beauticianId={beautician?.id} onNav={navigate} />
              <ActivityFeed limit={50} compact />
            </div>
            <aside className="today-support" aria-label="Suggestions and business overview">
              <div id="florrie-suggestions"><SuggestionCards /></div>
              <ValueReceipt />
              <details className="today-card today-disclosure today-setup">
                <summary><span>Setup & message usage</span><Icon name="chevron-down" size={16} /></summary>
                <SetupNudge />
                <UsagePanel />
              </details>
            </aside>
          </div>
          <MilestoneWatcher />

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
      <div style={{ width: 28, height: 28,
        border: '2.5px solid #EDE9E4',
        borderTopColor: '#C76B8A',
        borderRadius: '50%',
        animation: 'spin 0.8s linear infinite',
      }} />
    </div>
  );
}

const S = {
  page: {
    minHeight: 'var(--shell-viewport)',
    background: '#FBF6F1',
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    padding: '16px 16px var(--scroll-pad-bottom)',
    maxWidth: 'var(--today-width, 480px)',
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
    fontSize: 27,
    fontWeight: 600,
    color: '#2b1d22',
    fontFamily: "'Playfair Display', Georgia, serif",
    fontStyle: 'italic',
    margin: 0,
    lineHeight: 1.18,
    letterSpacing: '-0.01em',
  },
  datePill: {
    alignSelf: 'flex-start',
    fontSize: 11,
    fontWeight: 600,
    color: '#92405e',
    background: 'rgba(146,64,94,0.08)',
    padding: '4px 11px',
    borderRadius: 999,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  },
  askPill: {
    position: 'sticky',
    bottom: 88,
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    background: 'var(--tone-1, #fbf1ea)',
    borderRadius: 16,
    padding: '12px 16px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    WebkitTapHighlightColor: 'transparent',
    boxSizing: 'border-box',
    border: 'none',
    marginTop: 8,
  },
  askText: { flex: 1, fontSize: 14, color: '#534247', textAlign: 'left', fontWeight: 500 },

  subTabs: {
    display: 'flex',
    gap: 4,
    padding: 4,
    background: 'var(--tone-2, #f6e7dd)',
    borderRadius: 999,
    marginBottom: 16,
  },
  subTab: {
    flex: 1,
    minHeight: 44,
    padding: '8px 10px',
    borderRadius: 999,
    border: 'none',
    background: 'transparent',
    color: '#6e5a60',
    fontSize: 13,
    fontWeight: 600,
    fontFamily: 'inherit',
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
    transition: 'background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)',
  },
  subTabActive: {
    background: '#92405e',
    color: '#fff',
    boxShadow: 'var(--elev-2)',
  },
  subPane: {
    marginTop: 4,
    background: '#fff',
    borderRadius: 16,
    overflow: 'hidden',
    border: '1px solid rgba(146,64,94,0.07)',
    boxShadow: 'var(--elev-1)',
  },
};
