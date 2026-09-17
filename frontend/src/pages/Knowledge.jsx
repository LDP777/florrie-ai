/** Owner-approved guidance and a private preview of Florrie's reply. */
import { useState, useEffect, useCallback, useRef } from 'react';
import { useBeautician, supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import ReplyLearning from '../components/ReplyLearning.jsx';
import PageLoader from '../components/PageLoader.jsx';
import Icon from '../components/ui/Icon';
import PageHeader from '../components/ui/PageHeader.jsx';

const CATEGORIES = [
  { key: 'faq', label: 'Common questions' }, { key: 'policy', label: 'Policies' },
  { key: 'treatment', label: 'Treatments' }, { key: 'aftercare', label: 'Aftercare' },
  { key: 'arrival', label: 'Arriving' }, { key: 'prep', label: 'Preparation' },
  { key: 'general', label: 'General' },
];
const LABELS = Object.fromEntries(CATEGORIES.map(c => [c.key, c.label]));
const STARTERS = [
  { category: 'policy', title: 'When do you release new booking dates?' },
  { category: 'treatment', title: 'How long should I leave between brow laminations?' },
  { category: 'arrival', title: 'What should I do when I arrive?' },
];

export default function Knowledge() {
  const { beautician, loading: bLoading } = useBeautician();
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const [needsMigration, setNeedsMigration] = useState(false);
  const [saving, setSaving] = useState(false);
  const [changingId, setChangingId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [category, setCategory] = useState('faq');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [question, setQuestion] = useState('');
  const [testing, setTesting] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const [showPaused, setShowPaused] = useState(false);
  const previewRequest = useRef(null);
  const formRef = useRef(null);

  const authedFetch = useCallback(async (path, options = {}) => {
    const { data } = await supabase.auth.getSession();
    if (!data.session?.access_token) throw new Error('Please sign in again to continue.');
    const controller = options.signal ? null : new AbortController();
    const timeout = controller && setTimeout(() => controller.abort(), 35000);
    let response;
    try { response = await fetch(`${API_BASE}${path}`, {
      ...options,
      signal: options.signal || controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session.access_token}`, ...options.headers },
    }); } finally { if (timeout) clearTimeout(timeout); }
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error || 'Could not complete that. Try again.');
    return body;
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const body = await authedFetch('/api/knowledge');
      setNeedsMigration(Boolean(body.needs_migration));
      setEntries(body.entries || []);
    } catch (err) {
      logger.error({ err }, 'Load knowledge error');
      setError('Could not load your answers. Try again.');
    } finally { setLoading(false); }
  }, [authedFetch]);

  useEffect(() => { if (beautician && !bLoading) load(); }, [beautician, bLoading, load]);
  useEffect(() => () => previewRequest.current?.abort(), []);
  useEffect(() => { if (editingId) formRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [editingId]);

  function clearPreview() {
    previewRequest.current?.abort(); previewRequest.current = null;
    setTesting(false); setPreview(null); setPreviewError('');
  }
  function openAdd(starter) {
    setEditingId('new'); setCategory(starter?.category || 'faq');
    setTitle(starter?.title || ''); setContent(''); setError(null); setNotice('');
  }
  function openEdit(entry) {
    setEditingId(entry.id); setCategory(entry.category); setTitle(entry.title); setContent(entry.content);
    setError(null); setNotice('');
  }
  async function saveAnswer(event) {
    event.preventDefault();
    if (!title.trim() || !content.trim() || saving) return;
    setSaving(true); setError(null); setNotice('');
    try {
      const isNew = editingId === 'new';
      const body = await authedFetch(isNew ? '/api/knowledge' : `/api/knowledge/${editingId}`, {
        method: isNew ? 'POST' : 'PATCH', body: JSON.stringify({ category, title: title.trim(), content: content.trim() }),
      });
      setEntries(prev => isNew ? [body.entry, ...prev] : prev.map(e => e.id === body.entry.id ? body.entry : e));
      setEditingId(null); clearPreview();
      setNotice(body.entry.is_active ? 'Approved answer saved. Try a client question to check the reply.' : 'Changes saved. This answer is still paused.');
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }
  async function toggleAnswer(entry) {
    if (changingId) return;
    setChangingId(entry.id); setError(null); setNotice('');
    try {
      const body = await authedFetch(`/api/knowledge/${entry.id}`, {
        method: 'PATCH', body: JSON.stringify({ is_active: !entry.is_active }),
      });
      setEntries(prev => prev.map(e => e.id === entry.id ? body.entry : e));
      clearPreview();
      setNotice(body.entry.is_active ? 'Answer enabled for future replies.' : 'Answer paused. Florrie will no longer use it for future replies.');
    } catch (err) { setError(err.message); }
    finally { setChangingId(null); }
  }
  async function testQuestion(event) {
    event.preventDefault();
    if (!question.trim() || testing) return;
    clearPreview(); setTesting(true);
    const controller = new AbortController(); previewRequest.current = controller;
    const timeout = setTimeout(() => controller.abort(), 35000);
    try {
      const result = await authedFetch('/api/knowledge/preview', {
        method: 'POST', body: JSON.stringify({ question: question.trim() }), signal: controller.signal,
      });
      if (previewRequest.current === controller && !controller.signal.aborted) setPreview(result);
    } catch (err) {
      if (previewRequest.current === controller) setPreviewError(controller.signal.aborted
        ? 'The preview took too long. Your answers are saved; try again.' : err.message);
    } finally {
      clearTimeout(timeout);
      if (previewRequest.current === controller) { previewRequest.current = null; setTesting(false); }
    }
  }

  if (bLoading || loading) return <PageLoader />;
  const active = entries.filter(e => e.is_active);
  const paused = entries.filter(e => !e.is_active);
  const visible = showPaused ? paused : active;

  return (
    <div className="fl-knowledge">
      <PageHeader title="Florrie’s knowledge" subtitle="Your answers. Your way of working." />
      <div className="fl-knowledge-intro">
        <Icon name="flower" size={23} />
        <p>Teach Florrie the guidance you want clients to hear. Save an approved answer, then try a question to see how she uses it.</p>
      </div>
      {needsMigration && <p className="fl-knowledge-notice">Saved answers are not switched on for your account yet.</p>}
      {error && <div className="fl-knowledge-error" role="alert">{error} <button type="button" onClick={load}>Reload answers</button></div>}
      {notice && <p className="fl-knowledge-notice" role="status">{notice}</p>}

      {!needsMigration && <>
        <ReplyLearning request={authedFetch} entries={entries} onSaved={(entry, topic) => {
          setEntries(rows => [entry, ...rows.filter(row => row.id !== entry.id)]);
          clearPreview(); setQuestion(topic);
        }} />
        <section className="fl-knowledge-test" aria-labelledby="knowledge-test-heading">
          <span className="fl-knowledge-eyebrow">A PRIVATE PRACTICE RUN</span>
          <h2 id="knowledge-test-heading">Ask as a client</h2>
          <p>Uses Florrie’s reply process and your saved guidance. Nothing is sent and no booking is made. Personal questions may still need a client’s history or your decision.</p>
          <form onSubmit={testQuestion}>
            <label htmlFor="knowledge-question">Client’s question</label>
            <textarea id="knowledge-question" value={question} maxLength={1000} rows={3}
              onChange={e => { clearPreview(); setQuestion(e.target.value); }}
              placeholder="Have you released next month’s dates yet?" />
            <button className="fl-knowledge-primary" type="submit" disabled={!question.trim() || testing || saving || !!changingId}>
              <Icon name="message" size={17} /> {testing ? 'Writing a preview…' : 'Preview Florrie’s reply'}
            </button>
          </form>
          {previewError && <p className="fl-knowledge-error" role="alert">{previewError}</p>}
          {preview && <div className="fl-knowledge-result" aria-live="polite">
            <p className="fl-knowledge-result-title"><Icon name={preview.canAnswer ? 'check' : 'info'} size={18} />{preview.canAnswer ? 'An answer from your guidance' : 'Needs more guidance or a check'}</p>
            {preview.reply && <blockquote>{preview.reply}</blockquote>}
            <p className="fl-knowledge-source-label">{preview.sources?.length ? 'Saved guidance used' : 'No matching saved answer used.'}</p>
            <div className="fl-knowledge-sources">{(preview.sources || []).map(source => {
              const entry = entries.find(e => e.id === source.id);
              return entry ? <button key={source.id} type="button" onClick={() => openEdit(entry)}><Icon name="edit" size={14} />{source.title}</button>
                : <span key={source.id || source.title}>{source.title}</span>;
            })}</div>
            {!preview.canAnswer && <p className="fl-knowledge-help">Add the guidance you want Florrie to use, or leave a personal treatment decision with you. A general answer does not confirm whether treatment is suitable for a particular client.</p>}
            <button type="button" className="fl-knowledge-text-button" onClick={() => openAdd({ title: question.slice(0, 120), category: 'faq' })}>Write an approved answer <Icon name="arrow-right" size={15} /></button>
          </div>}
        </section>

        <section className="fl-knowledge-library" aria-labelledby="knowledge-library-heading">
          <div className="fl-knowledge-section-head"><div><span className="fl-knowledge-eyebrow">WHAT YOU’VE TAUGHT FLORRIE</span><h2 id="knowledge-library-heading">Approved answers</h2></div><button type="button" className="fl-knowledge-add" onClick={() => openAdd()} aria-label="Add an approved answer"><Icon name="plus" size={20} /></button></div>
          <p className="fl-knowledge-help">Existing notes live here too. Only enabled answers can inform future replies.</p>
          {editingId && <form ref={formRef} onSubmit={saveAnswer} className="fl-knowledge-form" aria-label="Approved answer editor">
            <div className="fl-knowledge-section-head"><h3>{editingId === 'new' ? 'Teach a new answer' : 'Edit your answer'}</h3><button type="button" className="fl-knowledge-text-button" disabled={saving} onClick={() => setEditingId(null)}>Cancel</button></div>
            <label htmlFor="knowledge-category">Category</label><select id="knowledge-category" value={category} onChange={e => setCategory(e.target.value)}>{CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}</select>
            <label htmlFor="knowledge-title">Question or topic</label><input id="knowledge-title" value={title} onChange={e => setTitle(e.target.value)} maxLength={120} required placeholder="When do you release new booking dates?" />
            <label htmlFor="knowledge-answer">Your approved answer or guidance</label><textarea id="knowledge-answer" value={content} onChange={e => setContent(e.target.value)} maxLength={5000} required rows={6} placeholder="Write the answer you want Florrie to use." />
            <p className="fl-knowledge-help">Use guidance you’ve approved for clients. Leave out individual names, private details and one-off exceptions. Saving does not change your diary, booking settings or treatment requirements.</p>
            <button type="submit" className="fl-knowledge-primary" disabled={saving || !title.trim() || !content.trim()}>{saving ? 'Saving…' : 'Save approved answer'}</button>
          </form>}
          {entries.length > 0 && <div className="fl-knowledge-tabs" aria-label="Answer status"><button type="button" aria-pressed={!showPaused} onClick={() => setShowPaused(false)}>Enabled <span>{active.length}</span></button><button type="button" aria-pressed={showPaused} onClick={() => setShowPaused(true)}>Paused <span>{paused.length}</span></button></div>}
          {!entries.length && !editingId && <div className="fl-knowledge-empty"><p>Start with something clients often ask.</p>{STARTERS.map(st => <button type="button" key={st.title} onClick={() => openAdd(st)}>{st.title}<Icon name="plus" size={16} /></button>)}</div>}
          {entries.length > 0 && !visible.length && <p className="fl-knowledge-help">{showPaused ? 'No paused answers.' : 'No enabled answers. Add one, or enable a paused answer.'}</p>}
          {visible.map(entry => <article key={entry.id} className="fl-knowledge-answer">
            <div className="fl-knowledge-entry-meta"><span>{LABELS[entry.category] || entry.category}</span>{!entry.is_active && <span>Paused</span>}</div>
            <h3>{entry.title}</h3><p>{entry.content}</p>
            <div className="fl-knowledge-entry-actions"><button type="button" onClick={() => openEdit(entry)}><Icon name="edit" size={15} />Edit answer</button><button type="button" disabled={!!changingId} onClick={() => toggleAnswer(entry)}>{changingId === entry.id ? 'Saving…' : entry.is_active ? 'Pause answer' : 'Enable answer'}</button></div>
          </article>)}
        </section>
      </>}
    </div>
  );
}
