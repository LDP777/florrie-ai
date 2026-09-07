import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import { readAuthenticatedJson } from '../lib/authenticated-json.js';
import Button from './ui/Button.jsx';
import Icon from './ui/Icon.jsx';

const ROLES = [
  { id: 'front_desk', name: 'Front Desk', short: 'Front desk', icon: 'message', x: 50, y: 11, link: '/inbox', purpose: 'Replies and booking steps, guided by your writing and your diary.', sources: ['Conversations', 'Diary', 'Your writing'] },
  { id: 'content_creator', name: 'Content Studio', short: 'Content', icon: 'image', x: 81, y: 32, link: '/content', purpose: 'Post ideas and captions from your treatments, photos and brief.', sources: ['Treatments', 'Photos', 'Your brief'] },
  { id: 'client_intel', name: 'Client Intel', short: 'Client intel', icon: 'users', x: 81, y: 71, link: '/rebook', purpose: 'Visit patterns that help you spot when a regular may be ready to return.', sources: ['Visit history', 'Client preferences', 'Diary'] },
  { id: 'bookkeeper', name: 'Bookkeeper', short: 'Money', icon: 'wallet', x: 50, y: 89, link: '/money', purpose: 'Income, expenses and payment records together for your review.', sources: ['Payments', 'Appointments', 'Expenses'] },
  { id: 'business_coach', name: 'Biz Coach', short: 'Insights', icon: 'chart', x: 19, y: 71, link: '/insights', purpose: 'Business patterns and next steps backed by your completed bookings.', sources: ['Completed bookings', 'Prices', 'Trends'] },
  { id: 'guardian', name: 'Guardian', short: 'Client care', icon: 'shield', x: 19, y: 32, link: '/compliance', purpose: 'Patch tests, forms and aftercare connected to the client and their visit.', sources: ['Client records', 'Treatment rules', 'Next visit'] },
];
const STAMP = value => value ? new Date(value).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Not recorded yet';

function checkState(agent) {
  if (!agent?.checks?.length) return { key: 'unknown', label: 'Check unavailable' };
  if (agent.checks.some(check => check.state === 'attention')) return { key: 'attention', label: 'Check needs attention' };
  if (agent.checks.some(check => check.state !== 'recent')) return { key: 'unknown', label: 'Checks incomplete' };
  return { key: 'recent', label: 'Recent background checks' };
}

