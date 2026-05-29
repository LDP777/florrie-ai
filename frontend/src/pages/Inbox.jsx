import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';

/**
 * Inbox , Day 2 of the 2026-05-28 refactor sprint.
 *
 * One thread per client, channels are metadata. Salon owners think
 * "Sarah", not "Sarah on WhatsApp". The composer defaults to the
 * channel of the most recent inbound message and lets you switch with
 * one tap.
 *
 * Two views:
 *   - Thread list      (default)
 *   - Conversation     (when ?client=<uuid> is set)
 *
 * Mobile-first single column; ≥768px the two panes sit side by side.
 */

const CHANNEL_ICON = { whatsapp: '💬', sms: '📱', email: '✉️' };
const CHANNEL_LABEL = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email' };

function getToken() {
  const key = Object.keys(localStorage).find(k => /^sb-.+-auth-token$/.test(k));
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    const parsed = JSON.parse(raw);
    return parsed?.access_token || parsed?.session?.access_token || raw;
  } catch { return null; }
}

async function authFetch(path, options = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token || getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error || 'Request failed');
    err.body = json;
    err.status = res.status;
    throw err;
  }
  return json;
}

function clientFullName(t) {
  const first = (t.client_first_name || '').trim();
  const last = (t.client_last_name || '').trim();
  if (first && last) return `${first} ${last}`;
  return first || last || 'Client';
}

function initialOf(name) {
  return (name || 'C').trim().charAt(0).toUpperCase() || 'C';
}

