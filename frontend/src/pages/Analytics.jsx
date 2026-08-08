import { useState, useEffect, useMemo } from 'react';
import { useBeautician, fetchRows } from '../lib/supabase.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';
import Icon, { iconName } from '../components/ui/Icon';
import Money from '../components/ui/Money';
/**
 * Analytics - unified historical analytics hub.
 *
 * Tabs:
 *   Overview     - revenue, top clients, booking patterns, AI insights
 *   Treatments   - per-treatment performance ranking
 *   Export       - CSV downloads for Revenue, Clients, Appointments
 */

const PERIOD_OPTIONS = [
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: '3months', label: 'Last 3 months' },
];

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'treatments', label: 'Treatments' },
  { key: 'export', label: 'Export' },
];

const SORT_OPTIONS = [
  { key: 'revenue', label: 'Revenue' },
  { key: 'bookings', label: 'Bookings' },
  { key: 'hourlyRate', label: '£/Hour' },
  { key: 'returnRate', label: 'Return Rate' },
];

const TREND_ICONS = { up: '📈', down: '📉', stable: '➡️' };
const TREND_COLORS = { up: 'var(--success, #386F52)', down: 'var(--danger, #9E2B32)', stable: 'var(--text-muted, #6B5D54)' };

export default function Analytics() {
  const { beautician } = useBeautician();
  const [tab, setTab] = useState('overview');
  const [period, setPeriod] = useState('month');

  const [stats, setStats] = useState(null);
  const [overviewLoading, setOverviewLoading] = useState(true);

  const [treatmentStats, setTreatmentStats] = useState([]);
  const [treatmentLoading, setTreatmentLoading] = useState(true);
  const [sortBy, setSortBy] = useState('revenue');
  const [catFilter, setCatFilter] = useState('all');

  const [allAppointments, setAllAppointments] = useState([]);
  const [allClients, setAllClients] = useState([]);
  const [exportLoading, setExportLoading] = useState(false);

  // Load overview data whenever beautician or period changes
  useEffect(() => {
    loadOverview();
  }, [beautician, period]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load treatment data when tab switches to treatments
  useEffect(() => {
    if (tab === 'treatments' || tab === 'export') loadTreatmentAndExportData();
  }, [tab, beautician]); // eslint-disable-line react-hooks/exhaustive-deps

  // Overview data loading
  async function loadOverview() {
    if (!beautician) return;
    setOverviewLoading(true);

    const now = new Date();
    let startDate = new Date(now);
    if (period === 'week') startDate.setDate(now.getDate() - 7);
    else if (period === 'month') startDate.setMonth(now.getMonth() - 1);
    else startDate.setMonth(now.getMonth() - 3);

    try {
      const [appointments, clients, expenses] = await Promise.all([
        fetchRows('appointments', beautician.id, { order: 'starts_at', ascending: false }),
        fetchRows('clients', beautician.id),
        fetchRows('expenses', beautician.id, { order: 'date', ascending: false }),
      ]);

      const inRange = appointments.filter(a => new Date(a.starts_at) >= startDate);
      const completed = inRange.filter(a => a.status === 'completed');
      const noShows = inRange.filter(a => a.status === 'no_show');
      const totalRevenue = completed.reduce((s, a) => s + (a.price_cents || 0), 0);
      const totalExpenses = expenses
        .filter(e => new Date(e.date) >= startDate)
        .reduce((s, e) => s + (e.amount_cents || 0), 0);

      const clientSpend = {};
      completed.forEach(a => {
        const cid = a.client_id;
        if (!clientSpend[cid]) clientSpend[cid] = { id: cid, spend: 0, visits: 0 };
        clientSpend[cid].spend += a.price_cents || 0;
        clientSpend[cid].visits += 1;
      });
      const topClients = Object.values(clientSpend)
        .sort((a, b) => b.spend - a.spend)
        .slice(0, 5)
        .map(tc => {
          const c = clients.find(c => c.id === tc.id);
          return { ...tc, name: c ? `${c.first_name} ${c.last_name || ''}`.trim() : 'Unknown' };
        });

      const dayCount = { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0, sun: 0 };
      inRange.forEach(a => {
        const d = new Date(a.starts_at).getDay();
        const key = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][d];
        dayCount[key]++;
      });
      const busiestDay = Object.entries(dayCount).sort((a, b) => b[1] - a[1])[0];

      // Real utilisation: booked minutes vs available working minutes across the period.
      // Available minutes come from the beautician's working_hours; booked minutes come
      // from completed appointments. Returns null when working_hours is missing.
      const utilizationRate = computeUtilisation(beautician?.working_hours, completed, startDate, now);

      setStats({
        totalAppointments: inRange.length,
        completedCount: completed.length,
        noShowCount: noShows.length,
        noShowRate: inRange.length > 0 ? Math.round((noShows.length / inRange.length) * 100) : 0,
        totalRevenue,
        totalExpenses,
        profit: totalRevenue - totalExpenses,
        avgPerAppointment: completed.length > 0 ? Math.round(totalRevenue / completed.length) : 0,
        topClients,
        busiestDay: busiestDay ? { day: busiestDay[0], count: busiestDay[1] } : null,
        newClients: clients.filter(c => new Date(c.created_at) >= startDate).length,
        totalClients: clients.length,
        utilizationRate,
        dayBreakdown: dayCount,
      });
    } catch (err) {
      logger.error({ err }, 'Analytics overview load error');
    }
    setOverviewLoading(false);
  }

  // Treatment stats + export data loading
  async function loadTreatmentAndExportData() {
    if (!beautician) return;
    setTreatmentLoading(true);
    setExportLoading(true);

    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 90);

      const [appointments, treatments, clients] = await Promise.all([
        fetchRows('appointments', beautician.id, { order: 'starts_at', ascending: false }),
        fetchRows('treatments', beautician.id),
        fetchRows('clients', beautician.id),
      ]);

      setAllAppointments(appointments);
      setAllClients(clients);

      const recentAppts = appointments.filter(a => new Date(a.starts_at) >= cutoff && a.status === 'completed');

      const tMap = {};
      treatments.forEach(t => {
        tMap[t.id] = {
          id: t.id,
          name: t.name,
          category: t.category || 'other',
          price: t.price_cents || 0,
          duration: t.duration_minutes || 60,
          bookings: 0,
          revenue: 0,
          clientsSeen: new Set(),
          clientVisitCounts: {},
        };
      });

      recentAppts.forEach(a => {
        const t = tMap[a.treatment_id];
        if (!t) return;
        t.bookings++;
        t.revenue += a.price_cents || 0;
        if (a.client_id) {
          t.clientsSeen.add(a.client_id);
          t.clientVisitCounts[a.client_id] = (t.clientVisitCounts[a.client_id] || 0) + 1;
        }
      });

      const stats = Object.values(tMap)
        .filter(t => t.bookings > 0)
        .map(t => ({
          id: t.id,
          name: t.name,
          category: t.category,
          price: t.price,
          bookings: t.bookings,
          revenue: t.revenue,
          avgDuration: t.duration,
          hourlyRate: t.duration > 0 ? Math.round((t.price / (t.duration / 60))) : 0,
          returnRate: t.clientsSeen.size > 0
            ? Math.round((Object.values(t.clientVisitCounts).filter(n => n >= 2).length / t.clientsSeen.size) * 100)
            : 0,
          trend: t.bookings > 5 ? 'up' : t.bookings > 2 ? 'stable' : 'down',
          rating: null,
        }));

      setTreatmentStats(stats);
    } catch (err) {
      logger.error({ err }, 'Treatment stats load error');
    }
    setTreatmentLoading(false);
    setExportLoading(false);
  }

  // Treatment sorting/filtering (memoised)
  const filteredTreatments = useMemo(() => {
    let list = catFilter === 'all' ? treatmentStats : treatmentStats.filter(t => t.category === catFilter);
    return [...list].sort((a, b) => {
      if (sortBy === 'revenue') return b.revenue - a.revenue;
      if (sortBy === 'bookings') return b.bookings - a.bookings;
      if (sortBy === 'hourlyRate') return b.hourlyRate - a.hourlyRate;
      if (sortBy === 'returnRate') return b.returnRate - a.returnRate;
      return 0;
    });
  }, [treatmentStats, sortBy, catFilter]);

  const categories = useMemo(() => {
    const cats = [...new Set(treatmentStats.map(t => t.category).filter(Boolean))];
    return ['all', ...cats];
  }, [treatmentStats]);

  const DAY_LABELS = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

  // CSV export helpers
  function downloadCSV(filename, headers, rows) {
    const csv = [headers.join(','), ...rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportAppointments() {
    downloadCSV('florrie-appointments.csv',
      ['Date', 'Client', 'Treatment', 'Status', 'Revenue (£)'],
      allAppointments.map(a => [
        a.starts_at ? new Date(a.starts_at).toLocaleDateString('en-GB') : '',
        a.client_name || '',
        a.treatment_name || '',
        a.status || '',
        ((a.price_cents || 0) / 100).toFixed(2),
      ])
    );
  }

  function exportClients() {
    downloadCSV('florrie-clients.csv',
      ['Name', 'Email', 'Phone', 'Joined'],
      allClients.map(c => [
        `${c.first_name || ''} ${c.last_name || ''}`.trim(),
        c.email || '',
        c.phone || '',
        c.created_at ? new Date(c.created_at).toLocaleDateString('en-GB') : '',
      ])
    );
  }

  function exportTreatments() {
    downloadCSV('florrie-treatments.csv',
      ['Treatment', 'Category', 'Bookings', 'Revenue (£)', 'Avg Duration (min)'],
      treatmentStats.map(t => [
        t.name,
        t.category || '',
        t.bookings,
        (t.revenue / 100).toFixed(2),
        t.avgDuration,
      ])
    );
  }

  // Render
  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.title}>Analytics</h1>
      </div>

      {/* Tab nav */}
      <div style={styles.tabNav}>
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{ ...styles.tabBtn,
              background: tab === t.key ? 'var(--accent, #92405e)' : 'var(--bg-subtle, #ede7e3)',
              color: tab === t.key ? '#fff' : 'var(--text-secondary, #574A42)',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Period picker - shown on Overview and Export tabs */}
      {(tab === 'overview') && (
        <div style={styles.periodNav}>
          {PERIOD_OPTIONS.map(p => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              style={{ ...styles.periodTab,
                background: period === p.key ? 'var(--text-secondary, #574A42)' : 'transparent',
                color: period === p.key ? '#fff' : 'var(--text-muted, #6B5D54)',
                border: period === p.key ? 'none' : '1.5px solid var(--border, #E8DDD4)',
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      {/* ── OVERVIEW TAB ─────────────────────────────── */}
      {tab === 'overview' && (
        overviewLoading ? (
          <div style={styles.skeletonGroup}>
            <SkeletonCard height={100} /><SkeletonCard height={80} /><SkeletonCard height={120} />
          </div>
        ) : stats ? (
          <>
            <div style={styles.heroCard}>
              <span style={styles.heroLabel}>Revenue</span>
              <span style={styles.heroAmount}><Money pence={stats.totalRevenue} /></span>
              <div style={styles.heroRow}>
                <div style={styles.heroStat}>
                  <span style={styles.heroStatValue}>{stats.completedCount}</span>
                  <span style={styles.heroStatLabel}>appointments</span>
                </div>
                <div style={styles.heroDivider} />
                <div style={styles.heroStat}>
                  <span style={styles.heroStatValue}><Money pence={stats.avgPerAppointment} round /></span>
                  <span style={styles.heroStatLabel}>avg per visit</span>
                </div>
                <div style={styles.heroDivider} />
                <div style={styles.heroStat}>
                  <span style={{ ...styles.heroStatValue, color: stats.profit >= 0 ? 'rgba(255,255,255,0.9)' : '#FFCDD2' }}>
                    <Money pence={stats.profit} round />
                  </span>
                  <span style={styles.heroStatLabel}>profit</span>
                </div>
              </div>
            </div>

            <div style={styles.statsGrid}>
              <StatCard label="No-show rate" value={`${stats.noShowRate}%`} sub={`${stats.noShowCount} no-shows`} color={stats.noShowRate > 10 ? 'var(--danger, #9E2B32)' : 'var(--success, #386F52)'} />
              <StatCard label="New clients" value={stats.newClients} sub={`of ${stats.totalClients} total`} color="var(--accent, #92405e)" />
              {stats.utilizationRate === null ? (
                <StatCard label="Utilisation" value="-" sub="set your hours to see this" color="var(--text-secondary, #574A42)" />
              ) : (
                <StatCard label="Utilisation" value={`${stats.utilizationRate}%`} sub="of available hours" color={stats.utilizationRate > 70 ? 'var(--success, #386F52)' : 'var(--warning, #79581C)'} />
              )}
              <StatCard label="Expenses" value={`£${(stats.totalExpenses / 100).toFixed(0)}`} sub="total spend" color="var(--text-secondary, #574A42)" />
            </div>

            {stats.busiestDay && stats.busiestDay.count > 0 && (
              <div style={styles.insightCard}>
                <span style={styles.insightIcon}><Icon name="chart" size={15} /></span>
                <div style={styles.insightContent}>
                  <span style={styles.insightTitle}>Busiest day</span>
                  <span style={styles.insightText}>
                    {DAY_LABELS[stats.busiestDay.day]} with {stats.busiestDay.count} appointment{stats.busiestDay.count !== 1 ? 's' : ''}
                  </span>
                </div>
              </div>
            )}

            {stats.topClients.length > 0 && (
              <div style={styles.card}>
                <h3 style={styles.cardTitle}>Top clients</h3>
                {stats.topClients.map((client, i) => (
                  <div key={client.id} style={styles.clientRow}>
                    <div style={styles.clientRank}>{i + 1}</div>
                    <div style={styles.clientInfo}>
                      <span style={styles.clientName}>{client.name}</span>
                      <span style={styles.clientVisits}>{client.visits} visit{client.visits !== 1 ? 's' : ''}</span>
                    </div>
                    <span style={styles.clientSpend}><Money pence={client.spend} round /></span>
                  </div>
                ))}
              </div>
            )}

            <div style={styles.card}>
              <h3 style={styles.cardTitle}>Bookings by day</h3>
              <DayBarChart data={stats.dayBreakdown || {}} />
            </div>

            <div style={styles.card}>
              <h3 style={styles.cardTitle}>AI insights</h3>
              <div style={styles.insightsList}>
                {getInsights(stats).map((insight, i) => (
                  <div key={i} style={styles.aiInsight}>
                    <span style={styles.aiInsightIcon}><Icon name={iconName(insight.icon)} inline /></span>
                    <span style={styles.aiInsightText}>{insight.text}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <EmptyState icon="chart" title="No data yet" desc="Analytics appear once you start booking appointments." />
        )
      )}

      {/* ── TREATMENTS TAB ───────────────────────────── */}
      {tab === 'treatments' && (
        treatmentLoading ? (
          <div style={styles.skeletonGroup}>
            <SkeletonCard height={80} /><SkeletonCard height={80} /><SkeletonCard height={80} />
          </div>
        ) : (
          <>
            {/* Sort options */}
            <div style={styles.filterRow}>
              {SORT_OPTIONS.map(s => (
                <button
                  key={s.key}
                  onClick={() => setSortBy(s.key)}
                  style={{ ...styles.filterChip,
                    background: sortBy === s.key ? 'var(--accent, #92405e)' : 'var(--bg-subtle, #ede7e3)',
                    color: sortBy === s.key ? '#fff' : 'var(--text-secondary, #574A42)',
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>

            {/* Category filter */}
            {categories.length > 2 && (
              <div style={{ ...styles.filterRow, marginTop: 0 }}>
                {categories.map(cat => (
                  <button
                    key={cat}
                    onClick={() => setCatFilter(cat)}
                    style={{ ...styles.filterChip,
                      background: catFilter === cat ? 'var(--text-secondary, #574A42)' : 'transparent',
                      color: catFilter === cat ? '#fff' : 'var(--text-muted, #6B5D54)',
                      border: catFilter === cat ? 'none' : '1.5px solid var(--border, #E8DDD4)',
                    }}
                  >
                    {cat === 'all' ? 'All' : cat}
                  </button>
                ))}
              </div>
            )}

            {filteredTreatments.length === 0 ? (
              <EmptyState icon="sparkles" title="No treatment data yet" desc="Data appears after clients start booking." />
            ) : (
              filteredTreatments.map((t, i) => (
                <div key={t.id} style={styles.treatmentCard}>
                  <div style={styles.treatmentHeader}>
                    <div style={styles.treatmentRankBadge}>{i + 1}</div>
                    <div style={styles.treatmentMeta}>
                      <span style={styles.treatmentName}>{t.name}</span>
                      {t.category && <span style={styles.treatmentCat}>{t.category}</span>}
                    </div>
                    {t.trend && (
                      <span style={{ fontSize: 18, color: TREND_COLORS[t.trend] }}>
                        {TREND_ICONS[t.trend]}
                      </span>
                    )}
                  </div>
                  <div style={styles.treatmentStats}>
                    <div style={styles.treatmentStat}>
                      <span style={styles.treatmentStatValue}><Money pence={t.revenue} round /></span>
                      <span style={styles.treatmentStatLabel}>revenue</span>
                    </div>
                    <div style={styles.treatmentStat}>
                      <span style={styles.treatmentStatValue}>{t.bookings}</span>
                      <span style={styles.treatmentStatLabel}>bookings</span>
                    </div>
                    <div style={styles.treatmentStat}>
                      <span style={styles.treatmentStatValue}><Money pence={t.hourlyRate} round />/h</span>
                      <span style={styles.treatmentStatLabel}>rate</span>
                    </div>
                    {t.returnRate > 0 && (
                      <div style={styles.treatmentStat}>
                        <span style={styles.treatmentStatValue}>{t.returnRate}%</span>
                        <span style={styles.treatmentStatLabel}>return</span>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </>
        )
      )}

      {/* ── EXPORT TAB ───────────────────────────────── */}
      {tab === 'export' && (
        <div>
          <p style={styles.exportDesc}>Download your Florrie data as CSV files ready to open in Excel or Numbers.</p>

          <ExportCard
            icon="calendar"
            title="Appointments"
            desc={`${allAppointments.length} records - date, client, treatment, status, revenue`}
            onExport={exportAppointments}
            loading={exportLoading}
          />
          <ExportCard
            icon="users"
            title="Clients"
            desc={`${allClients.length} clients - name, email, phone, joined date`}
            onExport={exportClients}
            loading={exportLoading}
          />
          <ExportCard
            icon="sparkles"
            title="Treatments"
            desc={`${treatmentStats.length} treatments - bookings, revenue, duration (last 90 days)`}
            onExport={exportTreatments}
            loading={exportLoading || treatmentLoading}
          />

          <div style={styles.exportNote}>
            <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted, #6B5D54)', lineHeight: 1.6 }}>
              All figures in pounds sterling. Appointment data includes completed and cancelled appointments.
              Treatment data covers the last 90 days.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// Sub-components

function StatCard({ label, value, sub, color }) {
  return (
    <div style={styles.statCard}>
      <span style={styles.statLabel}>{label}</span>
      <span style={{ ...styles.statValue, color }}>{value}</span>
      <span style={styles.statSub}>{sub}</span>
    </div>
  );
}

function DayBarChart({ data }) {
  const max = Math.max(...Object.values(data), 1);
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const keys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  return (
    <div style={styles.barChart}>
      {keys.map((k, i) => {
        const val = data[k] || 0;
        const pct = (val / max) * 100;
        return (
          <div key={k} style={styles.barCol}>
            <span style={styles.barValue}>{val}</span>
            <div style={styles.barTrack}>
              <div style={{ ...styles.barFill, height: `${Math.max(pct, 4)}%`, background: val === max ? 'var(--accent, #92405e)' : 'var(--border, #E8DDD4)' }} />
            </div>
            <span style={{ ...styles.barLabel, color: val === max ? 'var(--accent, #92405e)' : 'var(--text-muted, #6B5D54)' }}>
              {days[i]}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function SkeletonCard({ height = 80 }) {
  return (
    <div style={{ ...styles.card, height, display: 'flex', flexDirection: 'column', gap: 10, justifyContent: 'center' }}>
      <div style={{ height: 14, width: '40%', borderRadius: 10, background: 'var(--border-light, #ede7e3)' }} />
      <div style={{ height: 14, width: '65%', borderRadius: 10, background: 'var(--bg-subtle, #ede7e3)' }} />
    </div>
  );
}

function ExportCard({ icon, title, desc, onExport, loading }) {
  return (
    <div style={styles.exportCard}>
      <div style={styles.exportCardLeft}>
        <span style={{ fontSize: 24 }}><Icon name={iconName(icon)} inline /></span>
        <div>
          <span style={styles.exportCardTitle}>{title}</span>
          <span style={styles.exportCardDesc}>{loading ? 'Loading…' : desc}</span>
        </div>
      </div>
      <button
        onClick={onExport}
        disabled={loading}
        style={{ ...styles.exportBtn, opacity: loading ? 0.5 : 1, cursor: loading ? 'not-allowed' : 'pointer' }}
      >
        CSV
      </button>
    </div>
  );
}

// Utilisation: booked minutes / available working minutes across [start, end].
// working_hours is the beautician JSONB: { mon: {start, end}, ..., sat: null }.
// Returns an integer percent, or null when hours aren't set up.
function computeUtilisation(workingHours, completed, start, end) {
  if (!workingHours || typeof workingHours !== 'object') return null;

  const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  // Minutes worked per weekday from working_hours.
  const minutesByDay = {};
  let anyOpen = false;
  for (const key of dayKeys) {
    const h = workingHours[key];
    if (h && h.start && h.end) {
      const [sh, sm] = h.start.split(':').map(Number);
      const [eh, em] = h.end.split(':').map(Number);
      const mins = (eh * 60 + em) - (sh * 60 + sm);
      minutesByDay[key] = mins > 0 ? mins : 0;
      if (mins > 0) anyOpen = true;
    } else {
      minutesByDay[key] = 0;
    }
  }
  if (!anyOpen) return null;

  // Sum available minutes across each calendar day in the period.
  let availableMinutes = 0;
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  const stop = new Date(end);
  while (cursor <= stop) {
    availableMinutes += minutesByDay[dayKeys[cursor.getDay()]] || 0;
    cursor.setDate(cursor.getDate() + 1);
  }
  if (availableMinutes <= 0) return null;

  // Booked minutes from completed appointments in range.
  const bookedMinutes = completed.reduce((s, a) => s + (a.duration_minutes || 0), 0);

  return Math.min(100, Math.round((bookedMinutes / availableMinutes) * 100));
}

// Insights logic
function getInsights(stats) {
  const insights = [];
  if (stats.noShowRate > 10) insights.push({ icon: 'alert-triangle', text: `No-show rate is ${stats.noShowRate}%. Deposits reduce this significantly.` });
  if (stats.noShowRate <= 5) insights.push({ icon: 'sparkles', text: 'Your no-show rate is excellent. Your clients are reliable.' });
  if (stats.utilizationRate !== null && stats.utilizationRate < 60) insights.push({ icon: 'info', text: 'You have room to fill. A last-minute deals campaign could help.' });
  if (stats.utilizationRate !== null && stats.utilizationRate > 85) insights.push({ icon: 'flame', text: "You're nearly fully booked. Consider raising prices or opening a waitlist." });
  if (stats.newClients > 0) insights.push({ icon: 'hand', text: `${stats.newClients} new client${stats.newClients > 1 ? 's' : ''} this period. Keep your booking link visible.` });
  if (stats.topClients.length > 0 && stats.topClients[0].visits >= 3) insights.push({ icon: 'sparkles', text: `${stats.topClients[0].name} is your top client with ${stats.topClients[0].visits} visits. A loyalty perk could lock them in.` });
  if (insights.length === 0) insights.push({ icon: 'trending-up', text: 'Keep booking and trends will surface here automatically.' });
  return insights;
}

// Styles
const styles = {
  page: { minHeight: 'var(--shell-viewport)', background: 'var(--bg, #FBF6F1)', fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif", padding: '0 16px var(--scroll-pad-bottom)', maxWidth: 480, margin: '0 auto', color: 'var(--text-primary, #241B17)' },
  header: { paddingTop: 8, paddingBottom: 8 },
  title: { fontSize: 22, fontWeight: 700, margin: 0, fontFamily: "'Playfair Display', Georgia, serif", letterSpacing: '-0.02em' },

  tabNav: { display: 'flex', gap: 6, marginBottom: 12 },
  tabBtn: { flex: 1, padding: '9px 0', borderRadius: 10, border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.2s' },

  periodNav: { display: 'flex', gap: 6, marginBottom: 14 },
  periodTab: { flex: 1, padding: '7px 0', borderRadius: 10, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s' },

  // Hero revenue
  heroCard: { background: 'linear-gradient(135deg, #B9466D 0%, #BB4668 100%)', borderRadius: 16, padding: 20, marginBottom: 12, color: '#fff' },
  heroLabel: { fontSize: 11, fontWeight: 600, opacity: 0.8, textTransform: 'uppercase', letterSpacing: '0.06em' },
  heroAmount: { display: 'block', fontSize: 36, fontWeight: 800, marginTop: 4, letterSpacing: '-0.02em' },
  heroRow: { display: 'flex', justifyContent: 'space-between', marginTop: 16, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.2)' },
  heroStat: { display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1 },
  heroStatValue: { fontSize: 18, fontWeight: 700 },
  heroStatLabel: { fontSize: 10, opacity: 0.7, marginTop: 2 },
  heroDivider: { width: 1, background: 'rgba(255,255,255,0.2)', margin: '0 4px' },

  statsGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 },
  statCard: { background: 'var(--bg-card, #FFFCF9)', borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 2, boxShadow: 'var(--elev-1)' },
  statLabel: { fontSize: 11, color: 'var(--text-muted, #6B5D54)', fontWeight: 500 },
  statValue: { fontSize: 22, fontWeight: 700, letterSpacing: '-0.01em' },
  statSub: { fontSize: 11, color: 'var(--text-muted, #6B5D54)' },

  insightCard: { display: 'flex', alignItems: 'center', gap: 12, padding: 14, borderRadius: 10, background: 'var(--warning-bg, #F7EEDD)', marginBottom: 12 },
  insightIcon: { fontSize: 24, flexShrink: 0 },
  insightContent: { display: 'flex', flexDirection: 'column', gap: 2 },
  insightTitle: { fontSize: 12, fontWeight: 600, color: 'var(--warning, #79581C)' },
  insightText: { fontSize: 13, color: 'var(--text-secondary, #574A42)' },

  card: { background: 'var(--bg-card, #FFFCF9)', borderRadius: 16, padding: 16, marginBottom: 12, boxShadow: 'var(--elev-1)' },
  cardTitle: { fontSize: 14, fontWeight: 600, margin: '0 0 12px', color: 'var(--text-primary, #241B17)' },

  clientRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border-light, #ede7e3)' },
  clientRank: { width: 24, height: 24, borderRadius: 10, background: 'var(--bg-subtle, #ede7e3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--text-muted, #6B5D54)', flexShrink: 0 },
  clientInfo: { flex: 1, display: 'flex', flexDirection: 'column', gap: 1 },
  clientName: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary, #241B17)' },
  clientVisits: { fontSize: 11, color: 'var(--text-muted, #6B5D54)' },
  clientSpend: { fontSize: 14, fontWeight: 700, color: 'var(--accent, #92405e)' },

  barChart: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', height: 120, gap: 4, paddingTop: 8 },
  barCol: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flex: 1 },
  barValue: { fontSize: 10, fontWeight: 600, color: 'var(--text-muted, #6B5D54)' },
  barTrack: { width: '100%', height: 80, borderRadius: 6, background: 'var(--bg, #FBF6F1)', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', overflow: 'hidden' },
  barFill: { width: '100%', borderRadius: 6, transition: 'height 0.4s ease', minHeight: 3 },
  barLabel: { fontSize: 10, fontWeight: 600 },

  insightsList: { display: 'flex', flexDirection: 'column', gap: 8 },
  aiInsight: { display: 'flex', alignItems: 'flex-start', gap: 8 },
  aiInsightIcon: { fontSize: 16, flexShrink: 0, marginTop: 1 },
  aiInsightText: { fontSize: 13, color: 'var(--text-secondary, #574A42)', lineHeight: 1.5 },

  // Treatments tab
  filterRow: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 },
  filterChip: { padding: '6px 12px', borderRadius: 10, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s' },

  treatmentCard: { background: 'var(--bg-card, #FFFCF9)', borderRadius: 10, padding: 14, marginBottom: 8, boxShadow: 'var(--elev-1)' },
  treatmentHeader: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 },
  treatmentRankBadge: { width: 28, height: 28, borderRadius: 10, background: 'var(--accent-light, rgba(199,107,138,0.08))', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: 'var(--accent, #92405e)', flexShrink: 0 },
  treatmentMeta: { flex: 1, display: 'flex', flexDirection: 'column', gap: 1 },
  treatmentName: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #241B17)' },
  treatmentCat: { fontSize: 11, color: 'var(--text-muted, #6B5D54)', textTransform: 'capitalize' },
  treatmentStats: { display: 'flex', gap: 0, borderTop: '1px solid var(--border-light, #ede7e3)', paddingTop: 10 },
  treatmentStat: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 },
  treatmentStatValue: { fontSize: 15, fontWeight: 700, color: 'var(--text-primary, #241B17)' },
  treatmentStatLabel: { fontSize: 10, color: 'var(--text-muted, #6B5D54)', fontWeight: 500 },

  // Export tab
  exportDesc: { fontSize: 13, color: 'var(--text-muted, #6B5D54)', margin: '0 0 16px', lineHeight: 1.5 },
  exportCard: { background: 'var(--bg-card, #FFFCF9)', borderRadius: 10, padding: 14, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 12, boxShadow: 'var(--elev-1)' },
  exportCardLeft: { display: 'flex', alignItems: 'center', gap: 12, flex: 1 },
  exportCardTitle: { display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #241B17)' },
  exportCardDesc: { display: 'block', fontSize: 11, color: 'var(--text-muted, #6B5D54)', marginTop: 2 },
  exportBtn: { padding: '8px 16px', borderRadius: 10, border: 'none', background: 'var(--accent, #92405e)', color: '#fff', fontSize: 12, fontWeight: 700, fontFamily: 'inherit', flexShrink: 0 },
  exportNote: { background: 'var(--bg-subtle, #ede7e3)', borderRadius: 10, padding: 12, marginTop: 8 },

  skeletonGroup: { display: 'flex', flexDirection: 'column', gap: 10 },
};
