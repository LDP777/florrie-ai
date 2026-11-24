/**
 * TrainingBooking - Public course enrollment page.
 * URL: /training/:slug/:courseId
 *
 * Loads course details from the API, shows course info, and lets students
 * enroll with optional Stripe deposit checkout.
 *
 * 3 September 2026: the success screen printed the words "sparkles" and
 * "clock" where an icon should have been, forgot the course details after a
 * card payment (it skipped the load), and put the "payment cancelled" notice
 * under the form where nobody returning from Stripe would see it. A course
 * with no date said nothing; a closed course was a 404. All fixed here.
 */
import { useState, useEffect, useRef } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { API_BASE } from '../lib/config.js';
import Icon from '../components/ui/Icon';
import Button from '../components/ui/Button.jsx';
import CourseDescription from '../components/CourseDescription.jsx';
import { TrainingHeader, TrainingFooter, TrainingDateStamp, trainingTheme } from '../components/TrainingPublic.jsx';

const INCLUDES_LABELS = {
  certificate: 'Certificate',
  kit: 'Starter kit',
  manual: 'Course manual',
  lunch: 'Lunch',
  refreshments: 'Refreshments',
  models: 'Live models',
  aftercare: 'Aftercare pack',
};

function savedRequest(slug, dateId) {
  try {
    const previous = JSON.parse(sessionStorage.getItem(`florrie:training-checkout:${slug}:${dateId}`) || 'null');
    if (previous && typeof previous.name === 'string' && typeof previous.email === 'string'
      && /^[0-9a-f-]{36}$/i.test(previous.id || '') && Number.isFinite(previous.createdAt)
      && Date.now() >= previous.createdAt && Date.now() - previous.createdAt < 20 * 60 * 60 * 1000) return previous;
  } catch { /* A fresh form still works when browser storage is unavailable. */ }
  return null;
}

