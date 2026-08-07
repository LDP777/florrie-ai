import { useState, useEffect } from 'react';
import { useBeautician, fetchRows } from '../lib/supabase.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';

const PERIODS = ['This Week', 'This Month', 'Last 30 Days', 'This Quarter'];

// team_members rows carry profile fields only (name, role, avatar_url).
// Performance KPIs are not tracked per member yet, so they render as "-".
const DASH = '-';

function memberName(m) {
  const full = [m.first_name, m.last_name].filter(Boolean).join(' ').trim();
  return full || m.name || 'Team member';
}

function memberRole(m) {
  return m.role ? m.role.charAt(0).toUpperCase() + m.role.slice(1) : 'Stylist';
}

function Bar({ value, max, color = 'var(--accent-rose, #C76B8A)' }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div style={{ height: 6, borderRadius: 3, background: 'var(--card-border, #E8DDD4)', overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${pct}%`, borderRadius: 3, background: color, transition: 'width 0.4s ease' }} />
    </div>
  );
}

function StatCard({ label, value, suffix = '', sub, color }) {
  return (
    <div style={s.statCard}>
      <span style={{ fontSize: 11, color: 'var(--text-muted, #6B5D54)' }}>{label}</span>
      <span style={{ fontSize: 22, fontWeight: 700, color: color || 'var(--text, #241B17)' }}>{value}<span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-muted, #6B5D54)' }}>{suffix}</span></span>
      {sub && <span style={{ fontSize: 11, color: 'var(--text-muted, #6B5D54)' }}>{sub}</span>}
    </div>
  );
}

export default function StaffPerformance() {
  const [period, setPeriod] = useState('This Month');
  const [selectedStaff, setSelectedStaff] = useState(null);
  const [tab, setTab] = useState('overview');
  const { beautician, loading: bLoading } = useBeautician();
  const [staff, setStaff] = useState([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (bLoading) return;
    if (!beautician) { setStaff([]); setLoaded(true); return; }
    fetchRows('team_members', beautician.id, { order: 'first_name', ascending: true })
      .then(rows => { setStaff(rows); setLoaded(true); });
  }, [beautician, bLoading]);

  if (bLoading || !loaded) return <PageLoader />;

  // No team members: honest empty state. Performance is a team feature.
  if (staff.length === 0) {
    return (
      <div style={s.page}>
        <div style={s.header}>
          <h1 style={s.title}>Staff Performance</h1>
          <p style={s.subtitle}>Track individual KPIs and team output</p>
        </div>
        <EmptyState
          icon="👥"
          title="No team members yet"
          subtitle="Add your team in Team settings to track their performance here."
          actionLabel="Go to Team"
          onAction={() => { window.location.href = '/team'; }}
        />
      </div>
    );
  }

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
        <StatCard label="Team Revenue" value={DASH} sub={period} color="var(--accent, #92405e)" />
        <StatCard label="Bookings" value={DASH} sub="completed" />
        <StatCard label="Avg Rating" value={DASH} color="var(--warning, #8A6420)" />
        <StatCard label="Utilisation" value={DASH} sub="avg across team" />
      </div>
      <p style={s.kpiNote}>Per-member performance metrics are not tracked yet.</p>

      {/* Tab toggle */}
      <div style={s.tabRow}>
        {['overview', 'leaderboard', 'compare'].map(t => (
          <button key={t} onClick={() => { setTab(t); setSelectedStaff(null); }} style={{ ...s.tab, ...(tab === t ? s.tabActive : {}) }}>
            {t === 'overview' ? 'Overview' : t === 'leaderboard' ? 'Leaderboard' : 'Compare'}
          </button>
        ))}
      </div>

      {/* Overview tab - staff cards */}
      {tab === 'overview' && !detail && (
        <div style={s.staffList}>
          {staff.map(m => (
            <button key={m.id} onClick={() => setSelectedStaff(m.id)} style={s.staffCard}>
              <div style={s.staffTop}>
                {m.avatar_url
                  ? <img src={m.avatar_url} alt="" style={{ width: 32, height: 32, borderRadius: 16, objectFit: 'cover' }} />
                  : <span style={{ fontSize: 28 }}>👤</span>}
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--text, #241B17)' }}>{memberName(m)}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted, #6B5D54)' }}>{memberRole(m)}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontWeight: 700, fontSize: 17, color: 'var(--accent, #92405e)' }}>{DASH}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted, #6B5D54)' }}>no bookings tracked</div>
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
            {detail.avatar_url
              ? <img src={detail.avatar_url} alt="" style={{ width: 44, height: 44, borderRadius: 22, objectFit: 'cover' }} />
              : <span style={{ fontSize: 40 }}>👤</span>}
            <div>
              <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--text, #241B17)' }}>{memberName(detail)}</h2>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted, #6B5D54)' }}>{memberRole(detail)}</p>
            </div>
          </div>
          <div style={s.summaryGrid}>
            <StatCard label="Revenue" value={DASH} color="var(--accent, #92405e)" />
            <StatCard label="Bookings" value={DASH} />
            <StatCard label="Rating" value={DASH} color="var(--warning, #8A6420)" />
            <StatCard label="Utilisation" value={DASH} />
          </div>
          <div style={s.summaryGrid}>
            <StatCard label="Client Retention" value={DASH} color="var(--success, #3F7D5C)" />
            <StatCard label="Rebook Rate" value={DASH} />
            <StatCard label="Active Clients" value={DASH} />
            <StatCard label="No-shows" value={DASH} />
          </div>
          <p style={s.kpiNote}>Per-member performance metrics are not tracked yet.</p>

          {/* Contact details (real fields) */}
          {(detail.email || detail.phone) && (
            <div style={s.aiCard}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent, #92405e)', marginBottom: 6 }}>Contact</div>
              {detail.email && <p style={{ margin: '0 0 4px', fontSize: 13, color: 'var(--text, #241B17)' }}>{detail.email}</p>}
              {detail.phone && <p style={{ margin: 0, fontSize: 13, color: 'var(--text, #241B17)' }}>{detail.phone}</p>}
            </div>
          )}
        </div>
      )}

      {/* Leaderboard tab */}
      {tab === 'leaderboard' && (
        <div style={s.leaderboard}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted, #6B5D54)', marginBottom: 12 }}>Team - {period}</div>
          {staff.map((m, i) => (
            <div key={m.id} style={s.leaderRow}>
              <span style={{ ...s.rank, background: 'var(--card-border, #E8DDD4)', color: 'var(--text, #241B17)' }}>{i + 1}</span>
              {m.avatar_url
                ? <img src={m.avatar_url} alt="" style={{ width: 24, height: 24, borderRadius: 12, objectFit: 'cover' }} />
                : <span style={{ fontSize: 22 }}>👤</span>}
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{memberName(m)}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted, #6B5D54)' }}>{memberRole(m)}</div>
              </div>
              <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-muted, #6B5D54)' }}>{DASH}</span>
            </div>
          ))}
          <p style={s.kpiNote}>Revenue ranking will appear once per-member performance is tracked.</p>
        </div>
      )}

      {/* Compare tab */}
      {tab === 'compare' && (
        <div style={s.compareGrid}>
          <div style={s.compareHeader}>
            <div style={{ width: 100 }} />
            {staff.map(m => (
              <div key={m.id} style={{ flex: 1, textAlign: 'center' }}>
                {m.avatar_url
                  ? <img src={m.avatar_url} alt="" style={{ width: 24, height: 24, borderRadius: 12, objectFit: 'cover' }} />
                  : <span style={{ fontSize: 24 }}>👤</span>}
                <div style={{ fontSize: 12, fontWeight: 600, marginTop: 4 }}>{memberName(m)}</div>
              </div>
            ))}
          </div>
          {['Revenue', 'Bookings', 'Rating', 'Utilisation', 'Retention', 'Rebook', 'No-shows'].map(label => (
            <div key={label} style={s.compareRow}>
              <div style={{ width: 100, fontSize: 12, fontWeight: 600, color: 'var(--text-muted, #6B5D54)' }}>{label}</div>
              {staff.map(m => (
                <div key={m.id} style={{ flex: 1, textAlign: 'center', fontSize: 14, color: 'var(--text-muted, #6B5D54)' }}>{DASH}</div>
              ))}
            </div>
          ))}
          <p style={s.kpiNote}>Per-member performance metrics are not tracked yet.</p>
        </div>
      )}
    </div>
  );
}

const s = {
  page: { padding: '20px 16px 40px', fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif", maxWidth: 480, margin: '0 auto' },
  header: { marginBottom: 16 },
  title: { fontSize: 22, fontWeight: 700, margin: 0, color: 'var(--text, #241B17)' },
  subtitle: { fontSize: 13, color: 'var(--text-muted, #6B5D54)', margin: '4px 0 0' },
  kpiNote: { fontSize: 11, color: 'var(--text-muted, #6B5D54)', margin: '8px 0 16px', fontStyle: 'italic' },
  periodRow: { display: 'flex', gap: 8, marginBottom: 16, overflowX: 'auto' },
  periodChip: { padding: '6px 14px', borderRadius: 20, border: '1px solid var(--card-border, #E8DDD4)', background: 'none', fontSize: 12, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap', color: 'var(--text, #241B17)', fontFamily: 'inherit' },
  periodActive: { background: 'var(--accent, #92405e)', color: '#fff', borderColor: 'var(--accent, #92405e)' },
  summaryGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 },
  statCard: { display: 'flex', flexDirection: 'column', gap: 2, padding: '14px 12px', borderRadius: 12, background: 'var(--card-bg, #FFFCF9)', border: '1px solid var(--card-border, #E8DDD4)' },
  tabRow: { display: 'flex', gap: 0, marginBottom: 16, borderRadius: 10, overflow: 'hidden', border: '1px solid var(--card-border, #E8DDD4)' },
  tab: { flex: 1, padding: '10px 0', border: 'none', background: 'none', fontSize: 13, fontWeight: 500, cursor: 'pointer', color: 'var(--text-muted, #6B5D54)', fontFamily: 'inherit' },
  tabActive: { background: 'var(--accent, #92405e)', color: '#fff' },
  staffList: { display: 'flex', flexDirection: 'column', gap: 12 },
  staffCard: { padding: 16, borderRadius: 14, background: 'var(--card-bg, #FFFCF9)', border: '1px solid var(--card-border, #E8DDD4)', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', width: '100%' },
  staffTop: { display: 'flex', alignItems: 'center', gap: 12 },
  detailPanel: { animation: 'fadeIn 0.2s ease' },
  backBtn: { background: 'none', border: 'none', color: 'var(--accent, #92405e)', fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: '4px 0', marginBottom: 12, fontFamily: 'inherit' },
  detailHeader: { display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 },
  aiCard: { padding: 14, borderRadius: 12, background: 'linear-gradient(135deg, rgba(199,107,138,0.06), rgba(232,168,56,0.06))', border: '1px solid rgba(199,107,138,0.15)', marginTop: 4 },
  leaderboard: { display: 'flex', flexDirection: 'column', gap: 0 },
  leaderRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--card-border, #E8DDD4)' },
  rank: { width: 26, height: 26, borderRadius: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 },
  compareGrid: { display: 'flex', flexDirection: 'column', gap: 0 },
  compareHeader: { display: 'flex', alignItems: 'center', padding: '12px 0', borderBottom: '2px solid var(--card-border, #E8DDD4)' },
  compareRow: { display: 'flex', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--card-border, #E8DDD4)' },
};
