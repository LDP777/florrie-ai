import { useState, useEffect } from 'react';
import { useBeautician, supabase, isDevMode, insertRow, updateRow, deleteRow } from '../lib/supabase.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';

/**
 * Business Hours Exceptions — Holidays, sick days & one-off closures.
 *
 * Sections:
 *   Upcoming  — future exceptions (sorted by date)
 *   Add       — create a new exception
 *   Past      — previous closures / amended hours
 *
 * Exception types:
 *   closed   — full day off (holiday, sick, personal)
 *   amended  — different hours that day (e.g. finish early)
 *   extended — extra hours (e.g. late night for an event)
 */

const EXCEPTION_TYPES = {
  closed: { label: 'Day off', icon: '🏖️', color: '#E57373', bg: '#FEF2F2' },
  amended: { label: 'Changed hours', icon: '🕐', color: '#FF9800', bg: '#FFF3E0' },
  extended: { label: 'Extended hours', icon: '🌙', color: 'var(--success, #5BA97B)', bg: 'var(--success-bg, #E8F5E9)' },
};

const REASONS = [
  { value: 'holiday', label: 'Holiday' },
  { value: 'sick', label: 'Sick day' },
  { value: 'personal', label: 'Personal' },
  { value: 'training', label: 'Training course' },
  { value: 'bank_holiday', label: 'Bank holiday' },
  { value: 'event', label: 'Special event' },
  { value: 'other', label: 'Other' },
];

const DEV_EXCEPTIONS = [
  {
    id: 'dev-ex1', type: 'closed', date: '2026-04-03', end_date: null,
    reason: 'bank_holiday', note: 'Good Friday',
    start_time: null, end_time: null,
    notify_clients: true, created_at: '2026-03-20T10:00:00Z',
  },
  {
    id: 'dev-ex2', type: 'closed', date: '2026-04-06', end_date: null,
    reason: 'bank_holiday', note: 'Easter Monday',
    start_time: null, end_time: null,
    notify_clients: true, created_at: '2026-03-20T10:00:00Z',
  },
  {
    id: 'dev-ex3', type: 'amended', date: '2026-03-28', end_date: null,
    reason: 'personal', note: 'School pick-up — finishing early',
    start_time: '10:00', end_time: '14:00',
    notify_clients: true, created_at: '2026-03-22T10:00:00Z',
  },
  {
    id: 'dev-ex4', type: 'closed', date: '2026-04-14', end_date: '2026-04-18',
    reason: 'holiday', note: 'Spring holiday — Tenerife! ☀️',
    start_time: null, end_time: null,
    notify_clients: true, created_at: '2026-03-15T10:00:00Z',
  },
  {
    id: 'dev-ex5', type: 'extended', date: '2026-04-10', end_date: null,
    reason: 'event', note: 'Prom season late night',
    start_time: '10:00', end_time: '21:00',
    notify_clients: false, created_at: '2026-03-18T10:00:00Z',
  },
  {
    id: 'dev-ex6', type: 'closed', date: '2026-03-01', end_date: null,
    reason: 'sick', note: 'Flu — cancelled all appointments',
    start_time: null, end_time: null,
    notify_clients: true, created_at: '2026-03-01T08:00:00Z',
  },
];

