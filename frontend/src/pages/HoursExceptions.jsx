import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useBeautician } from '../lib/supabase.js';
import { todayLocal, localDateStr } from '../lib/dates.js';
import { readDateHours, hoursDateLabel } from '../lib/working-hours.js';
import PageHeader from '../components/ui/PageHeader.jsx';
import Button from '../components/ui/Button.jsx';
import Icon from '../components/ui/Icon';
import DateHoursEditor from '../components/DateHoursEditor.jsx';
import WeeklyHoursEditor from '../components/WeeklyHoursEditor.jsx';
import TimeOffPlanner from '../components/TimeOffPlanner.jsx';

export default function HoursExceptions({ initialTab = 'dates' }) {
  const { beautician, refresh } = useBeautician();
  const [params, setParams] = useSearchParams();
  const tab = ['dates', 'week', 'off'].includes(params.get('tab')) ? params.get('tab') : initialTab;
  const today = todayLocal();
  const [month, setMonth] = useState(() => new Date(`${today.slice(0, 7)}-01T12:00:00`));
  const [selected, setSelected] = useState([]), [editing, setEditing] = useState(null);
  const [rows, setRows] = useState([]), [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const request = useRef(0);
  const from = today, end = new Date(`${today}T12:00:00`);
  end.setFullYear(end.getFullYear() + 2);
  const to = localDateStr(end);
  async function load() {
    const seq = ++request.current; setLoading(true); setError('');
    try {
      const data = await readDateHours(from, to);
      if (!Array.isArray(data.dates)) throw new Error('Could not read your saved hours.');
      if (seq === request.current) setRows(data.dates);
    } catch (err) { if (seq === request.current) setError(err.message); }
    finally { if (seq === request.current) setLoading(false); }
  }
  useEffect(() => { if (beautician) load(); return () => { request.current++; }; }, [beautician?.id, from]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!beautician) return <p role="status">Loading your hours…</p>;
  function saved(result) {
    setRows(prev => result.removed ? prev.filter(row => row.date !== result.removed) : [...prev.filter(row => !result.dates.some(item => item.date === row.date)), ...result.dates]);
    setNotice(result.removed ? 'Usual hours restored.' : `Hours saved for ${result.dates.length === 1 ? hoursDateLabel(result.dates[0].date) : `${result.dates.length} days`}.`);
    setSelected([]);
  }
  const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate(), padding = (month.getDay() + 6) % 7;
  const monthKey = localDateStr(month).slice(0, 7);
  return <div className="hours-page">
    <PageHeader title="Your hours" />
    <div className="hours-tabs" role="tablist" aria-label="Working hours">
      {[['dates', 'Specific dates'], ['week', 'Usual week'], ['off', 'Time off']].map(([key, title]) => <button key={key} role="tab" aria-selected={tab === key} onClick={() => { setParams({ tab: key }); setNotice(''); }}>{title}</button>)}
    </div>
    {notice && <p className="hours-success" role="status">{notice}</p>}
    {tab === 'dates' && <>
      <p className="hours-muted">Working extra? Choose one or more dates.</p>
      <section className="hours-card" aria-label="Choose working dates">
        <div className="hours-month-heading"><Button variant="quiet" icon size="icon" aria-label="Previous month" disabled={monthKey <= today.slice(0, 7)} onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1, 12))}><Icon name="chevron-left" size={18} /></Button><h2>{month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</h2><Button variant="quiet" icon size="icon" aria-label="Next month" disabled={monthKey >= to.slice(0, 7)} onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1, 12))}><Icon name="chevron-right" size={18} /></Button></div>
        <div className="hours-grid">{['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, i) => <span key={`label-${i}`} aria-hidden="true">{day}</span>)}{Array.from({ length: padding }, (_, i) => <span key={`padding-${i}`} />)}{Array.from({ length: count }, (_, i) => {
          const date = localDateStr(new Date(month.getFullYear(), month.getMonth(), i + 1, 12));
          return <button key={date} className="hours-day" aria-label={hoursDateLabel(date)} aria-pressed={selected.includes(date)} data-today={date === today} data-changed={rows.some(row => row.date === date)} disabled={date < today || date > to || loading || !!error || (selected.length >= 60 && !selected.includes(date))} onClick={() => setSelected(prev => prev.includes(date) ? prev.filter(d => d !== date) : [...prev, date])}>{i + 1}</button>;
        })}</div>
        <div className="hours-calendar-actions"><span>{loading ? 'Checking saved hours…' : selected.length ? `${selected.length} selected` : 'Tap dates to select'}</span><Button disabled={!selected.length || loading || !!error} onClick={() => setEditing(selected)}>Set hours</Button></div>
        {selected.length > 0 && <Button variant="quiet" size="sm" onClick={() => setSelected([])}>Clear selection</Button>}
      </section>
      {error && <div className="hours-error" role="alert">{error}<Button variant="quiet" onClick={load}>Try again</Button></div>}
      <section className="hours-card" aria-label="Saved date hours"><h3>Upcoming changes</h3>
        {!loading && !error && rows.filter(row => row.date >= today).length === 0 && <p className="hours-muted">No changes yet. Your usual week applies.</p>}
        <ul className="hours-list">{rows.filter(row => row.date >= today).sort((a, b) => a.date.localeCompare(b.date)).map(row => <li key={row.date} className="hours-row"><div><strong>{hoursDateLabel(row.date)}</strong><small>{row.start_time.slice(0, 5)}–{row.end_time.slice(0, 5)}</small></div><Button variant="quiet" size="sm" aria-label={`Edit hours for ${hoursDateLabel(row.date)}`} onClick={() => setEditing([row.date])}>Edit</Button></li>)}</ul>
      </section>
    </>}
    <div hidden={tab !== 'week'}><WeeklyHoursEditor key={beautician.id} beautician={beautician} onSaved={refresh} /></div>
    {tab === 'off' && <TimeOffPlanner />}
    {editing && <DateHoursEditor dates={editing} beautician={beautician} onClose={() => setEditing(null)} onSaved={saved} />}
  </div>;
}
