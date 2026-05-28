import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { API_BASE } from '../lib/config.js';

/**
 * SuggestionCards, Day 4 of the 2026-05-28 refactor.
 *
 * A horizontal row of "Florrie is thinking..." suggestion cards. Sits
 * between TodaySummary and ActivityFeed.
 *
 * Each card has:
 *   - an icon
 *   - one-line summary
 *   - Yes / No / Tweak buttons
 *
 * Yes  -> POST /api/suggestions/respond with response=yes, then navigate
 *         to link_to so Ellie can finish the action visually.
 * No   -> POST with response=no, card collapses, never returns for 7 days.
 * Tweak-> POST with response=tweak and navigate to link_to. (We ship the
 *         lightweight version this sprint, full inline tweak editor is on
 *         the Day 5 backlog.)
 */

function getToken() {
  const key = Object.keys(localStorage).find(k => /^sb-.+-auth-token$/.test(k));
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    const parsed = JSON.parse(raw);
    return parsed?.access_token || parsed?.session?.access_token || raw;
  } catch { return null; }
}

export default function SuggestionCards() {
  const [state, setState] = useState({ status: 'loading', suggestions: [] });
  const [pendingId, setPendingId] = useState(null);
  const [toast, setToast] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const token = getToken();
      if (!token) { setState({ status: 'ready', suggestions: [] }); return; }
      try {
        const res = await fetch(`${API_BASE}/api/suggestions`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          if (!cancelled) setState({ status: 'error', suggestions: [] });
          return;
        }
        const json = await res.json();
        if (!cancelled) setState({ status: 'ready', suggestions: json.suggestions || [] });
      } catch {
        if (!cancelled) setState({ status: 'error', suggestions: [] });
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  async function respond(s, response) {
    setPendingId(s.id);
    const token = getToken();
    try {
      await fetch(`${API_BASE}/api/suggestions/respond`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: token ? `Bearer ${token}` : '',
        },
        body: JSON.stringify({
          suggestion_id: s.id,
          suggestion_type: s.type,
          suggestion_payload: s.payload || {},
          response,
        }),
      });
    } catch {
      // Best-effort, we still collapse the card so the UI feels responsive.
    }

    // Collapse the card out
    setState(prev => ({
      ...prev,
      suggestions: prev.suggestions.filter(x => x.id !== s.id),
    }));
    setPendingId(null);

    if (response === 'yes') {
      setToast('Done');
      setTimeout(() => setToast(null), 1600);
      if (s.link_to) navigate(s.link_to);
    } else if (response === 'tweak') {
      if (s.link_to) navigate(s.link_to);
    } else {
      setToast('Got it');
      setTimeout(() => setToast(null), 1200);
    }
  }

  if (state.status === 'loading') {
    return (
      <section style={SC.wrap} aria-busy="true">
        <div style={SC.header}>
          <span style={SC.title}>Florrie thinks</span>
        </div>
        <div style={SC.row}>
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </section>
    );
  }

  if (state.status === 'error' || state.suggestions.length === 0) {
    return null;
  }

  return (
    <section style={SC.wrap}>
      <div style={SC.header}>
        <span style={SC.title}>Florrie thinks</span>
        <span style={SC.count}>{state.suggestions.length}</span>
      </div>

      <div style={SC.row}>
        {state.suggestions.map(s => (
          <Card
            key={s.id}
            s={s}
            pending={pendingId === s.id}
            onRespond={respond}
          />
        ))}
      </div>

      {toast && (
        <div style={SC.toast} role="status" aria-live="polite">{toast}</div>
      )}
    </section>
  );
}

