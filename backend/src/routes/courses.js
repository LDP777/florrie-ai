/** Public training catalogue, dated courses and atomic place reservations.
 * Owner date allocation remains in Packages; ordinary diary slots are never offered.
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { reconcileCourseHolds, settleCourseCheckout } from '../services/course-checkout.js';
import Stripe from 'stripe';
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { totalApplicationFee } from '../lib/platform-fees.js';
import { enrollCourseSchema as enrollSchema } from '../lib/schemas.js';
import { hasColumn } from '../lib/schema-probe.js';
import { spotsLeft } from '../lib/course-enrolment.js';
import { formatCourseDate } from '../lib/training-enquiry.js';
import { deliverCourseNotice } from '../services/course-notice-delivery.js';

const router = Router();
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://florrie.ai';

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

/** The course columns the public page is allowed to see, plus start_time when the database has it. */
async function publicCourseColumns() {
  const base = 'id, name, description, date, location, duration, max_students, price, deposit, includes, enrolled, reserved_places, status';
  const [withTime, withGroup] = await Promise.all([
    hasColumn(supabase, 'courses', 'start_time'),
    hasColumn(supabase, 'courses', 'course_group_id'),
  ]);
  return `${base}${withTime ? ', start_time' : ''}${withGroup ? ', course_group_id' : ''}`;
}

function todayInLondon() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function dateStillOpen(course) {
  const today = todayInLondon();
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  return course.status === 'active' && !!course.date && (String(course.date).slice(0, 10) > today || (String(course.date).slice(0, 10) === today && (!course.start_time || String(course.start_time).slice(0, 5) > time)));
}

function publicCourse(course) {
  const left = spotsLeft(course);
  const today = todayInLondon();
  return {
    id: course.id,
    name: course.name,
    description: course.description,
    date: course.date,
    start_time: course.start_time ? String(course.start_time).slice(0, 5) : null,
    date_label: course.date ? formatCourseDate(course.date) : null,
    in_the_past: !!(course.date && String(course.date).slice(0, 10) < today),
    closed: !dateStillOpen(course),
    location: course.location,
    duration: course.duration,
    max_students: course.max_students,
    price: course.price,
    deposit: course.deposit,
    includes: course.includes || [],
    spots_left: left,
    is_full: left <= 0,
  };
}

// Dates are separate occurrences: each keeps its own students, payments and
// capacity. Only the explicit group, scoped to the same trainer, links them.
async function offeredDates(anchor, beauticianId, columns) {
  if (!anchor.course_group_id) return dateStillOpen(anchor) ? [anchor] : [];
  const { data, error } = await supabase.from('courses')
    .select(columns)
    .eq('beautician_id', beauticianId)
    .eq('course_group_id', anchor.course_group_id)
    .eq('status', 'active')
    .order('date', { ascending: true });
  if (error) throw error;
  return (data || []).filter(c => c.date && dateStillOpen(c))
    .sort((a, b) => `${a.date} ${a.start_time || ''}`.localeCompare(`${b.date} ${b.start_time || ''}`));
}

function requiresSelection(anchor, dates) {
  const bookable = dates.filter(c => spotsLeft(c) > 0);
  return bookable.length > 1
    || (bookable.length > 0 && (!dates.some(c => c.id === anchor.id) || spotsLeft(anchor) <= 0));
}

// Reusable salon link. Each course group keeps its anchor as dates fill or pass.
router.get('/:slug', async (req, res) => {
  try {
    const { data: owner, error } = await supabase.from('beauticians')
      .select('id,first_name,business_name,logo_url,avatar_url,brand_color').eq('booking_slug', req.params.slug).single();
    if (error || !owner) return res.status(404).json({ error: 'Trainer not found' });
    let { data: rows, error: courseError } = await supabase.from('courses')
      .select(`${await publicCourseColumns()},created_at`).eq('beautician_id', owner.id).order('created_at', { ascending: true }).order('id', { ascending: true });
    if (courseError) throw courseError;
    try {
      await reconcileCourseHolds(stripe, (rows || []).filter(dateStillOpen).map(c => c.id));
      const refreshed = await supabase.from('courses').select(`${await publicCourseColumns()},created_at`).eq('beautician_id', owner.id).order('created_at', { ascending: true }).order('id', { ascending: true });
      if (!refreshed.error) rows = refreshed.data;
    } catch (err) { logger.warn({ err }, 'Training checkout reconciliation deferred'); }
    const groups = new Map();
    for (const row of rows || []) {
      const key = row.course_group_id || row.id;
      if (!groups.has(key)) groups.set(key, { id: row.id, dates: [] });
      if (dateStillOpen(row)) groups.get(key).dates.push(row);
    }
    const courses = [...groups.values()].filter(g => g.dates.length).map(g => {
      const dates = g.dates.sort((a,b) => `${a.date} ${a.start_time || ''}`.localeCompare(`${b.date} ${b.start_time || ''}`));
      return { id: g.id, name: dates[0].name, description: dates[0].description, dates: dates.map(publicCourse) };
    });
    const { id, ...beautician } = owner;
    res.json({ beautician, courses });
  } catch (err) { logger.error({ err }, 'Training catalogue failed'); res.status(503).json({ error: 'Training dates could not load. Please try again.' }); }
});

