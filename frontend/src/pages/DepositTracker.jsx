/**
 * Deposit Tracker — Track all held deposits, refunds & forfeitures.
 *
 * Semi-permanent treatments, no-show policies, waitlist holds —
 * deposits are everywhere. This page tracks every penny held,
 * when it was taken, and what happened to it.
 */
import { useState, useEffect } from 'react';
import { useBeautician, fetchRows, isDevMode } from '../lib/supabase.js';
import logger from '../lib/logger.js';

const fmt = (cents) => `£${(Math.abs(cents) / 100).toFixed(2)}`;

const DEV_DEPOSITS = [
  { id: 'd1', client: 'Holly B', treatment: 'Ombre Brows (Semi-Permanent)', amount: 5000, takenDate: '2026-03-10', status: 'held', method: 'card', appointmentDate: '2026-04-05', notes: 'Waitlist deposit — slot confirmed' },
  { id: 'd2', client: 'Megan S', treatment: 'HD Brows', amount: 2500, takenDate: '2026-03-15', status: 'held', method: 'card', appointmentDate: '2026-03-29', notes: 'Standard booking deposit' },
  { id: 'd3', client: 'Amy R', treatment: 'Ombre Brows (Semi-Permanent)', amount: 5000, takenDate: '2026-03-20', status: 'held', method: 'card', appointmentDate: '2026-04-10', notes: 'Post-consultation deposit' },
  { id: 'd4', client: 'Beth K', treatment: 'Combination Brows', amount: 5000, takenDate: '2026-03-18', status: 'held', method: 'bank-transfer', appointmentDate: null, notes: 'Awaiting GP clearance — deposit held' },
  { id: 'd5', client: 'Daisy S', treatment: 'Ombre Brows (Semi-Permanent)', amount: 12500, takenDate: '2026-02-25', status: 'applied', method: 'card', appointmentDate: '2026-03-12', appliedDate: '2026-03-12', notes: '50% deposit deducted from final bill' },
  { id: 'd6', client: 'Chloe M', treatment: 'Ombre Brows (Semi-Permanent)', amount: 5000, takenDate: '2026-03-01', status: 'applied', method: 'card', appointmentDate: '2026-03-22', appliedDate: '2026-03-22', notes: 'Consultation deposit applied to treatment' },
  { id: 'd7', client: 'Lucy P', treatment: 'Lash Lift & Tint', amount: 1000, takenDate: '2026-02-20', status: 'refunded', method: 'card', appointmentDate: '2026-03-01', refundDate: '2026-02-28', notes: 'Client cancelled within 48h window — full refund' },
  { id: 'd8', client: 'Natalie W', treatment: 'Colour Boost', amount: 2500, takenDate: '2026-02-10', status: 'forfeited', method: 'card', appointmentDate: '2026-02-25', notes: 'No-show — deposit kept per policy' },
];

const STATUS_CONFIG = {
  held: { label: 'Held', bg: '#FFF5E6', color: '#B8860B', icon: '⏳' },
  applied: { label: 'Applied', bg: '#E8F5E9', color: '#4CAF50', icon: '✓' },
  refunded: { label: 'Refunded', bg: '#E3F2FD', color: '#2196F3', icon: '↩' },
  forfeited: { label: 'Forfeited', bg: '#FFEBEE', color: '#F44336', icon: '✗' },
};

