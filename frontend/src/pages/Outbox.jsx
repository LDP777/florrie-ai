/**
 * Outbox - "Florrie's Outbox".
 *
 * The calm review screen for proactive messages Florrie wants to send.
 * Nothing here goes out without the beautician's OK. Each draft can be
 * approved (sends now), edited, or skipped. There is also an "Approve all"
 * shortcut for clearing the whole queue in one tap.
 *
 * API (all need the Supabase bearer token):
 *   GET   /api/outbound/pending
 *   PATCH /api/outbound/:id            { body }
 *   POST  /api/outbound/:id/approve
 *   POST  /api/outbound/:id/skip
 *   POST  /api/outbound/approve-all
 */
import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import PageHeader from '../components/ui/PageHeader.jsx';

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
  // Fallback: title-case the raw type (rebook_nudge -> "Rebook Nudge").
  return type
    .split(/[_\s]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const REASON_LABELS = {
  awaiting_approval: 'Waiting for your OK',
};

function reasonLabel(reason) {
  if (!reason) return null;
  return REASON_LABELS[reason] || null;
}

function clientName(item) {
  const c = item.clients || {};
  const name = `${c.first_name || ''} ${c.last_name || ''}`.trim();
  return name || 'A client';
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

export default function Outbox() {
  const [items, setItems] = useState([]);
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
      const res = await authedFetch('/api/outbound/pending');
      if (!res.ok) throw new Error('Could not load the outbox');
      const data = await res.json();
      setItems(Array.isArray(data?.pending) ? data.pending : []);
    } catch (err) {
      setError(err.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Edit a draft. PATCH on blur or via the small Save action.
  async function saveDraft(id, body) {
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

  async function approve(id) {
    try {
      const res = await authedFetch(`/api/outbound/${id}/approve`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) throw new Error(data?.error || 'Send failed');
      setItems(prev => prev.filter(i => i.id !== id)); // optimistic remove
      showToast('Sent.');
    } catch (err) {
      showToast(err.message === 'Send failed' ? 'Could not send that one. Try again.' : 'Could not send that one. Try again.');
    }
  }

  async function skip(id) {
    try {
      const res = await authedFetch(`/api/outbound/${id}/skip`, { method: 'POST' });
      if (!res.ok) throw new Error();
      setItems(prev => prev.filter(i => i.id !== id)); // optimistic remove
    } catch {
      showToast('Could not skip that one. Try again.');
    }
  }

  async function approveAll() {
    setApprovingAll(true);
    try {
      const res = await authedFetch('/api/outbound/approve-all', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error();
      const sent = data?.sent ?? 0;
      const failed = data?.failed ?? 0;
      if (failed > 0) {
        showToast(`Sent ${sent}. ${failed} could not go out, still in your outbox.`);
      } else {
        showToast(`Sent ${sent}.`);
      }
      await load();
    } catch {
      showToast('Could not approve all. Try again.');
    } finally {
      setApprovingAll(false);
    }
  }

  return (
    <div style={s.page}>
      <PageHeader
        title="Florrie's Outbox"
        subtitle="What I'd like to send. Nothing goes out without your OK."
      />

      {loading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : items.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div style={s.topBar}>
            <span style={s.waitingLabel}>{items.length} waiting</span>
            <button
              onClick={approveAll}
              disabled={approvingAll}
              style={{ ...s.approveAllBtn, opacity: approvingAll ? 0.6 : 1 }}
            >
              {approvingAll ? 'Sending...' : 'Approve all'}
            </button>
          </div>

          <div style={s.list}>
            {items.map(item => (
              <OutboxCard
                key={item.id}
                item={item}
                onApprove={() => approve(item.id)}
                onSkip={() => skip(item.id)}
                onSave={(body) => saveDraft(item.id, body)}
              />
            ))}
          </div>
        </>
      )}

      {toast && <div style={s.toast}>{toast}</div>}
    </div>
  );
}

function OutboxCard({ item, onApprove, onSkip, onSave }) {
  const [body, setBody] = useState(item.body || '');
  const [dirty, setDirty] = useState(false);
  const why = reasonLabel(item.reason);
  const channel = (item.channel || '').toLowerCase();

  function handleBlur() {
    if (dirty) {
      onSave(body);
      setDirty(false);
    }
  }

  return (
    <div style={s.card}>
      <div style={s.cardTop}>
        <div style={s.cardTopLeft}>
          <span style={s.clientName}>{clientName(item)}</span>
          <span style={s.typeLabel}>{typeLabel(item.message_type)}</span>
        </div>
        {channel && <span style={s.channelChip}>{channel}</span>}
      </div>

      <textarea
        value={body}
        onChange={e => { setBody(e.target.value); setDirty(true); }}
        onBlur={handleBlur}
        rows={4}
        style={s.textarea}
        aria-label="Message draft"
      />

      <div style={s.cardFooter}>
        {why && <span style={s.why}>{why}</span>}
        {dirty && (
          <button onClick={handleBlur} style={s.saveBtn}>Save</button>
        )}
      </div>

      <div style={s.actions}>
        <button onClick={onApprove} style={s.approveBtn}>Approve</button>
        <button onClick={onSkip} style={s.skipBtn}>Skip</button>
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
        Florrie will line up anything proactive here for your OK first.
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
    background: 'var(--accent, #C76B8A)',
    color: '#fff',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
    boxShadow: 'var(--shadow-sm, 0 1px 4px rgba(0,0,0,0.06))',
    WebkitTapHighlightColor: 'transparent',
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
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 12,
  },
  cardTopLeft: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 },
  clientName: {
    fontSize: 15,
    fontWeight: 700,
    color: 'var(--text-primary, #1d1b19)',
    lineHeight: 1.2,
  },
  typeLabel: {
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--text-secondary, #867277)',
  },
  channelChip: {
    flexShrink: 0,
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'capitalize',
    letterSpacing: '0.02em',
    padding: '4px 9px',
    borderRadius: 999,
    background: 'var(--accent-light, #ffd9e2)',
    color: 'var(--accent, #92405e)',
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

  cardFooter: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    minHeight: 18,
    marginTop: 8,
  },
  why: {
    fontSize: 11,
    color: 'var(--text-muted, #B5AFA8)',
    fontWeight: 500,
  },
  saveBtn: {
    marginLeft: 'auto',
    padding: '5px 12px',
    borderRadius: 8,
    border: '1px solid var(--border, #E8E4E0)',
    background: 'var(--bg-card, #fff)',
    color: 'var(--text-primary, #1d1b19)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },

  actions: { display: 'flex', gap: 8, marginTop: 12 },
  approveBtn: {
    flex: 1,
    padding: '11px 0',
    borderRadius: 12,
    border: 'none',
    background: 'var(--accent, #C76B8A)',
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

  // Loading skeleton
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

  // Center states (error / empty)
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
    background: 'var(--accent, #C76B8A)',
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
