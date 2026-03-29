import { useState, useEffect } from 'react';
import { useBeautician, isDevMode } from '../lib/supabase.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';

/**
 * Notifications Centre — Real-time feed of everything happening.
 *
 * Categories:
 *   Bookings  — confirmed, cancelled, rescheduled, no-shows
 *   Payments  — received, refunds, deposits
 *   AI        — florrie.ai escalations, auto-reply confirmations
 *   Clients   — new sign-ups, review left, rebook due
 *   System    — updates, reminders, subscription alerts
 *
 * Two views:
 *   All  — full feed, newest first
 *   Filter by category
 */

const CATEGORIES = {
  booking: { label: 'Bookings', icon: '📅', color: '#E3F2FD', textColor: '#1565C0' },
  payment: { label: 'Payments', icon: '💷', color: 'var(--success-bg, #E8F5E9)', textColor: '#2E7D32' },
  ai: { label: 'florrie.ai', icon: '✨', color: 'var(--accent-light, #FFF0F3)', textColor: 'var(--accent, #C76B8A)' },
  client: { label: 'Clients', icon: '👤', color: '#FFF3E0', textColor: '#E65100' },
  system: { label: 'System', icon: '⚙️', color: 'var(--bg-hover, #F5F2EF)', textColor: '#5A5550' },
};

const DEV_NOTIFICATIONS = [
  {
    id: 'n1', category: 'booking', type: 'booking_confirmed',
    title: 'Booking confirmed',
    body: 'Shauna booked Lamination & Hybrid Dye for Thu 27 Mar at 11:00',
    time: new Date(Date.now() - 12 * 60000).toISOString(), read: false, actionUrl: '/calendar',
  },
  {
    id: 'n2', category: 'ai', type: 'auto_reply',
    title: 'florrie.ai replied for you',
    body: "Sent Daisy a rebook confirmation for Tuesday. Message: \"Hey lovely, you're all booked in for Tue at 2pm xx\"",
    time: new Date(Date.now() - 45 * 60000).toISOString(), read: false, actionUrl: '/voice',
  },
  {
    id: 'n3', category: 'payment', type: 'payment_received',
    title: 'Payment received',
    body: '£45.00 from Shauna — Lamination & Hybrid Dye',
    time: new Date(Date.now() - 2 * 3600000).toISOString(), read: false, actionUrl: '/money',
  },
  {
    id: 'n4', category: 'client', type: 'review_left',
    title: 'New review!',
    body: 'Jasmin left a 5★ review: "Absolutely love my brows every single time!"',
    time: new Date(Date.now() - 5 * 3600000).toISOString(), read: true, actionUrl: '/reviews',
  },
  {
    id: 'n5', category: 'ai', type: 'escalation',
    title: 'florrie.ai needs your input',
    body: "Megan asked about availability for a treatment you don't offer. florrie.ai wasn't sure how to reply.",
    time: new Date(Date.now() - 6 * 3600000).toISOString(), read: true, actionUrl: '/escalations',
  },
  {
    id: 'n6', category: 'booking', type: 'booking_cancelled',
    title: 'Booking cancelled',
    body: 'Chloe cancelled her HD Brows appointment for Fri 28 Mar at 14:00. Slot is now open.',
    time: new Date(Date.now() - 8 * 3600000).toISOString(), read: true, actionUrl: '/calendar',
  },
  {
    id: 'n7', category: 'payment', type: 'deposit_received',
    title: 'Deposit received',
    body: '£10.00 deposit from Emma for Ombre Brows on Sat 29 Mar',
    time: new Date(Date.now() - 10 * 3600000).toISOString(), read: true, actionUrl: '/money',
  },
  {
    id: 'n8', category: 'client', type: 'rebook_due',
    title: 'Rebook reminder',
    body: "Daisy S is 12 days overdue for her usual Lamination & Tint. Send a nudge?",
    time: new Date(Date.now() - 24 * 3600000).toISOString(), read: true, actionUrl: '/clients',
  },
  {
    id: 'n9', category: 'system', type: 'weekly_digest',
    title: 'Your weekly digest is ready',
    body: 'Last week: £385 revenue, 9 appointments, 0 no-shows. Nice one!',
    time: new Date(Date.now() - 48 * 3600000).toISOString(), read: true, actionUrl: '/digest',
  },
  {
    id: 'n10', category: 'booking', type: 'no_show',
    title: 'No-show detected',
    body: 'Sarah didn\'t turn up for her 3pm Lash Lift & Tint. No-show fee of £10 has been charged.',
    time: new Date(Date.now() - 72 * 3600000).toISOString(), read: true, actionUrl: '/calendar',
  },
];

function timeAgo(isoString) {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  return `${days}d ago`;
}

