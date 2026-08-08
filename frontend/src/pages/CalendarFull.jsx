import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBeautician, supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import { treatmentColor, tint } from '../lib/treatmentColors.js';
import { localDateStr, todayLocal, parseDateOnly } from '../lib/dates.js';
import Icon, { iconName } from '../components/ui/Icon';

/**
 * CalendarFull , a dedicated full-width calendar page (/calendar/full).
 *
 * Two views: a WEEK grid (time down the side, 7 days across, appointments placed
 * in their slots and coloured by treatment) and a MONTH overview (each day cell
 * shows its booking count + coloured dots; tap a day to open that week).
 *
 * It reuses the wall-clock time handling and colour logic from CalendarView,
 * deliberately not reinventing any of it: appointments are stored wall-clock
 * (ISO without a Z), so every time read is a plain string slice and every
 * date decision goes through lib/dates.js.
 */

const HOUR_HEIGHT = 56;       // px per hour in the week grid
const START_HOUR = 7;
const END_HOUR = 21;
const DEAD_STATUSES = ['cancelled', 'cancelled_by_client', 'cancelled_by_beautician', 'no_show'];

const C = {
  accent: 'var(--accent)',
  bg: 'var(--bg)',
  card: 'var(--bg-card)',
  text: 'var(--text-primary)',
  muted: 'var(--text-muted, #6B5D54)',   // was #78716b, 4.3:1 on cream
  line: 'rgba(146, 64, 94, 0.12)',
  lineSoft: 'rgba(146, 64, 94, 0.07)',
};

/** Wall-clock minutes since midnight from the stored string. */
function wallMinutes(isoish) {
  const s = String(isoish || '');
  const h = parseInt(s.slice(11, 13), 10);
  const m = parseInt(s.slice(14, 16), 10);
  if (isNaN(h) || isNaN(m)) {
    const d = new Date(isoish);
    return d.getUTCHours() * 60 + d.getUTCMinutes(); // UTC frame IS the wall clock
  }
  return h * 60 + m;
}

/** "14:00" from the stored wall-clock string. */
function wallTime(isoish) {
  const t = String(isoish || '').slice(11, 16);
  return /^\d{2}:\d{2}$/.test(t) ? t : '';
}