export default function TrainingBooking() {
  const { slug, courseId } = useParams();
  const [searchParams] = useSearchParams();
  const [baseCourse, setBaseCourse] = useState(null);
  const [dates, setDates] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [resumeRequest, setResumeRequest] = useState(null);
  const [beautician, setBeautician] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', phone: '', notes: '' });
  const [success, setSuccess] = useState(null);
  const [retry, setRetry] = useState(0);
  const [loadedKey, setLoadedKey] = useState('');
  const currentKey = `${slug}/${courseId}`;
  const routeRef = useRef(currentKey);
  routeRef.current = currentKey;
  const submitRef = useRef(null);
  const requestRef = useRef({ key: '', id: '' });

  const enrolledParam = searchParams.get('enrolled');
  const cancelledParam = searchParams.get('cancelled');
  const enrolledName = searchParams.get('name');

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let active = true;
    setLoading(true);
    setError('');
    setSuccess(null);
    setSelectedId('');
    setResumeRequest(null);
    setBaseCourse(null);
    setBeautician(null);
    setDates([]);
    setSubmitting(false);
    submitRef.current?.abort();
    submitRef.current = null;
    async function load() {
      try {
        let res = await fetch(`${API_BASE}/api/courses/${slug}/${courseId}`, { signal: controller.signal });
        let data = await res.json().catch(() => ({}));
        const saved = savedRequest(slug, courseId);
        if (!res.ok && saved) {
          res = await fetch(`${API_BASE}/api/courses/${slug}/${courseId}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
            body: JSON.stringify({ request_id: saved.id, name: saved.name, email: saved.email, open_payment: false }) });
          data = await res.json().catch(() => ({}));
        }
        if (!active || routeRef.current !== currentKey) return;
        if (!res.ok) {
          setError(data.error || 'Course not found');
          if (data.course) setBaseCourse({ ...data.course, closed: true });
          if (data.beautician) setBeautician(data.beautician);
          return;
        }
        if (!data.course?.id) throw new Error('Missing course');
        const options = Array.isArray(data.dates) ? data.dates : [data.course];
        setBaseCourse(data.course);
        setDates(options);
        setBeautician(data.beautician);
        const available = options.filter(d => !d.is_full && !d.in_the_past && !d.closed);
        // A shared link requires a choice; a cancelled checkout retains its dated occurrence.
        const returningDate = cancelledParam && available.find(d => d.id === courseId);
        const onlyDate = options.length === 1 && !data.date_selection_required && available[0];
        const held = options.map(option => ({ option, request: savedRequest(slug, option.id) })).find(item => item.request && !item.option.in_the_past && !item.option.closed);
        setSelectedId(held?.option.id || returningDate?.id || onlyDate?.id || '');
        if (held) { setResumeRequest({ ...held.request, courseId: held.option.id }); setForm(previous => ({ ...previous, name: held.request.name, email: held.request.email })); }
        if (data.confirmed === true) { setSuccess({ type: 'confirmed', name: saved?.name || 'Student', course: data.course }); }
        else if (enrolledParam === 'true') {
          // A URL parameter is not proof that Stripe has completed a payment.
          setSuccess({
            type: 'submitted', name: enrolledName || 'Student',
            course: options.find(d => d.id === courseId) || (data.course.id === courseId ? data.course : null),
          });
        }
      } catch {
        if (!active || routeRef.current !== currentKey) return;
        setError('Could not load the course. Check your connection and try again.');
      } finally {
        clearTimeout(timeout);
        if (active && routeRef.current === currentKey) {
          setLoadedKey(currentKey);
          setLoading(false);
        }
      }
    }
    load();
    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
      submitRef.current?.abort();
      submitRef.current = null;
    };
  }, [slug, courseId, enrolledParam, enrolledName, cancelledParam, retry]);

  useEffect(() => { setForm({ name: '', email: '', phone: '', notes: '' }); }, [slug, courseId]);

  const selectedCourse = dates.find(d => d.id === selectedId) || null;
  const course = success ? success.course : selectedCourse || baseCourse;
  const availableDates = dates.filter(d => !d.is_full && !d.in_the_past && !d.closed);
  const canResume = resumeRequest?.courseId === selectedId && resumeRequest.name === form.name.trim() && resumeRequest.email === form.email.trim().toLowerCase();
  const canBook = selectedCourse && (!selectedCourse.is_full || canResume) && !selectedCourse.in_the_past && !selectedCourse.closed;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitRef.current || !form.name.trim() || !form.email.trim() || !canBook || loadedKey !== currentKey) return;
    const chosenCourse = { ...selectedCourse };
    const requestKey = `${slug}|${chosenCourse.id}|${form.name.trim()}|${form.email.trim().toLowerCase()}`;
    if (requestRef.current.key !== requestKey) {
      const storageKey = `florrie:training-checkout:${slug}:${chosenCourse.id}`;
      const previous = savedRequest(slug, chosenCourse.id);
      const reusable = previous?.key === requestKey && typeof previous.id === 'string'
        && /^[0-9a-f-]{36}$/i.test(previous.id) && Date.now() - previous.createdAt < 20 * 60 * 60 * 1000;
      requestRef.current = reusable ? previous : { key: requestKey, id: crypto.randomUUID(), createdAt: Date.now(), name: form.name.trim(), email: form.email.trim().toLowerCase() };
      try { sessionStorage.setItem(storageKey, JSON.stringify(requestRef.current)); } catch { /* In-memory retries still work. */ }
    }
    const controller = new AbortController();
    submitRef.current = controller;
    const key = currentKey;
    const timeout = setTimeout(() => controller.abort(), 20000);
    const isCurrent = () => routeRef.current === key && submitRef.current === controller;
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/api/courses/${slug}/${canResume ? chosenCourse.id : courseId}/${canResume ? 'resume' : 'enroll'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, ...(canResume ? { open_payment: true } : {}), request_id: requestRef.current.id, email: form.email.trim().toLowerCase(), name: form.name.trim(), selected_course_id: chosenCourse.id }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!isCurrent()) return;
      if (!res.ok) {
        if (data.code === 'checkout_expired') {
          try { sessionStorage.removeItem(`florrie:training-checkout:${slug}:${chosenCourse.id}`); } catch {}
          requestRef.current = { key: '', id: '' };
          setResumeRequest(null);
        }
        setError(data.error || 'Enrollment failed'); return;
      }
      if (data.selected_course_id && data.selected_course_id !== chosenCourse.id) {
        setError('We could not confirm your chosen date. Please check with the trainer before trying again.');
        return;
      }
      if (data.checkout_url) {
        try {
          const redirectUrl = new URL(data.checkout_url);
          if (redirectUrl.protocol === 'https:' && (redirectUrl.hostname === 'stripe.com' || redirectUrl.hostname.endsWith('.stripe.com'))) {
            window.location.href = data.checkout_url;
            return;
          }
        } catch { /* Keep the form visible when checkout cannot be opened. */ }
        setError('We could not open the card payment. Please try again or contact the trainer.');
        return;
      }
      if (!data.confirmed) {
        setError('We could not confirm your place. Please check with the trainer before trying again.');
        return;
      }
      setSuccess({
        type: data.deposit_pending ? 'pending' : 'confirmed', name: form.name, note: data.deposit_note,
        course: data.course?.id === chosenCourse.id ? data.course : chosenCourse,
      });
    } catch {
      if (isCurrent()) setError('We could not check whether your booking completed. Check your confirmation email before trying again.');
    } finally {
      clearTimeout(timeout);
      if (isCurrent()) { submitRef.current = null; setSubmitting(false); }
    }
  };

  const theme = trainingTheme(beautician);
  const brandColor = theme['--training-accent'];
  const pricedDates = availableDates.length ? availableDates : dates;
  const priceCourse = selectedCourse || pricedDates[0] || course;
  const pricesVary = !selectedCourse && new Set(pricedDates.map(d => Number(d.price))).size > 1;
  const depositsVary = !selectedCourse && new Set(pricedDates.map(d => Number(d.deposit || 0))).size > 1;

  const formatDate = (d) => {
    if (!d) return 'Date to be confirmed';
    if (course?.date_label && d === course.date) return course.date_label;
    return new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
  };
  const whenLine = course ? `${formatDate(course.date)}${course.start_time ? `, ${course.start_time} start` : ''}` : '';

  const renderState = content => <main className="training-page" style={theme}><div className="training-shell"><TrainingHeader owner={beautician} to={`/training/${slug}`} label="All courses" />{content}<TrainingFooter /></div></main>;

  if (loading || loadedKey !== currentKey) {
    return renderState(
        <div style={styles.loadingWrap} role="status">
          <div style={styles.spinner} />
          <p style={styles.loadingText}>Loading course...</p>
        </div>
    );
  }

  if (success) {
    return renderState(
        <div style={styles.successCard}>
          <div style={styles.successIcon}>
            <Icon name={success.type === 'submitted' || success.type === 'pending' ? 'clock' : 'check-circle'} size={44} color={brandColor} />
          </div>
          <h2 style={styles.successTitle}>
            {success.type === 'submitted'
              ? 'Payment submitted'
              : success.type === 'pending'
                ? 'Almost there'
                : 'You\'re enrolled!'}
          </h2>
          <p style={styles.successText}>
            {success.type === 'submitted'
              ? `Thanks ${success.name}. Check your confirmation email for your booking and payment status. If it has not arrived, contact the trainer before paying again.`
              : success.type === 'pending'
                ? success.note || `We've reserved your spot. Your trainer will be in touch to arrange payment.`
                : `Thanks ${success.name} - you're all signed up. See you there!`}
          </p>
          {course && (
            <div style={styles.successMeta}>
              <p style={{ margin: '4px 0', fontWeight: 600 }}>{course.name}</p>
              <p style={{ margin: '2px 0' }}>{<Icon name="calendar" inline />} {whenLine}</p>
              {course.location && <p style={{ margin: '2px 0' }}>{<Icon name="map-pin" inline />} {course.location}</p>}
              <p style={{ margin: '8px 0 0', fontSize: 12, color: '#6B6560' }}>Check your confirmation email for the details. Contact the trainer if it has not arrived.</p>
            </div>
          )}
        </div>
    );
  }

  if (error && (!course || course.closed)) {
    return renderState(
        <div style={styles.errorCard}>
          <div style={{ fontSize: 32, marginBottom: 8 }}><Icon name="alert-triangle" size={32} /></div>
          <h2 style={{ fontSize: 18, margin: '0 0 8px' }}>{course?.name || 'Course not available'}</h2>
          <p style={styles.errorText}>{error}</p>
          {beautician && <p style={styles.errorText}>Message {beautician.business_name || beautician.first_name} to hear about the next date.</p>}
          <Button fullWidth style={{ marginTop: 20, background: brandColor }} onClick={() => setRetry(n => n + 1)}>Try again</Button>
        </div>
    );
  }

  return (
    <main className="training-page" style={theme}>
      <div className="training-shell">
        <TrainingHeader owner={beautician} to={`/training/${slug}`} label="All courses" />
        <section className="training-overview" aria-labelledby="training-course-title">
          <p className="training-eyebrow">Training course</p>
          <h1 id="training-course-title">{course.name}</h1>
          <ul className="training-meta">
            {course.duration && <li><Icon name="clock" size={15} />{course.duration}</li>}
            {course.location && <li><Icon name="map-pin" size={15} />{course.location}</li>}
          </ul>
          <div className="training-outline">
            <CourseDescription key={course.id} text={course.description} previewLines={4} style={{ margin: '0 0 8px' }} />
          </div>
          {course.includes?.length > 0 && <ul className="training-includes" aria-label="Included in your course">
            {course.includes.map(key => <li key={key}><Icon name="check" size={14} />{INCLUDES_LABELS[key] || key}</li>)}
          </ul>}
          <div className="training-price" aria-live="polite" aria-atomic="true">
            <div className="training-price-total">
              <strong>{pricesVary
                ? `From £${Math.min(...pricedDates.map(d => Number(d.price))).toFixed(2)}`
                : `£${Number(priceCourse.price).toFixed(2)}`}</strong>
              <span>course fee</span>
            </div>
            {depositsVary ? <span>Deposit varies by date</span> : Number(priceCourse.deposit) > 0 && <span>£{Number(priceCourse.deposit).toFixed(2)} deposit</span>}
          </div>
        </section>

        {cancelledParam && <div role="status" style={styles.cancelledBanner}>
          The card payment was cancelled, so your place is not booked yet. Fill in your details again to try once more.
        </div>}
        {resumeRequest && <p role="status" className="training-selected-date">You have a payment in progress for this date. Resume it with the same name and email.</p>}

        <div className="training-booking-grid">
          <section className="training-panel">
            <fieldset className="training-date-choices" disabled={submitting}>
              <legend>{dates.length === 1 && selectedId ? 'Your training date' : 'Choose your training date'}</legend>
              {dates.map(option => {
                const unavailable = (option.is_full && resumeRequest?.courseId !== option.id) || option.in_the_past || option.closed;
                const chosen = option.id === selectedId;
                const singleDate = dates.length === 1 && chosen;
                const DateRow = singleDate ? 'div' : 'label';
                return <DateRow key={option.id} className={`training-date-option${chosen ? ' is-selected' : ''}${unavailable ? ' is-unavailable' : ''}${singleDate ? ' is-single' : ''}`}>
                  <TrainingDateStamp date={option.date} />
                  <span className="training-date-copy">
                    <span className="training-date-name">{option.date_label || formatDate(option.date)}</span>
                    <span className="training-date-meta">
                      {option.start_time ? `${String(option.start_time).slice(0, 5)} start · ` : ''}
                      {option.in_the_past ? 'Date has passed' : option.closed ? 'Bookings closed' : option.is_full
                        ? resumeRequest?.courseId === option.id ? 'Payment in progress' : 'Fully booked'
                        : `${option.spots_left} place${option.spots_left === 1 ? '' : 's'} left`}
                    </span>
                    {(Number(option.price) !== Number(baseCourse.price) || Number(option.deposit || 0) !== Number(baseCourse.deposit || 0)) && <span className="training-date-meta">£{Number(option.price).toFixed(2)} · £{Number(option.deposit || 0).toFixed(2)} deposit</span>}
                  </span>
                  {!singleDate && <input type="radio" name="training-date" value={option.id} checked={chosen}
                    disabled={unavailable} onChange={() => { setSelectedId(option.id); setError(''); }} />}
                </DateRow>;
              })}
            </fieldset>
          </section>

          {!availableDates.length && !resumeRequest ? (
            <div className="training-panel" role="status">
              <h2 className="training-form-title">{dates.length > 0 && dates.every(d => d.is_full) ? 'These course dates are full' : 'No dates are available to book'}</h2>
              <p className="training-outline">Message {beautician?.business_name || beautician?.first_name} to hear about the next date.</p>
            </div>
          ) : (
            <section className="training-panel training-form-panel" aria-labelledby="training-details-title">
              <h2 id="training-details-title" className="training-form-title">Your details</h2>
              <form onSubmit={handleSubmit}>
                <fieldset disabled={submitting} className="training-fields" aria-labelledby="training-details-title">
                  <div className="training-field">
                    <label htmlFor="training-name">Full name</label>
                    <input id="training-name" type="text" autoComplete="name" value={form.name}
                      onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                      placeholder="Your name" className="training-input" required />
                  </div>
                  <div className="training-field">
                    <label htmlFor="training-email">Email</label>
                    <input id="training-email" type="email" autoComplete="email" inputMode="email" value={form.email}
                      onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                      placeholder="you@email.com" className="training-input" required />
                  </div>
                  <details className="training-optional">
                    <summary>Phone or questions (optional)<Icon name="chevron-down" size={15} /></summary>
                    <div className="training-field">
                      <label htmlFor="training-phone">Phone</label>
                      <input id="training-phone" type="tel" autoComplete="tel" value={form.phone}
                        onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                        placeholder="07..." className="training-input" />
                    </div>
                    <div className="training-field">
                      <label htmlFor="training-notes">Any questions or requirements?</label>
                      <textarea id="training-notes" value={form.notes}
                        onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                        placeholder="e.g. allergies, accessibility needs, experience level..." className="training-input" />
                    </div>
                  </details>
                  {error && <div style={styles.errorBanner} role="alert">{error}</div>}
                  <button type="submit" className="training-submit"
                    disabled={submitting || !form.name.trim() || !form.email.trim() || !canBook}>
                    {submitting ? 'Booking your place...'
                      : canResume ? 'Resume payment'
                      : !selectedCourse ? 'Choose a date to book'
                      : Number(course.deposit) > 0 && beautician?.stripe_ready
                        ? `Book my place, pay £${Number(course.deposit).toFixed(2)} deposit`
                        : 'Book my place'}
                  </button>
                  {selectedCourse && <p className="training-payment-note">
                    {Number(course.deposit) > 0
                      ? `£${(Number(course.price) - Number(course.deposit)).toFixed(2)} is due on the day.${beautician?.stripe_ready ? '' : ` ${beautician?.business_name || beautician?.first_name || 'Your trainer'} will be in touch to arrange the deposit.`}`
                      : `£${Number(course.price).toFixed(2)} is due on the day.`}
                    {' '}You will get a confirmation by email.
                  </p>}
                  <p className="training-privacy">
                    Your details are shared with {beautician?.business_name || beautician?.first_name || 'the trainer'} to arrange your course. <a href="/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a>.
                  </p>
                </fieldset>
              </form>
            </section>
          )}
        </div>
        <TrainingFooter />
      </div>
    </main>
  );
}

const styles = {
  loadingWrap: { textAlign: 'center', padding: '80px 0' },
  spinner: { width: 32, height: 32, border: '3px solid #E8E4E0', borderTopColor: '#92405e', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 12px' },
  loadingText: { fontSize: 14, color: 'var(--text-muted)' },
  errorBanner: { background: '#FDEDF0', color: '#C62828', padding: '10px 14px', borderRadius: 10, fontSize: 13, marginTop: 12, fontWeight: 500 },
  cancelledBanner: { background: '#FFF3E0', color: '#B33F00', padding: '10px 14px', borderRadius: 10, fontSize: 13, fontWeight: 500, marginBottom: 16, textAlign: 'center' },
  successCard: { background: '#ffffff', borderRadius: 16, padding: '40px 20px', textAlign: 'center', border: '1px solid #efe2e5', margin: '32px auto 0', maxWidth: 560 },
  successIcon: { fontSize: 48, marginBottom: 12 },
  successTitle: { fontSize: 22, fontWeight: 700, color: '#1d1b19', margin: '0 0 8px' },
  successText: { fontSize: 14, color: '#6B6560', lineHeight: 1.6, margin: '0 0 16px' },
  successMeta: { fontSize: 13, color: '#4A4540', background: '#FBF6F1', borderRadius: 10, padding: 12, display: 'inline-block' },
  errorCard: { background: '#ffffff', borderRadius: 16, padding: '40px 20px', textAlign: 'center', border: '1px solid #efe2e5', margin: '32px auto 0', maxWidth: 560 },
  errorText: { fontSize: 14, color: '#6B6560', lineHeight: 1.5 },
};
