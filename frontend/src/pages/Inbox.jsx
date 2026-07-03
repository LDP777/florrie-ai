import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import PageHeader from '../components/ui/PageHeader.jsx';

/**
 * Inbox , one calm thread per client.
 *
 * Salon owners think "Sarah", not "Sarah on WhatsApp", so each client is a
 * single thread and the channel rides along as metadata. This refresh adds:
 *
 *   - Material channel marks (WhatsApp, Instagram, SMS, email) instead of
 *     emoji, so it reads as part of the app, not a chat clone.
 *   - Message TYPE awareness: a client message, a reply Florrie sent, a
 *     proactive nudge she lined up, or something she handed back to you.
 *   - A "Needs you" view that floats real, waiting conversations to the top
 *     and keeps Florrie's automated housekeeping from drowning them out.
 *
 * Two views: the thread list, and a conversation (when a client is open).
 * Mobile-first single column; from 768px the two panes sit side by side.
 */

// Channel marks. Material Symbols so they sit with the rest of the app.
const CHANNEL = {
  whatsapp:  { icon: 'chat',         label: 'WhatsApp',  tint: '#1f9d55', fill: '#1f9d55' },
  instagram: { icon: 'photo_camera', label: 'Instagram', tint: '#c13584', fill: 'linear-gradient(135deg, #c13584 0%, #e1306c 55%, #f56040 100%)' },
  sms:       { icon: 'sms',          label: 'SMS',       tint: '#3a6ea5', fill: '#3a6ea5' },
  email:     { icon: 'mail',         label: 'Email',     tint: '#92405e', fill: '#92405e' },
};
function channelOf(key) {
  return CHANNEL[key] || CHANNEL.whatsapp;
}

// Message types. Derived on the backend; labelled and tinted here.
const TYPE = {
  inbound:    { label: 'Client message', dot: '#c0607f' },
  escalated:  { label: 'Needs you',      dot: '#c2410c' },
  auto_reply: { label: 'Florrie replied', dot: '#9a8f93' },
  proactive:  { label: 'Florrie reached out', dot: '#9a8f93' },
  you:        { label: 'You', dot: '#9a8f93' },
};
function typeMeta(key) {
  return TYPE[key] || TYPE.you;
}

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

function ChannelMark({ channel, size = 22 }) {
  const c = channelOf(channel);
  // Filled rounded-square chip in the channel's own colour with a white glyph,
  // so WhatsApp / Instagram / SMS / Email read apart at a glance. The glyph is
  // sized to the chip; Instagram carries its magenta-to-orange gradient.
  return (
    <span
      aria-label={c.label}
      title={c.label}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.34),
        background: c.fill,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        boxShadow: '0 1px 1.5px rgba(146,64,94,0.14)',
      }}
    >
      <span
        className="material-symbols-outlined"
        aria-hidden
        style={{ fontSize: Math.round(size * 0.62), color: '#fff', lineHeight: 1, fontVariationSettings: "'FILL' 1" }}
      >
        {c.icon}
      </span>
    </span>
  );
}

// A pure thank-you or sign-off does not owe a reply, so it should never nag
// her. Anything else the client said last is a real reply owed.
const HANDLED_INTENTS = new Set(['review_thanks', 'greeting']);

// "Needs you" means a human reply is genuinely owed:
//   - Florrie escalated something and the client's last word still asks
//     something (a real open question), or
//   - the client had the last word and was not just saying thanks.
// Florrie's own replies and proactive housekeeping never count, even if the
// thread shows unread automated rows.
//
// An escalation whose latest inbound is a pure closer ("No worries x",
// "Thanks!") is treated as handled: there is nothing to answer, so it drops
// out of Waiting. We never demote a thread where the client actually asked
// something, so a missing intent stays owed.
function isCloserOnly(t) {
  return t.last_message_direction === 'inbound'
    && HANDLED_INTENTS.has(t.last_inbound_intent || 'unknown');
}
function needsYou(t) {
  if (t.needs_attention) return !isCloserOnly(t);
  if (t.last_message_direction !== 'inbound') return false;
  // Client spoke last. Skip pure acknowledgements (thanks, hello with nothing
  // to answer). Treat a missing intent as "owed" rather than silently hiding it.
  return !HANDLED_INTENTS.has(t.last_inbound_intent || 'unknown');
}

// Automated housekeeping: a reply Florrie sent or a nudge she lined up. These
// stay quiet and muted so real client messages and escalations pop above them.
function isAutomated(t) {
  if (needsYou(t)) return false;
  return t.last_message_type === 'auto_reply' || t.last_message_type === 'proactive';
}

