import { useState, useEffect } from 'react';
import { useBeautician, supabase, isDevMode } from '../lib/supabase.js';
import { ds, type } from '../lib/designSystem.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';

const DEV_FORECAST = [
  { day: 'Mon', demand: 'Low', bookings: 4, capacity: 12, pct: 33, revenue: '£320', suggestion: 'Run a flash promo' },
  { day: 'Tue', demand: 'Medium', bookings: 7, capacity: 12, pct: 58, revenue: '£580', suggestion: 'Push filler slots on socials' },
  { day: 'Wed', demand: 'Medium', bookings: 8, capacity: 12, pct: 67, revenue: '£640', suggestion: 'On track — monitor' },
  { day: 'Thu', demand: 'High', bookings: 11, capacity: 12, pct: 92, revenue: '£920', suggestion: 'Nearly full — consider waitlist' },
  { day: 'Fri', demand: 'High', bookings: 12, capacity: 12, pct: 100, revenue: '£1,080', suggestion: 'Fully booked ✓' },
  { day: 'Sat', demand: 'Peak', bookings: 12, capacity: 12, pct: 100, revenue: '£1,200', suggestion: 'Fully booked + 3 waitlisted' },
  { day: 'Sun', demand: 'Low', bookings: 2, capacity: 6, pct: 33, revenue: '£180', suggestion: 'Reduced hours — normal' },
];

const DEV_HEATMAP = [
  { hour: '9am', mon: 2, tue: 3, wed: 4, thu: 5, fri: 5, sat: 5 },
  { hour: '10am', mon: 3, tue: 4, wed: 4, thu: 5, fri: 5, sat: 5 },
  { hour: '11am', mon: 2, tue: 3, wed: 5, thu: 5, fri: 5, sat: 5 },
  { hour: '12pm', mon: 1, tue: 2, wed: 3, thu: 4, fri: 4, sat: 5 },
  { hour: '1pm', mon: 1, tue: 2, wed: 2, thu: 3, fri: 4, sat: 4 },
  { hour: '2pm', mon: 2, tue: 3, wed: 3, thu: 4, fri: 5, sat: 5 },
  { hour: '3pm', mon: 2, tue: 3, wed: 4, thu: 5, fri: 5, sat: 5 },
  { hour: '4pm', mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 5 },
  { hour: '5pm', mon: 1, tue: 2, wed: 2, thu: 3, fri: 4, sat: 4 },
  { hour: '6pm', mon: 0, tue: 1, wed: 1, thu: 2, fri: 3, sat: 3 },
];

const staffingRecs = [
  { day: 'Monday', current: 2, recommended: 1, reason: 'Overstaffed — only 33% booked', saving: '£120', icon: '⬇️' },
  { day: 'Thursday', current: 2, recommended: 3, reason: '92% booked — need overflow capacity', cost: '£140', icon: '⬆️' },
  { day: 'Saturday', current: 2, recommended: 3, reason: 'Full + waitlist — extend with 3rd stylist', cost: '£160', icon: '⬆️' },
];

const seasonalTrends = [
  { month: 'Jan', demand: 65, label: 'Post-holiday dip' },
  { month: 'Feb', demand: 75, label: "Valentine's boost" },
  { month: 'Mar', demand: 80, label: 'Spring refresh' },
  { month: 'Apr', demand: 85, label: 'Pre-summer prep' },
  { month: 'May', demand: 90, label: 'Wedding season starts' },
  { month: 'Jun', demand: 95, label: 'Peak summer' },
  { month: 'Jul', demand: 88, label: 'Holiday season' },
  { month: 'Aug', demand: 82, label: 'Late summer dip' },
  { month: 'Sep', demand: 78, label: 'Back to school' },
  { month: 'Oct', demand: 85, label: 'Autumn refresh' },
  { month: 'Nov', demand: 92, label: 'Party season prep' },
  { month: 'Dec', demand: 98, label: 'Christmas peak' },
];

