import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import { contentRequest } from '../lib/content-workflow.js';
import Button from './ui/Button.jsx';

export default function ReviewSendingSettings({ ownerId, hasLink, onSaved }) {
  const active = useRef(false);
  const lock = useRef(false);
  const [settings,setSettings] = useState(null);
  const [mode,setMode] = useState('ask');
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const [reload,setReload] = useState(0);
  async function request(method = 'GET', body) {
    const session = await supabase.auth.getSession();
    if (session.error) throw new Error('Sign in again to change review requests.');
    return contentRequest(`${API_BASE}/api/google-reviews/request-settings`, {token:session.data?.session?.access_token,method,body,timeoutMs:15000});
  }
  useEffect(() => {
    active.current = true;
    let current = true;
    setSettings(null); setError(''); setNotice('');
    request().then(result => { if (current) { setSettings(result); setMode(result.mode); } })
      .catch(err => { if (current) setError(err.message); });
    return () => { current = false; active.current = false; };
  }, [ownerId,reload]);
  async function save(event) {
    event.preventDefault();
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const saved = await request('PUT',{mode});
      if (!active.current) return;
      if (saved.mode !== mode || (mode !== 'off' && !saved.startedAt)) throw new Error('Could not confirm the change. Reload to check your settings.');
      setSettings(saved);
      setNotice(mode === 'off' ? 'Review requests switched off.' : mode === 'ask' ? 'Future visits will prepare requests for your approval.' : 'Automatic requests are on for future visits.');
      onSaved?.();
    } catch(err) { if (active.current) setError(err.message || 'Could not save. Your choice is still here.'); }
    finally { lock.current = false; if (active.current) setBusy(false); }
  }
  const status = !hasLink ? 'Add your Google review link first' : settings?.paused ? 'Client messages are paused' : settings?.mode === 'off' ? 'Switched off' : !settings?.startedAt ? 'Automatic visits are not set up yet' : settings.mode === 'auto' ? 'Sends after completed visits' : 'Drafts wait in Outbox';
  return <section aria-label="Review sending preferences" id="review-sending" style={{borderTop:'1px solid var(--border)',marginTop:20,paddingTop:16}}>
    <h3 style={{fontSize:16,margin:'0 0 6px'}}>After each visit</h3>
    {settings ? <>
      <p className="fl-studio-note" role="status">{status}</p>
      <form onSubmit={save}>
        <label className="fl-studio-field">Review requests<select value={mode} disabled={busy} onChange={e => {setMode(e.target.value);setNotice('');}}>
          <option value="ask">Ask me first</option><option value="auto">Send automatically</option><option value="off">Off</option>
        </select></label>
        <p className="fl-studio-note">Starts with future visits, including those Florrie completes for you. Requests wait two hours and respect client permission and sending limits.</p>
        {mode === 'ask' && <p className="fl-studio-note">You approve each message in Outbox.</p>}
        <Button type="submit" disabled={busy || (!hasLink && mode !== 'off')}>{busy ? 'Saving…' : !settings.startedAt && mode !== 'off' ? 'Start review requests' : 'Save preferences'}</Button>
      </form>
    </> : !error && <p role="status">Loading sending preferences…</p>}
    {notice && <p className="fl-studio-note" role="status">{notice}</p>}
    {error && <><p role="alert">{error}</p><Button variant="quiet" disabled={busy} onClick={()=>setReload(n=>n+1)}>Reload preferences</Button></>}
  </section>;
}
