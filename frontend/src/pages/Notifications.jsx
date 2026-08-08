import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBeautician, fetchRows, updateRow, supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Icon, { iconName } from '../components/ui/Icon';

/**
 * Notifications Centre - Real-time feed of everything happening.
 *
 * Categories:
 *   Bookings  - confirmed, cancelled, rescheduled, no-shows
 *   Payments  - received, refunds, deposits
 *   AI        - florrie.ai escalations, auto-reply confirmations
 *   Clients   - new sign-ups, review left, rebook due
 *   System    - updates, reminders, subscription alerts
 *
 * Two views:
 *   All  - full feed, newest first
 *   Filter by category
 */

const CATEGORIES = {
  booking: { label: 'Bookings', icon: 'calendar', color: '#E3F2FD', textColor: '#1565C0' },
  payment: { label: 'Payments', icon: 'pound', color: 'var(--success-bg, #E9F0EB)', textColor: '#2E7D32' },
  ai: { label: 'florrie.ai', icon: 'sparkles', color: 'var(--accent-light, #F6E7EC)', textColor: 'var(--accent, #92405e)' },
  client: { label: 'Clients', icon: 'user', color: '#FFF3E0', textColor: '#B33F00' },
  system: { label: 'System', icon: 'settings', color: 'var(--bg-hover, var(--bg-subtle, #ede7e3))', textColor: '#5A5550' },
};

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
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState([]);
  const [approvals, setApprovals] = useState(null); // { count, name, snippet } | null
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadData(); loadApprovals(); }, [beautician]);

  // Live "waiting on your OK" flag. Pulls the same two sources as the outbox so
  // notifications, the home card, and the outbox always agree.
  async function loadApprovals() {
    try {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      if (!token) return;
      const h = { Authorization: `Bearer ${token}` };
      const [pendRes, escRes] = await Promise.all([
        fetch(`${API_BASE}/api/outbound/pending`, { headers: h }).catch(() => null),
        fetch(`${API_BASE}/api/escalations`, { headers: h }).catch(() => null),
      ]);
      let items = [];
      if (pendRes && pendRes.ok) {
        const d = await pendRes.json();
        for (const r of (d.pending || [])) {
          items.push({ name: (r.clients?.first_name || '').trim() || 'A client', snippet: r.body || '', at: r.created_at });
        }
      }
      if (escRes && escRes.ok) {
        const d = await escRes.json();
        for (const r of (d.escalations || [])) {
          if (!r.ai_response || !String(r.ai_response).trim()) continue;
          items.push({ name: (r.clients?.first_name || '').trim() || 'A client', snippet: r.ai_response || '', at: r.created_at });
        }
      }
      if (items.length === 0) { setApprovals({ count: 0 }); return; }
      items.sort((a, b) => new Date(b.at) - new Date(a.at));
      const top = items[0];
      const flat = String(top.snippet).replace(/\s+/g, ' ').trim();
      const snippet = flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
      setApprovals({ count: items.length, name: top.name, snippet });
    } catch {
      setApprovals({ count: 0 });
    }
  }

  async function loadData() {
    setLoading(true);
    try {
      const rows = await fetchRows('notifications', beautician?.id, {
        order: 'created_at',
        ascending: false,
        limit: 100,
      });
      setNotifications((rows || []).map(r => ({
        id: r.id,
        category: r.category,
        type: r.type,
        title: r.title,
        body: r.body,
        time: r.created_at,
        read: r.read,
        actionUrl: r.action_url,
      })));
    } catch (err) {
      setNotifications([]);
    }
    setLoading(false);
  }

  async function markRead(id) {
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
    try { await updateRow('notifications', id, { read: true }); } catch (e) { /* silent */ }
  }

  async function markAllRead() {
    const unreadIds = notifications.filter(n => !n.read).map(n => n.id);
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    for (const uid of unreadIds) {
      try { await updateRow('notifications', uid, { read: true }); } catch (e) { /* silent */ }
    }
  }

  const filtered = filter === 'all' ? notifications : notifications.filter(n => n.category === filter);
  const unreadCount = notifications.filter(n => !n.read).length + (approvals?.count || 0);

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

      {/* Waiting on your OK , the one yes/no flag, links straight to the outbox */}
      {approvals?.count > 0 && (
        <button
          onClick={() => navigate('/outbox')}
          style={styles.approvalBanner}
          aria-label={`${approvals.count} messages waiting for your OK`}
        >
          <div style={styles.approvalIcon}>
            <Icon name={iconName('how_to_reg')} size={20} inline style={{ color: 'var(--accent, #92405e)' }} />
          </div>
          <div style={styles.approvalBody}>
            <span style={styles.approvalTitle}>
              {approvals.count} message{approvals.count === 1 ? '' : 's'} waiting for your OK
            </span>
            {approvals.snippet && (
              <span style={styles.approvalPreview}>
                <span style={{ fontWeight: 600, color: 'var(--accent, #92405e)' }}>{approvals.name}:</span> {approvals.snippet}
              </span>
            )}
          </div>
          <Icon name={iconName('chevron_right')} inline style={styles.approvalChev} />
        </button>
      )}

      {/* Category filter */}
      <div style={styles.filterRow}>
        <button
          onClick={() => setFilter('all')}
          style={{ ...styles.filterChip,
            background: filter === 'all' ? 'var(--text-primary, #241B17)' : 'var(--bg-card, #FFFCF9)',
            color: filter === 'all' ? 'var(--bg-card, #FFFCF9)' : '#5A5550',
          }}
        >
          All
        </button>
        {Object.entries(CATEGORIES).map(([key, cat]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            style={{ ...styles.filterChip,
              background: filter === key ? cat.color : 'var(--bg-card, #FFFCF9)',
              color: filter === key ? cat.textColor : '#5A5550',
              borderColor: filter === key ? cat.textColor : 'var(--border, var(--border, var(--border, #E8DDD4)))',
            }}
          >
            <Icon name={iconName(cat.icon)} inline /> {cat.label}
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
                const cat = CATEGORIES[n.category] || CATEGORIES.system;
                return (
                  <div
                    key={n.id}
                    style={{ ...styles.notifCard,
                      background: n.read ? 'var(--bg-card, #FFFCF9)' : '#FFFBF9',
                      borderLeft: n.read ? '3px solid transparent' : `3px solid ${cat.textColor}`,
                    }}
                    onClick={() => markRead(n.id)}
                  >
                    <div style={{ ...styles.notifIcon, background: cat.color }}>
                      <span style={{ fontSize: 14 }}><Icon name={iconName(cat.icon)} inline /></span>
                    </div>
                    <div style={styles.notifBody}>
                      <div style={styles.notifHeaderRow}>
                        <span style={{ ...styles.notifTitle,
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
    minHeight: 'var(--shell-viewport)', background: 'var(--bg, var(--bg, #FBF6F1))',
    fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif",
    padding: '0 16px var(--scroll-pad-bottom)', maxWidth: 480, margin: '0 auto', color: 'var(--text-primary, #241B17)',
  },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    paddingTop: 28, paddingBottom: 8,
  },
  title: { fontSize: 22, fontWeight: 700, margin: '0 0 2px' },
  subtitle: { fontSize: 13, color: 'var(--accent, #92405e)', margin: 0, fontWeight: 500 },
  markAllBtn: {
    padding: '6px 14px', borderRadius: 10, border: 'none',
    background: 'var(--accent-light, #F6E7EC)', color: 'var(--accent, #92405e)', fontSize: 11, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },

  // Waiting-on-your-OK banner
  approvalBanner: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 11,
    background: 'var(--bg-card, #FFFCF9)',
    border: '1px solid rgba(146,64,94,0.14)',
    borderRadius: 16,
    padding: '12px 12px',
    margin: '4px 0 12px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
    boxShadow: 'var(--elev-2)',
    boxSizing: 'border-box',
  },
  approvalIcon: {
    width: 36, height: 36, borderRadius: 10,
    background: 'var(--accent-light, #F6E7EC)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  approvalBody: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
  approvalTitle: { fontSize: 13, fontWeight: 700, color: 'var(--text-primary, #241B17)', lineHeight: 1.25 },
  approvalPreview: {
    fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.3,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  approvalChev: { fontSize: 20, color: 'var(--text-muted, #6B5D54)', flexShrink: 0 },

  // Filters
  filterRow: {
    display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 12, marginBottom: 4,
    scrollbarWidth: 'none',
  },
  filterChip: {
    padding: '7px 12px', borderRadius: 10, border: '1.5px solid var(--border, var(--border, var(--border, #E8DDD4)))',
    fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
    whiteSpace: 'nowrap', flexShrink: 0,
  },

  // Feed
  feed: { display: 'flex', flexDirection: 'column', gap: 0 },
  dateLabel: {
    fontSize: 11, fontWeight: 600, color: 'var(--text-muted, var(--text-muted, #6B5D54))', textTransform: 'uppercase',
    letterSpacing: '0.04em', padding: '12px 0 6px',
  },
  notifCard: {
    display: 'flex', alignItems: 'flex-start', gap: 10,
    padding: '12px 10px', borderRadius: 10, marginBottom: 6,
    boxShadow: 'var(--elev-1)', cursor: 'pointer',
    position: 'relative', transition: 'background 0.2s',
  },
  notifIcon: {
    width: 32, height: 32, borderRadius: 10,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  notifBody: { flex: 1, minWidth: 0 },
  notifHeaderRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 },
  notifTitle: { fontSize: 13, color: 'var(--text-primary, #241B17)' },
  notifTime: { fontSize: 10, color: 'var(--text-muted, #6B5D54)', flexShrink: 0, marginLeft: 8 },
  notifText: { fontSize: 12, color: 'var(--text-muted)', margin: 0, lineHeight: 1.4 },
  unreadDot: {
    width: 8, height: 8, borderRadius: 6, background: 'var(--accent, #92405e)',
    position: 'absolute', top: 14, right: 10, flexShrink: 0,
  },

  // Empty
  loadingText: { textAlign: 'center', color: 'var(--text-muted, var(--text-muted, #6B5D54))', padding: 40, fontSize: 14 },
  emptyState: { textAlign: 'center', padding: '40px 20px' },
  emptyTitle: { fontSize: 16, fontWeight: 600, margin: '0 0 4px', color: 'var(--text-primary, #241B17)' },
  emptyDesc: { fontSize: 13, color: 'var(--text-muted, var(--text-muted, #6B5D54))', margin: 0, lineHeight: 1.5 },
};
