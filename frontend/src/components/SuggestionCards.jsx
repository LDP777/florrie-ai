import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { API_BASE } from '../lib/config.js';

/**
 * SuggestionCards: the "Florrie thinks" feed on the Today page.
 *
 * One prioritised, deduped stream. Every card shows the money at stake where we
 * know it, and the primary action EXECUTES in the app (it no longer just
 * navigates). A successful execute settles the card with an inline result:
 *   Booked · Offer sent · Held for your OK · Blocked off · Prices set
 *
 * Cards whose action needs a quick check (action.confirm set) flip to a tiny
 * inline confirm first; nothing is sent or booked without that tap.
 *
 * The set_prices card expands an inline mini editor instead of dumping her on
 * the calendar. "No" still records a dismissal so Florrie learns.
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
  const [state, setState] = useState({ status: 'loading', suggestions: [] });
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const token = getToken();
      if (!token) { setState({ status: 'ready', suggestions: [] }); return; }
      try {
        const { ok, json } = await api('/api/suggestions');
        if (cancelled) return;
        setState({ status: ok ? 'ready' : 'error', suggestions: ok ? (json.suggestions || []) : [] });
      } catch {
        if (!cancelled) setState({ status: 'error', suggestions: [] });
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  function removeCard(id) {
    setState(prev => ({ ...prev, suggestions: prev.suggestions.filter(x => x.id !== id) }));
  }

  // Record the choice (fire-and-forget). acted=true means the side effect ran.
  function record(s, response, acted = false) {
    api('/api/suggestions/respond', {
      method: 'POST',
      body: {
        suggestion_id: s.id,
        suggestion_type: s.type,
        suggestion_payload: s.payload || {},
        response,
        acted,
      },
    }).catch(() => {});
  }

  if (state.status === 'loading') {
    return (
      <section style={SC.wrap} aria-busy="true">
        <div style={SC.header}><span style={SC.title}>Florrie thinks</span></div>
        <div style={SC.row}><SkeletonCard /><SkeletonCard /></div>
      </section>
    );
  }

  if (state.status === 'error' || state.suggestions.length === 0) return null;

  const featured = state.suggestions.filter(s => s.featured);
  const rest = state.suggestions.filter(s => !s.featured);

  return (
    <section style={SC.wrap}>
      <div style={SC.header}>
        <span style={SC.title}>Florrie thinks</span>
        <span style={SC.count}>{state.suggestions.length}</span>
      </div>

      {featured.map(s => (
        <SuggestionCard key={s.id} s={s} featured onDone={removeCard} onRecord={record} navigate={navigate} />
      ))}

      {rest.length > 0 && (
        <div style={SC.row}>
          {rest.map(s => (
            <SuggestionCard key={s.id} s={s} onDone={removeCard} onRecord={record} navigate={navigate} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * One card. Holds its own execution state so the result settles inline:
 *   idle -> confirming (optional) -> running -> result, then collapses.
 */
