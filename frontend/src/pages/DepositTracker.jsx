/**
 * Deposit Tracker - Track all held deposits, refunds & forfeitures.
 *
 * Semi-permanent treatments, no-show policies, waitlist holds -
 * deposits are everywhere. This page tracks every penny held,
 * when it was taken, and what happened to it.
 */
import { useState, useEffect } from 'react';
import { useBeautician, fetchRows, supabase, updateRow } from '../lib/supabase.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';

const fmt = (cents) => `£${(Math.abs(cents) / 100).toFixed(2)}`;

const STATUS_CONFIG = {
  held: { label: 'Held', bg: '#FFF5E6', color: 'var(--gold, #C9A96E)', icon: '⏳' },
  applied: { label: 'Applied', bg: 'var(--success-bg, #E8F5E9)', color: 'var(--success, #5BA97B)', icon: '✓' },
  refunded: { label: 'Refunded', bg: '#E3F2FD', color: '#2196F3', icon: '↩' },
  forfeited: { label: 'Forfeited', bg: 'var(--danger-bg, #FDF0EF)', color: '#F44336', icon: '✗' },
};

export default function DepositTracker() {
  const { beautician, loading: bLoading } = useBeautician();
  const [tab, setTab] = useState('held');
  const [expanded, setExpanded] = useState(null);
  const [deposits, setDeposits] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Fetch deposits (query appointments where deposit_cents > 0)
  useEffect(() => {
    if (bLoading || !beautician) return;

    const loadDeposits = async () => {
      try {
        setLoading(true);
        setError(null);
        // Query appointments table directly with gt filter
        const { data, error: fetchErr } = await supabase
          .from('appointments')
          .select('*')
          .eq('beautician_id', beautician.id)
          .gt('deposit_cents', 0)
          .order('created_at', { ascending: false });

        if (fetchErr) throw fetchErr;

        setDeposits((data || []).map(a => ({
          appointmentId: a.id,
          id: a.id,
          client: a.client_name || 'Client',
          treatment: a.treatment_name || '',
          amount: a.deposit_cents || 0,
          takenDate: a.created_at?.slice(0, 10) || '',
          status: a.deposit_status || 'held',
          method: a.payment_method || 'card',
          appointmentDate: a.starts_at?.slice(0, 10) || null,
          notes: a.notes || '',
        })));
      } catch (err) {
        logger.error('Failed to load deposits:', err);
        setError('Failed to load deposits. Please try again.');
      } finally {
        setLoading(false);
      }
    };

    loadDeposits();
  }, [beautician, bLoading]);

  const held = deposits.filter(d => d.status === 'held');
  const history = deposits.filter(d => d.status !== 'held');

  const totalHeld = held.reduce((s, d) => s + d.amount, 0);
  const totalApplied = deposits.filter(d => d.status === 'applied').reduce((s, d) => s + d.amount, 0);
  const totalRefunded = deposits.filter(d => d.status === 'refunded').reduce((s, d) => s + d.amount, 0);
  const totalForfeited = deposits.filter(d => d.status === 'forfeited').reduce((s, d) => s + d.amount, 0);

  const filtered = tab === 'held' ? held : tab === 'history' ? history : deposits;

  // Handle deposit status changes
  const handleDepositAction = async (depositId, newStatus) => {
    try {
      setLoading(true);
      const updates = { deposit_status: newStatus };

      // Add timestamp for status transitions
      if (newStatus === 'applied') updates.applied_at = new Date().toISOString();
      if (newStatus === 'refunded') updates.refunded_at = new Date().toISOString();
      if (newStatus === 'forfeited') updates.forfeited_at = new Date().toISOString();

      const success = await updateRow('appointments', depositId, updates);

      if (success) {
        // Update local state
        setDeposits(prev =>
          prev.map(d =>
            d.id === depositId ? { ...d, status: newStatus } : d
          )
        );
        setExpanded(null);
        setError(null);
      } else {
        setError('Failed to update deposit. Please try again.');
      }
    } catch (err) {
      logger.error('Failed to update deposit:', err);
      setError('Failed to update deposit. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={S.page}>
      <h1 style={S.title}>Deposit Tracker</h1>

      {/* Error message */}
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
          <span style={S.summaryCount}>{held.length} deposit{held.length !== 1 ? 's' : ''}</span>
        </div>
        <div style={S.summaryBreakdown}>
          {[
            { label: 'Applied', value: totalApplied, colour: 'var(--success, #5BA97B)' },
            { label: 'Refunded', value: totalRefunded, colour: '#2196F3' },
            { label: 'Forfeited', value: totalForfeited, colour: '#F44336' },
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
        {!loading && filtered.length === 0 && <p style={S.empty}>No deposits in this view.</p>}
        {!loading && filtered.map(d => {
          const st = STATUS_CONFIG[d.status];
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
                      <span style={S.detailValue}>{d.method === 'card' ? '💳 Card' : '🏦 Transfer'}</span>
                    </div>
                    {d.appointmentDate && (
                      <div style={S.detailItem}>
                        <span style={S.detailLabel}>Appointment</span>
                        <span style={S.detailValue}>{formatDate(d.appointmentDate)}</span>
                      </div>
                    )}
                    {d.appliedDate && (
                      <div style={S.detailItem}>
                        <span style={S.detailLabel}>Applied</span>
                        <span style={S.detailValue}>{formatDate(d.appliedDate)}</span>
                      </div>
                    )}
                    {d.refundDate && (
                      <div style={S.detailItem}>
                        <span style={S.detailLabel}>Refunded</span>
                        <span style={S.detailValue}>{formatDate(d.refundDate)}</span>
                      </div>
                    )}
                  </div>

                  {d.notes && <p style={S.depositNotes}>{d.notes}</p>}

                  {d.status === 'held' && (
                    <div style={S.actionRow}>
                      <button
                        style={{ ...S.actionBtn, background: 'var(--success, #5BA97B)', color: 'var(--bg-card, #fff)' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDepositAction(d.id, 'applied');
                        }}
                        disabled={loading}
                      >
                        Apply to Bill
                      </button>
                      <button
                        style={S.actionBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDepositAction(d.id, 'refunded');
                        }}
                        disabled={loading}
                      >
                        Refund
                      </button>
                      <button
                        style={{ ...S.actionBtn, color: '#F44336' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDepositAction(d.id, 'forfeited');
                        }}
                        disabled={loading}
                      >
                        Forfeit
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Policy reminder */}
      <div style={S.policyCard}>
        <span style={S.policyTitle}>📌 Deposit Policy</span>
        <p style={S.policyText}>
          Deposits are non-refundable within 24 hours of the appointment. Cancellations outside this window receive a full refund. No-shows forfeit their deposit.
        </p>
        <button style={S.policyLink}>Edit in Policies →</button>
      </div>
    </div>
  );
}

function formatDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

const S = {
  page: { padding: '20px 16px 32px', fontFamily: '"DM Sans", -apple-system, sans-serif', maxWidth: 480, margin: '0 auto' },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text, var(--text-primary, #2D2A26))', margin: '0 0 16px' },

  errorBanner: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--danger-bg, #FDF0EF)', borderRadius: 10, padding: '10px 12px', marginBottom: 16, color: '#C62828', fontSize: 13 },
  errorClose: { background: 'none', border: 'none', color: '#C62828', cursor: 'pointer', fontSize: 16, fontWeight: 600, padding: 0 },

  summaryCard: { background: 'var(--card, #fff)', borderRadius: 14, padding: 16, marginBottom: 16 },
  summaryMain: { display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid var(--border, var(--border, var(--border, #EDE9E4)))' },
  summaryLabel: { fontSize: 12, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', fontWeight: 500 },
  summaryValue: { fontSize: 28, fontWeight: 700, color: 'var(--accent, #C76B8A)' },
  summaryCount: { fontSize: 12, color: 'var(--text-muted, var(--text-muted, #B5AFA8))' },
  summaryBreakdown: { display: 'flex', gap: 8 },
  summaryItem: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  summaryItemVal: { fontSize: 15, fontWeight: 700 },
  summaryItemLabel: { fontSize: 10, color: 'var(--text-muted, var(--text-muted, #B5AFA8))' },

  tabs: { display: 'flex', gap: 8, marginBottom: 16 },
  tab: { flex: 1, padding: '10px 0', border: 'none', borderRadius: 10, background: 'var(--card, #fff)', color: 'var(--text-muted, var(--text-muted, #B5AFA8))', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  tabActive: { background: 'var(--accent, #C76B8A)', color: 'var(--bg-card, #fff)' },

  list: { display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 },
  empty: { textAlign: 'center', color: 'var(--text-muted, var(--text-muted, #B5AFA8))', fontSize: 14, padding: 32 },

  depositCard: { background: 'var(--card, #fff)', borderRadius: 14, padding: 14, cursor: 'pointer' },
  depositHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
  depositLeft: { display: 'flex', gap: 10, alignItems: 'center' },
  avatar: { width: 36, height: 36, borderRadius: 18, background: '#F0E6ED', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 600, color: 'var(--accent, #C76B8A)', flexShrink: 0 },
  depositInfo: { display: 'flex', flexDirection: 'column', gap: 2 },
  depositClient: { fontSize: 14, fontWeight: 600, color: 'var(--text, var(--text-primary, #2D2A26))' },
  depositTreatment: { fontSize: 12, color: 'var(--text-muted, var(--text-muted, #B5AFA8))' },
  depositRight: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 },
  depositAmount: { fontSize: 16, fontWeight: 700, color: 'var(--accent, #C76B8A)' },
  statusBadge: { padding: '3px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600 },

  expandedSection: { marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border, var(--border, var(--border, #EDE9E4)))' },
  detailGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 10 },
  detailItem: { display: 'flex', flexDirection: 'column', gap: 2 },
  detailLabel: { fontSize: 11, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', fontWeight: 600 },
  detailValue: { fontSize: 13, fontWeight: 600, color: 'var(--text, var(--text-primary, #2D2A26))' },
  depositNotes: { fontSize: 12, color: 'var(--text-secondary, #8B6F5E)', fontStyle: 'italic', margin: '8px 0' },
  actionRow: { display: 'flex', gap: 8, marginTop: 8 },
  actionBtn: { flex: 1, padding: '9px 0', borderRadius: 8, border: '1px solid var(--border, var(--border, var(--border, #EDE9E4)))', background: 'var(--card, #fff)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-primary, #2D2A26)' },

  policyCard: { background: '#F9F7F4', borderRadius: 12, padding: 14 },
  policyTitle: { fontSize: 13, fontWeight: 600, color: 'var(--text, var(--text-primary, #2D2A26))' },
  policyText: { fontSize: 12, color: 'var(--text-secondary, #8B6F5E)', lineHeight: 1.4, margin: '6px 0' },
  policyLink: { background: 'none', border: 'none', color: 'var(--accent, #C76B8A)', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0, fontFamily: 'inherit' },
};
