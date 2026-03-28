import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBeautician, supabase, isDevMode, DEV_CLIENTS, DEV_TREATMENTS } from '../lib/supabase.js';
import SMSUsageWidget from '../components/SMSUsageWidget.jsx';
import logger from '../lib/logger.js';

/**
 * Dashboard v2 — Operational command centre.
 *
 * Sections:
 *   Greeting + next client hero
 *   Today's schedule strip
 *   Revenue pulse (this week)
 *   Quick actions grid
 *   AI insights from florrie.ai
 *   Recent activity feed
 */

const DEV_TODAY = [
  { id: 'a1', time: '11:00', duration: 60, client: 'Shauna', treatment: 'Lamination & Hybrid Dye', status: 'confirmed', price_cents: 4500 },
  { id: 'a2', time: '12:15', duration: 45, client: 'Daisy S', treatment: 'Lamination Maintenance / Tint', status: 'confirmed', price_cents: 2500 },
  { id: 'a3', time: '14:00', duration: 60, client: 'Jasmin', treatment: 'Lash Lift & Tint', status: 'confirmed', price_cents: 4000 },
  { id: 'a4', time: '15:30', duration: 45, client: 'Megan R', treatment: 'HD Brows', status: 'pending', price_cents: 2500 },
];

const DEV_INSIGHTS = [
  { id: 'i1', icon: '📈', text: "You're on track for £385 this week — that's 12% up on last week.", type: 'positive' },
  { id: 'i2', icon: '🔄', text: 'Daisy S is 12 days overdue for her usual rebook. Send a nudge?', type: 'action', actionLabel: 'Send nudge', actionPath: '/clients' },
  { id: 'i3', icon: '⭐', text: 'Jasmin left a 5★ review yesterday. florrie.ai drafted a reply for you.', type: 'action', actionLabel: 'View reply', actionPath: '/reviews' },
  { id: 'i4', icon: '📋', text: "Emma's patch test is needed before Friday's appointment.", type: 'warning', actionLabel: 'Send reminder', actionPath: '/patch-tests' },
];

const DEV_ACTIVITY = [
  { id: 'act1', icon: '💬', text: 'florrie.ai confirmed Shauna\'s 11am booking', time: '10 min ago' },
  { id: 'act2', icon: '📸', text: 'Content draft ready: "Tuesday transformation ✨"', time: '1h ago' },
  { id: 'act3', icon: '💷', text: '£45.00 payment received from Shauna', time: '2h ago' },
  { id: 'act4', icon: '📅', text: 'Megan R booked HD Brows for today 3:30pm', time: '3h ago' },
  { id: 'act5', icon: '✨', text: 'florrie.ai sent aftercare card to Daisy after yesterday\'s appointment', time: '18h ago' },
];

const QUICK_ACTIONS = [
  { icon: '📅', label: 'Calendar', path: '/calendar', color: '#E3F2FD' },
  { icon: '💬', label: 'florrie.ai', path: '/voice', color: '#FBF0F3' },
  { icon: '👤', label: 'Clients', path: '/clients', color: '#FFF3E0' },
  { icon: '💰', label: 'Money', path: '/money', color: '#E8F5E9' },
  { icon: '📸', label: 'Content', path: '/content', color: '#F3F0FA' },
  { icon: '🧠', label: 'Fill Gaps', path: '/smart-schedule', color: '#FCE4EC' },
  { icon: '🎁', label: 'Vouchers', path: '/vouchers', color: '#FFF8E1' },
  { icon: '⭐', label: 'Reviews', path: '/reviews', color: '#E8F5E9' },
];

