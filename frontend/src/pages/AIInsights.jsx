import { useState, useEffect, useMemo } from 'react';
import { useBeautician, fetchRows, isDevMode } from '../lib/supabase.js';
import { ds, type, space } from '../lib/designSystem.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';

/* ─── Dev-mode sample data ──────────────────────────── */
const DEV_APPOINTMENTS = [
  { id: 1, client_name: 'Jessica Moore', treatment_name: 'Brow Lamination', starts_at: new Date().toISOString().slice(0, 10) + 'T09:30:00', status: 'confirmed', price_cents: 4500 },
  { id: 2, client_name: 'Sarah Chen', treatment_name: 'Lash Lift & Tint', starts_at: new Date().toISOString().slice(0, 10) + 'T11:00:00', status: 'confirmed', price_cents: 5500 },
  { id: 3, client_name: 'Emma Taylor', treatment_name: 'Gel Manicure', starts_at: new Date().toISOString().slice(0, 10) + 'T13:15:00', status: 'confirmed', price_cents: 3500 },
  { id: 4, client_name: 'Olivia Brown', treatment_name: 'Facial Peel', starts_at: new Date().toISOString().slice(0, 10) + 'T15:00:00', status: 'pending', price_cents: 6500 },
  { id: 5, client_name: 'Amy Wilson', treatment_name: 'Lip Filler Top-Up', starts_at: new Date().toISOString().slice(0, 10) + 'T16:30:00', status: 'confirmed', price_cents: 12000 },
];

const DEV_ACTIVITY = [
  { type: 'booking', message: 'New booking: Emma Taylor — Gel Manicure, today 1:15 PM', time: '2h ago', icon: '📅' },
  { type: 'confirmation', message: 'Confirmed: Sarah Chen replied YES to her 11 AM appointment', time: '3h ago', icon: '✅' },
  { type: 'reschedule', message: 'Rescheduled: Olivia Brown moved from Wed to today 3 PM', time: '4h ago', icon: '🔄' },
  { type: 'review', message: 'New 5★ review from Lucy Hart: "Best brows in town!"', time: '5h ago', icon: '⭐' },
  { type: 'reminder', message: 'Sent 3 appointment reminders for tomorrow', time: '6h ago', icon: '🔔' },
  { type: 'gap', message: 'Gap detected: 2:00–3:00 PM today is open. Waitlist has 2 matches.', time: '7h ago', icon: '⚡' },
];

const TIPS = [
  { text: 'Thursday–Saturday is your money window. You\'re under-booked Mondays — consider a "Monday Glow" promo.', icon: '💡' },
  { text: 'Lip Filler bookings are up 34% this month. Might be time for a dedicated Instagram reel.', icon: '📈' },
  { text: '3 clients haven\'t rebooked in 40+ days. Sending a "we miss you" message could recover £2,100/yr.', icon: '💌' },
  { text: 'Your average booking gap is 22 minutes. Tightening to 15 could fit 1 extra client per day.', icon: '⏱️' },
];

