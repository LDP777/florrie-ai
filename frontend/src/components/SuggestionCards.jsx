import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { API_BASE } from '../lib/config.js';
import Icon, { iconName } from './ui/Icon';

/**
 * SuggestionCards: the "Florrie thinks" feed on the Today page, rebuilt on
 * grounded truth.
 *
 * The cards come from GET /api/florrie-thinks, which derives everything fresh
 * from the live tables at fetch time. The contract this component leans on:
 *
 *   - Every card names a real person and its tap opens them (thread, booking
 *     sheet or profile). Nothing anonymous, nothing past its date: the server
 *     enforces both, so this component never has to second-guess a card.
 *   - The primary action label says what genuinely happens (Open thread,
 *     Open booking). Nothing here books, sends or charges; those moves stay
 *     on the surfaces that own them, behind Ellie's own tap.
 *   - Each card shows its evidence ("asked Tue 2:14pm") in small muted text,
 *     tappable through to the source.
 *   - At most three cards, ranked by money then urgency, so the section
 *     reads as thinking, not nagging.
 *
 * A quiet No records a dismissal through the existing /api/suggestions/respond
 * (florrie_decisions), keyed by the card id, and the server keeps it away for
 * 30 days.
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

function poundsFromPence(pence) {
  if (!pence || pence <= 0) return null;
  const pounds = pence / 100;
  return Number.isInteger(pounds) ? `£${pounds}` : `£${pounds.toFixed(2)}`;
}

async function api(path, { method = 'GET', body } = {}) {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: token ? `Bearer ${token}` : '',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { ok: res.ok, status: res.status, json: json || {} };
}

export default function SuggestionCards() {
  const [state, setState] = useState({ status: 'loading', cards: [] });
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const token = getToken();
      if (!token) { setState({ status: 'ready', cards: [] }); return; }
      try {
        const { ok, json } = await api('/api/florrie-thinks');
        if (cancelled) return;
        setState({ status: ok ? 'ready' : 'error', cards: ok ? (json.cards || []) : [] });
      } catch {
        if (!cancelled) setState({ status: 'error', cards: [] });
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  function removeCard(id) {
    setState(prev => ({ ...prev, cards: prev.cards.filter(x => x.id !== id) }));
  }

  // Persist a dismissal (fire and forget) so the server keeps this card away.
  // The card id is the stable key: same subject, same key, stays dismissed.
  function dismiss(card) {
    api('/api/suggestions/respond', {
      method: 'POST',
      body: {
        suggestion_id: card.id,
        suggestion_type: card.type,
        suggestion_payload: { key: card.id },
        response: 'dismissed',
      },
    }).catch(() => {});
    removeCard(card.id);
  }

  function open(card) {
    // Opening is the whole action: the destination surface owns any real move
    // (approving a draft, charging a balance, sending a patch-test link).
    navigate(card.link_to, card.link_state ? { state: card.link_state } : undefined);
  }

  function openEvidence(card) {
    const ev = card.evidence;
    if (!ev?.link_to) return open(card);
    navigate(ev.link_to, ev.link_state ? { state: ev.link_state } : undefined);
  }

  if (state.status === 'loading') {
    return (
      <section style={SC.wrap} aria-busy="true">
        <div style={SC.header}><span style={SC.title}>Florrie thinks</span></div>
        <div style={SC.row}><SkeletonCard /><SkeletonCard /></div>
      </section>
    );
  }

  if (state.status === 'error' || state.cards.length === 0) return null;

  return (
    <section style={SC.wrap}>
      <div style={SC.header}>
        <span style={SC.title}>Florrie thinks</span>
        <span style={SC.count}>{state.cards.length}</span>
      </div>
      <div style={SC.row}>
        {state.cards.map(card => (
          <SuggestionCard
            key={card.id}
            card={card}
            onOpen={() => open(card)}
            onEvidence={() => openEvidence(card)}
            onDismiss={() => dismiss(card)}
          />
        ))}
      </div>
    </section>
  );
}

function SuggestionCard({ card, onOpen, onEvidence, onDismiss }) {
  const impact = poundsFromPence(card.impact_pence);
  return (
    <article style={SC.card}>
      <div style={SC.cardHead}>
        <span style={SC.icon} aria-hidden><Icon name={iconName(card.icon)} size={17} /></span>
        {impact && <span style={SC.impact}>{impact}</span>}
      </div>

      <p style={SC.summary}>{card.summary}</p>

      {card.evidence?.label && (
        <button onClick={onEvidence} style={SC.evidence}>
          {card.evidence.label}
        </button>
      )}

      <div style={SC.actions}>
        <button onClick={onOpen} style={{ ...SC.btn, ...SC.btnYes }}>
          {card.action_label || 'Open'}
        </button>
        <button onClick={onDismiss} style={{ ...SC.btn, ...SC.btnNo }}>
          No
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
      </div>
    </div>
  );
}

const SC = {
  wrap: { marginBottom: 16 },
  header: {
    display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', margin: '0 4px 8px',
  },
  title: {
    fontSize: 14, fontWeight: 700, color: 'var(--accent)',
    fontFamily: "'Playfair Display', Georgia, serif", fontStyle: 'italic',
  },
  count: {
    fontSize: 11, fontWeight: 700, color: 'var(--accent)', background: '#ffd9e2',
    padding: '2px 8px', borderRadius: 20, letterSpacing: '0.04em',
  },
  row: {
    display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 6, WebkitOverflowScrolling: 'touch',
    scrollSnapType: 'x mandatory', msOverflowStyle: 'none', scrollbarWidth: 'none',
  },
  card: {
    flex: '0 0 260px', minWidth: 260, background: 'var(--tone-1, #fbf1ea)', borderRadius: 20,
    padding: '12px 12px 12px', display: 'flex', flexDirection: 'column', scrollSnapAlign: 'start',
  },
  cardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 },
  icon: {
    width: 30, height: 30, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    lineHeight: 1, borderRadius: 10,
    background: 'var(--accent-light, #F6E7EC)', color: 'var(--accent, #92405E)',
  },
  impact: {
    fontSize: 13, fontWeight: 800, color: 'var(--accent)', background: 'rgba(146,64,94,0.08)',
    padding: '2px 9px', borderRadius: 20, letterSpacing: '0.01em',
  },
  summary: { fontSize: 13, lineHeight: 1.4, color: '#1d1b19', fontWeight: 500, margin: '4px 0 6px', minHeight: 36 },
  // The evidence line: small, muted, tappable through to the source message
  // or appointment. The text stays small but the hit area is a full 44px.
  evidence: {
    background: 'transparent', border: 'none', padding: 0, margin: '0 0 2px',
    minHeight: 44, display: 'inline-flex', alignItems: 'center', alignSelf: 'flex-start',
    fontSize: 11.5, color: '#867277', fontWeight: 500, fontFamily: 'inherit',
    textDecoration: 'underline', textDecorationColor: 'rgba(134,114,119,0.4)',
    cursor: 'pointer', WebkitTapHighlightColor: 'transparent', textAlign: 'left',
  },
  actions: { display: 'flex', gap: 6, marginTop: 'auto' },
  btn: {
    flex: 1, padding: '8px 6px', minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 10, border: 'none', fontSize: 12, fontWeight: 600,
    fontFamily: 'inherit', cursor: 'pointer', WebkitTapHighlightColor: 'transparent', transition: 'transform 0.1s ease',
  },
  btnYes: { background: 'var(--accent)', color: '#fff' },
  btnNo: { background: '#f3ede9', color: '#867277' },
};
