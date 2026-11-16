import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase, useBeautician } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import { readAuthenticatedJson } from '../lib/authenticated-json.js';
import PageHeader from '../components/ui/PageHeader.jsx';
import Button from '../components/ui/Button.jsx';
import Icon from '../components/ui/Icon.jsx';

export default function SetupHub() {
  const { beautician } = useBeautician();
  return beautician?.id ? <SalonSetup key={beautician.id} owner={beautician}/> : <p role="status">Loading your salon…</p>;
}
function SalonSetup({ owner }) {
  const [status, setStatus] = useState(null), [error, setError] = useState(''), [reload, setReload] = useState(0);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let active = true;
    setError(''); setStatus(null);
    const auth = Object.fromEntries(['getSession', 'refreshSession'].map(method => [method, async () => {
      const result = await supabase.auth[method]();
      if (result.data?.session?.user?.id !== owner.auth_id) throw new Error('Your account changed. Reopen setup.');
      return result;
    }]));
    readAuthenticatedJson({ auth, url: `${API_BASE}/api/setup/status` }).then(data => {
      if (!Array.isArray(data?.readiness?.items)) throw new Error('Setup is being updated. Try again shortly.');
      if (active) setStatus(data);
    }).catch(e => { if (active) setError(e.message); });
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || session?.user?.id && session.user.id !== owner.auth_id) {
        active = false; setStatus(null); setError('Your account changed. Reopen setup for your signed-in salon.');
      }
    });
    const visible = () => { if (document.visibilityState === 'visible') setReload(n => n + 1); };
    document.addEventListener('visibilitychange', visible);
    return () => { active = false; listener?.subscription?.unsubscribe(); document.removeEventListener('visibilitychange', visible); };
  }, [owner.auth_id, reload]);
  const items = status?.readiness?.items || [], next = items.find(i => !i.optional && i.state !== 'ready');
  const groups = [...new Set(items.map(i => i.group))];
  const bookingUrl = status?.business?.slug ? `https://florrie.ai/book/${encodeURIComponent(status.business.slug)}` : null;
  async function copyLink() {
    try { await navigator.clipboard.writeText(bookingUrl); setCopied(true); } catch { setError('Could not copy. Open your booking page and copy its address.'); }
  }
  return <main className="salon-setup"><style>{css}</style>
    <Link className="su-back" to="/more">All tools</Link>
    <PageHeader eyebrow="YOUR SALON, READY" title="Make Florrie yours." subtitle="Pick up where you left off. Your saved settings stay with your salon."/>
    {error && <p role="alert" className="su-error">{error} <Button variant="quiet" onClick={() => setReload(n => n + 1)}>Try again</Button></p>}
    {!status && !error && <p role="status">Checking your saved setup…</p>}
    {status && <>
      <section className="su-next" aria-label="Your next setup step">
        <div className="su-progress"><span>{status.readiness.done} of {status.readiness.total} booking checks ready</span><Button variant="quiet" onClick={() => setReload(n => n + 1)}>Refresh checks</Button></div>
        <progress aria-label="Booking setup" max={status.readiness.total} value={status.readiness.done}/>
        <span className="su-eyebrow">{next ? 'NEXT FOR YOUR SALON' : 'YOUR BOOKING SETUP IS IN PLACE'}</span>
        <h2>{next?.label || 'Take a look through your client’s eyes.'}</h2>
        <p>{next?.detail || 'Preview your booking page, check your terms, then connect the channels your clients use.'}</p>
        <Button as={Link} to={next?.path || (bookingUrl ? `/book/${encodeURIComponent(status.business.slug)}` : '/business?tab=booking')}>{next?.state === 'unknown' ? 'Review this check' : next ? 'Continue setup' : 'Preview booking page'} <Icon name="arrow-right" size={16}/></Button>
      </section>
      <section className="su-replies" aria-label="Current reply settings"><Icon name="message-circle" size={22}/><div><h2>How Florrie is helping</h2><p>{status.replies.summary}</p><p>Existing booking help: {status.replies.paused ? 'paused' : status.replies.booking_help ? 'enabled, with safety checks' : 'grounded replies off'}.</p><p>Instagram: {status.replies.paused ? 'paused' : status.replies.instagram === 'ai' ? 'AI reply mode' : status.replies.instagram === 'redirect' ? 'redirect message' : 'manual replies'}.</p><Link to="/settings?section=ai">Review reply settings →</Link></div></section>
      {groups.map(group => <section key={group} className="su-group"><h2>{group}</h2>{items.filter(i => i.group === group).map(item => <Link className="su-row" to={item.path} key={item.key}>
        <span className={`su-dot su-dot-${item.state}`} aria-hidden="true">{item.state === 'ready' ? <Icon name="check" size={16}/> : item.state === 'unknown' ? '?' : '·'}</span>
        <span className="su-row-body"><span className="su-label">{item.label}</span><span className="su-detail">{item.detail}</span><span className="su-state">{item.key === 'connections' ? (status.channels.test_receipt ? 'Test received' : 'Test in connections') : item.key === 'policy' ? 'Current terms' : item.state === 'unknown' ? 'Not checked' : item.state === 'ready' ? 'Saved' : item.optional ? 'Optional' : 'Needs attention'}</span></span><Icon name="chevron-right" size={18}/>
      </Link>)}</section>)}
      {bookingUrl && <section className="su-link"><h2>Your booking link</h2><p>{bookingUrl}</p><div><Button variant="secondary" onClick={copyLink}>{copied ? 'Link copied' : 'Copy link'}</Button><Button as="a" href={bookingUrl} target="_blank" rel="noopener noreferrer" variant="quiet">Preview</Button></div></section>}
      <p className="su-footnote">These checks describe your saved setup. Message delivery needs a test in Connections. Setup never switches on replies or changes your appointments.</p>
    </>}
  </main>;
}
const css = `
.salon-setup{max-width:760px;margin:auto;padding:20px 20px 36px;color:var(--text-primary);font-family:var(--font-body)}
.salon-setup a{color:var(--accent)}.su-back{display:inline-block;padding:10px 0;margin-bottom:8px;font-size:13px}.su-next{padding:24px;border-radius:24px;background:var(--tone-1);border:1px solid var(--border-light);margin:22px 0 16px}.su-progress{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px}.su-next progress{display:block;width:100%;height:5px;margin:12px 0 26px;accent-color:var(--accent)}.su-eyebrow{font-size:11px;font-weight:700;letter-spacing:.12em;color:var(--accent)}.su-next h2{font-family:var(--font-display);font-size:27px;font-weight:500;margin:8px 0}.su-next p,.su-replies p{font-size:13px;line-height:1.65;color:var(--text-secondary);margin:8px 0 16px}.su-next .fl-btn{gap:8px}.su-replies{display:flex;gap:14px;padding:20px;margin-bottom:24px;background:var(--bg-card);border:1px solid var(--border-light);border-radius:20px}.su-replies>svg{color:var(--accent);flex-shrink:0}.su-replies h2{font-size:15px;margin:0}.su-replies p{margin:6px 0}.su-replies a{display:inline-block;padding:9px 0;font-size:12px}.su-group{margin:24px 0}.su-group>h2,.su-link h2{font-family:var(--font-display);font-weight:500;font-size:21px;margin:0 0 10px}.su-row{display:flex;align-items:center;gap:12px;text-decoration:none;padding:17px 4px;border-bottom:1px solid var(--border-light);min-height:70px}.su-row-body{display:flex;flex-direction:column;gap:5px;flex:1;min-width:0}.su-label{font-size:14px;font-weight:650;color:var(--text-primary)}.su-detail{font-size:12px;line-height:1.5;color:var(--text-secondary);overflow-wrap:anywhere}.su-state{font-size:11px;font-weight:650;color:var(--accent)}.su-dot{display:grid;place-items:center;width:25px;height:25px;flex-shrink:0;border:1px solid var(--border);border-radius:50%;color:var(--text-muted)}.su-dot-ready{background:var(--success-bg);color:var(--success);border-color:var(--success)}.su-link{padding:20px;background:var(--bg-card);border:1px solid var(--border-light);border-radius:20px}.su-link p{font-size:13px;overflow-wrap:anywhere}.su-link>div{display:flex;gap:10px}.su-footnote{font-size:12px;line-height:1.7;color:var(--text-muted);margin:20px 0}.su-error{padding:16px;background:var(--danger-bg);border-radius:16px;font-size:13px}.salon-setup a:focus-visible{outline:2px solid var(--accent);outline-offset:4px}.su-next a.fl-btn--primary{color:var(--on-brand,#fff)}
`;