export default function AIInsights() {
  const { beautician, loading: bLoading } = useBeautician();
  const [appointments, setAppointments] = useState([]);
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (bLoading || !beautician) return;
    loadData();
  }, [beautician, bLoading]);

  async function loadData() {
    setLoading(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const rows = await fetchRows('appointments', beautician.id, {
        order: 'starts_at', ascending: true,
        filters: { starts_at: `gte.${today}T00:00:00`, 'starts_at.lt': `${today}T23:59:59` },
      });
      if (rows && rows.length > 0) {
        setAppointments(rows);
      } else if (isDevMode) {
        setAppointments(DEV_APPOINTMENTS);
      } else {
        setAppointments([]);
      }
      // Activity feed — would come from an activity_log table in production
      setActivity(isDevMode ? DEV_ACTIVITY : []);
    } catch (err) {
      logger.error('Load AI insights error:', err);
      if (isDevMode) {
        setAppointments(DEV_APPOINTMENTS);
        setActivity(DEV_ACTIVITY);
      }
    } finally {
      setLoading(false);
    }
  }

  const todaysTip = useMemo(() => TIPS[Math.floor(Math.random() * TIPS.length)], []);

  const stats = useMemo(() => {
    const confirmed = appointments.filter(a => a.status === 'confirmed' || a.status === 'completed');
    const revenue = appointments.reduce((sum, a) => sum + (a.price_cents || 0), 0);
    const completed = appointments.filter(a => a.status === 'completed').length;
    const pending = appointments.filter(a => a.status === 'pending').length;
    return { total: appointments.length, confirmed: confirmed.length, revenue, completed, pending };
  }, [appointments]);

  if (bLoading || loading) return <div style={ds.page}><PageLoader /></div>;

  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const dateStr = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <div style={ds.page}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 22 }}>✨</span>
          <h1 style={{ ...type.displayMd, margin: 0 }}>florrie.ai</h1>
        </div>
        <p style={{ ...type.bodySmall, color: 'var(--text-muted)', margin: 0 }}>
          {dateStr} · {timeStr}
        </p>
      </div>

      {/* Today's snapshot */}
      <div style={{ ...ds.heroCard, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Today's Snapshot</div>
            <div style={{ fontSize: 36, fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1 }}>{stats.total}</div>
            <div style={{ fontSize: 13, opacity: 0.9, marginTop: 4 }}>
              appointment{stats.total !== 1 ? 's' : ''} · £{(stats.revenue / 100).toFixed(0)} expected
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            {stats.pending > 0 && (
              <div style={{ ...ds.badge, background: 'rgba(255,255,255,0.2)', color: '#fff', marginBottom: 4 }}>
                {stats.pending} pending
              </div>
            )}
            <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>
              {stats.confirmed} confirmed
            </div>
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 20 }}>
        {[
          { label: 'Completed', value: stats.completed, icon: '✅' },
          { label: 'Pending', value: stats.pending, icon: '⏳' },
          { label: 'Revenue', value: `£${(stats.revenue / 100).toFixed(0)}`, icon: '💰' },
        ].map(s => (
          <div key={s.label} style={{ ...ds.card, textAlign: 'center', padding: '12px 8px' }}>
            <div style={{ fontSize: 18, marginBottom: 4 }}>{s.icon}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>{s.value}</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* AI Tip */}
      <div style={{ ...ds.insightCard, marginBottom: 20 }}>
        <span style={{ fontSize: 20 }}>{todaysTip.icon}</span>
        <div>
          <div style={{ ...type.heading, fontSize: 13, marginBottom: 4, color: 'var(--accent)' }}>florrie.ai's take</div>
          <div style={{ ...type.bodySmall, lineHeight: 1.5 }}>{todaysTip.text}</div>
        </div>
      </div>

      {/* Today's schedule */}
      <div style={{ marginBottom: 20 }}>
        <div style={ds.sectionTitle}>TODAY'S SCHEDULE</div>
        {appointments.length === 0 ? (
          <EmptyState message="No appointments today" icon="📅" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {appointments.map((apt, i) => {
              const time = new Date(apt.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
              const isPast = new Date(apt.starts_at) < now;
              const isNext = !isPast && (i === 0 || new Date(appointments[i - 1].starts_at) < now);
              return (
                <div key={apt.id} style={{
                  ...ds.card,
                  display: 'flex', gap: 12, alignItems: 'center',
                  opacity: isPast ? 0.5 : 1,
                  borderLeft: isNext ? '3px solid var(--accent)' : '3px solid transparent',
                }}>
                  <div style={{
                    width: 44, textAlign: 'center', flexShrink: 0,
                  }}>
                    <div style={{ ...type.heading, fontSize: 14 }}>{time}</div>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ ...type.heading, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {apt.client_name || 'Walk-in'}
                    </div>
                    <div style={{ ...type.bodySmall, color: 'var(--text-muted)', fontSize: 12 }}>
                      {apt.treatment_name || 'Appointment'}
                    </div>
                  </div>
                  <div style={{
                    ...ds.badge,
                    ...(apt.status === 'confirmed' ? ds.badgeSuccess : apt.status === 'completed' ? { background: 'var(--bg-subtle)', color: 'var(--text-muted)' } : ds.badgeWarning),
                    fontSize: 10,
                  }}>
                    {apt.status === 'confirmed' ? '✓' : apt.status === 'completed' ? '✓ Done' : '⏳'}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Activity feed */}
      {activity.length > 0 && (
        <div>
          <div style={ds.sectionTitle}>RECENT ACTIVITY</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {activity.map((a, i) => (
              <div key={i} style={{
                ...ds.card, display: 'flex', gap: 10, alignItems: 'flex-start',
                padding: '10px 12px',
              }}>
                <span style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }}>{a.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ ...type.body, fontSize: 13, lineHeight: 1.4 }}>{a.message}</div>
                  <div style={{ ...type.mono, fontSize: 10, color: 'var(--text-muted)', marginTop: 3 }}>{a.time}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
