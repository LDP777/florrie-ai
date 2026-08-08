import { lazy, Suspense, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useBeautician } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import { useCountUp } from '../lib/useCountUp.js';
import ActivityFeed from '../components/ActivityFeed.jsx';
import SuggestionCards from '../components/SuggestionCards.jsx';
import MorningCatchup from '../components/MorningCatchup.jsx';
import UsagePanel from '../components/UsagePanel.jsx';
import ValueReceipt from '../components/ValueReceipt.jsx';
import SetupNudge from '../components/SetupNudge.jsx';
import { milestoneBloom } from '../lib/bloom.js';
import Icon, { iconName } from '../components/ui/Icon';

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

          {/* Yes/no flag: anything Florrie is holding for your OK. Hidden at zero. */}
          <ApprovalCard onNav={navigate} />

          {/* Rare big bloom when a cumulative milestone is newly crossed */}
          <MilestoneWatcher />

          {/* Setup nudge: slim pointer to /setup while setup is incomplete */}
          <SetupNudge />

          {/* Usage panel, Day 5: slim line showing message quota for the month */}
          <UsagePanel />

          {/* Value receipt: what Florrie recovered this month */}
          <ValueReceipt />

          {/* Florrie suggestions , Day 4 wow moment */}
          <div id="florrie-suggestions">
            <SuggestionCards />
          </div>

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

/**
 * ApprovalCard , the home flag for anything waiting on the owner's yes or no.
 *
 * Combines two sources: proactive holds (outbound_sends pending_approval) and
 * escalated replies to clients she knows (messages, escalated). Shows a count,
 * a one-line preview of the most recent, and a button into the outbox. Renders
 * nothing at all when there is nothing to approve.
 */
