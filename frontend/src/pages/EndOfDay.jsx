import { useState, useEffect } from 'react';
import { useBeautician, fetchRows, updateRow, insertRow } from '../lib/supabase.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';

const mockToday = {
  date: 'Wed 26 Mar 2026',
  totalRevenue: 485.00,
  cashTaken: 120.00,
  cardTaken: 345.00,
  voucherRedeemed: 20.00,
  appointments: 12,
  completed: 10,
  noShows: 1,
  cancelled: 1,
  newClients: 3,
  productsRetailed: 2,
  retailRevenue: 35.00,
  tipsReceived: 28.50,
  expenses: 15.00,
  avgTicket: 48.50,
  utilisation: 82,
};

const mockTimeline = [
  { time: '09:00', client: 'Sarah M.', treatment: 'Brow Lamination', amount: 45, status: 'completed', method: 'card' },
  { time: '09:45', client: 'Katie L.', treatment: 'Lash Lift & Tint', amount: 55, status: 'completed', method: 'card' },
  { time: '10:30', client: 'Jess P.', treatment: 'Brow Wax & Tint', amount: 28, status: 'completed', method: 'cash' },
  { time: '11:15', client: 'Amy R.', treatment: 'Ombre Brows (Touch-up)', amount: 75, status: 'completed', method: 'card' },
  { time: '12:00', client: 'Danielle W.', treatment: 'Brow Lamination', amount: 45, status: 'no-show', method: null },
  { time: '13:00', client: 'Lauren T.', treatment: 'Classic Lash Extensions', amount: 65, status: 'completed', method: 'card' },
  { time: '14:00', client: 'Rachel S.', treatment: 'Brow Wax & Shape', amount: 22, status: 'completed', method: 'cash' },
  { time: '14:30', client: 'Megan K.', treatment: 'Lash Lift', amount: 40, status: 'completed', method: 'card' },
  { time: '15:15', client: 'Chloe B.', treatment: 'Brow Tint', amount: 15, status: 'cancelled', method: null },
  { time: '15:45', client: 'Ellie H.', treatment: 'HD Brows', amount: 35, status: 'completed', method: 'cash' },
  { time: '16:30', client: 'Sophie D.', treatment: 'Brow Lamination + Tint', amount: 50, status: 'completed', method: 'card' },
  { time: '17:15', client: 'Jade C.', treatment: 'Lash Lift & Tint', amount: 55, status: 'completed', method: 'card' },
];

const mockDiscrepancies = [];

const mockNotes = [
  'Danielle W. no-show — 2nd time this month, deposit policy triggered',
  'Chloe B. cancelled 30 mins before — no fee (first offence)',
  'New retail display arrived — logged 2 units sold from counter'
];