export default function Dashboard() {
  const { beautician, loading: bLoading } = useBeautician();
  const navigate = useNavigate();
  const [today, setToday] = useState([]);
  const [weeklyPulse, setWeeklyPulse] = useState({ income: 0, expenses: 0, profit: 0, incomeChange: null });
  const [insights, setInsights] = useState(isDevMode ? DEV_INSIGHTS : []);
  const [activity, setActivity] = useState(isDevMode ? DEV_ACTIVITY : []);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (beautician) loadData();
  }, [beautician]);

  async function loadData() {
    setLoading(true);
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

      // Weekly revenue pulse — this week's income
      const now = new Date();
      const weekStart = new Date(now);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1); // Monday
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

      // Generate real insights from data
      const realInsights = [];
      if (change !== null && change > 0) {
        realInsights.push({ id: 'ri1', icon: '📈', text: `Revenue is up ${change}% this week compared to last. Keep it going.`, type: 'positive' });
      } else if (change !== null && change < -10) {
        realInsights.push({ id: 'ri1', icon: '📉', text: `Revenue is down ${Math.abs(change)}% vs last week. Consider sending rebook reminders.`, type: 'action', actionLabel: 'View clients', actionPath: '/clients' });
      }
      const todayCount = (apptData || []).length;
      if (todayCount === 0) {
        realInsights.push({ id: 'ri2', icon: '📅', text: 'No appointments today. A good day to update your treatment menu or reach out to clients.', type: 'neutral' });
      } else {
        const todayRevenue = (apptData || []).reduce((s, a) => s + (a.price_cents || 0), 0);
        realInsights.push({ id: 'ri2', icon: '💷', text: `${todayCount} appointment${todayCount > 1 ? 's' : ''} today, worth £${(todayRevenue / 100).toFixed(0)} in total.`, type: 'positive' });
      }
      if (realInsights.length > 0) setInsights(realInsights);

      // AI activity feed
      const { data: actions } = await supabase
        .from('ai_actions')
        .select('*')
        .eq('beautician_id', beautician.id)
        .order('created_at', { ascending: false })
        .limit(5);

      if (actions && actions.length > 0) {
        setActivity(actions.map(a => ({
          id: a.id,
          icon: a.action_type === 'message_sent' ? '💬' : a.action_type === 'booking_confirmed' ? '📅' : a.action_type === 'payment' ? '💷' : '✨',
          text: a.summary || a.action_type,
          time: timeAgo(new Date(a.created_at)),
        })));
      }
    } catch (err) {
      logger.error('Dashboard load error:', err);
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

  return (
    <div style={styles.page}>
      {/* Greeting */}
      <div style={styles.greeting}>
        <div style={styles.greetingLeft}>
          <h1 style={styles.greetingTitle}>
            {getGreeting()}{beautician ? `, ${beautician.first_name || ''}` : ''}
          </h1>
          <p style={styles.greetingSubtitle}>
            {today.length > 0 ? `${today.length} appointment${today.length > 1 ? 's' : ''} today` : 'No appointments today'}
          </p>
        </div>
        <button onClick={() => navigate('/notifications')} style={styles.bellBtn}>
          🔔
          <div style={styles.bellDot} />
        </button>
      </div>

      {/* Next Client Hero */}
      {nextAppt && (
        <div style={styles.heroCard}>
          <div style={styles.heroHeader}>
            <span style={styles.heroLabel}>Next up</span>
            <span style={styles.heroTime}>{nextAppt.time}</span>
          </div>
          <div style={styles.heroBody}>
            <div style={styles.heroAvatar}>{nextAppt.client[0]}</div>
            <div style={styles.heroInfo}>
              <span style={styles.heroName}>{nextAppt.client}</span>
              <span style={styles.heroTreatment}>{nextAppt.treatment}</span>
              <span style={styles.heroDuration}>{nextAppt.duration}min · {fmt(nextAppt.price_cents)}</span>
            </div>
          </div>
          {today.length > 1 && (
            <div style={styles.heroFooter}>
              + {today.length - 1} more today · {fmt(todayRevenue)} projected
            </div>
          )}
        </div>
      )}

      {/* Today's Schedule Strip */}
      {today.length > 0 && (
        <div style={styles.scheduleCard}>
          <div style={styles.scheduleHeader}>
            <span style={styles.scheduleTitle}>Today's schedule</span>
            <button onClick={() => navigate('/calendar')} style={styles.seeAllBtn}>See all</button>
          </div>
          {today.map((appt, i) => {
            const isPast = (() => {
              const [h, m] = appt.time.split(':').map(Number);
              const now = new Date();
              return h < now.getHours() || (h === now.getHours() && m < now.getMinutes());
            })();
            return (
              <div key={appt.id} style={{ ...styles.scheduleRow, opacity: isPast ? 0.5 : 1 }}>
                <span style={styles.scheduleTime}>{appt.time}</span>
                <div style={styles.scheduleLine}>
                  <div style={{
                    ...styles.scheduleDot,
                    background: appt.status === 'confirmed' ? '#4CAF50' : appt.status === 'pending' ? '#FF9800' : '#AAA5A0',
                  }} />
                  {i < today.length - 1 && <div style={styles.scheduleConnector} />}
                </div>
                <div style={styles.scheduleDetail}>
                  <span style={styles.scheduleClient}>{appt.client}</span>
                  <span style={styles.scheduleTreatment}>{appt.treatment} · {appt.duration}min</span>
                </div>
                <span style={styles.schedulePrice}>{fmt(appt.price_cents)}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Revenue Pulse */}
      <div style={styles.pulseRow}>
        <div style={styles.pulseCard}>
          <span style={styles.pulseLabel}>Today</span>
          <span style={styles.pulseValue}>{fmt(todayRevenue)}</span>
        </div>
        <div style={styles.pulseCard}>
          <span style={styles.pulseLabel}>This week</span>
          <span style={styles.pulseValue}>{fmt(weeklyPulse.income)}</span>
          {weeklyPulse.incomeChange !== null && (
            <span style={{ fontSize: 10, color: weeklyPulse.incomeChange >= 0 ? '#4CAF50' : '#E57373', fontWeight: 600 }}>
              {weeklyPulse.incomeChange >= 0 ? '↑' : '↓'} {Math.abs(weeklyPulse.incomeChange)}%
            </span>
          )}
        </div>
        <div style={styles.pulseCard}>
          <span style={styles.pulseLabel}>Pending</span>
          <span style={{ ...styles.pulseValue, color: '#FF9800' }}>{today.filter(a => a.status === 'pending').length}</span>
        </div>
      </div>

      {/* SMS Usage Widget */}
      <SMSUsageWidget />

      {/* Quick Actions */}
      <div style={styles.quickGrid}>
        {QUICK_ACTIONS.map(action => (
          <button key={action.path} onClick={() => navigate(action.path)} style={styles.quickBtn}>
            <div style={{ ...styles.quickIcon, background: action.color }}>{action.icon}</div>
            <span style={styles.quickLabel}>{action.label}</span>
          </button>
        ))}
      </div>

      {/* AI Insights */}
      <div style={styles.insightsSection}>
        <h3 style={styles.sectionTitle}>✨ florrie.ai's insights</h3>
        {insights.map(insight => (
          <div key={insight.id} style={{
            ...styles.insightCard,
            borderLeft: `3px solid ${insight.type === 'positive' ? '#4CAF50' : insight.type === 'warning' ? '#FF9800' : '#C76B8A'}`,
          }}>
            <span style={styles.insightIcon}>{insight.icon}</span>
            <div style={styles.insightBody}>
              <span style={styles.insightText}>{insight.text}</span>
              {insight.actionLabel && (
                <button onClick={() => navigate(insight.actionPath)} style={styles.insightBtn}>
                  {insight.actionLabel}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Recent Activity */}
      <div style={styles.activitySection}>
        <h3 style={styles.sectionTitle}>Recent activity</h3>
        {activity.map(act => (
          <div key={act.id} style={styles.activityRow}>
            <span style={styles.activityIcon}>{act.icon}</span>
            <span style={styles.activityText}>{act.text}</span>
            <span style={styles.activityTime}>{act.time}</span>
          </div>
        ))}
      </div>

      {/* Booking link */}
      {beautician?.booking_slug && (
        <button onClick={() => {
          const url = `${window.location.origin}/book/${beautician.booking_slug}`;
          if (navigator.share) {
            navigator.share({ title: 'Book an appointment', url });
          } else {
            navigator.clipboard.writeText(url);
          }
        }} style={styles.shareBtn}>
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

const styles = {
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
  greetingLeft: {},
  greetingTitle: {
    fontSize: 24,
    fontWeight: 600,
    margin: '0 0 3px',
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

  // Hero — gradient with gold touch
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
    background: 'rgba(255,255,255,0.2)',
    backdropFilter: 'blur(8px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 18, fontWeight: 700, flexShrink: 0,
    border: '1.5px solid rgba(255,255,255,0.25)',
  },
  heroInfo: { display: 'flex', flexDirection: 'column', gap: 2 },
  heroName: { fontSize: 18, fontWeight: 700, fontFamily: "var(--font-display, 'Playfair Display', serif)" },
  heroTreatment: { fontSize: 13, opacity: 0.9 },
  heroDuration: { fontSize: 11, opacity: 0.7, fontFamily: "var(--font-mono, 'DM Mono', monospace)" },
  heroFooter: { fontSize: 12, opacity: 0.7, marginTop: 12, textAlign: 'center', borderTop: '1px solid rgba(255,255,255,0.15)', paddingTop: 10 },

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

  // Revenue pulse
  pulseRow: { display: 'flex', gap: 10, marginBottom: 16 },
  pulseCard: {
    flex: 1, background: 'var(--bg-card, #fff)', borderRadius: 14,
    padding: '14px 10px', textAlign: 'center',
    boxShadow: 'var(--shadow-xs)',
    border: '1px solid var(--border, #EDE9E4)',
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
  activityRow: { display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--border-light, #F5F2EF)' },
  activityIcon: { fontSize: 14, flexShrink: 0, paddingTop: 1 },
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

  emptyState: { textAlign: 'center', padding: '48px 24px' },
  emptyTitle: { fontSize: 17, fontWeight: 600, margin: '0 0 6px', fontFamily: "var(--font-display, 'Playfair Display', serif)" },
  emptyDesc: { fontSize: 13, color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 },
};
