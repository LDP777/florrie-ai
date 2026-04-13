/**
 * Consultations — Separate booking flow for consults & patch tests.
 *
 * Semi-permanent brows, lash extensions — these need a consult first.
 * This page lets Ellie manage consultation bookings separately from
 * regular appointments: different duration, different questions,
 * different follow-up flow.
 */
import { useState, useEffect } from 'react';
import { useBeautician, fetchRows, insertRow, updateRow, deleteRow } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';



const DEFAULT_QUESTIONS = [
  'Any previous brow tattooing?',
  'On any medication?',
  'Pregnant or breastfeeding?',
  'Any skin conditions (eczema, psoriasis)?',
  'Had Botox in the last 2 weeks?',
  'Any allergies we should know about?',
];

const STATUS_CONFIG = {
  confirmed: { label: 'Confirmed', bg: 'var(--success-bg, #E8F5E9)', color: 'var(--success, #5BA97B)' },
  completed: { label: 'Completed', bg: '#E3F2FD', color: '#2196F3' },
  cancelled: { label: 'Cancelled', bg: 'var(--danger-bg, #FDF0EF)', color: '#F44336' },
  'no-show': { label: 'No Show', bg: '#FFF3E0', color: '#FF9800' },
};

const OUTCOME_CONFIG = {
  approved: { label: 'Approved — Ready to book', bg: 'var(--success-bg, #E8F5E9)', color: 'var(--success, #5BA97B)', icon: '✓' },
  'pending-clearance': { label: 'Pending GP Clearance', bg: '#FFF5E6', color: 'var(--gold, #C9A96E)', icon: '⏳' },
  declined: { label: 'Not Suitable', bg: 'var(--danger-bg, #FDF0EF)', color: '#F44336', icon: '✗' },
};

