import { requireBookingIdentity, exactEmailPattern } from '../lib/booking-identity.js';
import { bookingManagementGuard } from '../lib/booking-management-access.js';
import { Router } from 'express';
import { z } from 'zod';
import Stripe from 'stripe';
import * as Sentry from '@sentry/node';
import { supabase } from '../config.js';
import { isMissingColumnError } from '../lib/junk-classifier.js';
import { notifyBookingConfirmed } from '../services/notifications.js';
import { pushNewBooking, pushReschedule, pushPatchTestBooked, pushClientCancelled, pushTeamUpdate } from '../services/push-notifications.js';
import { announceBookingConfirmed } from '../services/booking-confirmed-alert.js';
import { refreshLiveActivity } from '../services/live-activity.js';
import { sendConsultationFormSMS, recordBookingConsultation } from './consultation-forms.js';
import { splitBookingSubmission } from '../lib/client-notes.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { totalApplicationFee } from '../lib/platform-fees.js';
import { chargePolicyFee, computePolicyFee, chargeRescheduleDeposit } from '../services/policy-fees.js';
import { verifyTurnstile } from '../middleware/turnstile.js';
import logger from '../lib/logger.js';
import { bookingSchema } from '../lib/schemas.js';
import { nowInSalonWall, loadBlocks, hitsBlock, wallDayHours, blockCoversDay, blockDays, blockLookbackFrom, getFreeSlots, excludedAppointmentIds } from '../lib/free-slots.js';
import { getOutstandingBalanceCents } from '../services/outstanding-balance.js';
import { autoUnarchiveClient } from '../lib/client-archive.js';
import { guardedSend } from '../lib/outbound-guard.js';
import { BOOKING_MONEY_LOGGED_TYPES } from '../lib/money-guards.js';
import { combineTreatments, resolveDepositCents, salonRequiresDeposit } from '../lib/booking-rules.js';
import { recomputeTotals, endsAtWall } from '../lib/appointment-treatments.js';
import { appointmentIcs, googleCalendarUrl, DEAD_STATUSES } from '../lib/ical.js';
import { calendarLandingPage } from '../lib/calendar-page.js';
import { patchTestEvidence } from '../lib/patch-test-status.js';
import { readConsultationStatus, hasPriorHistory } from '../lib/consultation-status.js';

const router = Router();
router.use('/:slug/manage/:token', bookingManagementGuard(supabase));

/**
 * Send the confirmation, and if it reached nobody, say so to the owner.
 *
 * notifyBookingConfirmed does not throw when there is no channel: it
 * RESOLVES with { sent: false, reason: 'all_channels_disabled' }. Every call
 * site here wrapped it in .catch(), which cannot see a resolved value, so a
 * salon with no SMS provider and a client with no email got a green tick on
 * the booking page ("You'll receive a confirmation message shortly") and
 * nothing was sent, logged, or told to anybody. Non-blocking, never throws.
 */
function confirmOrTellTheOwner(appointmentId, beauticianId, clientFirstName) {
  notifyBookingConfirmed(appointmentId)
    .then((result) => {
      if (!result || result.sent !== false) return;
      logger.warn({ appointmentId, beauticianId, reason: result.reason }, 'Booking confirmation reached no channel');
      if (!beauticianId) return;
      return pushTeamUpdate(beauticianId, 'booking_confirmed',
        `${clientFirstName || 'A client'} booked in, but no confirmation could be sent (no email or text channel). Message them yourself to confirm.`,
        { url: '/calendar/week', clientName: clientFirstName });
    })
    .catch(err => logger.warn({ err, appointmentId }, 'Booking confirmation notification failed (non-fatal)'));
}
const FRONTEND_URL = process.env.FRONTEND_URL;

// Only init Stripe if key is present (avoids crash in dev without keys)
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

/**
 * What is actually left on a gift voucher, in pence.
 * gift_vouchers has amount_cents (face value) and remaining_cents (what is left
 * after part-redemptions); there has never been a plain `amount` column. Read
 * remaining_cents, and only fall back to the face value if the row predates it.
 */
function voucherRemainingCents(voucher) {
  if (!voucher) return 0;
  const remaining = voucher.remaining_cents ?? voucher.amount_cents ?? 0;
  return Math.max(0, Number(remaining) || 0);
}

/**
 * Sessions left on a bought package. The purchased row carries its own
 * sessions_total (client_packages.sessions_total, NOT NULL); the catalogue row
 * is packages.sessions_total. Neither is called `sessions`.
 */
function packageSessionsRemaining(clientPkg) {
  if (!clientPkg) return 0;
  const total = clientPkg.sessions_total ?? clientPkg.packages?.sessions_total ?? 0;
  const used = clientPkg.sessions_used || 0;
  return Math.max(0, (Number(total) || 0) - used);
}

/**
 * Has this package run out of time?
 *
 * client_packages.expires_at (007_all_features.sql:104) is a real instant and
 * a real column, and until now nothing read it: a six month course bought two
 * years ago still handed out free sessions, because "sessions left" was the
 * only question anyone asked. status can say 'expired' too, but only if
 * something has been through and set it, and nothing ever has.
 *
 * No expires_at means no expiry, which is what a NULL there means.
 */
function packageExpired(clientPkg, now = Date.now()) {
  const raw = clientPkg?.expires_at;
  if (!raw) return false;
  const ms = new Date(raw).getTime();
  if (!Number.isFinite(ms)) return false;   // unreadable date is not an expiry
  return ms < now;
}

/** Sessions left AND still in date. The one question the booking path asks. */
function packageIsRedeemable(clientPkg, now = Date.now()) {
  return packageSessionsRemaining(clientPkg) > 0 && !packageExpired(clientPkg, now);
}

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
 * RESEND CONFIRMATION, AND WHY IT REFUSES.
 *
 * This endpoint SENDS MESSAGES, and it was a GET with no idempotency of any
 * kind. A GET is re-fired by browser prefetch, by refreshes and retries, by
 * link unfurlers, and by WhatsApp itself, which fetches a url the moment
 * somebody pastes it in order to draw the preview card. Fired twice seven
 * seconds apart by accident on 26 August, a real client received two identical
 * confirmations on two channels.
 *
 * The guard is modelled on the Stripe refund one in routes/stripe.js, and the
 * shape it copies is the important part: do not trust the caller's intent,
 * OBSERVE whether the thing already happened. There the witness is the
 * charge's amount_refunded; here it is appointments.confirmation_sent_at,
 * which notifyBookingConfirmed stamps only when something really left (see
 * services/notifications.js, and confirmation-honesty.test.js for why the
 * "only" matters). A run that delivered nothing leaves no stamp and is
 * therefore never refused, which is exactly right: the whole point of this
 * endpoint is the case where nothing arrived.
 *
 * The refusal is answered honestly and with a time, not swallowed and not
 * reported as a send: `sent: false, duplicate: true, already_sent_at`, plus
 * when it can be tried again. Same as the refund route answering
 * `success: false, duplicate: true` rather than handing back the first
 * refund's id and calling it a second one.
 *
 * confirmation_sent_at is a REAL INSTANT (like created_at), not the salon wall
 * time convention that appointments.starts_at follows, so Date.parse is the
 * right way to read it.
 */
export const RESEND_IDEMPOTENCY_WINDOW_MS = 2 * 60 * 1000;

/**
 * Did a confirmation for this appointment already go out inside the window?
 * Returns null when it is fine to send, or the evidence when it is not.
 */
export function resendReplay(confirmationSentAt, now = Date.now()) {
  const ms = Date.parse(confirmationSentAt || '');
  if (!Number.isFinite(ms)) return null;
  const ageMs = now - ms;
  // A stamp in the future is a clock problem, not a duplicate. Do not refuse
  // on it: a client who got nothing must always be able to ask again.
  if (ageMs < 0 || ageMs > RESEND_IDEMPOTENCY_WINDOW_MS) return null;
  return {
    sentAt: new Date(ms).toISOString(),
    secondsAgo: Math.round(ageMs / 1000),
    retryAfterSeconds: Math.max(1, Math.ceil((RESEND_IDEMPOTENCY_WINDOW_MS - ageMs) / 1000)),
  };
}

/**
 * The stamp is the authority, but it only exists once the send has FINISHED,
 * and notifyBookingConfirmed talks to Meta, Bird and Resend in turn, which can
 * take seconds. Two fires inside that gap both read a null stamp and both send.
 * A browser that prefetches and then navigates does exactly that.
 *
 * So the claim is taken the moment we decide to send, and a live claim counts
 * as the same evidence the stamp does. Per process and deliberately so: it is a
 * narrowing of the same guard, not a second one, and the durable answer is
 * still confirmation_sent_at. Entries are dropped once they age past the
 * window, so this cannot grow.
 */
const resendClaims = new Map(); // appointmentId -> ISO string of when we started

function claimResend(appointmentId, now = Date.now()) {
  for (const [id, at] of resendClaims) {
    if (now - Date.parse(at) > RESEND_IDEMPOTENCY_WINDOW_MS) resendClaims.delete(id);
  }
  const held = resendClaims.get(appointmentId);
  if (held && resendReplay(held, now)) return held;
  resendClaims.set(appointmentId, new Date(now).toISOString());
  return null;
}

async function resendConfirmationHandler(req, res) {
  try {
    // no-store, because the other half of "a GET that sends" is a GET whose
    // answer gets cached and replayed by something that is not the client.
    res.set('Cache-Control', 'no-store');

    const { data: appt } = await supabase
      .from('appointments')
      .select('id, confirmation_sent_at, beauticians(booking_slug)')
      .eq('management_token', req.params.token)
      .maybeSingle();
    if (!appt || appt.beauticians?.booking_slug !== req.params.slug) {
      return res.status(404).json({ error: 'not_found' });
    }

    // Either the durable evidence, or a send already in flight for this
    // booking. Same window, same answer.
    const replay = resendReplay(appt.confirmation_sent_at) || resendReplay(claimResend(appt.id));
    if (replay) {
      logger.warn(
        { appointmentId: appt.id, method: req.method, secondsAgo: replay.secondsAgo },
        'resend-confirmation refused: a confirmation for this booking went out moments ago',
      );
      // confirmation_sent_at is a real instant, so it is CONVERTED for display,
      // the opposite of what starts_at needs. Europe/London is the salon clock
      // this product assumes everywhere else (see lib/marketing-guard.js), and
      // showing a BST send as a UTC time would put it an hour in the past.
      const whenLabel = new Date(replay.sentAt).toLocaleTimeString('en-GB', {
        hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London',
      });
      const agoLabel = replay.secondsAgo < 5 ? 'moments ago' : `${replay.secondsAgo} seconds ago`;
      return res.json({
        ok: true,
        sent: false,
        duplicate: true,
        channels: [],
        reason: 'already_sent',
        already_sent_at: replay.sentAt,
        seconds_ago: replay.secondsAgo,
        retry_after_seconds: replay.retryAfterSeconds,
        message: `This confirmation already went out ${agoLabel}, at ${whenLabel}. Nothing new was sent just now, so the client will not receive it twice. If it genuinely has not arrived, try again in ${replay.retryAfterSeconds} seconds.`,
      });
    }

    const { notifyBookingConfirmed } = await import('../services/notifications.js');
    // Report what actually happened. This used to answer `sent: true`
    // unconditionally, without reading the return value — which was fair
    // enough when there was no return value to read, and is exactly the class
    // of untrue reassurance that put two consultation forms on one client's
    // phone.
    let result;
    try {
      result = await notifyBookingConfirmed(appt.id);
    } finally {
      // Nothing delivered means nothing to be idempotent about, and this
      // client is by definition the one waiting for a message that never
      // arrived. Give the claim straight back so she can ask again now. Same
      // rule as the stamp, which notifyBookingConfirmed also withholds when
      // every channel declined.
      if (!result?.sent) resendClaims.delete(appt.id);
    }
    logger.info(
      { appointmentId: appt.id, method: req.method, sent: !!result?.sent, reason: result?.reason, link: result?.link || null },
      'Booking confirmation re-sent',
    );
    return res.json({
      ok: true,
      sent: !!result?.sent,
      duplicate: false,
      channels: result?.channels || [],
      reason: result?.reason || null,
      // Whether she can actually act on the booking she was just sent.
      link: result?.link || null,
    });
  } catch (err) {
    logger.error({ err }, 'resend-confirmation failed');
    return res.status(500).json({ error: 'failed' });
  }
}

/**
 * POST /api/booking/:slug/manage/:token/resend-confirmation
 * The one that should be used: a send is not a safe method.
 *
 * GET /api/booking/:slug/manage/:token/resend-confirmation
 * Kept, because this url is pasted into browsers and support threads by hand
 * and there is no way to know it has stopped being. It is now guarded rather
 * than removed. Authed by the unguessable per-appointment management token.
 */
router.post('/:slug/manage/:token/resend-confirmation', resendConfirmationHandler);
router.get('/:slug/manage/:token/resend-confirmation', resendConfirmationHandler);

/**
 * GET /api/booking/:slug/manage/:token/calendar.ics
 *
 * The booking as a calendar file. Authed by the same unguessable per-
 * appointment token the manage page uses, so a client can add it from the link
 * in her text without signing in to anything.
 *
 * This is the SMS and WhatsApp half of the answer: those messages can only
 * carry a link, and the link already goes to the manage page, so the manage
 * page gets an "Add to my calendar" button that points here.
 */
/**
 * GET /api/booking/:slug/manage/:token/calendar
 *
 * The HTML landing page. This is what the SMS and the WhatsApp message link
 * to, NOT the .ics itself — see lib/calendar-page.js for why a bare file link
 * silently does nothing inside WhatsApp's browser.
 */
router.get('/:slug/manage/:token/calendar', async (req, res) => {
  try {
    const appt = await loadForCalendar(req.params.token, req.params.slug);
    if (!appt) return res.status(404).type('html').send('<p>Booking not found.</p>');

    const base = `${req.protocol}://${req.get('host')}/api/booking/${encodeURIComponent(req.params.slug)}/manage/${encodeURIComponent(req.params.token)}`;
    const manageUrl = FRONTEND_URL ? `${FRONTEND_URL}/book/${req.params.slug}/manage/${req.params.token}` : null;
    const whenLabel = `${new Date(appt.starts_at).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })} at ${new Date(appt.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })}`;

    res.status(200).type('html').set('Cache-Control', 'no-store').send(calendarLandingPage({
      treatmentName: appt.treatments?.name,
      businessName: appt.beauticians?.business_name || appt.beauticians?.first_name,
      whenLabel,
      icsUrl: `${base}/calendar.ics`,
      googleUrl: googleCalendarUrl({
        startsAt: appt.starts_at, endsAt: appt.ends_at,
        treatmentName: appt.treatments?.name,
        businessName: appt.beauticians?.business_name || appt.beauticians?.first_name,
        location: appt.beauticians?.address || null,
        manageUrl,
      }),
      manageUrl,
      brand: appt.beauticians?.brand_color || '#92405E',
    }));
  } catch (err) {
    logger.error({ err }, 'calendar landing page failed');
    return res.status(500).type('html').send('<p>Something went wrong. Ask your beautician to resend your confirmation.</p>');
  }
});

/** The one read both calendar endpoints do, so they cannot disagree. */
async function loadForCalendar(token, slug) {
  const { data: appt } = await supabase
    .from('appointments')
    .select('id, starts_at, ends_at, status, reschedule_count, treatments(name), beauticians(business_name, first_name, booking_slug, address, brand_color)')
    .eq('management_token', token)
    .maybeSingle();
  if (!appt || appt.beauticians?.booking_slug !== slug) return null;
  return appt;
}

