import { PrivateText, PrivateAmount, PrivateSection, useClientPrivacy } from '../contexts/ClientPrivacyContext.jsx';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { readAuthenticatedJson } from '../lib/authenticated-json.js';
import { API_BASE } from '../lib/config.js';
import Icon, { iconName } from './ui/Icon';
import Button from './ui/Button.jsx';

async function api(path, body) {
  return readAuthenticatedJson({ auth: supabase.auth, url: `${API_BASE}${path}`,
    ...(body ? { request: async (url, options) => {
      const response = await fetch(url, { ...options, method: 'POST', headers: { ...options.headers, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(35000), body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok && response.status !== 401) throw new Error(data.error || 'Could not finish this check. Please try again.');
      return { ok: response.ok, status: response.status, data };
    } } : {}),
  });
}

export default function SuggestionCards({ showEmpty = false }) {
  const { hidden } = useClientPrivacy();
  const navigate = useNavigate();
  const [state, setState] = useState({ status: 'loading', cards: [] });
  const [revision, setRevision] = useState({ n: 0, fresh: false });
  const [busy, setBusy] = useState(null), [failure, setFailure] = useState(null);
  const [prepared, setPrepared] = useState(null), [completed, setCompleted] = useState(null);
  const alive = useRef(true), polls = useRef(0), resultRef = useRef(null);
  const refresh = (fresh = true) => setRevision(v => ({ n: v.n + 1, fresh }));
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let timer;
    const visible = () => { if (document.visibilityState === 'visible') { clearTimeout(timer); timer = setTimeout(() => { polls.current = 0; refresh(); }, 250); } };
    for (const event of ['focus', 'online', 'florrie:refresh-counts']) window.addEventListener(event, visible);
    document.addEventListener('visibilitychange', visible);
    const interval = setInterval(visible, 60000);
    return () => { clearTimeout(timer); clearInterval(interval); for (const event of ['focus', 'online', 'florrie:refresh-counts']) window.removeEventListener(event, visible); document.removeEventListener('visibilitychange', visible); };
  }, []);
  useEffect(() => {
    let cancelled = false, timer;
    api(`/api/florrie-thinks${revision.fresh ? '?fresh=1' : ''}`).then(json => {
      if (cancelled) return;
      setState({ status: 'ready', cards: json.cards || [], partial: json.partial, checked: json.checked_at, thinking: json.thinking });
      if (json.thinking && polls.current++ < 20) timer = setTimeout(() => refresh(false), 3000);
    }).catch(() => { if (!cancelled) setState(s => ({ ...s, status: 'error' })); });
    return () => { cancelled = true; clearTimeout(timer); };
  }, [revision]);
  useEffect(() => { if (prepared || completed) resultRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [prepared, completed]);
  async function choose(card, choice) {
    if (busy || hidden) return;
    setBusy(card.id); setFailure(null);
    try {
      await api('/api/suggestions/respond', { suggestion_id: card.id, suggestion_type: card.type, suggestion_payload: { key: card.id }, response: 'dismissed', choice });
      if (!alive.current) return;
      setState(s => ({ ...s, cards: s.cards.filter(c => c.id !== card.id) }));
      if (prepared?.id === card.id) setPrepared(null);
    } catch (e) { if (alive.current) setFailure(e.message || 'Could not save your choice. Please try again.'); }
    finally { if (alive.current) setBusy(null); }
  }
  async function prepare(card) {
    if (busy || hidden) return;
    setBusy(card.id); setFailure(null); setPrepared(null); setCompleted(null);
    try {
      const result = await api('/api/florrie-thinks/prepare', { id: card.id });
      if (alive.current) setPrepared(result);
    } catch (e) { if (alive.current) { setFailure(e.message || 'Could not check this suggestion. Please refresh.'); refresh(); } }
    finally { if (alive.current) setBusy(null); }
  }
  async function confirm() {
    if (busy || hidden || !prepared?.confirmation_token) return;
    setBusy('confirm'); setFailure(null);
    try {
      const result = await api('/api/florrie-thinks/confirm', { confirmation_token: prepared.confirmation_token });
      if (!alive.current) return;
      setCompleted(result); setPrepared(null); refresh();
      window.dispatchEvent(new Event('florrie:refresh-counts'));
    } catch (e) { if (alive.current) setFailure(e.message || 'Could not confirm the change. Check the diary before trying again.'); }
    finally { if (alive.current) setBusy(null); }
  }
  const open = (path, linkState) => { if (!hidden) navigate(path, linkState ? { state: linkState } : undefined); };
  if (state.status === 'loading') return <section className="fl-thoughts" aria-busy="true"><h2>Florrie thinks</h2><p className="fl-thoughts-meta">Checking what could help your day…</p></section>;
  if (!state.cards.length && !state.partial && !showEmpty && state.status !== 'error' && !prepared && !completed) return null;
  return <section className="fl-thoughts" aria-label="Florrie thinks">
    <div className="fl-thoughts-heading"><h2>Florrie thinks</h2><span className="fl-thoughts-meta">{state.checked ? `Checked ${new Date(state.checked).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : 'For your day'}</span></div>
    {(state.partial || state.status === 'error') && <p role="status" className="fl-thoughts-meta">Some priorities could not be checked. <button className="fl-thoughts-link" onClick={() => refresh()}>Check again</button></p>}
    {!state.cards.length && <p className="fl-thoughts-meta">No new suggestions from the records checked.</p>}
    <div className="fl-thoughts-list">{state.cards.map(card => <article className="fl-thought" key={card.id}>
      <div className="fl-thought-kicker"><Icon name={iconName(card.icon)} size={17} /><span>{card.priority_band === 0 ? 'Worth your attention' : card.confidence || 'A thought for you'}</span></div>
      {card.title && <h3><PrivateText>{card.title}</PrivateText></h3>}
      <p className="fl-thought-summary"><PrivateText placeholder="Suggestion details hidden">{card.summary}</PrivateText></p>
      {card.consideration && <p className="fl-thought-consideration"><PrivateText placeholder="Consideration hidden">{card.consideration}</PrivateText></p>}
      <details className="fl-thought-evidence"><summary>Why this came up</summary><PrivateSection placeholder="Evidence hidden"><ul>{(card.evidence?.facts || [card.evidence?.label]).filter(Boolean).map((fact, i) => <li key={i}>{fact}</li>)}</ul><button className="fl-thoughts-link" onClick={() => open(card.evidence?.link_to || card.link_to, card.evidence?.link_state || card.link_state)}>View the source <Icon name="arrow-up-right" size={13} /></button></PrivateSection></details>
      <div className="fl-thought-actions"><Button disabled={hidden || !!busy} onClick={() => prepare(card)}>{busy === card.id ? 'Checking…' : card.action_label || 'Look at this together'}</Button><details className="fl-thought-later"><summary>Not now</summary><button disabled={hidden || !!busy} onClick={() => choose(card, 'later')}>Remind me in 4 hours</button><button disabled={hidden || !!busy} onClick={() => choose(card, 'not_useful')}>Not useful this week</button>{card.type === 'holiday_habit' && <button disabled={hidden || !!busy} onClick={() => choose(card, 'keep_open')}>Leave this day as it is</button>}</details></div>
    </article>)}</div>
    {state.thinking && <p className="fl-thoughts-meta" role="status">Florrie is looking for useful connections in these records…</p>}
    {busy && !prepared && <p role="status" className="fl-thoughts-meta">Checking the latest records and preparing this for you…</p>}
    {failure && <p role="alert" className="fl-thought-error">{failure}</p>}
    <div ref={resultRef}>
      {completed && <div className="fl-thought-prepared"><p role="status"><PrivateText>{completed.message}</PrivateText></p><Button variant="secondary" disabled={hidden} onClick={() => open(completed.link_to)}>See it in my calendar</Button><button className="fl-thoughts-link" onClick={() => setCompleted(null)}>Done</button></div>}
      {prepared && <div className="fl-thought-prepared"><div className="fl-thoughts-heading"><span className="fl-thought-kicker">Ready for you to review</span><button className="fl-thought-close" aria-label="Close suggestion preview" disabled={!!busy} onClick={() => setPrepared(null)}><Icon name="x" size={20} /></button></div><PrivateSection placeholder="Prepared work hidden">
        <h3>{prepared.title}</h3>
        {prepared.kind === 'protect_time' && <><p>{prepared.preview}</p>{prepared.confirmation_token && <Button disabled={!!busy || hidden} onClick={confirm}>{busy === 'confirm' ? 'Confirming…' : prepared.start_time ? 'Protect this time' : 'Keep this day off'}</Button>}<button className="fl-thoughts-link" onClick={() => open(prepared.link_to)}>Check the diary</button></>}
        {prepared.kind === 'task' && <PreparedTask task={prepared.task} onAsk={prompt => open('/voice', { prompt })} />}
        {prepared.kind === 'drafts' && <>{prepared.note && <p>{prepared.note}</p>}{prepared.drafts.map(d => <div className="fl-thought-draft" key={d.client_id}><span className="fl-thought-kicker">{d.client_name} · Draft, not sent</span><p>{d.text}</p><Button variant="secondary" disabled={hidden} onClick={() => open(`/inbox?client=${encodeURIComponent(d.client_id)}`, { preparedDraft: { clientId: d.client_id, text: d.text } })}>Review in the conversation</Button></div>)}<p className="fl-thoughts-meta">Check the wording and the client’s contact preferences before sending.</p></>}
        {prepared.kind === 'source' && <p>{prepared.summary}</p>}
        {prepared.kind !== 'protect_time' && <button className="fl-thoughts-link" onClick={() => open(prepared.link_to, prepared.link_state)}>View the original record</button>}
      </PrivateSection></div>}
    </div>
  </section>;
}

function PreparedTask({ task, onAsk }) {
  return <div><p>{task.intro}</p><div className="fl-thought-facts">{task.cards?.map((c, i) => <div key={i}><span>{c.label}</span><strong><PrivateAmount>{c.value}</PrivateAmount></strong>{c.detail && <small>{c.detail}</small>}</div>)}</div>
    {task.items?.map((item, i) => <div className="fl-thought-result-item" key={i}><strong>{item.label}</strong><span>{item.value}</span><p>{item.detail}</p></div>)}
    {task.suggestion && <p className="fl-thought-consideration">{task.suggestion}</p>}{task.draft && <div className="fl-thought-draft"><span className="fl-thought-kicker">Draft, not sent</span><p>{task.draft}</p></div>}
    <details className="fl-thought-evidence"><summary>Sources & things to check</summary><ul>{task.limits?.map((s, i) => <li key={i}>{s}</li>)}</ul></details>
    {task.next_prompt && <Button variant="secondary" onClick={() => onAsk(task.next_prompt)}>{task.next_label || 'Continue with Florrie'}</Button>}
  </div>;
}
