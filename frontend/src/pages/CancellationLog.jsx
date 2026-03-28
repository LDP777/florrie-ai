/**
 * Cancellation Log — Track every cancellation, no-show & late change.
 *
 * Patterns matter. If Fridays always get cancelled, Ellie can stop
 * offering them. If one client has 3 no-shows, the system flags it.
 * Revenue lost, reasons, and trends — all in one place.
 */
import { useState, useEffect } from 'react';
import { useBeautician, fetchRows, isDevMode } from '../lib/supabase.js';
import logger from '../lib/logger.js';

const fmt = (cents) => `£${(cents / 100).toFixed(2)}`;

const DEV_CANCELLATIONS = [
  { id: 'cx1', client: 'Lucy P', treatment: 'Lash Lift & Tint', date: '2026-03-22', time: '10:00', type: 'no-show', reason: '', revenue_lost: 4000, deposit: 0, notice: '0h', rebooked: false },
  { id: 'cx2', client: 'Natalie W', treatment: 'Colour Boost 3-6 Months', date: '2026-03-18', time: '14:00', type: 'late-cancel', reason: 'Feeling unwell', revenue_lost: 5000, deposit: 2500, notice: '4h', rebooked: false },
  { id: 'cx3', client: 'Amy R', treatment: 'HD Brows', date: '2026-03-15', time: '11:00', type: 'cancelled', reason: 'Work meeting moved', revenue_lost: 2500, deposit: 0, notice: '48h', rebooked: true },
  { id: 'cx4', client: 'Beth K', treatment: 'Lamination & Hybrid Dye', date: '2026-03-12', time: '15:00', type: 'no-show', reason: '', revenue_lost: 4500, deposit: 0, notice: '0h', rebooked: false },
  { id: 'cx5', client: 'Holly B', treatment: 'HD Brows', date: '2026-03-08', time: '13:00', type: 'cancelled', reason: 'Childcare issue', revenue_lost: 2500, deposit: 0, notice: '24h', rebooked: true },
  { id: 'cx6', client: 'Lucy P', treatment: 'Lamination & Tint', date: '2026-02-28', time: '10:00', type: 'late-cancel', reason: 'Car trouble', revenue_lost: 4000, deposit: 0, notice: '2h', rebooked: false },
  { id: 'cx7', client: 'Natalie W', treatment: 'HD Brows', date: '2026-02-22', time: '14:00', type: 'no-show', reason: '', revenue_lost: 2500, deposit: 0, notice: '0h', rebooked: false },
  { id: 'cx8', client: 'Isabelle T', treatment: 'Lash Lift & Tint', date: '2026-02-15', time: '11:00', type: 'cancelled', reason: 'Moving to a different date', revenue_lost: 0, deposit: 0, notice: '72h', rebooked: true },
  { id: 'cx9', client: 'Kate M', treatment: 'Lamination & Hybrid Dye', date: '2026-02-10', time: '16:00', type: 'cancelled', reason: 'Holiday clash', revenue_lost: 0, deposit: 0, notice: '5d', rebooked: true },
  { id: 'cx10', client: 'Lucy P', treatment: 'HD Brows', date: '2026-02-01', time: '10:00', type: 'no-show', reason: '', revenue_lost: 2500, deposit: 0, notice: '0h', rebooked: false },
];

const TYPE_CONFIG = {
  'no-show': { label: 'No Show', bg: '#FFEBEE', color: '#F44336', icon: '✗' },
  'late-cancel': { label: 'Late Cancel', bg: '#FFF5E6', color: '#B8860B', icon: '⏰' },
  'cancelled': { label: 'Cancelled', bg: '#F0ECE8', color: '#8B6F5E', icon: '↩' },
};

