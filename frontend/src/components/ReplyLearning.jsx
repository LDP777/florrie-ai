import { useCallback, useEffect, useRef, useState } from 'react';

const CATEGORIES = ['faq', 'policy', 'treatment', 'aftercare', 'prep', 'arrival', 'general'];

function Lesson({ suggestion, entries, request, onSaved, onDismissed }) {
  const [title, setTitle] = useState(suggestion.title || '');
  const [content, setContent] = useState(suggestion.content || '');
  const [category, setCategory] = useState(suggestion.category || 'faq');
  const [replace, setReplace] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const previous = entries.find(entry => entry.id === replace);
  async function decide(event, action) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await request(`/api/knowledge/learning/${suggestion.id}/${action}`, {
        method: 'POST', body: JSON.stringify({ title, content, category, replace_entry_id: replace || null }),
      });
      if (action === 'approve') onSaved(result.entry, suggestion);
      else onDismissed(suggestion.id);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <form className="fl-knowledge-lesson" onSubmit={event => decide(event, 'approve')} aria-label="Review a learned answer">
    <span className="fl-knowledge-eyebrow">FROM YOUR SENT REPLY · NEEDS YOUR APPROVAL</span>
    <details><summary>Words Florrie picked from your reply</summary><blockquote>{suggestion.evidence}</blockquote></details>
    <label htmlFor={`lesson-title-${suggestion.id}`}>Question or topic</label>
    <input id={`lesson-title-${suggestion.id}`} value={title} maxLength={120} required onChange={e => setTitle(e.target.value)} />
    <label htmlFor={`lesson-answer-${suggestion.id}`}>Answer for future clients</label>
    <textarea id={`lesson-answer-${suggestion.id}`} value={content} maxLength={5000} rows={4} required onChange={e => setContent(e.target.value)} />
    <label htmlFor={`lesson-category-${suggestion.id}`}>Category</label>
    <select id={`lesson-category-${suggestion.id}`} value={category} onChange={e => setCategory(e.target.value)}>{CATEGORIES.map(value => <option key={value} value={value}>{({ faq: 'Common questions', policy: 'Policies', treatment: 'Treatments', aftercare: 'Aftercare', prep: 'Preparation', arrival: 'Arriving', general: 'General' })[value]}</option>)}</select>
    {entries.length > 0 && <><label htmlFor={`lesson-replace-${suggestion.id}`}>Save as</label>
      <select id={`lesson-replace-${suggestion.id}`} value={replace} onChange={e => setReplace(e.target.value)}><option value="">A new approved answer</option>{entries.map(entry => <option key={entry.id} value={entry.id}>Update: {entry.title}{!entry.is_active ? ' (paused)' : ''}</option>)}</select>
      {previous && <p className="fl-knowledge-help">Replaces: {previous.content}{!previous.is_active && ' This answer will stay paused.'}</p>}
    </>}
    <p className="fl-knowledge-help">Check this applies to other clients. Keep every condition, and remove private details or favours for one person. Nothing is learned until you approve.</p>
    {error && <p role="alert" className="fl-knowledge-error">{error}</p>}
    <button type="submit" className="fl-knowledge-primary" disabled={busy || !title.trim() || !content.trim()}>{busy ? 'Saving…' : 'Approve for future replies'}</button>
    <button type="button" className="fl-knowledge-text-button" disabled={busy} onClick={event => decide(event, 'dismiss')}>Keep this just in the conversation</button>
  </form>;
}

