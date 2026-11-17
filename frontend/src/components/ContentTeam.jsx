import { useClientPrivacy, PrivateText, PrivateSection } from '../contexts/ClientPrivacyContext.jsx';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import { contentRequest } from '../lib/content-workflow.js';
import { renderContentArtwork } from '../lib/content-artwork.js';
import Button from './ui/Button.jsx';
import Icon from './ui/Icon.jsx';

const GOALS = [
  ['bookings', 'Fill my diary', 'calendar'], ['show_work', 'Show my work', 'camera'],
  ['explain', 'Help clients choose', 'message'], ['trust', 'Build trust', 'heart'],
];
const SPECIALISTS = [
  { id: 'strategy', title: 'The strategist', short: 'Strategy', icon: 'compass', role: 'Find the right story', detail: 'A small, connected plan built from your treatments and saved salon knowledge.', work: 'Planning', result: 'Plan ready' },
  { id: 'writing', title: 'The copywriter', short: 'Writing', icon: 'edit', role: 'Make it sound like you', detail: 'Captions and opening lines that follow the brief and your saved writing style.', work: 'Writing', result: 'Words ready' },
  { id: 'reels', title: 'The Reel director', short: 'Reels', icon: 'video', role: 'Know exactly what to film', detail: 'An opening, a shot list and words for the screen. You bring the real footage.', work: 'Directing', result: 'Filming plan ready' },
];
const ACTIVE = new Set(['queued', 'running']);
const STATES = new Set(['queued', 'running', 'ready', 'failed']);
const STAGE_STATES = new Set(['waiting', 'running', 'complete', 'failed']);
const storageKey = owner => `florrie:content-team:pending:${owner}`;
const plain = value => typeof value === 'string' ? value : '';
const collection = value => Array.isArray(value) ? value : [];
const sourceList = item => [...new Set(collection(item?.source_refs).map(source => {
  const type = (typeof source === 'string' ? source : source?.id || '').split(':')[0];
  return ({ brief: 'Your brief', treatment: 'Treatment menu', knowledge: 'Saved salon knowledge', photo: 'Saved photo notes', campaign: 'Campaign opportunity' })[type];
}).filter(Boolean))];

function checkedRun(run) {
  if (!run || typeof run.id !== 'string' || !STATES.has(run.status) || !Array.isArray(run.stages)
    || run.stages.length !== 3 || SPECIALISTS.some(agent => !run.stages.some(stage => stage.id === agent.id && STAGE_STATES.has(stage.status)))) {
    throw new Error('We couldn’t confirm the team’s progress. Check again before starting another brief.');
  }
  if (run.status === 'ready' && run.stages.some(stage => stage.status !== 'complete' || !stage.output || typeof stage.output !== 'object' || Array.isArray(stage.output))) {
    throw new Error('We couldn’t confirm the finished work. Check progress before starting another brief.');
  }
  return run;
}
function pendingRead(owner) {
  try {
    const data = JSON.parse(sessionStorage.getItem(storageKey(owner)) || 'null');
    if (typeof data?.request_id === 'string' && GOALS.some(([id]) => id === data.goal) && typeof data.focus === 'string') return data;
  } catch { /* A blocked storage area must not prevent checking saved work. */ }
  return null;
}
function pendingSave(owner, pending) {
  try { pending ? sessionStorage.setItem(storageKey(owner), JSON.stringify(pending)) : sessionStorage.removeItem(storageKey(owner)); } catch { /* The server request ID remains the durable duplicate guard. */ }
}
function stageLabel(stage, agent, available) {
  if (stage?.status === 'complete') return agent.result;
  if (stage?.status === 'running') return agent.work;
  if (stage?.status === 'failed') return 'Needs attention';
  return available === false ? 'Setup needed' : stage ? 'Up next' : 'Ready for a brief';
}

/** The keyed inner component keeps pending writes, callbacks and polls salon-specific. */
export default function ContentTeam(props) {
  return <ContentTeamForOwner key={props.owner.id} {...props}/>;
}