export default function EndOfDay() {
  const { beautician, loading: bLoading } = useBeautician();
  const [dayData, setDayData] = useState(mockToday);
  const [timeline, setTimeline] = useState(mockTimeline);
  const [notes, setNotes] = useState(mockNotes);
  const [activeTab, setActiveTab] = useState('summary');
  const [cashCounted, setCashCounted] = useState('');
  const [isReconciled, setIsReconciled] = useState(false);
  const [closingNotes, setClosingNotes] = useState('');
  const [dayClosed, setDayClosed] = useState(false);

  useEffect(() => {
    if (bLoading) return;
    if (!beautician) return;
    const today = new Date().toISOString().slice(0, 10);
    // Fetch today's appointments for timeline
    fetchRows('appointments', beautician.id, { order: 'starts_at', ascending: true })
      .then(rows => {
        const todayAppts = rows.filter(a => a.starts_at?.startsWith(today));
        if (todayAppts.length) {
          setTimeline(todayAppts.map(a => ({
            time: a.starts_at?.slice(11, 16) || '',
            client: a.client_name || 'Client',
            treatment: a.treatment_name || '',
            amount: (a.price_cents || 0) / 100,
            status: a.status || 'completed',
            method: a.payment_method || 'card',
          })));
        }
      });
    // Fetch today's transactions for revenue summary
  }, [beautician, bLoading]);

  // Save end-of-day report (upsert)
  const saveEndOfDay = async () => {
    if (!beautician) return;
    const todayStr = new Date().toISOString().slice(0, 10);

    // Check if report exists for today
    const existing = await fetchRows('end_of_day_reports', beautician.id, { eq: { date: todayStr } });
    const reportData = {
      beautician_id: beautician.id,
      date: todayStr,
      total_revenue_cents: Math.round(dayData.totalRevenue * 100),
      appointments_total: dayData.appointments,
      appointments_completed: dayData.completed,
      appointments_noshow: dayData.noShows,
      appointments_cancelled: dayData.cancelled,
      cash_expected_cents: Math.round(dayData.cashTaken * 100),
      cash_counted_cents: cashCounted ? Math.round(parseFloat(cashCounted) * 100) : null,
      card_taken_cents: Math.round(dayData.cardTaken * 100),
      tips_cents: Math.round(dayData.tipsReceived * 100),
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

  if (bLoading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted, #AAA5A0)' }}>Loading...</div>;

  const d = dayData;
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
        <span style={styles.dateChip}>{d.date}</span>
      </div>

      {dayClosed && (
        <div style={styles.closedBanner}>
          <span style={{ fontSize: 18 }}>✅</span>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>Day Closed</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted, #AAA5A0)' }}>All reconciled and logged</div>
          </div>
        </div>
      )}

      {/* Revenue hero */}
      <div style={styles.heroCard}>
        <div style={styles.heroLabel}>Today's Revenue</div>
        <div style={styles.heroAmount}>£{d.totalRevenue.toFixed(2)}</div>
        <div style={styles.heroBreakdown}>
          <span>💳 £{d.cardTaken.toFixed(2)}</span>
          <span>💵 £{d.cashTaken.toFixed(2)}</span>
          <span>🎁 £{d.voucherRedeemed.toFixed(2)}</span>
        </div>
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
            <div style={{ ...styles.heroStatValue, color: '#E85D75' }}>{d.noShows}</div>
            <div style={styles.heroStatLabel}>No-show</div>
          </div>
          <div style={styles.heroStat}>
            <div style={styles.heroStatValue}>£{d.avgTicket.toFixed(0)}</div>
            <div style={styles.heroStatLabel}>Avg ticket</div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={styles.tabs}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              ...styles.tab,
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
              <div style={styles.statIcon}>🎯</div>
              <div style={styles.statValue}>{d.utilisation}%</div>
              <div style={styles.statLabel}>Utilisation</div>
              <div style={styles.utilBar}>
                <div style={{ ...styles.utilFill, width: `${d.utilisation}%` }} />
              </div>
            </div>
            <div style={styles.statCard}>
              <div style={styles.statIcon}>👤</div>
              <div style={styles.statValue}>{d.newClients}</div>
              <div style={styles.statLabel}>New clients</div>
            </div>
            <div style={styles.statCard}>
              <div style={styles.statIcon}>🛍️</div>
              <div style={styles.statValue}>£{d.retailRevenue.toFixed(0)}</div>
              <div style={styles.statLabel}>Retail ({d.productsRetailed} items)</div>
            </div>
            <div style={styles.statCard}>
              <div style={styles.statIcon}>💝</div>
              <div style={styles.statValue}>£{d.tipsReceived.toFixed(2)}</div>
              <div style={styles.statLabel}>Tips</div>
            </div>
            <div style={styles.statCard}>
              <div style={styles.statIcon}>📤</div>
              <div style={styles.statValue}>£{d.expenses.toFixed(2)}</div>
              <div style={styles.statLabel}>Expenses</div>
            </div>
            <div style={styles.statCard}>
              <div style={styles.statIcon}>💰</div>
              <div style={styles.statValue}>£{(d.totalRevenue - d.expenses + d.tipsReceived).toFixed(2)}</div>
              <div style={styles.statLabel}>Net take-home</div>
            </div>
          </div>

          {/* AI insight */}
          <div style={styles.insightCard}>
            <div style={{ fontSize: 16 }}>🧠</div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>florrie.ai's take</div>
              <div style={{ fontSize: 13, color: '#6B6560', lineHeight: 1.5 }}>
                Solid day — 82% utilisation is above your weekly average (74%). Danielle's second no-show
                this month means the deposit auto-triggered. Consider offering Sophie D. a loyalty perk —
                she's been 4 times in 6 weeks. Tomorrow's 2pm slot opened from Chloe's cancellation —
                3 waitlist clients match that window.
              </div>
            </div>
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
                    <div style={styles.timelineAmount}>£{appt.amount}</div>
                    <div style={styles.timelineMethod}>{appt.method === 'card' ? '💳' : '💵'} {appt.method}</div>
                  </>
                )}
                {appt.status === 'no-show' && <span style={styles.badgeNoShow}>No-show</span>}
                {appt.status === 'cancelled' && <span style={styles.badgeCancelled}>Cancelled</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Cash Up tab — optional, not required to close the day */}
      {activeTab === 'cashup' && (
        <div style={styles.section}>
          <div style={styles.optionalBanner}>
            <span style={{ fontSize: 14 }}>💡</span>
            <span style={{ fontSize: 12, color: '#6B6560', lineHeight: 1.4 }}>
              This is optional. Card payments and bookings are tracked automatically —
              use this only if you want to reconcile cash at the end of the day.
            </span>
          </div>

          <div style={styles.cashupCard}>
            <div style={styles.cashupRow}>
              <span style={{ fontSize: 14, color: '#6B6560' }}>Expected cash (from bookings)</span>
              <span style={{ fontSize: 16, fontWeight: 600 }}>£{d.cashTaken.toFixed(2)}</span>
            </div>
            <div style={styles.cashupDivider} />
            <div style={{ marginBottom: 16 }}>
              <label style={styles.inputLabel}>Cash counted (optional)</label>
              <div style={styles.cashInput}>
                <span style={{ color: 'var(--text-muted, #AAA5A0)', fontSize: 18 }}>£</span>
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
              <div style={{
                ...styles.diffBadge,
                background: parseFloat(cashDiff) === 0 ? '#E8F5E9' : '#FFF3E0',
                color: parseFloat(cashDiff) === 0 ? '#2E7D32' : '#E65100',
              }}>
                {parseFloat(cashDiff) === 0
                  ? '✅ Exact match'
                  : `${parseFloat(cashDiff) > 0 ? '⬆️ Over' : '⬇️ Under'} by £${Math.abs(parseFloat(cashDiff)).toFixed(2)}`
                }
              </div>
            )}
            <div style={styles.cashupDivider} />
            <div style={styles.cashupRow}>
              <span style={{ fontSize: 14, color: '#6B6560' }}>Card payments (auto)</span>
              <span style={{ fontSize: 14, fontWeight: 500 }}>£{d.cardTaken.toFixed(2)}</span>
            </div>
            <div style={styles.cashupRow}>
              <span style={{ fontSize: 14, color: '#6B6560' }}>Vouchers redeemed</span>
              <span style={{ fontSize: 14, fontWeight: 500 }}>£{d.voucherRedeemed.toFixed(2)}</span>
            </div>
            <div style={styles.cashupRow}>
              <span style={{ fontSize: 14, color: '#6B6560' }}>Tips collected</span>
              <span style={{ fontSize: 14, fontWeight: 500 }}>£{d.tipsReceived.toFixed(2)}</span>
            </div>
          </div>

          {cashCounted && (
            <button
              onClick={() => setIsReconciled(true)}
              style={{
                ...styles.reconBtn,
                background: isReconciled ? '#2E7D32' : 'var(--accent, #C76B8A)'
              }}
            >
              {isReconciled ? '✓ Reconciled' : 'Mark as Reconciled'}
            </button>
          )}
        </div>
      )}

      {/* Notes tab */}
      {activeTab === 'notes' && (
        <div style={styles.section}>
          <div style={styles.notesHeader}>Auto-generated notes</div>
          {notes.map((note, i) => (
            <div key={i} style={styles.noteCard}>
              <span style={{ fontSize: 14 }}>📌</span>
              <span style={{ fontSize: 13, color: '#4A4540', lineHeight: 1.5 }}>{note}</span>
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

      {/* Close day button — no longer gated on cash reconciliation */}
      {!dayClosed && (
        <div style={styles.closeDayWrap}>
          <button
            onClick={saveEndOfDay}
            style={styles.closeDayBtn}
          >
            🔒 Close Day
          </button>
          {!isReconciled && (
            <div style={styles.closeDayHint}>Cash up is optional — close whenever you're ready</div>
          )}
        </div>
      )}
    </div>
  );
}

const styles = {
  page: { padding: '16px 16px 100px', fontFamily: '"DM Sans", -apple-system, sans-serif', maxWidth: 480, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text-primary, #2D2A26)', margin: 0 },
  dateChip: { fontSize: 12, color: '#6B6560', background: '#F0ECE8', padding: '4px 10px', borderRadius: 12 },

  closedBanner: { display: 'flex', alignItems: 'center', gap: 12, background: '#E8F5E9', borderRadius: 12, padding: '12px 16px', marginBottom: 16 },

  heroCard: { background: 'linear-gradient(135deg, #C76B8A 0%, #A85575 100%)', borderRadius: 16, padding: 20, marginBottom: 16, color: 'var(--bg-card, #fff)' },
  heroLabel: { fontSize: 12, opacity: 0.8, marginBottom: 4 },
  heroAmount: { fontSize: 32, fontWeight: 700, marginBottom: 8 },
  heroBreakdown: { display: 'flex', gap: 16, fontSize: 13, opacity: 0.9, marginBottom: 16 },
  heroStats: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, borderTop: '1px solid rgba(255,255,255,0.2)', paddingTop: 12 },
  heroStat: { textAlign: 'center' },
  heroStatValue: { fontSize: 18, fontWeight: 700 },
  heroStatLabel: { fontSize: 10, opacity: 0.7 },

  tabs: { display: 'flex', gap: 4, marginBottom: 16, background: '#F0ECE8', borderRadius: 12, padding: 4 },
  tab: { flex: 1, padding: '8px 0', fontSize: 13, fontWeight: 500, border: 'none', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit', background: 'none', color: '#6B6560' },
  tabActive: { background: 'var(--bg-card, #fff)', color: 'var(--text-primary, #2D2A26)', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' },

  section: { marginBottom: 24 },

  statsGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 16 },
  statCard: { background: 'var(--bg-card, #fff)', borderRadius: 12, padding: 14, border: '1px solid #F0ECE8' },
  statIcon: { fontSize: 16, marginBottom: 6 },
  statValue: { fontSize: 20, fontWeight: 700, color: 'var(--text-primary, #2D2A26)' },
  statLabel: { fontSize: 11, color: 'var(--text-muted, #AAA5A0)', marginTop: 2 },
  utilBar: { height: 4, background: '#F0ECE8', borderRadius: 2, marginTop: 8 },
  utilFill: { height: '100%', background: 'var(--accent, #C76B8A)', borderRadius: 2, transition: 'width 0.3s' },

  insightCard: { display: 'flex', gap: 12, background: '#FFF8F0', border: '1px solid #FFE8CC', borderRadius: 12, padding: 14 },

  timelineRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid #F0ECE8' },
  timelineTime: { fontSize: 13, fontWeight: 600, color: 'var(--text-muted, #AAA5A0)', width: 42, flexShrink: 0 },
  timelineDot: (status) => ({ width: 8, height: 8, borderRadius: 4, flexShrink: 0, background: status === 'completed' ? '#4CAF50' : status === 'no-show' ? '#E85D75' : '#FFB74D' }),
  timelineClient: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #2D2A26)' },
  timelineTreatment: { fontSize: 12, color: 'var(--text-muted, #AAA5A0)' },
  timelineAmount: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #2D2A26)' },
  timelineMethod: { fontSize: 11, color: 'var(--text-muted, #AAA5A0)' },
  badgeNoShow: { fontSize: 11, color: '#E85D75', background: '#FDEDF0', padding: '3px 8px', borderRadius: 8, fontWeight: 600 },
  badgeCancelled: { fontSize: 11, color: '#F57C00', background: '#FFF3E0', padding: '3px 8px', borderRadius: 8, fontWeight: 600 },

  optionalBanner: { display: 'flex', gap: 8, alignItems: 'flex-start', background: '#FFF8F0', border: '1px solid #FFE8CC', borderRadius: 10, padding: '10px 12px', marginBottom: 12 },
  cashupCard: { background: 'var(--bg-card, #fff)', borderRadius: 14, padding: 16, border: '1px solid #F0ECE8', marginBottom: 16 },
  cashupRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0' },
  cashupDivider: { height: 1, background: '#F0ECE8', margin: '8px 0' },
  inputLabel: { fontSize: 12, fontWeight: 600, color: '#6B6560', display: 'block', marginBottom: 6 },
  cashInput: { display: 'flex', alignItems: 'center', gap: 6, background: 'var(--bg, var(--bg, #FAF8F5))', border: '1.5px solid #E8E4E0', borderRadius: 10, padding: '10px 12px' },
  input: { border: 'none', background: 'none', fontSize: 18, fontWeight: 600, outline: 'none', width: '100%', fontFamily: 'inherit', color: 'var(--text-primary, #2D2A26)' },
  diffBadge: { padding: '10px 14px', borderRadius: 10, fontSize: 14, fontWeight: 600, textAlign: 'center', marginBottom: 12 },
  reconBtn: { width: '100%', padding: '14px 0', borderRadius: 12, border: 'none', color: 'var(--bg-card, #fff)', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  notesHeader: { fontSize: 13, fontWeight: 600, color: 'var(--text-muted, #AAA5A0)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 },
  noteCard: { display: 'flex', gap: 8, background: 'var(--bg-card, #fff)', borderRadius: 10, padding: 12, border: '1px solid #F0ECE8', marginBottom: 8 },
  textarea: { width: '100%', padding: 12, borderRadius: 10, border: '1.5px solid #E8E4E0', fontSize: 14, fontFamily: 'inherit', resize: 'vertical', outline: 'none', background: 'var(--bg, var(--bg, #FAF8F5))', color: 'var(--text-primary, #2D2A26)', boxSizing: 'border-box' },

  closeDayWrap: { textAlign: 'center', marginTop: 8, paddingBottom: 20 },
  closeDayBtn: { width: '100%', padding: '16px 0', borderRadius: 14, border: 'none', background: 'var(--text-primary, #2D2A26)', color: 'var(--bg-card, #fff)', fontSize: 16, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  closeDayHint: { fontSize: 12, color: 'var(--text-muted, #AAA5A0)', marginTop: 8 },
};
