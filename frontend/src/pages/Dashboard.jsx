import { useState, useEffect, useMemo } from 'react';
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

// ── Shift Report mock data ──
const DEV_SHIFT_REPORT = [
  { id: 'sr1', category: 'message', agent: 'front_desk', summary: 'Confirmed Marcus\'s 11:30 booking via WhatsApp', value_cents: 0, created_at: new Date(Date.now() - 45 * 60000).toISOString() },
  { id: 'sr2', category: 'message', agent: 'front_desk', summary: 'Replied to Instagram DM from new enquiry — booked Friday 10am', value_cents: 4500, created_at: new Date(Date.now() - 90 * 60000).toISOString() },
  { id: 'sr3', category: 'message', agent: 'front_desk', summary: 'Sent aftercare tips to Sarah after her appointment', value_cents: 0, created_at: new Date(Date.now() - 120 * 60000).toISOString() },
  { id: 'sr4', category: 'booking', agent: 'calendar', summary: 'Filled Wednesday 2pm gap — Jasmin confirmed', value_cents: 2500, created_at: new Date(Date.now() - 150 * 60000).toISOString() },
  { id: 'sr5', category: 'retention', agent: 'comeback', summary: 'Nudged Daisy S — 12 days overdue for rebook', value_cents: 0, created_at: new Date(Date.now() - 180 * 60000).toISOString() },
  { id: 'sr6', category: 'retention', agent: 'comeback', summary: 'Sent rebook reminder to Chloe B (6 weeks since last visit)', value_cents: 0, created_at: new Date(Date.now() - 200 * 60000).toISOString() },
  { id: 'sr7', category: 'payment', agent: 'money', summary: 'Chased £45 deposit from Lena — paid', value_cents: 4500, created_at: new Date(Date.now() - 240 * 60000).toISOString() },
  { id: 'sr8', category: 'payment', agent: 'money', summary: 'Logged £85 payment from Sarah\'s appointment', value_cents: 8500, created_at: new Date(Date.now() - 300 * 60000).toISOString() },
];

