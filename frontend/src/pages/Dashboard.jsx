import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBeautician, supabase, isDevMode } from '../lib/supabase.js';
import logger from '../lib/logger.js';
import SpotlightSearch from '../components/SpotlightSearch.jsx';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';

/**
 * Dashboard — Stitch "Design System" reference rebuild.
 *
 * Matches the Stitch Home screen:
 *   - Greeting + date
 *   - Hero Stats Card (gradient, today's forecast)
 *   - Alert Cards (pending / retain)
 *   - AI Insight card
 *   - Today's Schedule (completed/active/upcoming)
 *   - Activity Feed
 *
 * All business logic preserved from v3.
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
  { id: 'a1', time: '09:00', duration: 60, client: 'Sarah Jenkins', treatment: 'Root Touch-up', status: 'completed', price_cents: 8500 },
  { id: 'a2', time: '11:30', duration: 90, client: 'Marcus Thorne', treatment: 'Full Creative Color & Cut', status: 'confirmed', price_cents: 24000 },
  { id: 'a3', time: '14:00', duration: 45, client: 'Lena Rivera', treatment: 'Gloss & Blowout', status: 'confirmed', price_cents: 11000 },
  { id: 'a4', time: '15:30', duration: 60, client: 'Megan R', treatment: 'HD Brows', status: 'pending', price_cents: 2500 },
];

const DEV_AGENT_SUMMARY = {
  front_desk: { today: 3, latest: 'Confirmed Marcus\'s 11:30 booking' },
  calendar: { today: 1, latest: 'Filled a gap at 2pm with Lena' },
  comeback: { today: 2, latest: 'Nudged Daisy S — 12 days overdue' },
  content: { today: 1, latest: 'Drafted "Tuesday transformation"' },
  money: { today: 1, latest: '£85 payment logged from Sarah' },
  scout: { today: 0, latest: 'Balayage trending +18% this month' },
};

const DEV_INSIGHTS = [
  { id: 'i1', icon: 'trending_up', text: "You're on track for £385 this week — 12% up on last week.", type: 'positive' },
  { id: 'i2', icon: 'history', text: 'Daisy S is 12 days overdue for her usual rebook. Send a nudge?', type: 'action', actionLabel: 'Send nudge', actionPath: '/clients' },
  { id: 'i3', icon: 'star', text: 'Jasmin left a 5★ review yesterday. florrie.ai drafted a reply.', type: 'action', actionLabel: 'View reply', actionPath: '/reviews' },
];

const DEV_ACTIVITY = [
  { id: 'act1', agent: 'scout', icon: '✨', text: 'New 5-star review from Chloe B.', time: '12m ago' },
  { id: 'act2', agent: 'money', icon: '💰', text: 'Payout of £840.00 initiated', time: '2h ago' },
  { id: 'act3', agent: 'calendar', icon: '📅', text: 'Megan R booked HD Brows for today 3:30pm', time: '3h ago' },
];

// ─── Material Icon helper ──────────────────────────────────
function MIcon({ name, fill, size, style }) {
  return (
    <span
      className="material-symbols-outlined"
      style={{
        fontSize: size || 24,
        fontVariationSettings: fill ? "'FILL' 1, 'wght' 300" : undefined,
        ...style,
      }}
    >
      {name}
    </span>
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
      setWeeklyPulse({ income: 142000, expenses: 12000, profit: 130000, incomeChange: 14 });
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
        client: a.clients ? `${a.clients.first_name || ''} ${a.clients.last_name || ''}`.trim() : 'Client',
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

      // AI agent summary
      try {
        const resp = await fetch(`/api/ai-actions/summary`, {
          headers: { 'Authorization': `Bearer ${(await supabase.auth.getSession()).data.session?.access_token}` },
        });
        if (resp.ok) {
          const summaryData = await resp.json();
          const mapped = {};
          if (summaryData.countByEmployee) {
            for (const row of summaryData.countByEmployee) {
              mapped[row.digital_employee] = { today: row.today_count || 0, latest: null };
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
        logger.error('Agent summary fetch failed:', e);
      }

      // Generate insights from data
      const realInsights = [];
      if (change !== null && change > 0) {
        realInsights.push({ id: 'ri1', icon: 'trending_up', text: `Revenue is up ${change}% this week compared to last.`, type: 'positive' });
      } else if (change !== null && change < -10) {
        realInsights.push({ id: 'ri1', icon: 'trending_down', text: `Revenue is down ${Math.abs(change)}% vs last week. Worth sending some rebook reminders.`, type: 'action', actionLabel: 'View clients', actionPath: '/clients' });
      }
      const todayCount = (apptData || []).length;
      if (todayCount === 0) {
        realInsights.push({ id: 'ri2', icon: 'calendar_today', text: 'No appointments today. Good time to update your menu or reach out to clients.', type: 'neutral' });
      } else {
        const todayRevenue = (apptData || []).reduce((s, a) => s + (a.price_cents || 0), 0);
        realInsights.push({ id: 'ri2', icon: 'payments', text: `${todayCount} appointment${todayCount > 1 ? 's' : ''} today, worth £${(todayRevenue / 100).toFixed(0)}.`, type: 'positive' });
      }
      if (realInsights.length > 0) setInsights(realInsights);

      // Activity feed
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
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  }

  const todayRevenue = today.reduce((sum, a) => sum + (a.price_cents || 0), 0);
  const completedCount = today.filter(a => a.status === 'completed').length;
  const pendingCount = today.filter(a => a.status === 'pending').length;
  const remainingCount = today.length - completedCount;
  const fmt = (cents) => `£${(cents / 100).toFixed(2)}`;

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-GB', { weekday: 'long', month: 'short', day: 'numeric' });

  if (loading || bLoading) return <PageLoader />;

  // Find currently active appointment
  const activeIdx = today.findIndex(a => {
    if (a.status === 'completed') return false;
    const [h, m] = a.time.split(':').map(Number);
    const apptTime = new Date();
    apptTime.setHours(h, m, 0, 0);
    const endTime = new Date(apptTime.getTime() + (a.duration || 60) * 60000);
    return now >= apptTime && now < endTime;
  });

  // First AI insight for the card
  const topInsight = insights[0];

  return (
    <div style={S.page}>
      {error && <ErrorCard message={error} onDismiss={() => setError(null)} />}

      {/* ─── Greeting ─── */}
      <section style={S.greetingSection}>
        <p style={S.dateLabel}>{dateStr}</p>
        <h1 style={S.greeting}>
          {getGreeting()}, {beautician?.first_name || 'there'}
        </h1>
      </section>

      {/* ─── Hero Stats Card ─── */}
      <section style={S.heroCard}>
        <div style={S.heroDecor} />
        <div style={{ position: 'relative', zIndex: 1 }}>
          <div style={S.heroTop}>
            <div>
              <p style={S.heroLabel}>Today's Forecast</p>
              <h2 style={S.heroValue}>{fmt(todayRevenue)}</h2>
            </div>
            <MIcon name="trending_up" style={{ color: 'rgba(255,255,255,0.4)' }} size={28} />
          </div>
          <div style={S.heroDivider} />
          <div style={S.heroStats}>
            <div style={S.heroStat}>
              <p style={S.heroStatLabel}>Appointments</p>
              <p style={S.heroStatValue}>{today.length}</p>
            </div>
            <div style={S.heroStat}>
              <p style={S.heroStatLabel}>Completed</p>
              <p style={S.heroStatValue}>{completedCount}</p>
            </div>
            <div style={S.heroStat}>
              <p style={S.heroStatLabel}>Remaining</p>
              <p style={S.heroStatValue}>{remainingCount}</p>
            </div>
          </div>
        </div>
      </section>

      {/* ─── Alert Cards ─── */}
      <section style={S.alertGrid}>
        {pendingCount > 0 && (
          <button onClick={() => navigate('/calendar')} style={S.alertCard('#fedb9b', '#745a27', '#795f2b')}>
            <div style={S.alertTop}>
              <MIcon name="pending_actions" size={14} style={{ color: '#795f2b' }} />
              <span style={S.alertBadge('#795f2b')}>Pending</span>
            </div>
            <p style={{ fontSize: 14, fontWeight: 500, color: '#745a27', margin: 0 }}>
              {pendingCount} unconfirmed
            </p>
          </button>
        )}
        {insights.some(i => i.type === 'action' && i.actionPath === '/clients') && (
          <button onClick={() => navigate('/clients')} style={S.alertCard('#ffd9e2', '#92405e', '#782b49')}>
            <div style={S.alertTop}>
              <MIcon name="history" size={14} style={{ color: '#92405e' }} />
              <span style={S.alertBadge('#92405e')}>Retain</span>
            </div>
            <p style={{ fontSize: 14, fontWeight: 500, color: '#782b49', margin: 0 }}>
              3 overdue rebookings
            </p>
          </button>
        )}
        {pendingCount === 0 && !insights.some(i => i.type === 'action' && i.actionPath === '/clients') && (
          <>
            <div style={S.alertCard('#fedb9b', '#745a27', '#795f2b')}>
              <div style={S.alertTop}>
                <MIcon name="check_circle" size={14} style={{ color: '#795f2b' }} />
                <span style={S.alertBadge('#795f2b')}>Status</span>
              </div>
              <p style={{ fontSize: 14, fontWeight: 500, color: '#745a27', margin: 0 }}>All confirmed</p>
            </div>
            <div style={S.alertCard('#ffd9e2', '#92405e', '#782b49')}>
              <div style={S.alertTop}>
                <MIcon name="schedule" size={14} style={{ color: '#92405e' }} />
                <span style={S.alertBadge('#92405e')}>Next</span>
              </div>
              <p style={{ fontSize: 14, fontWeight: 500, color: '#782b49', margin: 0 }}>
                {today.length > 0 ? today.find(a => a.status !== 'completed')?.time || 'Done' : 'Free day'}
              </p>
            </div>
          </>
        )}
      </section>

      {/* ─── AI Insight ─── */}
      {topInsight && (
        <section style={S.insightCard}>
          <div style={S.insightIconWrap}>
            <MIcon name="auto_awesome" fill size={22} style={{ color: '#745a27' }} />
          </div>
          <div>
            <p style={S.insightLabel}>Florrie Insight</p>
            <p style={S.insightText}>"{topInsight.text}"</p>
          </div>
        </section>
      )}

      {/* ─── Today's Schedule ─── */}
      <section style={S.scheduleSection}>
        <div style={S.scheduleHeader}>
          <h3 style={S.sectionHeading}>Today's Schedule</h3>
          <button onClick={() => navigate('/calendar')} style={S.viewAllBtn}>View All</button>
        </div>

        {today.length === 0 ? (
          <EmptyState message="No appointments today" icon="📅" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {today.map((appt, i) => {
              const isPast = appt.status === 'completed';
              const isActive = i === activeIdx;
              const isNow = isActive;

              return (
                <div key={appt.id} style={{ display: 'flex', alignItems: 'center', gap: 12, opacity: isPast ? 0.4 : 1 }}>
                  {/* Time */}
                  <span style={{
                    width: 48, fontSize: 12, fontWeight: isActive ? 700 : 400,
                    color: isActive ? '#92405e' : '#867277',
                    fontFamily: "var(--font-body)",
                  }}>
                    {appt.time}
                  </span>

                  {/* Card */}
                  <div style={{
                    flex: 1,
                    background: isActive ? '#FFFFFF' : isPast ? '#ede7e3' : '#f8f2ef',
                    padding: '14px 16px',
                    borderRadius: 16,
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    borderLeft: isActive ? '4px solid #745a27' : '4px solid transparent',
                    boxShadow: isActive ? '0 4px 20px rgba(146, 64, 94, 0.08)' : 'none',
                  }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                        <p style={{ fontSize: 14, fontWeight: 700, margin: 0, color: '#1d1b19' }}>{appt.client}</p>
                        {isNow && (
                          <span style={{
                            background: '#745a27', color: '#fff', fontSize: 8, fontWeight: 700,
                            padding: '2px 6px', borderRadius: 999, textTransform: 'uppercase', letterSpacing: '0.05em',
                          }}>Now</span>
                        )}
                      </div>
                      <p style={{ fontSize: 12, color: '#534247', margin: 0 }}>{appt.treatment}</p>
                    </div>
                    <span style={{
                      fontSize: 14, fontWeight: isActive ? 700 : 500,
                      color: isActive ? '#92405e' : '#1d1b19',
                    }}>
                      {fmt(appt.price_cents)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ─── Activity Feed ─── */}
      {activity.length > 0 && (
        <section style={{ paddingTop: 8 }}>
          <h3 style={S.activityLabel}>Recent Activity</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {activity.map(act => (
              <div key={act.id} style={S.activityRow}>
                <span style={{ fontSize: 18 }}>{act.icon}</span>
                <div style={{ flex: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <p style={{ fontSize: 12, color: '#1d1b19', margin: 0 }}>{act.text}</p>
                  <span style={{ fontSize: 10, color: '#534247', whiteSpace: 'nowrap', marginLeft: 8 }}>{act.time}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ─── Booking Link ─── */}
      {beautician?.booking_slug && (
        <button onClick={() => {
          const url = `${window.location.origin}/book/${beautician.booking_slug}`;
          if (navigator.share) {
            navigator.share({ title: 'Book an appointment', url });
          } else {
            navigator.clipboard.writeText(url);
          }
        }} style={S.shareBtn}>
          <MIcon name="link" size={16} style={{ color: '#92405e' }} />
          Share your booking link
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

// ─── Styles — matching Stitch "Design System" (Home) reference ───
const S = {
  page: {
    minHeight: '100vh',
    background: '#fef8f4',
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)",
    padding: '0 24px 120px',
    maxWidth: 480,
    margin: '0 auto',
    color: '#1d1b19',
    animation: 'fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
  },

  // Greeting
  greetingSection: { paddingTop: 32, marginBottom: 32 },
  dateLabel: {
    fontFamily: "var(--font-sans, 'DM Sans', sans-serif)",
    fontSize: 14, color: 'rgba(83, 66, 71, 0.7)', margin: '0 0 4px',
    textTransform: 'uppercase', letterSpacing: '0.12em',
  },
  greeting: {
    fontFamily: "var(--font-display, 'Playfair Display', serif)",
    fontSize: 36, fontWeight: 700, fontStyle: 'italic',
    color: '#92405e', margin: 0, lineHeight: 1.1,
  },

  // Hero stats card
  heroCard: {
    position: 'relative', overflow: 'hidden',
    background: 'linear-gradient(135deg, #c76b8a 0%, #92405e 100%)',
    borderRadius: 24, padding: 24, color: '#fff', marginBottom: 16,
    boxShadow: '0 8px 32px rgba(146, 64, 94, 0.2)',
  },
  heroDecor: {
    position: 'absolute', right: -32, bottom: -32,
    width: 128, height: 128,
    background: 'rgba(255,255,255,0.1)',
    borderRadius: '50%', filter: 'blur(40px)',
  },
  heroTop: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
  },
  heroLabel: {
    fontSize: 12, opacity: 0.8, textTransform: 'uppercase', letterSpacing: '0.12em',
    marginBottom: 4, fontFamily: "var(--font-sans, 'DM Sans')", margin: '0 0 4px',
  },
  heroValue: {
    fontSize: 30, fontFamily: "var(--font-display, 'Playfair Display')",
    fontStyle: 'italic', margin: 0, fontWeight: 400,
  },
  heroDivider: {
    borderTop: '1px solid rgba(255,255,255,0.1)',
    margin: '20px 0 16px',
  },
  heroStats: { display: 'flex', justifyContent: 'space-between' },
  heroStat: { textAlign: 'center' },
  heroStatLabel: { fontSize: 12, opacity: 0.6, margin: '0 0 4px' },
  heroStatValue: { fontSize: 18, fontWeight: 700, margin: 0 },

  // Alert cards
  alertGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 24 },
  alertCard: (bg, accent, text) => ({
    background: `${bg}20`,
    padding: 16, borderRadius: 16,
    border: `1px solid ${bg}30`,
    display: 'flex', flexDirection: 'column', gap: 8,
    cursor: 'pointer', fontFamily: 'inherit',
    textAlign: 'left',
    WebkitTapHighlightColor: 'transparent',
  }),
  alertTop: { display: 'flex', alignItems: 'center', gap: 6 },
  alertBadge: (color) => ({
    fontSize: 10, fontWeight: 700,
    textTransform: 'uppercase', letterSpacing: '0.1em',
    color,
  }),

  // AI Insight card
  insightCard: {
    background: 'rgba(243, 223, 211, 0.4)',
    padding: 20, borderRadius: 24,
    border: '1px solid rgba(116, 90, 39, 0.1)',
    display: 'flex', alignItems: 'flex-start', gap: 16,
    marginBottom: 32, position: 'relative', overflow: 'hidden',
  },
  insightIconWrap: {
    background: '#fff', padding: 8, borderRadius: 12,
    boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  insightLabel: {
    fontSize: 10, fontWeight: 700, color: '#745a27',
    textTransform: 'uppercase', letterSpacing: '0.12em',
    margin: '0 0 4px',
  },
  insightText: {
    fontSize: 14, color: 'rgba(116, 90, 39, 0.9)',
    lineHeight: 1.5, fontStyle: 'italic', margin: 0,
  },

  // Schedule section
  scheduleSection: { marginBottom: 32 },
  scheduleHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 20,
  },
  sectionHeading: {
    fontFamily: "var(--font-display, 'Playfair Display', serif)",
    fontSize: 22, fontWeight: 400, fontStyle: 'italic',
    color: '#1d1b19', margin: 0,
  },
  viewAllBtn: {
    fontSize: 12, fontWeight: 700, color: '#92405e',
    textTransform: 'uppercase', letterSpacing: '0.1em',
    background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
  },

  // Activity feed
  activityLabel: {
    fontFamily: "var(--font-sans, 'DM Sans')",
    fontSize: 10, fontWeight: 700, color: '#534247',
    textTransform: 'uppercase', letterSpacing: '0.2em',
    margin: '0 0 12px',
  },
  activityRow: {
    display: 'flex', alignItems: 'center', gap: 12,
  },

  // Share button
  shareBtn: {
    width: '100%', padding: '14px 0', borderRadius: 16, marginTop: 24,
    border: '1.5px dashed rgba(146, 64, 94, 0.25)',
    background: 'rgba(255, 217, 226, 0.2)',
    color: '#92405e', fontSize: 14, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
};