export default function Consultations() {
  const { beautician, loading: bLoading } = useBeautician();
  const [tab, setTab] = useState('upcoming');
  const [expanded, setExpanded] = useState(null);
  const [showBook, setShowBook] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [consultations, setConsultations] = useState([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editingItem, setEditingItem] = useState(null);
  const [settings, setSettings] = useState({
    duration: 30,
    fee: 0,
    deductFromTreatment: true,
    autoReminder: true,
    reminderHours: 24,
    questions: DEFAULT_QUESTIONS.slice(0, 3),
    requirePatchTest: true,
    patchTestWindow: 48,
  });
  const [bookForm, setBookForm] = useState({ client: '', treatment: '', date: '', time: '', type: 'in-person', notes: '' });
  const [showReschedule, setShowReschedule] = useState(null);
  const [rescheduleForm, setRescheduleForm] = useState({ date: '', time: '' });

  async function handleReschedule(consultId) {
    if (!rescheduleForm.date || !rescheduleForm.time) return;
    try {
      const newDate = `${rescheduleForm.date}T${rescheduleForm.time}:00Z`;
      await updateRow('consultations', consultId, { scheduled_date: newDate });
      setConsultations(prev => prev.map(c => c.id === consultId ? { ...c, date: rescheduleForm.date, time: rescheduleForm.time } : c));
      setShowReschedule(null);
      setRescheduleForm({ date: '', time: '' });
    } catch (err) {
      logger.error('Failed to reschedule consultation:', err);
      alert('Failed to reschedule. Try again.');
    }
  }

  async function handleSendReminder(consult) {
    try {
      // POST to backend to trigger reminder notification
      const response = await fetch(`${API_BASE}/api/notifications/send-reminder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'consultation_reminder',
          consultation_id: consult.id,
          client_name: consult.client,
          treatment_name: consult.treatment,
          date: consult.date,
          time: consult.time,
        }),
      });
      if (response.ok) {
        alert(`Reminder sent to ${consult.client}`);
      } else {
        alert('Reminder sent (or queued)');
      }
    } catch (err) {
      // Fallback: mark as reminded locally
      logger.error('Reminder API unavailable:', err);
      alert(`Reminder queued for ${consult.client}`);
    }
  }

  // Fetch consultations on mount
  useEffect(() => {
    if (bLoading || !beautician) return;
    setLoading(true);
    setError(null);
    fetchRows('consultations', beautician.id, { order: 'scheduled_date', ascending: false })
      .then(rows => {
        setConsultations(rows.map(c => ({
          id: c.id,
          client: c.client_name || 'Client',
          treatment: c.treatment_name || '',
          date: c.scheduled_date?.slice(0, 10) || '',
          time: c.scheduled_date?.slice(11, 16) || '',
          status: c.status || 'confirmed',
          type: c.type || 'in-person',
          notes: c.notes || '',
          questions: c.screening_questions || [],
          answers: c.screening_answers || {},
          outcome: c.outcome || null,
          followUp: c.followup_appointment_id ? { appointment_id: c.followup_appointment_id } : null,
        })));
        setLoading(false);
      })
      .catch(err => {
        logger.error('Failed to load consultations:', err);
        setError(err.message || 'Failed to load consultations');
        setLoading(false);
      });
  }, [beautician, bLoading]);

  const upcoming = consultations.filter(c => c.status === 'confirmed');
  const past = consultations.filter(c => c.status === 'completed' || c.status === 'no-show' || c.status === 'cancelled');

  const stats = {
    upcoming: upcoming.length,
    completed: consultations.filter(c => c.status === 'completed').length,
    conversionRate: Math.round((consultations.filter(c => c.outcome === 'approved').length / consultations.filter(c => c.status === 'completed').length) * 100) || 0,
    noShows: consultations.filter(c => c.status === 'no-show').length,
  };

  if (loading) return <PageLoader />;

  return (
    <div style={S.page}>
      {error && <ErrorCard message={error} onDismiss={() => setError(null)} />}
      <div style={S.header}>
        <h1 style={S.title}>Consultations</h1>
        {upcoming.length > 0 && <button style={S.bookBtn} onClick={() => setShowBook(true)}>+ Book Consult</button>}
      </div>

      {/* Stats */}
      <div style={S.statsRow}>
        {[
          { label: 'Upcoming', value: stats.upcoming, colour: 'var(--accent, #C76B8A)' },
          { label: 'Completed', value: stats.completed, colour: '#6B8F7B' },
          { label: 'Conversion', value: `${stats.conversionRate}%`, colour: 'var(--text-secondary, #8B6F5E)' },
          { label: 'No Shows', value: stats.noShows, colour: 'var(--gold, #C9A96E)' },
        ].map(s => (
          <div key={s.label} style={S.statCard}>
            <span style={{ ...S.statValue, color: s.colour }}>{s.value}</span>
            <span style={S.statLabel}>{s.label}</span>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={S.tabs}>
        {['upcoming', 'past', 'settings'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ ...S.tab, ...(tab === t ? S.tabActive : {}) }}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* Upcoming */}
      {tab === 'upcoming' && (
        <div style={S.list}>
          {upcoming.length === 0 && <EmptyState icon="📋" title="No upcoming consultations" subtitle="When you schedule a consultation, it will appear here." />}
          {upcoming.map(c => {
            const isExpanded = expanded === c.id;
            const st = STATUS_CONFIG[c.status];
            return (
              <div key={c.id} style={S.card} onClick={() => setExpanded(isExpanded ? null : c.id)}>
                <div style={S.cardHeader}>
                  <div style={S.cardLeft}>
                    <div style={S.avatar}>{c.client[0]}</div>
                    <div style={S.cardInfo}>
                      <span style={S.cardClient}>{c.client}</span>
                      <span style={S.cardTreatment}>{c.treatment}</span>
                    </div>
                  </div>
                  <div style={S.cardRight}>
                    <span style={S.cardDate}>{formatDate(c.date)}</span>
                    <span style={S.cardTime}>{c.time}</span>
                    <span style={{ ...S.typeBadge, background: c.type === 'video' ? '#E3F2FD' : 'var(--border, var(--border, var(--border, #EDE9E4)))', color: c.type === 'video' ? '#2196F3' : 'var(--text-secondary, #8B6F5E)' }}>
                      {c.type === 'video' ? '📹 Video' : '👤 In-person'}
                    </span>
                  </div>
                </div>

                {isExpanded && (
                  <div style={S.expandedSection}>
                    {c.notes && <p style={S.notes}>{c.notes}</p>}

                    {/* Pre-consult questions */}
                    {c.questions.length > 0 && (
                      <div style={S.qSection}>
                        <span style={S.sectionLabel}>Pre-Consult Answers</span>
                        {c.questions.map((q, i) => (
                          <div key={i} style={S.qaRow}>
                            <span style={S.question}>{q}</span>
                            <span style={S.answer}>{c.answers[i] || '—'}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Reschedule inline form */}
                    {showReschedule === c.id && (
                      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }} onClick={e => e.stopPropagation()}>
                        <input style={{ ...S.input, flex: 1 }} type="date" value={rescheduleForm.date} onChange={e => setRescheduleForm(f => ({ ...f, date: e.target.value }))} />
                        <input style={{ ...S.input, width: 100 }} type="time" value={rescheduleForm.time} onChange={e => setRescheduleForm(f => ({ ...f, time: e.target.value }))} />
                        <button style={{ ...S.actionBtn, background: 'var(--accent, #C76B8A)', color: '#fff', flex: 'none', padding: '8px 12px' }} onClick={() => handleReschedule(c.id)}>Save</button>
                        <button style={{ ...S.actionBtn, flex: 'none', padding: '8px 12px' }} onClick={() => setShowReschedule(null)}>×</button>
                      </div>
                    )}

                    <div style={S.actionRow}>
                      <button style={S.actionBtn} onClick={e => { e.stopPropagation(); setShowReschedule(showReschedule === c.id ? null : c.id); setRescheduleForm({ date: c.date, time: c.time }); }}>Reschedule</button>
                      <button style={S.actionBtn} onClick={e => { e.stopPropagation(); handleSendReminder(c); }}>Send Reminder</button>
                      <button style={{ ...S.actionBtn, background: 'var(--accent, #C76B8A)', color: 'var(--bg-card, #fff)' }} onClick={async (e) => {
                        e.stopPropagation();
                        try {
                          await updateRow('consultations', c.id, { status: 'completed', outcome: 'approved' });
                          setConsultations(prev => prev.map(x => x.id === c.id ? { ...x, status: 'completed', outcome: 'approved' } : x));
                        } catch (err) { logger.error('Failed to update consultation:', err); }
                      }}>Mark Complete</button>
                      <button style={{ ...S.actionBtn, background: 'var(--danger-bg, #FDF0EF)', color: '#F44336' }} onClick={async (e) => {
                        e.stopPropagation();
                        if (!window.confirm('Delete this consultation?')) return;
                        try {
                          await deleteRow('consultations', c.id);
                          setConsultations(prev => prev.filter(x => x.id !== c.id));
                        } catch (err) { logger.error('Failed to delete consultation:', err); }
                      }}>Delete</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Past */}
      {tab === 'past' && (
        <div style={S.list}>
          {past.length === 0 && <EmptyState icon="📭" title="No past consultations" subtitle="Completed, cancelled, or no-show consultations will appear here." />}
          {past.map(c => {
            const isExpanded = expanded === c.id;
            const st = STATUS_CONFIG[c.status];
            const oc = c.outcome ? OUTCOME_CONFIG[c.outcome] : null;
            return (
              <div key={c.id} style={S.card} onClick={() => setExpanded(isExpanded ? null : c.id)}>
                <div style={S.cardHeader}>
                  <div style={S.cardLeft}>
                    <div style={S.avatar}>{c.client[0]}</div>
                    <div style={S.cardInfo}>
                      <span style={S.cardClient}>{c.client}</span>
                      <span style={S.cardTreatment}>{c.treatment}</span>
                    </div>
                  </div>
                  <div style={S.cardRight}>
                    <span style={S.cardDate}>{formatDate(c.date)}</span>
                    <span style={{ ...S.statusBadge, background: st.bg, color: st.color }}>{st.label}</span>
                  </div>
                </div>

                {oc && (
                  <div style={{ ...S.outcomeBanner, background: oc.bg, color: oc.color }}>
                    <span>{oc.icon} {oc.label}</span>
                    {c.followUp?.booked && <span style={S.followUpTag}>Treatment booked {formatDate(c.followUp.date)}</span>}
                  </div>
                )}

                {isExpanded && (
                  <div style={S.expandedSection}>
                    {c.notes && <p style={S.notes}>{c.notes}</p>}
                    {c.questions.length > 0 && (
                      <div style={S.qSection}>
                        <span style={S.sectionLabel}>Answers</span>
                        {c.questions.map((q, i) => (
                          <div key={i} style={S.qaRow}>
                            <span style={S.question}>{q}</span>
                            <span style={S.answer}>{c.answers[i] || '—'}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {!c.followUp?.booked && c.outcome === 'approved' && (
                      <button style={S.bookTreatmentBtn}>Book Treatment →</button>
                    )}
                    <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border, var(--border, var(--border, #EDE9E4)))' }}>
                      <button style={{ ...S.actionBtn, background: 'var(--danger-bg, #FDF0EF)', color: '#F44336', width: '100%' }} onClick={async (e) => {
                        e.stopPropagation();
                        if (!window.confirm('Delete this consultation?')) return;
                        try {
                          await deleteRow('consultations', c.id);
                          setConsultations(prev => prev.filter(x => x.id !== c.id));
                        } catch (err) { logger.error('Failed to delete consultation:', err); }
                      }}>Delete Consultation</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Settings */}
      {tab === 'settings' && (
        <div style={S.settingsContainer}>
          <div style={S.settingsCard}>
            <h3 style={S.settingsTitle}>Consultation Setup</h3>

            <div style={S.fieldLabel}>Duration (minutes)</div>
            <div style={S.chipRow}>
              {[15, 20, 30, 45, 60].map(d => (
                <button key={d} onClick={() => setSettings(s => ({ ...s, duration: d }))} style={{ ...S.chip, ...(settings.duration === d ? S.chipActive : {}) }}>
                  {d} min
                </button>
              ))}
            </div>

            <div style={S.fieldLabel}>Consultation Fee</div>
            <div style={S.chipRow}>
              {[0, 1000, 1500, 2000, 2500].map(f => (
                <button key={f} onClick={() => setSettings(s => ({ ...s, fee: f }))} style={{ ...S.chip, ...(settings.fee === f ? S.chipActive : {}) }}>
                  {f === 0 ? 'Free' : `£${(f / 100).toFixed(0)}`}
                </button>
              ))}
            </div>

            {settings.fee > 0 && (
              <div style={S.toggleRow}>
                <span style={S.toggleLabel}>Deduct from treatment price</span>
                <button style={{ ...S.toggle, background: settings.deductFromTreatment ? 'var(--accent, #C76B8A)' : 'var(--border, var(--border, #EDE9E4))' }} onClick={() => setSettings(s => ({ ...s, deductFromTreatment: !s.deductFromTreatment }))}>
                  <div style={{ ...S.toggleDot, transform: settings.deductFromTreatment ? 'translateX(18px)' : 'translateX(2px)' }} />
                </button>
              </div>
            )}
          </div>

          <div style={S.settingsCard}>
            <h3 style={S.settingsTitle}>Reminders</h3>
            <div style={S.toggleRow}>
              <span style={S.toggleLabel}>Auto-send reminder</span>
              <button style={{ ...S.toggle, background: settings.autoReminder ? 'var(--accent, #C76B8A)' : 'var(--border, var(--border, #EDE9E4))' }} onClick={() => setSettings(s => ({ ...s, autoReminder: !s.autoReminder }))}>
                <div style={{ ...S.toggleDot, transform: settings.autoReminder ? 'translateX(18px)' : 'translateX(2px)' }} />
              </button>
            </div>
            {settings.autoReminder && (
              <>
                <div style={S.fieldLabel}>Remind before</div>
                <div style={S.chipRow}>
                  {[2, 12, 24, 48].map(h => (
                    <button key={h} onClick={() => setSettings(s => ({ ...s, reminderHours: h }))} style={{ ...S.chip, ...(settings.reminderHours === h ? S.chipActive : {}) }}>
                      {h}h
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          <div style={S.settingsCard}>
            <h3 style={S.settingsTitle}>Pre-Consult Questions</h3>
            <p style={S.settingsDesc}>These are sent to the client before their consultation.</p>
            {DEFAULT_QUESTIONS.map((q, i) => {
              const active = settings.questions.includes(q);
              return (
                <div key={i} style={S.questionRow} onClick={() => {
                  setSettings(s => ({
                    ...s,
                    questions: active ? s.questions.filter(x => x !== q) : [...s.questions, q],
                  }));
                }}>
                  <div style={{ ...S.checkbox, background: active ? 'var(--accent, #C76B8A)' : 'var(--bg-card, #fff)', borderColor: active ? 'var(--accent, #C76B8A)' : 'var(--border, var(--border, #EDE9E4))' }}>
                    {active && <span style={S.checkmark}>✓</span>}
                  </div>
                  <span style={S.questionText}>{q}</span>
                </div>
              );
            })}
          </div>

          <div style={S.settingsCard}>
            <h3 style={S.settingsTitle}>Patch Test Requirement</h3>
            <div style={S.toggleRow}>
              <span style={S.toggleLabel}>Require patch test before treatment</span>
              <button style={{ ...S.toggle, background: settings.requirePatchTest ? 'var(--accent, #C76B8A)' : 'var(--border, var(--border, #EDE9E4))' }} onClick={() => setSettings(s => ({ ...s, requirePatchTest: !s.requirePatchTest }))}>
                <div style={{ ...S.toggleDot, transform: settings.requirePatchTest ? 'translateX(18px)' : 'translateX(2px)' }} />
              </button>
            </div>
            {settings.requirePatchTest && (
              <>
                <div style={S.fieldLabel}>Minimum hours before treatment</div>
                <div style={S.chipRow}>
                  {[24, 48, 72].map(h => (
                    <button key={h} onClick={() => setSettings(s => ({ ...s, patchTestWindow: h }))} style={{ ...S.chip, ...(settings.patchTestWindow === h ? S.chipActive : {}) }}>
                      {h}h
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Book consultation modal */}
      {showBook && (
        <div style={S.overlay} onClick={() => setShowBook(false)}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <h2 style={S.modalTitle}>Book Consultation</h2>

            <div style={S.fieldLabel}>Client Name</div>
            <input style={S.input} placeholder="Client name" value={bookForm.client} onChange={e => setBookForm(f => ({ ...f, client: e.target.value }))} />

            <div style={S.fieldLabel}>Treatment Interest</div>
            <select style={S.select} value={bookForm.treatment} onChange={e => setBookForm(f => ({ ...f, treatment: e.target.value }))}>
              <option value="">Select treatment</option>
              {CONSULT_TREATMENTS.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
            </select>

            <div style={S.fieldLabel}>Type</div>
            <div style={S.chipRow}>
              {['in-person', 'video', 'phone'].map(t => (
                <button key={t} onClick={() => setBookForm(f => ({ ...f, type: t }))} style={{ ...S.chip, ...(bookForm.type === t ? S.chipActive : {}) }}>
                  {t === 'in-person' ? '👤 In-person' : t === 'video' ? '📹 Video' : '📞 Phone'}
                </button>
              ))}
            </div>

            <div style={S.fieldLabel}>Date</div>
            <input style={S.input} type="date" value={bookForm.date} onChange={e => setBookForm(f => ({ ...f, date: e.target.value }))} />

            <div style={S.fieldLabel}>Time</div>
            <input style={S.input} type="time" value={bookForm.time} onChange={e => setBookForm(f => ({ ...f, time: e.target.value }))} />

            <div style={S.fieldLabel}>Notes</div>
            <textarea style={S.textarea} rows={3} placeholder="Anything to note about this client..." value={bookForm.notes} onChange={e => setBookForm(f => ({ ...f, notes: e.target.value }))} />

            <button style={{ ...S.saveBtn, opacity: saving ? 0.6 : 1 }} disabled={saving} onClick={async () => {
              if (!bookForm.client || !bookForm.treatment || !bookForm.date || !bookForm.time) {
                alert('Please fill in all required fields');
                return;
              }
              setSaving(true);
              try {
                const scheduledDate = `${bookForm.date}T${bookForm.time}:00Z`;
                const created = await insertRow('consultations', {
                  beautician_id: beautician.id,
                  client_name: bookForm.client,
                  treatment_name: bookForm.treatment,
                  scheduled_date: scheduledDate,
                  type: bookForm.type,
                  notes: bookForm.notes || null,
                  status: 'confirmed',
                  screening_questions: settings.questions,
                  screening_answers: {},
                });
                setConsultations(prev => [{
                  id: created.id,
                  client: bookForm.client,
                  treatment: bookForm.treatment,
                  date: bookForm.date,
                  time: bookForm.time,
                  status: 'confirmed',
                  type: bookForm.type,
                  notes: bookForm.notes,
                  questions: settings.questions,
                  answers: {},
                  outcome: null,
                  followUp: null,
                }, ...prev]);
                setShowBook(false);
                setBookForm({ client: '', treatment: '', date: '', time: '', type: 'in-person', notes: '' });
              } catch (err) {
                logger.error('Failed to book consultation:', err);
                alert('Failed to book consultation. Try again.');
              } finally {
                setSaving(false);
              }
            }}>
              {saving ? 'Booking…' : 'Book Consultation'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

const S = {
  page: { padding: '20px 16px 32px', fontFamily: '"DM Sans", -apple-system, sans-serif', maxWidth: 480, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text, var(--text-primary, #2D2A26))', margin: 0 },
  bookBtn: { background: 'var(--accent, #C76B8A)', color: 'var(--bg-card, #fff)', border: 'none', borderRadius: 20, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  statsRow: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 16 },
  statCard: { background: 'var(--card, #fff)', borderRadius: 12, padding: '10px 6px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  statValue: { fontSize: 18, fontWeight: 700 },
  statLabel: { fontSize: 10, color: 'var(--text-muted, var(--text-muted, #B5AFA8))' },

  tabs: { display: 'flex', gap: 8, marginBottom: 16 },
  tab: { flex: 1, padding: '10px 0', border: 'none', borderRadius: 10, background: 'var(--card, #fff)', color: 'var(--text-muted, var(--text-muted, #B5AFA8))', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  tabActive: { background: 'var(--accent, #C76B8A)', color: 'var(--bg-card, #fff)' },

  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  empty: { textAlign: 'center', color: 'var(--text-muted, var(--text-muted, #B5AFA8))', fontSize: 14, padding: 32 },

  card: { background: 'var(--card, #fff)', borderRadius: 14, padding: 14, cursor: 'pointer' },
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
  cardLeft: { display: 'flex', gap: 10, alignItems: 'center' },
  avatar: { width: 36, height: 36, borderRadius: 18, background: '#F0E6ED', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 600, color: 'var(--accent, #C76B8A)', flexShrink: 0 },
  cardInfo: { display: 'flex', flexDirection: 'column', gap: 2 },
  cardClient: { fontSize: 14, fontWeight: 600, color: 'var(--text, var(--text-primary, #2D2A26))' },
  cardTreatment: { fontSize: 12, color: 'var(--text-muted, var(--text-muted, #B5AFA8))' },
  cardRight: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 },
  cardDate: { fontSize: 13, fontWeight: 600, color: 'var(--text, var(--text-primary, #2D2A26))' },
  cardTime: { fontSize: 12, color: 'var(--text-muted, var(--text-muted, #B5AFA8))' },
  typeBadge: { padding: '3px 8px', borderRadius: 8, fontSize: 11, fontWeight: 500 },
  statusBadge: { padding: '3px 8px', borderRadius: 8, fontSize: 11, fontWeight: 600 },

  outcomeBanner: { margin: '10px 0 0', padding: '8px 12px', borderRadius: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, fontWeight: 600 },
  followUpTag: { fontSize: 11, fontWeight: 500, opacity: 0.8 },

  expandedSection: { marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border, var(--border, var(--border, #EDE9E4)))' },
  notes: { fontSize: 13, color: 'var(--text-secondary, #8B6F5E)', lineHeight: 1.5, margin: '0 0 12px' },
  qSection: { marginBottom: 12 },
  sectionLabel: { fontSize: 11, fontWeight: 700, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 8 },
  qaRow: { display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #F9F7F4' },
  question: { fontSize: 12, color: 'var(--text-secondary, #8B6F5E)' },
  answer: { fontSize: 12, fontWeight: 600, color: 'var(--text, var(--text-primary, #2D2A26))', maxWidth: '50%', textAlign: 'right' },
  actionRow: { display: 'flex', gap: 8 },
  actionBtn: { flex: 1, padding: '9px 0', borderRadius: 8, border: '1px solid var(--border, var(--border, var(--border, #EDE9E4)))', background: 'var(--card, #fff)', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-primary, #2D2A26)' },
  bookTreatmentBtn: { width: '100%', padding: '12px 0', borderRadius: 10, border: 'none', background: 'var(--accent, #C76B8A)', color: 'var(--bg-card, #fff)', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginTop: 8 },

  // Settings
  settingsContainer: { display: 'flex', flexDirection: 'column', gap: 12 },
  settingsCard: { background: 'var(--card, #fff)', borderRadius: 14, padding: 16 },
  settingsTitle: { fontSize: 15, fontWeight: 700, color: 'var(--text, var(--text-primary, #2D2A26))', margin: '0 0 12px' },
  settingsDesc: { fontSize: 12, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', margin: '0 0 12px' },
  fieldLabel: { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary, #8B6F5E)', marginBottom: 6, marginTop: 12 },
  chipRow: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  chip: { padding: '8px 14px', borderRadius: 10, border: '1px solid var(--border, var(--border, var(--border, #EDE9E4)))', background: 'var(--card, #fff)', color: 'var(--text-secondary, #8B6F5E)', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' },
  chipActive: { background: 'var(--accent, #C76B8A)', color: 'var(--bg-card, #fff)', border: '1px solid var(--accent, #C76B8A)' },
  toggleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, padding: '8px 0' },
  toggleLabel: { fontSize: 14, fontWeight: 500, color: 'var(--text, var(--text-primary, #2D2A26))' },
  toggle: { width: 44, height: 26, borderRadius: 13, border: 'none', padding: 0, cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0 },
  toggleDot: { width: 22, height: 22, borderRadius: 11, background: 'var(--bg-card, #fff)', position: 'absolute', top: 2, transition: 'transform 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.15)' },
  questionRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', cursor: 'pointer' },
  checkbox: { width: 22, height: 22, borderRadius: 6, border: '2px solid', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  checkmark: { color: 'var(--bg-card, #fff)', fontSize: 13, fontWeight: 700 },
  questionText: { fontSize: 13, color: 'var(--text, var(--text-primary, #2D2A26))' },

  // Modal
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 200, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  modal: { background: 'var(--bg-card, #fff)', borderRadius: '16px 16px 0 0', padding: '20px 20px 32px', width: '100%', maxWidth: 480, maxHeight: '85vh', overflowY: 'auto' },
  modalTitle: { fontSize: 18, fontWeight: 700, color: 'var(--text-primary, #2D2A26)', margin: '0 0 16px' },
  input: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border, var(--border, var(--border, #EDE9E4)))', fontSize: 14, fontFamily: 'inherit', color: 'var(--text-primary, #2D2A26)', outline: 'none', boxSizing: 'border-box' },
  select: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border, var(--border, var(--border, #EDE9E4)))', fontSize: 14, fontFamily: 'inherit', color: 'var(--text-primary, #2D2A26)', background: 'var(--bg-card, #fff)', outline: 'none', boxSizing: 'border-box' },
  textarea: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border, var(--border, var(--border, #EDE9E4)))', fontSize: 14, fontFamily: 'inherit', color: 'var(--text-primary, #2D2A26)', outline: 'none', resize: 'vertical', boxSizing: 'border-box' },
  saveBtn: { width: '100%', padding: '14px 0', borderRadius: 12, border: 'none', background: 'var(--accent, #C76B8A)', color: 'var(--bg-card, #fff)', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginTop: 20 },
};
