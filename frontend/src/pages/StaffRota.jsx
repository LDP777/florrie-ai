/**
 * Staff Rota — Weekly availability & shift management.
 *
 * For when Ellie expands — tracks who's working when,
 * manages chair rentals, and prevents double-bookings.
 * Works for solo too: shows her own availability at a glance.
 */
import { useState, useEffect } from 'react';
import { useBeautician, supabase, isDevMode, fetchRows } from '../lib/supabase.js';
import logger from '../lib/logger.js';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const DEV_STAFF = [
  {
    id: 's1', name: 'Ellie', role: 'Owner', colour: '#C76B8A',
    hours: { mon: { start: '11:00', end: '15:00' }, tue: { start: '11:00', end: '19:00' }, wed: { start: '11:00', end: '18:00' }, thu: { start: '11:00', end: '19:00' }, fri: { start: '10:00', end: '17:00' }, sat: null },
    timeOff: [{ date: '2026-04-02', reason: 'Dentist' }],
  },
  {
    id: 's2', name: 'Sophie', role: 'Junior Stylist', colour: '#7B9FAF',
    hours: { mon: null, tue: { start: '10:00', end: '16:00' }, wed: { start: '10:00', end: '16:00' }, thu: null, fri: { start: '10:00', end: '16:00' }, sat: { start: '09:00', end: '14:00' } },
    timeOff: [],
  },
  {
    id: 's3', name: 'Chair Rental', role: 'Freelance Chair', colour: '#8F9B6B',
    hours: { mon: null, tue: null, wed: null, thu: { start: '10:00', end: '18:00' }, fri: null, sat: { start: '09:00', end: '15:00' } },
    timeOff: [],
  },
];

const DEV_EXCEPTIONS = [
  { id: 'ex1', staffId: 's1', date: '2026-04-02', type: 'time-off', reason: 'Dentist appointment', allDay: false, start: '11:00', end: '14:00' },
  { id: 'ex2', staffId: 's2', date: '2026-03-28', type: 'swap', reason: 'Covering Ellie — taking Friday for training', original: 'fri', swapTo: 'thu' },
];

