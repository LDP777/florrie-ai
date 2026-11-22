import { useRef, useState } from 'react';
import { updateRow } from '../lib/supabase.js';
import { TIMEZONE_OPTIONS } from '../lib/timezone-options.js';
import { validHoursTime } from '../../../backend/src/lib/effective-hours.js';
import Button from './ui/Button.jsx';
const DAYS = [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];

export default function WeeklyHoursEditor({ beautician, onSaved }) {
  const [hours, setHours] = useState(() => Object.fromEntries(DAYS.map(([key]) => {
    const week = beautician.working_hours || {};
    const day = Object.hasOwn(week, key) ? week[key] : week[key[0].toUpperCase() + key.slice(1)];
    return [key, !day || day.enabled === false || day.closed === true ? null : { start: String(day.start || '').slice(0, 5), end: String(day.end || '').slice(0, 5) }];
  })));
  const [timezone, setTimezone] = useState(beautician.timezone || 'Europe/London');
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  const mutation = useRef(false);
  function change(day, value) { setHours(prev => ({ ...prev, [day]: value })); setDirty(true); setSaved(false); }
  async function save() {
    if (mutation.current) return;
    if (Object.values(hours).some(h => h && (!validHoursTime(h.start) || !validHoursTime(h.end) || h.end <= h.start))) { setError('Check each finish time is after its start time.'); return; }
    mutation.current = true; setBusy(true); setError('');
    try {
      await updateRow('beauticians', beautician.id, { working_hours: hours, timezone });
      await onSaved(); setDirty(false); setSaved(true);
    } catch { setError('Could not save your usual hours. Your changes are still here. Try again.'); }
    finally { mutation.current = false; setBusy(false); }
  }
  const options = TIMEZONE_OPTIONS.some(([key]) => key === timezone) ? TIMEZONE_OPTIONS : [[timezone, timezone], ...TIMEZONE_OPTIONS];
  return <section className="hours-card" aria-label="Usual working week">
    <h2>Your usual week</h2><p className="hours-muted">Your regular opening hours. Specific dates can be different.</p>
    <fieldset disabled={busy} style={{ border: 0, margin: 0, padding: 0 }}>
      {DAYS.map(([day, label]) => <div className="hours-week-row" key={day}>
        <label><input type="checkbox" checked={!!hours[day]} onChange={e => change(day, e.target.checked ? { start: '09:00', end: '17:00' } : null)} />{label}</label>
        {hours[day] ? <div className="hours-week-times"><input aria-label={`${label} start`} type="time" value={hours[day].start.slice(0, 5)} onChange={e => change(day, { ...hours[day], start: e.target.value })} /><span>–</span><input aria-label={`${label} finish`} type="time" value={hours[day].end.slice(0, 5)} onChange={e => change(day, { ...hours[day], end: e.target.value })} /></div> : <span className="hours-muted" style={{ margin: 0 }}>Closed</span>}
      </div>)}
      <details style={{ margin: '20px 0' }}><summary className="hours-muted" style={{ cursor: 'pointer' }}>Timezone · {timezone.replaceAll('_', ' ')}</summary><label htmlFor="hours-timezone">Your timezone</label><select id="hours-timezone" value={timezone} onChange={e => { setTimezone(e.target.value); setDirty(true); setSaved(false); }} style={{ display: 'block', width: '100%', padding: 12, font: 'inherit', color: 'var(--text-primary)', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 12, marginTop: 8 }}>{options.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></details>
    </fieldset>
    {error && <p className="hours-error" role="alert">{error}</p>}
    {saved && <p className="hours-success" role="status">Usual hours saved.</p>}
    <Button fullWidth disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : 'Save usual hours'}</Button>
  </section>;
}