function ContentTeamForOwner({ owner, board, loading: sourcesLoading, busy: preparing, stage: prepareStage,
  error: prepareError, note, canPrepare, needsArtwork, onPrepare, onRefresh, onPosts, onPhotos, onResults,
  onCompose, children }) {
  const { hidden } = useClientPrivacy();
  const initialPending = useRef(pendingRead(owner.id));
  const [run, setRun] = useState(null), [available, setAvailable] = useState(null);
  const [reason, setReason] = useState(''), [checking, setChecking] = useState(true);
  const [error, setError] = useState(''), [submitting, setSubmitting] = useState(false);
  const [pending, setPending] = useState(initialPending.current), [briefOpen, setBriefOpen] = useState(!!initialPending.current);
  const [goal, setGoal] = useState(initialPending.current?.goal || 'show_work');
  const [focus, setFocus] = useState(initialPending.current?.focus || '');
  const [opportunity, setOpportunity] = useState(initialPending.current?.opportunity || null);
  const [selected, setSelected] = useState('strategy');
  const [history, setHistory] = useState([]), [moreHistory, setMoreHistory] = useState(false), [nextOffset, setNextOffset] = useState(20);
  const [historyBusy, setHistoryBusy] = useState(false), [latest, setLatest] = useState(null), [viewId, setViewId] = useState('');
  const [sessionBlocked, setSessionBlocked] = useState(false), [artworkBusy, setArtworkBusy] = useState(false);
  const alive = useRef(false), epoch = useRef(0), lock = useRef(false), inRead = useRef(false);
  const authEpoch = useRef(0), blocked = useRef(false), viewed = useRef(''), viewGeneration = useRef(0), historyLock = useRef(false), artworkLock = useRef(false);
  const formRef = useRef(null), workRef = useRef(null), outputRef = useRef(null), ideasRef = useRef(null);
  const active = !!run && ACTIVE.has(run.status);
  const teamBusy = !!latest && ACTIVE.has(latest.status);
  const selectedStage = run?.stages.find(stage => stage.id === selected);
  const selectedAgent = SPECIALISTS.find(agent => agent.id === selected);
  const savedPosts = collection(board?.prepared);
  const suggestions = collection(board?.opportunities).filter(item => ['booking', 'gallery', 'knowledge', 'treatment'].includes(item.type) && typeof item.source_id === 'string')
    .sort((a, b) => Number(b.type === 'booking') - Number(a.type === 'booking')).slice(0, 3);
  const chosenSuggestion = suggestions.find(item => item.type === opportunity?.type && item.source_id === opportunity?.source_id);
  const completeSources = board && !collection(board.unavailable).includes('posts');
  const readyPosts = completeSources ? savedPosts.filter(item => !item.needs?.length).length : null;
  const campaignResults = board?.results?.available && Array.isArray(board.results.campaigns)
    && board.results.campaigns.every(item => item && (typeof item.confirmed === 'number' || (typeof item.confirmed === 'string' && /^\d+$/.test(item.confirmed))) && Number.isSafeInteger(Number(item.confirmed)) && Number(item.confirmed) >= 0) ? board.results.campaigns : null;
  const bookings = campaignResults?.reduce((sum, item) => sum + Number(item.confirmed), 0);

  function blockSession() {
    blocked.current = true; authEpoch.current++; epoch.current++;
    setSessionBlocked(true); setRun(null); setLatest(null); setHistory([]);
    setChecking(false); setSubmitting(false); setHistoryBusy(false); setArtworkBusy(false);
  }
  async function session() {
    const sequence = authEpoch.current;
    let timer;
    const result = await Promise.race([
      supabase.auth.getSession(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Your connection is taking too long. Please try again.')), 10000); }),
    ]).finally(() => clearTimeout(timer));
    if (!alive.current || sequence !== authEpoch.current) throw new Error('Your salon context changed.');
    if (result.error) throw new Error('We couldn’t check your sign-in. Please try again.');
    if (!result.data?.session?.access_token || !owner.auth_id || result.data.session.user?.id !== owner.auth_id) {
      blockSession(); throw new Error('Your account changed. Reopen Content for your signed-in salon.');
    }
    return result.data;
  }
  async function request(path, options = {}) {
    const data = await session();
    return contentRequest(`${API_BASE}/api/content/team${path}`, { token: data?.session?.access_token, timeoutMs: 15000, ...options });
  }
  function remember(items) {
    setHistory(previous => [...new Map([...previous, ...collection(items)].map(item => [item.id, item])).values()]
      .filter(item => typeof item.id === 'string' && STATES.has(item.status))
      .sort((a,b) => (b.created_at || '').localeCompare(a.created_at || '') || b.id.localeCompare(a.id)));
  }
  async function refresh({ quiet = false } = {}) {
    if (inRead.current || lock.current) return null;
    inRead.current = true;
    const sequence = epoch.current;
    const visibleId = viewed.current, viewSequence = viewGeneration.current;
    if (!quiet) { setChecking(true); setError(''); }
    try {
      const data = await request('');
      if (!alive.current || sequence !== epoch.current) return null;
      if (typeof data?.available !== 'boolean') throw new Error('We couldn’t check your content team. Your saved posts are still available.');
      const next = data.run ? checkedRun(data.run) : null;
      // Retried older work stops being the default when it finishes. Read the
      // selected item itself so the screen can still show its completed result.
      const visible = visibleId && visibleId !== next?.id ? checkedRun((await request(`/runs/${encodeURIComponent(visibleId)}`)).run) : next;
      if (!alive.current || sequence !== epoch.current) return null;
      setAvailable(data.available); setReason(plain(data.reason)); setLatest(next);
      remember(data.recent_runs || (next ? [next] : []));
      if (viewSequence === viewGeneration.current) setRun(visible);
      setMoreHistory(data.has_more === true); setNextOffset(previous => Math.max(previous, data.next_offset || 20));
      const attempt = pendingRead(owner.id) || pending;
      if (attempt && next?.request_id === attempt.request_id) {
        pendingSave(owner.id, null); setPending(null); setBriefOpen(false);
      }
      if (!quiet) setError('');
      return { ...data, run: next };
    } catch (err) { if (alive.current && sequence === epoch.current) setError(err.message); return null; }
    finally { inRead.current = false; if (alive.current && sequence === epoch.current) setChecking(false); }
  }
  useEffect(() => {
    alive.current = true; refresh();
    const subscription = supabase.auth.onAuthStateChange?.((_event, nextSession) => {
      if (!alive.current) return;
      if (!owner.auth_id || nextSession?.user?.id !== owner.auth_id) blockSession();
      else if (blocked.current) { blocked.current = false; setSessionBlocked(false); queueMicrotask(() => { if (alive.current) refresh(); }); }
    });
    return () => { alive.current = false; epoch.current++; authEpoch.current++; subscription?.data?.subscription?.unsubscribe(); };
  }, []);
  useEffect(() => {
    if (!teamBusy) return;
    const timer = setInterval(() => { if (!document.hidden) refresh({ quiet: true }); }, 4500);
    return () => clearInterval(timer);
  }, [teamBusy, latest?.id]);

  async function chooseRun(id) {
    if (historyLock.current || lock.current) return;
    viewGeneration.current++;
    if (!id) { viewed.current = ''; setViewId(''); setRun(latest); return; }
    historyLock.current = true; setHistoryBusy(true); setError('');
    const sequence = epoch.current;
    try {
      const data = await request(`/runs/${encodeURIComponent(id)}`);
      if (!alive.current || sequence !== epoch.current) return;
      const next = checkedRun(data.run);
      if (next.id !== id) throw new Error('We couldn’t confirm that saved brief. Please try again.');
      viewed.current = id; setViewId(id); setRun(next); setSelected('strategy');
    } catch (err) { if (alive.current && sequence === epoch.current) setError(err.message); }
    finally { historyLock.current = false; if (alive.current && sequence === epoch.current) setHistoryBusy(false); }
  }
  async function loadOlder() {
    if (historyLock.current) return;
    historyLock.current = true; setHistoryBusy(true); setError('');
    const sequence = epoch.current;
    try {
      const data = await request(`/runs?offset=${nextOffset}&limit=20`);
      if (!alive.current || sequence !== epoch.current) return;
      if (!Array.isArray(data.runs)) throw new Error('We couldn’t load earlier briefs. Please try again.');
      remember(data.runs); setMoreHistory(data.has_more === true); setNextOffset(data.next_offset || nextOffset + data.runs.length);
    } catch (err) { if (alive.current && sequence === epoch.current) setError(err.message); }
    finally { historyLock.current = false; if (alive.current && sequence === epoch.current) setHistoryBusy(false); }
  }

  function openBrief() {
    if (hidden) return;
    if (!pending) setOpportunity(null);
    setBriefOpen(true);
    requestAnimationFrame(() => formRef.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' }));
  }
  function planCampaign(source) {
    if (hidden || pending || submitting || teamBusy || blocked.current) return;
    setOpportunity({ type: source.type, source_id: source.source_id });
    setGoal(source.type === 'booking' ? 'bookings' : source.type === 'gallery' ? 'show_work' : 'explain');
    setFocus(source.title || ''); setBriefOpen(true);
    requestAnimationFrame(() => formRef.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' }));
  }
  async function submit(event) {
    event?.preventDefault();
    if (hidden || lock.current || inRead.current || historyLock.current || teamBusy || available !== true || blocked.current) return;
    lock.current = true; epoch.current++; setSubmitting(true); setError('');
    const sequence = epoch.current;
    // An uncertain response must reuse both the original request ID and brief.
    const payload = pending || { request_id: crypto.randomUUID(), goal, focus: focus.trim(), treatment_id: null, ...(opportunity ? { opportunity } : {}) };
    setPending(payload); pendingSave(owner.id, payload);
    try {
      const response = await request('/runs', { method: 'POST', body: payload });
      if (!alive.current || sequence !== epoch.current) return;
      const next = checkedRun(response.run);
      if (next.request_id !== payload.request_id) throw new Error('Another brief is in progress. Check the saved work before continuing.');
      viewed.current = ''; setViewId(''); setRun(next); setLatest(next); remember([next]); setBriefOpen(false); setPending(null); pendingSave(owner.id, null); setSelected('strategy');
    } catch (err) {
      if (!alive.current || sequence !== epoch.current) return;
      if ([400, 401, 403, 409, 422, 429].includes(err.status)) { setPending(null); pendingSave(owner.id, null); }
      setError(err.message);
    } finally { lock.current = false; if (alive.current && sequence === epoch.current) setSubmitting(false); }
  }
  async function retry() {
    if (hidden || lock.current || inRead.current || historyLock.current || teamBusy || !run?.retryable || run.status !== 'failed' || blocked.current) return;
    lock.current = true; epoch.current++; setSubmitting(true); setError('');
    const sequence = epoch.current;
    try {
      const data = await request(`/runs/${encodeURIComponent(run.id)}/retry`, { method: 'POST', body: {} });
      if (alive.current && sequence === epoch.current) { const next = checkedRun(data.run); setRun(next); setLatest(next); remember([next]); }
    } catch (err) { if (alive.current && sequence === epoch.current) setError(`${err.message} Check progress before retrying.`); }
    finally { lock.current = false; if (alive.current && sequence === epoch.current) setSubmitting(false); }
  }
  const openOutput = id => { setSelected(id); requestAnimationFrame(() => outputRef.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' })); };
  async function reviewCaption(post) {
    if (hidden || !plain(post?.caption).trim() || artworkLock.current || blocked.current) return;
    artworkLock.current = true; setArtworkBusy(true); setError('');
    const sequence = epoch.current, viewSequence = viewGeneration.current;
    try {
      await session();
      let imageFile;
      if (post.format === 'story') {
        const image = await renderContentArtwork({ kind: 'knowledge', businessName: owner.business_name, title: post.title || 'From the salon', body: post.caption, format: 'story' });
        imageFile = new File([image.blob], image.filename, { type: image.mimeType });
      }
      if (!alive.current || sequence !== epoch.current || viewSequence !== viewGeneration.current) return;
      onCompose?.({ caption: post.caption, format: post.format === 'story' ? 'story' : 'feed', title: post.title || 'Your content brief', source_note: post.source_note || '', source_refs: post.source_refs || [], ...(imageFile ? { imageFile } : {}) });
    } catch (err) { if (alive.current && sequence === epoch.current) setError(err.message); }
    finally { artworkLock.current = false; if (alive.current && sequence === epoch.current) setArtworkBusy(false); }
  }

  if (sessionBlocked) return <section className="fl-content-team"><div className="fl-team-notice" role="alert">Your account changed. Reopen Content for your signed-in salon.</div></section>;
  return <section className="fl-content-team" aria-label="Your content team">
    <div className="fl-team-hero">
      <div className="fl-team-hero-copy">
        <span className="fl-team-eyebrow"><Icon name="flower" size={19}/> YOUR CREATIVE TEAM</span>
        <h2>More you.<br/><em>Less to do.</em></h2>
        <p>Plans, captions and Reel ideas for your salon. You choose what goes out.</p>
        <div className="fl-team-hero-actions">
          {run || savedPosts.length ? <Button disabled={hidden} onClick={() => (run ? outputRef : workRef).current?.scrollIntoView({ block: 'start', behavior: 'auto' })}><Icon name={active ? 'clock' : 'arrow-right'} size={17}/>{run ? active ? 'See campaign progress' : run.status === 'failed' ? 'Continue saved campaign' : 'Review my campaign' : 'Review my saved posts'}</Button> : suggestions.length ? <Button disabled={hidden || checking || available !== true || !!pending} onClick={() => { ideasRef.current.open = true; ideasRef.current.scrollIntoView({ block: 'start', behavior: 'auto' }); }}><Icon name="flower" size={17}/>Choose my next campaign</Button> : null}
          <Button variant={run || savedPosts.length || suggestions.length ? 'quiet' : 'primary'} onClick={openBrief} disabled={hidden || teamBusy || submitting || checking || available !== true || !!pending}><Icon name="plus" size={17}/>Brief my team</Button>
        </div>
      </div>
      <div className="fl-team-still-life" aria-hidden="true">
        <div className="fl-team-still-orbit"/>
        <div className="fl-team-paper fl-team-paper-back"><span>THE DIRECTION</span><strong>A story worth<br/>sharing.</strong><i/><i/><i/></div>
        <div className="fl-team-paper fl-team-paper-front"><span>THE WORDS</span><Icon name="flower" size={36}/><strong>Your voice.<br/><em>Beautifully put.</em></strong><div><i/><i/><i/></div><small>MADE FOR YOUR SALON</small></div>
        <div className="fl-team-film"><Icon name="video" size={18}/><span>A little creative direction</span><b>01 / 03</b></div>
      </div>
    </div>

    {error && <div className="fl-team-notice" role="alert"><p><PrivateText>{error}</PrivateText></p><Button variant="quiet" disabled={checking || submitting} onClick={() => refresh()}>Check progress</Button></div>}
    {available === false && <div className="fl-team-notice"><Icon name="clock" size={18}/><div><strong>The new team is not available yet</strong><p><PrivateText>{reason || 'Your saved posts and photo preparation are still available below.'}</PrivateText></p></div><Button variant="quiet" disabled={checking} onClick={() => refresh()}>Check again</Button></div>}

    {briefOpen && <PrivateSection placeholder="Content brief hidden"><form ref={formRef} className="fl-team-brief" onSubmit={submit} aria-label="Content brief">
      <div className="fl-team-section-heading"><div><h3>{opportunity ? 'Your campaign, ready to brief.' : 'Give us a little direction.'}</h3></div><Button variant="quiet" type="button" disabled={submitting || !!pending} onClick={() => setBriefOpen(false)}>Close brief</Button></div>
      {opportunity && <div className="fl-team-campaign-source"><Icon name="link" size={17}/><p>{chosenSuggestion?.reason || 'The team will recheck this saved campaign source before it starts.'}</p><Button variant="quiet" type="button" disabled={submitting || !!pending} onClick={() => setOpportunity(null)}>Use my own brief</Button></div>}
      <div className="fl-team-goals" role="group" aria-label="Content goal">{GOALS.map(([id,label,icon]) => <button type="button" key={id} aria-pressed={id === goal} disabled={submitting || !!pending || teamBusy} onClick={() => setGoal(id)}><Icon name={icon} size={19}/>{label}{goal === id && <Icon name="check" size={15}/>}</button>)}</div>
      <label className="fl-team-focus">What would you like to focus on?<textarea value={focus} maxLength={600} rows={3} disabled={submitting || !!pending || teamBusy} onChange={event => setFocus(event.target.value)} placeholder="A treatment you love, a question clients ask, or something you want to share…"/><span>Optional. The team checks this against your saved salon facts.</span></label>
      <div className="fl-team-brief-actions"><Button type="submit" disabled={submitting || historyBusy || teamBusy || available !== true || checking}>{submitting ? 'Saving your brief…' : pending ? 'Retry this same brief' : opportunity ? 'Prepare my campaign' : 'Start content brief'}<Icon name="arrow-right" size={17}/></Button><small>{pending ? 'The previous response was interrupted. Check progress, or retry the same brief without making a duplicate.' : 'A saved plan, captions and a filming brief. Publication stays in your hands.'}</small></div>
    </form></PrivateSection>}


    {run && <p className="fl-team-saved-status" role="status">{active ? 'Working on your brief' : run.status === 'ready' ? 'Your brief is ready' : 'Your saved campaign needs attention'}</p>}
    {history.length > 0 && <div className="fl-team-history"><label>Saved briefs<select aria-label="Saved briefs" value={viewId} disabled={historyBusy || submitting} onChange={event => chooseRun(event.target.value)}><option value="">Current brief</option>{history.map(item => <option key={item.id} value={item.id}>{new Date(item.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · {hidden ? 'Content brief' : item.brief?.focus || GOALS.find(([id]) => id === item.brief?.goal)?.[1] || 'Content brief'}</option>)}</select></label>{moreHistory && <Button variant="quiet" disabled={historyBusy || submitting} onClick={loadOlder}>Load older briefs</Button>}{historyBusy && <span role="status">Opening saved work…</span>}</div>}
    {viewId && teamBusy && run?.id !== latest?.id && <p className="fl-team-note">Your current brief is still running. You can read this earlier work while it finishes.</p>}
    {artworkBusy && <p className="fl-team-note" role="status">Preparing your draft for review…</p>}
    <div ref={outputRef} hidden={!run} className="fl-team-output">
      {run ? <>
        <div className="fl-team-output-heading"><div><h3>{GOALS.find(([id]) => id === run.brief?.goal)?.[1] || 'Your content plan'}</h3>{run.brief?.focus && <p><PrivateText placeholder="Brief hidden">{run.brief.focus}</PrivateText></p>}</div><Button variant="quiet" onClick={() => refresh()} disabled={checking || submitting}>Check progress<Icon name="refresh" size={15}/></Button></div>
        {active && <p className="fl-team-run-status" role="status"><Icon name="flower" size={19}/>{run.status === 'queued' ? 'Your brief is saved and waiting for the team.' : 'The team is working through your brief.'}<span>You can leave this page. Check back here for saved progress.</span></p>}
        {run.status === 'failed' && <div className="fl-team-notice" role="alert"><p><PrivateText>{plain(run.error) || 'The team couldn’t finish this brief. Completed work is saved below.'}</PrivateText></p>{run.retryable && <Button variant="secondary" disabled={hidden || submitting || checking || historyBusy || teamBusy} onClick={retry}>Retry unfinished work</Button>}</div>}
        <div className="fl-team-output-tabs" role="tablist" aria-label="Team work">{SPECIALISTS.map(agent => <button key={agent.id} type="button" role="tab" id={`content-team-tab-${agent.id}`} aria-controls="content-team-panel" aria-selected={selected === agent.id} tabIndex={selected === agent.id ? 0 : -1} onClick={() => setSelected(agent.id)} onKeyDown={event => { const index = SPECIALISTS.findIndex(item => item.id === selected); const next = event.key === 'ArrowRight' ? (index+1)%3 : event.key === 'ArrowLeft' ? (index+2)%3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : null; if(next !== null) { event.preventDefault(); setSelected(SPECIALISTS[next].id); event.currentTarget.parentElement.children[next].focus(); } }}><Icon name={agent.icon} size={17}/>{agent.short}{run.stages.find(stage => stage.id === agent.id)?.status === 'complete' && <Icon name="check" size={14}/>}</button>)}</div>
        <div role="tabpanel" id="content-team-panel" aria-labelledby={`content-team-tab-${selected}`} tabIndex={0}>
          {selectedStage?.status === 'complete' && selectedStage.output ? <TeamOutput type={selected} output={selectedStage.output} onReview={reviewCaption} canReview={!hidden && !!onCompose && !artworkBusy}/> : <div className="fl-team-awaiting"><Icon name={selectedAgent.icon} size={26}/><h4>{selectedStage?.status === 'failed' ? 'This part needs another try.' : selectedStage?.status === 'running' ? `${selectedAgent.work} your next chapter…` : 'A little direction, then good work.'}</h4><p>{selectedStage?.status === 'failed' ? 'Any completed stages remain saved in the other tabs.' : selectedAgent.detail}</p></div>}
        </div>
      </> : <div className="fl-team-empty"><Icon name={selectedAgent.icon} size={24}/><div><h3>{selectedAgent.role}.</h3><p>{selectedAgent.detail} Start a brief to see the team’s work here.</p></div><Button variant="quiet" disabled={hidden || checking || available !== true} onClick={openBrief}>Write a brief<Icon name="arrow-right" size={16}/></Button></div>}
    </div>

    <div ref={workRef} className="fl-team-prepared">
      <div className="fl-team-section-heading"><div><h3>Prepared for you.</h3></div><Button variant="quiet" onClick={onPosts}>See all posts<Icon name="arrow-right" size={15}/></Button></div>
      {(canPrepare || sourcesLoading || savedPosts.length > 0) && <div className="fl-team-prepare-line"><p>{readyPosts === null ? 'Checking your saved posts…' : readyPosts ? `${readyPosts} ${readyPosts === 1 ? 'post is' : 'posts are'} ready to review.` : 'Make posts from your saved photos and salon notes.'}</p>{canPrepare ? <Button variant="secondary" disabled={hidden || preparing || sourcesLoading} onClick={onPrepare}>{preparing ? 'Preparing your content…' : needsArtwork ? 'Finish my prepared posts' : 'Prepare my next posts'}</Button> : <Button variant="secondary" disabled={hidden} onClick={onPhotos}><Icon name="camera" size={17}/>Add a photo</Button>}</div>}
      {preparing && <p className="fl-team-run-status" role="status"><PrivateText>{prepareStage}</PrivateText><span>Keep this page open while the pictures are made. Saved drafts stay in Your posts.</span></p>}
      {prepareError && <div role="alert" className="fl-team-notice"><p><PrivateText>{prepareError}</PrivateText></p><Button variant="quiet" disabled={hidden || preparing || sourcesLoading} onClick={onRefresh}>Refresh prepared work</Button></div>}
      {note && <p role="status" className="fl-team-note"><PrivateText>{note}</PrivateText></p>}
      {children}
      {!savedPosts.length && !sourcesLoading && <button className="fl-team-photo-invite" type="button" disabled={hidden} onClick={onPhotos}><span className="fl-team-photo-mark"><Icon name="camera" size={24}/></span><span><strong>Add a treatment photo</strong><small>Choose a photo you have permission to share.</small></span><Icon name="arrow-right" size={20}/></button>}
    </div>

    <details ref={ideasRef} className="fl-team-campaigns fl-team-disclosure" aria-label="Campaign suggestions" open={!run && !savedPosts.length && suggestions.length > 0 || undefined}>
      <summary>Campaign ideas<Icon name="chevron-down" size={17}/></summary>
      <div className="fl-team-section-heading"><p className="fl-team-ideas-intro">From your diary, photos and salon knowledge.</p><Button variant="quiet" onClick={onRefresh} disabled={sourcesLoading || preparing}>Refresh ideas</Button></div>
      <PrivateSection placeholder="Campaign suggestions hidden">
        {sourcesLoading ? <p role="status" className="fl-team-note">Checking your diary and saved content…</p> : suggestions.length ? <div className="fl-team-campaign-grid">{suggestions.map((source, index) => <article key={`${source.type}:${source.source_id}`} className={`fl-team-campaign ${index === 0 ? 'is-lead' : ''}`}>
          <span className="fl-team-eyebrow"><Icon name={source.type === 'booking' ? 'calendar' : source.type === 'gallery' ? 'camera' : 'book-open'} size={17}/>{source.type === 'booking' ? 'FROM YOUR DIARY' : source.type === 'gallery' ? 'FROM YOUR PHOTOS' : 'FROM YOUR SALON KNOWLEDGE'}</span>
          <h4>{source.type === 'booking' ? `Invite clients for ${source.treatment || 'a treatment'}` : source.title}</h4>
          <p>{source.reason}</p>
          <Button variant="secondary" onClick={() => planCampaign(source)} disabled={hidden || teamBusy || submitting || checking || available !== true || !!pending}>Plan this campaign<Icon name="arrow-right" size={16}/></Button>
        </article>)}</div> : <div className="fl-team-notice"><div><strong>{collection(board?.unavailable).length || prepareError ? 'Some sources could not be checked' : 'Give Florrie something real to work with'}</strong><p>{collection(board?.unavailable).length || prepareError ? 'Refresh ideas to try again. You can still write your own brief using verified salon facts.' : 'Add a treatment photo or save a useful answer in Knowledge. Your next campaign can start there.'}</p><Link to="/knowledge">Open salon knowledge</Link></div></div>}
        <p className="fl-team-note">Review before publishing. Share the tracked booking link to measure results.</p>
      </PrivateSection>
    </details>

    <details className="fl-team-disclosure fl-team-about"><summary>Meet the team behind your content<Icon name="chevron-down" size={17}/></summary>
        <div className="fl-team-specialists">{SPECIALISTS.map((agent,index) => {
      const step = run?.stages.find(item => item.id === agent.id);
      return <button type="button" key={agent.id} className={`fl-team-specialist ${selected === agent.id && run ? 'is-selected' : ''}`} onClick={() => openOutput(agent.id)} aria-label={`Open ${agent.short}`}>
        <span className="fl-team-specialist-top"><span className={`fl-team-agent-mark fl-team-agent-mark-${agent.id}`}><Icon name={agent.icon} size={22}/></span><span className="fl-team-agent-number">0{index+1}</span></span>
        <span className="fl-team-agent-title">{agent.title}</span><strong>{agent.role}</strong><span className="fl-team-agent-description">{agent.detail}</span>
        <span className={`fl-team-agent-status is-${step?.status || 'idle'}`}><i aria-hidden="true"/>{stageLabel(step,agent,available)}<Icon name="arrow-up-right" size={16}/></span>
      </button>;
    })}</div>
    <div className="fl-team-context">
      <h4>What the team uses</h4>
      <p>Your treatments, approved salon knowledge and saved writing preferences. Campaign suggestions also use the diary opportunity or saved photo you choose. Private conversations, clinical records and unapproved review quotes stay out of briefs.</p>
      <Link to="/knowledge">Update salon knowledge<Icon name="arrow-right" size={14}/></Link>
    </div>
    </details>

    <nav className="fl-team-connections" aria-label="More content tools">
      <Link to="/inbox"><span className="fl-team-connection-icon"><Icon name="message" size={22}/></span><span><strong>Inbox</strong></span><Icon name="arrow-up-right" size={16}/></Link>
      <Link to="/reviews"><span className="fl-team-connection-icon"><Icon name="star" size={22}/></span><span><strong>Reviews</strong></span><Icon name="arrow-up-right" size={16}/></Link>
      <button type="button" onClick={onResults}><span className="fl-team-connection-icon"><Icon name="trending-up" size={22}/></span><span><strong>Booking results</strong><small>{campaignResults === null ? 'Booking results could not be checked.' : campaignResults.length ? `${bookings} confirmed through tracked post links in 90 days.` : 'View tracked bookings'}</small></span><Icon name="arrow-up-right" size={16}/></button>
    </nav>
  </section>;
}

function Sources({ item }) {
  const refs = sourceList(item);
  return (item.source_note || refs.length > 0) && <details className="fl-team-evidence"><summary>What this is based on<Icon name="chevron-down" size={13}/></summary>{item.source_note && <p><PrivateText>{item.source_note}</PrivateText></p>}{refs.length > 0 && <p>{refs.join(' · ')}</p>}</details>;
}
function TeamOutput({ type, output, onReview, canReview }) {
  if (type === 'strategy') return <PrivateSection placeholder="Content strategy hidden"><div className="fl-team-strategy-output"><p className="fl-team-strategy-summary">{plain(output.summary)}</p><ol className="fl-team-storyline">{collection(output.posts).map((post,index) => <li key={post.id || index}><span className="fl-team-story-number">0{index+1}</span><div><span className="fl-team-format">{post.format === 'reel' ? 'Reel idea' : post.format === 'story' ? 'Story idea' : 'Feed idea'}</span><h4>{plain(post.title)}</h4><p>{plain(post.angle)}</p><Sources item={post}/></div></li>)}</ol><p className="fl-team-note">This is a suggested sequence. Choose publication dates when you review your posts.</p></div></PrivateSection>;
  if (type === 'writing') return <div className="fl-team-writing-output">{collection(output.hooks).length > 0 && <div className="fl-team-hooks"><span className="fl-team-eyebrow">A FEW WAYS IN</span>{collection(output.hooks).map((hook,index) => <p key={index}><span>0{index+1}</span><PrivateText placeholder="Opening line hidden">{plain(hook)}</PrivateText></p>)}</div>}<div className="fl-team-caption-grid">{collection(output.posts).map((post,index) => <CaptionCard key={post.id || index} post={post} onReview={onReview} canReview={canReview}/>)}</div><p className="fl-team-note">Review opens an unsaved draft. Story words are placed in a ready-to-review image. Feed and Reel captions need your own photo or footage.</p></div>;
  return <PrivateSection placeholder="Filming plan hidden"><div className="fl-team-reel-output"><div className="fl-team-reel-intro"><span className="fl-team-reel-slate"><Icon name="video" size={27}/><span>SHOOT NOTES</span></span><div><span className="fl-team-eyebrow">YOUR FILMING PLAN</span><h4>{plain(output.title)}</h4><p>A guide for filming your own Reel. No video has been made or published.</p></div></div><blockquote>{plain(output.hook)}</blockquote><ol className="fl-team-shots">{collection(output.shots).map((shot,index) => <li key={index}><span>0{index+1}</span><div><h5>{plain(shot.shot)}</h5>{shot.spoken && <p><b>Say</b> {plain(shot.spoken)}</p>}{shot.on_screen && <p><b>On screen</b> {plain(shot.on_screen)}</p>}</div></li>)}</ol>{collection(output.needs).length > 0 && <div className="fl-team-reel-needs"><strong>Before you film</strong><ul>{collection(output.needs).map((need,index) => <li key={index}>{plain(need)}</li>)}</ul></div>}<Sources item={output}/>{output.caption && <><details className="fl-team-evidence"><summary>Caption to go with it<Icon name="chevron-down" size={13}/></summary><p>{plain(output.caption)}</p></details><Button variant="secondary" disabled={!canReview} onClick={() => onReview(output)}>Review Reel caption<Icon name="arrow-right" size={15}/></Button><p className="fl-team-note">Opens a caption draft in the photo editor. Keep this filming plan for creating your video separately.</p></>}</div></PrivateSection>;
}

function CaptionCard({ post, onReview, canReview }) {
  const [caption, setCaption] = useState(plain(post.caption)), [title, setTitle] = useState(plain(post.title));
  const story = post.format === 'story';
  return <PrivateSection placeholder="Caption draft hidden"><article className="fl-team-caption"><span className="fl-team-format">{story ? 'Story artwork' : post.format === 'reel' ? 'Reel caption draft' : 'Feed caption'}</span>
    {story ? <><label className="fl-team-story-edit">Story heading<input aria-label="Story heading" value={title} maxLength={120} onChange={event => setTitle(event.target.value)}/></label><label className="fl-team-story-edit">Story words<textarea aria-label="Story words" value={caption} maxLength={240} rows={5} onChange={event => setCaption(event.target.value)}/></label><p className="fl-team-note">Edit these words before review. Florrie places them in the Story image.</p></> : <><h4>{title}</h4><p className="fl-team-caption-text">{caption}</p></>}
    <Sources item={post}/><Button variant="secondary" disabled={!canReview || !caption.trim() || !title.trim()} onClick={() => onReview({ ...post, title, caption })}>Review caption<Icon name="arrow-right" size={15}/></Button></article></PrivateSection>;
}