export default function StaffRota({ token }) {
  const { beautician, loading: bLoading } = useBeautician();
  const [tab, setTab] = useState('week');
  const [loading, setLoading] = useState(true);
  const [weekOffset, setWeekOffset] = useState(0);
  const [selectedStaff, setSelectedStaff] = useState(null);
  const [showAddTimeOff, setShowAddTimeOff] = useState(false);
  const [timeOffForm, setTimeOffForm] = useState({ staffId: 's1', date: '', reason: '', allDay: true, start: '', end: '' });
  const [staff, setStaff] = useState(isDevMode ? DEV_STAFF : []);
  const [exceptions, setExceptions] = useState(isDevMode ? DEV_EXCEPTIONS : []);

  useEffect(() => {
    if (beautician && !bLoading) loadRota();
  }, [beautician, bLoading]);

  async function loadRota() {
    setLoading(true);
    try {
      if (isDevMode) {
        setStaff(DEV_STAFF);
        setExceptions(DEV_EXCEPTIONS);
      } else {
        const teamData = await fetchRows('team_members', beautician.id, { order: 'created_at' });
        setStaff(teamData || []);

        const { data: excepData } = await supabase
          .from('hours_exceptions')
          .select('*')
          .eq('beautician_id', beautician.id);
        setExceptions(excepData || []);
      }
    } catch (err) {
      logger.error('Load rota error:', err);
      setStaff(DEV_STAFF);
      setExceptions(DEV_EXCEPTIONS);
    } finally {
      setLoading(false);
    }
  }

  if (bLoading || loading) {
    return <div style={S.page}><div style={{ textAlign: 'center', padding: 60, color: '#AAA5A0' }}>Loading...</div></div>;
  }

  // Current week dates
  const getWeekDates = () => {
    const now = new Date();
    const monday = new Date(now);
    const day = monday.getDay();
    monday.setDate(monday.getDate() - (day === 0 ? 6 : day - 1) + (weekOffset * 7));
    return DAY_KEYS.map((_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return d;
    });
  };

  const weekDates = getWeekDates();
  const weekLabel = `${weekDates[0].toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} — ${weekDates[5].toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;

  // Total hours per staff this week
  const calcHours = (s) => {
    let total = 0;
    DAY_KEYS.forEach(d => {
      if (s.hours[d]) {
        const [sh, sm] = s.hours[d].start.split(':').map(Number);
        const [eh, em] = s.hours[d].end.split(':').map(Number);
        total += (eh + em / 60) - (sh + sm / 60);
      }
    });
    return total;
  };

  const totalWeekHours = staff.reduce((s, p) => s + calcHours(p), 0);

  return (
    <div style={S.page}>
      <div style={S.header}>
        <h1 style={S.title}>Staff Rota</h1>
        <button style={S.addBtn} onClick={() => setShowAddTimeOff(true)}>+ Time Off</button>
      </div>

      {/* Stats */}
      <div style={S.statsRow}>
        <div style={S.statCard}>
          <span style={{ ...S.statValue, color: '#C76B8A' }}>{staff.length}</span>
          <span style={S.statLabel}>Team</span>
        </div>
        <div style={S.statCard}>
          <span style={{ ...S.statValue, color: '#6B8F7B' }}>{totalWeekHours.toFixed(0)}h</span>
          <span style={S.statLabel}>Weekly Hours</span>
        </div>
        <div style={S.statCard}>
          <span style={{ ...S.statValue, color: '#8B6F5E' }}>{DEV_EXCEPTIONS.length}</span>
          <span style={S.statLabel}>Exceptions</span>
        </div>
      </div>

      {/* Tabs */}
      <div style={S.tabs}>
        {['week', 'staff', 'exceptions'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ ...S.tab, ...(tab === t ? S.tabActive : {}) }}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* Week view */}
      {tab === 'week' && (
        <>
          <div style={S.weekNav}>
            <button style={S.weekArrow} onClick={() => setWeekOffset(o => o - 1)}>‹</button>
            <span style={S.weekLabel}>{weekLabel}</span>
            <button style={S.weekArrow} onClick={() => setWeekOffset(o => o + 1)}>›</button>
          </div>

          <div style={S.grid}>
            {/* Header row */}
            <div style={S.gridHeader}>
              <div style={S.gridCorner} />
              {DAYS.map((d, i) => {
                const date = weekDates[i];
                const isToday = date.toDateString() === new Date().toDateString();
                return (
                  <div key={d} style={{ ...S.gridDayHeader, ...(isToday ? S.todayHeader : {}) }}>
                    <span style={S.dayName}>{d}</span>
                    <span style={S.dayNum}>{date.getDate()}</span>
                  </div>
                );
              })}
            </div>

            {/* Staff rows */}
            {staff.map(s => (
              <div key={s.id} style={S.gridRow}>
                <div style={S.gridStaff}>
                  <div style={{ ...S.staffDot, background: s.colour }} />
                  <div style={S.staffInfo}>
                    <span style={S.staffName}>{s.name}</span>
                    <span style={S.staffRole}>{s.role}</span>
                  </div>
                </div>
                {DAY_KEYS.map((d, i) => {
                  const hrs = s.hours[d];
                  const isToday = weekDates[i].toDateString() === new Date().toDateString();
                  return (
                    <div key={d} style={{ ...S.gridCell, ...(isToday ? S.todayCell : {}) }}>
                      {hrs ? (
                        <div style={{ ...S.shiftBlock, background: s.colour + '22', borderLeft: `3px solid ${s.colour}` }}>
                          <span style={S.shiftTime}>{hrs.start}</span>
                          <span style={S.shiftTime}>{hrs.end}</span>
                        </div>
                      ) : (
                        <span style={S.offLabel}>Off</span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </>
      )}

      {/* Staff tab */}
      {tab === 'staff' && (
        <div style={S.staffList}>
          {staff.map(s => {
            const hrs = calcHours(s);
            const isSelected = selectedStaff === s.id;
            return (
              <div key={s.id} style={S.staffCard} onClick={() => setSelectedStaff(isSelected ? null : s.id)}>
                <div style={S.staffCardHeader}>
                  <div style={S.staffCardLeft}>
                    <div style={{ ...S.staffAvatar, background: s.colour + '22', color: s.colour }}>{s.name[0]}</div>
                    <div>
                      <span style={S.staffCardName}>{s.name}</span>
                      <span style={S.staffCardRole}>{s.role}</span>
                    </div>
                  </div>
                  <span style={S.hoursTag}>{hrs.toFixed(0)}h/week</span>
                </div>

                {isSelected && (
                  <div style={S.staffDetail}>
                    <span style={S.sectionLabel}>Weekly Schedule</span>
                    <div style={S.scheduleGrid}>
                      {DAY_KEYS.map((d, i) => {
                        const hrs = s.hours[d];
                        return (
                          <div key={d} style={S.scheduleItem}>
                            <span style={S.schedDay}>{DAYS[i]}</span>
                            <span style={{ ...S.schedTime, color: hrs ? 'var(--text, #2D2A26)' : '#AAA5A0' }}>
                              {hrs ? `${hrs.start}–${hrs.end}` : 'Off'}
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    {s.timeOff.length > 0 && (
                      <>
                        <span style={S.sectionLabel}>Upcoming Time Off</span>
                        {s.timeOff.map((to, i) => (
                          <div key={i} style={S.timeOffItem}>
                            <span style={S.timeOffDate}>{new Date(to.date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</span>
                            <span style={S.timeOffReason}>{to.reason}</span>
                          </div>
                        ))}
                      </>
                    )}

                    <div style={S.staffActions}>
                      <button style={S.staffActionBtn}>Edit Hours</button>
                      <button style={S.staffActionBtn}>Add Time Off</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Exceptions */}
      {tab === 'exceptions' && (
        <div style={S.exceptionList}>
          {DEV_EXCEPTIONS.length === 0 && <p style={S.empty}>No exceptions this period.</p>}
          {DEV_EXCEPTIONS.map(ex => {
            const s = staff.find(st => st.id === ex.staffId);
            return (
              <div key={ex.id} style={S.exCard}>
                <div style={S.exHeader}>
                  <div style={S.exLeft}>
                    <div style={{ ...S.staffDot, background: s?.colour || '#AAA5A0' }} />
                    <span style={S.exName}>{s?.name || 'Unknown'}</span>
                  </div>
                  <span style={{ ...S.exTypeBadge, background: ex.type === 'time-off' ? '#FFF5E6' : '#E3F2FD', color: ex.type === 'time-off' ? '#B8860B' : '#2196F3' }}>
                    {ex.type === 'time-off' ? 'Time Off' : 'Swap'}
                  </span>
                </div>
                <p style={S.exReason}>{ex.reason}</p>
                <span style={S.exDate}>
                  {new Date(ex.date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })}
                  {!ex.allDay && ` · ${ex.start}–${ex.end}`}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Time off modal */}
      {showAddTimeOff && (
        <div style={S.overlay} onClick={() => setShowAddTimeOff(false)}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <h2 style={S.modalTitle}>Add Time Off</h2>

            <div style={S.fieldLabel}>Staff Member</div>
            <select style={S.select} value={timeOffForm.staffId} onChange={e => setTimeOffForm(f => ({ ...f, staffId: e.target.value }))}>
              {staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>

            <div style={S.fieldLabel}>Date</div>
            <input style={S.input} type="date" value={timeOffForm.date} onChange={e => setTimeOffForm(f => ({ ...f, date: e.target.value }))} />

            <div style={S.fieldLabel}>Reason</div>
            <input style={S.input} placeholder="e.g. Dentist, Holiday, Training" value={timeOffForm.reason} onChange={e => setTimeOffForm(f => ({ ...f, reason: e.target.value }))} />

            <div style={S.toggleRow}>
              <span style={S.toggleLabel}>All day</span>
              <button style={{ ...S.toggle, background: timeOffForm.allDay ? '#C76B8A' : '#E0DCD8' }} onClick={() => setTimeOffForm(f => ({ ...f, allDay: !f.allDay }))}>
                <div style={{ ...S.toggleDot, transform: timeOffForm.allDay ? 'translateX(18px)' : 'translateX(2px)' }} />
              </button>
            </div>

            {!timeOffForm.allDay && (
              <div style={S.timeRow}>
                <div style={{ flex: 1 }}>
                  <div style={S.fieldLabel}>From</div>
                  <input style={S.input} type="time" value={timeOffForm.start} onChange={e => setTimeOffForm(f => ({ ...f, start: e.target.value }))} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={S.fieldLabel}>To</div>
                  <input style={S.input} type="time" value={timeOffForm.end} onChange={e => setTimeOffForm(f => ({ ...f, end: e.target.value }))} />
                </div>
              </div>
            )}

            <button style={S.saveBtn} onClick={() => setShowAddTimeOff(false)}>Save</button>
          </div>
        </div>
      )}
    </div>
  );
}

const S = {
  page: { padding: '20px 16px 32px', fontFamily: '"DM Sans", -apple-system, sans-serif', maxWidth: 480, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: 0 },
  addBtn: { background: '#C76B8A', color: '#fff', border: 'none', borderRadius: 20, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  statsRow: { display: 'flex', gap: 10, marginBottom: 16 },
  statCard: { flex: 1, background: 'var(--card, #fff)', borderRadius: 12, padding: '12px 8px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  statValue: { fontSize: 18, fontWeight: 700 },
  statLabel: { fontSize: 11, color: '#AAA5A0' },

  tabs: { display: 'flex', gap: 8, marginBottom: 16 },
  tab: { flex: 1, padding: '10px 0', border: 'none', borderRadius: 10, background: 'var(--card, #fff)', color: '#AAA5A0', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  tabActive: { background: '#C76B8A', color: '#fff' },

  // Week view
  weekNav: { display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 16, marginBottom: 12 },
  weekArrow: { background: 'none', border: 'none', fontSize: 22, color: '#AAA5A0', cursor: 'pointer', padding: '4px 8px' },
  weekLabel: { fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)' },

  grid: { background: 'var(--card, #fff)', borderRadius: 14, overflow: 'hidden' },
  gridHeader: { display: 'grid', gridTemplateColumns: '80px repeat(6, 1fr)', borderBottom: '1px solid #F0ECE8' },
  gridCorner: { padding: 8 },
  gridDayHeader: { padding: '8px 4px', textAlign: 'center' },
  todayHeader: { background: '#F0E6ED' },
  dayName: { fontSize: 11, fontWeight: 600, color: '#AAA5A0', display: 'block' },
  dayNum: { fontSize: 14, fontWeight: 700, color: 'var(--text, #2D2A26)' },

  gridRow: { display: 'grid', gridTemplateColumns: '80px repeat(6, 1fr)', borderBottom: '1px solid #F9F7F4', minHeight: 56 },
  gridStaff: { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 8px 8px 10px' },
  staffDot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  staffInfo: { display: 'flex', flexDirection: 'column' },
  staffName: { fontSize: 12, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  staffRole: { fontSize: 10, color: '#AAA5A0' },

  gridCell: { padding: 4, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  todayCell: { background: '#FDF9F7' },
  shiftBlock: { width: '100%', borderRadius: 6, padding: '4px 3px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 },
  shiftTime: { fontSize: 10, fontWeight: 500, color: 'var(--text, #2D2A26)' },
  offLabel: { fontSize: 10, color: '#DDD' },

  // Staff tab
  staffList: { display: 'flex', flexDirection: 'column', gap: 10 },
  staffCard: { background: 'var(--card, #fff)', borderRadius: 14, padding: 14, cursor: 'pointer' },
  staffCardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  staffCardLeft: { display: 'flex', gap: 10, alignItems: 'center' },
  staffAvatar: { width: 36, height: 36, borderRadius: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 600 },
  staffCardName: { fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)', display: 'block' },
  staffCardRole: { fontSize: 12, color: '#AAA5A0' },
  hoursTag: { padding: '4px 10px', borderRadius: 8, background: '#F0ECE8', fontSize: 12, fontWeight: 600, color: '#8B6F5E' },

  staffDetail: { marginTop: 12, paddingTop: 12, borderTop: '1px solid #F0ECE8' },
  sectionLabel: { fontSize: 11, fontWeight: 700, color: '#AAA5A0', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 8, marginTop: 12 },
  scheduleGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 },
  scheduleItem: { display: 'flex', flexDirection: 'column', background: '#F9F7F4', borderRadius: 8, padding: '6px 8px' },
  schedDay: { fontSize: 11, fontWeight: 600, color: '#AAA5A0' },
  schedTime: { fontSize: 13, fontWeight: 600 },
  timeOffItem: { display: 'flex', justifyContent: 'space-between', padding: '6px 0' },
  timeOffDate: { fontSize: 12, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  timeOffReason: { fontSize: 12, color: '#B8860B' },
  staffActions: { display: 'flex', gap: 8, marginTop: 12 },
  staffActionBtn: { flex: 1, padding: '9px 0', borderRadius: 8, border: '1px solid #F0ECE8', background: 'var(--card, #fff)', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', color: '#2D2A26' },

  // Exceptions
  exceptionList: { display: 'flex', flexDirection: 'column', gap: 10 },
  exCard: { background: 'var(--card, #fff)', borderRadius: 14, padding: 14 },
  exHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  exLeft: { display: 'flex', alignItems: 'center', gap: 8 },
  exName: { fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  exTypeBadge: { padding: '3px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600 },
  exReason: { fontSize: 13, color: '#8B6F5E', margin: '0 0 4px' },
  exDate: { fontSize: 12, color: '#AAA5A0' },
  empty: { textAlign: 'center', color: '#AAA5A0', fontSize: 14, padding: 32 },

  // Modal
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 200, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  modal: { background: '#fff', borderRadius: '16px 16px 0 0', padding: '20px 20px 32px', width: '100%', maxWidth: 480 },
  modalTitle: { fontSize: 18, fontWeight: 700, color: '#2D2A26', margin: '0 0 16px' },
  fieldLabel: { fontSize: 12, fontWeight: 600, color: '#8B6F5E', marginBottom: 6, marginTop: 12 },
  input: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #F0ECE8', fontSize: 14, fontFamily: 'inherit', color: '#2D2A26', outline: 'none', boxSizing: 'border-box' },
  select: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #F0ECE8', fontSize: 14, fontFamily: 'inherit', color: '#2D2A26', background: '#fff', outline: 'none', boxSizing: 'border-box' },
  toggleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 },
  toggleLabel: { fontSize: 14, fontWeight: 500, color: 'var(--text, #2D2A26)' },
  toggle: { width: 44, height: 26, borderRadius: 13, border: 'none', padding: 0, cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0 },
  toggleDot: { width: 22, height: 22, borderRadius: 11, background: '#fff', position: 'absolute', top: 2, transition: 'transform 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.15)' },
  timeRow: { display: 'flex', gap: 12 },
  saveBtn: { width: '100%', padding: '14px 0', borderRadius: 12, border: 'none', background: '#C76B8A', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginTop: 20 },
};