function Card({ s, pending, onRespond }) {
  return (
    <article style={SC.card}>
      <div style={SC.cardHead}>
        <span style={SC.icon} aria-hidden>{s.icon || '🌷'}</span>
      </div>
      <p style={SC.summary}>{s.summary}</p>
      <div style={SC.actions}>
        <button
          onClick={() => onRespond(s, 'yes')}
          disabled={pending}
          style={{ ...SC.btn, ...SC.btnYes }}
        >
          {s.action_label || 'Yes'}
        </button>
        <button
          onClick={() => onRespond(s, 'no')}
          disabled={pending}
          style={{ ...SC.btn, ...SC.btnNo }}
        >
          No
        </button>
        <button
          onClick={() => onRespond(s, 'tweak')}
          disabled={pending}
          style={{ ...SC.btn, ...SC.btnTweak }}
        >
          Tweak
        </button>
      </div>
    </article>
  );
}

function SkeletonCard() {
  return (
    <div style={{ ...SC.card, opacity: 0.6 }}>
      <div style={{ ...SC.icon, background: '#f3ede9' }} />
      <div style={{ height: 14, background: '#f3ede9', borderRadius: 6, marginTop: 10, width: '90%' }} />
      <div style={{ height: 14, background: '#f3ede9', borderRadius: 6, marginTop: 6, width: '60%' }} />
      <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
        <div style={{ flex: 1, height: 28, background: '#f3ede9', borderRadius: 8 }} />
        <div style={{ flex: 1, height: 28, background: '#f3ede9', borderRadius: 8 }} />
        <div style={{ flex: 1, height: 28, background: '#f3ede9', borderRadius: 8 }} />
      </div>
    </div>
  );
}

const SC = {
  wrap: {
    marginBottom: 16,
  },
  header: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    margin: '0 4px 8px',
  },
  title: {
    fontSize: 14,
    fontWeight: 700,
    color: '#92405e',
    fontFamily: "'Noto Serif', Georgia, serif",
    fontStyle: 'italic',
  },
  count: {
    fontSize: 11,
    fontWeight: 700,
    color: '#92405e',
    background: '#ffd9e2',
    padding: '2px 8px',
    borderRadius: 20,
    letterSpacing: '0.04em',
  },
  row: {
    display: 'flex',
    gap: 10,
    overflowX: 'auto',
    paddingBottom: 6,
    WebkitOverflowScrolling: 'touch',
    scrollSnapType: 'x mandatory',
    msOverflowStyle: 'none',
    scrollbarWidth: 'none',
  },
  card: {
    flex: '0 0 260px',
    minWidth: 260,
    background: '#fff',
    borderRadius: 16,
    border: '1px solid rgba(146,64,94,0.10)',
    boxShadow: '0 2px 8px rgba(146,64,94,0.06)',
    padding: '12px 12px 12px',
    display: 'flex',
    flexDirection: 'column',
    scrollSnapAlign: 'start',
  },
  cardHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  icon: {
    width: 30,
    height: 30,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 18,
    lineHeight: 1,
    borderRadius: 10,
    background: '#ffd9e2',
  },
  summary: {
    fontSize: 13,
    lineHeight: 1.4,
    color: '#1d1b19',
    fontWeight: 500,
    margin: '4px 0 12px',
    minHeight: 36,
  },
  actions: {
    display: 'flex',
    gap: 6,
    marginTop: 'auto',
  },
  btn: {
    flex: 1,
    padding: '8px 6px',
    borderRadius: 10,
    border: 'none',
    fontSize: 12,
    fontWeight: 600,
    fontFamily: 'inherit',
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
    transition: 'transform 0.1s ease',
  },
  btnYes: {
    background: '#92405e',
    color: '#fff',
  },
  btnNo: {
    background: '#f3ede9',
    color: '#867277',
  },
  btnTweak: {
    background: 'transparent',
    color: '#92405e',
    border: '1px solid rgba(146,64,94,0.25)',
  },
  toast: {
    position: 'fixed',
    bottom: 96,
    left: '50%',
    transform: 'translateX(-50%)',
    background: '#1d1b19',
    color: '#fff',
    padding: '8px 16px',
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 600,
    zIndex: 1000,
    boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
  },
};
