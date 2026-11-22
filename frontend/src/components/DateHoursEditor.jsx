import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import { readAuthenticatedJson } from '../lib/authenticated-json.js';
import { readDateHours, changeDateHours, effectiveHours, hoursDateLabel } from '../lib/working-hours.js';
import Button from './ui/Button.jsx';
import Icon from './ui/Icon';

export default function DateHoursEditor({ dates, beautician, onClose, onSaved }) {
  const dialog = useRef(null), mutation = useRef(false);
  const [start, setStart] = useState('09:00'), [end, setEnd] = useState('17:00');
  const [rows, setRows] = useState([]), [blocks, setBlocks] = useState([]);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [retry, setRetry] = useState(0), [ready, setReady] = useState(false);
  const ordered = [...dates].sort(), key = ordered.join(',');
  useEffect(() => {
    const node = dialog.current; node.showModal();
    return () => node.close();
  }, []);
  useEffect(() => {
    let active = true; setReady(false); setLoading(true); setError('');
    Promise.all([readDateHours(ordered[0], ordered.at(-1)), readAuthenticatedJson({ auth: supabase.auth, url: `${API_BASE}/api/hours-exceptions` })])
      .then(([hours, blocked]) => {
        if (!active) return;
        if (!Array.isArray(hours.dates) || !Array.isArray(blocked.exceptions)) throw new Error('Could not check these dates.');
        const opening = effectiveHours(beautician.working_hours, ordered[0], hours.dates);
        setRows(hours.dates); setBlocks(blocked.exceptions);
        setStart(opening?.start || '09:00'); setEnd(opening?.end || '17:00'); setLoading(false); setReady(true);
      }).catch(err => { if (active) { setError(err.message); setLoading(false); } });
    return () => { active = false; };
  }, [key, beautician.id, retry]); // eslint-disable-line react-hooks/exhaustive-deps
  const relevant = blocks.filter(block => ordered.some(date => block.date <= date && (block.end_date || block.date) >= date));
  const blockedDays = ordered.filter(date => relevant.some(block => block.date <= date && (block.end_date || block.date) >= date && (block.type === 'closed' || !block.start_time || !block.end_time)));
  const existing = rows.find(row => row.date === ordered[0]);
  const usual = effectiveHours(beautician.working_hours, ordered[0]);
  async function save(restore = false) {
    if (mutation.current || !ready) return;
    if (!restore && (!start || !end || end <= start)) { setError('Choose a finish time after your start time.'); return; }
    mutation.current = true; setBusy(true); setError('');
    try {
      const data = await changeDateHours(restore ? 'DELETE' : 'PUT', restore ? null : { dates: ordered, start_time: start, end_time: end }, restore ? ordered[0] : null);
      if (restore ? data.restored !== ordered[0] : data.dates?.length !== ordered.length) throw new Error('The saved hours could not be confirmed. Please try again.');
      onSaved(restore ? { removed: ordered[0] } : { dates: data.dates }); onClose();
    } catch (err) { setError(err.name === 'TimeoutError' ? 'Saving took too long. Try again to confirm your hours.' : err.message); }
    finally { mutation.current = false; setBusy(false); }
  }
  return createPortal(<dialog ref={dialog} className="hours-dialog" aria-labelledby="date-hours-title" onCancel={event => { event.preventDefault(); if (!mutation.current) onClose(); }}>
    <header className="hours-sheet-heading"><div><p className="hours-eyebrow">{ordered.length === 1 ? hoursDateLabel(ordered[0]) : `${ordered.length} selected dates`}</p><h2 id="date-hours-title">{ordered.length === 1 ? 'Hours for this day' : 'Hours for these days'}</h2></div>
      <Button variant="quiet" icon size="icon" aria-label="Close hours" disabled={busy} onClick={onClose}><Icon name="x" size={20} /></Button></header>
    {ordered.length > 1 && <div className="hours-date-chips">{ordered.map(date => <span key={date}>{hoursDateLabel(date)}</span>)}</div>}
    {loading ? <p role="status">Checking your hours…</p> : <>
      <p className="hours-muted">{ordered.length === 1 ? `Usually ${usual ? `${usual.start}–${usual.end}` : 'closed'}. Change this date only.` : 'Your usual week stays the same.'}</p>
      <div className="hours-time-pair"><label>Start<input aria-label="Start time" type="time" required value={start} disabled={busy} onChange={e => setStart(e.target.value)} /></label><span>–</span><label>Finish<input aria-label="Finish time" type="time" required value={end} disabled={busy} onChange={e => setEnd(e.target.value)} /></label></div>
      {relevant.length > 0 && <div className="hours-notice">{blockedDays.length ? `${blockedDays.map(hoursDateLabel).join(', ')} ${blockedDays.length === 1 ? 'is' : 'are'} blocked off. Remove the day-off block to accept bookings.` : 'Your personal blocks still apply within these hours.'} <Link to="/hours?tab=off" onClick={onClose}>View time off</Link></div>}
      <p className="hours-muted">Existing appointments stay where they are.</p>
    </>}
    {error && <div className="hours-error" role="alert">{error} {!ready && <Button variant="quiet" disabled={busy} onClick={() => setRetry(n => n + 1)}>Check again</Button>}</div>}
    <footer className="hours-sheet-actions"><Button fullWidth disabled={loading || busy || !ready} onClick={() => save()}>{busy ? 'Saving…' : ordered.length === 1 ? 'Save hours' : `Save hours for ${ordered.length} days`}</Button>
      {ordered.length === 1 && existing && <Button variant="quiet" fullWidth disabled={loading || busy || !ready} onClick={() => save(true)}>Use usual hours{usual ? ` · ${usual.start}–${usual.end}` : ' · closed'}</Button>}</footer>
  </dialog>, document.body);
}
