import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import PageHeader from '../components/ui/PageHeader.jsx';
import { bloom } from '../lib/bloom.js';
import Icon, { iconName } from '../components/ui/Icon';

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
 *   - Segments (Needs you / Clients / New / Social) driven by the backend, so
 *     Instagram fluff sits in its own quiet lane instead of burying the
 *     handful of threads that actually want her.
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
      style={{ width: size,
        height: size,
        borderRadius: Math.round(size * 0.34),
        background: c.fill,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        boxShadow: 'var(--elev-1)',
      }}
    >
      <Icon name={iconName(c.icon)} inline style={{ fontSize: Math.round(size * 0.62), color: '#fff', lineHeight: 1, }} />
    </span>
  );
}

// A pure thank-you or sign-off does not owe a reply, so it should never nag
// her. Anything else the client said last is a real reply owed.

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
const NEEDS_YOU_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
function needsYou(t) {
  // The BACKEND owns this decision now and sends it as thread.segment, so
  // there is one copy of the rule (replyIsOwed) rather than two that drift.
  //
  // It deliberately no longer consults needs_attention ("some message in this
  // thread was escalated and never marked resolved"). That flag is sticky: a
  // thread Ellie had already answered five times still counted as waiting.
  // Production read 132 clients waiting when 15 genuinely were.
  return segmentOf(t) === 'needs';
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
  // Must NOT call needsYou: that now asks segmentOf, which lands back here.
  // A stale cached payload gets this coarse test instead, for the one render
  // before the real payload arrives.
  if (t.last_message_direction === 'inbound'
      && Date.now() - new Date(t.last_message_at).getTime() < NEEDS_YOU_WINDOW_MS) return 'needs';
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

/**
 * The two spaces. Split by RELATIONSHIP, not channel: since Instagram DMs
 * went live the single list was taken over by stranger noise, burying the
 * WhatsApps and DMs from people who actually book. The backend decides the
 * space per thread (thread.space) with the same evidence it uses for
 * is_known_client, so an Instagram DM from a real client sits in Clients
 * next to her WhatsApp messages.
 *
 *   clients   = anyone with a relationship: ever booked, or contact details
 *               on file, whatever channel they used today
 *   instagram = strangers who exist only as an Instagram DM
 */
const SPACE_KEY = 'florrie_inbox_space';

function spaceOf(t) {
  if (t.space === 'instagram' || t.space === 'clients') return t.space;
  // Cached payload from before spaces existed: same rule, coarser evidence.
  return (!t.is_known_client && t.last_channel === 'instagram') ? 'instagram' : 'clients';
}

// A LEAD is the narrow slice of the Instagram space worth her time: buying
// intent, or an actual question, and not junk. The backend computes this
// (is_social_lead); the fallback mirrors its rule for stale cached payloads.
const LEAD_INTENTS = new Set(['booking_request', 'price_enquiry', 'availability_check']);
function isLead(t) {
  if (typeof t.is_social_lead === 'boolean') return t.is_social_lead;
  if (t.is_junk) return false;
  if (LEAD_INTENTS.has(t.last_inbound_intent)) return true;
  return String(t.last_inbound_preview || t.last_message_preview || '').includes('?');
}

// Something outstanding = the thread would feed a badge somewhere. This is
// what "Clear all" clears, so the count and the button read off the same test.
function hasOutstanding(t) {
  return t.unread_count > 0 || !!t.needs_attention;
}

// The last-open space survives app restarts: if she lives in Clients, the
// Instagram pile should never greet her first.
function readStoredSpace() {
  try {
    return localStorage.getItem(SPACE_KEY) === 'instagram' ? 'instagram' : 'clients';
  } catch { return 'clients'; }
}

// Search matches the name AND the @handle, because half of her Instagram
// contacts have no name to search for.
function threadMatches(t, q) {
  if (!q) return true;
  const handle = handleOf(t);
  return clientFullName(t).toLowerCase().includes(q)
    || (handle ? handle.toLowerCase().includes(q) : false);
}

// Chip order, left to right, and the order the All view stacks its sections:
// urgent first, then people she knows, then strangers, then the fluff.
const SEGMENT_TABS = [
  { key: 'needs', label: 'Needs you' },
  { key: 'client', label: 'Clients' },
  { key: 'new', label: 'New' },
  { key: 'social', label: 'Social' },
  { key: 'all', label: 'All' },
];
const SECTION_TITLES = { needs: 'Needs you', client: 'Clients', new: 'New', social: 'Social' };

export default function Inbox() {
  const [threads, setThreads] = useState(null);
  const [threadsError, setThreadsError] = useState(null);
  const [search, setSearch] = useState('');
  // 'all' shows every segment as its own section, so nothing is hidden by
  // default. The other values narrow to one segment.
  const [segment, setSegment] = useState('all');
  // Which space is open: Clients or Instagram. Persisted so the page reopens
  // where she left it.
  const [space, setSpaceState] = useState(readStoredSpace);
  const [clearingSocial, setClearingSocial] = useState(false);
  const setSpace = (next) => {
    setSpaceState(next);
    try { localStorage.setItem(SPACE_KEY, next); } catch { /* private mode */ }
  };
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

  // Every thread lands in exactly one space first; everything below reads
  // off its own space so the two lists can never bleed into each other.
  const spaceThreads = useMemo(() => {
    if (!threads) return null;
    const out = { clients: [], instagram: [] };
    for (const t of threads) out[spaceOf(t)].push(t);
    return out;
  }, [threads]);

  // The numbers on the two space tabs. Instagram deliberately shows its LEAD
  // count, not its total: 4 leads is information, 61 messages is dread.
  // Clients shows how many client threads are genuinely waiting on her.
  const spaceCounts = useMemo(() => {
    if (!spaceThreads) return { clients: 0, instagram: 0 };
    return {
      clients: spaceThreads.clients.filter(t => segmentOf(t) === 'needs').length,
      instagram: spaceThreads.instagram.filter(isLead).length,
    };
  }, [spaceThreads]);

  // Clients space: one pass, apply the search, drop each thread into its
  // segment, sort each lane newest first. The segmented look Ellie likes,
  // now scoped to people she has a relationship with.
  const grouped = useMemo(() => {
    if (!spaceThreads) return null;
    const out = { needs: [], client: [], new: [], social: [] };
    const q = search.trim().toLowerCase().replace(/^@/, '');
    for (const t of spaceThreads.clients) {
      if (!threadMatches(t, q)) continue;
      out[segmentOf(t)].push(t);
    }
    for (const key of SEGMENTS) out[key].sort(byRecency);
    return out;
  }, [spaceThreads, search]);

  // Instagram space: pre-triaged, not a list to work through. Leads on top,
  // everything else in one collapsed pile below.
  const ig = useMemo(() => {
    if (!spaceThreads) return null;
    const q = search.trim().toLowerCase().replace(/^@/, '');
    const leads = [];
    const rest = [];
    for (const t of spaceThreads.instagram) {
      if (!threadMatches(t, q)) continue;
      (isLead(t) ? leads : rest).push(t);
    }
    leads.sort(byRecency);
    rest.sort(byRecency);
    // The Clear-all count comes off the UNFILTERED pile. The backend clears
    // the whole pile regardless of any search, so the dialog must not promise
    // a smaller number than what actually happens.
    const restOutstanding = spaceThreads.instagram
      .filter(t => !isLead(t) && hasOutstanding(t)).length;
    return { leads, rest, restOutstanding };
  }, [spaceThreads, search]);

  // One tap clears the non-lead pile: the backend re-derives which threads
  // qualify (it never trusts this client to say), resolves their escalations
  // and marks them read. Leads are untouched by definition.
  async function clearSocial() {
    const outstanding = ig?.restOutstanding || 0;
    if (!outstanding || clearingSocial) return;
    const ok = window.confirm(
      `Clear ${outstanding} Instagram message${outstanding === 1 ? '' : 's'}? Leads stay.`
    );
    if (!ok) return;
    setClearingSocial(true);
    try {
      await authFetch('/api/inbox/clear-social', { method: 'POST' });
      await loadThreads();
      bloom();
    } catch (err) {
      logger.error({ err }, 'inbox clear-social failed');
    } finally {
      setClearingSocial(false);
    }
  }

  // Counts come off the same buckets the list renders, and after the search,
  // so a chip can never claim 12 while its list shows nothing.
  const counts = useMemo(() => {
    const base = { needs: 0, client: 0, new: 0, social: 0, all: 0 };
    if (!grouped) return base;
    for (const key of SEGMENTS) { base[key] = grouped[key].length; base.all += grouped[key].length; }
    return base;
  }, [grouped]);

  // One segment selected: a flat list, no header, because the chip above it
  // already says what she is looking at.
  // All: every non-empty segment as its own section, in priority order. A
  // section with nothing in it is never rendered, and Social folds away
  // because that is the lane she should be able to ignore entirely.
  const sections = useMemo(() => {
    if (!grouped) return null;
    if (segment !== 'all') {
      const items = grouped[segment] || [];
      if (!items.length) return [];
      return [{ key: segment, header: null, items, muted: segment === 'social', quiet: segment === 'social' }];
    }
    return SEGMENTS
      .filter(key => grouped[key].length)
      .map(key => ({
        key,
        header: SECTION_TITLES[key],
        items: grouped[key],
        muted: key === 'social',
        quiet: key === 'social',
        collapsible: key === 'social',
        quietNote: key === 'social' ? 'pitches and randoms, nothing owed' : null,
      }));
  }, [grouped, segment]);

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
            segment={segment}
            onSegment={setSegment}
            counts={counts}
            totalCount={threads?.length || 0}
            space={space}
            onSpace={setSpace}
            spaceCounts={spaceCounts}
            ig={ig}
            onClearSocial={clearSocial}
            clearingSocial={clearingSocial}
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
        segment={segment}
        onSegment={setSegment}
        counts={counts}
        totalCount={threads?.length || 0}
        space={space}
        onSpace={setSpace}
        spaceCounts={spaceCounts}
        ig={ig}
        onClearSocial={clearSocial}
        clearingSocial={clearingSocial}
      />
    </div>
  );
}

