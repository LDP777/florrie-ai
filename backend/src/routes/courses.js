/**
 * Courses: public booking + enrolment for training courses.
 *
 * Public endpoints:
 *   GET  /api/courses/:slug/:courseId          course details for the public booking page
 *   POST /api/courses/:slug/:courseId/enroll   enrol a student (with optional Stripe deposit)
 *
 * The beautician's own CRUD is handled by Supabase client-side in Packages.jsx.
 *
 * What "perfect" had to mean here, 3 September 2026, after Ellie built her
 * first course in the app:
 *
 *   - A student who started a deposit checkout and closed the tab could never
 *     try again: the duplicate check saw her `unpaid` row and said "already
 *     enrolled". Now that row is reused and a fresh checkout opened.
 *   - Nobody was told. Not Ellie (no push), not the student (no email, no
 *     calendar file). services/course-notifications.js does both, once.
 *   - A course with a date but no time told nobody when to turn up. The
 *     optional `start_time` column (migration 029) is read when it exists.
 *   - Email casing: Gmail addresses typed with a capital letter made a second
 *     enrolment. Normalised on the way in.
 */
import { Router } from 'express';
import Stripe from 'stripe';
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { totalApplicationFee } from '../lib/platform-fees.js';
import { enrollCourseSchema as enrollSchema } from '../lib/schemas.js';
import { hasColumn } from '../lib/schema-probe.js';
import { checkoutAbandoned, holdsAPlace, spotsLeft, CHECKOUT_PREFIX } from '../lib/course-enrolment.js';
import { formatCourseDate } from '../lib/training-enquiry.js';
import { announceEnrolment } from '../services/course-notifications.js';

const router = Router();
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://florrie.ai';

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

/** The course columns the public page is allowed to see, plus start_time when the database has it. */
async function publicCourseColumns() {
  const base = 'id, name, description, date, location, duration, max_students, price, deposit, includes, enrolled, status';
  return (await hasColumn(supabase, 'courses', 'start_time')) ? `${base}, start_time` : base;
}