export default function Notifications() {
  const { beautician } = useBeautician();
  const [notifications, setNotifications] = useState([]);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadData(); }, [beautician]);

  async function loadData() {
    setLoading(true);
    if (isDevMode) {
      setNotifications(DEV_NOTIFICATIONS);
      setLoading(false);
      return;
    }
    setLoading(false);
  }

  function markRead(id) {
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
  }

  function markAllRead() {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
  }

  const filtered = filter === 'all' ? notifications : notifications.filter(n => n.category === filter);
  const unreadCount = notifications.filter(n => !n.read).length;

  // Group by date
  const groups = {};
  filtered.forEach(n => {
    const date = new Date(n.time);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);

    let label;
    if (date.toDateString() === today.toDateString()) label = 'Today';
    else if (date.toDateString() === yesterday.toDateString()) label = 'Yesterday';
    else label = date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

    if (!groups[label]) groups[label] = [];
    groups[label].push(n);
  });

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>Notifications</h1>
          <p style={styles.subtitle}>
            {unreadCount > 0 ? `${unreadCount} unread` : 'All caught up'}
          </p>
        </div>
        {unreadCount > 0 && (
          <button onClick={markAllRead} style={styles.markAllBtn}>Mark all read</button>
        )}
      </div>

      {/* Category filter */}
      <div style={styles.filterRow}>
        <button
          onClick={() => setFilter('all')}
          style={{
            ...styles.filterChip,
            background: filter === 'all' ? 'var(--text-primary, #2D2A26)' : '#fff',
            color: filter === 'all' ? '#fff' : '#5A5550',
          }}
        >
          All
        </button>
        {Object.entries(CATEGORIES).map(([key, cat]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            style={{
              ...styles.filterChip,
              background: filter === key ? cat.color : '#fff',
              color: filter === key ? cat.textColor : '#5A5550',
              borderColor: filter === key ? cat.textColor : 'var(--border, var(--border, #EDE9E4))',
            }}
          >
            {cat.icon} {cat.label}
          </button>
        ))}
      </div>

      {/* Notification feed */}
      {loading ? (
        <PageLoader />
      ) : filtered.length === 0 ? (
        <EmptyState title="No notifications" description="You're all caught up. New activity will show here." />
      ) : (
        <div style={styles.feed}>
          {Object.entries(groups).map(([label, items]) => (
            <div key={label}>
              <div style={styles.dateLabel}>{label}</div>
              {items.map(n => {
                const cat = CATEGORIES[n.category];
                return (
                  <div
                    key={n.id}
                    style={{
                      ...styles.notifCard,
                      background: n.read ? '#fff' : '#FFFBF9',
                      borderLeft: n.read ? '3px solid transparent' : `3px solid ${cat.textColor}`,
                    }}
                    onClick={() => markRead(n.id)}
                  >
                    <div style={{ ...styles.notifIcon, background: cat.color }}>
                      <span style={{ fontSize: 14 }}>{cat.icon}</span>
                    </div>
                    <div style={styles.notifBody}>
                      <div style={styles.notifHeaderRow}>
                        <span style={{
                          ...styles.notifTitle,
                          fontWeight: n.read ? 500 : 700,
                        }}>
                          {n.title}
                        </span>
                        <span style={styles.notifTime}>{timeAgo(n.time)}</span>
                      </div>
                      <p style={styles.notifText}>{n.body}</p>
                    </div>
                    {!n.read && <div style={styles.unreadDot} />}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh', background: 'var(--bg, #FAF8F5)',
    fontFamily: '"DM Sans", -apple-system, sans-serif',
    padding: '0 16px 40px', maxWidth: 480, margin: '0 auto', color: 'var(--text-primary, #2D2A26)',
  },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    paddingTop: 28, paddingBottom: 8,
  },
  title: { fontSize: 22, fontWeight: 700, margin: '0 0 2px' },
  subtitle: { fontSize: 13, color: 'var(--accent, #C76B8A)', margin: 0, fontWeight: 500 },
  markAllBtn: {
    padding: '6px 14px', borderRadius: 8, border: 'none',
    background: 'var(--accent-light, #FFF0F3)', color: 'var(--accent, #C76B8A)', fontSize: 11, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },

  // Filters
  filterRow: {
    display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 12, marginBottom: 4,
    scrollbarWidth: 'none',
  },
  filterChip: {
    padding: '7px 12px', borderRadius: 8, border: '1.5px solid var(--border, var(--border, #EDE9E4))',
    fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
    whiteSpace: 'nowrap', flexShrink: 0,
  },

  // Feed
  feed: { display: 'flex', flexDirection: 'column', gap: 0 },
  dateLabel: {
    fontSize: 11, fontWeight: 600, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', textTransform: 'uppercase',
    letterSpacing: '0.04em', padding: '12px 0 6px',
  },
  notifCard: {
    display: 'flex', alignItems: 'flex-start', gap: 10,
    padding: '12px 10px', borderRadius: 12, marginBottom: 6,
    boxShadow: '0 1px 2px rgba(0,0,0,0.03)', cursor: 'pointer',
    position: 'relative', transition: 'background 0.2s',
  },
  notifIcon: {
    width: 32, height: 32, borderRadius: 8,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  notifBody: { flex: 1, minWidth: 0 },
  notifHeaderRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 },
  notifTitle: { fontSize: 13, color: 'var(--text-primary, #2D2A26)' },
  notifTime: { fontSize: 10, color: 'var(--text-muted, #B5AFA8)', flexShrink: 0, marginLeft: 8 },
  notifText: { fontSize: 12, color: '#8A8580', margin: 0, lineHeight: 1.4 },
  unreadDot: {
    width: 8, height: 8, borderRadius: 4, background: 'var(--accent, #C76B8A)',
    position: 'absolute', top: 14, right: 10, flexShrink: 0,
  },

  // Empty
  loadingText: { textAlign: 'center', color: 'var(--text-muted, var(--text-muted, #B5AFA8))', padding: 40, fontSize: 14 },
  emptyState: { textAlign: 'center', padding: '40px 20px' },
  emptyTitle: { fontSize: 16, fontWeight: 600, margin: '0 0 4px', color: 'var(--text-primary, #2D2A26)' },
  emptyDesc: { fontSize: 13, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', margin: 0, lineHeight: 1.5 },
};
