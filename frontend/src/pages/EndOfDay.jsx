import { useState, useEffect, useMemo } from 'react';
import { useBeautician, fetchRows, updateRow, insertRow } from '../lib/supabase.js';
import logger from '../lib/logger.js';
import { todayLocal } from '../lib/dates.js';

export default function EndOfDay() {
  const { beautician, loading: bLoading } = useBeautician();
  const [appointments, setAppointments] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [activeTab, setActiveTab] = useState('summary');
  const [cashCounted, setCashCounted] = useState('');
  const [isReconciled, setIsReconciled] = useState(false);
  const [closingNotes, setClosingNotes] = useState('');
  const [dayClosed, setDayClosed] = useState(false);
  const [loading, setLoading] = useState(true);

  const today = todayLocal();
  const todayDisplay = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

  useEffect(() => {
    if (bLoading || !beautician) return;

    async function load() {
      try {
        const [appts, txns, exps, existingReport] = await Promise.all([
          fetchRows('appointments', beautician.id, { order: 'starts_at', ascending: true }),
          fetchRows('transactions', beautician.id, { order: 'created_at', ascending: true }),
          fetchRows('expenses', beautician.id, { order: 'created_at', ascending: true }),
          fetchRows('end_of_day_reports', beautician.id, { eq: { date: today } }),
        ]);

        setAppointments((appts || []).filter(a => a.starts_at?.startsWith(today)));
        setTransactions((txns || []).filter(t => t.created_at?.startsWith(today)));
        setExpenses((exps || []).filter(e => e.created_at?.startsWith(today)));

        // If already closed today, restore state
        if (existingReport?.length) {
          setDayClosed(true);
          const r = existingReport[0];
          if (r.cash_counted_cents != null) setCashCounted((r.cash_counted_cents / 100).toFixed(2));
          if (r.closing_notes) setClosingNotes(r.closing_notes);
          setIsReconciled(true);
        }
      } catch (err) {
        logger.error({ err }, 'Failed to load end of day data');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [beautician, bLoading, today]);

  const stats = useMemo(() => {
    const completed = appointments.filter(a => a.status === 'completed');
    const noShows = appointments.filter(a => a.status === 'no-show' || a.status === 'no_show');
    const cancelled = appointments.filter(a => a.status === 'cancelled');
    const newClients = appointments.filter(a => a.is_new_client);

    // Revenue from transactions
    const completedTxns = transactions.filter(t => t.status === 'completed');
    const payments = completedTxns.filter(t => t.type === 'payment' || t.type === 'deposit');
    const tips = completedTxns.filter(t => t.type === 'tip');
    const refunds = completedTxns.filter(t => t.type === 'refunded' || t.type === 'refund');

    const totalRevenueCents = payments.reduce((s, t) => s + (t.amount_cents || 0), 0)
      - refunds.reduce((s, t) => s + (t.amount_cents || 0), 0);
    const tipsCents = tips.reduce((s, t) => s + (t.amount_cents || 0), 0);

    // Cash vs card breakdown from transactions
    const cashCents = payments
      .filter(t => t.payment_method === 'cash')
      .reduce((s, t) => s + (t.amount_cents || 0), 0);
    const cardCents = payments
      .filter(t => t.payment_method && t.payment_method !== 'cash')
      .reduce((s, t) => s + (t.amount_cents || 0), 0);

    // If no transactions yet, estimate from appointments
    const fallbackRevenue = completed.reduce((s, a) => s + (a.price_cents || 0), 0);
    const useTransactions = payments.length > 0;
    const revenue = useTransactions ? totalRevenueCents : fallbackRevenue;

    // Expenses
    const totalExpensesCents = expenses.reduce((s, e) => s + (e.amount_cents || 0), 0);

    const avgTicket = completed.length > 0 ? revenue / completed.length : 0;
    // Utilisation: completed / total booked (excluding cancelled)
    const bookable = appointments.length - cancelled.length;
    const utilisation = bookable > 0 ? Math.round((completed.length / bookable) * 100) : 0;

    return {
      totalRevenue: revenue / 100,
      cashTaken: cashCents / 100,
      cardTaken: cardCents / 100,
      voucherRedeemed: 0, // TODO: wire up voucher redemptions when table exists
      tipsReceived: tipsCents / 100,
      expenses: totalExpensesCents / 100,
      appointments: appointments.length,
      completed: completed.length,
      noShows: noShows.length,
      cancelled: cancelled.length,
      newClients: newClients.length,
      avgTicket: avgTicket / 100,
      utilisation,
      useTransactions,
    };
  }, [appointments, transactions, expenses]);

  const timeline = useMemo(() => {
    return appointments.map(a => ({
      time: a.starts_at?.slice(11, 16) || '',
      client: a.client_name || 'Client',
      treatment: a.treatment_name || '',
      amount: (a.price_cents || 0) / 100,
      status: a.status || 'pending',
      method: a.payment_method || 'card',
    }));
  }, [appointments]);

  const autoNotes = useMemo(() => {
    const notes = [];
    const noShows = appointments.filter(a => a.status === 'no-show' || a.status === 'no_show');
    const cancelled = appointments.filter(a => a.status === 'cancelled');

    noShows.forEach(a => {
      notes.push(`${a.client_name || 'Client'} - no-show for ${a.treatment_name || 'appointment'}`);
    });
    cancelled.forEach(a => {
      notes.push(`${a.client_name || 'Client'} - cancelled ${a.treatment_name || 'appointment'}`);
    });
    if (stats.newClients > 0) {
      notes.push(`${stats.newClients} new client${stats.newClients > 1 ? 's' : ''} today`);
    }
    if (notes.length === 0) notes.push('Clean day - no issues to flag');
    return notes;
  }, [appointments, stats.newClients]);

  const saveEndOfDay = async () => {
    if (!beautician) return;

    const existing = await fetchRows('end_of_day_reports', beautician.id, { eq: { date: today } });
    const reportData = {
      beautician_id: beautician.id,
      date: today,
      total_revenue_cents: Math.round(stats.totalRevenue * 100),
      appointments_total: stats.appointments,
      appointments_completed: stats.completed,
      appointments_noshow: stats.noShows,
      appointments_cancelled: stats.cancelled,
      cash_expected_cents: Math.round(stats.cashTaken * 100),
      cash_counted_cents: cashCounted ? Math.round(parseFloat(cashCounted) * 100) : null,
      card_taken_cents: Math.round(stats.cardTaken * 100),
      tips_cents: Math.round(stats.tipsReceived * 100),
      closing_notes: closingNotes,
    };

    try {
      if (existing.length > 0) {
        await updateRow('end_of_day_reports', existing[0].id, reportData);
      } else {
        await insertRow('end_of_day_reports', reportData);
      }
      setDayClosed(true);
    } catch (err) {
      logger.error({ err }, 'Failed to save end of day report');
    }
  };

  if (bLoading || loading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted, #6B5D54)' }}>Loading...</div>;

  const d = stats;
  const cashDiff = cashCounted ? (parseFloat(cashCounted) - d.cashTaken).toFixed(2) : null;

  const tabs = [
    { id: 'summary', label: 'Summary' },
    { id: 'timeline', label: 'Timeline' },
    { id: 'cashup', label: 'Cash Up' },
    { id: 'notes', label: 'Notes' },
  ];

  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={styles.header}>
        <h1 style={styles.title}>End of Day</h1>
        <span style={styles.dateChip}>{todayDisplay}</span>
      </div>

      {dayClosed && (
        <div style={styles.closedBanner}>
          <span style={{ fontSize: 18 }}>&#x2705;</span>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>Day Closed</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted, #6B5D54)' }}>All reconciled and logged</div>
          </div>
        </div>
      )}

      {/* Revenue hero */}
      <div style={styles.heroCard}>
        <div style={styles.heroLabel}>Today's Revenue</div>
        <div style={styles.heroAmount}>
          {d.totalRevenue > 0 ? `\u00A3${d.totalRevenue.toFixed(2)}` : '\u00A30.00'}
        </div>
        <div style={styles.heroBreakdown}>
          <span>{'\uD83D\uDCB3'} £{d.cardTaken.toFixed(2)}</span>
          <span>{'\uD83D\uDCB5'} £{d.cashTaken.toFixed(2)}</span>
          {d.voucherRedeemed > 0 && <span>{'\uD83C\uDF81'} £{d.voucherRedeemed.toFixed(2)}</span>}
        </div>
        {!d.useTransactions && d.totalRevenue > 0 && (
          <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>
            Estimated from appointment prices (no payment data yet)
          </div>
        )}
        <div style={styles.heroStats}>
          <div style={styles.heroStat}>
            <div style={styles.heroStatValue}>{d.appointments}</div>
            <div style={styles.heroStatLabel}>Booked</div>
          </div>
          <div style={styles.heroStat}>
            <div style={styles.heroStatValue}>{d.completed}</div>
            <div style={styles.heroStatLabel}>Done</div>
          </div>
          <div style={styles.heroStat}>
            <div style={{ ...styles.heroStatValue, color: d.noShows > 0 ? '#E85D75' : 'inherit' }}>{d.noShows}</div>
            <div style={styles.heroStatLabel}>No-show</div>
          </div>
          <div style={styles.heroStat}>
            <div style={styles.heroStatValue}>{d.avgTicket > 0 ? `\u00A3${d.avgTicket.toFixed(0)}` : '--'}</div>
            <div style={styles.heroStatLabel}>Avg ticket</div>
          </div>
        </div>
      </div>

      {/* Empty state */}
      {appointments.length === 0 && (
        <div style={styles.emptyState}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>{'\uD83C\uDF19'}</div>
          <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>No appointments today</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted, #6B5D54)' }}>Your summary will appear here at the end of each working day</div>
        </div>
      )}

      {/* Tabs */}
      {appointments.length > 0 && (
        <>
          <div style={styles.tabs}>
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{ ...styles.tab,
                  ...(activeTab === tab.id ? styles.tabActive : {})
                }}
              >{tab.label}</button>
            ))}
          </div>

          {/* Summary tab */}
          {activeTab === 'summary' && (
            <div style={styles.section}>
              <div style={styles.statsGrid}>
                <div style={styles.statCard}>
                  <div style={styles.statIcon}>{'\uD83C\uDFAF'}</div>
                  <div style={styles.statValue}>{d.utilisation}%</div>
                  <div style={styles.statLabel}>Utilisation</div>
                  <div style={styles.utilBar}>
                    <div style={{ ...styles.utilFill, width: `${d.utilisation}%` }} />
                  </div>
                </div>
                <div style={styles.statCard}>
                  <div style={styles.statIcon}>{'\uD83D\uDC64'}</div>
                  <div style={styles.statValue}>{d.newClients}</div>
                  <div style={styles.statLabel}>New clients</div>
                </div>
                <div style={styles.statCard}>
                  <div style={styles.statIcon}>{'\uD83D\uDC9D'}</div>
                  <div style={styles.statValue}>{d.tipsReceived > 0 ? `\u00A3${d.tipsReceived.toFixed(2)}` : '--'}</div>
                  <div style={styles.statLabel}>Tips</div>
                </div>
                <div style={styles.statCard}>
                  <div style={styles.statIcon}>{'\uD83D\uDCE4'}</div>
                  <div style={styles.statValue}>{d.expenses > 0 ? `\u00A3${d.expenses.toFixed(2)}` : '--'}</div>
                  <div style={styles.statLabel}>Expenses</div>
                </div>
                {d.totalRevenue > 0 && (
                  <div style={{ ...styles.statCard, gridColumn: '1 / -1' }}>
                    <div style={styles.statIcon}>{'\uD83D\uDCB0'}</div>
                    <div style={styles.statValue}>£{(d.totalRevenue - d.expenses + d.tipsReceived).toFixed(2)}</div>
                    <div style={styles.statLabel}>Net take-home</div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Timeline tab */}
          {activeTab === 'timeline' && (
            <div style={styles.section}>
              {timeline.map((appt, i) => (
                <div key={i} style={styles.timelineRow}>
                  <div style={styles.timelineTime}>{appt.time}</div>
                  <div style={styles.timelineDot(appt.status)} />
                  <div style={{ flex: 1 }}>
                    <div style={styles.timelineClient}>{appt.client}</div>
                    <div style={styles.timelineTreatment}>{appt.treatment}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    {appt.status === 'completed' && (
                      <>
                        <div style={styles.timelineAmount}>£{appt.amount.toFixed(2)}</div>
                        <div style={styles.timelineMethod}>{appt.method === 'cash' ? '\uD83D\uDCB5' : '\uD83D\uDCB3'} {appt.method}</div>
                      </>
                    )}
                    {(appt.status === 'no-show' || appt.status === 'no_show') && <span style={styles.badgeNoShow}>No-show</span>}
                    {appt.status === 'cancelled' && <span style={styles.badgeCancelled}>Cancelled</span>}
                    {appt.status === 'pending' && <span style={styles.badgePending}>Pending</span>}
                    {appt.status === 'confirmed' && <span style={styles.badgeConfirmed}>Confirmed</span>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Cash Up tab */}
          {activeTab === 'cashup' && (
            <div style={styles.section}>
              <div style={styles.optionalBanner}>
                <span style={{ fontSize: 14 }}>{'\uD83D\uDCA1'}</span>
                <span style={{ fontSize: 12, color: 'var(--text-secondary, #574A42)', lineHeight: 1.4 }}>
                  This is optional. Card payments and bookings are tracked automatically -
                  use this only if you want to reconcile cash at the end of the day.
                </span>
              </div>

              <div style={styles.cashupCard}>
                <div style={styles.cashupRow}>
                  <span style={{ fontSize: 14, color: 'var(--text-secondary, #574A42)' }}>Expected cash (from bookings)</span>
                  <span style={{ fontSize: 16, fontWeight: 600 }}>£{d.cashTaken.toFixed(2)}</span>
                </div>
                <div style={styles.cashupDivider} />
                <div style={{ marginBottom: 16 }}>
                  <label style={styles.inputLabel}>Cash counted (optional)</label>
                  <div style={styles.cashInput}>
                    <span style={{ color: 'var(--text-muted, #6B5D54)', fontSize: 18 }}>£</span>
                    <input
                      type="number"
                      value={cashCounted}
                      onChange={e => setCashCounted(e.target.value)}
                      placeholder="0.00"
                      style={styles.input}
                      step="0.01"
                    />
                  </div>
                </div>
                {cashDiff !== null && (
                  <div style={{ ...styles.diffBadge,
                    background: parseFloat(cashDiff) === 0 ? 'var(--success-bg, #E9F0EB)' : 'var(--warning-bg, #F7EEDD)',
                    color: parseFloat(cashDiff) === 0 ? '#2E7D32' : '#E65100',
                  }}>
                    {parseFloat(cashDiff) === 0
                      ? '\u2705 Exact match'
                      : `${parseFloat(cashDiff) > 0 ? '\u2B06\uFE0F Over' : '\u2B07\uFE0F Under'} by \u00A3${Math.abs(parseFloat(cashDiff)).toFixed(2)}`
                    }
                  </div>
                )}
                <div style={styles.cashupDivider} />
                <div style={styles.cashupRow}>
                  <span style={{ fontSize: 14, color: 'var(--text-secondary, #574A42)' }}>Card payments (auto)</span>
                  <span style={{ fontSize: 14, fontWeight: 500 }}>£{d.cardTaken.toFixed(2)}</span>
                </div>
                <div style={styles.cashupRow}>
                  <span style={{ fontSize: 14, color: 'var(--text-secondary, #574A42)' }}>Tips collected</span>
                  <span style={{ fontSize: 14, fontWeight: 500 }}>£{d.tipsReceived.toFixed(2)}</span>
                </div>
              </div>

              {cashCounted && (
                <button
                  onClick={() => setIsReconciled(true)}
                  style={{ ...styles.reconBtn,
                    background: isReconciled ? 'var(--success, #3F7D5C)' : 'var(--accent, #92405e)'
                  }}
                >
                  {isReconciled ? '\u2713 Reconciled' : 'Mark as Reconciled'}
                </button>
              )}
            </div>
          )}

          {/* Notes tab */}
          {activeTab === 'notes' && (
            <div style={styles.section}>
              <div style={styles.notesHeader}>Auto-generated notes</div>
              {autoNotes.map((note, i) => (
                <div key={i} style={styles.noteCard}>
                  <span style={{ fontSize: 14 }}>{'\uD83D\uDCCC'}</span>
                  <span style={{ fontSize: 13, color: 'var(--text-secondary, #574A42)', lineHeight: 1.5 }}>{note}</span>
                </div>
              ))}

              <div style={{ marginTop: 20 }}>
                <label style={styles.inputLabel}>Closing notes</label>
                <textarea
                  value={closingNotes}
                  onChange={e => setClosingNotes(e.target.value)}
                  placeholder="Anything to note for tomorrow..."
                  rows={3}
                  style={styles.textarea}
                />
              </div>
            </div>
          )}
        </>
      )}

      {/* Close day button */}
      {!dayClosed && appointments.length > 0 && (
        <div style={styles.closeDayWrap}>
          <button
            onClick={saveEndOfDay}
            style={styles.closeDayBtn}
          >
            {'\uD83D\uDD12'} Close Day
          </button>
          {!isReconciled && (
            <div style={styles.closeDayHint}>Cash up is optional - close whenever you're ready</div>
          )}
        </div>
      )}
    </div>
  );
}

const styles = {
  page: { padding: '16px 16px 24px', fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif", maxWidth: 480, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text-primary, #241B17)', margin: 0 },
  dateChip: { fontSize: 12, color: 'var(--text-secondary, #574A42)', background: 'var(--bg-hover, #f3ede9)', padding: '4px 10px', borderRadius: 12 },

  closedBanner: { display: 'flex', alignItems: 'center', gap: 12, background: 'var(--success-bg, #E9F0EB)', borderRadius: 12, padding: '12px 16px', marginBottom: 16 },

  heroCard: { background: 'linear-gradient(135deg, #C76B8A 0%, #A85575 100%)', borderRadius: 16, padding: 20, marginBottom: 16, color: 'var(--bg-card, #FFFCF9)' },
  heroLabel: { fontSize: 12, opacity: 0.8, marginBottom: 4 },
  heroAmount: { fontSize: 32, fontWeight: 700, marginBottom: 8 },
  heroBreakdown: { display: 'flex', gap: 16, fontSize: 13, opacity: 0.9, marginBottom: 16 },
  heroStats: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, borderTop: '1px solid rgba(255,255,255,0.2)', paddingTop: 12 },
  heroStat: { textAlign: 'center' },
  heroStatValue: { fontSize: 18, fontWeight: 700 },
  heroStatLabel: { fontSize: 10, opacity: 0.7 },

  emptyState: { textAlign: 'center', padding: '40px 20px', background: 'var(--bg-card, #FFFCF9)', borderRadius: 16, border: '1px solid var(--border-light, #ede7e3)' },

  tabs: { display: 'flex', gap: 4, marginBottom: 16, background: 'var(--bg-hover, #f3ede9)', borderRadius: 12, padding: 4 },
  tab: { flex: 1, padding: '8px 0', fontSize: 13, fontWeight: 500, border: 'none', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit', background: 'none', color: 'var(--text-secondary, #574A42)' },
  tabActive: { background: 'var(--bg-card, #FFFCF9)', color: 'var(--text-primary, #241B17)', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' },

  section: { marginBottom: 24 },

  statsGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 16 },
  statCard: { background: 'var(--bg-card, #FFFCF9)', borderRadius: 12, padding: 14, border: '1px solid var(--border-light, #ede7e3)' },
  statIcon: { fontSize: 16, marginBottom: 6 },
  statValue: { fontSize: 20, fontWeight: 700, color: 'var(--text-primary, #241B17)' },
  statLabel: { fontSize: 11, color: 'var(--text-muted, #6B5D54)', marginTop: 2 },
  utilBar: { height: 4, background: 'var(--border-light, #ede7e3)', borderRadius: 2, marginTop: 8 },
  utilFill: { height: '100%', background: 'var(--accent, #92405e)', borderRadius: 2, transition: 'width 0.3s' },

  timelineRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid #F0ECE8' },
  timelineTime: { fontSize: 13, fontWeight: 600, color: 'var(--text-muted, #6B5D54)', width: 42, flexShrink: 0 },
  timelineDot: (status) => ({ width: 8, height: 8, borderRadius: 4, flexShrink: 0, background: status === 'completed' ? 'var(--success, #3F7D5C)' : (status === 'no-show' || status === 'no_show') ? 'var(--danger, #9E2B32)' : status === 'cancelled' ? 'var(--warning, #8A6420)' : status === 'confirmed' ? 'var(--success, #3F7D5C)' : 'var(--text-muted, #6B5D54)' }),
  timelineClient: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #241B17)' },
  timelineTreatment: { fontSize: 12, color: 'var(--text-muted, #6B5D54)' },
  timelineAmount: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #241B17)' },
  timelineMethod: { fontSize: 11, color: 'var(--text-muted, #6B5D54)' },
  badgeNoShow: { fontSize: 11, color: '#E85D75', background: 'var(--danger-bg, #F7E4E4)', padding: '3px 8px', borderRadius: 8, fontWeight: 600 },
  badgeCancelled: { fontSize: 11, color: '#F57C00', background: 'var(--warning-bg, #F7EEDD)', padding: '3px 8px', borderRadius: 8, fontWeight: 600 },
  badgePending: { fontSize: 11, color: '#757575', background: 'var(--bg-hover, #f3ede9)', padding: '3px 8px', borderRadius: 8, fontWeight: 600 },
  badgeConfirmed: { fontSize: 11, color: '#2E7D32', background: 'var(--success-bg, #E9F0EB)', padding: '3px 8px', borderRadius: 8, fontWeight: 600 },

  optionalBanner: { display: 'flex', gap: 8, alignItems: 'flex-start', background: '#FFF8F0', border: '1px solid #FFE8CC', borderRadius: 10, padding: '10px 12px', marginBottom: 12 },
  cashupCard: { background: 'var(--bg-card, #FFFCF9)', borderRadius: 14, padding: 16, border: '1px solid var(--border-light, #ede7e3)', marginBottom: 16 },
  cashupRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0' },
  cashupDivider: { height: 1, background: 'var(--border-light, #ede7e3)', margin: '8px 0' },
  inputLabel: { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary, #574A42)', display: 'block', marginBottom: 6 },
  cashInput: { display: 'flex', alignItems: 'center', gap: 6, background: 'var(--bg, var(--bg, #FBF6F1))', border: '1.5px solid var(--border, #E8DDD4)', borderRadius: 10, padding: '10px 12px' },
  input: { border: 'none', background: 'none', fontSize: 18, fontWeight: 600, outline: 'none', width: '100%', fontFamily: 'inherit', color: 'var(--text-primary, #241B17)' },
  diffBadge: { padding: '10px 14px', borderRadius: 10, fontSize: 14, fontWeight: 600, textAlign: 'center', marginBottom: 12 },
  reconBtn: { width: '100%', padding: '14px 0', borderRadius: 12, border: 'none', color: 'var(--bg-card, #FFFCF9)', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  notesHeader: { fontSize: 13, fontWeight: 600, color: 'var(--text-muted, #6B5D54)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 },
  noteCard: { display: 'flex', gap: 8, background: 'var(--bg-card, #FFFCF9)', borderRadius: 10, padding: 12, border: '1px solid var(--border-light, #ede7e3)', marginBottom: 8 },
  textarea: { width: '100%', padding: 12, borderRadius: 10, border: '1.5px solid var(--border, #E8DDD4)', fontSize: 14, fontFamily: 'inherit', resize: 'vertical', outline: 'none', background: 'var(--bg, var(--bg, #FBF6F1))', color: 'var(--text-primary, #241B17)', boxSizing: 'border-box' },

  closeDayWrap: { textAlign: 'center', marginTop: 8, paddingBottom: 20 },
  closeDayBtn: { width: '100%', padding: '16px 0', borderRadius: 14, border: 'none', background: 'var(--text-primary, #241B17)', color: 'var(--bg-card, #FFFCF9)', fontSize: 16, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  closeDayHint: { fontSize: 12, color: 'var(--text-muted, #6B5D54)', marginTop: 8 },
};
