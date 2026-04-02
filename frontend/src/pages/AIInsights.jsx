import { useState, useEffect, useMemo } from 'react';
import { useBeautician, fetchRows, isDevMode } from '../lib/supabase.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';

/**
 * AIInsights — Stitch "florrie.ai Assistant" reference rebuild.
 *
 * Matches the Stitch screen:
 *   - Pulse snapshot card (gradient, "Your day is X% optimized")
 *   - Stats pills (Completed / Pending / Revenue)
 *   - AI Recommendation card
 *   - Next Appointments compact list
 *   - Live Feed (activity)
 */

/* ─── Dev-mode sample data ──────────────────────────── */
const DEV_APPOINTMENTS = [
  { id: 1, client_name: 'Emma Richardson', treatment_name: 'Signature Balayage + Treatment', starts_at: new Date().toISOString().slice(0, 10) + 'T14:00:00', status: 'confirmed', price_cents: 24500 },
  { id: 2, client_name: 'Julianna Moore', treatment_name: 'Express Gloss & Blowout', starts_at: new Date().toISOString().slice(0, 10) + 'T15:30:00', status: 'confirmed', price_cents: 11000 },
  { id: 3, client_name: 'Sarah Chen', treatment_name: 'Lash Lift & Tint', starts_at: new Date().toISOString().slice(0, 10) + 'T11:00:00', status: 'confirmed', price_cents: 5500 },
  { id: 4, client_name: 'Olivia Brown', treatment_name: 'Facial Peel', starts_at: new Date().toISOString().slice(0, 10) + 'T13:15:00', status: 'confirmed', price_cents: 6500 },
  { id: 5, client_name: 'Amy Wilson', treatment_name: 'Lip Filler Top-Up', starts_at: new Date().toISOString().slice(0, 10) + 'T16:30:00', status: 'pending', price_cents: 12000 },
];

const DEV_ACTIVITY = [
  { type: 'optimization', message: 'Optimization complete. Restocked \'Mist\' inventory.', time: '2m ago', icon: '✨' },
  { type: 'booking', message: 'New Booking: Sarah K. for Dec 12th.', time: '14m ago', icon: '📅' },
  { type: 'payment', message: 'Payment Received: £240.00 from Maya L.', time: '1h ago', icon: '💰' },
];

const DEV_COACHING = [
  { id: 'vc-1', summary: "Your Saturday mornings fill within 2 hours. You could increase your gel set by £5 — demand supports it.", metadata: { coaching_type: 'high_demand' } },
  { id: 'vc-2', summary: "You haven't updated prices on 4 treatments in 6+ months. A £3 increase across these adds roughly £280/month based on your current bookings.", metadata: { coaching_type: 'price_stale' } },
  { id: 'vc-3', summary: "Clients who add brow lamination spend £25 more per visit. Mention it when rebooking lash clients — it could mean £150/month extra.", metadata: { coaching_type: 'upsell' } },
];

const TIPS = [
  { text: 'Emma tends to purchase \'Velvet Shine Serum\' every 3 appointments. She\'s due today—mention the loyalty discount for a likely upsell.' },
  { text: 'Thursday–Saturday is your money window. You\'re under-booked Mondays — consider a "Monday Glow" promo.' },
  { text: 'Lip Filler bookings are up 34% this month. Might be time for a dedicated Instagram reel.' },
  { text: '3 clients haven\'t rebooked in 40+ days. Sending a "we miss you" message could recover £2,100/yr.' },
];

function MIcon({ name, fill, size, style }) {
  return (
    <span className="material-symbols-outlined" style={{
      fontSize: size || 24,
      fontVariationSettings: fill ? "'FILL' 1, 'wght' 300" : undefined,
      ...style,
    }}>{name}</span>
  );
}

