import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBeautician, supabase, isDevMode, DEV_CLIENTS, DEV_TREATMENTS } from '../lib/supabase.js';
import logger from '../lib/logger.js';
import SpotlightSearch from '../components/SpotlightSearch.jsx';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';

/**
 * Dashboard v3 — AI-first command centre.
 *
 * Shows what your AI team has been doing, then gives you manual control.
 *
 * Sections:
 *   Greeting + next client hero
 *   Your AI Team strip (6 agents, live status)
 *   Today's schedule
 *   Revenue pulse
 *   Quick actions (time-aware)
 *   AI insights (data-driven)
 *   Activity feed (agent-attributed)
 */

// ─── Agent config ──────────────────────────────────────────
const AGENTS = [
  { key: 'front_desk', name: 'Front Desk', icon: '💬', path: '/inbox', desc: 'Handles messages' },
  { key: 'calendar', name: 'Calendar', icon: '📅', path: '/calendar', desc: 'Manages bookings' },
  { key: 'comeback', name: 'Comeback', icon: '🔄', path: '/clients', desc: 'Wins back clients' },
  { key: 'content', name: 'Content', icon: '📸', path: '/content', desc: 'Creates posts' },
  { key: 'money', name: 'Money', icon: '💰', path: '/money', desc: 'Tracks finances' },
  { key: 'scout', name: 'Scout', icon: '🔍', path: '/ai-insights', desc: 'Spots trends' },
];

// ─── Dev data ──────────────────────────────────────────────
const DEV_TODAY = [
  { id: 'a1', time: '11:00', duration: 60, client: 'Shauna', treatment: 'Lamination & Hybrid Dye', status: 'confirmed', price_cents: 4500 },
  { id: 'a2', time: '12:15', duration: 45, client: 'Daisy S', treatment: 'Lamination Maintenance / Tint', status: 'confirmed', price_cents: 2500 },
  { id: 'a3', time: '14:00', duration: 60, client: 'Jasmin', treatment: 'Lash Lift & Tint', status: 'confirmed', price_cents: 4000 },
  { id: 'a4', time: '15:30', duration: 45, client: 'Megan R', treatment: 'HD Brows', status: 'pending', price_cents: 2500 },
];

const DEV_AGENT_SUMMARY = {
  front_desk: { today: 3, latest: 'Confirmed Shauna\'s 11am booking' },
  calendar: { today: 1, latest: 'Filled a gap at 2pm with Jasmin' },
  comeback: { today: 2, latest: 'Nudged Daisy S — 12 days overdue' },
  content: { today: 1, latest: 'Drafted "Tuesday transformation ✨"' },
  money: { today: 1, latest: '£45 payment logged from Shauna' },
  scout: { today: 0, latest: 'Lash lifts trending +18% this month' },
};

const DEV_INSIGHTS = [
  { id: 'i1', icon: '📈', text: "You're on track for £385 this week — 12% up on last week.", type: 'positive' },
  { id: 'i2', icon: '🔄', text: 'Daisy S is 12 days overdue for her usual rebook. Send a nudge?', type: 'action', actionLabel: 'Send nudge', actionPath: '/clients' },
  { id: 'i3', icon: '⭐', text: 'Jasmin left a 5★ review yesterday. florrie.ai drafted a reply.', type: 'action', actionLabel: 'View reply', actionPath: '/reviews' },
  { id: 'i4', icon: '📋', text: "Emma's patch test is needed before Friday's appointment.", type: 'warning', actionLabel: 'Send reminder', actionPath: '/patch-tests' },
];

const DEV_ACTIVITY = [
  { id: 'act1', agent: 'front_desk', icon: '💬', text: 'Confirmed Shauna\'s 11am booking', time: '10 min ago' },
  { id: 'act2', agent: 'content', icon: '📸', text: 'Content draft ready: "Tuesday transformation ✨"', time: '1h ago' },
  { id: 'act3', agent: 'money', icon: '💰', text: '£45.00 payment received from Shauna', time: '2h ago' },
  { id: 'act4', agent: 'calendar', icon: '📅', text: 'Megan R booked HD Brows for today 3:30pm', time: '3h ago' },
  { id: 'act5', agent: 'comeback', icon: '🔄', text: 'Sent aftercare card to Daisy after yesterday\'s appointment', time: '18h ago' },
];

