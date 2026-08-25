/**
 * Staff Rota - Weekly availability & shift management.
 *
 * For when Ellie expands - tracks who's working when,
 * manages chair rentals, and prevents double-bookings.
 * Works for solo too: shows her own availability at a glance.
 */
import { useState, useEffect } from 'react';
import { useBeautician, supabase, fetchRows, insertRow, updateRow, deleteRow } from '../lib/supabase.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';
import PageHeader from '../components/ui/PageHeader.jsx';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export default function StaffRota() {
  const { beautician, loading: bLoading } = useBeautician();
  const [tab, setTab] = useState('week');
  const [loading, setLoading] = useState(true);
  const [weekOffset, setWeekOffset] = useState(0);
  const [selectedStaff, setSelectedStaff] = useState(null);
  const [showAddTimeOff, setShowAddTimeOff] = useState(false);
  const [editingShift, setEditingShift] = useState(null);
  const [shiftForm, setShiftForm] = useState({ name: '', role: '', colour: '#C76B8A', hours: { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null } });
  const [timeOffForm, setTimeOffForm] = useState({ staffId: '', date: '', reason: '', allDay: true, start: '', end: '' });
  const [staff, setStaff] = useState([]);
  const [exceptions, setExceptions] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (beautician && !bLoading) loadRota();
  }, [beautician, bLoading]);

  // team_members rows store first_name/last_name/working_hours; this page
  // renders name/hours/colour. Normalise so real rows display correctly
  // instead of showing blank names and "Off" for every day.
  const PALETTE = ['#C76B8A', '#6B8F7B', '#735C4E', '#7B85C7', '#C7A86B'];
  function normaliseStaff(rows) {
    return (rows || []).map((r, i) => ({
      ...r,
      name: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || r.name || 'Team member',
      role: r.role ? r.role.charAt(0).toUpperCase() + r.role.slice(1) : 'Stylist',
      colour: r.colour || PALETTE[i % PALETTE.length],
      hours: r.hours || r.working_hours || { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null },
    }));
  }

  async function loadRota() {
    setLoading(true);
    setError(null);
    try {
        const teamData = await fetchRows('team_members', beautician.id, { order: 'created_at' });
        setStaff(normaliseStaff(teamData));

        const { data: excepData, error: excepErr } = await supabase
          .from('hours_exceptions')
          .select('*')
          .eq('beautician_id', beautician.id);
        if (excepErr) throw excepErr;
        setExceptions(excepData || []);
    } catch (err) {
      logger.error('Load rota error:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (bLoading || loading) {
    return <PageLoader />;
  }

  if (error) {
    return <ErrorCard message={error} onDismiss={() => setError(null)} />;
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
  const weekLabel = `${weekDates[0].toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} - ${weekDates[5].toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;

  // Total hours per staff this week
  const calcHours = (s) => {
    let total = 0;
    DAY_KEYS.forEach(d => {
      if (s.hours && s.hours[d]) {
        const [sh, sm] = s.hours[d].start.split(':').map(Number);
        const [eh, em] = s.hours[d].end.split(':').map(Number);
        total += (eh + em / 60) - (sh + sm / 60);
      }
    });
    return total;
  };

  const totalWeekHours = staff.reduce((s, p) => s + calcHours(p), 0);

  const handleSaveTimeOff = async () => {
    if (!timeOffForm.date) {
      setError('Please choose a date');
      return;
    }
    try {
      // hours_exceptions is salon-wide (no staff_id column), so time off
      // applies to the whole diary. We don't send staff_id (it would error).
      const row = {
        beautician_id: beautician?.id,
        date: timeOffForm.date,
        reason: timeOffForm.reason,
        type: 'time-off',
        note: timeOffForm.reason,
        start_time: timeOffForm.allDay ? null : timeOffForm.start,
        end_time: timeOffForm.allDay ? null : timeOffForm.end,
      };
      if (beautician) {
        await insertRow('hours_exceptions', row);
      }
      setExceptions(prev => [...prev, { id: 'new-' + Date.now(), staffId: timeOffForm.staffId, date: timeOffForm.date, type: 'time-off', reason: timeOffForm.reason, allDay: timeOffForm.allDay, start: timeOffForm.start, end: timeOffForm.end }]);
      setShowAddTimeOff(false);
      setTimeOffForm({ staffId: '', date: '', reason: '', allDay: true, start: '', end: '' });
      setError(null);
    } catch (err) {
      logger.error('Save time off error:', err);
      setError(err.message);
    }
  };

  const handleDeleteException = async (exId) => {
    if (!window.confirm('Delete this exception?')) return;
    try {
      if (beautician) {
        await deleteRow('hours_exceptions', exId);
      }
      setExceptions(prev => prev.filter(ex => ex.id !== exId));
      setError(null);
    } catch (err) {
      logger.error('Delete exception error:', err);
      setError(err.message);
    }
  };

  const handleEditShift = (staffMember) => {
    setEditingShift(staffMember.id);
    setShiftForm({
      name: staffMember.name,
      role: staffMember.role,
      colour: staffMember.colour,
      hours: staffMember.hours || { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null },
    });
  };

  const handleSaveShift = async () => {
    if (!shiftForm.name || !editingShift) {
      setError('Please fill in name');
      return;
    }
    try {
      // Map back to real team_members columns (first_name/last_name/role/
      // working_hours). colour is a display-only field with no DB column,
      // so it's kept in local state but not persisted.
      const [firstName, ...rest] = shiftForm.name.trim().split(' ');
      const dbUpdates = {
        first_name: firstName || shiftForm.name.trim(),
        last_name: rest.join(' ') || null,
        role: (shiftForm.role || 'stylist').toLowerCase(),
        working_hours: shiftForm.hours,
      };
      if (beautician) {
        await updateRow('team_members', editingShift, dbUpdates);
      }
      const localUpdates = {
        name: shiftForm.name,
        role: shiftForm.role,
        colour: shiftForm.colour,
        hours: shiftForm.hours,
      };
      setStaff(prev => prev.map(s => s.id === editingShift ? { ...s, ...localUpdates } : s));
      setEditingShift(null);
      setError(null);
    } catch (err) {
      logger.error('Save shift error:', err);
      setError(err.message);
    }
  };

  const handleDeleteStaff = async (staffId) => {
    if (!window.confirm('Delete this staff member?')) return;
    try {
      if (beautician) {
        await deleteRow('team_members', staffId);
      }
      setStaff(prev => prev.filter(s => s.id !== staffId));
      setSelectedStaff(null);
      setError(null);
    } catch (err) {
      logger.error('Delete staff error:', err);
      setError(err.message);
    }
  };

  return (
    <div style={S.page}>
      <PageHeader
        title="Staff Rota"
        action={<button style={S.addBtn} onClick={() => setShowAddTimeOff(true)}>+ Time Off</button>}
      />

      {error && <div style={{ ...S.errorBox, marginBottom: 16 }}>{error}</div>}

      {/* Stats */}
      <div style={S.statsRow}>
        <div style={S.statCard}>
          <span style={{ ...S.statValue, color: 'var(--accent, #92405e)' }}>{staff.length}</span>
          <span style={S.statLabel}>Team</span>
        </div>
        <div style={S.statCard}>
          <span style={{ ...S.statValue, color: 'var(--success, #386F52)' }}>{totalWeekHours.toFixed(0)}h</span>
          <span style={S.statLabel}>Weekly Hours</span>
        </div>
        <div style={S.statCard}>
          <span style={{ ...S.statValue, color: '#735C4E' }}>{exceptions.length}</span>
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

      {/* No team yet: rota is a team feature */}
      {staff.length === 0 && tab !== 'exceptions' && (
        <EmptyState
          icon="calendar"
          title="No team to schedule yet"
          subtitle="Add stylists or assistants in Team, and their shifts will show up here. You can still add salon time off using the button above."
        />
      )}

      {/* Week view */}
      {tab === 'week' && staff.length > 0 && (
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
                  const hrs = s.hours && s.hours[d];
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
      {tab === 'staff' && staff.length > 0 && (
        <div style={S.staffList}>
          {staff.map(s => {
            const hrs = calcHours(s);
            const isSelected = selectedStaff === s.id;
            return (
              <div key={s.id}>
                <div style={S.staffCard} onClick={() => setSelectedStaff(isSelected ? null : s.id)}>
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
                          const hrs = s.hours && s.hours[d];
                          return (
                            <div key={d} style={S.scheduleItem}>
                              <span style={S.schedDay}>{DAYS[i]}</span>
                              <span style={{ ...S.schedTime, color: hrs ? 'var(--text, #241B17)' : '#AAA5A0' }}>
                                {hrs ? `${hrs.start}–${hrs.end}` : 'Off'}
                              </span>
                            </div>
                          );
                        })}
                      </div>

                      <div style={S.staffActions}>
                        <button style={S.staffActionBtn} onClick={() => handleEditShift(s)}>Edit Hours</button>
                        <button style={S.staffActionBtn} onClick={() => handleDeleteStaff(s.id)}>Delete</button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Exceptions */}
      {tab === 'exceptions' && (
        <div style={S.exceptionList}>
          {exceptions.length === 0 && <p style={S.empty}>No exceptions this period.</p>}
          {exceptions.map(ex => {
            return (
              <div key={ex.id} style={S.exCard}>
                <div style={S.exHeader}>
                  <div style={S.exLeft}>
                    <div style={{ ...S.staffDot, background: 'var(--accent, #92405e)' }} />
                    <span style={S.exName}>Salon closed</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ ...S.exTypeBadge, background: ex.type === 'time-off' ? '#FFF5E6' : '#E3F2FD', color: ex.type === 'time-off' ? '#886308' : '#0966af' }}>
                      {ex.type === 'time-off' ? 'Time Off' : 'Swap'}
                    </span>
                    <button style={S.deleteBtn} onClick={() => handleDeleteException(ex.id)}>×</button>
                  </div>
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
            <p style={{ ...S.fieldLabel, marginTop: 0, fontWeight: 500 }}>This closes your diary for the day so no new bookings come in.</p>

            <div style={S.fieldLabel}>Date</div>
            <input style={S.input} type="date" value={timeOffForm.date} onChange={e => setTimeOffForm(f => ({ ...f, date: e.target.value }))} />

            <div style={S.fieldLabel}>Reason</div>
            <input style={S.input} placeholder="e.g. Dentist, Holiday, Training" value={timeOffForm.reason} onChange={e => setTimeOffForm(f => ({ ...f, reason: e.target.value }))} />

            <div style={S.toggleRow}>
              <span style={S.toggleLabel}>All day</span>
              <button style={{ ...S.toggle, background: timeOffForm.allDay ? 'var(--accent-rose, #C76B8A)' : '#E0DCD8' }} onClick={() => setTimeOffForm(f => ({ ...f, allDay: !f.allDay }))}>
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

            {error && <div style={{ ...S.errorBox, marginTop: 12 }}>{error}</div>}

            <button style={S.saveBtn} onClick={handleSaveTimeOff}>Save</button>
          </div>
        </div>
      )}

      {/* Edit shift modal */}
      {editingShift && (
        <div style={S.overlay} onClick={() => setEditingShift(null)}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <h2 style={S.modalTitle}>Edit {shiftForm.name}</h2>

            <div style={S.fieldLabel}>Name</div>
            <input style={S.input} value={shiftForm.name} onChange={e => setShiftForm(f => ({ ...f, name: e.target.value }))} />

            <div style={S.fieldLabel}>Role</div>
            <input style={S.input} value={shiftForm.role} onChange={e => setShiftForm(f => ({ ...f, role: e.target.value }))} />

            <div style={S.fieldLabel}>Colour</div>
            <input style={S.input} type="color" value={shiftForm.colour} onChange={e => setShiftForm(f => ({ ...f, colour: e.target.value }))} />

            <div style={S.fieldLabel}>Hours by Day</div>
            {DAY_KEYS.map((d, i) => (
              <div key={d} style={S.dayEditRow}>
                <span style={{ width: 50, fontWeight: 600, color: 'var(--text, #241B17)' }}>{DAYS[i]}</span>
                <input style={{ ...S.input, flex: 1, fontSize: 12 }} type="time" placeholder="Start" value={shiftForm.hours[d]?.start || ''} onChange={e => {
                  const newHours = { ...shiftForm.hours };
                  if (e.target.value) {
                    newHours[d] = { ...newHours[d], start: e.target.value };
                  }
                  setShiftForm(f => ({ ...f, hours: newHours }));
                }} />
                <input style={{ ...S.input, flex: 1, fontSize: 12 }} type="time" placeholder="End" value={shiftForm.hours[d]?.end || ''} onChange={e => {
                  const newHours = { ...shiftForm.hours };
                  if (e.target.value) {
                    newHours[d] = { ...newHours[d], end: e.target.value };
                  }
                  setShiftForm(f => ({ ...f, hours: newHours }));
                }} />
                <button style={{ ...S.input, flex: 0.3, fontSize: 12, color: 'var(--accent, #92405e)', cursor: 'pointer' }} onClick={() => {
                  const newHours = { ...shiftForm.hours };
                  newHours[d] = null;
                  setShiftForm(f => ({ ...f, hours: newHours }));
                }}>Clear</button>
              </div>
            ))}

            {error && <div style={{ ...S.errorBox, marginTop: 12 }}>{error}</div>}

            <button style={S.saveBtn} onClick={handleSaveShift}>Save</button>
          </div>
        </div>
      )}
    </div>
  );
}

const S = {
  page: { padding: '20px 16px 32px', fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif", maxWidth: 480, margin: '0 auto' },
  addBtn: { background: 'var(--accent, #92405e)', color: '#fff', border: 'none', borderRadius: 22, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  errorBox: { background: 'var(--danger-bg, #F7E4E4)', borderRadius: 10, padding: '10px 12px', color: 'var(--danger, #9E2B32)', fontSize: 13, fontWeight: 500 },

  statsRow: { display: 'flex', gap: 10, marginBottom: 16 },
  statCard: { flex: 1, background: 'var(--card, #FFFCF9)', borderRadius: 10, padding: '12px 8px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  statValue: { fontSize: 18, fontWeight: 700 },
  statLabel: { fontSize: 11, color: 'var(--text-muted, #6B5D54)' },

  tabs: { display: 'flex', gap: 8, marginBottom: 16 },
  tab: { flex: 1, padding: '10px 0', border: 'none', borderRadius: 10, background: 'var(--card, #FFFCF9)', color: 'var(--text-muted, #6B5D54)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  tabActive: { background: 'var(--accent, #92405e)', color: '#fff' },

  // Week view
  weekNav: { display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 16, marginBottom: 12 },
  weekArrow: { background: 'none', border: 'none', fontSize: 22, color: 'var(--text-muted, #6B5D54)', cursor: 'pointer', padding: '4px 8px' },
  weekLabel: { fontSize: 14, fontWeight: 600, color: 'var(--text, #241B17)' },

  grid: { background: 'var(--card, #FFFCF9)', borderRadius: 16, overflow: 'hidden' },
  gridHeader: { display: 'grid', gridTemplateColumns: '80px repeat(6, 1fr)', borderBottom: '1px solid var(--border, #E8DDD4)' },
  gridCorner: { padding: 8 },
  gridDayHeader: { padding: '8px 4px', textAlign: 'center' },
  todayHeader: { background: 'var(--accent-light, #F6E7EC)' },
  dayName: { fontSize: 11, fontWeight: 600, color: 'var(--text-muted, #6B5D54)', display: 'block' },
  dayNum: { fontSize: 14, fontWeight: 700, color: 'var(--text, #241B17)' },

  gridRow: { display: 'grid', gridTemplateColumns: '80px repeat(6, 1fr)', borderBottom: '1px solid var(--border, #E8DDD4)', minHeight: 56 },
  gridStaff: { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 8px 8px 10px' },
  staffDot: { width: 8, height: 8, borderRadius: 'var(--radius-xs)', flexShrink: 0 },
  staffInfo: { display: 'flex', flexDirection: 'column' },
  staffName: { fontSize: 12, fontWeight: 600, color: 'var(--text, #241B17)' },
  staffRole: { fontSize: 10, color: 'var(--text-muted, #6B5D54)' },

  gridCell: { padding: 4, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  todayCell: { background: 'var(--bg, #FBF6F1)' },
  shiftBlock: { width: '100%', borderRadius: 'var(--radius-xs)', padding: '4px 3px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 },
  shiftTime: { fontSize: 10, fontWeight: 500, color: 'var(--text, #241B17)' },
  offLabel: { fontSize: 10, color: 'var(--text-muted, #6B5D54)' },

  // Staff tab
  staffList: { display: 'flex', flexDirection: 'column', gap: 10 },
  staffCard: { background: 'var(--card, #FFFCF9)', borderRadius: 16, padding: 14, cursor: 'pointer' },
  staffCardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  staffCardLeft: { display: 'flex', gap: 10, alignItems: 'center' },
  staffAvatar: { width: 36, height: 36, borderRadius: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 600 },
  staffCardName: { fontSize: 14, fontWeight: 600, color: 'var(--text, #241B17)', display: 'block' },
  staffCardRole: { fontSize: 12, color: 'var(--text-muted, #6B5D54)' },
  hoursTag: { padding: '4px 10px', borderRadius: 10, background: 'var(--border, #E8DDD4)', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary, #574A42)' },

  staffDetail: { marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border, #E8DDD4)' },
  sectionLabel: { fontSize: 11, fontWeight: 700, color: 'var(--text-muted, #6B5D54)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 8, marginTop: 12 },
  scheduleGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 },
  scheduleItem: { display: 'flex', flexDirection: 'column', background: 'var(--bg-hover, #f3ede9)', borderRadius: 10, padding: '6px 8px' },
  schedDay: { fontSize: 11, fontWeight: 600, color: 'var(--text-muted, #6B5D54)' },
  schedTime: { fontSize: 13, fontWeight: 600 },
  timeOffItem: { display: 'flex', justifyContent: 'space-between', padding: '6px 0' },
  timeOffDate: { fontSize: 12, fontWeight: 600, color: 'var(--text, #241B17)' },
  timeOffReason: { fontSize: 12, color: 'var(--gold-text, #795f2b)' },
  staffActions: { display: 'flex', gap: 8, marginTop: 12 },
  staffActionBtn: { flex: 1, padding: '9px 0', borderRadius: 10, border: '1px solid var(--border, #E8DDD4)', background: 'var(--card, #FFFCF9)', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text, #241B17)' },

  // Exceptions
  exceptionList: { display: 'flex', flexDirection: 'column', gap: 10 },
  exCard: { background: 'var(--card, #FFFCF9)', borderRadius: 16, padding: 14 },
  exHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  exLeft: { display: 'flex', alignItems: 'center', gap: 8 },
  exName: { fontSize: 14, fontWeight: 600, color: 'var(--text, #241B17)' },
  exTypeBadge: { padding: '3px 10px', borderRadius: 10, fontSize: 11, fontWeight: 600 },
  exReason: { fontSize: 13, color: 'var(--text-secondary, #574A42)', margin: '0 0 4px' },
  exDate: { fontSize: 12, color: 'var(--text-muted, #6B5D54)' },
  deleteBtn: { background: 'none', border: 'none', fontSize: 22, color: 'var(--text-muted, #6B5D54)', cursor: 'pointer', padding: '0 4px', lineHeight: 1 },
  empty: { textAlign: 'center', color: 'var(--text-muted, #6B5D54)', fontSize: 14, padding: 32 },

  // Modal
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 960, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  modal: { background: 'var(--bg-card, #FFFCF9)', borderRadius: '16px 16px 0 0', padding: '20px 20px 32px', paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 20px)', width: '100%', maxWidth: 480 },
  modalTitle: { fontSize: 18, fontWeight: 700, color: 'var(--text, #241B17)', margin: '0 0 16px' },
  fieldLabel: { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary, #574A42)', marginBottom: 6, marginTop: 12 },
  input: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border, #E8DDD4)', fontSize: 14, fontFamily: 'inherit', color: 'var(--text, #241B17)', outline: 'none', boxSizing: 'border-box' },
  select: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border, #E8DDD4)', fontSize: 14, fontFamily: 'inherit', color: 'var(--text, #241B17)', background: 'var(--bg-card, #FFFCF9)', outline: 'none', boxSizing: 'border-box' },
  toggleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 },
  toggleLabel: { fontSize: 14, fontWeight: 500, color: 'var(--text, #241B17)' },
  toggle: { width: 44, height: 26, borderRadius: 16, border: 'none', padding: 0, cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0 },
  toggleDot: { width: 22, height: 22, borderRadius: 10, background: 'var(--bg-card, #FFFCF9)', position: 'absolute', top: 2, transition: 'transform 0.2s', boxShadow: 'var(--elev-1)' },
  timeRow: { display: 'flex', gap: 12 },
  saveBtn: { width: '100%', padding: '14px 0', borderRadius: 10, border: 'none', background: 'var(--accent, #92405e)', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginTop: 20 },
  dayEditRow: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 },
};
