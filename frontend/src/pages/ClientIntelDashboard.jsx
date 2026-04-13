/**
 * Client Intel Dashboard — Everything Florrie knows about your clients.
 *
 * Landing page for the Client Intel agent. Surfaces key insights from
 * all 7 sub-pages so a beautician can glance and act:
 *
 *   1. Health pulse — total clients, active %, retention rate
 *   2. Churn alerts — at-risk clients needing attention NOW
 *   3. Segment breakdown — how clients split across value tiers
 *   4. Recent activity — timeline of latest client events
 *   5. Tags spotlight — auto-generated smart tags
 *   6. Quick actions — jump to any sub-page
 *
 * All data is real (Supabase), with dev mode fallback.
 */
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBeautician, supabase, fetchRows, isDevMode, DEV_CLIENTS } from '../lib/supabase.js';
import { ds, type } from '../lib/designSystem.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';

// ── Segment bucket definitions (mirrors ClientSegments.jsx) ──
const SEGMENTS = [
  { key: 'vip',        name: 'VIP',       icon: '👑', colour: 'var(--gold, #C9A96E)',      bg: 'var(--gold-light, #FDF8EE)',    match: c => c.rfm.r >= 8 && c.rfm.f >= 7 && c.rfm.m >= 7 },
  { key: 'loyal',      name: 'Loyal',     icon: '💎', colour: 'var(--accent, #C76B8A)',     bg: 'var(--accent-light, #FFF0F3)',  match: c => c.rfm.r >= 5 && c.rfm.f >= 4 && c.rfm.m >= 3 },
  { key: 'new',        name: 'New',       icon: '🌱', colour: 'var(--success, #5BA97B)',    bg: 'var(--success-bg, #E8F5E9)',    match: c => c.daysSinceFirst <= 60 && c.visits >= 2 },
  { key: 'declining',  name: 'Declining', icon: '📉', colour: 'var(--warning, #E59B3A)',    bg: 'var(--warning-bg, #FFF3E0)',    match: c => c.rfm.f >= 4 && c.daysSince >= 45 },
  { key: 'dormant',    name: 'Dormant',   icon: '💤', colour: 'var(--danger, #D4605C)',     bg: 'var(--danger-bg, #FDF0EF)',     match: c => c.daysSince >= 90 && c.rfm.m >= 5 },
  { key: 'one_timer',  name: 'One-Timer', icon: '👋', colour: 'var(--text-muted, #B5A99B)', bg: 'var(--bg-subtle, #F5F2EF)',     match: c => c.visits <= 1 },
];

// ── Risk thresholds ──
function churnScore(c) {
  let score = 0;
  const avg = c.avgInterval || 28;
  if (c.daysSince > avg + 21) score += 40 + Math.min(30, (c.daysSince - avg) / 2);
  else if (c.daysSince > avg) score += 25 + Math.min(20, c.daysSince - avg);
  if (c.daysSince >= 90) score += 30;
  else if (c.daysSince >= 45) score += 15;
  if (c.recentCancels >= 2) score += 25;
  return Math.min(99, Math.round(score));
}

// ── RFM scorer ──
function scoreRFM(clients) {
  const now = new Date();
  return clients.map(c => {
    const appts = (c.appointments || [])
      .map(a => new Date(a.created_at || a.starts_at))
      .filter(d => !isNaN(d))
      .sort((a, b) => b - a);
    const last = appts[0] || new Date(c.created_at || now);
    const first = appts[appts.length - 1] || last;
    const daysSince = Math.floor((now - last) / 86400000);
    const daysSinceFirst = Math.floor((now - first) / 86400000);
    const visits = appts.length || 1;
    const spend = (c.total_spend_cents || 0) / 100;

    // Compute average interval
    let avgInterval = 28;
    if (appts.length >= 2) {
      const ints = [];
      for (let i = 0; i < appts.length - 1; i++) ints.push(Math.floor((appts[i] - appts[i + 1]) / 86400000));
      avgInterval = Math.round(ints.reduce((s, v) => s + v, 0) / ints.length) || 28;
    }

    // Recent cancels
    const sixtyDaysAgo = new Date(now - 60 * 86400000);
    const recentCancels = (c.appointments || []).filter(a => a.status === 'cancelled' && new Date(a.starts_at) >= sixtyDaysAgo).length;

    return {
      id: c.id,
      name: `${c.first_name || ''} ${c.last_name || ''}`.trim(),
      initials: (c.first_name?.[0] || '') + (c.last_name?.[0] || ''),
      daysSince,
      daysSinceFirst,
      visits,
      spend,
      avgInterval,
      recentCancels,
      lastTreatment: c.appointments?.[0]?.treatment_name || null,
      rfm: {
        r: daysSince <= 7 ? 10 : daysSince <= 14 ? 8 : daysSince <= 30 ? 6 : daysSince <= 60 ? 4 : daysSince <= 90 ? 2 : 1,
        f: visits >= 20 ? 10 : visits >= 12 ? 8 : visits >= 6 ? 6 : visits >= 3 ? 4 : visits >= 2 ? 2 : 1,
        m: spend >= 500 ? 10 : spend >= 300 ? 8 : spend >= 150 ? 6 : spend >= 75 ? 4 : spend >= 30 ? 2 : 1,
      },
    };
  });
}

