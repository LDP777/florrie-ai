import { useState, useEffect } from 'react';
import { useBeautician, fetchRows, isDevMode, supabase } from '../lib/supabase.js';

const CHANNELS = ['all', 'whatsapp', 'sms', 'email', 'in_app'];
const CHANNEL_ICONS = { whatsapp: '💬', sms: '📱', email: '📧', in_app: '🔔' };
const CHANNEL_COLORS = { whatsapp: '#25D366', sms: '#2196F3', email: '#E8A838', in_app: '#C76B8A' };

const DEV_MESSAGES = [
  { id: 1, client: 'Jessica R.', channel: 'whatsapp', direction: 'outbound', type: 'reminder', subject: 'Appointment reminder — Brow Lamination tomorrow at 10:30am', time: '2026-03-26 09:00', status: 'delivered', read: true },
  { id: 2, client: 'Jessica R.', channel: 'whatsapp', direction: 'inbound', type: 'reply', subject: 'Thanks! See you then 💕', time: '2026-03-26 09:12', status: 'received', read: true },
  { id: 3, client: 'Amy K.', channel: 'sms', direction: 'outbound', type: 'reminder', subject: 'Hi Amy, quick reminder — your brow tint is booked for Thursday 2pm', time: '2026-03-25 18:00', status: 'delivered', read: false },
  { id: 4, client: 'Charlotte B.', channel: 'email', direction: 'outbound', type: 'aftercare', subject: 'Your Lash Lift Aftercare Guide', time: '2026-03-25 15:30', status: 'opened', read: true },
  { id: 5, client: 'Emma L.', channel: 'whatsapp', direction: 'outbound', type: 'campaign', subject: '🌸 Spring Special — 20% off brow packages this week only!', time: '2026-03-25 10:00', status: 'delivered', read: true },
  { id: 6, client: 'Emma L.', channel: 'whatsapp', direction: 'inbound', type: 'reply', subject: 'Ooh yes please! Can I book for Saturday?', time: '2026-03-25 10:45', status: 'received', read: true },
  { id: 7, client: 'Sophie T.', channel: 'email', direction: 'outbound', type: 'rebook', subject: 'We miss you! Time for a brow refresh?', time: '2026-03-24 12:00', status: 'opened', read: true },
  { id: 8, client: 'Megan W.', channel: 'sms', direction: 'outbound', type: 'reminder', subject: 'Megan, your VIP treatment is confirmed for Friday at 11am. See you soon!', time: '2026-03-24 09:00', status: 'delivered', read: false },
  { id: 9, client: 'Hannah D.', channel: 'in_app', direction: 'outbound', type: 'notification', subject: 'Your membership has been paused. Resume anytime from the app.', time: '2026-03-23 14:00', status: 'sent', read: false },
  { id: 10, client: 'Charlotte B.', channel: 'whatsapp', direction: 'outbound', type: 'review_request', subject: 'Hi Charlotte! Loved doing your lashes today. Would you mind leaving a quick review? 🙏', time: '2026-03-23 16:30', status: 'delivered', read: true },
  { id: 11, client: 'Charlotte B.', channel: 'whatsapp', direction: 'inbound', type: 'reply', subject: 'Of course! Just left you 5 stars ⭐', time: '2026-03-23 17:15', status: 'received', read: true },
  { id: 12, client: 'Amy K.', channel: 'email', direction: 'outbound', type: 'campaign', subject: 'New Season, New Brows — Spring Collection Preview', time: '2026-03-22 10:00', status: 'bounced', read: false },
];

const STATUS_STYLES = {
  delivered: { bg: '#E8F5E9', color: '#2E7D32', label: 'Delivered' },
  opened: { bg: '#E3F2FD', color: '#1565C0', label: 'Opened' },
  sent: { bg: '#FFF3E0', color: '#E65100', label: 'Sent' },
  received: { bg: '#F3E5F5', color: '#7B1FA2', label: 'Received' },
  failed: { bg: '#FFEBEE', color: '#C62828', label: 'Failed' },
  bounced: { bg: '#FFEBEE', color: '#C62828', label: 'Bounced' },
};

const TYPE_LABELS = {
  reminder: 'Reminder', aftercare: 'Aftercare', campaign: 'Campaign', rebook: 'Rebook',
  review_request: 'Review Ask', notification: 'Notification', reply: 'Reply',
};

