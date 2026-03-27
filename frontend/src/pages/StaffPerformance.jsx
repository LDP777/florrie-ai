import { useState, useEffect } from 'react';
import { useBeautician, fetchRows, isDevMode } from '../lib/supabase.js';

const DEV_STAFF = [
  { id: 1, name: 'Ellie', role: 'Owner / Lead Stylist', avatar: '👩‍🎨', revenue: 4820, bookings: 62, avgRating: 4.9, utilisation: 87, retention: 94, clients: 38, noShows: 1, rebookRate: 78 },
  { id: 2, name: 'Sophie', role: 'Brow Specialist', avatar: '💁‍♀️', revenue: 3640, bookings: 48, avgRating: 4.7, utilisation: 74, retention: 88, clients: 29, noShows: 3, rebookRate: 71 },
  { id: 3, name: 'Jade', role: 'Lash Technician', avatar: '✨', revenue: 2980, bookings: 41, avgRating: 4.8, utilisation: 69, retention: 91, clients: 24, noShows: 0, rebookRate: 82 },
  { id: 4, name: 'Mia', role: 'Junior Stylist', avatar: '🌸', revenue: 1560, bookings: 28, avgRating: 4.5, utilisation: 52, retention: 79, clients: 18, noShows: 2, rebookRate: 64 },
];

const PERIODS = ['This Week', 'This Month', 'Last 30 Days', 'This Quarter'];

