/**
 * Courses - Sell training courses & masterclasses.
 *
 * Features:
 *   - Build training courses with name, description, date, location, price, deposit
 *   - Set max students, duration, what's included
 *   - Generate a shareable booking link per course
 *   - Track enrollments and deposit/payment status
 *   - Revenue stats across all courses
 *
 * DB: requires `courses` table and `course_enrollments` table (see migration 036_courses.sql)
 * Public page: /training/:slug/:courseId - TrainingBooking.jsx (to be built)
 */
import { useState, useEffect, useCallback } from 'react';
import { useBeautician, fetchRows, insertRow, updateRow, deleteRow } from '../lib/supabase.js';
import { useTheme } from '../lib/theme.jsx';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import ErrorCard from '../components/ErrorCard.jsx';

const pence = v => `£${(v / 100).toFixed(2)}`;
const fmt = v => `£${Number(v || 0).toFixed(0)}`;

const DURATIONS = ['1 hour', '2 hours', '3 hours', 'Half day (4hrs)', 'Full day (7hrs)', '2 days'];
const MAX_SPOTS = [1, 2, 3, 4, 6, 8, 10, 12];
const INCLUDES_OPTIONS = [
  { key: 'certificate', label: '🏆 Certificate' },
  { key: 'kit',         label: '🧰 Starter kit' },
  { key: 'manual',      label: '📖 Course manual' },
  { key: 'lunch',       label: '🍽 Lunch' },
  { key: 'refreshments',label: '☕ Refreshments' },
  { key: 'models',      label: '🧖 Live models' },
  { key: 'aftercare',   label: '📋 Aftercare pack' },
];