// Public: returns course details + beautician branding for the booking page
router.get('/:slug/:courseId', async (req, res) => {
  try {
    const { slug, courseId } = req.params;

    const { data: beautician, error: bErr } = await supabase
      .from('beauticians')
      .select('id, first_name, business_name, avatar_url, brand_color, brand_font, logo_url, stripe_onboarding_complete, stripe_account_id')
      .eq('booking_slug', slug)
      .single();

    if (bErr || !beautician) {
      return res.status(404).json({ error: 'Trainer not found' });
    }

    const columns = await publicCourseColumns();
    const { data: course, error: cErr } = await supabase
      .from('courses')
      .select(columns)
      .eq('id', courseId)
      .eq('beautician_id', beautician.id)
      .single();

    if (cErr || !course) {
      return res.status(404).json({ error: 'Course not found or no longer available' });
    }
    let dates = await offeredDates(course, beautician.id, columns);
    try {
      await reconcileCourseHolds(stripe, dates.map(c => c.id));
      dates = await offeredDates(course, beautician.id, columns);
      const refreshedAnchor = dates.find(d => d.id === course.id);
      if (refreshedAnchor) Object.assign(course, refreshedAnchor);
      if (!course.course_group_id) {
        const refreshed = await supabase.from('courses').select(columns).eq('id', course.id).eq('beautician_id', beautician.id).single();
        if (!refreshed.error) Object.assign(course, refreshed.data);
        dates = dateStillOpen(course) ? [course] : [];
      }
    } catch (err) { logger.warn({ err }, 'Training checkout reconciliation deferred'); }
    if (course.status !== 'active' && !dates.length) {
      // Closed, cancelled or completed. Say which, kindly, rather than 404.
      return res.status(410).json({
        error: course.status === 'cancelled'
          ? 'This course has been cancelled.'
          : 'Bookings for this course are closed.',
        course: { id: course.id, name: course.name, status: course.status },
      });
    }

    const shownCourse = (!dateStillOpen(course) || (course.course_group_id && !course.date)) && dates.length
      ? dates.find(c => spotsLeft(c) > 0) || dates[0] : course;
    res.json({
      course: publicCourse(shownCourse),
      requested_course_id: courseId,
      dates: dates.map(publicCourse),
      date_selection_required: requiresSelection(course, dates),
      beautician: {
        first_name: beautician.first_name,
        business_name: beautician.business_name,
        avatar_url: beautician.avatar_url,
        brand_color: beautician.brand_color,
        brand_font: beautician.brand_font,
        logo_url: beautician.logo_url,
        stripe_ready: !!(beautician.stripe_onboarding_complete && beautician.stripe_account_id),
      },
    });
  } catch (err) {
    logger.error({ err }, 'Failed to load course for public booking');
    res.status(500).json({ error: 'Failed to load course' });
  }
});

