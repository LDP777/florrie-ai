import { useState, useEffect, useCallback } from 'react';
import { useBeautician, supabase, insertRow, deleteRow } from '../lib/supabase.js';
import logger from '../lib/logger.js';

/**
 * Availability Planner â forward-looking calendar for blocking days / changing hours.
 *
 * Layout:
 *   1. 3-month scrollable calendar grid â tap any future day to act on it
 *   2. Inline quick-block panel â appears below tapped date
 *   3. Upcoming exceptions list
 *
 * Backend: POST/DELETE /api/hours-exceptions (hours-exceptions.js route)
 * Types: closed | amended | extended
 * Reasons: holiday | sick | personal | training | bank_holiday | event | other
 */

const QUICK_REASONS = [
  { value: 'holiday',      label: 'Holiday',   emoji: 'ðï¸' },
  { value: 'personal',     label: 'Personal',  emoji: 'ð ' },
  { value: 'sick',         label: 'Sick day',  emoji: 'ð¤' },
  { value: 'training',     label: 'Training',  emoji: 'ð' },
  { value: 'bank_holiday', label: 'Bank hol',  emoji: 'ð' },
  { value: 'event',        label: 'Event',     emoji: 'â¨' },
  { value: 'other',        label: 'Other',     emoji: 'ð' },
];

const TYPE_CFG = {
  closed:   { label: 'Day off',        color: '#E57373', bg: '#FEF2F2', dot: '#E57373' },
  amended:  { label: 'Changed hours',  color: '#F59E0B', bg: '#FFF8E1', dot: '#F59E0B' },
  extended: { label: 'Extra hours',    color: '#5BA97B', bg: '#E8F5E9', dot: '#5BA97B' },
};