export default function Courses() {
  const { beautician, loading: bLoading } = useBeautician();
  const { dark } = useTheme();
  const [tab, setTab] = useState('courses');
  const [showCreate, setShowCreate] = useState(false);
  const [courses, setCourses] = useState([]);
  const [enrollments, setEnrollments] = useState([]);
  const [saving, setSaving] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState(null);
  const [expandedCourse, setExpandedCourse] = useState(null);

  // Form state
  const [form, setForm] = useState({
    name: '',
    description: '',
    date: '',
    location: '',
    duration: 'Full day (7hrs)',
    max_students: 4,
    price: '',
    deposit: '',
    includes: [],
  });

  const setField = (key, val) => setForm(f => ({ ...f, [key]: val }));

  const resetForm = () => {
    setForm({ name: '', description: '', date: '', location: '', duration: 'Full day (7hrs)', max_students: 4, price: '', deposit: '', includes: [] });
    setEditingItem(null);
    setErrorMsg('');
  };

  useEffect(() => {
    if (bLoading || !beautician) return;
    setLoading(true);
    Promise.all([
      fetchRows('courses', beautician.id),
      fetchRows('course_enrollments', beautician.id),
    ]).then(([c, e]) => {
      setCourses(c || []);
      setEnrollments(e || []);
      setLoading(false);
    }).catch(err => {
      logger.error({ err }, 'Failed to load courses');
      setLoading(false);
    });
  }, [beautician, bLoading]);

  const handleSave = async () => {
    if (!form.name || !form.price) return;
    setSaving(true);
    setErrorMsg('');
    try {
      const payload = {
        ...form,
        price: Number(form.price),
        deposit: Number(form.deposit) || 0,
        status: 'active',
      };
      if (editingItem) {
        const updated = await updateRow('courses', editingItem.id, payload);
        setCourses(prev => prev.map(c => c.id === editingItem.id ? updated : c));
      } else {
        const created = await insertRow('courses', { ...payload, beautician_id: beautician.id });
        setCourses(prev => [created, ...prev]);
      }
      setShowCreate(false);
      resetForm();
    } catch (err) {
      logger.error({ err }, 'Failed to save course');
      setErrorMsg('Failed to save course. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this course? This cannot be undone.')) return;
    try {
      await deleteRow('courses', id);
      setCourses(prev => prev.filter(c => c.id !== id));
    } catch (err) {
      logger.error({ err }, 'Failed to delete course');
    }
  };

  const handleEdit = (course) => {
    setEditingItem(course);
    setForm({
      name: course.name || '',
      description: course.description || '',
      date: course.date || '',
      location: course.location || '',
      duration: course.duration || 'Full day (7hrs)',
      max_students: course.max_students || 4,
      price: course.price || '',
      deposit: course.deposit || '',
      includes: course.includes || [],
    });
    setShowCreate(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const copyLink = (course) => {
    const slug = beautician?.booking_slug || course.booking_slug || 'your-link';
    const base = window.location.origin;
    const url = `${base}/training/${slug}/${course.id}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedId(course.id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  const toggleInclude = (key) => {
    setField('includes', form.includes.includes(key)
      ? form.includes.filter(k => k !== key)
      : [...form.includes, key]);
  };

  const spotsLeft = (course) => (course.max_students || 0) - (course.enrolled || 0);
  const isFull = (course) => spotsLeft(course) <= 0;

  const totalRevenue = courses.reduce((s, c) => s + (c.price || 0) * (c.enrolled || 0), 0);
  const totalEnrolled = courses.reduce((s, c) => s + (c.enrolled || 0), 0);

  const formatDate = (d) => {
    if (!d) return '';
    return new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  };

  const courseEnrollments = (courseId) => enrollments.filter(e => e.course_id === courseId);

  if (bLoading || loading) return <PageLoader />;

  return (
    <div style={s.page}>

      {/* Header */}
      <div style={s.header}>
        <div>
          <h1 style={s.title}>Courses</h1>
          <p style={s.sub}>Sell training & masterclasses</p>
        </div>
        <button onClick={() => { setShowCreate(!showCreate); if (showCreate) resetForm(); }} style={s.addBtn}>
          {showCreate ? '✕' : '+ New course'}
        </button>
      </div>

      {/* Stats */}
      <div style={s.statsRow}>
        <div style={s.statCard}>
          <span style={s.statValue}>{courses.length}</span>
          <span style={s.statLabel}>Courses</span>
        </div>
        <div style={s.statCard}>
          <span style={s.statValue}>{totalEnrolled}</span>
          <span style={s.statLabel}>Enrolled</span>
        </div>
        <div style={s.statCard}>
          <span style={s.statValue}>£{totalRevenue.toLocaleString()}</span>
          <span style={s.statLabel}>Revenue</span>
        </div>
      </div>

      {/* ── Course Builder ── */}
      {showCreate && (
        <div style={s.formCard}>
          <div style={s.formHeader}>
            <span style={s.formTitle}>{editingItem ? 'Edit course' : 'Build a course'}</span>
            <button onClick={() => { setShowCreate(false); resetForm(); }} style={s.closeBtn}>✕</button>
          </div>
          {errorMsg && <ErrorCard message={errorMsg} onDismiss={() => setErrorMsg('')} />}

          {/* Name */}
          <label style={s.label}>Course name</label>
          <input
            value={form.name}
            onChange={e => setField('name', e.target.value)}
            placeholder="e.g. Lash Extension Masterclass"
            style={s.input}
          />

          {/* Description */}
          <label style={s.label}>Description</label>
          <textarea
            value={form.description}
            onChange={e => setField('description', e.target.value)}
            placeholder="What will students learn? What can they charge afterwards?"
            style={{ ...s.input, height: 80, resize: 'vertical' }}
          />

          {/* Date + Location */}
          <div style={s.row2}>
            <div style={{ flex: 1 }}>
              <label style={s.label}>Date</label>
              <input
                type="date"
                value={form.date}
                onChange={e => setField('date', e.target.value)}
                style={s.input}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={s.label}>Location</label>
              <input
                value={form.location}
                onChange={e => setField('location', e.target.value)}
                placeholder="Address or Online"
                style={s.input}
              />
            </div>
          </div>

          {/* Duration */}
          <label style={s.label}>Duration</label>
          <div style={s.chipWrap}>
            {DURATIONS.map(d => (
              <button
                key={d}
                onClick={() => setField('duration', d)}
                style={{ ...s.chip, ...(form.duration === d ? s.chipActive : {}) }}
              >
                {d}
              </button>
            ))}
          </div>

          {/* Max students */}
          <label style={s.label}>Max students</label>
          <div style={s.chipWrap}>
            {MAX_SPOTS.map(n => (
              <button
                key={n}
                onClick={() => setField('max_students', n)}
                style={{ ...s.chip, ...(form.max_students === n ? s.chipActive : {}) }}
              >
                {n}
              </button>
            ))}
          </div>

          {/* Price + Deposit */}
          <div style={s.row2}>
            <div style={{ flex: 1 }}>
              <label style={s.label}>Full price (£)</label>
              <input
                type="number"
                value={form.price}
                onChange={e => setField('price', e.target.value)}
                placeholder="350"
                style={s.input}
                min="0"
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={s.label}>Deposit to book (£)</label>
              <input
                type="number"
                value={form.deposit}
                onChange={e => setField('deposit', e.target.value)}
                placeholder="75"
                style={s.input}
                min="0"
              />
            </div>
          </div>

          {form.price && form.deposit && Number(form.deposit) > 0 && (
            <div style={s.depositNote}>
              Students pay <strong>£{form.deposit}</strong> to secure their spot.
              Remaining <strong>£{Number(form.price) - Number(form.deposit)}</strong> due on the day.
            </div>
          )}

          {/* What's included */}
          <label style={s.label}>What's included</label>
          <div style={s.chipWrap}>
            {INCLUDES_OPTIONS.map(opt => (
              <button
                key={opt.key}
                onClick={() => toggleInclude(opt.key)}
                style={{ ...s.chip, ...(form.includes.includes(opt.key) ? s.chipActive : {}) }}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Actions */}
          <div style={s.formActions}>
            <button
              style={{ ...s.saveBtn, opacity: form.name && form.price && !saving ? 1 : 0.4 }}
              disabled={!form.name || !form.price || saving}
              onClick={handleSave}
            >
              {saving ? (editingItem ? 'Saving…' : 'Creating…') : (editingItem ? 'Save changes' : 'Create course')}
            </button>
            <button
              style={s.cancelBtn}
              onClick={() => { setShowCreate(false); resetForm(); }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Tab bar */}
      <div style={s.tabBar}>
        {['courses', 'enrollments'].map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{ ...s.tab,
              color: tab === t ? 'var(--accent, #92405e)' : 'var(--text-muted, #B5AFA8)',
              borderBottom: tab === t ? '2px solid var(--accent, #92405e)' : '2px solid transparent',
              fontWeight: tab === t ? 600 : 400,
            }}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
            {t === 'enrollments' && totalEnrolled > 0 && (
              <span style={s.badge}>{totalEnrolled}</span>
            )}
          </button>
        ))}
      </div>

      {/* ── Courses list ── */}
      {tab === 'courses' && (
        <div style={s.list}>
          {courses.length === 0 && (
            <div style={s.empty}>
              <div style={s.emptyIcon}>🎓</div>
              <p style={s.emptyTitle}>No courses yet</p>
              <p style={s.emptyText}>Create your first training course above. You'll get a shareable link to send to anyone interested.</p>
            </div>
          )}
          {courses.map(course => (
            <div key={course.id} style={s.courseCard}>

              {/* Top row */}
              <div style={s.courseTop}>
                <div style={{ flex: 1 }}>
                  <div style={s.courseName}>{course.name}</div>
                  {course.date && (
                    <div style={s.courseMeta}>
                      📅 {formatDate(course.date)}
                      {course.location && <> · 📍 {course.location}</>}
                    </div>
                  )}
                  {course.duration && (
                    <div style={s.courseMeta}>⏱ {course.duration}</div>
                  )}
                </div>
                <div style={s.coursePrice}>
                  <span style={s.coursePriceMain}>£{course.price}</span>
                  {course.deposit > 0 && (
                    <span style={s.courseDeposit}>£{course.deposit} deposit</span>
                  )}
                </div>
              </div>

              {/* Description */}
              {course.description && (
                <p style={s.courseDesc}>{course.description}</p>
              )}

              {/* Includes */}
              {course.includes?.length > 0 && (
                <div style={s.includesRow}>
                  {course.includes.map(key => {
                    const opt = INCLUDES_OPTIONS.find(o => o.key === key);
                    return opt ? (
                      <span key={key} style={s.includeTag}>{opt.label}</span>
                    ) : null;
                  })}
                </div>
              )}

              {/* Spots */}
              <div style={s.spotsRow}>
                <div style={s.spotsBar}>
                  <div
                    style={{ ...s.spotsBarFill,
                      width: `${Math.min(100, ((course.enrolled || 0) / (course.max_students || 1)) * 100)}%`,
                      background: isFull(course) ? 'var(--warning, #E8A838)' : 'var(--accent, #92405e)',
                    }}
                  />
                </div>
                <span style={{ ...s.spotsLabel, color: isFull(course) ? 'var(--warning, #E8A838)' : 'var(--text-muted, #B5AFA8)' }}>
                  {isFull(course) ? 'Full' : `${spotsLeft(course)} spot${spotsLeft(course) !== 1 ? 's' : ''} left`}
                  {' '}({course.enrolled || 0}/{course.max_students})
                </span>
              </div>

              {/* Shareable link */}
              <div style={s.linkRow}>
                <div style={s.linkBox}>
                  <span style={s.linkText}>
                    florrie.ai/training/{beautician?.booking_slug || '…'}/{course.id.slice(0, 8)}
                  </span>
                </div>
                <button
                  onClick={() => copyLink(course)}
                  style={{ ...s.copyBtn, background: copiedId === course.id ? 'var(--success, #5BA97B)' : 'var(--accent, #92405e)' }}
                >
                  {copiedId === course.id ? '✓ Copied' : 'Copy link'}
                </button>
              </div>

              {/* Actions */}
              <div style={s.courseActions}>
                <button onClick={() => handleEdit(course)} style={s.actionBtn}>Edit</button>
                <button
                  onClick={() => setExpandedCourse(expandedCourse === course.id ? null : course.id)}
                  style={s.actionBtn}
                >
                  {expandedCourse === course.id ? 'Hide' : `Enrolled (${course.enrolled || 0})`}
                </button>
                <button onClick={() => handleDelete(course.id)} style={{ ...s.actionBtn, color: 'var(--danger-text, #C62828)' }}>Delete</button>
              </div>

              {/* Inline enrollment list */}
              {expandedCourse === course.id && (
                <div style={s.enrollList}>
                  {courseEnrollments(course.id).length === 0 ? (
                    <p style={{ fontSize: 13, color: 'var(--text-muted, #B5AFA8)', textAlign: 'center', padding: '12px 0' }}>
                      No enrollments yet - share the link to get sign-ups.
                    </p>
                  ) : courseEnrollments(course.id).map(e => (
                    <div key={e.id} style={s.enrollRow}>
                      <div style={s.enrollAvatar}>{(e.name || '?')[0].toUpperCase()}</div>
                      <div style={{ flex: 1 }}>
                        <div style={s.enrollName}>{e.name || 'Unknown'}</div>
                        <div style={s.enrollContact}>{e.email || e.phone || ''}</div>
                      </div>
                      <span style={{ ...s.enrollStatus,
                        background: e.payment_status === 'paid' ? 'var(--success-bg, #E8F5E9)' : e.payment_status === 'deposit_paid' ? 'var(--warning-bg, #FFF8E1)' : 'var(--bg, #FAF8F5)',
                        color: e.payment_status === 'paid' ? 'var(--success, #5BA97B)' : e.payment_status === 'deposit_paid' ? '#E8A838' : 'var(--text-muted, #B5AFA8)',
                      }}>
                        {e.payment_status === 'paid' ? 'Paid in full' : e.payment_status === 'deposit_paid' ? 'Deposit paid' : 'Unpaid'}
                      </span>
                    </div>
                  ))}
                </div>
              )}

            </div>
          ))}
        </div>
      )}

      {/* ── Enrollments tab ── */}
      {tab === 'enrollments' && (
        <div style={s.list}>
          {enrollments.length === 0 && (
            <div style={s.empty}>
              <div style={s.emptyIcon}>👩‍🎓</div>
              <p style={s.emptyTitle}>No enrollments yet</p>
              <p style={s.emptyText}>Share your course links and students will appear here when they sign up.</p>
            </div>
          )}
          {enrollments.map(e => {
            const course = courses.find(c => c.id === e.course_id);
            return (
              <div key={e.id} style={s.enrollCard}>
                <div style={s.enrollCardTop}>
                  <div style={s.enrollAvatar}>{(e.name || '?')[0].toUpperCase()}</div>
                  <div style={{ flex: 1 }}>
                    <div style={s.enrollName}>{e.name || 'Unknown'}</div>
                    <div style={s.enrollContact}>{e.email || e.phone || ''}</div>
                    {course && <div style={s.enrollCourse}>{course.name}</div>}
                  </div>
                  <span style={{ ...s.enrollStatus,
                    background: e.payment_status === 'paid' ? 'var(--success-bg, #E8F5E9)' : e.payment_status === 'deposit_paid' ? 'var(--warning-bg, #FFF8E1)' : 'var(--bg, #FAF8F5)',
                    color: e.payment_status === 'paid' ? 'var(--success, #5BA97B)' : e.payment_status === 'deposit_paid' ? '#E8A838' : 'var(--text-muted, #B5AFA8)',
                  }}>
                    {e.payment_status === 'paid' ? 'Paid in full' : e.payment_status === 'deposit_paid' ? 'Deposit paid' : 'Unpaid'}
                  </span>
                </div>
                {course && (
                  <div style={s.enrollMeta}>
                    📅 {formatDate(course.date)} · £{course.price}
                    {course.deposit > 0 && ` (£${course.deposit} deposit)`}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

    </div>
  );
}

const s = {
  page:         { padding: '16px 16px 40px', maxWidth: 480, margin: '0 auto', fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif" },
  header:       { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 },
  title:        { fontSize: 24, fontWeight: 700, color: 'var(--text-primary, #2D2A26)', margin: 0 },
  sub:          { fontSize: 13, color: 'var(--text-muted, #B5AFA8)', margin: '4px 0 0' },
  addBtn:       { padding: '8px 16px', borderRadius: 10, border: 'none', background: 'var(--accent, #92405e)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },

  statsRow:     { display: 'flex', gap: 8, marginBottom: 16 },
  statCard:     { flex: 1, background: 'var(--card-bg, #fff)', borderRadius: 12, padding: '12px 10px', textAlign: 'center', border: '1px solid var(--border, #EDE9E4)' },
  statValue:    { display: 'block', fontSize: 20, fontWeight: 700, color: 'var(--text-primary, #2D2A26)' },
  statLabel:    { display: 'block', fontSize: 10, color: 'var(--text-muted, #B5AFA8)', textTransform: 'uppercase', letterSpacing: '0.03em' },

  formCard:     { background: 'var(--card-bg, #fff)', borderRadius: 16, padding: 18, marginBottom: 16, border: '1px solid var(--border, #EDE9E4)' },
  formHeader:   { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  formTitle:    { fontSize: 16, fontWeight: 700, color: 'var(--text-primary, #2D2A26)' },
  closeBtn:     { background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: 'var(--text-muted, #B5AFA8)', padding: '0 4px' },
  label:        { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-muted, #B5AFA8)', marginBottom: 6, marginTop: 12, textTransform: 'uppercase', letterSpacing: '0.04em' },
  input:        { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1.5px solid var(--border, #EDE9E4)', fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', background: 'var(--bg, #FAF8F5)', color: 'var(--text-primary, #2D2A26)', display: 'block' },
  row2:         { display: 'flex', gap: 10 },
  chipWrap:     { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 4 },
  chip:         { padding: '7px 12px', borderRadius: 8, border: '1.5px solid var(--border, #EDE9E4)', background: 'transparent', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-primary, #2D2A26)' },
  chipActive:   { background: 'var(--accent-light, #FFF0F3)', border: '1.5px solid var(--accent, #92405e)', color: 'var(--accent, #92405e)', fontWeight: 600 },
  depositNote:  { background: 'var(--accent-light, #FFF0F3)', borderRadius: 10, padding: '10px 12px', fontSize: 13, color: 'var(--text-primary, #2D2A26)', marginTop: 8, marginBottom: 4, lineHeight: 1.5 },
  formActions:  { display: 'flex', gap: 10, marginTop: 16 },
  saveBtn:      { flex: 1, padding: '12px 0', borderRadius: 12, border: 'none', background: 'var(--accent, #92405e)', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  cancelBtn:    { padding: '12px 20px', borderRadius: 12, border: '1.5px solid var(--border, #EDE9E4)', background: 'transparent', color: 'var(--text-muted, #B5AFA8)', fontSize: 14, cursor: 'pointer', fontFamily: 'inherit' },

  tabBar:       { display: 'flex', borderBottom: '1px solid var(--border, #EDE9E4)', marginBottom: 14 },
  tab:          { flex: 1, padding: '10px 0', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit', textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 },
  badge:        { background: 'var(--accent, #92405e)', color: '#fff', fontSize: 10, fontWeight: 700, borderRadius: 10, padding: '1px 6px', minWidth: 16, textAlign: 'center' },

  list:         { display: 'flex', flexDirection: 'column', gap: 12 },

  courseCard:   { background: 'var(--card-bg, #fff)', borderRadius: 16, padding: 16, border: '1px solid var(--border, #EDE9E4)' },
  courseTop:    { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 8 },
  courseName:   { fontSize: 16, fontWeight: 700, color: 'var(--text-primary, #2D2A26)', marginBottom: 4 },
  courseMeta:   { fontSize: 12, color: 'var(--text-muted, #B5AFA8)', lineHeight: 1.6 },
  coursePrice:  { textAlign: 'right', flexShrink: 0 },
  coursePriceMain: { display: 'block', fontSize: 18, fontWeight: 700, color: 'var(--accent, #92405e)' },
  courseDeposit:{ display: 'block', fontSize: 11, color: 'var(--text-muted, #B5AFA8)', marginTop: 2 },
  courseDesc:   { fontSize: 13, color: 'var(--text-secondary, #6B6460)', lineHeight: 1.6, marginBottom: 10 },

  includesRow:  { display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 10 },
  includeTag:   { fontSize: 11, background: 'var(--bg, #FAF8F5)', border: '1px solid var(--border, #EDE9E4)', borderRadius: 6, padding: '3px 7px', color: 'var(--text-secondary, #6B6460)' },

  spotsRow:     { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 },
  spotsBar:     { flex: 1, height: 5, borderRadius: 3, background: 'var(--border, #EDE9E4)', overflow: 'hidden' },
  spotsBarFill: { height: '100%', borderRadius: 3, transition: 'width 0.3s' },
  spotsLabel:   { fontSize: 11, fontWeight: 500, whiteSpace: 'nowrap' },

  linkRow:      { display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' },
  linkBox:      { flex: 1, background: 'var(--bg, #FAF8F5)', border: '1px solid var(--border, #EDE9E4)', borderRadius: 8, padding: '8px 10px', overflow: 'hidden' },
  linkText:     { fontSize: 11, color: 'var(--text-muted, #B5AFA8)', fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' },
  copyBtn:      { padding: '8px 14px', borderRadius: 8, border: 'none', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', transition: 'background 0.2s' },

  courseActions:{ display: 'flex', gap: 8, paddingTop: 10, borderTop: '1px solid var(--border, #EDE9E4)' },
  actionBtn:    { flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border, #EDE9E4)', background: 'transparent', color: 'var(--accent, #92405e)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  enrollList:   { marginTop: 10, borderTop: '1px solid var(--border, #EDE9E4)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 },
  enrollRow:    { display: 'flex', alignItems: 'center', gap: 10 },
  enrollCard:   { background: 'var(--card-bg, #fff)', borderRadius: 14, padding: 14, border: '1px solid var(--border, #EDE9E4)' },
  enrollCardTop:{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 },
  enrollAvatar: { width: 34, height: 34, borderRadius: 17, background: 'linear-gradient(135deg, #92405e22, #92405e44)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: 'var(--accent, #92405e)', flexShrink: 0 },
  enrollName:   { fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #2D2A26)' },
  enrollContact:{ fontSize: 12, color: 'var(--text-muted, #B5AFA8)' },
  enrollCourse: { fontSize: 11, color: 'var(--accent, #92405e)', fontWeight: 500, marginTop: 2 },
  enrollMeta:   { fontSize: 12, color: 'var(--text-muted, #B5AFA8)' },
  enrollStatus: { fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 6, whiteSpace: 'nowrap' },

  empty:        { textAlign: 'center', padding: '40px 20px' },
  emptyIcon:    { fontSize: 40, marginBottom: 12 },
  emptyTitle:   { fontSize: 16, fontWeight: 700, color: 'var(--text-primary, #2D2A26)', marginBottom: 6 },
  emptyText:    { fontSize: 13, color: 'var(--text-muted, #B5AFA8)', lineHeight: 1.6, maxWidth: 280, margin: '0 auto' },
};
