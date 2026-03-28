/**
 * Consultations — Separate booking flow for consults & patch tests.
 *
 * Semi-permanent brows, lash extensions — these need a consult first.
 * This page lets Ellie manage consultation bookings separately from
 * regular appointments: different duration, different questions,
 * different follow-up flow.
 */
import { useState, useEffect } from 'react';
import { useBeautician, fetchRows, updateRow, isDevMode, DEV_TREATMENTS } from '../lib/supabase.js';
import logger from '../lib/logger.js';

const DEV_CONSULTS = [
  {
    id: 'con1', client: 'Amy R', treatment: 'Ombre Brows (Semi-Permanent)',
    date: '2026-03-28', time: '11:00', status: 'confirmed', type: 'in-person',
    notes: 'First-time semi-permanent client. Wants natural look.',
    questions: ['Any previous brow tattooing?', 'On any medication?', 'Pregnant or breastfeeding?'],
    answers: { 0: 'No', 1: 'No', 2: 'No' },
    outcome: null,
  },
  {
    id: 'con2', client: 'Beth K', treatment: 'Combination Brows (Semi-Permanent)',
    date: '2026-03-27', time: '14:30', status: 'confirmed', type: 'video',
    notes: 'Referred by Daisy. Has had microblading before — wants to switch to combo.',
    questions: ['Any previous brow tattooing?', 'On any medication?', 'Pregnant or breastfeeding?'],
    answers: { 0: 'Yes — microblading 2 years ago', 1: 'No', 2: 'No' },
    outcome: null,
  },
  {
    id: 'con3', client: 'Chloe M', treatment: 'Ombre Brows (Semi-Permanent)',
    date: '2026-03-22', time: '10:00', status: 'completed', type: 'in-person',
    notes: 'Very fair skin. Discussed pigment options — going with soft taupe.',
    questions: ['Any previous brow tattooing?', 'On any medication?', 'Pregnant or breastfeeding?'],
    answers: { 0: 'No', 1: 'Antihistamines', 2: 'No' },
    outcome: 'approved',
    followUp: { treatment: 'Ombre Brows (Semi-Permanent)', date: '2026-04-05', booked: true },
  },
  {
    id: 'con4', client: 'Dani P', treatment: 'Combination Brows (Semi-Permanent)',
    date: '2026-03-20', time: '15:00', status: 'completed', type: 'video',
    notes: 'Client on blood thinners — advised to get GP clearance before proceeding.',
    questions: ['Any previous brow tattooing?', 'On any medication?', 'Pregnant or breastfeeding?'],
    answers: { 0: 'No', 1: 'Warfarin (blood thinner)', 2: 'No' },
    outcome: 'pending-clearance',
    followUp: null,
  },
  {
    id: 'con5', client: 'Emma W', treatment: 'Ombre Brows (Semi-Permanent)',
    date: '2026-03-15', time: '11:00', status: 'no-show', type: 'in-person',
    notes: '', questions: [], answers: {}, outcome: null, followUp: null,
  },
];

const CONSULT_TREATMENTS = DEV_TREATMENTS.filter(t => t.category === 'brows' && (t.name.includes('Semi-Permanent') || t.name.includes('Combination') || t.name.includes('Ombre')));

const DEFAULT_QUESTIONS = [
  'Any previous brow tattooing?',
  'On any medication?',
  'Pregnant or breastfeeding?',
  'Any skin conditions (eczema, psoriasis)?',
  'Had Botox in the last 2 weeks?',
  'Any allergies we should know about?',
];

const STATUS_CONFIG = {
  confirmed: { label: 'Confirmed', bg: '#E8F5E9', color: '#4CAF50' },
  completed: { label: 'Completed', bg: '#E3F2FD', color: '#2196F3' },
  cancelled: { label: 'Cancelled', bg: '#FFEBEE', color: '#F44336' },
  'no-show': { label: 'No Show', bg: '#FFF3E0', color: '#FF9800' },
};

const OUTCOME_CONFIG = {
  approved: { label: 'Approved — Ready to book', bg: '#E8F5E9', color: '#4CAF50', icon: '✓' },
  'pending-clearance': { label: 'Pending GP Clearance', bg: '#FFF5E6', color: '#B8860B', icon: '⏳' },
  declined: { label: 'Not Suitable', bg: '#FFEBEE', color: '#F44336', icon: '✗' },
};