export default function Inbox() {
  const [threads, setThreads] = useState(null);
  const [threadsError, setThreadsError] = useState(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('needs'); // 'needs' | 'all'
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
      // Keep the Today/Inbox nav badges in step when a thread is read or replied to.
      window.dispatchEvent(new Event('florrie:refresh-counts'));
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

  const needsCount = useMemo(
    () => (threads || []).filter(needsYou).length,
    [threads]
  );

  // Newest first within any group.
  const byRecency = (a, b) => new Date(b.last_message_at) - new Date(a.last_message_at);

  // Build the section structure the list renders.
  //   Needs-you view: one flat list of items owed a reply, newest first. No
  //                   group headers, no redundant "Needs you" tag, the whole
  //                   view is needs-you.
  //   All view:       "Waiting on you" first (real client messages and
  //                   escalations), then "Earlier" (everything Florrie has
  //                   already handled or sent on her own), each newest first.
  const sections = useMemo(() => {
    if (!threads) return null;
    const q = search.trim().toLowerCase();
    const match = (t) => !q || clientFullName(t).toLowerCase().includes(q);

    if (filter === 'needs') {
      const items = threads.filter(t => needsYou(t) && match(t)).sort(byRecency);
      return [{ key: 'needs', header: null, items, muted: false }];
    }

    const list = threads.filter(match);
    const waiting = list.filter(needsYou).sort(byRecency);
    const earlier = list.filter(t => !needsYou(t)).sort(byRecency);
    const out = [];
    if (waiting.length) out.push({ key: 'waiting', header: 'Waiting on you', items: waiting, muted: false });
    if (earlier.length) out.push({ key: 'earlier', header: 'Earlier', items: earlier, muted: true });
    return out;
  }, [threads, search, filter]);

  const visibleCount = useMemo(
    () => (sections || []).reduce((n, sec) => n + sec.items.length, 0),
    [sections]
  );

  function openThread(clientId) {
    setActiveClientId(clientId);
    setClientInUrl(clientId);
  }
  function closeThread() {
    setActiveClientId(null);
    setClientInUrl(null);
    loadThreads(); // refresh unread counts after reading
  }

  async function deleteThread(clientId) {
    setThreads(prev => (prev ? prev.filter(t => t.client_id !== clientId) : prev));
    if (activeClientId === clientId) { setActiveClientId(null); setClientInUrl(null); }
    try {
      await authFetch(`/api/inbox/thread/${clientId}`, { method: 'DELETE' });
    } catch (err) {
      logger.error({ err }, 'inbox deleteThread failed');
      loadThreads();
    }
  }

  // Mobile: conversation takes the whole screen when one is open.
  if (!isWide && activeClientId) {
    return <Conversation clientId={activeClientId} onBack={closeThread} onSent={loadThreads} />;
  }

  if (isWide) {
    return (
      <div style={S.pageWide}>
        <aside style={S.paneList}>
          <ThreadList
            sections={sections}
            visibleCount={visibleCount}
            error={threadsError}
            search={search}
            onSearch={setSearch}
            onOpen={openThread}
            onDelete={deleteThread}
            activeId={activeClientId}
            filter={filter}
            onFilter={setFilter}
            needsCount={needsCount}
            totalCount={threads?.length || 0}
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
        sections={sections}
        visibleCount={visibleCount}
        error={threadsError}
        search={search}
        onSearch={setSearch}
        onOpen={openThread}
        onDelete={deleteThread}
        filter={filter}
        onFilter={setFilter}
        needsCount={needsCount}
        totalCount={threads?.length || 0}
      />
    </div>
  );
}

function FilterChip({ active, onClick, label, count }) {
  return (
    <button type="button" onClick={onClick} style={{ ...S.filterChip, ...(active ? S.filterChipActive : {}) }}>
      {label}
      {count > 0 && (
        <span style={{ ...S.filterChipCount, ...(active ? S.filterChipCountActive : {}) }}>{count}</span>
      )}
    </button>
  );
}

function ThreadList({ sections, visibleCount, error, search, onSearch, onOpen, onDelete, activeId, filter, onFilter, needsCount, totalCount }) {
  const loading = sections === null;
  const isEmpty = !loading && visibleCount === 0;
  // In the needs-you view the whole list is needs-you, so the per-row tag is
  // redundant. Hide it there; show the informative type label in the all view.
  const hideTypeChip = filter === 'needs';

  return (
    <>
      <div style={S.headerWrap}>
        <PageHeader title="Inbox" subtitle="One thread per client. Florrie keeps the quiet ones tidy." />
      </div>

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

      <div style={S.filterRow}>
        <FilterChip active={filter === 'needs'} onClick={() => onFilter('needs')} label="Needs you" count={needsCount} />
        <FilterChip active={filter === 'all'} onClick={() => onFilter('all')} label="All" count={totalCount} />
      </div>

      {loading && <ThreadSkeleton />}
      {!loading && error && (
        <div style={S.errorCard}>
          Couldn't load conversations. Pull down to refresh, or check back in a bit.
        </div>
      )}
      {!loading && !error && isEmpty && (
        filter === 'needs' && totalCount > 0
          ? <CaughtUp onShowAll={() => onFilter('all')} />
          : <EmptyInbox />
      )}

      {!loading && !error && !isEmpty && sections.map(sec => (
        <section key={sec.key} style={S.section}>
          {sec.header && (
            <div style={S.sectionHead}>
              <span style={S.sectionTitle}>{sec.header}</span>
              <span style={S.sectionCount}>{sec.items.length}</span>
            </div>
          )}
          <ul style={S.list}>
            {sec.items.map(t => (
              <ThreadRow
                key={t.client_id}
                thread={t}
                active={t.client_id === activeId}
                onOpen={onOpen}
                onDelete={onDelete}
                muted={sec.muted}
                hideTypeChip={hideTypeChip}
              />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function ThreadRow({ thread, active, onOpen, onDelete, muted = false, hideTypeChip = false }) {
  const name = clientFullName(thread);
  const isUnread = thread.unread_count > 0;
  const flagged = !!thread.needs_attention;
  const owed = needsYou(thread);          // genuinely waiting on a human reply
  const automated = isAutomated(thread);  // Florrie's own housekeeping
  const type = typeMeta(thread.last_message_type);

  // What to show as the preview line.
  //  - Waiting on her: show the CLIENT's own latest words, so she sees what to
  //    answer, even when Florrie spoke last. No "You:" in this view.
  //  - Otherwise: the latest message, prefixed "You:" when it was outbound.
  let previewText;
  let previewPrefix = '';
  if (owed && thread.last_inbound_preview) {
    previewText = thread.last_inbound_preview;
  } else {
    previewText = thread.last_message_preview || '';
    if (thread.last_message_direction === 'outbound') previewPrefix = 'You: ';
  }

  // Explicit delete via a small menu. A swipe gesture fired on vertical scroll
  // and revealed delete across many rows at once, so this replaces it with a
  // deliberate, one-row-at-a-time affordance that never triggers from scrolling.
  const [menuOpen, setMenuOpen] = useState(false);
  const rowRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e) => { if (rowRef.current && !rowRef.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener('pointerdown', onDoc);
    return () => document.removeEventListener('pointerdown', onDoc);
  }, [menuOpen]);

  return (
    <li ref={rowRef} className="inbox-row-li" style={S.rowLi}>
      {active && <span aria-hidden style={S.selectedBar} />}
      <button
        type="button"
        className={active ? 'inbox-row inbox-row-active' : 'inbox-row'}
        onClick={() => onOpen(thread.client_id)}
        style={{
          ...S.row,
          ...((automated || muted) && !owed ? S.rowMuted : {}),
          background: active ? 'var(--accent-wash, #fbe9f0)' : 'transparent',
        }}
      >
        <span style={S.avatarWrap}>
          <span style={{
            ...S.avatar,
            ...((automated || muted) && !owed ? S.avatarMuted : {}),
          }} aria-hidden>
            {initialOf(name)}
          </span>
          <span style={S.avatarChannel}>
            <ChannelMark channel={thread.last_channel} size={(automated || muted) && !owed ? 15 : 16} />
          </span>
          {flagged && <span style={S.flagDot} title="Florrie escalated this" aria-label="Escalated" />}
        </span>

        <span style={S.rowBody}>
          <span style={S.rowTop}>
            <span style={{
              ...S.rowName,
              ...((automated || muted) && !owed ? S.rowNameMuted : {}),
              fontWeight: owed || isUnread ? 700 : (automated || muted) ? 500 : 600,
            }}>{name}</span>
            <span style={{ ...S.rowTime, ...((automated || muted) && !owed ? S.rowTimeMuted : {}) }}>
              {formatTimeShort(thread.last_message_at)}
            </span>
          </span>

          <span style={S.rowBottom}>
            <span style={{
              ...S.rowPreview,
              ...((automated || muted) && !owed ? S.rowPreviewMuted : {}),
              color: isUnread ? 'var(--text-primary, #1d1b19)' : 'var(--text-muted, #9B8A8E)',
              fontWeight: isUnread ? 600 : 400,
            }}>
              {previewPrefix}{previewText}
            </span>
            {isUnread && <span style={S.rowBadge}>{thread.unread_count}</span>}
          </span>

          {/* In the all view we still label Florrie's own housekeeping so she
              knows it was automated. We do NOT label "Waiting" rows: the
              section header already says it, and a per-card "handed back" tag
              just repeated on every escalation. An escalation is marked by the
              quiet pip on the avatar instead. */}
          {!hideTypeChip && !owed && (
            <span style={S.rowMetaRow}>
              <span style={S.typeChip}>
                <span style={{ ...S.typeDot, background: type.dot }} aria-hidden />
                {type.label}
              </span>
            </span>
          )}
        </span>
      </button>

      <button
        type="button"
        aria-label={`More options for ${name}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(e) => { e.stopPropagation(); setMenuOpen(o => !o); }}
        style={S.rowMenuBtn}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>more_vert</span>
      </button>

      {menuOpen && (
        <div role="menu" style={S.rowMenu}>
          <button
            type="button"
            role="menuitem"
            onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onDelete && onDelete(thread.client_id); }}
            style={S.rowMenuItem}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 17 }}>delete</span>
            Delete conversation
          </button>
        </div>
      )}
    </li>
  );
}

function ThreadSkeleton() {
  return (
    <ul style={S.list} aria-busy>
      {[0, 1, 2, 3].map(i => (
        <li key={i}>
          <div style={{ ...S.row, cursor: 'default' }}>
            <span style={{ ...S.avatar, background: 'var(--border-light, #F0ECE8)', color: 'transparent' }}>·</span>
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
      <span className="material-symbols-outlined" style={S.emptyIcon}>forum</span>
      <p style={S.emptyText}>Once a client messages you, they'll appear here.</p>
      <Link to="/whatsapp" style={S.emptyCta}>Send a template</Link>
      <p style={S.emptyHint}>A friendly hello is all it takes to get the conversation started.</p>
    </div>
  );
}

function CaughtUp({ onShowAll }) {
  return (
    <div style={S.empty}>
      <span className="material-symbols-outlined" style={S.emptyIcon}>task_alt</span>
      <p style={S.emptyText}>You're all caught up. Nothing is waiting on a reply.</p>
      <button type="button" onClick={onShowAll} style={S.caughtUpBtn}>See all conversations</button>
    </div>
  );
}

function EmptyConvoPlaceholder() {
  return (
    <div style={S.placeholder}>
      <span
        className="material-symbols-outlined"
        style={{
          fontSize: 30, color: 'var(--accent, #92405e)', marginBottom: 12,
          width: 68, height: 68, borderRadius: 34,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: 'linear-gradient(135deg, #ffe7ee 0%, #fdeef3 100%)',
          boxShadow: 'inset 0 0 0 1px rgba(146,64,94,0.08)',
        }}
      >
        forum
      </span>
      <div style={{ fontSize: 16, color: 'var(--text-secondary, #867277)', fontFamily: "'Noto Serif', Georgia, serif", fontStyle: 'italic' }}>
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
  const [suggestions, setSuggestions] = useState([]);
  const [draftOrigin, setDraftOrigin] = useState(null);
  const scrollerRef = useRef(null);
  const composerRef = useRef(null);

  const load = async () => {
    try {
      const json = await authFetch(`/api/inbox/thread/${encodeURIComponent(clientId)}`);
      setState({ status: 'ready', ...json });
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
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [state?.messages?.length]);

  useEffect(() => {
    if (state.status !== 'ready') { setSuggestions([]); return; }
    const msgs = state.messages || [];
    const last = msgs[msgs.length - 1];
    if (!last || last.direction !== 'inbound') { setSuggestions([]); return; }
    let cancelled = false;
    setSuggestions([]);
    authFetch(`/api/inbox/suggestions/${encodeURIComponent(clientId)}`)
      .then(json => { if (!cancelled) { setSuggestions(json.suggestions || []); setDraftOrigin(null); } })
      .catch(() => { if (!cancelled) setSuggestions([]); });
    return () => { cancelled = true; };
  }, [state.status, state.messages, clientId]);

  async function handleSend() {
    const body = composer.trim();
    if (!body || sending || !channel) return;
    if (!clientId) return;

    setSending(true);
    setSendError(null);

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
      message_type: 'you',
      image_url: null,
    };
    setState(prev => ({ ...prev, messages: [...(prev.messages || []), optimistic] }));
    setComposer('');

    try {
      const res = await authFetch('/api/inbox/send', {
        method: 'POST',
        body: JSON.stringify({ client_id: clientId, channel, body, draft_text: draftOrigin || undefined }),
      });
      setDraftOrigin(null);
      setState(prev => ({
        ...prev,
        messages: (prev.messages || []).map(m => m.id === tempId ? { ...res.message, message_type: 'you' } : m),
      }));
      onSent?.();
    } catch (err) {
      logger.error({ err }, 'inbox.send failed');
      setState(prev => ({
        ...prev,
        messages: (prev.messages || []).filter(m => m.id !== tempId),
      }));
      setComposer(body);
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
        <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 13 }}>Loading conversation…</div>
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

  const lastInbound = [...messages].reverse().find(m => m.direction === 'inbound');
  const lastInboundAge = lastInbound ? Date.now() - new Date(lastInbound.created_at).getTime() : Infinity;
  const showWaWindowHint = channel === 'whatsapp' && lastInboundAge > 24 * 60 * 60 * 1000;

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
        channel={channel}
      />

      <div ref={scrollerRef} style={S.scroller}>
        {messages.length === 0 && (
          <div style={{ padding: '40px 16px', color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
            No messages yet. Type below to start the conversation.
          </div>
        )}
        {messages.map(m => <Bubble key={m.id} msg={m} />)}
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
          <Link to="/clients" state={client?.id ? { clientId: client.id } : undefined} style={S.waHintLink}>Open profile</Link>
        </div>
      ) : (
        <div style={S.composerBar}>
          <div style={S.channelToggle} role="tablist" aria-label="Choose channel">
            {channels.map(c => {
              const meta = channelOf(c);
              const on = channel === c;
              return (
                <button
                  key={c}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => setChannel(c)}
                  style={{
                    ...S.channelPill,
                    background: on ? 'var(--accent, #92405e)' : 'var(--bg-card, #fff)',
                    color: on ? '#fff' : 'var(--accent, #92405e)',
                    borderColor: on ? 'var(--accent, #92405e)' : 'var(--border-light, #f0d2dd)',
                  }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 15, color: on ? '#fff' : meta.tint }} aria-hidden>
                    {meta.icon}
                  </span>
                  {meta.label}
                </button>
              );
            })}
          </div>

          {sendError && <div style={S.sendError}>{sendError}</div>}

          {suggestions.length > 0 && (
            <div style={S.suggestionRow}>
              {suggestions.map(s => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => { setComposer(s.text); setDraftOrigin(s.text); composerRef.current?.focus(); }}
                  style={S.suggestionChip}
                  title={s.text}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}

          <div style={S.composerRow}>
            <textarea
              ref={composerRef}
              value={composer}
              onChange={e => setComposer(e.target.value)}
              onKeyDown={handleKey}
              placeholder={`Reply via ${channelOf(channel).label}…`}
              rows={1}
              style={S.composerInput}
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={!composer.trim() || sending}
              style={{ ...S.sendBtn, opacity: composer.trim() && !sending ? 1 : 0.45 }}
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

/**
 * Who messages this person? Per-client autonomy (Levi + Ellie, 2026-07-04):
 * Auto (dial + regular detection decide) / Florrie handles / Drafts first /
 * Just me (Florrie never initiates; quiet drafts only). Tap to set; tapping
 * the active choice returns to Auto. Saves straight to the client row.
 */
function AutonomyPills({ clientId }) {
  const [value, setValue] = useState(undefined); // undefined = loading, null = auto
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase
          .from('clients')
          .select('messaging_autonomy')
          .eq('id', clientId)
          .maybeSingle();
        if (!cancelled) setValue(data?.messaging_autonomy || null);
      } catch { if (!cancelled) setValue(null); }
    })();
    return () => { cancelled = true; };
  }, [clientId]);

  if (value === undefined) return null;

  const OPTS = [
    { key: 'florrie', label: 'Florrie handles' },
    { key: 'drafts', label: 'Drafts first' },
    { key: 'just_me', label: 'Just me' },
  ];

  async function setAutonomy(next) {
    const v = value === next ? null : next; // tap active = back to Auto
    setValue(v);
    try {
      await supabase.from('clients').update({ messaging_autonomy: v }).eq('id', clientId);
    } catch { /* optimistic; reload corrects */ }
  }

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted, #9B8A8E)' }}>Who messages them</span>
      {OPTS.map(o => {
        const on = value === o.key;
        return (
          <button
            key={o.key}
            onClick={() => setAutonomy(o.key)}
            style={{
              padding: '4px 10px', minHeight: 26, borderRadius: 999, border: 'none',
              fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
              background: on ? 'var(--accent, #92405e)' : 'var(--tone-2, #f6e7dd)',
              color: on ? '#fff' : 'var(--text-secondary, #867277)',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            {o.label}
          </button>
        );
      })}
      {value === null && (
        <span style={{ fontSize: 11, color: 'var(--text-muted, #9B8A8E)' }}>Auto</span>
      )}
    </div>
  );
}

function ConvoHeader({ onBack, embedded, clientName, navigate, clientId, channel = null }) {
  return (
    <div style={S.convoHeader}>
      {!embedded && (
        <button onClick={onBack} style={S.backBtn} aria-label="Back to inbox">
          <span className="material-symbols-outlined" style={{ fontSize: 22 }}>chevron_left</span>
        </button>
      )}
      <span style={S.convoAvatar}>{initialOf(clientName)}</span>
      <div style={S.convoNameWrap}>
        <span style={S.convoNameRow}>
          <span style={S.convoName}>{clientName}</span>
          {channel && <ChannelMark channel={channel} size={18} />}
        </span>
        {clientId && (
          <button onClick={() => navigate('/clients', { state: { clientId } })} style={S.viewProfileBtn}>
            View profile
          </button>
        )}
        {clientId && <AutonomyPills clientId={clientId} />}
      </div>
    </div>
  );
}

function Bubble({ msg }) {
  const out = msg.direction === 'outbound';
  // Label outbound bubbles so the owner can tell what Florrie sent and why.
  const type = msg.message_type;
  let tag = null;
  if (out && type === 'auto_reply') tag = 'Florrie replied';
  else if (out && type === 'proactive') tag = 'Florrie reached out';
  else if (out && msg.ai_generated) tag = 'Florrie';

  return (
    <div style={{ ...S.bubbleRow, justifyContent: out ? 'flex-end' : 'flex-start' }}>
      <div style={{ ...S.bubbleStack, alignItems: out ? 'flex-end' : 'flex-start' }}>
        {tag && <span style={S.bubbleTag}>{tag}</span>}
        <div
          style={{
            ...S.bubble,
            background: out ? 'var(--accent, #92405e)' : '#fff4ee',
            color: out ? '#fff' : 'var(--text-primary, #1d1b19)',
            borderColor: out ? 'var(--accent, #92405e)' : 'rgba(146,64,94,0.10)',
            borderBottomLeftRadius: out ? 20 : 6,
            borderBottomRightRadius: out ? 6 : 20,
          }}
        >
          {msg.image_url && (
            <img src={msg.image_url} alt="" style={{ maxWidth: '100%', borderRadius: 10, marginBottom: msg.body ? 6 : 0 }} />
          )}
          {msg.body && <div style={S.bubbleText}>{msg.body}</div>}
          <div style={{ ...S.bubbleMeta, color: out ? 'rgba(255,255,255,0.78)' : '#9B8A8E' }}>
            <ChannelMark channel={msg.channel} size={14} />
            <span>{formatBubbleTime(msg.created_at)}</span>
            {msg.status === 'sending' && <span>· sending</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

const S = {
  page: {
    minHeight: '100vh',
    background: 'var(--bg, #fef8f4)',
    fontFamily: "'Plus Jakarta Sans', 'DM Sans', sans-serif",
    padding: '0 0 24px',
    maxWidth: 480,
    margin: '0 auto',
    color: 'var(--text-primary, #1d1b19)',
  },
  pageWide: {
    minHeight: '100vh',
    background: 'var(--bg, #fef8f4)',
    fontFamily: "'Plus Jakarta Sans', 'DM Sans', sans-serif",
    display: 'grid',
    gridTemplateColumns: 'minmax(320px, 392px) 1fr',
    gap: 16,
    padding: '0 16px 24px',
    maxWidth: 1120,
    margin: '0 auto',
    color: 'var(--text-primary, #1d1b19)',
  },
  paneList: {
    background: 'var(--tone-1, #fbf1ea)',
    borderRadius: 20,
    padding: '4px 0 14px',
    maxHeight: 'calc(100vh - 32px)',
    overflowY: 'auto',
    marginTop: 16,
  },
  paneConvo: {
    background: 'var(--tone-1, #fbf1ea)',
    borderRadius: 20,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 'calc(100vh - 32px)',
    overflow: 'hidden',
    marginTop: 16,
  },

  searchWrap: { position: 'relative', marginBottom: 10, padding: '0 18px' },
  searchIcon: {
    position: 'absolute', left: 32, top: '50%', transform: 'translateY(-50%)',
    fontSize: 18, color: 'var(--text-muted, #B5AFA8)',
  },
  searchInput: {
    width: '100%', boxSizing: 'border-box',
    padding: '11px 12px 11px 40px',
    border: 'none',
    borderRadius: 16, background: 'var(--tone-2, #f6e7dd)',
    fontSize: 14, fontFamily: 'inherit', color: 'var(--text-primary, #1d1b19)', outline: 'none',
    transition: 'border-color 0.15s ease, background 0.15s ease',
  },

  filterRow: { display: 'flex', gap: 8, marginBottom: 4, padding: '0 18px' },
  filterChip: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '8px 16px', minHeight: 44, borderRadius: 999,
    border: 'none',
    background: 'var(--tone-2, #f6e7dd)', color: 'var(--text-secondary, #867277)',
    fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
    transition: 'background 0.15s ease, color 0.15s ease, border-color 0.15s ease',
  },
  filterChipActive: { background: 'var(--accent, #92405e)', color: '#fff' },
  filterChipCount: {
    fontSize: 11, fontWeight: 700, padding: '1px 7px', borderRadius: 999,
    background: 'var(--accent-light, rgba(146,64,94,0.10))', color: 'var(--accent, #92405e)',
  },
  filterChipCountActive: { background: 'rgba(255,255,255,0.24)', color: '#fff' },

  headerWrap: { padding: '0 18px' },
  caughtUpBtn: {
    marginTop: 4, padding: '10px 18px', minHeight: 44,
    background: 'var(--tone-2, #f6e7dd)', color: 'var(--accent, #92405e)',
    border: 'none', borderRadius: 999,
    fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
  },

  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' },

  section: { marginBottom: 8 },
  sectionHead: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '20px 18px 7px',
  },
  sectionTitle: {
    fontSize: 11, fontWeight: 700, letterSpacing: '0.13em', textTransform: 'uppercase',
    color: 'var(--text-muted, #B5AFA8)',
  },
  sectionCount: {
    fontSize: 10.5, fontWeight: 700, color: 'var(--text-muted, #9a8f93)',
    background: 'rgba(146,64,94,0.06)', borderRadius: 999, padding: '1px 7px', minWidth: 16, textAlign: 'center',
  },
  // Each row is a slice of an open list, not a card. A single hairline warm
  // divider sits under it (the last row drops its own via :last-child below),
  // and the whole thing is full-bleed to the pane's horizontal padding.
  rowLi: { position: 'relative', listStyle: 'none' },
  // Selected: a 3px maroon bar pinned to the left edge, spanning the full row
  // height. Pairs with the warm tint applied to the button background.
  selectedBar: {
    position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, borderRadius: 0,
    background: 'var(--accent, #92405e)', zIndex: 1,
  },
  // Automated housekeeping: a touch denser and quieter so it recedes. No box,
  // no border, just the shared divider and a lighter density.
  rowMuted: {
    paddingTop: 9, paddingBottom: 9, gap: 11, opacity: 0.94,
  },
  // The airy list row. No border, no shadow, no rounded card. Hover and the
  // selected tint wash the full width (handled by .inbox-row + inline bg).
  row: {
    position: 'relative',
    width: '100%', display: 'flex', alignItems: 'center', gap: 13,
    padding: '13px 44px 13px 18px',
    border: 'none', borderRadius: 0, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
    boxShadow: 'none',
    transition: 'background 0.16s ease',
    WebkitTapHighlightColor: 'transparent',
  },
  rowMenuBtn: {
    position: 'absolute', top: '50%', transform: 'translateY(-50%)', right: 8,
    width: 44, height: 44, borderRadius: 22,
    background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted, #C4BBB6)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'inherit',
    transition: 'color 0.15s ease, background 0.15s ease', zIndex: 3,
  },
  rowMenu: {
    position: 'absolute', top: 38, right: 6, zIndex: 5,
    background: 'var(--bg-card, #fff)', border: '1px solid var(--border-light, #F0ECE8)',
    borderRadius: 14, boxShadow: '0 10px 28px rgba(146,64,94,0.16)', padding: 5, minWidth: 188,
  },
  rowMenuItem: {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
    padding: '9px 11px', borderRadius: 9, border: 'none', background: 'transparent',
    color: 'var(--danger, #c2410c)', fontSize: 13, fontWeight: 600, cursor: 'pointer',
    fontFamily: 'inherit', textAlign: 'left',
  },
  avatarWrap: { position: 'relative', flexShrink: 0 },
  avatar: {
    width: 44, height: 44, borderRadius: 22,
    background: 'linear-gradient(135deg, #ffe0e7 0%, #ffbecd 100%)',
    color: '#92405e', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 16.5, fontWeight: 700, fontFamily: "'Noto Serif', Georgia, serif",
    boxShadow: 'inset 0 0 0 1px rgba(146,64,94,0.05)',
  },
  avatarMuted: {
    width: 38, height: 38, borderRadius: 19, fontSize: 15,
    background: 'var(--border-light, #F0ECE8)',
    color: 'var(--text-muted, #9a8f93)',
  },
  // The channel mark rides the avatar's bottom-right corner so the row reads
  // cleanly, with a cream ring punching it off the photo. Uses ChannelMark.
  avatarChannel: {
    position: 'absolute', right: -3, bottom: -3, borderRadius: 8,
    padding: 2, background: 'var(--bg-card, #fff)',
    display: 'inline-flex', lineHeight: 0,
    boxShadow: '0 1px 2px rgba(146,64,94,0.16)',
  },
  flagDot: {
    position: 'absolute', top: -1, left: -1, width: 12, height: 12,
    borderRadius: 6, background: '#c2410c', border: '2px solid var(--bg-card, #fff)', zIndex: 2,
  },
  rowBody: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 },
  rowTop: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  rowName: { fontSize: 15, color: 'var(--text-primary, #1d1b19)', letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  rowTime: { fontSize: 11, color: 'var(--text-muted, #B5AFA8)', flexShrink: 0, fontWeight: 500, letterSpacing: '0.01em' },
  rowBottom: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 },
  rowPreview: {
    fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0,
    letterSpacing: '-0.003em', lineHeight: 1.35,
  },
  // Quieter type ramp for the Earlier (handled) section so it visibly recedes.
  rowNameMuted: { fontSize: 13.5, color: 'var(--text-secondary, #867277)' },
  rowTimeMuted: { color: 'var(--text-muted, #B5AFA8)' },
  rowPreviewMuted: { fontSize: 12.5 },
  rowBadge: {
    fontSize: 10.5, fontWeight: 700, color: '#fff', background: 'var(--accent, #92405e)',
    padding: '1px 7px', borderRadius: 20, minWidth: 17, textAlign: 'center', flexShrink: 0,
    lineHeight: 1.5, boxShadow: '0 1px 2px rgba(146,64,94,0.22)',
  },
  rowMetaRow: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 1 },
  typeChip: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    fontSize: 11, fontWeight: 600, color: 'var(--text-muted, #9a8f93)',
    letterSpacing: '0.01em',
  },
  typeDot: { width: 6, height: 6, borderRadius: 3, flexShrink: 0 },

  empty: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    padding: '64px 22px', textAlign: 'center', gap: 12,
  },
  emptyIcon: {
    fontSize: 32, color: 'var(--accent, #92405e)', lineHeight: 1,
    width: 72, height: 72, borderRadius: 36,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: 'linear-gradient(135deg, #ffe7ee 0%, #fdeef3 100%)',
    boxShadow: 'inset 0 0 0 1px rgba(146,64,94,0.08)', marginBottom: 6,
  },
  emptyText: { fontSize: 14.5, color: 'var(--text-secondary, #867277)', lineHeight: 1.5, margin: 0, maxWidth: 280 },
  emptyCta: {
    marginTop: 6, padding: '10px 18px', background: 'var(--accent, #92405e)', color: '#fff',
    borderRadius: 999, fontSize: 13, fontWeight: 600, textDecoration: 'none', fontFamily: 'inherit',
  },
  emptyHint: { fontSize: 12, color: 'var(--text-muted, #B5AFA8)', margin: 0, maxWidth: 260 },
  errorCard: {
    margin: '12px 18px', padding: 14, background: '#FFF8F0', border: '1px solid #FFE8CC',
    borderRadius: 12, fontSize: 13, color: '#7B5E00', lineHeight: 1.5,
  },

  placeholder: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24 },

  convoFull: {
    minHeight: '100vh', background: 'var(--bg, #fef8f4)',
    fontFamily: "'Plus Jakarta Sans', 'DM Sans', sans-serif",
    display: 'flex', flexDirection: 'column', color: 'var(--text-primary, #1d1b19)', paddingBottom: 120,
  },
  convoEmbedded: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 },
  convoHeader: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
    background: 'var(--bg-card, #fff)', borderBottom: '1px solid var(--border-light, #F0ECE8)',
    position: 'sticky', top: 0, zIndex: 2,
  },
  backBtn: {
    background: 'none', border: 'none', color: 'var(--accent, #92405e)', padding: 4, cursor: 'pointer',
    fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 44, minHeight: 44,
  },
  convoAvatar: {
    width: 36, height: 36, borderRadius: 18,
    background: 'linear-gradient(135deg, #ffd9e2 0%, #ffb8c8 100%)', color: '#92405e',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 14, fontWeight: 700, fontFamily: "'Noto Serif', Georgia, serif",
  },
  convoNameWrap: { display: 'flex', flexDirection: 'column', gap: 1, flex: 1, minWidth: 0 },
  convoNameRow: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 },
  convoName: {
    fontSize: 15, fontWeight: 700, color: 'var(--text-primary, #1d1b19)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
  },
  viewProfileBtn: {
    background: 'none', border: 'none', color: 'var(--accent, #92405e)', fontSize: 11, fontWeight: 600,
    padding: 0, minHeight: 44, display: 'inline-flex', alignItems: 'center', cursor: 'pointer', fontFamily: 'inherit', alignSelf: 'flex-start', textDecoration: 'underline',
  },

  scroller: { flex: 1, overflowY: 'auto', padding: '12px 14px 8px', display: 'flex', flexDirection: 'column', gap: 10 },
  bubbleRow: { display: 'flex', width: '100%' },
  bubbleStack: { display: 'flex', flexDirection: 'column', gap: 3, maxWidth: '78%' },
  bubbleTag: { fontSize: 9.5, fontWeight: 700, color: 'var(--accent, #92405e)', letterSpacing: '0.05em', textTransform: 'uppercase', paddingLeft: 3, opacity: 0.85 },
  bubble: {
    padding: '10px 14px', border: '1px solid', borderRadius: 20,
    boxShadow: '0 1px 2px rgba(146,64,94,0.06)',
  },
  bubbleText: { fontSize: 14, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  bubbleMeta: { fontSize: 10, marginTop: 4, display: 'flex', alignItems: 'center', gap: 5, justifyContent: 'flex-end' },

  waHint: {
    margin: '0 14px 8px', padding: '10px 12px', background: '#FFF8E1', border: '1px solid #FFE082',
    borderRadius: 12, fontSize: 12, color: '#7B5E00', lineHeight: 1.5,
  },
  waHintLink: { color: '#7B5E00', fontWeight: 700, marginLeft: 6, textDecoration: 'underline' },
  noContact: {
    margin: '0 14px 14px', padding: 12, background: '#FDECEA', border: '1px solid #F5C6C0',
    borderRadius: 12, fontSize: 12, color: '#8A2A1C', lineHeight: 1.5,
  },

  composerBar: {
    padding: '8px 12px 16px', background: 'var(--bg-card, #fff)',
    borderTop: '1px solid var(--border-light, #F0ECE8)',
    display: 'flex', flexDirection: 'column', gap: 8, position: 'sticky', bottom: 0,
  },
  channelToggle: { display: 'flex', gap: 6, overflowX: 'auto' },
  channelPill: {
    padding: '6px 12px', minHeight: 44, borderRadius: 999, border: '1px solid', fontSize: 12, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 5,
    whiteSpace: 'nowrap', flexShrink: 0,
  },
  suggestionRow: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 },
  suggestionChip: {
    background: 'var(--accent-wash, #fdeef3)', border: '1px solid rgba(146,64,94,0.16)', color: 'var(--accent, #92405e)',
    borderRadius: 999, padding: '13px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
    lineHeight: 1.2, maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    transition: 'background 0.15s ease',
  },
  composerRow: { display: 'flex', alignItems: 'flex-end', gap: 8 },
  composerInput: {
    flex: 1, padding: '11px 15px', border: '1px solid var(--border-light, #F0ECE8)', borderRadius: 20,
    background: 'var(--bg, #fef8f4)', fontSize: 14, fontFamily: 'inherit', resize: 'none', maxHeight: 140,
    color: 'var(--text-primary, #1d1b19)', outline: 'none', lineHeight: 1.4,
    transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
  },
  sendBtn: {
    width: 44, height: 44, borderRadius: 22, border: 'none', background: 'var(--accent, #92405e)', color: '#fff',
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    boxShadow: '0 2px 6px rgba(146,64,94,0.24)', transition: 'opacity 0.15s ease, transform 0.1s ease',
  },
  sendError: {
    fontSize: 12, color: '#8A2A1C', background: '#FDECEA', border: '1px solid #F5C6C0', borderRadius: 10, padding: '6px 10px',
  },

  skelLine: { height: 12, width: '60%', borderRadius: 6, background: 'var(--border-light, #F0ECE8)', display: 'block' },
  skelLineShort: { height: 10, width: '40%', borderRadius: 5, background: 'var(--border-light, #F0ECE8)', display: 'block', marginTop: 4 },
};

if (typeof document !== 'undefined' && !document.getElementById('inbox-bold-css')) {
  const s = document.createElement('style');
  s.id = 'inbox-bold-css';
  s.textContent = `
    .inbox-row-li { border-bottom: 1px solid rgba(146,64,94,0.07); }
    .inbox-row-li:last-child { border-bottom: none; }
    .inbox-row:hover { background: rgba(146,64,94,0.045) !important; }
    .inbox-row-active, .inbox-row-active:hover { background: var(--accent-wash, #fbe9f0) !important; }
  `;
  document.head.appendChild(s);
}