function ApprovalCard({ onNav }) {
  const [state, setState] = useState(null); // { count, name, snippet } | null

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const token = getToken();
      if (!token) return;
      const h = { Authorization: `Bearer ${token}` };
      try {
        const [pendRes, escRes, actRes] = await Promise.all([
          fetch(`${API_BASE}/api/outbound/pending`, { headers: h }).catch(() => null),
          fetch(`${API_BASE}/api/escalations`, { headers: h }).catch(() => null),
          fetch(`${API_BASE}/api/activity/feed?limit=50`, { headers: h }).catch(() => null),
        ]);
        if (cancelled) return;

        let approvals = 0;
        if (pendRes && pendRes.ok) {
          const d = await pendRes.json();
          approvals += (d.pending || []).length;
        }
        if (escRes && escRes.ok) {
          const d = await escRes.json();
          approvals += (d.escalations || []).filter(r => r.ai_response && String(r.ai_response).trim()).length;
        }

        // What Florrie has already handled today (matches the "What Florrie did"
        // feed: deduped rows, counted from local midnight).
        let handledToday = 0;
        if (actRes && actRes.ok) {
          const d = await actRes.json();
          const start = new Date(); start.setHours(0, 0, 0, 0);
          handledToday = (d.rows || []).filter(r => new Date(r.created_at) >= start).length;
        }

        setState({ approvals, handledToday, failed: false });
      } catch {
        // Do NOT fall back to zero. Zero is a claim — the card renders
        // "Nothing needs you right now" — and making that claim because the
        // network failed is how a screen teaches someone to stop believing it.
        // Unknown is not the same as none, so say nothing instead.
        if (!cancelled) setState({ approvals: 0, handledToday: 0, failed: true });
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // Lead with what Florrie DID today; approvals become a quiet secondary ask.
  if (!state) return null;
  const { approvals, handledToday, failed } = state;
  // Silent when we could not find out, rather than confidently reassuring.
  if (failed) return null;
  if (!approvals && !handledToday) return null;

  return (
    <div style={AC.card}>
      <div style={AC.iconWrap}>
        <Icon name={iconName('auto_awesome')} inline style={AC.icon} />
      </div>
      <div style={AC.body}>
        <span style={AC.title}>
          {handledToday > 0
            ? `Florrie handled ${handledToday} thing${handledToday === 1 ? '' : 's'} today`
            : "Florrie's on it"}
        </span>
        <span style={AC.sub}>
          {approvals > 0
            ? `${approvals} ${approvals === 1 ? 'needs' : 'need'} your yes or no`
            : 'Nothing needs you right now'}
        </span>
      </div>
      {approvals > 0 && (
        <button onClick={() => onNav('/outbox')} style={AC.cta} aria-label={`Review ${approvals} waiting for your OK`}>
          Review
          <Icon name={iconName('chevron_right')} inline style={AC.ctaChev} />
        </button>
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

/**
 * TodaySummary , pulls today's appointments + unresolved messages and
 * surfaces the four numbers a salon owner cares about first thing:
 * revenue forecast, next client, messages waiting, WhatsApp connection.
 */
function TodaySummary({ beautician, onNav }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  // Roll today's takings up on open (the Monzo app-load feel).
  const animatedRevenue = useCountUp(data?.revenuePence || 0);

  useEffect(() => {
    if (!beautician) return;
    let cancelled = false;
    async function load() {
      const token = getToken();
      if (!token) { setError(true); return; }
      const h = { Authorization: `Bearer ${token}` };

      const now   = new Date();
      // Local wall-clock dates (YYYY-MM-DD), never toISOString() , which shifts
      // to UTC and in British Summer Time buckets late-evening bookings onto the
      // wrong day, making Today's takings / potential / next appointment wrong
      // around the day boundary. The /appointments from/to filter is a date.
      const pad   = n => String(n).padStart(2, '0');
      const ymd   = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const start = ymd(now);
      const end   = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));

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
        // Takings so far: completed appointments only. (Appointments store
        // price_cents; the old price_pence read meant this was always £0.)
        const revenuePence = today
          .filter(a => a.status === 'completed')
          .reduce((sum, a) => sum + (a.price_cents || a.treatments?.price_cents || 0), 0);
        // Potential: everything still on the books today, cancellations and
        // no-shows excluded.
        const DEAD = ['cancelled', 'cancelled_by_client', 'cancelled_by_beautician', 'no_show'];
        const live = appts.filter(a => !DEAD.includes(a.status));
        const apptPrice = a => (a.price_cents || a.treatments?.price_cents || 0);
        const potentialPence = live.reduce((sum, a) => sum + apptPrice(a), 0);
        // Bookings with no price attached (usually imported from another system).
        // They silently drag "potential" down, so flag them rather than hide it.
        const needsPrice = live.filter(a => apptPrice(a) === 0).length;

        // starts_at stores salon WALL time inside the UTC slot, so compare and
        // sort on the raw string (Date-parsing shifts +1h in BST).
        const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
        const wallNow = `${start}T${hhmm}`;
        const byTime = (a, b) => String(a.starts_at).localeCompare(String(b.starts_at));
        const upcoming = today
          .filter(a => String(a.starts_at).slice(0, 16) > wallNow)
          .sort(byTime);
        const next = upcoming[0] || null;

        // The day's client list, in time order, for the strip under the stats.
        // Ellie: "the Today page doesn't actually show who is in that day."
        // Real bookings only (no unpaid pendings cluttering the day).
        const dayClients = [...today].sort(byTime);

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
          potentialPence,
          needsPrice,
          next,
          messagesWaiting,
          totalToday: today.length,
          dayClients,
          todayIso: start,
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

  const revenue = formatGbp(Math.round(animatedRevenue));
  const nextLabel = data.next
    ? `${formatTime(data.next.starts_at)} · ${nextClientName(data.next)}`
    : 'No clients booked';
  // `treatments`, plural. The appointments route selects
  // `treatments(name, duration_minutes, price_cents)`, so the field is
  // `treatments.name` — which the chip 30 lines below reads correctly. This
  // line read `treatment` and `treatment_name`, neither of which exists, so
  // the next-client card has shown the literal words "Booked in" on every
  // render since it shipped instead of "Lash lift".
  const nextSub = data.next?.treatments?.name || data.next?.treatment_name || (data.next ? 'Booked in' : 'Enjoy the breathing room');

  return (
    <section style={TS.wrap}>
      <div style={TS.row}>
        <Stat
          label="Today"
          value={revenue}
          sub={`${data.totalToday} booked`}
          sub2={data.potentialPence > 0 ? `${formatGbp(data.potentialPence)} potential` : null}
        />
        <div style={TS.divider} />
        <Stat label="Next" value={nextLabel} sub={nextSub} wide />
      </div>

      {/* Who's in today — the day at a glance, in time order. Tap = open on
          the calendar. Completed ones dim with a tick. */}
      {(data.dayClients || []).length > 0 && (
        <div style={TS.clientStrip} aria-label="Today's clients">
          {data.dayClients.map(a => {
            const done = a.status === 'completed';
            return (
              <button
                key={a.id}
                onClick={() => onNav(`/calendar/week?date=${data.todayIso}&appt=${a.id}`)}
                style={{ ...TS.clientChip, ...(done ? TS.clientChipDone : {}) }}
              >
                <span style={TS.clientChipTime}>{done ? <Icon name="check" size={13} /> : formatTime(a.starts_at)}</span>
                <span style={TS.clientChipName}>{nextClientName(a)}</span>
                {(a.treatments?.name || a.treatment_name) && (
                  <span style={TS.clientChipTreat}>{a.treatments?.name || a.treatment_name}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {data.needsPrice > 0 && (
        <button onClick={() => onNav('/calendar')} style={TS.priceFlag} aria-label={`${data.needsPrice} bookings need a price`}>
          <Icon name="tag" inline style={TS.priceFlagIcon} />
          <span style={TS.priceFlagText}>
            {data.needsPrice} booking{data.needsPrice === 1 ? '' : 's'} {data.needsPrice === 1 ? 'has' : 'have'} no price. Your potential is higher than it looks.
          </span>
          <Icon name={iconName('chevron_right')} inline style={TS.priceFlagChev} />
        </button>
      )}

      <button
        onClick={() => onNav('/inbox')}
        style={TS.msgRow}
        aria-label={`${data.messagesWaiting} messages waiting`}
      >
        <Icon name={iconName('forum')} inline style={TS.msgIcon} />
        <span style={TS.msgText}>
          {data.messagesWaiting > 0
            ? `${data.messagesWaiting} message${data.messagesWaiting === 1 ? '' : 's'} waiting`
            : 'Inbox is clear'}
        </span>
        <Icon name={iconName('chevron_right')} inline style={TS.msgChev} />
      </button>

      <WhatsAppPill connected={connected} pending={pending} onNav={onNav} />
    </section>
  );
}

function Stat({ label, value, sub, sub2, wide }) {
  return (
    <div style={{ ...TS.stat, ...(wide ? { flex: 2, minWidth: 0 } : {}) }}>
      <span style={TS.statLabel}>{label}</span>
      <span style={{ ...TS.statValue,
        ...(wide ? { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } : {}),
      }}>
        {value}
      </span>
      {sub && <span style={TS.statSub}>{sub}</span>}
      {sub2 && <span style={TS.statSub2}>{sub2}</span>}
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
      <Icon name={iconName('chevron_right')} inline style={TS.waChev} />
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
  // starts_at stores salon WALL time inside the UTC slot, so read it straight
  // off the string. Intl-converting shifted every displayed time +1h in BST.
  const t = String(iso || '').slice(11, 16);
  return /^\d\d:\d\d$/.test(t) ? t : '';
}

function pad(n) { return String(n).padStart(2, '0'); }

function nextClientName(appt) {
  // The appointments API embeds the record as `clients` (table name);
  // reading only `client` left every chip saying just "Client".
  const c = appt?.clients || appt?.client;
  if (!c) return appt?.client_name || 'Client';
  const first = c.first_name?.trim();
  const last  = c.last_name?.trim();
  if (first && last) return `${first} ${last[0]}`;
  return first || last || 'Client';
}

const S = {
  page: {
    minHeight: 'var(--shell-viewport)',
    background: '#FBF6F1',
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    padding: '16px 16px var(--scroll-pad-bottom)',
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
    minHeight: 40,
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

const TS = {
  wrap: {
    background: 'linear-gradient(145deg, #9b4d6e 0%, #7c3350 100%)',
    borderRadius: 22,
    padding: '18px 18px 16px',
    marginBottom: 16,
    boxShadow: 'var(--elev-3)',
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
  clientStrip: {
    display: 'flex',
    gap: 8,
    overflowX: 'auto',
    WebkitOverflowScrolling: 'touch',
    scrollbarWidth: 'none',
    margin: '2px -18px 12px',
    padding: '0 18px',
  },
  clientChip: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 1,
    flexShrink: 0,
    maxWidth: 150,
    padding: '8px 12px',
    borderRadius: 16,
    border: '1px solid rgba(255,255,255,0.22)',
    background: 'rgba(255,255,255,0.12)',
    color: '#fff',
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
  },
  clientChipDone: {
    opacity: 0.55,
  },
  clientChipTime: {
    fontSize: 11,
    fontWeight: 700,
    color: 'rgba(255,255,255,0.75)',
    fontVariantNumeric: 'tabular-nums',
  },
  clientChipName: {
    fontSize: 13,
    fontWeight: 700,
    color: '#fff',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: 126,
  },
  clientChipTreat: {
    fontSize: 10.5,
    color: 'rgba(255,255,255,0.7)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: 126,
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
    fontFamily: '"Plus Jakarta Sans", -apple-system, sans-serif',
    fontSize: 27,
    fontWeight: 700,
    color: '#fff',
    lineHeight: 1.05,
    letterSpacing: '-0.02em',
    fontVariantNumeric: 'tabular-nums',
    fontFeatureSettings: '"tnum" 1, "lnum" 1',
  },
  statSub: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.72)',
    fontWeight: 500,
  },
  statSub2: {
    fontSize: 10.5,
    color: 'rgba(255,255,255,0.55)',
    fontWeight: 500,
  },
  msgRow: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    background: 'rgba(255,255,255,0.12)',
    border: 'none',
    borderRadius: 10,
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

  priceFlag: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    background: 'rgba(255,255,255,0.16)',
    border: '1px solid rgba(255,255,255,0.22)',
    borderRadius: 10,
    padding: '8px 12px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    color: '#fff',
    marginBottom: 10,
    WebkitTapHighlightColor: 'transparent',
  },
  priceFlagIcon: { fontSize: 17, color: '#fff', opacity: 0.9 },
  priceFlagText: { flex: 1, fontSize: 12, fontWeight: 600, textAlign: 'left', lineHeight: 1.3 },
  priceFlagChev: { fontSize: 18, color: '#fff', opacity: 0.7 },

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


const AC = {
  card: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    background: 'var(--tone-1, #fbf1ea)',
    border: 'none',
    borderRadius: 22,
    padding: '16px',
    marginBottom: 14,
    cursor: 'default',
    fontFamily: 'inherit',
    textAlign: 'left',
    WebkitTapHighlightColor: 'transparent',
    boxSizing: 'border-box',
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 10,
    background: 'rgba(146,64,94,0.10)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  icon: { fontSize: 22, color: '#92405e' },
  body: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 },
  titleRow: { display: 'flex', alignItems: 'center', gap: 8 },
  title: { fontSize: 15, fontWeight: 700, color: '#2b1d22', lineHeight: 1.25 },
  sub: { fontSize: 13, color: '#6e5a60', fontWeight: 500, lineHeight: 1.3 },
  preview: {
    fontSize: 12,
    color: 'var(--text-muted)',
    lineHeight: 1.35,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  previewName: { fontWeight: 600, color: '#92405e' },
  cta: {
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 1,
    minHeight: 44,
    padding: '0 4px',
    background: 'transparent',
    border: 'none',
    fontFamily: 'inherit',
    fontSize: 13,
    fontWeight: 700,
    color: '#92405e',
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
  },
  ctaChev: { fontSize: 18 },
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
