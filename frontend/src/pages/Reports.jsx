/**
 * Reports — exportable business summaries.
 *
 * Tabs:
 *   Revenue   — weekly/monthly breakdown, totals, CSV export
 *   Clients   — client list with spend/visits, CSV export
 *   Appointments — appointment log, CSV export
 *   Treatments — treatment popularity, revenue per treatment
 *
 * Dev-mode only — all data is mock. Supabase wiring comes later.
 */
import { useState, useMemo } from 'react';
import { isDevMode, DEV_TREATMENTS, DEV_CLIENTS } from '../lib/supabase.js';
import { useTheme } from '../lib/theme.jsx';

// ── Mock data ──────────────────────────────────────────────

const today = new Date();
const fmt = d => d.toISOString().split('T')[0];

function dateOffset(days) {
  const d = new Date(today);
  d.setDate(d.getDate() + days);
  return d;
}

// 60 days of mock appointments
const DEV_APPOINTMENTS = [];
const clientNames = ['Shauna', 'Daisy S', 'Jasmin', 'Sophie', 'Grace', 'Beth', 'Amy', 'Chloe', 'Megan', 'Laura'];
for (let i = 0; i < 60; i++) {
  const daysAgo = Math.floor(Math.random() * 90);
  const t = DEV_TREATMENTS[Math.floor(Math.random() * DEV_TREATMENTS.length)];
  const client = clientNames[Math.floor(Math.random() * clientNames.length)];
  DEV_APPOINTMENTS.push({
    id: `dev-apt-${i}`,
    date: fmt(dateOffset(-daysAgo)),
    client_name: client,
    treatment: t.name,
    duration: t.duration_minutes,
    revenue_cents: t.price_cents,
    status: Math.random() > 0.08 ? 'completed' : 'cancelled',
  });
}
DEV_APPOINTMENTS.sort((a, b) => b.date.localeCompare(a.date));

// Weekly revenue buckets
function buildWeeklyRevenue(appointments) {
  const weeks = {};
  appointments.filter(a => a.status === 'completed').forEach(a => {
    const d = new Date(a.date);
    const weekStart = new Date(d);
    weekStart.setDate(d.getDate() - d.getDay() + 1); // Monday
    const key = fmt(weekStart);
    if (!weeks[key]) weeks[key] = { week: key, revenue: 0, count: 0 };
    weeks[key].revenue += a.revenue_cents;
    weeks[key].count += 1;
  });
  return Object.values(weeks).sort((a, b) => b.week.localeCompare(a.week));
}

// Treatment popularity
function buildTreatmentStats(appointments) {
  const stats = {};
  appointments.filter(a => a.status === 'completed').forEach(a => {
    if (!stats[a.treatment]) stats[a.treatment] = { name: a.treatment, count: 0, revenue: 0 };
    stats[a.treatment].count += 1;
    stats[a.treatment].revenue += a.revenue_cents;
  });
  return Object.values(stats).sort((a, b) => b.count - a.count);
}

// ── CSV export ─────────────────────────────────────────────

