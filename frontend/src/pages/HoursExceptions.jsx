import { useState, useEffect, useRef } from 'react';
import { useBeautician, supabase, insertRow } from '../lib/supabase.js';
import logger from '../lib/logger.js';
import { todayLocal } from '../lib/dates.js';
import Icon, { iconName } from '../components/ui/Icon';
import PageHeader from '../components/ui/PageHeader.jsx';
import Button from '../components/ui/Button.jsx';
import MoreLoadError from '../components/MoreLoadError.jsx';
/**
 * Availability Planner - forward-looking calendar for blocking days / changing hours.
 *
 * Layout:
 *   1. 3-month scrollable calendar grid - tap any future day to act on it
 *   2. Inline quick-block panel - appears below tapped date
 *   3. Upcoming exceptions list
 *
 * Backend: POST/DELETE /api/hours-exceptions (hours-exceptions.js route)
 * Types: closed | amended | extended
 * Reasons: holiday | sick | personal | training | bank_holiday | event | other
 */

const QUICK_REASONS = [
  { value: 'holiday',      label: 'Holiday',   emoji: 'sun' },
  { value: 'personal',     label: 'Personal',  emoji: 'map-pin' },
  { value: 'sick',         label: 'Sick day',  emoji: 'alert-triangle' },
  { value: 'training',     label: 'Training',  emoji: 'book' },
  { value: 'bank_holiday', label: 'Bank hol',  emoji: 'sparkles' },
  { value: 'event',        label: 'Event',     emoji: 'sparkles' },
  { value: 'other',        label: 'Other',     emoji: 'list' },
];

const TYPE_CFG = {
  closed:   { label: 'Day off',        color: '#bb2323', bg: 'var(--danger-bg, #F7E4E4)', dot: '#E57373' },
  amended:  { label: 'Changed hours',  color: '#945f06', bg: '#FFF8E1', dot: '#F59E0B' },
  extended: { label: 'Extra hours',    color: '#3a6e4f', bg: '#E8F5E9', dot: '#5BA97B' },
};

// ── date helpers ────────────────────────────────────────────────────────────

function toYMD(d) {
  // LOCAL date, never toISOString(): in British Summer Time UTC is an hour
  // behind, so toISOString() labelled every cell with the previous day and
  // the whole grid sat one weekday column out.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return toYMD(d);
}