function Bar({ value, max, color = '#C76B8A' }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div style={{ height: 6, borderRadius: 3, background: 'var(--card-border, #F0ECE8)', overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${pct}%`, borderRadius: 3, background: color, transition: 'width 0.4s ease' }} />
    </div>
  );
}

function StatCard({ label, value, suffix = '', sub, color }) {
  return (
    <div style={s.statCard}>
      <span style={{ fontSize: 11, color: 'var(--text-muted, #AAA5A0)' }}>{label}</span>
      <span style={{ fontSize: 22, fontWeight: 700, color: color || 'var(--text, #2D2A26)' }}>{value}<span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-muted, #AAA5A0)' }}>{suffix}</span></span>
      {sub && <span style={{ fontSize: 11, color: 'var(--text-muted, #AAA5A0)' }}>{sub}</span>}
    </div>
  );
}

export default function StaffPerformance() {
  const [period, setPeriod] = useState('This Month');
  const [selectedStaff, setSelectedStaff] = useState(null);
  const [tab, setTab] = useState('overview');
  const { beautician, loading: bLoading } = useBeautician();
  const [staff, setStaff] = useState([]);

  useEffect(() => {
    if (bLoading) return;
    if (isDevMode || !beautician) { setStaff(DEV_STAFF); return; }
    fetchRows('team_members', beautician.id, { order: 'name', ascending: true })
      .then(rows => setStaff(rows.length ? rows : DEV_STAFF));
  }, [beautician, bLoading]);

  if (bLoading) return <div style={{ padding: 40, textAlign: 'center', color: '#AAA5A0' }}>Loading...</div>;

  const teamTotals = {
    revenue: staff.reduce((s, m) => s + m.revenue, 0),
    bookings: staff.reduce((s, m) => s + m.bookings, 0),
    avgRating: (staff.reduce((s, m) => s + m.avgRating, 0) / staff.length).toFixed(1),
    avgUtil: Math.round(staff.reduce((s, m) => s + m.utilisation, 0) / staff.length),
  };

  const maxRevenue = Math.max(...staff.map(m => m.revenue));
  const detail = selectedStaff ? staff.find(m => m.id === selectedStaff) : null;

  return (
    <div style={s.page}>
      <div style={s.header}>
        <h1 style={s.title}>Staff Performance</h1>
        <p style={s.subtitle}>Track individual KPIs and team output</p>
      </div>

      {/* Period selector */}
      <div style={s.periodRow}>
        {PERIODS.map(p => (
          <button key={p} onClick={() => setPeriod(p)} style={{ ...s.periodChip, ...(period === p ? s.periodActive : {}) }}>{p}</button>
        ))}
      </div>

      {/* Team summary */}
      <div style={s.summaryGrid}>
        <StatCard label="Team Revenue" value={`£${teamTotals.revenue.toLocaleString()}`} sub={period} color="#C76B8A" />
        <StatCard label="Bookings" value={teamTotals.bookings} sub="completed" />
        <StatCard label="Avg Rating" value={teamTotals.avgRating} suffix="/5" color="#E8A838" />
        <StatCard label="Utilisation" value={`${teamTotals.avgUtil}%`} sub="avg across team" />
      </div>

      {/* Tab toggle */}
      <div style={s.tabRow}>
        {['overview', 'leaderboard', 'compare'].map(t => (
          <button key={t} onClick={() => { setTab(t); setSelectedStaff(null); }} style={{ ...s.tab, ...(tab === t ? s.tabActive : {}) }}>
            {t === 'overview' ? 'Overview' : t === 'leaderboard' ? 'Leaderboard' : 'Compare'}
          </button>
        ))}
      </div>

      {/* Overview tab — staff cards */}
      {tab === 'overview' && !detail && (
        <div style={s.staffList}>
          {staff.map(m => (
            <button key={m.id} onClick={() => setSelectedStaff(m.id)} style={s.staffCard}>
              <div style={s.staffTop}>
                <span style={{ fontSize: 28 }}>{m.avatar}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--text, #2D2A26)' }}>{m.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted, #AAA5A0)' }}>{m.role}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontWeight: 700, fontSize: 17, color: '#C76B8A' }}>£{m.revenue.toLocaleString()}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted, #AAA5A0)' }}>{m.bookings} bookings</div>
                </div>
              </div>
              <div style={s.staffMetrics}>
                <div style={s.metricRow}>
                  <span style={s.metricLabel}>Utilisation</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: m.utilisation >= 75 ? '#4CAF50' : m.utilisation >= 50 ? '#E8A838' : '#E57373' }}>{m.utilisation}%</span>
                </div>
                <Bar value={m.utilisation} max={100} color={m.utilisation >= 75 ? '#4CAF50' : m.utilisation >= 50 ? '#E8A838' : '#E57373'} />
                <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
                  <span style={s.miniStat}>⭐ {m.avgRating}</span>
                  <span style={s.miniStat}>🔄 {m.rebookRate}% rebook</span>
                  <span style={s.miniStat}>👥 {m.clients} clients</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Staff detail view */}
      {tab === 'overview' && detail && (
        <div style={s.detailPanel}>
          <button onClick={() => setSelectedStaff(null)} style={s.backBtn}>← Back to team</button>
          <div style={s.detailHeader}>
            <span style={{ fontSize: 40 }}>{detail.avatar}</span>
            <div>
              <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--text, #2D2A26)' }}>{detail.name}</h2>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted, #AAA5A0)' }}>{detail.role}</p>
            </div>
          </div>
          <div style={s.summaryGrid}>
            <StatCard label="Revenue" value={`£${detail.revenue.toLocaleString()}`} color="#C76B8A" />
            <StatCard label="Bookings" value={detail.bookings} />
            <StatCard label="Rating" value={detail.avgRating} suffix="/5" color="#E8A838" />
            <StatCard label="Utilisation" value={`${detail.utilisation}%`} />
          </div>
          <div style={s.summaryGrid}>
            <StatCard label="Client Retention" value={`${detail.retention}%`} color="#4CAF50" />
            <StatCard label="Rebook Rate" value={`${detail.rebookRate}%`} />
            <StatCard label="Active Clients" value={detail.clients} />
            <StatCard label="No-shows" value={detail.noShows} color={detail.noShows > 2 ? '#E57373' : '#4CAF50'} />
          </div>

          {/* AI insight */}
          <div style={s.aiCard}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#C76B8A', marginBottom: 6 }}>🤖 Florrie's Take</div>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text, #2D2A26)', lineHeight: 1.5 }}>
              {detail.utilisation >= 80
                ? `${detail.name} is running near capacity — consider adding buffer time between appointments or adjusting pricing upward for peak slots.`
                : detail.utilisation >= 60
                ? `${detail.name} has room to grow. Suggest targeting ${detail.name}'s existing clients with a rebook campaign or filling gaps with waitlist offers.`
                : `${detail.name}'s utilisation is low. Review their treatment menu and pricing, or pair them with a mentor for the next 4 weeks.`}
            </p>
          </div>
        </div>
      )}

      {/* Leaderboard tab */}
      {tab === 'leaderboard' && (
        <div style={s.leaderboard}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted, #AAA5A0)', marginBottom: 12 }}>Revenue Ranking — {period}</div>
          {[...staff].sort((a, b) => b.revenue - a.revenue).map((m, i) => (
            <div key={m.id} style={s.leaderRow}>
              <span style={{ ...s.rank, background: i === 0 ? '#C76B8A' : i === 1 ? '#E8A838' : i === 2 ? '#AAA5A0' : 'var(--card-border, #F0ECE8)', color: i < 3 ? '#fff' : 'var(--text, #2D2A26)' }}>{i + 1}</span>
              <span style={{ fontSize: 22 }}>{m.avatar}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{m.name}</div>
                <Bar value={m.revenue} max={maxRevenue} />
              </div>
              <span style={{ fontWeight: 700, fontSize: 15, color: '#C76B8A' }}>£{m.revenue.toLocaleString()}</span>
            </div>
          ))}

          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted, #AAA5A0)', marginTop: 20, marginBottom: 12 }}>Rebook Rate Ranking</div>
          {[...staff].sort((a, b) => b.rebookRate - a.rebookRate).map((m, i) => (
            <div key={m.id} style={s.leaderRow}>
              <span style={{ ...s.rank, background: i === 0 ? '#4CAF50' : 'var(--card-border, #F0ECE8)', color: i === 0 ? '#fff' : 'var(--text, #2D2A26)' }}>{i + 1}</span>
              <span style={{ fontSize: 22 }}>{m.avatar}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{m.name}</div>
                <Bar value={m.rebookRate} max={100} color="#4CAF50" />
              </div>
              <span style={{ fontWeight: 700, fontSize: 15, color: '#4CAF50' }}>{m.rebookRate}%</span>
            </div>
          ))}
        </div>
      )}

      {/* Compare tab */}
      {tab === 'compare' && (
        <div style={s.compareGrid}>
          <div style={s.compareHeader}>
            <div style={{ width: 100 }} />
            {staff.map(m => (
              <div key={m.id} style={{ flex: 1, textAlign: 'center' }}>
                <span style={{ fontSize: 24 }}>{m.avatar}</span>
                <div style={{ fontSize: 12, fontWeight: 600, marginTop: 4 }}>{m.name}</div>
              </div>
            ))}
          </div>
          {[
            { label: 'Revenue', key: 'revenue', fmt: v => `£${v.toLocaleString()}` },
            { label: 'Bookings', key: 'bookings', fmt: v => v },
            { label: 'Rating', key: 'avgRating', fmt: v => `${v}/5` },
            { label: 'Utilisation', key: 'utilisation', fmt: v => `${v}%` },
            { label: 'Retention', key: 'retention', fmt: v => `${v}%` },
            { label: 'Rebook', key: 'rebookRate', fmt: v => `${v}%` },
            { label: 'No-shows', key: 'noShows', fmt: v => v },
          ].map(metric => {
            const vals = staff.map(m => m[metric.key]);
            const best = metric.key === 'noShows' ? Math.min(...vals) : Math.max(...vals);
            return (
              <div key={metric.key} style={s.compareRow}>
                <div style={{ width: 100, fontSize: 12, fontWeight: 600, color: 'var(--text-muted, #AAA5A0)' }}>{metric.label}</div>
                {staff.map(m => (
                  <div key={m.id} style={{ flex: 1, textAlign: 'center', fontSize: 14, fontWeight: m[metric.key] === best ? 700 : 400, color: m[metric.key] === best ? '#C76B8A' : 'var(--text, #2D2A26)' }}>
                    {metric.fmt(m[metric.key])}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const s = {
  page: { padding: '20px 16px 40px', fontFamily: '"DM Sans", -apple-system, sans-serif', maxWidth: 480, margin: '0 auto' },
  header: { marginBottom: 16 },
  title: { fontSize: 22, fontWeight: 700, margin: 0, color: 'var(--text, #2D2A26)' },
  subtitle: { fontSize: 13, color: 'var(--text-muted, #AAA5A0)', margin: '4px 0 0' },
  periodRow: { display: 'flex', gap: 8, marginBottom: 16, overflowX: 'auto' },
  periodChip: { padding: '6px 14px', borderRadius: 20, border: '1px solid var(--card-border, #F0ECE8)', background: 'none', fontSize: 12, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap', color: 'var(--text, #2D2A26)', fontFamily: 'inherit' },
  periodActive: { background: '#C76B8A', color: '#fff', borderColor: '#C76B8A' },
  summaryGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 },
  statCard: { display: 'flex', flexDirection: 'column', gap: 2, padding: '14px 12px', borderRadius: 12, background: 'var(--card-bg, #fff)', border: '1px solid var(--card-border, #F0ECE8)' },
  tabRow: { display: 'flex', gap: 0, marginBottom: 16, borderRadius: 10, overflow: 'hidden', border: '1px solid var(--card-border, #F0ECE8)' },
  tab: { flex: 1, padding: '10px 0', border: 'none', background: 'none', fontSize: 13, fontWeight: 500, cursor: 'pointer', color: 'var(--text-muted, #AAA5A0)', fontFamily: 'inherit' },
  tabActive: { background: '#C76B8A', color: '#fff' },
  staffList: { display: 'flex', flexDirection: 'column', gap: 12 },
  staffCard: { padding: 16, borderRadius: 14, background: 'var(--card-bg, #fff)', border: '1px solid var(--card-border, #F0ECE8)', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', width: '100%' },
  staffTop: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 },
  staffMetrics: { borderTop: '1px solid var(--card-border, #F0ECE8)', paddingTop: 10 },
  metricRow: { display: 'flex', justifyContent: 'space-between', marginBottom: 4 },
  metricLabel: { fontSize: 12, color: 'var(--text-muted, #AAA5A0)' },
  miniStat: { fontSize: 11, color: 'var(--text-muted, #AAA5A0)' },
  detailPanel: { animation: 'fadeIn 0.2s ease' },
  backBtn: { background: 'none', border: 'none', color: '#C76B8A', fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: '4px 0', marginBottom: 12, fontFamily: 'inherit' },
  detailHeader: { display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 },
  aiCard: { padding: 14, borderRadius: 12, background: 'linear-gradient(135deg, rgba(199,107,138,0.06), rgba(232,168,56,0.06))', border: '1px solid rgba(199,107,138,0.15)', marginTop: 4 },
  leaderboard: { display: 'flex', flexDirection: 'column', gap: 0 },
  leaderRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--card-border, #F0ECE8)' },
  rank: { width: 26, height: 26, borderRadius: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 },
  compareGrid: { display: 'flex', flexDirection: 'column', gap: 0 },
  compareHeader: { display: 'flex', alignItems: 'center', padding: '12px 0', borderBottom: '2px solid var(--card-border, #F0ECE8)' },
  compareRow: { display: 'flex', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--card-border, #F0ECE8)' },
};
