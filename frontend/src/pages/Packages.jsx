/**
 * Courses. Sell training courses and masterclasses.
 *
 * What the owner does here:
 *   - offers several independently bookable dates behind one shared link
 *   - builds a course: name, what students learn, date (or "date to be
 *     confirmed"), start time, where, how long, how many, price, deposit,
 *     what is included
 *   - shares its booking link (florrie.ai/training/<slug>/<id>)
 *   - sees who has booked, what each has paid, and marks money she took
 *     herself (bank transfer, cash) as paid
 *   - closes bookings, reopens them, cancels a course, removes a student
 *
 * 3 September 2026, after Ellie built her first one. What was wrong:
 *   - a course with no date could not be saved at all: the form sent '' to a
 *     DATE column and the insert was rejected with "Failed to save course"
 *   - the Date field on iOS is blank when empty, so it looked broken
 *   - "Revenue" was price x enrolled, which is not money anyone has
 *   - there was no way to record a deposit paid by bank transfer, no way to
 *     remove a student, and deleting a course silently deleted its students
 *   - a load error showed as "no courses yet"
 *   - a checkout a student abandoned looked identical to a student paying
 *     the trainer directly (lib/course-enrolment.js)
 *
 * DB: `courses` and `course_enrollments` (supabase/migrations/042_courses.sql)
 * plus the optional courses.start_time (20260903_backend029). Saves retry
 * without start_time if the database has not got it yet.
 * Public page: /training/:slug/:courseId (TrainingBooking.jsx).
 */
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useBeautician, supabase } from '../lib/supabase.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import ErrorCard from '../components/ErrorCard.jsx';
import Icon from '../components/ui/Icon';
import PageHeader from '../components/ui/PageHeader.jsx';
import Button from '../components/ui/Button.jsx';
import { holdsAPlace, checkoutAbandoned, enrolmentLabel, spotsLeft, balanceDue, paidOnline, courseStage, sortCourses, groupCourses } from '../lib/course-enrolment.js';

const DURATIONS = ['1 hour', '2 hours', '3 hours', 'Half day (4hrs)', 'Full day (7hrs)', '2 days'];
const MAX_SPOTS = [1, 2, 3, 4, 6, 8, 10, 12];
const INCLUDES_OPTIONS = [
  { key: 'certificate', label: 'Certificate' },
  { key: 'kit',         label: 'Starter kit' },
  { key: 'manual',      label: 'Course manual' },
  { key: 'lunch',       label: 'Lunch' },
  { key: 'refreshments',label: 'Refreshments' },
  { key: 'models',      label: 'Live models' },
  { key: 'aftercare',   label: 'Aftercare pack' },
];
const newDateOption = () => ({ id: crypto.randomUUID(), date: '', start_time: '' });
const emptyForm = () => ({ name: '', description: '', dates: [newDateOption()], group_id: crypto.randomUUID(), location: '', duration: 'Full day (7hrs)', max_students: 4, price: '', deposit: '', includes: [] });
const MAX_DATE_OPTIONS = 24;

const STAGE_CHIP = {
  today:     { text: 'Today',            color: 'var(--accent, #92405e)',      bg: 'var(--accent-light, #F6E7EC)' },
  upcoming:  { text: 'Open for booking', color: 'var(--success, #386F52)',     bg: 'var(--success-bg, #E9F0EB)' },
  tbc:       { text: 'Date to confirm',  color: '#82580f',                     bg: 'var(--warning-bg, #F7EEDD)' },
  closed:    { text: 'Bookings closed',  color: 'var(--text-muted, #6B5D54)',  bg: 'var(--bg, #FBF6F1)' },
  past:      { text: 'Past',             color: 'var(--text-muted, #6B5D54)',  bg: 'var(--bg, #FBF6F1)' },
  cancelled: { text: 'Cancelled',        color: 'var(--danger-text, #9E2B32)', bg: '#FDEDF0' },
};
const TONE = {
  success: { bg: 'var(--success-bg, #E9F0EB)', color: 'var(--success, #386F52)' },
  warning: { bg: 'var(--warning-bg, #F7EEDD)', color: '#82580f' },
  muted:   { bg: 'var(--bg, #FBF6F1)',         color: 'var(--text-muted, #6B5D54)' },
};

const fmtDate = (d, long = false) => {
  if (!d) return '';
  const dt = new Date(`${String(d).slice(0, 10)}T12:00:00`);
  return dt.toLocaleDateString('en-GB', long
    ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }
    : { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
};
const todayInLondon = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const fmtTime = (t) => (t ? String(t).slice(0, 5) : '');
const pounds = (n) => `£${Number(n || 0).toLocaleString('en-GB', { maximumFractionDigits: 2 })}`;
const missingColumn = (err, col) => /column|schema cache|does not exist/i.test(err?.message || '') && new RegExp(col).test(err?.message || '');
const bounded = async (operation) => {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Connection timed out. Please try again.')), 15000); })]);
  } finally { clearTimeout(timer); }
};
const tableMissing = (err) => /relation .* does not exist|could not find the table|schema cache/i.test(err?.message || '');