const SHIFT_CATEGORIES = {
  message: { label: 'Messages', icon: 'chat_bubble', color: '#745a27', bg: 'rgba(254,219,155,0.3)' },
  booking: { label: 'Bookings', icon: 'event_available', color: '#5ba97b', bg: 'rgba(91,169,123,0.12)' },
  retention: { label: 'Retention', icon: 'loyalty', color: '#92405e', bg: 'rgba(255,217,226,0.3)' },
  payment: { label: 'Payments', icon: 'payments', color: '#3a7ca5', bg: 'rgba(58,124,165,0.1)' },
  other: { label: 'Other', icon: 'auto_awesome', color: '#6b5a5f', bg: 'rgba(146,64,94,0.06)' },
};

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
  const [shiftReport, setShiftReport] = useState(isDevMode ? DEV_SHIFT_REPORT : []);
  const [shiftExpanded, setShiftExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // ── Attendance marking ──
  const [attendanceMap, setAttendanceMap] = useState({}); // id → 'attended' | 'no_show'
  const [attendanceSaving, setAttendanceSaving] = useState(false);
  const [attendanceDone, setAttendanceDone] = useState(false);

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

        // Build shift report from today's actions
        const todayActions = actions.filter(a => a.created_at?.slice(0, 10) === nowDate);
        const shiftItems = todayActions.map(a => {
          let category = 'other';
          const at = (a.action_type || '').toLowerCase();
          const agent = (a.digital_employee || '').toLowerCase();
          if (agent === 'front_desk' || at.includes('message') || at.includes('reply') || at.includes('dm')) category = 'message';
          else if (agent === 'calendar' || at.includes('book') || at.includes('gap') || at.includes('schedule')) category = 'booking';
          else if (agent === 'comeback' || at.includes('nudge') || at.includes('rebook') || at.includes('retain')) category = 'retention';
          else if (agent === 'money' || at.includes('payment') || at.includes('deposit') || at.includes('chase')) category = 'payment';
          return {
            id: a.id,
            category,
            agent: a.digital_employee || 'general',
            summary: a.summary || a.action_type || 'Task completed',
            value_cents: a.value_cents || 0,
            created_at: a.created_at,
          };
        });
        if (shiftItems.length > 0) setShiftReport(shiftItems);
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

  // ── Attendance helpers ──
  const unresolvedAppts = today.filter(a => a.status === 'confirmed' || a.status === 'pending');
  const showAttendance = unresolvedAppts.length > 0 && !attendanceDone;

  // Only show after ALL appointments for the day are finished (last end time has passed)
  const allAppointmentsDone = useMemo(() => {
    if (isDevMode) return true; // always show in dev for testing
    if (today.length === 0) return false;
    const now = new Date();
    const activeAppts = today.filter(a => a.status !== 'cancelled');
    if (activeAppts.length === 0) return false;
    // Check if the last appointment's end time has passed
    return activeAppts.every(a => {
      const [h, m] = (a.time || '00:00').split(':').map(Number);
      const endTime = new Date();
      endTime.setHours(h, m, 0, 0);
      endTime.setMinutes(endTime.getMinutes() + (a.duration || 60));
      return now >= endTime;
    });
  }, [today]);

  function toggleAttendance(id) {
    setAttendanceMap(prev => {
      const current = prev[id];
      if (!current) return { ...prev, [id]: 'attended' };
      if (current === 'attended') return { ...prev, [id]: 'no_show' };
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  function markAllAttended() {
    const map = {};
    unresolvedAppts.forEach(a => { map[a.id] = 'attended'; });
    setAttendanceMap(map);
  }

  async function submitAttendance() {
    setAttendanceSaving(true);
    try {
      // In dev mode, just simulate
      if (isDevMode) {
        setToday(prev => prev.map(a => {
          const mark = attendanceMap[a.id];
          if (!mark) return a;
          return { ...a, status: mark === 'attended' ? 'completed' : 'no_show' };
        }));
        setAttendanceDone(true);
        setAttendanceSaving(false);
        return;
      }

      // Real mode: PATCH each appointment status
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const updates = Object.entries(attendanceMap).map(([id, mark]) => {
        const newStatus = mark === 'attended' ? 'completed' : 'no_show';
        return fetch(`/api/booking/appointments/${id}/status`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ status: newStatus }),
        });
      });

      await Promise.all(updates);

      // Update local state
      setToday(prev => prev.map(a => {
        const mark = attendanceMap[a.id];
        if (!mark) return a;
        return { ...a, status: mark === 'attended' ? 'completed' : 'no_show' };
      }));
      setAttendanceDone(true);
    } catch (err) {
      logger.error('Attendance submit error:', err);
    } finally {
      setAttendanceSaving(false);
    }
  }

  const todayRevenue = today.reduce((sum, a) => sum + (a.price_cents || 0), 0);
  const completedCount = today.filter(a => a.status === 'completed').length;
  const pendingCount = today.filter(a => a.status === 'pending').length;
  const remainingCount = today.length - completedCount;
  const fmt = (cents) => `£${(cents / 100).toFixed(2)}`;

  // Shift report derived
  const shiftStats = useMemo(() => {
    if (!shiftReport.length) return null;
    const totalActions = shiftReport.length;
    const totalValue = shiftReport.reduce((s, r) => s + (r.value_cents || 0), 0);
    const byCategory = {};
    shiftReport.forEach(r => {
      if (!byCategory[r.category]) byCategory[r.category] = { count: 0, value: 0, items: [] };
      byCategory[r.category].count++;
      byCategory[r.category].value += r.value_cents || 0;
      byCategory[r.category].items.push(r);
    });
    // Estimate time saved: ~3 min per message, ~5 min per booking/retention, ~2 min per payment
    const timeMins = shiftReport.reduce((s, r) => {
      if (r.category === 'message') return s + 3;
      if (r.category === 'booking' || r.category === 'retention') return s + 5;
      if (r.category === 'payment') return s + 2;
      return s + 2;
    }, 0);
    return { totalActions, totalValue, byCategory, timeMins };
  }, [shiftReport]);

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
            <MIcon name="trending_up" style={{ color: 'rgba(255,255,255,0.6)' }} size={28} />
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

      {/* ─── AI Shift Report ─── */}
      {shiftStats && shiftStats.totalActions > 0 && (
        <section style={S.shiftReport}>
          {/* Collapsed summary — always visible */}
          <div
            onClick={() => setShiftExpanded(e => !e)}
            style={S.shiftHeader}
          >
            <div style={S.shiftPulse}>
              <MIcon name="auto_awesome" fill size={18} style={{ color: '#fff' }} />
            </div>
            <div style={{ flex: 1 }}>
              <p style={S.shiftTitle}>
                Florrie handled {shiftStats.totalActions} task{shiftStats.totalActions !== 1 ? 's' : ''} today
              </p>
              <p style={S.shiftSub}>
                {shiftStats.timeMins} min saved
                {shiftStats.totalValue > 0 && ` · £${(shiftStats.totalValue / 100).toFixed(0)} secured`}
              </p>
            </div>
            <MIcon
              name={shiftExpanded ? 'expand_less' : 'expand_more'}
              size={20} style={{ color: '#6b5a5f' }}
            />
          </div>

          {/* Expanded detail */}
          {shiftExpanded && (
            <div style={S.shiftBody}>
              {/* Category pills */}
              <div style={S.shiftPills}>
                {Object.entries(shiftStats.byCategory).map(([cat, data]) => {
                  const meta = SHIFT_CATEGORIES[cat] || SHIFT_CATEGORIES.other;
                  return (
                    <div key={cat} style={{ ...S.shiftPill, background: meta.bg }}>
                      <MIcon name={meta.icon} fill size={14} style={{ color: meta.color }} />
                      <span style={{ fontSize: 11, fontWeight: 600, color: meta.color }}>
                        {data.count} {meta.label}
                      </span>
                      {data.value > 0 && (
                        <span style={{ fontSize: 10, color: meta.color, opacity: 0.7 }}>
                          £{(data.value / 100).toFixed(0)}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Action list */}
              <div style={S.shiftList}>
                {shiftReport.slice(0, 6).map(item => {
                  const meta = SHIFT_CATEGORIES[item.category] || SHIFT_CATEGORIES.other;
                  const agentConfig = AGENTS.find(a => a.key === item.agent);
                  return (
                    <div key={item.id} style={S.shiftItem}>
                      <div style={{ ...S.shiftDot, background: meta.color }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={S.shiftItemText}>{item.summary}</p>
                        <p style={S.shiftItemMeta}>
                          {agentConfig?.name || item.agent}
                          {item.value_cents > 0 && ` · £${(item.value_cents / 100).toFixed(0)}`}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* View full log link */}
              <button
                onClick={() => navigate('/florrie')}
                style={S.shiftViewAll}
              >
                View full activity log
                <MIcon name="arrow_forward" size={14} style={{ color: '#92405e' }} />
              </button>
            </div>
          )}
        </section>
      )}

      {/* ─── Insight Cards ─── */}
      <section style={S.alertGrid}>
        {/* Card 1: Schedule status — gaps or next appointment */}
        <button onClick={() => navigate('/calendar')} style={S.alertCard('#fedb9b', '#5c4418', '#4a3710')}>
          <div style={S.alertTop}>
            <MIcon name={remainingCount > 0 ? 'schedule' : 'check_circle'} size={14} style={{ color: '#5c4418' }} />
            <span style={S.alertBadge('#5c4418')}>
              {remainingCount > 0 ? 'Next Up' : 'Done'}
            </span>
          </div>
          <p style={{ fontSize: 14, fontWeight: 600, color: '#4a3710', margin: 0, fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)" }}>
            {remainingCount > 0
              ? (today.find(a => a.status !== 'completed')?.time || 'All clear')
              : 'All done for today'}
          </p>
        </button>

        {/* Card 2: Revenue context or retention nudge */}
        {insights.some(i => i.type === 'action' && i.actionPath === '/clients') ? (
          <button onClick={() => navigate('/clients')} style={S.alertCard('#ffd9e2', '#6e2d45', '#5a1f35')}>
            <div style={S.alertTop}>
              <MIcon name="history" size={14} style={{ color: '#6e2d45' }} />
              <span style={S.alertBadge('#6e2d45')}>Retain</span>
            </div>
            <p style={{ fontSize: 14, fontWeight: 500, color: '#5a1f35', margin: 0 }}>
              Overdue rebookings
            </p>
          </button>
        ) : (
          <button onClick={() => navigate('/money')} style={S.alertCard('#ffd9e2', '#6e2d45', '#5a1f35')}>
            <div style={S.alertTop}>
              <MIcon name="payments" size={14} style={{ color: '#6e2d45' }} />
              <span style={S.alertBadge('#6e2d45')}>Revenue</span>
            </div>
            <p style={{ fontSize: 14, fontWeight: 600, color: '#5a1f35', margin: 0, fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)" }}>
              {weeklyPulse.incomeChange != null
                ? `${weeklyPulse.incomeChange >= 0 ? '↑' : '↓'} ${Math.abs(weeklyPulse.incomeChange)}% this week`
                : fmt(weeklyPulse.income) + ' this week'}
            </p>
          </button>
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
                <div key={appt.id} style={{ display: 'flex', alignItems: 'center', gap: 12, opacity: isPast ? 0.55 : 1 }}>
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
                      <p style={{ fontSize: 12, color: '#3d2e33', margin: 0 }}>{appt.treatment}</p>
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

      {/* ─── Attendance Check ─── */}
      {showAttendance && allAppointmentsDone && (
        <section style={S.attendanceCard}>
          <div style={S.attendanceHeader}>
            <div style={S.attendancePulse}>
              <MIcon name="fact_check" fill size={18} style={{ color: '#fff' }} />
            </div>
            <div style={{ flex: 1 }}>
              <p style={S.attendanceTitle}>Quick attendance check</p>
              <p style={S.attendanceSub}>
                {unresolvedAppts.length} appointment{unresolvedAppts.length !== 1 ? 's' : ''} to confirm
              </p>
            </div>
          </div>

          {/* Mark all attended shortcut */}
          <button onClick={markAllAttended} style={S.markAllBtn}>
            <MIcon name="done_all" size={16} style={{ color: '#5ba97b' }} />
            Everyone attended
          </button>

          {/* Appointment list */}
          <div style={S.attendanceList}>
            {unresolvedAppts.map(appt => {
              const mark = attendanceMap[appt.id];
              const isAttended = mark === 'attended';
              const isNoShow = mark === 'no_show';

              return (
                <div
                  key={appt.id}
                  onClick={() => toggleAttendance(appt.id)}
                  style={{
                    ...S.attendanceRow,
                    background: isAttended ? 'rgba(91,169,123,0.08)' : isNoShow ? 'rgba(232,93,117,0.06)' : '#fff',
                    borderColor: isAttended ? 'rgba(91,169,123,0.25)' : isNoShow ? 'rgba(232,93,117,0.2)' : 'rgba(146,64,94,0.08)',
                  }}
                >
                  {/* Status icon */}
                  <div style={{
                    ...S.attendanceCheck,
                    background: isAttended ? '#5ba97b' : isNoShow ? '#E85D75' : '#ede7e3',
                  }}>
                    <MIcon
                      name={isAttended ? 'check' : isNoShow ? 'close' : 'remove'}
                      fill
                      size={14}
                      style={{ color: (isAttended || isNoShow) ? '#fff' : '#867277' }}
                    />
                  </div>

                  {/* Client info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={S.attendanceName}>{appt.client}</p>
                    <p style={S.attendanceMeta}>{appt.time} · {appt.treatment}</p>
                  </div>

                  {/* Status label */}
                  {mark && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      color: isAttended ? '#5ba97b' : '#E85D75',
                    }}>
                      {isAttended ? 'Attended' : 'No-show'}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Tap hint */}
          <p style={S.attendanceHint}>
            Tap once = attended · Tap again = no-show · Tap again = undo
          </p>

          {/* Submit */}
          <button
            onClick={submitAttendance}
            disabled={Object.keys(attendanceMap).length === 0 || attendanceSaving}
            style={{
              ...S.attendanceSubmit,
              opacity: Object.keys(attendanceMap).length === 0 ? 0.4 : 1,
            }}
          >
            {attendanceSaving ? 'Saving...' : `Confirm ${Object.keys(attendanceMap).length} of ${unresolvedAppts.length}`}
          </button>
        </section>
      )}

      {/* Attendance done toast */}
      {attendanceDone && (
        <section style={S.attendanceDoneBanner}>
          <MIcon name="check_circle" fill size={18} style={{ color: '#5ba97b' }} />
          <p style={{ fontSize: 13, fontWeight: 600, color: '#5ba97b', margin: 0 }}>
            Attendance confirmed — nice one!
          </p>
        </section>
      )}

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
                  <span style={{ fontSize: 10, color: '#3d2e33', whiteSpace: 'nowrap', marginLeft: 8 }}>{act.time}</span>
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
    fontSize: 14, color: '#6b5a5f', margin: '0 0 4px',
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
    fontSize: 12, opacity: 0.85, textTransform: 'uppercase', letterSpacing: '0.12em',
    marginBottom: 4, fontFamily: "var(--font-sans, 'DM Sans')", margin: '0 0 4px',
  },
  heroValue: {
    fontSize: 30, fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)",
    fontStyle: 'normal', margin: 0, fontWeight: 700, letterSpacing: '-0.02em',
  },
  heroDivider: {
    borderTop: '1px solid rgba(255,255,255,0.1)',
    margin: '20px 0 16px',
  },
  heroStats: { display: 'flex', justifyContent: 'space-between' },
  heroStat: { textAlign: 'center' },
  heroStatLabel: { fontSize: 12, opacity: 0.85, margin: '0 0 4px' },
  heroStatValue: { fontSize: 18, fontWeight: 700, margin: 0, fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)" },

  // Shift Report
  shiftReport: {
    background: '#fff', borderRadius: 20, marginBottom: 16,
    border: '1px solid rgba(146, 64, 94, 0.06)',
    boxShadow: '0 2px 12px rgba(146, 64, 94, 0.05)',
    overflow: 'hidden',
  },
  shiftHeader: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '16px 18px', cursor: 'pointer',
  },
  shiftPulse: {
    width: 36, height: 36, borderRadius: 12,
    background: 'linear-gradient(135deg, #c76b8a 0%, #92405e 100%)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
    boxShadow: '0 2px 8px rgba(146, 64, 94, 0.25)',
  },
  shiftTitle: {
    fontSize: 14, fontWeight: 600, color: '#1d1b19', margin: 0,
  },
  shiftSub: {
    fontSize: 11, color: '#6b5a5f', margin: '2px 0 0', fontWeight: 500,
  },
  shiftBody: {
    padding: '0 18px 18px',
    borderTop: '1px solid rgba(146, 64, 94, 0.06)',
    animation: 'fadeIn 0.2s ease',
  },
  shiftPills: {
    display: 'flex', flexWrap: 'wrap', gap: 6, padding: '14px 0 12px',
  },
  shiftPill: {
    display: 'flex', alignItems: 'center', gap: 5,
    padding: '5px 10px', borderRadius: 10,
  },
  shiftList: {
    display: 'flex', flexDirection: 'column', gap: 10,
    marginBottom: 14,
  },
  shiftItem: {
    display: 'flex', gap: 10, alignItems: 'flex-start',
  },
  shiftDot: {
    width: 6, height: 6, borderRadius: 3, flexShrink: 0,
    marginTop: 6,
  },
  shiftItemText: {
    fontSize: 13, color: '#1d1b19', margin: 0, lineHeight: 1.35,
  },
  shiftItemMeta: {
    fontSize: 10, color: '#6b5a5f', margin: '2px 0 0',
  },
  shiftViewAll: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    width: '100%', padding: '10px 0', borderRadius: 12,
    border: 'none', background: 'rgba(146, 64, 94, 0.05)',
    color: '#92405e', fontSize: 12, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },

  // Alert cards
  alertGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 24 },
  alertCard: (bg, accent, text) => ({
    background: `${bg}40`,
    padding: 16, borderRadius: 16,
    border: `1px solid ${bg}60`,
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
    fontSize: 14, color: '#5e4820',
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
    fontSize: 10, fontWeight: 700, color: '#3d2e33',
    textTransform: 'uppercase', letterSpacing: '0.2em',
    margin: '0 0 12px',
  },
  activityRow: {
    display: 'flex', alignItems: 'center', gap: 12,
  },

  // Attendance card
  attendanceCard: {
    background: '#fff', borderRadius: 20, marginBottom: 16,
    border: '1px solid rgba(146, 64, 94, 0.08)',
    boxShadow: '0 2px 12px rgba(146, 64, 94, 0.05)',
    padding: 18, overflow: 'hidden',
  },
  attendanceHeader: {
    display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16,
  },
  attendancePulse: {
    width: 36, height: 36, borderRadius: 12,
    background: 'linear-gradient(135deg, #745a27 0%, #a07b3f 100%)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
    boxShadow: '0 2px 8px rgba(116, 90, 39, 0.2)',
  },
  attendanceTitle: {
    fontSize: 14, fontWeight: 600, color: '#1d1b19', margin: 0,
  },
  attendanceSub: {
    fontSize: 11, color: '#6b5a5f', margin: '2px 0 0', fontWeight: 500,
  },
  markAllBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    width: '100%', padding: '10px 0', borderRadius: 12, marginBottom: 12,
    border: '1.5px solid rgba(91,169,123,0.3)',
    background: 'rgba(91,169,123,0.06)',
    color: '#5ba97b', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  attendanceList: {
    display: 'flex', flexDirection: 'column', gap: 8,
  },
  attendanceRow: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '12px 14px', borderRadius: 14,
    border: '1px solid rgba(146,64,94,0.08)',
    cursor: 'pointer', transition: 'all 0.15s ease',
    WebkitTapHighlightColor: 'transparent',
  },
  attendanceCheck: {
    width: 28, height: 28, borderRadius: 8,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, transition: 'all 0.15s ease',
  },
  attendanceName: {
    fontSize: 14, fontWeight: 600, color: '#1d1b19', margin: 0,
  },
  attendanceMeta: {
    fontSize: 11, color: '#6b5a5f', margin: '2px 0 0',
  },
  attendanceHint: {
    fontSize: 10, color: '#6b5a5f', textAlign: 'center',
    margin: '12px 0 14px', fontStyle: 'italic',
  },
  attendanceSubmit: {
    width: '100%', padding: '14px 0', borderRadius: 14,
    border: 'none',
    background: 'linear-gradient(135deg, #745a27 0%, #a07b3f 100%)',
    color: '#fff', fontSize: 14, fontWeight: 700,
    cursor: 'pointer', fontFamily: 'inherit',
    boxShadow: '0 4px 16px rgba(116, 90, 39, 0.2)',
  },
  attendanceDoneBanner: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    background: 'rgba(91,169,123,0.08)', borderRadius: 14,
    padding: '12px 16px', marginBottom: 16,
    border: '1px solid rgba(91,169,123,0.15)',
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
