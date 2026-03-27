import { useState, useEffect } from 'react';
import { useBeautician, supabase, isDevMode, updateRow, insertRow } from '../lib/supabase.js';

/**
 * CalendarView — Day and Week view of appointments.
 * Wired to Supabase with client/treatment joins.
 */

const HOUR_HEIGHT = 60;
const START_HOUR = 8;
const END_HOUR = 20;

export default function CalendarView() {
  const { beautician, loading: bLoading } = useBeautician();
  const [view, setView] = useState('day');
  const [currentDate, setCurrentDate] = useState(new Date());
  const [appointments, setAppointments] = useState([]);
  const [selectedAppointment, setSelectedAppointment] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (beautician) loadAppointments();
  }, [beautician, currentDate, view]);

  async function loadAppointments() {
    setLoading(true);
    const from = view === 'day' ? formatDate(currentDate) : formatDate(getWeekStart(currentDate));
    const to = view === 'day' ? formatDate(currentDate) : formatDate(getWeekEnd(currentDate));

    try {
      if (isDevMode) {
        setAppointments([]);
        setLoading(false);
        return;
      }

      const { data, error } = await supabase
        .from('appointments')
        .select('*, clients(first_name, last_name), treatments(name)')
        .eq('beautician_id', beautician.id)
        .gte('starts_at', `${from}T00:00:00Z`)
        .lte('starts_at', `${to}T23:59:59Z`)
        .order('starts_at');

      if (error) console.error('Calendar load:', error);
      setAppointments(data || []);
    } catch (err) {
      console.error('Calendar load error:', err);
    } finally {
      setLoading(false);
    }
  }

  function navigateDate(direction) {
    const delta = view === 'day' ? 1 : 7;
    const newDate = new Date(currentDate);
    newDate.setDate(newDate.getDate() + (direction * delta));
    setCurrentDate(newDate);
  }

  function getAppointmentsForDate(date) {
    const dateStr = formatDate(date);
    return appointments.filter(a => a.starts_at?.startsWith(dateStr));
  }

  function getBlockStyle(appointment) {
    const start = new Date(appointment.starts_at);
    const end = new Date(appointment.ends_at);
    const startMinutes = start.getHours() * 60 + start.getMinutes();
    const endMinutes = end.getHours() * 60 + end.getMinutes();
    const top = ((startMinutes - START_HOUR * 60) / 60) * HOUR_HEIGHT;
    const height = ((endMinutes - startMinutes) / 60) * HOUR_HEIGHT;
    return { top: Math.max(0, top), height: Math.max(height, 24) };
  }

  function getStatusColor(status) {
    const colors = { confirmed: '#5BA67F', pending: '#D4A843', in_progress: '#4A90D9', completed: '#8A8580', cancelled_by_client: '#DC2626', cancelled_by_beautician: '#DC2626', no_show: '#EF4444', rescheduled: '#7C6EAF' };
    return colors[status] || '#8A8580';
  }

  function getWeekDays() {
    const start = getWeekStart(currentDate);
    return Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d; });
  }

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div style={styles.headerTop}>
          <button onClick={() => navigateDate(-1)} style={styles.navBtn}>‹</button>
          <div style={styles.headerCenter}>
            <h1 style={styles.dateTitle}>
              {view === 'day'
                ? currentDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
                : `${getWeekStart(currentDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} — ${getWeekEnd(currentDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`}
            </h1>
            <button onClick={() => setCurrentDate(new Date())} style={styles.todayBtn}>Today</button>
          </div>
          <button onClick={() => navigateDate(1)} style={styles.navBtn}>›</button>
        </div>
        <div style={styles.viewToggle}>
          <button onClick={() => setView('day')} style={{ ...styles.toggleBtn, background: view === 'day' ? '#C4A882' : 'transparent', color: view === 'day' ? '#fff' : '#8A8580' }}>Day</button>
          <button onClick={() => setView('week')} style={{ ...styles.toggleBtn, background: view === 'week' ? '#C4A882' : 'transparent', color: view === 'week' ? '#fff' : '#8A8580' }}>Week</button>
        </div>
      </div>

      {/* Day View */}
      {view === 'day' && (
        <div style={styles.dayGrid}>
          <div style={styles.timeColumn}>
            {Array.from({ length: END_HOUR - START_HOUR }, (_, i) => (
              <div key={i} style={{ ...styles.timeLabel, top: i * HOUR_HEIGHT }}>
                {`${(START_HOUR + i).toString().padStart(2, '0')}:00`}
              </div>
            ))}
          </div>
          <div style={{ ...styles.appointmentColumn, height: (END_HOUR - START_HOUR) * HOUR_HEIGHT }}>
            {Array.from({ length: END_HOUR - START_HOUR }, (_, i) => (
              <div key={i} style={{ ...styles.hourLine, top: i * HOUR_HEIGHT }} />
            ))}
            {isToday(currentDate) && (
              <div style={{ ...styles.nowLine, top: getNowPosition() }}>
                <div style={styles.nowDot} />
              </div>
            )}
            {getAppointmentsForDate(currentDate).map(appt => {
              const pos = getBlockStyle(appt);
              const statusColor = getStatusColor(appt.status);
              return (
                <button key={appt.id} onClick={() => setSelectedAppointment(selectedAppointment?.id === appt.id ? null : appt)}
                  style={{ ...styles.appointmentBlock, top: pos.top, height: pos.height, borderLeftColor: statusColor, background: selectedAppointment?.id === appt.id ? '#F5F2EF' : '#fff' }}>
                  <div style={styles.apptContent}>
                    <span style={styles.apptTime}>{new Date(appt.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
                    <span style={styles.apptClient}>{appt.clients?.first_name} {appt.clients?.last_name || ''}</span>
                    <span style={styles.apptTreatment}>{appt.treatments?.name}</span>
                    {appt.ai_booked && <span style={styles.aiTag}>AI booked</span>}
                  </div>
                </button>
              );
            })}
            {!loading && getAppointmentsForDate(currentDate).length === 0 && (
              <div style={{ position: 'absolute', top: '40%', left: 0, right: 0, textAlign: 'center' }}>
                <p style={{ fontSize: 13, color: '#C4BDB6' }}>No appointments</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Week View */}
      {view === 'week' && (
        <div>
          <div style={styles.weekHeader}>
            {getWeekDays().map(day => (
              <button key={day.toISOString()} onClick={() => { setCurrentDate(day); setView('day'); }}
                style={{ ...styles.weekDayHeader, background: isToday(day) ? '#C4A882' : 'transparent', color: isToday(day) ? '#fff' : '#2D2A26' }}>
                <span style={styles.weekDayName}>{day.toLocaleDateString('en-GB', { weekday: 'short' })}</span>
                <span style={styles.weekDayNumber}>{day.getDate()}</span>
              </button>
            ))}
          </div>
          <div style={styles.weekBody}>
            {getWeekDays().map(day => {
              const dayAppts = getAppointmentsForDate(day);
              return (
                <div key={day.toISOString()} style={styles.weekDayColumn}>
                  {dayAppts.map(appt => (
                    <div key={appt.id} style={{ ...styles.weekApptChip, borderLeftColor: getStatusColor(appt.status) }}>
                      <span style={styles.weekApptTime}>{new Date(appt.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
                      <span style={styles.weekApptName}>{appt.clients?.first_name?.charAt(0)}.</span>
                    </div>
                  ))}
                  {dayAppts.length === 0 && <div style={styles.weekEmpty} />}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Selected appointment detail + completion flow */}
      {selectedAppointment && (
        <AppointmentDetail
          appointment={selectedAppointment}
          beautician={beautician}
          onClose={() => setSelectedAppointment(null)}
          onUpdate={() => { loadAppointments(); setSelectedAppointment(null); }}
          getStatusColor={getStatusColor}
        />
      )}
    </div>
  );
}

/**
 * AppointmentDetail — detail panel with completion flow.
 * Mark done → log payment → add notes → rebook prompt → before/after photo.
 */
function AppointmentDetail({ appointment, beautician, onClose, onUpdate, getStatusColor }) {
  const [mode, setMode] = useState('detail'); // detail | completing | done
  const [notes, setNotes] = useState(appointment.beautician_notes || '');
  const [paymentMethod, setPaymentMethod] = useState('card');
  const [rebookWeeks, setRebookWeeks] = useState(4);
  const [beforeAfterUrl, setBeforeAfterUrl] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  async function handleComplete() {
    setSaving(true);
    try {
      if (!isDevMode) {
        // Update appointment
        await updateRow('appointments', appointment.id, {
          status: 'completed',
          completed_at: new Date().toISOString(),
          beautician_notes: notes || null,
          payment_method: paymentMethod
        });
        // Log income transaction
        await insertRow('transactions', {
          beautician_id: beautician.id,
          appointment_id: appointment.id,
          client_id: appointment.client_id,
          treatment_id: appointment.treatment_id,
          amount_cents: appointment.price_cents,
          type: 'service',
          payment_method: paymentMethod,
          description: `${appointment.treatments?.name} — ${appointment.clients?.first_name}`
        });
      }
      setMode('done');
    } catch (err) {
      console.error('Complete error:', err);
    } finally {
      setSaving(false);
    }
  }

  async function handlePhotoUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      if (!isDevMode) {
        const path = `${beautician.id}/before-after/${Date.now()}-${file.name}`;
        const { error } = await supabase.storage.from('content-images').upload(path, file);
        if (!error) {
          const { data } = supabase.storage.from('content-images').getPublicUrl(path);
          setBeforeAfterUrl(data?.publicUrl);
        }
      } else {
        setBeforeAfterUrl(URL.createObjectURL(file));
      }
    } catch (err) {
      console.error('Upload error:', err);
    } finally {
      setUploading(false);
    }
  }

  function handleDone() {
    onUpdate();
  }

  const isCompleted = appointment.status === 'completed';
  const canComplete = ['confirmed', 'pending', 'in_progress'].includes(appointment.status);

  return (
    <div style={styles.detailPanel}>
      <div style={styles.detailHeader}>
        <h3 style={styles.detailTitle}>{appointment.clients?.first_name} {appointment.clients?.last_name || ''}</h3>
        <button onClick={onClose} style={styles.detailClose}>×</button>
      </div>

      {mode === 'detail' && (
        <>
          <div style={styles.detailGrid}>
            <div style={styles.detailRow}><span style={styles.detailLabel}>Treatment</span><span style={styles.detailValue}>{appointment.treatments?.name}</span></div>
            <div style={styles.detailRow}><span style={styles.detailLabel}>Time</span><span style={styles.detailValue}>{new Date(appointment.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} — {appointment.ends_at ? new Date(appointment.ends_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''}</span></div>
            <div style={styles.detailRow}><span style={styles.detailLabel}>Price</span><span style={styles.detailValue}>£{(appointment.price_cents / 100).toFixed(2)}</span></div>
            <div style={styles.detailRow}>
              <span style={styles.detailLabel}>Status</span>
              <span style={{ ...styles.statusBadge, background: getStatusColor(appointment.status) + '20', color: getStatusColor(appointment.status) }}>{appointment.status?.replace(/_/g, ' ')}</span>
            </div>
            {appointment.buffer_minutes > 0 && (
              <div style={styles.detailRow}><span style={styles.detailLabel}>Buffer</span><span style={styles.detailValue}>{appointment.buffer_minutes} min cleanup</span></div>
            )}
            {appointment.ai_booked && <div style={styles.detailRow}><span style={styles.detailLabel}>Booked by</span><span style={styles.aiTag}>AI Front Desk</span></div>}
          </div>
          {canComplete && (
            <button onClick={() => setMode('completing')} style={styles.completeBtn}>
              Mark as complete
            </button>
          )}
        </>
      )}

      {mode === 'completing' && (
        <div style={styles.completionFlow}>
          {/* Payment method */}
          <div style={styles.completionSection}>
            <span style={styles.completionLabel}>Payment</span>
            <div style={styles.paymentOptions}>
              {['card', 'cash', 'transfer', 'unpaid'].map(m => (
                <button key={m} onClick={() => setPaymentMethod(m)}
                  style={{ ...styles.paymentChip, background: paymentMethod === m ? '#C76B8A' : '#F5F2EF', color: paymentMethod === m ? '#fff' : '#666' }}>
                  {m === 'card' ? '💳' : m === 'cash' ? '💵' : m === 'transfer' ? '🏦' : '⏳'} {m}
                </button>
              ))}
            </div>
          </div>

          {/* Notes */}
          <div style={styles.completionSection}>
            <span style={styles.completionLabel}>Treatment notes</span>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Colour mix, skin reaction, preferences..."
              style={styles.notesInput}
              rows={3}
            />
          </div>

          {/* Before/After photo */}
          <div style={styles.completionSection}>
            <span style={styles.completionLabel}>Before/after photo</span>
            <p style={styles.photoHint}>Feeds into Content Autopilot for Instagram posts</p>
            {beforeAfterUrl ? (
              <div style={styles.photoPreview}>
                <img src={beforeAfterUrl} alt="Before/after" style={styles.photoImg} />
                <button onClick={() => setBeforeAfterUrl(null)} style={styles.photoRemove}>×</button>
              </div>
            ) : (
              <label style={styles.photoUploadBtn}>
                📸 {uploading ? 'Uploading...' : 'Take or upload photo'}
                <input type="file" accept="image/*" capture="environment" onChange={handlePhotoUpload} style={{ display: 'none' }} />
              </label>
            )}
          </div>

          <button onClick={handleComplete} disabled={saving} style={styles.confirmCompleteBtn}>
            {saving ? 'Saving...' : `Complete — £${(appointment.price_cents / 100).toFixed(2)} ${paymentMethod}`}
          </button>
        </div>
      )}

      {mode === 'done' && (
        <div style={styles.doneScreen}>
          <span style={{ fontSize: 40 }}>✅</span>
          <h3 style={{ fontSize: 18, fontWeight: 700, margin: '12px 0 4px' }}>Done!</h3>
          <p style={{ fontSize: 14, color: '#888', marginBottom: 16 }}>
            £{(appointment.price_cents / 100).toFixed(2)} logged via {paymentMethod}
          </p>

          {/* Rebook prompt */}
          <div style={styles.rebookSection}>
            <span style={styles.completionLabel}>Rebook {appointment.clients?.first_name}?</span>
            <div style={styles.rebookOptions}>
              {[3, 4, 5, 6, 8].map(w => (
                <button key={w} onClick={() => setRebookWeeks(w)}
                  style={{ ...styles.rebookChip, background: rebookWeeks === w ? '#C76B8A' : '#F5F2EF', color: rebookWeeks === w ? '#fff' : '#666' }}>
                  {w} weeks
                </button>
              ))}
            </div>
            <button style={styles.rebookSendBtn}>
              Send rebook reminder in {rebookWeeks} weeks
            </button>
          </div>

          <button onClick={handleDone} style={styles.doneCloseBtn}>Close</button>
        </div>
      )}
    </div>
  );
}

function formatDate(d) { return d.toISOString().split('T')[0]; }
function isToday(d) { return d.toDateString() === new Date().toDateString(); }
function getWeekStart(d) { const s = new Date(d); const day = s.getDay(); s.setDate(s.getDate() + (day === 0 ? -6 : 1 - day)); return s; }
function getWeekEnd(d) { const e = getWeekStart(d); e.setDate(e.getDate() + 6); return e; }
function getNowPosition() { const now = new Date(); return ((now.getHours() * 60 + now.getMinutes() - START_HOUR * 60) / 60) * HOUR_HEIGHT; }

const styles = {
  page: { minHeight: '100vh', background: '#FAF8F5', fontFamily: '"DM Sans", -apple-system, sans-serif', padding: '0 16px 40px', maxWidth: 480, margin: '0 auto', color: '#2D2A26' },
  header: { paddingTop: 20, paddingBottom: 16 },
  headerTop: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  headerCenter: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 },
  dateTitle: { fontSize: 17, fontWeight: 600, margin: 0, textAlign: 'center' },
  todayBtn: { background: 'none', border: '1px solid #E8E4DF', borderRadius: 8, padding: '4px 12px', fontSize: 12, color: '#8A8580', cursor: 'pointer', fontFamily: 'inherit' },
  navBtn: { background: 'none', border: 'none', fontSize: 28, color: '#8A8580', cursor: 'pointer', padding: '0 8px' },
  viewToggle: { display: 'flex', gap: 4, background: '#F0ECE8', borderRadius: 10, padding: 3 },
  toggleBtn: { flex: 1, padding: '8px 0', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer', transition: 'all 0.2s', fontFamily: 'inherit' },
  dayGrid: { display: 'flex', gap: 0, background: '#fff', borderRadius: 14, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' },
  timeColumn: { width: 50, position: 'relative', borderRight: '1px solid #F0ECE8', flexShrink: 0 },
  timeLabel: { position: 'absolute', right: 8, fontSize: 11, color: '#AAA5A0', transform: 'translateY(-6px)' },
  appointmentColumn: { flex: 1, position: 'relative', minHeight: 720 },
  hourLine: { position: 'absolute', left: 0, right: 0, height: 1, background: '#F5F2EF' },
  nowLine: { position: 'absolute', left: -4, right: 0, height: 2, background: '#DC2626', zIndex: 10 },
  nowDot: { width: 8, height: 8, borderRadius: '50%', background: '#DC2626', position: 'absolute', left: -2, top: -3 },
  appointmentBlock: { position: 'absolute', left: 4, right: 4, borderRadius: 8, padding: '6px 10px', cursor: 'pointer', transition: 'all 0.15s', fontFamily: 'inherit', textAlign: 'left', border: 'none', borderLeft: '3px solid', boxShadow: '0 1px 3px rgba(0,0,0,0.06)', overflow: 'hidden', width: 'calc(100% - 8px)' },
  apptContent: { display: 'flex', flexDirection: 'column', gap: 1 },
  apptTime: { fontSize: 11, fontWeight: 600, color: '#666' },
  apptClient: { fontSize: 13, fontWeight: 600, color: '#2D2A26' },
  apptTreatment: { fontSize: 11, color: '#8A8580' },
  aiTag: { display: 'inline-block', padding: '2px 6px', borderRadius: 4, fontSize: 9, fontWeight: 600, background: '#EEF4FC', color: '#4A90D9', letterSpacing: '0.03em', marginTop: 2, width: 'fit-content' },
  weekHeader: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, marginBottom: 8 },
  weekDayHeader: { display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '8px 0', borderRadius: 10, border: 'none', cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.2s' },
  weekDayName: { fontSize: 10, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em' },
  weekDayNumber: { fontSize: 16, fontWeight: 700 },
  weekBody: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, background: '#fff', borderRadius: 14, padding: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' },
  weekDayColumn: { display: 'flex', flexDirection: 'column', gap: 3, minHeight: 80 },
  weekApptChip: { padding: '4px 4px', borderRadius: 4, borderLeft: '2px solid', background: '#FDFCFB', display: 'flex', flexDirection: 'column', gap: 0 },
  weekApptTime: { fontSize: 9, fontWeight: 600, color: '#666' },
  weekApptName: { fontSize: 10, color: '#2D2A26', fontWeight: 500 },
  weekEmpty: { height: 40, borderRadius: 4, background: '#FDFCFB' },
  detailPanel: { background: '#fff', borderRadius: 14, padding: 20, marginTop: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' },
  detailHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  detailTitle: { fontSize: 17, fontWeight: 600, margin: 0 },
  detailClose: { background: 'none', border: 'none', fontSize: 22, color: '#AAA5A0', cursor: 'pointer' },
  detailGrid: { display: 'flex', flexDirection: 'column', gap: 0 },
  detailRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #F5F2EF' },
  detailLabel: { fontSize: 13, color: '#8A8580' },
  detailValue: { fontSize: 13, fontWeight: 500, textAlign: 'right' },
  statusBadge: { padding: '3px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, textTransform: 'capitalize' },
  completeBtn: { width: '100%', padding: '12px 0', borderRadius: 10, border: 'none', background: '#5BA67F', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginTop: 14 },
  completionFlow: { display: 'flex', flexDirection: 'column', gap: 16 },
  completionSection: { display: 'flex', flexDirection: 'column', gap: 6 },
  completionLabel: { fontSize: 12, fontWeight: 600, color: '#8A8580', textTransform: 'uppercase', letterSpacing: '0.05em' },
  paymentOptions: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  paymentChip: { padding: '8px 14px', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', textTransform: 'capitalize', transition: 'all 0.15s' },
  notesInput: { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1.5px solid #F0ECE8', fontSize: 14, fontFamily: 'inherit', outline: 'none', resize: 'vertical', boxSizing: 'border-box' },
  photoHint: { fontSize: 12, color: '#C4BDB6', margin: 0 },
  photoUploadBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '14px 0', borderRadius: 10, border: '2px dashed #E8E4E0', fontSize: 14, fontWeight: 500, color: '#8A8580', cursor: 'pointer', fontFamily: 'inherit' },
  photoPreview: { position: 'relative', borderRadius: 10, overflow: 'hidden' },
  photoImg: { width: '100%', borderRadius: 10, maxHeight: 200, objectFit: 'cover' },
  photoRemove: { position: 'absolute', top: 8, right: 8, width: 28, height: 28, borderRadius: '50%', background: 'rgba(0,0,0,0.5)', color: '#fff', border: 'none', fontSize: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  confirmCompleteBtn: { width: '100%', padding: '14px 0', borderRadius: 10, border: 'none', background: '#5BA67F', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  doneScreen: { textAlign: 'center', padding: '20px 0' },
  rebookSection: { background: '#FAF8F5', borderRadius: 12, padding: 16, textAlign: 'left', marginBottom: 12 },
  rebookOptions: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 },
  rebookChip: { padding: '6px 12px', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s' },
  rebookSendBtn: { width: '100%', padding: '10px 0', borderRadius: 8, border: 'none', background: '#C76B8A', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  doneCloseBtn: { width: '100%', padding: '10px 0', borderRadius: 8, border: 'none', background: '#F5F2EF', color: '#666', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' },
};
