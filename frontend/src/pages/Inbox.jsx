import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import PageHeader from '../components/ui/PageHeader.jsx';
import { bloom } from '../lib/bloom.js';

/**
 * Messages, as a surface she acts on rather than a list she reads.
 *
 * The old page was seventy identical rows and a 99+ badge, which told her that
 * something was happening and nothing about what. This one answers the only
 * question she actually has, which is who is waiting, and then lets her clear
 * them without opening anything:
 *
 *   - A headline that states the real number of people waiting, and a quiet
 *     line for the work Florrie did on her own.
 *   - One card per waiting person: who they are, how long they have waited,
 *     their own last words, and where Florrie has drafted the answer, the
 *     answer itself with Send and Edit. Send goes through the escalation
 *     resolve endpoint, so it is delivered, logged and resolved exactly as it
 *     would be from the Escalations page.
 *   - One quiet Everything row for the rest. That is the only other view:
 *     lanes and chips just filed the noise more neatly.
 *
 * Salon owners think "Sarah", not "Sarah on WhatsApp", so a client is still
 * one thread and the channel rides along as metadata. Mobile-first single
 * column; from 768px the list and the conversation sit side by side.
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
  // Names can arrive as a handle ("@nixiebeauty"); the @ is not an initial.
  const clean = (name || 'C').trim().replace(/^@+/, '');
  return clean.charAt(0).toUpperCase() || 'C';
}

// How long a needs-you thread has been waiting on her. Amber chip fuel.
function waitingLabel(t) {
  const ts = t.last_inbound_at || (t.last_message_direction === 'inbound' ? t.last_message_at : null);
  if (!ts) return null;
  const mins = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `waiting ${mins}m`;
  const h = Math.round(mins / 60);
  if (h < 24) return `waiting ${h}h`;
  return `waiting ${Math.round(h / 24)}d`;
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
const NEEDS_YOU_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
function needsYou(t) {
  if (t.needs_attention) return !isCloserOnly(t);
  if (t.last_message_direction !== 'inbound') return false;
  // A message older than a week that she never answered has answered itself.
  // It drops to Everyone else instead of guilt-tripping her with "waiting 17d".
  if (Date.now() - new Date(t.last_message_at).getTime() > NEEDS_YOU_WINDOW_MS) return false;
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

/**
 * Segments. The backend labels every thread with exactly one of these on
 * GET /api/inbox/threads, and both sides read the same answer so the list and
 * the counts can never disagree.
 *
 *   needs  = a human reply is genuinely owed
 *   client = someone she has a relationship with
 *   new    = first contact, not a client yet
 *   social = Instagram fluff: pitches, randoms, anything flagged junk
 *
 * Junk is settled before "needs" on the backend on purpose, so an unanswered
 * cold pitch cannot walk back into the urgent lane.
 */
const SEGMENTS = ['needs', 'client', 'new', 'social'];

// A cached response from before segments existed still has to render. This is
// deliberately coarse: without the booking history the backend has, it cannot
// tell a regular from a stranger, so it never guesses 'new'. Every thread
// still lands somewhere, which is the only thing that really matters here.
function fallbackSegment(t) {
  if (t.is_junk) return 'social';
  if (needsYou(t)) return 'needs';
  if (t.last_channel === 'instagram' && isPlaceholderName(clientFullName(t))) return 'social';
  return 'client';
}

// Never returns anything outside SEGMENTS: a value we do not recognise would
// otherwise drop the thread out of every section and lose it silently.
function segmentOf(t) {
  if (SEGMENTS.includes(t.segment)) return t.segment;
  if (t.segment) return 'client';
  return fallbackSegment(t);
}

// Instagram contacts usually arrive with no name, so the webhook stores
// "Instagram User". For those the @handle IS the identity, so it replaces the
// placeholder rather than sitting next to it.
const PLACEHOLDER_NAMES = new Set(['instagram user', 'client', 'unknown']);
function isPlaceholderName(name) {
  return !name || PLACEHOLDER_NAMES.has(name.trim().toLowerCase());
}
function handleOf(t) {
  const h = (t.instagram_username || '').trim().replace(/^@/, '');
  return h || null;
}
function displayName(t) {
  const name = clientFullName(t);
  const handle = handleOf(t);
  if (handle && isPlaceholderName(name)) return `@${handle}`;
  return name;
}
// The handle shown BESIDE a real name. Null when the handle is already doing
// duty as the name, so a row never reads "@ellie @ellie".
function secondaryHandle(t) {
  const handle = handleOf(t);
  if (!handle || isPlaceholderName(clientFullName(t))) return null;
  return `@${handle}`;
}

// One page, two states: the people actually waiting, and a drawer holding
// everything else. Chips only ever filed the noise more neatly, and a tidier
// pile of noise is still noise on screen. What she needs is not a filter, it
// is the answer, on the card, sendable without opening anything.