export default function DepositTracker({ token }) {
  const { beautician, loading: bLoading } = useBeautician();
  const [tab, setTab] = useState('held');
  const [expanded, setExpanded] = useState(null);
  const [showAction, setShowAction] = useState(null);
  const [deposits, setDeposits] = useState(DEV_DEPOSITS);

  // Fetch deposits (query appointments where deposit_cents > 0)
  useEffect(() => {
    if (bLoading || !beautician) return;
    if (isDevMode) {
      setDeposits(DEV_DEPOSITS);
      return;
    }
    fetchRows('appointments', beautician.id, { order: 'start_time', ascending: false })
      .then(appts => {
        const withDeposits = appts.filter(a => a.deposit_cents && a.deposit_cents > 0);
        setDeposits(withDeposits.map(a => ({
          id: a.id,
          client: a.client_name || 'Client',
          treatment: a.treatment_name || '',
          amount: a.deposit_cents || 0,
          takenDate: a.created_at?.slice(0, 10) || '',
          status: a.deposit_status || 'held',
          method: a.payment_method || 'card',
          appointmentDate: a.start_time?.slice(0, 10) || null,
          notes: a.notes || '',
        })));
      })
      .catch(err => logger.error('Failed to load deposits:', err));
  }, [beautician, bLoading]);

  const held = deposits.filter(d => d.status === 'held');
  const history = deposits.filter(d => d.status !== 'held');

  const totalHeld = held.reduce((s, d) => s + d.amount, 0);
  const totalApplied = deposits.filter(d => d.status === 'applied').reduce((s, d) => s + d.amount, 0);
  const totalRefunded = deposits.filter(d => d.status === 'refunded').reduce((s, d) => s + d.amount, 0);
  const totalForfeited = deposits.filter(d => d.status === 'forfeited').reduce((s, d) => s + d.amount, 0);

  const filtered = tab === 'held' ? held : tab === 'history' ? history : deposits;

  return (
    <div style={S.page}>
      <h1 style={S.title}>Deposit Tracker</h1>

      {/* Summary */}
      <div style={S.summaryCard}>
        <div style={S.summaryMain}>
          <span style={S.summaryLabel}>Currently Held</span>
          <span style={S.summaryValue}>{fmt(totalHeld)}</span>
          <span style={S.summaryCount}>{held.length} deposit{held.length !== 1 ? 's' : ''}</span>
        </div>
        <div style={S.summaryBreakdown}>
          {[
            { label: 'Applied', value: totalApplied, colour: '#4CAF50' },
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
        {filtered.length === 0 && <p style={S.empty}>No deposits in this view.</p>}
        {filtered.map(d => {
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
                      <button style={{ ...S.actionBtn, background: '#4CAF50', color: '#fff' }}>Apply to Bill</button>
                      <button style={S.actionBtn}>Refund</button>
                      <button style={{ ...S.actionBtn, color: '#F44336' }}>Forfeit</button>
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
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: '0 0 16px' },

  summaryCard: { background: 'var(--card, #fff)', borderRadius: 14, padding: 16, marginBottom: 16 },
  summaryMain: { display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid #F0ECE8' },
  summaryLabel: { fontSize: 12, color: '#AAA5A0', fontWeight: 500 },
  summaryValue: { fontSize: 28, fontWeight: 700, color: '#C76B8A' },
  summaryCount: { fontSize: 12, color: '#AAA5A0' },
  summaryBreakdown: { display: 'flex', gap: 8 },
  summaryItem: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  summaryItemVal: { fontSize: 15, fontWeight: 700 },
  summaryItemLabel: { fontSize: 10, color: '#AAA5A0' },

  tabs: { display: 'flex', gap: 8, marginBottom: 16 },
  tab: { flex: 1, padding: '10px 0', border: 'none', borderRadius: 10, background: 'var(--card, #fff)', color: '#AAA5A0', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  tabActive: { background: '#C76B8A', color: '#fff' },

  list: { display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 },
  empty: { textAlign: 'center', color: '#AAA5A0', fontSize: 14, padding: 32 },

  depositCard: { background: 'var(--card, #fff)', borderRadius: 14, padding: 14, cursor: 'pointer' },
  depositHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
  depositLeft: { display: 'flex', gap: 10, alignItems: 'center' },
  avatar: { width: 36, height: 36, borderRadius: 18, background: '#F0E6ED', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 600, color: '#C76B8A', flexShrink: 0 },
  depositInfo: { display: 'flex', flexDirection: 'column', gap: 2 },
  depositClient: { fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  depositTreatment: { fontSize: 12, color: '#AAA5A0' },
  depositRight: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 },
  depositAmount: { fontSize: 16, fontWeight: 700, color: '#C76B8A' },
  statusBadge: { padding: '3px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600 },

  expandedSection: { marginTop: 12, paddingTop: 12, borderTop: '1px solid #F0ECE8' },
  detailGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 10 },
  detailItem: { display: 'flex', flexDirection: 'column', gap: 2 },
  detailLabel: { fontSize: 11, color: '#AAA5A0', fontWeight: 600 },
  detailValue: { fontSize: 13, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  depositNotes: { fontSize: 12, color: '#8B6F5E', fontStyle: 'italic', margin: '8px 0' },
  actionRow: { display: 'flex', gap: 8, marginTop: 8 },
  actionBtn: { flex: 1, padding: '9px 0', borderRadius: 8, border: '1px solid #F0ECE8', background: 'var(--card, #fff)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', color: '#2D2A26' },

  policyCard: { background: '#F9F7F4', borderRadius: 12, padding: 14 },
  policyTitle: { fontSize: 13, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  policyText: { fontSize: 12, color: '#8B6F5E', lineHeight: 1.4, margin: '6px 0' },
  policyLink: { background: 'none', border: 'none', color: '#C76B8A', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0, fontFamily: 'inherit' },
};