// An opaque reservation plus the original identity can resume a held place even
// after the trainer closes new bookings. This route never creates a reservation.
router.post('/:slug/:courseId/resume', async (req, res) => {
  const parsed = enrollSchema.safeParse(req.body);
  if (!parsed.success || !parsed.data.request_id || (req.body.open_payment !== undefined && typeof req.body.open_payment !== 'boolean')) return res.status(400).json({ error: 'Check your booking details and try again.' });
  try {
    const { data: owner, error: ownerError } = await supabase.from('beauticians')
      .select('id,first_name,business_name,logo_url,avatar_url,brand_color,brand_font').eq('booking_slug', req.params.slug).single();
    if (ownerError || !owner) return res.status(404).json({ error: 'Saved booking not found.' });
    const { data: enrollment, error } = await supabase.from('course_enrollments').select('*')
      .eq('request_id', parsed.data.request_id).eq('course_id', req.params.courseId).eq('beautician_id', owner.id)
      .eq('email', parsed.data.email.toLowerCase()).eq('name', parsed.data.name).single();
    if (error || !enrollment) return res.status(404).json({ error: 'Saved booking not found. Use the original name and email.' });
    const found = await supabase.from('courses').select(await publicCourseColumns()).eq('id', enrollment.course_id).eq('beautician_id', owner.id).single();
    if (found.error || !found.data || found.data.status === 'cancelled') return res.status(410).json({ error: 'This course is no longer available. Contact the trainer about your saved booking.' });
    const course = found.data;
    if (enrollment.reservation_status === 'released') return res.status(410).json({ code: 'checkout_expired', error: 'Your previous checkout expired. Choose an available training date.' });
    const { id, ...beautician } = owner;
    if (enrollment.reservation_status === 'confirmed') return res.json({ confirmed: true, selected_course_id: course.id, course: publicCourse(course), beautician });
    if (enrollment.reservation_status !== 'held' || !enrollment.checkout_payload) return res.status(409).json({ error: 'This payment needs a check. Please contact the trainer.' });
    if (req.body.open_payment === true) {
      const session = enrollment.checkout_session_id ? await stripe.checkout.sessions.retrieve(enrollment.checkout_session_id)
        : await stripe.checkout.sessions.create(enrollment.checkout_payload, { idempotencyKey: `course-place-${enrollment.id}` });
      if (session.payment_status === 'paid') { await settleCourseCheckout(session); return res.json({ confirmed: true, selected_course_id: course.id, course: publicCourse(course) }); }
      if (session.status === 'expired') { await settleCourseCheckout(session, { expired: true }); return res.status(410).json({ code: 'checkout_expired', error: 'Your previous checkout expired. Choose an available training date.' }); }
      if (session.status !== 'open' || !session.url) return res.status(409).json({ error: 'This payment has finished or expired. Check your email before trying again.' });
      const attached = await supabase.rpc('attach_course_checkout', { p_id: enrollment.id, p_session: session.id });
      if (attached.error) throw attached.error;
      return res.json({ selected_course_id: course.id, checkout_url: session.url });
    }
    // Full/closed stays true for anonymous visitors; only this verified saved
    // reservation is exposed to its holder as resumable.
    const heldCourse = { ...publicCourse(course), closed: false, is_full: true, can_resume: true };
    return res.json({ course: heldCourse, dates: [heldCourse], beautician, date_selection_required: false });
  } catch (err) { logger.error({ err }, 'Saved course checkout could not resume'); return res.status(503).json({ error: 'We could not check your saved payment. Your place is still held; please try again.' }); }
});