// Numbers read as words up to ten, because "Two people waiting" is a sentence
// and "2 people waiting" is a metric. Past ten a digit takes in faster.
const NUMBER_WORDS = ['No one', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
function waitingHeadline(n) {
  if (n <= 0) return 'No one waiting';
  const word = n <= 10 ? NUMBER_WORDS[n] : String(n);
  return `${word} ${n === 1 ? 'person' : 'people'} waiting`;
}

// Florrie's own work today, counted off the threads the page already holds, so
// the line costs no extra call and can never contradict the list under it. A
// thread counts when its newest message is one Florrie sent herself, it landed
// today, and nothing is owed back. Thread level is all the payload carries, so
// the copy says conversations rather than claiming a message count it cannot
// see. Zero means no line at all: a hollow "handled 0" is worse than silence.
function handledTodayCount(threads) {
  if (!threads) return 0;
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  return threads.filter(t => (
    (t.last_message_type === 'auto_reply' || t.last_message_type === 'proactive')
    && !needsYou(t)
    && new Date(t.last_message_at) >= startOfDay
  )).length;
}

// Regular or new, decided on evidence: the backend flags anyone who has ever
// booked. A named one-time enquiry is not a regular, and a stranger whose
// Instagram profile happens to carry a real name is not a returning client.
function relationLabel(t) {
  return t.is_known_client ? 'Regular' : 'New';
}

// Two initials where there are two names, so the avatar identifies rather than
// decorates. Handles lose their @ first (same rule as initialOf).
function initialsOf(name) {
  const clean = (name || '').trim().replace(/^@+/, '');
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return initialOf(name);
}

export default function Inbox() {
  const [threads, setThreads] = useState(null);
  const [threadsError, setThreadsError] = useState(null);
  const [search, setSearch] = useState('');
  // A drawer, not a filter. Closed she sees only the people waiting; open she
  // gets the whole list and the search box that belongs with it.
  const [showEverything, setShowEverything] = useState(false);
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

  // Newest first within any group.
  const byRecency = (a, b) => new Date(b.last_message_at) - new Date(a.last_message_at);

  // One pass: apply the search, drop each thread into its segment, sort each
  // lane newest first. Search matches the name AND the @handle, because half
  // of her Instagram contacts have no name to search for.
  const grouped = useMemo(() => {
    if (!threads) return null;
    const out = { needs: [], client: [], new: [], social: [] };
    const q = search.trim().toLowerCase().replace(/^@/, '');
    const match = (t) => {
      if (!q) return true;
      const handle = handleOf(t);
      return clientFullName(t).toLowerCase().includes(q)
        || (handle ? handle.toLowerCase().includes(q) : false);
    };
    for (const t of threads) {
      if (!match(t)) continue;
      out[segmentOf(t)].push(t);
    }
    for (const key of SEGMENTS) out[key].sort(byRecency);
    return out;
  }, [threads, search]);

  // The cards. Only the 'needs' lane earns one: a card is a thing she has to
  // decide about, so anything that does not want her must never become one.
  // Built off the raw threads rather than the searched ones, because the
  // search belongs to the drawer: typing a name in there must not make the
  // headline claim nobody is waiting.
  const waiting = useMemo(() => (
    threads ? threads.filter(t => segmentOf(t) === 'needs').sort(byRecency) : []
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [threads]);

  // The drawer's contents: one flat list, newest first. Junk stays out unless
  // she is searching for it, because a quiet lane for noise is still noise.
  const everything = useMemo(() => {
    if (!grouped) return [];
    const searching = Boolean(search.trim());
    return SEGMENTS
      .filter(key => searching || key !== 'social')
      .flatMap(key => grouped[key])
      .sort(byRecency);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grouped, search]);

  const handledToday = useMemo(() => handledTodayCount(threads), [threads]);

  function openThread(clientId) {
    setActiveClientId(clientId);
    setClientInUrl(clientId);
  }
  function closeThread() {
    setActiveClientId(null);
    setClientInUrl(null);
    loadThreads(); // refresh unread counts after reading
  }

  // A card she has sent is done with: drop it straight away so the stack
  // shrinks under her thumb, then resync so the thread comes back where it now
  // belongs (answered, in the drawer) rather than in the waiting stack.
  function handleSent(clientId) {
    setThreads(prev => (prev ? prev.filter(t => t.client_id !== clientId) : prev));
    window.dispatchEvent(new Event('florrie:refresh-counts'));
    loadThreads();
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

  const listProps = {
    waiting,
    everything,
    handledToday,
    loading: threads === null,
    error: threadsError,
    search,
    onSearch: setSearch,
    onOpen: openThread,
    onDelete: deleteThread,
    onSent: handleSent,
    showEverything,
    onToggleEverything: () => setShowEverything(v => !v),
    totalCount: threads?.length || 0,
  };

  // Mobile: conversation takes the whole screen when one is open.
  if (!isWide && activeClientId) {
    return <Conversation clientId={activeClientId} onBack={closeThread} onSent={loadThreads} />;
  }

  if (isWide) {
    return (
      <div style={S.pageWide}>
        <aside style={S.paneList}>
          <ThreadList {...listProps} activeId={activeClientId} />
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
      <ThreadList {...listProps} />
    </div>
  );
}

/**
 * The page, top to bottom: how many people are waiting, a card for each of
 * them, and one quiet row that opens everything else.
 */
function ThreadList({
  waiting, everything, handledToday, loading, error,
  search, onSearch, onOpen, onDelete, onSent,
  activeId, showEverything, onToggleEverything, totalCount,
}) {
  const searching = Boolean(search.trim());
  const nothingAtAll = !loading && !error && totalCount === 0;

  return (
    <>
      <div style={S.headerWrap}>
        <PageHeader
          title={waitingHeadline(waiting.length)}
          subtitle={handledToday > 0
            ? `Florrie handled ${handledToday} on her own today.`
            : undefined}
        />
      </div>

      {loading && <ThreadSkeleton />}
      {!loading && error && (
        <div style={S.errorCard}>
          Couldn't load conversations. Pull down to refresh, or check back in a bit.
        </div>
      )}

      {nothingAtAll && <EmptyInbox />}

      {!loading && !error && totalCount > 0 && (
        <>
          {waiting.length > 0 && (
            <div style={S.cardStack}>
              {waiting.map(t => (
                <ActionCard
                  key={t.client_id}
                  thread={t}
                  active={t.client_id === activeId}
                  onOpen={onOpen}
                  onSent={onSent}
                />
              ))}
            </div>
          )}

          {waiting.length === 0 && <AllClear />}

          {/* The only other view. One row, no chips: she taps it when she wants
              a specific person, and it is closed the rest of the time. */}
          <button
            type="button"
            onClick={onToggleEverything}
            aria-expanded={showEverything}
            style={S.everythingRow}
          >
            <span className="material-symbols-outlined" style={S.everythingIcon} aria-hidden>search</span>
            <span style={S.everythingLabel}>Everything</span>
            <span style={S.everythingCount}>{everything.length}</span>
          </button>

          {showEverything && (
            <>
              <div style={S.searchWrap}>
                <span className="material-symbols-outlined" style={S.searchIcon} aria-hidden>search</span>
                <input
                  type="search"
                  value={search}
                  onChange={e => onSearch(e.target.value)}
                  placeholder="Search by name or @handle"
                  style={S.searchInput}
                />
              </div>

              {everything.length === 0 ? (
                searching
                  ? <NoMatches onClear={() => onSearch('')} />
                  : <DrawerEmpty />
              ) : (
                <ul style={S.list}>
                  {everything.map(t => (
                    <ThreadRow
                      key={t.client_id}
                      thread={t}
                      active={t.client_id === activeId}
                      onOpen={onOpen}
                      onDelete={onDelete}
                      muted={segmentOf(t) === 'social'}
                      quiet={segmentOf(t) === 'social'}
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}

/**
 * One person waiting, answerable without opening anything.
 *
 * The card carries what she needs to decide (who, how long they have waited,
 * their own words) and, when Florrie has one ready, the reply itself. Send
 * goes through the same escalation resolve endpoint the Escalations page uses,
 * so a reply sent from a card is delivered on the client's own channel, logged
 * back into the thread and marked resolved exactly as it would be there. Edit
 * opens the conversation, because editing wants the full thread around it.
 */
function ActionCard({ thread, active = false, onOpen, onSent }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);

  const name = displayName(thread);
  const draft = (thread.draft_reply || '').trim();
  const canSend = Boolean(draft && thread.draft_message_id);
  // Her own last words are what needs answering, even when Florrie spoke last.
  const said = thread.last_inbound_preview || thread.last_message_preview || '';
  const waited = waitingLabel(thread);

  async function send(e) {
    e.stopPropagation();
    if (sending || !canSend) return;
    setSending(true);
    setError(null);
    try {
      await authFetch(`/api/escalations/${encodeURIComponent(thread.draft_message_id)}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ action: 'send_as_is' }),
      });
      bloom();
      onSent?.(thread.client_id);
      // No state reset: the parent drops the card the moment this resolves.
    } catch (err) {
      logger.error({ err }, 'inbox action card send failed');
      // Put the card back exactly as it was and say what went wrong, so a
      // failed send can never read as a sent one.
      setSending(false);
      setError(err.message || 'Could not send. Open the conversation and try there.');
    }
  }

  return (
    <article style={{ ...S.card, ...(active ? S.cardActive : {}) }}>
      <button
        type="button"
        onClick={() => onOpen(thread.client_id)}
        style={S.cardOpen}
        aria-label={`Open conversation with ${name}`}
      >
        <span style={S.cardTopRow}>
          <span style={S.cardAvatar} aria-hidden>{initialsOf(name)}</span>
          <span style={S.cardWho}>
            <span style={S.cardName}>{name}</span>
            <span style={S.cardMeta}>
              {relationLabel(thread)}{waited ? ` · ${waited}` : ''}
            </span>
          </span>
          <ChannelMark channel={thread.last_channel} size={20} />
        </span>
        {said && <span style={S.cardQuote}>{'“'}{said}{'”'}</span>}
      </button>

      {canSend && (
        <>
          {/* Recessed so the drafted reply reads as Florrie's words sitting
              inside the card, not as something the client said. */}
          <div style={S.draftPanel}>
            <span style={S.draftContext}>{'\u{1F337}'} Florrie has this ready</span>
            <div style={S.draftPanelText}>{draft}</div>
          </div>
          <div style={S.cardActions}>
            <button type="button" onClick={send} disabled={sending} style={S.cardSend}>
              {sending ? 'Sending…' : 'Send'}
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onOpen(thread.client_id); }}
              disabled={sending}
              style={S.cardEdit}
            >
              Edit
            </button>
          </div>
        </>
      )}

      {error && <div style={S.cardError}>{error}</div>}
    </article>
  );
}

// `quiet` is the Social lane. Nothing in it may shout: no waiting chip, no
// escalation dot, no bold unread, no maroon badge. She should be able to
// scroll past the whole lane and lose nothing.
function ThreadRow({ thread, active, onOpen, onDelete, muted = false, quiet = false, hideTypeChip = false }) {
  const name = displayName(thread);
  const handle = secondaryHandle(thread);
  const isUnread = thread.unread_count > 0;
  const loud = isUnread && !quiet;
  const flagged = !quiet && !!thread.needs_attention;
  const owed = !quiet && needsYou(thread);  // genuinely waiting on a human reply
  const automated = isAutomated(thread);    // Florrie's own housekeeping
  const type = typeMeta(thread.last_message_type);
  // A count in the thousands is not information, it is wallpaper. Cap it.
  const unreadLabel = thread.unread_count > 99 ? '99+' : thread.unread_count;

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
            boxShadow: `0 0 0 2px ${channelOf(thread.last_channel).tint}${(automated || muted) && !owed ? '55' : '99'}`,
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
            <span style={S.rowNameWrap}>
              <span style={{
                ...S.rowName,
                ...((automated || muted) && !owed ? S.rowNameMuted : {}),
                fontWeight: owed || loud ? 700 : (automated || muted) ? 500 : 600,
              }}>{name}</span>
              {/* The handle is how she recognises an Instagram contact, so it
                  rides beside the name rather than hiding on the profile. */}
              {handle && <span style={S.rowHandle}>{handle}</span>}
            </span>
            <span style={{ ...S.rowTime, ...((automated || muted) && !owed ? S.rowTimeMuted : {}) }}>
              {formatTimeShort(thread.last_message_at)}
            </span>
          </span>

          <span style={S.rowBottom}>
            <span style={{
              ...S.rowPreview,
              ...((automated || muted) && !owed ? S.rowPreviewMuted : {}),
              color: loud ? 'var(--text-primary, #1d1b19)' : 'var(--text-muted, #9B8A8E)',
              fontWeight: loud ? 600 : 400,
            }}>
              {previewPrefix}{previewText}
            </span>
            {isUnread && (
              <span style={quiet ? S.rowBadgeQuiet : S.rowBadge}>{unreadLabel}</span>
            )}
          </span>

          {/* Owed rows: an amber waiting-time chip, plus a petal line when
              Florrie escalated (she has something prepared for a yes or no).
              Florrie's own housekeeping keeps its quiet type label. */}
          {owed && waitingLabel(thread) && (
            <span style={S.rowMetaRow}>
              <span style={S.waitChip}>{waitingLabel(thread)}</span>
              {flagged && <span style={S.petalNote}>{'\u{1F337}'} needs your yes or no</span>}
            </span>
          )}
          {!hideTypeChip && !owed && !quiet && (
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

// Nobody waiting. One quiet line, no illustration and no button: an empty
// action stack is the normal state of a good day, not an event.
function AllClear() {
  return (
    <div style={S.allClear}>
      <span className="material-symbols-outlined" style={S.allClearIcon} aria-hidden>task_alt</span>
      <span>Nothing needs you. Florrie has the rest.</span>
    </div>
  );
}

// The drawer opened on nothing. Only reachable when every thread she has is
// junk, so it says so plainly instead of implying the inbox is broken.
function DrawerEmpty() {
  return (
    <div style={S.allClear}>
      <span>Nothing else here. Florrie keeps pitches and randoms out of your way.</span>
    </div>
  );
}

function NoMatches({ onClear }) {
  return (
    <div style={S.empty}>
      <span className="material-symbols-outlined" style={S.emptyIcon}>search_off</span>
      <p style={S.emptyText}>Nobody by that name or handle. Try a shorter search.</p>
      <button type="button" onClick={onClear} style={S.caughtUpBtn}>Clear search</button>
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

  // bodyOverride lets a failed bubble's Retry resend its own text without
  // going through the composer, which may already hold something else.
  async function handleSend(bodyOverride) {
    const body = (typeof bodyOverride === 'string' ? bodyOverride : composer).trim();
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
    if (typeof bodyOverride !== 'string') setComposer('');

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

  const { client, messages = [], meta = null, drafts = [] } = state;
  const storedName = [client?.first_name, client?.last_name].filter(Boolean).join(' ');
  const igHandle = (client?.instagram_username || '').trim().replace(/^@/, '') || null;
  // Same rule as the list: when all we have is "Instagram User", the handle is
  // the only identity she can recognise, so it becomes the title.
  const fullName = igHandle && isPlaceholderName(storedName) ? `@${igHandle}` : (storedName || 'Client');
  const headerHandle = igHandle && !isPlaceholderName(storedName) ? `@${igHandle}` : null;

  // Fold runs of consecutive Florrie-sent messages (2+) behind a quiet
  // divider, so stretches she handled alone read as one line, not noise.
  const renderItems = (() => {
    const out = [];
    let run = [];
    let day = null;
    const flush = () => {
      if (run.length >= 2) out.push({ divider: true, id: `div-${run[0].id}`, count: run.length });
      run.forEach(m => out.push(m));
      run = [];
    };
    // Local day, not the ISO date slice: messages carry true UTC timestamps,
    // so a 00:30 BST message would otherwise be filed under yesterday.
    const dayKeyOf = (m) => {
      const d = new Date(m.created_at);
      return Number.isNaN(d.getTime()) ? null : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    };
    for (const m of messages) {
      const key = dayKeyOf(m);
      if (key && key !== day) {
        // Close any run first: the date has to sit above the stretch it opens.
        flush();
        out.push({ dateDivider: true, id: `day-${key}`, iso: m.created_at });
        day = key;
      }
      const florrieSent = m.direction === 'outbound' && (m.message_type === 'auto_reply' || m.message_type === 'proactive');
      if (florrieSent) run.push(m);
      else { flush(); out.push(m); }
    }
    flush();
    return out;
  })();

  function removeDraft(id) {
    setState(prev => ({ ...prev, drafts: (prev.drafts || []).filter(d => d.id !== id) }));
  }

  const lastInbound = [...messages].reverse().find(m => m.direction === 'inbound');
  const lastInboundAge = lastInbound ? Date.now() - new Date(lastInbound.created_at).getTime() : Infinity;
  const showWaWindowHint = channel === 'whatsapp' && lastInboundAge > 24 * 60 * 60 * 1000;

  const channels = ['instagram', 'whatsapp', 'sms', 'email'].filter(c => {
    if (c === 'instagram') return !!client?.has_instagram;
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
        handle={headerHandle}
        navigate={navigate}
        clientId={client?.id}
        channel={channel}
        meta={meta}
        initialAutonomy={client?.messaging_autonomy ?? null}
      />

      <div ref={scrollerRef} style={S.scroller}>
        {messages.length === 0 && (
          <div style={{ padding: '40px 16px', color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
            No messages yet. Type below to start the conversation.
          </div>
        )}
        {renderItems.map(m => m.dateDivider
          ? <DateDivider key={m.id} iso={m.iso} />
          : m.divider
            ? <HandledDivider key={m.id} count={m.count} />
            : <Bubble key={m.id} msg={m} onRetry={handleSend} />
        )}
        {drafts.map(d => (
          <DraftBubble key={d.id} draft={d} onDone={removeDraft} onSent={() => { removeDraft(d.id); load(); onSent?.(); }} />
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
              onClick={() => handleSend()}
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
 * Who drives this thread. One headline switch (Florrie / Me) backed by the
 * same clients.messaging_autonomy field the outbound guard enforces:
 *   Me      = 'just_me'  (Florrie never initiates; quiet drafts only)
 *   Florrie = null/'florrie'/'drafts' (Auto by default, fine-tuned by pills)
 * Tapping the active pill returns to Auto. Saves straight to the client row.
 */
function ClientControls({ clientId, initialAutonomy = null }) {
  const [value, setValue] = useState(initialAutonomy);
  useEffect(() => { setValue(initialAutonomy); }, [clientId, initialAutonomy]);

  const meDriving = value === 'just_me';

  async function save(v) {
    setValue(v);
    try {
      await supabase.from('clients').update({ messaging_autonomy: v }).eq('id', clientId);
    } catch { /* optimistic; reload corrects */ }
  }

  const PILLS = [
    { key: 'florrie', label: 'Florrie handles' },
    { key: 'drafts', label: 'Drafts first' },
  ];

  return (
    <div style={S.controlsWrap}>
      <div style={S.driverRow} role="tablist" aria-label="Who drives this thread">
        {[{ k: 'florrie_side', label: '\u{1F337} Florrie', on: !meDriving, set: () => save(null) },
          { k: 'me_side', label: 'Me', on: meDriving, set: () => save('just_me') }].map(seg => (
          <button
            key={seg.k}
            type="button"
            role="tab"
            aria-selected={seg.on}
            onClick={seg.set}
            style={{
              ...S.driverSeg,
              background: seg.on ? 'var(--accent, #92405e)' : 'transparent',
              color: seg.on ? '#fff' : 'var(--text-secondary, #867277)',
            }}
          >
            {seg.label}
          </button>
        ))}
        <span style={S.driverCaption}>
          {meDriving ? "You've taken over. Florrie stays quiet here." : 'Florrie is answering this thread.'}
        </span>
      </div>
      {!meDriving && (
        <div style={S.pillRow}>
          {PILLS.map(o => {
            const on = value === o.key;
            return (
              <button
                key={o.key}
                type="button"
                onClick={() => save(on ? null : o.key)}
                style={{
                  ...S.finePill,
                  background: on ? 'var(--tone-2, #f6e7dd)' : 'transparent',
                  color: on ? 'var(--accent, #92405e)' : 'var(--text-muted, #9B8A8E)',
                  fontWeight: on ? 700 : 500,
                }}
              >
                {o.label}
              </button>
            );
          })}
          {value === null && <span style={{ fontSize: 11, color: 'var(--text-muted, #9B8A8E)' }}>Auto</span>}
        </div>
      )}
    </div>
  );
}

// Wall-time reads only: starts_at stores salon wall time in the UTC slot, so
// date/time come from string slices, never timezone conversion.
function relDays(iso) {
  if (!iso) return null;
  const d = new Date(iso.slice(0, 10));
  const today = new Date(new Date().toISOString().slice(0, 10));
  const days = Math.round((today - d) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  return months === 1 ? 'a month ago' : `${months} months ago`;
}
function nextApptLabel(iso) {
  if (!iso) return null;
  const d = new Date(iso.slice(0, 10));
  const wd = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  return `${wd}, ${iso.slice(11, 16)}`;
}

function ConvoHeader({ onBack, embedded, clientName, navigate, clientId, channel = null, meta = null, initialAutonomy = null, handle = null }) {
  const metaBits = [];
  // The handle leads the meta line, directly under the name, so she can place
  // an Instagram contact without opening their profile.
  if (handle) metaBits.push(handle);
  if (meta) {
    if (meta.visits >= 3) metaBits.push('Regular');
    metaBits.push(`${meta.visits} visit${meta.visits === 1 ? '' : 's'}`);
    if (meta.last_visit_at) metaBits.push(`last in ${relDays(meta.last_visit_at)}`);
    metaBits.push(meta.next_appointment_at ? `next: ${nextApptLabel(meta.next_appointment_at)}` : 'next: none booked');
  }
  return (
    <div style={S.convoHeader}>
      <div style={S.convoTopRow}>
        {!embedded && (
          <button onClick={onBack} style={S.backBtn} aria-label="Back to inbox">
            <span className="material-symbols-outlined" style={{ fontSize: 22 }}>chevron_left</span>
          </button>
        )}
        <span style={{
          ...S.convoAvatar,
          boxShadow: channel ? `0 0 0 2px ${channelOf(channel).tint}99` : 'inset 0 0 0 1px rgba(146,64,94,0.05)',
        }}>{initialOf(clientName)}</span>
        <div style={S.convoNameCol}>
          <span style={S.convoNameRow}>
            <span style={S.convoName}>{clientName}</span>
            {channel && <ChannelMark channel={channel} size={16} />}
          </span>
          {metaBits.length > 0 && (
            <span style={S.metaLine}>{metaBits.join(' \u00B7 ')}</span>
          )}
        </div>
        {clientId && (
          <button onClick={() => navigate('/clients', { state: { clientId } })} style={S.viewProfileBtn}>
            View profile
          </button>
        )}
      </div>
      {clientId && meta && !meta.next_appointment_at && (
        <div style={S.headerActions}>
          <button
            type="button"
            onClick={() => navigate('/calendar/week', { state: { bookClient: { id: clientId, name: clientName } } })}
            style={S.bookChip}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 15 }} aria-hidden>event</span>
            Book her in
          </button>
        </div>
      )}
      {clientId && <ClientControls clientId={clientId} initialAutonomy={initialAutonomy} />}
    </div>
  );
}

/** Quiet divider over a stretch Florrie handled on her own. */
function HandledDivider({ count }) {
  return (
    <div style={S.handledDivider} aria-label={`Florrie handled ${count} messages`}>
      <span style={S.handledLine} aria-hidden />
      <span style={S.handledText}>{'\u{1F337}'} Florrie handled {count} messages</span>
      <span style={S.handledLine} aria-hidden />
    </div>
  );
}

/**
 * A pending outbound draft, rendered IN the thread as a dashed bubble so a
 * draft can never be mistaken for a sent message. Send / Edit / Bin inline,
 * wired to the same outbox endpoints the Outbox page uses.
 */
function DraftBubble({ draft, onDone, onSent }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(draft.body || '');
  const [busy, setBusy] = useState(false);

  async function act(fn) {
    if (busy) return;
    setBusy(true);
    try { await fn(); }
    catch (err) {
      // 404 = already handled elsewhere; just drop it from view.
      if (err?.status === 404) onDone(draft.id);
      else logger.error({ err }, 'draft action failed');
    }
    finally { setBusy(false); }
  }

  async function saveEditIfNeeded() {
    if (text.trim() && text.trim() !== (draft.body || '').trim()) {
      await authFetch(`/api/outbound/${draft.id}`, { method: 'PATCH', body: JSON.stringify({ body: text.trim() }) });
    }
  }

  const send = () => act(async () => {
    await saveEditIfNeeded();
    await authFetch(`/api/outbound/${draft.id}/approve`, { method: 'POST' });
    bloom();
    onSent();
  });
  const bin = () => act(async () => {
    await authFetch(`/api/outbound/${draft.id}/skip`, { method: 'POST' });
    onDone(draft.id);
  });

  return (
    <div style={{ ...S.bubbleRow, justifyContent: 'flex-end' }}>
      <div style={{ ...S.bubbleStack, alignItems: 'flex-end' }}>
        <span style={S.bubbleTag}>{'\u{1F337}'} Draft {'\u00B7'} waiting for your OK</span>
        <div style={S.draftBubble}>
          {editing ? (
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              rows={3}
              style={S.draftEdit}
              autoFocus
            />
          ) : (
            <div style={S.bubbleText}>{text}</div>
          )}
          <div style={S.draftActions}>
            <button type="button" onClick={send} disabled={busy} style={S.draftSend}>Send</button>
            <button
              type="button"
              onClick={() => setEditing(e => !e)}
              disabled={busy}
              style={S.draftGhost}
            >
              {editing ? 'Done' : 'Edit'}
            </button>
            <button type="button" onClick={bin} disabled={busy} style={S.draftGhost}>Bin</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function DateDivider({ iso }) {
  const d = new Date(iso);
  const dd = new Date(d); dd.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yest = new Date(today); yest.setDate(yest.getDate() - 1);
  const label = dd.getTime() === today.getTime() ? 'Today'
    : dd.getTime() === yest.getTime() ? 'Yesterday'
    : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  return <div style={S.dateDivider}><span style={S.dateChip}>{label}</span></div>;
}

function Bubble({ msg, onRetry }) {
  const out = msg.direction === 'outbound';
  const type = msg.message_type;
  const failed = msg.status === 'failed';

  // Colour + a small mark carry who-said-what: client left (peach), Ellie right
  // (maroon), Florrie right (quiet tonal). No loud per-bubble stamp any more.
  const florrieSent = out && (type === 'auto_reply' || type === 'proactive' || msg.ai_generated);
  const bubbleBg = failed ? '#fdeceb' : !out ? '#fff4ee' : florrieSent ? 'var(--tone-2, #f6e7dd)' : 'var(--accent, #92405e)';
  const bubbleFg = failed ? '#9a2a22' : out && !florrieSent ? '#fff' : 'var(--text-primary, #1d1b19)';
  const metaFg = failed ? '#c0665e' : out && !florrieSent ? 'rgba(255,255,255,0.78)' : '#9B8A8E';

  const mediaStub = !msg.body && !msg.image_url
    ? (msg.media_type === 'audio' ? '\u{1F3A4} Voice note'
      : msg.media_type === 'video' ? '\u{1F39E}️ Video'
      : msg.media_type ? '\u{1F4CE} Attachment'
      : 'No text')
    : null;

  return (
    <div style={{ ...S.bubbleRow, justifyContent: out ? 'flex-end' : 'flex-start' }}>
      <div style={{ ...S.bubbleStack, alignItems: out ? 'flex-end' : 'flex-start' }}>
        <div
          style={{
            ...S.bubble,
            background: bubbleBg,
            color: bubbleFg,
            borderColor: failed ? 'rgba(190,60,50,0.35)' : out && !florrieSent ? 'var(--accent, #92405e)' : 'rgba(146,64,94,0.10)',
            borderBottomLeftRadius: out ? 18 : 5,
            borderBottomRightRadius: out ? 5 : 18,
          }}
        >
          {msg.image_url && (
            <img src={msg.image_url} alt="" style={{ maxWidth: '100%', borderRadius: 10, marginBottom: msg.body ? 6 : 0, display: 'block' }} />
          )}
          {msg.body && <div style={S.bubbleText}>{msg.body}</div>}
          {mediaStub && <div style={{ ...S.bubbleText, fontStyle: 'italic', opacity: 0.7 }}>{mediaStub}</div>}
          <div style={{ ...S.bubbleMeta, color: metaFg }}>
            {florrieSent && !failed && <span aria-hidden>{'\u{1F337}'}</span>}
            <ChannelMark channel={msg.channel} size={13} />
            <span>{formatBubbleTime(msg.created_at)}</span>
            {msg.status === 'sending' && <span>{'·'} sending</span>}
          </div>
        </div>
        {failed && (
          <button type="button" onClick={() => onRetry?.(msg.body)} style={S.failedNote}>
            {'⚠'} Not delivered {'·'} Retry
          </button>
        )}
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
    padding: '13px 12px 13px 40px',
    border: 'none',
    borderRadius: 16, background: 'var(--tone-2, #f6e7dd)',
    fontSize: 14, fontFamily: 'inherit', color: 'var(--text-primary, #1d1b19)', outline: 'none',
    transition: 'border-color 0.15s ease, background 0.15s ease',
  },

  headerWrap: { padding: '0 18px' },

  // The action stack. Cards, not rows: a card is a thing with a decision in
  // it, so only the people waiting get one.
  cardStack: { display: 'flex', flexDirection: 'column', gap: 12, padding: '2px 18px 4px' },
  card: {
    background: 'var(--bg-card, #fff)',
    border: '1px solid rgba(146,64,94,0.10)',
    borderRadius: 14,
    boxShadow: '0 1px 3px rgba(146,64,94,0.07)',
    overflow: 'hidden',
  },
  cardActive: { borderColor: 'rgba(146,64,94,0.34)' },
  // The whole top of the card opens the thread, so the tap target is the card
  // rather than a link buried in it.
  cardOpen: {
    display: 'flex', flexDirection: 'column', gap: 8, width: '100%',
    padding: '13px 14px 12px', minHeight: 44,
    background: 'transparent', border: 'none', borderRadius: 0,
    textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit',
    WebkitTapHighlightColor: 'transparent',
  },
  cardTopRow: { display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 },
  cardAvatar: {
    width: 42, height: 42, borderRadius: 21, flexShrink: 0,
    background: 'linear-gradient(135deg, #ffe0e7 0%, #ffbecd 100%)',
    color: 'var(--accent, #92405e)',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 15, fontWeight: 700, fontFamily: "'Noto Serif', Georgia, serif",
    boxShadow: 'inset 0 0 0 1px rgba(146,64,94,0.05)',
  },
  cardWho: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 },
  cardName: {
    fontSize: 15.5, fontWeight: 700, color: 'var(--text-primary, #1d1b19)',
    letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  cardMeta: { fontSize: 11.5, color: 'var(--text-muted, #9B8A8E)', fontWeight: 500 },
  // Two lines of her own words is enough to decide on. More turns the card
  // back into a conversation she has to read.
  cardQuote: {
    fontSize: 13.5, lineHeight: 1.45, color: 'var(--text-secondary, #867277)',
    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
  },
  draftPanel: {
    margin: '0 14px', padding: '10px 12px', borderRadius: 8,
    background: 'rgba(146,64,94,0.05)',
    display: 'flex', flexDirection: 'column', gap: 5,
  },
  draftContext: {
    fontSize: 10.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
    color: 'var(--accent, #92405e)', opacity: 0.85,
  },
  draftPanelText: {
    fontSize: 13.5, lineHeight: 1.5, color: 'var(--text-primary, #1d1b19)',
    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  },
  cardActions: {
    display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: '10px 14px 14px',
  },
  cardSend: {
    minHeight: 44, borderRadius: 12, border: 'none',
    background: 'var(--accent, #92405e)', color: '#fff',
    fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
    WebkitTapHighlightColor: 'transparent',
  },
  cardEdit: {
    minHeight: 44, borderRadius: 12,
    border: '1px solid rgba(146,64,94,0.28)', background: 'transparent',
    color: 'var(--accent, #92405e)',
    fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
    WebkitTapHighlightColor: 'transparent',
  },
  cardError: {
    margin: '0 14px 12px', padding: '8px 10px', borderRadius: 8,
    background: '#FDECEA', border: '1px solid #F5C6C0',
    fontSize: 12, color: '#8A2A1C', lineHeight: 1.45,
  },

  allClear: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    padding: '18px 22px 22px', textAlign: 'center',
    fontSize: 13.5, color: 'var(--text-muted, #9B8A8E)', lineHeight: 1.5,
  },
  allClearIcon: { fontSize: 18, color: 'var(--accent, #92405e)', opacity: 0.6 },

  // The drawer handle. A hairline above it is the only separation it needs.
  everythingRow: {
    display: 'flex', alignItems: 'center', gap: 10, width: '100%',
    minHeight: 56, padding: '0 18px', marginTop: 6,
    background: 'transparent', border: 'none',
    borderTop: '1px solid rgba(146,64,94,0.10)',
    cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
    WebkitTapHighlightColor: 'transparent',
  },
  everythingIcon: { fontSize: 19, color: 'var(--text-muted, #B5AFA8)' },
  everythingLabel: { flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--text-secondary, #867277)' },
  everythingCount: { fontSize: 12, fontWeight: 700, color: 'var(--text-muted, #B5AFA8)' },

  caughtUpBtn: {
    marginTop: 4, padding: '10px 18px', minHeight: 44,
    background: 'var(--tone-2, #f6e7dd)', color: 'var(--accent, #92405e)',
    border: 'none', borderRadius: 999,
    fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
  },

  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' },

  waitChip: {
    fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
    background: '#fdf0e3', color: '#b3602f', letterSpacing: '0.02em',
  },
  petalNote: { fontSize: 11, color: 'var(--accent, #92405e)', fontWeight: 600 },
  metaLine: {
    display: 'block', fontSize: 11.5, color: 'var(--text-muted, #9B8A8E)',
    lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  headerActions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  bookChip: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '5px 12px', minHeight: 28, borderRadius: 999, border: 'none',
    background: '#f0e3cf', color: '#8a6d3b', fontSize: 11.5, fontWeight: 700,
    cursor: 'pointer', fontFamily: 'inherit', WebkitTapHighlightColor: 'transparent',
  },
  controlsWrap: { marginTop: 2 },
  driverRow: {
    display: 'flex', alignItems: 'center', gap: 8,
    background: 'var(--tone-2, #f6e7dd)', borderRadius: 999, padding: 3,
    width: 'fit-content', maxWidth: '100%', flexWrap: 'wrap',
  },
  driverSeg: {
    padding: '5px 13px', minHeight: 28, borderRadius: 999, border: 'none',
    fontSize: 11.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
    WebkitTapHighlightColor: 'transparent', transition: 'background 0.15s ease',
  },
  driverCaption: { fontSize: 10.5, color: 'var(--text-muted, #9B8A8E)', padding: '0 10px 0 4px' },
  pillRow: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' },
  finePill: {
    padding: '4px 10px', minHeight: 26, borderRadius: 999, border: 'none',
    fontSize: 11, cursor: 'pointer', fontFamily: 'inherit',
    WebkitTapHighlightColor: 'transparent',
  },
  handledDivider: {
    display: 'flex', alignItems: 'center', gap: 10, margin: '14px 6px',
  },
  handledLine: { flex: 1, height: 1, background: 'rgba(146,64,94,0.12)' },
  handledText: {
    fontSize: 11, color: 'var(--text-muted, #9B8A8E)', fontWeight: 600,
    whiteSpace: 'nowrap',
  },
  draftBubble: {
    maxWidth: 'min(78%, 420px)', padding: '10px 14px', borderRadius: 20,
    borderBottomRightRadius: 6, background: 'rgba(146,64,94,0.04)',
    border: '1.5px dashed rgba(146,64,94,0.45)', color: 'var(--text-primary, #1d1b19)',
    boxSizing: 'border-box',
  },
  draftEdit: {
    width: '100%', boxSizing: 'border-box', border: '1px solid rgba(146,64,94,0.25)',
    borderRadius: 10, padding: '8px 10px', fontSize: 14, fontFamily: 'inherit',
    background: '#fff', color: 'var(--text-primary, #1d1b19)', resize: 'vertical', outline: 'none',
  },
  draftActions: { display: 'flex', gap: 6, marginTop: 8 },
  draftSend: {
    padding: '6px 16px', minHeight: 32, borderRadius: 999, border: 'none',
    background: 'var(--accent, #92405e)', color: '#fff', fontSize: 12, fontWeight: 700,
    cursor: 'pointer', fontFamily: 'inherit', WebkitTapHighlightColor: 'transparent',
  },
  draftGhost: {
    padding: '6px 12px', minHeight: 32, borderRadius: 999, border: 'none',
    background: 'var(--tone-2, #f6e7dd)', color: 'var(--text-secondary, #867277)',
    fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
    WebkitTapHighlightColor: 'transparent',
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
  // Name and handle share one line. The name gives up space first, so a long
  // real name truncates before the handle disappears entirely.
  rowNameWrap: { display: 'flex', alignItems: 'baseline', gap: 5, minWidth: 0, overflow: 'hidden' },
  rowHandle: {
    fontSize: 11.5, color: 'var(--text-muted, #9B8A8E)', fontWeight: 500, flexShrink: 0,
    maxWidth: '46%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
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
  // Social lane: still countable, never urgent. No accent, no shadow.
  rowBadgeQuiet: {
    fontSize: 10.5, fontWeight: 600, color: 'var(--text-muted, #9a8f93)',
    background: 'rgba(146,64,94,0.06)',
    padding: '1px 7px', borderRadius: 20, minWidth: 17, textAlign: 'center', flexShrink: 0,
    lineHeight: 1.5,
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
    height: '100dvh', overflow: 'hidden', background: 'var(--bg, #fef8f4)',
    fontFamily: "'Plus Jakarta Sans', 'DM Sans', sans-serif",
    display: 'flex', flexDirection: 'column', color: 'var(--text-primary, #1d1b19)',
  },
  convoEmbedded: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 },
  convoHeader: {
    display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 14px 12px',
    background: 'var(--tone-1, #fbf1ea)', borderBottom: '1px solid rgba(146,64,94,0.06)',
    flexShrink: 0,
  },
  convoTopRow: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 },
  convoNameCol: { display: 'flex', flexDirection: 'column', gap: 1, flex: 1, minWidth: 0 },
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
  convoNameRow: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 },
  convoName: {
    fontSize: 15, fontWeight: 700, color: 'var(--text-primary, #1d1b19)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
  },
  viewProfileBtn: {
    background: 'var(--tone-2, #f6e7dd)', border: 'none', color: 'var(--accent, #92405e)',
    fontSize: 11, fontWeight: 700, padding: '6px 12px', minHeight: 30, borderRadius: 999,
    display: 'inline-flex', alignItems: 'center', cursor: 'pointer', fontFamily: 'inherit',
    whiteSpace: 'nowrap', flexShrink: 0, WebkitTapHighlightColor: 'transparent',
  },

  scroller: { flex: 1, minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch', padding: '12px 14px 12px', display: 'flex', flexDirection: 'column', gap: 10 },
  bubbleRow: { display: 'flex', width: '100%' },
  bubbleStack: { display: 'flex', flexDirection: 'column', gap: 3, maxWidth: '78%' },
  bubbleTag: { fontSize: 9.5, fontWeight: 700, color: 'var(--accent, #92405e)', letterSpacing: '0.05em', textTransform: 'uppercase', paddingLeft: 3, opacity: 0.85 },
  bubble: {
    padding: '10px 14px', border: '1px solid', borderRadius: 20,
    boxShadow: '0 1px 2px rgba(146,64,94,0.06)',
  },
  bubbleText: { fontSize: 14, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  dateDivider: { display: 'flex', justifyContent: 'center', margin: '4px 0 0' },
  dateChip: {
    fontSize: 10, fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase',
    color: 'var(--text-muted, #9B8A8E)', background: 'rgba(146,64,94,0.06)',
    borderRadius: 999, padding: '3px 10px',
  },
  // A failed send needs a real tap target, not a caption, so it keeps the 44px
  // height even though it reads as a note.
  failedNote: {
    display: 'inline-flex', alignItems: 'center', minHeight: 44, padding: '0 4px',
    background: 'transparent', border: 'none',
    fontSize: 11, fontWeight: 700, color: '#9a2a22',
    cursor: 'pointer', fontFamily: 'inherit',
    WebkitTapHighlightColor: 'transparent',
  },
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
    // In-flow at the column's bottom (the column is height-contained), with
    // clearance for the floating bottom nav so nothing hides behind it.
    padding: '8px 12px calc(env(safe-area-inset-bottom, 0px) + 92px)', background: 'var(--tone-1, #fbf1ea)',
    borderTop: '1px solid rgba(146,64,94,0.08)',
    display: 'flex', flexDirection: 'column', gap: 8,
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
