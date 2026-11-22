import { useState } from 'react';
import Icon from './ui/Icon';

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const first = d => new Date(d.getFullYear(), d.getMonth(), 1);
const last = d => new Date(d.getFullYear(), d.getMonth() + 1, 0);
const dateLabel = d => d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const stateLabel = { open: 'Available', full: 'Fully booked', off: 'Closed', closed: 'Closed', past: 'Unavailable', beyond: 'Unavailable', unknown: 'Checking availability' };

/** A short date strip with the same availability rules as the full calendar. */
export default function BookingDatePicker({ month, earliest, latest, selectedDate, statusFor, loading, error, onMonthChange, onSelect, onRetry }) {
  const [expanded, setExpanded] = useState(false);
  const [anchor, setAnchor] = useState('');
  if (!month) return <p role="status">Loading dates…</p>;
  const monthKey = iso(month).slice(0, 7);
  const start = first(month);
  const end = last(month);
  const minimum = Math.max(1, earliest > start ? earliest.getDate() : 1);
  const maximum = Math.min(end.getDate(), latest < end ? latest.getDate() : end.getDate());
  const clamp = day => Math.max(minimum, Math.min(day, Math.max(minimum, maximum - 4)));
  const anchorDay = anchor.startsWith(monthKey) ? Number(anchor.slice(8)) : selectedDate.startsWith(monthKey) ? Number(selectedDate.slice(8)) : minimum;
  const stripDay = clamp(anchorDay);
  const canPreviousMonth = first(month) > first(earliest);
  const canNextMonth = first(month) < first(latest);
  const months = [];
  for (let d = first(earliest); d <= first(latest); d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) months.push(d);

  function moveMonth(next) {
    setAnchor('');
    onMonthChange(first(next));
  }
  function moveStrip(direction) {
    const next = stripDay + direction * 5;
    if (next < minimum && canPreviousMonth) {
      const previous = new Date(month.getFullYear(), month.getMonth() - 1, 1);
      setAnchor(iso(new Date(previous.getFullYear(), previous.getMonth(), Math.max(1, last(previous).getDate() - 4))));
      onMonthChange(previous);
    } else if (next > maximum && canNextMonth) {
      moveMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1));
    } else {
      setAnchor(iso(new Date(month.getFullYear(), month.getMonth(), clamp(next))));
    }
  }
  function choose(d) {
    setAnchor(iso(new Date(d.getFullYear(), d.getMonth(), clamp(d.getDate() - 2))));
    onSelect(iso(d));
    setExpanded(false);
  }
  function dayButton(d, full = false) {
    const status = statusFor(d);
    const selected = iso(d) === selectedDate;
    return <button key={iso(d)} type="button" className={`fl-booking-date${full ? ' is-month' : ''}`} data-state={status}
      aria-label={`${dateLabel(d)}, ${stateLabel[status] || 'Unavailable'}`} aria-pressed={selected}
      disabled={status !== 'open' || loading} onClick={() => choose(d)}>
      {!full && <span className="fl-booking-date-weekday">{d.toLocaleDateString('en-GB', { weekday: 'short' })}</span>}
      <span className="fl-booking-date-number">{d.getDate()}</span>
      {!full && <span className="fl-booking-date-state" aria-hidden="true">{status === 'full' ? 'Full' : status === 'closed' || status === 'off' ? 'Closed' : status === 'unknown' ? '…' : status === 'open' ? '•' : ''}</span>}
      {full && <span className="fl-booking-date-dot" aria-hidden="true" />}
    </button>;
  }
  const cells = Array.from({ length: (start.getDay() + 6) % 7 }, () => null);
  for (let day = 1; day <= end.getDate(); day++) cells.push(new Date(month.getFullYear(), month.getMonth(), day));

  return <div className="fl-booking-dates">
    <div className="fl-booking-date-heading">
      <button type="button" className="fl-booking-month-toggle" aria-expanded={expanded} aria-controls="booking-full-calendar" onClick={() => setExpanded(value => !value)}>
        {month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}<Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={16} />
      </button>
      <div className="fl-booking-date-nav">
        <button type="button" aria-label={expanded ? 'Previous month' : 'Previous dates'} disabled={expanded ? !canPreviousMonth : stripDay <= minimum && !canPreviousMonth}
          onClick={() => expanded ? moveMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1)) : moveStrip(-1)}><Icon name="chevron-left" size={19} /></button>
        <button type="button" aria-label={expanded ? 'Next month' : 'Next dates'} disabled={expanded ? !canNextMonth : stripDay + 4 >= maximum && !canNextMonth}
          onClick={() => expanded ? moveMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1)) : moveStrip(1)}><Icon name="chevron-right" size={19} /></button>
      </div>
    </div>
    {expanded ? <div id="booking-full-calendar" className="fl-booking-month">
      <label className="fl-booking-month-jump">Jump to month<span className="fl-booking-month-select"><select value={monthKey} onChange={event => moveMonth(new Date(`${event.target.value}-01T12:00:00`))}>
        {months.map(d => <option key={iso(d)} value={iso(d).slice(0, 7)}>{d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</option>)}
      </select><Icon name="chevron-down" size={14} /></span></label>
      <div className="fl-booking-month-grid">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, i) => <span className="fl-booking-weekday" key={`weekday-${i}`} aria-hidden="true">{day}</span>)}
        {cells.map((d, i) => d ? dayButton(d, true) : <span key={`blank-${i}`} />)}
      </div>
      <p className="fl-booking-calendar-key">Dates with a dot have space.</p>
    </div> : <div className="fl-booking-date-strip" aria-label="Choose a date">
      {Array.from({ length: Math.min(5, maximum - stripDay + 1) }, (_, i) => dayButton(new Date(month.getFullYear(), month.getMonth(), stripDay + i)))}
    </div>}
    <div className="fl-booking-date-status" aria-live="polite">
      {loading ? <span>Checking available dates…</span> : error ? <div role="alert">We couldn’t check these dates. <button type="button" onClick={onRetry}>Try again</button></div> :
        !expanded && <button type="button" onClick={() => setExpanded(true)}><Icon name="calendar" size={14} />See full calendar</button>}
    </div>
  </div>;
}