const tabs = ['This Week', 'Heatmap', 'Staffing', 'Seasonal'];

export default function DemandForecast() {
  const { beautician, loading: bLoading } = useBeautician();
  const [tab, setTab] = useState(0);
  const [loading, setLoading] = useState(true);
  const [forecast, setForecast] = useState(isDevMode ? DEV_FORECAST : []);
  const [heatmap, setHeatmap] = useState(isDevMode ? DEV_HEATMAP : []);

  useEffect(() => {
    if (beautician && !bLoading) loadForecast();
  }, [beautician, bLoading]);

  async function loadForecast() {
    setLoading(true);
    try {
      if (isDevMode) {
        setForecast(DEV_FORECAST);
        setHeatmap(DEV_HEATMAP);
      } else {
        // Query appointments grouped by day/hour
        const { data: appointments } = await supabase
          .from('appointments')
          .select('*')
          .eq('beautician_id', beautician.id)
          .gte('start_time', new Date().toISOString());

        // TODO: compute real forecast from appointment data
        // For now, fall back to demo data
        setForecast(DEV_FORECAST);
        setHeatmap(DEV_HEATMAP);
      }
    } catch (err) {
      logger.error('Load forecast error:', err);
      setForecast(DEV_FORECAST);
      setHeatmap(DEV_HEATMAP);
    } finally {
      setLoading(false);
    }
  }

  if (bLoading || loading) {
    return <div style={ds.page}><div style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted, #7a7470)' }}>Loading...</div></div>;
  }

  const demandColor = (level) => {
    if (level === 'Peak') return { bg: 'var(--danger-bg)', color: 'var(--danger)' };
    if (level === 'High') return { bg: 'var(--success-bg)', color: 'var(--success)' };
    if (level === 'Medium') return { bg: 'var(--gold-light)', color: 'var(--gold)' };
    return { bg: 'var(--bg-subtle)', color: 'var(--text-muted)' };
  };

  const heatColor = (val) => {
    if (val >= 5) return 'var(--accent)';
    if (val >= 4) return 'rgba(199,107,138,0.7)';
    if (val >= 3) return 'rgba(199,107,138,0.45)';
    if (val >= 2) return 'rgba(199,107,138,0.25)';
    if (val >= 1) return 'rgba(199,107,138,0.12)';
    return 'var(--bg-subtle)';
  };

  return (
    <div style={ds.page}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={ds.pageTitle}>Demand Forecast</h1>
        <p style={{ ...type.bodySmall, marginTop: 4 }}>Predict busy periods and plan capacity</p>
      </div>

      {/* Hero */}
      <div style={{ ...ds.heroCard, marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>NEXT WEEK FORECAST</div>
            <div style={{ fontSize: 36, fontWeight: 700, letterSpacing: '-0.02em' }}>£4,920</div>
            <div style={{ fontSize: 13, opacity: 0.9, marginTop: 4 }}>72% avg capacity · 56 bookings predicted</div>
          </div>
          <div style={{ fontSize: 40 }}>📊</div>
        </div>
        {/* Mini capacity bars */}
        <div style={{ display: 'flex', gap: 4, marginTop: 16 }}>
          {forecast.map(d => (
            <div key={d.day} style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ height: 40, background: 'rgba(255,255,255,0.15)', borderRadius: 4, position: 'relative', overflow: 'hidden' }}>
                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: `${d.pct}%`, background: 'rgba(255,255,255,0.6)', borderRadius: '0 0 4px 4px' }} />
              </div>
              <div style={{ fontSize: 10, opacity: 0.8, marginTop: 4 }}>{d.day}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div style={ds.tabBar}>
        {tabs.map((t, i) => (
          <button key={t} onClick={() => setTab(i)} style={{ ...ds.tab, ...(tab === i ? ds.tabActive : {}) }}>{t}</button>
        ))}
      </div>

      {/* This Week */}
      {tab === 0 && (
        <div>
          {forecast.map(d => {
            const dc = demandColor(d.demand);
            return (
              <div key={d.day} style={{ ...ds.card, marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <div style={{ ...type.heading, fontSize: 15, width: 36 }}>{d.day}</div>
                    <span style={{ ...ds.badge, background: dc.bg, color: dc.color }}>{d.demand}</span>
                  </div>
                  <span style={{ ...type.mono, fontSize: 13, color: 'var(--success)' }}>{d.revenue}</span>
                </div>
                {/* Capacity bar */}
                <div style={{ height: 8, background: 'var(--bg-subtle)', borderRadius: 4, overflow: 'hidden', marginBottom: 6 }}>
                  <div style={{
                    height: '100%',
                    width: `${d.pct}%`,
                    background: d.pct === 100 ? 'var(--success)' : d.pct > 80 ? 'var(--accent)' : d.pct > 50 ? 'var(--gold)' : 'var(--text-muted)',
                    borderRadius: 4,
                    transition: 'width 0.4s ease',
                  }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ ...type.bodySmall, fontSize: 11 }}>{d.bookings}/{d.capacity} slots · {d.pct}%</span>
                  <span style={{ ...type.bodySmall, fontSize: 11, fontStyle: 'italic' }}>{d.suggestion}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Heatmap */}
      {tab === 1 && (
        <div>
          <div style={{ ...ds.card, marginBottom: 16, overflowX: 'auto' }}>
            <div style={{ ...type.heading, marginBottom: 12 }}>Booking Density — Hourly Heatmap</div>
            {/* Header row */}
            <div style={{ display: 'flex', gap: 3, marginBottom: 4 }}>
              <div style={{ width: 40, flexShrink: 0 }} />
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
                <div key={d} style={{ flex: 1, textAlign: 'center', ...type.caption, fontSize: 9 }}>{d}</div>
              ))}
            </div>
            {/* Heatmap rows */}
            {heatmap.map(row => (
              <div key={row.hour} style={{ display: 'flex', gap: 3, marginBottom: 3 }}>
                <div style={{ width: 40, flexShrink: 0, ...type.mono, fontSize: 10, display: 'flex', alignItems: 'center' }}>{row.hour}</div>
                {['mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map(d => (
                  <div key={d} style={{
                    flex: 1, height: 24, borderRadius: 4,
                    background: heatColor(row[d]),
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 9, fontWeight: 600,
                    color: row[d] >= 4 ? 'var(--bg-card, #fff)' : 'var(--text-muted)',
                  }}>
                    {row[d] > 0 ? row[d] : ''}
                  </div>
                ))}
              </div>
            ))}
            {/* Legend */}
            <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginTop: 10 }}>
              {[{ label: 'Empty', val: 0 }, { label: 'Light', val: 1 }, { label: 'Moderate', val: 3 }, { label: 'Busy', val: 4 }, { label: 'Full', val: 5 }].map(l => (
                <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                  <div style={{ width: 10, height: 10, borderRadius: 2, background: heatColor(l.val) }} />
                  <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{l.label}</span>
                </div>
              ))}
            </div>
          </div>

          <div style={ds.insightCard}>
            <span style={{ fontSize: 20 }}>🕐</span>
            <div style={{ ...type.bodySmall, lineHeight: 1.5 }}>
              Your dead zone is Monday afternoons (1–3pm). Consider running a "Lunchtime Express" promo — 30-min treatments at 15% off to fill that gap.
            </div>
          </div>
        </div>
      )}

      {/* Staffing */}
      {tab === 2 && (
        <div>
          <div style={{ ...ds.sectionTitle, marginBottom: 12 }}>STAFFING RECOMMENDATIONS</div>
          {staffingRecs.map(s => (
            <div key={s.day} style={{ ...ds.card, marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <span style={{ fontSize: 20 }}>{s.icon}</span>
                  <span style={type.heading}>{s.day}</span>
                </div>
                <span style={{
                  ...ds.badge,
                  ...(s.icon === '⬇️' ? ds.badgeWarning : ds.badgeSuccess),
                }}>{s.saving ? `Save ${s.saving}` : `+${s.cost}`}</span>
              </div>
              <div style={{ display: 'flex', gap: 16, marginBottom: 8 }}>
                <div>
                  <div style={{ ...type.caption, fontSize: 10, marginBottom: 2 }}>CURRENT</div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {Array(s.current).fill(0).map((_, i) => (
                      <div key={i} style={{ width: 24, height: 24, borderRadius: 8, background: 'var(--bg-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12 }}>👤</div>
                    ))}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', fontSize: 16, color: 'var(--text-muted)' }}>→</div>
                <div>
                  <div style={{ ...type.caption, fontSize: 10, marginBottom: 2 }}>RECOMMENDED</div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {Array(s.recommended).fill(0).map((_, i) => (
                      <div key={i} style={{ width: 24, height: 24, borderRadius: 8, background: 'var(--accent-light)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12 }}>👤</div>
                    ))}
                  </div>
                </div>
              </div>
              <div style={{ ...type.bodySmall, fontSize: 12 }}>{s.reason}</div>
            </div>
          ))}

          {/* Weekly cost impact */}
          <div style={{ ...ds.card, background: 'var(--bg-warm)' }}>
            <div style={{ ...type.heading, marginBottom: 8 }}>Net Weekly Impact</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={type.bodySmall}>Optimised staffing vs current</span>
              <span style={{ ...type.mono, fontSize: 14, color: 'var(--success)', fontWeight: 600 }}>Save £120/week</span>
            </div>
          </div>
        </div>
      )}

      {/* Seasonal */}
      {tab === 3 && (
        <div>
          <div style={{ ...ds.card, marginBottom: 16 }}>
            <div style={{ ...type.heading, marginBottom: 12 }}>12-Month Demand Curve</div>
            <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: 120 }}>
              {seasonalTrends.map((m, i) => {
                const isCurrentMonth = i === 2; // March
                return (
                  <div key={m.month} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <div style={{
                      width: '100%', height: `${m.demand}%`,
                      background: isCurrentMonth ? 'var(--accent)' : 'var(--accent-light)',
                      borderRadius: '4px 4px 0 0',
                      border: isCurrentMonth ? '2px solid var(--accent)' : 'none',
                      transition: 'height 0.4s ease',
                    }} />
                    <span style={{ ...type.mono, fontSize: 8, marginTop: 4, color: isCurrentMonth ? 'var(--accent)' : 'var(--text-muted)' }}>{m.month}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Monthly breakdown */}
          {seasonalTrends.map((m, i) => (
            <div key={m.month} style={{
              ...ds.listRow,
              background: i === 2 ? 'var(--accent-light)' : 'none',
              borderRadius: i === 2 ? 10 : 0,
              padding: i === 2 ? '13px 10px' : '13px 0',
            }}>
              <span style={{ ...type.heading, fontSize: 13, width: 40 }}>{m.month}</span>
              <div style={{ flex: 1 }}>
                <div style={{ height: 4, background: 'var(--bg-subtle)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${m.demand}%`, background: 'var(--accent)', borderRadius: 2 }} />
                </div>
              </div>
              <span style={{ ...type.mono, fontSize: 11, width: 36, textAlign: 'right' }}>{m.demand}%</span>
              <span style={{ ...type.bodySmall, fontSize: 11, width: 100, textAlign: 'right' }}>{m.label}</span>
            </div>
          ))}

          <div style={{ ...ds.insightCard, marginTop: 16 }}>
            <span style={{ fontSize: 20 }}>📅</span>
            <div style={{ ...type.bodySmall, lineHeight: 1.5 }}>
              You're entering spring refresh season — demand climbs through May. Start promoting wedding/event packages now to lock in peak-season bookings before competitors fill up.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