// ─── Quick actions (time-aware) ────────────────────────────
const DEFAULT_QUICK_ACTIONS = [
  { icon: '📅', label: 'Calendar', path: '/calendar', color: '#E3F2FD' },
  { icon: '💬', label: 'Messages', path: '/inbox', color: '#FBF0F3' },
  { icon: '👤', label: 'Clients', path: '/clients', color: '#FFF3E0' },
  { icon: '💰', label: 'Money', path: '/money', color: '#E8F5E9' },
  { icon: '📸', label: 'Content', path: '/content', color: '#F3F0FA' },
  { icon: '🧠', label: 'Smart Fill', path: '/smart-schedule', color: '#FCE4EC' },
  { icon: '🎁', label: 'Vouchers', path: '/vouchers', color: '#FFF8E1' },
  { icon: '⭐', label: 'Reviews', path: '/reviews', color: '#E8F5E9' },
];

function getSmartQuickActions(today) {
  const hour = new Date().getHours();
  const actions = [...DEFAULT_QUICK_ACTIONS];

  if (hour < 11) {
    const idx = actions.findIndex(a => a.path === '/vouchers');
    if (idx !== -1) actions[idx] = { icon: '☑️', label: 'Checklist', path: '/checklist', color: '#E8F5E9' };
  }

  if (hour >= 17) {
    const idx = actions.findIndex(a => a.path === '/smart-schedule');
    if (idx !== -1) actions[idx] = { icon: '🌙', label: 'Close Day', path: '/end-of-day', color: '#EDE7F6' };
  }

  if (today.length === 0 && hour >= 11 && hour < 17) {
    const idx = actions.findIndex(a => a.path === '/smart-schedule');
    if (idx !== -1) actions[idx] = { icon: '🔄', label: 'Rebook', path: '/rebook', color: '#FCE4EC' };
  }

  return actions;
}

// ─── Skeleton loader ───────────────────────────────────────
function Skeleton({ width, height, radius = 8, style: extra }) {
  return (
    <div style={{
      width, height, borderRadius: radius,
      background: 'var(--bg-subtle, #F5F2EF)',
      animation: 'shimmer 1.5s infinite',
      ...extra,
    }} />
  );
}

// ─── Agent card (for the AI Team strip) ────────────────────
function AgentCard({ agent, summary, navigate }) {
  const isActive = summary && summary.today > 0;
  return (
    <button
      onClick={() => navigate(agent.path)}
      style={S.agentCard}
    >
      <div style={S.agentIconWrap}>
        <span style={S.agentIcon}>{agent.icon}</span>
        <div style={{
          ...S.agentDot,
          background: isActive ? 'var(--success, #4CAF50)' : 'var(--text-muted, #CCC)',
        }} />
      </div>
      <span style={S.agentName}>{agent.name}</span>
      {summary ? (
        <span style={S.agentStat}>
          {summary.today > 0
            ? `${summary.today} action${summary.today > 1 ? 's' : ''} today`
            : 'Idle today'}
        </span>
      ) : (
        <span style={S.agentStat}>Ready</span>
      )}
    </button>
  );
}