function SuggestionCard({ s, featured, onDone, onRecord, navigate }) {
  const [phase, setPhase] = useState('idle'); // idle | confirming | running | result | prices
  const [result, setResult] = useState(null); // { label, tone, detail }
  const action = s.action || { kind: 'navigate' };
  const impact = poundsFromPence(s.impact_pence);

  function settle(after = 1500) {
    setTimeout(() => onDone(s.id), after);
  }

  async function execute() {
    // Navigate-only cards just open the detail; no fake "done" state.
    if (action.kind === 'navigate' || !action.endpoint) {
      onRecord(s, 'yes', false);
      onDone(s.id);
      if (s.link_to) navigate(s.link_to);
      return;
    }

    // Confirm gate for anything that books or sends.
    if (action.confirm && phase !== 'confirming') {
      setPhase('confirming');
      return;
    }

    setPhase('running');
    try {
      const { ok, status, json } = await api(action.endpoint, {
        method: action.method || 'POST',
        body: action.body || {},
      });

      if (!ok) {
        const msg = status === 409
          ? (json.error || 'That time is already taken.')
          : (json.error || 'Could not do that. Try again.');
        setResult({ label: 'Did not go through', tone: 'warn', detail: msg });
        setPhase('result');
        // Not recorded as acted; leave it dismissible by letting it settle.
        settle(2600);
        return;
      }

      // Map each execute kind to its inline result copy.
      let res = { label: 'Done', tone: 'ok', detail: null };
      if (action.kind === 'book') res = { label: 'Booked', tone: 'ok', detail: null };
      if (action.kind === 'block_day') res = { label: 'Blocked off', tone: 'ok', detail: null };
      if (action.kind === 'send_offer') {
        if (json.outcome === 'held') res = { label: 'Held for your OK', tone: 'ok', detail: 'It is waiting in your outbox.' };
        else if (json.outcome === 'sent') res = { label: 'Offer sent', tone: 'ok', detail: null };
        else res = { label: 'Not sent', tone: 'warn', detail: json.reason || 'Could not send right now.' };
      }

      setResult(res);
      setPhase('result');
      onRecord(s, 'yes', res.tone === 'ok');
      settle(res.tone === 'ok' ? 1600 : 2600);
    } catch {
      setResult({ label: 'Something went wrong', tone: 'warn', detail: 'Please try again.' });
      setPhase('result');
      settle(2600);
    }
  }

  function openPrices() {
    setPhase('prices');
  }

  function dismiss() {
    onRecord(s, 'dismissed', false);
    onDone(s.id);
  }

  // ---- Render: result state ----
  if (phase === 'result' && result) {
    return (
      <article style={featured ? SC.featured : SC.card}>
        <div style={SC.resultWrap}>
          <span className="material-symbols-outlined" style={{ ...SC.resultIcon, color: result.tone === 'ok' ? 'var(--accent)' : '#b3602f' }}>
            {result.tone === 'ok' ? 'check_circle' : 'error'}
          </span>
          <div>
            <p style={SC.resultLabel}>{result.label}</p>
            {result.detail && <p style={SC.resultDetail}>{result.detail}</p>}
          </div>
        </div>
      </article>
    );
  }

  // ---- Render: inline price editor ----
  if (phase === 'prices') {
    return <PriceEditor s={s} featured={featured} onClose={() => { onRecord(s, 'yes', true); onDone(s.id); }} onCancel={() => onDone(s.id)} />;
  }

  // ---- Render: bank-holiday featured card ----
  if (featured) {
    return (
      <article style={SC.featured}>
        <div style={SC.featuredTop}>
          <span style={SC.featuredIcon} aria-hidden>{s.icon || '\u{1F4C5}'}</span>
          <span style={SC.featuredPill}>Bank holiday</span>
        </div>
        <p style={SC.featuredTitle}>{s.title || 'Upcoming bank holiday'}</p>
        <p style={SC.featuredSummary}>{s.summary}</p>
        {phase === 'confirming' ? (
          <ConfirmRow text={action.confirm} onYes={execute} onCancel={() => setPhase('idle')} big />
        ) : (
          <div style={SC.featuredActions}>
            <button onClick={execute} disabled={phase === 'running'} style={{ ...SC.featuredBtn, ...SC.featuredBtnPrimary }}>
              {phase === 'running' ? 'Working…' : (s.action_label || 'Block it off')}
            </button>
            <button onClick={dismiss} disabled={phase === 'running'} style={{ ...SC.featuredBtn, ...SC.featuredBtnSecondary }}>
              {s.secondary_label || 'Keep it open'}
            </button>
          </div>
        )}
      </article>
    );
  }

  // ---- Render: standard card ----
  const isPriceCard = s.type === 'unpriced_appointments';
  return (
    <article style={SC.card}>
      <div style={SC.cardHead}>
        <span style={SC.icon} aria-hidden>{s.icon || '🌷'}</span>
        {impact && <span style={SC.impact}>+{impact}</span>}
      </div>
      <p style={SC.summary}>{s.summary}</p>

      {phase === 'confirming' ? (
        <ConfirmRow text={action.confirm} onYes={execute} onCancel={() => setPhase('idle')} />
      ) : (
        <div style={SC.actions}>
          <button
            onClick={isPriceCard ? openPrices : execute}
            disabled={phase === 'running'}
            style={{ ...SC.btn, ...SC.btnYes }}
          >
            {phase === 'running' ? 'Working…' : (s.action_label || 'Yes')}
          </button>
          <button onClick={dismiss} disabled={phase === 'running'} style={{ ...SC.btn, ...SC.btnNo }}>
            No
          </button>
          {s.link_to && (
            <button onClick={() => navigate(s.link_to)} disabled={phase === 'running'} style={{ ...SC.btn, ...SC.btnOpen }}>
              Open
            </button>
          )}
        </div>
      )}
    </article>
  );
}