// ── Dev mock data ──
const DEV_STATS = { total: 42, active: 34, returning: 28, churnRisk: 6, avgVisits: 4.2, avgSpend: 187 };
const DEV_CHURN = [
  { name: 'Natalie W', initials: 'NW', daysSince: 94, trigger: 'Extended absence', score: 72, lastTreatment: 'HD Brows' },
  { name: 'Lucy P', initials: 'LP', daysSince: 67, trigger: 'Missed rebook', score: 58, lastTreatment: 'Lash Lift' },
  { name: 'Kelly M', initials: 'KM', daysSince: 43, trigger: '2 recent cancellations', score: 51, lastTreatment: 'Brow Lamination' },
];
const DEV_SEGMENTS = [
  { key: 'vip', count: 5 }, { key: 'loyal', count: 12 }, { key: 'new', count: 8 },
  { key: 'declining', count: 4 }, { key: 'dormant', count: 3 }, { key: 'one_timer', count: 10 },
];

export default function ClientIntelDashboard() {
  const navigate = useNavigate();
  const { beautician, loading: bLoading } = useBeautician();
  const [stats, setStats] = useState(null);
  const [churnAlerts, setChurnAlerts] = useState([]);
  const [segmentCounts, setSegmentCounts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (bLoading) return;
    if (isDevMode || !beautician) {
      setStats(DEV_STATS);
      setChurnAlerts(DEV_CHURN);
      setSegmentCounts(DEV_SEGMENTS);
      setLoading(false);
      return;
    }
    loadAll();
  }, [beautician, bLoading]);

  async function loadAll() {
    setLoading(true);
    try {
      const { data: clients } = await supabase
        .from('clients')
        .select('*, appointments(created_at, starts_at, treatment_name, price_cents, status)')
        .eq('beautician_id', beautician.id);

      if (!clients?.length) {
        setStats({ total: 0, active: 0, returning: 0, churnRisk: 0, avgVisits: 0, avgSpend: 0 });
        setChurnAlerts([]);
        setSegmentCounts([]);
        setLoading(false);
        return;
      }

      const scored = scoreRFM(clients);
      const now = new Date();
      const ninetyDaysAgo = new Date(now - 90 * 86400000);

      // Stats
      const active = scored.filter(c => c.daysSince <= 90).length;
      const returning = scored.filter(c => c.visits >= 2).length;
      const totalSpend = scored.reduce((s, c) => s + c.spend, 0);

      // Churn
      const withChurn = scored.map(c => ({ ...c, score: churnScore(c) })).filter(c => c.score >= 30);
      withChurn.sort((a, b) => b.score - a.score);

      const triggers = withChurn.map(c => {
        let trigger = 'At risk';
        if (c.daysSince >= 90) trigger = 'Extended absence';
        else if (c.daysSince > c.avgInterval + 14) trigger = 'Missed rebook';
        else if (c.recentCancels >= 2) trigger = `${c.recentCancels} recent cancellations`;
        else if (c.daysSince >= 45) trigger = 'Going quiet';
        return { ...c, trigger };
      });

      // Segments
      const segCounts = SEGMENTS.map(seg => ({
        key: seg.key,
        count: scored.filter(c => seg.match(c)).length,
      }));

      setStats({
        total: clients.length,
        active,
        returning,
        churnRisk: triggers.length,
        avgVisits: +(scored.reduce((s, c) => s + c.visits, 0) / scored.length).toFixed(1),
        avgSpend: Math.round(totalSpend / scored.length),
      });
      setChurnAlerts(triggers.slice(0, 5));
      setSegmentCounts(segCounts);
    } catch (err) {
      logger.error('Client Intel dashboard load failed:', err);
    } finally {
      setLoading(false);
    }
  }

  if (loading || bLoading) return <PageLoader label="Loading client intel…" />;
  if (!stats || stats.total === 0) {
    return (
      <div style={ds.page}>
        <h1 style={ds.pageTitle}>Client Intel</h1>
        <EmptyState
          icon="psychology"
          title="No client data yet"
          message="Once you have clients and appointments, Florrie will start building intelligence — churn risk, segments, spending patterns, the lot."
        />
      </div>
    );
  }

  const retentionPct = stats.active && stats.total ? Math.round((stats.active / stats.total) * 100) : 0;
  const returningPct = stats.returning && stats.total ? Math.round((stats.returning / stats.total) * 100) : 0;

  return (
    <div style={ds.page}>
      {/* Page title */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <span className="material-symbols-outlined" style={{ fontSize: 26, color: '#7B6BA8' }}>psychology</span>
        <h1 style={{ ...ds.pageTitle, color: '#7B6BA8', margin: 0 }}>Client Intel</h1>
      </div>

      {/* ── Hero card: client health pulse ── */}
      <div style={{ ...S.heroCard, marginBottom: 16 }}>
        <div style={S.heroGrid}>
          <HeroStat value={stats.total} label="Total clients" />
          <HeroStat value={`${retentionPct}%`} label="Active (90 days)" accent={retentionPct >= 70} />
          <HeroStat value={`${returningPct}%`} label="Returning" accent={returningPct >= 60} />
          <HeroStat value={stats.churnRisk} label="At risk" warn={stats.churnRisk > 0} />
        </div>
        <div style={S.heroSubRow}>
          <span style={S.heroSub}>Avg {stats.avgVisits} visits</span>
          <span style={S.heroDot}>·</span>
          <span style={S.heroSub}>Avg £{stats.avgSpend} spend</span>
        </div>
      </div>

      {/* ── Churn alerts ── */}
      {churnAlerts.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ ...type.caption, marginBottom: 8 }}>NEEDS ATTENTION</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {churnAlerts.slice(0, 3).map((c, i) => (
              <ChurnCard key={i} client={c} onNav={() => navigate('/churn')} />
            ))}
          </div>
          {churnAlerts.length > 3 && (
            <button
              onClick={() => navigate('/churn')}
              style={S.seeAllBtn}
            >
              View all {churnAlerts.length} at-risk clients →
            </button>
          )}
        </div>
      )}

      {/* ── Segment breakdown ── */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ ...type.caption, marginBottom: 8 }}>CLIENT SEGMENTS</div>
        <div style={{ ...ds.card, padding: 14 }}>
          <div style={S.segGrid}>
            {SEGMENTS.map(seg => {
              const count = segmentCounts.find(s => s.key === seg.key)?.count || 0;
              return (
                <button
                  key={seg.key}
                  onClick={() => navigate('/segments')}
                  style={S.segBtn}
                >
                  <div style={{ ...S.segIcon, background: seg.bg }}>{seg.icon}</div>
                  <span style={S.segCount}>{count}</span>
                  <span style={S.segLabel}>{seg.name}</span>
                </button>
              );
            })}
          </div>
          {/* Mini bar viz */}
          <div style={S.segBar}>
            {SEGMENTS.map(seg => {
              const count = segmentCounts.find(s => s.key === seg.key)?.count || 0;
              const pct = stats.total > 0 ? (count / stats.total) * 100 : 0;
              if (pct < 1) return null;
              return <div key={seg.key} style={{ ...S.segBarSlice, width: `${pct}%`, background: seg.colour }} title={`${seg.name}: ${count}`} />;
            })}
          </div>
        </div>
      </div>

      {/* ── Quick actions grid ── */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ ...type.caption, marginBottom: 8 }}>DEEP DIVE</div>
        <div style={S.actionGrid}>
          {QUICK_ACTIONS.map(a => (
            <button
              key={a.path}
              onClick={() => navigate(a.path)}
              style={S.actionBtn}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 22, color: a.colour }}>{a.matIcon}</span>
              <span style={S.actionLabel}>{a.label}</span>
              <span style={S.actionDesc}>{a.desc}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Insight footer ── */}
      <div style={{ ...ds.card, padding: 14, display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
        <span className="material-symbols-outlined" style={{ fontSize: 20, color: '#7B6BA8' }}>auto_awesome</span>
        <span style={{ ...type.bodySmall, flex: 1 }}>
          Intel updates automatically as clients book, cancel, and interact. The more data Florrie sees, the sharper these insights get.
        </span>
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────

function HeroStat({ value, label, accent = false, warn = false }) {
  const colour = warn ? '#D4605C' : accent ? '#5BA97B' : '#fff';
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: colour, lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.85, marginTop: 2 }}>{label}</div>
    </div>
  );
}

