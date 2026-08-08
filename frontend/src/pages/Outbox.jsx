/**
 * Florrie's Outbox , the one calm place to give your yes or no.
 *
 * Florrie never messages a client you know without checking first. Anything
 * waiting on you lands here, in two kinds:
 *
 *   1. Holds      , proactive messages Florrie lined up (rebook nudges,
 *                   check-ins, win-backs). Rows in outbound_sends with
 *                   status 'pending_approval'.
 *   2. Replies    , a client you know messaged in and Florrie drafted an
 *                   answer. Escalated rows in the messages table.
 *
 * Both show the client, why it is here, the exact words (editable), and two
 * plain buttons: Send it, or Not now. Nothing goes out until you say so.
 *
 * APIs (all need the Supabase bearer token):
 *   GET   /api/outbound/pending
 *   PATCH /api/outbound/:id            { body }
 *   POST  /api/outbound/:id/approve
 *   POST  /api/outbound/:id/skip
 *   POST  /api/outbound/approve-all
 *   GET   /api/escalations
 *   POST  /api/escalations/:id/resolve { response, action }
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import PageHeader from '../components/ui/PageHeader.jsx';
import { bloom } from '../lib/bloom.js';
import Icon, { iconName } from '../components/ui/Icon';

const TYPE_LABELS = {
  rebook_nudge: 'Rebook nudge',
  gap_fill: 'Gap-fill offer',
  predictive_nudge: 'Check-in',
  review_request: 'Review request',
  comeback: 'Win-back',
};

function typeLabel(type) {
  if (!type) return 'Message';
  if (TYPE_LABELS[type]) return TYPE_LABELS[type];
  return type
    .split(/[_\s]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Plain "why this is here" lines. Proactive holds get a sentence tied to the
// reason the guard held them; known regulars get a warmer one.
function holdWhy(item) {
  const reason = item.reason || '';
  if (reason === 'known_client_review' || reason === 'known_client_reply') {
    return 'A regular you know. I held it for your OK.';
  }
  return 'I lined this up. Send it whenever you like.';
}

function isRegularHold(item) {
  return String(item.reason || '').startsWith('known_client');
}

function channelMeta(channel) {
  const c = String(channel || '').toLowerCase();
  if (c === 'whatsapp') return { icon: 'chat', label: 'WhatsApp' };
  if (c === 'instagram') return { icon: 'photo_camera', label: 'Instagram' };
  if (c === 'sms') return { icon: 'sms', label: 'SMS' };
  if (c === 'email') return { icon: 'mail', label: 'Email' };
  return { icon: 'forum', label: c ? c.charAt(0).toUpperCase() + c.slice(1) : 'Message' };
}

function displayNameOf(first, last) {
  // Show first + last so Ellie can tell apart clients who share a first name.
  // This is a label she sees only; the client-facing message body is separate.
  const f = (first || '').trim();
  const l = (last || '').trim();
  if (f && l) return `${f} ${l}`;
  return f || l || 'A client';
}

function initialOf(name) {
  return (name || 'C').trim().charAt(0).toUpperCase() || 'C';
}

async function authedFetch(path, opts = {}) {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  const doFetch = (tok) => fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${tok}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  let res = await doFetch(token);
  // One retry after a forced session refresh: a stale token mid-session made
  // every action toast a generic failure even though the tap was fine.
  if (res.status === 401) {
    try {
      const { data: refreshed } = await supabase.auth.refreshSession();
      const fresh = refreshed?.session?.access_token;
      if (fresh) res = await doFetch(fresh);
    } catch { /* fall through with the 401 */ }
  }
  return res;
}

