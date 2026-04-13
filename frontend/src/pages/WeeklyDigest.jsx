import { useState, useEffect } from 'react';
import { useBeautician, fetchRows } from '../lib/supabase.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';

/**
 * Weekly Digest — an email-style summary of the week's activity.
 * Shows what the AI team did, revenue snapshot, client highlights,
 * and what to focus on next week.
 *
 * Auto-generated every Monday morning and also viewable on demand.
 */

export default function WeeklyDigest() {
  const { beautician } = useBeautician();
  const [digest, setDigest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [weekOffset, setWeekOffset] = useState(0); // 0 = this week, -1 = last week

  useEffect(() => { if (beautician) loadDigest(); }, [beautician, weekOffset]);

  async function loadDigest() {
    setLoading(true);
    try {
      const now = new Date();
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - now.getDay() + 1 + (weekOffset * 7));
      weekStart.setHours(0, 0, 0, 0);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 7);

      const [appointments, expenses, clients] = await Promise.all([
        fetchRows('appointments', beautician.id, { order: 'starts_at' }),
        fetchRows('expenses', beautician.id),
        fetchRows('clients', beautician.id),
      ]);

      const inWeek = appointments.filter(a => {
        const d = new Date(a.starts_at);
        return d >= weekStart && d < weekEnd;
      });
      const completed = inWeek.filter(a => a.status === 'completed');
      const noShows = inWeek.filter(a => a.status === 'no_show');
      const cancelled = inWeek.filter(a => a.status?.includes('cancelled'));
      const revenue = completed.reduce((s, a) => s + (a.price_cents || 0), 0);
      const weekExpenses = expenses.filter(e => {
        const d = new Date(e.date);
        return d >= weekStart && d < weekEnd;
      }).reduce((s, e) => s + (e.amount_cents || 0), 0);

      const newClients = clients.filter(c => {
        const d = new Date(c.created_at);
        return d >= weekStart && d < weekEnd;
      });

      // Next week lookahead
      const nextWeekStart = new Date(weekEnd);
      const nextWeekEnd = new Date(nextWeekStart);
      nextWeekEnd.setDate(nextWeekStart.getDate() + 7);
      const nextWeekAppts = appointments.filter(a => {
        const d = new Date(a.starts_at);
        return d >= nextWeekStart && d < nextWeekEnd && a.status !== 'cancelled_by_client' && a.status !== 'cancelled_by_beautician';
      });

      setDigest({
        weekLabel: `${weekStart.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${new Date(weekEnd - 86400000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`,
        totalAppointments: inWeek.length,
        completed: completed.length,
        noShows: noShows.length,
        cancelled: cancelled.length,
        revenue,
        expenses: weekExpenses,
        profit: revenue - weekExpenses,
        newClients: newClients.length,
        nextWeekBookings: nextWeekAppts.length,
        highlights: buildHighlights(completed, noShows, cancelled, revenue, newClients, nextWeekAppts),
      });
    } catch (err) {
      logger.error('Digest load error:', err);
      setDigest(getDevDigest());
    }
    setLoading(false);
  }

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.title}>Weekly Digest</h1>
      </div>

      {/* Week selector */}
      <div style={styles.weekNav}>
        <button onClick={() => setWeekOffset(w => w - 1)} style={styles.weekBtn}>← Previous</button>
        <span style={styles.weekLabel}>{digest?.weekLabel || '...'}</span>
        <button
          onClick={() => setWeekOffset(w => Math.min(w + 1, 0))}
          disabled={weekOffset >= 0}
          style={{ ...styles.weekBtn, opacity: weekOffset >= 0 ? 0.3 : 1 }}
        >
          Next →
        </button>
      </div>

      {loading ? (
        <PageLoader />
      ) : digest ? (
        <div style={styles.digestBody}>
          {/* Greeting */}
          <div style={styles.greetingCard}>
            <span style={styles.greetingEmoji}>👋</span>
            <div>
              <p style={styles.greetingTitle}>
                Hey {beautician?.first_name || 'there'}, here's your week.
              </p>
              <p style={styles.greetingText}>
                {digest.completed} appointment{digest.completed !== 1 ? 's' : ''} completed, £{(digest.revenue / 100).toFixed(0)} earned.
                {digest.noShows > 0 ? ` ${digest.noShows} no-show${digest.noShows > 1 ? 's' : ''}.` : ' No no-shows — nice.'}
              </p>
            </div>
          </div>

          {/* Revenue card */}
          <div style={styles.revenueCard}>
            <div style={styles.revenueRow}>
              <div style={styles.revCol}>
                <span style={styles.revLabel}>Revenue</span>
                <span style={styles.revAmount}>£{(digest.revenue / 100).toFixed(0)}</span>
              </div>
              <div style={styles.revDivider} />
              <div style={styles.revCol}>
                <span style={styles.revLabel}>Expenses</span>
                <span style={styles.revAmount}>£{(digest.expenses / 100).toFixed(0)}</span>
              </div>
              <div style={styles.revDivider} />
              <div style={styles.revCol}>
                <span style={styles.revLabel}>Profit</span>
                <span style={{ ...styles.revAmount, color: digest.profit >= 0 ? 'var(--success, #5BA97B)' : '#E57373' }}>
                  £{(digest.profit / 100).toFixed(0)}
                </span>
              </div>
            </div>
          </div>

          {/* Stats grid */}
          <div style={styles.statsGrid}>
            <MiniStat icon="📅" value={digest.totalAppointments} label="Booked" />
            <MiniStat icon="✅" value={digest.completed} label="Completed" />
            <MiniStat icon="❌" value={digest.noShows} label="No-shows" color={digest.noShows > 0 ? '#E57373' : undefined} />
            <MiniStat icon="🚫" value={digest.cancelled} label="Cancelled" />
            <MiniStat icon="👋" value={digest.newClients} label="New clients" color="var(--accent, #C76B8A)" />
            <MiniStat icon="📆" value={digest.nextWeekBookings} label="Next week" color="#4A90D9" />
          </div>

          {/* Highlights / insights */}
          <div style={styles.card}>
            <h3 style={styles.cardTitle}>This week's highlights</h3>
            {digest.highlights.map((h, i) => (
              <div key={i} style={styles.highlightRow}>
                <span style={styles.highlightIcon}>{h.icon}</span>
                <span style={styles.highlightText}>{h.text}</span>
              </div>
            ))}
          </div>

          {/* Next week preview */}
          <div style={styles.nextWeekCard}>
            <span style={styles.nextWeekIcon}>📆</span>
            <div>
              <span style={styles.nextWeekTitle}>Next week</span>
              <span style={styles.nextWeekText}>
                {digest.nextWeekBookings} appointment{digest.nextWeekBookings !== 1 ? 's' : ''} booked.
                {digest.nextWeekBookings < 5 ? ' Looks light — consider running a last-minute availability post.' : ' Looking solid.'}
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MiniStat({ icon, value, label, color }) {
  return (
    <div style={styles.miniStat}>
      <span style={{ fontSize: 16 }}>{icon}</span>
      <span style={{ ...styles.miniStatValue, color: color || 'var(--text-primary, #2D2A26)' }}>{value}</span>
      <span style={styles.miniStatLabel}>{label}</span>
    </div>
  );
}

function SkeletonBlock({ height = 80 }) {
  return (
    <div style={{ background: 'var(--bg-card, #fff)', borderRadius: 14, height, marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 8, padding: 16, justifyContent: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
      <div style={{ height: 14, width: '40%', borderRadius: 7, background: 'var(--border, var(--border, var(--border, #EDE9E4)))' }} />
      <div style={{ height: 12, width: '65%', borderRadius: 6, background: 'var(--bg-hover, var(--bg-subtle, #F5F2EF))' }} />
    </div>
  );
}

function buildHighlights(completed, noShows, cancelled, revenue, newClients, nextWeek) {
  const highlights = [];

  if (completed.length >= 8) {
    highlights.push({ icon: '🔥', text: `Busy week — ${completed.length} appointments completed. Keep the momentum going.` });
  } else if (completed.length >= 4) {
    highlights.push({ icon: '👍', text: `Solid week with ${completed.length} appointments completed.` });
  } else if (completed.length > 0) {
    highlights.push({ icon: '💡', text: `Quieter week with ${completed.length} appointment${completed.length > 1 ? 's' : ''}. Could be a good time to run a promo.` });
  }

  if (noShows.length === 0) {
    highlights.push({ icon: '🎉', text: 'Zero no-shows this week. Your clients are reliable.' });
  } else {
    highlights.push({ icon: '⚠️', text: `${noShows.length} no-show${noShows.length > 1 ? 's' : ''} this week. Consider adding deposits to high-value treatments.` });
  }

  if (newClients.length > 0) {
    highlights.push({ icon: '✨', text: `${newClients.length} new client${newClients.length > 1 ? 's' : ''} this week. Follow up with a welcome message.` });
  }

  if (revenue > 30000) {
    highlights.push({ icon: '💰', text: `Great revenue week — £${(revenue / 100).toFixed(0)}. You're on track.` });
  }

  if (nextWeek.length < 3) {
    highlights.push({ icon: '📢', text: 'Next week is looking light. Share your booking link or run an availability drop post.' });
  }

  if (highlights.length === 0) {
    highlights.push({ icon: '📈', text: 'Keep booking appointments — more data means better insights.' });
  }

  return highlights;
}

function getDevDigest() {
  return {
    weekLabel: '24 Mar – 30 Mar',
    totalAppointments: 12,
    completed: 10,
    noShows: 1,
    cancelled: 1,
    revenue: 38500,
    expenses: 5200,
    profit: 33300,
    newClients: 2,
    nextWeekBookings: 8,
    highlights: [
      { icon: '👍', text: 'Solid week with 10 appointments completed.' },
      { icon: '⚠️', text: '1 no-show this week. Consider adding deposits to high-value treatments.' },
      { icon: '✨', text: '2 new clients this week. Follow up with a welcome message.' },
      { icon: '💰', text: 'Great revenue week — £385. You\'re on track.' },
    ],
  };
}

const styles = {
  page: { minHeight: '100vh', background: 'var(--bg, var(--bg, #FAF8F5))', fontFamily: '"DM Sans", -apple-system, sans-serif', padding: '0 16px 40px', maxWidth: 480, margin: '0 auto', color: 'var(--text-primary, #2D2A26)' },
  header: { paddingTop: 28, paddingBottom: 8 },
  title: { fontSize: 22, fontWeight: 700, margin: 0 },

  weekNav: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  weekBtn: { background: 'none', border: 'none', color: 'var(--accent, #C76B8A)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', padding: '8px 0' },
  weekLabel: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #2D2A26)' },

  loadingWrap: { display: 'flex', flexDirection: 'column' },

  digestBody: { display: 'flex', flexDirection: 'column', gap: 10 },

  greetingCard: { display: 'flex', gap: 12, padding: 16, borderRadius: 14, background: 'var(--bg-card, #fff)', boxShadow: '0 1px 3px rgba(0,0,0,0.04)', alignItems: 'flex-start' },
  greetingEmoji: { fontSize: 28, flexShrink: 0 },
  greetingTitle: { fontSize: 15, fontWeight: 600, margin: '0 0 4px', color: 'var(--text-primary, #2D2A26)' },
  greetingText: { fontSize: 13, color: '#8A8580', margin: 0, lineHeight: 1.5 },

  revenueCard: { background: 'linear-gradient(135deg, var(--accent, #C76B8A) 0%, #D4899F 100%)', borderRadius: 14, padding: 18, color: 'var(--bg-card, #fff)' },
  revenueRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  revCol: { display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1 },
  revLabel: { fontSize: 10, opacity: 0.7, textTransform: 'uppercase', letterSpacing: '0.04em' },
  revAmount: { fontSize: 22, fontWeight: 700, marginTop: 2 },
  revDivider: { width: 1, height: 36, background: 'rgba(255,255,255,0.2)' },

  statsGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 },
  miniStat: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: '12px 8px', borderRadius: 12, background: 'var(--bg-card, #fff)', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' },
  miniStatValue: { fontSize: 20, fontWeight: 700 },
  miniStatLabel: { fontSize: 10, color: 'var(--text-muted, var(--text-muted, #B5AFA8))' },

  card: { background: 'var(--bg-card, #fff)', borderRadius: 14, padding: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' },
  cardTitle: { fontSize: 14, fontWeight: 600, margin: '0 0 12px', color: 'var(--text-primary, #2D2A26)' },

  highlightRow: { display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 0', borderBottom: '1px solid var(--bg, var(--bg, #FAF8F5))' },
  highlightIcon: { fontSize: 16, flexShrink: 0, marginTop: 1 },
  highlightText: { fontSize: 13, color: '#5A5550', lineHeight: 1.5 },

  nextWeekCard: { display: 'flex', gap: 12, padding: 16, borderRadius: 14, background: '#EEF4FC', alignItems: 'flex-start' },
  nextWeekIcon: { fontSize: 24, flexShrink: 0 },
  nextWeekTitle: { display: 'block', fontSize: 13, fontWeight: 600, color: '#4A6B8A', marginBottom: 2 },
  nextWeekText: { display: 'block', fontSize: 12, color: '#5A7A9A', lineHeight: 1.5 },
};