function downloadCSV(filename, headers, rows) {
  const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [headers.join(',')];
  rows.forEach(r => lines.push(r.map(escape).join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Helpers ────────────────────────────────────────────────

const pence = v => `£${(v / 100).toFixed(2)}`;
const pounds = v => `£${Math.round(v / 100).toLocaleString()}`;

function formatWeek(dateStr) {
  const d = new Date(dateStr);
  const end = new Date(d);
  end.setDate(d.getDate() + 6);
  const mo = s => new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return `${mo(dateStr)} – ${mo(end.toISOString())}`;
}

// ── Component ──────────────────────────────────────────────

export default function Reports({ token }) {
  const { dark } = useTheme();
  const [tab, setTab] = useState('revenue');
  const [period, setPeriod] = useState('all'); // all | 30 | 7

  const filtered = useMemo(() => {
    if (period === 'all') return DEV_APPOINTMENTS;
    const cutoff = fmt(dateOffset(-Number(period)));
    return DEV_APPOINTMENTS.filter(a => a.date >= cutoff);
  }, [period]);

  const weeklyRevenue = useMemo(() => buildWeeklyRevenue(filtered), [filtered]);
  const treatmentStats = useMemo(() => buildTreatmentStats(filtered), [filtered]);
  const completed = filtered.filter(a => a.status === 'completed');
  const totalRevenue = completed.reduce((s, a) => s + a.revenue_cents, 0);
  const totalAppointments = completed.length;
  const avgPerAppointment = totalAppointments ? Math.round(totalRevenue / totalAppointments) : 0;

  // Client stats from mock data enriched with appointment data
  const clientStats = useMemo(() => {
    const map = {};
    completed.forEach(a => {
      if (!map[a.client_name]) map[a.client_name] = { name: a.client_name, visits: 0, spend: 0, lastVisit: '' };
      map[a.client_name].visits += 1;
      map[a.client_name].spend += a.revenue_cents;
      if (a.date > map[a.client_name].lastVisit) map[a.client_name].lastVisit = a.date;
    });
    return Object.values(map).sort((a, b) => b.spend - a.spend);
  }, [completed]);

  const tabs = [
    { key: 'revenue', label: 'Revenue' },
    { key: 'clients', label: 'Clients' },
    { key: 'appointments', label: 'Bookings' },
    { key: 'treatments', label: 'Treatments' },
  ];

  const periods = [
    { key: '7', label: '7 days' },
    { key: '30', label: '30 days' },
    { key: 'all', label: 'All time' },
  ];

  // Export handlers
  const exportRevenue = () => {
    downloadCSV('florrie-revenue.csv', ['Week', 'Revenue', 'Appointments'],
      weeklyRevenue.map(w => [formatWeek(w.week), pence(w.revenue), w.count]));
  };
  const exportClients = () => {
    downloadCSV('florrie-clients.csv', ['Client', 'Visits', 'Total Spend', 'Last Visit'],
      clientStats.map(c => [c.name, c.visits, pence(c.spend), c.lastVisit]));
  };
  const exportAppointments = () => {
    downloadCSV('florrie-appointments.csv', ['Date', 'Client', 'Treatment', 'Duration (min)', 'Revenue', 'Status'],
      filtered.map(a => [a.date, a.client_name, a.treatment, a.duration, pence(a.revenue_cents), a.status]));
  };
  const exportTreatments = () => {
    downloadCSV('florrie-treatments.csv', ['Treatment', 'Bookings', 'Total Revenue', 'Avg Revenue'],
      treatmentStats.map(t => [t.name, t.count, pence(t.revenue), pence(Math.round(t.revenue / t.count))]));
  };

  return (
    <div style={s.page}>
      <div style={s.header}>
        <h1 style={s.title}>Reports</h1>
        <p style={s.sub}>Exportable business summaries</p>
      </div>

      {/* Summary row */}
      <div style={s.summaryRow}>
        <div style={s.summaryCard}>
          <span style={s.summaryValue}>{pounds(totalRevenue)}</span>
          <span style={s.summaryLabel}>Revenue</span>
        </div>
        <div style={s.summaryCard}>
          <span style={s.summaryValue}>{totalAppointments}</span>
          <span style={s.summaryLabel}>Appointments</span>
        </div>
        <div style={s.summaryCard}>
          <span style={s.summaryValue}>{pounds(avgPerAppointment)}</span>
          <span style={s.summaryLabel}>Avg/booking</span>
        </div>
      </div>

      {/* Period filter */}
      <div style={s.filterRow}>
        {periods.map(p => (
          <button
            key={p.key}
            onClick={() => setPeriod(p.key)}
            style={{
              ...s.filterChip,
              background: period === p.key ? 'var(--accent, #C76B8A)' : 'var(--card-bg, #fff)',
              color: period === p.key ? '#fff' : 'var(--text, #2D2A26)',
              border: period === p.key ? '1px solid var(--accent, #C76B8A)' : '1px solid var(--border, #E8E4E0)',
            }}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Tab bar */}
      <div style={s.tabBar}>
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              ...s.tab,
              color: tab === t.key ? 'var(--accent, #C76B8A)' : 'var(--text-muted, #AAA5A0)',
              borderBottom: tab === t.key ? '2px solid var(--accent, #C76B8A)' : '2px solid transparent',
              fontWeight: tab === t.key ? 600 : 400,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={s.content}>
        {tab === 'revenue' && (
          <>
            <button onClick={exportRevenue} style={s.exportBtn}>Export CSV</button>
            {weeklyRevenue.length === 0 && <p style={s.empty}>No revenue data for this period.</p>}
            {weeklyRevenue.map(w => (
              <div key={w.week} style={s.row}>
                <div style={s.rowLeft}>
                  <span style={s.rowTitle}>{formatWeek(w.week)}</span>
                  <span style={s.rowMeta}>{w.count} appointment{w.count !== 1 ? 's' : ''}</span>
                </div>
                <span style={s.rowAmount}>{pounds(w.revenue)}</span>
              </div>
            ))}
            {/* Revenue bar chart */}
            {weeklyRevenue.length > 1 && (
              <div style={s.chartSection}>
                <span style={s.chartLabel}>Weekly trend</span>
                <div style={s.barChart}>
                  {weeklyRevenue.slice(0, 12).reverse().map(w => {
                    const max = Math.max(...weeklyRevenue.slice(0, 12).map(x => x.revenue));
                    const pct = max ? (w.revenue / max) * 100 : 0;
                    return (
                      <div key={w.week} style={s.barCol}>
                        <div style={{ ...s.bar, height: `${Math.max(pct, 4)}%` }} title={pounds(w.revenue)} />
                        <span style={s.barLabel}>{new Date(w.week).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}

        {tab === 'clients' && (
          <>
            <button onClick={exportClients} style={s.exportBtn}>Export CSV</button>
            {clientStats.length === 0 && <p style={s.empty}>No client data for this period.</p>}
            {clientStats.map(c => (
              <div key={c.name} style={s.row}>
                <div style={s.rowLeft}>
                  <div style={s.avatar}>{c.name.charAt(0)}</div>
                  <div>
                    <span style={s.rowTitle}>{c.name}</span>
                    <span style={s.rowMeta}>{c.visits} visit{c.visits !== 1 ? 's' : ''} · Last: {new Date(c.lastVisit).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
                  </div>
                </div>
                <span style={s.rowAmount}>{pounds(c.spend)}</span>
              </div>
            ))}
          </>
        )}

        {tab === 'appointments' && (
          <>
            <button onClick={exportAppointments} style={s.exportBtn}>Export CSV</button>
            {filtered.length === 0 && <p style={s.empty}>No appointments for this period.</p>}
            {filtered.slice(0, 50).map(a => (
              <div key={a.id} style={s.row}>
                <div style={s.rowLeft}>
                  <div>
                    <span style={s.rowTitle}>{a.client_name}</span>
                    <span style={s.rowMeta}>{a.treatment} · {a.duration}min</span>
                    <span style={s.rowMeta}>{new Date(a.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</span>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span style={s.rowAmount}>{pence(a.revenue_cents)}</span>
                  <span style={{
                    ...s.statusBadge,
                    background: a.status === 'completed' ? 'var(--success-bg, #EDF7F0)' : 'var(--danger-bg, #FDF0EF)',
                    color: a.status === 'completed' ? 'var(--success, #5BA97B)' : 'var(--danger, #D4605C)',
                  }}>{a.status}</span>
                </div>
              </div>
            ))}
            {filtered.length > 50 && <p style={s.moreNote}>Showing 50 of {filtered.length} — export CSV for full list</p>}
          </>
        )}

        {tab === 'treatments' && (
          <>
            <button onClick={exportTreatments} style={s.exportBtn}>Export CSV</button>
            {treatmentStats.length === 0 && <p style={s.empty}>No treatment data for this period.</p>}
            {treatmentStats.map((t, i) => {
              const max = treatmentStats[0]?.count || 1;
              const pct = (t.count / max) * 100;
              return (
                <div key={t.name} style={s.treatmentRow}>
                  <div style={s.treatmentInfo}>
                    <span style={s.treatmentRank}>#{i + 1}</span>
                    <div>
                      <span style={s.rowTitle}>{t.name}</span>
                      <span style={s.rowMeta}>{t.count} booking{t.count !== 1 ? 's' : ''} · Avg {pence(Math.round(t.revenue / t.count))}</span>
                    </div>
                  </div>
                  <div style={s.treatmentBar}>
                    <div style={{ ...s.treatmentFill, width: `${pct}%` }} />
                  </div>
                  <span style={{ ...s.rowAmount, minWidth: 60, textAlign: 'right' }}>{pounds(t.revenue)}</span>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────

const s = {
  page: {
    padding: '16px 16px 32px',
    maxWidth: 480,
    margin: '0 auto',
    fontFamily: '"DM Sans", -apple-system, sans-serif',
  },
  header: { marginBottom: 16 },
  title: {
    fontSize: 24,
    fontWeight: 700,
    color: 'var(--text, #2D2A26)',
    margin: 0,
  },
  sub: {
    fontSize: 13,
    color: 'var(--text-muted, #AAA5A0)',
    margin: '4px 0 0',
  },
  summaryRow: {
    display: 'flex',
    gap: 10,
    marginBottom: 16,
  },
  summaryCard: {
    flex: 1,
    background: 'var(--card-bg, #fff)',
    borderRadius: 12,
    padding: '14px 10px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 2,
    border: '1px solid var(--border, #F0ECE8)',
  },
  summaryValue: {
    fontSize: 20,
    fontWeight: 700,
    color: 'var(--text, #2D2A26)',
  },
  summaryLabel: {
    fontSize: 11,
    color: 'var(--text-muted, #AAA5A0)',
    textTransform: 'uppercase',
    letterSpacing: '0.03em',
  },
  filterRow: {
    display: 'flex',
    gap: 8,
    marginBottom: 12,
  },
  filterChip: {
    padding: '6px 14px',
    borderRadius: 20,
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  tabBar: {
    display: 'flex',
    gap: 0,
    borderBottom: '1px solid var(--border, #F0ECE8)',
    marginBottom: 16,
  },
  tab: {
    flex: 1,
    padding: '10px 0',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: 13,
    fontFamily: 'inherit',
    textAlign: 'center',
  },
  content: {},
  exportBtn: {
    display: 'block',
    width: '100%',
    padding: '10px 0',
    marginBottom: 16,
    background: 'var(--card-bg, #fff)',
    border: '1px solid var(--border, #E8E4E0)',
    borderRadius: 10,
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--accent, #C76B8A)',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 0',
    borderBottom: '1px solid var(--border, #F0ECE8)',
  },
  rowLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  rowTitle: {
    display: 'block',
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text, #2D2A26)',
  },
  rowMeta: {
    display: 'block',
    fontSize: 12,
    color: 'var(--text-muted, #AAA5A0)',
  },
  rowAmount: {
    fontSize: 15,
    fontWeight: 700,
    color: 'var(--text, #2D2A26)',
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    background: 'linear-gradient(135deg, var(--accent, #C76B8A)22, var(--accent, #C76B8A)44)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 14,
    fontWeight: 700,
    color: 'var(--accent, #C76B8A)',
  },
  statusBadge: {
    display: 'inline-block',
    fontSize: 10,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 8,
    marginTop: 4,
    textTransform: 'capitalize',
  },
  empty: {
    textAlign: 'center',
    color: 'var(--text-muted, #AAA5A0)',
    fontSize: 13,
    padding: '32px 0',
  },
  moreNote: {
    textAlign: 'center',
    color: 'var(--text-muted, #AAA5A0)',
    fontSize: 12,
    padding: '12px 0',
  },
  // Bar chart
  chartSection: { marginTop: 20 },
  chartLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-muted, #AAA5A0)',
    display: 'block',
    marginBottom: 8,
  },
  barChart: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: 6,
    height: 120,
    padding: '0 4px',
  },
  barCol: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
    height: '100%',
    justifyContent: 'flex-end',
  },
  bar: {
    width: '100%',
    borderRadius: '4px 4px 0 0',
    background: 'linear-gradient(180deg, var(--accent, #C76B8A), var(--accent, #C76B8A)88)',
    minHeight: 4,
    transition: 'height 0.3s ease',
  },
  barLabel: {
    fontSize: 9,
    color: 'var(--text-muted, #AAA5A0)',
    whiteSpace: 'nowrap',
  },
  // Treatment tab
  treatmentRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 0',
    borderBottom: '1px solid var(--border, #F0ECE8)',
  },
  treatmentInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flex: 1,
    minWidth: 0,
  },
  treatmentRank: {
    fontSize: 12,
    fontWeight: 700,
    color: 'var(--accent, #C76B8A)',
    minWidth: 24,
  },
  treatmentBar: {
    width: 60,
    height: 6,
    borderRadius: 3,
    background: 'var(--border, #F0ECE8)',
    overflow: 'hidden',
    flexShrink: 0,
  },
  treatmentFill: {
    height: '100%',
    borderRadius: 3,
    background: 'var(--accent, #C76B8A)',
    transition: 'width 0.3s ease',
  },
};
