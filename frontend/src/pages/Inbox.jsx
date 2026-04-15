/**
 * Inbox — Full client messaging hub replacing the basic Escalations view.
 *
 * Features:
 *   - Conversation list with unread indicators + last message preview
 *   - Thread view with chat bubbles (inbound/outbound)
 *   - AI draft suggestions for replies
 *   - Quick-reply chips (confirm, rebook, thanks)
 *   - Message compose with send button
 *   - Channel indicator (WhatsApp/SMS/Email)
 *
 * Dev-mode mock conversations from Ellie's typical DM patterns.
 */
import { useState, useRef, useEffect } from 'react';
import { useBeautician, supabase, fetchRows } from '../lib/supabase.js';
import { useTheme } from '../lib/theme.jsx';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';

const QUICK_REPLIES = [
  { key: 'confirm', label: 'Confirm', text: "That's booked in for you lovely! See you then xx" },
  { key: 'rebook', label: 'Rebook?', text: "Fancy getting booked in again? I've got some slots free this week xx" },
  { key: 'thanks', label: 'Thanks!', text: "You're so welcome lovely! xx" },
  { key: 'moved', label: 'Moved it', text: "No worries, I've moved that for you xx" },
];

const CHANNEL_ICONS = { whatsapp: '💬', sms: '📱', email: '✉️', instagram: '📸' };
const CHANNEL_FILTERS = ['all', 'whatsapp', 'sms', 'email', 'instagram'];