function ChurnCard({ client, onNav }) {
  const scoreColour = client.score >= 70 ? 'var(--danger, #D4605C)' : client.score >= 50 ? 'var(--warning, #E59B3A)' : 'var(--text-secondary)';
  return (
    <button onClick={onNav} style={S.churnCard}>
      <div style={S.churnAvatar}>{client.initials}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ ...type.body, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{client.name}</div>
        <div style={{ ...type.bodySmall, fontSize: 12 }}>
          {client.trigger}{client.lastTreatment ? ` · ${client.lastTreatment}` : ''}
        </div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: scoreColour, lineHeight: 1 }}>{client.score}</div>
        <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginTop: 1 }}>risk</div>
      </div>
    </button>
  );
}

// ── Quick-action definitions ──
const QUICK_ACTIONS = [
  { path: '/churn',     label: 'Churn Risk',     desc: 'At-risk clients',        matIcon: 'warning',     colour: '#D4605C' },
  { path: '/segments',  label: 'Segments',       desc: 'Value-based groups',     matIcon: 'donut_small', colour: '#7B6BA8' },
  { path: '/client-timeline', label: 'Timeline', desc: 'Full client history',    matIcon: 'timeline',    colour: '#4A90D9' },
  { path: '/tags',      label: 'Smart Tags',     desc: 'Auto-labelling',         matIcon: 'label',       colour: '#5BA97B' },
  { path: '/memberships', label: 'Memberships',  desc: 'Plans & retention',      matIcon: 'card_membership', colour: '#C9A96E' },
  { path: '/clients',   label: 'All Clients',    desc: 'Full client list',       matIcon: 'group',       colour: '#8B6F5E' },
];