export default function ReplyLearning({ request, entries, onSaved }) {
  const [suggestions, setSuggestions] = useState([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [watching, setWatching] = useState(false);
  const alive = useRef(true);
  const expiry = useRef(0);
  const initial = useRef(false);
  const refresh = useCallback(async () => {
    try {
      const body = await request('/api/knowledge/learning');
      if (!alive.current) return;
      setSuggestions(body.suggestions || []); setError('');
    } catch (err) { if (alive.current) setError(err.message); }
  }, [request]);
  const watch = () => { expiry.current = Date.now() + 150000; setWatching(true); };
  const checkReply = useCallback(async id => {
    setBusy(true); setError(''); setNotice('Looking for an answer in your reply…');
    try {
      const { suggestion } = await request(`/api/knowledge/learning/from-reply/${id}`, { method: 'POST' });
      if (!alive.current) return;
      const messages = { not_reusable: 'This reply looks personal or does not contain a complete reusable answer. You can still write general guidance below.', dismissed: 'You chose to keep this reply just in its conversation.', approved: 'You have already taught Florrie this answer. You can edit it in Approved answers.', processing: 'Florrie is checking this reply. It is not part of her knowledge yet.', pending: 'Review the answer below before Florrie uses it for other clients.' };
      setNotice(messages[suggestion?.status] || 'Try this reply again in a moment.');
      await refresh(); watch();
    } catch (err) { if (alive.current) setError(err.message); }
    finally { if (alive.current) setBusy(false); }
  }, [refresh, request]);
  useEffect(() => {
    alive.current = true; refresh();
    const id = new URLSearchParams(window.location.search).get('reply');
    if (!initial.current && /^[0-9a-f-]{36}$/i.test(id || '')) { initial.current = true; checkReply(id); }
    return () => { alive.current = false; };
  }, [refresh, checkReply]);
  useEffect(() => {
    if (!watching) return;
    const timer = setInterval(() => { if (Date.now() > expiry.current) setWatching(false); else refresh(); }, 4000);
    return () => clearInterval(timer);
  }, [watching, refresh]);
  async function discover() {
    setBusy(true); setError('');
    try {
      const body = await request('/api/knowledge/learning/discover', { method: 'POST' });
      if (!alive.current) return;
      setNotice(body.reviewing ? `Checking ${body.reviewing} recent ${body.reviewing === 1 ? 'reply' : 'replies'}. Any useful answers will appear here for review.` : 'Your recent replies have been checked. New useful replies will appear here for review.');
      await refresh(); watch();
    } catch (err) { if (alive.current) setError(err.message); }
    finally { if (alive.current) setBusy(false); }
  }
  const pending = suggestions.filter(s => s.status === 'pending');
  return <section className="fl-knowledge-learning" aria-labelledby="reply-learning-heading">
    <span className="fl-knowledge-eyebrow">TEACH ONCE, HELP THE NEXT CLIENT</span>
    <h2 id="reply-learning-heading">Learn from your replies</h2>
    <p className="fl-knowledge-help">When you write or correct a reply, Florrie looks for guidance worth remembering. You check it here before it helps anyone else. Your messages send as usual.</p>
    <button type="button" className="fl-knowledge-text-button" onClick={discover} disabled={busy}>{busy ? 'Checking…' : 'Check my recent replies'}</button>
    {notice && <p role="status" className="fl-knowledge-notice">{notice}</p>}
    {error && <p role="alert" className="fl-knowledge-error">{error} <button type="button" onClick={refresh}>Retry loading suggestions</button></p>}
    {suggestions.some(s => s.status === 'processing') && <p className="fl-knowledge-help">Some replies are still being checked. <button className="fl-knowledge-text-button" onClick={refresh}>Refresh</button></p>}
    {suggestions.filter(s => s.status === 'retry').map(s => <button type="button" className="fl-knowledge-text-button" key={s.id} disabled={busy} onClick={() => checkReply(s.source_message_id)}>Retry a reply that could not be checked</button>)}
    {pending.map(suggestion => <Lesson key={suggestion.id} suggestion={suggestion} entries={entries} request={request}
      onDismissed={id => setSuggestions(rows => rows.filter(row => row.id !== id))}
      onSaved={(entry, source) => { setSuggestions(rows => rows.filter(row => row.id !== source.id)); setNotice(entry.is_active ? 'Answer learned. Try the question below to check what the next client will hear.' : 'Answer updated. It is still paused.'); onSaved(entry, source.title); }} />)}
    {!pending.length && !error && <p className="fl-knowledge-help">No answers waiting for approval. In a chat, choose “Teach Florrie” under one of your replies, or check recent replies above.</p>}
  </section>;
}
