import { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import { contentRequest } from '../lib/content-workflow.js';
import Button from './ui/Button.jsx';
import Icon from './ui/Icon.jsx';

export default function GoogleReviews({ ownerId, salonName }) {
  const [status, setStatus] = useState(null), [data, setData] = useState(null), [locations, setLocations] = useState([]);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [editor, setEditor] = useState(null);
  const [loading, setLoading] = useState(false), [fresh, setFresh] = useState(false), [choosingBusiness, setChoosingBusiness] = useState(false);
  const owner = useRef(ownerId), scope = useRef(0), generation = useRef(0), locked = useRef(null), dataLocation = useRef(null);
  owner.current = ownerId;
  const currentScope = () => ({ ownerId: owner.current, scope: scope.current });
  const isCurrent = run => run.ownerId === owner.current && run.scope === scope.current;
  const assertCurrent = run => { if (!isCurrent(run)) throw new Error('The salon changed. Open Google reviews again.'); };

  async function request(path, options = {}, run = currentScope()) {
    assertCurrent(run);
    let timer;
    let session;
    try {
      session = await Promise.race([
        supabase.auth.getSession(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Sign-in took too long. Try again. Nothing has been sent.')), 15000); }),
      ]);
    } finally { clearTimeout(timer); }
    assertCurrent(run);
    if (session.error) throw new Error('Sign in again to use Google reviews. Nothing has been sent.');
    const result = await contentRequest(`${API_BASE}/api/google-reviews${path}`, { token: session.data?.session?.access_token, ...options });
    assertCurrent(run);
    return result;
  }

  async function load(run = currentScope(), withinAction = false) {
    if (!isCurrent(run) || (locked.current && !withinAction)) return;
    const read = ++generation.current;
    const active = () => isCurrent(run) && read === generation.current;
    setLoading(true); setFresh(false); setError('');
    setEditor(previous => previous ? { ...previous, approved: false } : null);
    try {
      const s = await request('/status', {}, run);
      if (!active()) return;
      if (typeof s?.available !== 'boolean' || typeof s?.connected !== 'boolean') throw new Error('Could not check Google setup. Try again.');
      setStatus(s);
      if (!s.connected || dataLocation.current !== s.location?.name) {
        setData(null); dataLocation.current = null;
      }
      setChoosingBusiness(s.connected && !s.location);
      if (s.check_error) { setError(s.check_error); return; }
      if (s.connected && s.location) {
        const d = await request('/reviews', {}, run);
        if (!active()) return;
        dataLocation.current = s.location.name;
        setData(d); setFresh(true);
        setEditor(previous => {
          if (!previous) return null;
          const review = d.reviews?.find(r => (r.reviewId || r.name?.split('/').pop()) === previous.id);
          return review ? { ...previous, fingerprint: review.fingerprint, approved: false } : null;
        });
      } else if (s.connected) {
        setLocations([]);
        const result = await request('/locations', {}, run);
        if (active()) setLocations(result.locations || []);
      }
    } catch (e) { if (active()) setError(e.message); }
    finally { if (active()) setLoading(false); }
  }

  useEffect(() => {
    const run = { ownerId, scope: ++scope.current };
    locked.current = null; dataLocation.current = null;
    setStatus(null); setData(null); setLocations([]); setEditor(null); setBusy(false); setChoosingBusiness(false);
    void load(run);
    return () => { scope.current++; generation.current++; };
  }, [ownerId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let disposed = false, handle;
    import('@capacitor/browser').then(({ Browser }) => Browser.addListener('browserFinished', () => { if (!disposed) void load(); }))
      .then(h => { if (disposed) h.remove(); else handle = h; }).catch(() => {});
    return () => { disposed = true; handle?.remove(); };
  }, [ownerId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(fn) {
    if (locked.current || loading) return;
    const run = currentScope(), lock = {};
    locked.current = lock; setBusy(true); setError('');
    try { await fn(run); }
    catch (e) { if (isCurrent(run)) setError(e.message); }
    finally { if (isCurrent(run) && locked.current === lock) { locked.current = null; setBusy(false); } }
  }

  async function connect(run) {
    const native = Capacitor.isNativePlatform();
    const { url } = await request(`/connect${native ? '?platform=native' : ''}`, {}, run);
    const parsed = new URL(url);
    if (parsed.origin !== 'https://accounts.google.com' || parsed.pathname !== '/o/oauth2/v2/auth' || parsed.username || parsed.password) throw new Error('Could not open a verified Google connection link.');
    if (native) {
      const { Browser } = await import('@capacitor/browser');
      assertCurrent(run);
      await Browser.open({ url });
    } else { assertCurrent(run); window.location.assign(url); }
  }

  async function chooseBusiness(run) {
    setChoosingBusiness(true); setLocations([]);
    const result = await request('/locations', {}, run);
    setLocations(result.locations || []);
  }

  const disabled = busy || loading;
  const reconnect = status?.reconnect_required === true;
  return <section className="fl-reputation-panel" aria-labelledby="google-reviews-title">
    <div className="fl-reputation-heading"><div><span className="fl-workspace-eyebrow">Your public reputation</span><h2 id="google-reviews-title">Google reviews</h2><p>{status?.location?.title || 'Read the feedback. Choose your words. Approve each reply.'}</p></div><Icon name="star" size={25} /></div>
    {error && <div className="fl-reputation-error" role="alert">{error}<Button variant="quiet" onClick={() => choosingBusiness && status?.connected ? act(chooseBusiness) : load()} disabled={disabled}>Retry</Button></div>}
    {loading && <p role="status">{status ? 'Refreshing your Google connection…' : 'Checking Google connection…'}</p>}
    {status?.available === false && <p className="fl-studio-note">Google imports and replies are awaiting connection setup. Your review request link below still works.</p>}
    {status?.available && !status.connected && <>
      <p>{reconnect ? 'Reconnect Google to read this salon’s reviews.' : `Connect the Google account that manages ${salonName || 'your salon'}, then choose its Business Profile.`}</p>
      <Button disabled={disabled} onClick={() => act(connect)}>{reconnect ? 'Reconnect Google' : 'Connect Google Business Profile'}</Button>
      <p className="fl-studio-note">Use an account with owner or manager access to your salon’s existing profile.</p>
    </>}
    {status?.connected && <div className="fl-studio-actions">
      <Button variant="quiet" disabled={disabled} onClick={() => load()}>Refresh from Google</Button>
      {status.location && !choosingBusiness && <Button variant="quiet" disabled={disabled} onClick={() => act(chooseBusiness)}>Change business</Button>}
      <Button variant="quiet" disabled={disabled} onClick={() => act(connect)}>Reconnect Google</Button>
      <Button variant="quiet" disabled={disabled} onClick={() => act(async run => { await request('/disconnect', { method: 'POST' }, run); setEditor(null); await load(run, true); })}>Disconnect reviews</Button>
    </div>}
    {status?.connected && <p className="fl-studio-note">This connection belongs to {salonName || 'your salon'}. Disconnecting reviews leaves Google Calendar unchanged.</p>}
    {status?.connected && choosingBusiness && <div className="fl-reputation-locations">
      <p>Choose the Business Profile for {salonName || 'your salon'}.</p>
      {(loading || busy) && <p role="status">Loading your Business Profiles…</p>}
      {locations.map(l => <button key={l.name} disabled={disabled || l.name === status.location?.name} aria-label={`Use ${l.title}${l.address ? `, ${l.address}` : ''}`} onClick={() => act(async run => {
        await request('/location', { method: 'POST', body: { name: l.name } }, run);
        setData(null); dataLocation.current = null; setEditor(null); setChoosingBusiness(false);
        await load(run, true);
      })}><strong>{l.title}{l.name === status.location?.name ? ' (current profile)' : ''}</strong><small>{l.address || 'No address supplied by Google'}</small></button>)}
      {!locations.length && !error && !disabled && <p>No Business Profiles found in this Google account. Try the account you use to manage your salon on Google.</p>}
      <div className="fl-studio-actions">
        <Button variant="secondary" disabled={disabled} onClick={() => act(connect)}>Use another Google account</Button>
        {status.location && <Button variant="quiet" disabled={disabled} onClick={() => { setChoosingBusiness(false); setError(''); }}>Keep current business</Button>}
        <a className="fl-studio-link" href="https://business.google.com/locations" target="_blank" rel="noopener noreferrer">Find my Business Profile ↗</a>
      </div>
    </div>}
    {data && !choosingBusiness && <>
      <p className="fl-studio-note">Read from Google {new Date(data.fetched_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}. Review text stays separate from your Florrie training notes and marketing posts.</p>
      {!data.reviews?.length && <p>No Google reviews found for this business.</p>}
      {(data.reviews || []).map(review => {
        const id = review.reviewId || review.name?.split('/').pop();
        return <article className="fl-google-imported-review" key={review.name || id}>
          <div className="fl-review-byline"><strong>{review.reviewer?.displayName || 'Google reviewer'}</strong><span>{({ ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 })[review.starRating] || 'Unrated'} / 5</span></div>
          <p className="fl-review-quote">{review.comment || 'This review contains a rating only.'}</p>
          {review.reviewReply && <div className="fl-review-existing"><strong>Reply on Google</strong><p>{review.reviewReply.comment}</p></div>}
          {editor?.id === id ? <div className="fl-review-editor">
            <label>Review your reply<textarea aria-label="Google review reply" rows={4} maxLength={4096} value={editor.text} disabled={disabled} onChange={e => setEditor({ ...editor, text: e.target.value, approved: false })} /></label>
            <label className="fl-review-consent"><input type="checkbox" checked={editor.approved} disabled={disabled || !fresh} onChange={e => setEditor({ ...editor, approved: e.target.checked })} /> I approve these exact words as a public reply on Google.</label>
            <div className="fl-studio-actions"><Button disabled={disabled || !fresh || !editor.approved || !editor.text.trim()} onClick={() => act(async run => {
              try { await request(`/reviews/${encodeURIComponent(id)}/reply`, { method: 'POST', body: { text: editor.text, fingerprint: editor.fingerprint, approved: true } }, run); }
              catch (e) { if (isCurrent(run)) { setFresh(false); setEditor(previous => previous ? { ...previous, approved: false } : null); } throw e; }
              setEditor(null); await load(run, true);
            })}>{busy ? 'Working…' : 'Approve & publish reply'}</Button><Button variant="quiet" disabled={disabled} onClick={() => setEditor(null)}>Cancel</Button></div>
          </div> : <div className="fl-studio-actions"><Button variant="secondary" disabled={disabled || !fresh} onClick={() => act(async run => {
            const r = await request(`/reviews/${encodeURIComponent(id)}/draft`, { method: 'POST' }, run);
            setEditor({ id, text: r.draft, fingerprint: r.fingerprint, approved: false });
          })}>Draft a reply</Button><Button variant="quiet" disabled={disabled || !fresh} onClick={() => setEditor({ id, text: review.reviewReply?.comment || '', fingerprint: review.fingerprint, approved: false })}>Write my own</Button></div>}
        </article>;
      })}
      {data.nextPageToken && <Button variant="secondary" disabled={disabled || !fresh} onClick={() => act(async run => {
        const next = await request(`/reviews?cursor=${encodeURIComponent(data.nextPageToken)}`, {}, run);
        setData({ ...next, reviews: [...new Map([...data.reviews, ...next.reviews].map(r => [r.name, r])).values()] });
      })}>Load more Google reviews</Button>}
    </>}
  </section>;
}