router.get('/:slug/manage/:token/calendar.ics', async (req, res) => {
  try {
    const appt = await loadForCalendar(req.params.token, req.params.slug);
    if (!appt) return res.status(404).json({ error: 'not_found' });
    const manageUrl = FRONTEND_URL
      ? `${FRONTEND_URL}/book/${req.params.slug}/manage/${req.params.token}`
      : null;
    const body = appointmentIcs({
      id: appt.id,
      startsAt: appt.starts_at,
      endsAt: appt.ends_at,
      treatmentName: appt.treatments?.name,
      businessName: appt.beauticians?.business_name || appt.beauticians?.first_name,
      location: appt.beauticians?.address || null,
      manageUrl,
      cancelled: DEAD_STATUSES.includes(appt.status),
      sequence: appt.reschedule_count || 0,
    });
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    // `attachment` so iOS hands it to Calendar rather than rendering it as
    // text in Safari, which is what happens with inline.
    res.setHeader('Content-Disposition', 'attachment; filename="booking.ics"');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(body);
  } catch (err) {
    logger.error({ err }, 'calendar.ics failed');
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
      const paid = session?.payment_status === 'paid';
      if (appointmentId && paid) {
        const { data: appt } = await supabase
          .from('appointments')
          .select('id, deposit_paid')
          .eq('id', appointmentId)
          .maybeSingle();
        if (appt && !appt.deposit_paid) {
          // The status transition moved OUT of this update on 31 August 2026.
          // It is now made by announceBookingConfirmed below, conditionally, so
          // that whichever of this redirect and the Stripe webhook gets there
          // first is the one and only writer that tells the owner. The guard
          // that used to do that job (`!appt.deposit_paid`, just above) is
          // one-shot: four other writers set deposit_paid true, so whichever
          // landed first disarmed it for good.
          await supabase
            .from('appointments')
            .update({
              deposit_paid: true,
              deposit_status: 'paid',
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

              // 1. deposit transaction (guarded so a retry cannot double-log).
              // The client refreshing the confirmation tab replays this whole
              // block, so the guard is the only thing between one deposit and
              // two income rows. The error was NOT destructured: a transient
              // read failure returned null, `already` came back undefined, and
              // the insert ran regardless. Refuse instead, exactly as
              // chargeRemainingBalance does with reason 'guard_unreadable'.
              // Type list is canonical, see lib/money-guards.js.
              const { data: already, error: alreadyErr } = await supabase
                .from('transactions')
                .select('id')
                .eq('appointment_id', appointmentId)
                .in('type', BOOKING_MONEY_LOGGED_TYPES)
                .limit(1);
              if (alreadyErr) {
                logger.error({ err: alreadyErr, appointmentId }, 'confirm-redirect: deposit guard unreadable, not logging');
                Sentry.captureMessage('Deposit not logged: guard unreadable', {
                  level: 'warning',
                  tags: { area: 'payments', check: 'deposit_guard' },
                  extra: {
                    appointmentId,
                    amountPence: session.amount_total ?? null,
                    dbError: alreadyErr.message,
                    dbCode: alreadyErr.code,
                  },
                });
              } else if (!already?.length) {
                const { error: depErr } = await supabase.from('transactions').insert({
                  beautician_id: full.beautician_id,
                  appointment_id: appointmentId,
                  client_id: full.client_id || null,
                  amount_cents: session.amount_total ?? full.deposit_cents ?? 0,
                  type: full.payment_type === 'full' ? 'full_payment' : 'deposit',
                  status: 'completed',
                  stripe_payment_intent_id: session.payment_intent || null,
                  payment_method: 'card_online',
                });
                if (depErr) {
                  // This is the ONLY path that logs deposits (the webhook was
                  // dead for six weeks). A rejected row here is money the
                  // client paid that never reaches the Money tab.
                  logger.error({ err: depErr, appointmentId }, 'PAID BUT NOT RECORDED: deposit insert failed');
                  Sentry.captureMessage('PAID BUT NOT RECORDED: booking deposit', {
                    level: 'error',
                    tags: { area: 'payments', check: 'transaction_insert' },
                    extra: {
                      appointmentId,
                      beauticianId: full.beautician_id,
                      amountPence: session.amount_total ?? full.deposit_cents ?? 0,
                      paymentIntentId: session.payment_intent || null,
                      dbError: depErr.message,
                      dbCode: depErr.code,
                    },
                  });
                }
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
        }

        // Outside the deposit_paid gate on purpose. Stripe says this session is
        // paid, so the booking is real whoever recorded it, and the claim
        // inside announceBookingConfirmed is what stops a second buzz. If the
        // webhook already confirmed it, this costs one no-op UPDATE and says
        // nothing.
        await announceBookingConfirmed(appointmentId, { source: 'confirm_redirect' });
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
      // The deposit rule IN FORCE, not the raw column. depositAmount used to
      // fall back to '£10' whether or not deposits were switched on, which is
      // where the "Pay £10.00 deposit" button on a brand new salon's page came
      // from. Off means there is no amount to show.
      requireDeposit: salonRequiresDeposit(paySettings),
      depositAmount: salonRequiresDeposit(paySettings) ? (paySettings.deposit_amount ?? '£0') : '£0',
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

  // THE BUTTON HAS TO SAY WHAT THE CARD WILL BE CHARGED.
  //
  // The page prices its own deposit from salon.payment_settings.deposit_amount,
  // falling back to '£10' the way this route's own arithmetic used to, so a
  // salon with require_deposit false still showed "Pay £10.00 deposit" over a
  // booking that now takes nothing. What the page needs is the rule in force,
  // so deposit_amount is cleared when the switch is off rather than handed over
  // as a number the booking route will not honour. require_deposit itself is
  // passed through untouched.
  //
  // '£0' rather than null on purpose: the page reads
  // `deposit_amount || '£10'`, so a null would land straight back on the
  // invented tenner. Zero is also the true answer, which is the point.
  const effectivePaymentSettings = { ...(salon.payment_settings || {}) };
  if (!salonRequiresDeposit(effectivePaymentSettings)) effectivePaymentSettings.deposit_amount = '£0';

  res.json({
    salon: {
      ...salon,
      payment_settings: effectivePaymentSettings,
      loyalty_enabled: loyaltyConfig?.is_active === true,
    },
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

  const { data: appts, error: apptErr } = await supabase
    .from('appointments')
    .select('starts_at, duration_minutes, buffer_minutes')
    .eq('beautician_id', salon.id)
    .gte('starts_at', `${date}T00:00:00`)
    .lte('starts_at', `${date}T23:59:59`)
    .not('status', 'in', '(cancelled,cancelled_by_client,cancelled_by_beautician,rescheduled)');

  // PostgREST puts its errors in the result object, so an unchecked destructure
  // leaves this null, the picker greys nothing out and every hour of a full day
  // looks free. An error here has to be an error on the page, not a diary with
  // no bookings in it.
  if (apptErr) {
    logger.error({ err: apptErr, beauticianId: salon.id, date }, 'availability: could not read the diary');
    return res.status(500).json({ error: 'Could not load availability. Please try again.' });
  }

  // Blocked-off time for the day: partial (amended) blocks come back with
  // their time range so the picker can grey those slots out; anything
  // without a usable range is treated as a full-day closure.
  //
  // A closure is a RANGE, date..end_date. This matched on `date` alone, so a
  // holiday entered as 24 to 30 August greyed out the 24th and showed the
  // other six days as a normal working week. Widen the lower bound (see
  // MAX_BLOCK_LOOKBACK_DAYS in lib/free-slots.js) so a closure that STARTED
  // earlier and is still running is fetched, then let blockCoversDay decide.
  const { data: exceptionRows, error: exceptionErr } = await supabase
    .from('hours_exceptions')
    .select('date, end_date, type, start_time, end_time')
    .eq('beautician_id', salon.id)
    .gte('date', blockLookbackFrom(date))
    .lte('date', date);

  // Same failure, worse consequence: unread exceptions show a closed day as
  // bookable, so a client picks a time in the middle of Ellie's holiday.
  if (exceptionErr) {
    logger.error({ err: exceptionErr, beauticianId: salon.id, date }, 'availability: could not read the blocked time');
    return res.status(500).json({ error: 'Could not load availability. Please try again.' });
  }

  const blocks = [];
  let dayClosed = false;
  // The query narrows; this decides. A row only counts if its own
  // date..end_date span actually contains the day being asked about.
  for (const r of (exceptionRows || []).filter(r => blockCoversDay(r, date))) {
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

  const { data: appts, error: apptErr } = await supabase
    .from('appointments')
    .select('starts_at, duration_minutes, buffer_minutes')
    .eq('beautician_id', salon.id)
    .gte('starts_at', `${from}T00:00:00`)
    .lte('starts_at', `${to}T23:59:59`)
    .not('status', 'in', '(cancelled,cancelled_by_client,cancelled_by_beautician,rescheduled)');

  // An unread month reads as an empty month: every day in the grid shows space.
  if (apptErr) {
    logger.error({ err: apptErr, beauticianId: salon.id, from, to }, 'availability-range: could not read the diary');
    return res.status(500).json({ error: 'Could not load availability. Please try again.' });
  }

  // Blocked-off time: full-day closures AND partial-day (amended) blocks.
  // Previously only type='closed' was returned, so a client could book
  // straight into an hour the beautician had blocked out.
  //
  // And a closure is a RANGE, date..end_date. This read `r.date` only, so the
  // month grid marked the first day of a holiday closed and left the rest of
  // it looking like a normal week. The lower bound is widened (see
  // MAX_BLOCK_LOOKBACK_DAYS in lib/free-slots.js) so a fortnight off that
  // began before `from` is fetched too; blockDays then expands each row into
  // the days it actually covers, clamped to the window.
  const { data: exceptionRows, error: exceptionErr } = await supabase
    .from('hours_exceptions')
    .select('date, end_date, type, start_time, end_time')
    .eq('beautician_id', salon.id)
    .gte('date', blockLookbackFrom(from))
    .lte('date', to);

  // And an unread exception list reads as "she never takes a day off".
  if (exceptionErr) {
    logger.error({ err: exceptionErr, beauticianId: salon.id, from, to }, 'availability-range: could not read the blocked time');
    return res.status(500).json({ error: 'Could not load availability. Please try again.' });
  }

  const closureDays = new Set();
  const blocks = [];
  const seenBlock = new Set();
  for (const r of exceptionRows || []) {
    // One row, every day it covers. A null or blank end_date is a single day.
    for (const day of blockDays(r, from, to)) {
      if (r.type !== 'closed' && r.start_time && r.end_time) {
        const key = `${day}|${r.start_time}|${r.end_time}`;
        if (seenBlock.has(key)) continue;
        seenBlock.add(key);
        blocks.push({ date: day, start_time: r.start_time, end_time: r.end_time });
      } else {
        closureDays.add(day);
      }
    }
  }
  const closures = [...closureDays].sort();

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
router.post('/:slug/lookup-client', requireBookingIdentity, async (req, res) => {
  try {
    const { email, phone, treatment_ids } = req.body;
    if (!email && !phone) return res.json({ found: false });

    // Get beautician ID
    const { data: b } = await supabase
      .from('beauticians')
      .select('id')
      .eq('booking_slug', req.params.slug)
      .single();
    if (!b) return res.status(404).json({ error: 'Not found' });

    // Saved details are accessible only through the verified email.
    const selectCols = 'id, first_name, last_name, email, phone';
    let client = null;

    if (email) {
      const { data, error } = await supabase
        .from('clients')
        .select(selectCols)
        .eq('beautician_id', b.id)
        .ilike('email', exactEmailPattern(email))
        .maybeSingle();
      if (error) return res.status(503).json({ error: 'Saved details could not be checked. Please try again.' });
      client = data;
    }


    /* WHAT SHE IS BOOKING, resolved before the not-found return, because the
     * page needs an answer about the form either way and the answer for
     * somebody with no row at all is the one that still walls.
     *
     * treatment_ids is what she has in her basket right now. The page sends it
     * with every lookup and re-asks when the basket changes, because "does she
     * need a form" is a question about a treatment, not about a person.
     */
    const wantedTreatments = [...new Set((Array.isArray(treatment_ids) ? treatment_ids : [])
      .filter(t => typeof t === 'string' && t))].slice(0, 10);
    let consultationTreatments = [];
    if (wantedTreatments.length > 0) {
      const { data: tRows, error: tErr } = await supabase
        .from('treatments')
        .select('id, requires_consultation, consultation_form_id')
        .eq('beautician_id', b.id)
        .in('id', wantedTreatments);
      // Unread, this error would say "no treatment needs a consultation" and
      // the page would skip the form for everybody. Read, it says we do not
      // know, and not knowing asks.
      if (tErr) {
        logger.warn({ err: tErr, beauticianId: b.id }, 'lookup-client: treatment read failed');
        consultationTreatments = wantedTreatments.map(id => ({ id, requires_consultation: true, consultation_form_id: null }));
      } else {
        consultationTreatments = tRows || [];
      }
    }

    /* WHETHER TO ASK HER THE HEALTH QUESTIONS, decided here rather than on the
     * page.
     *
     * Until 29 August 2026 the page decided it itself, from
     * `recognisedClient?.found`, which means only "a clients row matched on
     * email or the last nine digits of the phone". Of 1,151 clients, 926 came
     * in from Timely and every one of them is `found`; 277 of those have no
     * history of any kind and had never once been asked about allergies,
     * medication or pregnancy. The page now asks the server, the server
     * answers with lib/consultation-status.js, and services/
     * conversational-booking.js answers from the same function, so the booking
     * page and Florrie cannot reach different verdicts about the same client
     * and the same treatment.
     */
    const shapeConsultation = (status) => ({
      ask: status.ask,
      block: status.block,
      reason: status.reason,
      needsConsultation: status.needsConsultation,
      formOnFile: status.formOnFile,
      // Echoed so a page holding a verdict from an older basket can tell.
      treatmentIds: wantedTreatments,
    });

    if (!client) {
      // Nobody in the book by this email or number. This is the ONE population
      // that is refused rather than chased, and it is refused exactly as it
      // was before 29 August 2026. POST /book enforces it again server side,
      // which is where it actually holds.
      const strangerStatus = await readConsultationStatus(supabase, {
        beauticianId: b.id, clientId: null, treatments: consultationTreatments,
        inDatabase: false, logger,
      });
      return res.json({ found: false, consultation: shapeConsultation(strangerStatus) });
    }

    // Anything still owed from previous visits (unpaid policy fee or an
    // unsettled remainder). The confirm step shows a warm heads-up so the
    // client is not surprised at the till. Fails OPEN inside the service:
    // any error means zero, and zero means no notice. Never blocks booking.
    const { owesCents } = await getOutstandingBalanceCents(b.id, client.id);

    /* HAS SHE ACTUALLY BEEN HERE BEFORE, which is NOT the same question as
     * `found`. `found` means "there is a row for her", and after the Timely
     * import there is a row for 926 people including all 277 who have never
     * once sat in the chair. One of them wrote at 01:18 on 27 August 2026:
     * "hey I have a appointment on the 3rd of September and I just went onto
     * the website and it said about a patch test do I need to book one in or
     * not x". She did need one. The 673 imported regulars reading the same
     * banner did not, and had no way to tell.
     *
     * So the booking page gets the real distinction: prior history from before
     * Florrie (clients.total_visits / last_visit_at, written by the importer)
     * OR a completed appointment inside it. Returning, or not. It says nothing
     * about patch tests and is used only to stop the page asserting one.
     */
    const [{ data: upcoming }, { data: pendingTests }, { data: pendingForms }, { data: lastVisit }, priorHistory] = await Promise.all([
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

      // One definition of "has she been here before", shared with the
      // consultation rule and with lib/patch-test-status.js rather than
      // rebuilt here. See lib/consultation-status.js.
      hasPriorHistory(supabase, { beauticianId: b.id, clientId: client.id, logger }),
    ]);

    const consultation = await readConsultationStatus(supabase, {
      beauticianId: b.id,
      clientId: client.id,
      treatments: consultationTreatments,
      // She matched a clients row, so she is in the book. This is the fact
      // that keeps `block` false for her: the wall is for people who are not.
      inDatabase: true,
      // Already read, a few lines up, for the same client. This page calls
      // lookup-client on every blur of the phone and email boxes, so reading
      // it twice per keystroke-and-tab is a cost for nothing.
      knownPriorHistory: priorHistory,
      logger,
    });

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
      // She has been here before. Never a claim that she has had a patch test:
      // it only stops the page telling a regular she needs one.
      returningClient: !!priorHistory?.known,
      priorVisits: priorHistory?.totalVisits || 0,
      // What the booking page obeys. `ask` shows the form, `block` refuses to
      // book without it, and `block` is never true here: she is in the book.
      consultation: shapeConsultation(consultation),
      lastTreatment,
      outstandingBalanceCents: owesCents || 0,
    });
  } catch (err) {
    logger.error({ err }, 'Client lookup failed');
    res.json({ found: false }); // fail silently, do not block booking
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
        payment_expires_at, policy_snapshot, client_email, extra_treatment_ids,
        price_cents, deposit_cents, deposit_amount_cents, deposit_paid, deposit_status,
        payment_type, stripe_payment_intent_id, stripe_payment_method_id,
        treatments(id, name, duration_minutes, price_cents, category, requires_patch_test),
        clients(id, first_name, last_name, email, phone, stripe_customer_id),
        beauticians(id, first_name, business_name, phone, booking_policy, booking_slug, brand_color, patch_test_expiry_months, patch_test_block_booking, payment_settings)
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

    const [{ data: patchTests }, { data: pendingForms }, { data: upfrontTxRows }] = await Promise.all([
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
        .eq('appointment_id', appt.id)
        .gt('expires_at', new Date().toISOString())
        .eq('client_id', clientId)
        .eq('beautician_id', beauticianId)
        .eq('status', 'pending')
        .limit(5),

      // What was ACTUALLY charged at booking, from the transaction log. This
      // is the figure on the client's card statement, so it is the figure the
      // receipt must show. Never recompute it from the treatment price.
      supabase
        .from('transactions')
        .select('amount_cents, type')
        .eq('appointment_id', appt.id)
        .eq('status', 'completed')
        .in('type', ['deposit', 'full_payment'])
        .limit(1),
    ]);

    // EVERYTHING SHE BOOKED, not just the first thing.
    //
    // Two of Ellie's clients messaged her about this within a week. Sasha
    // booked brows AND a Korean lash lift and her page said "Signature brows,
    // 30 min, GBP 30" while charging her the GBP 80 for both. Anastasia booked
    // two and saw one. Ellie had to reassure them by hand that the diary was
    // right, which is the opposite of what a confirmation is for: it made her
    // look disorganised for a bug that was ours.
    //
    // The extras have always been in extra_treatment_ids, and the diary and
    // the money both use them. This page just never asked for them.
    let extraTreatments = [];
    if (Array.isArray(appt.extra_treatment_ids) && appt.extra_treatment_ids.length > 0) {
      const { data: extras, error: extrasErr } = await supabase
        .from('treatments')
        .select('id, name, duration_minutes, price_cents, category, requires_patch_test')
        .eq('beautician_id', beauticianId)
        .in('id', appt.extra_treatment_ids);
      // Checked: an unchecked error here silently reproduces the exact bug
      // this code was written to fix.
      if (extrasErr) {
        logger.error({ err: extrasErr, appointmentId: appt.id }, 'Could not load the extra treatments for the manage page');
      } else {
        // Keep her booking order rather than whatever PostgREST returned.
        const byId = new Map((extras || []).map(t => [t.id, t]));
        extraTreatments = appt.extra_treatment_ids.map(id => byId.get(id)).filter(Boolean);
      }
    }

    const allTreatments = [appt.treatments, ...extraTreatments].filter(Boolean);
    const combined = combineTreatments(allTreatments);

    /* ---- does she owe a patch test for THIS booking, and who should be told
     *
     * This is the block that cost Sophie a slot and Ellie a message. It used
     * to be three lines that between them could only ever produce one answer:
     *
     *   hasValidPatchTest  tested `pt.status === 'passed'`, a word nothing in
     *                      this codebase writes and the schema does not know.
     *                      Always false, for everybody, forever.
     *   hasPendingPatchTest  needed a patch_tests ROW to exist, and a client
     *                      tested in the chair has no row.
     *
     * so a returning client got a flat "you need a patch test" and booked one
     * she did not need. The evidence rule lives in lib/patch-test-status.js
     * now and is shared with the swap and add-treatment gates below.
     *
     * Two changes of substance beyond fixing the vocabulary:
     *
     *   The requirement is read off EVERY treatment on the booking, not just
     *   the first. Extras have always lived in extra_treatment_ids and a lash
     *   tint added as an extra needs a test exactly as much as one booked as
     *   the main thing.
     *
     *   Evidence is judged against the APPOINTMENT's wall date, not today. A
     *   test done in August covers a September booking and does not cover one
     *   next April, and the question on this page is about the booking in
     *   front of her.
     */
    const treatmentRequiresPatchTest = allTreatments.some(t => t?.requires_patch_test === true);
    const evidence = treatmentRequiresPatchTest
      ? await patchTestEvidence(supabase, beauticianId, clientId, {
          expiryMonths,
          asOf: appt.starts_at,
          logger,
        })
      : {
          ok: false, kind: 'none', when: null, pending: false, completedVisits: 0,
          priorHistory: { known: false, inWindow: false, totalVisits: 0, lastVisit: null, importedFrom: null, failed: false },
        };

    /* WHO GETS TOLD, when the evidence is merely ABSENT rather than negative.
     *
     * "You need a patch test" is an assertion. It is only true of a client we
     * know has never sat in this chair, and for her it is worth saying plainly
     * because she genuinely does need one and she can book it herself.
     *
     * For a returning client with nothing on file it is a guess, and it is the
     * guess that goes wrong in the expensive direction: she books a slot she
     * does not need, the diary loses it, and the owner spends her evening
     * undoing it. The person who actually knows is Ellie, and she is also the
     * only one who can fix it, in one tap, from the Patch Tests page. So the
     * uncertain case is not asserted to the client at all: the client is told
     * the truth, which is that the salon will check, and the ASKING happens on
     * the owner's side (GET /api/appointments/patch-test-alerts).
     *
     * A recorded reaction is not an absence and never becomes a booking
     * button. That one goes straight to the owner too.
     */
    /* AND WHO COUNTS AS "NEVER BEEN IN", WHICH WAS THE 27 AUGUST DEFECT.
     *
     * At 01:18 on 27 August 2026 a client wrote: "hey I have a appointment on
     * the 3rd of September and I just went onto the website and it said about
     * a patch test do I need to book one in or not x". She was one of the 277
     * genuine first timers, so the system was right about her. It was wrong
     * about 673 other people, and it could not tell them apart.
     *
     * `evidence.completedVisits === 0` used to be the whole test for "she has
     * never been here", and it counts Florrie-era completed appointments only.
     * The Timely import writes clients.total_visits and clients.last_visit_at
     * and creates no appointments, so of 854 imported clients carrying a real
     * total_visits, 673 had zero completed appointments inside Florrie and
     * every one of them was told flatly that she needed a patch test.
     *
     * Three populations, three behaviours, and this ladder is where they part:
     *
     *   recent regular   prior history, last visit inside her own expiry
     *                    window. 52 of the 673. She is told nothing and
     *                    nobody is asked: she was in this salon inside the
     *                    very window the setting defines.
     *   stale regular    prior history, last visit outside the window or no
     *                    usable date at all. 621 of the 673, and the reason a
     *                    blanket "regulars are fine" would be dangerous: her
     *                    last recorded visit predates the salon's own six
     *                    month expiry and the next thing she sits down for is
     *                    a chemical tint. The CLIENT is told nothing; the
     *                    OWNER is asked, on the Patch Tests page.
     *   true first timer no history of any kind. 277 of them. Told plainly,
     *                    exactly as before, because it is true of her.
     *
     * Prior history buys a returning client out of being TOLD something this
     * app does not know. It is never read as a patch test. See the
     * PRIOR HISTORY block in lib/patch-test-status.js.
     */
    let patchTestCertainty = 'not_required';
    let patchTestAsk = null;
    if (treatmentRequiresPatchTest) {
      const prior = evidence.priorHistory || { known: false, inWindow: false };
      if (evidence.kind === 'unknown') { patchTestCertainty = 'unknown'; patchTestAsk = 'owner'; }
      else if (evidence.ok) { patchTestCertainty = 'satisfied'; }
      else if (evidence.kind === 'adverse') { patchTestCertainty = 'adverse'; patchTestAsk = 'owner'; }
      else if (evidence.pending) { patchTestCertainty = 'booked'; }
      else if (prior.known && prior.inWindow) { patchTestCertainty = 'recent_regular'; }
      else if (prior.known) { patchTestCertainty = 'uncertain'; patchTestAsk = 'owner'; }
      else if (evidence.completedVisits === 0) { patchTestCertainty = 'never_visited'; patchTestAsk = 'client'; }
      else { patchTestCertainty = 'uncertain'; patchTestAsk = 'owner'; }
    }

    // needsPatchTest keeps its name and its meaning to the page: show her the
    // demand and the booking button. It is now only true when the demand is a
    // true statement rather than a guess.
    const needsPatchTest = patchTestCertainty === 'never_visited';
    // And a client is never locked out of her own booking on a guess.
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
        depositPaid: !!appt.deposit_paid,
        paymentExpiresAt: appt.payment_expires_at,
        treatment: appt.treatments,
        // The full list, plus the totals that go with it. `treatment` stays as
        // it was so nothing that reads it breaks; anything showing the client
        // what she booked should use these.
        treatments: allTreatments,
        totalDurationMinutes: combined.durationMinutes || appt.treatments?.duration_minutes || 0,
        totalPriceCents: appt.price_cents || combined.priceCents || 0,
        client: {
          name: `${appt.clients?.first_name} ${appt.clients?.last_name || ''}`.trim(),
          email: appt.clients?.email || appt.client_email,
          phone: appt.clients?.phone,
        },
        beautician: {
          name: appt.beauticians?.business_name || appt.beauticians?.first_name,
          brandColor: appt.beauticians?.brand_color,
          // Her business number, so "no times are free, please get in touch"
          // is something the client can act on rather than a dead end. This is
          // the same number the Instagram auto-reply already hands out as a
          // wa.me link; the login email deliberately stays private.
          phone: appt.beauticians?.phone || null,
        },
      },
      // Remaining balance after the deposit, plus the beautician's bank details
      // so the client can pay the rest by transfer.
      payment: (() => {
        const priceCents = appt.price_cents || appt.treatments?.price_cents || 0;
        const upfrontTx = (upfrontTxRows || [])[0] || null;
        // A deposit counts as paid when a transaction was logged OR the
        // appointment itself says so. The fallback exists because the Stripe
        // webhook historically failed to fire, leaving genuinely paid deposits
        // with no transaction row; the intent stamped on the appointment is
        // proof enough that the money moved.
        const depositEvidenced = !!(
          upfrontTx ||
          appt.deposit_paid ||
          (appt.stripe_payment_intent_id && appt.deposit_status === 'paid')
        );
        // What we display as paid: prefer the logged charge (matches the card
        // statement, and includes any add-ons paid alongside the deposit),
        // then the amount the checkout was created for, then the configured
        // deposit. The remaining balance is worked out from the deposit
        // portion only, because add-ons were already paid in full.
        const depositPortionCents = appt.deposit_amount_cents ?? appt.deposit_cents ?? 0;
        const paidCents = depositEvidenced
          ? (upfrontTx?.amount_cents ?? depositPortionCents)
          : 0;
        const paidInFull = depositEvidenced &&
          (appt.payment_type === 'full' || upfrontTx?.type === 'full_payment');
        return {
          priceCents,
          depositPaidCents: paidCents,
          paidInFull,
          remainingCents: paidInFull
            ? 0
            : Math.max(0, priceCents - (depositEvidenced ? (depositPortionCents || paidCents) : 0)),
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
      // The whole picture, so the page can be honest instead of flat. See the
      // block above for what each certainty means and why the uncertain case
      // is addressed to the owner rather than to the client.
      patchTest: {
        required: treatmentRequiresPatchTest,
        certainty: patchTestCertainty,
        ask: patchTestAsk,
        evidence: evidence.kind,
        evidenceDate: evidence.when,
        expiryMonths,
        // Whether she is a returning client, and nothing more than that. The
        // page uses it to keep quiet, never to claim she is cleared.
        returningClient: !!(evidence.priorHistory?.known) || evidence.completedVisits > 0,
      },
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
      // beautician_id is here because the cancellation push below passes it.
      // It was not in the select, so it was always undefined, pushClientCancelled
      // had nobody to send to, and Ellie was never told a client had cancelled.
      .select('id, starts_at, status, policy_snapshot, client_id, beautician_id, price_cents, deposit_cents, deposit_paid, stripe_payment_method_id, clients(first_name, stripe_customer_id), beauticians(booking_policy, booking_slug)')
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
      .select('id, starts_at, client_id, treatment_id, extra_treatment_ids, treatments(requires_patch_test), beauticians(id, booking_slug, patch_test_expiry_months)')
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

    // A treatment needing a patch test she has no evidence of is not a valid
    // swap: it would quietly put her into an appointment she cannot have.
    //
    // This used to read `pt.status === 'passed'`, a value nothing has ever
    // written to that column, so it was false for everyone and the only
    // treatments offered here were the ones needing no test at all. The one
    // rule now lives in lib/patch-test-status.js and counts a completed
    // treatment that required a test as the evidence it plainly is.
    const evidence = await patchTestEvidence(supabase, appt.beauticians.id, appt.client_id, {
      expiryMonths: appt.beauticians.patch_test_expiry_months || 6,
      asOf: appt.starts_at,
      logger,
    });
    const hasValidPatchTest = evidence.ok;
    // If what they ALREADY booked needs a patch test, they are in that lane
    // and a test is either done or on the way, so swapping to another
    // patch-test treatment adds no new requirement. Without this, the exact
    // swap Ellie asked for (lamination -> lamination maintenance) was hidden.
    const alreadyInPatchTestLane = appt.treatments?.requires_patch_test === true;
    const patchTestOk = hasValidPatchTest || alreadyInPatchTestLane;

    res.json({
      current_treatment_id: appt.treatment_id,
      // What is already on the booking, so the page can offer "add" without
      // offering something they have already got. Added alongside the existing
      // fields rather than replacing any, so the swap picker is untouched.
      extra_treatment_ids: Array.isArray(appt.extra_treatment_ids) ? appt.extra_treatment_ids : [],
      treatments: (treatments || [])
        .filter(t => !t.requires_patch_test || patchTestOk)
        .map(t => ({ id: t.id, name: t.name, duration_minutes: t.duration_minutes, price_cents: t.price_cents })),
    });
  } catch (err) {
    logger.error({ err }, 'Manage treatments list failed');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * She has just changed what she is booked in for from her confirmation link.
 * Does the new treatment need a consultation form, and if so, get one to her.
 *
 * WHY THIS EXISTS. change-treatment and add-treatment both handled patch tests
 * and did nothing whatsoever about consultation forms. So a client could book
 * a wax, open the link in her confirmation text, swap it for a tint, and no
 * consultation was asked of anybody, stranger or regular. That is a bigger
 * hole than the one on the booking page: on the page at least the true first
 * timer was stopped. Here nobody was.
 *
 * CHASE, NOT BLOCK, and here there is nothing to argue about: everybody
 * holding a management token is in the book by definition, so the stranger
 * wall on POST /book cannot apply to them. The swap goes through and the form
 * follows. The rule is the shared one in lib/consultation-status.js.
 *
 * Never throws, never fails a change. A swap that failed because a text could
 * not be sent would be a worse bug than the one being fixed.
 *
 * @param {object} appt the appointment row, with clients(first_name) and
 *   beauticians(id, business_name, first_name) joined
 * @param {Array<object>} treatments the treatment(s) newly on the booking
 * @returns {Promise<{sent: boolean, reason: string}>}
 */
async function chaseConsultationAfterChange(appt, treatments) {
  const beauticianId = appt?.beauticians?.id;
  const clientId = appt?.client_id;
  if (!beauticianId || !clientId) return { sent: false, reason: 'no_client' };

  try {
    const status = await readConsultationStatus(supabase, {
      beauticianId, clientId, treatments, inDatabase: true, logger,
    });
    if (!status.ask) return { sent: false, reason: status.reason };

    /* Do not text her the same form twice. A pending row means one is already
     * on its way and the 24 to 72 hour reminder is already chasing it; a
     * completed row on the OTHER arm of the rule (no prior history, ordinary
     * treatment) means she filled it in at booking half an hour ago. Scoped to
     * the form this treatment asks for, the same way the rule itself is.
     *
     * On an unreadable answer this sends anyway. A duplicate text is the
     * double-ask annoyance Ellie has complained about before and she can say
     * so; a consultation nobody asked for is the thing that put this work on
     * the list at all.
     */
    const formId = treatments.find(t => t?.consultation_form_id)?.consultation_form_id || null;
    let existing = supabase
      .from('consultation_responses')
      .select('id')
      .eq('beautician_id', beauticianId)
      .eq('client_id', clientId)
      .in('status', ['pending', 'completed']);
    if (formId) existing = existing.eq('form_id', formId);
    const { data: already, error: alreadyErr } = await existing.limit(1);
    if (alreadyErr) {
      logger.warn({ err: alreadyErr, appointmentId: appt.id }, 'manage: consultation form lookup failed, sending anyway');
    } else if ((already || []).length > 0) {
      return { sent: false, reason: 'already_asked' };
    }

    /* Her number, read here rather than joined onto the appointment select.
     *
     * Adding `phone` to the clients(...) join would have handed a routing file
     * a client row with contact details and no consent columns, which is the
     * exact shape tests/unit/consent-columns-cannot-be-dropped.js exists to
     * stop. This is a transactional text about a booking she just changed
     * herself, so it does not need her marketing consent, and it should not be
     * carrying it around either.
     */
    const { data: clientRow, error: clientErr } = await supabase
      .from('clients')
      .select('phone')
      .eq('id', clientId)
      .eq('beautician_id', beauticianId)
      .maybeSingle();
    if (clientErr) {
      logger.warn({ err: clientErr, appointmentId: appt.id }, 'manage: could not read the client to send a consultation form');
      return { sent: false, reason: 'no_phone' };
    }
    const phone = clientRow?.phone;
    if (!phone) return { sent: false, reason: 'no_phone' };

    await sendConsultationFormSMS({
      beauticianId,
      clientId,
      appointmentId: appt.id,
      clientPhone: phone,
      clientFirstName: appt.clients?.first_name || 'there',
      treatmentId: (treatments.find(t => t?.consultation_form_id) || treatments[0])?.id || null,
      beauticianName: appt.beauticians.business_name || appt.beauticians.first_name,
    });
    logger.info({ appointmentId: appt.id, clientId, reason: status.reason }, 'Consultation form sent after a manage-page treatment change');
    return { sent: true, reason: status.reason };
  } catch (err) {
    logger.warn({ err, appointmentId: appt?.id }, 'Consultation form after a treatment change failed (non-fatal)');
    return { sent: false, reason: 'failed' };
  }
}

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
        beauticians(id, booking_slug, business_name, first_name, working_hours, timezone, patch_test_expiry_months)
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
      .select('id, name, duration_minutes, price_cents, requires_patch_test, requires_consultation, consultation_form_id')
      .eq('id', treatment_id)
      .eq('beautician_id', appt.beauticians.id)
      .eq('is_active', true)
      .maybeSingle();
    if (!treat) return res.status(400).json({ error: 'That treatment is not available.' });

    // Same rule as the list above: already booked into a patch-test treatment
    // means swapping to another one adds no new requirement.
    if (treat.requires_patch_test && appt.treatments?.requires_patch_test !== true) {
      const evidence = await patchTestEvidence(supabase, appt.beauticians.id, appt.client_id, {
        expiryMonths: appt.beauticians.patch_test_expiry_months || 6,
        asOf: appt.starts_at,
        logger,
      });
      if (!evidence.ok) {
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
    const { data: clash, error: clashErr } = await supabase
      .from('appointments')
      .select('id')
      .eq('beautician_id', appt.beauticians.id)
      .neq('id', appt.id)
      .in('status', ['confirmed', 'pending', 'in_progress'])
      .lt('starts_at', endD.toISOString())
      .gt('ends_at', startD.toISOString());
    // A longer treatment that cannot be checked is a longer treatment that does
    // not get swapped in. Unchecked, this let the new length run over the next
    // client.
    if (clashErr) {
      logger.error({ err: clashErr, appointmentId: appt.id }, 'change-treatment: overrun check failed');
      return res.status(500).json({ error: 'Could not check that just then. Nothing has been changed, please try again.' });
    }
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

    // The swap is done and stays done. The form follows it, it does not gate
    // it. See chaseConsultationAfterChange above.
    const chased = await chaseConsultationAfterChange(appt, [treat]);

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
      consultationFormSent: chased.sent,
      message: `Changed to ${treat.name}. Your deposit stays as it is${remaining > 0 ? `, with £${(remaining / 100).toFixed(2)} to pay on the day` : ''}.${chased.sent ? ' I have texted you a quick health form for that one, it takes about two minutes.' : ''}`,
    });
  } catch (err) {
    logger.error({ err }, 'change-treatment failed');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * POST /api/booking/:slug/manage/:token/add-treatment  { treatment_id }
 *
 * Let the CLIENT add a treatment to a booking they already have.
 *
 * THE MESSAGE THAT ASKED FOR THIS. Lucy Walker, 21 August, 06:50: "Hi - so
 * sorry I just realised I need to add lash lift to this booking! Should have
 * been lash lift + brow lamination, tint." Ellie: "You should be able to add
 * and adjust your booking. Did you receive a link at all?" Lucy: "No I didn't
 * :/". Ellie then spent an hour and a half of her morning on it by hand.
 *
 * Ellie was half right, and the half she was wrong about is this route. The
 * manage page could SWAP a treatment for a different one and nothing else, so
 * even with the link in her hand Lucy could have turned her brow lamination
 * into a lash lift, but not had both. Swapping is not adding, and adding is
 * the thing people actually message about — it is more money for Ellie and a
 * better appointment for the client, and it was the one direction the page
 * refused to go.
 *
 * ADD ONLY, DELIBERATELY. A client may lengthen and enrich their own booking;
 * they may not shorten it. Taking a treatment off drops the price below what
 * may already have been paid, which is a refund Ellie has to chase, and it
 * frees diary time she may have already filled around. Removing stays with
 * her, in the app, where it already works.
 *
 * The deposit does not move here either, exactly as in change-treatment: what
 * they paid carries over and the balance recomputes itself.
 */
router.post('/:slug/manage/:token/add-treatment', async (req, res) => {
  try {
    const { treatment_id } = req.body || {};
    if (!treatment_id) return res.status(400).json({ error: 'Please choose a treatment to add.' });

    const { data: appt } = await supabase
      .from('appointments')
      .select(`
        id, starts_at, ends_at, status, client_id, treatment_id, extra_treatment_ids,
        duration_minutes, price_cents, deposit_cents, deposit_paid,
        buffer_minutes, extra_padding_minutes,
        clients(first_name),
        treatments(id, name, duration_minutes, price_cents, requires_patch_test),
        beauticians(id, booking_slug, business_name, first_name, working_hours, timezone, patch_test_expiry_months)
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

    const currentExtraIds = Array.isArray(appt.extra_treatment_ids) ? appt.extra_treatment_ids : [];
    // Same cap as the app's own path: the list feeds a clash check and a
    // treatments query, and neither wants to be unbounded.
    if (currentExtraIds.length >= 10) {
      return res.status(409).json({ error: 'That is as many treatments as one appointment can hold. Message me and we will sort it.' });
    }
    // A second tap on a slow connection must not book the same thing twice.
    if (treatment_id === appt.treatment_id || currentExtraIds.includes(treatment_id)) {
      return res.status(409).json({ error: 'That treatment is already on this booking.' });
    }

    const { data: treat } = await supabase
      .from('treatments')
      .select('id, name, duration_minutes, price_cents, requires_patch_test, requires_consultation, consultation_form_id')
      .eq('id', treatment_id)
      .eq('beautician_id', appt.beauticians.id)
      .eq('is_active', true)
      .maybeSingle();
    if (!treat) return res.status(400).json({ error: 'That treatment is not available.' });

    // Same patch-test rule as a swap: already being booked into a patch-test
    // treatment means they are in that lane and adding another needs no new
    // test. Otherwise a valid one has to be on file.
    if (treat.requires_patch_test && appt.treatments?.requires_patch_test !== true) {
      const evidence = await patchTestEvidence(supabase, appt.beauticians.id, appt.client_id, {
        expiryMonths: appt.beauticians.patch_test_expiry_months || 6,
        asOf: appt.starts_at,
        logger,
      });
      if (!evidence.ok) {
        return res.status(409).json({ error: 'That treatment needs a patch test first. Please message me and we will sort it.' });
      }
    }

    // Every treatment on the booking after this request, priced together.
    // recomputeTotals is the same function the app uses, so a client adding a
    // treatment and Ellie adding one land on identical numbers.
    const nextExtraIds = [...currentExtraIds, treat.id];
    const wanted = [...new Set([appt.treatment_id, ...nextExtraIds].filter(Boolean))];
    const { data: rows, error: tErr } = await supabase
      .from('treatments')
      .select('id, name, duration_minutes, price_cents')
      .eq('beautician_id', appt.beauticians.id)
      .in('id', wanted);
    if (tErr) {
      logger.error({ err: tErr, appointmentId: appt.id }, 'add-treatment: could not load treatments');
      return res.status(500).json({ error: 'Could not check that just then. Nothing has been changed, please try again.' });
    }
    const byId = Object.fromEntries((rows || []).map(t => [t.id, t]));
    const totals = recomputeTotals({
      baseTreatment: appt.treatment_id ? byId[appt.treatment_id] : null,
      extraTreatments: nextExtraIds.map(id => byId[id]).filter(Boolean),
      existing: appt,
      currentExtras: currentExtraIds.map(id => byId[id]).filter(Boolean),
    });

    const newEnds = endsAtWall(appt.starts_at, totals.blockMinutes);
    if (!newEnds) return res.status(400).json({ error: 'This appointment has no usable start time.' });

    // Adding always makes the booking longer, so all three overrun checks
    // apply, every time. Same three as change-treatment, and the wording is
    // the same too: the client cannot fix a diary clash, so every one of them
    // ends by pointing at Ellie.
    const startD = new Date(`${String(appt.starts_at).slice(0, 19)}Z`);
    const endD = new Date(`${newEnds}Z`);
    const { data: clash, error: clashErr } = await supabase
      .from('appointments')
      .select('id')
      .eq('beautician_id', appt.beauticians.id)
      .neq('id', appt.id)
      .in('status', ['confirmed', 'pending', 'in_progress'])
      .lt('starts_at', endD.toISOString())
      .gt('ends_at', startD.toISOString());
    // An unchecked error here would let the longer booking run over the next
    // client, which is the failure change-treatment already had once.
    if (clashErr) {
      logger.error({ err: clashErr, appointmentId: appt.id }, 'add-treatment: overrun check failed');
      return res.status(500).json({ error: 'Could not check that just then. Nothing has been changed, please try again.' });
    }
    if (clash && clash.length) {
      return res.status(409).json({ error: `There is not enough time after your appointment for ${treat.name} as well. Message me and we will find a time that fits both.` });
    }
    const blocks = await loadBlocks(appt.beauticians.id, startD, endD);
    if (hitsBlock(startD, endD, blocks)) {
      return res.status(409).json({ error: `There is not enough time left in that slot for ${treat.name} as well. Message me and we will find a time that fits both.` });
    }
    const dh = wallDayHours(appt.beauticians.working_hours || {}, startD);
    if (dh) {
      const [eh, em] = dh.end.split(':').map(Number);
      const dayEnd = new Date(startD); dayEnd.setUTCHours(eh, em, 0, 0);
      if (endD > dayEnd) {
        return res.status(409).json({ error: `Both treatments together would run past closing time. Message me and we will find a time that fits.` });
      }
    }

    // THE DEPOSIT IS DELIBERATELY UNTOUCHED, as in change-treatment. Only the
    // price, the length and the finish time move.
    const { error: upErr } = await supabase
      .from('appointments')
      .update({
        extra_treatment_ids: nextExtraIds,
        duration_minutes: totals.durationMinutes,
        price_cents: totals.priceCents,
        ends_at: newEnds,
      })
      .eq('id', appt.id);
    if (upErr) {
      logger.error({ err: upErr, appointmentId: appt.id }, 'add-treatment update failed');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    // Added and staying added. Same rule as the swap: the form follows, it
    // does not gate. See chaseConsultationAfterChange above.
    const chased = await chaseConsultationAfterChange(appt, [treat]);

    const depositPaid = appt.deposit_paid ? (appt.deposit_cents || 0) : 0;
    const remaining = Math.max(0, (totals.priceCents || 0) - depositPaid);
    const endLabel = newEnds.slice(11, 16);

    // Tell Ellie, because her diary just got longer without her touching it.
    // This is the notification that means she does not have to be told twice —
    // once by the app and once by the client in a message.
    const dLabel = new Date(`${String(appt.starts_at).slice(0, 10)}T00:00:00Z`)
      .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    pushTeamUpdate(appt.beauticians.id, 'booking_rescheduled',
      `${appt.clients?.first_name || 'A client'} added ${treat.name} to their ${dLabel} booking. It now finishes at ${endLabel}.`,
      { url: '/calendar/week', clientName: appt.clients?.first_name }
    ).catch(err => logger.error({ err, appointmentId: appt.id }, 'add-treatment push failed'));

    res.json({
      success: true,
      added: { id: treat.id, name: treat.name, duration_minutes: treat.duration_minutes, price_cents: treat.price_cents },
      extra_treatment_ids: nextExtraIds,
      duration_minutes: totals.durationMinutes,
      price_cents: totals.priceCents,
      ends_at: newEnds,
      depositPaidCents: depositPaid,
      remainingCents: remaining,
      consultationFormSent: chased.sent,
      message: `${treat.name} added. Your appointment now finishes at ${endLabel}${remaining > 0 ? `, with £${(remaining / 100).toFixed(2)} to pay on the day` : ''}.${chased.sent ? ' I have texted you a quick health form for that one, it takes about two minutes.' : ''}`,
    });
  } catch (err) {
    logger.error({ err }, 'add-treatment failed');
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

    // Wall frame, explicitly. The client sends "2026-08-10T14:00:00" meaning
    // 2pm in the salon, and every check below compares it against starts_at
    // values that are stored the same way. Parsing it without the Z made the
    // runtime's zone decide what 2pm meant, which was only ever correct
    // because nothing had set TZ. Compared against the salon's own now, not
    // the server's.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(String(new_starts_at))) {
      return res.status(400).json({ error: 'Invalid date format' });
    }
    const newStart = new Date(`${new_starts_at}${String(new_starts_at).length === 16 ? ':00' : ''}Z`);
    if (isNaN(newStart.getTime())) return res.status(400).json({ error: 'Invalid date format' });
    if (newStart <= nowInSalonWall()) return res.status(400).json({ error: 'New time must be in the future' });

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

    const { data: conflicts, error: conflictErr } = await supabase
      .from('appointments')
      .select('id')
      .eq('beautician_id', appt.beautician_id)
      .in('status', ['confirmed', 'pending', 'in_progress'])
      .neq('id', appt.id)
      .lt('starts_at', newEnd.toISOString())
      .gt('ends_at', newStart.toISOString());

    // Cannot read the diary means cannot move the booking. Unchecked, a failed
    // read let a client reschedule herself on top of somebody else.
    if (conflictErr) {
      logger.error({ err: conflictErr, appointmentId: appt.id }, 'reschedule: conflict check failed');
      return res.status(500).json({ error: 'Could not check that time just then. Nothing has been changed, please try again.' });
    }

    if (conflicts && conflicts.length > 0) {
      return res.status(409).json({ error: 'That time slot is not available. Please choose another time.' });
    }

    // IS THE SALON EVEN OPEN THEN?
    //
    // This route checked the future, the notice period, the booking horizon,
    // the once-only rule and the diary, and never once asked whether Ellie
    // works that day. It selected working_hours at the top and then ignored
    // it, so a client could move herself onto a Sunday, into a closed day, or
    // into the middle of Ellie's holiday, and the first anyone knew was the
    // knock at the door. Same three checks the change-treatment route runs.
    //
    // Wall frame throughout: starts_at stores salon wall time inside a UTC
    // slot, so the comparison Dates are built from the string and read with
    // UTC accessors. Never Intl-convert here, that is the BST hour drift.
    const wallStart = new Date(`${String(new_starts_at).slice(0, 19)}Z`);
    const wallEnd = new Date(wallStart.getTime() + totalMinutes * 60 * 1000);
    if (isNaN(wallStart.getTime())) {
      return res.status(400).json({ error: 'Invalid date format' });
    }

    // loadBlocks throws when it cannot read hours_exceptions, which the outer
    // catch turns into a 500. That is the right way round: an unreadable block
    // list must not read as "she has no days off".
    const rsBlocks = await loadBlocks(appt.beautician_id, wallStart, wallEnd);
    if (hitsBlock(wallStart, wallEnd, rsBlocks)) {
      return res.status(409).json({ error: 'That time is not available. Please choose another time.' });
    }

    const rsHours = wallDayHours(appt.beauticians?.working_hours || {}, wallStart);
    if (!rsHours) {
      return res.status(409).json({ error: 'We are closed that day. Please choose another date.' });
    }
    const [rsOpenH, rsOpenM] = rsHours.start.split(':').map(Number);
    const [rsShutH, rsShutM] = rsHours.end.split(':').map(Number);
    const rsOpen = new Date(wallStart); rsOpen.setUTCHours(rsOpenH, rsOpenM, 0, 0);
    const rsShut = new Date(wallStart); rsShut.setUTCHours(rsShutH, rsShutM, 0, 0);
    if (wallStart < rsOpen || wallEnd > rsShut) {
      return res.status(409).json({ error: 'That time is outside opening hours. Please choose another time.' });
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
        // Same trap as the one in consultation-forms.js: a query builder has
        // no .catch, so this threw a TypeError mid-reschedule rather than
        // swallowing anything. It sat on the branch where a deposit was NOT
        // re-collected, which is the quieter half of the reschedule flow.
        const { error: pendErr } = await supabase
          .from('appointments')
          .update({ deposit_status: 'pending' })
          .eq('id', appt.id);
        if (pendErr) logger.warn({ err: pendErr, appointmentId: appt.id }, 'Could not mark the new slot deposit pending');
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
        ? `Rescheduled to ${newStart.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })} at ${newStart.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })}. As this is within the ${noticeHours}-hour notice period, a ${chargePercent}% fee for the original appointment will be charged to the card on file${newDepositCollected ? ', and a fresh deposit has been taken for your new appointment' : ', and your new appointment will need a fresh deposit'}.`
        : `Rescheduled to ${newStart.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })} at ${newStart.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })}.`,
    });
  } catch (err) {
    logger.error({ err }, 'Reschedule failed');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/** How far ahead either reschedule mode will look. */
const RESCHEDULE_HORIZON_DAYS = 28;
/** Cap on the general list, same grain and same cap as the patch-test picker. */
const RESCHEDULE_MAX_SLOTS = 800;

/**
 * General availability for a client moving her own booking: every genuinely
 * free slot the public booking page would offer her, minus the one thing the
 * public page never has to think about.
 *
 * THE APPOINTMENT BEING MOVED MUST NOT BLOCK ITS OWN REPLACEMENT. Ellie's
 * client wanting to slide her 1pm to 1.30pm is sitting in the only booking
 * that overlaps 1.30, her own. getFreeSlots takes excludeAppointmentIds for
 * exactly this, and the back-to-back path excludes the same row through the
 * same helper, so both modes agree.
 *
 * Everything else comes off getFreeSlots: working hours, closures (date to
 * end_date), blocked ranges, the real diary and the wall-time convention. No
 * third availability implementation.
 *
 * The list is then passed through the SAME two policy predicates POST
 * .../reschedule applies before it will accept a time, in the same frames it
 * applies them in. Offering a slot the acceptor then refuses is the bug this
 * whole endpoint exists to end, so agreement matters more than elegance here.
 */
async function generalRescheduleSlots(res, appt, { policy, livePolicy, workingHours, totalMinutes }) {
  const timezone = appt.beauticians?.timezone || 'Europe/London';

  // Lead time and horizon: read the way the POST reads them. The POST takes
  // min_booking_hours and max_advance_days off `policy` (snapshot, falling
  // back to live). Where the live policy is TIGHTER we honour that too, so a
  // salon that has just shortened its booking window is not still handing out
  // dates beyond it.
  const minHours = Math.max(0, Number(policy.min_booking_hours) || 0);
  const advanceCandidates = [policy.max_advance_days, livePolicy.max_advance_days]
    .map(n => Number(n) || 0)
    .filter(n => n > 0);
  const maxAdvanceDays = advanceCandidates.length ? Math.min(...advanceCandidates) : 0;

  const days = maxAdvanceDays > 0
    ? Math.min(RESCHEDULE_HORIZON_DAYS, maxAdvanceDays)
    : RESCHEDULE_HORIZON_DAYS;

  // getFreeSlots throws when it cannot read the diary or the closures, and the
  // route's catch turns that into a 500. That is the right way round: an
  // unreadable diary must never render as a page full of free time.
  const free = await getFreeSlots(appt.beautician_id, {
    workingHours,
    timezone,
    durationMinutes: totalMinutes,
    fromWall: nowInSalonWall(timezone),
    days,
    leadHours: minHours,
    maxSlots: RESCHEDULE_MAX_SLOTS,
    excludeAppointmentIds: [appt.id],
  });

  // The POST's own guards, replayed. Both of them measure a wall-frame start
  // against a real instant, which is an hour out in BST; replaying them rather
  // than reasoning about them is what guarantees every offered time is one it
  // will actually take.
  const nowReal = new Date();
  const horizon = maxAdvanceDays > 0 ? new Date(nowReal) : null;
  if (horizon) horizon.setDate(horizon.getDate() + maxAdvanceDays);

  const slots = [];
  for (const s of free) {
    // Zone-free wall string: this is the only shape POST .../reschedule accepts.
    const wall = `${s.date}T${s.time}:00`;
    const start = new Date(`${wall}Z`);
    if (minHours > 0 && (start - nowReal) / (1000 * 60 * 60) < minHours) continue;
    if (horizon && start > horizon) continue;
    slots.push(wall);
  }

  return res.json({
    mode: 'available',
    slots,
    durationMinutes: totalMinutes,
    horizonDays: days,
  });
}

/**
 * GET /api/booking/:slug/manage/:token/reschedule/slots
 * The times this client can actually move her booking to. TWO MODES:
 *
 *   reschedule_between_only ON  -> back-to-back only. The client is offered
 *     only slots that butt directly against another booking (start where one
 *     ends, or end where one starts), so days stay tightly packed and Ellie
 *     never travels in for one client. Deliberate product rule, unchanged.
 *
 *   otherwise (the default)     -> general availability, the same times the
 *     public booking page would offer.
 *
 * The default used to have no answer at all. The manage page fell back to a
 * bare date box and a time box, and a client wrote, verbatim: "it doesn't let
 * me see your slots, I just have to choose a time and date and it keeps saying
 * it's not available but that's cause I'm guessing haha x". Ellie then read
 * the diary herself and told her a time. Guess-and-check is not an interface,
 * so the default now answers the question.
 *
 * The general mode is generated by lib/free-slots.js getFreeSlots, the same
 * generator the AI front desk and the patch-test picker use, so there is one
 * account of what "free" means rather than three.
 *
 * Wall-clock throughout: appointment times are stored as salon local time in
 * the slot, so we read/build them with plain string maths, never Date tz maths.
 * Both modes emit `YYYY-MM-DDTHH:MM:SS` with no zone, which is exactly what
 * POST .../reschedule accepts (it refuses anything carrying an offset).
 */
router.get('/:slug/manage/:token/reschedule/slots', async (req, res) => {
  try {
    const { data: appt } = await supabase
      .from('appointments')
      .select(`
        id, starts_at, status, duration_minutes, buffer_minutes, extra_padding_minutes,
        policy_snapshot, beautician_id,
        beauticians(id, booking_slug, booking_policy, working_hours, timezone)
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

    // ---------------------------------------------------------------- mode --
    // The POST route decides adjacency from the LIVE policy, so the list of
    // offered times has to be decided from the same place. Reading the frozen
    // snapshot here would offer a back-to-back client the whole diary, or the
    // reverse.
    if (livePolicy.reschedule_between_only !== true) {
      return await generalRescheduleSlots(res, appt, { policy, livePolicy, workingHours, totalMinutes });
    }

    const HORIZON_DAYS = RESCHEDULE_HORIZON_DAYS;
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

    // Group existing bookings by day. The appointment being moved must never
    // count against its own replacement, so it is excluded twice: once in the
    // query above (.neq) and once here, through the same helper the general
    // mode uses, so the two modes cannot drift apart on what "exclude" means.
    const movingItself = excludedAppointmentIds([appt.id]);
    const byDay = {};
    for (const a of (existing || []).filter(a => !movingItself.has(String(a.id)))) {
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
        starts_at, treatment_id, beautician_id, client_id,
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
      return res.status(400).json({ error: 'Payment not available. Contact your beautician directly' });
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
    // timeZone UTC: starts_at stores salon wall time in the UTC slot
    const dateLabel = startsDate.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    const timeLabel = startsDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
    const beauticianName = b.business_name || b.first_name;

    // Public base of THIS backend, so the checkout success redirect lands on
    // our confirm endpoint rather than the SPA (see success_url below).
    const apiBase = `${req.headers['x-forwarded-proto'] || 'https'}://${req.get('host')}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      ...(appt.clients?.stripe_customer_id ? { customer: appt.clients.stripe_customer_id } : {}),
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: {
            name: `${appt.treatments?.name || 'Appointment'} deposit`,
            description: `${dateLabel} at ${timeLabel} with ${beauticianName}`,
          },
          unit_amount: depositCents,
        },
        quantity: 1,
      }],
      payment_intent_data: {
        // Destination charge: totalApplicationFee (Florrie's cut plus Stripe's
        // processing estimate), never a bare 1.5%, or the platform pays Stripe
        // out of its own pocket on every resent deposit (the arrears leak).
        application_fee_amount: totalApplicationFee(depositCents),
        transfer_data: { destination: b.stripe_account_id },
        metadata: {
          appointment_id: appt.id,
          beautician_id: appt.beautician_id,
          payment_type: 'deposit_resend',
        },
      },
      // Land on OUR confirm endpoint, not straight back on the SPA. That route
      // retrieves the session, checks payment_status server side and marks the
      // booking paid before forwarding. Pointing at the frontend meant a resent
      // deposit was never verified anywhere, so the only thing that could have
      // confirmed it was the webhook, which is the very thing that had died.
      success_url: `${apiBase}/api/booking/confirm/{CHECKOUT_SESSION_ID}?slug=${req.params.slug}&mt=${req.params.token}`,
      cancel_url: `${FRONTEND_URL}/book/${req.params.slug}/manage/${req.params.token}`,
      // SESSION-LEVEL metadata, and it must carry the salon.
      //
      // 31 August 2026. This object used to be
      // `{ appointment_id, payment_type }` and nothing else, while the copy
      // inside payment_intent_data above carried beautician_id all along. The
      // webhook reads the SESSION one (routes/stripe.js, session.metadata),
      // so every resent deposit paid gave it beauticianId === undefined, and
      // that undefined went two places, both of them silent:
      //
      //   1. the confirmed push, which filtered devices on
      //      .eq('beautician_id', undefined), matched nothing and told her
      //      nothing;
      //   2. the transactions insert, where beautician_id is NOT NULL, so the
      //      row was rejected and the money the client actually paid never
      //      reached her Money tab. A PAID BUT NOT RECORDED, every time.
      //
      // client_id is here for the same reason: the transaction and the
      // customer save both read it off the session.
      metadata: {
        appointment_id: appt.id,
        beautician_id: appt.beautician_id,
        ...(appt.client_id ? { client_id: appt.client_id } : {}),
        payment_type: 'deposit_resend',
      },
    });

    // Move the appointment onto the intent the client is about to pay with.
    // It was still carrying the intent from the abandoned first attempt, which
    // sits at 'requires_payment_method' forever, so the stale cleanup asked
    // Stripe about the wrong charge, read a definite "not paid" and released a
    // slot the client had just paid for. Guarded for null the way
    // conversational-booking.js does: writing a null would erase the old intent
    // and tell the cleanup nothing at all.
    if (session.payment_intent) {
      const { error: pinErr } = await supabase
        .from('appointments')
        .update({ stripe_payment_intent_id: session.payment_intent })
        .eq('id', appt.id);
      if (pinErr) {
        logger.error({ err: pinErr, appointmentId: appt.id }, 'Resent deposit link created but the payment intent did not move onto the booking');
        Sentry.captureMessage('Resent deposit left pointing at the stale payment intent', {
          level: 'error',
          tags: { area: 'payments', check: 'resend_pin_payment_intent' },
          extra: { appointmentId: appt.id, sessionId: session.id },
        });
      }
    } else {
      logger.error({ appointmentId: appt.id, sessionId: session.id }, 'Resent deposit session came back with no payment intent');
      Sentry.captureMessage('Resent deposit session created with no payment intent', {
        level: 'error',
        tags: { area: 'payments', check: 'resend_pin_payment_intent' },
        extra: { appointmentId: appt.id, sessionId: session.id },
      });
    }

    // Email the link to the client
    const { sendEmail } = await import('../services/notifications.js');
    await sendEmail({
      to: clientEmail,
      subject: `Complete your booking with ${beauticianName}`,
      html: `
        <p>Hi ${appt.clients?.first_name || 'there'},</p>
        <p>Your booking for <strong>${appt.treatments?.name || 'your appointment'}</strong> on <strong>${dateLabel} at ${timeLabel}</strong> with ${beauticianName} is still waiting for payment.</p>
        <p>Click below to secure your spot. This link is active for 24 hours:</p>
        <p><a href="${session.url}" style="background:#C76B8A;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600;">Pay deposit £${(depositCents / 100).toFixed(2)}</a></p>
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
        clients(first_name, phone, email),
        beauticians(id, booking_slug, business_name, first_name, working_hours, timezone, patch_test_duration_minutes, patch_test_price_cents)
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

    const { data: conflicts, error: conflictErr } = await supabase
      .from('appointments')
      .select('id')
      .eq('beautician_id', beautician.id)
      .in('status', ['confirmed', 'pending', 'in_progress'])
      .lt('starts_at', slotEnd.toISOString())
      .gt('ends_at', slotTime.toISOString());

    // Unchecked, a failed read booked the patch test on top of a real client.
    if (conflictErr) {
      logger.error({ err: conflictErr, beauticianId: beautician.id }, 'patch test: conflict check failed');
      return res.status(500).json({ error: 'Could not check that time just then. Nothing has been booked, please try again.' });
    }

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

    // The CLIENT gets it in writing too. Until now only Ellie was told, so a
    // client who closed the tab had nothing: no text, no email, no trace of a
    // ten minute visit people forget. Fire and forget, same rule as the push:
    // a send problem must never fail a booking that already exists.
    (async () => {
      const { sendSMS, sendEmail } = await import('../services/notifications.js');
      const firstName = appt.clients?.first_name || 'there';
      const bizName = beautician.business_name || beautician.first_name || 'the salon';
      const line = `Hi ${firstName}, your patch test with ${bizName} is booked for ${whenLabel}. It only takes a few minutes. See you then!`;
      let sent = false;
      if (appt.clients?.phone) {
        const r = await sendSMS({
          to: appt.clients.phone, body: line, beauticianId: beautician.id,
          messageType: 'booking_confirmation', clientId: appt.client_id,
        }).catch(() => null);
        sent = !!r?.success || !!r;
      }
      if (appt.clients?.email) {
        await sendEmail({
          to: appt.clients.email,
          subject: `Patch test booked: ${whenLabel}`,
          text: line,
          html: `<p>${line}</p>`,
        }).catch(() => null);
        sent = true;
      }
      if (!sent) logger.warn({ appointmentId: patchTestAppt.id }, 'patch test booked but client has no phone or email to confirm to');
    })().catch(err => logger.warn({ err }, 'patch test client confirmation failed (non-fatal)'));

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

  // The waitlist row holds no contact details at all. It never has: the table is
  // client_id + treatment_id + preferences (supabase/migrations/001, 070). This
  // used to select phone, first_name and preferred_times, none of which exist,
  // so PostgREST rejected the whole select, `waiters` was null, and in the whole
  // life of this feature nobody has ever been told a slot opened up. Contact
  // details come through the client_id join.
  const { data: waiters, error: waitersErr } = await supabase
    .from('waitlist')
    .select('id, client_id, notify_count, preferred_days, preferred_time, clients(id, first_name, phone, email, marketing_consent, marketing_opted_out_at, messaging_autonomy)')
    .eq('beautician_id', beauticianId)
    .or(`treatment_id.eq.${treatmentId},treatment_id.is.null`)
    .in('status', ['waiting', 'active'])
    .order('created_at', { ascending: true })
    .limit(3); // notify top 3

  if (waitersErr) {
    logger.warn({ err: waitersErr, beauticianId }, 'waitlist gap-fill: lookup failed, nobody notified');
    return;
  }
  if (!waiters?.length) return;

  const { sendSMS, sendEmail } = await import('../services/notifications.js');

  // timeZone UTC: the freed slot is salon wall time stored in the UTC slot
  const dayName = freedDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const timeStr = freedDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });

  for (const waiter of waiters) {
    const person = waiter.clients;
    if (!person) continue;                       // no client row, nobody to write to

    const msg = `Hi ${person.first_name || 'there'}! A slot has just opened up: ${dayName} at ${timeStr}. Reply YES to claim it or book at your link.`;

    // ONE channel per person, through the one gate. This block used to call
    // sendSMS and sendEmail directly with no evaluateOutbound, which is a
    // proactive message: it would have gone to clients who had replied STOP,
    // ignored the cross-engine frequency cap, and eaten the allowance kept back
    // for confirmations and reminders. Texting an opted-out client is a PECR
    // breach, not a bug. Two guardedSend calls would also double-count against
    // the cap, so pick the channel and send once.
    const channel = person.phone ? 'sms' : (person.email ? 'email' : null);
    if (!channel) continue;

    const verdict = await guardedSend({
      beauticianId,
      clientId: person.id,
      messageType: 'waitlist_alert',
      channel,
      client: person,
      body: msg,
      send: async () => {
        if (channel === 'sms') {
          return await sendSMS({
            to: person.phone, body: msg, beauticianId,
            messageType: 'waitlist_alert', clientId: person.id,
          });
        }
        return await sendEmail({
          to: person.email,
          subject: `A slot just opened up, ${dayName} at ${timeStr}`,
          html: `<p>${msg}</p>`,
        });
      },
    });

    // Only a delivered message counts as "notified". Marking a held or blocked
    // draft as notified would quietly drop her off the list without her ever
    // hearing about the slot.
    if (!verdict.delivered) continue;

    const { error: markErr } = await supabase
      .from('waitlist')
      .update({
        notified_at: new Date().toISOString(),
        last_notified_at: new Date().toISOString(),
        notify_count: (waiter.notify_count || 0) + 1,
      })
      .eq('id', waiter.id);
    if (markErr) logger.warn({ err: markErr, waitlistId: waiter.id }, 'waitlist gap-fill: could not mark as notified');
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
    const apptDate = new Date(appt.starts_at).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });

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

    if (newStatus === 'confirmed') {
      await announceBookingConfirmed(id, { source: 'manual_status', claim: false });
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
 * Verified client endpoint — checks membership for the authenticated email.
 * Returns membership info so the booking page can show a "Member" badge and notify the beautician.
 */
router.post('/:slug/check-member', requireBookingIdentity, async (req, res) => {
  const { email } = req.body;

  const { data: beautician } = await supabase
    .from('beauticians')
    .select('id')
    .eq('booking_slug', req.params.slug)
    .single();

  if (!beautician) return res.json({ is_member: false });

  const { data: client, error: identityError } = await supabase.from('clients')
    .select('id, first_name').eq('beautician_id', beautician.id)
    .ilike('email', exactEmailPattern(email)).maybeSingle();
  if (identityError) return res.status(503).json({ error: 'Membership could not be checked. Please try again.' });

  if (!client) return res.json({ is_member: false });

  // The two tables are confusingly named:
  //   client_memberships      = the PLANS   (name, price_cents, benefits)
  //   membership_subscriptions = the ENROLMENTS (client_id, membership_id, status)
  // This route had them the wrong way round, and then read a `membership_plans`
  // table that does not exist at all. Both queries errored, so `is_member` was
  // ALWAYS false: no client has ever been recognised as a member here.
  const { data: membership, error: membershipError } = await supabase
    .from('membership_subscriptions')
    .select('id, membership_id, status')
    .eq('beautician_id', beautician.id)
    .eq('client_id', client.id)
    .eq('status', 'active')
    .maybeSingle();

  if (membershipError) return res.status(503).json({ error: 'Membership could not be checked. Please try again.' });
  if (!membership) return res.json({ is_member: false });

  const { data: plan, error: planError } = await supabase
    .from('client_memberships')
    .select('name')
    .eq('id', membership.membership_id)
    .maybeSingle();

  if (planError) return res.status(503).json({ error: 'Membership could not be checked. Please try again.' });
  return res.json({
    is_member: true,
    plan_name: plan?.name || 'Active Member',
    client_name: client.first_name,
  });
});

/**
 * POST /api/booking/:slug/check-packages
 * Verified client endpoint — checks packages for the authenticated email.
 * Returns the packages so the booking page can offer "Use a session" instead of paying.
 */
router.post('/:slug/check-packages', requireBookingIdentity, async (req, res) => {
  const { email, treatment_id } = req.body;

  const { data: beautician } = await supabase
    .from('beauticians')
    .select('id')
    .eq('booking_slug', req.params.slug)
    .single();

  if (!beautician) return res.json({ packages: [] });

  const { data: pkgClient, error: pkgClientErr } = await supabase.from('clients')
    .select('id').eq('beautician_id', beautician.id)
    .ilike('email', exactEmailPattern(email)).maybeSingle();

  // "We could not look" is not "you have no packages". Say so, otherwise she is
  // shown the full price for sessions she has already paid for.
  if (pkgClientErr) {
    logger.error({ err: pkgClientErr, beauticianId: beautician.id }, 'check-packages: client lookup failed');
    return res.status(503).json({ packages: [], unchecked: true, error: 'Could not check your packages just then.' });
  }
  const client = pkgClient || null;

  if (!client) return res.json({ packages: [] });

  // Get active client packages with sessions remaining.
  // The column is sessions_total on BOTH tables (supabase/migrations/007), not
  // `sessions`. Asking for a column that does not exist made PostgREST reject
  // the whole select, so this always came back null and every client was told
  // she had no packages at all.
  const { data: clientPkgs, error: clientPkgsErr } = await supabase
    .from('client_packages')
    .select('id, sessions_used, sessions_total, expires_at, package_id, packages(name, sessions_total, treatment_ids)')
    .eq('beautician_id', beautician.id)
    .eq('client_id', client.id)
    .eq('status', 'active');

  if (clientPkgsErr) {
    logger.error({ err: clientPkgsErr, beauticianId: beautician.id }, 'check-packages: package lookup failed');
    return res.status(503).json({ packages: [], unchecked: true, error: 'Could not check your packages just then.' });
  }

  if (!clientPkgs || clientPkgs.length === 0) return res.json({ packages: [] });

  // Filter to packages that have sessions remaining and (optionally) include this treatment
  const available = clientPkgs
    .filter(cp => {
      // Out of sessions, or out of date. Offering a package the booking path
      // will not honour is how a client gets told her session is free and then
      // asked to pay on the next screen.
      if (!packageIsRedeemable(cp)) return false;
      // If treatment_id provided, only show packages that include that treatment
      if (treatment_id && cp.packages?.treatment_ids?.length > 0) {
        return cp.packages.treatment_ids.includes(treatment_id);
      }
      return true;
    })
    .map(cp => ({
      client_package_id: cp.id,
      package_name: cp.packages?.name || 'Package',
      sessions_remaining: packageSessionsRemaining(cp),
      sessions_total: cp.sessions_total ?? cp.packages?.sessions_total ?? 0,
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
  const { data: promo, error: promoErr } = await supabase
    .from('promo_codes')
    .select('id, code, discount_type, discount_value, max_uses, current_uses, valid_from, valid_until, is_active')
    .eq('beautician_id', beautician.id)
    .eq('code', normalised)
    .maybeSingle();

  // An unread lookup error is indistinguishable from "no such code", and telling
  // a client her code is not recognised when we simply could not look is how she
  // ends up paying full price for something the salon already sold her.
  if (promoErr) {
    logger.error({ err: promoErr, beauticianId: beautician.id }, 'validate-code: promo lookup failed');
    return res.status(503).json({ valid: false, unchecked: true, error: 'Could not check that code just then. Please try again in a moment.' });
  }

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

  // 2. Try gift_vouchers.
  // There is no `amount` column on this table (see supabase/migrations/007):
  // it is amount_cents (face value) and remaining_cents (what is left after
  // part-redemptions). PostgREST rejects the WHOLE select for one unknown
  // column, so this came back { data: null, error }, the error was never read,
  // and every real voucher fell through to "Code not recognised" below.
  const { data: voucher, error: voucherErr } = await supabase
    .from('gift_vouchers')
    .select('id, code, amount_cents, remaining_cents, status, expires_at')
    .eq('beautician_id', beautician.id)
    .eq('code', normalised)
    .maybeSingle();

  if (voucherErr) {
    logger.error({ err: voucherErr, beauticianId: beautician.id }, 'validate-code: voucher lookup failed');
    return res.status(503).json({ valid: false, unchecked: true, error: 'Could not check that code just then. Please try again in a moment.' });
  }

  if (voucher) {
    if (voucher.status !== 'active') {
      return res.status(400).json({ valid: false, error: 'This voucher has already been used or cancelled' });
    }
    if (voucher.expires_at && voucher.expires_at < now) {
      return res.status(400).json({ valid: false, error: 'This voucher has expired' });
    }
    const remaining = voucherRemainingCents(voucher);
    if (remaining <= 0) {
      return res.status(400).json({ valid: false, error: 'This voucher has already been used' });
    }
    return res.json({
      valid: true,
      type: 'voucher',
      code: voucher.code,
      discount_type: 'fixed',
      discount_value: remaining,   // pence still on the voucher
      voucher_id: voucher.id,
    });
  }

  // Nothing matched, and we know that because both lookups actually ran.
  return res.status(404).json({ valid: false, error: 'Code not recognised' });
});

/**
 * Record the consent box ticked by a client the salon already has.
 *
 * Reads the row first so consent that already stands keeps its original
 * marketing_consent_at (that date is the evidence, and moving it forward
 * erases the earlier proof). Writes only when there is no consent on file or
 * an opt-out is standing. The read and the write both report their error: a
 * consent that silently failed to save is the same defect as one never asked
 * for. Never throws, the booking itself does not depend on this.
 */
async function recordReturningClientConsent(clientId, beauticianId) {
  const { data: row, error: readErr } = await supabase
    .from('clients')
    .select('marketing_consent, marketing_opted_out_at')
    .eq('id', clientId)
    .maybeSingle();
  if (readErr) {
    logger.error({ err: readErr, clientId, beauticianId }, 'book: could not read the returning client consent state; the ticked box was not recorded');
    return false;
  }
  if (row?.marketing_consent === true && !row?.marketing_opted_out_at) return true;

  const { error: writeErr } = await supabase
    .from('clients')
    .update({ marketing_consent: true, marketing_consent_at: new Date().toISOString(), marketing_opted_out_at: null })
    .eq('id', clientId);
  if (writeErr) {
    logger.error({ err: writeErr, clientId, beauticianId }, 'book: could not record the returning client consent; she ticked the box and no marketing will reach her until this is fixed');
    return false;
  }
  return true;
}

/**
 * POST /api/booking/:slug/book
 * Public endpoint — creates a booking from the booking page.
 * Creates or finds the client, creates the appointment.
 * If deposit is required and beautician has Stripe Connect, creates a
 * Checkout session and returns checkout_url for redirect.
 * Returning clients with a saved Stripe customer see their saved cards.
 */
router.post('/:slug/book', requireBookingIdentity, validate(bookingSchema), verifyTurnstile, async (req, res) => {
  const { treatment_id, extra_treatment_ids, starts_at, client_name, client_email, client_phone, notes, consultation, add_ons, payment_type, payment_method, discount_code, photo_consent, client_package_id, marketing_opt_in } = req.body;

  // Get beautician from slug (include Stripe fields, booking policy, payment settings)
  const { data: beautician } = await supabase
    .from('beauticians')
    .select('id, business_name, first_name, timezone, stripe_account_id, stripe_onboarding_complete, booking_policy, payment_settings')
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
  // Durations add up, buffers do not (the longest wins, it is cleanup after the
  // whole visit). Moved to lib/booking-rules.js so the conversational booking
  // flow lengths a visit identically: two implementations of this would drift,
  // and a drift here books a client over the top of the next one.
  const {
    durationMinutes: combinedDuration,
    bufferMinutes: combinedBuffer,
    priceCents: combinedPriceCents,
  } = combineTreatments(allTreatments);

  // Block appointments in the past.
  // starts_at is SALON WALL TIME with no zone (see bookingSchema), so
  // `new Date(starts_at)` is a wall-frame Date. `new Date()` is a real instant,
  // and in BST it reads an hour BEHIND the salon clock: at 10:00 BST a 09:30
  // wall slot compared as still in the future and sailed through. Compare like
  // with like, against the salon's own wall clock.
  const startsAtCheck = new Date(starts_at);
  const salonNow = nowInSalonWall(beautician.timezone || 'Europe/London');
  if (startsAtCheck < salonNow) {
    return res.status(400).json({ error: 'Cannot book an appointment in the past' });
  }

  // Enforce minimum booking window (same wall frame, same reason: measured
  // against a real instant, a 2 hour notice period let a 1 hour booking through)
  const bookingPolicy = beautician.booking_policy || {};
  const minHours = bookingPolicy.min_booking_hours || 0;
  if (minHours > 0) {
    const hoursUntil = (startsAtCheck - salonNow) / (1000 * 60 * 60);
    if (hoursUntil < minHours) {
      return res.status(400).json({
        error: `Bookings must be made at least ${minHours} hour${minHours !== 1 ? 's' : ''} in advance. Please choose a later time.`
      });
    }
  }

  // Enforce how far ahead the diary is open (0/unset = no limit).
  const maxAdvanceDays = bookingPolicy.max_advance_days || 0;
  if (maxAdvanceDays > 0) {
    const horizon = new Date(salonNow);
    horizon.setUTCDate(horizon.getUTCDate() + maxAdvanceDays);
    if (startsAtCheck > horizon) {
      return res.status(400).json({
        error: `Online bookings are only open up to ${maxAdvanceDays} days ahead. Please choose an earlier date.`
      });
    }
  }

  // Validate appointment falls within working hours
  const { data: beauticianHours, error: hoursErr } = await supabase
    .from('beauticians')
    .select('working_hours')
    .eq('id', beautician.id)
    .single();

  // Unread hours skip the whole check below, so a Sunday booking sails through.
  // Refuse the booking instead: not knowing when she works is not permission.
  if (hoursErr) {
    logger.error({ err: hoursErr, beauticianId: beautician.id }, 'book: could not read working hours');
    return res.status(500).json({ error: 'Could not check availability just then. Nothing has been booked, please try again.' });
  }

  if (beauticianHours?.working_hours) {
    // getUTCDay, not a locale conversion. startsAtCheck is a wall-time Date
    // whose UTC fields ARE the salon clock, so asking the runtime which day it
    // is in ITS zone is only right while that zone happens to be UTC.
    const dayKey = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][startsAtCheck.getUTCDay()];
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

  // Reuse only the record matching the verified email. A typed phone number
  // never establishes ownership of saved records or prepaid benefits.
  let existingClient = null;

  // Until migration 018 runs, archived_at does not exist and selecting it
  // errors 42703. Ignoring that error is how a returning client silently
  // becomes null here, which creates a DUPLICATE record and, far worse,
  // bypasses the blocked-client check below. So: try with archived_at,
  // and on a missing-column error retry without it rather than shrugging.
  let clientLookupFailed = false;
  const lookupClient = async (build) => {
    let { data, error } = await build('id, stripe_customer_id, blocked_at, archived_at');
    if (error && isMissingColumnError(error)) {
      ({ data, error } = await build('id, stripe_customer_id, blocked_at'));
    }
    if (error) {
      logger.error({ err: error }, 'booking client lookup failed');
      clientLookupFailed = true;
      return null;
    }
    return data;
  };

  if (client_email) {
    existingClient = await lookupClient((cols) => supabase
      .from('clients')
      .select(cols)
      .eq('beautician_id', beautician.id)
      .ilike('email', exactEmailPattern(client_email))
      .maybeSingle());
  }

  if (clientLookupFailed) return res.status(503).json({ error: 'Your client record could not be checked. Please try again.' });

  // A client Ellie has blocked cannot book online. Kept deliberately vague so
  // it does not invite an argument; she can still add them by hand if she wants.
  if (existingClient?.blocked_at) {
    return res.status(403).json({ error: 'Online booking is not available for this account. Please contact us directly.' });
  }

  if (existingClient) {
    client = existingClient;
    // An archived client booking again is the clearest possible sign they are
    // back: clear the flag so they reappear in the client list. Fail-soft and
    // fire-and-forget, the booking must never wait on (or break over) this.
    if (existingClient.archived_at) {
      autoUnarchiveClient(existingClient.id, 'booked_again').catch(() => {});
    }
    // PECR / UK GDPR: a returning client who ticks the box is giving fresh
    // consent, and it has to be recorded against HER row with a timestamp or
    // there is no evidence of it. This used to be a fire-and-forget update
    // matched on the last nine digits of the phone she typed, with the error
    // thrown away: it missed a client matched by email whose stored phone
    // differed, it could touch a different client on the same digits, and a
    // failed write looked like a recorded consent. Since the marketing guard
    // fails closed (lib/marketing-guard.js, 2 September 2026) a client with
    // no consent on file never gets marketing, so a lost tick is now a client
    // who asked for offers and was silently refused them forever.
    //
    // Ticking is fresh consent and supersedes an earlier STOP, so the opt-out
    // is cleared. An unticked box is not a withdrawal: nothing is written.
    if (marketing_opt_in === true) {
      await recordReturningClientConsent(existingClient.id, beautician.id);
    }
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

  // Conflict check. THE one that decides whether two people are sat in the
  // chair at once, and it was reading `data` without reading `error`: any
  // PostgREST failure came back as null, `conflicts` was falsy, and the double
  // booking went straight in. Fail closed, always.
  const { data: conflicts, error: conflictErr } = await supabase
    .from('appointments')
    .select('id')
    .eq('beautician_id', beautician.id)
    .in('status', ['confirmed', 'pending'])
    .lt('starts_at', endsDate.toISOString())
    .gt('ends_at', startsDate.toISOString());

  if (conflictErr) {
    logger.error({ err: conflictErr, beauticianId: beautician.id }, 'book: conflict check failed');
    return res.status(500).json({ error: 'Could not check that time just then. Nothing has been booked, please try again.' });
  }

  if (conflicts && conflicts.length > 0) {
    return res.status(409).json({ error: 'This time slot is no longer available' });
  }

  // Blocked-time guard: never accept a booking on a closed day or inside a
  // blocked-out time range (hours_exceptions). The picker hides these, but a
  // stale page or direct API call could still slip through without this.
  // starts_at from the public picker is salon-local wall time ('...THH:MM:00',
  // no Z), and exception times are salon-local too, so compare wall minutes.
  // A closure is a RANGE (date..end_date). Matching on `date` alone meant a
  // holiday entered as 24 to 30 August only guarded the 24th, and clients booked
  // straight through the rest of it.
  // The lower bound is widened (see MAX_BLOCK_LOOKBACK_DAYS in lib/free-slots.js)
  // so a closure that STARTED earlier and is still running is fetched too; the
  // exact date..end_date test happens in JS just below.
  const bookDate = String(starts_at).slice(0, 10);
  const { data: dayExceptionRows, error: dayExceptionErr } = await supabase
    .from('hours_exceptions')
    .select('date, end_date, type, start_time, end_time')
    .eq('beautician_id', beautician.id)
    .gte('date', blockLookbackFrom(bookDate))
    .lte('date', bookDate);

  // An unreadable exception list is not an empty one. Read as empty, this guard
  // waves a client straight into a closed day or a blocked-out hour.
  if (dayExceptionErr) {
    logger.error({ err: dayExceptionErr, beauticianId: beautician.id, date: bookDate }, 'book: blocked-time check failed');
    return res.status(500).json({ error: 'Could not check that time just then. Nothing has been booked, please try again.' });
  }

  // Filter here too: the query narrows, this decides. A row only counts if its
  // own date..end_date span actually contains the day being booked.
  const dayExceptions = (dayExceptionRows || []).filter(ex => blockCoversDay(ex, bookDate));

  if (dayExceptions.length > 0) {
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
  // test can happen at least 24 hours before the appointment. Measured against
  // the salon wall clock, not a real instant: against Date.now() this read an
  // hour generous in BST and let a 23 hour booking through. The confirmation +
  // manage portal then walk the client through booking the actual patch-test
  // slot (24h validation there).
  const gateNeedsPatchTest = isNewClient && allTreatments.some(t => t.requires_patch_test === true);
  if (gateNeedsPatchTest) {
    const hoursAway = (startsDate.getTime() - salonNow.getTime()) / 3600000;
    if (hoursAway < 24) {
      return res.status(409).json({
        error: 'As a new client, this treatment needs a quick patch test at least 24 hours before your appointment. Please choose a time from tomorrow onwards so there is time to fit it in.',
      });
    }
  }

  /* CONSULTATION: WHO GETS ASKED, AND WHO ACTUALLY GETS REFUSED.
   *
   * These are two different questions and until 29 August 2026 this route only
   * had one answer for both, keyed on isNewClient, which is true only when the
   * insert above created a clients row. After the Timely import 926 of 1,151
   * clients already had one, so for every one of them the gate was off and the
   * form SMS below never fired. 277 of those 926 have no history of any kind:
   * total_visits 0, last_visit_at NULL, no completed appointment. They had a
   * phone number in an old address book and nothing else, and this route
   * treated that as "she has been here before".
   *
   * The rule now comes from lib/consultation-status.js, the same function
   * POST /lookup-client answers the booking page with and the same one
   * services/conversational-booking.js has used since it was written.
   *
   * WHO IS REFUSED IS DELIBERATELY UNCHANGED. `block` is true only when
   * inDatabase is false, and inDatabase here is !isNewClient, so this refuses
   * exactly the population the old expression refused: somebody with no
   * clients row at all, booking a treatment that requires a consultation.
   * That wall predates this change and works. Everybody NEWLY brought into
   * scope is asked and then chased, never refused: she sees the form, she can
   * carry on without it, the SMS goes out below, and the 24 to 72 hour
   * pre-appointment reminder chases the pending row it leaves behind.
   */
  const consultationStatus = await readConsultationStatus(supabase, {
    beauticianId: beautician.id,
    clientId: client.id,
    treatments: allTreatments,
    inDatabase: !isNewClient,
    logger,
  });
  const consultationAnswered = !!consultation && Object.keys(consultation).length > 0;

  if (consultationStatus.block && !consultationAnswered) {
    return res.status(400).json({
      error: 'Please fill in the quick consultation form to book this treatment.',
      // The page sends her back to the form rather than leaving her on the
      // review screen reading a refusal with nothing to act on.
      code: 'consultation_required',
    });
  }

  // A free text note and a set of consultation answers stop sharing a column
  // here. This used to store JSON.stringify({ notes, consultation }) in
  // appointments.client_notes, which had two consequences, both found while
  // surfacing consultation forms: the answers never reached
  // consultation_responses so nothing could display them, and client_notes is
  // pasted into third party calendars, so the raw JSON of a client's medical
  // answers was one Google Calendar connection away from leaving Florrie.
  // The note is not medical data and stays here as plain text. The answers go
  // to consultation_responses once the appointment exists to attach them to.
  const { plainNote: clientNotes, answers: consultationAnswers } = splitBookingSubmission({ notes, consultation });

  let discountCents = 0;
  let discountMeta = null;  // stored on appointment for audit trail

  if (discount_code) {
    const normalised = discount_code.trim().toUpperCase();
    const now = new Date().toISOString();

    // Try promo code first
    const { data: promo, error: promoErr } = await supabase
      .from('promo_codes')
      .select('id, code, discount_type, discount_value, max_uses, current_uses, valid_from, valid_until, is_active')
      .eq('beautician_id', beautician.id)
      .eq('code', normalised)
      .maybeSingle();

    // She typed a code. If we cannot tell whether it is good, do NOT quietly
    // charge her the full price and book her anyway.
    if (promoErr) {
      logger.error({ err: promoErr, beauticianId: beautician.id }, 'book: promo lookup failed');
      return res.status(503).json({ error: 'Could not check your discount code just then. Nothing has been booked, please try again.' });
    }

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

    // Try gift voucher if promo didn't match. Columns are amount_cents and
    // remaining_cents (supabase/migrations/007), never `amount`: selecting the
    // column that does not exist made PostgREST reject the whole select, left
    // `voucher` null, and the salon's own gift voucher was silently ignored
    // while the client paid in full.
    if (!discountMeta) {
      const { data: voucher, error: voucherErr } = await supabase
        .from('gift_vouchers')
        .select('id, code, amount_cents, remaining_cents, status, expires_at')
        .eq('beautician_id', beautician.id)
        .eq('code', normalised)
        .maybeSingle();

      if (voucherErr) {
        logger.error({ err: voucherErr, beauticianId: beautician.id }, 'book: voucher lookup failed');
        return res.status(503).json({ error: 'Could not check your discount code just then. Nothing has been booked, please try again.' });
      }

      const voucherLive = voucher && voucher.status === 'active'
        && !(voucher.expires_at && voucher.expires_at < now);

      if (voucherLive) {
        const remaining = voucherRemainingCents(voucher);
        const treatmentTotal = combinedPriceCents + (add_ons || []).reduce((s, ao) => s + ao.price_cents, 0);
        discountCents = Math.min(remaining, treatmentTotal);

        if (discountCents > 0) {
          discountMeta = { type: 'voucher', code: voucher.code, voucher_id: voucher.id, discount_cents: discountCents };

          // Draw down what was actually used. A GBP 100 voucher against a GBP 40
          // treatment used to be marked fully 'redeemed', burning the other 60.
          const left = remaining - discountCents;
          const { error: redeemErr } = await supabase
            .from('gift_vouchers')
            .update({
              remaining_cents: left,
              ...(left <= 0 && { status: 'redeemed', redeemed_at: new Date().toISOString() }),
            })
            .eq('id', voucher.id);

          // If the draw-down did not stick, the voucher could be spent twice.
          if (redeemErr) {
            logger.error({ err: redeemErr, voucherId: voucher.id }, 'book: voucher redemption write failed');
            return res.status(503).json({ error: 'Could not apply your voucher just then. Nothing has been booked, please try again.' });
          }
        }
      }
    }

    // A code that genuinely matches nothing applies no discount, which is fine.
    // The difference that matters is that we now know it matched nothing,
    // rather than assuming so because a query we never checked came back null.
  }

  let isPackageRedemption = false;
  // Set when a package was asked for and could not be used, so the response can
  // say why the client is being asked to pay for a session she thought was
  // already paid for. Anything else and she just sees a bill she did not expect.
  let packageFellBackToPayment = false;
  if (client_package_id && client) {
    // Verify the package belongs to this client, is active, and has sessions left.
    // sessions_total, not `sessions`: the wrong column name made PostgREST reject
    // the select, left `clientPkg` null, and sent a client with a paid-for
    // 6-session package to Stripe to pay for the same session twice.
    const { data: clientPkg, error: clientPkgErr } = await supabase
      .from('client_packages')
      .select('id, sessions_used, sessions_total, expires_at, package_id, client_id, packages(sessions_total, treatment_ids)')
      .eq('id', client_package_id)
      .eq('beautician_id', beautician.id)
      .eq('status', 'active')
      .maybeSingle();

    // She asked to use a session. If we cannot verify it, refuse the booking
    // rather than fall through and charge her card for it.
    if (clientPkgErr) {
      logger.error({ err: clientPkgErr, beauticianId: beautician.id }, 'book: package lookup failed');
      return res.status(503).json({ error: 'Could not check your package just then. Nothing has been booked, please try again.' });
    }

    // SOMEONE ELSE'S PACKAGE IS THE ONLY HARD NO.
    //
    // A client_package_id that belongs to another client is not a race, it is
    // an id from somewhere it should not have come from, and quietly charging
    // the card would hide it. Refuse, loudly.
    if (clientPkg && clientPkg.client_id !== client.id) {
      logger.warn({ clientPackageId: client_package_id, beauticianId: beautician.id },
        'book: package belongs to a different client, refused');
      return res.status(409).json({ error: 'That package is not on your account. Please refresh and book again.' });
    }

    // EVERYTHING ELSE FALLS BACK TO PAYING.
    //
    // Gone, cancelled, out of sessions, out of date: this is the last session
    // of a course being used on another device between the page loading and
    // this submit, and before check-packages was fixed it could not happen at
    // all because the page never offered a package. The booking is still a
    // perfectly good booking; it just is not free. Refusing it turns a payable
    // booking into an error message, and she has to start again to get to the
    // same slot with the same card.
    if (!packageIsRedeemable(clientPkg)) {
      logger.info({
        clientPackageId: client_package_id,
        beauticianId: beautician.id,
        reason: !clientPkg ? 'not_found_or_inactive'
          : packageExpired(clientPkg) ? 'expired' : 'no_sessions_left',
      }, 'book: package not usable, booking continues as a paid booking');
      packageFellBackToPayment = true;
    } else {
      const used = clientPkg.sessions_used || 0;
      const totalSessions = clientPkg.sessions_total ?? clientPkg.packages?.sessions_total ?? 0;

      // Increment sessions_used. If this write does not land the session is
      // effectively free, so it decides the booking rather than being ignored.
      const { error: redeemPkgErr } = await supabase
        .from('client_packages')
        .update({
          sessions_used: used + 1,
          // Auto-complete if all sessions now used
          ...(used + 1 >= totalSessions && { status: 'completed' }),
        })
        .eq('id', client_package_id);

      if (redeemPkgErr) {
        logger.error({ err: redeemPkgErr, clientPackageId: client_package_id }, 'book: package redemption write failed');
        return res.status(503).json({ error: 'Could not use your package session just then. Nothing has been booked, please try again.' });
      }

      isPackageRedemption = true;
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
    // The deposit rules (per-treatment percent beats flat amount, the salon's
    // own switched-on deposit as the fallback, never more than the price) live
    // in lib/booking-rules.js. The payment method only governs the BALANCE.
    // A salon that has not switched deposits on takes none: the migration 029
    // default of "£10" sits next to require_deposit false and is not an
    // instruction to charge anybody.
    depositCents = resolveDepositCents({
      treatments: allTreatments,
      paymentSettings: beautician.payment_settings || {},
      combinedPriceCents,
    });

    // Full payment up front only applies to card. Cash/bank pay the balance
    // offline, so those only ever pay the DEPOSIT by card here.
    isFullPayment = payment_type === 'full' && combinedPriceCents > 0 && !isOfflinePayment;

    // The deposit is taken on EVERY booking, whatever the payment method. Cash
    // and bank transfer no longer skip it; they just pay the balance offline.
    depositRequired = depositCents > 0 || isFullPayment;
  }

  // CAN THIS SALON ACTUALLY TAKE THE MONEY?
  //
  // stripe_account_id plus stripe_onboarding_complete (migrations 001 and 003)
  // is the pair every paying path in this file already checks, so it is the
  // pair checked here. Without them there is no Checkout session to open, and
  // a booking that requires a payment nobody can make is not a booking, it is
  // a fifteen minute countdown to an auto-cancellation that tells the client
  // she did not pay and tells the owner nothing at all.
  const stripeReady = Boolean(stripe && beautician.stripe_account_id && beautician.stripe_onboarding_complete);
  const depositUnpayable = depositRequired && !stripeReady;

  // Payment buffer: if enabled, set expiry timestamp. Never on a booking there
  // is no way to pay for: an expiry is a deadline, and a deadline for a payment
  // that cannot be started is just a slower way of losing the appointment.
  const bufferEnabled = bookingPolicy.payment_buffer_enabled && depositRequired && !depositUnpayable;
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
      // 'pending' means "held while she pays". If there is nothing to pay with,
      // the hold has no end and the booking is simply confirmed: the client
      // asked for the slot, the salon can take the money in the chair, and
      // deposit_cents stays on the row so it shows as awaiting in the deposit
      // tracker rather than vanishing.
      status: depositRequired && !depositUnpayable ? 'pending' : 'confirmed',
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

  // The answers become a real consultation_responses row, in the same shape
  // POST /public/:token/submit writes, so a form filled in at booking and a
  // form filled in from a text message read as one thing on her screens.
  // Awaited rather than fired off, because she can open the booking the second
  // it lands and the answers should already be there.
  if (consultationAnswers) {
    const { unrecorded, failed } = await recordBookingConsultation({
      beauticianId: beautician.id,
      clientId: client.id,
      appointmentId: appointment.id,
      answers: consultationAnswers,
      formIds: allTreatments.map(t => t.consultation_form_id).filter(Boolean),
    });

    // Nothing is thrown away. If an answer could not be filed (the write
    // failed, or the key belongs to no question anyone can name) it is kept on
    // the appointment in the old shape, which is where it would have lived
    // anyway. client_notes no longer leaves Florrie, so parking it there is
    // containment rather than exposure, and a warning says it needs a look.
    const leftovers = Object.keys(unrecorded || {}).length > 0;
    if (failed || leftovers) {
      const { error: keepErr } = await supabase
        .from('appointments')
        .update({ client_notes: JSON.stringify({ notes: clientNotes || '', consultation: unrecorded }) })
        .eq('id', appointment.id);
      if (keepErr) {
        logger.error({ err: keepErr, appointmentId: appointment.id }, 'Could not keep the unfiled consultation answers on the appointment');
      } else {
        logger.warn(
          { appointmentId: appointment.id, unfiled: Object.keys(unrecorded || {}).length, failed },
          'Consultation answers kept on the appointment because they could not be filed'
        );
      }
    }
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
    summary: `${firstName} booked ${treatmentNames} for ${startsDate.toLocaleDateString('en-GB', { timeZone: 'UTC' })} at ${startsDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })}`,
    details: { appointment_id: appointment.id, treatment: treatmentNames, treatments: allTreatments.map(t => ({ id: t.id, name: t.name })), client_name },
    client_id: client.id,
    appointment_id: appointment.id,
    confidence: 1.0,
    autonomous: false,
    outcome: 'success',
    notification_sent: true,
    notification_text: `New booking: ${firstName}, ${treatmentNames}, ${startsDate.toLocaleDateString('en-GB', { timeZone: 'UTC' })} at ${startsDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })}`
  });
  if (logErr) logger.warn({ err: logErr }, 'AI action log failed (non-fatal)');

  // Push notification — beautician gets a team-style alert
  // timeZone UTC: wall time lives in the UTC slot
  const timeStr = startsDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  const dateStr = startsDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  // SHE IS TOLD ABOUT EVERY BOOKING, INCLUDING THE ONES STILL BEING PAID FOR.
  //
  // The old gate was `if (appointment.status !== 'pending')`, and the reason
  // given was noise: one push at the payment screen and a second when the money
  // landed read as two bookings, so the first was dropped. But the fix for two
  // pushes that say the same thing is two pushes that say different things, and
  // pushNewBooking has said different things since it was written: pending:true
  // sends "X is trying to book Y. Not confirmed until the deposit is paid" and
  // the confirmed push from the Stripe webhook is the second beat. The gate made
  // that copy unreachable, so a pending booking was silent, and if the client
  // never finished paying the FIRST thing the owner ever heard about it was the
  // cleanup saying a booking she never knew existed had been released.
  //
  // A booking she is never told about is worse than no booking, so the gate
  // stays but inverts: it picks the wording rather than deciding whether to
  // speak at all.
  if (appointment.status === 'confirmed') {
    await announceBookingConfirmed(appointment.id, { source: 'public_booking', claim: false });
  } else pushNewBooking(beautician.id, firstName, treatmentNames, `${dateStr} at ${timeStr}`, {
    appointmentId: appointment.id,
    apptDate: appointment.starts_at,
    pending: appointment.status === 'pending',
  }).catch(() => {});
  refreshLiveActivity(beautician.id).catch(() => {});

  // A DEPOSIT NOBODY CAN PAY DOES NOT HOLD UP A BOOKING.
  //
  // This branch used to answer 201 with status 'pending', deposit_pending true
  // and the line "your beautician will send a payment link to confirm your
  // booking". Nothing in Florrie sends one. Fifteen minutes later the stale
  // sweep cancelled the row, texted the client that her slot was released
  // because the deposit was not paid, and pushed the owner that somebody had
  // started a booking and not paid. Every sentence in that sequence was untrue,
  // and it happened to a new salon's FIRST booking, because a new salon has
  // payment_settings at the migration default and no Stripe account.
  //
  // So the booking is confirmed instead. Refusing it was the other honest
  // option and it is the wrong one: the client picked a real slot on a real
  // page, the salon can take a card or cash in the chair, and the alternative
  // is turning away business over a payment setting nobody has opened. The
  // deposit stays recorded on the row as awaiting, and the owner is told it
  // could not be taken online so she can ask for it herself.
  if (depositUnpayable) {
    confirmOrTellTheOwner(appointment.id, beautician.id, firstName);

    // One extra line to the owner, beside the new-booking push: the money side
    // of this booking is hers to chase, and she cannot chase what she has not
    // been told about.
    const owedLabel = isFullPayment
      ? `the £${(combinedPriceCents / 100).toFixed(2)}`
      : `the £${(depositCents / 100).toFixed(2)} deposit`;
    pushTeamUpdate(beautician.id, 'booking_confirmed',
      `${firstName} is booked in for ${treatmentNames}, ${dateStr} at ${timeStr}. Card payments are not set up yet, so ${owedLabel} could not be taken online. Take it at the appointment, or connect Stripe to collect it up front.`,
      { url: `/calendar/week?date=${String(appointment.starts_at).slice(0, 10)}&appt=${appointment.id}` }
    ).catch(() => {});

    logger.warn({
      appointmentId: appointment.id, beauticianId: beautician.id, depositCents,
    }, 'Deposit could not be collected online (no Stripe connection), booking confirmed instead of held');

    // Send the consultation form (non-blocking). CHASE, NOT BLOCK: this is how
    // everybody newly in scope since 29 August 2026 gets asked without being
    // stopped. Skipped when they answered inline during booking, which was
    // Ellie's double-ask bug.
    if (consultationStatus.ask && client_phone && !consultationAnswered) {
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
        date: startsDate.toLocaleDateString('en-GB', { timeZone: 'UTC' }),
        time: startsDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }),
        price: `£${(combinedPriceCents / 100).toFixed(2)}`,
        // deposit stays null so the page does not subtract a deposit nobody
        // has taken from the balance it shows her. The amount still owed is
        // the whole price, and that is what the bank-transfer panel prints.
        deposit: null,
        status: appointment.status,
        deposit_pending: false,
      },
      // No checkout_url, and no promise of a payment link nothing sends.
      deposit_note: 'Your booking is confirmed. Nothing to pay online, you can settle up at your appointment.',
      // She picked a package and it was not there to use. Saying why beats
      // showing her a bill with no explanation.
      ...(packageFellBackToPayment && { package_note: 'That package session was not available any more, so this booking has been priced as normal.' }),
    });
  }

  // If deposit required and beautician has Stripe Connect, create Checkout session.
  // Returning clients with a saved stripe_customer_id see saved payment methods.
  // stripeReady is the same three-part check the branch above answers with, kept
  // as one expression so the two can never disagree about whether a payment is
  // possible and leave a booking in the gap between them.
  if (depositRequired && stripeReady) {
    try {
      const bookingSlug = req.params.slug;
      const dateLabel = startsDate.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

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
                description: `${dateLabel} at ${startsDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} with ${beautician.business_name || beautician.first_name}`,
              },
              unit_amount: Math.max(0, amount),
            },
            quantity: 1,
          });
        }
      } else {
        // Deposit: single combined line item
        const label = allTreatments.length > 1
          ? `${treatmentNames} deposit`
          : `${treatment.name} deposit`;
        lineItems.push({
          price_data: {
            currency: 'gbp',
            product_data: {
              name: label,
              description: `${dateLabel} at ${startsDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} with ${beautician.business_name || beautician.first_name}`,
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
      // Destination charge: the platform pays Stripe's processing fee, so the
      // application fee must recover it on top of Florrie's cut or every
      // booking loses the platform money (the arrears leak).
      const platformFee = totalApplicationFee(checkoutTotalCents);

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

      // Pin the payment intent to the booking. This is the only thread back
      // from a charge to the appointment it paid for, so it is what lets the
      // stale cleanup ask Stripe "was this one actually paid?" before taking
      // the slot away. An unchecked write here leaves the cleanup blind, which
      // is precisely the state that gave away paid slots on 5 August, so the
      // error is read and reported rather than dropped.
      //
      // session.payment_intent is null for a Checkout session Stripe has not
      // attached one to yet; writing that null would erase a pinned intent
      // rather than record one, so it is skipped and shouted about instead.
      if (session.payment_intent) {
        const { error: pinErr } = await supabase.from('appointments').update({
          stripe_payment_intent_id: session.payment_intent,
          deposit_amount_cents: depositCents,
          deposit_status: 'pending',
        }).eq('id', appointment.id);
        if (pinErr) {
          logger.error({ err: pinErr, appointmentId: appointment.id }, 'Could not pin the payment intent to the booking');
          Sentry.captureMessage('Payment intent not pinned to a deposit booking', {
            level: 'error',
            tags: { area: 'payments', check: 'booking_pin_payment_intent' },
            extra: { appointmentId: appointment.id, sessionId: session.id },
          });
        }
      } else {
        const { error: depErr } = await supabase.from('appointments').update({
          deposit_amount_cents: depositCents,
          deposit_status: 'pending',
        }).eq('id', appointment.id);
        if (depErr) logger.error({ err: depErr, appointmentId: appointment.id }, 'Could not record the pending deposit on the booking');
        logger.error({ appointmentId: appointment.id, sessionId: session.id }, 'Checkout session came back with no payment intent, the cleanup cannot verify this one');
        Sentry.captureMessage('Checkout session created with no payment intent', {
          level: 'error',
          tags: { area: 'payments', check: 'booking_pin_payment_intent' },
          extra: { appointmentId: appointment.id, sessionId: session.id },
        });
      }

      // Don't fire confirmation here. The booking is still 'pending' until the Stripe webhook
      // (checkout.session.completed) marks the deposit paid and triggers notifyBookingConfirmed.
      if (appointment.status === 'confirmed') {
        confirmOrTellTheOwner(appointment.id, beautician.id, firstName);
      }

      // Send the consultation form (non-blocking). CHASE, NOT BLOCK, exactly as
      // in the branch above. SKIPPED when they answered inline during booking:
      // texting the same form again straight after was Ellie's double-ask bug.
      if (consultationStatus.ask && client_phone && !consultationAnswered) {
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
          date: startsDate.toLocaleDateString('en-GB', { timeZone: 'UTC' }),
          time: startsDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }),
          price: `£${(combinedPriceCents / 100).toFixed(2)}`,
          deposit: isFullPayment ? null : `£${(depositCents / 100).toFixed(2)}`,
          payment_type: isFullPayment ? 'full' : 'deposit',
          amount_charged: `£${(checkoutTotalCents / 100).toFixed(2)}`,
          status: 'pending',
          paymentExpiresAt: paymentExpiresAt || null,
          ...(discountMeta && { discount: { code: discountMeta.code, type: discountMeta.type, saved: `£${(discountCents / 100).toFixed(2)}` } }),
        },
        checkout_url: session.url,
        // She picked a package and it was not there to use. Saying why beats
        // showing her a bill with no explanation.
        ...(packageFellBackToPayment && { package_note: 'That package session was not available any more, so this booking has been priced as normal.' }),
      });
    } catch (err) {
      // THE FALL-THROUGH THAT TOLD A CLIENT SHE WAS BOOKED.
      //
      // This used to log and carry on, so execution dropped into the
      // "no deposit, confirmed immediately" tail below: notifyBookingConfirmed
      // fired a full "you're booked in for X at Y", and the route answered 201
      // with no checkout_url, which the booking page renders as a green tick.
      // Meanwhile the row sat 'pending' with no payment intent, so the stale
      // cleanup had nothing to ask Stripe about and quietly cancelled it later.
      // A hold nobody can pay for is a slot out of Ellie's diary and a client
      // who believes she has an appointment. conversational-booking.js has
      // given the slot back on this failure since it was written; so does this.
      logger.error({ err, appointmentId: appointment.id }, 'Stripe checkout creation failed, releasing the hold');
      Sentry.captureException(err, {
        tags: { area: 'payments', check: 'booking_checkout_create' },
        extra: { appointmentId: appointment.id, beauticianId: beautician.id },
      });

      const { error: releaseErr } = await supabase
        .from('appointments')
        .update({
          status: 'cancelled',
          cancellation_reason: 'checkout_creation_failed',
          cancelled_at: new Date().toISOString(),
        })
        .eq('id', appointment.id)
        .eq('status', 'pending');
      if (releaseErr) {
        // Worst case of all: a slot held by a booking nobody can pay for and
        // nobody cancelled. Somebody has to hear about this one.
        logger.error({ err: releaseErr, appointmentId: appointment.id }, 'Could not release the hold after a failed checkout');
        Sentry.captureMessage('Booking hold left in the diary after a failed checkout', {
          level: 'error',
          tags: { area: 'payments', check: 'booking_checkout_release' },
          extra: { appointmentId: appointment.id },
        });
      }

      return res.status(502).json({
        error: "We couldn't open the payment page just then, so nothing has been booked. Please try again in a moment.",
        code: 'checkout_unavailable',
      });
    }
  }

  // Belt and braces. Both deposit branches above return, so a booking that
  // needs a deposit can no longer reach the confirmation tail; if one ever
  // does again it is a bug, and a bug must not be resolved by telling a client
  // she is booked in for something she has not paid for.
  if (depositRequired) {
    logger.error({ appointmentId: appointment.id }, 'Deposit booking reached the confirmed-immediately tail');
    Sentry.captureMessage('Deposit booking fell through to the confirmed-immediately tail', {
      level: 'error',
      tags: { area: 'payments', check: 'booking_deposit_fallthrough' },
      extra: { appointmentId: appointment.id },
    });
    return res.status(500).json({
      error: "Something went wrong setting up your payment, so nothing has been booked. Please try again.",
      code: 'checkout_unavailable',
    });
  }

  // No deposit required: the booking is confirmed outright.
  // Fire confirmation notification (non-blocking)
  confirmOrTellTheOwner(appointment.id, beautician.id, firstName);

  // Send the consultation form (non-blocking). CHASE, NOT BLOCK, exactly as in
  // the two branches above. Skipped when they answered inline during booking
  // (the double-ask bug).
  if (consultationStatus.ask && client_phone && !consultationAnswered) {
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
      date: startsDate.toLocaleDateString('en-GB', { timeZone: 'UTC' }),
      time: startsDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }),
      price: `£${(combinedPriceCents / 100).toFixed(2)}`,
      deposit: null,
      status: appointment.status,
      paymentExpiresAt: paymentExpiresAt || null,
    },
    // She picked a package and it was not there to use. Saying why beats
    // showing her a bill with no explanation.
    ...(packageFellBackToPayment && { package_note: 'That package session was not available any more, so this booking has been priced as normal.' }),
  });
});

export default router;
