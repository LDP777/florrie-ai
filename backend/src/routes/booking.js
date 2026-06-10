import { Router } from 'express';
import { z } from 'zod';
import Stripe from 'stripe';
import { supabase } from '../config.js';
import { notifyBookingConfirmed } from '../services/notifications.js';
import { pushNewBooking } from '../services/push-notifications.js';
import { sendConsultationFormSMS } from './consultation-forms.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { calculatePlatformFee } from '../lib/platform-fees.js';
import { verifyTurnstile } from '../middleware/turnstile.js';
import logger from '../lib/logger.js';
import { bookingSchema } from '../lib/schemas.js';

const router = Router();
const FRONTEND_URL = process.env.FRONTEND_URL;

// Only init Stripe if key is present (avoids crash in dev without keys)
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

/**
 * GET /api/booking/:slug
 * Public endpoint — returns the beautician's booking page data.
 * This powers the branded booking link (florrie.ai/book/ellie-brows).
 */
/**
 * GET /api/booking/confirm/:sessionId
 * Stripe redirects the client here after a successful deposit payment
 * (this is the checkout success_url). We verify the payment server-side, mark
 * the booking confirmed and send the confirmation email, THEN forward the
 * client to the confirmation page. This makes confirmations reliable even when
 * the Stripe webhook does not fire. Idempotent (skips if already paid).
 */
/**
 * GET /api/booking/:slug/manage/:token/resend-confirmation
 * Re-send a booking confirmation to the client (used when the original did not
 * go out). Authed by the unguessable per-appointment management token.
 */
router.get('/:slug/manage/:token/resend-confirmation', async (req, res) => {
  try {
    const { data: appt } = await supabase
      .from('appointments')
      .select('id, beauticians(booking_slug)')
      .eq('management_token', req.params.token)
      .maybeSingle();
    if (!appt || appt.beauticians?.booking_slug !== req.params.slug) {
      return res.status(404).json({ error: 'not_found' });
    }
    const { notifyBookingConfirmed } = await import('../services/notifications.js');
    await notifyBookingConfirmed(appt.id);
    logger.info({ appointmentId: appt.id }, 'Booking confirmation re-sent manually');
    return res.json({ ok: true, sent: true });
  } catch (err) {
    logger.error({ err }, 'resend-confirmation failed');
    return res.status(500).json({ error: 'failed' });
  }
});

router.get('/confirm/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const slug = req.query.slug || '';
  const mt = req.query.mt;
  const done = `${FRONTEND_URL}/book/${slug}/confirmed?session_id=${sessionId}${mt ? `&mt=${mt}` : ''}`;
  try {
    if (stripe && sessionId) {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const appointmentId = session?.metadata?.appointment_id;
      const paid = session?.payment_status === 'paid' || session?.status === 'complete';
      if (appointmentId && paid) {
        const { data: appt } = await supabase
          .from('appointments')
          .select('id, deposit_paid')
          .eq('id', appointmentId)
          .maybeSingle();
        if (appt && !appt.deposit_paid) {
          await supabase
            .from('appointments')
            .update({
              deposit_paid: true,
              deposit_status: 'paid',
              status: 'confirmed',
              stripe_payment_intent_id: session.payment_intent || null,
            })
            .eq('id', appointmentId);
          const { notifyBookingConfirmed } = await import('../services/notifications.js');
          notifyBookingConfirmed(appointmentId).catch(err =>
            logger.warn({ err, appointmentId }, 'confirm-redirect: notification failed (non-fatal)')
          );
          logger.info({ appointmentId, sessionId }, 'Booking confirmed via success-redirect (webhook fallback)');
        }
      }
    }
  } catch (err) {
    logger.error({ err, sessionId }, 'confirm-redirect failed');
  }
  return res.redirect(302, done);
});

router.get('/:slug', async (req, res) => {
  const { data: beautician, error } = await supabase
    .from('beauticians')
    .select('id, first_name, business_name, avatar_url, brand_color, brand_font, logo_url, working_hours, timezone, payment_settings, stripe_onboarding_complete')
    .eq('booking_slug', req.params.slug)
    .single();

  if (error || !beautician) {
    return res.status(404).json({ error: 'Booking page not found' });
  }

  // Get active, bookable treatments
  const { data: treatments } = await supabase
    .from('treatments')
    .select('id, name, description, duration_minutes, price_cents, deposit_cents, category')
    .eq('beautician_id', beautician.id)
    .eq('is_active', true)
    .eq('booking_enabled', true)
    .order('sort_order', { ascending: true });

  // Build accepted payment methods — always include card if Stripe connected
  const paySettings = beautician.payment_settings || {};
  const acceptedMethods = paySettings.accepted_methods || ['cash'];
  const stripeActive = beautician.stripe_onboarding_complete === true;
  // Card methods only available if Stripe is connected
  const availableMethods = acceptedMethods.filter(m =>
    m === 'cash' || m === 'bank_transfer' || (stripeActive && (m === 'card_online' || m === 'tap_to_pay'))
  );

  res.json({
    beautician: {
      id: beautician.id,
      name: beautician.business_name || beautician.first_name,
      avatar: beautician.avatar_url,
      brandColor: beautician.brand_color,
      brandFont: beautician.brand_font,
      logo: beautician.logo_url,
      workingHours: beautician.working_hours,
      timezone: beautician.timezone,
    },
    treatments: treatments || [],
    paymentSettings: {
      acceptedMethods: availableMethods.length > 0 ? availableMethods : ['cash'],
      requireDeposit: paySettings.require_deposit || false,
      depositAmount: paySettings.deposit_amount || '£10',
      noShowFee: paySettings.no_show_fee || false,
      stripeActive,
    },
  });
});

/**
 * GET /api/booking/:slug/page
 * Public — everything the booking page needs to render, in one call, run with
 * the service role so it works for LOGGED-OUT visitors (anon RLS would block a
 * direct browser query). Returns only booking-safe fields.
 */
router.get('/:slug/page', async (req, res) => {
  const { data: salon, error } = await supabase
    .from('beauticians')
    .select('id, first_name, business_name, booking_slug, brand_color, working_hours, payment_settings, stripe_onboarding_complete, avatar_url, logo_url, tagline')
    .eq('booking_slug', req.params.slug)
    .maybeSingle();

  if (error || !salon) {
    return res.status(404).json({ error: 'not_found' });
  }

  const { data: treatments } = await supabase
    .from('treatments')
    .select('id, name, description, duration_minutes, price_cents, deposit_cents, deposit_percent, category, requires_consultation, consultation_form_id')
    .eq('beautician_id', salon.id)
    .eq('is_active', true)
    .order('sort_order', { ascending: true });

  const { data: addOns } = await supabase
    .from('add_ons')
    .select('id, name, description, price_cents, duration_minutes, compatible_treatment_ids, is_active')
    .eq('beautician_id', salon.id)
    .eq('is_active', true)
    .order('name');

  res.json({ salon, treatments: treatments || [], addOns: addOns || [] });
});

/**
 * GET /api/booking/:slug/availability?date=YYYY-MM-DD
 * Public — booked time blocks for a day so the page can grey out taken slots.
 * Returns only timing (no client info). Service role, works logged-out.
 */
router.get('/:slug/availability', async (req, res) => {
  const { date } = req.query;
  const { data: salon } = await supabase
    .from('beauticians')
    .select('id')
    .eq('booking_slug', req.params.slug)
    .maybeSingle();
  if (!salon) return res.status(404).json({ error: 'not_found' });
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.json({ appointments: [] });

  const { data: appts } = await supabase
    .from('appointments')
    .select('starts_at, duration_minutes, buffer_minutes')
    .eq('beautician_id', salon.id)
    .gte('starts_at', `${date}T00:00:00`)
    .lte('starts_at', `${date}T23:59:59`)
    .not('status', 'in', '(cancelled,cancelled_by_client,cancelled_by_beautician,rescheduled)');

  res.json({ appointments: appts || [] });
});

/**
 * GET /api/booking/:slug/policy
 * Public — returns the beautician's booking policy for display on the booking page.
 * Includes: cancellation terms, min booking window, deposit rules.
 */