function formatShort(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function formatRange(start, end) {
  if (!end || start === end) return formatShort(start);
  const s = new Date(start + 'T12:00:00');
  const e = new Date(end + 'T12:00:00');
  if (s.getMonth() === e.getMonth()) {
    return `${s.getDate()} - ${e.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
  }
  return `${formatShort(start)} - ${formatShort(end)}`;
}

function daysAway(dateStr) {
  const diff = Math.round((new Date(dateStr + 'T12:00:00') - new Date()) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return `${diff} days away`;
}

// Return all dates covered by an exception (handles ranges)
function expandException(exc) {
  const dates = [];
  let current = exc.date;
  const end = exc.end_date || exc.date;
  while (current <= end) {
    dates.push(current);
    current = addDays(current, 1);
  }
  return dates;
}

// Build a map: dateStr → exception (for quick lookup)
function buildDateMap(exceptions) {
  const map = {};
  exceptions.forEach(exc => {
    expandException(exc).forEach(d => {
      if (!map[d]) map[d] = exc;
    });
  });
  return map;
}

// ── calendar grid builder ────────────────────────────────────────────────────

function buildMonth(year, month) {
  // month is 0-indexed
  const firstDay = new Date(year, month, 1);
  const lastDay  = new Date(year, month + 1, 0);

  // Start grid on Monday (ISO week)
  let startDow = firstDay.getDay(); // 0=Sun
  startDow = startDow === 0 ? 6 : startDow - 1; // convert to Mon=0

  const days = [];
  // Padding before month
  for (let i = 0; i < startDow; i++) days.push(null);
  // Actual days
  for (let d = 1; d <= lastDay.getDate(); d++) {
    days.push(toYMD(new Date(year, month, d)));
  }
  // Pad to complete last row
  while (days.length % 7 !== 0) days.push(null);
  return { year, month, days };
}

function getMonthLabel(year, month) {
  return new Date(year, month, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

// ── main component ────────────────────────────────────────────────────────────

export default function HoursExceptions() {
  const { beautician } = useBeautician();
  const [exceptions, setExceptions]   = useState([]);
  const [loading, setLoading]         = useState(true);
  const [saving, setSaving]           = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [error, setError] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const mutation = useRef(false);
  const panelRef = useRef(null);

  // Calendar navigation
  const todayDate = toYMD(new Date());
  const [baseMonth, setBaseMonth]     = useState({ year: new Date().getFullYear(), month: new Date().getMonth() });

  // Tapped date / range selection
  const [selectedDate, setSelectedDate] = useState(null);
  const [rangeMode, setRangeMode]       = useState(false);
  const [rangeStart, setRangeStart]     = useState(null);
  const [rangeEnd, setRangeEnd]         = useState(null);

  // Quick-block form state
  const [blockType, setBlockType]       = useState('closed');
  const [blockReason, setBlockReason]   = useState('holiday');
  const [blockNote, setBlockNote]       = useState('');
  const [blockStartTime, setBlockStartTime] = useState('10:00');
  const [blockEndTime, setBlockEndTime]     = useState('17:00');

  useEffect(() => { if (beautician) loadData(); }, [beautician]);

  async function loadData() {
    setLoading(true); setLoadError(null);
    try {
        const { data, error: readError } = await supabase
          .from('hours_exceptions')
          .select('*')
          .eq('beautician_id', beautician.id)
          .order('date', { ascending: true });
        if (readError) throw readError;
        setExceptions(data || []);
    } catch (err) {
      logger.error('Load exceptions error:', err);
      setLoadError('Could not load your availability. Try again.');
    } finally {
      setLoading(false);
    }
  }

  const dateMap = buildDateMap(exceptions);

  // A full rolling year in one scroll. Ellie books December off in June;
  // nobody should have to find a pagination button for that.
  const months = Array.from({ length: 12 }, (_, offset) => {
    let m = baseMonth.month + offset;
    let y = baseMonth.year;
    while (m > 11) { m -= 12; y += 1; }
    return buildMonth(y, m);
  });

  function handleDayTap(dateStr) {
    if (mutation.current || !dateStr || dateStr < todayDate) return; // past - no-op

    if (rangeMode) {
      if (!rangeStart || (rangeStart && rangeEnd)) {
        setRangeStart(dateStr);
        setRangeEnd(null);
        setSelectedDate(dateStr);
      } else {
        if (dateStr < rangeStart) {
          setRangeEnd(rangeStart);
          setRangeStart(dateStr);
        } else {
          setRangeEnd(dateStr);
        }
        setSelectedDate(dateStr);
      }
      return;
    }

    setSelectedDate(prev => prev === dateStr ? null : dateStr);
    setRangeStart(null);
    setRangeEnd(null);
  }

  function resetForm() {
    setSelectedDate(null);
    setRangeStart(null);
    setRangeEnd(null);
    setBlockType('closed');
    setBlockReason('holiday');
    setBlockNote('');
    setBlockStartTime('10:00');
    setBlockEndTime('17:00');
  }

  async function handleSave() {
    const startDate = rangeMode ? (rangeStart || selectedDate) : selectedDate;
    const endDate = rangeMode && rangeEnd ? rangeEnd : null;
    if (!beautician || mutation.current || !startDate) return;
    if (blockType !== 'closed' && (!blockStartTime || !blockEndTime || blockEndTime <= blockStartTime)) {
      setError('Choose an end time after the start time.'); return;
    }
    mutation.current = true; setSaving(true); setError(null);
    try {
      const saved = await insertRow('hours_exceptions', {
        beautician_id: beautician.id, type: blockType, date: startDate, end_date: endDate,
        reason: blockReason, note: blockNote.trim() || null,
        start_time: blockType !== 'closed' ? blockStartTime : null,
        end_time: blockType !== 'closed' ? blockEndTime : null,
        notify_clients: false,
      });
      if (!saved?.id) throw new Error('Save was not confirmed');
      setExceptions(prev => [...prev, saved].sort((a,b) => a.date.localeCompare(b.date)));
      resetForm();
    } catch (err) {
      logger.error('Save exception error:', err);
      setError('Could not save this change. Your dates and note are still here. Try again.');
    } finally { mutation.current = false; setSaving(false); }
  }

  async function handleDelete(id) {
    if (mutation.current) return;
    mutation.current = true; setDeleting(id); setError(null);
    try {
      const { data, error: deleteError } = await supabase.from('hours_exceptions').delete().eq('id', id).eq('beautician_id', beautician.id).select('id');
      if (deleteError || !data?.some(row => row.id === id)) throw deleteError || new Error('Removal was not confirmed');
      setExceptions(prev => prev.filter(e => e.id !== id));
    } catch (err) {
      logger.error('Delete exception error:', err);
      setError('Could not remove this change. It is still in your availability. Try again.');
    } finally { mutation.current = false; setDeleting(null); }
  }

  const today = todayLocal();
  const upcoming = exceptions.filter(e => (e.end_date || e.date) >= today).sort((a,b) => a.date.localeCompare(b.date));
  const past = exceptions.filter(e => (e.end_date || e.date) < today).sort((a,b) => b.date.localeCompare(a.date));

  // Check if a date is in the current range selection highlight
  function isInRange(dateStr) {
    if (!rangeMode || !rangeStart || !rangeEnd) return false;
    return dateStr >= rangeStart && dateStr <= rangeEnd;
  }

  // Active date for the quick-block form
  const activeDate = rangeMode ? rangeStart : selectedDate;

  useEffect(() => {
    if (activeDate && (!rangeMode || rangeEnd)) panelRef.current?.scrollIntoView?.({ block: 'center' });
  }, [activeDate, rangeMode, rangeEnd]);

  if (loadError) return <MoreLoadError title="Availability" message={loadError} onRetry={loadData} />;

  return (
    <div style={S.page}>
      <PageHeader
        title="Availability"
        subtitle="Tap any future day to block it"
        action={upcoming.length > 0 ? (
          <div style={S.upcomingBubble}>
            <span style={S.upcomingNum}>{upcoming.length}</span>
            <span style={S.upcomingLbl}>upcoming</span>
          </div>
        ) : null}
      />

      {/* ── Next off card ── */}
      {upcoming.find(e => e.type === 'closed') && (() => {
        const next = upcoming.find(e => e.type === 'closed');
        return (
          <div style={S.nextCard}>
            <span style={S.nextTag}>Next time off</span>
            <span style={S.nextDate}>{formatRange(next.date, next.end_date)}</span>
            {next.note && <span style={S.nextNote}>{next.note}</span>}
            <span style={S.nextAway}>{daysAway(next.date)}</span>
          </div>
        );
      })()}

      {/* ── Range mode toggle ── */}
      <div style={S.rangeModeRow}>
        <span style={S.rangeModeLabel}>Holiday / multi-day block</span>
        <button
          disabled={saving || !!deleting}
          aria-label="Select a date range"
          aria-pressed={rangeMode}
          onClick={() => { setRangeMode(p => !p); setSelectedDate(null); setRangeStart(null); setRangeEnd(null); }}
          style={{ ...S.rangeToggle, background: rangeMode ? 'var(--accent, #92405e)' : 'var(--border-light, #ede7e3)' }}
        >
          <div style={{ ...S.rangeToggleDot, transform: rangeMode ? 'translateX(18px)' : 'translateX(2px)' }} />
        </button>
      </div>

      {rangeMode && (
        <div style={S.rangeHint}>
          {!rangeStart
            ? '👆 Tap your first day off'
            : !rangeEnd
            ? `📅 From ${formatShort(rangeStart)} - now tap the last day`
            : `✅ ${formatShort(rangeStart)} → ${formatShort(rangeEnd)}`}
        </div>
      )}

      {/* ── Calendar grid (3 months) ── */}
      {months.map(({ year, month, days }) => (
        <div key={`${year}-${month}`} style={S.monthBlock}>
          <div style={S.monthHeader}>{getMonthLabel(year, month)}</div>
          <div style={S.dayHeaders}>
            {['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(d => (
              <span key={d} style={S.dayHeaderCell}>{d}</span>
            ))}
          </div>
          <div style={S.calGrid}>
            {days.map((dateStr, i) => {
              if (!dateStr) return <div key={`pad-${i}`} />;
              const exc      = dateMap[dateStr];
              const isPast   = dateStr < todayDate;
              const isToday  = dateStr === todayDate;
              const isSel    = (!rangeMode && selectedDate === dateStr) || (rangeMode && (dateStr === rangeStart || dateStr === rangeEnd));
              const inRange  = isInRange(dateStr);
              const dayNum   = parseInt(dateStr.slice(8), 10);

              let bg = 'transparent';
              let textColor = isPast ? '#C8C3BE' : 'var(--text-primary, #241B17)';
              let border = 'none';
              let dotColor = null;

              if (exc) dotColor = TYPE_CFG[exc.type]?.dot || '#E57373';
              if (inRange) bg = '#FBE8EF';
              if (isSel)   { bg = 'var(--accent, #92405e)'; textColor = '#fff'; }
              if (isToday && !isSel) { border = '2px solid var(--accent, #92405e)'; }

              return (
                <button
                  key={dateStr}
                  onClick={() => handleDayTap(dateStr)}
                  aria-label={dateStr}
                  disabled={isPast || saving || !!deleting}
                  style={{ ...S.dayCell,
                    background: bg,
                    color: textColor,
                    border,
                    cursor: isPast ? 'default' : 'pointer',
                    opacity: isPast ? 0.35 : 1,
                  }}
                >
                  <span style={{ fontSize: 13, fontWeight: isToday ? 700 : 400 }}>{dayNum}</span>
                  {dotColor && !isSel && (
                    <div style={{ ...S.excDot, background: dotColor }} />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {/* ── Legend ── */}
      <div style={S.legend}>
        {Object.entries(TYPE_CFG).map(([k, v]) => (
          <div key={k} style={S.legendItem}>
            <div style={{ ...S.legendDot, background: v.dot }} />
            <span style={S.legendLabel}>{v.label}</span>
          </div>
        ))}
      </div>

      {/* ── Quick-block panel ── */}
      {(activeDate || (rangeMode && rangeStart && rangeEnd)) && (
        <div ref={panelRef} style={S.quickPanel}>
          <div style={S.quickPanelHeader}>
            <span style={S.quickPanelDate}>
              {rangeMode && rangeEnd
                ? `${formatShort(rangeStart)} → ${formatShort(rangeEnd)}`
                : formatShort(activeDate)}
            </span>
            <button disabled={saving || !!deleting} aria-label="Close date editor" onClick={resetForm} style={S.closeBtn}><Icon name="x" size={15} /></button>
          </div>

          {/* Type picker */}
          <div style={S.typeRow}>
            {Object.entries(TYPE_CFG).map(([k, v]) => (
              <button
                key={k}
                disabled={saving || !!deleting}
                onClick={() => setBlockType(k)}
                style={{ ...S.typeBtn,
                  background: blockType === k ? v.bg : 'var(--bg-card, #FFFCF9)',
                  borderColor: blockType === k ? v.color : 'var(--border-light, #ede7e3)',
                  color: blockType === k ? v.color : 'var(--text-muted)',
                }}
              >
                {v.label}
              </button>
            ))}
          </div>

          {/* Quick reason chips */}
          <div style={S.reasonRow}>
            {QUICK_REASONS.map(r => (
              <button
                key={r.value}
                disabled={saving || !!deleting}
                onClick={() => setBlockReason(r.value)}
                style={{ ...S.reasonChip,
                  background: blockReason === r.value ? '#2D2A26' : '#F5F2EF',
                  color: blockReason === r.value ? '#fff' : '#5A5550',
                }}
              >
                <Icon name={iconName(r.emoji)} inline /> {r.label}
              </button>
            ))}
          </div>

          {/* Times (only for amended/extended) */}
          {blockType !== 'closed' && (
            <div style={S.timeRow}>
              <div style={{ flex: 1 }}>
                <label style={S.timeLabel}>From</label>
                <input type="time" value={blockStartTime} onChange={e => setBlockStartTime(e.target.value)} style={S.timeInput} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={S.timeLabel}>Until</label>
                <input type="time" value={blockEndTime} onChange={e => setBlockEndTime(e.target.value)} style={S.timeInput} />
              </div>
            </div>
          )}

          {/* Note */}
          <input disabled={saving || !!deleting}
            type="text"
            placeholder="Note (optional - e.g. Tenerife ☀️)"
            value={blockNote}
            onChange={e => setBlockNote(e.target.value)}
            style={S.noteInput}
          />

          <p style={S.notifyHint}>Blocking dates does not message or move existing bookings. Review affected appointments in your calendar.</p>

          {/* Save */}
          <button onClick={handleSave} disabled={saving || !!deleting} style={S.saveBtn}>
            {saving ? 'Saving…' : `Block ${rangeMode && rangeEnd ? 'these days' : 'this day'}`}
          </button>
        </div>
      )}

      {error && <p role="alert" style={{ color: 'var(--danger, #9f3434)' }}>{error}</p>}

      {/* ── Upcoming exceptions ── */}
      <h3 style={S.sectionTitle}>Coming up ({upcoming.length})</h3>
      {loading ? (
        <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted, #6B5D54)', fontSize: 13 }}>Loading…</div>
      ) : upcoming.length === 0 ? (
        <div style={S.emptyCard}>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted, #6B5D54)' }}>
            No upcoming blocks - your regular hours are live.
          </p>
        </div>
      ) : (
        <div style={S.excList}>
          {upcoming.map(exc => {
            const cfg = TYPE_CFG[exc.type];
            return (
              <div key={exc.id} style={S.excCard}>
                <div style={{ ...S.excDotLarge, background: cfg.dot }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={S.excTopRow}>
                    <span style={S.excDate}>{formatRange(exc.date, exc.end_date)}</span>
                    <span style={{ ...S.excBadge, background: cfg.bg, color: cfg.color }}>{cfg.label}</span>
                  </div>
                  {exc.type !== 'closed' && exc.start_time && (
                    <span style={S.excTimes}>{exc.start_time} - {exc.end_time}</span>
                  )}
                  <div style={S.excMeta}>
                    <span style={S.excAway}>{daysAway(exc.date)}</span>
                    {exc.note && <span style={S.excNote}>{exc.note}</span>}
                  </div>
                </div>
                <Button variant="quiet" size="sm" disabled={saving || !!deleting} aria-label={`Remove ${formatRange(exc.date, exc.end_date)}`} onClick={() => handleDelete(exc.id)} style={S.deleteBtn}>{deleting === exc.id ? 'Removing…' : <Icon name="x" size={15} />}</Button>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Past (collapsed) ── */}
      {past.length > 0 && (
        <>
          <h3 style={{ ...S.sectionTitle, color: 'var(--text-muted, #6B5D54)', marginTop: 24 }}>Past ({past.length})</h3>
          <div style={S.excList}>
            {past.slice(0, 4).map(exc => (
              <div key={exc.id} style={{ ...S.excCard, opacity: 0.5 }}>
                <div style={{ ...S.excDotLarge, background: TYPE_CFG[exc.type]?.dot || '#ccc' }} />
                <div style={{ flex: 1 }}>
                  <span style={S.excDate}>{formatRange(exc.date, exc.end_date)}</span>
                  {exc.note && <span style={{ ...S.excNote, display: 'block', marginTop: 2 }}>{exc.note}</span>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────────────────────

const S = {
  page: {
    minHeight: 'var(--shell-viewport)',
    background: 'var(--bg, #FBF6F1)',
    fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif",
    padding: '0 16px var(--scroll-pad-bottom)',
    maxWidth: 480,
    margin: '0 auto',
    color: 'var(--text-primary, #241B17)',
  },


  upcomingBubble: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    background: 'var(--accent, #92405e)', borderRadius: 10,
    padding: '6px 12px', minWidth: 48,
  },
  upcomingNum: { fontSize: 18, fontWeight: 700, color: '#fff', lineHeight: 1 },
  upcomingLbl: { fontSize: 9, color: 'rgba(255,255,255,0.8)', textTransform: 'uppercase', letterSpacing: '0.04em' },

  // Next-off hero card
  nextCard: {
    background: 'linear-gradient(135deg, var(--accent, #92405e) 0%, #c9315d 100%)',
    borderRadius: 16, padding: '14px 16px', marginBottom: 14, color: '#fff',
  },
  nextTag:  { display: 'block', fontSize: 10, opacity: 0.8, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 },
  nextDate: { display: 'block', fontSize: 18, fontWeight: 700, marginBottom: 2 },
  nextNote: { display: 'block', fontSize: 13, opacity: 0.9, marginBottom: 2 },
  nextAway: { display: 'block', fontSize: 11, opacity: 0.7 },

  // Month navigation
  monthNav: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 8,
  },
  navArrow: {
    width: 36, height: 36, borderRadius: 10, border: 'none',
    background: '#F5F2EF', color: '#5A5550', fontSize: 20, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  monthRange: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary, #241B17)' },

  // Range mode
  rangeModeRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    background: 'var(--bg-card, #FFFCF9)', borderRadius: 10, padding: '10px 14px',
    marginBottom: 8, boxShadow: 'var(--elev-1)',
  },
  rangeModeLabel: { fontSize: 13, fontWeight: 500, color: 'var(--text-primary, #241B17)' },
  rangeToggle: {
    width: 44, height: 26, borderRadius: 16, border: 'none',
    cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0,
  },
  rangeToggleDot: {
    width: 22, height: 22, borderRadius: 10, background: 'var(--bg-card, #FFFCF9)',
    position: 'absolute', top: 2, transition: 'transform 0.2s',
    boxShadow: 'var(--elev-1)',
  },
  rangeHint: {
    fontSize: 13, color: 'var(--accent, #92405e)', fontWeight: 500,
    padding: '6px 12px', background: '#FBF0F3', borderRadius: 10,
    marginBottom: 10, textAlign: 'center',
  },

  // Calendar month block
  monthBlock: { marginBottom: 16 },
  monthHeader: {
    fontSize: 13, fontWeight: 600, color: '#5A5550',
    textTransform: 'uppercase', letterSpacing: '0.06em',
    marginBottom: 6,
  },
  dayHeaders: {
    display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)',
    marginBottom: 4,
  },
  dayHeaderCell: {
    textAlign: 'center', fontSize: 10, fontWeight: 600,
    color: 'var(--text-muted, #6B5D54)', textTransform: 'uppercase', letterSpacing: '0.04em',
  },
  calGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2,
  },
  dayCell: {
    aspectRatio: '1', borderRadius: 10, display: 'flex',
    flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer', fontFamily: 'inherit', position: 'relative',
    transition: 'background 0.15s, color 0.15s',
    minWidth: 0,
  },
  excDot: {
    width: 4, height: 4, borderRadius: 'var(--radius-xs)', marginTop: 1,
  },

  // Legend
  legend: {
    display: 'flex', gap: 14, flexWrap: 'wrap',
    padding: '10px 0', marginBottom: 8,
  },
  legendItem: { display: 'flex', alignItems: 'center', gap: 5 },
  legendDot: { width: 8, height: 8, borderRadius: 'var(--radius-xs)' },
  legendLabel: { fontSize: 11, color: 'var(--text-muted)' },

  // Quick-block panel
  quickPanel: {
    background: 'var(--bg-card, #FFFCF9)',
    borderRadius: 16, padding: 16,
    boxShadow: 'var(--elev-2)',
    marginBottom: 20, border: '1.5px solid #F0ECE8',
  },
  quickPanelHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 12,
  },
  quickPanelDate: { fontSize: 15, fontWeight: 700, color: 'var(--text-primary, #241B17)' },
  closeBtn: {
    width: 28, height: 28, borderRadius: 16, border: 'none',
    background: '#F5F2EF', color: 'var(--text-muted)', fontSize: 12,
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
  },

  typeRow: { display: 'flex', gap: 6, marginBottom: 12 },
  typeBtn: {
    flex: 1, padding: '8px 4px', borderRadius: 10, border: '1.5px solid',
    fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
    transition: 'all 0.15s',
  },

  reasonRow: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
  reasonChip: {
    padding: '6px 10px', borderRadius: 10, border: 'none',
    fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
    transition: 'all 0.15s',
  },

  timeRow: { display: 'flex', gap: 10, marginBottom: 12 },
  timeLabel: { display: 'block', fontSize: 11, color: 'var(--text-muted, #6B5D54)', marginBottom: 4 },
  timeInput: {
    width: '100%', padding: '9px 10px', borderRadius: 10,
    border: '1.5px solid var(--border-light, #ede7e3)', fontSize: 14, fontFamily: 'inherit',
    outline: 'none', boxSizing: 'border-box',
  },

  noteInput: {
    width: '100%', padding: '10px 12px', borderRadius: 10,
    border: '1.5px solid var(--border-light, #ede7e3)', fontSize: 13, fontFamily: 'inherit',
    outline: 'none', boxSizing: 'border-box', marginBottom: 12,
    color: 'var(--text-primary, #241B17)',
  },

  notifyRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '8px 0', marginBottom: 12,
  },
  notifyLabel: { display: 'block', fontSize: 13, fontWeight: 500, color: 'var(--text-primary, #241B17)' },
  notifyHint:  { display: 'block', fontSize: 11, color: 'var(--text-muted, #6B5D54)', marginTop: 2 },
  toggle: {
    width: 44, height: 26, borderRadius: 16, border: 'none',
    cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0,
  },
  toggleDot: {
    width: 22, height: 22, borderRadius: 10, background: 'var(--bg-card, #FFFCF9)',
    position: 'absolute', top: 2, transition: 'transform 0.2s',
    boxShadow: 'var(--elev-1)',
  },

  saveBtn: {
    width: '100%', padding: '13px 0', borderRadius: 10, border: 'none',
    background: 'var(--accent, #92405e)', color: '#fff', fontSize: 14, fontWeight: 700,
    cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '0.01em',
  },

  // Exceptions list
  sectionTitle: {
    fontSize: 14, fontWeight: 600, margin: '20px 0 10px',
    color: 'var(--text-primary, #241B17)',
  },
  excList: { display: 'flex', flexDirection: 'column', gap: 8 },
  excCard: {
    display: 'flex', alignItems: 'center', gap: 12,
    background: 'var(--bg-card, #FFFCF9)', borderRadius: 10, padding: '12px 12px',
    boxShadow: 'var(--elev-1)',
  },
  excDotLarge: { width: 10, height: 10, borderRadius: 'var(--radius-xs)', flexShrink: 0 },
  excTopRow:   { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 },
  excDate:     { fontSize: 13, fontWeight: 600, color: 'var(--text-primary, #241B17)' },
  excBadge:    { padding: '2px 7px', borderRadius: 'var(--radius-xs)', fontSize: 10, fontWeight: 600, flexShrink: 0 },
  excTimes:    { display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 },
  excMeta:     { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  excAway:     { fontSize: 11, color: 'var(--text-muted, #6B5D54)' },
  excNote:     { fontSize: 12, color: 'var(--text-muted)' },
  notifyTag:   { display: 'block', fontSize: 10, color: 'var(--success, #386F52)', marginTop: 3 },
  deleteBtn: {
    width: 26, height: 26, borderRadius: 16, border: 'none',
    background: 'var(--danger-bg, #F7E4E4)', color: '#bb2323', fontSize: 12, flexShrink: 0,
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
  },

  emptyCard: {
    background: 'var(--bg-card, #FFFCF9)', borderRadius: 10, padding: '20px 16px',
    textAlign: 'center', boxShadow: 'var(--elev-1)',
  },
};
