import { useEffect, useId, useState } from 'react';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import Button from './ui/Button.jsx';
import Icon from './ui/Icon.jsx';

export const clientName = client => `${client?.first_name || ''} ${client?.last_name || ''}`.trim() || 'Client';

// Search the server instead of silently limiting selection to the first page.
export default function ClientLookup({ value = '', onChange, label = 'Find a client' }) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState([]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState(null);
  const [choosing, setChoosing] = useState(!value);
  useEffect(() => { if (!value) { setSelected(null); setChoosing(true); } }, [value]);
  useEffect(() => {
    if (!value || selected?.id === value) return;
    const controller = new AbortController();
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (!data.session) throw new Error('Sign in again to load clients.');
        const res = await fetch(`${API_BASE}/api/clients/${encodeURIComponent(value)}`, { headers: { Authorization: `Bearer ${data.session.access_token}` }, signal: controller.signal });
        if (!res.ok) throw new Error('Could not load the selected client. Choose them again.');
        const body = await res.json();
        if (!body.client?.id) throw new Error('Please choose a client.');
        if (!controller.signal.aborted) { setSelected(body.client); setChoosing(false); setError(''); }
      } catch (err) { if (!controller.signal.aborted) { setError(err.message); setChoosing(true); } }
    })();
    return () => controller.abort();
  }, [value, retry]);
  useEffect(() => {
    if (!choosing) return;
    const controller = new AbortController();
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (!data.session) throw new Error('Sign in again to load clients.');
        const params = new URLSearchParams({ search: query.trim(), page: String(page), per_page: '8' });
        const res = await fetch(`${API_BASE}/api/clients?${params}`, { headers: { Authorization: `Bearer ${data.session.access_token}` }, signal: controller.signal });
        if (!res.ok) throw new Error('Could not load clients. Try again.');
        const body = await res.json();
        if (!Array.isArray(body.data)) throw new Error('Could not load clients. Try again.');
        if (!controller.signal.aborted) {
          setRows(body.data);
          setMore(body.pagination?.has_next ?? page < (body.pagination?.total_pages || 1));
          setError('');
        }
      } catch (err) { if (!controller.signal.aborted) { setError(err.message); setRows([]); } }
      finally { if (!controller.signal.aborted) setBusy(false); }
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, page, choosing, retry]);
  return <div style={{ minWidth: 0 }}>
    {selected && !choosing ? <div style={S.selected}>
      <div><span style={S.label}>Selected client</span><strong>{clientName(selected)}</strong></div>
      <Button variant="quiet" onClick={() => setChoosing(true)}>Change</Button>
    </div> : <>
      <label htmlFor={id} style={S.label}>{label}</label>
      <div style={S.search}><Icon name="search" size={18} /><input id={id} type="search" value={query} placeholder="Name or email" autoComplete="off" onChange={event => { setQuery(event.target.value); setPage(1); }} style={S.input} /></div>
      {error ? <div role="alert" style={S.message}>{error} <Button size="sm" variant="secondary" onClick={() => setRetry(n => n + 1)}>Retry</Button></div>
        : busy ? <p role="status" style={S.message}>Finding clients…</p>
          : <>
            <div aria-label="Client results" style={{ display: 'grid', gap: 4 }}>
              {rows.map(client => <Button key={client.id} variant="quiet" onClick={() => { setSelected(client); setChoosing(false); onChange(client); }} style={S.result}>
                <span style={{ minWidth: 0 }}><strong style={{ display: 'block' }}>{clientName(client)}</strong><span style={S.detail}>{client.email || client.phone || 'Open client record'}</span></span><Icon name="chevron-right" size={18} />
              </Button>)}
              {!rows.length && <p style={S.message}>No clients match this search.</p>}
            </div>
            {(page > 1 || more) && <div style={S.paging}><Button variant="secondary" size="sm" disabled={page === 1} onClick={() => setPage(n => n - 1)}>Previous</Button><span style={S.detail}>Page {page}</span><Button variant="secondary" size="sm" disabled={!more} onClick={() => setPage(n => n + 1)}>Next</Button></div>}
          </>}
    </>}
  </div>;
}
const S = {
  label: { display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 8 },
  search: { display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--border)', borderRadius: 14, padding: '0 12px', background: 'var(--bg-card)', marginBottom: 8 },
  input: { minWidth: 0, width: '100%', minHeight: 48, border: 0, background: 'transparent', color: 'var(--text-primary)', font: 'inherit', fontSize: 14 },
  selected: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: 12, background: 'var(--accent-light)', borderRadius: 12 },
  result: { width: '100%', justifyContent: 'space-between', textAlign: 'left', padding: '12px 10px', whiteSpace: 'normal', height: 'auto', gap: 10, color: 'var(--text-primary)' },
  detail: { display: 'block', fontSize: 12, fontWeight: 400, color: 'var(--text-muted)', overflowWrap: 'anywhere', marginTop: 3 },
  message: { fontSize: 13, color: 'var(--text-secondary)', padding: '8px 0', lineHeight: 1.5 },
  paging: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 10 },
};