// Public: enrol a student. If deposit > 0 and Stripe is configured, creates a Checkout session.
router.post('/:slug/:courseId/enroll', async (req, res) => {
  try {
    const { slug, courseId: requestedCourseId } = req.params;
    let courseId = requestedCourseId;
    const parsed = enrollSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Validation failed' });
    }
    const { name, phone, notes } = parsed.data;
    const email = String(parsed.data.email || '').trim().toLowerCase();

    const { data: beautician, error: bErr } = await supabase
      .from('beauticians')
      .select('id, first_name, business_name, email, phone, stripe_account_id, stripe_onboarding_complete, booking_slug')
      .eq('booking_slug', slug)
      .single();

    if (bErr || !beautician) {
      return res.status(404).json({ error: 'Trainer not found' });
    }

    const columns = await publicCourseColumns();
    const { data: anchor, error: cErr } = await supabase
      .from('courses')
      .select(columns)
      .eq('id', courseId)
      .eq('beautician_id', beautician.id)
      .single();

    if (cErr || !anchor) {
      return res.status(404).json({ error: 'Course not found or no longer available' });
    }
    const dates = await offeredDates(anchor, beautician.id, columns);
    let course = anchor;
    if (parsed.data.selected_course_id && parsed.data.selected_course_id !== anchor.id) {
      // Only advertised occurrences from this trainer's explicit group may
      // be chosen. Never accept another similarly named course or salon.
      course = dates.find(c => c.id === parsed.data.selected_course_id);
      if (!course || !anchor.course_group_id) {
        return res.status(400).json({ error: 'That date is not available for this course. Please choose an offered date.' });
      }
    } else if (!parsed.data.selected_course_id && requiresSelection(anchor, dates)) {
      return res.status(400).json({ error: 'Please choose a course date before booking.' });
    }
    courseId = course.id;
    if (anchor.course_group_id && !course.date) {
      return res.status(400).json({ error: 'Please choose an offered course date before booking.' });
    }
    if (course.status !== 'active') {
      return res.status(404).json({ error: 'Course not found or no longer available' });
    }
    if (course.date && String(course.date).slice(0, 10) < todayInLondon()) {
      return res.status(410).json({ error: 'This course date has passed. Message the trainer about the next one.' });
    }

    if (!dateStillOpen(course)) return res.status(410).json({ error: 'Choose one of the training dates the trainer has opened.' });
    await reconcileCourseHolds(stripe, [courseId]);

    const depositAmount = Number(course.deposit) || 0;
    const depositCents = Math.round(depositAmount * 100);
    const stripeReady = !!(beautician.stripe_account_id && beautician.stripe_onboarding_complete);
    const willTakePayment = depositCents > 0 && !!stripe && stripeReady;
    const needsPayment = depositCents > 0;
    const requestId = parsed.data.request_id || randomUUID();
    const metadata = { course_price_cents: String(Math.round(Number(course.price || 0) * 100)), enrollment_id: requestId, course_id: courseId, beautician_id: beautician.id, type: 'course_deposit' };
    const courseDate = formatCourseDate(course.date);
    const checkoutPayload = willTakePayment ? {
      mode: 'payment', customer_email: email,
      expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
      line_items: [{ price_data: { currency: 'gbp', product_data: {
        name: `${course.name} deposit`, description: `${courseDate} with ${beautician.business_name || beautician.first_name}`,
      }, unit_amount: depositCents }, quantity: 1 }],
      payment_intent_data: { application_fee_amount: totalApplicationFee(depositCents),
        transfer_data: { destination: beautician.stripe_account_id }, metadata },
      success_url: `${FRONTEND_URL}/training/${slug}/${courseId}?enrolled=true`,
      cancel_url: `${FRONTEND_URL}/training/${slug}/${courseId}?cancelled=true`, metadata,
    } : null;
    const { data: enrollment, error: reserveError } = await supabase.rpc('reserve_course_place', {
      p_id: requestId, p_owner: beautician.id, p_course: courseId, p_name: name,
      p_email: email, p_phone: phone || null, p_notes: notes || null, p_checkout: checkoutPayload,
    });
    if (reserveError) {
      const expected = ['P0001', '23505', '22023', 'P0002'].includes(reserveError.code);
      if (!expected) logger.error({ err: reserveError }, 'Course reservation unavailable');
      return res.status(expected ? 409 : 503).json({ error: expected ? reserveError.message : 'We could not reserve a place. Please try again shortly.' });
    }
    if (enrollment.reservation_status === 'released') return res.status(409).json({ code: 'checkout_expired', error: 'Your previous checkout expired. Choose an available date and try again.' });
    if (enrollment.reservation_status === 'held') {
      try {
        const session = enrollment.checkout_session_id
          ? await stripe.checkout.sessions.retrieve(enrollment.checkout_session_id)
          : await stripe.checkout.sessions.create(enrollment.checkout_payload, { idempotencyKey: `course-place-${enrollment.id}` });
        if (session.status !== 'open' || !session.url) return res.status(409).json({ error: 'This payment has already finished or expired. Check your email before trying again.' });
        const attached = await supabase.rpc('attach_course_checkout', { p_id: enrollment.id, p_session: session.id });
        if (attached.error) throw attached.error;
        return res.status(201).json({ enrollment: { id: enrollment.id, name, email }, selected_course_id: courseId, course: publicCourse(course), checkout_url: session.url });
      } catch (err) {
        logger.error({ err, enrollmentId: enrollment.id }, 'Course checkout could not be opened');
        return res.status(503).json({ error: 'We could not open payment. Your place is held while we check it. Try again here; please do not start a second booking.' });
      }
    }
    // The atomic insert owns the count. No read-then-write increments.
    deliverCourseNotice(enrollment.id).catch(err => logger.warn({ err, enrollmentId: enrollment.id }, 'Training confirmation remains queued'));

    const trainerName = beautician.business_name || beautician.first_name;
    const paymentNote = needsPayment
      ? `A deposit of £${depositAmount.toFixed(2)} secures your place. ${trainerName} will be in touch to arrange it.`
      : null;

    return res.status(201).json({
      enrollment: { id: enrollment.id, name, email },
      selected_course_id: courseId,
      course: publicCourse(course),
      confirmed: true,
      deposit_pending: needsPayment && enrollment.payment_status === 'unpaid',
      deposit_note: enrollment.payment_status === 'unpaid' ? paymentNote : null,
    });
  } catch (err) {
    logger.error({ err }, 'Course enrollment failed');
    res.status(500).json({ error: 'Enrollment failed. Please try again.' });
  }
});

export default router;
