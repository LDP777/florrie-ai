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
import { useBeautician, supabase, isDevMode, fetchRows } from '../lib/supabase.js';
import { useTheme } from '../lib/theme.jsx';
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

const CHANNEL_ICONS = { whatsapp: '💬', sms: '📱', email: '✉️' };

// ── Dev mock data (fallback) ──────────────────────────────────────────────
const DEV_CONVERSATIONS = [
  {
    id: 'conv-1', client: 'Shauna', channel: 'whatsapp', unread: 2,
    lastMessage: 'Can I move my appointment to Friday instead?', lastTime: '10:32',
    messages: [
      { id: 'm1', dir: 'in', text: 'Hey Ellie! Hope you\'re well xx', time: '10:28', read: true },
      { id: 'm2', dir: 'out', text: 'Hey lovely! I\'m great thanks, how are you? xx', time: '10:29', read: true },
      { id: 'm3', dir: 'in', text: 'Good thanks! Quick one — can I move my appointment to Friday instead?', time: '10:32', read: false },
    ],
    aiDraft: "No worries at all lovely! I've got 2pm or 3:30pm free on Friday — which works best for you? xx",
  },
];

// ── Component ──────────────────────────────────────────────

export default function Inbox() {
  const { dark } = useTheme();
  const { beautician, loading: bLoading } = useBeautician();
  const [conversations, setConversations] = useState(isDevMode ? DEV_CONVERSATIONS : []);
  const [activeId, setActiveId] = useState(null);
  const [compose, setCompose] = useState('');
  const [showAiDraft, setShowAiDraft] = useState(true);
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
      if (isDevMode) {
        setConversations(DEV_CONVERSATIONS);
        setLoading(false);
        return;
      }

      const { data, error } = await supabase
        .from('messages')
        .select('*, clients(first_name, last_name)')
        .eq('beautician_id', beautician.id)
        .eq('direction', 'inbound')
        .order('created_at', { ascending: false });

      if (error) {
        logger.error('Load conversations error:', error);
        setError(error.message || 'Failed to load conversations');
        setConversations(DEV_CONVERSATIONS);
      } else {
        // Group messages by client_id to create conversation list
        const grouped = {};
        (data || []).forEach(msg => {
          if (!grouped[msg.client_id]) {
            grouped[msg.client_id] = {
              id: `conv-${msg.client_id}`,
              client_id: msg.client_id,
              client: msg.clients?.first_name || 'Unknown',
              channel: msg.channel,
              unread: msg.read ? 0 : 1,
              lastMessage: msg.content,
              lastTime: new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              messages: [],
              aiDraft: msg.ai_response || null,
            };
          }
          grouped[msg.client_id].messages.push({
            id: msg.id,
            dir: msg.direction === 'inbound' ? 'in' : 'out',
            text: msg.content,
            time: new Date(msg.created_at).toLocaleTimeString(),
            read: msg.read || false,
          });
        });

        setConversations(Object.values(grouped));
      }
    } catch (err) {
      logger.error('Failed to load conversations:', err);
      setError(err.message || 'Failed to load conversations');
      setConversations(DEV_CONVERSATIONS);
    } finally {
      setLoading(false);
    }
  }

  const active = conversations.find(c => c.id === activeId);
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
    if (!text.trim() || !activeId) return;
    const newMsg = { id: `m-${Date.now()}`, dir: 'out', text: text.trim(), time: 'Just now', read: true };

    // Update UI optimistically
    setConversations(prev => prev.map(c =>
      c.id === activeId
        ? { ...c, messages: [...c.messages, newMsg], lastMessage: text.trim(), lastTime: 'Just now', aiDraft: null }
        : c
    ));

    // Send to real DB via SMS API (Twilio)
    setCompose('');
    setShowAiDraft(false);
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

  // ── Conversation list view ──
  if (!activeId) {
    return (
      <div style={s.page}>
        <div style={s.header}>
          <h1 style={s.title}>Inbox</h1>
          {totalUnread > 0 && <span style={s.unreadBadge}>{totalUnread}</span>}
        </div>
        <p style={s.sub}>Client messages across all channels</p>

        <div style={s.convList}>
          {conversations.length === 0 ? (
            <EmptyState title="No conversations" description="Start messaging with your clients to see them here." />
          ) : (
            conversations.map(c => (
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
                    color: c.unread > 0 ? 'var(--text, #2D2A26)' : 'var(--text-muted, #AAA5A0)',
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

  // ── Thread view ──
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
            style={{
              ...s.bubble,
              ...(msg.dir === 'out' ? s.bubbleOut : s.bubbleIn),
            }}
          >
            <p style={s.bubbleText}>{msg.text}</p>
            <span style={s.bubbleTime}>{msg.time}</span>
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
          onKeyDown={e => e.key === 'Enter' && sendMessage(compose)}
          placeholder="Type a message..."
          style={s.composeInput}
        />
        <button
          onClick={() => sendMessage(compose)}
          disabled={!compose.trim()}
          style={{
            ...s.sendBtn,
            opacity: compose.trim() ? 1 : 0.4,
          }}
        >
          ↑
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
  sub: { fontSize: 13, color: 'var(--text-muted)', margin: '4px 0 16px' },
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
