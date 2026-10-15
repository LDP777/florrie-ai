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
  return ({ brief: 'Your brief', treatment: 'Treatment menu', knowledge: 'Saved salon knowledge', photo: 'Saved photo notes' })[type];
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
  const initialPending = useRef(pendingRead(owner.id));
  const [run, setRun] = useState(null), [available, setAvailable] = useState(null);
  const [reason, setReason] = useState(''), [checking, setChecking] = useState(true);
  const [error, setError] = useState(''), [submitting, setSubmitting] = useState(false);
  const [pending, setPending] = useState(initialPending.current), [briefOpen, setBriefOpen] = useState(!!initialPending.current);
  const [goal, setGoal] = useState(initialPending.current?.goal || 'show_work');
  const [focus, setFocus] = useState(initialPending.current?.focus || '');
  const [selected, setSelected] = useState('strategy');
  const [history, setHistory] = useState([]), [moreHistory, setMoreHistory] = useState(false), [nextOffset, setNextOffset] = useState(20);
  const [historyBusy, setHistoryBusy] = useState(false), [latest, setLatest] = useState(null), [viewId, setViewId] = useState('');
  const [sessionBlocked, setSessionBlocked] = useState(false), [artworkBusy, setArtworkBusy] = useState(false);
  const alive = useRef(false), epoch = useRef(0), lock = useRef(false), inRead = useRef(false);
  const authEpoch = useRef(0), blocked = useRef(false), viewed = useRef(''), viewGeneration = useRef(0), historyLock = useRef(false), artworkLock = useRef(false);
  const formRef = useRef(null), workRef = useRef(null), outputRef = useRef(null);
  const active = !!run && ACTIVE.has(run.status);
  const teamBusy = !!latest && ACTIVE.has(latest.status);
  const selectedStage = run?.stages.find(stage => stage.id === selected);
  const selectedAgent = SPECIALISTS.find(agent => agent.id === selected);
  const savedPosts = collection(board?.prepared);
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
    setBriefOpen(true);
    requestAnimationFrame(() => formRef.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' }));
  }
  async function submit(event) {
    event?.preventDefault();
    if (lock.current || inRead.current || historyLock.current || teamBusy || available !== true || blocked.current) return;
    lock.current = true; epoch.current++; setSubmitting(true); setError('');
    const sequence = epoch.current;
    // An uncertain response must reuse both the original request ID and brief.
    const payload = pending || { request_id: crypto.randomUUID(), goal, focus: focus.trim(), treatment_id: null };
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
    if (lock.current || inRead.current || historyLock.current || teamBusy || !run?.retryable || run.status !== 'failed' || blocked.current) return;
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
    if (!plain(post?.caption).trim() || artworkLock.current || blocked.current) return;
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
        <p>A plan with purpose. Words that sound like you. A little direction for your next Reel.</p>
        <div className="fl-team-hero-actions"><Button onClick={openBrief} disabled={teamBusy || submitting || checking || available !== true}><Icon name="plus" size={17}/>Brief my team</Button><button type="button" className="fl-team-text-button" onClick={() => workRef.current?.scrollIntoView({ block: 'start', behavior: 'auto' })}>See prepared posts<Icon name="arrow-down" size={15}/></button></div>
        <span className="fl-team-hero-note">One shared brief. You have the final say.</span>
      </div>
      <div className="fl-team-still-life" aria-hidden="true">
        <div className="fl-team-still-orbit"/>
        <div className="fl-team-paper fl-team-paper-back"><span>THE DIRECTION</span><strong>A story worth<br/>sharing.</strong><i/><i/><i/></div>
        <div className="fl-team-paper fl-team-paper-front"><span>THE WORDS</span><Icon name="flower" size={36}/><strong>Your voice.<br/><em>Beautifully put.</em></strong><div><i/><i/><i/></div><small>MADE FOR YOUR SALON</small></div>
        <div className="fl-team-film"><Icon name="video" size={18}/><span>A little creative direction</span><b>01 / 03</b></div>
      </div>
    </div>

    <div className="fl-team-context">
      <span><Icon name="link" size={15}/> Built around your salon</span>
      <details><summary>What the team uses<Icon name="chevron-down" size={14}/></summary><p>Your active treatment menu and approved salon knowledge give the team its facts. Saved writing preferences guide the wording. Private conversations, clinical records and unapproved review quotes stay out of these briefs.</p><Link to="/knowledge">Update salon knowledge<Icon name="arrow-right" size={14}/></Link></details>
    </div>

    {error && <div className="fl-team-notice" role="alert"><p>{error}</p><Button variant="quiet" disabled={checking || submitting} onClick={() => refresh()}>Check progress</Button></div>}
    {available === false && <div className="fl-team-notice"><Icon name="clock" size={18}/><div><strong>The new team is not available yet</strong><p>{reason || 'Your saved posts and photo preparation are still available below.'}</p></div><Button variant="quiet" disabled={checking} onClick={() => refresh()}>Check again</Button></div>}

    {briefOpen && <form ref={formRef} className="fl-team-brief" onSubmit={submit} aria-label="Content brief">
      <div className="fl-team-section-heading"><div><span className="fl-team-eyebrow">START WITH A PURPOSE</span><h3>Give us a little direction.</h3></div><Button variant="quiet" type="button" disabled={submitting || !!pending} onClick={() => setBriefOpen(false)}>Close brief</Button></div>
      <div className="fl-team-goals" role="group" aria-label="Content goal">{GOALS.map(([id,label,icon]) => <button type="button" key={id} aria-pressed={id === goal} disabled={submitting || !!pending || teamBusy} onClick={() => setGoal(id)}><Icon name={icon} size={19}/>{label}{goal === id && <Icon name="check" size={15}/>}</button>)}</div>
      <label className="fl-team-focus">What would you like to focus on?<textarea value={focus} maxLength={600} rows={3} disabled={submitting || !!pending || teamBusy} onChange={event => setFocus(event.target.value)} placeholder="A treatment you love, a question clients ask, or something you want to share…"/><span>Optional. The team checks this against your saved salon facts.</span></label>
      <div className="fl-team-brief-actions"><Button type="submit" disabled={submitting || historyBusy || teamBusy || available !== true || checking}>{submitting ? 'Saving your brief…' : pending ? 'Retry this same brief' : 'Start content brief'}<Icon name="arrow-right" size={17}/></Button><small>{pending ? 'The previous response was interrupted. Check progress, or retry the same brief without making a duplicate.' : 'A saved plan, captions and a filming brief. Publication stays in your hands.'}</small></div>
    </form>}

    <div className="fl-team-section-heading fl-team-specialist-heading"><div><span className="fl-team-eyebrow">A LITTLE EXPERTISE, WORKING TOGETHER</span><h3>Your team.</h3></div><span className="fl-team-saved-status">{checking && !run ? 'Checking saved work…' : active ? 'Working on your brief' : run?.status === 'ready' ? 'Your brief is ready' : 'Three specialists. One direction.'}</span></div>
    <div className="fl-team-specialists">{SPECIALISTS.map((agent,index) => {
      const step = run?.stages.find(item => item.id === agent.id);
      return <button type="button" key={agent.id} className={`fl-team-specialist ${selected === agent.id && run ? 'is-selected' : ''}`} onClick={() => openOutput(agent.id)} aria-label={`Open ${agent.short}`}>
        <span className="fl-team-specialist-top"><span className={`fl-team-agent-mark fl-team-agent-mark-${agent.id}`}><Icon name={agent.icon} size={22}/></span><span className="fl-team-agent-number">0{index+1}</span></span>
        <span className="fl-team-agent-title">{agent.title}</span><strong>{agent.role}</strong><span className="fl-team-agent-description">{agent.detail}</span>
        <span className={`fl-team-agent-status is-${step?.status || 'idle'}`}><i aria-hidden="true"/>{stageLabel(step,agent,available)}<Icon name="arrow-up-right" size={16}/></span>
      </button>;
    })}</div>

    {history.length > 0 && <div className="fl-team-history"><label>Saved briefs<select aria-label="Saved briefs" value={viewId} disabled={historyBusy || submitting} onChange={event => chooseRun(event.target.value)}><option value="">Current brief</option>{history.map(item => <option key={item.id} value={item.id}>{new Date(item.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · {item.brief?.focus || GOALS.find(([id]) => id === item.brief?.goal)?.[1] || 'Content brief'}</option>)}</select></label>{moreHistory && <Button variant="quiet" disabled={historyBusy || submitting} onClick={loadOlder}>Load older briefs</Button>}{historyBusy && <span role="status">Opening saved work…</span>}</div>}
    {viewId && teamBusy && run?.id !== latest?.id && <p className="fl-team-note">Your current brief is still running. You can read this earlier work while it finishes.</p>}
    {artworkBusy && <p className="fl-team-note" role="status">Preparing your draft for review…</p>}
    <div ref={outputRef} className="fl-team-output">
      {run ? <>
        <div className="fl-team-output-heading"><div><span className="fl-team-eyebrow">{run.status === 'ready' ? 'THE TEAM’S WORK' : 'YOUR SAVED BRIEF'}</span><h3>{GOALS.find(([id]) => id === run.brief?.goal)?.[1] || 'Your content plan'}</h3>{run.brief?.focus && <p>{run.brief.focus}</p>}</div><Button variant="quiet" onClick={() => refresh()} disabled={checking || submitting}>Check progress<Icon name="refresh" size={15}/></Button></div>
        {active && <p className="fl-team-run-status" role="status"><Icon name="flower" size={19}/>{run.status === 'queued' ? 'Your brief is saved and waiting for the team.' : 'The team is working through your brief.'}<span>You can leave this page. Check back here for saved progress.</span></p>}
        {run.status === 'failed' && <div className="fl-team-notice" role="alert"><p>{plain(run.error) || 'The team couldn’t finish this brief. Completed work is saved below.'}</p>{run.retryable && <Button variant="secondary" disabled={submitting || checking || historyBusy || teamBusy} onClick={retry}>Retry unfinished work</Button>}</div>}
        <div className="fl-team-output-tabs" role="tablist" aria-label="Team work">{SPECIALISTS.map(agent => <button key={agent.id} type="button" role="tab" id={`content-team-tab-${agent.id}`} aria-controls="content-team-panel" aria-selected={selected === agent.id} tabIndex={selected === agent.id ? 0 : -1} onClick={() => setSelected(agent.id)} onKeyDown={event => { const index = SPECIALISTS.findIndex(item => item.id === selected); const next = event.key === 'ArrowRight' ? (index+1)%3 : event.key === 'ArrowLeft' ? (index+2)%3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : null; if(next !== null) { event.preventDefault(); setSelected(SPECIALISTS[next].id); event.currentTarget.parentElement.children[next].focus(); } }}><Icon name={agent.icon} size={17}/>{agent.short}{run.stages.find(stage => stage.id === agent.id)?.status === 'complete' && <Icon name="check" size={14}/>}</button>)}</div>
        <div role="tabpanel" id="content-team-panel" aria-labelledby={`content-team-tab-${selected}`} tabIndex={0}>
          {selectedStage?.status === 'complete' && selectedStage.output ? <TeamOutput type={selected} output={selectedStage.output} onReview={reviewCaption} canReview={!!onCompose && !artworkBusy}/> : <div className="fl-team-awaiting"><Icon name={selectedAgent.icon} size={26}/><h4>{selectedStage?.status === 'failed' ? 'This part needs another try.' : selectedStage?.status === 'running' ? `${selectedAgent.work} your next chapter…` : 'A little direction, then good work.'}</h4><p>{selectedStage?.status === 'failed' ? 'Any completed stages remain saved in the other tabs.' : selectedAgent.detail}</p></div>}
        </div>
      </> : <div className="fl-team-empty"><Icon name={selectedAgent.icon} size={24}/><div><h3>{selectedAgent.role}.</h3><p>{selectedAgent.detail} Start a brief to see the team’s work here.</p></div><Button variant="quiet" disabled={checking || available !== true} onClick={openBrief}>Write a brief<Icon name="arrow-right" size={16}/></Button></div>}
    </div>

    <div ref={workRef} className="fl-team-prepared">
      <div className="fl-team-section-heading"><div><span className="fl-team-eyebrow">FROM YOUR PHOTOS & SALON NOTES</span><h3>Prepared for you.</h3></div><Button variant="quiet" onClick={onPosts}>See all posts<Icon name="arrow-right" size={15}/></Button></div>
      <div className="fl-team-prepare-line"><p>{readyPosts === null ? 'Checking your saved posts…' : readyPosts ? `${readyPosts} ${readyPosts === 1 ? 'post has' : 'posts have'} pictures and words ready for review.` : 'Turn the photos and knowledge you already have into posts you can review.'}</p>{canPrepare ? <Button variant="secondary" disabled={preparing || sourcesLoading} onClick={onPrepare}>{preparing ? 'Preparing your content…' : needsArtwork ? 'Finish my prepared posts' : 'Prepare my next posts'}</Button> : <Button variant="secondary" onClick={onPhotos}><Icon name="camera" size={17}/>Add a photo</Button>}</div>
      {preparing && <p className="fl-team-run-status" role="status">{prepareStage}<span>Keep this page open while the pictures are made. Saved drafts stay in Your posts.</span></p>}
      {prepareError && <div role="alert" className="fl-team-notice"><p>{prepareError}</p><Button variant="quiet" disabled={preparing || sourcesLoading} onClick={onRefresh}>Refresh prepared work</Button></div>}
      {note && <p role="status" className="fl-team-note">{note}</p>}
      {children}
      {!savedPosts.length && !sourcesLoading && <button className="fl-team-photo-invite" type="button" onClick={onPhotos}><span className="fl-team-photo-mark"><Icon name="camera" size={24}/></span><span><strong>Your work is the starting point.</strong><small>Add a photo you have permission to share. Florrie can help with the words.</small></span><Icon name="arrow-right" size={20}/></button>}
    </div>

    <div className="fl-team-connected-heading"><span className="fl-team-eyebrow">THE REST OF THE PICTURE</span><p>Good content connects to the rest of your business.</p></div>
    <div className="fl-team-connections">
      <Link to="/inbox"><span className="fl-team-connection-icon"><Icon name="message" size={22}/></span><span><strong>Your community</strong><small>Keep real conversations in your inbox.</small></span><Icon name="arrow-up-right" size={16}/></Link>
      <Link to="/reviews"><span className="fl-team-connection-icon"><Icon name="star" size={22}/></span><span><strong>Your reputation</strong><small>Review requests and permission to share.</small></span><Icon name="arrow-up-right" size={16}/></Link>
      <button type="button" onClick={onResults}><span className="fl-team-connection-icon"><Icon name="trending-up" size={22}/></span><span><strong>What brings bookings</strong><small>{campaignResults === null ? 'Booking results could not be checked.' : campaignResults.length ? `${bookings} confirmed through tracked post links in 90 days.` : 'Track the appointments that follow a post.'}</small></span><Icon name="arrow-up-right" size={16}/></button>
    </div>
    <p className="fl-team-bottom-note"><Icon name="flower" size={15}/>A little creative help. Still unmistakably you.</p>
  </section>;
}

function Sources({ item }) {
  const refs = sourceList(item);
  return (item.source_note || refs.length > 0) && <details className="fl-team-evidence"><summary>What this is based on<Icon name="chevron-down" size={13}/></summary>{item.source_note && <p>{item.source_note}</p>}{refs.length > 0 && <p>{refs.join(' · ')}</p>}</details>;
}
function TeamOutput({ type, output, onReview, canReview }) {
  if (type === 'strategy') return <div className="fl-team-strategy-output"><p className="fl-team-strategy-summary">{plain(output.summary)}</p><ol className="fl-team-storyline">{collection(output.posts).map((post,index) => <li key={post.id || index}><span className="fl-team-story-number">0{index+1}</span><div><span className="fl-team-format">{post.format === 'reel' ? 'Reel idea' : post.format === 'story' ? 'Story idea' : 'Feed idea'}</span><h4>{plain(post.title)}</h4><p>{plain(post.angle)}</p><Sources item={post}/></div></li>)}</ol><p className="fl-team-note">This is a suggested sequence. Choose publication dates when you review your posts.</p></div>;
  if (type === 'writing') return <div className="fl-team-writing-output">{collection(output.hooks).length > 0 && <div className="fl-team-hooks"><span className="fl-team-eyebrow">A FEW WAYS IN</span>{collection(output.hooks).map((hook,index) => <p key={index}><span>0{index+1}</span>{plain(hook)}</p>)}</div>}<div className="fl-team-caption-grid">{collection(output.posts).map((post,index) => <CaptionCard key={post.id || index} post={post} onReview={onReview} canReview={canReview}/>)}</div><p className="fl-team-note">Review opens an unsaved draft. Story words are placed in a ready-to-review image. Feed and Reel captions need your own photo or footage.</p></div>;
  return <div className="fl-team-reel-output"><div className="fl-team-reel-intro"><span className="fl-team-reel-slate"><Icon name="video" size={27}/><span>SHOOT NOTES</span></span><div><span className="fl-team-eyebrow">YOUR FILMING PLAN</span><h4>{plain(output.title)}</h4><p>A guide for filming your own Reel. No video has been made or published.</p></div></div><blockquote>{plain(output.hook)}</blockquote><ol className="fl-team-shots">{collection(output.shots).map((shot,index) => <li key={index}><span>0{index+1}</span><div><h5>{plain(shot.shot)}</h5>{shot.spoken && <p><b>Say</b> {plain(shot.spoken)}</p>}{shot.on_screen && <p><b>On screen</b> {plain(shot.on_screen)}</p>}</div></li>)}</ol>{collection(output.needs).length > 0 && <div className="fl-team-reel-needs"><strong>Before you film</strong><ul>{collection(output.needs).map((need,index) => <li key={index}>{plain(need)}</li>)}</ul></div>}<Sources item={output}/>{output.caption && <><details className="fl-team-evidence"><summary>Caption to go with it<Icon name="chevron-down" size={13}/></summary><p>{plain(output.caption)}</p></details><Button variant="secondary" disabled={!canReview} onClick={() => onReview(output)}>Review Reel caption<Icon name="arrow-right" size={15}/></Button><p className="fl-team-note">Opens a caption draft in the photo editor. Keep this filming plan for creating your video separately.</p></>}</div>;
}

function CaptionCard({ post, onReview, canReview }) {
  const [caption, setCaption] = useState(plain(post.caption)), [title, setTitle] = useState(plain(post.title));
  const story = post.format === 'story';
  return <article className="fl-team-caption"><span className="fl-team-format">{story ? 'Story artwork' : post.format === 'reel' ? 'Reel caption draft' : 'Feed caption'}</span>
    {story ? <><label className="fl-team-story-edit">Story heading<input aria-label="Story heading" value={title} maxLength={120} onChange={event => setTitle(event.target.value)}/></label><label className="fl-team-story-edit">Story words<textarea aria-label="Story words" value={caption} maxLength={240} rows={5} onChange={event => setCaption(event.target.value)}/></label><p className="fl-team-note">Edit these words before review. Florrie places them in the Story image.</p></> : <><h4>{title}</h4><p className="fl-team-caption-text">{caption}</p></>}
    <Sources item={post}/><Button variant="secondary" disabled={!canReview || !caption.trim() || !title.trim()} onClick={() => onReview({ ...post, title, caption })}>Review caption<Icon name="arrow-right" size={15}/></Button></article>;
}