/** A map of connected capabilities. Selection highlights a connection, not a live task. */
export function AgentNetwork({ agents = [], learning, compact = false, loading = false, error = false, onRefresh }) {
  const [selected, setSelected] = useState('front_desk');
  const uid = useId();
  const navigate = useNavigate();
  const role = ROLES.find(item => item.id === selected) || ROLES[0];
  const agent = Array.isArray(agents) ? agents.find(item => item.id === role.id) : null;
  const status = checkState(agent);
  return (
    <section className={`agent-network ${compact ? 'agent-network--compact' : ''}`} aria-labelledby={`${uid}-title`}>
      <header className="agent-network__heading">
        <div><p className="agent-network__eyebrow">CONNECTED INTELLIGENCE</p><h2 id={`${uid}-title`}>Florrie at work</h2></div>
        <span className="agent-network__role-count">6 roles</span>
      </header>
      <p className="agent-network__intro">Your diary, clients and preferences. Shared across the work.</p>
      <div className="agent-network__layout">
        <div className="agent-network__map" role="group" aria-label="Explore Florrie’s connected roles">
          <svg className="agent-network__connections" viewBox="0 0 320 292" preserveAspectRatio="none" aria-hidden="true">
            <ellipse cx="160" cy="146" rx="107" ry="105" className="agent-network__orbit" />
            {ROLES.map(item => <path key={item.id} className={selected === item.id ? 'is-selected' : ''} d={`M160 146 Q${item.x < 50 ? 110 : item.x > 50 ? 210 : 160} 146 ${item.x * 3.2} ${item.y * 2.92}`} />)}
          </svg>
          <div className="agent-network__core" aria-hidden="true">
            <svg viewBox="0 0 100 100" width="47" height="47">{[0, 72, 144, 216, 288].map((angle, index) => <ellipse key={angle} cx="50" cy="30" rx="16" ry="24" fill="currentColor" opacity={[0.9, 0.72, 0.54, 0.64, 0.8][index]} transform={`rotate(${angle} 50 50)`} />)}<circle cx="50" cy="50" r="7" fill="currentColor" /></svg>
            <span>florrie</span>
          </div>
          {ROLES.map(item => <Button key={item.id} variant="quiet" className={`agent-network__node ${selected === item.id ? 'is-selected' : ''}`} style={{ left: `${item.x}%`, top: `${item.y}%` }} aria-pressed={selected === item.id} aria-label={`Explore ${item.name}`} aria-controls={`${uid}-detail`} onClick={() => setSelected(item.id)}>
            <Icon name={item.icon} size={19} /><span>{item.short}</span>
          </Button>)}
        </div>
        <div className="agent-network__detail" id={`${uid}-detail`}>
          <p className="agent-network__eyebrow">{compact ? 'TAP A ROLE TO EXPLORE' : 'HOW THE WORK CONNECTS'}</p>
          <h3>{role.name}</h3>
          <p className="agent-network__purpose">{role.purpose}</p>
          {!compact && <div className="agent-network__sources" aria-label="Shared information">{role.sources.map(source => <span key={source}>{source}</span>)}</div>}
          <div className="agent-network__evidence" aria-live="polite">
            {loading ? <p role="status">Checking recent work…</p> : error ? <p role="status">Recent work could not be checked.</p> : <>
              <p className="agent-network__outcome">{agent?.statusLine || 'No activity information available for this role.'}</p>
              {agent?.lastActionAt && <span className="agent-network__timestamp">Recorded {STAMP(agent.lastActionAt)}</span>}
              <p className={`agent-network__check agent-network__check--${status.key}`}><span aria-hidden="true" />{status.label}</p>
            </>}
          </div>
          {!compact && <>
            <p className="agent-network__sample">{agent?.actionsThisWeek == null ? 'Completed count unavailable' : `${agent.actionsThisWeek} completed in recent records`} · last 7 days</p>
            <details className="agent-network__checks" key={role.id}><summary>Background checks</summary>{agent?.checks?.length ? agent.checks.map(check => <p key={check.name}><span>{check.name.replaceAll('-', ' ').replace(' v2', '')}</span><span>{check.state === 'attention' ? 'Needs attention · ' : ''}{STAMP(check.last_success_at)}</span></p>) : <p>Check records are unavailable for this role.</p>}</details>
            <Button variant="secondary" onClick={() => navigate(role.link)}>Open {role.name}</Button>
          </>}
        </div>
      </div>
      {!compact && learning && <div className="agent-network__learning" aria-label="Learning from your business">
        <span><strong>{learning.human_samples == null ? 'Unavailable' : learning.human_samples}</strong> human-written samples</span>
        <span><strong>{learning.client_profiles == null ? 'Unavailable' : learning.client_profiles}</strong> client visit profiles</span>
      </div>}
      <footer className="agent-network__footer">
        {compact ? <Button variant="quiet" onClick={() => navigate('/insights')}>Explore Florrie’s brief <Icon name="arrow-right" size={15} /></Button> : <p>Recent records are a sample of up to 300 events. Background checks and completed actions are recorded separately.</p>}
        {onRefresh && <Button variant="quiet" size="sm" aria-label="Refresh Florrie’s work" disabled={loading} onClick={onRefresh}><Icon name="refresh" size={15} /></Button>}
      </footer>
    </section>
  );
}

/** Today reads only the light status endpoint, once the widget approaches view. */
export default function TodayAgentNetwork({ beauticianId }) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);
  const [revision, refresh] = useState(0);
  const [state, setState] = useState({ loading: false, data: null, error: false });
  useEffect(() => {
    if (!ref.current || !beauticianId) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '160px' });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [beauticianId]);
  useEffect(() => {
    if (!visible || !beauticianId) return;
    let active = true;
    setState({ loading: true, data: null, error: false });
    readAuthenticatedJson({ auth: supabase.auth, url: `${API_BASE}/api/agents/status` })
      .then(data => { if (active) setState({ loading: false, data, error: !Array.isArray(data.agents) }); })
      .catch(() => { if (active) setState({ loading: false, data: null, error: true }); });
    return () => { active = false; };
  }, [beauticianId, visible, revision]);
  return <div ref={ref}><AgentNetwork compact agents={state.data?.agents} loading={state.loading || !visible} error={state.error} onRefresh={() => refresh(n => n + 1)} /></div>;
}
