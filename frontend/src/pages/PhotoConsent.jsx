import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import CareNav from '../components/CareNav.jsx';
import ClientLookup from '../components/ClientLookup.jsx';
import PageHeader from '../components/ui/PageHeader.jsx';
import Button from '../components/ui/Button.jsx';
import Icon from '../components/ui/Icon.jsx';

const SCOPES = [
  ['portfolio', 'Portfolio'], ['booking-page', 'Booking page'], ['instagram', 'Instagram'],
  ['tiktok', 'TikTok'], ['facebook', 'Facebook'], ['training', 'Training materials'],
];
const STATUS = {
  granted: ['Granted', 'var(--success)', 'var(--success-bg)'],
  pending: ['Awaiting permission', 'var(--warning)', 'var(--warning-bg)'],
  declined: ['Withdrawn or declined', 'var(--danger)', 'var(--danger-bg)'],
  expired: ['Expired', 'var(--text-muted)', 'var(--bg-subtle)'],
};
const formatDate = value => value ? new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : 'Not recorded';
const fullName = row => `${row.clients?.first_name || ''} ${row.clients?.last_name || ''}`.trim() || row.client_name || 'Client';

export default function PhotoConsent() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const clientId = params.get('clientId') || '';
  const [tab, setTab] = useState('all');
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ client_id: clientId, permitted_uses: [], notes: '' });
  const [saving, setSaving] = useState(false);
  const [revoking, setRevoking] = useState(null);
  const [saveError, setSaveError] = useState('');
  const [notice, setNotice] = useState('');
  const [retry, setRetry] = useState(0);
  const request = async (path, options = {}) => {
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw new Error('Please sign in again.');
    const res = await fetch(`${API_BASE}${path}`, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session.access_token}` } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Could not save this change. Try again.');
    return body;
  };
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError('');
    (async () => {
      try {
        const body = await request('/api/photo-consent', { signal: controller.signal });
        if (!Array.isArray(body.data)) throw new Error('Could not load photo permissions.');
        if (!controller.signal.aborted) setRows(body.data);
      } catch (err) { if (!controller.signal.aborted) setError(err.message); }
      finally { if (!controller.signal.aborted) setBusy(false); }
    })();
    return () => controller.abort();
  }, [retry]);
  useEffect(() => { setForm(f => ({ ...f, client_id: clientId })); }, [clientId]);

  const records = rows.filter(row => !clientId || row.client_id === clientId).map(row => ({
    ...row, status: row.status === 'granted' && row.expires_at && new Date(row.expires_at).getTime() < Date.now() ? 'expired' : row.status,
  }));
  const filtered = records.filter(row => tab === 'all' || row.status === tab);
  const openClient = id => navigate('/clients', { state: { clientId: id } });
  async function save(event) {
    event.preventDefault();
    if (saving || !form.client_id || !form.permitted_uses.length) return;
    setSaving(true); setSaveError(''); setNotice('');
    try {
      const body = await request('/api/photo-consent', { method: 'POST', body: JSON.stringify(form) });
      if (!body.data?.id) throw new Error('The request could not be saved. Try again.');
      setRows(current => [body.data, ...current]);
      setShowForm(false); setForm({ client_id: clientId, permitted_uses: [], notes: '' });
      setNotice('Request recorded. No message has been sent and permission is still outstanding.');
    } catch (err) { setSaveError(err.message); }
    finally { setSaving(false); }
  }
  async function revoke(row) {
    if (!confirm(`Record that ${fullName(row)} has withdrawn photo permission?`)) return;
    setRevoking(row.id); setNotice(''); setSaveError('');
    try {
      const body = await request(`/api/photo-consent/${row.id}/revoke`, { method: 'PATCH', body: JSON.stringify({ notes: 'Consent withdrawn by client' }) });
      if (!body.data?.id) throw new Error('The withdrawal could not be saved. Try again.');
      setRows(current => current.map(item => item.id === row.id ? { ...item, ...body.data } : item));
      setNotice(`Photo permission withdrawn for ${fullName(row)}.`);
    } catch (err) { setSaveError(err.message); }
    finally { setRevoking(null); }
  }

  return <div style={S.page}>
    <CareNav />
    <PageHeader title="Photo consent" subtitle="Keep the permission and its scope together" />
    <section style={S.intro}><Icon name="camera" size={24} color="var(--accent)" /><div><h2 style={S.heading}>Permission, before publishing</h2><p style={S.body}>Review what each client has agreed to and record any withdrawal. An outstanding request is not permission to use their photos.</p></div></section>
    <div style={S.actions}><Button onClick={() => { setShowForm(open => !open); setSaveError(''); }}>{showForm ? 'Close request' : 'Record a request'}</Button><Button variant="secondary" onClick={() => navigate('/compliance?tab=records')}>Client records</Button></div>
    {clientId && <div style={S.context}><span>Showing one client</span><Button variant="quiet" onClick={() => openClient(clientId)}>Client profile</Button><Button variant="quiet" onClick={() => setParams({})}>Show everyone</Button></div>}
    {notice && <p role="status" style={S.notice}>{notice}</p>}
    {saveError && <p role="alert" style={S.error}>{saveError}</p>}

    {showForm && <form onSubmit={save} style={S.card}>
      <h2 style={S.heading}>Record an outstanding request</h2><p style={{ ...S.body, margin: '8px 0 18px' }}>This saves a note for follow-up. To collect a client’s signature, send a consultation form from their profile.</p>
      <ClientLookup value={form.client_id} onChange={client => setForm(f => ({ ...f, client_id: client.id }))} />
      <fieldset disabled={saving} style={S.fieldset}><legend style={S.label}>Where are you asking to use the photos?</legend><div style={S.scopes}>
        {SCOPES.map(([value, label]) => <label key={value} style={S.option}><input type="checkbox" checked={form.permitted_uses.includes(value)} onChange={event => setForm(f => ({ ...f, permitted_uses: event.target.checked ? [...f.permitted_uses, value] : f.permitted_uses.filter(item => item !== value) }))} style={{ width: 18, height: 18, accentColor: 'var(--accent)' }} />{label}</label>)}
      </div></fieldset>
      <label htmlFor="photo-notes" style={S.label}>Your notes</label><textarea id="photo-notes" rows={3} value={form.notes} onChange={event => setForm(f => ({ ...f, notes: event.target.value }))} style={S.input} placeholder="What you asked and anything to follow up" />
      <div style={S.actions}><Button type="submit" disabled={saving || !form.client_id || !form.permitted_uses.length} loading={saving}>{saving ? 'Saving…' : 'Save request record'}</Button><Button variant="quiet" disabled={saving} onClick={() => setShowForm(false)}>Cancel</Button></div>
    </form>}

    <nav aria-label="Photo permission status" style={S.tabs}>
      {[['all', 'All records'], ['granted', 'Granted'], ['pending', 'Outstanding'], ['expired', 'Expired'], ['declined', 'Withdrawn / declined']].map(([key, label]) => <Button key={key} variant={tab === key ? 'primary' : 'chip'} aria-pressed={tab === key} onClick={() => setTab(key)} style={{ whiteSpace: 'normal' }}>{label}{!busy && !error ? ` (${key === 'all' ? records.length : records.filter(row => row.status === key).length})` : ''}</Button>)}
    </nav>
    {busy ? <p role="status">Loading photo permissions…</p> : error ? <div role="alert" style={S.error}><p>{error}</p><Button variant="secondary" onClick={() => setRetry(n => n + 1)}>Try again</Button></div> : filtered.length ? <div style={{ display: 'grid', gap: 12 }}>
      {filtered.map(row => {
        const [label, color, background] = STATUS[row.status] || ['Status unknown', 'var(--text-muted)', 'var(--bg-subtle)'];
        const open = expanded === row.id;
        return <article key={row.id} style={S.card}>
          <Button variant="quiet" aria-expanded={open} onClick={() => setExpanded(open ? null : row.id)} style={S.cardButton}>
            <span style={{ minWidth: 0 }}><strong style={{ fontSize: 16, display: 'block' }}>{fullName(row)}</strong><span style={S.detail}>{row.granted_at ? `Granted ${formatDate(row.granted_at)}` : `Recorded ${formatDate(row.created_at)}`}</span></span>
            <span style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}><span style={{ ...S.badge, color, background }}>{label}</span><Icon name={open ? 'chevron-up' : 'chevron-down'} size={18} /></span>
          </Button>
          <p style={S.detail}>{row.status === 'pending' ? 'Requested uses' : 'Recorded scope'}: {(row.permitted_uses || []).map(value => SCOPES.find(([key]) => key === value)?.[1] || value).join(', ') || 'None on record'}</p>
          {open && <div style={S.expanded}>
            {row.notes && <p style={{ ...S.body, whiteSpace: 'pre-wrap' }}>{row.notes}</p>}
            {row.status === 'granted' && row.expires_at && <p style={S.detail}>Permission expires {formatDate(row.expires_at)}</p>}
            {row.status === 'pending' && <p style={S.body}>This record does not contain a client’s acceptance. Open their profile to check any signed consultation forms.</p>}
            <div style={S.actions}><Button variant="secondary" onClick={() => openClient(row.client_id)}>Client profile & forms</Button>
              {row.status === 'granted' && <Button variant="danger" disabled={revoking === row.id} onClick={() => revoke(row)}>{revoking === row.id ? 'Saving…' : 'Record withdrawal'}</Button>}
            </div>
          </div>}
        </article>;
      })}
    </div> : <section style={S.card}><h2 style={S.heading}>No {tab === 'all' ? 'photo permission records' : 'records in this view'}</h2><p style={S.body}>Saved requests and granted permissions appear here. Use a client’s consultation form to collect their signed answers.</p></section>}
    <p style={{ ...S.detail, marginTop: 22 }}>Use photos only within the permission the client gave. Review the original signed record if the scope is unclear.</p>
  </div>;
}
const S = {
  page: { padding: '20px 20px var(--scroll-pad-bottom)', maxWidth: 820, margin: '0 auto', color: 'var(--text-primary)', fontFamily: 'var(--font-body)' },
  intro: { display: 'flex', gap: 16, padding: 24, background: 'linear-gradient(120deg,#F4E2E8,#FFFCF9)', border: '1px solid #E6CCD5', borderRadius: 22, marginBottom: 18 },
  heading: { fontSize: 23, fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)", fontWeight: 500, margin: '0 0 8px' },
  body: { fontSize: 13, lineHeight: 1.7, color: 'var(--text-secondary)', margin: 0 },
  actions: { display: 'flex', flexWrap: 'wrap', gap: 8, margin: '16px 0' },
  context: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, fontSize: 13 },
  notice: { background: 'var(--success-bg)', color: 'var(--success)', padding: 16, borderRadius: 14, fontSize: 13, lineHeight: 1.6 },
  error: { background: 'var(--danger-bg)', color: 'var(--danger)', padding: 16, borderRadius: 14, fontSize: 13 },
  card: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 20, padding: 20 },
  cardButton: { width: '100%', padding: 0, justifyContent: 'space-between', textAlign: 'left', whiteSpace: 'normal', gap: 12, color: 'var(--text-primary)' },
  badge: { padding: '5px 9px', borderRadius: 8, fontSize: 11, lineHeight: 1.5 },
  detail: { display: 'block', fontSize: 12, lineHeight: 1.6, color: 'var(--text-muted)', margin: '5px 0 0' },
  tabs: { display: 'flex', flexWrap: 'wrap', gap: 6, margin: '24px 0 16px' },
  fieldset: { border: 0, padding: 0, margin: '20px 0' },
  label: { display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 10 },
  scopes: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 6 },
  option: { display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, fontSize: 13, cursor: 'pointer' },
  input: { width: '100%', boxSizing: 'border-box', padding: 12, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)', font: 'inherit', fontSize: 14 },
  expanded: { marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' },
};
