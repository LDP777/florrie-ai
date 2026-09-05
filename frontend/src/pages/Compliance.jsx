import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useBeautician, supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import Button from '../components/ui/Button.jsx';
import Icon from '../components/ui/Icon.jsx';
import ClientLookup from '../components/ClientLookup.jsx';

const REASONS = {
  never_been_in: 'No previous visits or patch test on record',
  been_in_but_nothing_on_record: 'Returning client, with no patch test written down',
  booked_not_attended: 'Patch test booked, but not recorded as done',
  reaction_on_record: 'A reaction is noted on the last patch test',
  could_not_check: 'The record could not be checked. Review it before deciding.',
};
const dateLabel = date => date ? new Date(`${date.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : 'Date to confirm';

export default function Compliance() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = ['records', 'templates'].includes(params.get('tab')) ? params.get('tab') : 'checks';
  const { beautician, loading } = useBeautician();
  const [checks, setChecks] = useState({ loading: true });
  const [forms, setForms] = useState({ loading: true });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (loading) return;
    if (!beautician) { setChecks({ error: 'Sign in to load client checks.' }); setForms({ error: 'Sign in to load forms.' }); return; }
    const controller = new AbortController();
    const load = async (path, setState, field) => {
      setState({ loading: true });
      try {
        const { data } = await supabase.auth.getSession();
        if (!data.session) throw new Error('Please sign in again.');
        const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${data.session.access_token}` }, signal: controller.signal });
        if (!res.ok) throw new Error('This information could not be loaded.');
        const body = await res.json();
        if (!Array.isArray(body[field])) throw new Error('This information could not be loaded.');
        if (!controller.signal.aborted) setState({ rows: body[field], until: body.checkedUntil });
      } catch (err) { if (!controller.signal.aborted) setState({ error: err.message }); }
    };
    void load('/api/appointments/patch-test-alerts?days=21', setChecks, 'alerts');
    void load('/api/consultation-forms', setForms, 'forms');
    return () => controller.abort();
  }, [beautician?.id, loading, retry]);
  const openClient = id => navigate('/clients', { state: { clientId: id } });
  const renderError = message => <div role="alert" style={S.error}><p>{message}</p><Button variant="secondary" onClick={() => setRetry(n => n + 1)}>Try again</Button></div>;

  return <div className="care-hub" style={S.page}>
    <style>{`
      .care-hub__hero { display:grid; grid-template-columns:1.6fr 1fr; gap:28px; }

      .care-hub__queue { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
      .care-hub a:focus-visible { outline:3px solid var(--accent); outline-offset:3px; }
      @media(max-width:650px) { .care-hub__hero,.care-hub__queue { grid-template-columns:1fr; } .care-hub__hero { gap:16px; } .care-hub__summary { display:grid!important; grid-template-columns:auto 1fr; gap:6px 12px!important; padding:14px!important; } .care-hub__summary>span:first-child { grid-column:1/-1; } .care-hub__summary>span:last-child { grid-column:1/-1; } .care-hub__summary>strong { grid-row:2; } }
    `}</style>
    <header className="care-hub__hero" style={S.hero}>
      <div><span style={S.eyebrow}><Icon name="shield" size={16} inline /> Guardian · Client care</span>
        <h1 style={S.title}>Client checks</h1>
        <p style={S.description}>Review patch tests, find signed consultations and check photo permissions.</p>
      </div>
      <div className="care-hub__summary" style={S.heroAside}><span style={S.eyebrow}>Before their next visit</span>
        <strong style={S.figure}>{checks.loading ? '…' : checks.error ? 'Unavailable' : checks.rows.length}</strong>
        <span style={S.description}>{checks.error ? 'Try loading the checks again below.' : 'clients to review for patch-test evidence in the next 21 days'}</span>
        <span style={S.note}>Review the evidence before deciding what to do.</span>
      </div>
    </header>
    <nav aria-label="Client check views" style={S.tabs}>
      {[['checks', 'Upcoming checks'], ['records', 'Client records'], ['templates', 'Form templates']].map(([key, label]) =>
        <Button key={key} variant={tab === key ? 'primary' : 'quiet'} aria-pressed={tab === key} onClick={() => setParams(key === 'checks' ? {} : { tab: key })} style={{ whiteSpace: 'normal', minWidth: 0, flex: '1 1 0', fontSize: 12, padding: '8px 5px' }}>{label}</Button>)}
    </nav>
    {tab === 'checks' && <section aria-label="Upcoming patch-test checks">
      <div style={S.sectionHeader}><div><h2 style={S.heading}>Give these a look</h2><p style={S.description}>{checks.until ? `Bookings through ${dateLabel(checks.until)}.` : 'Upcoming bookings that need their patch-test record reviewed.'}</p></div><Link to="/patch-tests" style={S.textLink}>All patch tests <Icon name="arrow-right" size={16} inline /></Link></div>
      {checks.loading ? <p role="status">Loading upcoming checks…</p> : checks.error ? renderError(checks.error) : checks.rows.length ? <div className="care-hub__queue">
        {checks.rows.map(client => <article key={`${client.client_id}-${client.appointment_id}`} style={S.card}>
          <div style={S.cardTop}><span style={S.avatar}>{client.client_name?.slice(0, 1) || 'C'}</span><div style={{ minWidth: 0 }}><h3 style={S.client}>{client.client_name}</h3><p style={S.note}>{client.treatment || 'Upcoming treatment'} · {dateLabel(client.appointment_date)}</p></div></div>
          <p style={{ ...S.description, margin: '14px 0' }}>{REASONS[client.reason] || 'Review the patch-test evidence for this booking.'}</p>
          <div style={S.actions}><Button variant="secondary" onClick={() => openClient(client.client_id)}>Client record</Button><Button variant="tonal" onClick={() => navigate(`/patch-tests?clientId=${encodeURIComponent(client.client_id)}&log=1`)}>Record a test</Button></div>
        </article>)}
      </div> : <div style={S.empty}><Icon name="check-circle" size={26} color="var(--success)" /><h3 style={S.client}>No patch-test checks in this window</h3><p style={S.description}>You can still review a client’s records or record a test below.</p><Button variant="secondary" onClick={() => setParams({ tab: 'records' })}>Find a client</Button></div>}
      <aside style={S.footnote}><Icon name="file" size={20} /><div><strong>Looking for a completed consultation?</strong><p style={{ ...S.description, margin: '5px 0 0' }}>Open Client records and choose the person. Their answers, signature and outstanding forms are together in their profile.</p></div></aside>
    </section>}
    {tab === 'records' && <section style={S.card}><h2 style={S.heading}>Find the person, then the paperwork</h2><p style={{ ...S.description, margin: '8px 0 20px' }}>Open a client to read submitted consultations, check requests or send a form. Patch tests and photo consent are linked from the same profile.</p><ClientLookup onChange={client => openClient(client.id)} /></section>}
    {tab === 'templates' && <section><div style={S.sectionHeader}><div><h2 style={S.heading}>The questions you ask</h2><p style={S.description}>Reusable templates. Completed answers live in Client records.</p></div><Link to="/consultation-forms/new" className="fl-btn fl-btn--primary fl-btn--md" style={{ textDecoration: 'none' }}>New form</Link></div>
      {forms.loading ? <p role="status">Loading templates…</p> : forms.error ? renderError(forms.error) : forms.rows.length ? <div className="care-hub__queue">{forms.rows.map(form => <Link key={form.id} to={`/consultation-forms/${form.id}`} style={S.shortcut}><Icon name="file" size={22} /><span style={{ flex: 1 }}><strong>{form.name}</strong><span style={S.note}>{form.is_default ? 'Default consultation template' : 'Consultation template'}</span></span><Icon name="chevron-right" size={18} /></Link>)}</div> : <div style={S.empty}><h3 style={S.client}>Start with your first form</h3><p style={S.description}>Create a template, then choose it from a client’s profile to send it.</p><Button onClick={() => navigate('/consultation-forms/new')}>Create a form</Button></div>}
    </section>}
    <div style={{ ...S.actions, marginTop: 24 }}><Link to="/patch-tests" className="fl-btn fl-btn--secondary fl-btn--md" style={{ textDecoration: 'none' }}>All patch-test records</Link><Link to="/photo-consent" className="fl-btn fl-btn--quiet fl-btn--md" style={{ textDecoration: 'none' }}>Photo consent</Link></div>
  </div>;
}
const S = {
  page: { maxWidth: 1040, margin: '0 auto', padding: '20px 20px var(--scroll-pad-bottom)', color: 'var(--text-primary)', fontFamily: 'var(--font-body)' },
  hero: { padding: 'clamp(20px,4vw,36px)', background: 'linear-gradient(120deg,#F4E2E8,#FFFCF9)', border: '1px solid #E6CCD5', borderRadius: 28 },
  eyebrow: { fontSize: 11, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--accent)', display: 'block' },
  title: { fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)", fontSize: 'clamp(34px,5vw,46px)', fontWeight: 500, margin: '14px 0 10px', lineHeight: 1.1 },
  intro: { fontSize: 19, lineHeight: 1.5, margin: '0 0 12px', fontWeight: 500 },
  description: { fontSize: 13, lineHeight: 1.65, color: 'var(--text-secondary)', margin: 0 },
  heroAside: { alignSelf: 'stretch', borderRadius: 20, background: 'rgba(255,252,249,.8)', padding: 22, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'flex-start', gap: 10 },
  figure: { fontSize: 'clamp(28px,5vw,48px)', lineHeight: 1, fontWeight: 600, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' },
  note: { fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, display: 'block', margin: '4px 0 0' },
  shortcut: { display: 'flex', alignItems: 'center', gap: 12, padding: 18, textDecoration: 'none', color: 'var(--text-primary)', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 18 },
  tabs: { display: 'flex', flexWrap: 'wrap', gap: 5, padding: 5, background: 'var(--bg-subtle)', borderRadius: 18, marginTop: 20, marginBottom: 26 },
  heading: { fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)", fontWeight: 500, fontSize: 25, margin: 0 },
  sectionHeader: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 16, marginBottom: 18 },
  textLink: { fontSize: 13, fontWeight: 600, color: 'var(--accent)', padding: '12px 0' },
  card: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 20, padding: 20 },
  cardTop: { display: 'flex', alignItems: 'center', gap: 12 },
  avatar: { width: 42, height: 42, flexShrink: 0, display: 'grid', placeItems: 'center', borderRadius: 15, background: 'var(--accent-light)', color: 'var(--accent)', fontWeight: 700 },
  client: { fontSize: 16, fontWeight: 700, margin: 0, overflowWrap: 'anywhere' },
  actions: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  error: { background: 'var(--danger-bg)', color: 'var(--danger)', padding: 20, borderRadius: 18 },
  empty: { display: 'grid', justifyItems: 'start', gap: 12, padding: 26, border: '1px solid var(--border)', borderRadius: 20, background: 'var(--bg-card)' },
  footnote: { display: 'flex', gap: 12, padding: '22px 4px', marginTop: 14, fontSize: 13, color: 'var(--text-secondary)' },
};
