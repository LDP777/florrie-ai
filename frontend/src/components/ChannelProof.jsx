import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { readAuthenticatedJson } from '../lib/authenticated-json.js';
import { API_BASE } from '../lib/config.js';
import Button from './ui/Button.jsx';

const fresh = value => value && /^FLORRIE-[A-F0-9]{12}$/.test(value.code)
  && Number.isFinite(Date.parse(value.since)) && Date.parse(value.since) <= Date.now()
  && Date.now() - Date.parse(value.since) < 86400000;
export default function ChannelProof({ ownerId, channel, auth }) {
  const key = `florrie-channel-check:${ownerId}:${channel}`;
  const [challenge, setChallenge] = useState(() => {
    try { const saved = JSON.parse(localStorage.getItem(key)); return fresh(saved) ? saved : null; } catch { return null; }
  });
  const [result, setResult] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [copied, setCopied] = useState(false);
  const alive = useRef(true), generation = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  function start() {
    generation.current++;
    const value = { code: `FLORRIE-${Array.from(crypto.getRandomValues(new Uint8Array(6)), n => n.toString(16).padStart(2, '0')).join('').toUpperCase()}`, since: new Date().toISOString() };
    setChallenge(value); setResult(null); setError(''); setCopied(false); setBusy(false);
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Still works until this page closes. */ }
  }
  async function check() {
    if (busy) return;
    if (!fresh(challenge)) { setError('This check expired. Start a new check.'); return; }
    const run = ++generation.current;
    setBusy(true); setError(''); setResult(null);
    try {
      const data = await readAuthenticatedJson({ auth, url: `${API_BASE}/api/setup/channel-proof?${new URLSearchParams({ channel, ...challenge })}` });
      if (typeof data.received !== 'boolean') throw new Error('Could not check Inbox. Try again.');
      if (alive.current && run === generation.current) setResult(data);
    } catch (e) { if (alive.current && run === generation.current) setError(e.message); }
    finally { if (alive.current && run === generation.current) setBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(challenge.code); setCopied(true); }
    catch { setError('Copy the message below, then send it from another account.'); }
  }
  return <div className="mc-proof">
    <h3>Check an enquiry</h3>
    {!challenge ? <><p className="mc-detail">Prove that a message from another account reaches this salon’s Inbox.</p><Button variant="secondary" onClick={start}>Start {channel === 'instagram' ? 'Instagram' : 'WhatsApp'} check</Button></> : <>
      <p className="mc-detail">From another {channel === 'instagram' ? 'Instagram account' : 'WhatsApp number'}, send only this message to your connected salon account. This check lasts 24 hours.</p>
      <code style={{ display: 'block', overflowWrap: 'anywhere', padding: '12px 0', fontSize: 14 }}>{challenge.code}</code>
      <div className="mc-actions"><Button variant="quiet" onClick={copy}>{copied ? 'Copied' : 'Copy test message'}</Button><Button variant="secondary" onClick={check} disabled={busy}>{busy ? 'Checking Inbox…' : 'Check it arrived'}</Button></div>
      {result && <p role="status" className="mc-note">{result.received ? 'Test enquiry received in this salon’s Inbox. Open the conversation to check it.' : 'We haven’t received this test message yet. Check the account you sent it to, allow a moment, then try again.'}</p>}
      {result?.received && <Link className="mc-action" to="/inbox">Open Inbox →</Link>}
      {error && <p role="alert" className="mc-alert">{error}</p>}
      <Button variant="quiet" onClick={start}>Start a new check</Button>
    </>}
  </div>;
}
