/**
 * Deposit Tracker - every deposit taken, and what happened to it.
 *
 * Statuses are DERIVED server-side from the real payment state
 * (GET /api/appointments/deposits), not hand-edited here:
 *   awaiting   deposit requested, client hasn't paid yet
 *   held       paid, appointment still to come
 *   applied    paid, appointment completed (went toward the bill)
 *   forfeited  paid, appointment cancelled / no-show (kept under policy)
 *   refunded   refunded via Stripe
 *   lapsed     never paid and the booking expired
 *
 * The old version read the appointments table straight from the browser and
 * bucketed by status values the payment engine never writes, so it showed
 * £0.00 no matter how many deposits were held.
 */
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBeautician, supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';

const fmt = (cents) => `£${(Math.abs(cents) / 100).toFixed(2)}`;

const STATUS_CONFIG = {
  held: { label: 'Held', bg: '#FFF5E6', color: 'var(--gold, #C9A96E)', icon: '⏳' },
  awaiting: { label: 'Awaiting payment', bg: '#FDF8EE', color: '#8A7245', icon: '·' },
  applied: { label: 'Applied', bg: 'var(--success-bg, #E8F5E9)', color: 'var(--success, #5BA97B)', icon: '✓' },
  refunded: { label: 'Refunded', bg: '#E3F2FD', color: '#2196F3', icon: '↩' },
  forfeited: { label: 'Kept (policy)', bg: 'var(--danger-bg, #FDF0EF)', color: '#F44336', icon: '✗' },
  lapsed: { label: 'Lapsed', bg: 'var(--bg-subtle, #F9F7F4)', color: 'var(--text-muted, #B5AFA8)', icon: '—' },
};