// ─── Main Dashboard ────────────────────────────────────────
export default function Dashboard() {
  const { beautician, loading: bLoading } = useBeautician();
  const navigate = useNavigate();
  const [today, setToday] = useState([]);
  const [weeklyPulse, setWeeklyPulse] = useState({ income: 0, expenses: 0, profit: 0, incomeChange: null });
  const [insights, setInsights] = useState(isDevMode ? DEV_INSIGHTS : []);
  const [activity, setActivity] = useState(isDevMode ? DEV_ACTIVITY : []);
  const [agentSummary, setAgentSummary] = useState(isDevMode ? DEV_AGENT_SUMMARY : {});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (beautician) loadData();
  }, [beautician]);

  async function loadData() {
    setLoading(true);
    setError(null);
    if (isDevMode) {
      setToday(DEV_TODAY);
      setWeeklyPulse({ income: 38500, expenses: 4200, profit: 34300, incomeChange: 12 });
      setLoading(false);
      return;
    }
    try {
      const nowDate = new Date().toISOString().split('T')[0];

      // Today's appointments
      const { data: apptData } = await supabase
        .from('appointments')
        .select('*, clients(first_name, last_name), treatments(name, price_cents)')
        .eq('beautician_id', beautician.id)
        .gte('starts_at', nowDate + 'T00:00:00')
        .lte('starts_at', nowDate + 'T23:59:59')
        .order('starts_at', { ascending: true });
      setToday((apptData || []).map(a => ({
        id: a.id,
        time: new Date(a.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
        duration: a.duration_minutes,
        client: a.clients?.first_name || 'Client',
        treatment: a.treatments?.name || '',
        status: a.status,
        price_cents: a.treatments?.price_cents || 0,
      })));

      // Weekly revenue
      const now = new Date();
      const weekStart = new Date(now);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1);
      weekStart.setHours(0, 0, 0, 0);
      const lastWeekStart = new Date(weekStart);
      lastWeekStart.setDate(lastWeekStart.getDate() - 7);

      const [{ data: thisWeekTx }, { data: lastWeekTx }, { data: thisWeekExp }] = await Promise.all([
        supabase.from('transactions').select('amount_cents')
          .eq('beautician_id', beautician.id).eq('status', 'completed')
          .gte('created_at', weekStart.toISOString()),
        supabase.from('transactions').select('amount_cents')
          .eq('beautician_id', beautician.id).eq('status', 'completed')
          .gte('created_at', lastWeekStart.toISOString()).lt('created_at', weekStart.toISOString()),
        supabase.from('expenses').select('amount_cents')
          .eq('beautician_id', beautician.id)
          .gte('date', weekStart.toISOString().split('T')[0]),
      ]);

      const sumC = (arr) => (arr || []).reduce((s, r) => s + (r.amount_cents || 0), 0);
      const thisInc = sumC(thisWeekTx);
      const lastInc = sumC(lastWeekTx);
      const thisExp = sumC(thisWeekExp);
      const change = lastInc > 0 ? Math.round(((thisInc - lastInc) / lastInc) * 100) : null;
      setWeeklyPulse({ income: thisInc, expenses: thisExp, profit: thisInc - thisExp, incomeChange: change });

      // AI agent summary — what each agent did today
      try {
        const resp = await fetch(`/api/ai-actions/summary`, {
          headers: { 'Authorization': `Bearer ${(await supabase.auth.getSession()).data.session?.access_token}` },
        });
        if (resp.ok) {
          const summaryData = await resp.json();
          const mapped = {};
          if (summaryData.countByEmployee) {
            for (const row of summaryData.countByEmployee) {
              mapped[row.digital_employee] = {
                today: row.today_count || 0,
                latest: null,
              };
            }
          }
          if (summaryData.latestByEmployee) {
            for (const row of summaryData.latestByEmployee) {
              if (!mapped[row.digital_employee]) mapped[row.digital_employee] = { today: 0 };
              mapped[row.digital_employee].latest = row.summary || row.action_type;
            }
          }
          setAgentSummary(mapped);
        }
      } catch (e) {
        // Non-critical — agent strip just won't show counts
        logger.error('Agent summary fetch failed:', e);
      }

      // Generate insights from data
      const realInsights = [];
      if (change !== null && change > 0) {
        realInsights.push({ id: 'ri1', icon: '📈', text: `Revenue is up ${change}% this week compared to last.`, type: 'positive' });
      } else if (change !== null && change < -10) {
        realInsights.push({ id: 'ri1', icon: '📉', text: `Revenue is down ${Math.abs(change)}% vs last week. Worth sending some rebook reminders.`, type: 'action', actionLabel: 'View clients', actionPath: '/clients' });
      }
      const todayCount = (apptData || []).length;
      if (todayCount === 0) {
        realInsights.push({ id: 'ri2', icon: '📅', text: 'No appointments today. Good time to update your menu or reach out to clients.', type: 'neutral' });
      } else {
        const todayRevenue = (apptData || []).reduce((s, a) => s + (a.price_cents || 0), 0);
        realInsights.push({ id: 'ri2', icon: '💷', text: `${todayCount} appointment${todayCount > 1 ? 's' : ''} today, worth £${(todayRevenue / 100).toFixed(0)}.`, type: 'positive' });
      }
      if (realInsights.length > 0) setInsights(realInsights);

      // Activity feed — with agent attribution
      const { data: actions } = await supabase
        .from('ai_actions')
        .select('*')
        .eq('beautician_id', beautician.id)
        .order('created_at', { ascending: false })
        .limit(5);

      if (actions && actions.length > 0) {
        setActivity(actions.map(a => {
          const agentConfig = AGENTS.find(ag => ag.key === a.digital_employee);
          return {
            id: a.id,
            agent: a.digital_employee,
            icon: agentConfig?.icon || '✨',
            text: a.summary || a.action_type,
            time: timeAgo(new Date(a.created_at)),
          };
        }));
      }
    } catch (err) {
      logger.error('Dashboard load error:', err);
      setError(err.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  function timeAgo(date) {
    const mins = Math.round((Date.now() - date.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  }

  const todayRevenue = today.reduce((sum, a) => sum + (a.price_cents || 0), 0);
  const nextAppt = today.find(a => {
    const [h, m] = a.time.split(':').map(Number);
    const now = new Date();
    return (h > now.getHours()) || (h === now.getHours() && m > now.getMinutes());
  }) || today[0];

  const fmt = (cents) => `£${(cents / 100).toFixed(2)}`;
  const pendingCount = today.filter(a => a.status === 'pending').length;
  const smartActions = getSmartQuickActions(today);
  const totalAgentActions = Object.values(agentSummary).reduce((s, a) => s + (a?.today || 0), 0);
  const hasNoData = !loading && today.length === 0 && insights.length === 0 && activity.length === 0 && !isDevMode;

  if (loading) return <PageLoader />;

  return (
    <div style={S.page}>
      {error && <ErrorCard message={error} onDismiss={() => setError(null)} />}

      {/* Greeting */}
      <div style={S.greeting}>
        <div>
          <h1 style={S.greetingTitle}>
            {getGreeting()}{beautician ? `, ${beautician.first_name || ''}` : ''}
          </h1>
          <p style={S.greetingSubtitle}>
            {today.length > 0
              ? `${today.length} appointment${today.length > 1 ? 's' : ''} today`
              : 'No appointments today'}
            {totalAgentActions > 0 && ` · florrie.ai handled ${totalAgentActions} thing${totalAgentActions > 1 ? 's' : ''}`}
          </p>
        </div>
        <button onClick={() => navigate('/notifications')} style={S.bellBtn}>
          🔔
          <div style={S.bellDot} />
        </button>
      </div>

      {/* Spotlight search */}
      <div style={{ marginBottom: 14 }}>
        <SpotlightSearch />
      </div>

      {/* Welcome card for new users */}
      {hasNoData && !loading && (
        <div style={S.welcomeCard}>
          <span style={{ fontSize: 32, marginBottom: 8 }}>👋</span>
          <h2 style={S.welcomeTitle}>Welcome to florrie.ai</h2>
          <p style={S.welcomeDesc}>
            Your dashboard will come alive as you add clients, book appointments, and let florrie.ai work for you.
          </p>
          <div style={S.welcomeActions}>
            <button onClick={() => navigate('/treatments')} style={S.welcomeBtn}>💅 Add your treatments</button>
            <button onClick={() => navigate('/import')} style={S.welcomeBtn}>📥 Import clients</button>
            <button onClick={() => navigate('/business')} style={S.welcomeBtn}>🏪 Set up your profile</button>
            <button onClick={() => navigate('/hours')} style={S.welcomeBtn}>🕐 Set working hours</button>
          </div>
        </div>
      )}

      {/* Next Client Hero */}
      {!loading && nextAppt && (
        <div style={S.heroCard}>
          <div style={S.heroHeader}>
            <span style={S.heroLabel}>Next up</span>
            <span style={S.heroTime}>{nextAppt.time}</span>
          </div>
          <div style={S.heroBody}>
            <div style={S.heroAvatar}>{nextAppt.client[0]}</div>
            <div style={S.heroInfo}>
              <span style={S.heroName}>{nextAppt.client}</span>
              <span style={S.heroTreatment}>{nextAppt.treatment}</span>
              <span style={S.heroDuration}>{nextAppt.duration}min · {fmt(nextAppt.price_cents)}</span>
            </div>
          </div>
          {today.length > 1 && (
            <div style={S.heroFooter}>
              + {today.length - 1} more today · {fmt(todayRevenue)} projected
            </div>
          )}
        </div>
      )}

      {/* ─── YOUR AI TEAM ─────────────────────────────── */}
      {!loading && (
        <div style={S.teamSection}>
          <div style={S.teamHeader}>
            <h3 style={S.sectionTitle}>Your AI team</h3>
            {totalAgentActions > 0 && (
              <span style={S.teamBadge}>{totalAgentActions} actions today</span>
            )}
          </div>
          <div style={S.teamGrid}>
            {AGENTS.map(agent => (
              <AgentCard
                key={agent.key}
                agent={agent}
                summary={agentSummary[agent.key]}
                navigate={navigate}
              />
            ))}
          </div>
        </div>
      )}

      {/* Today's Schedule */}
      {!loading && today.length > 0 && (
        <div style={S.scheduleCard}>
          <div style={S.scheduleHeader}>
            <span style={S.scheduleTitle}>Today's schedule</span>
            <button onClick={() => navigate('/calendar')} style={S.seeAllBtn}>See all</button>
          </div>
          {today.map((appt, i) => {
            const isPast = (() => {
              const [h, m] = appt.time.split(':').map(Number);
              const now = new Date();
              return h < now.getHours() || (h === now.getHours() && m < now.getMinutes());
            })();
            return (
              <div key={appt.id} style={{ ...S.scheduleRow, opacity: isPast ? 0.5 : 1 }}>
                <span style={S.scheduleTime}>{appt.time}</span>
                <div style={S.scheduleLine}>
                  <div style={{
                    ...S.scheduleDot,
                    background: appt.status === 'confirmed' ? 'var(--success, #4CAF50)' : appt.status === 'pending' ? 'var(--warning, #FF9800)' : 'var(--text-muted, #AAA5A0)',
                  }} />
                  {i < today.length - 1 && <div style={S.scheduleConnector} />}
                </div>
                <div style={S.scheduleDetail}>
                  <span style={S.scheduleClient}>{appt.client}</span>
                  <span style={S.scheduleTreatment}>
                    {appt.treatment} · {appt.duration}min
                    {appt.status === 'pending' && <span style={S.pendingTag}> · Unconfirmed</span>}
                  </span>
                </div>
                <span style={S.schedulePrice}>{fmt(appt.price_cents)}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Revenue Pulse */}
      {!loading && (
        <div style={S.pulseRow}>
          <button onClick={() => navigate('/money')} style={S.pulseCard}>
            <span style={S.pulseLabel}>Today</span>
            <span style={S.pulseValue}>{fmt(todayRevenue)}</span>
          </button>
          <button onClick={() => navigate('/money')} style={S.pulseCard}>
            <span style={S.pulseLabel}>This week</span>
            <span style={S.pulseValue}>{fmt(weeklyPulse.income)}</span>
            {weeklyPulse.incomeChange !== null && (
              <span style={{ fontSize: 10, color: weeklyPulse.incomeChange >= 0 ? 'var(--success, #4CAF50)' : 'var(--danger, #E57373)', fontWeight: 600 }}>
                {weeklyPulse.incomeChange >= 0 ? '↑' : '↓'} {Math.abs(weeklyPulse.incomeChange)}%
              </span>
            )}
          </button>
          <button onClick={() => navigate('/calendar')} style={S.pulseCard}>
            <span style={S.pulseLabel}>Unconfirmed</span>
            <span style={{
              ...S.pulseValue,
              color: pendingCount > 0 ? 'var(--warning, #FF9800)' : 'var(--success, #4CAF50)',
            }}>
              {pendingCount}
            </span>
            {pendingCount > 0 && (
              <span style={{ fontSize: 9, color: 'var(--warning, #FF9800)', fontWeight: 500 }}>
                Chase?
              </span>
            )}
          </button>
        </div>
      )}

      {/* Quick Actions */}
      <div style={S.quickGrid}>
        {smartActions.map(action => (
          <button key={action.path} onClick={() => navigate(action.path)} style={S.quickBtn}>
            <div style={{ ...S.quickIcon, background: action.color }}>{action.icon}</div>
            <span style={S.quickLabel}>{action.label}</span>
          </button>
        ))}
      </div>

      {/* AI Insights */}
      {!loading && insights.length > 0 && (
        <div style={S.insightsSection}>
          <h3 style={S.sectionTitle}>florrie.ai's insights</h3>
          {insights.map(insight => (
            <div key={insight.id} style={{
              ...S.insightCard,
              borderLeft: `3px solid ${insight.type === 'positive' ? 'var(--success, #4CAF50)' : insight.type === 'warning' ? 'var(--warning, #FF9800)' : 'var(--accent, #C76B8A)'}`,
            }}>
              <span style={S.insightIcon}>{insight.icon}</span>
              <div style={S.insightBody}>
                <span style={S.insightText}>{insight.text}</span>
                {insight.actionLabel && (
                  <button onClick={() => navigate(insight.actionPath)} style={S.insightBtn}>
                    {insight.actionLabel}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Activity Feed — agent-attributed */}
      {!loading && activity.length > 0 && (
        <div style={S.activitySection}>
          <div style={S.activityHeader}>
            <h3 style={S.sectionTitle}>Recent activity</h3>
            <button onClick={() => navigate('/ai-insights')} style={S.seeAllBtn}>View all</button>
          </div>
          {activity.map(act => {
            const agentConfig = AGENTS.find(ag => ag.key === act.agent);
            const actPath = act.icon === '💬' ? '/inbox'
              : act.icon === '📅' ? '/calendar'
              : act.icon === '💰' ? '/money'
              : act.icon === '📸' ? '/content'
              : act.icon === '🔄' ? '/clients'
              : null;

            const inner = (
              <>
                <div style={S.activityLeft}>
                  <span style={S.activityIcon}>{act.icon}</span>
                  {agentConfig && <span style={S.activityAgent}>{agentConfig.name}</span>}
                </div>
                <span style={S.activityText}>{act.text}</span>
                <span style={S.activityTime}>{act.time}</span>
              </>
            );

            return actPath ? (
              <button key={act.id} onClick={() => navigate(actPath)} style={S.activityRowBtn}>
                {inner}
              </button>
            ) : (
              <div key={act.id} style={S.activityRow}>
                {inner}
              </div>
            );
          })}
        </div>
      )}

      {/* Booking link */}
      {beautician?.booking_slug && (
        <button onClick={() => {
          const url = `${window.location.origin}/book/${beautician.booking_slug}`;
          if (navigator.share) {
            navigator.share({ title: 'Book an appointment', url });
          } else {
            navigator.clipboard.writeText(url);
          }
        }} style={S.shareBtn}>
          🔗 Share your booking link
        </button>
      )}
    </div>
  );
}

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

// ─── Styles ────────────────────────────────────────────────
const S = {
  page: {
    minHeight: '100vh',
    background: 'var(--bg, #FAF8F5)',
    fontFamily: "var(--font-body, 'DM Sans', -apple-system, sans-serif)",
    padding: '0 16px 40px',
    maxWidth: 480,
    margin: '0 auto',
    color: 'var(--text-primary, #2D2A26)',
    animation: 'fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
  },

  // Greeting
  greeting: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 28, paddingBottom: 8 },
  greetingTitle: {
    fontSize: 24, fontWeight: 600, margin: '0 0 3px',
    letterSpacing: '-0.02em',
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
    color: 'var(--text-primary)',
  },
  greetingSubtitle: { fontSize: 13, color: 'var(--accent, #C76B8A)', margin: 0, fontWeight: 500 },
  bellBtn: {
    width: 42, height: 42, borderRadius: 21,
    border: '1px solid var(--border, #EDE9E4)',
    background: 'var(--bg-card, #fff)',
    fontSize: 18, cursor: 'pointer', position: 'relative',
    boxShadow: 'var(--shadow-sm)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  bellDot: { width: 7, height: 7, borderRadius: 4, background: 'var(--accent, #C76B8A)', position: 'absolute', top: 7, right: 7, border: '2px solid var(--bg-card, #fff)' },

  // Hero
  heroCard: {
    background: 'linear-gradient(135deg, #C76B8A 0%, #B85D7B 45%, #C9A96E 100%)',
    borderRadius: 20, padding: 20, marginBottom: 14, color: '#fff',
    boxShadow: '0 8px 24px rgba(199, 107, 138, 0.2)',
  },
  heroHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  heroLabel: { fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em', opacity: 0.85 },
  heroTime: { fontSize: 13, fontWeight: 600, background: 'rgba(255,255,255,0.2)', borderRadius: 20, padding: '4px 14px', backdropFilter: 'blur(8px)' },
  heroBody: { display: 'flex', gap: 14, alignItems: 'center' },
  heroAvatar: {
    width: 48, height: 48, borderRadius: 16,
    background: 'rgba(255,255,255,0.2)', backdropFilter: 'blur(8px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 18, fontWeight: 700, flexShrink: 0,
    border: '1.5px solid rgba(255,255,255,0.25)',
  },
  heroInfo: { display: 'flex', flexDirection: 'column', gap: 2 },
  heroName: { fontSize: 18, fontWeight: 700, fontFamily: "var(--font-display, 'Playfair Display', serif)" },
  heroTreatment: { fontSize: 13, opacity: 0.9 },
  heroDuration: { fontSize: 11, opacity: 0.7, fontFamily: "var(--font-mono, 'DM Mono', monospace)" },
  heroFooter: { fontSize: 12, opacity: 0.7, marginTop: 12, textAlign: 'center', borderTop: '1px solid rgba(255,255,255,0.15)', paddingTop: 10 },

  // AI Team strip
  teamSection: { marginBottom: 16 },
  teamHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  teamBadge: {
    fontSize: 10, fontWeight: 600, color: 'var(--success, #4CAF50)',
    background: 'rgba(76, 175, 80, 0.08)',
    padding: '3px 10px', borderRadius: 20,
  },
  teamGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8,
  },
  agentCard: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
    padding: '12px 6px 10px', borderRadius: 14,
    border: '1px solid var(--border, #EDE9E4)',
    background: 'var(--bg-card, #fff)',
    cursor: 'pointer', fontFamily: 'inherit',
    boxShadow: 'var(--shadow-xs)',
    WebkitTapHighlightColor: 'transparent',
    transition: 'transform 0.1s',
  },
  agentIconWrap: { position: 'relative', width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  agentIcon: { fontSize: 20 },
  agentDot: {
    position: 'absolute', top: -2, right: -4,
    width: 8, height: 8, borderRadius: 4,
    border: '2px solid var(--bg-card, #fff)',
  },
  agentName: { fontSize: 11, fontWeight: 600, color: 'var(--text-primary)' },
  agentStat: { fontSize: 9, color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.3 },

  // Schedule
  scheduleCard: {
    background: 'var(--bg-card, #fff)',
    borderRadius: 16, padding: 16,
    boxShadow: 'var(--shadow-sm)',
    border: '1px solid var(--border, #EDE9E4)',
    marginBottom: 14,
  },
  scheduleHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  scheduleTitle: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' },
  seeAllBtn: { fontSize: 12, color: 'var(--accent, #C76B8A)', fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' },
  scheduleRow: { display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 4 },
  scheduleTime: { fontSize: 12, fontWeight: 500, color: 'var(--text-muted)', width: 40, flexShrink: 0, paddingTop: 2, fontFamily: "var(--font-mono, 'DM Mono', monospace)" },
  scheduleLine: { display: 'flex', flexDirection: 'column', alignItems: 'center', width: 12, flexShrink: 0, paddingTop: 4 },
  scheduleDot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  scheduleConnector: { width: 1.5, height: 28, background: 'var(--border, #EDE9E4)', marginTop: 2 },
  scheduleDetail: { flex: 1, display: 'flex', flexDirection: 'column', gap: 1, paddingBottom: 8 },
  scheduleClient: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' },
  scheduleTreatment: { fontSize: 11, color: 'var(--text-muted)' },
  schedulePrice: { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', flexShrink: 0, paddingTop: 2, fontFamily: "var(--font-mono, 'DM Mono', monospace)" },
  pendingTag: { color: 'var(--warning, #FF9800)', fontWeight: 600 },

  // Revenue pulse
  pulseRow: { display: 'flex', gap: 10, marginBottom: 16 },
  pulseCard: {
    flex: 1, background: 'var(--bg-card, #fff)', borderRadius: 14,
    padding: '14px 10px', textAlign: 'center',
    boxShadow: 'var(--shadow-xs)',
    border: '1px solid var(--border, #EDE9E4)',
    cursor: 'pointer', fontFamily: 'inherit',
    WebkitTapHighlightColor: 'transparent',
    transition: 'transform 0.1s, box-shadow 0.15s',
  },
  pulseLabel: { display: 'block', fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 },
  pulseValue: { display: 'block', fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' },

  // Quick actions
  quickGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 22 },
  quickBtn: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5,
    padding: '12px 0', borderRadius: 14, border: '1px solid var(--border-light, #F5F2EF)',
    background: 'var(--bg-card, #fff)', cursor: 'pointer', fontFamily: 'inherit',
    boxShadow: 'var(--shadow-xs)',
  },
  quickIcon: { width: 38, height: 38, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17 },
  quickLabel: { fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)' },

  // Insights
  insightsSection: { marginBottom: 22 },
  sectionTitle: {
    fontSize: 15, fontWeight: 600, margin: '0 0 10px',
    color: 'var(--text-primary)',
    fontFamily: "var(--font-display, 'Playfair Display', serif)",
  },
  insightCard: {
    display: 'flex', alignItems: 'flex-start', gap: 10,
    padding: '12px 14px',
    background: 'var(--bg-card, #fff)',
    borderRadius: 14, marginBottom: 8,
    boxShadow: 'var(--shadow-xs)',
    border: '1px solid var(--border, #EDE9E4)',
  },
  insightIcon: { fontSize: 16, flexShrink: 0, paddingTop: 1 },
  insightBody: { flex: 1 },
  insightText: { display: 'block', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55 },
  insightBtn: {
    marginTop: 8, padding: '6px 14px', borderRadius: 8, border: 'none',
    background: 'var(--accent-light, #FFF0F3)', color: 'var(--accent, #C76B8A)',
    fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
  },

  // Activity
  activitySection: { marginBottom: 22 },
  activityHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  activityRow: { display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--border-light, #F5F2EF)' },
  activityRowBtn: {
    display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 0',
    borderBottom: '1px solid var(--border-light, #F5F2EF)',
    background: 'none', border: 'none', width: '100%', cursor: 'pointer',
    fontFamily: 'inherit', textAlign: 'left',
    WebkitTapHighlightColor: 'transparent',
  },
  activityLeft: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, flexShrink: 0, width: 42 },
  activityIcon: { fontSize: 14 },
  activityAgent: { fontSize: 8, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' },
  activityText: { flex: 1, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.45 },
  activityTime: { fontSize: 10, color: 'var(--text-muted)', flexShrink: 0, whiteSpace: 'nowrap' },

  // Share
  shareBtn: {
    width: '100%', padding: '12px 0', borderRadius: 14,
    border: '1.5px dashed rgba(199,107,138,0.25)',
    background: 'var(--accent-light, #FFF0F3)',
    color: 'var(--accent, #C76B8A)',
    fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
  },

  // Welcome
  welcomeCard: {
    background: 'var(--bg-card, #fff)',
    borderRadius: 20, padding: '28px 20px',
    border: '1px solid var(--border, #EDE9E4)',
    boxShadow: 'var(--shadow-md)',
    textAlign: 'center', marginBottom: 16,
  },
  welcomeTitle: {
    fontSize: 20, fontWeight: 600, margin: '0 0 8px',
    fontFamily: "var(--font-display, 'Playfair Display', serif)",
    color: 'var(--text-primary)',
  },
  welcomeDesc: {
    fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6,
    margin: '0 0 20px', maxWidth: 320, marginLeft: 'auto', marginRight: 'auto',
  },
  welcomeActions: { display: 'flex', flexDirection: 'column', gap: 8 },
  welcomeBtn: {
    width: '100%', padding: '12px 16px', borderRadius: 12,
    border: '1px solid var(--border, #EDE9E4)',
    background: 'var(--bg-subtle, #F9F7F4)',
    fontSize: 14, fontWeight: 500, cursor: 'pointer',
    fontFamily: 'inherit', textAlign: 'left',
    color: 'var(--text-primary)',
    WebkitTapHighlightColor: 'transparent',
    transition: 'background 0.12s',
  },
};
