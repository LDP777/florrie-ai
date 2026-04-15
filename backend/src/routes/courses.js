/**
 * Courses — public booking + enrollment for training courses.
 *
 * Public endpoints:
 *   GET  /api/courses/:slug/:courseId  — load course details for public booking page
 *   POST /api/courses/:slug/:courseId/enroll — enroll a student (with optional Stripe deposit)
 *
 * The beautician's own CRUD is handled by Supabase client-side in Packages.jsx.
 */
import { Router } from 'express';
import { z } from 'zod';
import Stripe from 'stripe';
import { supabase } from '../index.js';
import logger from '../lib/logger.js';
import { calculatePlatformFee } from '../lib/platform-fees.js';

const router = Router();
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://florrie.ai';

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const enrollSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200).trim(),
  email: z.string().email('Valid email required').max(200).trim(),
  phone: z.string().min(5).max(30).trim().optional().default(''),
  notes: z.string().max(2000).optional().default(''),
});

// ─── GET /api/courses/:slug/:courseId ─────────────────────
// Public: returns course details + beautician branding for the booking page
router.get('/:slug/:courseId', async (req, res) => {
  try {
    const { slug, courseId } = req.params;

    // Find beautician by booking slug
    const { data: beautician, error: bErr } = await supabase
      .from('beauticians')
      .select('id, first_name, business_name, avatar_url, brand_color, brand_font, logo_url, stripe_onboarding_complete, stripe_account_id')
      .eq('booking_slug', slug)
      .single();

    if (bErr || !beautician) {
      return res.status(404).json({ error: 'Beautician not found' });
    }

    // Find course
    const { data: course, error: cErr } = await supabase
      .from('courses')
      .select('*')
      .eq('id', courseId)
      .eq('beautician_id', beautician.id)
      .eq('status', 'active')
      .single();

    if (cErr || !course) {
      return res.status(404).json({ error: 'Course not found or no longer available' });
    }

    const spotsLeft = (course.max_students || 0) - (course.enrolled || 0);

    res.json({
      course: {
        id: course.id,
        name: course.name,
        description: course.description,
        date: course.date,
        location: course.location,
        duration: course.duration,
        max_students: course.max_students,
        price: course.price,
        deposit: course.deposit,
        includes: course.includes || [],
        spots_left: spotsLeft,
        is_full: spotsLeft <= 0,
      },
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

// ─── POST /api/courses/:slug/:courseId/enroll ─────────────
// Public: enroll a student. If deposit > 0 and Stripe is configured, creates Checkout session.
router.post('/:slug/:courseId/enroll', async (req, res) => {
  try {
    const { slug, courseId } = req.params;
    const parsed = enrollSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Validation failed' });
    }
    const { name, email, phone, notes } = parsed.data;

    // Find beautician
    const { data: beautician, error: bErr } = await supabase
      .from('beauticians')
      .select('id, first_name, business_name, stripe_account_id, stripe_onboarding_complete, booking_slug')
      .eq('booking_slug', slug)
      .single();

    if (bErr || !beautician) {
      return res.status(404).json({ error: 'Beautician not found' });
    }

    // Find course
    const { data: course, error: cErr } = await supabase
      .from('courses')
      .select('*')
      .eq('id', courseId)
      .eq('beautician_id', beautician.id)
      .eq('status', 'active')
      .single();

    if (cErr || !course) {
      return res.status(404).json({ error: 'Course not found or no longer available' });
    }

    // Check spots
    const spotsLeft = (course.max_students || 0) - (course.enrolled || 0);
    if (spotsLeft <= 0) {
      return res.status(409).json({ error: 'This course is fully booked' });
    }

    // Check for duplicate enrollment (same email + course)
    if (email) {
      const { data: existing } = await supabase
        .from('course_enrollments')
        .select('id')
        .eq('course_id', courseId)
        .eq('email', email)
        .limit(1);
      if (existing?.length) {
        return res.status(409).json({ error: 'You are already enrolled in this course' });
      }
    }

    // Create enrollment
    const { data: enrollment, error: eErr } = await supabase
      .from('course_enrollments')
      .insert({
        beautician_id: beautician.id,
        course_id: courseId,
        name,
        email,
        phone,
        notes,
        payment_status: 'unpaid',
        amount_paid_cents: 0,
      })
      .select()
      .single();

    if (eErr) {
      logger.error({ eErr }, 'Failed to create course enrollment');
      return res.status(500).json({ error: 'Failed to enroll' });
    }

    // Increment enrolled count on course
    await supabase
      .from('courses')
      .update({ enrolled: (course.enrolled || 0) + 1 })
      .eq('id', courseId);

    // Determine if deposit is needed
    const depositAmount = Number(course.deposit) || 0;
    const depositCents = Math.round(depositAmount * 100);
    const needsPayment = depositCents > 0;

    // If Stripe is ready and deposit required, create Checkout session
    if (needsPayment && stripe && beautician.stripe_account_id && beautician.stripe_onboarding_complete) {
      try {
        const courseDate = course.date
          ? new Date(course.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
          : '';

        const platformFee = calculatePlatformFee(depositCents);

        const session = await stripe.checkout.sessions.create({
          mode: 'payment',
          customer_email: email,
          line_items: [{
            price_data: {
              currency: 'gbp',
              product_data: {
                name: `${course.name} — deposit`,
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
            metadata: {
              enrollment_id: enrollment.id,
              course_id: courseId,
              beautician_id: beautician.id,
              type: 'course_deposit',
            },
          },
          success_url: `${FRONTEND_URL}/training/${slug}/${courseId}?enrolled=true&name=${encodeURIComponent(name)}`,
          cancel_url: `${FRONTEND_URL}/training/${slug}/${courseId}?cancelled=true`,
          metadata: {
            enrollment_id: enrollment.id,
            course_id: courseId,
            beautician_id: beautician.id,
            type: 'course_deposit',
          },
        });

        return res.status(201).json({
          enrollment: { id: enrollment.id, name, email },
          checkout_url: session.url,
        });
      } catch (stripeErr) {
        logger.error({ stripeErr }, 'Stripe checkout creation failed for course enrollment');
        // Fall through to non-payment response
      }
    }

    // No Stripe or no deposit required — enrollment confirmed without payment
    const paymentNote = needsPayment
      ? `Deposit of £${depositAmount.toFixed(2)} required — ${beautician.business_name || beautician.first_name} will be in touch to arrange payment.`
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
