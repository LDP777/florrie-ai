/**
 * Treatment Stats — Per-treatment analytics & performance.
 *
 * Which treatments bring the money? Which ones take too long for
 * what they earn? This page answers those questions so Ellie can
 * optimise her menu, pricing, and scheduling.
 */
import { useState } from 'react';
import { isDevMode, DEV_TREATMENTS } from '../lib/supabase.js';

const fmt = (cents) => `£${(cents / 100).toFixed(0)}`;

const DEV_STATS = [
  { id: 'ts1', name: 'Brow Lamination', bookings: 42, revenue: 147000, avgDuration: 43, price: 3500, returnRate: 78, rating: 4.8, trend: 'up', category: 'brows' },
  { id: 'ts2', name: 'HD Brows', bookings: 38, revenue: 114000, avgDuration: 38, price: 3000, returnRate: 82, rating: 4.9, trend: 'up', category: 'brows' },
  { id: 'ts3', name: 'Lash Lift & Tint', bookings: 35, revenue: 140000, avgDuration: 58, price: 4000, returnRate: 71, rating: 4.7, trend: 'stable', category: 'lashes' },
  { id: 'ts4', name: 'Brow Shape & Tidy', bookings: 55, revenue: 82500, avgDuration: 14, price: 1500, returnRate: 85, rating: 4.6, trend: 'stable', category: 'brows' },
  { id: 'ts5', name: 'Ombre Brows', bookings: 8, revenue: 200000, avgDuration: 148, price: 25000, returnRate: 100, rating: 5.0, trend: 'up', category: 'semi' },
  { id: 'ts6', name: 'Combination Brows', bookings: 4, revenue: 112000, avgDuration: 175, price: 28000, returnRate: 100, rating: 5.0, trend: 'stable', category: 'semi' },
  { id: 'ts7', name: 'Brow Tint Only', bookings: 28, revenue: 28000, avgDuration: 9, price: 1000, returnRate: 60, rating: 4.4, trend: 'down', category: 'brows' },
  { id: 'ts8', name: 'Lash Tint Only', bookings: 20, revenue: 24000, avgDuration: 14, price: 1200, returnRate: 55, rating: 4.3, trend: 'down', category: 'lashes' },
  { id: 'ts9', name: 'Lip Wax', bookings: 32, revenue: 25600, avgDuration: 8, price: 800, returnRate: 72, rating: 4.5, trend: 'stable', category: 'waxing' },
  { id: 'ts10', name: 'Full Face Wax', bookings: 12, revenue: 24000, avgDuration: 22, price: 2000, returnRate: 65, rating: 4.4, trend: 'stable', category: 'waxing' },
];

const SORT_OPTIONS = [
  { key: 'revenue', label: 'Revenue' },
  { key: 'bookings', label: 'Most Booked' },
  { key: 'hourlyRate', label: '£/Hour' },
  { key: 'rating', label: 'Rating' },
  { key: 'returnRate', label: 'Return Rate' },
];

const TREND_ICONS = { up: '📈', down: '📉', stable: '➡️' };
const TREND_COLORS = { up: 'var(--success, #5BA97B)', down: '#F44336', stable: 'var(--text-muted, var(--text-muted, #B5AFA8))' };