function formatTimeShort(iso, now = new Date()) {
  if (!iso) return '';
  const t = new Date(iso);
  const sameDay = t.toDateString() === now.toDateString();
  if (sameDay) return t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const diff = now - t;
  const day = 24 * 60 * 60 * 1000;
  if (diff < 7 * day) return t.toLocaleDateString('en-GB', { weekday: 'short' });
  return t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function formatBubbleTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function readClientFromUrl() {
  if (typeof window === 'undefined') return null;
  const u = new URL(window.location.href);
  return u.searchParams.get('client') || null;
}

function setClientInUrl(clientId) {
  const u = new URL(window.location.href);
  if (clientId) u.searchParams.set('client', clientId);
  else u.searchParams.delete('client');
  window.history.replaceState({}, '', u.toString());
}

export default function Inbox() {
  const navigate = useNavigate();
  const [threads, setThreads] = useState(null);
  const [threadsError, setThreadsError] = useState(null);
  const [search, setSearch] = useState('');
  const [activeClientId, setActiveClientId] = useState(readClientFromUrl());
  const [isWide, setIsWide] = useState(typeof window !== 'undefined' ? window.innerWidth >= 768 : false);

  useEffect(() => {
    const onResize = () => setIsWide(window.innerWidth >= 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const loadThreads = async () => {
    try {
      const json = await authFetch('/api/inbox/threads?limit=80');
      setThreads(json.threads || []);
      setThreadsError(null);
    } catch (err) {
      logger.error({ err }, 'inbox threads load failed');
      setThreadsError(err.message || 'Failed to load');
      setThreads([]);
    }
  };

  useEffect(() => {
    loadThreads();
    const onFocus = () => loadThreads();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    if (!threads) return null;
    const q = search.trim().toLowerCase();
    if (!q) return threads;
    return threads.filter(t => clientFullName(t).toLowerCase().includes(q));
  }, [threads, search]);

  function openThread(clientId) {
    setActiveClientId(clientId);
    setClientInUrl(clientId);
  }
  function closeThread() {
    setActiveClientId(null);
    setClientInUrl(null);
    // Reload thread list so unread counts refresh after reading.
    loadThreads();
  }

  // Mobile: show conversation full-screen when active; thread list when not.
  if (!isWide && activeClientId) {
    return (
      <Conversation
        clientId={activeClientId}
        onBack={closeThread}
        onSent={loadThreads}
      />
    );
  }

  if (isWide) {
    return (
      <div style={S.pageWide}>
        <aside style={S.paneList}>
          <ThreadList
            threads={filtered}
            error={threadsError}
            search={search}
            onSearch={setSearch}
            onOpen={openThread}
            activeId={activeClientId}
          />
        </aside>
        <section style={S.paneConvo}>
          {activeClientId ? (
            <Conversation clientId={activeClientId} onBack={closeThread} onSent={loadThreads} embedded />
          ) : (
            <EmptyConvoPlaceholder />
          )}
        </section>
      </div>
    );
  }

  return (
    <div style={S.page}>
      <ThreadList
        threads={filtered}
        error={threadsError}
        search={search}
        onSearch={setSearch}
        onOpen={openThread}
      />
    </div>
  );
}

function ThreadList({ threads, error, search, onSearch, onOpen, activeId }) {
  return (
    <>
      <header style={S.header}>
        <h1 style={S.title}>Inbox</h1>
      </header>

      <div style={S.searchWrap}>
        <span className="material-symbols-outlined" style={S.searchIcon} aria-hidden>search</span>
        <input
          type="search"
          value={search}
          onChange={e => onSearch(e.target.value)}
          placeholder="Search by name"
          style={S.searchInput}
        />
      </div>

      {threads === null && <ThreadSkeleton />}
      {threads !== null && error && (
        <div style={S.errorCard}>
          Couldn't load conversations. Pull down to refresh, or check back in a bit.
        </div>
      )}
      {threads !== null && !error && threads.length === 0 && <EmptyInbox />}

      {threads !== null && threads.length > 0 && (
        <ul style={S.list}>
          {threads.map(t => (
            <ThreadRow
              key={t.client_id}
              thread={t}
              active={t.client_id === activeId}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
    </>
  );
}

function ThreadRow({ thread, active, onOpen }) {
  const name = clientFullName(thread);
  const isUnread = thread.unread_count > 0;
  const channelIcon = CHANNEL_ICON[thread.last_channel] || '💬';
  const directionPrefix = thread.last_message_direction === 'outbound' ? 'You: ' : '';

  return (
    <li>
      <button
        onClick={() => onOpen(thread.client_id)}
        style={{
          ...S.row,
          background: active ? '#ffe5ec' : isUnread ? '#fff' : 'transparent',
          borderColor: active ? '#ffd1de' : 'transparent',
        }}
      >
        <span style={S.avatar} aria-hidden>{initialOf(name)}</span>
        <span style={S.rowBody}>
          <span style={S.rowTop}>
            <span style={{ ...S.rowName, fontWeight: isUnread ? 700 : 600 }}>{name}</span>
            <span style={S.rowTime}>{formatTimeShort(thread.last_message_at)}</span>
          </span>
          <span style={S.rowBottom}>
            <span style={S.rowChannel} aria-label={CHANNEL_LABEL[thread.last_channel] || 'WhatsApp'}>
              {channelIcon}
            </span>
            <span style={{
              ...S.rowPreview,
              color: isUnread ? '#1d1b19' : '#867277',
              fontWeight: isUnread ? 600 : 400,
            }}>
              {directionPrefix}{thread.last_message_preview || ''}
            </span>
            {isUnread && <span style={S.rowBadge}>{thread.unread_count}</span>}
          </span>
        </span>
      </button>
    </li>
  );
}

function ThreadSkeleton() {
  return (
    <ul style={S.list} aria-busy>
      {[0, 1, 2, 3].map(i => (
        <li key={i}>
          <div style={{ ...S.row, cursor: 'default' }}>
            <span style={{ ...S.avatar, background: '#f3ede9', color: 'transparent' }}>·</span>
            <span style={S.rowBody}>
              <span style={S.skelLine} />
              <span style={S.skelLineShort} />
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function EmptyInbox() {
  return (
    <div style={S.empty}>
      <div style={S.emptyIcon}>🌷</div>
      <p style={S.emptyText}>
        Once a client messages you, they'll appear here.
      </p>
      <Link to="/whatsapp" style={S.emptyCta}>
        Send a template
      </Link>
      <p style={S.emptyHint}>
        A friendly hello is all it takes to get the conversation started.
      </p>
    </div>
  );
}

function EmptyConvoPlaceholder() {
  return (
    <div style={S.placeholder}>
      <div style={{ fontSize: 28, marginBottom: 8 }}>💌</div>
      <div style={{ fontSize: 14, color: '#867277', fontFamily: "'Noto Serif', Georgia, serif", fontStyle: 'italic' }}>
        Pick a conversation
      </div>
    </div>
  );
}

function Conversation({ clientId, onBack, onSent, embedded = false }) {
  const navigate = useNavigate();
  const [state, setState] = useState({ status: 'loading' });
  const [composer, setComposer] = useState('');
  const [channel, setChannel] = useState(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const scrollerRef = useRef(null);
  const composerRef = useRef(null);

  const load = async () => {
    try {
      const json = await authFetch(`/api/inbox/thread/${encodeURIComponent(clientId)}`);
      setState({ status: 'ready', ...json });
      // Only auto-pick the default channel on first load (or when the
      // available channels for the conversation actually change).
      setChannel(prev => prev || json.default_channel);
    } catch (err) {
      logger.error({ err }, 'inbox.thread load failed');
      setState({ status: 'error', error: err.message || 'Failed to load' });
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  useEffect(() => {
    // Scroll to bottom when messages change.
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [state?.messages?.length]);

  async function handleSend() {
    const body = composer.trim();
    if (!body || sending || !channel) return;
    if (!clientId) return;

    setSending(true);
    setSendError(null);

    // Optimistic message.
    const tempId = `tmp-${Date.now()}`;
    const optimistic = {
      id: tempId,
      client_id: clientId,
      channel,
      direction: 'outbound',
      body,
      created_at: new Date().toISOString(),
      status: 'sending',
      ai_generated: false,
      image_url: null,
    };
    setState(prev => ({ ...prev, messages: [...(prev.messages || []), optimistic] }));
    setComposer('');

    try {
      const res = await authFetch('/api/inbox/send', {
        method: 'POST',
        body: JSON.stringify({ client_id: clientId, channel, body }),
      });
      // Swap the optimistic row for the real one.
      setState(prev => ({
        ...prev,
        messages: (prev.messages || []).map(m => m.id === tempId ? res.message : m),
      }));
      onSent?.();
    } catch (err) {
      logger.error({ err }, 'inbox.send failed');
      // Remove the optimistic row and surface a clear error.
      setState(prev => ({
        ...prev,
        messages: (prev.messages || []).filter(m => m.id !== tempId),
      }));
      setComposer(body); // give the user their text back
      setSendError(err.message || 'Send failed');
    } finally {
      setSending(false);
      composerRef.current?.focus();
    }
  }

  function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  if (state.status === 'loading') {
    return (
      <div style={embedded ? S.convoEmbedded : S.convoFull}>
        <ConvoHeader onBack={onBack} embedded={embedded} clientName="…" navigate={navigate} clientId={clientId} />
        <div style={{ padding: 16, color: '#867277', fontSize: 13 }}>Loading conversation…</div>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div style={embedded ? S.convoEmbedded : S.convoFull}>
        <ConvoHeader onBack={onBack} embedded={embedded} clientName="Conversation" navigate={navigate} clientId={clientId} />
        <div style={S.errorCard}>{state.error || "Couldn't load this conversation."}</div>
      </div>
    );
  }

  const { client, messages = [] } = state;
  const fullName = [client?.first_name, client?.last_name].filter(Boolean).join(' ') || 'Client';

  // Detect "outside 24h window" hint: latest inbound is older than 24h and
  // the picked channel is whatsapp.
  const lastInbound = [...messages].reverse().find(m => m.direction === 'inbound');
  const lastInboundAge = lastInbound ? Date.now() - new Date(lastInbound.created_at).getTime() : Infinity;
  const showWaWindowHint = channel === 'whatsapp' && lastInboundAge > 24 * 60 * 60 * 1000;

  // Which channels are actually available?
  const channels = ['whatsapp', 'sms', 'email'].filter(c => {
    if (c === 'whatsapp') return !!client?.has_whatsapp;
    if (c === 'sms') return !!client?.has_phone;
    if (c === 'email') return !!client?.has_email;
    return false;
  });

  return (
    <div style={embedded ? S.convoEmbedded : S.convoFull}>
      <ConvoHeader
        onBack={onBack}
        embedded={embedded}
        clientName={fullName}
        navigate={navigate}
        clientId={client?.id}
      />

      <div ref={scrollerRef} style={S.scroller}>
        {messages.length === 0 && (
          <div style={{ padding: '40px 16px', color: '#867277', fontSize: 13, textAlign: 'center' }}>
            No messages yet. Type below to start the conversation.
          </div>
        )}
        {messages.map(m => (
          <Bubble key={m.id} msg={m} />
        ))}
      </div>

      {showWaWindowHint && (
        <div style={S.waHint}>
          WhatsApp is outside the 24h window. Send a template or switch channels.
          <Link to="/whatsapp" style={S.waHintLink}>Go to templates</Link>
        </div>
      )}

      {channels.length === 0 ? (
        <div style={S.noContact}>
          No contact info on file for this client. Add a phone or email on their profile.
          <Link to={client?.id ? `/clients/${client.id}` : '/clients'} style={S.waHintLink}>Open profile</Link>
        </div>
      ) : (
        <div style={S.composerBar}>
          <div style={S.channelToggle} role="tablist" aria-label="Choose channel">
            {channels.map(c => (
              <button
                key={c}
                type="button"
                role="tab"
                aria-selected={channel === c}
                onClick={() => setChannel(c)}
                style={{
                  ...S.channelPill,
                  background: channel === c ? '#92405e' : '#fff',
                  color: channel === c ? '#fff' : '#92405e',
                  borderColor: channel === c ? '#92405e' : '#f0d2dd',
                }}
              >
                <span aria-hidden>{CHANNEL_ICON[c]}</span> {CHANNEL_LABEL[c]}
              </button>
            ))}
          </div>

          {sendError && <div style={S.sendError}>{sendError}</div>}

          <div style={S.composerRow}>
            <textarea
              ref={composerRef}
              value={composer}
              onChange={e => setComposer(e.target.value)}
              onKeyDown={handleKey}
              placeholder={`Reply via ${CHANNEL_LABEL[channel] || 'WhatsApp'}…`}
              rows={1}
              style={S.composerInput}
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={!composer.trim() || sending}
              style={{
                ...S.sendBtn,
                opacity: composer.trim() && !sending ? 1 : 0.45,
              }}
              aria-label="Send"
            >
              {sending ? '…' : (
                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>arrow_upward</span>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ConvoHeader({ onBack, embedded, clientName, navigate, clientId }) {
  return (
    <div style={S.convoHeader}>
      {!embedded && (
        <button onClick={onBack} style={S.backBtn} aria-label="Back to inbox">
          <span className="material-symbols-outlined" style={{ fontSize: 22 }}>chevron_left</span>
        </button>
      )}
      <span style={S.convoAvatar}>{initialOf(clientName)}</span>
      <div style={S.convoNameWrap}>
        <span style={S.convoName}>{clientName}</span>
        {clientId && (
          <button
            onClick={() => navigate(`/clients/${clientId}`)}
            style={S.viewProfileBtn}
          >
            View profile
          </button>
        )}
      </div>
    </div>
  );
}

function Bubble({ msg }) {
  const out = msg.direction === 'outbound';
  const icon = CHANNEL_ICON[msg.channel] || '💬';
  return (
    <div style={{ ...S.bubbleRow, justifyContent: out ? 'flex-end' : 'flex-start' }}>
      <div
        style={{
          ...S.bubble,
          background: out ? '#92405e' : '#fff',
          color: out ? '#fff' : '#1d1b19',
          borderColor: out ? '#92405e' : '#f0d2dd',
          borderBottomLeftRadius: out ? 16 : 4,
          borderBottomRightRadius: out ? 4 : 16,
        }}
      >
        {msg.image_url && (
          <img
            src={msg.image_url}
            alt=""
            style={{ maxWidth: '100%', borderRadius: 10, marginBottom: msg.body ? 6 : 0 }}
          />
        )}
        {msg.body && <div style={S.bubbleText}>{msg.body}</div>}
        <div style={{ ...S.bubbleMeta, color: out ? 'rgba(255,255,255,0.75)' : '#9B8A8E' }}>
          <span aria-hidden>{icon}</span>
          <span>{formatBubbleTime(msg.created_at)}</span>
          {msg.status === 'sending' && <span>· sending</span>}
          {msg.ai_generated && <span>· Florrie</span>}
        </div>
      </div>
    </div>
  );
}

const S = {
  page: {
    minHeight: '100vh',
    background: '#fef8f4',
    fontFamily: "'Plus Jakarta Sans', 'DM Sans', sans-serif",
    padding: '16px 16px 120px',
    maxWidth: 480,
    margin: '0 auto',
    color: '#1d1b19',
  },
  pageWide: {
    minHeight: '100vh',
    background: '#fef8f4',
    fontFamily: "'Plus Jakarta Sans', 'DM Sans', sans-serif",
    display: 'grid',
    gridTemplateColumns: 'minmax(320px, 380px) 1fr',
    gap: 16,
    padding: '16px 16px 24px',
    maxWidth: 1100,
    margin: '0 auto',
    color: '#1d1b19',
  },
  paneList: {
    background: '#fff',
    border: '1px solid rgba(146,64,94,0.07)',
    borderRadius: 20,
    padding: '14px 12px',
    boxShadow: '0 1px 4px rgba(146,64,94,0.05)',
    maxHeight: 'calc(100vh - 32px)',
    overflowY: 'auto',
  },
  paneConvo: {
    background: '#fff',
    border: '1px solid rgba(146,64,94,0.07)',
    borderRadius: 20,
    boxShadow: '0 1px 4px rgba(146,64,94,0.05)',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 'calc(100vh - 32px)',
    overflow: 'hidden',
  },

  header: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: 10,
    padding: '0 4px',
  },
  title: {
    fontSize: 22,
    fontWeight: 700,
    color: '#1d1b19',
    fontFamily: "'Noto Serif', Georgia, serif",
    fontStyle: 'italic',
    margin: 0,
    lineHeight: 1.2,
  },

  searchWrap: {
    position: 'relative',
    marginBottom: 10,
    padding: '0 4px',
  },
  searchIcon: {
    position: 'absolute',
    left: 14,
    top: '50%',
    transform: 'translateY(-50%)',
    fontSize: 18,
    color: '#B5AFA8',
  },
  searchInput: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '10px 12px 10px 38px',
    border: '1px solid rgba(146,64,94,0.12)',
    borderRadius: 14,
    background: '#fff',
    fontSize: 14,
    fontFamily: 'inherit',
    color: '#1d1b19',
    outline: 'none',
  },

  list: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  row: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '10px 10px',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: 14,
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
    WebkitTapHighlightColor: 'transparent',
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    background: 'linear-gradient(135deg, #ffd9e2 0%, #ffb8c8 100%)',
    color: '#92405e',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 16,
    fontWeight: 700,
    flexShrink: 0,
    fontFamily: "'Noto Serif', Georgia, serif",
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  rowTop: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
  },
  rowName: { fontSize: 14, color: '#1d1b19' },
  rowTime: { fontSize: 11, color: '#9B8A8E', flexShrink: 0 },
  rowBottom: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    minWidth: 0,
  },
  rowChannel: { fontSize: 13, flexShrink: 0 },
  rowPreview: {
    fontSize: 13,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: 1,
    minWidth: 0,
  },
  rowBadge: {
    fontSize: 11,
    fontWeight: 700,
    color: '#fff',
    background: '#92405e',
    padding: '2px 8px',
    borderRadius: 20,
    minWidth: 18,
    textAlign: 'center',
    flexShrink: 0,
  },

  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '40px 14px',
    textAlign: 'center',
    gap: 10,
  },
  emptyIcon: { fontSize: 36, lineHeight: 1 },
  emptyText: {
    fontSize: 14,
    color: '#534247',
    lineHeight: 1.5,
    margin: 0,
    maxWidth: 280,
  },
  emptyCta: {
    marginTop: 6,
    padding: '10px 18px',
    background: '#92405e',
    color: '#fff',
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 600,
    textDecoration: 'none',
    fontFamily: 'inherit',
  },
  emptyHint: {
    fontSize: 12,
    color: '#867277',
    margin: 0,
    maxWidth: 260,
  },
  errorCard: {
    margin: '12px 4px',
    padding: 14,
    background: '#FFF8F0',
    border: '1px solid #FFE8CC',
    borderRadius: 12,
    fontSize: 13,
    color: '#7B5E00',
    lineHeight: 1.5,
  },

  placeholder: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },

  // Conversation
  convoFull: {
    minHeight: '100vh',
    background: '#fef8f4',
    fontFamily: "'Plus Jakarta Sans', 'DM Sans', sans-serif",
    display: 'flex',
    flexDirection: 'column',
    color: '#1d1b19',
    paddingBottom: 120,
  },
  convoEmbedded: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
  },
  convoHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '12px 14px',
    background: '#fff',
    borderBottom: '1px solid rgba(146,64,94,0.07)',
    position: 'sticky',
    top: 0,
    zIndex: 2,
  },
  backBtn: {
    background: 'none',
    border: 'none',
    color: '#92405e',
    padding: 4,
    cursor: 'pointer',
    fontFamily: 'inherit',
    display: 'flex',
    alignItems: 'center',
  },
  convoAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    background: 'linear-gradient(135deg, #ffd9e2 0%, #ffb8c8 100%)',
    color: '#92405e',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 14,
    fontWeight: 700,
    fontFamily: "'Noto Serif', Georgia, serif",
  },
  convoNameWrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
    flex: 1,
    minWidth: 0,
  },
  convoName: {
    fontSize: 15,
    fontWeight: 700,
    color: '#1d1b19',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  viewProfileBtn: {
    background: 'none',
    border: 'none',
    color: '#92405e',
    fontSize: 11,
    fontWeight: 600,
    padding: 0,
    cursor: 'pointer',
    fontFamily: 'inherit',
    alignSelf: 'flex-start',
    textDecoration: 'underline',
  },

  scroller: {
    flex: 1,
    overflowY: 'auto',
    padding: '12px 14px 8px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  bubbleRow: {
    display: 'flex',
    width: '100%',
  },
  bubble: {
    maxWidth: '80%',
    padding: '9px 12px',
    border: '1px solid',
    borderRadius: 16,
    boxShadow: '0 1px 2px rgba(146,64,94,0.05)',
  },
  bubbleText: {
    fontSize: 14,
    lineHeight: 1.45,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  bubbleMeta: {
    fontSize: 10,
    marginTop: 4,
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    justifyContent: 'flex-end',
  },

  waHint: {
    margin: '0 14px 8px',
    padding: '10px 12px',
    background: '#FFF8E1',
    border: '1px solid #FFE082',
    borderRadius: 12,
    fontSize: 12,
    color: '#7B5E00',
    lineHeight: 1.5,
  },
  waHintLink: {
    color: '#7B5E00',
    fontWeight: 700,
    marginLeft: 6,
    textDecoration: 'underline',
  },
  noContact: {
    margin: '0 14px 14px',
    padding: 12,
    background: '#FDECEA',
    border: '1px solid #F5C6C0',
    borderRadius: 12,
    fontSize: 12,
    color: '#8A2A1C',
    lineHeight: 1.5,
  },

  composerBar: {
    padding: '8px 12px 16px',
    background: '#fff',
    borderTop: '1px solid rgba(146,64,94,0.07)',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    position: 'sticky',
    bottom: 0,
  },
  channelToggle: {
    display: 'flex',
    gap: 6,
    overflowX: 'auto',
  },
  channelPill: {
    padding: '6px 12px',
    borderRadius: 999,
    border: '1px solid',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  composerRow: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: 8,
  },
  composerInput: {
    flex: 1,
    padding: '10px 14px',
    border: '1px solid rgba(146,64,94,0.18)',
    borderRadius: 18,
    background: '#fef8f4',
    fontSize: 14,
    fontFamily: 'inherit',
    resize: 'none',
    maxHeight: 140,
    color: '#1d1b19',
    outline: 'none',
    lineHeight: 1.4,
  },
  sendBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    border: 'none',
    background: '#92405e',
    color: '#fff',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  sendError: {
    fontSize: 12,
    color: '#8A2A1C',
    background: '#FDECEA',
    border: '1px solid #F5C6C0',
    borderRadius: 10,
    padding: '6px 10px',
  },

  skelLine: {
    height: 12,
    width: '60%',
    borderRadius: 6,
    background: '#f3ede9',
    display: 'block',
  },
  skelLineShort: {
    height: 10,
    width: '40%',
    borderRadius: 5,
    background: '#f3ede9',
    display: 'block',
    marginTop: 4,
  },
};

if (typeof document !== 'undefined' && !document.getElementById('inbox-keyframes')) {
  const s = document.createElement('style');
  s.id = 'inbox-keyframes';
  s.textContent = `
    @media (max-width: 767px) {
      .inbox-wide-only { display: none; }
    }
  `;
  document.head.appendChild(s);
}