function timeAgo(dateStr) {
  const now = new Date('2026-03-26T12:00:00');
  const d = new Date(dateStr);
  const mins = Math.floor((now - d) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export default function CommsLog() {
  const [channel, setChannel] = useState('all');
  const [search, setSearch] = useState('');
  const [expandedMsg, setExpandedMsg] = useState(null);
  const [showStats, setShowStats] = useState(false);
  const { beautician, loading: bLoading } = useBeautician();
  const [messages, setMessages] = useState([]);

  useEffect(() => {
    if (bLoading) return;
    if (isDevMode || !beautician) { setMessages(DEV_MESSAGES); return; }
    fetchRows('messages', beautician.id, { order: 'created_at', ascending: false, limit: 50 })
      .then(rows => setMessages(rows.length ? rows : DEV_MESSAGES));
  }, [beautician, bLoading]);

  if (bLoading) return <div style={{ padding: 40, textAlign: 'center', color: '#AAA5A0' }}>Loading...</div>;

  const filtered = messages.filter(m => {
    if (channel !== 'all' && m.channel !== channel) return false;
    if (search && !m.client.toLowerCase().includes(search.toLowerCase()) && !m.subject.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const stats = {
    total: messages.length,
    outbound: messages.filter(m => m.direction === 'outbound').length,
    inbound: messages.filter(m => m.direction === 'inbound').length,
    delivered: messages.filter(m => m.status === 'delivered').length,
    opened: messages.filter(m => m.status === 'opened').length,
    bounced: messages.filter(m => m.status === 'bounced' || m.status === 'failed').length,
    byChannel: Object.fromEntries(CHANNELS.filter(c => c !== 'all').map(c => [c, messages.filter(m => m.channel === c).length])),
  };

  const deliveryRate = stats.outbound > 0 ? Math.round(((stats.delivered + stats.opened) / stats.outbound) * 100) : 0;

  return (
    <div style={s.page}>
      <div style={s.header}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h1 style={s.title}>Comms Log</h1>
            <p style={s.subtitle}>Every message sent and received</p>
          </div>
          <button onClick={() => setShowStats(!showStats)} style={s.statsToggle}>
            {showStats ? 'Hide Stats' : '📊 Stats'}
          </button>
        </div>
      </div>

      {/* Stats panel */}
      {showStats && (
        <div style={s.statsPanel}>
          <div style={s.statsGrid}>
            <div style={s.statCard}>
              <span style={{ fontSize: 20, fontWeight: 700, color: 'var(--text, #2D2A26)' }}>{stats.total}</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted, #AAA5A0)' }}>Total</span>
            </div>
            <div style={s.statCard}>
              <span style={{ fontSize: 20, fontWeight: 700, color: '#C76B8A' }}>{stats.outbound}</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted, #AAA5A0)' }}>Sent</span>
            </div>
            <div style={s.statCard}>
              <span style={{ fontSize: 20, fontWeight: 700, color: '#7B1FA2' }}>{stats.inbound}</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted, #AAA5A0)' }}>Replies</span>
            </div>
            <div style={s.statCard}>
              <span style={{ fontSize: 20, fontWeight: 700, color: deliveryRate >= 90 ? '#4CAF50' : '#E8A838' }}>{deliveryRate}%</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted, #AAA5A0)' }}>Delivery</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 10 }}>
            {CHANNELS.filter(c => c !== 'all').map(c => (
              <div key={c} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text-muted, #AAA5A0)' }}>
                <span>{CHANNEL_ICONS[c]}</span>
                <span style={{ fontWeight: 600, color: CHANNEL_COLORS[c] }}>{stats.byChannel[c]}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Search */}
      <input
        type="text"
        placeholder="Search by client or message..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={s.search}
      />

      {/* Channel filter */}
      <div style={s.channelRow}>
        {CHANNELS.map(c => (
          <button key={c} onClick={() => setChannel(c)} style={{ ...s.channelChip, ...(channel === c ? { background: c === 'all' ? '#C76B8A' : CHANNEL_COLORS[c], color: '#fff', borderColor: c === 'all' ? '#C76B8A' : CHANNEL_COLORS[c] } : {}) }}>
            {c === 'all' ? 'All' : CHANNEL_ICONS[c]} {c !== 'all' ? c.replace('_', ' ') : ''}
          </button>
        ))}
      </div>

      {/* Message list */}
      <div style={s.msgList}>
        {filtered.length === 0 && (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted, #AAA5A0)', fontSize: 13 }}>No messages found</div>
        )}
        {filtered.map(msg => {
          const statusStyle = STATUS_STYLES[msg.status] || STATUS_STYLES.sent;
          const expanded = expandedMsg === msg.id;
          const isInbound = msg.direction === 'inbound';
          return (
            <button key={msg.id} onClick={() => setExpandedMsg(expanded ? null : msg.id)} style={s.msgCard}>
              <div style={s.msgTop}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
                  <span style={{ ...s.channelDot, background: CHANNEL_COLORS[msg.channel] }}>{CHANNEL_ICONS[msg.channel]}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text, #2D2A26)' }}>{msg.client}</span>
                      <span style={{ fontSize: 10, color: isInbound ? '#7B1FA2' : '#C76B8A' }}>{isInbound ? '← in' : '→ out'}</span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted, #AAA5A0)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {msg.subject}
                    </div>
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted, #AAA5A0)' }}>{timeAgo(msg.time)}</div>
                  <span style={{ ...s.statusBadge, background: statusStyle.bg, color: statusStyle.color }}>{statusStyle.label}</span>
                </div>
              </div>
              {expanded && (
                <div style={{ marginTop: 10, borderTop: '1px solid var(--card-border, #F0ECE8)', paddingTop: 10 }}>
                  <div style={{ fontSize: 13, color: 'var(--text, #2D2A26)', lineHeight: 1.5, marginBottom: 8 }}>{msg.subject}</div>
                  <div style={{ display: 'flex', gap: 12, fontSize: 12, color: 'var(--text-muted, #AAA5A0)', flexWrap: 'wrap' }}>
                    <span>📅 {msg.time}</span>
                    <span>📂 {TYPE_LABELS[msg.type] || msg.type}</span>
                    <span>{CHANNEL_ICONS[msg.channel]} {msg.channel.replace('_', ' ')}</span>
                  </div>
                  {!isInbound && (
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      <button style={s.actionBtn}>Resend</button>
                      <button style={s.actionBtn}>View Thread</button>
                    </div>
                  )}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const s = {
  page: { padding: '20px 16px 40px', fontFamily: '"DM Sans", -apple-system, sans-serif', maxWidth: 480, margin: '0 auto' },
  header: { marginBottom: 12 },
  title: { fontSize: 22, fontWeight: 700, margin: 0, color: 'var(--text, #2D2A26)' },
  subtitle: { fontSize: 13, color: 'var(--text-muted, #AAA5A0)', margin: '4px 0 0' },
  statsToggle: { background: 'none', border: '1px solid var(--card-border, #F0ECE8)', borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', color: '#C76B8A', fontFamily: 'inherit' },
  statsPanel: { padding: 14, borderRadius: 12, background: 'var(--card-bg, #fff)', border: '1px solid var(--card-border, #F0ECE8)', marginBottom: 12 },
  statsGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8 },
  statCard: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  search: { width: '100%', padding: '10px 14px', borderRadius: 10, border: '1px solid var(--card-border, #F0ECE8)', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box', marginBottom: 10, background: 'var(--card-bg, #fff)', color: 'var(--text, #2D2A26)' },
  channelRow: { display: 'flex', gap: 6, marginBottom: 14, overflowX: 'auto' },
  channelChip: { padding: '6px 12px', borderRadius: 20, border: '1px solid var(--card-border, #F0ECE8)', background: 'none', fontSize: 11, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap', color: 'var(--text, #2D2A26)', fontFamily: 'inherit', textTransform: 'capitalize' },
  msgList: { display: 'flex', flexDirection: 'column', gap: 8 },
  msgCard: { padding: '12px 12px', borderRadius: 12, background: 'var(--card-bg, #fff)', border: '1px solid var(--card-border, #F0ECE8)', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', width: '100%' },
  msgTop: { display: 'flex', alignItems: 'flex-start', gap: 8 },
  channelDot: { width: 32, height: 32, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0 },
  statusBadge: { display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 600, marginTop: 4 },
  actionBtn: { background: 'none', border: '1px solid var(--card-border, #F0ECE8)', borderRadius: 6, padding: '6px 12px', fontSize: 12, fontWeight: 500, cursor: 'pointer', color: '#C76B8A', fontFamily: 'inherit' },
};