// Normalise a held proactive row into the shared shape.
function fromHold(row) {
  const first = displayNameOf(row.clients?.first_name, row.clients?.last_name);
  return {
    key: `hold-${row.id}`,
    kind: 'hold',
    id: row.id,
    displayName: first,
    regular: isRegularHold(row),
    channel: row.channel || 'whatsapp',
    typeLabel: typeLabel(row.message_type),
    why: holdWhy(row),
    body: row.body || '',
    createdAt: row.created_at,
    quiet: row.reason === 'just_me_silent_draft',
    // Gap offers carry their slot in the drafted copy ("... on Mon 6 Jul at
    // 13:30 ..."), which lets the page collapse many offers for one slot
    // into a single decision.
    slot: row.message_type === 'gap_fill'
      ? (/(?:on|slot on)\s+(.+?)\s+at\s+(\d{1,2}:\d{2})/.exec(row.body || '') || []).slice(1).join(' ') || null
    : null,
  };
}

// Normalise an escalated reply (messages row) into the shared shape. The
// editable text is Florrie's suggested reply (ai_response), not the client's
// inbound message.
function fromEscalation(row) {
  const first = displayNameOf(row.clients?.first_name, row.clients?.last_name);
  return {
    key: `reply-${row.id}`,
    kind: 'reply',
    id: row.id,
    displayName: first,
    regular: true, // these escalations are clients Florrie knows
    channel: row.channel || 'sms',
    typeLabel: 'Reply',
    why: row.escalated_reason || 'A client you know messaged in. Have a look before it goes.',
    inbound: row.content || '',
    body: row.ai_response || '',
    createdAt: row.created_at,
  };
}