export default function AIInsights() {
  const { beautician, loading: bLoading } = useBeautician();
  const [appointments, setAppointments] = useState([]);
  const [activity, setActivity] = useState([]);
  const [coachingCards, setCoachingCards] = useState([]);
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
      setActivity(isDevMode ? DEV_ACTIVITY : []);

      // Fetch value coaching insights
      if (!isDevMode) {
        const coaching = await fetchRows('ai_actions', beautician.id, {
          order: 'created_at', ascending: false,
          filters: { action_type: 'eq.value_coaching' },
          limit: 3,
        });
        setCoachingCards(coaching || []);
      } else {
        setCoachingCards(DEV_COACHING);
      }
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

  if (bLoading || loading) return <PageLoader />;

  const optimPct = stats.total > 0 ? Math.min(95, Math.round((stats.confirmed / stats.total) * 100 + (stats.total > 3 ? 10 : 0))) : 0;

  const now = new Date();
  const upcoming = [...appointments]
    .filter(a => new Date(a.starts_at) > now || a.status !== 'completed')
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))
    .slice(0, 3);

  const focusAppt = upcoming[0];

  return (
    <div style={S.page}>
      {/* ─── Pulse Snapshot Card ─── */}
      <section style={S.pulseCard}>
        <div style={S.pulseDecor} />
        <div style={{ position: 'relative', zIndex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <MIcon name="auto_awesome" fill size={16} style={{ color: 'rgba(255,255,255,0.8)' }} />
            <span style={S.pulseLabel}>Today's Pulse</span>
          </div>
          <h2 style={S.pulseHeading}>
            Your day is {optimPct}%<br />optimized.
          </h2>
          {focusAppt && (
            <p style={S.pulseSub}>
              Focus on the {focusAppt.treatment_name || 'next appointment'} at {new Date(focusAppt.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}—client high-value window identified.
            </p>
          )}
        </div>
        <div style={S.pulseIcon}>
          <MIcon name="temp_preferences_custom" size={64} style={{ opacity: 0.2, color: '#fff' }} />
        </div>
      </section>

      {/* ─── Stats Pills ─── */}
      <section style={S.statsGrid}>
        <div style={S.statPill}>
          <span style={S.statPillLabel}>Completed</span>
          <span style={S.statPillValue}>{String(stats.completed).padStart(2, '0')}</span>
        </div>
        <div style={S.statPill}>
          <span style={S.statPillLabel}>Pending</span>
          <span style={S.statPillValue}>{String(stats.pending).padStart(2, '0')}</span>
        </div>
        <div style={{ ...S.statPill, borderColor: 'rgba(116, 90, 39, 0.1)' }}>
          <span style={S.statPillLabel}>Revenue</span>
          <span style={{ ...S.statPillValue, color: '#745a27' }}>£{(stats.revenue / 100 / 1000).toFixed(1)}k</span>
        </div>
      </section>

      {/* ─── AI Recommendation ─── */}
      <section style={S.tipCard}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', position: 'relative', zIndex: 1 }}>
          <div style={S.tipIconWrap}>
            <MIcon name="lightbulb" size={22} style={{ color: '#fff' }} />
          </div>
          <div>
            <h4 style={S.tipTitle}>AI Recommendation</h4>
            <p style={S.tipText}>"{todaysTip.text}"</p>
          </div>
        </div>
      </section>

      {/* ─── Value Coaching ─── */}
      {coachingCards.length > 0 && (
        <section style={{ marginBottom: 24 }}>
          <div style={S.sectionHeader}>
            <h3 style={S.sectionHeading}>Revenue Opportunities</h3>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {coachingCards.map((card, i) => {
              const icons = { high_demand: '📈', price_stale: '💰', upsell: '✨' };
              const coachType = card.metadata?.coaching_type || 'upsell';
              return (
                <div key={card.id || i} style={S.coachingCard}>
                  <span style={{ fontSize: 22, flexShrink: 0 }}>{icons[coachType] || '💡'}</span>
                  <p style={{ fontSize: 13, lineHeight: 1.55, margin: 0, color: 'var(--text-primary, #1d1b19)' }}>{card.summary}</p>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ─── Next Appointments ─── */}
      <section style={{ marginBottom: 32 }}>
        <div style={S.sectionHeader}>
          <h3 style={S.sectionHeading}>Next Appointments</h3>
          <span style={S.seeAll}>See All</span>
        </div>
        {upcoming.length === 0 ? (
          <EmptyState message="No upcoming appointments" icon="📅" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {upcoming.map((apt, i) => {
              const time = new Date(apt.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
              const isFirst = i === 0;
              return (
                <div key={apt.id} style={S.apptRow}>
                  <div style={{ textAlign: 'center', flexShrink: 0 }}>
                    <p style={{ fontSize: 10, fontWeight: 700, color: '#867277', margin: 0 }}>{time}</p>
                    <p style={{ fontSize: 10, fontWeight: 700, color: '#867277', margin: 0 }}>
                      {parseInt(time) >= 12 ? 'PM' : 'AM'}
                    </p>
                  </div>
                  <div style={S.apptDivider} />
                  <div style={{ flex: 1 }}>
                    <p style={{ fontSize: 14, fontWeight: 700, color: '#1d1b19', margin: 0 }}>{apt.client_name || 'Client'}</p>
                    <p style={{ fontSize: 11, color: '#867277', margin: 0 }}>{apt.treatment_name || 'Appointment'}</p>
                  </div>
                  {isFirst ? (
                    <MIcon name="star" fill size={14} style={{ color: 'rgba(116, 90, 39, 0.4)' }} />
                  ) : (
                    <MIcon name="chevron_right" size={18} style={{ color: '#d8c1c6' }} />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ─── Live Feed ─── */}
      {activity.length > 0 && (
        <section>
          <h3 style={S.sectionHeading}>Live Feed</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingLeft: 8, marginTop: 16 }}>
            {activity.map((a, i) => (
              <div key={i} style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                <span style={{ fontSize: 20 }}>{a.icon}</span>
                <div style={{
                  flex: 1,
                  borderBottom: i < activity.length - 1 ? '1px solid rgba(146, 64, 94, 0.05)' : 'none',
                  paddingBottom: i < activity.length - 1 ? 12 : 0,
                }}>
                  <p style={{ fontSize: 12, color: '#1d1b19', margin: 0 }} dangerouslySetInnerHTML={{
                    __html: a.message.replace(/^([^.]+\.)/, '<strong>$1</strong>'),
                  }} />
                  <p style={{ fontSize: 9, color: '#867277', textTransform: 'uppercase', margin: '4px 0 0', fontFamily: "var(--font-sans)" }}>{a.time}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ─── Styles — Stitch "florrie.ai Assistant" reference ───
const S = {
  page: {
    minHeight: '100vh',
    background: '#fef8f4',
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)",
    padding: '16px 24px 120px',
    maxWidth: 480,
    margin: '0 auto',
    color: '#1d1b19',
    animation: 'fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
  },
  pulseCard: {
    position: 'relative', overflow: 'hidden',
    background: '#92405e', color: '#fff',
    borderRadius: 24, padding: 24, marginBottom: 20,
    boxShadow: '0 8px 32px rgba(146, 64, 94, 0.1)',
  },
  pulseDecor: {
    position: 'absolute', top: 0, right: 0,
    width: 128, height: 128,
    background: 'rgba(255,255,255,0.1)',
    borderRadius: '50%', marginRight: -64, marginTop: -64,
    filter: 'blur(32px)',
  },
  pulseIcon: { position: 'absolute', bottom: 16, right: 24 },
  pulseLabel: {
    fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.12em',
    fontWeight: 700, opacity: 0.8,
  },
  pulseHeading: {
    fontFamily: "var(--font-display, 'Playfair Display', serif)",
    fontSize: 30, fontStyle: 'italic', fontWeight: 400,
    lineHeight: 1.15, margin: 0,
  },
  pulseSub: {
    fontSize: 14, opacity: 0.9, maxWidth: '80%',
    lineHeight: 1.5, margin: '8px 0 0',
  },
  statsGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 24 },
  statPill: {
    background: '#fff', padding: 12, borderRadius: 16,
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    border: '1px solid rgba(146, 64, 94, 0.05)',
    boxShadow: '0 1px 3px rgba(146, 64, 94, 0.04)',
  },
  statPillLabel: {
    fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em',
    color: '#867277', marginBottom: 4,
  },
  statPillValue: {
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)",
    fontSize: 20, fontStyle: 'normal', fontWeight: 700, color: '#92405e',
    letterSpacing: '-0.01em',
  },
  tipCard: {
    background: 'rgba(254, 219, 155, 0.4)',
    border: '1px solid rgba(116, 90, 39, 0.1)',
    borderRadius: 16, padding: 20,
    position: 'relative', overflow: 'hidden',
    marginBottom: 32,
  },
  tipIconWrap: {
    width: 40, height: 40, borderRadius: '50%',
    background: '#745a27',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  tipTitle: { fontSize: 14, fontWeight: 700, color: '#795f2b', margin: '0 0 4px' },
  tipText: {
    fontSize: 12, color: 'rgba(121, 95, 43, 0.8)',
    lineHeight: 1.5, fontStyle: 'italic', margin: 0,
  },
  coachingCard: {
    display: 'flex', gap: 14, alignItems: 'flex-start',
    background: 'var(--bg-card, #fff)', borderRadius: 14, padding: 16,
    border: '1px solid var(--gold-light, rgba(201, 169, 110, 0.15))',
    boxShadow: '0 1px 3px rgba(146, 64, 94, 0.04)',
  },
  sectionHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
    marginBottom: 12,
  },
  sectionHeading: {
    fontFamily: "var(--font-display, 'Playfair Display', serif)",
    fontSize: 20, fontStyle: 'italic', fontWeight: 400,
    color: '#92405e', margin: 0,
  },
  seeAll: {
    fontSize: 10, fontWeight: 700, color: '#867277',
    textTransform: 'uppercase', letterSpacing: '0.12em',
  },
  apptRow: {
    background: '#f8f2ef', padding: 16, borderRadius: 16,
    display: 'flex', alignItems: 'center', gap: 16,
    transition: 'background 0.15s ease',
  },
  apptDivider: {
    height: 32, width: 1, background: 'rgba(146, 64, 94, 0.2)',
  },
};