// ââ date helpers ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function toYMD(d) {
  return d.toISOString().slice(0, 10);
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
    return `${s.getDate()} â ${e.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
  }
  return `${formatShort(start)} â ${formatShort(end)}`;
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

// Build a map: dateStr â exception (for quick lookup)
function buildDateMap(exceptions) {
  const map = {};
  exceptions.forEach(exc => {
    expandException(exc).forEach(d => {
      if (!map[d]) map[d] = exc;
    });
  });
  return map;
}

// ââ calendar grid builder ââââââââââââââââââââââââââââââââââââââââââââââââââââ

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

// ââ main component ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

export default function HoursExceptions() {
  const { beautician } = useBeautician();
  const [exceptions, setExceptions]   = useState([]);
  const [loading, setLoading]         = useState(true);
  const [saving, setSaving]           = useState(false);

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
  const [notifyClients, setNotifyClients]   = useState(true);

  useEffect(() => { if (beautician) loadData(); }, [beautician]);

  async function loadData() {
    setLoading(true);
    try {
        const { data } = await supabase
          .from('hours_exceptions')
          .select('*')
          .eq('beautician_id', beautician.id)
          .order('date', { ascending: true });
        setExceptions(data || []);
    } catch (err) {
      logger.error('Load exceptions error:', err);
      setExceptions([]);
    } finally {
      setLoading(false);
    }
  }

  const dateMap = buildDateMap(exceptions);

  // Which 3 months to show
  const months = [0, 1, 2].map(offset => {
    let m = baseMonth.month + offset;
    let y = baseMonth.year;
    while (m > 11) { m -= 12; y += 1; }
    return buildMonth(y, m);
  });

  function handleDayTap(dateStr) {
    if (!dateStr || dateStr < todayDate) return; // past â no-op

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
    setNotifyClients(true);
  }

  async function handleSave() {
    const startDate = rangeMode ? (rangeStart || selectedDate) : selectedDate;
    const endDate   = rangeMode && rangeEnd ? rangeEnd : null;
    if (!startDate) return;

    setSaving(true);
    const exc = {
      id: crypto.randomUUID(),
      type: blockType,
      date: startDate,
      end_date: endDate,
      reason: blockReason,
      note: blockNote.trim() || null,
      start_time:    blockType !== 'closed' ? blockStartTime : null,
      end_time:      blockType !== 'closed' ? blockEndTime   : null,
      notify_clients: notifyClients,
      created_at: new Date().toISOString(),
    };

    if (beautician) {
      try {
        const saved = await insertRow('hours_exceptions', { beautician_id: beautician.id, ...exc });
        exc.id = saved.id;
      } catch (err) {
        logger.error('Save exception error:', err);
      }
    }

    setExceptions(prev => [...prev, exc].sort((a, b) => a.date.localeCompare(b.date)));
    resetForm();
    setSaving(false);
  }

  async function handleDelete(id) {
    setExceptions(prev => prev.filter(e => e.id !== id));
    if (true) {
      try { await deleteRow('hours_exceptions', id); } catch {}
    }
  }

  const today = new Date().toISOString().split('T')[0];
  const upcoming = exceptions.filter(e => e.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const past     = exceptions.filter(e => e.date < today).sort((a, b) => b.date.localeCompare(a.date));

  // Check if a date is in the current range selection highlight
  function isInRange(dateStr) {
    if (!rangeMode || !rangeStart || !rangeEnd) return false;
    return dateStr >= rangeStart && dateStr <= rangeEnd;
  }

  // Active date for the quick-block form
  const activeDate = rangeMode ? rangeStart : selectedDate;

  return (
    <div style={S.page}>
      {/* ââ Header ââ */}
      <div style={S.header}>
        <div>
          <h1 style={S.title}>Availability</h1>
          <p style={S.subtitle}>Tap any future day to block it</p>
        </div>
        {upcoming.length > 0 && (
          <div style={S.upcomingBubble}>
            <span style={S.upcomingNum}>{upcoming.length}</span>
            <span style={S.upcomingLbl}>upcoming</span>
          </div>
        )}
      </div>

      {/* ââ Next off card ââ */}
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

      {/* ââ Month navigator ââ */}
      <div style={S.monthNav}>
        <button style={S.navArrow} onClick={() => setBaseMonth(p => {
          let m = p.month - 1; let y = p.year;
          if (m < 0) { m = 11; y -= 1; }
          // Don't go before current month
          const thisYear = new Date().getFullYear();
          const thisMonth = new Date().getMonth();
          if (y < thisYear || (y === thisYear && m < thisMonth)) return p;
          return { year: y, month: m };
        })}>â¹</button>
        <span style={S.monthRange}>
          {getMonthLabel(months[0].year, months[0].month)} â {getMonthLabel(months[2].year, months[2].month)}
        </span>
        <button style={S.navArrow} onClick={() => setBaseMonth(p => {
          let m = p.month + 1; let y = p.year;
          if (m > 11) { m = 0; y += 1; }
          return { year: y, month: m };
        })}>âº</button>
      </div>

      {/* ââ Range mode toggle ââ */}
      <div style={S.rangeModeRow}>
        <span style={S.rangeModeLabel}>Holiday / multi-day block</span>
        <button
          onClick={() => { setRangeMode(p => !p); setSelectedDate(null); setRangeStart(null); setRangeEnd(null); }}
          style={{ ...S.rangeToggle, background: rangeMode ? 'var(--accent, #C76B8A)' : '#EDE9E4' }}
        >
          <div style={{ ...S.rangeToggleDot, transform: rangeMode ? 'translateX(18px)' : 'translateX(2px)' }} />
        </button>
      </div>

      {rangeMode && (
        <div style={S.rangeHint}>
          {!rangeStart
            ? 'ð Tap your first day off'
            : !rangeEnd
            ? `ð From ${formatShort(rangeStart)} â now tap the last day`
            : `â ${formatShort(rangeStart)} â ${formatShort(rangeEnd)}`}
        </div>
      )}

      {/* ââ Calendar grid (3 months) ââ */}
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
              let textColor = isPast ? '#C8C3BE' : '#2D2A26';
              let border = 'none';
              let dotColor = null;

              if (exc) dotColor = TYPE_CFG[exc.type]?.dot || '#E57373';
              if (inRange) bg = '#FBE8EF';
              if (isSel)   { bg = 'var(--accent, #C76B8A)'; textColor = '#fff'; }
              if (isToday && !isSel) { border = '2px solid var(--accent, #C76B8A)'; }

              return (
                <button
                  key={dateStr}
                  onClick={() => handleDayTap(dateStr)}
                  disabled={isPast}
                  style={{
                    ...S.dayCell,
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

      {/* ââ Legend ââ */}
      <div style={S.legend}>
        {Object.entries(TYPE_CFG).map(([k, v]) => (
          <div key={k} style={S.legendItem}>
            <div style={{ ...S.legendDot, background: v.dot }} />
            <span style={S.legendLabel}>{v.label}</span>
          </div>
        ))}
      </div>

      {/* ââ Quick-block panel ââ */}
      {(activeDate || (rangeMode && rangeStart && rangeEnd)) && (
        <div style={S.quickPanel}>
          <div style={S.quickPanelHeader}>
            <span style={S.quickPanelDate}>
              {rangeMode && rangeEnd
                ? `${formatShort(rangeStart)} â ${formatShort(rangeEnd)}`
                : formatShort(activeDate)}
            </span>
            <button onClick={resetForm} style={S.closeBtn}>â</button>
          </div>

          {/* Type picker */}
          <div style={S.typeRow}>
            {Object.entries(TYPE_CFG).map(([k, v]) => (
              <button
                key={k}
                onClick={() => setBlockType(k)}
                style={{
                  ...S.typeBtn,
                  background: blockType === k ? v.bg : 'var(--bg-card, #fff)',
                  borderColor: blockType === k ? v.color : '#EDE9E4',
                  color: blockType === k ? v.color : '#8A8580',
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
                onClick={() => setBlockReason(r.value)}
                style={{
                  ...S.reasonChip,
                  background: blockReason === r.value ? '#2D2A26' : '#F5F2EF',
                  color: blockReason === r.value ? '#fff' : '#5A5550',
                }}
              >
                {r.emoji} {r.label}
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
          <input
            type="text"
            placeholder="Note (optional â e.g. Tenerife âï¸)"
            value={blockNote}
            onChange={e => setBlockNote(e.target.value)}
            style={S.noteInput}
          />

          {/* Notify toggle */}
          <div style={S.notifyRow}>
            <div>
              <span style={S.notifyLabel}>Notify affected clients</span>
              <span style={S.notifyHint}>florrie.ai will message anyone booked on these dates</span>
            </div>
            <button
              onClick={() => setNotifyClients(p => !p)}
              style={{ ...S.toggle, background: notifyClients ? 'var(--accent, #C76B8A)' : '#EDE9E4' }}
            >
              <div style={{ ...S.toggleDot, transform: notifyClients ? 'translateX(18px)' : 'translateX(2px)' }} />
            </button>
          </div>

          {/* Save */}
          <button onClick={handleSave} disabled={saving} style={S.saveBtn}>
            {saving ? 'Savingâ¦' : `Block ${rangeMode && rangeEnd ? 'these days' : 'this day'}`}
          </button>
        </div>
      )}

      {/* ââ Upcoming exceptions ââ */}
      <h3 style={S.sectionTitle}>Coming up ({upcoming.length})</h3>
      {loading ? (
        <div style={{ textAlign: 'center', padding: 32, color: '#B5AFA8', fontSize: 13 }}>Loadingâ¦</div>
      ) : upcoming.length === 0 ? (
        <div style={S.emptyCard}>
          <p style={{ margin: 0, fontSize: 13, color: '#B5AFA8' }}>
            No upcoming blocks â your regular hours are live.
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
                    <span style={S.excTimes}>{exc.start_time} â {exc.end_time}</span>
                  )}
                  <div style={S.excMeta}>
                    <span style={S.excAway}>{daysAway(exc.date)}</span>
                    {exc.note && <span style={S.excNote}>{exc.note}</span>}
                  </div>
                  {exc.notify_clients && (
                    <span style={S.notifyTag}>Clients notified â</span>
                  )}
                </div>
                <button onClick={() => handleDelete(exc.id)} style={S.deleteBtn}>â</button>
              </div>
            );
          })}
        </div>
      )}

      {/* ââ Past (collapsed) ââ */}
      {past.length > 0 && (
        <>
          <h3 style={{ ...S.sectionTitle, color: '#B5AFA8', marginTop: 24 }}>Past ({past.length})</h3>
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

// ââ styles ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

const S = {
  page: {
    minHeight: '100vh',
    background: 'var(--bg, #FAF8F5)',
    fontFamily: '"DM Sans", -apple-system, sans-serif',
    padding: '0 16px 60px',
    maxWidth: 480,
    margin: '0 auto',
    color: 'var(--text-primary, #2D2A26)',
  },

  header: {
    paddingTop: 28,
    paddingBottom: 12,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  title:    { fontSize: 22, fontWeight: 700, margin: '0 0 2px' },
  subtitle: { fontSize: 13, color: 'var(--accent, #C76B8A)', margin: 0, fontWeight: 500 },

  upcomingBubble: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    background: 'var(--accent, #C76B8A)', borderRadius: 12,
    padding: '6px 12px', minWidth: 48,
  },
  upcomingNum: { fontSize: 18, fontWeight: 700, color: '#fff', lineHeight: 1 },
  upcomingLbl: { fontSize: 9, color: 'rgba(255,255,255,0.8)', textTransform: 'uppercase', letterSpacing: '0.04em' },

  // Next-off hero card
  nextCard: {
    background: 'linear-gradient(135deg, var(--accent, #C76B8A) 0%, #E8A0B5 100%)',
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
  monthRange: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary, #2D2A26)' },

  // Range mode
  rangeModeRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    background: 'var(--bg-card, #fff)', borderRadius: 12, padding: '10px 14px',
    marginBottom: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
  },
  rangeModeLabel: { fontSize: 13, fontWeight: 500, color: 'var(--text-primary, #2D2A26)' },
  rangeToggle: {
    width: 44, height: 26, borderRadius: 13, border: 'none',
    cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0,
  },
  rangeToggleDot: {
    width: 22, height: 22, borderRadius: 11, background: '#fff',
    position: 'absolute', top: 2, transition: 'transform 0.2s',
    boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
  },
  rangeHint: {
    fontSize: 13, color: 'var(--accent, #C76B8A)', fontWeight: 500,
    padding: '6px 12px', background: '#FBF0F3', borderRadius: 8,
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
    color: '#B5AFA8', textTransform: 'uppercase', letterSpacing: '0.04em',
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
    width: 4, height: 4, borderRadius: 2, marginTop: 1,
  },

  // Legend
  legend: {
    display: 'flex', gap: 14, flexWrap: 'wrap',
    padding: '10px 0', marginBottom: 8,
  },
  legendItem: { display: 'flex', alignItems: 'center', gap: 5 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendLabel: { fontSize: 11, color: '#8A8580' },

  // Quick-block panel
  quickPanel: {
    background: 'var(--bg-card, #fff)',
    borderRadius: 16, padding: 16,
    boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
    marginBottom: 20, border: '1.5px solid #F0ECE8',
  },
  quickPanelHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 12,
  },
  quickPanelDate: { fontSize: 15, fontWeight: 700, color: 'var(--text-primary, #2D2A26)' },
  closeBtn: {
    width: 28, height: 28, borderRadius: 14, border: 'none',
    background: '#F5F2EF', color: '#8A8580', fontSize: 12,
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
    padding: '6px 10px', borderRadius: 8, border: 'none',
    fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
    transition: 'all 0.15s',
  },

  timeRow: { display: 'flex', gap: 10, marginBottom: 12 },
  timeLabel: { display: 'block', fontSize: 11, color: '#B5AFA8', marginBottom: 4 },
  timeInput: {
    width: '100%', padding: '9px 10px', borderRadius: 8,
    border: '1.5px solid #EDE9E4', fontSize: 14, fontFamily: 'inherit',
    outline: 'none', boxSizing: 'border-box',
  },

  noteInput: {
    width: '100%', padding: '10px 12px', borderRadius: 8,
    border: '1.5px solid #EDE9E4', fontSize: 13, fontFamily: 'inherit',
    outline: 'none', boxSizing: 'border-box', marginBottom: 12,
    color: 'var(--text-primary, #2D2A26)',
  },

  notifyRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '8px 0', marginBottom: 12,
  },
  notifyLabel: { display: 'block', fontSize: 13, fontWeight: 500, color: 'var(--text-primary, #2D2A26)' },
  notifyHint:  { display: 'block', fontSize: 11, color: '#B5AFA8', marginTop: 2 },
  toggle: {
    width: 44, height: 26, borderRadius: 13, border: 'none',
    cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0,
  },
  toggleDot: {
    width: 22, height: 22, borderRadius: 11, background: '#fff',
    position: 'absolute', top: 2, transition: 'transform 0.2s',
    boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
  },

  saveBtn: {
    width: '100%', padding: '13px 0', borderRadius: 12, border: 'none',
    background: 'var(--accent, #C76B8A)', color: '#fff', fontSize: 14, fontWeight: 700,
    cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '0.01em',
  },

  // Exceptions list
  sectionTitle: {
    fontSize: 14, fontWeight: 600, margin: '20px 0 10px',
    color: 'var(--text-primary, #2D2A26)',
  },
  excList: { display: 'flex', flexDirection: 'column', gap: 8 },
  excCard: {
    display: 'flex', alignItems: 'center', gap: 12,
    background: 'var(--bg-card, #fff)', borderRadius: 12, padding: '12px 12px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
  },
  excDotLarge: { width: 10, height: 10, borderRadius: 5, flexShrink: 0 },
  excTopRow:   { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 },
  excDate:     { fontSize: 13, fontWeight: 600, color: 'var(--text-primary, #2D2A26)' },
  excBadge:    { padding: '2px 7px', borderRadius: 5, fontSize: 10, fontWeight: 600, flexShrink: 0 },
  excTimes:    { display: 'block', fontSize: 11, color: '#8A8580', marginBottom: 2 },
  excMeta:     { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  excAway:     { fontSize: 11, color: '#B5AFA8' },
  excNote:     { fontSize: 12, color: '#8A8580' },
  notifyTag:   { display: 'block', fontSize: 10, color: '#5BA97B', marginTop: 3 },
  deleteBtn: {
    width: 26, height: 26, borderRadius: 13, border: 'none',
    background: '#FEF2F2', color: '#E57373', fontSize: 12, flexShrink: 0,
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
  },

  emptyCard: {
    background: 'var(--bg-card, #fff)', borderRadius: 12, padding: '20px 16px',
    textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
  },
};