function publicCourse(course) {
  const left = spotsLeft(course);
  const today = new Date().toISOString().slice(0, 10);
  return {
    id: course.id,
    name: course.name,
    description: course.description,
    date: course.date,
    start_time: course.start_time ? String(course.start_time).slice(0, 5) : null,
    date_label: course.date ? formatCourseDate(course.date) : null,
    in_the_past: !!(course.date && String(course.date).slice(0, 10) < today),
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

    const { data: course, error: cErr } = await supabase
      .from('courses')
      .select(await publicCourseColumns())
      .eq('id', courseId)
      .eq('beautician_id', beautician.id)
      .single();

    if (cErr || !course) {
      return res.status(404).json({ error: 'Course not found or no longer available' });
    }
    if (course.status !== 'active') {
      // Closed, cancelled or completed. Say which, kindly, rather than 404.
      return res.status(410).json({
        error: course.status === 'cancelled'
          ? 'This course has been cancelled.'
          : 'Bookings for this course are closed.',
        course: { id: course.id, name: course.name, status: course.status },
      });
    }

    res.json({
      course: publicCourse(course),
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

// Public: enrol a student. If deposit > 0 and Stripe is configured, creates a Checkout session.
router.post('/:slug/:courseId/enroll', async (req, res) => {
  try {
    const { slug, courseId } = req.params;
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

    const { data: course, error: cErr } = await supabase
      .from('courses')
      .select(await publicCourseColumns())
      .eq('id', courseId)
      .eq('beautician_id', beautician.id)
      .single();

    if (cErr || !course || course.status !== 'active') {
      return res.status(404).json({ error: 'Course not found or no longer available' });
    }
    if (course.date && String(course.date).slice(0, 10) < new Date().toISOString().slice(0, 10)) {
      return res.status(410).json({ error: 'This course date has passed. Message the trainer about the next one.' });
    }

    if (spotsLeft(course) <= 0) {
      return res.status(409).json({ error: 'This course is fully booked' });
    }

    // The same person again. A finished checkout (deposit or paid), or a
    // no-deposit enrolment, really is a duplicate. A checkout that was opened
    // and abandoned is not: reuse the row and open a fresh session.
    let enrollment = null;
    if (email) {
      // Matched in code, case-insensitively. ilike would treat the underscore
      // in jo_smith@ as a wildcard; eq would miss a row saved with a capital.
      const { data: sameCourse } = await supabase
        .from('course_enrollments')
        .select('*')
        .eq('course_id', courseId)
        .order('created_at', { ascending: false });
      const existing = (sameCourse || []).filter(r => String(r.email || '').trim().toLowerCase() === email);
      const live = existing.find(holdsAPlace);
      if (live) {
        return res.status(409).json({ error: 'You are already booked onto this course. Check your email for the details, or message the trainer.' });
      }
      const abandoned = existing.find(checkoutAbandoned);
      if (abandoned) {
        const { data: refreshed } = await supabase
          .from('course_enrollments')
          // Clear the old checkout reference: if this attempt ends up on the
          // arrange-it-later path the row must read as holding a place.
          .update({ name, phone: phone || null, notes: notes || null, stripe_payment_intent_id: null })
          .eq('id', abandoned.id)
          .select()
          .single();
        enrollment = refreshed || abandoned;
      }
    }

    if (!enrollment) {
      const { data: created, error: eErr } = await supabase
        .from('course_enrollments')
        .insert({
          beautician_id: beautician.id,
          course_id: courseId,
          name,
          email,
          phone: phone || null,
          notes: notes || null,
          payment_status: 'unpaid',
          amount_paid_cents: 0,
        })
        .select()
        .single();
      if (eErr) {
        logger.error({ err: eErr }, 'Failed to create course enrollment');
        return res.status(500).json({ error: 'Failed to enroll' });
      }
      enrollment = created;
    }

    const depositAmount = Number(course.deposit) || 0;
    const depositCents = Math.round(depositAmount * 100);
    const stripeReady = !!(beautician.stripe_account_id && beautician.stripe_onboarding_complete);
    const willTakePayment = depositCents > 0 && !!stripe && stripeReady;
    const needsPayment = depositCents > 0;

    // Count the spot straight away ONLY when no live payment is pending. When
    // we hand off to Stripe Checkout the webhook owns the count, so an
    // abandoned checkout never permanently eats a place.
    const countTheSpot = async () => {
      await supabase
        .from('courses')
        .update({ enrolled: (course.enrolled || 0) + 1 })
        .eq('id', courseId);
    };

    if (willTakePayment) {
      try {
        const platformFee = totalApplicationFee(depositCents);
        const courseDate = course.date ? formatCourseDate(course.date) : '';

        const session = await stripe.checkout.sessions.create({
          mode: 'payment',
          customer_email: email,
          line_items: [{
            price_data: {
              currency: 'gbp',
              product_data: {
                name: `${course.name} deposit`,
                description: courseDate
                  ? `${courseDate} with ${beautician.business_name || beautician.first_name}`
                  : `Training with ${beautician.business_name || beautician.first_name}`,
              },
              unit_amount: depositCents,
            },
            quantity: 1,
          }],
          payment_intent_data: {
            application_fee_amount: platformFee,
            transfer_data: { destination: beautician.stripe_account_id },
            metadata: { enrollment_id: enrollment.id, course_id: courseId, beautician_id: beautician.id, type: 'course_deposit' },
          },
          success_url: `${FRONTEND_URL}/training/${slug}/${courseId}?enrolled=true&name=${encodeURIComponent(name)}`,
          cancel_url: `${FRONTEND_URL}/training/${slug}/${courseId}?cancelled=true`,
          metadata: { enrollment_id: enrollment.id, course_id: courseId, beautician_id: beautician.id, type: 'course_deposit' },
        });

        // Remember that a checkout was opened, so an abandoned one can be told
        // apart from a student paying by bank transfer (lib/course-enrolment.js).
        // The webhook replaces this with the payment intent when the money lands.
        if (String(session.id || '').startsWith(CHECKOUT_PREFIX)) {
          await supabase.from('course_enrollments')
            .update({ stripe_payment_intent_id: session.id })
            .eq('id', enrollment.id);
        }

        return res.status(201).json({
          enrollment: { id: enrollment.id, name, email },
          checkout_url: session.url,
        });
      } catch (stripeErr) {
        logger.error({ err: stripeErr }, 'Stripe checkout creation failed for course enrollment');
        // Checkout never started, so the webhook will not run. Fall through to
        // the arrange-payment-later path below, which counts the spot.
      }
    }

    await countTheSpot();
    // Told once, here, because this is the moment the place is really held.
    // The Stripe path announces from the webhook instead.
    announceEnrolment({ beautician, course, enrollment, paid: 'unpaid' }).catch(() => {});

    const trainerName = beautician.business_name || beautician.first_name;
    const paymentNote = needsPayment
      ? `A deposit of £${depositAmount.toFixed(2)} secures your place. ${trainerName} will be in touch to arrange it.`
      : null;

    return res.status(201).json({
      enrollment: { id: enrollment.id, name, email },
      confirmed: true,
      deposit_pending: needsPayment,
      deposit_note: paymentNote,
    });
  } catch (err) {
    logger.error({ err }, 'Course enrollment failed');
    res.status(500).json({ error: 'Enrollment failed. Please try again.' });
  }
});

export default router;
