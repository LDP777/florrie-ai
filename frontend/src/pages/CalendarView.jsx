import { useState, useEffect, useRef } from 'react';
import { useBeautician, supabase, isDevMode, updateRow, insertRow } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';

/**
 * CalendarView — Day and Week view of appointments.
 * Wired to Supabase with client/treatment joins.
 * Redesigned to match Stitch design reference.
 */

const HOUR_HEIGHT = 60;
const START_HOUR = 8;
const END_HOUR = 20;

// Color palette (Stitch design)
const COLORS = {
  primary: '#92405e',
  secondary: '#745a27',
  surface: '#fef8f4',
  primaryContainer: '#b05877',
  secondaryContainer: '#fedb9b',
  surfaceContainerLow: '#f8f2ef',
  onSurface: '#1d1b19',
  outlineVariant: '#d8c1c6',
  stone400: '#78716b',
};

export default function CalendarView() {
  const { beautician, loading: bLoading } = useBeautician();
  const [view, setView] = useState('day');
  const [currentDate, setCurrentDate] = useState(new Date());
  const [appointments, setAppointments] = useState([]);
  const [selectedAppointment, setSelectedAppointment] = useState(null);
  const [loading, setLoading] = useState(true);
  const detailRef = useRef(null);

  // Time blocking state
  const [timeBlocks, setTimeBlocks] = useState([]);
  const [showBlockModal, setShowBlockModal] = useState(false);
  const [selectedBlock, setSelectedBlock] = useState(null); // existing block tapped
  const [savingBlock, setSavingBlock] = useState(false);

  useEffect(() => {
    if (beautician) {
      loadAppointments();
      loadTimeBlocks();
    }
  }, [beautician, currentDate, view]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll to appointment detail when selected
  useEffect(() => {
    if (selectedAppointment && detailRef.current) {
      setTimeout(() => {
        detailRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 50);
    }
  }, [selectedAppointment]);

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

      if (error) logger.error('Calendar load:', error);
      setAppointments(data || []);
    } catch (err) {
      logger.error('Calendar load error:', err);
    } finally {
      setLoading(false);
    }
  }

  // ──────────────────────────────────────────────────────
  // Time block functions
  // ──────────────────────────────────────────────────────

  async function loadTimeBlocks() {
    if (!beautician || isDevMode) return;
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const res = await fetch(`${API_BASE}/api/hours-exceptions`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();
      setTimeBlocks(data.exceptions || []);
    } catch (err) {
      logger.error('Load time blocks error:', err);
    }
  }

  async function createTimeBlock({ date, type, reason, note, start_time, end_time }) {
    setSavingBlock(true);
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const res = await fetch(`${API_BASE}/api/hours-exceptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ date, type, reason, note, start_time, end_time, notify_clients: false }),
      });
      if (res.ok) {
        await loadTimeBlocks();
        setShowBlockModal(false);
      }
    } catch (err) {
      logger.error('Create time block error:', err);
    } finally {
      setSavingBlock(false);
    }
  }

  async function deleteTimeBlock(blockId) {
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      await fetch(`${API_BASE}/api/hours-exceptions/${blockId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      setTimeBlocks(prev => prev.filter(b => b.id !== blockId));
      setSelectedBlock(null);
    } catch (err) {
      logger.error('Delete time block error:', err);
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
    return { top: Math.max(0, top), height: Math.max(height, 64) };
  }

  function getStatusColor(status) {
    const colors = { confirmed: '#5BA67F', pending: '#D4A843', in_progress: '#4A90D9', completed: '#8A8580', cancelled_by_client: '#DC2626', cancelled_by_beautician: '#DC2626', no_show: '#EF4444', rescheduled: '#7C6EAF' };
    return colors[status] || '#8A8580';
  }

  function getAppointmentCardStyle(appointment) {
    // Determine card style based on tier/special status
    // For now, default style; can be extended with VIP/gold tier detection
    return {
      background: '#fff',
      borderColor: COLORS.primary,
    };
  }

  function getWeekDays() {
    const start = getWeekStart(currentDate);
    return Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d; });
  }

  function countGapsToday() {
    const dayAppts = getAppointmentsForDate(currentDate).sort((a, b) => new Date(a.ends_at) - new Date(b.ends_at));
    let gaps = 0;
    for (let i = 0; i < dayAppts.length - 1; i++) {
      const endTime = new Date(dayAppts[i].ends_at);
      const nextStart = new Date(dayAppts[i + 1].starts_at);
      const diffMinutes = (nextStart - endTime) / (1000 * 60);
      if (diffMinutes > 15) gaps++;
    }
    return gaps;
  }

  function countWaitlistMatches() {
    // Placeholder: would come from waitlist data
    return 0;
  }

  const weekDays = getWeekDays();
  const weekMonthName = getWeekStart(currentDate).toLocaleDateString('en-GB', { month: 'long' });
  const weekNumber = Math.ceil((currentDate.getDate() + 6 - currentDate.getDay()) / 7);
  const gapsToday = countGapsToday();
  const waitlistMatches = countWaitlistMatches();
  const showInsightsPill = view === 'day' && (gapsToday > 0 || waitlistMatches > 0);

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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={styles.viewToggle}>
            <button onClick={() => setView('day')} style={{ ...styles.toggleBtn, background: view === 'day' ? COLORS.secondary : 'transparent', color: view === 'day' ? '#fff' : COLORS.stone400 }}>Day</button>
            <button onClick={() => setView('week')} style={{ ...styles.toggleBtn, background: view === 'week' ? COLORS.secondary : 'transparent', color: view === 'week' ? '#fff' : COLORS.stone400 }}>Week</button>
          </div>
          <button
            onClick={() => setShowBlockModal(true)}
            title="Block time"
            style={{ width: 36, height: 36, borderRadius: 10, border: 'none', background: 'rgba(146,64,94,0.08)', color: COLORS.primary, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18, fontVariationSettings: "'FILL' 0, 'wght' 300" }}>block</span>
          </button>
        </div>
      </div>

      {/* Weekly Date Strip (shared for both views) */}
      <div style={styles.weeklyStripContainer}>
        <div style={styles.weeklyStripHeader}>
          <span style={styles.weeklyStripMonth}>{weekMonthName} WEEK {weekNumber}</span>
        </div>
        <div style={styles.weeklyStrip}>
          {weekDays.map(day => (
            <button
              key={day.toISOString()}
              onClick={() => { setCurrentDate(day); setView('day'); }}
              style={{
                ...styles.weeklyStripDay,
                background: isToday(day) ? COLORS.primary : 'transparent',
                color: isToday(day) ? '#fff' : COLORS.onSurface,
                boxShadow: isToday(day) ? `0 4px 10px rgba(146, 64, 94, 0.15)` : 'none',
              }}
            >
              <span style={styles.weeklyStripDayName}>{day.toLocaleDateString('en-GB', { weekday: 'short' })}</span>
              <span style={styles.weeklyStripDayNumber}>{day.getDate()}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Day View with Timeline Grid */}
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
            {/* Hour lines and grid */}
            {Array.from({ length: END_HOUR - START_HOUR }, (_, i) => (
              <div key={i} style={{ ...styles.hourLine, top: i * HOUR_HEIGHT }} />
            ))}

            {/* Now-line indicator */}
            {isToday(currentDate) && (
              <div style={{ ...styles.nowLine, top: getNowPosition() }}>
                <div style={styles.nowDot} />
              </div>
            )}

            {/* Appointment cards */}
            {getAppointmentsForDate(currentDate).map(appt => {
              const pos = getBlockStyle(appt);
              const cardStyle = getAppointmentCardStyle(appt);
              const statusColor = getStatusColor(appt.status);
              const clientInitials = `${appt.clients?.first_name?.[0] || ''}${appt.clients?.last_name?.[0] || ''}`.toUpperCase();

              return (
                <button
                  key={appt.id}
                  onClick={() => setSelectedAppointment(selectedAppointment?.id === appt.id ? null : appt)}
                  style={{
                    ...styles.appointmentCard,
                    top: pos.top,
                    height: pos.height,
                    background: cardStyle.background,
                    borderLeftColor: statusColor,
                  }}
                >
                  <div style={styles.appointmentCardContent}>
                    <div style={styles.appointmentCardHeader}>
                      <div style={{ ...styles.appointmentAvatar, background: statusColor }}>
                        {clientInitials}
                      </div>
                      <div style={styles.appointmentCardTextBlock}>
                        <div style={styles.appointmentCardClientName}>{appt.clients?.first_name} {appt.clients?.last_name || ''}</div>
                        <div style={styles.appointmentCardTreatment}>{appt.treatments?.name}</div>
                      </div>
                    </div>
                    <div style={styles.appointmentCardMeta}>
                      <span style={styles.appointmentCardTime}>
                        {new Date(appt.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      {appt.ai_booked && <span style={styles.aiTag}>AI</span>}
                    </div>
                  </div>
                </button>
              );
            })}

            {/* Time block overlays */}
            {timeBlocks
              .filter(b => b.date === formatDate(currentDate))
              .map(block => {
                let top = 0, height = (END_HOUR - START_HOUR) * HOUR_HEIGHT;
                const isClosed = block.type === 'closed' || block.is_closed;
                if (!isClosed) {
                  const st = block.start_time || block.custom_start;
                  const et = block.end_time || block.custom_end;
                  if (st && et) {
                    const [sh, sm] = st.split(':').map(Number);
                    const [eh, em] = et.split(':').map(Number);
                    top = ((sh * 60 + sm - START_HOUR * 60) / 60) * HOUR_HEIGHT;
                    height = ((eh * 60 + em - (sh * 60 + sm)) / 60) * HOUR_HEIGHT;
                  }
                }
                const label = isClosed ? 'CLOSED ALL DAY'
                  : `🚫 ${(block.reason || block.note || 'BLOCKED').toUpperCase()}`;
                return (
                  <button
                    key={block.id}
                    onClick={() => setSelectedBlock(block)}
                    style={{
                      position: 'absolute', left: 0, right: 0,
                      top: Math.max(0, top),
                      height: Math.max(height, 36),
                      background: 'repeating-linear-gradient(45deg, rgba(146,64,94,0.07) 0px, rgba(146,64,94,0.07) 5px, rgba(146,64,94,0.02) 5px, rgba(146,64,94,0.02) 10px)',
                      border: 'none',
                      borderLeft: '3px solid rgba(146,64,94,0.5)',
                      borderRadius: 4,
                      display: 'flex', alignItems: 'center', paddingLeft: 10,
                      cursor: 'pointer', zIndex: 3,
                    }}
                  >
                    <span style={{ fontSize: 11, fontWeight: 700, color: COLORS.primary, letterSpacing: '0.04em' }}>
                      {label}
                    </span>
                  </button>
                );
              })
            }

            {/* Open slot placeholders */}
            {(() => {
              const appts = getAppointmentsForDate(currentDate).sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
              const slots = [];

              // Check for gap at start of day
              if (appts.length > 0) {
                const firstStart = new Date(appts[0].starts_at);
                const firstStartMinutes = firstStart.getHours() * 60 + firstStart.getMinutes();
                if (firstStartMinutes > START_HOUR * 60 + 30) {
                  const top = 0;
                  const height = ((firstStartMinutes - START_HOUR * 60) / 60) * HOUR_HEIGHT;
                  slots.push({ id: 'start', top, height });
                }
              }

              // Check for gaps between appointments
              for (let i = 0; i < appts.length - 1; i++) {
                const end = new Date(appts[i].ends_at);
                const nextStart = new Date(appts[i + 1].starts_at);
                const endMinutes = end.getHours() * 60 + end.getMinutes();
                const nextStartMinutes = nextStart.getHours() * 60 + nextStart.getMinutes();
                const diffMinutes = (nextStartMinutes - endMinutes);

                if (diffMinutes > 30) {
                  const top = ((endMinutes - START_HOUR * 60) / 60) * HOUR_HEIGHT;
                  const height = (diffMinutes / 60) * HOUR_HEIGHT;
                  slots.push({ id: `gap-${i}`, top, height });
                }
              }

              // Check for gap at end of day
              if (appts.length > 0) {
                const lastEnd = new Date(appts[appts.length - 1].ends_at);
                const lastEndMinutes = lastEnd.getHours() * 60 + lastEnd.getMinutes();
                if (lastEndMinutes < END_HOUR * 60 - 30) {
                  const top = ((lastEndMinutes - START_HOUR * 60) / 60) * HOUR_HEIGHT;
                  const height = ((END_HOUR * 60 - lastEndMinutes) / 60) * HOUR_HEIGHT;
                  slots.push({ id: 'end', top, height });
                }
              }

              return slots.map(slot => (
                <div
                  key={slot.id}
                  style={{
                    ...styles.openSlotCard,
                    top: slot.top,
                    height: slot.height,
                  }}
                >
                  <span style={styles.openSlotText}>OPEN SLOT</span>
                </div>
              ));
            })()}

            {!loading && getAppointmentsForDate(currentDate).length === 0 && (
              <div style={{ position: 'absolute', top: '40%', left: 0, right: 0, textAlign: 'center' }}>
                <p style={{ fontSize: 13, color: COLORS.stone400 }}>No appointments</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Week View */}
      {view === 'week' && (
        <div style={styles.weekBody}>
          {weekDays.map(day => {
            const dayAppts = getAppointmentsForDate(day);
            return (
              <div key={day.toISOString()} style={styles.weekDayColumn}>
                {dayAppts.map(appt => {
                  const statusCol = getStatusColor(appt.status);
                  const firstName = appt.clients?.first_name || '';
                  const lastInitial = appt.clients?.last_name ? appt.clients.last_name.charAt(0) + '.' : '';
                  const clientLabel = firstName ? `${firstName}${lastInitial ? ' ' + lastInitial : ''}` : '—';
                  return (
                    <button
                      key={appt.id}
                      onClick={() => setSelectedAppointment(selectedAppointment?.id === appt.id ? null : appt)}
                      style={{
                        ...styles.weekApptChip,
                        borderLeftColor: statusCol,
                        background: statusCol + '18',
                      }}
                    >
                      <span style={styles.weekApptTime}>{new Date(appt.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
                      <span style={styles.weekApptName}>{clientLabel}</span>
                    </button>
                  );
                })}
                {dayAppts.length === 0 && <div style={styles.weekEmpty} />}
              </div>
            );
          })}
        </div>
      )}

      {/* Floating Insights Pill (day view only) */}
      {showInsightsPill && (
        <div style={styles.insightsPill}>
          <span style={styles.insightsPillIcon}>⚡</span>
          <span style={styles.insightsPillText}>
            {gapsToday} gap{gapsToday !== 1 ? 's' : ''} today {waitlistMatches > 0 ? `· ${waitlistMatches} waitlist match${waitlistMatches !== 1 ? 'es' : ''}` : ''}
          </span>
        </div>
      )}

      {/* Selected appointment detail + completion flow */}
      {selectedAppointment && (
        <div ref={detailRef}>
          <AppointmentDetail
            appointment={selectedAppointment}
            beautician={beautician}
            onClose={() => setSelectedAppointment(null)}
            onUpdate={() => { loadAppointments(); setSelectedAppointment(null); }}
            getStatusColor={getStatusColor}
          />
        </div>
      )}

      {/* Block Time modal */}
      {showBlockModal && (
        <BlockTimeModal
          defaultDate={formatDate(currentDate)}
          onSave={createTimeBlock}
          onClose={() => setShowBlockModal(false)}
          saving={savingBlock}
        />
      )}

      {/* Existing block detail (tap to remove) */}
      {selectedBlock && (
        <BlockDetailSheet
          block={selectedBlock}
          onDelete={() => deleteTimeBlock(selectedBlock.id)}
          onClose={() => setSelectedBlock(null)}
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
  const [noShowCharging, setNoShowCharging] = useState(false);
  const [paymentLinkUrl, setPaymentLinkUrl] = useState(null);
  const [linkLoading, setLinkLoading] = useState(false);
  const [noteSaved, setNoteSaved] = useState(false);

  async function handleSaveNote() {
    if (isDevMode) { setNoteSaved(true); setTimeout(() => setNoteSaved(false), 1500); return; }
    try {
      await updateRow('appointments', appointment.id, { beautician_notes: notes || null });
      setNoteSaved(true);
      setTimeout(() => setNoteSaved(false), 1500);
    } catch (err) {
      logger.error('Save note error:', err);
    }
  }

  async function handleMarkNoShow() {
    if (!confirm('Mark this appointment as a no-show?')) return;
    setSaving(true);
    try {
      const token = (await supabase.auth.getSession())?.data?.session?.access_token;
      const res = await fetch(`${API_BASE}/api/booking/appointments/${appointment.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: 'no_show' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      // If backend says we can charge, show the option
      if (data.no_show_fee?.can_charge) {
        setNoShowCharging(true);
      }
      onUpdate();
    } catch (err) {
      logger.error('No-show error:', err);
    } finally {
      setSaving(false);
    }
  }

  async function handleChargeNoShow() {
    setSaving(true);
    try {
      const token = (await supabase.auth.getSession())?.data?.session?.access_token;
      const res = await fetch(`${API_BASE}/api/stripe/charge-no-show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ appointment_id: appointment.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      alert(`No-show fee of £${(data.amount_cents / 100).toFixed(2)} charged successfully.`);
      setNoShowCharging(false);
      onUpdate();
    } catch (err) {
      logger.error('No-show charge error:', err);
      alert(err.message || 'Failed to charge no-show fee');
    } finally {
      setSaving(false);
    }
  }

  async function handleSendPaymentLink() {
    setLinkLoading(true);
    try {
      const token = (await supabase.auth.getSession())?.data?.session?.access_token;
      const remaining = appointment.price_cents - (appointment.deposit_cents || 0);
      const amount = remaining > 0 ? remaining : appointment.price_cents;
      const res = await fetch(`${API_BASE}/api/stripe/payment-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          amount_cents: amount,
          description: `${appointment.treatments?.name} — ${appointment.clients?.first_name}`,
          client_id: appointment.client_id,
          appointment_id: appointment.id,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setPaymentLinkUrl(data.url);
    } catch (err) {
      logger.error('Payment link error:', err);
      alert(err.message || 'Failed to create payment link');
    } finally {
      setLinkLoading(false);
    }
  }

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
      logger.error('Complete error:', err);
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
      logger.error('Upload error:', err);
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
            {appointment.ai_booked && <div style={styles.detailRow}><span style={styles.detailLabel}>Booked by</span><span style={styles.aiTag}>Florrie</span></div>}
          </div>

          {/* Persistent notes — always visible, save without completing */}
          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary, #888)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Notes</span>
              {notes !== (appointment.beautician_notes || '') && (
                <button onClick={handleSaveNote}
                  style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, border: 'none', background: noteSaved ? 'var(--success-bg, #E8F5E9)' : 'var(--accent)', color: noteSaved ? 'var(--success, #5BA97B)' : '#fff', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, transition: 'all 0.15s' }}>
                  {noteSaved ? '✓ Saved' : 'Save'}
                </button>
              )}
              {noteSaved && notes === (appointment.beautician_notes || '') && (
                <span style={{ fontSize: 11, color: 'var(--success, #5BA97B)', fontWeight: 600 }}>✓ Saved</span>
              )}
            </div>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Colour mix, skin notes, preferences, anything worth remembering..."
              rows={3}
              style={{ width: '100%', padding: '9px 11px', borderRadius: 8, border: '1.5px solid var(--border, #E5E5E5)', fontSize: 13, fontFamily: 'inherit', outline: 'none', resize: 'vertical', boxSizing: 'border-box', color: 'var(--text, #333)', background: 'var(--bg-input, #FAFAFA)' }}
              onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); handleSaveNote(); } }}
            />
            <p style={{ fontSize: 11, color: 'var(--text-muted, #aaa)', margin: '4px 0 0' }}>⌘S to save · notes shown next time this client books</p>
          </div>

          {canComplete && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
              <button onClick={() => setMode('completing')} style={styles.completeBtn}>
                Mark as complete
              </button>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={handleMarkNoShow} disabled={saving}
                  style={{ ...styles.completeBtn, flex: 1, background: '#EF4444', fontSize: 12, padding: '8px 0' }}>
                  No-show
                </button>
                <button onClick={handleSendPaymentLink} disabled={linkLoading}
                  style={{ ...styles.completeBtn, flex: 1, background: 'var(--accent)', fontSize: 12, padding: '8px 0' }}>
                  {linkLoading ? 'Creating...' : 'Send payment link'}
                </button>
              </div>
            </div>
          )}

          {/* No-show fee charge prompt */}
          {noShowCharging && (
            <div style={{ marginTop: 12, padding: 12, borderRadius: 10, background: '#FEF2F2', border: '1px solid #FECACA' }}>
              <p style={{ fontSize: 13, color: '#991B1B', margin: '0 0 8px' }}>Client has a saved card. Charge no-show fee?</p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={handleChargeNoShow} disabled={saving}
                  style={{ flex: 1, padding: '8px', borderRadius: 8, border: 'none', background: '#EF4444', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                  {saving ? 'Charging...' : `Charge £${((appointment.deposit_cents || appointment.price_cents) / 100).toFixed(2)}`}
                </button>
                <button onClick={() => setNoShowCharging(false)}
                  style={{ flex: 1, padding: '8px', borderRadius: 8, border: '1px solid #E5E5E5', background: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>
                  Skip
                </button>
              </div>
            </div>
          )}

          {/* Payment link result */}
          {paymentLinkUrl && (
            <div style={{ marginTop: 12, padding: 12, borderRadius: 10, background: '#F0FFF4', border: '1px solid #C6F6D5' }}>
              <p style={{ fontSize: 13, color: '#276749', margin: '0 0 8px', fontWeight: 600 }}>Payment link ready</p>
              <input readOnly value={paymentLinkUrl} style={{ width: '100%', padding: '8px', borderRadius: 6, border: '1px solid #C6F6D5', fontSize: 12, boxSizing: 'border-box' }}
                onClick={e => { e.target.select(); navigator.clipboard?.copyText(paymentLinkUrl); }} />
              <p style={{ fontSize: 11, color: '#276749', margin: '6px 0 0' }}>Tap to copy. Send to client via WhatsApp or SMS.</p>
            </div>
          )}

          {/* Show status for already no-show or completed */}
          {appointment.status === 'no_show' && (
            <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: '#FEF2F2', textAlign: 'center' }}>
              <span style={{ fontSize: 13, color: '#991B1B', fontWeight: 600 }}>Marked as no-show</span>
              {!appointment.no_show_fee_charged && (
                <button onClick={handleSendPaymentLink} disabled={linkLoading}
                  style={{ ...styles.completeBtn, marginTop: 8, background: '#EF4444', fontSize: 12, padding: '8px 0' }}>
                  {linkLoading ? 'Creating...' : 'Send no-show fee link'}
                </button>
              )}
            </div>
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
                  style={{ ...styles.paymentChip, background: paymentMethod === m ? 'var(--accent)' : 'var(--border-light)', color: paymentMethod === m ? '#fff' : '#666' }}>
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
                  style={{ ...styles.rebookChip, background: rebookWeeks === w ? 'var(--accent)' : 'var(--border-light)', color: rebookWeeks === w ? '#fff' : '#666' }}>
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
  page: { minHeight: '100vh', background: 'var(--bg)', fontFamily: "var(--font-body, 'DM Sans', -apple-system, sans-serif)", padding: '0 16px 120px', maxWidth: 480, margin: '0 auto', color: 'var(--text-primary)', animation: 'fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)' },
  header: { paddingTop: 20, paddingBottom: 16 },
  headerTop: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  headerCenter: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 },
  dateTitle: { fontSize: 17, fontWeight: 600, margin: 0, textAlign: 'center', fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)" },
  todayBtn: { background: 'none', border: `1px solid ${COLORS.outlineVariant}`, borderRadius: 8, padding: '4px 12px', fontSize: 12, color: COLORS.stone400, cursor: 'pointer', fontFamily: 'inherit' },
  navBtn: { background: 'none', border: 'none', fontSize: 28, color: COLORS.stone400, cursor: 'pointer', padding: '0 8px' },
  viewToggle: { display: 'flex', gap: 4, background: `${COLORS.outlineVariant}33`, borderRadius: 12, padding: 3 },
  toggleBtn: { flex: 1, padding: '8px 0', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer', transition: 'all 0.2s', fontFamily: 'inherit' },

  // Weekly Date Strip
  weeklyStripContainer: { marginBottom: 20, background: COLORS.surfaceContainerLow, borderRadius: 24, padding: '12px 16px', position: 'relative' },
  weeklyStripHeader: { marginBottom: 12 },
  weeklyStripMonth: { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: COLORS.stone400 },
  weeklyStrip: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 8 },
  weeklyStripDay: { display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '8px 4px', borderRadius: 12, border: 'none', cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.2s ease' },
  weeklyStripDayName: { fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' },
  weeklyStripDayNumber: { fontSize: 16, fontWeight: 700, marginTop: 2 },

  // Day View Timeline
  dayGrid: { display: 'flex', gap: 0, background: '#fff', borderRadius: 16, overflow: 'hidden', boxShadow: '0 10px 30px rgba(146, 64, 94, 0.06)' },
  timeColumn: { width: 56, position: 'relative', borderRight: `1px solid ${COLORS.outlineVariant}33`, flexShrink: 0 },
  timeLabel: { position: 'absolute', right: 8, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: COLORS.stone400, transform: 'translateY(-6px)' },
  appointmentColumn: { flex: 1, position: 'relative', minHeight: 720 },
  hourLine: { position: 'absolute', left: 0, right: 0, height: 1, background: `${COLORS.outlineVariant}33` },
  nowLine: { position: 'absolute', left: -4, right: 0, height: 2, background: '#E53E3E', zIndex: 10 },
  nowDot: { width: 8, height: 8, borderRadius: '50%', background: '#E53E3E', position: 'absolute', left: -2, top: -3 },

  // Appointment Cards
  appointmentCard: { position: 'absolute', left: 4, right: 4, borderRadius: 12, padding: '6px 10px', cursor: 'pointer', transition: 'all 0.15s', fontFamily: 'inherit', textAlign: 'left', border: 'none', borderLeft: '4px solid', boxShadow: '0 10px 30px rgba(146, 64, 94, 0.06)', overflow: 'visible', width: 'calc(100% - 8px)', zIndex: 2, minHeight: 56 },
  appointmentCardContent: { display: 'flex', alignItems: 'center', gap: 8 },
  appointmentCardHeader: { display: 'flex', gap: 8, alignItems: 'center', flex: 1, minWidth: 0 },
  appointmentAvatar: { width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 10, fontWeight: 700, flexShrink: 0 },
  appointmentCardTextBlock: { flex: 1, display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 },
  appointmentCardClientName: { fontSize: 13, fontWeight: 700, color: COLORS.onSurface, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  appointmentCardTreatment: { fontSize: 10, fontWeight: 500, textTransform: 'uppercase', color: COLORS.stone400, letterSpacing: '0.02em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  appointmentCardMeta: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, flexShrink: 0 },
  appointmentCardTime: { fontWeight: 600, color: COLORS.stone400, textTransform: 'uppercase' },
  aiTag: { display: 'inline-block', padding: '2px 6px', borderRadius: 4, fontSize: 9, fontWeight: 600, background: '#EEF4FC', color: '#4A90D9', letterSpacing: '0.03em' },

  // Open Slot Cards
  openSlotCard: { position: 'absolute', left: 4, right: 4, borderRadius: 16, border: `2px dashed ${COLORS.outlineVariant}80`, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 'calc(100% - 8px)' },
  openSlotText: { fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: COLORS.stone400 },

  // Week Body
  weekBody: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, background: '#fff', borderRadius: 16, padding: 8, boxShadow: '0 10px 30px rgba(146, 64, 94, 0.06)' },
  weekDayColumn: { display: 'flex', flexDirection: 'column', gap: 3, minHeight: 80 },
  weekApptChip: { padding: '5px 6px', borderRadius: 8, borderLeft: '3px solid', display: 'flex', flexDirection: 'column', gap: 1, cursor: 'pointer', border: 'none', textAlign: 'left', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' },
  weekApptTime: { fontSize: 9, fontWeight: 700, color: COLORS.stone400, lineHeight: 1 },
  weekApptName: { fontSize: 10, color: COLORS.onSurface, fontWeight: 600, lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  weekEmpty: { height: 40, borderRadius: 8, background: COLORS.surfaceContainerLow },

  // Floating Insights Pill
  insightsPill: { position: 'fixed', bottom: 80, left: '50%', transform: 'translateX(-50%)', background: `rgba(116, 90, 39, 0.9)`, backdropFilter: 'blur(10px)', borderRadius: 24, padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 8, boxShadow: '0 10px 30px rgba(0, 0, 0, 0.15)', zIndex: 20, color: '#fff' },
  insightsPillIcon: { fontSize: 14 },
  insightsPillText: { fontSize: 12, fontWeight: 600 },

  // Detail Panel
  detailPanel: { background: '#fff', borderRadius: 16, padding: 20, marginTop: 16, boxShadow: '0 10px 30px rgba(146, 64, 94, 0.06)' },
  detailHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  detailTitle: { fontSize: 17, fontWeight: 700, margin: 0 },
  detailClose: { background: 'none', border: 'none', fontSize: 22, color: COLORS.stone400, cursor: 'pointer' },
  detailGrid: { display: 'flex', flexDirection: 'column', gap: 0 },
  detailRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: `1px solid ${COLORS.outlineVariant}33` },
  detailLabel: { fontSize: 13, color: COLORS.stone400, fontWeight: 500 },
  detailValue: { fontSize: 13, fontWeight: 600, textAlign: 'right' },
  statusBadge: { padding: '3px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, textTransform: 'capitalize' },
  completeBtn: { width: '100%', padding: '12px 0', borderRadius: 12, border: 'none', background: '#5BA67F', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginTop: 14 },
  completionFlow: { display: 'flex', flexDirection: 'column', gap: 16 },
  completionSection: { display: 'flex', flexDirection: 'column', gap: 6 },
  completionLabel: { fontSize: 11, fontWeight: 700, color: COLORS.stone400, textTransform: 'uppercase', letterSpacing: '0.05em' },
  paymentOptions: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  paymentChip: { padding: '8px 14px', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', textTransform: 'capitalize', transition: 'all 0.15s' },
  notesInput: { width: '100%', padding: '10px 12px', borderRadius: 8, border: `1.5px solid ${COLORS.outlineVariant}`, fontSize: 14, fontFamily: 'inherit', outline: 'none', resize: 'vertical', boxSizing: 'border-box' },
  photoHint: { fontSize: 12, color: COLORS.stone400, margin: 0 },
  photoUploadBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '14px 0', borderRadius: 12, border: `2px dashed ${COLORS.outlineVariant}`, fontSize: 14, fontWeight: 500, color: COLORS.stone400, cursor: 'pointer', fontFamily: 'inherit' },
  photoPreview: { position: 'relative', borderRadius: 12, overflow: 'hidden' },
  photoImg: { width: '100%', borderRadius: 12, maxHeight: 200, objectFit: 'cover' },
  photoRemove: { position: 'absolute', top: 8, right: 8, width: 28, height: 28, borderRadius: '50%', background: 'rgba(0,0,0,0.5)', color: '#fff', border: 'none', fontSize: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  confirmCompleteBtn: { width: '100%', padding: '14px 0', borderRadius: 12, border: 'none', background: '#5BA67F', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  doneScreen: { textAlign: 'center', padding: '20px 0' },
  rebookSection: { background: COLORS.surfaceContainerLow, borderRadius: 12, padding: 16, textAlign: 'left', marginBottom: 12 },
  rebookOptions: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 },
  rebookChip: { padding: '6px 12px', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s' },
  rebookSendBtn: { width: '100%', padding: '10px 0', borderRadius: 8, border: 'none', background: COLORS.primary, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  doneCloseBtn: { width: '100%', padding: '10px 0', borderRadius: 8, border: 'none', background: `${COLORS.outlineVariant}33`, color: COLORS.stone400, fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' },
};

// ──────────────────────────────────────────────────────────────────
// BlockTimeModal — create a new time block
// ──────────────────────────────────────────────────────────────────

const BLOCK_REASONS = [
  { key: 'lunch', label: '🍽️ Lunch' },
  { key: 'holiday', label: '🏖️ Holiday' },
  { key: 'personal', label: '🏠 Personal' },
  { key: 'sick', label: '🤒 Sick' },
  { key: 'training', label: '📚 Training' },
  { key: 'other', label: '✏️ Other' },
];

function BlockTimeModal({ defaultDate, onSave, onClose, saving }) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const nowTime = `${pad(now.getHours())}:${pad(Math.ceil(now.getMinutes() / 15) * 15 === 60 ? 0 : Math.ceil(now.getMinutes() / 15) * 15)}`;
  const plusOneHour = `${pad(now.getHours() + 1)}:${pad(Math.ceil(now.getMinutes() / 15) * 15 === 60 ? 0 : Math.ceil(now.getMinutes() / 15) * 15)}`;

  const [date, setDate] = useState(defaultDate);
  const [type, setType] = useState('amended'); // 'closed' = all day, 'amended' = time range
  const [startTime, setStartTime] = useState(nowTime);
  const [endTime, setEndTime] = useState(plusOneHour);
  const [reason, setReason] = useState('personal');
  const [note, setNote] = useState('');

  const PRESETS = [
    {
      label: 'Lunch (1hr)',
      apply: () => {
        setType('amended');
        setStartTime('12:00');
        setEndTime('13:00');
        setReason('lunch');
      },
    },
    {
      label: 'Rest of day',
      apply: () => {
        setType('amended');
        setStartTime(nowTime);
        setEndTime('20:00');
        setReason('personal');
      },
    },
    {
      label: 'All day',
      apply: () => {
        setType('closed');
        setReason('holiday');
      },
    },
    {
      label: '1 hour',
      apply: () => {
        setType('amended');
        setStartTime(nowTime);
        setEndTime(plusOneHour);
        setReason('personal');
      },
    },
  ];

  function handleSave() {
    onSave({
      date,
      type,
      reason,
      note: note.trim() || undefined,
      start_time: type === 'closed' ? undefined : startTime,
      end_time: type === 'closed' ? undefined : endTime,
    });
  }

  const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 50, display: 'flex', alignItems: 'flex-end' };
  const sheet = { background: '#fff', borderRadius: '20px 20px 0 0', padding: '20px 20px 40px', width: '100%', maxWidth: 480, margin: '0 auto', fontFamily: '"DM Sans", -apple-system, sans-serif', maxHeight: '90vh', overflowY: 'auto' };

  return (
    <div style={overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={sheet}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: COLORS.onSurface }}>Block time</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: COLORS.stone400 }}>×</button>
        </div>

        {/* Quick presets */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
          {PRESETS.map(p => (
            <button
              key={p.label}
              onClick={p.apply}
              style={{ padding: '7px 12px', borderRadius: 8, border: `1.5px solid ${COLORS.outlineVariant}`, background: '#fff', color: COLORS.onSurface, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Date */}
        <label style={{ fontSize: 12, fontWeight: 600, color: COLORS.stone400, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Date</label>
        <input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
          style={{ display: 'block', width: '100%', marginTop: 4, marginBottom: 14, padding: '10px 12px', borderRadius: 10, border: `1.5px solid ${COLORS.outlineVariant}`, fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }}
        />

        {/* All day toggle */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <span style={{ fontSize: 14, fontWeight: 500, color: COLORS.onSurface }}>All day</span>
          <button
            onClick={() => setType(type === 'closed' ? 'amended' : 'closed')}
            style={{ width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer', position: 'relative', transition: 'background 0.2s', padding: 0, background: type === 'closed' ? COLORS.primary : COLORS.outlineVariant }}
          >
            <div style={{ width: 20, height: 20, borderRadius: 10, background: '#fff', position: 'absolute', top: 2, transition: 'transform 0.2s', transform: type === 'closed' ? 'translateX(20px)' : 'translateX(2px)' }} />
          </button>
        </div>

        {/* Time range — only when not all day */}
        {type !== 'closed' && (
          <div style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'center' }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: COLORS.stone400, textTransform: 'uppercase', letterSpacing: '0.05em' }}>From</label>
              <input
                type="time"
                value={startTime}
                onChange={e => setStartTime(e.target.value)}
                style={{ display: 'block', width: '100%', marginTop: 4, padding: '10px 12px', borderRadius: 10, border: `1.5px solid ${COLORS.outlineVariant}`, fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }}
              />
            </div>
            <span style={{ fontSize: 14, color: COLORS.stone400, marginTop: 16 }}>→</span>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: COLORS.stone400, textTransform: 'uppercase', letterSpacing: '0.05em' }}>To</label>
              <input
                type="time"
                value={endTime}
                onChange={e => setEndTime(e.target.value)}
                style={{ display: 'block', width: '100%', marginTop: 4, padding: '10px 12px', borderRadius: 10, border: `1.5px solid ${COLORS.outlineVariant}`, fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }}
              />
            </div>
          </div>
        )}

        {/* Reason */}
        <label style={{ fontSize: 12, fontWeight: 600, color: COLORS.stone400, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 8 }}>Reason</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
          {BLOCK_REASONS.map(r => (
            <button
              key={r.key}
              onClick={() => setReason(r.key)}
              style={{
                padding: '7px 12px', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                background: reason === r.key ? COLORS.primary : `${COLORS.outlineVariant}33`,
                color: reason === r.key ? '#fff' : COLORS.onSurface,
              }}
            >
              {r.label}
            </button>
          ))}
        </div>

        {/* Note */}
        <label style={{ fontSize: 12, fontWeight: 600, color: COLORS.stone400, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Note (optional)</label>
        <input
          type="text"
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder="e.g. School pickup, dentist..."
          style={{ display: 'block', width: '100%', marginTop: 4, marginBottom: 20, padding: '10px 12px', borderRadius: 10, border: `1.5px solid ${COLORS.outlineVariant}`, fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }}
        />

        <button
          onClick={handleSave}
          disabled={saving}
          style={{ width: '100%', padding: '14px 0', borderRadius: 12, border: 'none', background: saving ? COLORS.stone400 : COLORS.primary, color: '#fff', fontSize: 15, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', fontFamily: 'inherit' }}
        >
          {saving ? 'Saving…' : 'Block this time'}
        </button>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// BlockDetailSheet — shows an existing block + remove option
// ──────────────────────────────────────────────────────────────────

function BlockDetailSheet({ block, onDelete, onClose }) {
  const [confirming, setConfirming] = useState(false);

  const isClosed = block.type === 'closed' || block.is_closed;
  const timeRange = isClosed
    ? 'All day'
    : `${block.start_time || block.custom_start || '?'} → ${block.end_time || block.custom_end || '?'}`;

  const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 50, display: 'flex', alignItems: 'flex-end' };
  const sheet = { background: '#fff', borderRadius: '20px 20px 0 0', padding: '20px 20px 40px', width: '100%', maxWidth: 480, margin: '0 auto', fontFamily: '"DM Sans", -apple-system, sans-serif' };

  return (
    <div style={overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={sheet}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: COLORS.onSurface }}>Time block</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: COLORS.stone400 }}>×</button>
        </div>

        <div style={{ background: `${COLORS.outlineVariant}22`, borderRadius: 12, padding: 14, marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: COLORS.stone400 }}>Date</span>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{block.date}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: COLORS.stone400 }}>Time</span>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{timeRange}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: block.note ? 8 : 0 }}>
            <span style={{ fontSize: 12, color: COLORS.stone400 }}>Reason</span>
            <span style={{ fontSize: 13, fontWeight: 600, textTransform: 'capitalize' }}>{block.reason || '—'}</span>
          </div>
          {block.note && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12, color: COLORS.stone400 }}>Note</span>
              <span style={{ fontSize: 13, fontWeight: 500, textAlign: 'right', maxWidth: '65%' }}>{block.note}</span>
            </div>
          )}
        </div>

        {confirming ? (
          <div>
            <p style={{ fontSize: 14, color: COLORS.onSurface, marginBottom: 12, textAlign: 'center' }}>Remove this block?</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setConfirming(false)} style={{ flex: 1, padding: '12px 0', borderRadius: 10, border: `1.5px solid ${COLORS.outlineVariant}`, background: '#fff', color: COLORS.onSurface, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                Cancel
              </button>
              <button onClick={onDelete} style={{ flex: 1, padding: '12px 0', borderRadius: 10, border: 'none', background: '#E57373', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                Remove
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            style={{ width: '100%', padding: '13px 0', borderRadius: 12, border: 'none', background: '#FEE2E2', color: '#B91C1C', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}
          >
            Remove this block
          </button>
        )}
      </div>
    </div>
  );
}