// ── Styles ──────────────────────────────────────────────────
const S = {
  heroCard: {
    background: 'linear-gradient(135deg, #7B6BA8 0%, #5A4B82 100%)',
    borderRadius: 20,
    padding: 20,
    color: '#fff',
    boxShadow: '0 8px 24px rgba(91, 75, 130, 0.25)',
  },
  heroGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 8,
    marginBottom: 12,
  },
  heroSubRow: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    opacity: 0.8,
  },
  heroSub: { fontSize: 12, fontWeight: 500 },
  heroDot: { fontSize: 10 },

  // Churn
  churnCard: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: 14,
    padding: '10px 12px',
    width: '100%',
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'box-shadow 0.15s',
  },
  churnAvatar: {
    width: 36,
    height: 36,
    borderRadius: '50%',
    background: 'linear-gradient(135deg, #7B6BA8 0%, #9B8BC8 100%)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#fff',
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.04em',
    flexShrink: 0,
  },

  // Segments
  segGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 8,
    marginBottom: 10,
  },
  segBtn: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 2,
    padding: '8px 4px',
    background: 'none',
    border: 'none',
    borderRadius: 10,
    cursor: 'pointer',
    transition: 'background 0.15s',
  },
  segIcon: {
    width: 32,
    height: 32,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 15,
  },
  segCount: { fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.1 },
  segLabel: { fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' },
  segBar: {
    display: 'flex',
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
    background: 'var(--bg-subtle, #F5F2EF)',
  },
  segBarSlice: {
    height: '100%',
    transition: 'width 0.4s ease',
  },

  // Quick actions
  actionGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: 8,
  },
  actionBtn: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 4,
    padding: 14,
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: 14,
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'box-shadow 0.15s, border-color 0.15s',
  },
  actionLabel: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' },
  actionDesc: { fontSize: 11, color: 'var(--text-muted)' },

  seeAllBtn: {
    display: 'block',
    width: '100%',
    padding: '8px 0',
    marginTop: 6,
    background: 'none',
    border: 'none',
    color: '#7B6BA8',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    textAlign: 'center',
  },
};