router.get('/:slug/policy', async (req, res) => {
  try {
    const { data: b } = await supabase
      .from('beauticians')
      .select('booking_policy, first_name, business_name')
      .eq('booking_slug', req.params.slug)
      .single();
    if (!b) return res.status(404).json({ error: 'Not found' });
    res.json({ policy: b.booking_policy || {}, name: b.business_name || b.first_name });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch booking policy');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * POST /api/booking/:slug/lookup-client
 * Public — recognise a returning client by email or phone.
 * Returns pre-fill data + patch test status + pending consultation forms.
 * Does NOT return sensitive data — only enough to personalise the booking form.
 */
router.post('/:slug/lookup-client', async (req, res) => {
  try {
    const { email, phone } = req.body;
    if (!email && !phone) return res.json({ found: false });

    // Get beautician ID
    const { data: b } = await supabase
      .from('beauticians')
      .select('id')
      .eq('booking_slug', req.params.slug)
      .single();
    if (!b) return res.status(404).json({ error: 'Not found' });

    // Look up client by email or phone
    let query = supabase
      .from('clients')
      .select('id, first_name, last_name, email, phone')
      .eq('beautician_id', b.id);

    if (email) query = query.ilike('email', email.trim());
    else query = query.eq('phone', phone.trim());

    const { data: client } = await query.maybeSingle();

    if (!client) return res.json({ found: false });

    // Fetch their upcoming appointment count + patch test status
    const [{ data: upcoming }, { data: pendingTests }, { data: pendingForms }] = await Promise.all([
      supabase
        .from('appointments')
        .select('id, starts_at, status')
        .eq('client_id', client.id)
        .in('status', ['confirmed', 'pending'])
        .gte('starts_at', new Date().toISOString())
        .order('starts_at', { ascending: true })
        .limit(3),

      supabase
        .from('patch_tests')
        .select('id, status, test_date')
        .eq('client_id', client.id)
        .eq('beautician_id', b.id)
        .eq('status', 'pending')
        .limit(1),

      supabase
        .from('consultation_responses')
        .select('id, status, created_at')
        .eq('client_id', client.id)
        .eq('beautician_id', b.id)
        .eq('status', 'pending')
        .limit(1),
    ]);

    res.json({
      found: true,
      client: {
        name: `${client.first_name} ${client.last_name || ''}`.trim(),
        email: client.email,
        phone: client.phone,
        clientId: client.id,
      },
      upcomingAppointments: (upcoming || []).length,
      hasPendingPatchTest: (pendingTests || []).length > 0,
      hasPendingForm: (pendingForms || []).length > 0,
    });
  } catch (err) {
    logger.error({ err }, 'Client lookup failed');
    res.json({ found: false }); // fail silently — don't block booking
  }
});

/**
 * GET /api/booking/:slug/manage/:token
 * Public — client self-service portal. Returns their booking + related data.
 * Token = appointment.management_token (UUID generated at booking time).
 */
router.get('/:slug/manage/:token', async (req, res) => {
  try {
    const { data: appt } = await supabase
      .from('appointments')
      .select(`
        id, starts_at, ends_at, status, management_token,
        payment_expires_at, policy_snapshot, client_email,
        treatments(id, name, duration_minutes, price_cents, category, requires_patch_test),
        clients(id, first_name, last_name, email, phone),
        beauticians(id, first_name, business_name, booking_policy, booking_slug, brand_color, patch_test_expiry_months, patch_test_block_booking)
      `)
      .eq('management_token', req.params.token)
      .single();

    if (!appt || appt.beauticians?.booking_slug !== req.params.slug) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    // Fetch patch test status and pending consultation forms for this client
    const clientId = appt.clients?.id;
    const beauticianId = appt.beauticians?.id;

    const expiryMonths = appt.beauticians?.patch_test_expiry_months || 6;
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - expiryMonths);

    const [{ data: patchTests }, { data: pendingForms }] = await Promise.all([
      supabase
        .from('patch_tests')
        .select('id, status, test_date, result, suggested_slot, confirmed_at, treatments(name)')
        .eq('client_id', clientId)
        .eq('beautician_id', beauticianId)
        .order('test_date', { ascending: false })
        .limit(5),

      supabase
        .from('consultation_responses')
        .select('id, status, created_at, token, form_url, consultation_forms(name)')
        .eq('client_id', clientId)
        .eq('beautician_id', beauticianId)
        .eq('status', 'pending')
        .limit(5),
    ]);

    // Determine if a patch test is needed:
    // Treatment requires one AND client has no passed patch test in the last 6 months
    // AND no pending/confirmed patch test already exists for this appointment
    const treatmentRequiresPatchTest = appt.treatments?.requires_patch_test === true;
    const hasValidPatchTest = (patchTests || []).some(pt =>
      pt.status === 'passed' && pt.test_date && new Date(pt.test_date) > sixMonthsAgo
    );
    const hasPendingPatchTest = (patchTests || []).some(pt =>
      pt.status === 'pending' || pt.confirmed_at
    );
    const needsPatchTest = treatmentRequiresPatchTest && !hasValidPatchTest && !hasPendingPatchTest;
    const blockBooking = needsPatchTest && (appt.beauticians?.patch_test_block_booking === true);

    const policy = appt.policy_snapshot || appt.beauticians?.booking_policy || {};
    const now = new Date();
    const apptStart = new Date(appt.starts_at);
    const hoursUntil = (apptStart - now) / (1000 * 60 * 60);
    const withinCancellationWindow = hoursUntil < (policy.cancellation_notice_hours || 48);

    res.json({
      appointment: {
        id: appt.id,
        startsAt: appt.starts_at,
        endsAt: appt.ends_at,
        status: appt.status,
        paymentExpiresAt: appt.payment_expires_at,
        treatment: appt.treatments,
        client: {
          name: `${appt.clients?.first_name} ${appt.clients?.last_name || ''}`.trim(),
          email: appt.clients?.email || appt.client_email,
          phone: appt.clients?.phone,
        },
        beautician: {
          name: appt.beauticians?.business_name || appt.beauticians?.first_name,
          brandColor: appt.beauticians?.brand_color,
        },
      },
      policy: {
        ...policy,
        withinCancellationWindow,
        hoursUntil: Math.max(0, Math.round(hoursUntil)),
      },
      patchTests: patchTests || [],
      needsPatchTest,
      blockBooking,
      pendingForms: (pendingForms || []).map(f => ({
        ...f,
        // Compute form_url from token if not stored in DB
        form_url: f.form_url || (f.token ? `${FRONTEND_URL}/form/${f.token}` : null),
      })),
    });
  } catch (err) {
    logger.error({ err }, 'Manage booking fetch failed');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * POST /api/booking/:slug/manage/:token/cancel
 * Client self-cancels. Enforces cancellation policy:
 *   - Within notice window → records late_cancel_charged flag (beautician charges separately)
 *   - Outside window → free cancellation
 */
router.post('/:slug/manage/:token/cancel', async (req, res) => {
  try {
    const { data: appt } = await supabase
      .from('appointments')
      .select('id, starts_at, status, policy_snapshot, client_id, beauticians(booking_policy, booking_slug)')
      .eq('management_token', req.params.token)
      .single();

    if (!appt || appt.beauticians?.booking_slug !== req.params.slug) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    if (!['confirmed', 'pending'].includes(appt.status)) {
      return res.status(400).json({ error: 'This booking cannot be cancelled' });
    }

    const policy = appt.policy_snapshot || appt.beauticians?.booking_policy || {};
    const hoursUntil = (new Date(appt.starts_at) - new Date()) / (1000 * 60 * 60);
    const isLateCancel = hoursUntil < (policy.cancellation_notice_hours || 48);

    const { error } = await supabase
      .from('appointments')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        late_cancel_charged: isLateCancel && (policy.late_cancel_charge_percent || 0) > 0,
      })
      .eq('id', appt.id);

    if (error) {
      logger.error({ err: error }, 'Failed to cancel appointment');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    res.json({
      success: true,
      isLateCancel,
      chargePercent: isLateCancel ? (policy.late_cancel_charge_percent || 0) : 0,
      message: isLateCancel
        ? `Cancelled. As this is within the ${policy.cancellation_notice_hours || 48}-hour notice period, a cancellation fee may apply.`
        : 'Your appointment has been cancelled.',
    });
  } catch (err) {
    logger.error({ err }, 'Cancel booking failed');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * POST /api/booking/:slug/manage/:token/reschedule
 * Client self-reschedules to a new time.
 *
 * Policy enforcement:
 *   - If within the beautician's cancellation_notice_hours window → late_reschedule_charged = true
 *     (beautician's policy may require client to pay for both appointments)
 *   - Conflict-checks the new slot before confirming
 *   - After moving, notifies the waitlist about the freed slot (non-blocking)
 */
router.post('/:slug/manage/:token/reschedule', async (req, res) => {
  try {
    const { new_starts_at } = req.body;
    if (!new_starts_at) return res.status(400).json({ error: 'new_starts_at is required' });

    const newStart = new Date(new_starts_at);
    if (isNaN(newStart.getTime())) return res.status(400).json({ error: 'Invalid date format' });
    if (newStart <= new Date()) return res.status(400).json({ error: 'New time must be in the future' });

    // Load current appointment
    const { data: appt } = await supabase
      .from('appointments')
      .select(`
        id, starts_at, ends_at, status, duration_minutes, buffer_minutes, extra_padding_minutes,
        policy_snapshot, client_email, client_id, beautician_id, treatment_id,
        beauticians(id, booking_slug, booking_policy, business_name, first_name),
        treatments(name),
        clients(first_name, email)
      `)
      .eq('management_token', req.params.token)
      .single();

    if (!appt || appt.beauticians?.booking_slug !== req.params.slug) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    if (!['confirmed', 'pending'].includes(appt.status)) {
      return res.status(400).json({ error: 'This booking cannot be rescheduled' });
    }

    const policy = appt.policy_snapshot || appt.beauticians?.booking_policy || {};
    const noticeHours = policy.cancellation_notice_hours || 48;
    const hoursUntilCurrent = (new Date(appt.starts_at) - new Date()) / (1000 * 60 * 60);
    const isLateReschedule = hoursUntilCurrent < noticeHours;

    // Min booking hours check for the new time
    const minHours = policy.min_booking_hours || 0;
    const hoursUntilNew = (newStart - new Date()) / (1000 * 60 * 60);
    if (minHours > 0 && hoursUntilNew < minHours) {
      return res.status(400).json({
        error: `Bookings must be made at least ${minHours} hour${minHours !== 1 ? 's' : ''} in advance`,
      });
    }

    // Conflict check for new slot
    const totalMinutes = (appt.duration_minutes || 60) + (appt.buffer_minutes || 0) + (appt.extra_padding_minutes || 0);
    const newEnd = new Date(newStart.getTime() + totalMinutes * 60 * 1000);

    const { data: conflicts } = await supabase
      .from('appointments')
      .select('id')
      .eq('beautician_id', appt.beautician_id)
      .in('status', ['confirmed', 'pending', 'in_progress'])
      .neq('id', appt.id)
      .lt('starts_at', newEnd.toISOString())
      .gt('ends_at', newStart.toISOString());

    if (conflicts && conflicts.length > 0) {
      return res.status(409).json({ error: 'That time slot is not available. Please choose another time.' });
    }

    // Save old slot info for gap-filling
    const oldStartsAt = appt.starts_at;
    const oldEndsAt = appt.ends_at;

    // Update appointment to new time
    const { error: updateErr } = await supabase
      .from('appointments')
      .update({
        starts_at: newStart.toISOString(),
        ends_at: newEnd.toISOString(),
        ...(isLateReschedule && { late_reschedule_charged: true }),
        rescheduled_at: new Date().toISOString(),
        rescheduled_from: oldStartsAt,
      })
      .eq('id', appt.id);

    if (updateErr) {
      logger.error({ err: updateErr }, 'Reschedule update failed');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    // Log AI action
    await supabase.from('ai_actions').insert({
      beautician_id: appt.beautician_id,
      action_type: 'booking_rescheduled',
      digital_employee: 'front_desk',
      summary: `${appt.clients?.first_name || 'Client'} rescheduled ${appt.treatments?.name} from ${new Date(oldStartsAt).toLocaleDateString('en-GB')} to ${newStart.toLocaleDateString('en-GB')}`,
      details: {
        appointment_id: appt.id,
        from: oldStartsAt,
        to: newStart.toISOString(),
        isLateReschedule,
        chargePercent: isLateReschedule ? (policy.late_cancel_charge_percent || 0) : 0,
      },
      client_id: appt.client_id,
      appointment_id: appt.id,
      confidence: 1.0,
      autonomous: false,
      outcome: 'success',
    }).catch(() => {});

    // Smart gap-filling: check waitlist for the freed slot (non-blocking)
    notifyWaitlistAboutFreedSlot({
      beauticianId: appt.beautician_id,
      treatmentId: appt.treatment_id,
      freedStart: oldStartsAt,
      freedEnd: oldEndsAt,
    }).catch(err => logger.warn({ err }, 'Waitlist gap-fill notification failed (non-fatal)'));

    const beauticianName = appt.beauticians?.business_name || appt.beauticians?.first_name;
    const chargePercent = isLateReschedule ? (policy.late_cancel_charge_percent || 0) : 0;

    res.json({
      success: true,
      newStartsAt: newStart.toISOString(),
      newEndsAt: newEnd.toISOString(),
      isLateReschedule,
      chargePercent,
      message: isLateReschedule && chargePercent > 0
        ? `Rescheduled to ${newStart.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })} at ${newStart.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}. As this is within the ${noticeHours}-hour window, ${beauticianName} may charge ${chargePercent}% for the original appointment.`
        : `Rescheduled to ${newStart.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })} at ${newStart.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.`,
    });
  } catch (err) {
    logger.error({ err }, 'Reschedule failed');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * POST /api/booking/:slug/manage/:token/resend-payment
 * Resend the Stripe payment link for an unpaid pending booking.
 * Called from the manage page when client still hasn't paid.
 */
router.post('/:slug/manage/:token/resend-payment', async (req, res) => {
  try {
    const { data: appt } = await supabase
      .from('appointments')
      .select(`
        id, status, deposit_paid, stripe_payment_intent_id, client_email,
        starts_at, treatment_id, beautician_id,
        beauticians(id, booking_slug, booking_policy, business_name, first_name, stripe_account_id, stripe_onboarding_complete, brand_color),
        treatments(name, price_cents),
        clients(first_name, email, stripe_customer_id)
      `)
      .eq('management_token', req.params.token)
      .single();

    if (!appt || appt.beauticians?.booking_slug !== req.params.slug) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    if (appt.status !== 'pending' || appt.deposit_paid) {
      return res.status(400).json({ error: 'No payment required for this booking' });
    }

    const clientEmail = appt.clients?.email || appt.client_email;
    if (!clientEmail) return res.status(400).json({ error: 'No email on record for this booking' });

    const b = appt.beauticians;
    if (!stripe || !b?.stripe_account_id || !b?.stripe_onboarding_complete) {
      return res.status(400).json({ error: 'Payment not available — contact your beautician directly' });
    }

    // Create a fresh Stripe checkout session for the outstanding deposit
    const { data: depositData } = await supabase
      .from('appointments')
      .select('deposit_cents, payment_type')
      .eq('id', appt.id)
      .single();

    const depositCents = depositData?.deposit_cents || 0;
    if (!depositCents) return res.status(400).json({ error: 'No deposit amount set' });

    const startsDate = new Date(appt.starts_at);
    const dateLabel = startsDate.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const timeLabel = startsDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const beauticianName = b.business_name || b.first_name;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      ...(appt.clients?.stripe_customer_id ? { customer: appt.clients.stripe_customer_id } : {}),
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: {
            name: `${appt.treatments?.name || 'Appointment'} — deposit`,
            description: `${dateLabel} at ${timeLabel} with ${beauticianName}`,
          },
          unit_amount: depositCents,
        },
        quantity: 1,
      }],
      payment_intent_data: {
        application_fee_amount: Math.round(depositCents * 0.015),
        transfer_data: { destination: b.stripe_account_id },
        metadata: {
          appointment_id: appt.id,
          beautician_id: appt.beautician_id,
          payment_type: 'deposit_resend',
        },
      },
      success_url: `${FRONTEND_URL}/book/${req.params.slug}/confirmed?resent=true&mt=${req.params.token}`,
      cancel_url: `${FRONTEND_URL}/book/${req.params.slug}/manage/${req.params.token}`,
      metadata: { appointment_id: appt.id, payment_type: 'deposit_resend' },
    });

    // Email the link to the client
    const { sendEmail } = await import('../services/notifications.js');
    await sendEmail({
      to: clientEmail,
      subject: `Complete your booking with ${beauticianName} — payment link`,
      html: `
        <p>Hi ${appt.clients?.first_name || 'there'},</p>
        <p>Your booking for <strong>${appt.treatments?.name || 'your appointment'}</strong> on <strong>${dateLabel} at ${timeLabel}</strong> with ${beauticianName} is still waiting for payment.</p>
        <p>Click below to secure your spot — this link is active for 24 hours:</p>
        <p><a href="${session.url}" style="background:#C76B8A;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600;">Pay deposit — £${(depositCents / 100).toFixed(2)}</a></p>
        <p style="color:#999;font-size:12px;">If your slot isn't paid for, it may be released to another client.</p>
      `,
    });

    res.json({ sent: true, checkoutUrl: session.url });
  } catch (err) {
    logger.error({ err }, 'Resend payment failed');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * GET /api/booking/:slug/manage/:token/patch-test/slots
 * Return available 10-minute slots for a patch test appointment.
 * Must be at least 24 hours before the main appointment, within working hours.
 * Checks for conflicts with existing appointments.
 */
router.get('/:slug/manage/:token/patch-test/slots', async (req, res) => {
  try {
    const { data: appt } = await supabase
      .from('appointments')
      .select(`
        id, starts_at, client_id, client_email, client_name, client_phone,
        beauticians(id, booking_slug, working_hours, timezone)
      `)
      .eq('management_token', req.params.token)
      .single();

    if (!appt || appt.beauticians?.booking_slug !== req.params.slug) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const mainApptStart = new Date(appt.starts_at);
    const deadline = new Date(mainApptStart.getTime() - 24 * 60 * 60 * 1000);
    const now = new Date();

    if (deadline <= now) {
      return res.status(400).json({ error: 'Too late to book patch test — must be 24+ hours before appointment' });
    }

    const beautician = appt.beauticians;
    const beauticianId = beautician.id;
    const timezone = beautician.timezone || 'Europe/London';

    // Get working hours; fallback to 9:00–17:00
    const workingHours = beautician.working_hours || {
      'Mon': { start: '09:00', end: '17:00' },
      'Tue': { start: '09:00', end: '17:00' },
      'Wed': { start: '09:00', end: '17:00' },
      'Thu': { start: '09:00', end: '17:00' },
      'Fri': { start: '09:00', end: '17:00' },
      'Sat': { start: '09:00', end: '17:00' },
    };

    // Get existing appointments in next 14 days to find conflicts
    const searchEnd = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    const { data: existing } = await supabase
      .from('appointments')
      .select('id, starts_at, ends_at')
      .eq('beautician_id', beauticianId)
      .in('status', ['confirmed', 'pending', 'in_progress'])
      .gte('starts_at', now.toISOString())
      .lte('ends_at', searchEnd.toISOString())
      .order('starts_at', { ascending: true });

    const existingSlots = (existing || []).map(a => ({
      start: new Date(a.starts_at),
      end: new Date(a.ends_at),
    }));

    // Generate candidate 10-minute slots
    const candidates = [];
    let slotTime = new Date(now);

    // Round up to next 15-min interval
    const mins = slotTime.getMinutes();
    if (mins % 15 !== 0) {
      slotTime.setMinutes(Math.ceil(mins / 15) * 15, 0, 0);
    }

    // Generate slots up to deadline
    while (slotTime < deadline) {
      const slotEnd = new Date(slotTime.getTime() + 10 * 60 * 1000);

      // Check working hours for this day
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const dayName = dayNames[slotTime.getDay()];
      const dayHours = workingHours[dayName];

      if (dayHours) {
        const [startHour, startMin] = dayHours.start.split(':').map(Number);
        const [endHour, endMin] = dayHours.end.split(':').map(Number);
        const dayStart = new Date(slotTime);
        dayStart.setHours(startHour, startMin, 0, 0);
        const dayEnd = new Date(slotTime);
        dayEnd.setHours(endHour, endMin, 0, 0);

        // Slot must be within working hours
        if (slotTime >= dayStart && slotEnd <= dayEnd) {
          // Check for conflicts
          let hasConflict = false;
          for (const existing of existingSlots) {
            if (slotTime < existing.end && slotEnd > existing.start) {
              hasConflict = true;
              break;
            }
          }

          if (!hasConflict) {
            candidates.push(slotTime.toISOString());
            if (candidates.length >= 4) break; // Get 3-4 slots
          }
        }
      }

      slotTime = new Date(slotTime.getTime() + 15 * 60 * 1000); // Next 15-min slot
    }

    if (candidates.length === 0) {
      return res.status(400).json({ error: 'No available slots for patch test' });
    }

    res.json({
      success: true,
      slots: candidates,
      suggested: candidates[0],
      deadline: deadline.toISOString(),
    });
  } catch (err) {
    logger.error({ err }, 'Patch test slots fetch failed');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * POST /api/booking/:slug/manage/:token/patch-test/confirm
 * Client confirms a patch test appointment slot.
 * Creates a new appointment record for the patch test.
 */
router.post('/:slug/manage/:token/patch-test/confirm', async (req, res) => {
  try {
    const { slot } = req.body;
    if (!slot) return res.status(400).json({ error: 'Slot is required' });

    const slotTime = new Date(slot);
    if (isNaN(slotTime.getTime())) {
      return res.status(400).json({ error: 'Invalid slot format' });
    }

    const { data: appt } = await supabase
      .from('appointments')
      .select(`
        id, starts_at, client_id, client_email, client_name, client_phone,
        beauticians(id, booking_slug, working_hours, timezone)
      `)
      .eq('management_token', req.params.token)
      .single();

    if (!appt || appt.beauticians?.booking_slug !== req.params.slug) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const mainApptStart = new Date(appt.starts_at);
    const deadline = new Date(mainApptStart.getTime() - 24 * 60 * 60 * 1000);
    const now = new Date();

    // Validate slot timing
    if (slotTime >= deadline) {
      return res.status(400).json({ error: 'Slot must be at least 24 hours before main appointment' });
    }

    if (slotTime < now) {
      return res.status(400).json({ error: 'Slot must be in the future' });
    }

    const beautician = appt.beauticians;
    const workingHours = beautician.working_hours || {};
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayName = dayNames[slotTime.getDay()];
    const dayHours = workingHours[dayName] || { start: '09:00', end: '17:00' };

    const [startHour, startMin] = dayHours.start.split(':').map(Number);
    const [endHour, endMin] = dayHours.end.split(':').map(Number);
    const dayStart = new Date(slotTime);
    dayStart.setHours(startHour, startMin, 0, 0);
    const dayEnd = new Date(slotTime);
    dayEnd.setHours(endHour, endMin, 0, 0);

    if (slotTime < dayStart || slotTime >= dayEnd) {
      return res.status(400).json({ error: 'Slot is outside working hours' });
    }

    // Check for conflicts
    const slotEnd = new Date(slotTime.getTime() + 10 * 60 * 1000);
    const { data: conflicts } = await supabase
      .from('appointments')
      .select('id')
      .eq('beautician_id', beautician.id)
      .in('status', ['confirmed', 'pending', 'in_progress'])
      .lt('starts_at', slotEnd.toISOString())
      .gt('ends_at', slotTime.toISOString());

    if (conflicts && conflicts.length > 0) {
      return res.status(409).json({ error: 'This slot is no longer available' });
    }

    // Create patch test appointment
    const { data: patchTestAppt, error: insertErr } = await supabase
      .from('appointments')
      .insert({
        beautician_id: beautician.id,
        client_id: appt.client_id,
        client_email: appt.client_email,
        client_name: appt.client_name,
        client_phone: appt.client_phone,
        treatment_id: null,
        starts_at: slotTime.toISOString(),
        ends_at: slotEnd.toISOString(),
        duration_minutes: 10,
        status: 'confirmed',
        notes: 'Patch test (auto-booked)',
        booked_via: 'booking_page',
        price_cents: 0,
      })
      .select('id, starts_at, ends_at')
      .single();

    if (insertErr) {
      logger.error({ err: insertErr }, 'Patch test appointment creation failed');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    // Upsert patch_tests row — update if one exists (unconfirmed), otherwise create
    const { data: existingPT } = await supabase
      .from('patch_tests')
      .select('id')
      .eq('client_id', appt.client_id)
      .eq('beautician_id', beautician.id)
      .is('confirmed_at', null)
      .maybeSingle();

    if (existingPT) {
      const { error: patchErr } = await supabase
        .from('patch_tests')
        .update({
          appointment_id: patchTestAppt.id,
          suggested_slot: slotTime.toISOString(),
          confirmed_at: new Date().toISOString(),
          auto_booked: true,
        })
        .eq('id', existingPT.id);
      if (patchErr) logger.error({ err: patchErr }, 'Patch test update failed (non-fatal)');
    } else {
      // No existing row — create one so manage page reflects the confirmed booking
      const { error: patchErr } = await supabase
        .from('patch_tests')
        .insert({
          client_id: appt.client_id,
          beautician_id: beautician.id,
          appointment_id: patchTestAppt.id,
          suggested_slot: slotTime.toISOString(),
          confirmed_at: new Date().toISOString(),
          auto_booked: true,
          status: 'pending', // awaiting result
        });
      if (patchErr) logger.error({ err: patchErr }, 'Patch test insert failed (non-fatal)');
    }

    res.json({
      success: true,
      appointment: {
        starts_at: patchTestAppt.starts_at,
        ends_at: patchTestAppt.ends_at,
      },
    });
  } catch (err) {
    logger.error({ err }, 'Patch test confirmation failed');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * Helper: notify waitlist clients when a slot is freed up by a reschedule.
 * Looks for waitlist entries that match the treatment and freed time window.
 */
async function notifyWaitlistAboutFreedSlot({ beauticianId, treatmentId, freedStart, freedEnd }) {
  const freedDate = new Date(freedStart);

  // Find waitlist entries for this beautician + treatment (or any treatment)
  const { data: waiters } = await supabase
    .from('waitlist')
    .select('id, client_id, phone, email, first_name, preferred_days, preferred_times')
    .eq('beautician_id', beauticianId)
    .or(`treatment_id.eq.${treatmentId},treatment_id.is.null`)
    .eq('status', 'waiting')
    .order('created_at', { ascending: true })
    .limit(3); // notify top 3

  if (!waiters?.length) return;

  const { sendSMS } = await import('./notifications.js');
  const { sendEmail } = await import('../services/notifications.js');

  const dayName = freedDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const timeStr = freedDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  for (const waiter of waiters) {
    const msg = `Hi ${waiter.first_name || 'there'}! A slot has just opened up: ${dayName} at ${timeStr}. Reply YES to claim it or book at your link.`;

    if (waiter.phone) {
      sendSMS({ to: waiter.phone, body: msg, beauticianId, messageType: 'waitlist_alert' }).catch(() => {});
    }
    if (waiter.email) {
      sendEmail({
        to: waiter.email,
        subject: `A slot just opened up — ${dayName} at ${timeStr}`,
        html: `<p>${msg}</p>`,
      }).catch(() => {});
    }

    // Mark as notified (don't spam them)
    await supabase.from('waitlist').update({ notified_at: new Date().toISOString() }).eq('id', waiter.id);
  }
}

/**
 * POST /api/booking/:slug/send-manage-link
 * Resend the manage-booking link to the client's email.
 * Looks up by email + slug — for clients who lose the original confirmation.
 */
router.post('/:slug/send-manage-link', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const { data: b } = await supabase
      .from('beauticians')
      .select('id, business_name, first_name')
      .eq('booking_slug', req.params.slug)
      .single();
    if (!b) return res.status(404).json({ error: 'Not found' });

    // Find their most recent upcoming appointment with a management token
    const { data: appt } = await supabase
      .from('appointments')
      .select('id, starts_at, management_token, treatments(name)')
      .eq('beautician_id', b.id)
      .eq('client_email', email.toLowerCase().trim())
      .in('status', ['confirmed', 'pending'])
      .gte('starts_at', new Date().toISOString())
      .order('starts_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (!appt) {
      // Return 200 regardless to avoid email enumeration
      return res.json({ sent: true });
    }

    const manageUrl = `${FRONTEND_URL}/book/${req.params.slug}/manage/${appt.management_token}`;
    const treatmentName = appt.treatments?.name || 'your appointment';
    const apptDate = new Date(appt.starts_at).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

    // Send via the notifications service (Resend email)
    const { sendEmail } = await import('../services/notifications.js');
    await sendEmail({
      to: email,
      subject: `Manage your ${treatmentName} booking`,
      html: `
        <p>Hi there,</p>
        <p>Here's your booking management link for your <strong>${treatmentName}</strong> on <strong>${apptDate}</strong> with ${b.business_name || b.first_name}.</p>
        <p><a href="${manageUrl}" style="background:#C76B8A;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;">Manage my booking</a></p>
        <p>From this page you can view your booking, complete any consultation forms, check your patch test status, or cancel.</p>
        <p style="color:#999;font-size:12px;">If you didn't request this email, you can ignore it.</p>
      `,
    });

    res.json({ sent: true });
  } catch (err) {
    logger.error({ err }, 'Send manage link failed');
    res.json({ sent: true }); // don't leak errors
  }
});

/**
 * PATCH /api/booking/appointments/:id/status
 * Transition appointment status with validation.
 * Only allows valid state transitions.
 * Requires authentication.
 */
const statusTransitionSchema = z.object({
  status: z.enum(['confirmed', 'cancelled', 'no_show', 'completed'], {
    errorMap: () => ({ message: 'Invalid status. Must be: confirmed, cancelled, no_show, or completed' })
  })
});

const VALID_TRANSITIONS = {
  'pending': ['confirmed', 'cancelled'],
  'confirmed': ['completed', 'cancelled', 'no_show'],
  'completed': [],
  'cancelled': [],
  'no_show': []
};

router.patch('/appointments/:id/status', requireAuth, validate(statusTransitionSchema), async (req, res) => {
  const { id } = req.params;
  const { status: newStatus } = req.body;

  try {
    // Get current appointment
    const { data: appointment, error: fetchError } = await supabase
      .from('appointments')
      .select('id, status, starts_at, ends_at, beautician_id, price_cents, client_id')
      .eq('id', id)
      .single();

    if (fetchError || !appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    // Verify ownership
    if (appointment.beautician_id !== req.beautician.id) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Validate transition
    const currentStatus = appointment.status;
    const allowedTransitions = VALID_TRANSITIONS[currentStatus] || [];

    if (!allowedTransitions.includes(newStatus)) {
      return res.status(400).json({
        error: `Cannot transition from '${currentStatus}' to '${newStatus}'`,
        currentStatus,
        allowedTransitions
      });
    }

    // Build update object
    const updates = { status: newStatus };

    // Set completion timestamp
    if (newStatus === 'completed') {
      updates.completed_at = new Date().toISOString();
    }

    // Set cancellation timestamp
    if (newStatus === 'cancelled') {
      updates.cancelled_at = new Date().toISOString();
    }

    // Set no-show timestamp
    if (newStatus === 'no_show') {
      updates.no_showed_at = new Date().toISOString();
    }

    // Perform update
    const { data: updated, error: updateError } = await supabase
      .from('appointments')
      .update(updates)
      .eq('id', id)
      .eq('beautician_id', req.beautician.id)
      .select('*, clients(first_name, last_name, phone, stripe_customer_id), treatments(name, duration_minutes, price_cents)')
      .single();

    if (updateError) {
      return res.status(500).json({ error: 'Failed to update appointment status' });
    }

    // If marked no-show and client has saved card, tell frontend it can charge a fee
    const canChargeNoShow = newStatus === 'no_show' && updated.clients?.stripe_customer_id;

    res.json({
      message: `Appointment status updated to '${newStatus}'`,
      appointment: updated,
      ...(canChargeNoShow && {
        no_show_fee: {
          can_charge: true,
          suggested_amount_cents: updated.deposit_cents || updated.price_cents,
          hint: 'Client has a saved card. You can charge a no-show fee from the appointment details.',
        },
      }),
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/booking/:slug/consultation-form/:formId
 * Public endpoint — returns the consultation form fields for inline display in the booking page.
 * No auth required since this powers the public booking flow.
 */
router.get('/:slug/consultation-form/:formId', async (req, res) => {
  try {
    // Resolve beautician from slug to filter by their ID
    const { data: beautician, error: beauticianError } = await supabase
      .from('beauticians')
      .select('id')
      .eq('booking_slug', req.params.slug)
      .single();

    if (beauticianError || !beautician) {
      return res.status(404).json({ error: 'Beautician not found' });
    }

    const { data: form } = await supabase
      .from('consultation_forms')
      .select('id, name, consent_text, consultation_form_fields(*)')
      .eq('id', req.params.formId)
      .eq('beautician_id', beautician.id)
      .eq('is_active', true)
      .single();

    if (!form) return res.status(404).json({ error: 'Form not found' });

    // Sort fields by sort_order
    if (form.consultation_form_fields) {
      form.consultation_form_fields.sort((a, b) => a.sort_order - b.sort_order);
    }

    res.json({ form });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch consultation form');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * POST /api/booking/:slug/check-member
 * Public endpoint — checks if a phone number belongs to a client with an active membership.
 * Returns membership info so the booking page can show a "Member" badge and notify the beautician.
 */
router.post('/:slug/check-member', async (req, res) => {
  const { phone } = req.body;
  if (!phone || typeof phone !== 'string' || phone.trim().length < 5) {
    return res.json({ is_member: false });
  }

  const { data: beautician } = await supabase
    .from('beauticians')
    .select('id')
    .eq('booking_slug', req.params.slug)
    .single();

  if (!beautician) return res.json({ is_member: false });

  // Find client by phone
  const { data: client } = await supabase
    .from('clients')
    .select('id, first_name')
    .eq('beautician_id', beautician.id)
    .eq('phone', phone.trim())
    .maybeSingle();

  if (!client) return res.json({ is_member: false });

  // Check for active membership
  const { data: membership } = await supabase
    .from('client_memberships')
    .select('id, membership_id, status')
    .eq('beautician_id', beautician.id)
    .eq('client_id', client.id)
    .eq('status', 'active')
    .maybeSingle();

  if (!membership) return res.json({ is_member: false });

  // Get plan name
  const { data: plan } = await supabase
    .from('membership_plans')
    .select('name')
    .eq('id', membership.membership_id)
    .maybeSingle();

  return res.json({
    is_member: true,
    plan_name: plan?.name || 'Active Member',
    client_name: client.first_name,
  });
});

/**
 * POST /api/booking/:slug/check-packages
 * Public endpoint — checks if a phone number has active packages with sessions remaining.
 * Returns the packages so the booking page can offer "Use a session" instead of paying.
 */
router.post('/:slug/check-packages', async (req, res) => {
  const { phone, treatment_id } = req.body;
  if (!phone || typeof phone !== 'string' || phone.trim().length < 5) {
    return res.json({ packages: [] });
  }

  const { data: beautician } = await supabase
    .from('beauticians')
    .select('id')
    .eq('booking_slug', req.params.slug)
    .single();

  if (!beautician) return res.json({ packages: [] });

  // Find client by phone
  const { data: client } = await supabase
    .from('clients')
    .select('id')
    .eq('beautician_id', beautician.id)
    .eq('phone', phone.trim())
    .maybeSingle();

  if (!client) return res.json({ packages: [] });

  // Get active client packages with sessions remaining
  const { data: clientPkgs } = await supabase
    .from('client_packages')
    .select('id, sessions_used, package_id, packages(name, sessions, treatment_ids)')
    .eq('beautician_id', beautician.id)
    .eq('client_id', client.id)
    .eq('status', 'active');

  if (!clientPkgs || clientPkgs.length === 0) return res.json({ packages: [] });

  // Filter to packages that have sessions remaining and (optionally) include this treatment
  const available = clientPkgs
    .filter(cp => {
      const totalSessions = cp.packages?.sessions || 0;
      const used = cp.sessions_used || 0;
      if (used >= totalSessions) return false;
      // If treatment_id provided, only show packages that include that treatment
      if (treatment_id && cp.packages?.treatment_ids?.length > 0) {
        return cp.packages.treatment_ids.includes(treatment_id);
      }
      return true;
    })
    .map(cp => ({
      client_package_id: cp.id,
      package_name: cp.packages?.name || 'Package',
      sessions_remaining: (cp.packages?.sessions || 0) - (cp.sessions_used || 0),
      sessions_total: cp.packages?.sessions || 0,
    }));

  return res.json({ packages: available });
});

/**
 * POST /api/booking/:slug/validate-code
 * Public endpoint — validates a discount code (promo code or gift voucher)
 * and returns the discount info so the booking page can show the savings.
 * Single input field handles both code types — tries promo_codes first, then gift_vouchers.
 */
router.post('/:slug/validate-code', async (req, res) => {
  const { code } = req.body;
  if (!code || typeof code !== 'string' || !code.trim()) {
    return res.status(400).json({ valid: false, error: 'Code is required' });
  }

  const normalised = code.trim().toUpperCase();

  // Look up beautician from slug
  const { data: beautician } = await supabase
    .from('beauticians')
    .select('id')
    .eq('booking_slug', req.params.slug)
    .single();

  if (!beautician) return res.status(404).json({ valid: false, error: 'Booking page not found' });

  const now = new Date().toISOString();

  // 1. Try promo_codes
  const { data: promo } = await supabase
    .from('promo_codes')
    .select('id, code, discount_type, discount_value, max_uses, current_uses, valid_from, valid_until, is_active')
    .eq('beautician_id', beautician.id)
    .eq('code', normalised)
    .maybeSingle();

  if (promo) {
    if (!promo.is_active) return res.status(400).json({ valid: false, error: 'This code is no longer active' });
    if (now < promo.valid_from) return res.status(400).json({ valid: false, error: 'This code is not yet valid' });
    if (now > promo.valid_until) return res.status(400).json({ valid: false, error: 'This code has expired' });
    if (promo.max_uses && promo.current_uses >= promo.max_uses) {
      return res.status(400).json({ valid: false, error: 'This code has reached its usage limit' });
    }

    return res.json({
      valid: true,
      type: 'promo',
      code: promo.code,
      discount_type: promo.discount_type,   // 'percentage' or 'fixed'
      discount_value: promo.discount_value,  // percentage int or pence int
      promo_id: promo.id,
    });
  }

  // 2. Try gift_vouchers
  const { data: voucher } = await supabase
    .from('gift_vouchers')
    .select('id, code, amount, status')
    .eq('beautician_id', beautician.id)
    .eq('code', normalised)
    .maybeSingle();

  if (voucher) {
    if (voucher.status !== 'active') {
      return res.status(400).json({ valid: false, error: 'This voucher has already been used or cancelled' });
    }
    return res.json({
      valid: true,
      type: 'voucher',
      code: voucher.code,
      discount_type: 'fixed',
      discount_value: voucher.amount,   // amount in pence
      voucher_id: voucher.id,
    });
  }

  // Nothing matched
  return res.status(404).json({ valid: false, error: 'Code not recognised' });
});

/**
 * POST /api/booking/:slug/book
 * Public endpoint — creates a booking from the booking page.
 * Creates or finds the client, creates the appointment.
 * If deposit is required and beautician has Stripe Connect, creates a
 * Checkout session and returns checkout_url for redirect.
 * Returning clients with a saved Stripe customer see their saved cards.
 */
router.post('/:slug/book', validate(bookingSchema), verifyTurnstile, async (req, res) => {
  const { treatment_id, extra_treatment_ids, starts_at, client_name, client_email, client_phone, notes, consultation, add_ons, payment_type, payment_method, discount_code, photo_consent, client_package_id, marketing_opt_in } = req.body;

  // Get beautician from slug (include Stripe fields, booking policy, payment settings)
  const { data: beautician } = await supabase
    .from('beauticians')
    .select('id, business_name, first_name, stripe_account_id, stripe_onboarding_complete, booking_policy, payment_settings')
    .eq('booking_slug', req.params.slug)
    .single();

  if (!beautician) return res.status(404).json({ error: 'Booking page not found' });

  // Get primary treatment (including deposit_percent for percentage-based deposits)
  const { data: treatment } = await supabase
    .from('treatments')
    .select('*, deposit_percent, consultation_form_id')
    .eq('id', treatment_id)
    .eq('beautician_id', beautician.id)
    .single();

  if (!treatment) return res.status(404).json({ error: 'Treatment not found' });

  // PECR: an existing client actively ticking the consent box upgrades their
  // consent (never downgrades; leaving it unticked means "no change").
  if (marketing_opt_in) {
    supabase.from('clients')
      .update({ marketing_consent: true, marketing_consent_at: new Date().toISOString(), marketing_opted_out_at: null })
      .eq('beautician_id', beautician.id)
      .ilike('phone', `%${String(client_phone || '').replace(/\D/g, '').slice(-9)}`)
      .then(() => {}, () => {});
  }

  // SECURITY: re-price add-ons from the DB. Never trust client-supplied price_cents —
  // a tampered request could otherwise set add-ons to 0p and underpay the deposit/total.
  if (add_ons && add_ons.length > 0) {
    const { data: dbAddOns } = await supabase
      .from('add_ons')
      .select('id, price_cents, is_active')
      .eq('beautician_id', beautician.id)
      .in('id', add_ons.map(ao => ao.id));
    const priceById = Object.fromEntries((dbAddOns || []).filter(a => a.is_active).map(a => [a.id, a.price_cents]));
    for (const ao of add_ons) {
      if (priceById[ao.id] === undefined) {
        return res.status(400).json({ error: 'Invalid add-on selected' });
      }
      ao.price_cents = priceById[ao.id];
    }
  }

  let extraTreatments = [];
  if (extra_treatment_ids && extra_treatment_ids.length > 0) {
    const { data: extras } = await supabase
      .from('treatments')
      .select('id, name, duration_minutes, buffer_minutes, price_cents, deposit_cents, deposit_percent')
      .in('id', extra_treatment_ids)
      .eq('beautician_id', beautician.id);
    extraTreatments = extras || [];
    if (extraTreatments.length !== extra_treatment_ids.length) {
      return res.status(404).json({ error: 'One or more selected treatments not found' });
    }
  }
  const allTreatments = [treatment, ...extraTreatments];
  const combinedDuration = allTreatments.reduce((sum, t) => sum + (t.duration_minutes || 0), 0);
  const combinedBuffer = Math.max(...allTreatments.map(t => t.buffer_minutes || 0)); // use longest buffer, not sum
  const combinedPriceCents = allTreatments.reduce((sum, t) => sum + (t.price_cents || 0), 0);

  // Block appointments in the past
  const startsAtCheck = new Date(starts_at);
  if (startsAtCheck < new Date()) {
    return res.status(400).json({ error: 'Cannot book an appointment in the past' });
  }

  // Enforce minimum booking window
  const bookingPolicy = beautician.booking_policy || {};
  const minHours = bookingPolicy.min_booking_hours || 0;
  if (minHours > 0) {
    const hoursUntil = (startsAtCheck - new Date()) / (1000 * 60 * 60);
    if (hoursUntil < minHours) {
      return res.status(400).json({
        error: `Bookings must be made at least ${minHours} hour${minHours !== 1 ? 's' : ''} in advance. Please choose a later time.`
      });
    }
  }

  // Validate appointment falls within working hours
  const { data: beauticianHours } = await supabase
    .from('beauticians')
    .select('working_hours')
    .eq('id', beautician.id)
    .single();

  if (beauticianHours?.working_hours) {
    const dayKey = startsAtCheck.toLocaleDateString('en-US', { weekday: 'short' }).toLowerCase();
    const hours = beauticianHours.working_hours[dayKey];

    if (!hours) {
      return res.status(400).json({ error: 'Not available on this day' });
    }

    const [startH, startM] = hours.start.split(':').map(Number);
    const [endH, endM] = hours.end.split(':').map(Number);
    const apptHour = startsAtCheck.getUTCHours();
    const apptMin = startsAtCheck.getUTCMinutes();
    const apptTime = apptHour * 60 + apptMin;
    const workStart = startH * 60 + startM;
    const workEnd = endH * 60 + endM;

    if (apptTime < workStart || apptTime >= workEnd) {
      return res.status(400).json({ error: 'Requested time is outside working hours' });
    }
  }

  // Find or create client (track whether new for consultation form trigger)
  const nameParts = client_name.trim().split(' ');
  const firstName = nameParts[0];
  const lastName = nameParts.slice(1).join(' ') || null;

  let client;
  let isNewClient = false;

  // Try to find existing client by phone
  const { data: existingClient } = await supabase
    .from('clients')
    .select('id, stripe_customer_id')
    .eq('beautician_id', beautician.id)
    .eq('phone', client_phone)
    .maybeSingle();

  if (existingClient) {
    client = existingClient;
  } else {
    // Create new client
    const { data: newClient, error: cError } = await supabase
      .from('clients')
      .insert({
        beautician_id: beautician.id,
        first_name: firstName,
        last_name: lastName,
        email: client_email || null,
        phone: client_phone,
        status: 'new',
        // PECR: consent only when the box was actively ticked
        ...(marketing_opt_in && { marketing_consent: true, marketing_consent_at: new Date().toISOString() }),
      })
      .select('id, stripe_customer_id')
      .single();

    if (cError) return res.status(500).json({ error: 'Failed to create client record' });
    client = newClient;
    isNewClient = true;
  }

  // Calculate times (use combined duration for multi-treatment bookings)
  const totalMinutes = combinedDuration + combinedBuffer;
  const startsDate = new Date(starts_at);
  const endsDate = new Date(startsDate.getTime() + totalMinutes * 60 * 1000);

  // Conflict check
  const { data: conflicts } = await supabase
    .from('appointments')
    .select('id')
    .eq('beautician_id', beautician.id)
    .in('status', ['confirmed', 'pending'])
    .lt('starts_at', endsDate.toISOString())
    .gt('ends_at', startsDate.toISOString());

  if (conflicts && conflicts.length > 0) {
    return res.status(409).json({ error: 'This time slot is no longer available' });
  }

  // Build client_notes — combine free text notes + consultation form answers
  let clientNotes = notes || null;
  if (consultation && Object.keys(consultation).length > 0) {
    clientNotes = JSON.stringify({ notes: notes || '', consultation });
  }

  let discountCents = 0;
  let discountMeta = null;  // stored on appointment for audit trail

  if (discount_code) {
    const normalised = discount_code.trim().toUpperCase();
    const now = new Date().toISOString();

    // Try promo code first
    const { data: promo } = await supabase
      .from('promo_codes')
      .select('id, code, discount_type, discount_value, max_uses, current_uses, valid_from, valid_until, is_active')
      .eq('beautician_id', beautician.id)
      .eq('code', normalised)
      .maybeSingle();

    if (promo && promo.is_active && now >= promo.valid_from && now <= promo.valid_until
        && (!promo.max_uses || promo.current_uses < promo.max_uses)) {
      const treatmentTotal = combinedPriceCents + (add_ons || []).reduce((s, ao) => s + ao.price_cents, 0);
      if (promo.discount_type === 'percentage') {
        discountCents = Math.round(treatmentTotal * promo.discount_value / 100);
      } else {
        discountCents = Math.min(promo.discount_value, treatmentTotal);
      }
      discountMeta = { type: 'promo', code: promo.code, promo_id: promo.id, discount_type: promo.discount_type, discount_value: promo.discount_value, discount_cents: discountCents };

      // Increment usage count
      await supabase.from('promo_codes').update({ current_uses: (promo.current_uses || 0) + 1 }).eq('id', promo.id);
    }

    // Try gift voucher if promo didn't match
    if (!discountMeta) {
      const { data: voucher } = await supabase
        .from('gift_vouchers')
        .select('id, code, amount, status')
        .eq('beautician_id', beautician.id)
        .eq('code', normalised)
        .maybeSingle();

      if (voucher && voucher.status === 'active') {
        const treatmentTotal = combinedPriceCents + (add_ons || []).reduce((s, ao) => s + ao.price_cents, 0);
        discountCents = Math.min(voucher.amount, treatmentTotal);
        discountMeta = { type: 'voucher', code: voucher.code, voucher_id: voucher.id, discount_cents: discountCents };

        // Mark voucher as redeemed
        await supabase.from('gift_vouchers').update({ status: 'redeemed', redeemed_at: new Date().toISOString() }).eq('id', voucher.id);
      }
    }

    // If code was provided but nothing matched, that's fine — we just don't apply a discount.
    // The frontend already validated it, so this is a safety net.
  }

  let isPackageRedemption = false;
  if (client_package_id && client) {
    // Verify the package belongs to this client, is active, and has sessions left
    const { data: clientPkg } = await supabase
      .from('client_packages')
      .select('id, sessions_used, package_id, client_id, packages(sessions, treatment_ids)')
      .eq('id', client_package_id)
      .eq('beautician_id', beautician.id)
      .eq('status', 'active')
      .maybeSingle();

    if (clientPkg && clientPkg.client_id === client.id) {
      const totalSessions = clientPkg.packages?.sessions || 0;
      const used = clientPkg.sessions_used || 0;
      if (used < totalSessions) {
        isPackageRedemption = true;
        // Increment sessions_used
        await supabase
          .from('client_packages')
          .update({
            sessions_used: used + 1,
            // Auto-complete if all sessions now used
            ...(used + 1 >= totalSessions && { status: 'completed' }),
          })
          .eq('id', client_package_id);
      }
    }
  }

  // Package redemptions skip payment entirely — session already paid for
  let depositCents = 0;
  let isFullPayment = false;
  let depositRequired = false;
  const addOnSum = (add_ons || []).reduce((s, ao) => s + ao.price_cents, 0);

  // Cash/bank transfer bookings confirm immediately — no online payment collected
  const isOfflinePayment = payment_method === 'cash' || payment_method === 'bank_transfer';

  if (!isPackageRedemption) {
    // Calculate deposit: sum deposits across all treatments (multi-treatment aware)
    depositCents = allTreatments.reduce((sum, t) => {
      if (t.deposit_percent > 0 && t.price_cents > 0) {
        return sum + Math.round(t.price_cents * t.deposit_percent / 100);
      }
      return sum + (t.deposit_cents || 0);
    }, 0);

    // Apply global require_deposit override (only for card payments)
    const paySettings = beautician.payment_settings || {};
    if (!isOfflinePayment && paySettings.require_deposit && depositCents === 0 && combinedPriceCents > 0) {
      // Parse global deposit amount setting (e.g. '£10', '£15', '50%')
      const dAmt = paySettings.deposit_amount || '£10';
      if (dAmt.endsWith('%')) {
        depositCents = Math.round(combinedPriceCents * parseInt(dAmt) / 100);
      } else {
        depositCents = Math.round(parseFloat(dAmt.replace('£', '')) * 100);
      }
    }

    // If client chose to pay full amount, charge treatment price + add-ons minus discount
    isFullPayment = payment_type === 'full' && combinedPriceCents > 0;

    // Offline payments never require online deposit — appointment confirmed directly
    depositRequired = !isOfflinePayment && (depositCents > 0 || isFullPayment);
  }

  // Payment buffer: if enabled, set expiry timestamp
  const bufferEnabled = bookingPolicy.payment_buffer_enabled && depositRequired;
  const paymentExpiresAt = bufferEnabled
    ? new Date(Date.now() + (bookingPolicy.payment_buffer_minutes || 10) * 60 * 1000).toISOString()
    : null;

  // Create appointment (uses combined duration/price for multi-treatment bookings)
  const { data: appointment, error: aError } = await supabase
    .from('appointments')
    .insert({
      beautician_id: beautician.id,
      client_id: client.id,
      treatment_id,
      starts_at,
      ends_at: endsDate.toISOString(),
      duration_minutes: combinedDuration,
      buffer_minutes: combinedBuffer,
      price_cents: combinedPriceCents,
      deposit_cents: depositCents,
      payment_type: isFullPayment ? 'full' : 'deposit',
      client_notes: clientNotes,
      booked_via: 'booking_page',
      payment_method: payment_method || 'card',
      status: depositRequired ? 'pending' : 'confirmed',
      client_email: client_email ? client_email.toLowerCase().trim() : null,
      policy_snapshot: bookingPolicy,
      ...(paymentExpiresAt && { payment_expires_at: paymentExpiresAt }),
      ...(discountMeta && { discount_meta: discountMeta, discount_cents: discountCents }),
      ...(photo_consent && { photo_consent: true }),
      ...(isPackageRedemption && { package_redemption: true, client_package_id }),
      ...(extraTreatments.length > 0 && { extra_treatment_ids: extraTreatments.map(t => t.id) }),
    })
    .select()
    .single();

  if (aError) {
    logger.error({ err: aError }, 'Appointment insert error');
    return res.status(500).json({ error: 'Failed to create booking' });
  }

  // Insert add-ons (if any selected)
  if (add_ons && add_ons.length > 0) {
    const addOnRows = add_ons.map(ao => ({
      appointment_id: appointment.id,
      add_on_id: ao.id,
      price_cents: ao.price_cents,
    }));
    const { error: aoErr } = await supabase.from('appointment_add_ons').insert(addOnRows);
    if (aoErr) logger.warn({ err: aoErr }, 'Add-on insert failed (non-fatal)');
  }

  // Calculate total including add-ons for Stripe line items
  const addOnTotalCents = (add_ons || []).reduce((sum, ao) => sum + ao.price_cents, 0);

  // Build display name for all treatments
  const treatmentNames = allTreatments.map(t => t.name).join(' + ');

  // Log AI action (supabase returns thenable, not a Promise — use .then() not .catch())
  const { error: logErr } = await supabase.from('ai_actions').insert({
    beautician_id: beautician.id,
    action_type: 'booking_created',
    digital_employee: 'front_desk',
    summary: `${firstName} booked ${treatmentNames} for ${startsDate.toLocaleDateString('en-GB')} at ${startsDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`,
    details: { appointment_id: appointment.id, treatment: treatmentNames, treatments: allTreatments.map(t => ({ id: t.id, name: t.name })), client_name },
    client_id: client.id,
    appointment_id: appointment.id,
    confidence: 1.0,
    autonomous: false,
    outcome: 'success',
    notification_sent: true,
    notification_text: `New booking: ${firstName} — ${treatmentNames}, ${startsDate.toLocaleDateString('en-GB')} at ${startsDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
  });
  if (logErr) logger.warn({ err: logErr }, 'AI action log failed (non-fatal)');

  // Push notification — beautician gets a team-style alert
  const timeStr = startsDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const dateStr = startsDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  pushNewBooking(beautician.id, firstName, treatmentNames, `${dateStr} at ${timeStr}`).catch(() => {});

  // If deposit required but Stripe isn't configured, return booking with deposit_pending flag
  // so the frontend can show an appropriate message instead of silently skipping payment.
  if (depositRequired && (!stripe || !beautician.stripe_account_id || !beautician.stripe_onboarding_complete)) {
    // Booking created as 'pending' (beautician needs to complete Stripe setup or collect deposit manually).
    // Don't fire the confirmation notification yet; the booking isn't actually confirmed until payment lands.
    if (appointment.status === 'confirmed') {
      notifyBookingConfirmed(appointment.id).catch(err =>
        logger.warn({ err }, 'Booking confirmation notification failed (non-fatal)')
      );
    }

    // Send consultation form to first-time clients (non-blocking)
    if (isNewClient && client_phone) {
      sendConsultationFormSMS({
        beauticianId: beautician.id,
        clientId: client.id,
        appointmentId: appointment.id,
        clientPhone: client_phone,
        clientFirstName: firstName,
        treatmentId: treatment_id,
        beauticianName: beautician.business_name || beautician.first_name,
      }).catch(err =>
        logger.warn({ err }, 'Consultation form SMS failed (non-fatal)')
      );
    }

    return res.status(201).json({
      booking: {
        id: appointment.id,
        managementToken: appointment.management_token,
        manageUrl: `${FRONTEND_URL}/book/${req.params.slug}/manage/${appointment.management_token}`,
        treatment: treatmentNames,
        treatments: allTreatments.map(t => ({ id: t.id, name: t.name, price_cents: t.price_cents })),
        date: startsDate.toLocaleDateString('en-GB'),
        time: startsDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
        price: `£${(combinedPriceCents / 100).toFixed(2)}`,
        deposit: `£${(depositCents / 100).toFixed(2)}`,
        status: 'pending',
        deposit_pending: true,
      },
      // No checkout_url — Stripe not ready
      deposit_note: 'Deposit required — your beautician will send a payment link to confirm your booking.',
    });
  }

  // If deposit required and beautician has Stripe Connect, create Checkout session.
  // Returning clients with a saved stripe_customer_id see saved payment methods.
  if (depositRequired && stripe && beautician.stripe_account_id && beautician.stripe_onboarding_complete) {
    try {
      const bookingSlug = req.params.slug;
      const dateLabel = startsDate.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

      // Ensure client has a Stripe Customer for saved card reuse
      let stripeCustomerId = client.stripe_customer_id;
      if (!stripeCustomerId) {
        const customer = await stripe.customers.create({
          name: client_name,
          email: client_email || undefined,
          phone: client_phone,
          metadata: { client_id: client.id, beautician_id: beautician.id },
        });
        stripeCustomerId = customer.id;
        await supabase.from('clients').update({ stripe_customer_id: stripeCustomerId }).eq('id', client.id);
      }

      // Build line items: treatment payment (deposit or full) + add-on costs
      // For multi-treatment bookings, show each treatment as a line item when paying in full
      const lineItems = [];

      if (isFullPayment) {
        // Full payment: one line per treatment (discount applied to first)
        let remainingDiscount = discountCents;
        for (const t of allTreatments) {
          let amount = t.price_cents;
          if (remainingDiscount > 0) {
            const applied = Math.min(remainingDiscount, amount);
            amount -= applied;
            remainingDiscount -= applied;
          }
          lineItems.push({
            price_data: {
              currency: 'gbp',
              product_data: {
                name: discountCents > 0 && t === treatment ? `${t.name} (${discountMeta?.code} applied)` : t.name,
                description: `${dateLabel} at ${startsDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} with ${beautician.business_name || beautician.first_name}`,
              },
              unit_amount: Math.max(0, amount),
            },
            quantity: 1,
          });
        }
      } else {
        // Deposit: single combined line item
        const label = allTreatments.length > 1
          ? `${treatmentNames} — deposit`
          : `${treatment.name} — deposit`;
        lineItems.push({
          price_data: {
            currency: 'gbp',
            product_data: {
              name: label,
              description: `${dateLabel} at ${startsDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} with ${beautician.business_name || beautician.first_name}`,
            },
            unit_amount: depositCents,
          },
          quantity: 1,
        });
      }
      const treatmentAmountCents = isFullPayment ? Math.max(0, combinedPriceCents - discountCents) : depositCents;

      // Add each add-on as a separate line item (full price, not deposit)
      if (add_ons && add_ons.length > 0) {
        // Fetch add-on names from DB
        const { data: addOnDetails } = await supabase
          .from('add_ons')
          .select('id, name')
          .in('id', add_ons.map(ao => ao.id));
        const nameMap = Object.fromEntries((addOnDetails || []).map(a => [a.id, a.name]));

        for (const ao of add_ons) {
          lineItems.push({
            price_data: {
              currency: 'gbp',
              product_data: { name: nameMap[ao.id] || 'Add-on' },
              unit_amount: ao.price_cents,
            },
            quantity: 1,
          });
        }
      }

      // Calculate total for platform fee (treatment payment + add-ons)
      const checkoutTotalCents = treatmentAmountCents + addOnTotalCents;
      const platformFee = calculatePlatformFee(checkoutTotalCents);

      // Public base of THIS backend (the booking request came in on it), so the
      // checkout success redirect lands on our confirm endpoint, not the SPA.
      const apiBase = `${req.headers['x-forwarded-proto'] || 'https'}://${req.get('host')}`;

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer: stripeCustomerId,
        line_items: lineItems,
        payment_intent_data: {
          application_fee_amount: platformFee,
          transfer_data: {
            destination: beautician.stripe_account_id,
          },
          setup_future_usage: 'off_session', // saves card for returning clients
          metadata: {
            appointment_id: appointment.id,
            beautician_id: beautician.id,
            client_id: client.id,
            platform_fee_cents: platformFee,
            payment_type: isFullPayment ? 'full' : 'deposit',
          },
        },
        success_url: `${apiBase}/api/booking/confirm/{CHECKOUT_SESSION_ID}?slug=${bookingSlug}&mt=${appointment.management_token}`,
        cancel_url: `${FRONTEND_URL}/book/${bookingSlug}?cancelled=true`,
        metadata: {
          appointment_id: appointment.id,
          beautician_id: beautician.id,
          client_id: client.id,
          payment_type: isFullPayment ? 'full' : 'deposit',
        },
      });

      // Store payment intent on the appointment
      await supabase.from('appointments').update({
        stripe_payment_intent_id: session.payment_intent,
        deposit_amount_cents: depositCents,
        deposit_status: 'pending',
      }).eq('id', appointment.id);

      // Don't fire confirmation here. The booking is still 'pending' until the Stripe webhook
      // (checkout.session.completed) marks the deposit paid and triggers notifyBookingConfirmed.
      if (appointment.status === 'confirmed') {
        notifyBookingConfirmed(appointment.id).catch(err =>
          logger.warn({ err }, 'Booking confirmation notification failed (non-fatal)')
        );
      }

      // Send consultation form to first-time clients (non-blocking)
      if (isNewClient && client_phone) {
        sendConsultationFormSMS({
          beauticianId: beautician.id,
          clientId: client.id,
          appointmentId: appointment.id,
          clientPhone: client_phone,
          clientFirstName: firstName,
          treatmentId: treatment_id,
          beauticianName: beautician.business_name || beautician.first_name,
        }).catch(err =>
          logger.warn({ err }, 'Consultation form SMS failed (non-fatal)')
        );
      }

      return res.status(201).json({
        booking: {
          id: appointment.id,
          managementToken: appointment.management_token,
          manageUrl: `${FRONTEND_URL}/book/${req.params.slug}/manage/${appointment.management_token}`,
          treatment: treatmentNames,
          treatments: allTreatments.map(t => ({ id: t.id, name: t.name, price_cents: t.price_cents })),
          date: startsDate.toLocaleDateString('en-GB'),
          time: startsDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
          price: `£${(combinedPriceCents / 100).toFixed(2)}`,
          deposit: isFullPayment ? null : `£${(depositCents / 100).toFixed(2)}`,
          payment_type: isFullPayment ? 'full' : 'deposit',
          amount_charged: `£${(checkoutTotalCents / 100).toFixed(2)}`,
          status: 'pending',
          paymentExpiresAt: paymentExpiresAt || null,
          ...(discountMeta && { discount: { code: discountMeta.code, type: discountMeta.type, saved: `£${(discountCents / 100).toFixed(2)}` } }),
        },
        checkout_url: session.url,
      });
    } catch (err) {
      logger.error({ err }, 'Stripe checkout creation failed');
      // Booking was created but payment setup failed — still return the booking
      // The beautician can send a payment link manually
    }
  }

  // No deposit or Stripe not configured — booking is confirmed immediately
  // Fire confirmation notification (non-blocking)
  notifyBookingConfirmed(appointment.id).catch(err =>
    logger.warn({ err }, 'Booking confirmation notification failed (non-fatal)')
  );

  // Send consultation form to first-time clients (non-blocking)
  if (isNewClient && client_phone) {
    sendConsultationFormSMS({
      beauticianId: beautician.id,
      clientId: client.id,
      appointmentId: appointment.id,
      clientPhone: client_phone,
      clientFirstName: firstName,
      treatmentId: treatment_id,
      beauticianName: beautician.business_name || beautician.first_name,
    }).catch(err =>
      logger.warn({ err }, 'Consultation form SMS failed (non-fatal)')
    );
  }

  res.status(201).json({
    booking: {
      id: appointment.id,
      managementToken: appointment.management_token,
      manageUrl: `${FRONTEND_URL}/book/${req.params.slug}/manage/${appointment.management_token}`,
      treatment: treatmentNames,
      treatments: allTreatments.map(t => ({ id: t.id, name: t.name, price_cents: t.price_cents })),
      date: startsDate.toLocaleDateString('en-GB'),
      time: startsDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      price: `£${(combinedPriceCents / 100).toFixed(2)}`,
      deposit: null,
      status: appointment.status,
      paymentExpiresAt: paymentExpiresAt || null,
    }
  });
});

export default router;
