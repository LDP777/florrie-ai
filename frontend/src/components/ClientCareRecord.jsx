import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import { readAuthenticatedJson } from '../lib/authenticated-json.js';
import Button from './ui/Button.jsx';

export default function ClientCareRecord({ clientId, data }) {
  const navigate = useNavigate();
  const [record, setRecord] = useState(data);
  const [busy, setBusy] = useState(data === undefined);
  const [error, setError] = useState(data === null ? 'Could not load consultation records.' : null);
  const [notice, setNotice] = useState(null);
  const [selectedForm, setSelectedForm] = useState('');
  const [signatures, setSignatures] = useState({});
  const [signatureErrors, setSignatureErrors] = useState({});
  const read = path => readAuthenticatedJson({ auth: supabase.auth, url: `${API_BASE}${path}` });
  const readRecords = async () => {
    const body = await read(`/api/consultation-forms/responses/list?client_id=${encodeURIComponent(clientId)}`);
    if (!Array.isArray(body?.responses) || !Array.isArray(body?.requests) || !Array.isArray(body?.templates)) throw new Error('Could not load consultation records.');
    return body;
  };
  useEffect(() => {
    let cancelled = false;
    setRecord(data); setSelectedForm(''); setSignatures({}); setSignatureErrors({}); setNotice(null);
    setError(data === null ? 'Could not load consultation records.' : null);
    setBusy(data === undefined);
    if (data === undefined && clientId) {
      readRecords().then(body => { if (!cancelled) setRecord(body); })
        .catch(() => { if (!cancelled) setError('Could not load consultation records.'); })
        .finally(() => { if (!cancelled) setBusy(false); });
    }
    return () => { cancelled = true; };
  }, [clientId, data]);
  const dateLabel = value => value ? new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Date unavailable';
  async function refresh() {
    setBusy(true); setError(null);
    try {
      setRecord(await readRecords());
    } catch (err) { setError(err.message || 'Could not load consultation records.'); }
    finally { setBusy(false); }
  }
  const templates = record?.templates || [];
  const formId = selectedForm || templates.find(t => t.is_default)?.id || templates[0]?.id || '';
  const pending = (record?.requests || []).some(r => r.form_id === formId && r.status === 'pending');
  async function send() {
    setBusy(true); setNotice(null); setError(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData?.session?.access_token) throw new Error('Sign in again before sending a form.');
      const res = await fetch(`${API_BASE}/api/consultation-forms/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionData.session.access_token}` },
        body: JSON.stringify({ client_id: clientId, form_id: formId }),
      });
      const result = await res.json();
      if (!res.ok || !result.sent) throw new Error(result.error || 'Could not send the form.');
      setNotice('The text service accepted the form link.');
      await refresh();
    } catch (err) { setError(err.message || 'Could not send the form.'); }
    finally { setBusy(false); }
  }
  async function loadSignature(id) {
    setSignatureErrors(prev => ({ ...prev, [id]: null }));
    try {
      const body = await read(`/api/consultation-forms/responses/${id}`);
      if (!body.response?.signature_data) throw new Error();
      setSignatures(prev => ({ ...prev, [id]: body.response.signature_data }));
    } catch { setSignatureErrors(prev => ({ ...prev, [id]: 'Could not load the signature. Try again.' })); }
  }
  return (
    <section style={styles.paymentsCard} aria-label="Client care records">
      <h4 style={{ ...styles.sectionLabel, margin: '0 0 12px' }}>Client care</h4>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
        <Button variant="secondary" onClick={() => navigate(`/patch-tests?clientId=${encodeURIComponent(clientId)}`)}>Patch tests</Button>
        <Button variant="secondary" onClick={() => navigate(`/photo-consent?clientId=${encodeURIComponent(clientId)}`)}>Photo consent</Button>
      </div>
      <h4 style={{ margin: '0 0 6px' }}>Consultation forms</h4>
      <p style={styles.consultDate}>Read submitted answers, check requests and send a new form.</p>
      {error && <div role="alert"><p>{error}</p><Button disabled={busy} onClick={refresh}>Retry records</Button></div>}
      {notice && <p role="status" style={styles.consultSendResult}>{notice}</p>}
      {busy && !record && <p role="status">Loading consultation records…</p>}
      {record && !error && <>
        {!record.responses?.length && <p style={styles.noHistory}>No submitted answers available.</p>}
        {(record.responses || []).map(r => <details key={r.id} style={styles.consultSubmission}>
          <summary style={{ cursor: 'pointer', padding: '12px 0', minHeight: 44, boxSizing: 'border-box' }}>
            <strong>{r.form_name}</strong><span style={{ display: 'block', marginTop: 4 }}>{dateLabel(r.completed_at)} · {r.has_signature ? 'Signed' : 'No signature recorded'}</span>
            {!!r.worth_knowing?.length && <span style={styles.worthKnowingChip}>{r.worth_knowing.length} {r.worth_knowing.length === 1 ? 'answer' : 'answers'} to review</span>}
          </summary>
          {(r.worth_knowing || []).map((note, i) => <p key={i} style={styles.worthKnowingNote}>{note}</p>)}
          {!r.pairs?.length && <p>No answers recorded.</p>}
          {(r.pairs || []).filter(p => p.type !== 'signature').map(pair => <div key={pair.field_id} style={styles.consultPair}>
            <span style={styles.consultQuestion}>{pair.question}</span>
            <span style={{ ...styles.consultAnswer, overflowWrap: 'anywhere' }}>{pair.answered ? pair.answer : 'Not answered'}</span>
          </div>)}
          {r.consent_text && <div style={styles.consultConsent}><strong>Consent wording</strong><p style={{ whiteSpace: 'pre-wrap' }}>{r.consent_text}</p></div>}
          {r.has_signature && (signatures[r.id] ? <img src={signatures[r.id]} alt="Client signature" style={styles.consultSignature} /> : <Button onClick={() => loadSignature(r.id)}>View signature</Button>)}
          {signatureErrors[r.id] && <p role="alert">{signatureErrors[r.id]}</p>}
        </details>)}
        {!!record.requests?.length && <div style={{ marginTop: 18 }}><h5 style={{ margin: '0 0 8px' }}>Requests</h5>
          {record.requests.map(r => <div key={r.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border-light)' }}>
            <strong>{r.form_name}</strong><p style={{ ...styles.consultDate, margin: '4px 0' }}>{r.status === 'answers_removed' ? 'Answers no longer held' : r.status === 'expired' ? 'Link expired' : 'Awaiting response'} · Requested {dateLabel(r.sent_at)}{r.expires_at ? ` · Link expires ${dateLabel(r.expires_at)}` : ''}</p>
          </div>)}
        </div>}
        <div style={{ marginTop: 18 }}>
          {!!templates.length && <><label htmlFor={`consultation-template-${clientId}`} style={{ display: 'block', marginBottom: 6 }}>Send a form</label>
            <select id={`consultation-template-${clientId}`} value={formId} onChange={e => setSelectedForm(e.target.value)} style={{ width: '100%', minHeight: 44, padding: 10, borderRadius: 10, marginBottom: 8, background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-light)' }}>
              {templates.map(t => <option key={t.id} value={t.id}>{t.name}{t.is_default ? ' (default)' : ''}</option>)}
            </select>
            <Button fullWidth disabled={busy || !formId || pending} onClick={send}>{busy ? 'Working…' : pending ? 'Already awaiting a response' : 'Send form by text'}</Button></>}
          <Button variant="quiet" style={{ ...styles.consultLinkBtn, marginTop: 12, minHeight: 44 }} onClick={() => navigate('/consultation-forms')}>{templates.length ? 'Manage blank templates' : 'Create a form template'}</Button>
        </div>
      </>}
    </section>
  );
}

