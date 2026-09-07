import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AgentNetwork } from '../components/AgentNetwork.jsx';
import { supabase, useBeautician } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import { readAuthenticatedJson } from '../lib/authenticated-json.js';
import SuggestionCards from '../components/SuggestionCards.jsx';
import Button from '../components/ui/Button.jsx';
import Icon from '../components/ui/Icon.jsx';
import { FlorrieOrb, EffectFrame, LiquidIndicator } from '../components/ui/FlorrieEffects.jsx';

const stamp = value => value ? new Date(value).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Not recorded yet';
const number = value => value == null ? 'Unavailable' : value.toLocaleString('en-GB');
const VIEWS = [{ id: 'overview', label: 'Your brief' }, { id: 'team', label: 'The team' }, { id: 'learning', label: 'Learning' }];

export default function Insights() {
  const { beautician } = useBeautician();
  const navigate = useNavigate();
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [revision, refresh] = useState(0);
  const [view, setView] = useState('overview');
  useEffect(() => {
    if (!beautician?.id) return;
    let active = true;
    setState(previous => ({ data: previous.ownerId === beautician.id ? previous.data : null, ownerId: beautician.id, loading: true, error: null }));
    readAuthenticatedJson({ auth: supabase.auth, url: `${API_BASE}/api/agents/brief` })
      .then(data => { if (active) setState({ data, ownerId: beautician.id, loading: false, error: null }); })
      .catch(error => { if (active) setState({ data: null, loading: false, error: error.message }); });
    return () => { active = false; };
  }, [beautician?.id, revision]);
  const data = state.ownerId === beautician?.id ? state.data : null;
  const ask = prompt => navigate('/voice', { state: { prompt } });
  const replyMode = data?.permissions?.auto_reply_enabled;
  const moveView = event => {
    const index = VIEWS.findIndex(item => item.id === view);
    const next = event.key === 'ArrowRight' ? (index + 1) % VIEWS.length : event.key === 'ArrowLeft' ? (index + VIEWS.length - 1) % VIEWS.length : event.key === 'Home' ? 0 : event.key === 'End' ? VIEWS.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    setView(VIEWS[next].id);
    event.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next]?.focus();
  };
  return (
    <main className="insights-page">
      <header className="insights-heading">
        <div><p className="insights-eyebrow">A LITTLE HEADSPACE</p><h1>Florrie’s brief</h1></div>
        <Button variant="quiet" icon size="icon" aria-label="Refresh brief" disabled={state.loading} onClick={() => refresh(n => n + 1)}><Icon name="refresh" size={19} /></Button>
      </header>
      <EffectFrame active={state.loading} className="brief-hero-frame"><section className="brief-hero">
        <div className="brief-hero__orb"><FlorrieOrb state={state.loading ? 'connecting' : 'weaving'} size={112} /></div>
        <div className="brief-hero__copy"><span className="insights-eyebrow">YOUR BUSINESS, TOGETHER</span><h2>Space to see<br /><em>what’s next.</em></h2><p>Client care, conversations and your next idea. All in view.</p></div>
        <Button variant="quiet" className="brief-team-link" onClick={() => setView('team')}><span className="brief-team-dots" aria-hidden="true">{['message', 'camera', 'users', 'wallet', 'chart', 'shield'].map(icon => <span key={icon}><Icon name={icon} size={13} /></span>)}</span><span>Meet your six specialists</span><Icon name="arrow-right" size={15} /></Button>
      </section></EffectFrame>
      {state.loading && !data && <p className="insights-notice" role="status">Checking your latest work and patterns…</p>}
      {state.error && <div className="insights-notice" role="alert"><p>{state.error}</p><Button variant="secondary" onClick={() => refresh(n => n + 1)}>Try again</Button></div>}
      {data && <>
        {data.partial && <p className="insights-notice" role="status">Some sources could not be checked. Available evidence is shown below; missing data is labelled.</p>}
        <div className="brief-metrics" aria-label="Work in the last seven days">
          <div><strong className={data.activity?.completed == null ? 'is-unavailable' : ''}>{number(data.activity?.completed)}</strong><span>completed actions</span></div>
          <button onClick={() => navigate('/outbox')}><strong className={data.activity?.pending_approval == null ? 'is-unavailable' : ''}>{number(data.activity?.pending_approval)}</strong><span>awaiting your OK <Icon name="arrow-right" size={12} /></span></button>
          <div><strong className={data.activity?.failed == null ? 'is-unavailable' : ''}>{number(data.activity?.failed)}</strong><span>unsuccessful actions</span></div>
        </div>
        <p className="brief-period">Last 7 days{data.activity?.sampled ? ' · recent sample' : ''}</p>
        <div className="brief-view-tabs fl-liquid-tabs" role="tablist" aria-label="Brief views"><LiquidIndicator index={VIEWS.findIndex(item => item.id === view)} count={VIEWS.length} />{VIEWS.map(item => <button type="button" role="tab" aria-selected={view === item.id} tabIndex={view === item.id ? 0 : -1} onKeyDown={moveView} aria-controls={`brief-panel-${item.id}`} key={item.id} onClick={() => setView(item.id)}>{item.label}</button>)}</div>
        <section id={`brief-panel-${view}`} className="brief-panel" role="tabpanel" aria-label={VIEWS.find(item => item.id === view).label}>
          {view === 'overview' && <>
            <div className="brief-section-heading"><h2>Your next move</h2><span>Picked from your business</span></div>
            <SuggestionCards key={beautician?.id} showEmpty />
            <Button className="brief-talk" variant="secondary" onClick={() => ask('Read my Florrie brief and help me choose what to focus on next. Explain the evidence and anything you could not check.')}><FlorrieOrb size={22} /><span>Talk it through with Florrie</span><Icon name="arrow-right" size={16} /></Button>
            <div className="brief-section-heading"><h2>Worth a closer look</h2><Icon name="chart" size={19} /></div>
            {!data.insights_available && <p className="insights-muted">Booking patterns are unavailable. Refresh to try again.</p>}
            {data.insights_available && !data.insights?.length && <p className="insights-muted">A few more completed bookings will help Florrie find useful patterns here.</p>}
            {data.insights?.map(card => <article className="insight-story" key={card.id}><span className="insights-eyebrow">{card.confidence === 'scenario' ? 'A SCENARIO TO CONSIDER' : 'FROM YOUR BOOKINGS'}</span><h3>{card.title}</h3><p>{card.summary}</p><details><summary>See the evidence</summary><p className="insights-muted">{card.evidence}</p>{data.insights_sampled && <p className="insights-muted">Based on a sample of recent bookings and services.</p>}</details><Button variant="quiet" onClick={() => navigate(card.link_to)}>{card.action_label}<Icon name="arrow-right" size={14} /></Button></article>)}
            <div className="brief-permissions"><Icon name="shield" size={20} /><div><strong>You set the pace</strong><p>{replyMode === true ? 'Automatic replies are enabled. Message rules and your approval settings still apply.' : replyMode === false ? 'Automatic replies are off. You stay in control of replies while Florrie prepares the work.' : 'Reply settings could not be checked.'}</p><Button variant="quiet" onClick={() => navigate('/settings')}>Your preferences <Icon name="arrow-right" size={14} /></Button></div></div>
          </>}
          {view === 'team' && <AgentNetwork key={beautician?.id} agents={data.agents} />}
          {view === 'learning' && <>
            <section className="brief-learning"><FlorrieOrb state="weaving" size={80} paused /><div><p className="insights-eyebrow">MORE LIKE YOU</p><h2>Your words.<br />Your way of working.</h2><p>Your own writing teaches Florrie how you greet clients, phrase replies and sign off.</p></div></section>
            <div className="brief-learning-rows"><div><Icon name="message" size={21} /><span><strong>{number(data.learning?.human_samples)}</strong> human-written samples<span>Your current writing profile</span></span></div><div><Icon name="edit" size={21} /><span><strong>{number(data.learning?.saved_corrections)}</strong> saved reply edits<span>Recent corrections for future drafts</span></span></div><div><Icon name="users" size={21} /><span><strong>{number(data.learning?.client_profiles)}</strong> client visit profiles<span>Visit patterns that inform rebooking ideas</span></span></div></div>
            <p className="insights-muted">Voice updated {stamp(data.learning?.updated_at)}. New writing is checked hourly; a profile needs enough suitable examples.</p>
            <p className="insights-muted">Learning adjusts writing and visit patterns. It does not change your prices, permissions or treatment rules.</p>
            <Button variant="secondary" onClick={() => navigate('/knowledge')}>What Florrie knows <Icon name="arrow-right" size={15} /></Button>
          </>}
        </section>
        <footer className="insights-footer"><span>Checked {stamp(data.checked_at)}</span><details><summary>About these figures</summary><p>Refreshes may reuse evidence from the last 30 seconds. Activity figures use up to 300 recent records within seven days. Background checks are counted separately from completed actions.</p></details></footer>
      </>}
    </main>
  );
}