function ConfirmRow({ text, onYes, onCancel, big }) {
  return (
    <div style={SC.confirmWrap}>
      <p style={SC.confirmText}>{text || 'Go ahead?'}</p>
      <div style={big ? SC.featuredActions : SC.actions}>
        <button onClick={onYes} style={big ? { ...SC.featuredBtn, ...SC.featuredBtnPrimary } : { ...SC.btn, ...SC.btnYes }}>
          Yes, do it
        </button>
        <button onClick={onCancel} style={big ? { ...SC.featuredBtn, ...SC.featuredBtnSecondary } : { ...SC.btn, ...SC.btnNo }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Inline mini editor for the unpriced-appointments card. Lists each upcoming
 * booking with no price and a small GBP input; Save writes that one price.
 */
function PriceEditor({ s, featured, onClose, onCancel }) {
  const [rows, setRows] = useState(null); // null = loading
  const [vals, setVals] = useState({});
  const [savingId, setSavingId] = useState(null);
  const [savedIds, setSavedIds] = useState(new Set());

  useEffect(() => {
    let cancelled = false;
    api('/api/suggestions/unpriced').then(({ ok, json }) => {
      if (cancelled) return;
      setRows(ok ? (json.appointments || []) : []);
    }).catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, []);

  async function save(row) {
    const pounds = parseFloat(vals[row.id]);
    if (!Number.isFinite(pounds) || pounds < 0) return;
    setSavingId(row.id);
    const { ok } = await api(`/api/suggestions/appointments/${row.id}/price`, {
      method: 'PATCH',
      body: { price_cents: Math.round(pounds * 100) },
    });
    setSavingId(null);
    if (ok) {
      setSavedIds(prev => new Set(prev).add(row.id));
    }
  }

  const pending = (rows || []).filter(r => !savedIds.has(r.id));

  return (
    <article style={featured ? SC.featured : { ...SC.card, flex: '0 0 300px', minWidth: 300 }}>
      <div style={SC.cardHead}>
        <span style={SC.icon} aria-hidden>{s.icon || '🏷️'}</span>
        <span style={SC.priceHeader}>Set prices</span>
      </div>

      {rows === null && <p style={SC.summary}>Loading your bookings…</p>}

      {rows !== null && pending.length === 0 && (
        <p style={SC.summary}>{savedIds.size > 0 ? 'All sorted. Nice one.' : 'Nothing left to price.'}</p>
      )}

      {pending.map(row => (
        <div key={row.id} style={SC.priceRow}>
          <div style={SC.priceRowInfo}>
            <span style={SC.priceClient}>{row.client}</span>
            <span style={SC.priceMeta}>{row.treatment}</span>
          </div>
          <div style={SC.priceInputWrap}>
            <span style={SC.priceCurrency}>£</span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="1"
              value={vals[row.id] || ''}
              onChange={e => setVals(v => ({ ...v, [row.id]: e.target.value }))}
              style={SC.priceInput}
              placeholder="0"
            />
            <button
              onClick={() => save(row)}
              disabled={savingId === row.id || !vals[row.id]}
              style={SC.priceSave}
            >
              {savingId === row.id ? '…' : 'Save'}
            </button>
          </div>
        </div>
      ))}

      <div style={{ ...SC.actions, marginTop: 10 }}>
        <button onClick={onClose} style={{ ...SC.btn, ...SC.btnYes }}>Done</button>
        <button onClick={onCancel} style={{ ...SC.btn, ...SC.btnNo }}>Later</button>
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
  featured: {
    background: 'linear-gradient(135deg, #fff6ec 0%, #ffeede 100%)',
    border: '1px solid rgba(201,169,110,0.45)', borderRadius: 18,
    boxShadow: '0 4px 16px rgba(201,169,110,0.18)', padding: '14px 16px', marginBottom: 12,
  },
  featuredTop: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
  featuredIcon: {
    width: 34, height: 34, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 20, lineHeight: 1, borderRadius: 11, background: 'rgba(201,169,110,0.18)',
  },
  featuredPill: {
    fontSize: 10, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase',
    color: '#8a6d2f', background: 'rgba(201,169,110,0.22)', padding: '3px 9px', borderRadius: 20,
  },
  featuredTitle: {
    fontSize: 16, fontWeight: 700, color: '#1d1b19',
    fontFamily: "'Playfair Display', Georgia, serif", margin: '2px 0 4px',
  },
  featuredSummary: { fontSize: 13, lineHeight: 1.45, color: '#5c5450', fontWeight: 500, margin: '0 0 12px' },
  featuredActions: { display: 'flex', gap: 8 },
  featuredBtn: {
    flex: 1, padding: '11px 8px', borderRadius: 12, border: 'none', fontSize: 13, fontWeight: 700,
    fontFamily: 'inherit', cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
  },
  featuredBtnPrimary: { background: 'var(--accent)', color: '#fff' },
  featuredBtnSecondary: {
    background: 'rgba(255,255,255,0.7)', color: 'var(--accent)', border: '1px solid rgba(146,64,94,0.30)',
  },
  row: {
    display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 6, WebkitOverflowScrolling: 'touch',
    scrollSnapType: 'x mandatory', msOverflowStyle: 'none', scrollbarWidth: 'none',
  },
  card: {
    flex: '0 0 260px', minWidth: 260, background: '#fff', borderRadius: 16,
    border: '1px solid rgba(146,64,94,0.10)', boxShadow: '0 2px 8px rgba(146,64,94,0.06)',
    padding: '12px 12px 12px', display: 'flex', flexDirection: 'column', scrollSnapAlign: 'start',
  },
  cardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 },
  icon: {
    width: 30, height: 30, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 18, lineHeight: 1, borderRadius: 10, background: '#ffd9e2',
  },
  impact: {
    fontSize: 13, fontWeight: 800, color: 'var(--accent)', background: 'rgba(146,64,94,0.08)',
    padding: '2px 9px', borderRadius: 20, letterSpacing: '0.01em',
  },
  summary: { fontSize: 13, lineHeight: 1.4, color: '#1d1b19', fontWeight: 500, margin: '4px 0 12px', minHeight: 36 },
  actions: { display: 'flex', gap: 6, marginTop: 'auto' },
  btn: {
    flex: 1, padding: '8px 6px', borderRadius: 10, border: 'none', fontSize: 12, fontWeight: 600,
    fontFamily: 'inherit', cursor: 'pointer', WebkitTapHighlightColor: 'transparent', transition: 'transform 0.1s ease',
  },
  btnYes: { background: 'var(--accent)', color: '#fff' },
  btnNo: { background: '#f3ede9', color: '#867277' },
  btnOpen: { background: 'transparent', color: 'var(--accent)', border: '1px solid rgba(146,64,94,0.25)' },

  confirmWrap: { marginTop: 'auto' },
  confirmText: { fontSize: 12.5, lineHeight: 1.4, color: '#5c5450', fontWeight: 600, margin: '0 0 8px' },

  resultWrap: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 2px' },
  resultIcon: { fontSize: 28, lineHeight: 1 },
  resultLabel: { fontSize: 14, fontWeight: 700, color: '#1d1b19', margin: 0 },
  resultDetail: { fontSize: 12, color: '#867277', margin: '2px 0 0', lineHeight: 1.35 },

  priceHeader: {
    fontSize: 13, fontWeight: 700, color: 'var(--accent)',
    fontFamily: "'Playfair Display', Georgia, serif", fontStyle: 'italic',
  },
  priceRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    padding: '8px 0', borderTop: '1px solid rgba(146,64,94,0.08)',
  },
  priceRowInfo: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  priceClient: { fontSize: 13, fontWeight: 600, color: '#1d1b19', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  priceMeta: { fontSize: 11, color: '#867277', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  priceInputWrap: { display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 },
  priceCurrency: { fontSize: 13, fontWeight: 700, color: '#867277' },
  priceInput: {
    width: 52, padding: '6px 6px', borderRadius: 8, border: '1px solid rgba(146,64,94,0.25)',
    fontSize: 13, fontWeight: 600, fontFamily: 'inherit', textAlign: 'right',
  },
  priceSave: {
    padding: '6px 10px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff',
    fontSize: 12, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
  },
};
