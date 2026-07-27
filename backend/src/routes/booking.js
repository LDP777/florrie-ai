import { Router } from 'express';
import { z } from 'zod';
import Stripe from 'stripe';
import { supabase } from '../config.js';
import { notifyBookingConfirmed } from '../services/notifications.js';
import { pushNewBooking, pushBookingConfirmed, pushReschedule, pushPatchTestBooked, pushClientCancelled, pushTeamUpdate } from '../services/push-notifications.js';
import { refreshLiveActivity } from '../services/live-activity.js';
import { sendConsultationFormSMS } from './consultation-forms.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { calculatePlatformFee } from '../lib/platform-fees.js';
import { chargePolicyFee, computePolicyFee, chargeRescheduleDeposit } from '../services/policy-fees.js';
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
          // The Stripe webhook has never fired in production (stripe_events is
          // empty), so this redirect is the ONLY path that completes a booking.
          // It therefore has to do the webhook's other two jobs as well, or they
          // simply never happen:
          //
          //  1. LOG THE DEPOSIT as a transaction. Without this every deposit the
          //     client actually paid is missing from Ellie's Money tab.
          //  2. PIN THE SAVED CARD onto the appointment. Checkout runs with
          //     setup_future_usage 'off_session', so Stripe attaches the card to
          //     the customer either way, but pinning the exact payment method is
          //     what makes a later no-show / balance charge direct and reliable.
          (async () => {
            try {
              const { data: full } = await supabase
                .from('appointments')
                .select('beautician_id, client_id, deposit_cents, payment_type')
                .eq('id', appointmentId).maybeSingle();
              if (!full) return;

              // 1. deposit transaction (guarded so a retry cannot double-log)
              const { data: already } = await supabase
                .from('transactions')
                .select('id')
                .eq('appointment_id', appointmentId)
                .in('type', ['deposit', 'full_payment'])
                .limit(1);
              if (!already?.length) {
                await supabase.from('transactions').insert({
                  beautician_id: full.beautician_id,
                  appointment_id: appointmentId,
                  client_id: full.client_id || null,
                  amount_cents: session.amount_total ?? full.deposit_cents ?? 0,
                  type: full.payment_type === 'full' ? 'full_payment' : 'deposit',
                  status: 'completed',
                  stripe_payment_intent_id: session.payment_intent || null,
                  payment_method: 'card_online',
                });
              }

              // 2. remember the card for later off-session charges
              if (session.customer && full.client_id) {
                await supabase.from('clients')
                  .update({ stripe_customer_id: session.customer })
                  .eq('id', full.client_id);
              }
              if (session.payment_intent) {
                const pi = await stripe.paymentIntents.retrieve(session.payment_intent);
                const pmId = typeof pi.payment_method === 'string' ? pi.payment_method : pi.payment_method?.id;
                if (pmId) {
                  await supabase.from('appointments')
                    .update({ stripe_payment_method_id: pmId })
                    .eq('id', appointmentId);
                }
              }
            } catch (e) {
              logger.warn({ err: e, appointmentId }, 'confirm-redirect: deposit log / card pin failed (non-fatal)');
            }
          })();

          const { notifyBookingConfirmed } = await import('../services/notifications.js');
          notifyBookingConfirmed(appointmentId).catch(err =>
            logger.warn({ err, appointmentId }, 'confirm-redirect: notification failed (non-fatal)')
          );
          logger.info({ appointmentId, sessionId }, 'Booking confirmed via success-redirect (webhook fallback)');
          // Push the beautician the "booked - deposit paid" confirmation too. The
          // Stripe webhook also does this, but the deposit_paid guard above means
          // only ONE path (whichever confirmed first) fires, so no duplicate.
          (async () => {
            try {
              const { data: ca } = await supabase
                .from('appointments')
                .select('beautician_id, starts_at, clients(first_name), treatments(name)')
                .eq('id', appointmentId).maybeSingle();
              if (!ca) return;
              const cday = String(ca.starts_at || '').slice(0, 10);
              const ctime = String(ca.starts_at || '').slice(11, 16);
              const clabel = cday ? `${new Date(`${cday}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} at ${ctime}` : 'their appointment';
              await pushBookingConfirmed(ca.beautician_id, ca.clients?.first_name || 'A client', ca.treatments?.name || 'their treatment', clabel, { appointmentId, apptDate: ca.starts_at });
            } catch (e) { logger.warn({ err: e, appointmentId }, 'confirm-redirect: beautician push failed (non-fatal)'); }
          })();
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

  // Get active, bookable treatments (never show £0 placeholders to clients).
  const { data: treatments } = await supabase
    .from('treatments')
    .select('id, name, description, duration_minutes, price_cents, deposit_cents, category')
    .eq('beautician_id', beautician.id)
    .eq('is_active', true)
    .eq('booking_enabled', true)
    .gt('price_cents', 0)
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
    .select('id, first_name, business_name, booking_slug, brand_color, working_hours, payment_settings, stripe_onboarding_complete, avatar_url, logo_url, tagline, booking_policy, address')
    .eq('booking_slug', req.params.slug)
    .maybeSingle();

  if (error || !salon) {
    return res.status(404).json({ error: 'not_found' });
  }

  const { data: treatments } = await supabase
    .from('treatments')
    .select('id, name, description, duration_minutes, price_cents, deposit_cents, deposit_percent, category, requires_consultation, requires_patch_test, consultation_form_id')
    .eq('beautician_id', salon.id)
    .eq('is_active', true)
    // Must be bookable and have a real price. Imported placeholders are inactive
    // and £0, but a restored-not-yet-priced one could leak onto a client's page,
    // so guard on both here (never show 'Imported'/£0 services to clients).
    .eq('booking_enabled', true)
    .gt('price_cents', 0)
    .order('sort_order', { ascending: true });

  const { data: addOns } = await supabase
    .from('add_ons')
    .select('id, name, description, price_cents, duration_minutes, compatible_treatment_ids, is_active')
    .eq('beautician_id', salon.id)
    .eq('is_active', true)
    .order('name');

  // Loyalty flag so the public page can mention points (booking-safe boolean only)
  const { data: loyaltyConfig } = await supabase
    .from('loyalty_config')
    .select('is_active')
    .eq('beautician_id', salon.id)
    .maybeSingle();

  res.json({
    salon: { ...salon, loyalty_enabled: loyaltyConfig?.is_active === true },
    treatments: treatments || [],
    addOns: addOns || [],
  });
});

/**
 * GET /api/booking/:slug/reviews
 * Public — read-only review summary for the booking page. Returns only
 * booking-safe fields (rating, comment, reviewer first name, date), never
 * client contact data. The page hides the section when there are none.
 */
router.get('/:slug/reviews', async (req, res) => {
  try {
    const { data: salon } = await supabase
      .from('beauticians')
      .select('id')
      .eq('booking_slug', req.params.slug)
      .maybeSingle();
    if (!salon) return res.status(404).json({ error: 'not_found' });

    const { data: rows } = await supabase
      .from('reviews')
      .select('rating, comment, created_at, clients(first_name)')
      .eq('beautician_id', salon.id)
      .eq('is_public', true)
      .not('rating', 'is', null)
      .order('created_at', { ascending: false })
      .limit(50);

    const reviews = rows || [];
    const count = reviews.length;
    const average = count
      ? Math.round((reviews.reduce((sum, r) => sum + (r.rating || 0), 0) / count) * 10) / 10
      : 0;
    const recent = reviews
      .filter(r => (r.comment || '').trim().length > 0)
      .slice(0, 3)
      .map(r => ({
        rating: r.rating,
        comment: r.comment,
        first_name: r.clients?.first_name || null,
        created_at: r.created_at,
      }));

    res.json({ count, average, recent });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch public reviews');
    // Fail soft: the booking page simply hides the section.
    res.json({ count: 0, average: 0, recent: [] });
  }
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

  // Blocked-off time for the day: partial (amended) blocks come back with
  // their time range so the picker can grey those slots out; anything
  // without a usable range is treated as a full-day closure.
  const { data: exceptionRows } = await supabase
    .from('hours_exceptions')
    .select('type, start_time, end_time')
    .eq('beautician_id', salon.id)
    .eq('date', date);

  const blocks = [];
  let dayClosed = false;
  for (const r of exceptionRows || []) {
    if (r.type !== 'closed' && r.start_time && r.end_time) {
      blocks.push({ start_time: r.start_time, end_time: r.end_time });
    } else {
      dayClosed = true;
    }
  }

  res.json({ appointments: appts || [], blocks, closed: dayClosed });
});

/**
 * GET /api/booking/:slug/availability-range?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Public — one call returns a whole month's booked blocks + fully-closed days,
 * so the booking calendar can mark which days actually have space without a
 * request per day. Returns only timing (no client info). Service role.
 */
router.get('/:slug/availability-range', async (req, res) => {
  const { from, to } = req.query;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!from || !to || !dateRe.test(from) || !dateRe.test(to)) {
    return res.status(400).json({ error: 'from and to (YYYY-MM-DD) are required' });
  }

  const { data: salon } = await supabase
    .from('beauticians')
    .select('id')
    .eq('booking_slug', req.params.slug)
    .maybeSingle();
  if (!salon) return res.status(404).json({ error: 'not_found' });

  const { data: appts } = await supabase
    .from('appointments')
    .select('starts_at, duration_minutes, buffer_minutes')
    .eq('beautician_id', salon.id)
    .gte('starts_at', `${from}T00:00:00`)
    .lte('starts_at', `${to}T23:59:59`)
    .not('status', 'in', '(cancelled,cancelled_by_client,cancelled_by_beautician,rescheduled)');

  // Blocked-off time: full-day closures AND partial-day (amended) blocks.
  // Previously only type='closed' was returned, so a client could book
  // straight into an hour the beautician had blocked out.
  const { data: exceptionRows } = await supabase
    .from('hours_exceptions')
    .select('date, type, start_time, end_time')
    .eq('beautician_id', salon.id)
    .gte('date', from)
    .lte('date', to);

  const closures = [];
  const blocks = [];
  for (const r of exceptionRows || []) {
    if (r.type !== 'closed' && r.start_time && r.end_time) {
      blocks.push({ date: r.date, start_time: r.start_time, end_time: r.end_time });
    } else {
      closures.push(r.date);
    }
  }

  res.json({
    appointments: appts || [],
    closures,
    blocks,
  });
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

    // Look up client by email OR phone — a match on EITHER field means a
    // returning client. Try email first (most reliable), fall back to phone.
    const selectCols = 'id, first_name, last_name, email, phone';
    let client = null;

    if (email) {
      const { data } = await supabase
        .from('clients')
        .select(selectCols)
        .eq('beautician_id', b.id)
        .ilike('email', email.trim())
        .maybeSingle();
      client = data;
    }

    if (!client && phone) {
      // Match on the last 9 digits so +44 / 0 / spaced formats all resolve to
      // the SAME client (07... == +447...). Same convention as rebook + imports.
      const pd = String(phone).replace(/\D/g, '');
      if (pd.length >= 7) {
        const { data } = await supabase
          .from('clients')
          .select(selectCols)
          .eq('beautician_id', b.id)
          .ilike('phone', `%${pd.slice(-9)}`)
          .limit(1);
        client = data?.[0] || null;
      }
    }

    if (!client) return res.json({ found: false });

    // Fetch their upcoming appointment count + patch test status + what they
    // had last time (for the one-tap "same again?" rebook path)
    const [{ data: upcoming }, { data: pendingTests }, { data: pendingForms }, { data: lastVisit }] = await Promise.all([
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

      supabase
        .from('appointments')
        .select('starts_at, treatments(id, name, duration_minutes, price_cents)')
        .eq('client_id', client.id)
        .eq('beautician_id', b.id)
        .eq('status', 'completed')
        .not('treatment_id', 'is', null)
        .order('starts_at', { ascending: false })
        .limit(1),
    ]);

    // Booking-safe: treatment name/price is already public on this page.
    const lastRow = (lastVisit || [])[0];
    const lastTreatment = lastRow?.treatments
      ? {
          id: lastRow.treatments.id,
          name: lastRow.treatments.name,
          duration_minutes: lastRow.treatments.duration_minutes,
          price_cents: lastRow.treatments.price_cents,
          last_visit: String(lastRow.starts_at || '').slice(0, 10),
        }
      : null;

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
      lastTreatment,
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
        id, starts_at, ends_at, status, management_token, rescheduled_at,
        payment_expires_at, policy_snapshot, client_email,
        price_cents, deposit_cents, deposit_paid, stripe_payment_method_id,
        treatments(id, name, duration_minutes, price_cents, category, requires_patch_test),
        clients(id, first_name, last_name, email, phone, stripe_customer_id),
        beauticians(id, first_name, business_name, booking_policy, booking_slug, brand_color, patch_test_expiry_months, patch_test_block_booking, payment_settings)
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

    // What a late cancellation would cost right now (percent of price minus
    // deposit already paid) and whether we hold a card we can charge it to.
    const { feeCents: lateCancelFeeCents } = computePolicyFee(appt, policy, 'late_cancel');
    const cardOnFile = !!(appt.clients?.stripe_customer_id &&
      (appt.stripe_payment_method_id || appt.deposit_paid));

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
      // Remaining balance after the deposit, plus the beautician's bank details
      // so the client can pay the rest by transfer.
      payment: (() => {
        const priceCents = appt.price_cents || appt.treatments?.price_cents || 0;
        const depositPaidCents = appt.deposit_paid ? (appt.deposit_cents || 0) : 0;
        return {
          priceCents,
          depositPaidCents,
          remainingCents: Math.max(0, priceCents - depositPaidCents),
          bankDetails: appt.beauticians?.payment_settings?.bank_details || null,
        };
      })(),
      policy: {
        ...policy,
        withinCancellationWindow,
        hoursUntil: Math.max(0, Math.round(hoursUntil)),
        lateCancelFeeCents,
        cardOnFile,
        // Reschedule controls come from the LIVE beautician policy, not the
        // frozen snapshot, so toggling them takes effect on existing bookings.
        reschedule_once: appt.beauticians?.booking_policy?.reschedule_once === true,
        reschedule_between_only: appt.beauticians?.booking_policy?.reschedule_between_only === true,
        alreadyRescheduled: !!appt.rescheduled_at,
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
      .select('id, starts_at, status, policy_snapshot, client_id, price_cents, deposit_cents, deposit_paid, stripe_payment_method_id, clients(first_name, stripe_customer_id), beauticians(booking_policy, booking_slug)')
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
    const { feeCents } = computePolicyFee(appt, policy, 'late_cancel');
    const cardOnFile = !!(appt.clients?.stripe_customer_id &&
      (appt.stripe_payment_method_id || appt.deposit_paid));

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

    // Auto-charge the late cancellation fee to the saved card (fire-and-forget;
    // chargePolicyFee is idempotent and only charges when the policy has a fee).
    // A CLIENT cancel happens while Ellie may be asleep, so auto is right here
    // (unlike a no-show she marks herself, which is one-tap).
    if (isLateCancel && feeCents > 0) {
      chargePolicyFee(appt.id, 'late_cancel').catch(err =>
        logger.error({ err, appointmentId: appt.id }, 'late_cancel policy fee charge failed (non-fatal)')
      );
    }

    // Tell Ellie a client cancelled - she was not being notified at all.
    const cancelDateStr = appt.starts_at
      ? new Date(`${String(appt.starts_at).slice(0, 19)}Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
      : 'upcoming';
    pushClientCancelled(appt.beautician_id, appt.clients?.first_name || 'A client', cancelDateStr, { lateCancel: isLateCancel, feeCents: isLateCancel ? feeCents : 0 })
      .catch(err => logger.error({ err, appointmentId: appt.id }, 'client-cancel push failed'));

    const willCharge = isLateCancel && feeCents > 0 && cardOnFile;
    res.json({
      success: true,
      isLateCancel,
      chargePercent: isLateCancel ? (policy.late_cancel_charge_percent || 0) : 0,
      feeCents: isLateCancel ? feeCents : 0,
      message: isLateCancel
        ? (willCharge
          ? `Cancelled. As this is within the ${policy.cancellation_notice_hours || 48}-hour notice period, a £${(feeCents / 100).toFixed(2)} cancellation fee will be charged to the card you used for your deposit.`
          : `Cancelled. As this is within the ${policy.cancellation_notice_hours || 48}-hour notice period, a cancellation fee may apply.`)
        : 'Your appointment has been cancelled.',
    });
  } catch (err) {
    logger.error({ err }, 'Cancel booking failed');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * GET  /api/booking/:slug/manage/:token/treatments
 * POST /api/booking/:slug/manage/:token/change-treatment  { treatment_id }
 *
 * Let the CLIENT swap their treatment on an existing booking. Ellie's case:
 * someone books a full brow lamination four weeks out but only needs the
 * maintenance. Previously neither she nor the client could change it, only the
 * time, so the booking had to be cancelled and rebooked, losing the deposit.
 *
 * THE DEPOSIT DOES NOT MOVE. Whatever they already paid stays exactly as it is:
 * not refunded, not topped up, not recalculated. Only the price and the length
 * follow the new treatment, so the balance owed (price minus deposit) simply
 * works out on its own. That is deliberate, it keeps a swap frictionless and
 * means a downgrade never triggers a refund Ellie has to chase.
 */
router.get('/:slug/manage/:token/treatments', async (req, res) => {
  try {
    const { data: appt } = await supabase
      .from('appointments')
      .select('id, starts_at, client_id, treatment_id, treatments(requires_patch_test), beauticians(id, booking_slug)')
      .eq('management_token', req.params.token)
      .single();
    if (!appt || appt.beauticians?.booking_slug !== req.params.slug) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { data: treatments } = await supabase
      .from('treatments')
      .select('id, name, duration_minutes, price_cents, requires_patch_test')
      .eq('beautician_id', appt.beauticians.id)
      .eq('is_active', true)
      .gt('price_cents', 0)
      .order('sort_order', { ascending: true });

    // A treatment needing a patch test they have not passed is not a valid
    // swap: it would quietly put them into an appointment they cannot have.
    const { data: pts } = await supabase
      .from('patch_tests')
      .select('status, test_date')
      .eq('client_id', appt.client_id)
      .eq('beautician_id', appt.beauticians.id);
    const sixMonthsAgo = new Date(Date.now() - 182 * 24 * 60 * 60 * 1000);
    const hasValidPatchTest = (pts || []).some(pt =>
      pt.status === 'passed' && pt.test_date && new Date(pt.test_date) > sixMonthsAgo);
    // If what they ALREADY booked needs a patch test, they are in that lane
    // and a test is either done or on the way, so swapping to another
    // patch-test treatment adds no new requirement. Without this, the exact
    // swap Ellie asked for (lamination -> lamination maintenance) was hidden.
    const alreadyInPatchTestLane = appt.treatments?.requires_patch_test === true;
    const patchTestOk = hasValidPatchTest || alreadyInPatchTestLane;

    res.json({
      current_treatment_id: appt.treatment_id,
      treatments: (treatments || [])
        .filter(t => !t.requires_patch_test || patchTestOk)
        .map(t => ({ id: t.id, name: t.name, duration_minutes: t.duration_minutes, price_cents: t.price_cents })),
    });
  } catch (err) {
    logger.error({ err }, 'Manage treatments list failed');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

router.post('/:slug/manage/:token/change-treatment', async (req, res) => {
  try {
    const { treatment_id } = req.body || {};
    if (!treatment_id) return res.status(400).json({ error: 'Please choose a treatment.' });

    const { data: appt } = await supabase
      .from('appointments')
      .select(`
        id, starts_at, ends_at, status, client_id, treatment_id,
        price_cents, deposit_cents, deposit_paid, buffer_minutes, extra_padding_minutes,
        clients(first_name),
        treatments(requires_patch_test),
        beauticians(id, booking_slug, working_hours, timezone)
      `)
      .eq('management_token', req.params.token)
      .single();
    if (!appt || appt.beauticians?.booking_slug !== req.params.slug) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (['cancelled', 'completed', 'no_show'].includes(appt.status)) {
      return res.status(409).json({ error: 'This booking can no longer be changed.' });
    }
    if (new Date(`${String(appt.starts_at).slice(0, 19)}Z`) < nowInSalonWall(appt.beauticians.timezone)) {
      return res.status(409).json({ error: 'This appointment has already passed.' });
    }

    const { data: treat } = await supabase
      .from('treatments')
      .select('id, name, duration_minutes, price_cents, requires_patch_test')
      .eq('id', treatment_id)
      .eq('beautician_id', appt.beauticians.id)
      .eq('is_active', true)
      .maybeSingle();
    if (!treat) return res.status(400).json({ error: 'That treatment is not available.' });

    // Same rule as the list above: already booked into a patch-test treatment
    // means swapping to another one adds no new requirement.
    if (treat.requires_patch_test && appt.treatments?.requires_patch_test !== true) {
      const sixMonthsAgo = new Date(Date.now() - 182 * 24 * 60 * 60 * 1000);
      const { data: pts } = await supabase
        .from('patch_tests')
        .select('status, test_date')
        .eq('client_id', appt.client_id)
        .eq('beautician_id', appt.beauticians.id);
      const ok = (pts || []).some(pt => pt.status === 'passed' && pt.test_date && new Date(pt.test_date) > sixMonthsAgo);
      if (!ok) {
        return res.status(409).json({ error: 'That treatment needs a patch test first. Please message me and we will sort it.' });
      }
    }

    // Re-end from the SAME start using the new length, in the wall frame.
    const m = String(appt.starts_at).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) return res.status(500).json({ error: 'Something went wrong' });
    const [, yy, mo, dd, hh, mi] = m;
    const total = (treat.duration_minutes || 0) + (appt.buffer_minutes || 0) + (appt.extra_padding_minutes || 0);
    const endDate = new Date(Date.UTC(Number(yy), Number(mo) - 1, Number(dd), Number(hh), Number(mi) + total));
    const pad = (n) => String(n).padStart(2, '0');
    const newEnds = `${endDate.getUTCFullYear()}-${pad(endDate.getUTCMonth() + 1)}-${pad(endDate.getUTCDate())}T${pad(endDate.getUTCHours())}:${pad(endDate.getUTCMinutes())}:00`;

    // A longer treatment must not run into the next client, or past closing,
    // or into one of Ellie's blocks.
    const startD = new Date(`${String(appt.starts_at).slice(0, 19)}Z`);
    const endD = new Date(`${newEnds}Z`);
    const { data: clash } = await supabase
      .from('appointments')
      .select('id')
      .eq('beautician_id', appt.beauticians.id)
      .neq('id', appt.id)
      .in('status', ['confirmed', 'pending', 'in_progress'])
      .lt('starts_at', endD.toISOString())
      .gt('ends_at', startD.toISOString());
    if (clash && clash.length) {
      return res.status(409).json({ error: 'That treatment takes longer and would run into the next appointment. Please pick a shorter one, or message me to move your time.' });
    }
    const blocks = await loadBlocks(appt.beauticians.id, startD, endD);
    if (hitsBlock(startD, endD, blocks)) {
      return res.status(409).json({ error: 'That treatment takes longer than the time left in that slot. Please pick a shorter one, or message me.' });
    }
    const dh = wallDayHours(appt.beauticians.working_hours || {}, startD);
    if (dh) {
      const [eh, em] = dh.end.split(':').map(Number);
      const dayEnd = new Date(startD); dayEnd.setUTCHours(eh, em, 0, 0);
      if (endD > dayEnd) {
        return res.status(409).json({ error: 'That treatment would run past closing time. Please pick a shorter one, or message me.' });
      }
    }

    // THE DEPOSIT IS DELIBERATELY UNTOUCHED. deposit_cents and deposit_paid are
    // not in this update, so whatever they paid carries straight over and the
    // remaining balance (price - deposit) recomputes itself.
    const { error: upErr } = await supabase
      .from('appointments')
      .update({
        treatment_id: treat.id,
        duration_minutes: treat.duration_minutes,
        price_cents: treat.price_cents,
        ends_at: newEnds,
      })
      .eq('id', appt.id);
    if (upErr) {
      logger.error({ err: upErr, appointmentId: appt.id }, 'change-treatment update failed');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    const depositPaid = appt.deposit_paid ? (appt.deposit_cents || 0) : 0;
    const remaining = Math.max(0, (treat.price_cents || 0) - depositPaid);

    // Tell Ellie: her diary just changed under her.
    const dLabel = new Date(`${String(appt.starts_at).slice(0, 10)}T00:00:00Z`)
      .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    pushTeamUpdate(appt.beauticians.id, 'booking_rescheduled',
      `${appt.clients?.first_name || 'A client'} changed their ${dLabel} booking to ${treat.name}. Deposit stays as paid.`,
      { url: '/calendar/week', clientName: appt.clients?.first_name }
    ).catch(err => logger.error({ err, appointmentId: appt.id }, 'change-treatment push failed'));

    res.json({
      success: true,
      treatment: { id: treat.id, name: treat.name, duration_minutes: treat.duration_minutes, price_cents: treat.price_cents },
      depositPaidCents: depositPaid,
      remainingCents: remaining,
      message: `Changed to ${treat.name}. Your deposit stays as it is${remaining > 0 ? `, with £${(remaining / 100).toFixed(2)} to pay on the day` : ''}.`,
    });
  } catch (err) {
    logger.error({ err }, 'change-treatment failed');
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
        policy_snapshot, client_email, client_id, beautician_id, treatment_id, rescheduled_at,
        beauticians(id, booking_slug, booking_policy, business_name, first_name, working_hours),
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

    // Live reschedule controls (from the current beautician policy, not the
    // frozen snapshot).
    const livePolicy = appt.beauticians?.booking_policy || {};

    // "Only once" — once a client has moved this booking, they can't keep
    // shuffling it. Ellie turns this on to stop repeat rescheduling.
    if (livePolicy.reschedule_once === true && appt.rescheduled_at) {
      return res.status(409).json({
        error: "This booking has already been moved once. Please contact us directly if you need to change it again.",
        code: 'reschedule_used',
      });
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

    // Max advance window check for the new time (0/unset = no limit).
    const maxAdvanceDays = policy.max_advance_days || 0;
    if (maxAdvanceDays > 0) {
      const horizon = new Date();
      horizon.setDate(horizon.getDate() + maxAdvanceDays);
      if (newStart > horizon) {
        return res.status(400).json({
          error: `Online bookings are only open up to ${maxAdvanceDays} days ahead. Please choose an earlier date.`,
        });
      }
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

    // "Only between existing appointments" — keep Ellie's days tightly packed.
    // The new slot must butt directly against another booking that day (start
    // where one ends, or end where one starts) so she never travels in for a
    // single isolated client. Wall-clock reads (stored local time in the slot).
    if (livePolicy.reschedule_between_only === true) {
      const dayStr = String(new_starts_at).slice(0, 10);
      const wm = (isoish) => {
        const t = String(isoish || '').slice(11, 16);
        const h = parseInt(t.slice(0, 2), 10); const m = parseInt(t.slice(3, 5), 10);
        return (isNaN(h) || isNaN(m)) ? null : h * 60 + m;
      };
      const newStartMin = wm(new_starts_at);
      const newEndMin = (newStartMin != null) ? newStartMin + totalMinutes : null;
      const { data: dayAppts } = await supabase
        .from('appointments')
        .select('starts_at, ends_at')
        .eq('beautician_id', appt.beautician_id)
        .in('status', ['confirmed', 'pending', 'in_progress'])
        .neq('id', appt.id)
        .gte('starts_at', `${dayStr}T00:00:00`)
        .lte('starts_at', `${dayStr}T23:59:59`);
      const touches = (dayAppts || []).some(a => {
        const es = wm(a.starts_at); const ee = wm(a.ends_at);
        // Back-to-back: the new slot starts exactly when another ends, or ends
        // exactly when another starts.
        return (ee != null && ee === newStartMin) || (newEndMin != null && newEndMin === es);
      });
      if (!touches) {
        return res.status(422).json({
          error: "To keep the day tidy, this booking can only move to a time right before or after another appointment. Please pick one of the suggested slots.",
          code: 'reschedule_not_adjacent',
        });
      }
    }

    // Late reschedule + the beautician requires a fresh deposit for the new slot
    // (booking_policy.require_deposit_on_late_reschedule, off by default): take it
    // off the saved card NOW, and BLOCK the move if we can't (no card / declined).
    // This runs before the move so a failed deposit never leaves the slot shifted.
    let newDepositCollected = false;
    if (isLateReschedule && policy.require_deposit_on_late_reschedule === true) {
      const dep = await chargeRescheduleDeposit(appt.id, newStart.toISOString());
      if (dep.charged) {
        newDepositCollected = true;
      } else if (dep.reason !== 'no_deposit') {
        const who = appt.beauticians?.business_name || appt.beauticians?.first_name || 'your beautician';
        const msg = dep.reason === 'no_card_on_file'
          ? `We couldn't take the new deposit because there's no saved card on file, so your appointment has not been moved. Please contact ${who} to rearrange.`
          : `We couldn't take the new deposit for the rescheduled time, so your appointment has not been moved. Please try again, or contact ${who}.`;
        return res.status(402).json({ error: msg, code: 'reschedule_deposit_required' });
      }
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

    // Policy enforcement: a reschedule inside the notice window is treated like a
    // late cancellation of the original slot. Charge the original appointment's
    // late fee to the saved card (chargePolicyFee self-guards: it only charges
    // when the beautician's policy has a fee, a card is on file, and never twice).
    // Previously this only set a flag and nothing was ever charged, which is the
    // gap Ellie hit (a client moved inside the window and was not charged).
    let lateFeeCharged = false;
    if (isLateReschedule && (policy.late_cancel_charge_percent || 0) > 0) {
      lateFeeCharged = true;
      chargePolicyFee(appt.id, 'late_cancel').catch(err =>
        logger.error({ err, appointmentId: appt.id }, 'late_reschedule policy fee charge failed (non-fatal)')
      );
      // If we did NOT auto-collect a fresh deposit above (toggle off, or this
      // booking has no deposit), mark the new slot deposit pending so it shows
      // as awaiting one. deposit_paid is left intact so the late-fee calc still
      // credits the original deposit.
      if (!newDepositCollected) {
        await supabase
          .from('appointments')
          .update({ deposit_status: 'pending' })
          .eq('id', appt.id)
          .catch(err => logger.warn({ err, appointmentId: appt.id }, 'deposit_status pending reset failed (non-fatal)'));
      }
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

    // iOS/web push: tell Ellie her client moved the booking themselves, deep
    // linked to the new day. Fail-soft, never blocks the response.
    (async () => {
      try {
        const who = appt.clients?.first_name || 'A client';
        const dateStr = newStart.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
        const timeStr = String(newStart.toISOString()).slice(11, 16);
        await pushReschedule(appt.beautician_id, who, `${dateStr} at ${timeStr}`, {
          appointmentId: appt.id,
          apptDate: newStart.toISOString(),
        });
      } catch (e) { logger.warn({ e }, 'reschedule push failed (non-fatal)'); }
    })();

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
      newDepositCollected,
      message: isLateReschedule && chargePercent > 0
        ? `Rescheduled to ${newStart.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })} at ${newStart.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}. As this is within the ${noticeHours}-hour notice period, a ${chargePercent}% fee for the original appointment will be charged to the card on file${newDepositCollected ? ', and a fresh deposit has been taken for your new appointment' : ', and your new appointment will need a fresh deposit'}.`
        : `Rescheduled to ${newStart.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })} at ${newStart.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.`,
    });
  } catch (err) {
    logger.error({ err }, 'Reschedule failed');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * GET /api/booking/:slug/manage/:token/reschedule/slots
 * Back-to-back reschedule slots. Used when the beautician has
 * booking_policy.reschedule_between_only turned on: instead of a free
 * date/time picker, the client is offered only slots that butt directly
 * against another booking (start where one ends, or end where one starts),
 * so days stay tightly packed and Ellie never travels in for one client.
 *
 * Wall-clock throughout: appointment times are stored as salon local time in
 * the slot, so we read/build them with plain string maths, never Date tz maths.
 */
router.get('/:slug/manage/:token/reschedule/slots', async (req, res) => {
  try {
    const { data: appt } = await supabase
      .from('appointments')
      .select(`
        id, starts_at, status, duration_minutes, buffer_minutes, extra_padding_minutes,
        policy_snapshot, beautician_id,
        beauticians(id, booking_slug, booking_policy, working_hours)
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
    const livePolicy = appt.beauticians?.booking_policy || {};
    const workingHours = appt.beauticians?.working_hours || null;
    const totalMinutes = (appt.duration_minutes || 60) + (appt.buffer_minutes || 0) + (appt.extra_padding_minutes || 0);

    const HORIZON_DAYS = 28;
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const minHours = policy.min_booking_hours || 0;
    const maxAdvanceDays = livePolicy.max_advance_days || policy.max_advance_days || 0;

    const fromStr = todayStr;
    const toDate = new Date(now.getTime() + HORIZON_DAYS * 24 * 3600 * 1000);
    const toStr = toDate.toISOString().slice(0, 10);

    // Existing live bookings (exclude the one being moved) + blocked time.
    const [{ data: existing }, { data: exceptionRows }] = await Promise.all([
      supabase.from('appointments')
        .select('id, starts_at, ends_at')
        .eq('beautician_id', appt.beautician_id)
        .in('status', ['confirmed', 'pending', 'in_progress'])
        .neq('id', appt.id)
        .gte('starts_at', `${fromStr}T00:00:00`)
        .lte('starts_at', `${toStr}T23:59:59`),
      supabase.from('hours_exceptions')
        .select('date, type, start_time, end_time')
        .eq('beautician_id', appt.beautician_id)
        .gte('date', fromStr)
        .lte('date', toStr),
    ]);

    const wm = (isoish) => {
      const t = String(isoish || '').slice(11, 16);
      const h = parseInt(t.slice(0, 2), 10); const m = parseInt(t.slice(3, 5), 10);
      return (isNaN(h) || isNaN(m)) ? null : h * 60 + m;
    };
    const dayOf = (isoish) => String(isoish || '').slice(0, 10);

    // Group existing bookings by day.
    const byDay = {};
    for (const a of existing || []) {
      const d = dayOf(a.starts_at);
      (byDay[d] = byDay[d] || []).push({ start: wm(a.starts_at), end: wm(a.ends_at) });
    }
    // Blocks by day (closed all day, or specific ranges in wall minutes).
    const blocksByDay = {};
    const closedDays = new Set();
    for (const r of exceptionRows || []) {
      const isClosed = r.type ? r.type === 'closed' : true;
      if (isClosed || !r.start_time || !r.end_time) { closedDays.add(r.date); continue; }
      const sm = parseInt(String(r.start_time).slice(0, 2), 10) * 60 + parseInt(String(r.start_time).slice(3, 5), 10);
      const em = parseInt(String(r.end_time).slice(0, 2), 10) * 60 + parseInt(String(r.end_time).slice(3, 5), 10);
      (blocksByDay[r.date] = blocksByDay[r.date] || []).push([sm, em]);
    }

    const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const pad = (n) => String(n).padStart(2, '0');
    const fmt = (mins) => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
    const slots = [];
    const seen = new Set();

    // Only days that ALREADY have a booking can host a back-to-back slot.
    const candidateDays = Object.keys(byDay).sort();
    const horizonMax = maxAdvanceDays > 0
      ? new Date(now.getTime() + maxAdvanceDays * 24 * 3600 * 1000).toISOString().slice(0, 10)
      : null;

    for (const dateStr of candidateDays) {
      if (closedDays.has(dateStr)) continue;
      if (dateStr < todayStr) continue;
      if (horizonMax && dateStr > horizonMax) continue;

      const dow = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
      const wh = workingHours ? workingHours[dayKeys[dow]] : { start: '09:00', end: '17:00' };
      if (!wh || !wh.start || !wh.end) continue; // day off
      const workStart = parseInt(wh.start.slice(0, 2), 10) * 60 + parseInt(wh.start.slice(3, 5), 10);
      const workEnd = parseInt(wh.end.slice(0, 2), 10) * 60 + parseInt(wh.end.slice(3, 5), 10);

      const dayAppts = byDay[dateStr];
      const dayBlocks = blocksByDay[dateStr] || [];

      // Candidate starts: immediately after each booking, and immediately
      // before each booking (so the new one ends exactly as that one starts).
      const candidates = new Set();
      for (const a of dayAppts) {
        if (a.end != null) candidates.add(a.end);
        if (a.start != null) candidates.add(a.start - totalMinutes);
      }

      for (const startMin of candidates) {
        const endMin = startMin + totalMinutes;
        if (startMin < workStart || endMin > workEnd) continue;
        // Future + min-notice guard (only matters for today).
        if (dateStr === todayStr && startMin < nowMinutes + minHours * 60) continue;
        if (dateStr < todayStr) continue;
        // No overlap with an existing booking.
        const clashAppt = dayAppts.some(a => a.start != null && a.end != null && startMin < a.end && endMin > a.start);
        if (clashAppt) continue;
        // No overlap with a blocked range.
        const clashBlock = dayBlocks.some(([bs, be]) => startMin < be && endMin > bs);
        if (clashBlock) continue;

        const iso = `${dateStr}T${fmt(startMin)}:00`;
        if (seen.has(iso)) continue;
        seen.add(iso);
        slots.push(iso);
      }
    }

    slots.sort();
    return res.json({ slots: slots.slice(0, 12) });
  } catch (err) {
    logger.error({ err }, 'Reschedule slots fetch failed');
    return res.status(500).json({ error: 'Something went wrong' });
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
        application_fee_amount: calculatePlatformFee(depositCents),
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
/**
 * PATCH TEST TIME HANDLING
 * appointments.starts_at / ends_at store SALON WALL TIME inside the UTC slot
 * (an 11:00 salon booking is saved as ...T11:00:00Z). So every comparison here
 * happens in that same "wall frame": a Date whose UTC fields ARE the wall clock.
 * Mixing a real UTC `now` into this frame is what made patch-test slots ignore
 * the real diary and drift by an hour in BST.
 */
const PATCH_TEST_LEAD_HOURS = 24; // must match the booking gate + the client copy
const WALL_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** "Now", rendered in the salon's wall clock, in the wall frame. */
function nowInSalonWall(timezone = 'Europe/London') {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  return new Date(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
}

/** Working hours for the day a wall-frame Date falls on. null = salon closed. */
/**
 * Ellie's personal blocks live in hours_exceptions (a date plus an optional
 * start/end wall time; no range = the whole day is closed). The public picker
 * respected them but the patch-test slot generator did not, so a client could
 * book a patch test straight over a block. Load them once, in the wall frame.
 */
async function loadBlocks(beauticianId, fromWall, toWall) {
  const { data: rows } = await supabase
    .from('hours_exceptions')
    .select('date, type, start_time, end_time')
    .eq('beautician_id', beauticianId)
    .gte('date', fromWall.toISOString().slice(0, 10))
    .lte('date', toWall.toISOString().slice(0, 10));

  const closedDays = new Set();
  const intervals = [];
  for (const r of rows || []) {
    if (r.type !== 'closed' && r.start_time && r.end_time) {
      intervals.push({
        start: new Date(`${r.date}T${String(r.start_time).slice(0, 5)}:00Z`),
        end: new Date(`${r.date}T${String(r.end_time).slice(0, 5)}:00Z`),
      });
    } else {
      closedDays.add(r.date); // whole day off
    }
  }
  return { closedDays, intervals };
}

function hitsBlock(slotStart, slotEnd, blocks) {
  if (blocks.closedDays.has(slotStart.toISOString().slice(0, 10))) return true;
  return blocks.intervals.some(b => slotStart < b.end && slotEnd > b.start);
}

function wallDayHours(workingHours, wallDate) {
  const k = WALL_DAYS[wallDate.getUTCDay()];
  const h = workingHours?.[k] || workingHours?.[k[0].toUpperCase() + k.slice(1)];
  return h && h.start && h.end ? h : null;
}


router.get('/:slug/manage/:token/patch-test/slots', async (req, res) => {
  try {
    const { data: appt } = await supabase
      .from('appointments')
      .select(`
        id, starts_at, client_id, client_email,
        beauticians(id, booking_slug, working_hours, timezone, patch_test_duration_minutes, patch_test_price_cents)
      `)
      .eq('management_token', req.params.token)
      .single();

    if (!appt || appt.beauticians?.booking_slug !== req.params.slug) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const beautician = appt.beauticians;
    const beauticianId = beautician.id;
    const timezone = beautician.timezone || 'Europe/London';
    const ptDuration = beautician.patch_test_duration_minutes || 10;

    // Everything below is in the WALL frame (see notes above the route).
    const apptStart = new Date(appt.starts_at);
    const deadline = new Date(apptStart.getTime() - PATCH_TEST_LEAD_HOURS * 60 * 60 * 1000);
    const nowWall = nowInSalonWall(timezone);

    if (deadline <= nowWall) {
      return res.status(400).json({
        error: `Too late to book a patch test, it must be at least ${PATCH_TEST_LEAD_HOURS} hours before your appointment.`,
      });
    }

    const workingHours = beautician.working_hours || {
      mon: { start: '09:00', end: '17:00' }, tue: { start: '09:00', end: '17:00' },
      wed: { start: '09:00', end: '17:00' }, thu: { start: '09:00', end: '17:00' },
      fri: { start: '09:00', end: '17:00' }, sat: { start: '09:00', end: '17:00' },
    };

    // The real diary, in the same wall frame, so slots never clash with a booking.
    const scanEnd = new Date(Math.min(
      deadline.getTime(),
      nowWall.getTime() + 28 * 24 * 60 * 60 * 1000,
    ));
    const { data: existing } = await supabase
      .from('appointments')
      .select('starts_at, ends_at')
      .eq('beautician_id', beauticianId)
      .in('status', ['confirmed', 'pending', 'in_progress'])
      .gte('starts_at', nowWall.toISOString())
      .lte('starts_at', scanEnd.toISOString())
      .order('starts_at', { ascending: true });
    const busy = (existing || []).map(a2 => ({
      start: new Date(a2.starts_at),
      end: new Date(a2.ends_at),
    }));

    // Her personal blocks and days off count as busy too.
    const blocks = await loadBlocks(beauticianId, nowWall, deadline);

    // Every genuinely free slot between now and the deadline, so the client can
    // pick from a real calendar (any open day, any open time) exactly like the
    // main booking page, instead of a handful of consecutive quarter-hours.
    const cursor = new Date(nowWall.getTime() + 60 * 60 * 1000); // 1h notice
    cursor.setUTCSeconds(0, 0);
    const cm = cursor.getUTCMinutes();
    if (cm % 15 !== 0) cursor.setUTCMinutes(Math.ceil(cm / 15) * 15, 0, 0);

    const slots = [];
    const MAX_SLOTS = 800;
    while (cursor < deadline && slots.length < MAX_SLOTS) {
      const slotEnd = new Date(cursor.getTime() + ptDuration * 60 * 1000);
      const dh = wallDayHours(workingHours, cursor);
      if (dh) {
        const [sh, sm] = dh.start.split(':').map(Number);
        const [eh, em] = dh.end.split(':').map(Number);
        const dayOpen = new Date(cursor); dayOpen.setUTCHours(sh, sm, 0, 0);
        const dayShut = new Date(cursor); dayShut.setUTCHours(eh, em, 0, 0);

        if (cursor >= dayOpen && slotEnd <= dayShut) {
          const clash = busy.some(b2 => cursor < b2.end && slotEnd > b2.start)
            || hitsBlock(cursor, slotEnd, blocks);
          if (!clash) slots.push(cursor.toISOString());
        }
      }
      cursor.setUTCMinutes(cursor.getUTCMinutes() + 15);
    }

    if (slots.length === 0) {
      return res.status(400).json({ error: 'No available patch test slots before your appointment. Message me and we will sort one out.' });
    }

    res.json({
      success: true,
      slots,
      suggested: slots[0],
      deadline: deadline.toISOString(),
      lead_hours: PATCH_TEST_LEAD_HOURS,
      duration_minutes: ptDuration,
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
        id, starts_at, client_id, client_email,
        clients(first_name),
        beauticians(id, booking_slug, working_hours, timezone, patch_test_duration_minutes, patch_test_price_cents)
      `)
      .eq('management_token', req.params.token)
      .single();

    if (!appt || appt.beauticians?.booking_slug !== req.params.slug) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const beautician = appt.beauticians;
    const ptDuration = beautician.patch_test_duration_minutes || 10;
    const ptPrice = beautician.patch_test_price_cents || 0;
    const timezone = beautician.timezone || 'Europe/London';

    // Same WALL frame as the slot generator, so a slot the client was offered
    // always validates here (this mismatch is what stopped patch tests booking).
    const apptStart = new Date(appt.starts_at);
    const deadline = new Date(apptStart.getTime() - PATCH_TEST_LEAD_HOURS * 60 * 60 * 1000);
    const nowWall = nowInSalonWall(timezone);
    const slotEnd = new Date(slotTime.getTime() + ptDuration * 60 * 1000);

    if (slotTime >= deadline) {
      return res.status(400).json({ error: `That time is too close to your appointment. A patch test must be at least ${PATCH_TEST_LEAD_HOURS} hours before.` });
    }
    if (slotTime < nowWall) {
      return res.status(400).json({ error: 'That time has already passed, please pick another.' });
    }

    const workingHours = beautician.working_hours || {};
    const dayHours = wallDayHours(workingHours, slotTime) || { start: '09:00', end: '17:00' };
    const [startHour, startMin] = dayHours.start.split(':').map(Number);
    const [endHour, endMin] = dayHours.end.split(':').map(Number);
    const dayStart = new Date(slotTime); dayStart.setUTCHours(startHour, startMin, 0, 0);
    const dayEnd = new Date(slotTime); dayEnd.setUTCHours(endHour, endMin, 0, 0);

    if (slotTime < dayStart || slotEnd > dayEnd) {
      return res.status(400).json({ error: 'That time is outside opening hours, please pick another.' });
    }

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

    // Re-check her blocks server side: the slot list could be stale, and a
    // client could post any time they like.
    const confirmBlocks = await loadBlocks(beautician.id, slotTime, slotEnd);
    if (hitsBlock(slotTime, slotEnd, confirmBlocks)) {
      return res.status(409).json({ error: 'That time is not free any more, please pick another.' });
    }

    // Create patch test appointment
    const { data: patchTestAppt, error: insertErr } = await supabase
      .from('appointments')
      .insert({
        beautician_id: beautician.id,
        client_id: appt.client_id,
        client_email: appt.client_email,
        // client_name/client_phone are not appointment columns; client_id
        // carries the person. Their presence rejected the insert whole.
        treatment_id: null,
        starts_at: slotTime.toISOString(),
        ends_at: slotEnd.toISOString(),
        duration_minutes: ptDuration,
        status: 'confirmed',
        // NOT `notes`: appointments has no such column, so the insert errored
        // every time and no patch test could ever be booked.
        beautician_notes: 'Patch test (auto-booked)',
        booked_via: 'booking_page',
        price_cents: ptPrice,
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

    // Tell Ellie it landed. Fire and forget: a push problem must never fail
    // a patch test the client has already booked.
    const ptDay = new Date(patchTestAppt.starts_at);
    const whenLabel = `${ptDay.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })} at ${String(patchTestAppt.starts_at).slice(11, 16)}`;
    pushPatchTestBooked(
      beautician.id,
      appt.clients?.first_name || 'A client',
      whenLabel,
      { appointmentId: patchTestAppt.id, apptDate: patchTestAppt.starts_at },
    ).catch(() => {});

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
  // Appointments auto-complete once their time passes (assumed done). Ellie can
  // still flag one a no-show at the end of the day - that reverses the takings
  // and charges the fee - so completed -> no_show must be allowed. completed ->
  // confirmed lets her undo an auto-complete if she wants to re-open it.
  'completed': ['no_show', 'confirmed'],
  'cancelled': [],
  'no_show': ['confirmed']
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

    if (newStatus === 'no_show') {
      // Reverse assumed/auto takings (type 'payment' with a null method) so the
      // Money tab drops the income for an appointment that auto-completed but was
      // actually a no-show. Real card charges (deposits, balance) keep a method
      // and are left alone. This is what makes a late no-show update everything.
      const { error: revErr } = await supabase
        .from('transactions')
        .delete()
        .eq('appointment_id', id)
        .eq('type', 'payment')
        .is('payment_method', null);
      if (revErr) logger.error({ err: revErr, appointmentId: id }, 'no_show takings reversal failed');

      // One-tap model (not auto): we do NOT charge here. We tell the app the fee
      // amount and whether a card is on file, and Ellie taps 'Charge' herself.
    }

    // Fee preview for the no-show prompt. Always returned on a no-show so Ellie
    // sees the amount, and, when she can't charge, WHY (no card on file - which
    // for her means deposits/card-capture is currently off).
    let noShowFee = null;
    if (newStatus === 'no_show') {
      // Same merge as policy-fees: the snapshot wins, but a no-show percent set
      // after the booking was made still applies (old snapshots lack the key).
      const snap = updated.policy_snapshot || {};
      const livePol = req.beautician?.booking_policy || {};
      const policy = updated.policy_snapshot
        ? { ...snap, ...(snap.no_show_charge_percent === undefined && livePol.no_show_charge_percent !== undefined
              ? { no_show_charge_percent: livePol.no_show_charge_percent } : {}) }
        : livePol;
      let feeCents = 0;
      try {
        ({ feeCents } = computePolicyFee(updated, policy, 'no_show'));
      } catch { feeCents = updated.deposit_cents || 0; }
      const hasCard = !!updated.clients?.stripe_customer_id;
      noShowFee = feeCents > 0 && hasCard
        ? { can_charge: true, amount_cents: feeCents }
        : { can_charge: false, amount_cents: feeCents, reason: !hasCard ? 'no_card' : 'no_fee' };
    }

    res.json({
      message: `Appointment status updated to '${newStatus}'`,
      appointment: updated,
      ...(noShowFee && { no_show_fee: noShowFee }),
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

  // Find client by phone (last-9 match: +44 / 0 / spaced all resolve the same)
  const mpd = String(phone || '').replace(/\D/g, '');
  const { data: memberRows } = mpd.length >= 7 ? await supabase
    .from('clients')
    .select('id, first_name')
    .eq('beautician_id', beautician.id)
    .ilike('phone', `%${mpd.slice(-9)}`)
    .limit(1) : { data: [] };
  const client = memberRows?.[0] || null;

  if (!client) return res.json({ is_member: false });

  // The two tables are confusingly named:
  //   client_memberships      = the PLANS   (name, price_cents, benefits)
  //   membership_subscriptions = the ENROLMENTS (client_id, membership_id, status)
  // This route had them the wrong way round, and then read a `membership_plans`
  // table that does not exist at all. Both queries errored, so `is_member` was
  // ALWAYS false: no client has ever been recognised as a member here.
  const { data: membership } = await supabase
    .from('membership_subscriptions')
    .select('id, membership_id, status')
    .eq('beautician_id', beautician.id)
    .eq('client_id', client.id)
    .eq('status', 'active')
    .maybeSingle();

  if (!membership) return res.json({ is_member: false });

  const { data: plan } = await supabase
    .from('client_memberships')
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

  // Find client by phone (last-9 match: +44 / 0 / spaced all resolve the same)
  const ppd = String(phone || '').replace(/\D/g, '');
  const { data: pkgClientRows } = ppd.length >= 7 ? await supabase
    .from('clients')
    .select('id')
    .eq('beautician_id', beautician.id)
    .ilike('phone', `%${ppd.slice(-9)}`)
    .limit(1) : { data: [] };
  const client = pkgClientRows?.[0] || null;

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
      .select('id, name, duration_minutes, buffer_minutes, price_cents, deposit_cents, deposit_percent, requires_patch_test, requires_consultation, consultation_form_id')
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

  // Enforce how far ahead the diary is open (0/unset = no limit).
  const maxAdvanceDays = bookingPolicy.max_advance_days || 0;
  if (maxAdvanceDays > 0) {
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + maxAdvanceDays);
    if (startsAtCheck > horizon) {
      return res.status(400).json({
        error: `Online bookings are only open up to ${maxAdvanceDays} days ahead. Please choose an earlier date.`
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

  // Find an existing client by email OR phone — a match on EITHER field means a
  // returning client, so we reuse their record (no duplicate) and skip the
  // consultation form / patch test. Try email first, fall back to phone.
  let existingClient = null;

  if (client_email) {
    const { data } = await supabase
      .from('clients')
      .select('id, stripe_customer_id, blocked_at')
      .eq('beautician_id', beautician.id)
      .ilike('email', client_email.trim())
      .maybeSingle();
    existingClient = data;
  }

  if (!existingClient && client_phone) {
    // Last-9 match so a returning client typing 07... when we stored +447...
    // (or vice versa) is still recognised: no duplicate record, and no being
    // re-asked for a patch test / consultation form they already did.
    const cpd = String(client_phone).replace(/\D/g, '');
    if (cpd.length >= 7) {
      const { data } = await supabase
        .from('clients')
        .select('id, stripe_customer_id, blocked_at')
        .eq('beautician_id', beautician.id)
        .ilike('phone', `%${cpd.slice(-9)}`)
        .limit(1);
      existingClient = data?.[0] || null;
    }
  }

  // A client Ellie has blocked cannot book online. Kept deliberately vague so
  // it does not invite an argument; she can still add them by hand if she wants.
  if (existingClient?.blocked_at) {
    return res.status(403).json({ error: 'Online booking is not available for this account. Please contact us directly.' });
  }

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

  // Blocked-time guard: never accept a booking on a closed day or inside a
  // blocked-out time range (hours_exceptions). The picker hides these, but a
  // stale page or direct API call could still slip through without this.
  // starts_at from the public picker is salon-local wall time ('...THH:MM:00',
  // no Z), and exception times are salon-local too, so compare wall minutes.
  const bookDate = String(starts_at).slice(0, 10);
  const { data: dayExceptions } = await supabase
    .from('hours_exceptions')
    .select('type, start_time, end_time')
    .eq('beautician_id', beautician.id)
    .eq('date', bookDate);

  if (dayExceptions && dayExceptions.length > 0) {
    const wall = /T(\d{2}):(\d{2})/.exec(String(starts_at));
    const slotStartMin = wall ? Number(wall[1]) * 60 + Number(wall[2]) : null;
    const slotEndMin = slotStartMin === null ? null : slotStartMin + totalMinutes;
    for (const ex of dayExceptions) {
      const timed = ex.type !== 'closed' && ex.start_time && ex.end_time;
      if (!timed) {
        return res.status(409).json({ error: 'This day is no longer available. Please choose another date.' });
      }
      if (slotStartMin === null) continue;
      const [sh, sm] = ex.start_time.split(':').map(Number);
      const [eh, em] = ex.end_time.split(':').map(Number);
      if (slotStartMin < eh * 60 + em && slotEndMin > sh * 60 + sm) {
        return res.status(409).json({ error: 'This time slot is no longer available. Please choose another time.' });
      }
    }
  }

  // ---- New-client safety gate (Ellie's rule, 2026-07-04) -------------------
  // First-time clients booking a patch-test treatment must be 24h+ out so the
  // test can happen at least 24 hours before the appointment. starts_at is
  // salon wall time stored as UTC, so in BST this reads up to 1h generous;
  // acceptable for a v1 gate. The confirmation + manage portal then walk the
  // client through booking the actual patch-test slot (24h validation there).
  const gateNeedsPatchTest = isNewClient && allTreatments.some(t => t.requires_patch_test === true);
  if (gateNeedsPatchTest) {
    const hoursAway = (startsDate.getTime() - Date.now()) / 3600000;
    if (hoursAway < 24) {
      return res.status(409).json({
        error: 'As a new client, this treatment needs a quick patch test at least 24 hours before your appointment. Please choose a time from tomorrow onwards so there is time to fit it in.',
      });
    }
  }

  // First visit + a treatment that asks for consultation answers: the form is
  // not optional. The page always collects it; this stops anything skipping it.
  const gateNeedsConsultation = isNewClient && allTreatments.some(t => t.requires_consultation === true);
  if (gateNeedsConsultation && (!consultation || Object.keys(consultation).length === 0)) {
    return res.status(400).json({ error: 'Please fill in the quick consultation form to book this treatment.' });
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

    // Every booking secures a deposit by card, no matter how the balance is
    // paid. If a treatment has no deposit of its own, fall back to the salon's
    // configured deposit amount. A salon that truly wants no deposit sets it to
    // £0. The payment method (card / cash / bank) only governs the BALANCE.
    const paySettings = beautician.payment_settings || {};
    if (depositCents === 0 && combinedPriceCents > 0) {
      // Parse the deposit amount setting (e.g. '£10', '£15', '50%')
      const dAmt = paySettings.deposit_amount || '£10';
      if (dAmt.endsWith('%')) {
        depositCents = Math.round(combinedPriceCents * parseInt(dAmt) / 100);
      } else {
        depositCents = Math.round(parseFloat(dAmt.replace('£', '')) * 100);
      }
    }

    // Safety: a deposit can never exceed the total price (guards against a
    // misconfigured fixed deposit or percent that's larger than the treatment).
    if (combinedPriceCents > 0) depositCents = Math.min(depositCents, combinedPriceCents);

    // Full payment up front only applies to card. Cash/bank pay the balance
    // offline, so those only ever pay the DEPOSIT by card here.
    isFullPayment = payment_type === 'full' && combinedPriceCents > 0 && !isOfflinePayment;

    // The deposit is taken on EVERY booking, whatever the payment method. Cash
    // and bank transfer no longer skip it; they just pay the balance offline.
    depositRequired = depositCents > 0 || isFullPayment;
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
    // The slot was taken between the conflict check and the insert (a race), or
    // this is a double-submit, or the new appointment overlaps an existing one.
    // 23505 = unique violation (same start), 23P01 = exclusion violation (overlap).
    // Either way, never a 500.
    if (aError.code === '23505' || aError.code === '23P01') {
      return res.status(409).json({ error: 'That time was just booked. Please pick another slot.' });
    }
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

  // New client + patch-test treatment: the pending patch test is created WITH
  // the booking (idempotent), so it is tracked from second one and the manage
  // portal can offer test slots immediately (its own 24h validation applies).
  if (gateNeedsPatchTest) {
    try {
      const { data: priorPt } = await supabase
        .from('patch_tests')
        .select('id')
        .eq('appointment_id', appointment.id)
        .limit(1);
      if (!priorPt || priorPt.length === 0) {
        await supabase.from('patch_tests').insert({
          client_id: client.id,
          beautician_id: beautician.id,
          appointment_id: appointment.id,
          status: 'pending',
        });
      }
    } catch (err) {
      logger.warn({ err }, 'Pending patch test insert failed (non-fatal)');
    }
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
  // Only alert on a REAL booking. A deposit booking starts as 'pending'; it must
  // NOT fire a "waiting on a deposit" push up front (that was the noise). Ellie
  // now hears about a deposit booking only when the deposit lands (confirmed push
  // in the Stripe paths) or when it is abandoned (cleanup releases the slot).
  if (appointment.status !== 'pending') {
    pushNewBooking(beautician.id, firstName, treatmentNames, `${dateStr} at ${timeStr}`, { appointmentId: appointment.id, apptDate: appointment.starts_at, pending: false }).catch(() => {});
  }
  refreshLiveActivity(beautician.id).catch(() => {});

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

    // Send consultation form to first-time clients (non-blocking).
    // Skipped when they already answered inline during booking (double-ask bug).
    if (isNewClient && client_phone && !(consultation && Object.keys(consultation).length > 0)) {
      sendConsultationFormSMS({
        beauticianId: beautician.id,
        clientId: client.id,
        appointmentId: appointment.id,
        clientPhone: client_phone,
        clientFirstName: firstName,
        treatmentId: (allTreatments.find(t => t.consultation_form_id)?.id) || treatment_id,
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

      // Send consultation form to first-time clients (non-blocking).
      // SKIPPED when they already answered inline during booking - texting the
      // same form again straight after was Ellie's double-ask bug.
      const answeredInline = consultation && Object.keys(consultation).length > 0;
      if (isNewClient && client_phone && !answeredInline) {
        sendConsultationFormSMS({
          beauticianId: beautician.id,
          clientId: client.id,
          appointmentId: appointment.id,
          clientPhone: client_phone,
          clientFirstName: firstName,
          treatmentId: (allTreatments.find(t => t.consultation_form_id)?.id) || treatment_id,
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

  // Send consultation form to first-time clients (non-blocking).
  // Skipped when they already answered inline during booking (double-ask bug).
  if (isNewClient && client_phone && !(consultation && Object.keys(consultation).length > 0)) {
    sendConsultationFormSMS({
      beauticianId: beautician.id,
      clientId: client.id,
      appointmentId: appointment.id,
      clientPhone: client_phone,
      clientFirstName: firstName,
      treatmentId: (allTreatments.find(t => t.consultation_form_id)?.id) || treatment_id,
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