export default function CancellationLog({ token }) {
  const { beautician, loading: bLoading } = useBeautician();
  const [tab, setTab] = useState('log');
  const [filterType, setFilterType] = useState('all');
  const [period, setPeriod] = useState('30d');
  const [cancellations, setCancellations] = useState(DEV_CANCELLATIONS);

  // Fetch cancelled/no-show appointments
  useEffect(() => {
    if (bLoading || !beautician) return;
    if (isDevMode) {
      setCancellations(DEV_CANCELLATIONS);
      return;
    }
    fetchRows('appointments', beautician.id, { order: 'start_time', ascending: false })
      .then(appts => {
        const cancelled = appts.filter(a => a.status && (a.status.startsWith('cancelled') || a.status === 'no_show'));
        setCancellations(cancelled.map(a => ({
          id: a.id,
          client: a.client_name || 'Client',
          treatment: a.treatment_name || '',
          date: a.start_time?.slice(0, 10) || '',
          time: a.start_time?.slice(11, 16) || '',
          type: a.status === 'no_show' ? 'no-show' : a.cancellation_reason ? 'late-cancel' : 'cancelled',
          reason: a.cancellation_reason || '',
          revenue_lost: a.price_cents || 0,
          deposit: a.deposit_cents || 0,
          notice: '0h',
          rebooked: false,
        })));
      })
      .catch(err => logger.error('Failed to load cancellations:', err));
  }, [beautician, bLoading]);

  // Period filter
  const now = new Date();
  const periodDays = period === '7d' ? 7 : period === '30d' ? 30 : 90;
  const cutoff = new Date(now - periodDays * 86400000);
  const filtered = cancellations.filter(c => new Date(c.date) >= cutoff);
  const typeFiltered = filterType === 'all' ? filtered : filtered.filter(c => c.type === filterType);

  // Stats
  const totalLost = filtered.reduce((s, c) => s + c.revenue_lost, 0);
  const noShows = filtered.filter(c => c.type === 'no-show').length;
  const lateCancels = filtered.filter(c => c.type === 'late-cancel').length;
  const rebooked = filtered.filter(c => c.rebooked).length;
  const rebookRate = filtered.length > 0 ? Math.round((rebooked / filtered.length) * 100) : 0;

  // Repeat offenders
  const clientCounts = {};
  cancellations.forEach(c => {
    if (!clientCounts[c.client]) clientCounts[c.client] = { total: 0, noShows: 0 };
    clientCounts[c.client].total++;
    if (c.type === 'no-show') clientCounts[c.client].noShows++;
  });
  const repeatOffenders = Object.entries(clientCounts).filter(([, d]) => d.total >= 2).sort(([, a], [, b]) => b.total - a.total);

  // Day of week pattern
  const dayPattern = {};
  filtered.forEach(c => {
    const day = new Date(c.date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short' });
    dayPattern[day] = (dayPattern[day] || 0) + 1;
  });

  return (
    <div style={S.page}>
      <h1 style={S.title}>Cancellation Log</h1>

      {/* Period filter */}
      <div style={S.periodRow}>
        {['7d', '30d', '90d'].map(p => (
          <button key={p} onClick={() => setPeriod(p)} style={{ ...S.periodChip, ...(period === p ? S.periodActive : {}) }}>
            {p === '7d' ? '7 days' : p === '30d' ? '30 days' : '90 days'}
          </button>
        ))}
      </div>

      {/* Stats */}
      <div style={S.statsGrid}>
        <div style={{ ...S.statCard, borderLeft: '3px solid #F44336' }}>
          <span style={{ ...S.statValue, color: '#F44336' }}>{fmt(totalLost)}</span>
          <span style={S.statLabel}>Revenue Lost</span>
        </div>
        <div style={{ ...S.statCard, borderLeft: '3px solid #B8860B' }}>
          <span style={{ ...S.statValue, color: '#B8860B' }}>{noShows + lateCancels}</span>
          <span style={S.statLabel}>No-shows + Late</span>
        </div>
        <div style={{ ...S.statCard, borderLeft: '3px solid #6B8F7B' }}>
          <span style={{ ...S.statValue, color: '#6B8F7B' }}>{rebookRate}%</span>
          <span style={S.statLabel}>Rebooked</span>
        </div>
      </div>

      {/* Tabs */}
      <div style={S.tabs}>
        {['log', 'insights'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ ...S.tab, ...(tab === t ? S.tabActive : {}) }}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* Log */}
      {tab === 'log' && (
        <>
          <div style={S.filterRow}>
            {['all', 'no-show', 'late-cancel', 'cancelled'].map(f => (
              <button key={f} onClick={() => setFilterType(f)} style={{ ...S.filterChip, ...(filterType === f ? S.filterActive : {}) }}>
                {f === 'all' ? 'All' : TYPE_CONFIG[f]?.label || f}
              </button>
            ))}
          </div>

          <div style={S.list}>
            {typeFiltered.length === 0 && <p style={S.empty}>No cancellations for this filter.</p>}
            {typeFiltered.map(c => {
              const cfg = TYPE_CONFIG[c.type];
              return (
                <div key={c.id} style={S.logCard}>
                  <div style={S.logHeader}>
                    <div style={S.logLeft}>
                      <div style={S.avatar}>{c.client[0]}</div>
                      <div style={S.logInfo}>
                        <span style={S.logClient}>{c.client}</span>
                        <span style={S.logTreatment}>{c.treatment}</span>
                      </div>
                    </div>
                    <div style={S.logRight}>
                      <span style={{ ...S.typeBadge, background: cfg.bg, color: cfg.color }}>{cfg.icon} {cfg.label}</span>
                      <span style={S.logDate}>{formatDate(c.date)} · {c.time}</span>
                    </div>
                  </div>
                  <div style={S.logMeta}>
                    {c.reason && <span style={S.reasonTag}>"{c.reason}"</span>}
                    {c.revenue_lost > 0 && <span style={S.lostTag}>-{fmt(c.revenue_lost)}</span>}
                    {c.deposit > 0 && <span style={S.depositTag}>Deposit kept: {fmt(c.deposit)}</span>}
                    {c.notice !== '0h' && <span style={S.noticeTag}>{c.notice} notice</span>}
                    {c.rebooked && <span style={S.rebookedTag}>✓ Rebooked</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Insights */}
      {tab === 'insights' && (
        <div style={S.insightsContainer}>
          {/* Repeat offenders */}
          {repeatOffenders.length > 0 && (
            <div style={S.card}>
              <h3 style={S.cardTitle}>Repeat Cancellers</h3>
              {repeatOffenders.map(([client, data]) => (
                <div key={client} style={S.offenderRow}>
                  <div style={S.offenderLeft}>
                    <div style={S.avatar}>{client[0]}</div>
                    <div>
                      <span style={S.offenderName}>{client}</span>
                      <span style={S.offenderDetail}>{data.noShows} no-show{data.noShows !== 1 ? 's' : ''}, {data.total} total</span>
                    </div>
                  </div>
                  <span style={{ ...S.offenderBadge, background: data.noShows >= 2 ? '#FFEBEE' : '#FFF5E6', color: data.noShows >= 2 ? '#F44336' : '#B8860B' }}>
                    {data.noShows >= 2 ? 'Flag' : 'Watch'}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Day pattern */}
          <div style={S.card}>
            <h3 style={S.cardTitle}>By Day of Week</h3>
            {Object.entries(dayPattern).sort(([, a], [, b]) => b - a).map(([day, count]) => {
              const maxCount = Math.max(...Object.values(dayPattern));
              const pct = Math.round((count / maxCount) * 100);
              return (
                <div key={day} style={S.dayRow}>
                  <span style={S.dayLabel}>{day}</span>
                  <div style={S.dayBarBg}>
                    <div style={{ ...S.dayBarFill, width: `${pct}%` }} />
                  </div>
                  <span style={S.dayCount}>{count}</span>
                </div>
              );
            })}
          </div>

          {/* Revenue impact */}
          <div style={S.card}>
            <h3 style={S.cardTitle}>Revenue Impact</h3>
            <div style={S.impactGrid}>
              <div style={S.impactItem}>
                <span style={S.impactLabel}>Lost to no-shows</span>
                <span style={{ ...S.impactValue, color: '#F44336' }}>{fmt(filtered.filter(c => c.type === 'no-show').reduce((s, c) => s + c.revenue_lost, 0))}</span>
              </div>
              <div style={S.impactItem}>
                <span style={S.impactLabel}>Lost to late cancels</span>
                <span style={{ ...S.impactValue, color: '#B8860B' }}>{fmt(filtered.filter(c => c.type === 'late-cancel').reduce((s, c) => s + c.revenue_lost, 0))}</span>
              </div>
              <div style={S.impactItem}>
                <span style={S.impactLabel}>Recovered via deposits</span>
                <span style={{ ...S.impactValue, color: '#6B8F7B' }}>{fmt(filtered.reduce((s, c) => s + c.deposit, 0))}</span>
              </div>
              <div style={S.impactItem}>
                <span style={S.impactLabel}>Saved via rebooks</span>
                <span style={{ ...S.impactValue, color: '#6B8F7B' }}>{fmt(filtered.filter(c => c.rebooked).reduce((s, c) => s + c.revenue_lost, 0))}</span>
              </div>
            </div>
          </div>

          <div style={S.tipCard}>
            <span style={S.tipTitle}>💡 Insight</span>
            <p style={S.tipText}>Lucy P has 3 no-shows. Consider requiring a deposit for her future bookings, or enabling the auto-block policy after 3 strikes.</p>
          </div>
        </div>
      )}
    </div>
  );
}

function formatDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

const S = {
  page: { padding: '20px 16px 32px', fontFamily: '"DM Sans", -apple-system, sans-serif', maxWidth: 480, margin: '0 auto' },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: '0 0 12px' },
  periodRow: { display: 'flex', gap: 8, marginBottom: 16 },
  periodChip: { padding: '6px 14px', borderRadius: 16, border: '1px solid #F0ECE8', background: 'var(--card, #fff)', color: '#8B6F5E', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' },
  periodActive: { background: '#2D2A26', color: '#fff', border: '1px solid #2D2A26' },
  statsGrid: { display: 'flex', gap: 8, marginBottom: 16 },
  statCard: { flex: 1, background: 'var(--card, #fff)', borderRadius: 12, padding: '12px 8px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  statValue: { fontSize: 17, fontWeight: 700 },
  statLabel: { fontSize: 10, color: '#AAA5A0' },
  tabs: { display: 'flex', gap: 8, marginBottom: 12 },
  tab: { flex: 1, padding: '10px 0', border: 'none', borderRadius: 10, background: 'var(--card, #fff)', color: '#AAA5A0', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  tabActive: { background: '#C76B8A', color: '#fff' },
  filterRow: { display: 'flex', gap: 6, marginBottom: 12, overflowX: 'auto' },
  filterChip: { padding: '6px 12px', borderRadius: 16, border: '1px solid #F0ECE8', background: 'var(--card, #fff)', color: '#8B6F5E', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  filterActive: { background: '#C76B8A', color: '#fff', border: '1px solid #C76B8A' },
  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  empty: { textAlign: 'center', color: '#AAA5A0', fontSize: 14, padding: 32 },
  logCard: { background: 'var(--card, #fff)', borderRadius: 14, padding: 14 },
  logHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
  logLeft: { display: 'flex', gap: 10, alignItems: 'center' },
  avatar: { width: 32, height: 32, borderRadius: 16, background: '#F0E6ED', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600, color: '#C76B8A', flexShrink: 0 },
  logInfo: { display: 'flex', flexDirection: 'column', gap: 2 },
  logClient: { fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  logTreatment: { fontSize: 12, color: '#AAA5A0' },
  logRight: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 },
  typeBadge: { padding: '3px 8px', borderRadius: 8, fontSize: 11, fontWeight: 600 },
  logDate: { fontSize: 11, color: '#AAA5A0' },
  logMeta: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  reasonTag: { padding: '3px 8px', borderRadius: 6, background: '#F9F7F4', color: '#8B6F5E', fontSize: 11, fontStyle: 'italic' },
  lostTag: { padding: '3px 8px', borderRadius: 6, background: '#FFEBEE', color: '#F44336', fontSize: 11, fontWeight: 600 },
  depositTag: { padding: '3px 8px', borderRadius: 6, background: '#E8F5E9', color: '#4CAF50', fontSize: 11, fontWeight: 500 },
  noticeTag: { padding: '3px 8px', borderRadius: 6, background: '#F0ECE8', color: '#8B6F5E', fontSize: 11 },
  rebookedTag: { padding: '3px 8px', borderRadius: 6, background: '#E8F5E9', color: '#4CAF50', fontSize: 11, fontWeight: 600 },
  insightsContainer: { display: 'flex', flexDirection: 'column', gap: 12 },
  card: { background: 'var(--card, #fff)', borderRadius: 14, padding: 16 },
  cardTitle: { fontSize: 15, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: '0 0 12px' },
  offenderRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #F0ECE8' },
  offenderLeft: { display: 'flex', gap: 10, alignItems: 'center' },
  offenderName: { fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)', display: 'block' },
  offenderDetail: { fontSize: 11, color: '#AAA5A0' },
  offenderBadge: { padding: '3px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600 },
  dayRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 },
  dayLabel: { fontSize: 12, fontWeight: 600, color: '#8B6F5E', width: 32 },
  dayBarBg: { flex: 1, height: 8, borderRadius: 4, background: '#F0ECE8' },
  dayBarFill: { height: 8, borderRadius: 4, background: '#C76B8A' },
  dayCount: { fontSize: 12, color: '#AAA5A0', width: 20, textAlign: 'right' },
  impactGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 },
  impactItem: { display: 'flex', flexDirection: 'column', gap: 2 },
  impactLabel: { fontSize: 11, color: '#AAA5A0' },
  impactValue: { fontSize: 16, fontWeight: 700 },
  tipCard: { background: '#FFF9F0', borderRadius: 12, padding: 14 },
  tipTitle: { fontSize: 13, fontWeight: 600, color: '#B8860B' },
  tipText: { fontSize: 12, color: '#8B6F5E', lineHeight: 1.4, margin: '6px 0 0' },
};