/** Monday-start week beginning for a Date. */
function weekStart(d) {
  const s = new Date(d);
  const day = s.getDay();
  s.setHours(12, 0, 0, 0);
  s.setDate(s.getDate() + (day === 0 ? -6 : 1 - day));
  return s;
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function addMonths(d, n) { const x = new Date(d); x.setHours(12, 0, 0, 0); x.setMonth(x.getMonth() + n); return x; }
function sameDay(a, b) { return localDateStr(a) === localDateStr(b); }

/**
 * Greedy column layout for one day's appointments inside the week grid, so
 * overlapping bookings sit side by side instead of stacking on top of each other.
 */
function layoutDay(appts) {
  const rects = appts
    .map(a => {
      const startMin = wallMinutes(a.starts_at);
      const endMin = Math.max(a.ends_at ? wallMinutes(a.ends_at) : startMin + 30, startMin + 15);
      const top = ((startMin - START_HOUR * 60) / 60) * HOUR_HEIGHT;
      const height = Math.max(((endMin - startMin) / 60) * HOUR_HEIGHT, 20);
      return { a, top, height, bottom: top + height, col: 0, cols: 1 };
    })
    .sort((x, y) => x.top - y.top || y.height - x.height);

  let cluster = [];
  let clusterBottom = -Infinity;
  const flush = () => {
    if (!cluster.length) return;
    const colBottoms = [];
    for (const r of cluster) {
      let placed = false;
      for (let c = 0; c < colBottoms.length; c++) {
        if (colBottoms[c] <= r.top + 1) { r.col = c; colBottoms[c] = r.bottom; placed = true; break; }
      }
      if (!placed) { r.col = colBottoms.length; colBottoms.push(r.bottom); }
    }
    for (const r of cluster) r.cols = colBottoms.length;
    cluster = [];
  };
  for (const r of rects) {
    if (r.top >= clusterBottom - 1) flush();
    cluster.push(r);
    clusterBottom = Math.max(clusterBottom, r.bottom);
  }
  flush();
  return rects;
}

export default function CalendarFull() {
  const navigate = useNavigate();
  const { beautician, loading: bLoading } = useBeautician();
  const [view, setView] = useState('week'); // 'week' | 'month'
  const [anchor, setAnchor] = useState(() => { const d = new Date(); d.setHours(12, 0, 0, 0); return d; });
  const [appts, setAppts] = useState([]);
  const [blocks, setBlocks] = useState([]); // hours_exceptions: closed days + blocked hours
  const [loading, setLoading] = useState(true);
  const [syncOpen, setSyncOpen] = useState(false);

  // Range to fetch: the visible month padded out to whole weeks (covers the
  // week view too, since any week we land on overlaps this padded month).
  const range = useMemo(() => {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1, 12);
    const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0, 12);
    const from = weekStart(first);
    const to = addDays(weekStart(last), 13); // pad two weeks forward to be safe
    return { from, to };
  }, [anchor]);

  const loadAppointments = useCallback(async () => {
    if (!beautician?.id) return;
    setLoading(true);
    try {
      const fromStr = localDateStr(range.from);
      const toStr = localDateStr(range.to);
      const { data, error } = await supabase
        .from('appointments')
        .select('*, clients(first_name, last_name), treatments(name, price_cents, color, sort_order)')
        .eq('beautician_id', beautician.id)
        .gte('starts_at', `${fromStr}T00:00:00`)
        .lte('starts_at', `${toStr}T23:59:59`)
        .order('starts_at');
      if (error) logger.error('CalendarFull load:', error);
      setAppts(data || []);

      // Blocked time: without this the full calendar looked OPEN on days
      // Ellie had blocked off. Same source as the day view.
      try {
        const token = (await supabase.auth.getSession()).data.session?.access_token;
        const bres = await fetch(`${API_BASE}/api/hours-exceptions`, { headers: { Authorization: `Bearer ${token}` } });
        if (bres.ok) {
          const bdata = await bres.json();
          setBlocks((bdata.exceptions || []).filter(b => b.date >= fromStr && b.date <= toStr));
        }
      } catch { /* blocks are supplementary; appointments still render */ }
    } catch (err) {
      logger.error('CalendarFull load error:', err);
    } finally {
      setLoading(false);
    }
  }, [beautician?.id, range.from, range.to]);

  useEffect(() => { loadAppointments(); }, [loadAppointments]);

  const liveAppts = useMemo(() => appts.filter(a => !DEAD_STATUSES.includes(a.status)), [appts]);

  function apptsOn(dateStr) {
    return liveAppts.filter(a => String(a.starts_at || '').startsWith(dateStr));
  }

  function blocksOn(dateStr) {
    return blocks.filter(b => b.date === dateStr);
  }

  // ---- navigation ----
  function prev() { setAnchor(a => view === 'week' ? addDays(a, -7) : addMonths(a, -1)); }
  function next() { setAnchor(a => view === 'week' ? addDays(a, 7) : addMonths(a, 1)); }
  function goToday() { const d = new Date(); d.setHours(12, 0, 0, 0); setAnchor(d); }

  const days = useMemo(() => {
    const start = weekStart(anchor);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [anchor]);

  const monthLabel = anchor.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const weekLabel = `${days[0].toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} , ${days[6].toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;

  function handlePrint() { window.print(); }

  return (
    <div style={S.page}>
      <PrintStyles />
      {/* ===== Header ===== */}
      <header style={S.header} className="cf-noprint">
        <div style={S.headerLeft}>
          <button onClick={() => navigate('/calendar')} title="Back" aria-label="Back" style={S.iconBtn}>
            <Icon name={iconName('arrow_back')} size={20} inline />
          </button>
          <h1 style={S.title}>Calendar</h1>
        </div>
        <div style={S.headerActions}>
          <button onClick={() => setSyncOpen(true)} style={S.ghostBtn}>
            <Icon name={iconName('sync')} size={17} inline />
            <span style={S.btnLabel}>Sync to my calendar</span>
          </button>
          <button onClick={handlePrint} style={S.ghostBtn}>
            <Icon name={iconName('print')} size={17} inline />
            <span style={S.btnLabel}>Print or save PDF</span>
          </button>
        </div>
      </header>

      {/* ===== Toolbar ===== */}
      <div style={S.toolbar} className="cf-noprint">
        <div style={S.navGroup}>
          <button onClick={prev} style={S.navBtn} aria-label="Previous">‹</button>
          <button onClick={goToday} style={S.todayBtn}>Today</button>
          <button onClick={next} style={S.navBtn} aria-label="Next">›</button>
          <span style={S.rangeLabel}>{view === 'week' ? weekLabel : monthLabel}</span>
        </div>
        <div style={S.viewToggle}>
          <button onClick={() => setView('week')} style={{ ...S.toggleBtn, ...(view === 'week' ? S.toggleOn : {}) }}>Week</button>
          <button onClick={() => setView('month')} style={{ ...S.toggleBtn, ...(view === 'month' ? S.toggleOn : {}) }}>Month</button>
        </div>
      </div>

      {/* Print heading (only visible on paper) */}
      <div className="cf-printonly" style={S.printHead}>
        <div style={S.printBrand}>{beautician?.business_name || beautician?.first_name || 'Florrie'}</div>
        <div style={S.printRange}>{view === 'week' ? weekLabel : monthLabel}</div>
      </div>

      {loading && <div style={S.loading} className="cf-noprint">Loading your diary…</div>}

      {view === 'week'
        ? <WeekGrid days={days} apptsOn={apptsOn} blocksOn={blocksOn} onPickDay={(d) => { setAnchor(d); }} onOpenAppt={(a) => navigate(`/calendar/week?date=${localDateStr(new Date(String(a.starts_at).slice(0, 10) + 'T12:00:00'))}&appt=${a.id}`)} />
        : <MonthGrid anchor={anchor} apptsOn={apptsOn} blocksOn={blocksOn} onPickDay={(d) => navigate(`/calendar/week?date=${localDateStr(d)}&view=day`)} />}

      {syncOpen && <SyncPanel onClose={() => setSyncOpen(false)} />}
    </div>
  );
}

/* ============================ WEEK GRID ============================ */
function WeekGrid({ days, apptsOn, blocksOn = () => [], onPickDay, onOpenAppt = () => {} }) {
  const hours = Array.from({ length: END_HOUR - START_HOUR + 1 }, (_, i) => START_HOUR + i);
  const gridHeight = (END_HOUR - START_HOUR) * HOUR_HEIGHT;
  const todayStr = todayLocal();

  return (
    <div style={S.weekWrap} className="cf-weekgrid">
      {/* Day header row */}
      <div style={S.weekHeadRow}>
        <div style={S.weekHeadSpacer} />
        {days.map(d => {
          const ds = localDateStr(d);
          const isToday = ds === todayStr;
          return (
            <button key={ds} onClick={() => onPickDay(d)} style={{ ...S.weekHeadCell, ...(isToday ? S.weekHeadToday : {}) }}>
              <span style={S.weekHeadDow}>{d.toLocaleDateString('en-GB', { weekday: 'short' })}</span>
              <span style={{ ...S.weekHeadNum, ...(isToday ? S.weekHeadNumToday : {}) }}>{d.getDate()}</span>
            </button>
          );
        })}
      </div>

      {/* Scrollable grid body */}
      <div style={S.weekBody}>
        <div style={{ ...S.weekGridInner, height: gridHeight }}>
          {/* time gutter */}
          <div style={{ ...S.timeCol, height: gridHeight }}>
            {hours.map((h, i) => (
              <div key={h} style={{ ...S.timeLabel, top: i * HOUR_HEIGHT }}>{String(h).padStart(2, '0')}:00</div>
            ))}
          </div>
          {/* day columns */}
          {days.map(d => {
            const ds = localDateStr(d);
            const rects = layoutDay(apptsOn(ds));
            return (
              <div key={ds} style={{ ...S.dayCol, height: gridHeight }}>
                {hours.map((h, i) => (
                  <div key={h} style={{ ...S.hourLine, top: i * HOUR_HEIGHT }} />
                ))}
                {/* Blocked time: closed days stripe the whole column, hour
                    blocks stripe just their range (same rule as the day view). */}
                {blocksOn(ds).map(b => {
                  const isClosed = b.type ? b.type === 'closed' : !!b.is_closed;
                  let top = 0, height = gridHeight;
                  if (!isClosed && b.start_time && b.end_time) {
                    const [sh, sm] = String(b.start_time).split(':').map(Number);
                    const [eh, em] = String(b.end_time).split(':').map(Number);
                    top = ((sh + sm / 60) - hours[0]) * HOUR_HEIGHT;
                    height = Math.max(((eh + em / 60) - (sh + sm / 60)) * HOUR_HEIGHT, 20);
                  }
                  return (
                    <div
                      key={b.id}
                      title={isClosed ? 'Closed all day' : `Blocked ${String(b.start_time).slice(0, 5)} to ${String(b.end_time).slice(0, 5)}`}
                      style={{ position: 'absolute', left: 1, right: 1, top: Math.max(0, top), height,
                        background: 'repeating-linear-gradient(45deg, rgba(146,64,94,0.08) 0px, rgba(146,64,94,0.08) 5px, rgba(146,64,94,0.02) 5px, rgba(146,64,94,0.02) 10px)',
                        borderLeft: '3px solid rgba(146,64,94,0.45)',
                        borderRadius: 6, zIndex: 1, pointerEvents: 'none',
                        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 4,
                      }}
                    >
                      <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.05em', color: 'rgba(146,64,94,0.75)' }}>
                        {isClosed ? 'CLOSED' : 'BLOCKED'}
                      </span>
                    </div>
                  );
                })}
                {rects.map(({ a, top, height, col, cols }) => {
                  const color = treatmentColor(a.treatments);
                  const widthPct = 100 / cols;
                  const name = a.clients?.first_name || 'Booking';
                  const treat = a.treatments?.name || (a.beautician_notes && /patch test/i.test(a.beautician_notes) ? 'Patch test' : '');
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => onOpenAppt(a)}
                      title={`${wallTime(a.starts_at)} ${name} , ${treat} , open the day`}
                      style={{ ...S.event,
                        top, height,
                        left: `calc(${col * widthPct}% + 2px)`,
                        width: `calc(${widthPct}% - 4px)`,
                        background: tint(color, 0.16),
                        borderLeft: `3px solid ${color}`,
                      }}
                    >
                      <div style={{ ...S.eventTime, color }}>{wallTime(a.starts_at)}</div>
                      <div style={S.eventName}>{name}</div>
                      {height > 40 && treat && <div style={S.eventTreat}>{treat}</div>}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ============================ MONTH GRID ============================ */
function MonthGrid({ anchor, apptsOn, blocksOn = () => [], onPickDay }) {
  const todayStr = todayLocal();
  const monthIdx = anchor.getMonth();
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1, 12);
  const gridStart = weekStart(first);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const dows = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  return (
    <div style={S.monthWrap} className="cf-monthgrid">
      <div style={S.monthDowRow}>
        {dows.map(d => <div key={d} style={S.monthDow}>{d}</div>)}
      </div>
      <div style={S.monthGrid}>
        {cells.map(d => {
          const ds = localDateStr(d);
          const list = apptsOn(ds);
          const inMonth = d.getMonth() === monthIdx;
          const isToday = ds === todayStr;
          const dots = list.slice(0, 4);
          const dayBlocks = blocksOn(ds);
          const isClosedDay = dayBlocks.some(b => (b.type ? b.type === 'closed' : !!b.is_closed));
          const hasHourBlock = !isClosedDay && dayBlocks.length > 0;
          return (
            <button
              key={ds}
              onClick={() => onPickDay(d)}
              style={{ ...S.monthCell,
                opacity: inMonth ? 1 : 0.4,
                ...(isToday ? S.monthCellToday : {}),
                ...(isClosedDay ? { background: 'repeating-linear-gradient(45deg, rgba(146,64,94,0.07) 0px, rgba(146,64,94,0.07) 5px, transparent 5px, transparent 10px)' } : {}),
              }}
            >
              <div style={S.monthCellTop}>
                <span style={{ ...S.monthDayNum, ...(isToday ? S.monthDayNumToday : {}) }}>{d.getDate()}</span>
                {isClosedDay
                  ? <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: '0.04em', color: 'rgba(146,64,94,0.7)' }}>CLOSED</span>
                  : hasHourBlock
                    ? <span title="Some hours blocked" style={{ fontSize: 9, color: 'rgba(146,64,94,0.7)' }}>▮</span>
                    : (list.length > 0 && <span style={S.monthCount}>{list.length}</span>)}
              </div>
              <div style={S.monthDots}>
                {dots.map(a => (
                  <span key={a.id} style={{ ...S.monthDot, background: treatmentColor(a.treatments) }} />
                ))}
                {list.length > 4 && <span style={S.monthMore}>+{list.length - 4}</span>}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ============================ SYNC PANEL ============================ */
function SyncPanel({ onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = (await supabase.auth.getSession())?.data?.session?.access_token;
        const res = await fetch(`${API_BASE}/api/calendar/sync`, { headers: { Authorization: `Bearer ${token}` } });
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) { setErr(body.message || 'Could not load your sync link.'); return; }
        setData(body);
      } catch (e) {
        if (!cancelled) setErr('Could not load your sync link.');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  function copy(value, key) {
    navigator.clipboard?.writeText?.(value);
    setCopied(key);
    setTimeout(() => setCopied(''), 1800);
  }

  return (
    <div style={S.overlay} onClick={onClose} className="cf-noprint">
      <div style={S.sheet} onClick={e => e.stopPropagation()}>
        <div style={S.sheetHead}>
          <h2 style={S.sheetTitle}>Sync to my calendar</h2>
          <button onClick={onClose} style={S.sheetClose} aria-label="Close">×</button>
        </div>
        <p style={S.sheetIntro}>
          Add this private link to your phone or Google calendar and your Florrie bookings
          show up automatically, refreshing on their own through the day.
        </p>

        {err && <div style={S.errBox}>{err}</div>}

        {!data && !err && <div style={S.sheetLoading}>Preparing your link…</div>}

        {data && (
          <>
            <div style={S.linkBlock}>
              <span style={S.linkLabel}>Subscribe link</span>
              <div style={S.linkRow}>
                <input readOnly value={data.webcalUrl} onFocus={e => e.target.select()} style={S.linkInput} />
                <button onClick={() => copy(data.webcalUrl, 'webcal')} style={S.copyBtn}>
                  {copied === 'webcal' ? 'Copied' : 'Copy'}
                </button>
              </div>
              <div style={S.linkRow}>
                <input readOnly value={data.httpsUrl} onFocus={e => e.target.select()} style={S.linkInput} />
                <button onClick={() => copy(data.httpsUrl, 'https')} style={S.copyBtn}>
                  {copied === 'https' ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p style={S.linkHint}>The webcal link opens straight into the Calendar app. The https one is for Google.</p>
            </div>

            <div style={S.howBlock}>
              <div style={S.howTitle}>On your iPhone</div>
              <ol style={S.howList}>
                <li>Tap the webcal link above, or copy it.</li>
                <li>Open Settings, then Calendar, then Accounts, then Add Account, then Other.</li>
                <li>Choose Add Subscribed Calendar and paste the link.</li>
              </ol>
            </div>

            <div style={S.howBlock}>
              <div style={S.howTitle}>On Google Calendar</div>
              <ol style={S.howList}>
                <li>Open Google Calendar on a computer.</li>
                <li>Next to Other calendars, click the plus, then From URL.</li>
                <li>Paste the https link and click Add calendar.</li>
              </ol>
            </div>

            <p style={S.privacyNote}>
              Keep this link private. Anyone with it can see your booking times. You can change it
              later to switch off an old link.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/* ============================ PRINT STYLES ============================ */
function PrintStyles() {
  return (
    <style>{`
      .cf-printonly { display: none; }
      @media print {
        .cf-noprint { display: none !important; }
        .cf-printonly { display: block !important; }
        body { background: #fff !important; }
        .cf-weekgrid, .cf-monthgrid { box-shadow: none !important; }
        @page { margin: 12mm; }
      }
    `}</style>
  );
}

/* ============================ STYLES ============================ */
const S = {
  page: { minHeight: 'var(--shell-viewport)', background: C.bg, color: C.text, fontFamily: "var(--font-body, 'Plus Jakarta Sans', -apple-system, sans-serif)", padding: '16px clamp(12px, 4vw, 40px) 24px', boxSizing: 'border-box' },

  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 14 },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 10 },
  title: { fontSize: 'clamp(20px, 3vw, 28px)', fontWeight: 700, margin: 0, fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)" },
  headerActions: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  iconBtn: { width: 38, height: 38, borderRadius: 10, border: `1px solid ${C.line}`, background: C.card, color: C.text, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  ghostBtn: { display: 'flex', alignItems: 'center', gap: 7, height: 38, padding: '0 14px', borderRadius: 10, border: `1px solid ${C.line}`, background: C.card, color: C.text, cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' },
  btnLabel: { whiteSpace: 'nowrap' },

  toolbar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 16 },
  navGroup: { display: 'flex', alignItems: 'center', gap: 8 },
  navBtn: { width: 36, height: 36, borderRadius: 10, border: `1px solid ${C.line}`, background: C.card, color: C.muted, fontSize: 22, lineHeight: 1, cursor: 'pointer' },
  todayBtn: { height: 36, padding: '0 14px', borderRadius: 10, border: `1px solid ${C.line}`, background: C.card, color: C.text, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  rangeLabel: { marginLeft: 6, fontSize: 'clamp(15px, 2vw, 19px)', fontWeight: 700, fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)" },
  viewToggle: { display: 'flex', gap: 3, background: C.card, borderRadius: 10, padding: 3, border: `1px solid ${C.line}` },
  toggleBtn: { padding: '7px 18px', borderRadius: 10, border: 'none', background: 'transparent', color: C.muted, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  toggleOn: { background: C.accent, color: '#fff' },

  loading: { padding: '40px 0', textAlign: 'center', color: C.muted, fontSize: 14 },

  // Week grid
  weekWrap: { background: C.card, borderRadius: 16, boxShadow: 'var(--elev-3)', overflow: 'hidden' },
  weekHeadRow: { display: 'grid', gridTemplateColumns: '52px repeat(7, 1fr)', borderBottom: `1px solid ${C.line}` },
  weekHeadSpacer: {},
  weekHeadCell: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: '10px 2px', border: 'none', borderLeft: `1px solid ${C.lineSoft}`, background: 'transparent', cursor: 'pointer', fontFamily: 'inherit' },
  weekHeadToday: { background: 'rgba(146, 64, 94, 0.06)' },
  weekHeadDow: { fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: C.muted },
  weekHeadNum: { fontSize: 16, fontWeight: 700, color: C.text },
  weekHeadNumToday: { color: '#fff', background: C.accent, width: 26, height: 26, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  weekBody: { maxHeight: 'calc(var(--shell-viewport) - 220px)', overflowY: 'auto', WebkitOverflowScrolling: 'touch' },
  weekGridInner: { display: 'grid', gridTemplateColumns: '52px repeat(7, 1fr)', position: 'relative' },
  timeCol: { position: 'relative' },
  timeLabel: { position: 'absolute', right: 6, fontSize: 10, fontWeight: 700, color: C.muted, transform: 'translateY(-6px)' },
  dayCol: { position: 'relative', borderLeft: `1px solid ${C.lineSoft}` },
  hourLine: { position: 'absolute', left: 0, right: 0, height: 1, background: C.lineSoft },
  event: { position: 'absolute', borderRadius: 10, padding: '3px 5px', overflow: 'hidden', boxSizing: 'border-box', cursor: 'pointer', textAlign: 'left', font: 'inherit', appearance: 'none', WebkitAppearance: 'none' },
  eventTime: { fontSize: 9, fontWeight: 700 },
  eventName: { fontSize: 11, fontWeight: 700, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  eventTreat: { fontSize: 9, color: C.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },

  // Month grid
  monthWrap: { background: C.card, borderRadius: 16, padding: 12, boxShadow: 'var(--elev-3)' },
  monthDowRow: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', marginBottom: 6 },
  monthDow: { textAlign: 'center', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: C.muted, padding: '4px 0' },
  monthGrid: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 5 },
  monthCell: { aspectRatio: '1 / 1', minHeight: 64, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', alignItems: 'stretch', padding: 6, borderRadius: 10, border: `1px solid ${C.lineSoft}`, background: 'transparent', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' },
  monthCellToday: { border: `1.5px solid ${C.accent}`, background: 'rgba(146, 64, 94, 0.04)' },
  monthCellTop: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  monthDayNum: { fontSize: 13, fontWeight: 700, color: C.text },
  monthDayNumToday: { color: C.accent },
  monthCount: { fontSize: 10, fontWeight: 700, color: C.accent, background: 'rgba(146, 64, 94, 0.10)', borderRadius: 6, padding: '1px 5px' },
  monthDots: { display: 'flex', flexWrap: 'wrap', gap: 3, alignItems: 'center' },
  monthDot: { width: 7, height: 7, borderRadius: '50%' },
  monthMore: { fontSize: 9, fontWeight: 700, color: C.muted },

  // Print head
  printHead: { marginBottom: 12 },
  printBrand: { fontSize: 22, fontWeight: 700, fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)" },
  printRange: { fontSize: 13, color: C.muted, marginTop: 2 },

  // Sync sheet
  overlay: { position: 'fixed', inset: 0, background: 'rgba(40, 20, 28, 0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 1000 },
  sheet: { width: '100%', maxWidth: 460, maxHeight: '90vh', overflowY: 'auto', background: C.card, borderRadius: 22, padding: 22, boxShadow: 'var(--elev-3)', paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 20px)' },
  sheetHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  sheetTitle: { fontSize: 20, fontWeight: 700, margin: 0, fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)" },
  sheetClose: { background: 'none', border: 'none', fontSize: 26, lineHeight: 1, color: C.muted, cursor: 'pointer' },
  sheetIntro: { fontSize: 13, color: C.muted, margin: '4px 0 16px', lineHeight: 1.5 },
  sheetLoading: { padding: '24px 0', textAlign: 'center', color: C.muted, fontSize: 13 },
  errBox: { background: 'rgba(220, 38, 38, 0.08)', color: '#b91c1c', borderRadius: 10, padding: '10px 12px', fontSize: 13, marginBottom: 12 },

  linkBlock: { marginBottom: 18 },
  linkLabel: { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: C.muted },
  linkRow: { display: 'flex', gap: 8, marginTop: 8 },
  linkInput: { flex: 1, minWidth: 0, padding: '9px 11px', borderRadius: 10, border: `1px solid ${C.line}`, background: C.bg, fontSize: 12, color: C.text, fontFamily: 'inherit' },
  copyBtn: { padding: '0 14px', borderRadius: 10, border: 'none', background: C.accent, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 },
  linkHint: { fontSize: 11, color: C.muted, margin: '8px 0 0', lineHeight: 1.5 },

  howBlock: { marginBottom: 14 },
  howTitle: { fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 4 },
  howList: { margin: 0, paddingLeft: 18, fontSize: 12, color: C.muted, lineHeight: 1.6 },
  privacyNote: { fontSize: 11, color: C.muted, lineHeight: 1.5, marginTop: 6, marginBottom: 0 },
};