export default function Consultations({ token }) {
  const { beautician, loading: bLoading } = useBeautician();
  const [tab, setTab] = useState('upcoming');
  const [expanded, setExpanded] = useState(null);
  const [showBook, setShowBook] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [consultations, setConsultations] = useState(DEV_CONSULTS);
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

  // Fetch consultations on mount
  useEffect(() => {
    if (bLoading || !beautician) return;
    if (isDevMode) {
      setConsultations(DEV_CONSULTS);
      return;
    }
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
      })
      .catch(err => logger.error('Failed to load consultations:', err));
  }, [beautician, bLoading]);

  const upcoming = consultations.filter(c => c.status === 'confirmed');
  const past = consultations.filter(c => c.status === 'completed' || c.status === 'no-show' || c.status === 'cancelled');

  const stats = {
    upcoming: upcoming.length,
    completed: consultations.filter(c => c.status === 'completed').length,
    conversionRate: Math.round((consultations.filter(c => c.outcome === 'approved').length / consultations.filter(c => c.status === 'completed').length) * 100) || 0,
    noShows: consultations.filter(c => c.status === 'no-show').length,
  };

  return (
    <div style={S.page}>
      <div style={S.header}>
        <h1 style={S.title}>Consultations</h1>
        {upcoming.length > 0 && <button style={S.bookBtn} onClick={() => setShowBook(true)}>+ Book Consult</button>}
      </div>

      {/* Stats */}
      <div style={S.statsRow}>
        {[
          { label: 'Upcoming', value: stats.upcoming, colour: '#C76B8A' },
          { label: 'Completed', value: stats.completed, colour: '#6B8F7B' },
          { label: 'Conversion', value: `${stats.conversionRate}%`, colour: '#8B6F5E' },
          { label: 'No Shows', value: stats.noShows, colour: '#B8860B' },
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
          {upcoming.length === 0 && <p style={S.empty}>No upcoming consultations.</p>}
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
                    <span style={{ ...S.typeBadge, background: c.type === 'video' ? '#E3F2FD' : '#F0ECE8', color: c.type === 'video' ? '#2196F3' : '#8B6F5E' }}>
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

                    <div style={S.actionRow}>
                      <button style={S.actionBtn}>Reschedule</button>
                      <button style={S.actionBtn}>Send Reminder</button>
                      <button style={{ ...S.actionBtn, background: '#C76B8A', color: '#fff' }}>Mark Complete</button>
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
          {past.length === 0 && <p style={S.empty}>No past consultations.</p>}
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
                <button style={{ ...S.toggle, background: settings.deductFromTreatment ? '#C76B8A' : '#E0DCD8' }} onClick={() => setSettings(s => ({ ...s, deductFromTreatment: !s.deductFromTreatment }))}>
                  <div style={{ ...S.toggleDot, transform: settings.deductFromTreatment ? 'translateX(18px)' : 'translateX(2px)' }} />
                </button>
              </div>
            )}
          </div>

          <div style={S.settingsCard}>
            <h3 style={S.settingsTitle}>Reminders</h3>
            <div style={S.toggleRow}>
              <span style={S.toggleLabel}>Auto-send reminder</span>
              <button style={{ ...S.toggle, background: settings.autoReminder ? '#C76B8A' : '#E0DCD8' }} onClick={() => setSettings(s => ({ ...s, autoReminder: !s.autoReminder }))}>
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
                  <div style={{ ...S.checkbox, background: active ? '#C76B8A' : '#fff', borderColor: active ? '#C76B8A' : '#E0DCD8' }}>
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
              <button style={{ ...S.toggle, background: settings.requirePatchTest ? '#C76B8A' : '#E0DCD8' }} onClick={() => setSettings(s => ({ ...s, requirePatchTest: !s.requirePatchTest }))}>
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

            <button style={S.saveBtn} onClick={() => setShowBook(false)}>Book Consultation</button>
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
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: 0 },
  bookBtn: { background: '#C76B8A', color: '#fff', border: 'none', borderRadius: 20, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  statsRow: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 16 },
  statCard: { background: 'var(--card, #fff)', borderRadius: 12, padding: '10px 6px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  statValue: { fontSize: 18, fontWeight: 700 },
  statLabel: { fontSize: 10, color: '#AAA5A0' },

  tabs: { display: 'flex', gap: 8, marginBottom: 16 },
  tab: { flex: 1, padding: '10px 0', border: 'none', borderRadius: 10, background: 'var(--card, #fff)', color: '#AAA5A0', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  tabActive: { background: '#C76B8A', color: '#fff' },

  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  empty: { textAlign: 'center', color: '#AAA5A0', fontSize: 14, padding: 32 },

  card: { background: 'var(--card, #fff)', borderRadius: 14, padding: 14, cursor: 'pointer' },
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
  cardLeft: { display: 'flex', gap: 10, alignItems: 'center' },
  avatar: { width: 36, height: 36, borderRadius: 18, background: '#F0E6ED', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 600, color: '#C76B8A', flexShrink: 0 },
  cardInfo: { display: 'flex', flexDirection: 'column', gap: 2 },
  cardClient: { fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  cardTreatment: { fontSize: 12, color: '#AAA5A0' },
  cardRight: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 },
  cardDate: { fontSize: 13, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  cardTime: { fontSize: 12, color: '#AAA5A0' },
  typeBadge: { padding: '3px 8px', borderRadius: 8, fontSize: 11, fontWeight: 500 },
  statusBadge: { padding: '3px 8px', borderRadius: 8, fontSize: 11, fontWeight: 600 },

  outcomeBanner: { margin: '10px 0 0', padding: '8px 12px', borderRadius: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, fontWeight: 600 },
  followUpTag: { fontSize: 11, fontWeight: 500, opacity: 0.8 },

  expandedSection: { marginTop: 12, paddingTop: 12, borderTop: '1px solid #F0ECE8' },
  notes: { fontSize: 13, color: '#8B6F5E', lineHeight: 1.5, margin: '0 0 12px' },
  qSection: { marginBottom: 12 },
  sectionLabel: { fontSize: 11, fontWeight: 700, color: '#AAA5A0', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 8 },
  qaRow: { display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #F9F7F4' },
  question: { fontSize: 12, color: '#8B6F5E' },
  answer: { fontSize: 12, fontWeight: 600, color: 'var(--text, #2D2A26)', maxWidth: '50%', textAlign: 'right' },
  actionRow: { display: 'flex', gap: 8 },
  actionBtn: { flex: 1, padding: '9px 0', borderRadius: 8, border: '1px solid #F0ECE8', background: 'var(--card, #fff)', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', color: '#2D2A26' },
  bookTreatmentBtn: { width: '100%', padding: '12px 0', borderRadius: 10, border: 'none', background: '#C76B8A', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginTop: 8 },

  // Settings
  settingsContainer: { display: 'flex', flexDirection: 'column', gap: 12 },
  settingsCard: { background: 'var(--card, #fff)', borderRadius: 14, padding: 16 },
  settingsTitle: { fontSize: 15, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: '0 0 12px' },
  settingsDesc: { fontSize: 12, color: '#AAA5A0', margin: '0 0 12px' },
  fieldLabel: { fontSize: 12, fontWeight: 600, color: '#8B6F5E', marginBottom: 6, marginTop: 12 },
  chipRow: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  chip: { padding: '8px 14px', borderRadius: 10, border: '1px solid #F0ECE8', background: 'var(--card, #fff)', color: '#8B6F5E', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' },
  chipActive: { background: '#C76B8A', color: '#fff', border: '1px solid #C76B8A' },
  toggleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, padding: '8px 0' },
  toggleLabel: { fontSize: 14, fontWeight: 500, color: 'var(--text, #2D2A26)' },
  toggle: { width: 44, height: 26, borderRadius: 13, border: 'none', padding: 0, cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0 },
  toggleDot: { width: 22, height: 22, borderRadius: 11, background: '#fff', position: 'absolute', top: 2, transition: 'transform 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.15)' },
  questionRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', cursor: 'pointer' },
  checkbox: { width: 22, height: 22, borderRadius: 6, border: '2px solid', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  checkmark: { color: '#fff', fontSize: 13, fontWeight: 700 },
  questionText: { fontSize: 13, color: 'var(--text, #2D2A26)' },

  // Modal
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 200, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  modal: { background: '#fff', borderRadius: '16px 16px 0 0', padding: '20px 20px 32px', width: '100%', maxWidth: 480, maxHeight: '85vh', overflowY: 'auto' },
  modalTitle: { fontSize: 18, fontWeight: 700, color: '#2D2A26', margin: '0 0 16px' },
  input: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #F0ECE8', fontSize: 14, fontFamily: 'inherit', color: '#2D2A26', outline: 'none', boxSizing: 'border-box' },
  select: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #F0ECE8', fontSize: 14, fontFamily: 'inherit', color: '#2D2A26', background: '#fff', outline: 'none', boxSizing: 'border-box' },
  textarea: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #F0ECE8', fontSize: 14, fontFamily: 'inherit', color: '#2D2A26', outline: 'none', resize: 'vertical', boxSizing: 'border-box' },
  saveBtn: { width: '100%', padding: '14px 0', borderRadius: 12, border: 'none', background: '#C76B8A', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginTop: 20 },
};
