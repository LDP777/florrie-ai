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
import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { API_BASE } from '../lib/config.js';
import Icon from '../components/ui/Icon';

const INCLUDES_LABELS = {
  certificate: 'Certificate',
  kit: 'Starter kit',
  manual: 'Course manual',
  lunch: 'Lunch',
  refreshments: 'Refreshments',
  models: 'Live models',
  aftercare: 'Aftercare pack',
};

export default function TrainingBooking() {
  const { slug, courseId } = useParams();
  const [searchParams] = useSearchParams();
  const [course, setCourse] = useState(null);
  const [beautician, setBeautician] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', phone: '', notes: '' });
  const [success, setSuccess] = useState(null);

  // Check for return from Stripe or direct enrollment
  const enrolledParam = searchParams.get('enrolled');
  const cancelledParam = searchParams.get('cancelled');
  const enrolledName = searchParams.get('name');

  useEffect(() => {
    // Back from Stripe with the deposit paid. Still load the course, so the
    // "you're in" screen can say when and where.
    if (enrolledParam === 'true') {
      setSuccess({ type: 'paid', name: enrolledName || 'Student' });
    }

    async function load() {
      try {
        const res = await fetch(`${API_BASE}/api/courses/${slug}/${courseId}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data.error || 'Course not found');
          if (data.course) setCourse({ ...data.course, closed: true });
          if (data.beautician) setBeautician(data.beautician);
          return;
        }
        setCourse(data.course);
        setBeautician(data.beautician);
      } catch (err) {
        setError('Could not load the course. Check your connection and try again.');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [slug, courseId, enrolledParam, enrolledName]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name || !form.email) return;
    setSubmitting(true);
    setError('');

    try {
      const res = await fetch(`${API_BASE}/api/courses/${slug}/${courseId}/enroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, email: form.email.trim().toLowerCase(), name: form.name.trim() }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Enrollment failed');
        setSubmitting(false);
        return;
      }

      // Stripe redirect
      if (data.checkout_url) {
        try {
          const redirectUrl = new URL(data.checkout_url);
          if (redirectUrl.hostname.endsWith('stripe.com')) {
            window.location.href = data.checkout_url;
            return;
          }
        } catch {
          // Fall through
        }
      }

      // Direct confirmation
      setSuccess({
        type: data.deposit_pending ? 'pending' : 'confirmed',
        name: form.name,
        note: data.deposit_note,
      });
    } catch (err) {
      setError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const brandColor = beautician?.brand_color || '#92405e';

  const formatDate = (d) => {
    if (!d) return 'Date to be confirmed';
    if (course?.date_label && d === course.date) return course.date_label;
    return new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
  };
  const whenLine = course ? `${formatDate(course.date)}${course.start_time ? `, ${course.start_time} start` : ''}` : '';

  if (loading) {
    return (
      <div style={styles.page}>
        <div style={styles.loadingWrap}>
          <div style={styles.spinner} />
          <p style={styles.loadingText}>Loading course...</p>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div style={styles.page}>
        <div style={styles.successCard}>
          <div style={styles.successIcon}>
            <Icon name={success.type === 'paid' ? 'sparkles' : success.type === 'pending' ? 'clock' : 'check-circle'} size={44} color={brandColor} />
          </div>
          <h2 style={styles.successTitle}>
            {success.type === 'paid'
              ? 'You\'re in!'
              : success.type === 'pending'
                ? 'Almost there'
                : 'You\'re enrolled!'}
          </h2>
          <p style={styles.successText}>
            {success.type === 'paid'
              ? `Thanks ${success.name} - your deposit is paid and your spot is secured.`
              : success.type === 'pending'
                ? success.note || `We've reserved your spot. Your trainer will be in touch to arrange payment.`
                : `Thanks ${success.name} - you're all signed up. See you there!`}
          </p>
          {course && (
            <div style={styles.successMeta}>
              <p style={{ margin: '4px 0', fontWeight: 600 }}>{course.name}</p>
              <p style={{ margin: '2px 0' }}>{<Icon name="calendar" inline />} {whenLine}</p>
              {course.location && <p style={{ margin: '2px 0' }}>{<Icon name="map-pin" inline />} {course.location}</p>}
              <p style={{ margin: '8px 0 0', fontSize: 12, color: '#6B6560' }}>The details and a calendar file are on their way to your email.</p>
            </div>
          )}
        </div>
        <p style={styles.poweredBy}>Powered by <strong>florrie.ai</strong></p>
      </div>
    );
  }

  if (error && (!course || course.closed)) {
    return (
      <div style={styles.page}>
        <div style={styles.errorCard}>
          <div style={{ fontSize: 32, marginBottom: 8 }}><Icon name="alert-triangle" size={32} /></div>
          <h2 style={{ fontSize: 18, margin: '0 0 8px' }}>{course?.name || 'Course not available'}</h2>
          <p style={styles.errorText}>{error}</p>
          {beautician && <p style={styles.errorText}>Message {beautician.business_name || beautician.first_name} to hear about the next date.</p>}
        </div>
        <p style={styles.poweredBy}>Powered by <strong>florrie.ai</strong></p>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      {/* Beautician header */}
      <div style={styles.trainerHeader}>
        {beautician?.avatar_url && (
          <img src={beautician.avatar_url} alt="" style={styles.trainerAvatar} />
        )}
        <div>
          <div style={styles.trainerName}>{beautician?.business_name || beautician?.first_name}</div>
          <div style={styles.trainerSub}>Training course</div>
        </div>
      </div>

      {/* Course card */}
      <div style={styles.courseCard}>
        <h1 style={styles.courseName}>{course.name}</h1>

        {/* Details row */}
        <div style={styles.detailsGrid}>
          <div style={styles.detailItem}>
            <span style={styles.detailIcon}><Icon name="calendar" size={15} /></span>
            <span style={styles.detailText}>{whenLine}</span>
          </div>
          {course.location && (
            <div style={styles.detailItem}>
              <span style={styles.detailIcon}><Icon name="map-pin" size={15} /></span>
              <span style={styles.detailText}>{course.location}</span>
            </div>
          )}
          {course.duration && (
            <div style={styles.detailItem}>
              <span style={styles.detailIcon}>{<Icon name="clock" inline />}</span>
              <span style={styles.detailText}>{course.duration}</span>
            </div>
          )}
          <div style={styles.detailItem}>
            <span style={styles.detailIcon}><Icon name="users" size={15} /></span>
            <span style={styles.detailText}>
              {course.is_full
                ? 'Fully booked'
                : `${course.spots_left} place${course.spots_left !== 1 ? 's' : ''} left`}
            </span>
          </div>
        </div>

        {course.description && (
          <p style={styles.courseDesc}>{course.description}</p>
        )}

        {/* Includes */}
        {course.includes?.length > 0 && (
          <div style={styles.includesSection}>
            <h3 style={styles.includesTitle}>What's included</h3>
            <div style={styles.includesWrap}>
              {course.includes.map(key => (
                <span key={key} style={styles.includeTag}>
                  {INCLUDES_LABELS[key] || key}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Price */}
        <div style={styles.priceSection}>
          <div style={{ ...styles.priceMain, color: brandColor }}>£{Number(course.price).toFixed(0)}</div>
          {Number(course.deposit) > 0 && (
            <div style={styles.priceDeposit}>
              £{Number(course.deposit).toFixed(0)} deposit to secure your spot
            </div>
          )}
        </div>
      </div>

      {cancelledParam && (
        <div style={styles.cancelledBanner}>
          The card payment was cancelled, so your place is not booked yet. Fill in your details again to try once more.
        </div>
      )}

      {/* Enrollment form */}
      {course.is_full ? (
        <div style={styles.fullBanner}>
          <span style={{ fontSize: 20 }}>{<Icon name="alert-triangle" inline />}</span>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15 }}>This course is full</div>
            <div style={{ fontSize: 13, color: '#6B6560', marginTop: 2 }}>
              Message {beautician?.business_name || beautician?.first_name} to hear about the next date.
            </div>
          </div>
        </div>
      ) : (
        <div style={styles.formCard}>
          <h2 style={styles.formTitle}>Book your spot</h2>
          <form onSubmit={handleSubmit}>
            <label style={styles.label}>Full name *</label>
            <input
              type="text"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="Your name"
              style={styles.input}
              required
            />

            <label style={styles.label}>Email *</label>
            <input
              type="email"
              value={form.email}
              onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
              placeholder="you@email.com"
              style={styles.input}
              required
            />

            <label style={styles.label}>Phone (optional)</label>
            <input
              type="tel"
              value={form.phone}
              onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
              placeholder="07..."
              style={styles.input}
            />

            <label style={styles.label}>Any questions or requirements?</label>
            <textarea
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              placeholder="e.g. allergies, accessibility needs, experience level..."
              style={{ ...styles.input, height: 70, resize: 'vertical' }}
            />

            {error && (
              <div style={styles.errorBanner}>{error}</div>
            )}

            <button
              type="submit"
              disabled={submitting || !form.name || !form.email}
              style={{ ...styles.submitBtn,
                background: brandColor,
                opacity: submitting || !form.name || !form.email ? 0.5 : 1,
              }}
            >
              {submitting
                ? 'Booking your place...'
                : Number(course.deposit) > 0
                  ? (beautician?.stripe_ready ? `Book my place, pay £${Number(course.deposit).toFixed(0)} deposit` : 'Book my place')
                  : 'Book my place'}
            </button>

            <p style={styles.depositNote}>
              {Number(course.deposit) > 0
                ? `£${(Number(course.price) - Number(course.deposit)).toFixed(0)} is due on the day.${beautician?.stripe_ready ? '' : ` ${beautician?.business_name || beautician?.first_name || 'Your trainer'} will be in touch to arrange the deposit.`}`
                : `£${Number(course.price).toFixed(0)} is due on the day.`}
              {' '}You will get a confirmation by email.
            </p>
            <p style={styles.privacyNote}>
              Your details go to {beautician?.business_name || beautician?.first_name || 'the trainer'} so they can run the course and contact you about it. See our <a href="/privacy" style={styles.privacyLink} target="_blank" rel="noopener noreferrer">Privacy Policy</a>.
            </p>
          </form>
        </div>
      )}

      <p style={styles.poweredBy}>Powered by <strong>florrie.ai</strong></p>
    </div>
  );
}

const styles = {
  page: {
    minHeight: 'var(--shell-viewport)',
    background: '#FBF6F1',
    fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif",
    padding: '20px 16px 40px',
    maxWidth: 480,
    margin: '0 auto',
  },
  loadingWrap: { textAlign: 'center', padding: '80px 0' },
  spinner: { width: 32, height: 32, border: '3px solid #E8E4E0', borderTopColor: '#92405e', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 12px' },
  loadingText: { fontSize: 14, color: 'var(--text-muted)' },

  trainerHeader: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 },
  trainerAvatar: { width: 44, height: 44, borderRadius: 22, objectFit: 'cover' },
  trainerName: { fontSize: 16, fontWeight: 700, color: '#1d1b19' },
  trainerSub: { fontSize: 12, color: 'var(--text-muted)' },

  courseCard: { background: '#ffffff', borderRadius: 16, padding: 20, marginBottom: 16, border: '1px solid #efe2e5' },
  courseName: { fontSize: 22, fontWeight: 700, color: '#1d1b19', margin: '0 0 16px' },

  detailsGrid: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 },
  detailItem: { display: 'flex', alignItems: 'center', gap: 8 },
  detailIcon: { fontSize: 16, width: 24, textAlign: 'center' },
  detailText: { fontSize: 14, color: '#4A4540' },

  courseDesc: { fontSize: 14, color: '#6B6560', lineHeight: 1.6, margin: '0 0 16px' },

  includesSection: { marginBottom: 16, paddingTop: 16, borderTop: '1px solid #F0ECE8' },
  includesTitle: { fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', margin: '0 0 8px', textTransform: 'uppercase', letterSpacing: '0.04em' },
  includesWrap: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  includeTag: { fontSize: 13, background: '#FBF6F1', border: '1px solid #efe2e5', borderRadius: 10, padding: '5px 10px', color: '#4A4540' },

  priceSection: { paddingTop: 16, borderTop: '1px solid #F0ECE8', textAlign: 'center' },
  priceMain: { fontSize: 28, fontWeight: 700, color: '#92405e' },
  priceDeposit: { fontSize: 13, color: '#6B6560', marginTop: 4 },

  formCard: { background: '#ffffff', borderRadius: 16, padding: 20, marginBottom: 16, border: '1px solid #efe2e5' },
  formTitle: { fontSize: 18, fontWeight: 700, color: '#1d1b19', margin: '0 0 16px' },
  label: { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6, marginTop: 14, textTransform: 'uppercase', letterSpacing: '0.04em' },
  input: { width: '100%', padding: '11px 14px', borderRadius: 10, border: '1.5px solid #efe2e5', fontSize: 15, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', background: '#FBF6F1', color: '#1d1b19' },

  submitBtn: { width: '100%', padding: '15px 0', borderRadius: 10, border: 'none', color: '#fff', fontSize: 16, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', marginTop: 20 },
  depositNote: { fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', marginTop: 10, lineHeight: 1.5 },
  privacyNote: { fontSize: 11, color: '#9C9690', textAlign: 'center', marginTop: 8, lineHeight: 1.5 },
  privacyLink: { color: '#9C9690', textDecoration: 'underline' },

  errorBanner: { background: '#FDEDF0', color: '#C62828', padding: '10px 14px', borderRadius: 10, fontSize: 13, marginTop: 12, fontWeight: 500 },
  cancelledBanner: { background: '#FFF3E0', color: '#B33F00', padding: '10px 14px', borderRadius: 10, fontSize: 13, fontWeight: 500, marginBottom: 16, textAlign: 'center' },

  fullBanner: { display: 'flex', alignItems: 'center', gap: 12, background: '#FFF3E0', borderRadius: 10, padding: '16px 14px', marginBottom: 16 },

  successCard: { background: '#ffffff', borderRadius: 16, padding: '40px 20px', textAlign: 'center', border: '1px solid #efe2e5', marginTop: 40 },
  successIcon: { fontSize: 48, marginBottom: 12 },
  successTitle: { fontSize: 22, fontWeight: 700, color: '#1d1b19', margin: '0 0 8px' },
  successText: { fontSize: 14, color: '#6B6560', lineHeight: 1.6, margin: '0 0 16px' },
  successMeta: { fontSize: 13, color: '#4A4540', background: '#FBF6F1', borderRadius: 10, padding: 12, display: 'inline-block' },

  errorCard: { background: '#ffffff', borderRadius: 16, padding: '40px 20px', textAlign: 'center', border: '1px solid #efe2e5', marginTop: 40 },
  errorText: { fontSize: 14, color: '#6B6560', lineHeight: 1.5 },

  poweredBy: { textAlign: 'center', fontSize: 11, color: '#CCC', marginTop: 24 },
};