const styles = {
  paymentsCard: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 20, padding: 20, marginBottom: 12 },
  sectionLabel: { fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' },
  noHistory: { color: 'var(--text-secondary)', fontSize: 14 },
  consultHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
    width: '100%', minHeight: 44, padding: 0, background: 'none', border: 'none',
    cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
  },
  consultChevron: { fontSize: 10, color: 'var(--text-muted)' },
  consultDate: { fontSize: 12, color: 'var(--text-muted)' },
  consultFormName: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' },
  worthKnowingChip: {
    display: 'inline-block', fontSize: 11, fontWeight: 700, letterSpacing: '0.02em',
    color: '#92405e', background: 'rgba(146, 64, 94, 0.10)',
    border: '1px solid rgba(146, 64, 94, 0.25)', borderRadius: 999, padding: '3px 9px',
  },
  worthKnowingNote: {
    fontSize: 12, color: '#92405e', lineHeight: 1.45, margin: '8px 0 0',
  },
  consultSubmission: {
    marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--bg)',
  },
  consultSubmissionHead: {
    display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 6,
  },
  consultPair: {
    display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 0',
    borderBottom: '1px solid var(--bg)',
  },
  consultQuestion: { fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 },
  consultAnswer: { fontSize: 13, fontWeight: 500, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  consultSignature: {
    marginTop: 6, maxWidth: '100%', height: 'auto', borderRadius: 10,
    border: '1px solid var(--border, #E8DDD4)', background: '#fff',
  },
  consultLinkBtn: {
    alignSelf: 'flex-start', minHeight: 44, padding: '0 2px', background: 'none', border: 'none',
    color: '#92405e', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
  },
  consultSendResult: { fontSize: 12, color: 'var(--text-muted)', margin: '8px 0 0', lineHeight: 1.45 },
  consultConsent: { fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, margin: '10px 0 0' },
};