export default function TreatmentStats({ token }) {
  const [tab, setTab] = useState('ranking');
  const [sortBy, setSortBy] = useState('revenue');
  const [catFilter, setCatFilter] = useState('all');

  const stats = DEV_STATS;

  const enriched = stats.map(s => ({
    ...s,
    hourlyRate: s.avgDuration > 0 ? Math.round((s.price / s.avgDuration) * 60) : 0,
    totalHours: Math.round((s.bookings * s.avgDuration) / 60),
  }));

  const filtered = catFilter === 'all' ? enriched : enriched.filter(s => s.category === catFilter);

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === 'revenue') return b.revenue - a.revenue;
    if (sortBy === 'bookings') return b.bookings - a.bookings;
    if (sortBy === 'hourlyRate') return b.hourlyRate - a.hourlyRate;
    if (sortBy === 'rating') return b.rating - a.rating;
    if (sortBy === 'returnRate') return b.returnRate - a.returnRate;
    return 0;
  });

  const totalRevenue = stats.reduce((s, t) => s + t.revenue, 0);
  const totalBookings = stats.reduce((s, t) => s + t.bookings, 0);
  const avgRating = stats.length > 0 ? (stats.reduce((s, t) => s + t.rating, 0) / stats.length).toFixed(1) : '0';
  const topEarner = [...stats].sort((a, b) => b.revenue - a.revenue)[0];
  const bestHourly = [...enriched].sort((a, b) => b.hourlyRate - a.hourlyRate)[0];

  const maxRevenue = sorted.length > 0 ? sorted[0].revenue : 1;

  return (
    <div style={S.page}>
      <h1 style={S.title}>Treatment Stats</h1>
      <p style={S.subtitle}>Last 90 days</p>

      {/* Summary */}
      <div style={S.summaryRow}>
        <div style={S.summaryCard}>
          <span style={S.summaryNum}>{fmt(totalRevenue)}</span>
          <span style={S.summaryLabel}>Revenue</span>
        </div>
        <div style={S.summaryCard}>
          <span style={S.summaryNum}>{totalBookings}</span>
          <span style={S.summaryLabel}>Bookings</span>
        </div>
        <div style={S.summaryCard}>
          <span style={S.summaryNum}>⭐ {avgRating}</span>
          <span style={S.summaryLabel}>Avg Rating</span>
        </div>
      </div>

      {/* Quick insights */}
      <div style={S.insightRow}>
        <div style={S.insightCard}>
          <span style={S.insightEmoji}>💰</span>
          <span style={S.insightText}>Top earner: <strong>{topEarner?.name}</strong> ({fmt(topEarner?.revenue || 0)})</span>
        </div>
        <div style={S.insightCard}>
          <span style={S.insightEmoji}>⚡</span>
          <span style={S.insightText}>Best £/hr: <strong>{bestHourly?.name}</strong> ({fmt(bestHourly?.hourlyRate || 0)}/hr)</span>
        </div>
      </div>

      {/* Tabs */}
      <div style={S.tabs}>
        {['ranking', 'insights'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ ...S.tab, ...(tab === t ? S.tabActive : {}) }}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'ranking' && (
        <>
          {/* Category filter */}
          <div style={S.filterRow}>
            {['all', 'brows', 'lashes', 'semi', 'waxing'].map(c => (
              <button key={c} onClick={() => setCatFilter(c)} style={{ ...S.filterChip, ...(catFilter === c ? S.filterChipActive : {}) }}>
                {c === 'all' ? 'All' : c.charAt(0).toUpperCase() + c.slice(1)}
              </button>
            ))}
          </div>

          {/* Sort */}
          <div style={S.sortRow}>
            <span style={S.sortLabel}>Sort:</span>
            {SORT_OPTIONS.map(opt => (
              <button key={opt.key} onClick={() => setSortBy(opt.key)} style={{ ...S.sortBtn, ...(sortBy === opt.key ? S.sortBtnActive : {}) }}>
                {opt.label}
              </button>
            ))}
          </div>

          {/* Treatment cards */}
          <div style={S.list}>
            {sorted.map((t, i) => (
              <div key={t.id} style={S.card}>
                <div style={S.cardHeader}>
                  <div style={S.rankBadge}>{i + 1}</div>
                  <div style={S.cardInfo}>
                    <div style={S.cardNameRow}>
                      <span style={S.cardName}>{t.name}</span>
                      <span style={{ color: TREND_COLORS[t.trend], fontSize: 14 }}>{TREND_ICONS[t.trend]}</span>
                    </div>
                    <span style={S.cardMeta}>{t.bookings} bookings · {fmt(t.revenue)} revenue</span>
                  </div>
                </div>

                {/* Revenue bar */}
                <div style={S.barTrack}>
                  <div style={{ ...S.barFill, width: `${(t.revenue / maxRevenue) * 100}%` }} />
                </div>

                <div style={S.metricsRow}>
                  <div style={S.metric}>
                    <span style={S.metricValue}>{fmt(t.hourlyRate)}</span>
                    <span style={S.metricLabel}>per hr</span>
                  </div>
                  <div style={S.metric}>
                    <span style={S.metricValue}>{t.avgDuration}m</span>
                    <span style={S.metricLabel}>avg time</span>
                  </div>
                  <div style={S.metric}>
                    <span style={S.metricValue}>{t.returnRate}%</span>
                    <span style={S.metricLabel}>return</span>
                  </div>
                  <div style={S.metric}>
                    <span style={S.metricValue}>⭐ {t.rating}</span>
                    <span style={S.metricLabel}>rating</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {tab === 'insights' && (
        <div style={S.section}>
          <h3 style={S.sectionTitle}>Revenue by Category</h3>
          {['brows', 'lashes', 'semi', 'waxing'].map(cat => {
            const catStats = stats.filter(s => s.category === cat);
            const catRev = catStats.reduce((s, t) => s + t.revenue, 0);
            const catPct = totalRevenue > 0 ? Math.round((catRev / totalRevenue) * 100) : 0;
            const colors = { brows: 'var(--accent, #C76B8A)', lashes: '#9C27B0', semi: '#FF9800', waxing: 'var(--success, #5BA97B)' };
            return (
              <div key={cat} style={S.catRow}>
                <span style={S.catLabel}>{cat.charAt(0).toUpperCase() + cat.slice(1)}</span>
                <div style={S.catBar}>
                  <div style={{ ...S.catFill, width: `${catPct}%`, background: colors[cat] }} />
                </div>
                <span style={S.catValue}>{catPct}%</span>
              </div>
            );
          })}

          <h3 style={{ ...S.sectionTitle, marginTop: 20 }}>Time Efficiency</h3>
          <p style={S.hint}>Treatments ranked by revenue per hour — the higher, the more profitable your time.</p>
          {[...enriched].sort((a, b) => b.hourlyRate - a.hourlyRate).slice(0, 5).map((t, i) => (
            <div key={t.id} style={S.effRow}>
              <span style={S.effRank}>{i + 1}</span>
              <span style={S.effName}>{t.name}</span>
              <span style={S.effRate}>{fmt(t.hourlyRate)}/hr</span>
            </div>
          ))}

          <h3 style={{ ...S.sectionTitle, marginTop: 20 }}>Recommendations</h3>
          <div style={S.tipCard}>
            <span style={S.tipIcon}>💡</span>
            <span style={S.tipText}>
              Brow Tint Only is trending down with a 60% return rate. Consider bundling it with Brow Shape at a discount to boost retention.
            </span>
          </div>
          <div style={S.tipCard}>
            <span style={S.tipIcon}>🔥</span>
            <span style={S.tipText}>
              Brow Lamination is your most-booked premium treatment. It's at {fmt(enriched.find(e => e.name === 'Brow Lamination')?.hourlyRate || 0)}/hr — room for a small price increase.
            </span>
          </div>
          <div style={S.tipCard}>
            <span style={S.tipIcon}>⏰</span>
            <span style={S.tipText}>
              Semi-permanent treatments average 2.5+ hours each but generate {fmt(stats.filter(s => s.category === 'semi').reduce((a, t) => a + t.revenue, 0))} total. They're your highest-value bookings.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

const S = {
  page: { padding: '20px 16px 100px', fontFamily: '"DM Sans", -apple-system, sans-serif', maxWidth: 480, margin: '0 auto' },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text, var(--text-primary, #2D2A26))', margin: '0 0 2px' },
  subtitle: { fontSize: 13, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', margin: '0 0 16px' },

  summaryRow: { display: 'flex', gap: 8, marginBottom: 12 },
  summaryCard: { flex: 1, background: 'var(--card, #fff)', borderRadius: 12, padding: '12px 6px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  summaryNum: { fontSize: 17, fontWeight: 700, color: 'var(--accent, #C76B8A)' },
  summaryLabel: { fontSize: 10, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', fontWeight: 500 },

  insightRow: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 },
  insightCard: { display: 'flex', gap: 8, alignItems: 'center', background: 'var(--card, #fff)', borderRadius: 10, padding: '10px 12px' },
  insightEmoji: { fontSize: 16 },
  insightText: { fontSize: 12, color: 'var(--text-secondary, #8B6F5E)', lineHeight: 1.3 },

  tabs: { display: 'flex', gap: 8, marginBottom: 14 },
  tab: { flex: 1, padding: '10px 0', border: 'none', borderRadius: 10, background: 'var(--card, #fff)', color: 'var(--text-muted, var(--text-muted, #B5AFA8))', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  tabActive: { background: 'var(--accent, #C76B8A)', color: '#fff' },

  filterRow: { display: 'flex', gap: 6, marginBottom: 8, overflowX: 'auto' },
  filterChip: { padding: '6px 14px', borderRadius: 20, border: '1px solid var(--border, var(--border, #EDE9E4))', background: 'var(--card, #fff)', fontSize: 12, fontWeight: 600, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  filterChipActive: { background: 'var(--accent, #C76B8A)', color: '#fff', border: '1px solid var(--accent, #C76B8A)' },

  sortRow: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12, overflowX: 'auto' },
  sortLabel: { fontSize: 12, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', fontWeight: 600, flexShrink: 0 },
  sortBtn: { padding: '5px 10px', borderRadius: 8, border: '1px solid var(--border, var(--border, #EDE9E4))', background: 'var(--card, #fff)', fontSize: 11, fontWeight: 600, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  sortBtnActive: { background: '#F0E6ED', color: 'var(--accent, #C76B8A)', border: '1px solid var(--accent, #C76B8A)20' },

  list: { display: 'flex', flexDirection: 'column', gap: 8 },
  card: { background: 'var(--card, #fff)', borderRadius: 14, padding: 14 },
  cardHeader: { display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 },
  rankBadge: { width: 28, height: 28, borderRadius: 8, background: '#F0E6ED', color: 'var(--accent, #C76B8A)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, flexShrink: 0 },
  cardInfo: { flex: 1, minWidth: 0 },
  cardNameRow: { display: 'flex', alignItems: 'center', gap: 6 },
  cardName: { fontSize: 14, fontWeight: 600, color: 'var(--text, var(--text-primary, #2D2A26))' },
  cardMeta: { fontSize: 12, color: 'var(--text-muted, var(--text-muted, #B5AFA8))' },
  barTrack: { height: 6, borderRadius: 3, background: 'var(--border, var(--border, #EDE9E4))', overflow: 'hidden', marginBottom: 10 },
  barFill: { height: '100%', borderRadius: 3, background: 'var(--accent, #C76B8A)', transition: 'width .4s' },
  metricsRow: { display: 'flex', justifyContent: 'space-between' },
  metric: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 },
  metricValue: { fontSize: 13, fontWeight: 700, color: 'var(--text, var(--text-primary, #2D2A26))' },
  metricLabel: { fontSize: 10, color: 'var(--text-muted, var(--text-muted, #B5AFA8))' },

  section: { marginBottom: 16 },
  sectionTitle: { fontSize: 14, fontWeight: 700, color: 'var(--text, var(--text-primary, #2D2A26))', margin: '0 0 12px' },
  hint: { fontSize: 12, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', margin: '0 0 10px' },
  catRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
  catLabel: { fontSize: 12, fontWeight: 600, color: 'var(--text, var(--text-primary, #2D2A26))', width: 60 },
  catBar: { flex: 1, height: 10, borderRadius: 5, background: 'var(--border, var(--border, #EDE9E4))', overflow: 'hidden' },
  catFill: { height: '100%', borderRadius: 5, transition: 'width .4s' },
  catValue: { fontSize: 12, fontWeight: 700, color: 'var(--accent, #C76B8A)', width: 35, textAlign: 'right' },
  effRow: { display: 'flex', alignItems: 'center', gap: 10, background: 'var(--card, #fff)', borderRadius: 10, padding: '10px 12px', marginBottom: 4 },
  effRank: { width: 20, fontSize: 13, fontWeight: 700, color: 'var(--accent, #C76B8A)' },
  effName: { flex: 1, fontSize: 13, color: 'var(--text, var(--text-primary, #2D2A26))' },
  effRate: { fontSize: 13, fontWeight: 700, color: 'var(--success, #5BA97B)' },

  tipCard: { background: '#F9F7F4', borderRadius: 12, padding: 12, display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 8 },
  tipIcon: { fontSize: 16, flexShrink: 0 },
  tipText: { fontSize: 12, color: 'var(--text-secondary, #8B6F5E)', lineHeight: 1.4, margin: 0 },
};