export default function Outbox() {
  const [holds, setHolds] = useState([]);
  const [replies, setReplies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [approvingAll, setApprovingAll] = useState(false);
  const [toast, setToast] = useState(null);

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3200);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pendRes, escRes] = await Promise.all([
        authedFetch('/api/outbound/pending'),
        authedFetch('/api/escalations').catch(() => null),
      ]);
      if (!pendRes.ok) throw new Error('Could not load your outbox');
      const pendData = await pendRes.json();
      const pend = Array.isArray(pendData?.pending) ? pendData.pending : [];
      setHolds(pend.map(fromHold));

      let esc = [];
      if (escRes && escRes.ok) {
        const escData = await escRes.json();
        const rows = Array.isArray(escData?.escalations) ? escData.escalations : [];
        // Only show escalations that actually have a drafted reply to approve.
        esc = rows.filter(r => r.ai_response && String(r.ai_response).trim()).map(fromEscalation);
      }
      setReplies(esc);
    } catch (err) {
      setError(err.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ----- Hold actions (proactive) -----
  async function saveHold(id, body) {
    try {
      const res = await authedFetch(`/api/outbound/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ body }),
      });
      if (!res.ok) throw new Error();
    } catch {
      showToast('Could not save that edit. Try again.');
    }
  }

  async function approveHold(id) {
    try {
      const res = await authedFetch(`/api/outbound/${id}/approve`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) throw new Error(data?.error || 'Send failed');
      setHolds(prev => prev.filter(i => i.id !== id)); window.dispatchEvent(new Event('florrie:refresh-counts'));
      bloom();
      showToast('Sent.');
    } catch {
      showToast('Could not send that one. Try again.');
    }
  }

  async function skipHold(id) {
    try {
      const res = await authedFetch(`/api/outbound/${id}/skip`, { method: 'POST' });
      if (!res.ok) throw new Error();
      setHolds(prev => prev.filter(i => i.id !== id)); window.dispatchEvent(new Event('florrie:refresh-counts'));
    } catch {
      showToast('Could not skip that one. Try again.');
    }
  }

  // ----- Reply actions (escalations) -----
  // Reuse the Inbox / Escalations resolve path so the tone model still learns
  // from any edit. action: 'send_as_is' | 'send_edited' | 'dismiss'.
  async function approveReply(id, originalBody, body) {
    const edited = body.trim() !== (originalBody || '').trim();
    try {
      const res = await authedFetch(`/api/escalations/${id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({
          response: body,
          action: edited ? 'send_edited' : 'send_as_is',
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || '');
      }
      setReplies(prev => prev.filter(i => i.id !== id)); window.dispatchEvent(new Event('florrie:refresh-counts'));
      bloom();
      showToast('Sent.');
    } catch (err) {
      showToast(err?.message ? `Could not send: ${err.message}` : 'Could not send that one. Try again.');
    }
  }

  async function skipReply(id) {
    try {
      const res = await authedFetch(`/api/escalations/${id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ action: 'dismiss' }),
      });
      // 404 = already resolved elsewhere (another device, the inbox, a retry):
      // the card is done either way, so clear it instead of erroring.
      if (res.status === 404) {
        setReplies(prev => prev.filter(i => i.id !== id)); window.dispatchEvent(new Event('florrie:refresh-counts'));
        return;
      }
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || '');
      }
      setReplies(prev => prev.filter(i => i.id !== id)); window.dispatchEvent(new Event('florrie:refresh-counts'));
    } catch (err) {
      showToast(err?.message ? `Could not dismiss: ${err.message}` : 'Could not dismiss that one. Try again.');
    }
  }

  // Approve all only clears the proactive holds (safe, one transport). Replies
  // stay so each client answer gets a real read first.
  async function approveAllHolds() {
    setApprovingAll(true);
    try {
      const res = await authedFetch('/api/outbound/approve-all', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error();
      const sent = data?.sent ?? 0;
      const failed = data?.failed ?? 0;
      if (failed > 0) showToast(`Sent ${sent}. ${failed} could not go out, still here.`);
      else showToast(`Sent ${sent}.`);
      await load();
    } catch {
      showToast('Could not send them all. Try again.');
    } finally {
      setApprovingAll(false);
    }
  }

  // Quiet drafts: clients Ellie marked "just me". Florrie prepares the words
  // but never nags: tucked at the bottom, excluded from counts and Send all.
  const loudHolds = holds.filter(h => !h.quiet);
  const quietHolds = holds.filter(h => h.quiet);

  // Structure (approved concept): many offers for ONE slot are one decision,
  // replies and gap offers are time-sensitive, everything else can wait.
  const gapHolds = loudHolds.filter(h => h.slot);
  const otherHolds = loudHolds.filter(h => !h.slot);
  const batches = Object.values(gapHolds.reduce((acc, h) => {
    (acc[h.slot] = acc[h.slot] || { slot: h.slot, items: [] }).items.push(h);
    return acc;
  }, {}));
  const decisions = replies.length + otherHolds.length + batches.length;
  const total = loudHolds.length + replies.length;
  const [deckOpen, setDeckOpen] = useState(false);

  async function approveBatch(batch) {
    let sent = 0;
    for (const item of batch.items) {
      try {
        const res = await authedFetch(`/api/outbound/${item.id}/approve`, { method: 'POST' });
        if (res.ok) sent++;
      } catch { /* count what went */ }
    }
    setHolds(prev => prev.filter(i => !batch.items.some(b => b.id === i.id)));
    window.dispatchEvent(new Event('florrie:refresh-counts'));
    if (sent > 0) bloom();
    showToast(sent === batch.items.length ? `Offered to ${sent}.` : `Offered to ${sent} of ${batch.items.length}.`);
  }

  async function skipBatch(batch) {
    for (const item of batch.items) {
      try { await authedFetch(`/api/outbound/${item.id}/skip`, { method: 'POST' }); } catch { /* best effort */ }
    }
    setHolds(prev => prev.filter(i => !batch.items.some(b => b.id === i.id)));
    window.dispatchEvent(new Event('florrie:refresh-counts'));
  }

  return (
    <div style={s.page}>
      <PageHeader
        title="Florrie's Outbox"
        subtitle="Everything waiting on your yes or no. Nothing goes out without you."
      />

      {loading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : total === 0 && quietHolds.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div style={s.topBar}>
            <span style={s.waitingLabel}>{decisions} for your yes or no</span>
            {decisions > 1 && (
              <button onClick={() => setDeckOpen(true)} style={s.approveAllBtn}>
                Review one by one
              </button>
            )}
          </div>

          {(replies.length > 0 || batches.length > 0) && (
            <Section
              icon="bolt"
              title="Worth doing now"
              hint="Clients waiting on an answer and slots that expire."
            >
              {replies.map(item => (
                <ReviewCard
                  key={item.key}
                  item={item}
                  onApprove={(body) => approveReply(item.id, item.body, body)}
                  onSkip={() => skipReply(item.id)}
                  skipLabel="Dismiss"
                />
              ))}
              {batches.map(batch => (
                <BatchCard
                  key={batch.slot}
                  batch={batch}
                  onSendAll={() => approveBatch(batch)}
                  onSkipAll={() => skipBatch(batch)}
                  onSkipOne={(id) => skipHold(id)}
                />
              ))}
            </Section>
          )}

          {otherHolds.length > 0 && (
            <Section
              icon="schedule_send"
              title="When you have a minute"
              hint="Nothing here expires. Send, tweak, or leave them."
            >
              {otherHolds.map(item => (
                <ReviewCard
                  key={item.key}
                  item={item}
                  onApprove={(body) => approveHold(item.id, body)}
                  onSkip={() => skipHold(item.id)}
                  onSave={(body) => saveHold(item.id, body)}
                  skipLabel="Not now"
                />
              ))}
            </Section>
          )}

          {quietHolds.length > 0 && (
            <Section
              icon="volume_off"
              title="Quiet drafts for people you handle yourself"
              hint="You said these clients are yours. The words are here if you ever want them, and nothing sends unless you say so."
            >
              {quietHolds.map(item => (
                <ReviewCard
                  key={item.key}
                  item={item}
                  onApprove={(body) => approveHold(item.id, body)}
                  onSkip={() => skipHold(item.id)}
                  onSave={(body) => saveHold(item.id, body)}
                  skipLabel="Not now"
                />
              ))}
            </Section>
          )}
        </>
      )}

      {deckOpen && (
        <ReviewDeck
          replies={replies}
          batches={batches}
          holds={otherHolds}
          onReply={(item) => approveReply(item.id, item.body, item.body)}
          onReplySkip={(item) => skipReply(item.id)}
          onBatch={(batch) => approveBatch(batch)}
          onBatchSkip={(batch) => skipBatch(batch)}
          onHold={(item) => approveHold(item.id, item.body)}
          onHoldSkip={(item) => skipHold(item.id)}
          onClose={() => setDeckOpen(false)}
        />
      )}

      {toast && <div style={s.toast}>{toast}</div>}
    </div>
  );
}

/**
 * One card per DECISION: many offers for a slot collapse into a single card
 * with a choose-who expander. The gold edge marks a Florrie initiative.
 */
function BatchCard({ batch, onSendAll, onSkipAll, onSkipOne }) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [skipped, setSkipped] = useState([]);
  const live = batch.items.filter(i => !skipped.includes(i.id));
  if (live.length === 0) return null;
  const preview = live[0]?.body || '';

  return (
    <div style={{ ...s.card, borderLeft: '3px solid #c9a96e' }}>
      <div style={s.cardTop}>
        <span style={{ ...s.avatar, background: '#f6ead6', color: '#8a6d3b' }} aria-hidden><Icon name="flower" size={15} /></span>
        <div style={s.cardTopText}>
          <div style={s.nameRow}>
            <span style={s.clientName}>Fill the {batch.slot} gap</span>
          </div>
          <span style={s.typeLabel}>One decision, {live.length} offer{live.length === 1 ? '' : 's'}. Florrie staggers them so nobody clashes.</span>
        </div>
      </div>
      <div style={s.bodyBox}>{preview}</div>
      <div style={s.actions}>
        <button
          onClick={async () => { setBusy(true); await onSendAll(); setBusy(false); }}
          disabled={busy}
          style={{ ...s.approveBtn, opacity: busy ? 0.6 : 1 }}
        >
          {busy ? 'Sending…' : `Offer it to ${live.length === 1 ? live[0].displayName : `all ${live.length}`}`}
        </button>
        <button onClick={onSkipAll} disabled={busy} style={s.skipBtn}>Not now</button>
      </div>
      <button onClick={() => setExpanded(v => !v)} style={s.chooseWho}>
        {expanded ? 'Hide the list' : 'Choose who ›'}
      </button>
      {expanded && live.map(item => (
        <div key={item.id} style={s.batchRow}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{item.displayName}</span>
          <button className="fl-tap"
            onClick={() => { setSkipped(prev => [...prev, item.id]); onSkipOne(item.id); }}
            style={{ ...s.skipBtn, minHeight: 34, padding: '0 14px', fontSize: 12.5 }}
          >
            Skip her
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Review deck: approvals as a 20-second swipe session. Right or "Yes" sends,
 * left or "Not now" skips. Ends on the earned empty state.
 */
function ReviewDeck({ replies, batches, holds, onReply, onReplySkip, onBatch, onBatchSkip, onHold, onHoldSkip, onClose }) {
  const items = [
    ...replies.map(r => ({ kind: 'reply', title: `${r.displayName} is waiting on a reply`, why: r.why, body: r.body, data: r })),
    ...batches.map(b => ({ kind: 'batch', title: `Fill the ${b.slot} gap`, why: `One yes offers it to ${b.items.length} client${b.items.length === 1 ? '' : 's'}`, body: b.items[0]?.body || '', data: b })),
    ...holds.map(h => ({ kind: 'hold', title: `${h.displayName} · ${h.typeLabel}`, why: h.why, body: h.body, data: h })),
  ];
  const [idx, setIdx] = useState(0);
  const [leaving, setLeaving] = useState(null); // 'yes' | 'no'
  const startX = useRef(null);
  const done = idx >= items.length;

  useEffect(() => { if (done && items.length > 0) bloom(); }, [done]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(yes) {
    if (leaving || done) return;
    const it = items[idx];
    setLeaving(yes ? 'yes' : 'no');
    try {
      if (yes) {
        if (it.kind === 'reply') await onReply(it.data);
        else if (it.kind === 'batch') await onBatch(it.data);
        else await onHold(it.data);
      } else {
        if (it.kind === 'reply') await onReplySkip(it.data);
        else if (it.kind === 'batch') await onBatchSkip(it.data);
        else await onHoldSkip(it.data);
      }
    } finally {
      setTimeout(() => { setIdx(i => i + 1); setLeaving(null); }, 260);
    }
  }

  const cardShift = leaving === 'yes' ? 'translateX(120%) rotate(8deg)' : leaving === 'no' ? 'translateX(-120%) rotate(-8deg)' : 'translateX(0)';

  return (
    <div style={s.deckOverlay} role="dialog" aria-modal="true" aria-label="Review one by one">
      <button onClick={onClose} style={s.deckClose} aria-label="Close">×</button>
      {done ? (
        <div style={{ textAlign: 'center' }} onClick={onClose}>
          <p style={s.deckDone}>All caught up 🌸</p>
          <p style={{ fontSize: 13, color: 'var(--text-secondary, #574A42)', marginTop: 8 }}>Florrie handles the rest. Tap to close.</p>
        </div>
      ) : (
        <>
          <p style={s.deckProg}>{idx + 1} of {items.length}</p>
          <div style={{ position: 'relative', width: '100%', maxWidth: 340 }}>
            <div style={s.deckBehind} />
            <div
              style={{ ...s.deckCard, transform: cardShift, opacity: leaving ? 0 : 1 }}
              onTouchStart={e => { startX.current = e.touches[0].clientX; }}
              onTouchEnd={e => {
                if (startX.current === null) return;
                const dx = e.changedTouches[0].clientX - startX.current;
                if (dx > 60) act(true);
                else if (dx < -60) act(false);
                startX.current = null;
              }}
            >
              <p style={{ margin: 0, fontSize: 15.5, fontWeight: 700 }}>{items[idx].title}</p>
              <p style={{ margin: '4px 0 10px', fontSize: 12, color: 'var(--text-secondary, #574A42)' }}>{items[idx].why}</p>
              <div style={{ ...s.bodyBox, maxHeight: 180, overflowY: 'auto' }}>{items[idx].body}</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 18, width: '100%', maxWidth: 340 }}>
            <button onClick={() => act(false)} disabled={!!leaving} style={{ ...s.skipBtn, flex: 1 }}>Not now</button>
            <button onClick={() => act(true)} disabled={!!leaving} style={{ ...s.approveBtn, flex: 1 }}>Yes, send</button>
          </div>
        </>
      )}
    </div>
  );
}

function Section({ icon, title, hint, children }) {
  return (
    <div style={s.section}>
      <div style={s.sectionHead}>
        <Icon name={iconName(icon)} inline style={s.sectionIcon} />
        <div style={{ minWidth: 0 }}>
          <div style={s.sectionTitle}>{title}</div>
          <div style={s.sectionHint}>{hint}</div>
        </div>
      </div>
      <div style={s.list}>{children}</div>
    </div>
  );
}

function ReviewCard({ item, onApprove, onSkip, onSave, skipLabel }) {
  const [body, setBody] = useState(item.body || '');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const ch = channelMeta(item.channel);

  function handleBlur() {
    if (dirty && onSave) {
      onSave(body);
      setDirty(false);
    }
  }

  async function send() {
    if (busy) return;
    setBusy(true);
    if (dirty && onSave) { onSave(body); setDirty(false); }
    await onApprove(body);
    setBusy(false);
  }

  async function skip() {
    if (busy) return;
    setBusy(true);
    await onSkip();
    setBusy(false);
  }

  return (
    <div style={s.card}>
      <div style={s.cardTop}>
        <span style={s.avatar} aria-hidden>{initialOf(item.displayName)}</span>
        <div style={s.cardTopText}>
          <div style={s.nameRow}>
            <span style={s.clientName}>{item.displayName}</span>
            {item.regular && <span style={s.regularPill}>Regular</span>}
          </div>
          <span style={s.typeLabel}>{item.typeLabel}</span>
        </div>
        <span style={s.channelChip}>
          <Icon name={iconName(ch.icon)} inline style={s.channelChipIcon} />
          {ch.label}
        </span>
      </div>

      <p style={s.why}>{item.why}</p>

      {item.kind === 'reply' && item.inbound && (
        <div style={s.inboundQuote}>
          <span style={s.inboundLabel}>They said</span>
          <span style={s.inboundText}>{item.inbound}</span>
        </div>
      )}

      <textarea
        value={body}
        onChange={e => { setBody(e.target.value); setDirty(true); }}
        onBlur={handleBlur}
        rows={4}
        style={s.textarea}
        aria-label="Message text"
      />

      <div style={s.actions}>
        <button onClick={send} disabled={busy || !body.trim()} style={{ ...s.approveBtn, opacity: busy || !body.trim() ? 0.6 : 1 }}>
          {busy ? 'Sending...' : 'Send it'}
        </button>
        <button onClick={skip} disabled={busy} style={s.skipBtn}>{skipLabel || 'Not now'}</button>
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div style={s.list}>
      {[0, 1, 2].map(i => (
        <div key={i} style={{ ...s.card, ...s.skeletonCard }}>
          <div style={{ ...s.skelLine, width: '45%' }} />
          <div style={{ ...s.skelLine, width: '70%', marginTop: 10 }} />
          <div style={{ ...s.skelBlock, marginTop: 12 }} />
          <div style={{ ...s.skelLine, width: '100%', marginTop: 14, height: 38 }} />
        </div>
      ))}
    </div>
  );
}

function ErrorState({ message, onRetry }) {
  return (
    <div style={s.centerState}>
      <Icon name={iconName('cloud_off')} inline style={s.stateIcon} />
      <p style={s.stateTitle}>{message}</p>
      <p style={s.stateSub}>Give it another go.</p>
      <button onClick={onRetry} style={s.retryBtn}>Try again</button>
    </div>
  );
}

function EmptyState() {
  return (
    <div style={s.centerState}>
      <Icon name={iconName('mark_email_read')} inline style={s.stateIcon} />
      <p style={s.stateTitle}>All clear.</p>
      <p style={s.stateSub}>
        Anything Florrie wants to send a client you know will wait here for your OK first.
      </p>
    </div>
  );
}

const s = {
  page: {
    padding: '16px 16px 32px',
    paddingBottom: 'calc(env(safe-area-inset-bottom, 8px) + 96px)',
    maxWidth: 480,
    margin: '0 auto',
    fontFamily: "'Plus Jakarta Sans', 'DM Sans', -apple-system, sans-serif",
    color: 'var(--text-primary, #241B17)',
  },

  topBar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
    gap: 12,
  },
  waitingLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-secondary, #574A42)',
  },
  approveAllBtn: {
    padding: '9px 16px',
    borderRadius: 999,
    border: 'none',
    background: 'var(--accent, #92405e)',
    color: '#fff',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
    WebkitTapHighlightColor: 'transparent',
  },

  section: { marginBottom: 22 },
  sectionHead: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 10,
    padding: '0 2px',
  },
  sectionIcon: {
    fontSize: 20,
    color: 'var(--accent, #92405e)',
    marginTop: 1,
    flexShrink: 0,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: 700,
    color: 'var(--text-primary, #241B17)',
    lineHeight: 1.25,
  },
  sectionHint: {
    fontSize: 12,
    color: 'var(--text-secondary, #574A42)',
    lineHeight: 1.4,
    marginTop: 2,
  },

  list: { display: 'flex', flexDirection: 'column', gap: 12 },

  card: {
    background: 'var(--tone-1, #fbf1ea)',
    borderRadius: 22,
    padding: 16,
  },
  cardTop: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 11,
    marginBottom: 10,
  },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 22,
    background: 'linear-gradient(135deg, #ffd9e2 0%, #ffb8c8 100%)',
    color: '#92405e',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 16,
    fontWeight: 700,
    flexShrink: 0,
    fontFamily: "'Playfair Display', Georgia, serif",
  },
  cardTopText: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: 1 },
  nameRow: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 },
  clientName: {
    fontSize: 15,
    fontWeight: 700,
    color: 'var(--text-primary, #241B17)',
    lineHeight: 1.2,
  },
  regularPill: {
    flexShrink: 0,
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.02em',
    padding: '2px 8px',
    borderRadius: 999,
    background: '#fff0f4',
    color: 'var(--accent, #92405e)',
    border: '1px solid #ffd9e2',
  },
  typeLabel: {
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--text-secondary, #574A42)',
  },
  channelChip: {
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 10.5,
    fontWeight: 700,
    letterSpacing: '0.01em',
    padding: '4px 9px',
    borderRadius: 999,
    background: 'var(--accent-light, #F6E7EC)',
    color: 'var(--accent, #92405e)',
  },
  channelChipIcon: { fontSize: 13 },

  why: {
    fontSize: 12.5,
    color: 'var(--text-secondary, #574A42)',
    lineHeight: 1.45,
    margin: '0 0 10px',
    fontWeight: 500,
  },

  inboundQuote: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    background: 'var(--bg, #FBF6F1)',
    borderRadius: 10,
    padding: '9px 12px',
    marginBottom: 10,
    borderLeft: '3px solid var(--accent-light, #F6E7EC)',
  },
  inboundLabel: {
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: 'var(--text-muted, #6B5D54)',
  },
  inboundText: {
    fontSize: 13,
    color: 'var(--text-primary, #241B17)',
    lineHeight: 1.45,
  },

  textarea: {
    width: '100%',
    boxSizing: 'border-box',
    resize: 'vertical',
    minHeight: 80,
    padding: '11px 12px',
    borderRadius: 10,
    border: 'none',
    background: 'var(--tone-2, #f6e7dd)',
    color: 'var(--text-primary, #241B17)',
    fontSize: 13,
    lineHeight: 1.5,
    fontFamily: 'inherit',
    outline: 'none',
  },

  actions: { display: 'flex', gap: 8, marginTop: 12 },
  approveBtn: {
    flex: 1,
    padding: '11px 0',
    borderRadius: 10,
    border: 'none',
    background: 'var(--accent, #92405e)',
    color: '#fff',
    fontSize: 14,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
    WebkitTapHighlightColor: 'transparent',
  },
  skipBtn: {
    padding: '11px 20px',
    borderRadius: 10,
    border: 'none',
    background: 'var(--tone-2, #f6e7dd)',
    color: 'var(--text-secondary, #574A42)',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    WebkitTapHighlightColor: 'transparent',
  },

  bodyBox: {
    background: 'var(--tone-2, #f6e7dd)', borderRadius: 10,
    padding: '10px 12px', fontSize: 13, lineHeight: 1.5,
    color: 'var(--text-primary, #241B17)', whiteSpace: 'pre-wrap',
  },
  chooseWho: {
    width: '100%', minHeight: 40, padding: '9px 0', marginTop: 4,
    background: 'none', border: 'none', color: 'var(--accent, #92405e)',
    fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
    textAlign: 'left', WebkitTapHighlightColor: 'transparent',
  },
  batchRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    background: 'var(--tone-2, #f6e7dd)', borderRadius: 10, padding: '8px 12px', marginTop: 6,
  },
  deckOverlay: {
    position: 'fixed', inset: 0, zIndex: 1000,
    background: 'rgba(254,248,244,0.97)',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    padding: 24,
  },
  deckClose: {
    position: 'absolute', top: 16, right: 20,
    width: 44, height: 44, background: 'none', border: 'none',
    fontSize: 26, color: 'var(--text-muted, #6B5D54)', cursor: 'pointer',
  },
  deckProg: { fontSize: 12.5, fontWeight: 600, color: 'var(--text-muted, #6B5D54)', marginBottom: 14 },
  deckBehind: { position: 'absolute', left: '8%', right: '8%', bottom: -10, height: 16, background: 'var(--tone-2, #f6e7dd)', borderRadius: 16, zIndex: 0 },
  deckCard: {
    position: 'relative', zIndex: 1,
    background: 'var(--tone-1, #fbf1ea)', borderRadius: 22, padding: 20,
    boxShadow: 'var(--elev-3)',
    transition: 'transform 0.26s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.26s',
  },
  deckDone: {
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
    fontSize: 24, color: 'var(--accent, #92405e)', margin: 0,
  },
  skeletonCard: { pointerEvents: 'none' },
  skelLine: {
    height: 13,
    borderRadius: 6,
    background: 'var(--border-light, #ede7e3)',
  },
  skelBlock: {
    height: 70,
    borderRadius: 10,
    background: 'var(--tone-2, #f6e7dd)',
  },

  centerState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
    padding: '56px 24px',
  },
  stateIcon: {
    fontSize: 44,
    color: 'var(--text-muted, #6B5D54)',
    marginBottom: 12,
  },
  stateTitle: {
    fontSize: 16,
    fontWeight: 700,
    color: 'var(--text-primary, #241B17)',
    margin: '0 0 6px',
  },
  stateSub: {
    fontSize: 13,
    color: 'var(--text-secondary, #574A42)',
    lineHeight: 1.5,
    margin: 0,
    maxWidth: 280,
  },
  retryBtn: {
    marginTop: 18,
    padding: '10px 22px',
    borderRadius: 999,
    border: 'none',
    background: 'var(--accent, #92405e)',
    color: '#fff',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },

  toast: {
    position: 'fixed',
    left: '50%',
    bottom: 'calc(env(safe-area-inset-bottom, 8px) + 92px)',
    transform: 'translateX(-50%)',
    background: 'var(--text-primary, #241B17)',
    color: '#fff',
    fontSize: 13,
    fontWeight: 500,
    padding: '10px 18px',
    borderRadius: 999,
    boxShadow: 'var(--elev-2)',
    zIndex: 1000,
    maxWidth: 'calc(100vw - 32px)',
    textAlign: 'center',
  },
};
