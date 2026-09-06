import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import Button from './ui/Button.jsx';

export default function AccountDeletionProgress({ initial = null }) {
  const [deletion, setDeletion] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function read(retry = false) {
    setBusy(true); setError('');
    try {
      let statusToken;
      try { statusToken = localStorage.getItem('florrie_deletion_status_token'); } catch { /* use session */ }
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const useStatusToken = statusToken && !retry;
      const response = await fetch(`${API_BASE}/api/auth/account${useStatusToken ? '/deletion-status' : ''}`, {
        method: retry ? 'DELETE' : 'GET',
        headers: { 'Content-Type':'application/json', ...(useStatusToken ? { 'X-Deletion-Token':statusToken } : token ? { Authorization:`Bearer ${token}` } : {}) },
        ...(retry ? { body: JSON.stringify({ confirm:'DELETE' }) } : {}),
      });
      const body = await response.json();
      if (!response.ok || !body.deletion) throw new Error('Could not read deletion progress. Try again or contact hello@florrie.ai.');
      if (body.deletion.status_token) {
        try { localStorage.setItem('florrie_deletion_status_token',body.deletion.status_token); } catch { /* session status still works */ }
      }
      setDeletion(body.deletion);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  useEffect(() => { read(); }, []);
  return <main style={{ maxWidth:480, margin:'0 auto', padding:'calc(32px + env(safe-area-inset-top)) 20px calc(32px + env(safe-area-inset-bottom))', color:'var(--text-primary)', fontFamily:'var(--font-body)' }}>
    <h1 style={{ fontFamily:'var(--font-display)', fontSize:28 }}>{deletion?.completed ? 'Account deleted' : 'Account deletion'}</h1>
    <p>{deletion?.message || 'Checking your saved deletion request…'}</p>
    {deletion && <p style={{ overflowWrap:'anywhere', fontSize:13 }}>Reference: {deletion.id}</p>}
    {deletion && !deletion.completed && <p>Cleanup continues in the background. Until it is complete, any unfinished billing or provider step remains open. You can check progress here or contact support.</p>}
    {deletion?.completed && <p>Limited payment-provider records and backups may remain under their retention policies. This confirmation covers the account cleanup steps recorded by Florrie.</p>}
    {error && <p role="alert">{error}</p>}
    <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
      {!deletion?.completed && <Button disabled={busy} onClick={() => read()}>{busy ? 'Checking…' : 'Check progress'}</Button>}
      {deletion && !deletion.completed && <Button variant="quiet" disabled={busy} onClick={() => read(true)}>Retry cleanup</Button>}
      <Button variant="quiet" onClick={async () => { await supabase.auth.signOut(); window.location.assign('/login'); }}>Sign out</Button>
    </div>
  </main>;
}