function FilterChip({ active, onClick, label, count }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{ ...S.filterChip, ...(active ? S.filterChipActive : {}) }}
    >
      {label}
      {count > 0 && (
        <span style={{ ...S.filterChipCount, ...(active ? S.filterChipCountActive : {}) }}>{count}</span>
      )}
    </button>
  );
}

function ThreadList({ sections, visibleCount, error, search, onSearch, onOpen, onDelete, activeId, segment, onSegment, counts, totalCount, space, onSpace, spaceCounts, ig, onClearSocial, clearingSocial }) {
  const loading = sections === null;
  // Social starts folded to one line; searching unfolds everything.
  const [expanded, setExpanded] = useState({});
  // The Instagram "everything else" pile starts folded too, same rule.
  const [igRestOpen, setIgRestOpen] = useState(false);
  const isCollapsed = (sec) => sec.collapsible && !expanded[sec.key] && !search.trim();
  const inClients = space !== 'instagram';
  const igLeads = ig?.leads || [];
  const igRest = ig?.rest || [];
  // What "Clear all" would actually clear: threads still feeding a badge,
  // counted off the unfiltered pile so the number matches what the tap does.
  const igOutstanding = ig?.restOutstanding || 0;
  const igRestExpanded = igRestOpen || !!search.trim();
  const isEmpty = !loading && (inClients
    ? visibleCount === 0
    : igLeads.length + igRest.length === 0);
  // In the needs-you view the whole list is needs-you, so the per-row tag is
  // redundant. Hide it there; show the informative type label elsewhere.
  const hideTypeChip = segment === 'needs';

  return (
    <>
      <div style={S.headerWrap}>
        <PageHeader title="Inbox" subtitle="One thread per client. Florrie keeps the quiet ones tidy." />
      </div>

      {/* The two spaces. Clients wears its waiting count; Instagram wears its
          LEAD count on purpose, never the total, because "4 leads" is
          information and "61 messages" is dread. */}
      <div role="tablist" aria-label="Inbox spaces" style={S.spaceRow}>
        <button
          type="button"
          role="tab"
          aria-selected={inClients}
          onClick={() => onSpace('clients')}
          style={{ ...S.spaceTab, ...(inClients ? S.spaceTabActive : {}) }}
        >
          <Icon name={iconName('group')} inline style={S.spaceTabIcon} />
          Clients
          {spaceCounts?.clients > 0 && (
            <span style={{ ...S.spaceTabCount, ...(inClients ? S.spaceTabCountActive : {}) }}>
              {spaceCounts.clients}
            </span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={!inClients}
          onClick={() => onSpace('instagram')}
          style={{ ...S.spaceTab, ...(!inClients ? S.spaceTabActive : {}) }}
        >
          <Icon name={iconName('photo_camera')} inline style={S.spaceTabIcon} />
          Instagram
          {spaceCounts?.instagram > 0 && (
            <span style={{ ...S.spaceTabCount, ...(!inClients ? S.spaceTabCountActive : {}) }}>
              {spaceCounts.instagram}
            </span>
          )}
        </button>
      </div>

      <div style={S.searchWrap}>
        <Icon name={iconName('search')} inline style={S.searchIcon} />
        <input
          type="search"
          value={search}
          onChange={e => onSearch(e.target.value)}
          placeholder="Search by name or @handle"
          style={S.searchInput}
        />
      </div>

      {/* Clients keeps the segmented chips Ellie likes. Instagram has no
          chips: it is pre-triaged into leads and a foldaway pile, not a
          filterable list to work through. */}
      {inClients && (
        <div className="inbox-seg-row" style={S.filterRow}>
          {SEGMENT_TABS.map(tab => (
            <FilterChip
              key={tab.key}
              active={segment === tab.key}
              onClick={() => onSegment(tab.key)}
              label={tab.label}
              count={counts?.[tab.key] || 0}
            />
          ))}
        </div>
      )}

      {loading && <ThreadSkeleton />}
      {!loading && error && (
        <div style={S.errorCard}>
          Couldn't load conversations. Pull down to refresh, or check back in a bit.
        </div>
      )}
      {!loading && !error && isEmpty && (
        search.trim()
          ? <NoMatches onClear={() => onSearch('')} />
          : !inClients
            ? <InstagramEmpty />
            : totalCount === 0
              ? <EmptyInbox />
              : segment === 'needs'
                ? <CaughtUp onShowAll={() => onSegment('all')} />
                : <SegmentEmpty segment={segment} onShowAll={() => onSegment('all')} />
      )}

      {inClients && !loading && !error && !isEmpty && sections.map(sec => (
        <section key={sec.key} style={S.section}>
          {sec.header && (
            sec.collapsible ? (
              <button
                type="button"
                onClick={() => setExpanded(prev => ({ ...prev, [sec.key]: !prev[sec.key] }))}
                style={S.sectionHeadBtn}
                aria-expanded={!isCollapsed(sec)}
              >
                <span style={S.sectionTitle}>{sec.header}</span>
                <span style={S.sectionCount}>{sec.items.length}</span>
                <Icon name={iconName(isCollapsed(sec) ? 'expand_more' : 'expand_less')} inline style={S.sectionChevron} />
                {isCollapsed(sec) && sec.quietNote && (
                  <span style={S.sectionQuietNote}>{sec.quietNote}</span>
                )}
              </button>
            ) : (
              <div style={S.sectionHead}>
                <span style={S.sectionTitle}>{sec.header}</span>
                <span style={S.sectionCount}>{sec.items.length}</span>
              </div>
            )
          )}
          {!isCollapsed(sec) && (
            <ul style={S.list}>
              {sec.items.map(t => (
                <ThreadRow
                  key={t.client_id}
                  thread={t}
                  active={t.client_id === activeId}
                  onOpen={onOpen}
                  onDelete={onDelete}
                  muted={sec.muted}
                  quiet={sec.quiet}
                  hideTypeChip={hideTypeChip}
                />
              ))}
            </ul>
          )}
        </section>
      ))}

      {/* Instagram space: leads first and loud, everything else folded away
          behind a count and one Clear-all tap. */}
      {!inClients && !loading && !error && !isEmpty && (
        <>
          <section style={S.section}>
            <div style={S.sectionHead}>
              <span style={S.sectionTitle}>Leads</span>
              <span style={S.sectionCount}>{igLeads.length}</span>
            </div>
            {igLeads.length ? (
              <ul style={S.list}>
                {igLeads.map(t => (
                  <ThreadRow
                    key={t.client_id}
                    thread={t}
                    active={t.client_id === activeId}
                    onOpen={onOpen}
                    onDelete={onDelete}
                  />
                ))}
              </ul>
            ) : (
              <p style={S.igNoLeads}>
                No leads right now. Anyone asking about prices, times or booking in lands here.
              </p>
            )}
          </section>

          {igRest.length > 0 && (
            <section style={S.section}>
              <button
                type="button"
                onClick={() => setIgRestOpen(o => !o)}
                style={S.sectionHeadBtn}
                aria-expanded={igRestExpanded}
              >
                <span style={S.sectionTitle}>Everything else</span>
                <span style={S.sectionCount}>{igRest.length}</span>
                <Icon name={iconName(igRestExpanded ? 'expand_less' : 'expand_more')} inline style={S.sectionChevron} />
                {!igRestExpanded && (
                  <span style={S.sectionQuietNote}>compliments, story replies, sign-offs</span>
                )}
              </button>
              {igOutstanding > 0 && (
                <div style={S.clearAllWrap}>
                  <button
                    type="button"
                    onClick={onClearSocial}
                    disabled={clearingSocial}
                    style={{ ...S.clearAllBtn, opacity: clearingSocial ? 0.6 : 1 }}
                  >
                    <Icon name={iconName('done_all')} size={17} inline />
                    {clearingSocial ? 'Clearing\u2026' : `Clear all (${igOutstanding})`}
                  </button>
                  <span style={S.clearAllHint}>Marks them handled. Leads stay.</span>
                </div>
              )}
              {igRestExpanded && (
                <ul style={S.list}>
                  {igRest.map(t => (
                    <ThreadRow
                      key={t.client_id}
                      thread={t}
                      active={t.client_id === activeId}
                      onOpen={onOpen}
                      onDelete={onDelete}
                      muted
                      quiet
                    />
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}
    </>
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
        style={{ ...S.row,
          ...((automated || muted) && !owed ? S.rowMuted : {}),
          background: active ? 'var(--accent-wash, #FBF2F5)' : 'transparent',
        }}
      >
        <span style={S.avatarWrap}>
          <span style={{ ...S.avatar,
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
              <span style={{ ...S.rowName,
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
            <span style={{ ...S.rowPreview,
              ...((automated || muted) && !owed ? S.rowPreviewMuted : {}),
              color: loud ? 'var(--text-primary, #241B17)' : 'var(--text-muted, #6B5D54)',
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
        <Icon name={iconName('more_vert')} size={18} inline />
      </button>

      {menuOpen && (
        <div role="menu" style={S.rowMenu}>
          <button
            type="button"
            role="menuitem"
            onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onDelete && onDelete(thread.client_id); }}
            style={S.rowMenuItem}
          >
            <Icon name={iconName('delete')} size={17} inline />
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
            <span style={{ ...S.avatar, background: 'var(--border-light, #ede7e3)', color: 'transparent' }}>·</span>
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
      <Icon name={iconName('forum')} inline style={S.emptyIcon} />
      <p style={S.emptyText}>Once a client messages you, they'll appear here.</p>
      <Link to="/whatsapp" style={S.emptyCta}>Send a template</Link>
      <p style={S.emptyHint}>A friendly hello is all it takes to get the conversation started.</p>
    </div>
  );
}

function CaughtUp({ onShowAll }) {
  return (
    <div style={S.empty}>
      <Icon name={iconName('task_alt')} inline style={S.emptyIcon} />
      <p style={S.emptyText}>You're all caught up. Nothing is waiting on a reply.</p>
      <button type="button" onClick={onShowAll} style={S.caughtUpBtn}>See all conversations</button>
    </div>
  );
}

// Per-segment empty states, so an empty lane reads as "nothing here" rather
// than "the inbox is broken".
const SEGMENT_EMPTY = {
  client: { icon: 'group', text: 'No client conversations here. Anyone you have booked in shows up in this lane.' },
  new: { icon: 'waving_hand', text: 'No new enquiries right now. First-time messages land here.' },
  social: { icon: 'photo_camera', text: 'Nothing parked here. Florrie keeps pitches and randoms out of your way.' },
};

function SegmentEmpty({ segment, onShowAll }) {
  const copy = SEGMENT_EMPTY[segment] || { icon: 'forum', text: 'Nothing in this lane.' };
  return (
    <div style={S.empty}>
      <Icon name={iconName(copy.icon)} inline style={S.emptyIcon} />
      <p style={S.emptyText}>{copy.text}</p>
      <button type="button" onClick={onShowAll} style={S.caughtUpBtn}>See all conversations</button>
    </div>
  );
}

function InstagramEmpty() {
  return (
    <div style={S.empty}>
      <Icon name={iconName('photo_camera')} inline style={S.emptyIcon} />
      <p style={S.emptyText}>
        No Instagram enquiries from new people. When a stranger DMs you, Florrie sorts the real leads to the top here.
      </p>
    </div>
  );
}

function NoMatches({ onClear }) {
  return (
    <div style={S.empty}>
      <Icon name={iconName('search_off')} inline style={S.emptyIcon} />
      <p style={S.emptyText}>Nobody by that name or handle. Try a shorter search.</p>
      <button type="button" onClick={onClear} style={S.caughtUpBtn}>Clear search</button>
    </div>
  );
}

function EmptyConvoPlaceholder() {
  return (
    <div style={S.placeholder}>
      <Icon name={iconName('forum')} size={30} inline style={{ color: 'var(--accent, #92405e)', marginBottom: 12,
          width: 68, height: 68, borderRadius: 22,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: 'linear-gradient(135deg, #ffe7ee 0%, #fdeef3 100%)',
          boxShadow: 'inset 0 0 0 1px rgba(146,64,94,0.08)' }} />
      <div style={{ fontSize: 16, color: 'var(--text-secondary, #574A42)', fontFamily: "'Playfair Display', Georgia, serif", fontStyle: 'italic' }}>
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

  async function handleSend(retryBody) {
    // Retry passes the failed bubble's own text. Without this the button could
    // only ever resend whatever happened to be in the composer, which is
    // usually empty.
    const isRetry = typeof retryBody === 'string' && retryBody.trim().length > 0;
    const body = isRetry ? retryBody.trim() : composer.trim();
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
    if (!isRetry) setComposer('');

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
      if (!isRetry) setComposer(body);
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
    const flush = () => {
      if (run.length >= 2) out.push({ divider: true, id: `div-${run[0].id}`, count: run.length });
      run.forEach(m => out.push(m));
      run = [];
    };
    // Local day, not iso.slice(0,10): a message at 00:30 BST is today, and
    // slicing the UTC string would file it under yesterday.
    const dayKey = (iso) => new Date(iso).toLocaleDateString('en-GB');
    let lastDay = null;

    for (const m of messages) {
      const day = dayKey(m.created_at);
      if (day !== lastDay) {
        // Close any run of Florrie's own messages BEFORE the divider, so a
        // collapsed run can never straddle two days.
        flush();
        out.push({ dateDivider: true, id: `day-${day}`, iso: m.created_at });
        lastDay = day;
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
        {renderItems.map(m => {
          if (m.dateDivider) return <DateDivider key={m.id} iso={m.iso} />;
          if (m.divider) return <HandledDivider key={m.id} count={m.count} />;
          return <Bubble key={m.id} msg={m} threadChannel={channel} onRetry={handleSend} />;
        })}
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
                  style={{ ...S.channelPill,
                    background: on ? 'var(--accent, #92405e)' : 'var(--bg-card, #FFFCF9)',
                    color: on ? '#fff' : 'var(--accent, #92405e)',
                    borderColor: on ? 'var(--accent, #92405e)' : 'var(--border-light, #ede7e3)',
                  }}
                >
                  <Icon name={iconName(meta.icon)} size={15} inline style={{ color: on ? '#fff' : meta.tint }} />
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
                <Icon name={iconName('arrow_upward')} size={18} inline />
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
            style={{ ...S.driverSeg,
              background: seg.on ? 'var(--accent, #92405e)' : 'transparent',
              color: seg.on ? '#fff' : 'var(--text-secondary, #574A42)',
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
                style={{ ...S.finePill,
                  background: on ? 'var(--tone-2, #f6e7dd)' : 'transparent',
                  color: on ? 'var(--accent, #92405e)' : 'var(--text-muted, #6B5D54)',
                  fontWeight: on ? 700 : 500,
                }}
              >
                {o.label}
              </button>
            );
          })}
          {value === null && <span style={{ fontSize: 11, color: 'var(--text-muted, #6B5D54)' }}>Auto</span>}
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
            <Icon name={iconName('chevron_left')} size={22} inline />
          </button>
        )}
        <span style={{ ...S.convoAvatar,
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
            <Icon name={iconName('event')} size={15} inline />
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

function Bubble({ msg, threadChannel, onRetry }) {
  const out = msg.direction === 'outbound';
  const type = msg.message_type;
  const failed = msg.status === 'failed';

  // Colour + a small mark carry who-said-what: client left (peach), Ellie right
  // (maroon), Florrie right (quiet tonal). No loud per-bubble stamp any more.
  const florrieSent = out && (type === 'auto_reply' || type === 'proactive' || msg.ai_generated);
  const bubbleBg = failed ? '#fdeceb' : !out ? 'var(--bg-card, #FFFCF9)' : florrieSent ? 'var(--tone-2, #f6e7dd)' : 'var(--accent, #92405e)';
  const bubbleFg = failed ? '#9a2a22' : out && !florrieSent ? '#fff' : 'var(--text-primary, #241B17)';
  const metaFg = failed ? '#c0665e' : out && !florrieSent ? 'rgba(255,255,255,0.78)' : '#9B8A8E';

  const mediaStub = !msg.body && !msg.image_url
    ? (msg.media_type === 'audio' ? 'Voice note'
      : msg.media_type === 'video' ? 'Video'
      : msg.media_type ? 'Attachment'
      : 'No text')
    : null;

  return (
    <div style={{ ...S.bubbleRow, justifyContent: out ? 'flex-end' : 'flex-start' }}>
      <div style={{ ...S.bubbleStack, alignItems: out ? 'flex-end' : 'flex-start' }}>
        <div
          style={{ ...S.bubble,
            background: bubbleBg,
            color: bubbleFg,
            borderColor: failed ? 'rgba(190,60,50,0.35)' : out && !florrieSent ? 'var(--accent, #92405e)' : 'rgba(146,64,94,0.16)',
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
            {florrieSent && !failed && <Icon name="flower" size={12} />}
            {msg.channel && msg.channel !== threadChannel && <ChannelMark channel={msg.channel} size={13} />}
            <span>{formatBubbleTime(msg.created_at)}</span>
            {msg.status === 'sending' && <span>{'·'} sending</span>}
          </div>
        </div>
        {failed && (
          <button type="button" onClick={() => onRetry?.(msg.body)} style={S.failedNote}>
            <Icon name="alert-triangle" size={13} /> Not delivered {'·'} Retry
          </button>
        )}
      </div>
    </div>
  );
}

const S = {
  page: {
    minHeight: 'var(--shell-viewport)',
    background: 'var(--bg, #FBF6F1)',
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    padding: '0 0 24px',
    maxWidth: 480,
    margin: '0 auto',
    color: 'var(--text-primary, #241B17)',
  },
  pageWide: {
    minHeight: 'var(--shell-viewport)',
    background: 'var(--bg, #FBF6F1)',
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    display: 'grid',
    gridTemplateColumns: 'minmax(320px, 392px) 1fr',
    gap: 16,
    padding: '0 16px 24px',
    maxWidth: 1120,
    margin: '0 auto',
    color: 'var(--text-primary, #241B17)',
  },
  paneList: {
    background: 'var(--tone-1, #fbf1ea)',
    borderRadius: 22,
    padding: '4px 0 14px',
    maxHeight: 'var(--shell-viewport)',
    overflowY: 'auto',
    marginTop: 16,
  },
  paneConvo: {
    background: 'var(--tone-1, #fbf1ea)',
    borderRadius: 22,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 'var(--shell-viewport)',
    overflow: 'hidden',
    marginTop: 16,
  },

  searchWrap: { position: 'relative', marginBottom: 10, padding: '0 18px' },
  searchIcon: {
    position: 'absolute', left: 32, top: '50%', transform: 'translateY(-50%)',
    fontSize: 18, color: 'var(--text-muted, #6B5D54)',
  },
  searchInput: {
    width: '100%', boxSizing: 'border-box',
    padding: '11px 12px 11px 40px',
    border: 'none',
    borderRadius: 16, background: 'var(--tone-2, #f6e7dd)',
    fontSize: 14, fontFamily: 'inherit', color: 'var(--text-primary, #241B17)', outline: 'none',
    transition: 'border-color 0.15s ease, background 0.15s ease',
  },

  filterRow: {
    display: 'flex', gap: 8, marginBottom: 4, padding: '0 18px',
    flexWrap: 'nowrap', overflowX: 'auto', WebkitOverflowScrolling: 'touch',
    scrollbarWidth: 'none',
  },
  filterChip: {
    display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0, whiteSpace: 'nowrap',
    padding: '8px 14px', minHeight: 44, borderRadius: 999,
    border: 'none',
    background: 'var(--tone-2, #f6e7dd)', color: 'var(--text-secondary, #574A42)',
    fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
    transition: 'background 0.15s ease, color 0.15s ease, border-color 0.15s ease',
  },
  filterChipActive: { background: 'var(--accent, #92405e)', color: '#fff' },
  filterChipCount: {
    fontSize: 11, fontWeight: 700, padding: '1px 7px', borderRadius: 999,
    background: 'var(--accent-light, rgba(146,64,94,0.10))', color: 'var(--accent, #92405e)',
  },
  filterChipCountActive: { background: 'rgba(255,255,255,0.24)', color: '#fff' },

  // The two space tabs. Bigger than the chips on purpose: this is the page's
  // first decision, not another filter. 44px minimum stands.
  spaceRow: {
    display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
    padding: '0 18px', marginBottom: 12,
  },
  spaceTab: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
    minHeight: 48, padding: '10px 12px', borderRadius: 16, border: 'none',
    background: 'var(--tone-2, #f6e7dd)', color: 'var(--text-secondary, #574A42)',
    fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
    transition: 'background 0.15s ease, color 0.15s ease',
    WebkitTapHighlightColor: 'transparent',
  },
  spaceTabActive: { background: 'var(--accent, #92405e)', color: '#fff' },
  spaceTabIcon: { fontSize: 18, lineHeight: 1 },
  spaceTabCount: {
    fontSize: 11.5, fontWeight: 700, padding: '1px 8px', borderRadius: 999,
    background: 'var(--accent-light, rgba(146,64,94,0.10))', color: 'var(--accent, #92405e)',
  },
  spaceTabCountActive: { background: 'rgba(255,255,255,0.24)', color: '#fff' },

  igNoLeads: {
    margin: 0, padding: '10px 18px', fontSize: 13,
    color: 'var(--text-muted, #6B5D54)', lineHeight: 1.5,
  },
  clearAllWrap: {
    display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
    padding: '2px 18px 8px',
  },
  clearAllBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    minHeight: 44, padding: '9px 16px', borderRadius: 999, border: 'none',
    background: 'var(--accent, #92405e)', color: '#fff',
    fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
    WebkitTapHighlightColor: 'transparent',
  },
  clearAllHint: { fontSize: 11.5, color: 'var(--text-muted, #6B5D54)' },

  headerWrap: { padding: '0 18px' },
  caughtUpBtn: {
    marginTop: 4, padding: '10px 18px', minHeight: 44,
    background: 'var(--tone-2, #f6e7dd)', color: 'var(--accent, #92405e)',
    border: 'none', borderRadius: 999,
    fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
  },

  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' },

  section: { marginBottom: 8 },
  sectionHeadBtn: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '20px 18px 7px',
    width: '100%', background: 'none', border: 'none', cursor: 'pointer',
    fontFamily: 'inherit', textAlign: 'left', minHeight: 44,
  },
  sectionChevron: { fontSize: 18, color: 'var(--text-muted, #6B5D54)' },
  sectionQuietNote: { fontSize: 11.5, color: 'var(--text-muted, #6B5D54)', fontStyle: 'italic', marginLeft: 'auto' },
  waitChip: {
    fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
    background: '#fdf0e3', color: '#9b5329', letterSpacing: '0.02em',
  },
  petalNote: { fontSize: 11, color: 'var(--accent, #92405e)', fontWeight: 600 },
  metaLine: {
    display: 'block', fontSize: 11.5, color: 'var(--text-muted, #6B5D54)',
    lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  headerActions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  bookChip: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '5px 12px', minHeight: 28, borderRadius: 999, border: 'none',
    background: '#f0e3cf', color: '#6d562f', fontSize: 11.5, fontWeight: 700,
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
  driverCaption: { fontSize: 10.5, color: 'var(--text-muted, #6B5D54)', padding: '0 10px 0 4px' },
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
    fontSize: 11, color: 'var(--text-muted, #6B5D54)', fontWeight: 600,
    whiteSpace: 'nowrap',
  },
  draftBubble: {
    maxWidth: 'min(78%, 420px)', padding: '10px 14px', borderRadius: 22,
    borderBottomRightRadius: 6, background: 'rgba(146,64,94,0.04)',
    border: '1.5px dashed rgba(146,64,94,0.45)', color: 'var(--text-primary, #241B17)',
    boxSizing: 'border-box',
  },
  draftEdit: {
    width: '100%', boxSizing: 'border-box', border: '1px solid rgba(146,64,94,0.25)',
    borderRadius: 10, padding: '8px 10px', fontSize: 14, fontFamily: 'inherit',
    background: '#fff', color: 'var(--text-primary, #241B17)', resize: 'vertical', outline: 'none',
  },
  draftActions: { display: 'flex', gap: 6, marginTop: 8 },
  draftSend: {
    padding: '6px 16px', minHeight: 32, borderRadius: 999, border: 'none',
    background: 'var(--accent, #92405e)', color: '#fff', fontSize: 12, fontWeight: 700,
    cursor: 'pointer', fontFamily: 'inherit', WebkitTapHighlightColor: 'transparent',
  },
  draftGhost: {
    padding: '6px 12px', minHeight: 32, borderRadius: 999, border: 'none',
    background: 'var(--tone-2, #f6e7dd)', color: 'var(--text-secondary, #574A42)',
    fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
    WebkitTapHighlightColor: 'transparent',
  },
  sectionHead: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '20px 18px 7px',
  },
  sectionTitle: {
    fontSize: 11, fontWeight: 700, letterSpacing: '0.13em', textTransform: 'uppercase',
    color: 'var(--text-muted, #6B5D54)',
  },
  sectionCount: {
    fontSize: 10.5, fontWeight: 700, color: 'var(--text-muted, #6B5D54)',
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
    background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted, #6B5D54)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'inherit',
    transition: 'color 0.15s ease, background 0.15s ease', zIndex: 3,
  },
  rowMenu: {
    position: 'absolute', top: 38, right: 6, zIndex: 5,
    background: 'var(--bg-card, #FFFCF9)', border: '1px solid var(--border-light, #ede7e3)',
    borderRadius: 16, boxShadow: 'var(--elev-3)', padding: 5, minWidth: 188,
  },
  rowMenuItem: {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
    padding: '9px 11px', borderRadius: 10, border: 'none', background: 'transparent',
    color: 'var(--danger, #9E2B32)', fontSize: 13, fontWeight: 600, cursor: 'pointer',
    fontFamily: 'inherit', textAlign: 'left',
  },
  avatarWrap: { position: 'relative', flexShrink: 0 },
  avatar: {
    width: 44, height: 44, borderRadius: 22,
    background: 'linear-gradient(135deg, #ffe0e7 0%, #ffbecd 100%)',
    color: '#7d3750', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 16.5, fontWeight: 700, fontFamily: "'Playfair Display', Georgia, serif",
    boxShadow: 'inset 0 0 0 1px rgba(146,64,94,0.05)',
  },
  avatarMuted: {
    width: 38, height: 38, borderRadius: 22, fontSize: 15,
    background: 'var(--border-light, #ede7e3)',
    color: 'var(--text-muted, #6B5D54)',
  },
  // The channel mark rides the avatar's bottom-right corner so the row reads
  // cleanly, with a cream ring punching it off the photo. Uses ChannelMark.
  avatarChannel: {
    position: 'absolute', right: -3, bottom: -3, borderRadius: 10,
    padding: 2, background: 'var(--bg-card, #FFFCF9)',
    display: 'inline-flex', lineHeight: 0,
    boxShadow: 'var(--elev-1)',
  },
  flagDot: {
    position: 'absolute', top: -1, left: -1, width: 12, height: 12,
    borderRadius: 6, background: '#c2410c', border: '2px solid var(--bg-card, #FFFCF9)', zIndex: 2,
  },
  rowBody: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 },
  rowTop: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  // Name and handle share one line. The name gives up space first, so a long
  // real name truncates before the handle disappears entirely.
  rowNameWrap: { display: 'flex', alignItems: 'baseline', gap: 5, minWidth: 0, overflow: 'hidden' },
  rowHandle: {
    fontSize: 11.5, color: 'var(--text-muted, #6B5D54)', fontWeight: 500, flexShrink: 0,
    maxWidth: '46%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  rowName: { fontSize: 15, color: 'var(--text-primary, #241B17)', letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  rowTime: { fontSize: 11, color: 'var(--text-muted, #6B5D54)', flexShrink: 0, fontWeight: 500, letterSpacing: '0.01em' },
  rowBottom: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 },
  rowPreview: {
    fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0,
    letterSpacing: '-0.003em', lineHeight: 1.35,
  },
  // Quieter type ramp for the Earlier (handled) section so it visibly recedes.
  rowNameMuted: { fontSize: 13.5, color: 'var(--text-secondary, #574A42)' },
  rowTimeMuted: { color: 'var(--text-muted, #6B5D54)' },
  rowPreviewMuted: { fontSize: 12.5 },
  rowBadge: {
    fontSize: 10.5, fontWeight: 700, color: '#fff', background: 'var(--accent, #92405e)',
    padding: '1px 7px', borderRadius: 22, minWidth: 17, textAlign: 'center', flexShrink: 0,
    lineHeight: 1.5, boxShadow: 'var(--elev-1)',
  },
  // Social lane: still countable, never urgent. No accent, no shadow.
  rowBadgeQuiet: {
    fontSize: 10.5, fontWeight: 600, color: 'var(--text-muted, #6B5D54)',
    background: 'rgba(146,64,94,0.06)',
    padding: '1px 7px', borderRadius: 22, minWidth: 17, textAlign: 'center', flexShrink: 0,
    lineHeight: 1.5,
  },
  rowMetaRow: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 1 },
  typeChip: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    fontSize: 11, fontWeight: 600, color: 'var(--text-muted, #6B5D54)',
    letterSpacing: '0.01em',
  },
  typeDot: { width: 6, height: 6, borderRadius: 6, flexShrink: 0 },

  empty: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    padding: '64px 22px', textAlign: 'center', gap: 12,
  },
  emptyIcon: {
    fontSize: 32, color: 'var(--accent, #92405e)', lineHeight: 1,
    width: 72, height: 72, borderRadius: 22,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: 'linear-gradient(135deg, #ffe7ee 0%, #fdeef3 100%)',
    boxShadow: 'inset 0 0 0 1px rgba(146,64,94,0.08)', marginBottom: 6,
  },
  emptyText: { fontSize: 14.5, color: 'var(--text-secondary, #574A42)', lineHeight: 1.5, margin: 0, maxWidth: 280 },
  emptyCta: {
    marginTop: 6, padding: '10px 18px', background: 'var(--accent, #92405e)', color: '#fff',
    borderRadius: 999, fontSize: 13, fontWeight: 600, textDecoration: 'none', fontFamily: 'inherit',
  },
  emptyHint: { fontSize: 12, color: 'var(--text-muted, #6B5D54)', margin: 0, maxWidth: 260 },
  errorCard: {
    margin: '12px 18px', padding: 14, background: '#FFF8F0', border: '1px solid #FFE8CC',
    borderRadius: 10, fontSize: 13, color: '#7B5E00', lineHeight: 1.5,
  },

  placeholder: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24 },

  convoFull: {
    height: 'var(--shell-viewport-nav)', overflow: 'hidden', background: 'var(--bg, #FBF6F1)',
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    display: 'flex', flexDirection: 'column', color: 'var(--text-primary, #241B17)',
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
    width: 36, height: 36, borderRadius: 16,
    background: 'var(--accent-light, #F6E7EC)', color: 'var(--accent, #92405e)',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 15, fontWeight: 600, fontFamily: "'Playfair Display', Georgia, serif",
  },
  convoNameWrap: { display: 'flex', flexDirection: 'column', gap: 1, flex: 1, minWidth: 0 },
  convoNameRow: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 },
  convoName: {
    fontSize: 15, fontWeight: 700, color: 'var(--text-primary, #241B17)',
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
  // These three were referenced but never defined, so React got style={undefined}
  // and the day dividers and the failed-send Retry rendered as bare unstyled
  // text. DateDivider was also never rendered at all until now.
  dateDivider: { display: 'flex', justifyContent: 'center', margin: '14px 0 8px' },
  dateChip: {
    fontSize: 11, fontWeight: 600, color: 'var(--text-muted, #6B5D54)',
    background: 'var(--surface-2, #f3ede9)', borderRadius: 999, padding: '3px 12px',
    letterSpacing: '0.02em',
  },
  failedNote: {
    minHeight: 44, display: 'inline-flex', alignItems: 'center', gap: 5,
    border: 'none', background: 'none', padding: '4px 3px', cursor: 'pointer',
    fontSize: 11, fontWeight: 600, fontFamily: 'inherit', color: '#B3261E',
  },
  bubbleTag: { fontSize: 9.5, fontWeight: 700, color: 'var(--accent, #92405e)', letterSpacing: '0.05em', textTransform: 'uppercase', paddingLeft: 3, opacity: 0.85 },
  bubble: {
    padding: '10px 14px', border: '1px solid', borderRadius: 22,
    boxShadow: 'var(--elev-1)',
  },
  bubbleText: { fontSize: 14, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  bubbleMeta: { fontSize: 10, marginTop: 4, display: 'flex', alignItems: 'center', gap: 5, justifyContent: 'flex-end' },

  waHint: {
    margin: '0 14px 8px', padding: '10px 12px', background: '#FFF8E1', border: '1px solid #FFE082',
    borderRadius: 10, fontSize: 12, color: '#7B5E00', lineHeight: 1.5,
  },
  waHintLink: { color: '#7B5E00', fontWeight: 700, marginLeft: 6, textDecoration: 'underline' },
  noContact: {
    margin: '0 14px 14px', padding: 12, background: '#FDECEA', border: '1px solid #F5C6C0',
    borderRadius: 10, fontSize: 12, color: '#8A2A1C', lineHeight: 1.5,
  },

  composerBar: {
    // In-flow at the column's bottom. The shell already reserves the floating
    // nav and mic, so adding clearance here stacked ~240px of dead space.
    padding: '10px 12px 12px', background: 'var(--tone-1, #fbf1ea)',
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
    background: 'var(--surface-container-low, #f8f2ef)', border: '1px solid rgba(146,64,94,0.14)', color: 'var(--accent, #92405e)',
    borderRadius: 999, padding: '13px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
    lineHeight: 1.2, maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    transition: 'background 0.15s ease',
  },
  composerRow: { display: 'flex', alignItems: 'flex-end', gap: 8 },
  composerInput: {
    flex: 1, padding: '11px 15px', border: '1px solid var(--border-light, #ede7e3)', borderRadius: 22,
    background: 'var(--bg, #FBF6F1)', fontSize: 14, fontFamily: 'inherit', resize: 'none', maxHeight: 140,
    color: 'var(--text-primary, #241B17)', outline: 'none', lineHeight: 1.4,
    transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
  },
  sendBtn: {
    width: 44, height: 44, borderRadius: 22, border: 'none', background: 'var(--accent, #92405e)', color: '#fff',
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    boxShadow: 'var(--elev-1)', transition: 'opacity 0.15s ease, transform 0.1s ease',
  },
  sendError: {
    fontSize: 12, color: '#8A2A1C', background: '#FDECEA', border: '1px solid #F5C6C0', borderRadius: 10, padding: '6px 10px',
  },

  skelLine: { height: 12, width: '60%', borderRadius: 6, background: 'var(--border-light, #ede7e3)', display: 'block' },
  skelLineShort: { height: 10, width: '40%', borderRadius: 6, background: 'var(--border-light, #ede7e3)', display: 'block', marginTop: 4 },
};

if (typeof document !== 'undefined' && !document.getElementById('inbox-bold-css')) {
  const s = document.createElement('style');
  s.id = 'inbox-bold-css';
  s.textContent = `
    .inbox-seg-row::-webkit-scrollbar { display: none; }
    .inbox-row-li { border-bottom: 1px solid rgba(146,64,94,0.07); }
    .inbox-row-li:last-child { border-bottom: none; }
    .inbox-row:hover { background: rgba(146,64,94,0.045) !important; }
    .inbox-row-active, .inbox-row-active:hover { background: var(--accent-wash, #FBF2F5) !important; }
  `;
  document.head.appendChild(s);
}
