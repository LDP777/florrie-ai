/**
 * Cancellation Log - Track every cancellation, no-show & late change.
 *
 * Patterns matter. If Fridays always get cancelled, Ellie can stop
 * offering them. If one client has 3 no-shows, the system flags it.
 * Revenue lost, reasons, and trends - all in one place.
 */
import { useState, useEffect } from 'react';
import { useBeautician, fetchRows, updateRow } from '../lib/supabase.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';
import Icon, { iconName } from '../components/ui/Icon';
const fmt = (cents) => `£${(cents / 100).toFixed(2)}`;

const TYPE_CONFIG = {
  // Not the client's doing, so it does not wear the client's badge.
  unpaid: { label: 'Deposit unpaid', icon: '\u{1F4B3}', bg: 'var(--bg-hover, #f3ede9)', color: 'var(--text-secondary, #574A42)' },
  'no-show': { label: 'No Show', bg: '#FFEBEE', color: '#F44336', icon: 'x' },
  'late-cancel': { label: 'Late Cancel', bg: '#FFF5E6', color: 'var(--gold, #79581C)', icon: '⏰' },
  'cancelled': { label: 'Cancelled', bg: '#F0ECE8', color: '#735C4E', icon: '↩' },
};

export default function CancellationLog() {
  const { beautician, loading: bLoading } = useBeautician();
  const [tab, setTab] = useState('log');
  const [filterType, setFilterType] = useState('all');
  const [period, setPeriod] = useState('30d');
  const [cancellations, setCancellations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Fetch cancelled/no-show appointments from real data
  useEffect(() => {
    if (bLoading || !beautician) return;

    setLoading(true);
    setError('');

    // The names are the whole point of this screen, and it never had them:
    // `client_name` and `treatment_name` are not columns on appointments, so
    // every row read "Client" with no treatment. Ellie went looking for who had
    // been cancelled and the list could not tell her. Join for them.
    fetchRows('appointments', beautician.id, {
      order: 'starts_at',
      ascending: false,
      select: '*, clients(first_name, last_name), treatments(name)',
    })
      .then(appts => {
        const cancelled = appts.filter(a => a.status && (a.status.startsWith('cancelled') || a.status === 'no_show'));
        setCancellations(cancelled.map(a => {
          const name = [a.clients?.first_name, a.clients?.last_name].filter(Boolean).join(' ').trim();
          // A deposit that was never paid was never kept. This showed
          // "Deposit kept: GBP 17" against bookings released BECAUSE no deposit
          // arrived, which is how the money stopped making sense.
          const depositActuallyKept = a.deposit_paid === true ? (a.deposit_cents || 0) : 0;
          return {
            id: a.id,
            client: name || 'Client',
            treatment: a.treatments?.name || '',
            date: a.starts_at?.slice(0, 10) || '',
            time: a.starts_at?.slice(11, 16) || '',
            type: cancellationType(a),
            reason: humanReason(a.cancellation_reason),
            // Nothing was lost on a booking that was never paid for and never
            // happened: the slot went back in the diary.
            revenue_lost: a.status === 'no_show' || a.deposit_paid === true ? (a.price_cents || 0) : 0,
            deposit: depositActuallyKept,
            notice: computeNotice(a.cancelled_at, a.starts_at),
            rebooked: a.rebooked_at ? true : false,
          };
        }));
        setLoading(false);
      })
      .catch(err => {
        logger.error('Failed to load cancellations:', err);
        setError('Failed to load cancellations');
        setLoading(false);
      });
  }, [beautician, bLoading]);

  // Handler to rebook appointment
  const handleRebook = async (appointmentId, clientName) => {
    try {
      const updates = { rebooked_at: new Date().toISOString() };
      await updateRow('appointments', appointmentId, updates);

      // Update local state
      setCancellations(prev =>
        prev.map(c =>
          c.id === appointmentId ? { ...c, rebooked: true } : c
        )
      );
      logger.info(`Rebooked appointment for ${clientName}`);
    } catch (err) {
      logger.error('Failed to mark as rebooked:', err);
      setError('Failed to mark as rebooked');
    }
  };

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

  // Real insight: the client with the most no-shows (if any).
  const topNoShow = Object.entries(clientCounts)
    .filter(([, d]) => d.noShows >= 1)
    .sort(([, a], [, b]) => b.noShows - a.noShows)[0];

  // Day of week pattern
  const dayPattern = {};
  filtered.forEach(c => {
    const day = new Date(c.date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short' });
    dayPattern[day] = (dayPattern[day] || 0) + 1;
  });

  return (
    <div style={S.page}>
      <h1 style={S.title}>Cancellation Log</h1>
      {error && <div style={{ ...S.errorBanner, marginBottom: 16 }}>{error}</div>}
      {loading && <p style={{ textAlign: 'center', color: 'var(--text-muted, #6B5D54)' }}>Loading cancellations...</p>}

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
        <div style={{ ...S.statCard, borderLeft: '3px solid var(--danger, #9E2B32)' }}>
          <span style={{ ...S.statValue, color: 'var(--danger, #9E2B32)' }}>{fmt(totalLost)}</span>
          <span style={S.statLabel}>Revenue Lost</span>
        </div>
        <div style={{ ...S.statCard, borderLeft: '3px solid var(--warning, #79581C)' }}>
          <span style={{ ...S.statValue, color: 'var(--warning, #79581C)' }}>{noShows + lateCancels}</span>
          <span style={S.statLabel}>No-shows + Late</span>
        </div>
        <div style={{ ...S.statCard, borderLeft: '3px solid var(--success, #386F52)' }}>
          <span style={{ ...S.statValue, color: 'var(--success, #386F52)' }}>{rebookRate}%</span>
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
            {['all', 'no-show', 'late-cancel', 'cancelled', 'unpaid'].map(f => (
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
                      <span style={{ ...S.typeBadge, background: cfg.bg, color: cfg.color }}><Icon name={iconName(cfg.icon)} inline /> {cfg.label}</span>
                      <span style={S.logDate}>{formatDate(c.date)} · {c.time}</span>
                    </div>
                  </div>
                  <div style={S.logMeta}>
                    {c.reason && <span style={S.reasonTag}>"{c.reason}"</span>}
                    {c.revenue_lost > 0 && <span style={S.lostTag}>-{fmt(c.revenue_lost)}</span>}
                    {c.deposit > 0 && <span style={S.depositTag}>Deposit kept: {fmt(c.deposit)}</span>}
                    {c.notice && <span style={S.noticeTag}>{c.notice} notice</span>}
                    {c.rebooked ? (
                      <span style={S.rebookedTag}><Icon name="check" size={14} inline /> Rebooked</span>
                    ) : (
                      <button
                        onClick={() => handleRebook(c.id, c.client)}
                        style={S.rebookBtn}
                      >
                        Rebook
                      </button>
                    )}
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
                <span style={{ ...S.impactValue, color: 'var(--danger, #9E2B32)' }}>{fmt(filtered.filter(c => c.type === 'no-show').reduce((s, c) => s + c.revenue_lost, 0))}</span>
              </div>
              <div style={S.impactItem}>
                <span style={S.impactLabel}>Lost to late cancels</span>
                <span style={{ ...S.impactValue, color: 'var(--warning, #79581C)' }}>{fmt(filtered.filter(c => c.type === 'late-cancel').reduce((s, c) => s + c.revenue_lost, 0))}</span>
              </div>
              <div style={S.impactItem}>
                <span style={S.impactLabel}>Recovered via deposits</span>
                <span style={{ ...S.impactValue, color: 'var(--success, #386F52)' }}>{fmt(filtered.reduce((s, c) => s + c.deposit, 0))}</span>
              </div>
              <div style={S.impactItem}>
                <span style={S.impactLabel}>Saved via rebooks</span>
                <span style={{ ...S.impactValue, color: 'var(--success, #386F52)' }}>{fmt(filtered.filter(c => c.rebooked).reduce((s, c) => s + c.revenue_lost, 0))}</span>
              </div>
            </div>
          </div>

          {topNoShow && (
            <div style={S.tipCard}>
              <span style={S.tipTitle}><Icon name="info" size={14} inline /> Insight</span>
              <p style={S.tipText}>
                {topNoShow[0]} has {topNoShow[1].noShows} no-show{topNoShow[1].noShows !== 1 ? 's' : ''}. Consider requiring a deposit for future bookings, or enabling the auto-block policy after repeat strikes.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

// Notice given = hours between the cancellation and the appointment start.
// Returns null when we can't tell (e.g. no-shows have no cancelled_at).

/**
 * What kind of cancellation was this, really?
 *
 * Anything carrying a reason used to be badged "Late Cancel", which put that
 * label on bookings the system itself released for non payment. It read as the
 * client letting her down at short notice when in fact nobody had turned up to
 * let her down: the deposit never arrived.
 */
function cancellationType(a) {
  if (a.status === 'no_show') return 'no-show';
  if (a.cancellation_reason === 'auto_cancelled_unpaid') return 'unpaid';
  if (a.cancellation_reason === 'client_abandoned_booking') return 'cancelled';
  return a.cancellation_reason ? 'late-cancel' : 'cancelled';
}

/**
 * Reasons are internal identifiers. Showing her `"auto_cancelled_unpaid"` in
 * quotation marks tells her nothing and looks broken.
 */
const REASON_TEXT = {
  auto_cancelled_unpaid: 'Deposit was never paid, so the slot was released',
  client_abandoned_booking: 'They changed their mind mid booking',
  ai_hold_no_payment_link: 'We could not raise a payment link',
  ai_hold_state_unwritable: 'Something went wrong holding the slot',
};
function humanReason(reason) {
  if (!reason) return '';
  return REASON_TEXT[reason] || reason.replace(/_/g, ' ');
}

function computeNotice(cancelledAt, startsAt) {
  if (!cancelledAt || !startsAt) return null;
  const diffMs = new Date(startsAt) - new Date(cancelledAt);
  if (!Number.isFinite(diffMs) || diffMs <= 0) return null;
  const hours = diffMs / 3600000;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

const S = {
  page: { padding: '20px 16px 32px', fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif", maxWidth: 480, margin: '0 auto' },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text-primary, #241B17)', margin: '0 0 12px' },
  errorBanner: { background: 'var(--danger-bg, #F7E4E4)', color: 'var(--danger, #9E2B32)', padding: '10px 12px', borderRadius: 10, fontSize: 13 },
  periodRow: { display: 'flex', gap: 8, marginBottom: 16 },
  periodChip: { padding: '6px 14px', borderRadius: 16, border: '1px solid var(--border, var(--border, #E8DDD4))', background: 'var(--bg-card, #FFFCF9)', color: 'var(--text-secondary, #574A42)', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' },
  periodActive: { background: 'var(--text-primary, #241B17)', color: 'var(--bg-card, #FFFCF9)', border: '1px solid var(--text-primary, #241B17)' },
  statsGrid: { display: 'flex', gap: 8, marginBottom: 16 },
  statCard: { flex: 1, background: 'var(--bg-card, #FFFCF9)', borderRadius: 10, padding: '12px 8px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  statValue: { fontSize: 17, fontWeight: 700 },
  statLabel: { fontSize: 10, color: 'var(--text-muted, #6B5D54)' },
  tabs: { display: 'flex', gap: 8, marginBottom: 12 },
  tab: { flex: 1, padding: '10px 0', border: 'none', borderRadius: 10, background: 'var(--bg-card, #FFFCF9)', color: 'var(--text-muted, #6B5D54)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  tabActive: { background: 'var(--accent, #92405e)', color: 'var(--bg-card, #FFFCF9)' },
  filterRow: { display: 'flex', gap: 6, marginBottom: 12, overflowX: 'auto' },
  filterChip: { padding: '6px 12px', borderRadius: 16, border: '1px solid var(--border, var(--border, #E8DDD4))', background: 'var(--bg-card, #FFFCF9)', color: 'var(--text-secondary, #574A42)', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  filterActive: { background: 'var(--accent, #92405e)', color: 'var(--bg-card, #FFFCF9)', border: '1px solid var(--accent, #92405e)' },
  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  empty: { textAlign: 'center', color: 'var(--text-muted, #6B5D54)', fontSize: 14, padding: 32 },
  logCard: { background: 'var(--bg-card, #FFFCF9)', borderRadius: 16, padding: 14 },
  logHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
  logLeft: { display: 'flex', gap: 10, alignItems: 'center' },
  avatar: { width: 32, height: 32, borderRadius: 16, background: 'var(--accent-light, #F6E7EC)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600, color: 'var(--accent, #92405e)', flexShrink: 0 },
  logInfo: { display: 'flex', flexDirection: 'column', gap: 2 },
  logClient: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #241B17)' },
  logTreatment: { fontSize: 12, color: 'var(--text-muted, #6B5D54)' },
  logRight: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 },
  typeBadge: { padding: '3px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600 },
  logDate: { fontSize: 11, color: 'var(--text-muted, #6B5D54)' },
  logMeta: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  reasonTag: { padding: '3px 8px', borderRadius: 6, background: 'var(--bg-hover, var(--bg-subtle, #ede7e3))', color: 'var(--text-secondary, #574A42)', fontSize: 11, fontStyle: 'italic' },
  lostTag: { padding: '3px 8px', borderRadius: 6, background: 'var(--danger-bg, #F7E4E4)', color: 'var(--danger, #9E2B32)', fontSize: 11, fontWeight: 600 },
  depositTag: { padding: '3px 8px', borderRadius: 6, background: 'var(--success-bg, #E9F0EB)', color: 'var(--success, #386F52)', fontSize: 11, fontWeight: 500 },
  noticeTag: { padding: '3px 8px', borderRadius: 6, background: 'var(--border, var(--border, #E8DDD4))', color: 'var(--text-secondary, #574A42)', fontSize: 11 },
  rebookedTag: { padding: '3px 8px', borderRadius: 6, background: 'var(--success-bg, #E9F0EB)', color: 'var(--success, #386F52)', fontSize: 11, fontWeight: 600 },
  rebookBtn: { padding: '3px 10px', borderRadius: 6, background: 'var(--accent, #92405e)', color: 'var(--bg-card, #FFFCF9)', border: 'none', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  insightsContainer: { display: 'flex', flexDirection: 'column', gap: 12 },
  card: { background: 'var(--bg-card, #FFFCF9)', borderRadius: 16, padding: 16 },
  cardTitle: { fontSize: 15, fontWeight: 700, color: 'var(--text-primary, #241B17)', margin: '0 0 12px' },
  offenderRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border, var(--border, #E8DDD4))' },
  offenderLeft: { display: 'flex', gap: 10, alignItems: 'center' },
  offenderName: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #241B17)', display: 'block' },
  offenderDetail: { fontSize: 11, color: 'var(--text-muted, #6B5D54)' },
  offenderBadge: { padding: '3px 10px', borderRadius: 10, fontSize: 11, fontWeight: 600 },
  dayRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 },
  dayLabel: { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary, #574A42)', width: 32 },
  dayBarBg: { flex: 1, height: 8, borderRadius: 6, background: 'var(--border, var(--border, #E8DDD4))' },
  dayBarFill: { height: 8, borderRadius: 6, background: 'var(--accent, #92405e)' },
  dayCount: { fontSize: 12, color: 'var(--text-muted, #6B5D54)', width: 20, textAlign: 'right' },
  impactGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 },
  impactItem: { display: 'flex', flexDirection: 'column', gap: 2 },
  impactLabel: { fontSize: 11, color: 'var(--text-muted, #6B5D54)' },
  impactValue: { fontSize: 16, fontWeight: 700 },
  tipCard: { background: 'var(--gold-light, #ffdea4)', borderRadius: 10, padding: 14 },
  tipTitle: { fontSize: 13, fontWeight: 600, color: 'var(--gold-text, #795f2b)' },
  tipText: { fontSize: 12, color: 'var(--text-secondary, #574A42)', lineHeight: 1.4, margin: '6px 0 0' },
};
