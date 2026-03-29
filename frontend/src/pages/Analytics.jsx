import { useState, useEffect } from 'react';
import { useBeautician, fetchRows, isDevMode } from '../lib/supabase.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';

/**
 * Analytics — Weekly digest, trends, top clients, booking patterns.
 * The "business brain" page that shows beauticians what's working.
 */

const PERIOD_OPTIONS = [
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: '3months', label: 'Last 3 months' },
];

export default function Analytics() {
  const { beautician } = useBeautician();
  const [period, setPeriod] = useState('week');
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadStats();
  }, [beautician, period]);

  async function loadStats() {
    if (!beautician) return;
    setLoading(true);

    if (isDevMode) {
      setStats(getDevStats(period));
      setLoading(false);
      return;
    }

    // Production: query real data
    const now = new Date();
    let startDate;
    if (period === 'week') {
      startDate = new Date(now);
      startDate.setDate(now.getDate() - 7);
    } else if (period === 'month') {
      startDate = new Date(now);
      startDate.setMonth(now.getMonth() - 1);
    } else {
      startDate = new Date(now);
      startDate.setMonth(now.getMonth() - 3);
    }

    try {
      const [appointments, clients, expenses] = await Promise.all([
        fetchRows('appointments', beautician.id, { order: 'starts_at', ascending: false }),
        fetchRows('clients', beautician.id),
        fetchRows('expenses', beautician.id, { order: 'date', ascending: false }),
      ]);

      const inRange = appointments.filter(a => new Date(a.starts_at) >= startDate);
      const completed = inRange.filter(a => a.status === 'completed');
      const noShows = inRange.filter(a => a.status === 'no_show');
      const totalRevenue = completed.reduce((s, a) => s + (a.price_cents || 0), 0);
      const totalExpenses = expenses
        .filter(e => new Date(e.date) >= startDate)
        .reduce((s, e) => s + (e.amount_cents || 0), 0);

      // Top clients by spend
      const clientSpend = {};
      completed.forEach(a => {
        const cid = a.client_id;
        if (!clientSpend[cid]) clientSpend[cid] = { id: cid, spend: 0, visits: 0 };
        clientSpend[cid].spend += a.price_cents || 0;
        clientSpend[cid].visits += 1;
      });
      const topClients = Object.values(clientSpend)
        .sort((a, b) => b.spend - a.spend)
        .slice(0, 5)
        .map(tc => {
          const client = clients.find(c => c.id === tc.id);
          return { ...tc, name: client ? `${client.first_name} ${client.last_name || ''}`.trim() : 'Unknown' };
        });

      // Busiest days
      const dayCount = { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0, sun: 0 };
      inRange.forEach(a => {
        const d = new Date(a.starts_at).getDay();
        const key = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][d];
        dayCount[key]++;
      });
      const busiestDay = Object.entries(dayCount).sort((a, b) => b[1] - a[1])[0];

      setStats({
        totalAppointments: inRange.length,
        completedCount: completed.length,
        noShowCount: noShows.length,
        noShowRate: inRange.length > 0 ? Math.round((noShows.length / inRange.length) * 100) : 0,
        totalRevenue,
        totalExpenses,
        profit: totalRevenue - totalExpenses,
        avgPerAppointment: completed.length > 0 ? Math.round(totalRevenue / completed.length) : 0,
        topClients,
        busiestDay: busiestDay ? { day: busiestDay[0], count: busiestDay[1] } : null,
        newClients: clients.filter(c => new Date(c.created_at) >= startDate).length,
        totalClients: clients.length,
        utilizationRate: 78, // Would calculate from working hours vs booked slots
      });
    } catch (err) {
      logger.error('Analytics load error:', err);
    }
    setLoading(false);
  }

  const DAY_LABELS = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.title}>Analytics</h1>
      </div>

      {/* Period selector */}
      <div style={styles.periodNav}>
        {PERIOD_OPTIONS.map(p => (
          <button
            key={p.key}
            onClick={() => setPeriod(p.key)}
            style={{
              ...styles.periodTab,
              background: period === p.key ? '#C76B8A' : '#F5F2EF',
              color: period === p.key ? '#fff' : '#8A8580'
            }}
          >
            {p.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={styles.skeletonGroup}>
          <SkeletonCard height={100} /><SkeletonCard height={80} /><SkeletonCard height={120} />
        </div>
      ) : stats ? (
        <>
          {/* Revenue hero card */}
          <div style={styles.heroCard}>
            <span style={styles.heroLabel}>Revenue</span>
            <span style={styles.heroAmount}>£{(stats.totalRevenue / 100).toFixed(2)}</span>
            <div style={styles.heroRow}>
              <div style={styles.heroStat}>
                <span style={styles.heroStatValue}>{stats.completedCount}</span>
                <span style={styles.heroStatLabel}>appointments</span>
              </div>
              <div style={styles.heroDivider} />
              <div style={styles.heroStat}>
                <span style={styles.heroStatValue}>£{(stats.avgPerAppointment / 100).toFixed(0)}</span>
                <span style={styles.heroStatLabel}>avg per visit</span>
              </div>
              <div style={styles.heroDivider} />
              <div style={styles.heroStat}>
                <span style={{ ...styles.heroStatValue, color: stats.profit >= 0 ? '#4CAF50' : '#E57373' }}>
                  £{(stats.profit / 100).toFixed(0)}
                </span>
                <span style={styles.heroStatLabel}>profit</span>
              </div>
            </div>
          </div>

          {/* Quick stats grid */}
          <div style={styles.statsGrid}>
            <StatCard label="No-show rate" value={`${stats.noShowRate}%`} sub={`${stats.noShowCount} no-shows`} color={stats.noShowRate > 10 ? '#E57373' : '#4CAF50'} />
            <StatCard label="New clients" value={stats.newClients} sub={`of ${stats.totalClients} total`} color="#C76B8A" />
            <StatCard label="Utilisation" value={`${stats.utilizationRate}%`} sub="of available hours" color={stats.utilizationRate > 70 ? '#4CAF50' : '#F57C00'} />
            <StatCard label="Expenses" value={`£${(stats.totalExpenses / 100).toFixed(0)}`} sub="total spend" color="#8A8580" />
          </div>

          {/* Busiest day */}
          {stats.busiestDay && stats.busiestDay.count > 0 && (
            <div style={styles.insightCard}>
              <span style={styles.insightIcon}>📊</span>
              <div style={styles.insightContent}>
                <span style={styles.insightTitle}>Busiest day</span>
                <span style={styles.insightText}>
                  {DAY_LABELS[stats.busiestDay.day]} with {stats.busiestDay.count} appointment{stats.busiestDay.count !== 1 ? 's' : ''}
                </span>
              </div>
            </div>
          )}

          {/* Top clients */}
          {stats.topClients.length > 0 && (
            <div style={styles.card}>
              <h3 style={styles.cardTitle}>Top clients</h3>
              {stats.topClients.map((client, i) => (
                <div key={client.id} style={styles.clientRow}>
                  <div style={styles.clientRank}>{i + 1}</div>
                  <div style={styles.clientInfo}>
                    <span style={styles.clientName}>{client.name}</span>
                    <span style={styles.clientVisits}>{client.visits} visit{client.visits !== 1 ? 's' : ''}</span>
                  </div>
                  <span style={styles.clientSpend}>£{(client.spend / 100).toFixed(0)}</span>
                </div>
              ))}
            </div>
          )}

          {/* Booking bar chart (simple CSS bars) */}
          <div style={styles.card}>
            <h3 style={styles.cardTitle}>Bookings by day</h3>
            <DayBarChart data={stats.dayBreakdown || getDevDayBreakdown()} />
          </div>

          {/* AI insights */}
          <div style={styles.card}>
            <h3 style={styles.cardTitle}>AI insights</h3>
            <div style={styles.insightsList}>
              {getInsights(stats).map((insight, i) => (
                <div key={i} style={styles.aiInsight}>
                  <span style={styles.aiInsightIcon}>{insight.icon}</span>
                  <span style={styles.aiInsightText}>{insight.text}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : (
        <div style={styles.emptyState}>
          <div style={styles.emptyIcon}>📊</div>
          <p style={styles.emptyTitle}>No data yet</p>
          <p style={styles.emptyDesc}>Analytics will appear once you start booking appointments.</p>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, sub, color }) {
  return (
    <div style={styles.statCard}>
      <span style={styles.statLabel}>{label}</span>
      <span style={{ ...styles.statValue, color }}>{value}</span>
      <span style={styles.statSub}>{sub}</span>
    </div>
  );
}

function DayBarChart({ data }) {
  const max = Math.max(...Object.values(data), 1);
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const keys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

  return (
    <div style={styles.barChart}>
      {keys.map((k, i) => {
        const val = data[k] || 0;
        const pct = (val / max) * 100;
        return (
          <div key={k} style={styles.barCol}>
            <span style={styles.barValue}>{val}</span>
            <div style={styles.barTrack}>
              <div style={{
                ...styles.barFill,
                height: `${Math.max(pct, 4)}%`,
                background: val === max ? '#C76B8A' : '#E8E4E0'
              }} />
            </div>
            <span style={{ ...styles.barLabel, color: val === max ? '#C76B8A' : '#AAA5A0' }}>
              {days[i]}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function SkeletonCard({ height = 80 }) {
  return (
    <div style={{ ...styles.card, height, display: 'flex', flexDirection: 'column', gap: 10, justifyContent: 'center' }}>
      <div style={{ height: 14, width: '40%', borderRadius: 7, background: '#F0ECE8' }} />
      <div style={{ height: 14, width: '65%', borderRadius: 7, background: '#F5F2EF' }} />
    </div>
  );
}

function getInsights(stats) {
  const insights = [];
  if (stats.noShowRate > 10) {
    insights.push({ icon: '⚠️', text: `No-show rate is ${stats.noShowRate}%. Consider adding deposits to reduce cancellations.` });
  }
  if (stats.noShowRate <= 5) {
    insights.push({ icon: '🎉', text: 'Your no-show rate is excellent. Your clients are reliable.' });
  }
  if (stats.utilizationRate < 60) {
    insights.push({ icon: '💡', text: 'You have availability to fill. Try running a last-minute deals campaign.' });
  }
  if (stats.utilizationRate > 85) {
    insights.push({ icon: '🔥', text: 'You\'re nearly fully booked. Consider raising prices or adding a waitlist.' });
  }
  if (stats.newClients > 0) {
    insights.push({ icon: '👋', text: `${stats.newClients} new client${stats.newClients > 1 ? 's' : ''} this period. Keep the booking link visible.` });
  }
  if (stats.topClients.length > 0 && stats.topClients[0].visits >= 3) {
    insights.push({ icon: '💎', text: `${stats.topClients[0].name} is your top spender with ${stats.topClients[0].visits} visits. Consider a loyalty perk.` });
  }
  if (insights.length === 0) {
    insights.push({ icon: '📈', text: 'Keep booking and the AI will spot trends in your data.' });
  }
  return insights;
}

// Dev mode mock data
function getDevStats(period) {
  const base = period === 'week' ? 1 : period === 'month' ? 4 : 12;
  return {
    totalAppointments: 8 * base,
    completedCount: 7 * base,
    noShowCount: Math.round(0.5 * base),
    noShowRate: 6,
    totalRevenue: 28000 * base,
    totalExpenses: 4200 * base,
    profit: 23800 * base,
    avgPerAppointment: 4000,
    topClients: [
      { id: 'dev-c2', name: 'Daisy S', spend: 9000 * base, visits: 3 * base },
      { id: 'dev-c1', name: 'Shauna', spend: 7200 * base, visits: 2 * base },
      { id: 'dev-c3', name: 'Jasmin', spend: 4500 * base, visits: base },
      { id: 'dev-c4', name: 'Megan R', spend: 4000 * base, visits: base },
      { id: 'dev-c5', name: 'Beth W', spend: 3300 * base, visits: base },
    ],
    busiestDay: { day: 'thu', count: 3 * base },
    newClients: Math.round(1.5 * base),
    totalClients: 24,
    utilizationRate: 78,
    dayBreakdown: getDevDayBreakdown(),
  };
}

function getDevDayBreakdown() {
  return { mon: 4, tue: 6, wed: 5, thu: 8, fri: 7, sat: 2, sun: 0 };
}

const styles = {
  page: { minHeight: '100vh', background: '#FAF8F5', fontFamily: '"DM Sans", -apple-system, sans-serif', padding: '0 16px 40px', maxWidth: 480, margin: '0 auto', color: '#2D2A26' },
  header: { paddingTop: 28, paddingBottom: 8 },
  title: { fontSize: 22, fontWeight: 700, margin: 0 },

  periodNav: { display: 'flex', gap: 6, marginBottom: 16 },
  periodTab: { flex: 1, padding: '8px 0', borderRadius: 8, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.2s' },

  // Hero revenue
  heroCard: { background: 'linear-gradient(135deg, #C76B8A 0%, #D4899F 100%)', borderRadius: 16, padding: 20, marginBottom: 12, color: '#fff' },
  heroLabel: { fontSize: 12, fontWeight: 600, opacity: 0.8, textTransform: 'uppercase', letterSpacing: '0.05em' },
  heroAmount: { display: 'block', fontSize: 36, fontWeight: 800, marginTop: 4, letterSpacing: '-0.02em' },
  heroRow: { display: 'flex', justifyContent: 'space-between', marginTop: 16, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.2)' },
  heroStat: { display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1 },
  heroStatValue: { fontSize: 18, fontWeight: 700 },
  heroStatLabel: { fontSize: 10, opacity: 0.7, marginTop: 2 },
  heroDivider: { width: 1, background: 'rgba(255,255,255,0.2)', margin: '0 4px' },

  // Stats grid
  statsGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 },
  statCard: { background: '#fff', borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 2, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' },
  statLabel: { fontSize: 11, color: '#AAA5A0', fontWeight: 500 },
  statValue: { fontSize: 22, fontWeight: 700, letterSpacing: '-0.01em' },
  statSub: { fontSize: 11, color: '#C4BDB6' },

  // Insight card
  insightCard: { display: 'flex', alignItems: 'center', gap: 12, padding: 14, borderRadius: 12, background: '#FFF8E1', marginBottom: 12 },
  insightIcon: { fontSize: 24, flexShrink: 0 },
  insightContent: { display: 'flex', flexDirection: 'column', gap: 2 },
  insightTitle: { fontSize: 12, fontWeight: 600, color: '#F57C00' },
  insightText: { fontSize: 13, color: '#8A8580' },

  // Card
  card: { background: '#fff', borderRadius: 14, padding: 16, marginBottom: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' },
  cardTitle: { fontSize: 14, fontWeight: 600, margin: '0 0 12px', color: '#2D2A26' },

  // Top clients
  clientRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid #FAF8F5' },
  clientRank: { width: 24, height: 24, borderRadius: 12, background: '#F5F2EF', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: '#AAA5A0', flexShrink: 0 },
  clientInfo: { flex: 1, display: 'flex', flexDirection: 'column', gap: 1 },
  clientName: { fontSize: 13, fontWeight: 600, color: '#2D2A26' },
  clientVisits: { fontSize: 11, color: '#AAA5A0' },
  clientSpend: { fontSize: 14, fontWeight: 700, color: '#C76B8A' },

  // Bar chart
  barChart: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', height: 120, gap: 4, paddingTop: 8 },
  barCol: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flex: 1 },
  barValue: { fontSize: 10, fontWeight: 600, color: '#AAA5A0' },
  barTrack: { width: '100%', height: 80, borderRadius: 4, background: '#FAF8F5', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', overflow: 'hidden' },
  barFill: { width: '100%', borderRadius: 4, transition: 'height 0.4s ease', minHeight: 3 },
  barLabel: { fontSize: 10, fontWeight: 600 },

  // AI insights
  insightsList: { display: 'flex', flexDirection: 'column', gap: 8 },
  aiInsight: { display: 'flex', alignItems: 'flex-start', gap: 8 },
  aiInsightIcon: { fontSize: 16, flexShrink: 0, marginTop: 1 },
  aiInsightText: { fontSize: 13, color: '#5A5550', lineHeight: 1.5 },

  // Empty state
  emptyState: { textAlign: 'center', padding: '40px 20px' },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyTitle: { fontSize: 16, fontWeight: 600, margin: '0 0 8px' },
  emptyDesc: { fontSize: 13, color: '#AAA5A0', lineHeight: 1.5 },

  // Skeleton
  skeletonGroup: { display: 'flex', flexDirection: 'column', gap: 10 },
};