export default function DepositTracker() {
  const navigate = useNavigate();
  const { beautician, loading: bLoading } = useBeautician();
  const [tab, setTab] = useState('held');
  const [expanded, setExpanded] = useState(null);
  const [deposits, setDeposits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (bLoading || !beautician) return;
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const { data: { session } } = await supabase.auth.getSession();
        const res = await fetch(`${API_BASE}/api/appointments/deposits`, {
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
        });
        if (!res.ok) throw new Error(`deposits fetch ${res.status}`);
        const body = await res.json();
        if (!cancelled) setDeposits(body.deposits || []);
      } catch (err) {
        logger.error('Failed to load deposits:', err);
        if (!cancelled) setError('Could not load deposits. Reopen this page to try again.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [beautician, bLoading]);

  // "Held" tab = live money (paid & upcoming) plus deposits still being paid.
  const held = deposits.filter(d => d.status === 'held' || d.status === 'awaiting');
  const history = deposits.filter(d => !['held', 'awaiting'].includes(d.status));

  const totalHeld = deposits.filter(d => d.status === 'held').reduce((s, d) => s + d.amount, 0);
  const heldCount = deposits.filter(d => d.status === 'held').length;
  const totalApplied = deposits.filter(d => d.status === 'applied').reduce((s, d) => s + d.amount, 0);
  const totalRefunded = deposits.filter(d => d.status === 'refunded').reduce((s, d) => s + d.amount, 0);
  const totalForfeited = deposits.filter(d => d.status === 'forfeited').reduce((s, d) => s + d.amount, 0);

  const filtered = tab === 'held' ? held : history;

  // Real deposit + cancellation terms, straight from her saved booking policy,
  // so this card reflects what clients actually see (not a fixed placeholder).
  const bp = beautician?.booking_policy || {};
  const noticeHours = bp.cancellation_notice_hours ?? 48;
  const chargePct = Math.min(bp.late_cancel_charge_percent ?? bp.no_show_charge_percent ?? 0, 100);
  // Only claim a specific % when the deposit really is percentage-based; a
  // fixed deposit gets a neutral line so we never quote a wrong number.
  const depositPct = bp.deposit_type === 'percentage' ? (bp.deposit_percent ?? null) : null;
  const policyLines = [];
  policyLines.push(depositPct ? `A ${depositPct}% deposit secures each booking.` : 'A deposit secures each booking.');
  if (noticeHours > 0) {
    const notice = noticeHours % 24 === 0 ? `${noticeHours / 24} day${noticeHours / 24 === 1 ? '' : 's'}` : `${noticeHours} hours`;
    policyLines.push(chargePct > 0
      ? `Free to cancel or reschedule up to ${notice} before. Later than that, or a no-show, may be charged up to ${chargePct}% of the treatment.`
      : `Free to cancel or reschedule up to ${notice} before.`);
  } else {
    policyLines.push('Free cancellation any time before the appointment.');
  }
  const hasCustomNote = !!(bp.cancellation_message && bp.cancellation_message.trim());

  if (bLoading) return <PageLoader />;

  return (
    <div style={S.page}>
      <h1 style={S.title}>Deposit Tracker</h1>

      {error && (
        <div style={S.errorBanner}>
          <span>{error}</span>
          <button style={S.errorClose} onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {/* Summary */}
      <div style={S.summaryCard}>
        <div style={S.summaryMain}>
          <span style={S.summaryLabel}>Currently Held</span>
          <span style={S.summaryValue}>{fmt(totalHeld)}</span>
          <span style={S.summaryCount}>{heldCount} deposit{heldCount !== 1 ? 's' : ''}</span>
        </div>
        <div style={S.summaryBreakdown}>
          {[
            { label: 'Applied', value: totalApplied, colour: 'var(--success, #5BA97B)' },
            { label: 'Refunded', value: totalRefunded, colour: '#2196F3' },
            { label: 'Kept', value: totalForfeited, colour: '#F44336' },
          ].map(s => (
            <div key={s.label} style={S.summaryItem}>
              <span style={{ ...S.summaryItemVal, color: s.colour }}>{fmt(s.value)}</span>
              <span style={S.summaryItemLabel}>{s.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div style={S.tabs}>
        {['held', 'history'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ ...S.tab, ...(tab === t ? S.tabActive : {}) }}>
            {t === 'held' ? `Held (${held.length})` : `History (${history.length})`}
          </button>
        ))}
      </div>

      {/* Deposit list */}
      <div style={S.list}>
        {loading && <p style={S.empty}>Loading deposits...</p>}
        {!loading && filtered.length === 0 && (
          <p style={S.empty}>
            {tab === 'held'
              ? 'No deposits held right now. New bookings with a deposit will appear here.'
              : 'No past deposits yet.'}
          </p>
        )}
        {!loading && filtered.map(d => {
          const st = STATUS_CONFIG[d.status] || STATUS_CONFIG.held;
          const isExp = expanded === d.id;
          return (
            <div key={d.id} style={S.depositCard} onClick={() => setExpanded(isExp ? null : d.id)}>
              <div style={S.depositHeader}>
                <div style={S.depositLeft}>
                  <div style={S.avatar}>{d.client[0]}</div>
                  <div style={S.depositInfo}>
                    <span style={S.depositClient}>{d.client}</span>
                    <span style={S.depositTreatment}>{d.treatment}</span>
                  </div>
                </div>
                <div style={S.depositRight}>
                  <span style={S.depositAmount}>{fmt(d.amount)}</span>
                  <span style={{ ...S.statusBadge, background: st.bg, color: st.color }}>{st.icon} {st.label}</span>
                </div>
              </div>

              {isExp && (
                <div style={S.expandedSection}>
                  <div style={S.detailGrid}>
                    <div style={S.detailItem}>
                      <span style={S.detailLabel}>Taken</span>
                      <span style={S.detailValue}>{formatDate(d.takenDate)}</span>
                    </div>
                    <div style={S.detailItem}>
                      <span style={S.detailLabel}>Method</span>
                      <span style={S.detailValue}>{d.method === 'card' ? '💳 Card' : d.method === 'bank_transfer' ? '🏦 Transfer' : `💵 ${d.method}`}</span>
                    </div>
                    {d.appointmentDate && (
                      <div style={S.detailItem}>
                        <span style={S.detailLabel}>Appointment</span>
                        <span style={S.detailValue}>
                          {formatDate(d.appointmentDate)}{d.appointmentTime ? ` · ${d.appointmentTime}` : ''}
                        </span>
                      </div>
                    )}
                  </div>
                  <p style={S.depositHint}>
                    {d.status === 'held' && 'Held on card. It applies to the bill when you mark the appointment complete, and is kept automatically on a late cancel or no-show under your policy.'}
                    {d.status === 'awaiting' && 'The client has not finished paying yet. If they never pay, the booking expires and the slot frees up on its own.'}
                    {d.status === 'applied' && 'Went toward the bill when the appointment was completed.'}
                    {d.status === 'forfeited' && 'Kept under your cancellation policy.'}
                    {d.status === 'refunded' && 'Returned to the client.'}
                    {d.status === 'lapsed' && 'Never paid, the booking expired and the slot was released.'}
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Policy reminder */}
      <div style={S.policyCard}>
        <span style={S.policyTitle}>📌 Your booking policy</span>
        <p style={S.policyText}>
          {policyLines.join(' ')}
          {hasCustomNote && ' Your full policy note is shown to clients on the booking page and their manage link.'}
        </p>
        <button style={S.policyLink} onClick={() => navigate('/settings?section=policy')}>Edit in Settings →</button>
      </div>
    </div>
  );
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

const S = {
  page: { padding: '20px 16px 32px', fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif", maxWidth: 480, margin: '0 auto' },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text, var(--text-primary, #2D2A26))', margin: '0 0 16px' },

  errorBanner: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--danger-bg, #FDF0EF)', borderRadius: 10, padding: '10px 12px', marginBottom: 16, color: 'var(--danger-text, #C62828)', fontSize: 13 },
  errorClose: { background: 'none', border: 'none', color: 'var(--danger-text, #C62828)', cursor: 'pointer', fontSize: 16, fontWeight: 600, padding: 0 },

  summaryCard: { background: 'var(--card, #fff)', borderRadius: 14, padding: 16, marginBottom: 16 },
  summaryMain: { display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid var(--border, #EDE9E4)' },
  summaryLabel: { fontSize: 12, color: 'var(--text-muted, #B5AFA8)', fontWeight: 500 },
  summaryValue: { fontSize: 28, fontWeight: 700, color: 'var(--accent, #C76B8A)' },
  summaryCount: { fontSize: 12, color: 'var(--text-muted, #B5AFA8)' },
  summaryBreakdown: { display: 'flex', gap: 8 },
  summaryItem: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  summaryItemVal: { fontSize: 15, fontWeight: 700 },
  summaryItemLabel: { fontSize: 10, color: 'var(--text-muted, #B5AFA8)' },

  tabs: { display: 'flex', gap: 8, marginBottom: 16 },
  tab: { flex: 1, padding: '10px 0', border: 'none', borderRadius: 10, background: 'var(--card, #fff)', color: 'var(--text-muted, #B5AFA8)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  tabActive: { background: 'var(--accent, #C76B8A)', color: 'var(--bg-card, #fff)' },

  list: { display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 },
  empty: { textAlign: 'center', color: 'var(--text-muted, #B5AFA8)', fontSize: 14, padding: 32 },

  depositCard: { background: 'var(--card, #fff)', borderRadius: 14, padding: 14, cursor: 'pointer' },
  depositHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
  depositLeft: { display: 'flex', gap: 10, alignItems: 'center' },
  avatar: { width: 36, height: 36, borderRadius: 18, background: 'var(--accent-light, #F0E6ED)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 600, color: 'var(--accent, #C76B8A)', flexShrink: 0 },
  depositInfo: { display: 'flex', flexDirection: 'column', gap: 2 },
  depositClient: { fontSize: 14, fontWeight: 600, color: 'var(--text, var(--text-primary, #2D2A26))' },
  depositTreatment: { fontSize: 12, color: 'var(--text-muted, #B5AFA8)' },
  depositRight: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 },
  depositAmount: { fontSize: 16, fontWeight: 700, color: 'var(--accent, #C76B8A)' },
  statusBadge: { padding: '3px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600 },

  expandedSection: { marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border, #EDE9E4)' },
  detailGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 10 },
  detailItem: { display: 'flex', flexDirection: 'column', gap: 2 },
  detailLabel: { fontSize: 11, color: 'var(--text-muted, #B5AFA8)', fontWeight: 600 },
  detailValue: { fontSize: 13, fontWeight: 600, color: 'var(--text, var(--text-primary, #2D2A26))' },
  depositHint: { fontSize: 12, color: 'var(--text-secondary, #8B6F5E)', lineHeight: 1.5, margin: '4px 0 0' },

  policyCard: { background: 'var(--bg-subtle, #F9F7F4)', borderRadius: 12, padding: 14 },
  policyTitle: { fontSize: 13, fontWeight: 600, color: 'var(--text, var(--text-primary, #2D2A26))' },
  policyText: { fontSize: 12, color: 'var(--text-secondary, #8B6F5E)', lineHeight: 1.4, margin: '6px 0' },
  policyLink: { background: 'none', border: 'none', color: 'var(--accent, #C76B8A)', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0, fontFamily: 'inherit' },
};
