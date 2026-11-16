import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase, useBeautician } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import { isNativeApp } from '../lib/platform.js';
import { emailRequest, startEmailConnection } from '../lib/email-connect.js';
import PageHeader from '../components/ui/PageHeader.jsx';
import Button from '../components/ui/Button.jsx';
import Icon from '../components/ui/Icon';
import styles from './message-connections-style.js';
import SalonEmailCard from '../components/SalonEmailCard.jsx';

export default function MessageConnections() {
  const { beautician } = useBeautician();
  const [params] = useSearchParams();
  const [data, setData] = useState(null), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(''), [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [aiDrafts, setAiDrafts] = useState(false), [clientsOnly, setClientsOnly] = useState(true);
  const requestVersion = useRef(0), currentOwner = useRef(beautician?.id);
  currentOwner.current = beautician?.id;
  const refresh = useCallback(async () => {
    const owner = beautician?.id, version = ++requestVersion.current;
    if (!owner) return;
    try {
      const result = await emailRequest({ api: API_BASE, auth: supabase.auth, path: 'status' });
      if (version !== requestVersion.current || currentOwner.current !== owner) return;
      setData(result); setError('');
      if (result.connection?.status !== 'disconnected' && result.connection) { setAiDrafts(result.connection.ai_drafts); setClientsOnly(result.connection.client_emails_only); }
    } catch (e) { if (version === requestVersion.current && currentOwner.current === owner) setError(e.message); }
  }, [beautician?.id]);
  useEffect(() => { setData(null); setAiDrafts(false); setClientsOnly(true); void refresh(); return () => { requestVersion.current++; }; }, [refresh]);
  useEffect(() => {
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', visible);
    let listener, disposed = false;
    if (isNativeApp()) import('@capacitor/browser').then(async ({ Browser }) => { listener = await Browser.addListener('browserFinished', refresh); if (disposed) await listener.remove(); }).catch(() => {});
    return () => { disposed = true; document.removeEventListener('visibilitychange', visible); void listener?.remove(); };
  }, [refresh]);
  const preferences = { ai_drafts: aiDrafts, client_emails_only: clientsOnly, ...(aiDrafts ? { ai_consent: 'anthropic-email-drafts-v1' } : {}) };
  async function act(kind, provider) {
    const owner = beautician?.id;
    if (busy || !owner) return;
    setBusy(kind); setError(''); setNotice('');
    try {
      if (kind === 'connect') await startEmailConnection({ api: API_BASE, auth: supabase.auth, native: isNativeApp(), provider, preferences });
      else {
        const result = await emailRequest({ api: API_BASE, auth: supabase.auth, path: kind, body: kind === 'preferences' ? preferences : {} });
        if (currentOwner.current !== owner) return;
        setNotice(kind === 'disconnect' ? 'Email disconnected. Your existing conversations stay in Inbox.' : kind === 'preferences' ? 'Email preferences saved.' : result.more ? 'Mailbox checked. More messages will follow in the next check.' : `Mailbox checked. ${result.imported} new ${result.imported === 1 ? 'email' : 'emails'} added.`);
        setConfirmDisconnect(false); await refresh();
      }
    } catch (e) { if (currentOwner.current === owner) setError(e.message); }
    finally { if (currentOwner.current === owner) setBusy(''); }
  }
  const c = data?.connection, connected = c?.status === 'connected', present = c && c.status !== 'disconnected';
  const enabled = data?.providers?.some(p => p.available);
  return <main className="message-connections"><style>{styles}</style>
    <Link to="/more?group=business" className="mc-back">All tools</Link>
    <PageHeader title="Your messages, together" eyebrow="Message connections" subtitle="Your salon email, with Florrie." />
    <p className="mc-intro">Keep client enquiries beside your diary. Use your Florrie email, then add the other channels your clients use.</p>
    <SalonEmailCard />
    <section className="mc-card">
      <div className="mc-heading"><span className="mc-icon"><Icon name="chat" size={23} /></span><div><h2>WhatsApp</h2><p>{beautician?.whatsapp_connected ? 'Your connection is saved. Check its status and reply settings.' : 'Let clients reach your salon on WhatsApp.'}</p></div></div>
      <Link className="mc-action" to="/whatsapp">{beautician?.whatsapp_connected ? 'Manage WhatsApp' : 'Set up WhatsApp'} <span aria-hidden="true">→</span></Link>
    </section>
    <details className="mc-card mc-existing" open={present || !!notice || !!error || params.get('email') === 'incomplete' || undefined}>
      <summary id="email-heading">Use your existing business email <span>Optional · Gmail, Outlook or Hotmail</span></summary>
      <p className="mc-detail">Already share another address with clients? Connect it here to receive those enquiries too.</p>
      {error && <div role="alert" className="mc-alert">{error} <button onClick={refresh} disabled={!!busy}>Check again</button></div>}
      {notice && <p role="status" className="mc-note">{notice}</p>}
      {params.get('email') === 'incomplete' && <p className="mc-note">Email setup didn’t finish. Your other connections are unchanged. You can try again below.</p>}
      {!data && !error && <p role="status">Checking email setup…</p>}
      {data && <>
        {present && <div className="mc-account"><strong>{c.email}</strong><span className={connected && !c.error ? 'mc-status' : 'mc-status mc-attention'}>{c.status === 'reconnect' ? 'Reconnect needed' : c.error ? 'Check needed' : 'Access verified'}</span>
          <p>{c.last_synced_at ? `Inbox last checked ${new Date(c.last_synced_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.` : 'Run your first inbox check below.'}</p>{c.error && <p>{c.error}</p>}</div>}
        <div className="mc-how"><h3>{present ? 'Your email preferences' : 'Choose what Florrie helps with'}</h3><p>New emails arrive in Inbox after you connect. Keep using your email app as usual. Attachments stay in your email app.</p></div>
        <label className="mc-option"><input type="checkbox" checked={clientsOnly} disabled={!!busy} onChange={e => setClientsOnly(e.target.checked)} /><span><strong>Only emails from existing clients</strong><small>Match senders to the email addresses in your client list. Turn this off for new enquiries in a dedicated business inbox.</small></span></label>
        <label className="mc-option"><input type="checkbox" checked={aiDrafts} disabled={!!busy} onChange={e => setAiDrafts(e.target.checked)} /><span><strong>Let Florrie prepare draft replies</strong><small>Allow Florrie to share imported email text and relevant salon guidance with Anthropic to prepare drafts. You review and send each reply. You can turn this off here.</small></span></label>
        <p className="mc-detail">Connecting does not send any messages. Florrie checks for new emails in the background while connected.</p>
        <div className="mc-actions">
          {connected ? <><Button disabled={!!busy} onClick={() => act('check')}>{busy === 'check' ? 'Checking inbox…' : 'Check inbox now'}</Button><Button variant="secondary" disabled={!!busy} onClick={() => act('preferences')}>{busy === 'preferences' ? 'Saving…' : 'Save preferences'}</Button></> : data.providers.filter(p => !present || p.id === c.provider).map(p => <Button key={p.id} disabled={!!busy || !p.available} variant="secondary" onClick={() => act('connect', p.id)}>{busy === 'connect' ? 'Opening sign-in…' : `${present ? 'Reconnect' : 'Connect'} ${p.id === 'google' ? 'Gmail' : 'Outlook / Hotmail'}`}</Button>)}
        </div>
        {!enabled && !present && <p className="mc-note">Email sign-in is awaiting provider setup and approval. You can set up WhatsApp now and return for email when it is ready.</p>}
        {present && <div className="mc-disconnect">{confirmDisconnect ? <><p>Stop email syncing and remove this account’s saved access? Existing conversations will stay in Inbox.</p><Button variant="secondary" disabled={!!busy} onClick={() => act('disconnect')}>Disconnect email</Button> <button disabled={!!busy} onClick={() => setConfirmDisconnect(false)}>Keep connected</button></> : <button disabled={!!busy} onClick={() => setConfirmDisconnect(true)}>Disconnect email</button>}</div>}
      </>}
    </details>
    <section className="mc-last"><Icon name="chat" size={23} /><div><h2>Ready for the next message</h2><p>After connecting, send a test enquiry from another account and check it in Inbox. Review drafts in Outbox before sending.</p><Link className="mc-action" to="/inbox">Open Inbox <span aria-hidden="true">→</span></Link></div></section>
  </main>;
}
