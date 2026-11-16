import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import { isNativeApp } from '../lib/platform.js';
import { readAuthenticatedJson } from '../lib/authenticated-json.js';
import { startInstagramConnection } from '../lib/instagram-connect.js';
import Button from './ui/Button.jsx';
import ChannelProof from './ChannelProof.jsx';
import Icon from './ui/Icon.jsx';

export default function SocialConnections({ owner }) {
  return owner?.id ? <ConnectionsForOwner key={owner.id} owner={owner}/> : null;
}

function ConnectionsForOwner({ owner }) {
  const [params] = useSearchParams();
  const [channels, setChannels] = useState({});
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const generation = useRef(0), alive = useRef(true), blocked = useRef(false);
  const checkedAuth = useMemo(() => Object.fromEntries(['getSession', 'refreshSession'].map(method => [method, async () => {
    const result = await supabase.auth[method]();
    if (blocked.current || result.data?.session?.user?.id !== owner.auth_id) throw new Error('Your salon context changed.');
    return result;
  }])), [owner.auth_id]);
  const refresh = useCallback(async () => {
    if (blocked.current) return;
    const version = ++generation.current;
    // Keep failures independent: an email or Meta outage must not erase another channel.
    setChannels({});
    await Promise.allSettled([
      ['instagram', '/api/instagram/status'], ['whatsapp', '/api/whatsapp/status'],
      ['signup', '/api/whatsapp/embedded/availability'],
    ].map(async ([key, path]) => {
      try {
        const data = await readAuthenticatedJson({ auth: checkedAuth, url: `${API_BASE}${path}` });
        if (typeof data?.[key === 'signup' ? 'available' : 'connected'] !== 'boolean') throw new Error('Incomplete connection status');
        if (alive.current && generation.current === version) setChannels(previous => ({ ...previous, [key]: { data } }));
      } catch {
        if (alive.current && generation.current === version) setChannels(previous => ({ ...previous, [key]: { error: true } }));
      }
    }));
  }, [checkedAuth]);
  useEffect(() => {
    alive.current = true; void refresh();
    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || session?.user?.id && session.user.id !== owner.auth_id) {
        blocked.current = true; generation.current++;
        setChannels({ instagram: { error: true }, whatsapp: { error: true }, signup: { error: true } });
        setError('Your account changed. Reopen connections for your signed-in salon.');
      }
    });
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', visible);
    let listener, disposed = false;
    if (isNativeApp()) import('@capacitor/browser').then(async ({ Browser }) => {
      listener = await Browser.addListener('browserFinished', refresh); if (disposed) await listener.remove();
    }).catch(() => {});
    return () => { authListener?.subscription?.unsubscribe(); disposed = true; alive.current = false; generation.current++; document.removeEventListener('visibilitychange', visible); void listener?.remove(); };
  }, [refresh, owner.auth_id]);
  async function connectInstagram() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await startInstagramConnection({ api: API_BASE, native: isNativeApp(), returnTo: 'connections', getToken: async () => {
        const { data, error: sessionError } = await supabase.auth.getSession();
        if (sessionError || !alive.current || data?.session?.user?.id !== owner.auth_id) throw new Error('Reopen connections for your signed-in salon.');
        return data.session.access_token;
      } });
    } catch (e) { if (alive.current) setError(e.message); }
    finally { if (alive.current) setBusy(false); }
  }
  const ig = channels.instagram?.data, wa = channels.whatsapp?.data, signup = channels.signup?.data;
  const igVerified = ig?.connected && ig.token_valid === true && ig.webhook_subscribed === true;
  const igLabel = !channels.instagram ? 'Checking…' : channels.instagram.error ? 'Couldn’t check' : ig?.needs_reconnect ? 'Reconnect needed' : igVerified ? 'Access verified' : ig?.connected ? 'Check connection' : 'Not connected';
  const waLabel = !channels.whatsapp ? 'Checking…' : channels.whatsapp.error ? 'Couldn’t check' : wa?.retry_exhausted ? 'Needs attention' : wa?.pending_activation ? 'Finishing setup' : wa?.connected ? 'Connection saved' : 'Not connected';
  return <>
    <div className="mc-social-heading"><span className="mc-eyebrow">WHERE YOUR CLIENTS ALREADY ARE</span><Button variant="quiet" onClick={refresh}>Check connections</Button></div>
    {params.get('ig') === 'error' && <p role="alert" className="mc-alert">Instagram setup didn’t finish. Check you’re signing into a Business or Creator account, then try again.</p>}
    {params.get('ig') === 'success' && <p role="status" className="mc-note">Instagram sign-in finished. Check its connection below, then try an enquiry in Inbox.</p>}
    {error && <p role="alert" className="mc-alert">{error}</p>}
    <div className="mc-social-grid">
      <section className="mc-card" aria-label="Instagram connection">
        <div className="mc-heading"><span className="mc-icon"><Icon name="camera" size={23}/></span><div><h2>Instagram</h2><span className="mc-status">{igLabel}</span></div></div>
        <p className="mc-detail">{ig?.connected ? ig.page_name ? `Connected account: @${ig.page_name.replace(/^@/, '')}` : 'Your salon’s Instagram account is saved.' : 'Bring client DMs into Inbox and publish the posts you approve.'}</p>
        {igVerified ? <p className="mc-detail">Account access and message setup checked. Send an enquiry from another Instagram account, then open Inbox to check it arrived.</p> : <ol className="mc-steps"><li>Use an Instagram Business or Creator account.</li><li>Sign in with Instagram and approve Florrie’s access.</li><li>Check a test enquiry in your Florrie Inbox.</li></ol>}
        {ig?.connected && !igVerified && <p className="mc-note">{ig.needs_reconnect ? 'Instagram access has expired or been removed. Reconnect this account.' : 'We haven’t verified both account access and incoming messages. Check again or review the connection in Settings.'}</p>}
        {!ig?.connected && <p className="mc-detail">Access for new salons is awaiting Meta’s approval. If Meta says your account is not eligible yet, keep using Instagram and check back here.</p>}
        <div className="mc-actions">{igVerified ? <Link className="mc-action" to="/inbox">Open Inbox <span aria-hidden="true">→</span></Link> : <Button onClick={connectInstagram} disabled={busy || !channels.instagram || !!channels.instagram.error}>{busy ? 'Opening Instagram…' : ig?.connected ? 'Reconnect Instagram' : 'Connect Instagram'}</Button>}</div>
        {ig?.connected && !blocked.current && <ChannelProof ownerId={owner.id} channel="instagram" auth={checkedAuth}/>}
        <Link className="mc-action" to="/settings?section=ai">Reply settings <span aria-hidden="true">→</span></Link>
      </section>
      <section className="mc-card" aria-label="WhatsApp connection">
        <div className="mc-heading"><span className="mc-icon"><Icon name="chat" size={23}/></span><div><h2>WhatsApp</h2><span className="mc-status">{waLabel}</span></div></div>
        <p className="mc-detail">{wa?.connected ? 'Your number is saved. Open WhatsApp setup to check activation and reply settings.' : 'Connect your salon’s number through Meta, from your own device.'}</p>
        <ol className="mc-steps"><li>Choose the number you use for your salon.</li><li>Sign in to Meta and follow the number check.</li><li>Check a test enquiry in your Florrie Inbox.</li></ol>
        {!wa?.connected && <p className="mc-note">{signup?.business_app_available ? 'Already use the WhatsApp Business app? Choose the option to keep using it during setup.' : 'Keeping an existing WhatsApp Business app connected is still being checked. Keep your account and chats. A separate, unused business number may be eligible.'}</p>}
        {signup && !signup.available && !wa?.connected && <p className="mc-detail">Self-service setup is not available for this salon yet. Your current WhatsApp keeps working.</p>}
        {wa?.connected && !blocked.current && <ChannelProof ownerId={owner.id} channel="whatsapp" auth={checkedAuth}/>}
        <Link className="mc-action" to="/whatsapp">{wa?.connected ? 'Manage WhatsApp' : 'Check WhatsApp setup'} <span aria-hidden="true">→</span></Link>
      </section>
    </div>
    <p className="mc-detail">Connecting a channel doesn’t switch on automatic replies. Choose how Florrie helps in your reply settings, then check a test message before relying on it.</p>
  </>;
}
