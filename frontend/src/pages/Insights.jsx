import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase, useBeautician } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import { readAuthenticatedJson } from '../lib/authenticated-json.js';
import SuggestionCards from '../components/SuggestionCards.jsx';
import Button from '../components/ui/Button.jsx';
import Icon from '../components/ui/Icon.jsx';

const stamp = value => value ? new Date(value).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Not recorded yet';
const number = value => value == null ? 'Unavailable' : value.toLocaleString('en-GB');

export default function Insights() {
  const { beautician } = useBeautician();
  const navigate = useNavigate();
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [revision, refresh] = useState(0);
  useEffect(() => {
    if (!beautician?.id) return;
    let active = true;
    setState(s => ({ ...s, loading: true, error: null }));
    readAuthenticatedJson({ auth: supabase.auth, url: `${API_BASE}/api/agents/brief` })
      .then(data => { if (active) setState({ data, loading: false, error: null }); })
      .catch(error => { if (active) setState({ data: null, loading: false, error: error.message }); });
    return () => { active = false; };
  }, [beautician?.id, revision]);
  const data = state.data;
  const ask = prompt => navigate('/voice', { state: { prompt } });
  return (
    <main className="insights-page">
      <header className="insights-heading">
        <div><p className="insights-eyebrow">YOUR BUSINESS, IN VIEW</p><h1>Florrie’s brief</h1><p>The work, the learning and your next good move.</p></div>
        <Button variant="secondary" onClick={() => refresh(n => n + 1)} disabled={state.loading}>Refresh</Button>
      </header>
      {state.loading && !data && <p className="insights-notice" role="status">Checking your latest work and patterns…</p>}
      {state.error && <p className="insights-notice" role="alert">{state.error} Use Refresh to try again.</p>}
      {data && <>
        {data.partial && <p className="insights-notice" role="status">Some sources could not be checked. Available evidence is shown below; missing data is labelled.</p>}
        <section className="insights-overview" aria-label="Work in the last seven days">
          <div className="insights-intro"><Icon name="sparkles" size={25} /><h2>A little less on your mind.</h2><p>{data.permissions?.auto_reply_enabled === true ? 'Automatic replies are enabled. Message rules and your approval settings still apply.' : data.permissions?.auto_reply_enabled === false ? 'Automatic replies are off. You stay in control of replies while Florrie prepares the work.' : 'Reply settings could not be checked.'}</p><Button variant="secondary" onClick={() => navigate('/settings')}>Your preferences</Button></div>
          <div className="insights-totals">
            <div><strong className={data.activity?.completed == null ? 'is-unavailable' : undefined}>{number(data.activity?.completed)}</strong><span>completed actions · 7 days{data.activity?.sampled ? ' · recent sample' : ''}</span></div>
            <button onClick={() => navigate('/outbox')}><strong className={data.activity?.pending_approval == null ? 'is-unavailable' : undefined}>{number(data.activity?.pending_approval)}</strong><span>outbound messages awaiting approval <Icon name="arrow-right" size={14} /></span></button>
            <div><strong className={data.activity?.failed == null ? 'is-unavailable' : undefined}>{number(data.activity?.failed)}</strong><span>unsuccessful actions · 7 days</span></div>
          </div>
        </section>
        {data.activity?.sampled && <p className="insights-muted">Activity figures use the latest 300 records within seven days. Background checks are counted separately from completed actions.</p>}
        <div className="insights-columns">
          <div>
            <section className="insights-section"><div className="insights-section-title"><span>01</span><h2>Your next move</h2></div>
              <SuggestionCards key={beautician?.id} showEmpty />
              <Button onClick={() => ask('Read my Florrie brief and help me choose what to focus on next. Explain the evidence and anything you could not check.')}>Talk it through with Florrie</Button>
            </section>
            <section className="insights-section"><div className="insights-section-title"><span>02</span><h2>Patterns worth a look</h2></div>
              {!data.insights_available && <p className="insights-muted">Booking patterns are unavailable. Refresh to try again.</p>}
              {data.insights_available && !data.insights?.length && <p className="insights-muted">There are not enough completed bookings for a useful pattern yet. Florrie will check again as your diary grows.</p>}
              {data.insights_sampled && <p className="insights-muted">Based on a bounded sample of recent bookings and services.</p>}
              {data.insights?.map(card => <article className="insight-story" key={card.id}>
                <span className="insights-eyebrow">{card.confidence === 'scenario' ? 'A SCENARIO TO CONSIDER' : 'FROM YOUR BOOKINGS'}</span><h3>{card.title}</h3><p>{card.summary}</p><p className="insight-evidence">{card.evidence}</p>
                <Button variant="secondary" onClick={() => navigate(card.link_to)}>{card.action_label}</Button>
              </article>)}
            </section>
          </div>
          <aside>
            <section className="insights-learning"><div className="insights-section-title"><span>03</span><h2>More like you</h2></div><p>Your own writing teaches Florrie how you greet clients, phrase replies and sign off.</p>
              <dl><div><dt>Human-written samples in the current voice</dt><dd>{number(data.learning?.human_samples)}</dd></div><div><dt>Recent saved reply edits</dt><dd>{number(data.learning?.saved_corrections)}</dd></div><div><dt>Client visit profiles</dt><dd>{number(data.learning?.client_profiles)}</dd></div></dl>
              <p className="insights-muted">Voice updated {stamp(data.learning?.updated_at)}. New writing is checked hourly; a profile needs enough suitable examples.</p>
              <p className="insights-muted">Learning adjusts writing and visit patterns. It does not change your prices, permissions or treatment rules.</p>
              <Button variant="secondary" onClick={() => navigate('/knowledge')}>What Florrie knows</Button>
            </section>
          </aside>
        </div>
        <section className="insights-section"><div className="insights-section-title"><span>04</span><h2>Working across your business</h2></div><p className="insights-muted">Each area uses your shared diary, clients and preferences. A recent background check records a service run; delivery is recorded separately in activity.</p>
          <div className="insights-team">{data.agents?.map(agent => {
            const attention = agent.checks?.some(c => c.state === 'attention');
            const unknown = agent.checks?.some(c => c.state === 'unknown');
            return <article key={agent.id} className="insights-agent"><div className="insights-agent-top"><h3>{agent.name}</h3><span className={`insights-check ${attention || unknown ? 'is-uncertain' : ''}`}>{attention ? 'Check needs attention' : unknown ? 'Check unverified' : 'Recent checks'}</span></div><p>{agent.statusLine}</p><p className="insights-muted">{number(agent.actionsThisWeek)} completed · 7 days</p><details><summary>Background checks</summary>{agent.checks?.map(check => <p className="insights-check-row" key={check.name}><span>{check.name.replaceAll('-', ' ').replace(' v2', '')}</span><span>{check.state === 'attention' ? 'Needs attention · ' : ''}{stamp(check.last_success_at)}</span></p>)}</details><Button variant="secondary" onClick={() => navigate(agent.link_to)}>Open {agent.name}</Button></article>;
          })}</div>
        </section>
        <footer className="insights-footer">Checked {stamp(data.checked_at)}. Refreshes may reuse evidence from the last 30 seconds.</footer>
      </>}
    </main>
  );
}
