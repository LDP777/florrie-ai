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
import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import PageHeader from '../components/ui/PageHeader.jsx';
import { bloom } from '../lib/bloom.js';

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

function firstNameOf(first, last) {
  const f = (first || '').trim();
  if (f) return f;
  const l = (last || '').trim();
  return l || 'A client';
}

function initialOf(name) {
  return (name || 'C').trim().charAt(0).toUpperCase() || 'C';
}

async function authedFetch(path, opts = {}) {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  return fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
}

// Normalise a held proactive row into the shared shape.
function fromHold(row) {
  const first = firstNameOf(row.clients?.first_name, row.clients?.last_name);
  return {
    key: `hold-${row.id}`,
    kind: 'hold',
    id: row.id,
    firstName: first,
    regular: isRegularHold(row),
    channel: row.channel || 'whatsapp',
    typeLabel: typeLabel(row.message_type),
    why: holdWhy(row),
    body: row.body || '',
    createdAt: row.created_at,
  };
}

// Normalise an escalated reply (messages row) into the shared shape. The
// editable text is Florrie's suggested reply (ai_response), not the client's
// inbound message.
function fromEscalation(row) {
  const first = firstNameOf(row.clients?.first_name, row.clients?.last_name);
  return {
    key: `reply-${row.id}`,
    kind: 'reply',
    id: row.id,
    firstName: first,
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
      if (!res.ok) throw new Error();
      setReplies(prev => prev.filter(i => i.id !== id)); window.dispatchEvent(new Event('florrie:refresh-counts'));
      bloom();
      showToast('Sent.');
    } catch {
      showToast('Could not send that one. Try again.');
    }
  }

  async function skipReply(id) {
    try {
      const res = await authedFetch(`/api/escalations/${id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ action: 'dismiss' }),
      });
      if (!res.ok) throw new Error();
      setReplies(prev => prev.filter(i => i.id !== id)); window.dispatchEvent(new Event('florrie:refresh-counts'));
    } catch {
      showToast('Could not dismiss that one. Try again.');
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

  const total = holds.length + replies.length;

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
      ) : total === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div style={s.topBar}>
            <span style={s.waitingLabel}>{total} waiting</span>
            {holds.length > 0 && (
              <button
                onClick={approveAllHolds}
                disabled={approvingAll}
                style={{ ...s.approveAllBtn, opacity: approvingAll ? 0.6 : 1 }}
              >
                {approvingAll ? 'Sending...' : `Send all ${holds.length} hold${holds.length === 1 ? '' : 's'}`}
              </button>
            )}
          </div>

          {replies.length > 0 && (
            <Section
              icon="reply"
              title="Replies to clients you know"
              hint="A regular messaged in. Florrie drafted an answer for your OK."
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
            </Section>
          )}

          {holds.length > 0 && (
            <Section
              icon="schedule_send"
              title="Messages Florrie wants to send"
              hint="Proactive nudges and check-ins. Send, tweak, or leave them."
            >
              {holds.map(item => (
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

      {toast && <div style={s.toast}>{toast}</div>}
    </div>
  );
}

function Section({ icon, title, hint, children }) {
  return (
    <div style={s.section}>
      <div style={s.sectionHead}>
        <span className="material-symbols-outlined" style={s.sectionIcon}>{icon}</span>
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
        <span style={s.avatar} aria-hidden>{initialOf(item.firstName)}</span>
        <div style={s.cardTopText}>
          <div style={s.nameRow}>
            <span style={s.clientName}>{item.firstName}</span>
            {item.regular && <span style={s.regularPill}>Regular</span>}
          </div>
          <span style={s.typeLabel}>{item.typeLabel}</span>
        </div>
        <span style={s.channelChip}>
          <span className="material-symbols-outlined" style={s.channelChipIcon}>{ch.icon}</span>
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
      <span className="material-symbols-outlined" style={s.stateIcon}>cloud_off</span>
      <p style={s.stateTitle}>{message}</p>
      <p style={s.stateSub}>Give it another go.</p>
      <button onClick={onRetry} style={s.retryBtn}>Try again</button>
    </div>
  );
}

function EmptyState() {
  return (
    <div style={s.centerState}>
      <span className="material-symbols-outlined" style={s.stateIcon}>mark_email_read</span>
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
    color: 'var(--text-primary, #1d1b19)',
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
    color: 'var(--text-secondary, #867277)',
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
    boxShadow: 'var(--shadow-sm, 0 1px 4px rgba(0,0,0,0.06))',
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
    color: 'var(--text-primary, #1d1b19)',
    lineHeight: 1.25,
  },
  sectionHint: {
    fontSize: 12,
    color: 'var(--text-secondary, #867277)',
    lineHeight: 1.4,
    marginTop: 2,
  },

  list: { display: 'flex', flexDirection: 'column', gap: 12 },

  card: {
    background: 'var(--bg-card, #fff)',
    borderRadius: 16,
    padding: 16,
    border: '1px solid var(--border-light, #F0ECE8)',
    boxShadow: 'var(--shadow-sm, 0 1px 4px rgba(0,0,0,0.05))',
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
    borderRadius: 19,
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
  cardTopText: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: 1 },
  nameRow: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 },
  clientName: {
    fontSize: 15,
    fontWeight: 700,
    color: 'var(--text-primary, #1d1b19)',
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
    color: 'var(--text-secondary, #867277)',
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
    background: 'var(--accent-light, #ffd9e2)',
    color: 'var(--accent, #92405e)',
  },
  channelChipIcon: { fontSize: 13 },

  why: {
    fontSize: 12.5,
    color: 'var(--text-secondary, #867277)',
    lineHeight: 1.45,
    margin: '0 0 10px',
    fontWeight: 500,
  },

  inboundQuote: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    background: 'var(--bg, #fef8f4)',
    borderRadius: 12,
    padding: '9px 12px',
    marginBottom: 10,
    borderLeft: '3px solid var(--accent-light, #ffd9e2)',
  },
  inboundLabel: {
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: 'var(--text-muted, #B5AFA8)',
  },
  inboundText: {
    fontSize: 13,
    color: 'var(--text-primary, #1d1b19)',
    lineHeight: 1.45,
  },

  textarea: {
    width: '100%',
    boxSizing: 'border-box',
    resize: 'vertical',
    minHeight: 80,
    padding: '11px 12px',
    borderRadius: 12,
    border: '1px solid var(--border, #E8E4E0)',
    background: 'var(--bg, #fef8f4)',
    color: 'var(--text-primary, #1d1b19)',
    fontSize: 13,
    lineHeight: 1.5,
    fontFamily: 'inherit',
    outline: 'none',
  },

  actions: { display: 'flex', gap: 8, marginTop: 12 },
  approveBtn: {
    flex: 1,
    padding: '11px 0',
    borderRadius: 12,
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
    borderRadius: 12,
    border: '1px solid var(--border, #E8E4E0)',
    background: 'var(--bg-card, #fff)',
    color: 'var(--text-secondary, #867277)',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    WebkitTapHighlightColor: 'transparent',
  },

  skeletonCard: { pointerEvents: 'none' },
  skelLine: {
    height: 13,
    borderRadius: 6,
    background: 'var(--border-light, #F0ECE8)',
  },
  skelBlock: {
    height: 70,
    borderRadius: 12,
    background: 'var(--bg, #fef8f4)',
    border: '1px solid var(--border-light, #F0ECE8)',
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
    color: 'var(--text-muted, #B5AFA8)',
    marginBottom: 12,
  },
  stateTitle: {
    fontSize: 16,
    fontWeight: 700,
    color: 'var(--text-primary, #1d1b19)',
    margin: '0 0 6px',
  },
  stateSub: {
    fontSize: 13,
    color: 'var(--text-secondary, #867277)',
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
    background: 'var(--text-primary, #1d1b19)',
    color: '#fff',
    fontSize: 13,
    fontWeight: 500,
    padding: '10px 18px',
    borderRadius: 999,
    boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
    zIndex: 1000,
    maxWidth: 'calc(100vw - 32px)',
    textAlign: 'center',
  },
};