export default function Courses() {
  const { beautician, loading: bLoading } = useBeautician();
  const ownerRef = useRef(beautician?.id);
  ownerRef.current = beautician?.id;
  const loadedOwnerRef = useRef(null);
  const loadSequence = useRef(0);
  const saveOwnerRef = useRef(null);
  const [tab, setTab] = useState('courses');
  const [showCreate, setShowCreate] = useState(false);
  const [courses, setCourses] = useState([]);
  const [enrollments, setEnrollments] = useState([]);
  const [saving, setSaving] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [addingTo, setAddingTo] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [copiedId, setCopiedId] = useState(null);
  const [expandedCourse, setExpandedCourse] = useState(null);
  const [openStudent, setOpenStudent] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [customSpots, setCustomSpots] = useState('');
  const [form, setForm] = useState(emptyForm);

  const setField = (key, val) => setForm(f => ({ ...f, [key]: val }));
  const say = useCallback((msg) => { setNotice(msg); setTimeout(() => setNotice(''), 2800); }, []);

  const resetForm = () => { setForm(emptyForm()); setEditingItem(null); setAddingTo(null); setErrorMsg(''); setCustomSpots(''); };
  const setDateOption = (id, field, value) => setForm(f => ({ ...f, dates: f.dates.map(d => d.id === id ? { ...d, [field]: value } : d) }));

  // Keyed on the id, not the object: a provider that hands back a fresh
  // object each render would otherwise reload (and re-render) forever.
  const beauticianId = beautician?.id;
  const load = useCallback(async () => {
    if (!beauticianId) return;
    const request = ++loadSequence.current;
    setLoading(true);
    setLoadError('');
    let c, e;
    try { [c, e] = await bounded(Promise.all([
      supabase.from('courses').select('*').eq('beautician_id', beauticianId).order('created_at', { ascending: false }),
      supabase.from('course_enrollments').select('*').eq('beautician_id', beauticianId).order('created_at', { ascending: false }),
    ])); } catch (err) { c = { error: err }; e = { error: err }; }
    if (ownerRef.current !== beauticianId || loadSequence.current !== request) return;
    loadedOwnerRef.current = beauticianId;
    if (c.error || e.error) {
      const err = c.error || e.error;
      logger.error({ err }, 'Failed to load courses');
      setLoadError(tableMissing(err)
        ? 'Courses are not switched on for this account yet. Ask Florrie support to run the courses migration.'
        : 'Could not load your courses just now. Pull down to try again.');
    }
    setCourses(c.data || []);
    setEnrollments(e.data || []);
    setLoading(false);
  }, [beauticianId]);

  useEffect(() => {
    setCourses([]); setEnrollments([]); setShowCreate(false); setSaving(false);
    setEditingItem(null); setAddingTo(null); setErrorMsg(''); setNotice('');
    setForm(emptyForm());
  }, [beauticianId]);
  useEffect(() => { if (!bLoading && beauticianId) load(); }, [beauticianId, bLoading, load]);

  /* ------------------------------------------------------------ the form -- */
  const priceNum = Number(form.price);
  const depositNum = Number(form.deposit) || 0;
  const heldOnEditedDate = editingItem ? Math.max(Number(editingItem.enrolled || 0), enrollments.filter(e => e.course_id === editingItem.id && holdsAPlace(e)).length) : 0;
  const dateLocked = !!editingItem && (Number(editingItem.enrolled || 0) > 0 || enrollments.some(e => e.course_id === editingItem.id));
  const formProblem = (() => {
    if (!form.name.trim()) return 'Give the course a name.';
    if (!form.price || !Number.isFinite(priceNum) || !(priceNum > 0)) return 'Set a price.';
    if (!Number.isFinite(depositNum) || depositNum < 0) return 'The deposit cannot be negative.';
    if (depositNum > priceNum) return 'The deposit cannot be more than the price.';
    const held = heldOnEditedDate;
    if (Number(form.max_students) < held) return `${held} student${held === 1 ? ' has' : 's have'} already booked, so the maximum cannot be lower than ${held}.`;
    if (!Number.isInteger(Number(form.max_students)) || Number(form.max_students) < 1 || Number(form.max_students) > 200) return 'Choose between 1 and 200 students per date.';
    const offered = form.dates;
    if (offered.length > MAX_DATE_OPTIONS) return `Offer up to ${MAX_DATE_OPTIONS} dates at once.`;
    if ((offered.length > 1 || addingTo) && offered.some(d => !d.date)) return 'Choose a date for each option, or remove the empty option.';
    if (!editingItem && offered.some(d => d.date && d.date < todayInLondon())) return 'One of those dates has already passed.';
    const keys = offered.map(d => `${d.date}|${d.start_time}`);
    if (new Set(keys).size !== keys.length) return 'You have added the same date and time twice.';
    if (dateLocked && (offered[0].date !== String(editingItem.date || '').slice(0, 10) || offered[0].start_time !== fmtTime(editingItem.start_time))) return 'This date has bookings or a checkout in progress. Add a new date to offer another option.';
    return null;
  })();

  const handleSave = async () => {
    if (formProblem || saving || saveOwnerRef.current === beautician?.id) { setErrorMsg(formProblem || ''); return; }
    const savingOwner = beautician.id;
    saveOwnerRef.current = savingOwner;
    const stillSameOwner = () => ownerRef.current === savingOwner;
    setSaving(true);
    setErrorMsg('');
    const details = {
      name: form.name.trim(), description: form.description.trim() || null,
      location: form.location.trim() || null, duration: form.duration || null,
      max_students: Number(form.max_students), price: priceNum,
      deposit: depositNum, includes: form.includes,
    };
    const first = form.dates[0];
    const payload = { ...details, date: first.date || null, start_time: first.start_time || null };
    const multiple = form.dates.length > 1;
    const rows = form.dates.map(d => ({ ...details, id: d.id, date: d.date || null, start_time: d.start_time || null,
      beautician_id: beautician.id, status: 'active', ...(multiple ? { course_group_id: form.group_id } : {}),
    }));
    const mergeRows = (saved) => setCourses(prev => {
      const ids = new Set(saved.map(c => c.id));
      return [...saved, ...prev.filter(c => !ids.has(c.id))];
    });
    let omittedStartTime = false;
    try {
      let result;
      let droppedTime = false;
      if (addingTo) {
        result = await bounded(supabase.rpc('add_course_dates', {
          p_course_id: addingTo.id,
          p_dates: form.dates.map(d => ({ id: d.id, date: d.date, start_time: d.start_time || null, max_students: Number(form.max_students) })),
        }));
      } else if (editingItem) {
        result = await bounded(supabase.from('courses').update(payload).eq('id', editingItem.id).eq('beautician_id', beautician.id).select().single());
      } else {
        // A batch insert is one transaction: all offered dates save together.
        result = await bounded(supabase.from('courses').insert(multiple ? rows : rows[0]).select());
      }
      if (!stillSameOwner()) return;
      if (result.error && missingColumn(result.error, 'start_time') && !multiple && !addingTo) {
        omittedStartTime = true;
        const { start_time, ...rest } = editingItem ? payload : rows[0];
        result = editingItem
          ? await bounded(supabase.from('courses').update(rest).eq('id', editingItem.id).eq('beautician_id', beautician.id).select().single())
          : await bounded(supabase.from('courses').insert(rest).select());
        droppedTime = !result.error && !!first.start_time;
      }
      if (!stillSameOwner()) return;
      if (result.error) throw result.error;
      const saved = Array.isArray(result.data) ? result.data : [result.data].filter(Boolean);
      if (!saved.length) throw new Error('No saved dates returned');
      mergeRows(saved);
      setShowCreate(false);
      resetForm();
      say(droppedTime ? 'Saved. The start time could not be stored yet; tell your students the time directly.' : addingTo ? 'Dates added. Students can choose from the same booking link.' : editingItem ? 'This date has been updated.' : multiple ? 'Course created. Share one link so students can choose their date.' : 'Course created. Copy the link to start taking bookings.');
      setTab('courses');
    } catch (err) {
      if (!stillSameOwner()) return;
      // Generated ids stay with the form. If a connection drops after a successful
      // create, an exact retry reads the saved records instead of making duplicates.
      if (!editingItem && !addingTo && (err?.code === '23505' || /fetch|network|connection/i.test(err?.message || ''))) {
        let recovered;
        try { recovered = await bounded(supabase.from('courses').select('*').eq('beautician_id', beautician.id).in('id', rows.map(r => r.id))); } catch { recovered = { error: true }; }
        if (!stillSameOwner()) return;
        if (!recovered.error && recovered.data?.length === rows.length && recovered.data.every(row => {
          const intended = rows.find(r => r.id === row.id);
          return intended && row.name === intended.name && String(row.date || '').slice(0, 10) === (intended.date || '') && fmtTime(row.start_time) === (omittedStartTime ? '' : fmtTime(intended.start_time))
            && ['price', 'deposit', 'max_students'].every(key => Number(row[key]) === Number(intended[key]))
            && ['description', 'location', 'duration', 'course_group_id'].every(key => (row[key] || null) === (intended[key] || null))
            && JSON.stringify(row.includes || []) === JSON.stringify(intended.includes || []);
        })) {
          mergeRows(recovered.data); setShowCreate(false); resetForm();
          say(omittedStartTime && first.start_time ? 'Your course was saved without its start time. Tell your students the time directly until the training update is ready.' : 'Your course dates were saved. The booking link is ready.');
          setSaving(false); return;
        }
      }
      logger.error({ err }, 'Failed to save course');
      const unavailable = missingColumn(err, 'course_group_id') || missingColumn(err, 'start_time') || /add_course_dates|schema cache/i.test(err?.message || '');
      setErrorMsg(unavailable && (multiple || addingTo)
        ? 'Offering several dates is not available on this account yet. Your dates are still here. Try again once the training update is ready.'
        : err?.message?.includes('row-level security') ? 'You do not have permission to save this course.'
          : /duplicate|already|past|booked|date|maximum|students/i.test(err?.message || '') && addingTo ? err.message
            : 'Could not confirm the course was saved. Your details are still here; check your connection and try again.');
    } finally {
      if (saveOwnerRef.current === savingOwner) saveOwnerRef.current = null;
      if (stillSameOwner()) setSaving(false);
    }
  };

  const handleEdit = (course) => {
    setAddingTo(null);
    setEditingItem(course);
    setErrorMsg('');
    setForm({
      name: course.name || '', description: course.description || '',
      dates: [{ id: course.id, date: String(course.date || '').slice(0, 10), start_time: fmtTime(course.start_time) }],
      group_id: course.course_group_id || crypto.randomUUID(),
      location: course.location || '', duration: course.duration || 'Full day (7hrs)',
      max_students: course.max_students || 4, price: course.price ?? '', deposit: course.deposit || '',
      includes: Array.isArray(course.includes) ? course.includes : [],
    });
    setCustomSpots(MAX_SPOTS.includes(course.max_students) ? '' : String(course.max_students || ''));
    setShowCreate(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleAddDates = (course) => {
    handleEdit(course);
    setEditingItem(null);
    setAddingTo(course);
    setForm(f => ({ ...f, dates: [newDateOption()] }));
  };

  /* --------------------------------------------------------- course acts -- */
  const patchCourse = async (id, patch) => {
    setBusyId(id);
    try {
      const { data, error } = await supabase.from('courses').update(patch).eq('id', id).select().single();
      if (error) throw error;
      setCourses(prev => prev.map(c => (c.id === id ? data : c)));
      return data;
    } catch (err) {
      logger.error({ err }, 'Failed to update course');
      say('That did not save. Try again.');
      return null;
    } finally {
      setBusyId(null);
    }
  };

  const closeBookings = (course) => patchCourse(course.id, { status: 'draft' }).then(r => r && say('Bookings closed for this date.'));
  const reopenBookings = (course) => patchCourse(course.id, { status: 'active' }).then(r => r && say('Bookings open again for this date.'));

  const cancelCourse = async (course) => {
    const n = studentsOf(course.id).length;
    const ok = window.confirm(n
      ? `Cancel ${course.name} on ${course.date ? fmtDate(course.date) : 'the unconfirmed date'}? ${n} student${n === 1 ? '' : 's'} will keep their record here so you can refund and message them. Other offered dates stay available.`
      : `Cancel this date for ${course.name}? Other offered dates stay available.`);
    if (!ok) return;
    const r = await patchCourse(course.id, { status: 'cancelled' });
    if (r) say(n ? 'Cancelled. Message your students; refunds are in Money.' : 'Cancelled.');
  };

  const deleteCourse = async (course) => {
    if (course.course_group_id) { await cancelCourse(course); return; }
    if (studentsOf(course.id).length) { say('This course has students. Cancel it instead, so their records stay.'); return; }
    if (!window.confirm(`Delete this date for ${course.name}? This cannot be undone.`)) return;
    setBusyId(course.id);
    try {
      const { error } = await supabase.from('courses').delete().eq('id', course.id);
      if (error) throw error;
      setCourses(prev => prev.filter(c => c.id !== course.id));
    } catch (err) {
      logger.error({ err }, 'Failed to delete course');
      say('Could not delete that course.');
    } finally {
      setBusyId(null);
    }
  };

  const courseUrl = (course) => `${/^https?:$/.test(window.location.protocol) && window.location.hostname !== 'localhost' ? window.location.origin : 'https://florrie.ai'}/training/${beautician?.booking_slug || course.booking_slug || 'your-link'}/${course.id}`;
  const copyLink = async (course) => {
    try {
      await navigator.clipboard.writeText(courseUrl(course));
      setCopiedId(course.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      say('Could not copy. Long-press the link to copy it.');
    }
  };
  const shareLink = async (course) => {
    const url = courseUrl(course);
    if (navigator.share) {
      try { await navigator.share({ title: course.name, text: `Book your place on ${course.name}`, url }); return; } catch { /* dismissed */ }
    }
    copyLink(course);
  };

  /* -------------------------------------------------------- student acts -- */
  const bumpEnrolled = async (courseId, delta) => {
    const course = courses.find(c => c.id === courseId);
    if (!course) return;
    const next = Math.max(0, Number(course.enrolled || 0) + delta);
    const { data, error } = await supabase.from('courses').update({ enrolled: next }).eq('id', courseId).select().single();
    if (error) throw error;
    setCourses(prev => prev.map(c => (c.id === courseId ? data : c)));
  };

  const markPaid = async (row, level) => {
    const course = courses.find(c => c.id === row.course_id);
    if (!course) return;
    setBusyId(row.id);
    try {
      const cents = level === 'paid'
        ? Math.round(Number(course.price || 0) * 100)
        : Math.max(Number(row.amount_paid_cents || 0), Math.round(Number(course.deposit || 0) * 100));
      const patch = { payment_status: level === 'paid' ? 'paid' : 'deposit_paid', amount_paid_cents: cents };
      // A checkout that never finished is no longer that: she took the money herself.
      if (checkoutAbandoned(row)) patch.stripe_payment_intent_id = null;
      const { data, error } = await supabase.from('course_enrollments').update(patch).eq('id', row.id).select().single();
      if (error) throw error;
      setEnrollments(prev => prev.map(e => (e.id === row.id ? data : e)));
      if (!holdsAPlace(row)) await bumpEnrolled(row.course_id, +1);
      say(level === 'paid' ? `${row.name} marked as paid in full.` : `${row.name}'s deposit recorded.`);
    } catch (err) {
      logger.error({ err }, 'Failed to update enrolment');
      say('That did not save. Try again.');
    } finally {
      setBusyId(null);
      setOpenStudent(null);
    }
  };

  const removeStudent = async (row) => {
    const online = paidOnline(row);
    const ok = window.confirm(online
      ? `Remove ${row.name}? They paid £${(Number(row.amount_paid_cents) / 100).toFixed(2)} by card. Removing them here does not refund it; do that from Money if you owe it back.`
      : `Remove ${row.name} from this course?`);
    if (!ok) return;
    setBusyId(row.id);
    try {
      const { error } = await supabase.from('course_enrollments').delete().eq('id', row.id);
      if (error) throw error;
      setEnrollments(prev => prev.filter(e => e.id !== row.id));
      if (holdsAPlace(row)) await bumpEnrolled(row.course_id, -1);
      say(`${row.name} removed. Their place is free again.`);
    } catch (err) {
      logger.error({ err }, 'Failed to remove enrolment');
      say('Could not remove them. Try again.');
    } finally {
      setBusyId(null);
      setOpenStudent(null);
    }
  };

  /* ------------------------------------------------------------- derived -- */
  const today = todayInLondon();
  const studentsOf = (courseId) => enrollments.filter(e => e.course_id === courseId && holdsAPlace(e));
  const attemptsOf = (courseId) => enrollments.filter(e => e.course_id === courseId);
  const sorted = useMemo(() => sortCourses(courses, today), [courses, today]);
  const groups = useMemo(() => groupCourses(sorted, today), [sorted, today]);
  const upcoming = groups.filter(g => g.courses.some(c => ['today', 'upcoming', 'tbc'].includes(courseStage(c, today)))).length;
  const placesHeld = enrollments.filter(holdsAPlace).length;
  const collected = enrollments.reduce((s, e) => s + Number(e.amount_paid_cents || 0), 0) / 100;
  const stillToCollect = enrollments.filter(holdsAPlace).reduce((s, e) => {
    const c = courses.find(x => x.id === e.course_id);
    return c && c.status !== 'cancelled' ? s + balanceDue(c, e) : s;
  }, 0);

  const toggleInclude = (key) => setField('includes', form.includes.includes(key) ? form.includes.filter(k => k !== key) : [...form.includes, key]);

  if (bLoading || loading || loadedOwnerRef.current !== beauticianId) return <PageLoader />;

  return (
    <div style={s.page}>
      <PageHeader
        title="Courses"
        subtitle="Sell training and masterclasses"
        action={(
          <Button disabled={saving} variant={showCreate ? 'secondary' : 'primary'} size="sm" onClick={() => { if (showCreate) resetForm(); setShowCreate(!showCreate); }}>
            {showCreate ? 'Close' : '+ New course'}
          </Button>
        )}
      />

      {loadError && <ErrorCard message={loadError} onDismiss={() => setLoadError('')} />}
      {notice && <div style={s.notice}>{notice}</div>}

      {/* Stats: things that are true, not price x heads */}
      <div style={s.statsRow}>
        <div style={s.statCard}><span style={s.statValue}>{upcoming}</span><span style={s.statLabel}>Open courses</span></div>
        <div style={s.statCard}><span style={s.statValue}>{placesHeld}</span><span style={s.statLabel}>Students</span></div>
        <div style={s.statCard}><span style={s.statValue}>{pounds(collected)}</span><span style={s.statLabel}>Collected</span></div>
      </div>
      {stillToCollect > 0 && <p style={s.statNote}>{pounds(stillToCollect)} still to collect on the day, across booked students.</p>}

      {/* The builder */}
      {showCreate && (
        <div style={s.formCard}>
          <div style={s.formHeader}>
            <span style={s.formTitle}>{addingTo ? `Add dates to ${addingTo.name}` : editingItem ? 'Edit this course date' : 'Build a course'}</span>
            <Button disabled={saving} variant="quiet" icon size="icon" aria-label="Close" onClick={() => { setShowCreate(false); resetForm(); }}><Icon name="x" size={16} /></Button>
          </div>
          {errorMsg && <ErrorCard message={errorMsg} onDismiss={() => setErrorMsg('')} />}

          <fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }} aria-busy={saving}>
          {!addingTo && <>
          <label style={s.label}>Course name</label>
          <input aria-label="Course name" value={form.name} onChange={e => setField('name', e.target.value)} placeholder="e.g. Ultimate Beginner Lash Course" style={s.input} maxLength={120} />

          <label style={s.label}>What students will learn</label>
          <textarea aria-label="What students will learn" value={form.description} onChange={e => setField('description', e.target.value)} placeholder="What you cover, who it is for, and what they can charge afterwards." style={{ ...s.input, height: 88, resize: 'vertical' }} maxLength={2000} />

          </>}
          <div style={s.dateIntro}>
            <strong>{editingItem ? 'Date and time' : 'Dates students can choose'}</strong>
            <p style={s.dateHelp}>{editingItem
              ? dateLocked ? 'This date has bookings or a checkout in progress, so its date and time stay fixed. Add another date to offer more choice.' : 'Changes apply to this date only.'
              : 'Each student chooses one date. Places and payments stay with that date.'}</p>
            {addingTo && <><p style={s.dateHelp}>Based on {addingTo.date ? `${fmtDate(addingTo.date)}${addingTo.start_time ? ` at ${fmtTime(addingTo.start_time)}` : ''}` : 'the current course'}: {pounds(addingTo.price)} per student{Number(addingTo.deposit) > 0 ? `, ${pounds(addingTo.deposit)} deposit` : ', no deposit'}. {addingTo.location || 'Location to confirm'}.</p><p style={s.dateHelp}>New dates keep those details, the duration and included items. Existing dates and students stay as they are.</p></>}
          </div>
          {form.dates.map((option, index) => (
            <div key={option.id} style={s.dateOption}>
              <div style={s.dateOptionTop}>
                <span style={s.dateOptionTitle}>{editingItem ? 'Course date' : `Date ${index + 1}`}</span>
                {!editingItem && form.dates.length > 1 && <Button variant="quiet" size="xs" disabled={saving} aria-label={`Remove date ${index + 1}`} onClick={() => setField('dates', form.dates.filter(d => d.id !== option.id))}>Remove</Button>}
              </div>
              <div style={s.row2}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <label style={s.label} htmlFor={`course-date-${option.id}`}>Date</label>
                  <DateLike id={`course-date-${option.id}`} ariaLabel={`Date ${index + 1}`} type="date" value={option.date} onChange={v => setDateOption(option.id, 'date', v)} placeholder="Pick a date" min={editingItem ? undefined : today} disabled={saving || dateLocked} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <label style={s.label} htmlFor={`course-time-${option.id}`}>Start time</label>
                  <DateLike id={`course-time-${option.id}`} ariaLabel={`Start time ${index + 1}`} type="time" value={option.start_time} onChange={v => setDateOption(option.id, 'start_time', v)} placeholder="e.g. 09:30" disabled={saving || dateLocked} />
                </div>
              </div>
            </div>
          ))}
          {!editingItem && <Button variant="secondary" size="sm" disabled={saving || form.dates.length >= MAX_DATE_OPTIONS} onClick={() => setField('dates', [...form.dates, newDateOption()])}>+ Add another date</Button>}
          {!editingItem && !addingTo && form.dates.length === 1 && <span style={s.hint}>Leave the date blank if you will confirm it later. Add dates when you are ready.</span>}
          {!dateLocked && <span style={s.hint}>The selected date and start time appear in each student’s confirmation.</span>}

          {!addingTo && <>

          <label style={s.label}>Location</label>
          <input aria-label="Location" value={form.location} onChange={e => setField('location', e.target.value)} placeholder="Salon address, or Online" style={s.input} maxLength={200} />

          <label style={s.label}>Duration</label>
          <div style={s.chipWrap}>
            {DURATIONS.map(d => (
              <Button key={d} variant="chip" size="xs" aria-pressed={form.duration === d} onClick={() => setField('duration', d)}>{d}</Button>
            ))}
          </div>

          </>}
          <label style={s.label}>Max students per date</label>
          <div style={s.chipWrap}>
            {MAX_SPOTS.map(n => (
              <Button key={n} variant="chip" size="xs" aria-pressed={form.max_students === n && !customSpots} onClick={() => { setField('max_students', n); setCustomSpots(''); }}>{n}</Button>
            ))}
            <input
              aria-label="Custom students per date" type="number" inputMode="numeric" min="1" max="200" placeholder="Other"
              value={customSpots}
              onChange={e => { const v = e.target.value; setCustomSpots(v); if (Number(v) >= 1) setField('max_students', Number(v)); }}
              style={{ ...s.input, width: 84, minHeight: 44, padding: '7px 10px', display: 'inline-block', ...(customSpots ? { borderColor: 'var(--accent, #92405e)', color: 'var(--accent, #92405e)', fontWeight: 600 } : {}) }}
            />
          </div>
          {editingItem && Number(editingItem.enrolled) > 0 && (
            <span style={s.hint}>{editingItem.enrolled} already booked. You can raise the maximum, not lower it below that.</span>
          )}

          {!addingTo && <>
          <div style={s.row2}>
            <div style={{ flex: 1 }}>
              <label style={s.label}>Full price (£)</label>
              <input aria-label="Full price (£)" type="number" inputMode="decimal" value={form.price} onChange={e => setField('price', e.target.value)} placeholder="750" style={s.input} min="0" step="1" />
            </div>
            <div style={{ flex: 1 }}>
              <label style={s.label}>Deposit to book (£)</label>
              <input aria-label="Deposit to book (£)" type="number" inputMode="decimal" value={form.deposit} onChange={e => setField('deposit', e.target.value)} placeholder="150" style={s.input} min="0" step="1" />
            </div>
          </div>

          {priceNum > 0 && depositNum > 0 && depositNum <= priceNum && (
            <div style={s.depositNote}>
              Students pay <strong>£{depositNum}</strong> {beautician?.stripe_onboarding_complete ? 'by card when they book' : 'to secure their place'}.
              Remaining <strong>£{priceNum - depositNum}</strong> due on the day.
              {!beautician?.stripe_onboarding_complete && ' Connect Stripe in Settings to take the deposit online.'}
            </div>
          )}
          {priceNum > 0 && depositNum === 0 && (
            <div style={s.depositNote}>No deposit: students book with just their details and pay <strong>£{priceNum}</strong> on the day.</div>
          )}

          <label style={s.label}>What's included</label>
          <div style={s.chipWrap}>
            {INCLUDES_OPTIONS.map(opt => (
              <Button key={opt.key} variant="chip" size="xs" aria-pressed={form.includes.includes(opt.key)} onClick={() => toggleInclude(opt.key)}>{opt.label}</Button>
            ))}
          </div>

          </>}

          {formProblem && form.name && form.price && <p style={s.problem}>{formProblem}</p>}

          <div style={s.formActions}>
            <Button fullWidth loading={saving} disabled={!!formProblem} onClick={handleSave} style={{ flex: 1 }}>
              {saving ? 'Saving' : addingTo ? 'Save dates' : editingItem ? 'Save changes' : 'Create course'}
            </Button>
            <Button disabled={saving} variant="secondary" onClick={() => { setShowCreate(false); resetForm(); }}>Cancel</Button>
          </div>
          </fieldset>
        </div>
      )}

      {/* Tabs */}
      <div style={s.tabBar}>
        {[['courses', 'Courses'], ['students', 'Students']].map(([key, label]) => (
          <Button key={key} variant="quiet" size="sm" onClick={() => setTab(key)} aria-pressed={tab === key} style={{ ...s.tab,
            color: tab === key ? 'var(--accent, #92405e)' : 'var(--text-muted, #6B5D54)',
            borderBottom: tab === key ? '2px solid var(--accent, #92405e)' : '2px solid transparent',
            fontWeight: tab === key ? 600 : 400,
          }}>
            {label}
            {key === 'students' && placesHeld > 0 && <span style={s.badge}>{placesHeld}</span>}
          </Button>
        ))}
      </div>

      {/* Courses */}
      {tab === 'courses' && (
        <div style={s.list}>
          {sorted.length === 0 && !loadError && (
            <div style={s.empty}>
              <div style={s.emptyIcon}><Icon name="book" size={32} /></div>
              <p style={s.emptyTitle}>No courses yet</p>
              <p style={s.emptyText}>Build your first one above. You get a link to share on Instagram, WhatsApp or your story, and students book themselves in.</p>
            </div>
          )}
          {groups.map(group => {
            const base = group.anchor;
            const multiple = group.courses.length > 1;
            const shareable = group.courses.some(c => c.status !== 'cancelled');
            const priceVaries = group.courses.some(c => Number(c.price) !== Number(base.price) || Number(c.deposit) !== Number(base.deposit));
            return (
              <section key={group.id} style={s.courseCard} aria-label={base.name}>
                <div style={s.courseTop}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {multiple && <span style={{ ...s.stageChip, color: 'var(--accent, #92405e)', background: 'var(--accent-light, #F6E7EC)', display: 'inline-block', marginBottom: 8 }}>{group.courses.length} date options</span>}
                    <div style={s.courseName}>{base.name}</div>
                    {base.location && <div style={s.courseMeta}><Icon name="map-pin" inline /> {base.location}</div>}
                    {base.duration && <div style={s.courseMeta}><Icon name="clock" inline /> {base.duration}</div>}
                  </div>
                  <div style={s.coursePrice}>
                    <span style={s.coursePriceMain}>{priceVaries ? 'From ' : ''}{pounds(Math.min(...group.courses.map(c => Number(c.price || 0))))}</span>
                    {!priceVaries && Number(base.deposit) > 0 && <span style={s.courseDeposit}>{pounds(base.deposit)} deposit</span>}
                  </div>
                </div>
                {base.description && <p style={s.courseDesc}>{base.description}</p>}
                {Array.isArray(base.includes) && base.includes.length > 0 && <div style={s.includesRow}>
                  {base.includes.map(key => { const opt = INCLUDES_OPTIONS.find(o => o.key === key); return opt ? <span key={key} style={s.includeTag}>{opt.label}</span> : null; })}
                </div>}
                {shareable && <>
                  {multiple && <p style={s.dateHelp}>Share one link. Students choose the date that suits them.</p>}
                  <div style={s.linkRow}>
                    <div style={s.linkBox}><span style={s.linkText}>florrie.ai/training/{beautician?.booking_slug || '…'}/{base.id.slice(0, 8)}</span></div>
                    <Button size="sm" onClick={() => copyLink(base)} style={copiedId === base.id ? { background: 'var(--success, #386F52)' } : undefined}>{copiedId === base.id ? 'Copied' : 'Copy link'}</Button>
                    <Button variant="secondary" icon size="icon" aria-label="Share link" onClick={() => shareLink(base)}><Icon name="share" size={16} /></Button>
                  </div>
                </>}
                <div style={s.dateList}>
                  {group.courses.map(course => {
                    const stage = courseStage(course, today);
                    const chip = STAGE_CHIP[stage];
                    const students = studentsOf(course.id);
                    const attempts = attemptsOf(course.id);
                    const left = spotsLeft(course);
                    const full = left <= 0;
                    const open = ['today', 'upcoming', 'tbc'].includes(stage);
                    const takenHere = students.reduce((sum, e) => sum + Number(e.amount_paid_cents || 0), 0) / 100;
                    return <div key={course.id} style={{ ...s.offeredDate, opacity: stage === 'cancelled' || stage === 'past' ? 0.75 : 1 }}>
                      <div style={s.chipRow}>
                        <span style={{ ...s.stageChip, color: chip.color, background: chip.bg }}>{chip.text}</span>
                        {open && full && <span style={{ ...s.stageChip, color: '#82580f', background: 'var(--warning-bg, #F7EEDD)' }}>Full</span>}
                      </div>
                      <div style={s.dateHeading}><Icon name="calendar" size={16} inline /> {course.date ? `${fmtDate(course.date)}${course.start_time ? `, ${fmtTime(course.start_time)}` : ''}` : 'Date to be confirmed'}</div>
                      {course.name !== base.name && <div style={s.courseMeta}>{course.name}</div>}
                      {course.location !== base.location && <div style={s.courseMeta}>{course.location || 'Location to confirm'}</div>}
                      {course.duration !== base.duration && <div style={s.courseMeta}>{course.duration}</div>}
                      {course.description !== base.description && <p style={s.courseDesc}>{course.description}</p>}
                      {priceVaries && <p style={s.dateHelp}>{pounds(course.price)} · {Number(course.deposit) > 0 ? `${pounds(course.deposit)} deposit` : 'No deposit'}</p>}
                      <div style={s.spotsRow}>
                        <div style={s.spotsBar}><div style={{ ...s.spotsBarFill, width: `${Math.min(100, (Number(course.enrolled || 0) / Math.max(1, Number(course.max_students || 1))) * 100)}%`, background: full ? 'var(--warning, #79581C)' : 'var(--accent, #92405e)' }} /></div>
                        <span style={{ ...s.spotsLabel, color: full ? 'var(--warning, #79581C)' : 'var(--text-muted, #6B5D54)' }}>{full ? 'Full' : `${left} place${left !== 1 ? 's' : ''} left`} ({course.enrolled || 0}/{course.max_students}){takenHere > 0 && <> · {pounds(takenHere)} taken</>}</span>
                      </div>
                      <div style={s.courseActions}>
                        {stage !== 'cancelled' && <Button variant="secondary" size="xs" style={s.actionBtn} disabled={saving} onClick={() => handleEdit(course)}>Edit date</Button>}
                        <Button variant="secondary" size="xs" style={s.actionBtn} onClick={() => { setExpandedCourse(expandedCourse === course.id ? null : course.id); setOpenStudent(null); }}>{expandedCourse === course.id ? 'Hide students' : `Students (${students.length})`}</Button>
                        {open && <Button variant="secondary" size="xs" style={s.actionBtn} disabled={busyId === course.id} onClick={() => closeBookings(course)}>Close bookings</Button>}
                        {stage === 'closed' && <Button variant="secondary" size="xs" style={s.actionBtn} disabled={busyId === course.id} onClick={() => reopenBookings(course)}>Reopen</Button>}
                        {stage !== 'cancelled' && (students.length || course.course_group_id
                          ? <Button variant="danger" size="xs" style={s.actionBtn} disabled={busyId === course.id} onClick={() => cancelCourse(course)}>Cancel date</Button>
                          : <Button variant="danger" size="xs" style={s.actionBtn} disabled={busyId === course.id} onClick={() => deleteCourse(course)}>Delete date</Button>)}
                      </div>
                      {expandedCourse === course.id && <div style={s.enrollList}>
                        {attempts.length === 0 ? <p style={s.enrollEmpty}>Nobody booked on this date yet.</p> : attempts.map(e => <StudentRow key={e.id} row={e} course={course} open={openStudent === e.id} busy={busyId === e.id}
                          onToggle={() => setOpenStudent(openStudent === e.id ? null : e.id)} onMarkDeposit={() => markPaid(e, 'deposit')} onMarkPaid={() => markPaid(e, 'paid')} onRemove={() => removeStudent(e)} />)}
                      </div>}
                    </div>;
                  })}
                </div>
                {shareable && <Button variant="secondary" fullWidth size="sm" disabled={saving} style={{ marginTop: 12 }} onClick={() => handleAddDates(group.courses.find(c => c.status === 'active') || group.courses.find(c => c.status !== 'cancelled'))}>+ Add dates</Button>}
              </section>
            );
          })}
        </div>
      )}

      {/* Students, across every course */}
      {tab === 'students' && (
        <div style={s.list}>
          {enrollments.length === 0 && (
            <div style={s.empty}>
              <div style={s.emptyIcon}><Icon name="users" size={32} /></div>
              <p style={s.emptyTitle}>No students yet</p>
              <p style={s.emptyText}>When somebody books through a course link they appear here, with what they have paid and how to reach them.</p>
            </div>
          )}
          {enrollments.map(e => {
            const course = courses.find(c => c.id === e.course_id);
            return (
              <div key={e.id} style={s.enrollCard}>
                <StudentRow row={e} course={course} open={openStudent === e.id} busy={busyId === e.id} showCourse
                  onToggle={() => setOpenStudent(openStudent === e.id ? null : e.id)}
                  onMarkDeposit={() => markPaid(e, 'deposit')} onMarkPaid={() => markPaid(e, 'paid')} onRemove={() => removeStudent(e)} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * A native date or time input, with a visible placeholder. iOS renders an
 * empty <input type="date"> as a blank box with no hint at all, which is
 * what made the Date field look broken. The placeholder is painted over the
 * empty control and lets taps through to it.
 */
function DateLike({ type, value, onChange, placeholder, min, id, ariaLabel, disabled }) {
  return (
    <div style={{ position: 'relative' }}>
      <input id={id} aria-label={ariaLabel} disabled={disabled} type={type} value={value} min={min} onChange={e => onChange(e.target.value)} style={{ ...s.input, minHeight: 44, color: value ? 'var(--text-primary, #241B17)' : 'transparent' }} />
      {!value && <span style={s.fakePlaceholder} aria-hidden="true">{placeholder}</span>}
    </div>
  );
}

function StudentRow({ row, course, open, busy, showCourse = false, onToggle, onMarkDeposit, onMarkPaid, onRemove }) {
  const label = enrolmentLabel(row);
  const tone = TONE[label.tone];
  const abandoned = checkoutAbandoned(row);
  const due = course ? balanceDue(course, row) : 0;
  const wa = row.phone ? `https://wa.me/${String(row.phone).replace(/\D/g, '').replace(/^0/, '44')}` : null;
  return (
    <div style={{ ...s.enrollRow, opacity: abandoned ? 0.7 : 1 }}>
      <button type="button" onClick={onToggle} style={s.enrollMain}>
        <div style={s.enrollAvatar}>{(row.name || '?')[0].toUpperCase()}</div>
        <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
          <div style={s.enrollName}>{row.name || 'Unknown'}</div>
          <div style={s.enrollContact}>{[row.email, row.phone].filter(Boolean).join(' · ')}</div>
          {showCourse && course && <div style={s.enrollCourse}>{course.name}{course.date ? ` · ${fmtDate(course.date)}${course.start_time ? `, ${fmtTime(course.start_time)}` : ''}` : ' · Date to confirm'}</div>}
          {row.notes && <div style={s.enrollNotes}>“{row.notes}”</div>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
          <span style={{ ...s.enrollStatus, background: tone.bg, color: tone.color }}>{label.text}</span>
          {!abandoned && due > 0 && <span style={s.dueLabel}>{pounds(due)} to collect</span>}
        </div>
      </button>
      {open && (
        <div style={s.studentActions}>
          {abandoned && <p style={s.studentHint}>They opened the card payment and did not finish, so no place is held. If they have paid you another way, record it below and the place is theirs.</p>}
          <div style={s.studentBtns}>
            {row.payment_status !== 'paid' && row.payment_status !== 'deposit_paid' && Number(course?.deposit) > 0 && (
              <Button variant="tonal" size="xs" disabled={busy} onClick={onMarkDeposit}>Deposit paid</Button>
            )}
            {row.payment_status !== 'paid' && <Button variant="tonal" size="xs" disabled={busy} onClick={onMarkPaid}>Paid in full</Button>}
            {row.email && <Button as="a" variant="secondary" size="xs" href={`mailto:${row.email}`}>Email</Button>}
            {wa && <Button as="a" variant="secondary" size="xs" href={wa} target="_blank" rel="noreferrer">WhatsApp</Button>}
            {row.phone && <Button as="a" variant="secondary" size="xs" href={`tel:${row.phone}`}>Call</Button>}
            <Button variant="danger" size="xs" disabled={busy} onClick={onRemove}>{abandoned ? 'Clear' : 'Remove'}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

const s = {
  page:         { padding: '16px 16px 40px', maxWidth: 480, margin: '0 auto', fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif" },
  notice:       { background: 'var(--accent-light, #F6E7EC)', color: 'var(--accent, #92405e)', borderRadius: 10, padding: '10px 12px', fontSize: 13, fontWeight: 600, marginBottom: 12 },

  statsRow:     { display: 'flex', gap: 8, marginBottom: 6 },
  statCard:     { flex: 1, background: 'var(--card-bg, #FFFCF9)', borderRadius: 10, padding: '12px 10px', textAlign: 'center', border: '1px solid var(--border, #E8DDD4)' },
  statValue:    { display: 'block', fontSize: 20, fontWeight: 700, color: 'var(--text-primary, #241B17)' },
  statLabel:    { display: 'block', fontSize: 10, color: 'var(--text-muted, #6B5D54)', textTransform: 'uppercase', letterSpacing: '0.03em' },
  statNote:     { fontSize: 12, color: 'var(--text-muted, #6B5D54)', margin: '4px 2px 12px' },

  dateIntro:    { marginTop: 18, color: 'var(--text-primary, #241B17)', fontSize: 14 },
  dateHelp:     { margin: '6px 0 12px', color: 'var(--text-muted, #6B5D54)', fontSize: 12, lineHeight: 1.55 },
  dateOption:   { padding: '10px 12px 14px', marginBottom: 10, background: 'var(--bg, #FBF6F1)', border: '1px solid var(--border, #E8DDD4)', borderRadius: 12 },
  dateOptionTop:{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 32 },
  dateOptionTitle: { fontSize: 12, fontWeight: 700, color: 'var(--accent, #92405e)' },
  dateList:     { display: 'flex', flexDirection: 'column', gap: 12, marginTop: 14 },
  offeredDate:  { padding: 12, background: 'var(--bg, #FBF6F1)', borderRadius: 12, border: '1px solid var(--border, #E8DDD4)' },
  dateHeading:  { fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #241B17)', margin: '10px 0 14px', lineHeight: 1.5 },

  formCard:     { background: 'var(--card-bg, #FFFCF9)', borderRadius: 16, padding: 18, margin: '10px 0 16px', border: '1px solid var(--border, #E8DDD4)' },
  formHeader:   { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  formTitle:    { fontSize: 16, fontWeight: 700, color: 'var(--text-primary, #241B17)' },
  label:        { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-muted, #6B5D54)', marginBottom: 6, marginTop: 14, textTransform: 'uppercase', letterSpacing: '0.04em' },
  hint:         { display: 'block', fontSize: 11.5, color: 'var(--text-muted, #6B5D54)', marginTop: 5, lineHeight: 1.4 },
  problem:      { fontSize: 13, color: 'var(--danger-text, #9E2B32)', margin: '12px 0 0', fontWeight: 500 },
  input:        { width: '100%', minHeight: 44, padding: '10px 12px', borderRadius: 10, border: '1.5px solid var(--border, #E8DDD4)', fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', background: 'var(--bg, #FBF6F1)', color: 'var(--text-primary, #241B17)', display: 'block', WebkitAppearance: 'none', appearance: 'none' },
  fakePlaceholder: { position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 14, color: 'var(--text-muted, #6B5D54)', opacity: 0.75, pointerEvents: 'none' },
  row2:         { display: 'flex', gap: 10 },
  chipWrap:     { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 4, alignItems: 'center' },
  depositNote:  { background: 'var(--accent-light, #F6E7EC)', borderRadius: 10, padding: '10px 12px', fontSize: 13, color: 'var(--text-primary, #241B17)', marginTop: 10, lineHeight: 1.5 },
  formActions:  { display: 'flex', gap: 10, marginTop: 18 },

  tabBar:       { display: 'flex', borderBottom: '1px solid var(--border, #E8DDD4)', marginBottom: 14 },
  tab:          { flex: 1, padding: '10px 0', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit', textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 },
  badge:        { background: 'var(--accent, #92405e)', color: '#fff', fontSize: 10, fontWeight: 700, borderRadius: 10, padding: '1px 6px', minWidth: 16, textAlign: 'center' },

  list:         { display: 'flex', flexDirection: 'column', gap: 12 },

  courseCard:   { background: 'var(--card-bg, #FFFCF9)', borderRadius: 16, padding: 16, border: '1px solid var(--border, #E8DDD4)' },
  courseTop:    { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 8 },
  chipRow:      { display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' },
  stageChip:    { fontSize: 10.5, fontWeight: 700, padding: '3px 8px', borderRadius: 999, letterSpacing: '0.04em', textTransform: 'uppercase' },
  courseName:   { fontSize: 16, fontWeight: 700, color: 'var(--text-primary, #241B17)', marginBottom: 4 },
  courseMeta:   { fontSize: 12, color: 'var(--text-muted, #6B5D54)', lineHeight: 1.6 },
  coursePrice:  { textAlign: 'right', flexShrink: 0 },
  coursePriceMain: { display: 'block', fontSize: 18, fontWeight: 700, color: 'var(--accent, #92405e)' },
  courseDeposit:{ display: 'block', fontSize: 11, color: 'var(--text-muted, #6B5D54)', marginTop: 2 },
  courseDesc:   { fontSize: 13, color: 'var(--text-secondary, #574A42)', lineHeight: 1.6, marginBottom: 10, whiteSpace: 'pre-wrap' },

  includesRow:  { display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 10 },
  includeTag:   { fontSize: 11, background: 'var(--bg, #FBF6F1)', border: '1px solid var(--border, #E8DDD4)', borderRadius: 'var(--radius-xs, 6px)', padding: '3px 7px', color: 'var(--text-secondary, #574A42)' },

  spotsRow:     { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 },
  spotsBar:     { flex: 1, height: 5, borderRadius: 'var(--radius-xs, 6px)', background: 'var(--border, #E8DDD4)', overflow: 'hidden' },
  spotsBarFill: { height: '100%', borderRadius: 'var(--radius-xs, 6px)', transition: 'width 0.3s' },
  spotsLabel:   { fontSize: 11, fontWeight: 500, whiteSpace: 'nowrap' },

  linkRow:      { display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' },
  linkBox:      { flex: 1, background: 'var(--bg, #FBF6F1)', border: '1px solid var(--border, #E8DDD4)', borderRadius: 10, padding: '8px 10px', overflow: 'hidden', minWidth: 0 },
  linkText:     { fontSize: 11, color: 'var(--text-muted, #6B5D54)', fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' },

  courseActions:{ display: 'flex', gap: 6, paddingTop: 10, borderTop: '1px solid var(--border, #E8DDD4)', flexWrap: 'wrap' },
  actionBtn:    { flex: 1, minWidth: 70, whiteSpace: 'nowrap' },

  enrollList:   { marginTop: 10, borderTop: '1px solid var(--border, #E8DDD4)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 },
  enrollEmpty:  { fontSize: 13, color: 'var(--text-muted, #6B5D54)', textAlign: 'center', padding: '12px 0', margin: 0 },
  enrollRow:    { display: 'flex', flexDirection: 'column', gap: 8 },
  enrollMain:   { display: 'flex', alignItems: 'center', gap: 10, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', width: '100%', color: 'inherit' },
  enrollCard:   { background: 'var(--card-bg, #FFFCF9)', borderRadius: 16, padding: 14, border: '1px solid var(--border, #E8DDD4)' },
  enrollAvatar: { width: 34, height: 34, borderRadius: 16, background: 'linear-gradient(135deg, #92405e22, #92405e44)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: 'var(--accent, #92405e)', flexShrink: 0 },
  enrollName:   { fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #241B17)' },
  enrollContact:{ fontSize: 12, color: 'var(--text-muted, #6B5D54)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  enrollCourse: { fontSize: 11, color: 'var(--accent, #92405e)', fontWeight: 500, marginTop: 2 },
  enrollNotes:  { fontSize: 12, color: 'var(--text-secondary, #574A42)', marginTop: 3, fontStyle: 'italic', lineHeight: 1.4 },
  enrollStatus: { fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 'var(--radius-xs, 6px)', whiteSpace: 'nowrap' },
  dueLabel:     { fontSize: 10.5, color: 'var(--text-muted, #6B5D54)', whiteSpace: 'nowrap' },
  studentActions: { background: 'var(--bg, #FBF6F1)', borderRadius: 10, padding: '10px 10px' },
  studentHint:  { fontSize: 12, color: 'var(--text-secondary, #574A42)', margin: '0 0 8px', lineHeight: 1.45 },
  studentBtns:  { display: 'flex', flexWrap: 'wrap', gap: 6 },

  empty:        { textAlign: 'center', padding: '40px 20px' },
  emptyIcon:    { fontSize: 40, marginBottom: 12, color: 'var(--accent, #92405e)' },
  emptyTitle:   { fontSize: 16, fontWeight: 700, color: 'var(--text-primary, #241B17)', marginBottom: 6 },
  emptyText:    { fontSize: 13, color: 'var(--text-muted, #6B5D54)', lineHeight: 1.6, maxWidth: 300, margin: '0 auto' },
};