function formatDate(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function formatDateRange(start, end) {
  if (!end || start === end) return formatDate(start);
  const s = new Date(start + 'T12:00:00');
  const e = new Date(end + 'T12:00:00');
  const sameMonth = s.getMonth() === e.getMonth();
  if (sameMonth) {
    return `${s.toLocaleDateString('en-GB', { day: 'numeric' })} — ${e.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
  }
  return `${formatDate(start)} — ${formatDate(end)}`;
}

function daysCount(start, end) {
  if (!end || start === end) return 1;
  return Math.round((new Date(end) - new Date(start)) / 86400000) + 1;
}

export default function HoursExceptions() {
  const { beautician } = useBeautician();
  const [exceptions, setExceptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);

  const [form, setForm] = useState({
    type: 'closed', date: '', end_date: '',
    reason: 'holiday', note: '',
    start_time: '10:00', end_time: '17:00',
    notify_clients: true,
  });

  useEffect(() => { if (beautician) loadData(); }, [beautician]);

  async function loadData() {
    setLoading(true);
    try {
      if (isDevMode) {
        setExceptions(DEV_EXCEPTIONS);
      } else {
        const { data } = await supabase
          .from('hours_exceptions')
          .select('*')
          .eq('beautician_id', beautician.id)
          .order('date', { ascending: false });
        setExceptions(data || []);
      }
    } catch (err) {
      logger.error('Load exceptions error:', err);
      setExceptions(isDevMode ? DEV_EXCEPTIONS : []);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!form.date) return;
    const exc = {
      id: crypto.randomUUID(),
      type: form.type,
      date: form.date,
      end_date: form.end_date || null,
      reason: form.reason,
      note: form.note.trim(),
      start_time: form.type !== 'closed' ? form.start_time : null,
      end_time: form.type !== 'closed' ? form.end_time : null,
      notify_clients: form.notify_clients,
      created_at: new Date().toISOString(),
    };

    if (!isDevMode && beautician) {
      try {
        const saved = await insertRow('hours_exceptions', { beautician_id: beautician.id, ...exc });
        exc.id = saved.id;
      } catch {}
    }

    setExceptions(prev => [exc, ...prev]);
    setForm({
      type: 'closed', date: '', end_date: '',
      reason: 'holiday', note: '',
      start_time: '10:00', end_time: '17:00',
      notify_clients: true,
    });
    setShowAdd(false);
  }

  async function handleDelete(id) {
    setExceptions(prev => prev.filter(e => e.id !== id));
    if (!isDevMode) {
      try { await deleteRow('hours_exceptions', id); } catch {}
    }
  }

  const today = new Date().toISOString().split('T')[0];
  const upcoming = exceptions
    .filter(e => e.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date));
  const past = exceptions
    .filter(e => e.date < today)
    .sort((a, b) => b.date.localeCompare(a.date));

  // Next closure
  const nextClosed = upcoming.find(e => e.type === 'closed');

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>Hours & Closures</h1>
          <p style={styles.subtitle}>Manage days off & schedule changes</p>
        </div>
      </div>

      {/* Next closure card */}
      {nextClosed && (
        <div style={styles.nextCard}>
          <span style={styles.nextLabel}>Next day off</span>
          <span style={styles.nextDate}>
            {formatDateRange(nextClosed.date, nextClosed.end_date)}
          </span>
          {nextClosed.note && <span style={styles.nextNote}>{nextClosed.note}</span>}
          <span style={styles.nextDays}>
            {Math.max(0, Math.round((new Date(nextClosed.date) - new Date()) / 86400000))} days away
          </span>
        </div>
      )}

      <button onClick={() => setShowAdd(!showAdd)} style={styles.addBtn}>
        + Add Exception
      </button>

      {/* Add form */}
      {showAdd && (
        <div style={styles.formCard}>
          <h3 style={styles.formTitle}>New Exception</h3>

          <div style={styles.formGroup}>
            <label style={styles.formLabel}>Type</label>
            <div style={styles.typeRow}>
              {Object.entries(EXCEPTION_TYPES).map(([key, cfg]) => (
                <button
                  key={key}
                  onClick={() => setForm(p => ({ ...p, type: key }))}
                  style={{
                    ...styles.typeBtn,
                    background: form.type === key ? cfg.bg : '#fff',
                    borderColor: form.type === key ? cfg.color : 'var(--border, var(--border, #EDE9E4))',
                  }}
                >
                  <span style={{ fontSize: 18 }}>{cfg.icon}</span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: form.type === key ? cfg.color : '#5A5550' }}>
                    {cfg.label}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div style={styles.formRow}>
            <div style={{ flex: 1 }}>
              <label style={styles.formLabel}>Date</label>
              <input
                type="date" value={form.date}
                onChange={e => setForm(p => ({ ...p, date: e.target.value }))}
                style={styles.formInput}
              />
            </div>
            {form.type === 'closed' && (
              <div style={{ flex: 1 }}>
                <label style={styles.formLabel}>End date (multi-day)</label>
                <input
                  type="date" value={form.end_date}
                  onChange={e => setForm(p => ({ ...p, end_date: e.target.value }))}
                  style={styles.formInput}
                />
              </div>
            )}
          </div>

          {form.type !== 'closed' && (
            <div style={styles.formRow}>
              <div style={{ flex: 1 }}>
                <label style={styles.formLabel}>Start time</label>
                <input
                  type="time" value={form.start_time}
                  onChange={e => setForm(p => ({ ...p, start_time: e.target.value }))}
                  style={styles.formInput}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={styles.formLabel}>End time</label>
                <input
                  type="time" value={form.end_time}
                  onChange={e => setForm(p => ({ ...p, end_time: e.target.value }))}
                  style={styles.formInput}
                />
              </div>
            </div>
          )}

          <div style={styles.formGroup}>
            <label style={styles.formLabel}>Reason</label>
            <div style={styles.reasonGrid}>
              {REASONS.map(r => (
                <button
                  key={r.value}
                  onClick={() => setForm(p => ({ ...p, reason: r.value }))}
                  style={{
                    ...styles.reasonChip,
                    background: form.reason === r.value ? 'var(--text-primary, #2D2A26)' : '#fff',
                    color: form.reason === r.value ? '#fff' : '#5A5550',
                  }}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          <div style={styles.formGroup}>
            <label style={styles.formLabel}>Note (optional)</label>
            <input
              type="text" placeholder="e.g. Spain holiday ☀️"
              value={form.note}
              onChange={e => setForm(p => ({ ...p, note: e.target.value }))}
              style={styles.formInput}
            />
          </div>

          <div style={styles.notifyRow}>
            <div>
              <span style={styles.notifyLabel}>Notify affected clients</span>
              <span style={styles.notifyHint}>florrie.ai will message anyone booked on these dates</span>
            </div>
            <button
              onClick={() => setForm(p => ({ ...p, notify_clients: !p.notify_clients }))}
              style={{
                ...styles.toggle,
                background: form.notify_clients ? 'var(--accent, #C76B8A)' : 'var(--border, var(--border, #EDE9E4))',
              }}
            >
              <div style={{
                ...styles.toggleDot,
                transform: form.notify_clients ? 'translateX(18px)' : 'translateX(2px)',
              }} />
            </button>
          </div>

          <div style={styles.formActions}>
            <button onClick={handleSave} style={styles.saveBtn}>Save</button>
            <button onClick={() => setShowAdd(false)} style={styles.cancelBtn}>Cancel</button>
          </div>
        </div>
      )}

      {/* Upcoming */}
      <h3 style={styles.sectionTitle}>Upcoming ({upcoming.length})</h3>
      {loading ? (
        <p style={styles.loadingText}>Loading...</p>
      ) : upcoming.length === 0 ? (
        <div style={styles.emptyCard}>
          <p style={styles.emptyText}>No upcoming exceptions. Your regular hours are active.</p>
        </div>
      ) : (
        <div style={styles.excList}>
          {upcoming.map(exc => {
            const cfg = EXCEPTION_TYPES[exc.type];
            const days = daysCount(exc.date, exc.end_date);
            return (
              <div key={exc.id} style={styles.excCard}>
                <div style={{ ...styles.excIcon, background: cfg.bg }}>
                  <span>{cfg.icon}</span>
                </div>
                <div style={styles.excBody}>
                  <div style={styles.excTopRow}>
                    <span style={styles.excDate}>{formatDateRange(exc.date, exc.end_date)}</span>
                    <span style={{ ...styles.excTypeBadge, background: cfg.bg, color: cfg.color }}>
                      {cfg.label}
                    </span>
                  </div>
                  {exc.type !== 'closed' && exc.start_time && (
                    <span style={styles.excTimes}>{exc.start_time} — {exc.end_time}</span>
                  )}
                  {exc.note && <span style={styles.excNote}>{exc.note}</span>}
                  <div style={styles.excFooter}>
                    <span style={styles.excReason}>{REASONS.find(r => r.value === exc.reason)?.label || exc.reason}</span>
                    {days > 1 && <span style={styles.excDays}>{days} days</span>}
                    {exc.notify_clients && <span style={styles.excNotify}>Clients notified</span>}
                  </div>
                </div>
                <button onClick={() => handleDelete(exc.id)} style={styles.deleteBtn}>×</button>
              </div>
            );
          })}
        </div>
      )}

      {/* Past */}
      {past.length > 0 && (
        <>
          <h3 style={{ ...styles.sectionTitle, color: 'var(--text-muted, var(--text-muted, #B5AFA8))' }}>Past ({past.length})</h3>
          <div style={styles.excList}>
            {past.slice(0, 5).map(exc => {
              const cfg = EXCEPTION_TYPES[exc.type];
              return (
                <div key={exc.id} style={{ ...styles.excCard, opacity: 0.6 }}>
                  <div style={{ ...styles.excIcon, background: cfg.bg }}>
                    <span>{cfg.icon}</span>
                  </div>
                  <div style={styles.excBody}>
                    <span style={styles.excDate}>{formatDateRange(exc.date, exc.end_date)}</span>
                    {exc.note && <span style={styles.excNote}>{exc.note}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh', background: 'var(--bg, #FAF8F5)',
    fontFamily: '"DM Sans", -apple-system, sans-serif',
    padding: '0 16px 40px', maxWidth: 480, margin: '0 auto', color: 'var(--text-primary, #2D2A26)',
  },
  header: { paddingTop: 28, paddingBottom: 8 },
  title: { fontSize: 22, fontWeight: 700, margin: '0 0 2px' },
  subtitle: { fontSize: 13, color: 'var(--accent, #C76B8A)', margin: 0, fontWeight: 500 },

  // Next closure
  nextCard: {
    background: 'linear-gradient(135deg, var(--accent, #C76B8A) 0%, #E8A0B5 100%)',
    borderRadius: 14, padding: 18, marginBottom: 12, color: '#fff',
  },
  nextLabel: { display: 'block', fontSize: 11, opacity: 0.8, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 },
  nextDate: { display: 'block', fontSize: 18, fontWeight: 700, marginBottom: 4 },
  nextNote: { display: 'block', fontSize: 13, opacity: 0.9, marginBottom: 4 },
  nextDays: { display: 'block', fontSize: 12, opacity: 0.7 },

  addBtn: {
    width: '100%', padding: '12px 0', borderRadius: 10, border: 'none',
    background: 'var(--accent, #C76B8A)', color: '#fff', fontSize: 14, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit', marginBottom: 16,
  },

  // Form
  formCard: {
    background: '#fff', borderRadius: 14, padding: 16,
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)', marginBottom: 16,
  },
  formTitle: { fontSize: 16, fontWeight: 600, margin: '0 0 14px', color: 'var(--text-primary, #2D2A26)' },
  formGroup: { marginBottom: 14 },
  formLabel: { display: 'block', fontSize: 12, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', marginBottom: 6, fontWeight: 500 },
  formInput: {
    width: '100%', padding: '10px 12px', borderRadius: 8,
    border: '1.5px solid var(--border, var(--border, #EDE9E4))', fontSize: 14, fontFamily: 'inherit',
    outline: 'none', boxSizing: 'border-box',
  },
  formRow: { display: 'flex', gap: 10, marginBottom: 14 },
  typeRow: { display: 'flex', gap: 8 },
  typeBtn: {
    flex: 1, padding: '10px 0', borderRadius: 10, border: '1.5px solid var(--border, var(--border, #EDE9E4))',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  reasonGrid: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  reasonChip: {
    padding: '6px 12px', borderRadius: 8, border: '1.5px solid var(--border, var(--border, #EDE9E4))',
    fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
  },
  notifyRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '10px 0', marginBottom: 14,
  },
  notifyLabel: { display: 'block', fontSize: 13, fontWeight: 500, color: 'var(--text-primary, #2D2A26)' },
  notifyHint: { display: 'block', fontSize: 11, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', marginTop: 2 },
  toggle: {
    width: 44, height: 26, borderRadius: 13, border: 'none',
    cursor: 'pointer', position: 'relative', flexShrink: 0,
    transition: 'background 0.2s',
  },
  toggleDot: {
    width: 22, height: 22, borderRadius: 11, background: '#fff',
    position: 'absolute', top: 2, transition: 'transform 0.2s',
    boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
  },
  formActions: { display: 'flex', gap: 8 },
  saveBtn: {
    flex: 1, padding: '10px 0', borderRadius: 10, border: 'none',
    background: 'var(--accent, #C76B8A)', color: '#fff', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  cancelBtn: {
    padding: '10px 16px', borderRadius: 10, border: 'none',
    background: 'var(--bg-hover, #F5F2EF)', color: '#8A8580', fontSize: 13,
    cursor: 'pointer', fontFamily: 'inherit',
  },

  // Section
  sectionTitle: { fontSize: 14, fontWeight: 600, margin: '16px 0 10px', color: 'var(--text-primary, #2D2A26)' },

  // Exception list
  excList: { display: 'flex', flexDirection: 'column', gap: 8 },
  excCard: {
    display: 'flex', alignItems: 'flex-start', gap: 10,
    background: '#fff', borderRadius: 12, padding: '12px 10px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)', position: 'relative',
  },
  excIcon: {
    width: 36, height: 36, borderRadius: 10,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 16, flexShrink: 0,
  },
  excBody: { flex: 1, minWidth: 0 },
  excTopRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 },
  excDate: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary, #2D2A26)' },
  excTypeBadge: { padding: '3px 8px', borderRadius: 5, fontSize: 10, fontWeight: 600, flexShrink: 0 },
  excTimes: { display: 'block', fontSize: 12, color: '#5A5550', marginBottom: 2 },
  excNote: { display: 'block', fontSize: 12, color: '#8A8580', marginBottom: 4 },
  excFooter: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  excReason: { fontSize: 10, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', textTransform: 'uppercase', letterSpacing: '0.03em' },
  excDays: { fontSize: 10, color: 'var(--accent, #C76B8A)', fontWeight: 600 },
  excNotify: { fontSize: 10, color: 'var(--success, #5BA97B)' },
  deleteBtn: {
    width: 24, height: 24, borderRadius: 12, border: 'none',
    background: '#FEF2F2', color: '#E57373', fontSize: 14,
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },

  // Empty
  loadingText: { textAlign: 'center', color: 'var(--text-muted, var(--text-muted, #B5AFA8))', padding: 40, fontSize: 14 },
  emptyCard: {
    background: '#fff', borderRadius: 12, padding: 20, textAlign: 'center',
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
  },
  emptyText: { fontSize: 13, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', margin: 0 },
};