export default function Inbox() {
  const { dark } = useTheme();
  const { beautician, loading: bLoading } = useBeautician();
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [compose, setCompose] = useState('');
  const [showAiDraft, setShowAiDraft] = useState(true);
  const [channelFilter, setChannelFilter] = useState('all');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    if (beautician && !bLoading) loadConversations();
  }, [beautician, bLoading]);

  async function loadConversations() {
    setLoading(true);
    setError(null);
    try {
      const { data, error } = await supabase
        .from('messages')
        .select('*, clients(first_name, last_name)')
        .eq('beautician_id', beautician.id)
        .order('created_at', { ascending: true });

      if (error) {
        logger.error({ err: error }, 'Load conversations error');
        setError('Something went wrong');
        setConversations([]);
      } else {
        // Group ALL messages (inbound + outbound) by client_id
        const grouped = {};
        (data || []).forEach(msg => {
          if (!grouped[msg.client_id]) {
            grouped[msg.client_id] = {
              id: `conv-${msg.client_id}`,
              client_id: msg.client_id,
              client: msg.clients?.first_name || 'Unknown',
              channel: msg.channel,
              unread: 0,
              lastMessage: msg.content,
              lastTime: new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              messages: [],
              aiDraft: null,
            };
          }
          // Track unread count from inbound messages only
          if (msg.direction === 'inbound' && !msg.read) {
            grouped[msg.client_id].unread += 1;
          }
          // Keep latest AI draft suggestion from inbound messages
          if (msg.direction === 'inbound' && msg.ai_response) {
            grouped[msg.client_id].aiDraft = msg.ai_response;
          }
          // Update last message to the most recent (data is sorted ascending)
          grouped[msg.client_id].lastMessage = msg.content;
          grouped[msg.client_id].lastTime = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

          grouped[msg.client_id].messages.push({
            id: msg.id,
            dir: msg.direction === 'inbound' ? 'in' : 'out',
            text: msg.content,
            time: new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            read: msg.read || false,
          });
        });

        // Sort conversations by most recent message (last in each group)
        const convList = Object.values(grouped).sort((a, b) => {
          const aLast = (data || []).filter(m => m.client_id === a.client_id).pop();
          const bLast = (data || []).filter(m => m.client_id === b.client_id).pop();
          return new Date(bLast?.created_at || 0) - new Date(aLast?.created_at || 0);
        });

        setConversations(convList);
      }
    } catch (err) {
      logger.error({ err }, 'Failed to load conversations');
      setError('Something went wrong');
      setConversations([]);
    } finally {
      setLoading(false);
    }
  }

  const active = conversations.find(c => c.id === activeId);
  const filtered = channelFilter === 'all' ? conversations : conversations.filter(c => c.channel === channelFilter);
  const totalUnread = conversations.reduce((s, c) => s + c.unread, 0);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [active?.messages?.length]);

  function openConversation(id) {
    setActiveId(id);
    setCompose('');
    setShowAiDraft(true);
    // Mark as read
    setConversations(prev => prev.map(c =>
      c.id === id ? { ...c, unread: 0, messages: c.messages.map(m => ({ ...m, read: true })) } : c
    ));
  }

  async function sendMessage(text) {
    if (!text.trim() || !activeId || sending) return;
    const body = text.trim();
    const conv = conversations.find(c => c.id === activeId);
    if (!conv) return;

    setSending(true);
    setCompose('');
    setShowAiDraft(false);

    // Optimistic UI update
    const tempId = `m-${Date.now()}`;
    const optimistic = { id: tempId, dir: 'out', text: body, time: 'Sending…', read: true };
    setConversations(prev => prev.map(c =>
      c.id === activeId
        ? { ...c, messages: [...c.messages, optimistic], lastMessage: body, lastTime: 'Just now', aiDraft: null }
        : c
    ));

    try {
      const session = await supabase.auth.getSession();
      const token = session.data.session?.access_token;
      const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };

      let res;
      if (conv.channel === 'email') {
        res = await fetch(`${API_BASE}/api/notifications/send-email`, {
          method: 'POST', headers,
          body: JSON.stringify({ client_id: conv.client_id, subject: 'Message from your beautician', text: body }),
        });
      } else {
        // SMS covers sms + whatsapp channels via Bird
        res = await fetch(`${API_BASE}/api/notifications/send-sms`, {
          method: 'POST', headers,
          body: JSON.stringify({ client_id: conv.client_id, message: body }),
        });
      }

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Send failed');
      }

      // Mark the optimistic message as sent
      setConversations(prev => prev.map(c =>
        c.id === activeId
          ? { ...c, messages: c.messages.map(m => m.id === tempId ? { ...m, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) } : m) }
          : c
      ));
    } catch (err) {
      logger.error({ err }, 'Failed to send message');
      // Mark message as failed in UI
      setConversations(prev => prev.map(c =>
        c.id === activeId
          ? { ...c, messages: c.messages.map(m => m.id === tempId ? { ...m, time: 'Failed — tap to retry', failed: true } : m) }
          : c
      ));
    } finally {
      setSending(false);
    }
  }

  function useAiDraft() {
    if (active?.aiDraft) {
      sendMessage(active.aiDraft);
    }
  }

  if (bLoading || loading) {
    return <PageLoader />;
  }

  if (error) {
    return <ErrorCard message={error} onDismiss={() => setError(null)} />;
  }

  if (!activeId) {
    return (
      <div style={s.page}>
        <div style={s.header}>
          <h1 style={s.title}>Inbox</h1>
          {totalUnread > 0 && <span style={s.unreadBadge}>{totalUnread}</span>}
        </div>
        <p style={s.sub}>Client messages across all channels</p>

        {/* Channel filter pills */}
        <div style={s.filterRow}>
          {CHANNEL_FILTERS.map(f => (
            <button
              key={f}
              onClick={() => setChannelFilter(f)}
              style={{
                ...s.filterPill,
                background: channelFilter === f ? 'var(--accent)' : 'var(--bg-card)',
                color: channelFilter === f ? '#fff' : 'var(--text-secondary)',
                border: channelFilter === f ? 'none' : '1px solid var(--border)',
              }}
            >
              {f === 'all' ? 'All' : `${CHANNEL_ICONS[f] || ''} ${f[0].toUpperCase() + f.slice(1)}`}
            </button>
          ))}
        </div>

        <div style={s.convList}>
          {filtered.length === 0 ? (
            <EmptyState title="No conversations" description={channelFilter === 'all' ? 'Start messaging with your clients to see them here.' : `No ${channelFilter} conversations yet.`} />
          ) : (
            filtered.map(c => (
            <button
              key={c.id}
              onClick={() => openConversation(c.id)}
              style={{
                ...s.convItem,
                background: c.unread > 0 ? 'var(--accent-light)' : 'var(--bg-card)',
              }}
            >
              <div style={s.convAvatar}>
                <span style={s.avatarLetter}>{c.client[0]}</span>
                {c.unread > 0 && <div style={s.unreadDot} />}
              </div>
              <div style={s.convInfo}>
                <div style={s.convTop}>
                  <span style={{
                    ...s.convName,
                    fontWeight: c.unread > 0 ? 700 : 500,
                  }}>{c.client}</span>
                  <span style={s.convTime}>{c.lastTime}</span>
                </div>
                <div style={s.convBottom}>
                  <span style={s.channelIcon}>{CHANNEL_ICONS[c.channel] || '📱'}</span>
                  <span style={{
                    ...s.convPreview,
                    fontWeight: c.unread > 0 ? 600 : 400,
                    color: c.unread > 0 ? 'var(--text, #2D2A26)' : 'var(--text-muted, #7a7470)',
                  }}>
                    {c.lastMessage}
                  </span>
                </div>
              </div>
              {c.aiDraft && <span style={s.aiIndicator}>AI</span>}
            </button>
            ))
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={s.threadPage}>
      {/* Thread header */}
      <div style={s.threadHeader}>
        <button onClick={() => setActiveId(null)} style={s.backBtn}>‹</button>
        <div style={s.threadAvatar}>{active.client[0]}</div>
        <div style={s.threadInfo}>
          <span style={s.threadName}>{active.client}</span>
          <span style={s.threadChannel}>{CHANNEL_ICONS[active.channel] || '📱'} {active.channel}</span>
        </div>
      </div>

      {/* Messages */}
      <div style={s.messagesArea}>
        {active.messages.map(msg => (
          <div
            key={msg.id}
            onClick={msg.failed ? () => sendMessage(msg.text) : undefined}
            style={{
              ...s.bubble,
              ...(msg.dir === 'out' ? s.bubbleOut : s.bubbleIn),
              ...(msg.failed ? { background: '#d4463644', cursor: 'pointer' } : {}),
            }}
          >
            <p style={s.bubbleText}>{msg.text}</p>
            <span style={{ ...s.bubbleTime, color: msg.failed ? '#d44636' : undefined }}>
              {msg.failed ? '⚠ Failed — tap to retry' : msg.time}
            </span>
          </div>
        ))}

        {/* AI draft suggestion */}
        {showAiDraft && active.aiDraft && (
          <div style={s.aiDraftCard}>
            <div style={s.aiDraftHeader}>
              <span style={s.aiDraftLabel}>florrie.ai suggests</span>
              <button onClick={() => setShowAiDraft(false)} style={s.aiDismiss}>×</button>
            </div>
            <p style={s.aiDraftText}>{active.aiDraft}</p>
            <div style={s.aiDraftActions}>
              <button onClick={useAiDraft} style={s.aiSendBtn}>Send as-is</button>
              <button
                onClick={() => { setCompose(active.aiDraft); setShowAiDraft(false); }}
                style={s.aiEditBtn}
              >
                Edit first
              </button>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Quick replies */}
      <div style={s.quickReplies}>
        {QUICK_REPLIES.map(qr => (
          <button
            key={qr.key}
            onClick={() => sendMessage(qr.text)}
            style={s.quickChip}
          >
            {qr.label}
          </button>
        ))}
      </div>

      {/* Compose */}
      <div style={s.composeBar}>
        <input
          type="text"
          value={compose}
          onChange={e => setCompose(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !sending && sendMessage(compose)}
          placeholder={sending ? 'Sending…' : 'Type a message...'}
          disabled={sending}
          style={{ ...s.composeInput, opacity: sending ? 0.6 : 1 }}
        />
        <button
          onClick={() => sendMessage(compose)}
          disabled={!compose.trim() || sending}
          style={{
            ...s.sendBtn,
            opacity: compose.trim() && !sending ? 1 : 0.4,
          }}
        >
          {sending ? '…' : '↑'}
        </button>
      </div>
    </div>
  );
}

const s = {
  page: {
    padding: '16px 16px 32px',
    maxWidth: 480,
    margin: '0 auto',
    fontFamily: "var(--font-body, 'DM Sans', -apple-system, sans-serif)",
    animation: 'fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    paddingTop: 4,
  },
  title: { fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', margin: 0, fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)" },
  unreadBadge: {
    background: 'var(--accent)',
    color: '#fff',
    fontSize: 12,
    fontWeight: 700,
    padding: '2px 8px',
    borderRadius: 10,
  },
  sub: { fontSize: 13, color: 'var(--text-muted)', margin: '4px 0 12px' },
  filterRow: {
    display: 'flex',
    gap: 6,
    marginBottom: 12,
    overflowX: 'auto',
    paddingBottom: 2,
  },
  filterPill: {
    padding: '5px 12px',
    borderRadius: 14,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  convList: { display: 'flex', flexDirection: 'column', gap: 4 },
  convItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '12px 14px',
    borderRadius: 14,
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
    width: '100%',
  },
  convAvatar: {
    position: 'relative',
    width: 44,
    height: 44,
    borderRadius: 22,
    background: 'linear-gradient(135deg, var(--accent)22, var(--accent)44)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  avatarLetter: { fontSize: 16, fontWeight: 700, color: 'var(--accent)' },
  unreadDot: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 10,
    height: 10,
    borderRadius: 5,
    background: 'var(--accent)',
    border: '2px solid var(--bg)',
  },
  convInfo: { flex: 1, minWidth: 0 },
  convTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 },
  convName: { fontSize: 14, color: 'var(--text-primary)' },
  convTime: { fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 },
  convBottom: { display: 'flex', alignItems: 'center', gap: 4 },
  channelIcon: { fontSize: 12, flexShrink: 0 },
  convPreview: {
    fontSize: 13,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  aiIndicator: {
    fontSize: 9,
    fontWeight: 700,
    color: 'var(--accent)',
    background: 'var(--accent-light)',
    padding: '2px 6px',
    borderRadius: 6,
    flexShrink: 0,
  },

  // Thread view
  threadPage: {
    display: 'flex',
    flexDirection: 'column',
    height: 'calc(100vh - 72px)',
    maxWidth: 480,
    margin: '0 auto',
    fontFamily: "var(--font-body, 'DM Sans', -apple-system, sans-serif)",
  },
  threadHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '12px 16px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--bg)',
    flexShrink: 0,
  },
  backBtn: {
    background: 'none',
    border: 'none',
    fontSize: 24,
    color: 'var(--accent)',
    cursor: 'pointer',
    padding: '0 4px',
    fontFamily: 'inherit',
  },
  threadAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    background: 'linear-gradient(135deg, var(--accent)22, var(--accent)44)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 14,
    fontWeight: 700,
    color: 'var(--accent)',
  },
  threadInfo: { display: 'flex', flexDirection: 'column' },
  threadName: { fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' },
  threadChannel: { fontSize: 11, color: 'var(--text-muted)' },
  messagesArea: {
    flex: 1,
    overflowY: 'auto',
    padding: '12px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  bubble: {
    maxWidth: '80%',
    padding: '10px 14px',
    borderRadius: 16,
    position: 'relative',
  },
  bubbleIn: {
    alignSelf: 'flex-start',
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderBottomLeftRadius: 4,
  },
  bubbleOut: {
    alignSelf: 'flex-end',
    background: 'var(--accent)',
    color: '#fff',
    borderBottomRightRadius: 4,
  },
  bubbleText: { fontSize: 14, lineHeight: 1.5, margin: 0 },
  bubbleTime: {
    fontSize: 10,
    opacity: 0.6,
    display: 'block',
    marginTop: 4,
    textAlign: 'right',
  },
  aiDraftCard: {
    alignSelf: 'flex-end',
    maxWidth: '85%',
    padding: '12px 14px',
    borderRadius: 14,
    background: 'linear-gradient(135deg, var(--accent-light), #F5EFFC)',
    border: '1px solid #E8D8E8',
    marginTop: 8,
  },
  aiDraftHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  aiDraftLabel: {
    fontSize: 11,
    fontWeight: 700,
    color: 'var(--accent)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  aiDismiss: {
    background: 'none',
    border: 'none',
    fontSize: 16,
    color: 'var(--text-muted)',
    cursor: 'pointer',
    padding: 0,
  },
  aiDraftText: {
    fontSize: 13,
    lineHeight: 1.5,
    color: 'var(--text-secondary)',
    margin: '0 0 10px',
  },
  aiDraftActions: { display: 'flex', gap: 8 },
  aiSendBtn: {
    flex: 1,
    padding: '8px 0',
    borderRadius: 8,
    border: 'none',
    background: 'var(--accent)',
    color: '#fff',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  aiEditBtn: {
    padding: '8px 14px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--bg-card)',
    color: 'var(--text-primary)',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  quickReplies: {
    display: 'flex',
    gap: 6,
    padding: '8px 16px',
    overflowX: 'auto',
    borderTop: '1px solid var(--border)',
    flexShrink: 0,
  },
  quickChip: {
    padding: '6px 14px',
    borderRadius: 16,
    border: '1px solid var(--border)',
    background: 'var(--bg-card)',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
    color: 'var(--text-primary)',
  },
  composeBar: {
    display: 'flex',
    gap: 8,
    padding: '10px 16px 14px',
    borderTop: '1px solid var(--border)',
    background: 'var(--bg)',
    flexShrink: 0,
  },
  composeInput: {
    flex: 1,
    padding: '10px 14px',
    borderRadius: 20,
    border: '1.5px solid var(--border)',
    fontSize: 14,
    fontFamily: 'inherit',
    outline: 'none',
    background: 'var(--bg-card)',
    color: 'var(--text-primary)',
  },
  sendBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    border: 'none',
    background: 'var(--accent)',
    color: '#fff',
    fontSize: 18,
    fontWeight: 700,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
};
