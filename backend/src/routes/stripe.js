import { claimPaymentEvent, completePaymentEvent, releasePaymentEvent } from '../services/payment-webhook-events.js';
import { isBillingEvent, handleBillingEvent } from './billing.js';
import { Router } from 'express';
import Stripe from 'stripe';
import * as Sentry from '@sentry/node';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOwned } from '../lib/ownership.js';
import { notifyBookingConfirmed } from '../services/notifications.js';
import { announceBookingConfirmed } from '../services/booking-confirmed-alert.js';
import { cleanupStripeEvents } from '../services/stripe-cleanup.js';
import { totalApplicationFee, estimateStripeFee, getFeeDescription } from '../lib/platform-fees.js';
import {
  buildRefundTransaction,
  buildDisputeReversalTransaction,
  refundDeltaCents,
  disputeTag,
  disputeWonTag,
  hasTag, BOOKING_MONEY_LOGGED_TYPES} from '../lib/money-guards.js';
import { chargePolicyFee } from '../services/policy-fees.js';
import logger from '../lib/logger.js';
import { verifyWebhook } from '../lib/stripe-webhook-secret.js';
import { requireCronKey } from '../middleware/security.js';
// The plan name is written in routes/billing.js and read here. Importing the
// reader from the writer is the whole point: the key cannot drift apart again
// without breaking the import.
import { readPlanFromMetadata, PLAN_METADATA_KEY } from './billing.js';
import { internalStatusFor, isCardlessDraft } from '../lib/subscription-status.js';
import { handleDunningEvent } from '../services/dunning.js';
import { teamSeatQuantity } from '../lib/team-seats.js';

const router = Router();
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;
const FRONTEND_URL = process.env.FRONTEND_URL;

// Guard: if Stripe isn't configured, return 503 for all Stripe endpoints
// except webhook (which uses its own error handling)
function requireStripe(req, res, next) {
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe not configured. Add STRIPE_SECRET_KEY to environment.' });
  }
  next();
}

// ═══════════════════════════════════════════════
// STRIPE CONNECT — Beautician payment onboarding
// ═══════════════════════════════════════════════

/**
 * POST /api/stripe/connect/onboard
 * Creates a Stripe Connect account (Accounts v2) and returns the onboarding link.
 * Uses recipient + merchant configurations for the marketplace model:
 *   - recipient: enables stripe_balance.stripe_transfers (beautician receives payouts)
 *   - merchant: enables card_payments (beautician can accept payments via Florrie)
 * Florrie is the losses_collector and fees_collector (application model).
 * The beautician completes KYC on Stripe's hosted Express dashboard.
 */
router.post('/connect/onboard', requireAuth, requireStripe, async (req, res) => {
  try {
    let accountId = req.beautician.stripe_account_id;

    // Verify existing account ID is valid with current key — clears stale test-mode IDs
    if (accountId) {
      try {
        await stripe.accounts.retrieve(accountId);
      } catch (verifyErr) {
        if (verifyErr?.statusCode === 404 || verifyErr?.message?.includes('No such account')) {
          logger.warn({ accountId }, 'Stale Stripe account ID — clearing and creating fresh');
          accountId = null;
          await supabase
            .from('beauticians')
            .update({ stripe_account_id: null, stripe_onboarding_complete: false })
            .eq('id', req.beautician.id);
        } else {
          throw verifyErr;
        }
      }
    }

    // Create account if not exists
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'GB',
        email: req.beautician.email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_profile: {
          name: req.beautician.business_name || `${req.beautician.first_name}'s Beauty`,
          mcc: '7230', // Barber and beauty shops
        },
        metadata: {
          beautician_id: req.beautician.id,
        },
      });

      accountId = account.id;

      await supabase
        .from('beauticians')
        .update({ stripe_account_id: accountId })
        .eq('id', req.beautician.id);
    }

    // Generate onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${FRONTEND_URL}/settings?stripe=refresh`,
      return_url: `${FRONTEND_URL}/settings?stripe=success`,
      type: 'account_onboarding',
    });

    res.json({ url: accountLink.url });
  } catch (err) {
    logger.error({ err }, 'Stripe Connect onboard error');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * GET /api/stripe/connect/status
 * Check if the beautician's Stripe account is fully onboarded.
 * Account is complete when charges_enabled && payouts_enabled.
 */
router.get('/connect/status', requireAuth, requireStripe, async (req, res) => {
  const accountId = req.beautician.stripe_account_id;

  if (!accountId) {
    return res.json({ connected: false, onboarding_complete: false });
  }

  try {
    let complete = false;
    let chargesEnabled = false;
    let payoutsEnabled = false;
    let currency = 'gbp';

    const account = await stripe.accounts.retrieve(accountId);
    complete = account.charges_enabled && account.payouts_enabled;
    chargesEnabled = account.charges_enabled;
    payoutsEnabled = account.payouts_enabled;
    currency = account.default_currency || 'gbp';

    // Sync our DB if the status has changed
    if (complete !== req.beautician.stripe_onboarding_complete) {
      await supabase
        .from('beauticians')
        .update({ stripe_onboarding_complete: complete })
        .eq('id', req.beautician.id);
    }

    res.json({
      connected: true,
      onboarding_complete: complete,
      charges_enabled: chargesEnabled,
      payouts_enabled: payoutsEnabled,
      default_currency: currency,
    });
  } catch (err) {
    // Stale or test-mode account ID — clear it so they can re-onboard with the live key
    if (err?.raw?.code === 'account_invalid' || err?.statusCode === 404 || err?.message?.includes('No such account')) {
      logger.warn({ accountId }, 'Stripe account not found — clearing stale account ID');
      await supabase
        .from('beauticians')
        .update({ stripe_account_id: null, stripe_onboarding_complete: false })
        .eq('id', req.beautician.id);
      return res.json({ connected: false, onboarding_complete: false, stale: true });
    }
    logger.error({ err }, 'Stripe status error');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// ═══════════════════════════════════════════════
// CHECKOUT — Client payments (deposits + full)
// ═══════════════════════════════════════════════

/**
 * POST /api/stripe/checkout
 * Creates a Stripe Checkout session for a booking deposit.
 * Redirects the client to Stripe's hosted payment page.
 */
router.post('/checkout', requireAuth, requireStripe, async (req, res) => {
  const { appointment_id, beautician_id, amount_cents, description } = req.body;

  if (!appointment_id || !beautician_id || !amount_cents) {
    return res.status(400).json({ error: 'appointment_id, beautician_id, and amount_cents required' });
  }

  // Get the beautician's Stripe account. The error is read on purpose: this
  // used to be `const { data: beautician }` alone, and a missing column in the
  // select (PostgREST rejects the whole list) made every deposit answer 400
  // with 'Beautician has not completed Stripe setup', which was a lie about
  // the salon. A read failure is a 500 that names itself, not a claim about
  // her onboarding.
  const { data: beautician, error: beauticianErr } = await supabase
    .from('beauticians')
    .select('stripe_account_id, stripe_onboarding_complete, business_name')
    .eq('id', beautician_id)
    .single();

  if (beauticianErr) {
    logger.error({ err: beauticianErr, beautician_id, appointment_id }, 'Checkout: could not read the beautician row for the Stripe Connect gate');
    return res.status(500).json({ error: 'Could not check payment setup. Please try again.' });
  }

  if (!beautician?.stripe_account_id || !beautician.stripe_onboarding_complete) {
    return res.status(400).json({ error: 'Beautician has not completed Stripe setup' });
  }

  try {
    // Destination charge: the platform pays Stripe's processing fee, so the
    // application fee must recover it on top of Florrie's cut or this payment
    // loses the platform money (the arrears leak).
    const platformFee = totalApplicationFee(amount_cents);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: {
            name: description || 'Booking deposit',
          },
          unit_amount: amount_cents,
        },
        quantity: 1,
      }],
      payment_intent_data: {
        application_fee_amount: platformFee,
        transfer_data: {
          destination: beautician.stripe_account_id,
        },
        metadata: {
          appointment_id,
          beautician_id,
          platform_fee_cents: platformFee,
        },
      },
      success_url: `${FRONTEND_URL}/book/confirmed?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/book/cancelled`,
      metadata: {
        appointment_id,
        beautician_id,
      },
    });

    // Store the payment intent on the appointment
    await supabase
      .from('appointments')
      .update({
        stripe_payment_intent_id: session.payment_intent,
        deposit_amount_cents: amount_cents,
        deposit_status: 'pending',
      })
      .eq('id', appointment_id);

    res.json({ url: session.url, session_id: session.id });
  } catch (err) {
    logger.error({ err }, 'Checkout session error');
    logger.error({ err }, 'Stripe operation failed');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// ═══════════════════════════════════════════════
// SUBSCRIPTIONS — Florrie SaaS billing
// ═══════════════════════════════════════════════

/**
 * POST /api/stripe/subscribe
 * Creates a Checkout session for a Florrie subscription plan.
 */
router.post('/subscribe', requireAuth, requireStripe, async (req, res) => {
  const { plan_id } = req.body;

  // Get plan details
  const { data: plan } = await supabase
    .from('plans')
    .select('*')
    .eq('id', plan_id)
    .single();

  if (!plan || !plan.stripe_price_id) {
    return res.status(400).json({ error: 'Invalid plan' });
  }

  try {
    // Ensure customer exists in Stripe
    let customerId = req.beautician.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.beautician.email,
        metadata: { beautician_id: req.beautician.id },
      });
      customerId = customer.id;
      // The customer already exists in Stripe whether or not this row write
      // lands, so a failed write still returns the checkout URL. It is logged
      // loudly because a lost stripe_customer_id makes the NEXT checkout
      // create a second Stripe customer, and the monthly overage invoice items
      // then attach to whichever one the row happens to name: an orphan.
      const { error: customerIdErr } = await supabase
        .from('beauticians')
        .update({ stripe_customer_id: customerId })
        .eq('id', req.beautician.id);
      if (customerIdErr) {
        logger.error({ err: customerIdErr, beauticianId: req.beautician.id, customerId }, 'Subscribe: stripe_customer_id was created in Stripe but could not be saved on the beautician');
        Sentry.captureException(customerIdErr, {
          tags: { area: 'billing', check: 'stripe_customer_id_write' },
          extra: { beauticianId: req.beautician.id, customerId },
        });
      }
    }

    // One seat per active staff member on the team plan. This has no effect
    // on the amount charged until the Stripe price is per-seat: the 'Florrie
    // Team' price created by backend/scripts/stripe-setup.js (around line 36)
    // is a flat £44, and Stripe multiplies a flat price by the quantity, so
    // lib/team-seats.js answers 1 until STRIPE_TEAM_PRICE_PER_SEAT is set
    // against a per-seat price. Set the flag and the staff count goes through.
    const quantity = await teamSeatQuantity(supabase, req.beautician.id, plan_id);

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: plan.stripe_price_id, quantity }],
      success_url: `${FRONTEND_URL}/settings?plan=success`,
      cancel_url: `${FRONTEND_URL}/settings?plan=cancelled`,
      subscription_data: {
        trial_period_days: req.beautician.subscription_plan === 'trial' ? 14 : undefined,
        metadata: { beautician_id: req.beautician.id, plan_id },
      },
    });

    res.json({ url: session.url });
  } catch (err) {
    logger.error({ err }, 'Subscribe error');
    logger.error({ err }, 'Stripe operation failed');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * POST /api/stripe/portal
 * Opens the Stripe Customer Portal for managing subscription.
 */
router.post('/portal', requireAuth, requireStripe, async (req, res) => {
  const customerId = req.beautician.stripe_customer_id;
  if (!customerId) {
    return res.status(400).json({ error: 'No active Florrie subscription found.' });
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${FRONTEND_URL}/settings`,
    });
    res.json({ url: session.url });
  } catch (err) {
    // Stale test-mode customer ID — clear it and return a clean error
    if (err?.statusCode === 404 || err?.message?.includes('No such customer')) {
      logger.warn({ customerId }, 'Stale Stripe customer ID — clearing from DB');
      await supabase
        .from('beauticians')
        .update({ stripe_customer_id: null })
        .eq('id', req.beautician.id);
      return res.status(400).json({ error: 'No active Florrie subscription found.' });
    }
    logger.error({ err }, 'Portal error');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// ═══════════════════════════════════════════════
// PLATFORM FEE INFO
// ═══════════════════════════════════════════════

/**
 * GET /api/stripe/fees
 * Returns Florrie's platform fee structure for display in settings/onboarding.
 */
router.get('/fees', requireAuth, (req, res) => {
  res.json(getFeeDescription());
});

// ═══════════════════════════════════════════════
// NO-SHOW FEE — Charge saved card
// ═══════════════════════════════════════════════

/**
 * POST /api/stripe/charge-no-show
 * Charges the client's saved card for a no-show fee.
 * Requires: appointment_id, amount_cents (optional — defaults to deposit amount)
 * The client must have a saved stripe_customer_id with a payment method on file.
 */
router.post('/charge-no-show', requireAuth, requireStripe, async (req, res) => {
  const { appointment_id } = req.body;

  if (!appointment_id) {
    return res.status(400).json({ error: 'appointment_id is required' });
  }

  // Verify beautician has Stripe Connect set up before attempting off-session charge
  if (!req.beautician.stripe_account_id || !req.beautician.stripe_onboarding_complete) {
    return res.status(400).json({ error: 'Complete Stripe setup before charging no-show fees' });
  }

  try {
    // Ownership + state check. The actual charge goes through chargePolicyFee,
    // which is the single idempotent path (guards on policy_fee_charged_at and
    // carries a Stripe idempotency key), so the manual button can never
    // double-charge a card that the automatic no-show flow already charged.
    const { data: appointment, error: fetchError } = await supabase
      .from('appointments')
      .select('id, status, price_cents, policy_fee_charged_at')
      .eq('id', appointment_id)
      .eq('beautician_id', req.beautician.id)
      .single();

    if (fetchError || !appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }
    if (appointment.status !== 'no_show') {
      return res.status(400).json({ error: 'Appointment must be marked as no-show first' });
    }
    if (appointment.policy_fee_charged_at) {
      return res.status(409).json({ error: 'This no-show fee has already been charged.' });
    }

    const result = await chargePolicyFee(appointment_id, 'no_show');

    if (result.charged) {
      return res.json({
        success: true,
        amount_cents: result.feeCents,
        payment_intent_id: result.paymentIntentId,
        status: 'succeeded',
      });
    }

    // Map the (never-throwing) reason to a helpful response.
    const reason = result.reason;
    if (reason === 'already_charged') {
      return res.status(409).json({ error: 'This no-show fee has already been charged.' });
    }
    if (reason === 'no_fee_configured') {
      return res.status(400).json({
        error: 'No no-show fee is set in your booking policy. Set one in Settings, or send a payment link instead.',
        code: 'no_fee_configured',
      });
    }
    if (reason === 'no_card_on_file') {
      return res.status(400).json({
        error: 'Client has no saved card on file. Send a payment link instead.',
        code: 'no_card_on_file',
      });
    }
    if (reason === 'stripe_not_onboarded' || reason === 'stripe_not_configured') {
      return res.status(400).json({ error: 'Complete Stripe setup before charging no-show fees.' });
    }
    if (reason === 'authentication_required') {
      return res.status(402).json({
        error: 'Client card requires authentication. Send a payment link instead.',
        code: 'authentication_required',
      });
    }
    if (reason === 'card_declined' || (typeof reason === 'string' && reason.startsWith('card_'))) {
      return res.status(402).json({ error: 'Card declined. Send a payment link instead.', code: reason });
    }
    return res.status(502).json({ error: 'Could not charge the no-show fee. Send a payment link instead.', code: reason || 'unknown' });
  } catch (err) {
    logger.error({ err }, 'No-show charge error');
    res.status(500).json({ error: 'Failed to charge no-show fee' });
  }
});

// ═══════════════════════════════════════════════
// REFUNDS
// ═══════════════════════════════════════════════

/**
 * The off-session charges that write a status:'completed' transaction the
 * moment Stripe says 'processing', before the money has actually cleared. These
 * are the ones a later payment_intent.payment_failed has to undo. Every value
 * here is a metadata.type set in services/policy-fees.js.
 */
const OPTIMISTIC_CHARGE_TYPES = new Set([
  'no_show_fee', 'late_cancel_fee', 'reschedule_deposit', 'remaining_balance', 'manual_charge',
]);

/**
 * Write a money-out row (refund or dispute) to the books, once.
 *
 * WHY THIS IS SHARED
 * Refunds reached the ledger from exactly one place, POST /api/stripe/refund,
 * with an unchecked insert. The charge.refunded webhook only wrote a log line,
 * and charge.dispute.created was not handled at all, so a chargeback removed
 * money from Ellie's account and left the books showing it as income for ever.
 * Both paths now come through here, which is also the only way the two can
 * dedupe against each other: a refund Ellie triggers in the app arrives a
 * second time as a webhook seconds later.
 *
 * Returns { recorded, reason }. Never throws.
 */
async function recordMoneyOut({
  paymentIntentId,
  chargeId = null,
  totalRefundedCents,
  exactAmountCents = null,
  tag = null,
  reversal = false,
  fallbackBeauticianId = null,
  fallbackAppointmentId = null,
  description = null,
  source,
}) {
  if (!paymentIntentId) return { recorded: false, reason: 'no_payment_intent' };

  // Everything already written against this PaymentIntent. This read is the
  // guard, so a failed read must REFUSE, not fall through and insert: a
  // transient error that returns null would otherwise write a duplicate
  // negative row and understate Ellie's takings by the refund amount.
  const { data: priorRows, error: priorErr } = await supabase
    .from('transactions')
    .select('id, amount_cents, description, beautician_id, appointment_id, client_id')
    .eq('stripe_payment_intent_id', paymentIntentId);

  if (priorErr) {
    logger.error({ err: priorErr, paymentIntentId, source }, 'refund guard unreadable, refusing to record');
    Sentry.captureMessage('Refund not recorded: guard unreadable', {
      level: 'error',
      tags: { area: 'payments', check: 'refund_guard' },
      extra: { paymentIntentId, source, dbError: priorErr.message, dbCode: priorErr.code },
    });
    return { recorded: false, reason: 'guard_unreadable' };
  }

  const refundRows = (priorRows || []).filter((r) => (Number(r.amount_cents) || 0) < 0
    || String(r.description || '').includes('[dispute:'));

  if (tag && hasTag(priorRows, tag)) {
    return { recorded: false, reason: 'already_recorded' };
  }

  const amountCents = exactAmountCents !== null
    ? Math.abs(Math.round(Number(exactAmountCents) || 0))
    : refundDeltaCents(totalRefundedCents, refundRows);

  if (!amountCents) return { recorded: false, reason: 'already_recorded' };

  // The original payment row carries who this money belongs to. transactions
  // .beautician_id is NOT NULL, so without it there is nothing we can write.
  const origin = (priorRows || []).find((r) => (Number(r.amount_cents) || 0) > 0) || {};
  const beauticianId = origin.beautician_id || fallbackBeauticianId;
  const appointmentId = origin.appointment_id || fallbackAppointmentId || null;

  if (!beauticianId) {
    logger.error({ paymentIntentId, source }, 'money out with no owning beautician, not recorded');
    Sentry.captureMessage('Refund not recorded: no matching payment row', {
      level: 'error',
      tags: { area: 'payments', check: 'refund_orphan' },
      extra: { paymentIntentId, chargeId, amountCents, source },
    });
    return { recorded: false, reason: 'no_beautician' };
  }

  const build = reversal ? buildDisputeReversalTransaction : buildRefundTransaction;
  const row = build({
    beauticianId,
    appointmentId,
    clientId: origin.client_id || null,
    amountCents,
    paymentIntentId,
    chargeId,
    description: tag ? `${tag} ${description || ''}`.trim() : description,
  });

  const { error: insErr } = await supabase.from('transactions').insert(row);
  if (insErr) {
    // Money has left the account and the books do not know. Same failure mode
    // as the six weeks of card charges that were rejected by a CHECK
    // constraint and only ever logged.
    logger.error({ err: insErr, paymentIntentId, amountCents, source },
      'REFUNDED BUT NOT RECORDED: money out but the transaction insert failed');
    Sentry.captureMessage('REFUNDED BUT NOT RECORDED', {
      level: 'error',
      tags: { area: 'payments', check: 'transaction_insert' },
      extra: {
        paymentIntentId, chargeId, amountCents, source, beauticianId, appointmentId,
        dbError: insErr.message, dbCode: insErr.code,
      },
    });
    return { recorded: false, reason: 'insert_failed' };
  }

  logger.info({ paymentIntentId, amountCents, source }, 'Money out recorded');
  return { recorded: true, amountCents };
}

/**
 * How much of the application fee may honestly be handed back.
 *
 * On a destination charge Florrie collects ONE application fee made of two
 * different things (see lib/platform-fees.js):
 *
 *     application_fee = Florrie's cut + estimated Stripe processing fee
 *
 * The second part is not income. It exists because the PLATFORM, not the
 * beautician, is billed by Stripe for processing a destination charge, so the
 * fee has to be recovered through the application fee or every booking loses
 * money. On a GBP 10 deposit that is 15p + 34p = 49p collected, of which
 * Florrie actually KEEPS 15p.
 *
 * Stripe does not return its processing fee when a UK charge is refunded. So
 * `refund_application_fee: true`, which returns the whole 49p, hands back 34p
 * that Florrie never had. That is the same arrears leak the platform-fees
 * comments were written to close, running in reverse.
 *
 * The honest number is the RETAINED part only, prorated by how much of the
 * charge is being refunded:
 *
 *     retained = application_fee_charged - estimated Stripe fee on the charge
 *     owed(x)  = min(retained, round(retained * x / charge_amount))
 *     this refund's fee = owed(already_refunded + this_refund) - owed(already_refunded)
 *
 * Working from the RUNNING TOTAL rather than this refund alone is what stops a
 * string of small partials rounding their way past `retained`. Ten 10p refunds
 * of a GBP 1 charge each round 0.5p up to 1p, which would hand back 10p of a
 * 5p margin; on the running total they hand back exactly 5p.
 *
 * Worked, GBP 10 deposit refunded in full:
 *     fee charged 49p, Stripe estimate 34p, retained 15p -> refund 15p
 *     (today: 49p, so 34p per refund out of Florrie's pocket)
 *
 * Worked, GBP 50 deposit with GBP 15 refunded:
 *     fee charged 165p (75p cut + 90p Stripe), retained 75p
 *     75 * 1500 / 5000 = 22.5 -> 23p
 *     (today: 165 * 1500 / 5000 = 49.5 -> 50p, so 27p out of pocket)
 *
 * Floors at zero: on a tiny charge the application fee is capped at the charge
 * amount and can be less than the Stripe estimate, meaning nothing was
 * retained and nothing can be given back.
 *
 * @param {object} args
 * @param {number} args.chargeAmountCents amount of the original charge
 * @param {number} args.refundAmountCents amount being refunded now
 * @param {number} [args.alreadyRefundedCents] refunded before this one
 * @param {number} [args.applicationFeeCents] fee actually taken on the charge
 * @returns {number} application fee refund in pence
 */
export function refundableApplicationFeeCents({
  chargeAmountCents,
  refundAmountCents,
  alreadyRefundedCents = 0,
  applicationFeeCents,
}) {
  const charge = Math.round(Number(chargeAmountCents) || 0);
  const refundAmount = Math.round(Number(refundAmountCents) || 0);
  const already = Math.max(0, Math.round(Number(alreadyRefundedCents) || 0));
  if (charge <= 0 || refundAmount <= 0) return 0;

  const feeCharged = Number.isFinite(Number(applicationFeeCents))
    ? Math.max(0, Math.round(Number(applicationFeeCents)))
    : totalApplicationFee(charge);

  // The slice of the fee that was really Florrie's. Never negative.
  const retained = Math.max(0, feeCharged - estimateStripeFee(charge));
  if (retained === 0) return 0;

  const owed = (refunded) => Math.min(
    retained,
    Math.round(retained * Math.min(Math.max(0, refunded), charge) / charge),
  );

  return Math.max(0, owed(already + refundAmount) - owed(already));
}

/**
 * The key that makes a double tap harmless.
 *
 * Stripe will happily create a SECOND partial refund on the same charge until
 * the charge total is exhausted, so "refund GBP 15 of a GBP 50 deposit" twice
 * takes GBP 30. Every input that defines this refund goes into the key: who is
 * refunding, which payment, and how much. Two taps of the same button produce
 * the same key, Stripe replays the first refund instead of making another, and
 * the caller gets the original refund id back.
 *
 * Nothing here comes from a request header. The old guard keyed on an
 * Idempotency-Key the app has never sent, which is why it never fired.
 *
 * A deliberate second refund of the SAME amount on the same payment is
 * indistinguishable from a double tap, so it is held for Stripe's 24 hour
 * idempotency window. `refund_request_id` in the body is the escape hatch for
 * that case: any value not used before makes the key distinct.
 *
 * The route does NOT assume the replay was a double tap. It checks the charge
 * afterwards, and when no money moved it says so and names the escape hatch,
 * rather than reporting a refund that did not happen. See the check under
 * refunds.create below.
 */
export function refundIdempotencyKey({ beauticianId, paymentIntentId, amountCents, requestId }) {
  const parts = ['florrie-refund', beauticianId, paymentIntentId, String(amountCents)];
  if (requestId) parts.push(String(requestId).slice(0, 64));
  return parts.join(':');
}

/**
 * POST /api/stripe/refund
 * Refunds a payment (full or partial).
 * The beautician can refund from their dashboard.
 * The beautician's portion comes back via reverse_transfer; Florrie's own cut
 * is returned separately and exactly, see refundableApplicationFeeCents.
 */
router.post('/refund', requireAuth, requireStripe, async (req, res) => {
  const { appointment_id, amount_cents, reason, refund_request_id } = req.body || {};

  if (!appointment_id) {
    return res.status(400).json({ error: 'appointment_id is required' });
  }

  // Shape check before anything talks to Stripe. amount_cents used to go
  // straight through with no floor and no ceiling, so a slipped digit in the
  // box could refund more than was ever taken.
  let requestedAmount = null;
  if (amount_cents !== undefined && amount_cents !== null && amount_cents !== '') {
    const asNumber = Number(amount_cents);
    if (!Number.isInteger(asNumber) || asNumber <= 0) {
      return res.status(400).json({ error: 'amount_cents must be a whole number of pence greater than zero' });
    }
    requestedAmount = asNumber;
  }

  try {
    // Get appointment
    const { data: appointment } = await supabase
      .from('appointments')
      .select('id, stripe_payment_intent_id, deposit_cents, price_cents, beautician_id')
      .eq('id', appointment_id)
      .eq('beautician_id', req.beautician.id)
      .single();

    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    if (!appointment.stripe_payment_intent_id) {
      return res.status(400).json({ error: 'No payment found for this appointment' });
    }

    // The ceiling has to be Stripe's number, not ours. deposit_cents can drift
    // from what was actually captured (promo codes, a partial capture, an
    // earlier partial refund), and it is what is left on the CHARGE that
    // bounds a refund.
    const intent = await stripe.paymentIntents.retrieve(
      appointment.stripe_payment_intent_id,
      { expand: ['latest_charge'] },
    );
    const charge = intent?.latest_charge && typeof intent.latest_charge === 'object'
      ? intent.latest_charge
      : null;

    const chargeAmountCents = Math.round(Number(
      charge?.amount ?? intent?.amount_received ?? intent?.amount ?? 0,
    ) || 0);
    const alreadyRefundedCents = Math.round(Number(charge?.amount_refunded ?? 0) || 0);
    const refundableCents = Math.max(0, chargeAmountCents - alreadyRefundedCents);

    if (chargeAmountCents <= 0) {
      // A PaymentIntent that never captured. There is nothing to send back.
      return res.status(400).json({ error: 'No completed payment found for this appointment' });
    }

    if (refundableCents <= 0) {
      return res.status(400).json({
        error: 'This payment has already been refunded in full.',
        charge_amount_cents: chargeAmountCents,
        already_refunded_cents: alreadyRefundedCents,
      });
    }

    if (requestedAmount !== null && requestedAmount > refundableCents) {
      return res.status(400).json({
        error: `You can refund at most £${(refundableCents / 100).toFixed(2)} on this payment.`,
        max_refundable_cents: refundableCents,
        already_refunded_cents: alreadyRefundedCents,
      });
    }

    const refundAmountCents = requestedAmount ?? refundableCents;

    // Build refund params. The amount is always explicit so the idempotency
    // key below means the same thing for "refund everything" and "refund the
    // exact remaining amount".
    const refundParams = {
      payment_intent: appointment.stripe_payment_intent_id,
      amount: refundAmountCents,
      reverse_transfer: true,        // pull the beautician's portion back
      refund_application_fee: false, // handled exactly, below
    };

    if (reason) {
      refundParams.reason = reason === 'duplicate' ? 'duplicate'
        : reason === 'fraudulent' ? 'fraudulent'
        : 'requested_by_customer';
      refundParams.metadata = { reason_text: reason };
    }

    const idempotencyKey = refundIdempotencyKey({
      beauticianId: req.beautician.id,
      paymentIntentId: appointment.stripe_payment_intent_id,
      amountCents: refundAmountCents,
      requestId: refund_request_id,
    });

    const refund = await stripe.refunds.create(refundParams, { idempotencyKey });

    // DID ANY MONEY ACTUALLY MOVE?
    //
    // The idempotency key above is doing exactly what it is there for, and it
    // cannot tell a double tap from a decision. Refund GBP 15 of a GBP 50
    // deposit, then deliberately refund another GBP 15 the same day: same
    // beautician, same intent, same amount, same key. Stripe hands back the
    // ORIGINAL refund object and creates nothing. The route used to answer
    // success:true with the first refund's id and a remaining_refundable that
    // was a further GBP 15 out, so Ellie was told a refund had gone through
    // that had not, and her client never got the money.
    //
    // The charge is the witness. If amount_refunded has not moved, nothing
    // left the account, whatever the refund object says. Only a positive
    // observation counts: if we cannot re-read the charge we say nothing and
    // report the refund as normal, because a failed verification must never
    // turn a genuine refund into an error.
    let replayed = false;
    try {
      const after = await stripe.paymentIntents.retrieve(
        appointment.stripe_payment_intent_id,
        { expand: ['latest_charge'] },
      );
      const afterCharge = after?.latest_charge && typeof after.latest_charge === 'object'
        ? after.latest_charge
        : null;
      const afterRefundedCents = Math.round(Number(afterCharge?.amount_refunded ?? NaN));
      if (Number.isFinite(afterRefundedCents) && refund.amount > 0) {
        replayed = afterRefundedCents <= alreadyRefundedCents;
      }
    } catch (verifyErr) {
      logger.warn({ err: verifyErr, refundId: refund.id },
        'Refund created but the charge could not be re-read to confirm it moved');
    }

    if (replayed) {
      // Nothing to record and nothing to reverse: this refund is already in
      // the books and already reflected in the charge. Say so plainly, and say
      // how to do it on purpose, because "refund another GBP 15" is a real
      // thing Ellie sometimes means.
      logger.warn({
        refundId: refund.id,
        paymentIntentId: appointment.stripe_payment_intent_id,
        amountCents: refundAmountCents,
      }, 'Refund request replayed an existing refund; no new money moved');
      return res.json({
        success: false,
        duplicate: true,
        refund_id: refund.id,
        amount_cents: refund.amount,
        status: refund.status,
        already_refunded_cents: alreadyRefundedCents,
        remaining_refundable_cents: Math.max(0, chargeAmountCents - alreadyRefundedCents),
        application_fee_refunded_cents: 0,
        recorded: true,
        error: `No new money has moved. This is the refund of £${(refund.amount / 100).toFixed(2)} that already went back to this client, not a second one.`,
        message: 'If you meant to send back the same amount again, repeat the request with a different refund_request_id and it will go through as a separate refund.',
      });
    }

    // Give back Florrie's own cut, and only that. See the arithmetic on
    // refundableApplicationFeeCents: refunding the whole application fee also
    // hands back the Stripe processing fee, which Stripe keeps on a UK refund.
    const applicationFeeId = typeof charge?.application_fee === 'string'
      ? charge.application_fee
      : charge?.application_fee?.id || null;
    const applicationFeeRefundCents = refundableApplicationFeeCents({
      chargeAmountCents,
      refundAmountCents: refund.amount,
      alreadyRefundedCents,
      applicationFeeCents: charge?.application_fee_amount,
    });

    if (applicationFeeId && applicationFeeRefundCents > 0) {
      try {
        await stripe.applicationFees.createRefund(
          applicationFeeId,
          { amount: applicationFeeRefundCents },
          { idempotencyKey: `${idempotencyKey}:appfee` },
        );
      } catch (feeErr) {
        // The client already has their money. A failed fee refund leaves
        // Florrie holding a few pence too many, which is a reconciliation
        // job, not a reason to tell the caller the refund failed.
        logger.error({ err: feeErr, applicationFeeId, applicationFeeRefundCents },
          'Refund went through but the application fee refund did not');
        Sentry.captureMessage('Application fee refund failed', {
          level: 'warning',
          tags: { area: 'payments', check: 'application_fee_refund' },
          extra: {
            applicationFeeId,
            applicationFeeRefundCents,
            refundId: refund.id,
            paymentIntentId: appointment.stripe_payment_intent_id,
          },
        });
      }
    }

    // Record refund transaction (negative amount). This insert was unchecked,
    // and it was the ONLY path in the codebase that ever wrote a refund, so a
    // rejected row meant the money went back to the client and the books still
    // showed it as income. Shared recorder so the charge.refunded webhook that
    // follows seconds later cannot write the same refund again.
    const refundedAmount = refund.amount;
    const recorded = await recordMoneyOut({
      paymentIntentId: appointment.stripe_payment_intent_id,
      chargeId: typeof refund.charge === 'string' ? refund.charge : refund.charge?.id || null,
      exactAmountCents: refundedAmount,
      fallbackBeauticianId: req.beautician.id,
      fallbackAppointmentId: appointment_id,
      description: reason ? `Refund, ${String(reason).slice(0, 80)}` : 'Refund',
      // Tag the row with the Stripe refund id. When Stripe replays a refund
      // under the idempotency key above, the SAME refund arrives here a second
      // time, and without the tag the books would grow a second negative row
      // for money that only left once.
      tag: `[refund:${refund.id}]`,
      source: 'app_refund_route',
    });

    // Update appointment deposit status if the CHARGE is now fully refunded.
    // Measured against the charge, not deposit_cents, for the same reason the
    // ceiling is: deposit_cents is not always what was taken.
    if (alreadyRefundedCents + refundedAmount >= chargeAmountCents) {
      const { error: apptErr } = await supabase.from('appointments').update({
        deposit_status: 'refunded',
        deposit_paid: false,
      }).eq('id', appointment_id);
      if (apptErr) {
        // A stale deposit_paid=true after a full refund makes chargeRemainingBalance
        // compute price minus a deposit that no longer exists, so the client gets
        // asked for less than they owe.
        logger.error({ err: apptErr, appointment_id }, 'Refund: appointment deposit status not cleared');
        Sentry.captureMessage('Refund: appointment deposit status not cleared', {
          level: 'error',
          tags: { area: 'payments', check: 'appointment_update' },
          extra: { appointment_id, dbError: apptErr.message, dbCode: apptErr.code },
        });
      }
    }

    res.json({
      success: true,
      refund_id: refund.id,
      amount_cents: refundedAmount,
      status: refund.status,
      // What is left on the charge after this one, so the dashboard can grey
      // the button out rather than letting her tap into a 400.
      remaining_refundable_cents: Math.max(0, chargeAmountCents - alreadyRefundedCents - refundedAmount),
      application_fee_refunded_cents: applicationFeeId ? applicationFeeRefundCents : 0,
      // Tell the caller the truth: the refund went through at Stripe either
      // way, but the books may not have it.
      recorded: recorded.recorded,
      ...(recorded.recorded ? {} : { record_issue: recorded.reason }),
    });
  } catch (err) {
    logger.error({ err }, 'Refund error');
    logger.error({ err }, 'Stripe operation failed');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// ═══════════════════════════════════════════════
// PAYMENT LINKS — Ad-hoc payment requests
// ═══════════════════════════════════════════════

/**
 * POST /api/stripe/save-card-link  { appointment_id }
 *
 * A link Ellie sends a client to put a card on file WITHOUT charging them.
 *
 * The card that makes no-show protection work is normally captured when a client
 * pays a deposit through the booking page. That leaves out every booking Ellie
 * adds herself and every client imported from her old system, which is most of
 * her diary. Stripe Checkout in `setup` mode collects and stores a card without
 * taking a penny, which is exactly the missing piece.
 */
router.post('/save-card-link', requireAuth, requireStripe, async (req, res) => {
  const { appointment_id } = req.body || {};
  if (!appointment_id) return res.status(400).json({ error: 'appointment_id is required' });

  if (!req.beautician.stripe_account_id || !req.beautician.stripe_onboarding_complete) {
    return res.status(400).json({ error: 'Finish your Stripe setup first.' });
  }

  try {
    const { data: appt } = await supabase
      .from('appointments')
      .select('id, client_id, clients(id, first_name, last_name, email, phone, stripe_customer_id)')
      .eq('id', appointment_id)
      .eq('beautician_id', req.beautician.id)
      .maybeSingle();
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });

    const client = appt.clients;
    if (!client) return res.status(400).json({ error: 'This booking has no client attached.' });

    // Reuse their Stripe customer, or make one so the card has somewhere to live.
    let customerId = client.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: `${client.first_name || ''} ${client.last_name || ''}`.trim() || undefined,
        email: client.email || undefined,
        phone: client.phone || undefined,
        metadata: { client_id: client.id, beautician_id: req.beautician.id },
      });
      customerId = customer.id;
      await supabase.from('clients').update({ stripe_customer_id: customerId }).eq('id', client.id);
    }

    const apiBase = `${req.headers['x-forwarded-proto'] || 'https'}://${req.get('host')}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'setup',
      customer: customerId,
      payment_method_types: ['card'],
      // Land back on our own endpoint so the card is pinned to the appointment
      // even though the Stripe webhook is not delivering yet.
      success_url: `${apiBase}/api/stripe/card-saved/{CHECKOUT_SESSION_ID}?apt=${appointment_id}`,
      cancel_url: `${FRONTEND_URL}/card/cancelled`,
      metadata: {
        appointment_id,
        client_id: client.id,
        beautician_id: req.beautician.id,
        type: 'save_card',
      },
    });

    res.json({ url: session.url, client_first_name: client.first_name || null });
  } catch (err) {
    logger.error({ err, appointment_id }, 'save-card-link failed');
    res.status(500).json({ error: 'Could not create the card link' });
  }
});

/**
 * GET /api/stripe/card-saved/:sessionId?apt=...
 * Where the client lands after saving a card. Pins the payment method to the
 * appointment (and their client record) so a later charge is direct.
 * Public: the session id is the proof, exactly like the booking confirm redirect.
 */
router.get('/card-saved/:sessionId', async (req, res) => {
  const done = `${FRONTEND_URL}/card/saved`;
  try {
    if (stripe && req.params.sessionId) {
      const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
      const appointmentId = req.query.apt || session?.metadata?.appointment_id;
      const setupIntentId = session?.setup_intent;
      if (setupIntentId) {
        const si = await stripe.setupIntents.retrieve(
          typeof setupIntentId === 'string' ? setupIntentId : setupIntentId.id
        );
        const pmId = typeof si.payment_method === 'string' ? si.payment_method : si.payment_method?.id;
        if (pmId && appointmentId) {
          await supabase.from('appointments')
            .update({ stripe_payment_method_id: pmId })
            .eq('id', appointmentId);
          logger.info({ appointmentId, pmId }, 'Card saved on file via setup link');
        }
        if (session.customer && session.metadata?.client_id) {
          await supabase.from('clients')
            .update({ stripe_customer_id: session.customer })
            .eq('id', session.metadata.client_id);
        }
      }
    }
  } catch (err) {
    logger.error({ err, sessionId: req.params.sessionId }, 'card-saved redirect failed');
  }
  return res.redirect(302, done);
});

/**
 * POST /api/stripe/payment-link
 * Creates a one-time payment link the beautician can send to a client.
 * Use cases: manual deposit collection, outstanding balance, no-show fee when no card on file.
 */
router.post('/payment-link', requireAuth, requireStripe, async (req, res) => {
  const { amount_cents, description, client_id, appointment_id } = req.body;

  if (!amount_cents || amount_cents < 50) {
    return res.status(400).json({ error: 'Amount must be at least 50p' });
  }

  if (!req.beautician.stripe_account_id || !req.beautician.stripe_onboarding_complete) {
    return res.status(400).json({ error: 'Complete Stripe setup first' });
  }

  // Both ids end up in Stripe metadata AND in the payment_links row, so an
  // unverified one attaches a real payment to another salon's booking and the
  // webhook then reconciles it against their books. The client_id lookup below
  // was already scoped, but it silently carried on when it found nothing, so
  // the foreign id was stored anyway. The service key bypasses RLS, so this is
  // the only check. Both are optional; requireOwned skips a missing id.
  if (!await requireOwned(req, res, [
    { table: 'clients', id: client_id },
    { table: 'appointments', id: appointment_id },
  ])) return;

  try {
    // Destination charge: the platform pays Stripe's processing fee, so the
    // application fee must recover it on top of Florrie's cut or this payment
    // loses the platform money (the arrears leak).
    const platformFee = totalApplicationFee(amount_cents);
    const beauticianName = req.beautician.business_name || req.beautician.first_name;

    // Build customer reference if client_id provided
    let stripeCustomerId;
    if (client_id) {
      const { data: client } = await supabase
        .from('clients')
        .select('stripe_customer_id, first_name, email, phone')
        .eq('id', client_id)
        .eq('beautician_id', req.beautician.id)
        .single();

      if (client?.stripe_customer_id) {
        stripeCustomerId = client.stripe_customer_id;
      }
    }

    const sessionParams = {
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: {
            name: description || `Payment to ${beauticianName}`,
          },
          unit_amount: amount_cents,
        },
        quantity: 1,
      }],
      payment_intent_data: {
        application_fee_amount: platformFee,
        transfer_data: {
          destination: req.beautician.stripe_account_id,
        },
        setup_future_usage: 'off_session',
        metadata: {
          beautician_id: req.beautician.id,
          client_id: client_id || null,
          appointment_id: appointment_id || null,
          type: 'payment_link',
          platform_fee_cents: platformFee,
        },
      },
      success_url: `${FRONTEND_URL}/pay/success`,
      cancel_url: `${FRONTEND_URL}/pay/cancelled`,
      metadata: {
        beautician_id: req.beautician.id,
        client_id: client_id || null,
        appointment_id: appointment_id || null,
        type: 'payment_link',
      },
    };

    if (stripeCustomerId) {
      sessionParams.customer = stripeCustomerId;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    // Store payment link record for tracking
    await supabase.from('payment_links').insert({
      beautician_id: req.beautician.id,
      client_id: client_id || null,
      appointment_id: appointment_id || null,
      amount_cents,
      description: description || null,
      stripe_session_id: session.id,
      checkout_url: session.url,
      status: 'pending',
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24h expiry
    });

    res.json({
      url: session.url,
      session_id: session.id,
      amount_cents,
      platform_fee_cents: platformFee,
      expires_in: '24 hours',
    });
  } catch (err) {
    logger.error({ err }, 'Payment link error');
    logger.error({ err }, 'Stripe operation failed');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// ═══════════════════════════════════════════════
// MAINTENANCE — Stripe event cleanup
// ═══════════════════════════════════════════════

/**
 * POST /api/stripe/cleanup-events
 * Deletes stripe_events older than 90 days.
 * Protected by x-cron-key header (same as process-reminders). requireCronKey
 * refuses outright when CRON_SECRET is unset; the inline compare it replaced
 * read `undefined !== undefined`, which let anybody through.
 * Can be called by: cron job, admin endpoint, Supabase Edge Function.
 */
router.post('/cleanup-events', requireCronKey, async (req, res) => {
  try {
    const result = await cleanupStripeEvents();
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error({ err }, 'Stripe cleanup error');
    logger.error({ err }, 'Stripe operation failed');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// ═══════════════════════════════════════════════
// WEBHOOKS — Stripe event processing
// ═══════════════════════════════════════════════

/**
 * POST /api/stripe/webhook
 * Handles Stripe webhook events. Must use raw body for signature verification.
 */
router.post('/webhook', async (req, res) => {
  if (!stripe) {
    return res.status(200).json({ received: true, note: 'Stripe not configured, ignoring webhook' });
  }

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  // Every configured secret gets a go. There are TWO endpoints on this url,
  // one scoped to the platform account and one to connected accounts, and
  // Stripe signs each with its own secret. Reading a single value meant one
  // endpoint's events were rejected 100% of the time. See
  // lib/stripe-webhook-secret.js.
  const { event, secretsTried, reason } = verifyWebhook({
    stripe,
    payload: req.rawBody || req.body,   // the RAW bytes, set in index.js
    signature: sig,
    rawSecret: webhookSecret,
  });

  if (!event) {
    // This exact line was logged on every Stripe event for MONTHS and nobody
    // knew: stripe_events had zero rows in production, ever. The log was
    // there. The log was not enough. Sentry so a human hears about it.
    logger.error({ reason, secretsTried }, 'Webhook signature verification failed');
    Sentry.captureMessage('Stripe webhook signature verification failed', {
      level: 'error',
      tags: { area: 'payments', check: 'stripe_webhook' },
      extra: {
        reason: reason || 'unknown',
        secrets_configured: secretsTried,
        signature_header_present: Boolean(sig),
      },
    });
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // Both registered webhook URLs dispatch billing through one handler.
  if (isBillingEvent(event)) return handleBillingEvent(event, res);

  const paymentSession = event.data?.object;
  const bookingPayment = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)
    && paymentSession?.mode === 'payment' && paymentSession.payment_status === 'paid'
    && !!paymentSession.metadata?.appointment_id;
  let paymentClaim;
  if (bookingPayment) {
    try {
      paymentClaim = await claimPaymentEvent(event);
      if (paymentClaim.duplicate) {
        await announceBookingConfirmed(paymentSession.metadata.appointment_id, { source: 'stripe_webhook_retry', claim: false });
        return res.json({ received: true, status: 'already_processed' });
      }
    } catch (err) {
      logger.error({ err, eventId: event.id }, 'Booking payment event claim unavailable');
      return res.status(503).json({ received: true, processed: false });
    }
  } else {
    const { error } = await supabase.from('stripe_events')
      .insert({ id: event.id, type: event.type, processed_at: new Date().toISOString() });
    if (error?.code === '23505') return res.json({ received: true, status: 'already_processed' });
    if (error) return res.status(503).json({ received: true, processed: false });
  }

  async function confirmWithDurableIntent(appointmentId, source) {
    const alert = await announceBookingConfirmed(appointmentId, { source });
    if (['claim_unreadable', 'appointment_unreadable', 'ledger_unreadable', 'delivery_claim_lost', 'threw', 'no_beautician'].includes(alert.reason)) {
      throw new Error(`Booking confirmation intent unavailable: ${alert.reason}`);
    }
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object;
        if (session.mode !== 'payment' || session.payment_status !== 'paid') break;

        const isPaymentLink = session.metadata?.type === 'payment_link';
        const appointmentId = session.metadata?.appointment_id;
        const beauticianId = session.metadata?.beautician_id;
        const clientId = session.metadata?.client_id;

        // Capture the saved payment method for later off-session policy fees
        // (deposit Checkout uses setup_future_usage 'off_session', so the card
        // is attached to the customer; we pin the exact method on the appointment).
        async function savePaymentMethodOnAppointment() {
          if (!appointmentId || !session.payment_intent) return;
          try {
            const pi = await stripe.paymentIntents.retrieve(session.payment_intent);
            const pmId = typeof pi.payment_method === 'string' ? pi.payment_method : pi.payment_method?.id;
            if (pmId) {
              await supabase.from('appointments')
                .update({ stripe_payment_method_id: pmId })
                .eq('id', appointmentId);
            }
          } catch (err) {
            logger.warn({ err, appointmentId }, 'Could not store payment method for policy fees (non-fatal)');
          }
        }

        // Payment link completion (may or may not have appointment)
        if (isPaymentLink) {
          // Update payment_links table
          const linkWrite = await supabase.from('payment_links')
            .update({ status: 'paid', paid_at: new Date().toISOString() })
            .eq('stripe_session_id', session.id);
          if (linkWrite.error) throw new Error('Could not record paid payment link');

          // A failed confirmation intent can replay this event after money was recorded.
          const priorLink = await supabase.from('transactions').select('id')
            .eq('stripe_payment_intent_id', session.payment_intent).eq('type', 'payment_link').limit(1);
          if (priorLink.error) throw new Error('Could not read payment link ledger');
          if (!priorLink.data?.length) {
          const linkTransaction = await supabase.from('transactions').insert({
            beautician_id: beauticianId,
            appointment_id: appointmentId || null,
            client_id: clientId || null,
            amount_cents: session.amount_total,
            type: 'payment_link',
            status: 'completed',
            stripe_payment_intent_id: session.payment_intent,
            payment_method: 'card_online',
          });
          if (linkTransaction.error) throw new Error('Could not record payment link transaction');
          }

          // Save payment truth before confirming. The delivery ledger prevents
          // duplicate pushes and retains unsuccessful attempts for retry.
          if (appointmentId) {
            const paidWrite = await supabase.from('appointments')
              .update({ deposit_status: 'paid', deposit_paid: true })
              .eq('id', appointmentId).select('id');
            if (paidWrite.error || !paidWrite.data?.length) throw new Error('Could not record paid booking');
            await confirmWithDurableIntent(appointmentId, 'stripe_payment_link');
          }

          // Save customer for future use
          if (session.customer && clientId) {
            await supabase.from('clients')
              .update({ stripe_customer_id: session.customer })
              .eq('id', clientId);
          }

          await savePaymentMethodOnAppointment();
          break;
        }

        // Standard booking payment (deposit or full)
        if (appointmentId) {
          // Determine if this was a full payment or deposit from metadata
          const paymentType = session.metadata?.payment_type || 'deposit';

          // Payment state and delivery are separate. Save the accepted deposit,
          // then require a durable alert intent before acknowledging this event.
          // Database failures return 503 and leave the event safe to retry.
          const paidWrite = await supabase
            .from('appointments')
            .update({ deposit_status: 'paid', deposit_paid: true })
            .eq('id', appointmentId).select('id');
          if (paidWrite.error || !paidWrite.data?.length) throw new Error('Could not record paid booking');
          await confirmWithDurableIntent(appointmentId, 'stripe_webhook');

          // Log the transaction, ONCE. The confirmation redirect
          // (GET /api/booking/confirm/:sessionId) logs the same deposit and has
          // always guarded against a repeat; this one never did, so whichever
          // arrived second wrote a duplicate. That was invisible while the
          // webhook was dead, and the moment it started working again it
          // became one deposit showing as two in her takings. Same guard, same
          // canonical type list, and refusing when the guard cannot be read
          // rather than logging money twice.
          const { data: alreadyLogged, error: loggedErr } = await supabase
            .from('transactions')
            .select('id')
            .eq('appointment_id', appointmentId)
            .in('type', BOOKING_MONEY_LOGGED_TYPES)
            .limit(1);

          if (loggedErr) {
            logger.error({ err: loggedErr, appointmentId }, 'webhook: deposit guard unreadable, not logging');
            Sentry.captureMessage('Deposit not logged: guard unreadable', {
              level: 'warning',
              tags: { area: 'payments', check: 'deposit_guard' },
              extra: { appointmentId, amountPence: session.amount_total ?? null, dbCode: loggedErr.code },
            });
            throw new Error('Could not read booking payment ledger');
          } else if (!alreadyLogged?.length) {
            const { error: txErr } = await supabase.from('transactions').insert({
              beautician_id: beauticianId,
              appointment_id: appointmentId,
              client_id: clientId || null,
              amount_cents: session.amount_total,
              type: paymentType === 'full' ? 'full_payment' : 'deposit',
              status: 'completed',
              stripe_payment_intent_id: session.payment_intent,
              payment_method: 'card_online',
            });
            if (txErr) {
              // Money that reached Stripe and never reached her books.
              logger.error({ err: txErr, appointmentId }, 'PAID BUT NOT RECORDED: webhook deposit insert failed');
              Sentry.captureMessage('PAID BUT NOT RECORDED: webhook deposit', {
                level: 'error',
                tags: { area: 'payments', check: 'transaction_insert' },
                extra: { appointmentId, beauticianId, amountPence: session.amount_total ?? null, dbCode: txErr.code },
              });
              throw new Error('Could not record booking payment');
            }
          }

          // If client paid, store their Stripe customer for faster future payments
          if (session.customer && clientId) {
            await supabase
              .from('clients')
              .update({ stripe_customer_id: session.customer })
              .eq('id', clientId);
          }

          await savePaymentMethodOnAppointment();

          // Send booking confirmation now that payment is confirmed
          notifyBookingConfirmed(appointmentId).catch(err =>
            logger.warn({ err }, 'Post-payment confirmation notification failed (non-fatal)')
          );


        }

        // Course enrollment deposit payment
        const enrollmentId = session.metadata?.enrollment_id;
        const isCourseDeposit = session.metadata?.type === 'course_deposit';
        if (isCourseDeposit && enrollmentId) {
          const courseBeauticianId = session.metadata?.beautician_id;
          const courseId = session.metadata?.course_id;

          // Read the current status first so this stays idempotent. Stripe can
          // deliver the same event more than once; we only count the spot and
          // log the transaction on the first transition into deposit_paid.
          const { data: priorEnrollment } = await supabase
            .from('course_enrollments')
            .select('payment_status')
            .eq('id', enrollmentId)
            .single();
          const alreadyPaid = priorEnrollment?.payment_status === 'deposit_paid'
            || priorEnrollment?.payment_status === 'paid';

          // Mark enrollment as deposit_paid
          await supabase.from('course_enrollments')
            .update({
              payment_status: 'deposit_paid',
              amount_paid_cents: session.amount_total,
              stripe_payment_intent_id: session.payment_intent,
            })
            .eq('id', enrollmentId);

          // First confirmation: count the spot on the course. The enroll route
          // deliberately defers this for the Stripe path so abandoned checkouts
          // never eat a place.
          if (!alreadyPaid && courseId) {
            const { data: courseRow } = await supabase
              .from('courses')
              .select('enrolled')
              .eq('id', courseId)
              .single();
            await supabase.from('courses')
              .update({ enrolled: (courseRow?.enrolled || 0) + 1 })
              .eq('id', courseId);
          }

          // Log the transaction (only once)
          if (courseBeauticianId && !alreadyPaid) {
            await supabase.from('transactions').insert({
              beautician_id: courseBeauticianId,
              amount_cents: session.amount_total,
              type: 'deposit',
              status: 'completed',
              stripe_payment_intent_id: session.payment_intent,
              payment_method: 'card_online',
            });
          }

          // Tell the trainer and the student, once: the place is really held
          // now. Never throws (services/course-notifications.js).
          if (!alreadyPaid) {
            const { announceEnrolmentById } = await import('../services/course-notifications.js');
            await announceEnrolmentById(enrollmentId, 'deposit');
          }

          logger.info({ enrollmentId, courseId, amount: session.amount_total }, 'Course deposit paid via Stripe');
        }
        break;
      }

      case 'charge.refunded': {
        // This case used to log a line and write NOTHING. A refund issued from
        // the Stripe dashboard (or by Stripe itself) never reached the books at
        // all, so Ellie's income included money that had already gone back.
        //
        // charge.amount_refunded is a RUNNING TOTAL for the charge, so the
        // recorder writes the difference against what is already on file. That
        // is what makes this safe to run alongside POST /api/stripe/refund,
        // which fires for the same money moments earlier.
        const charge = event.data.object;
        const piId = typeof charge.payment_intent === 'string'
          ? charge.payment_intent
          : charge.payment_intent?.id || null;

        if (!piId) {
          logger.warn({ chargeId: charge.id }, 'charge.refunded with no payment_intent, cannot key the ledger row');
          break;
        }

        await recordMoneyOut({
          paymentIntentId: piId,
          chargeId: charge.id,
          totalRefundedCents: charge.amount_refunded,
          fallbackBeauticianId: charge.metadata?.beautician_id || null,
          fallbackAppointmentId: charge.metadata?.appointment_id || null,
          description: 'Refund',
          source: 'webhook_charge_refunded',
        });
        break;
      }

      case 'charge.dispute.created': {
        // A chargeback takes the money back out of the account, plus Stripe's
        // dispute fee. Nothing in this codebase handled disputes, so the books
        // kept counting the payment as income permanently. Recorded as a
        // negative 'refund' row tagged with the dispute id: the CHECK
        // constraint has no 'dispute' member, and inventing a type is what
        // silently rejected every product_sale row before migration 076.
        const dispute = event.data.object;
        const piId = typeof dispute.payment_intent === 'string'
          ? dispute.payment_intent
          : dispute.payment_intent?.id || null;

        if (!piId) {
          logger.warn({ disputeId: dispute.id }, 'dispute with no payment_intent, cannot key the ledger row');
          break;
        }

        const outcome = await recordMoneyOut({
          paymentIntentId: piId,
          chargeId: typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id || null,
          exactAmountCents: dispute.amount,
          tag: disputeTag(dispute.id),
          description: 'Disputed by the client, money held by the bank',
          source: 'webhook_dispute_created',
        });

        // Ellie has a deadline to submit evidence and losing is the default, so
        // this is not just bookkeeping.
        Sentry.captureMessage('Card payment disputed by a client', {
          level: 'warning',
          tags: { area: 'payments', check: 'dispute' },
          extra: {
            disputeId: dispute.id,
            paymentIntentId: piId,
            amountPence: dispute.amount,
            reason: dispute.reason || null,
            evidenceDueBy: dispute.evidence_details?.due_by || null,
            recorded: outcome.recorded,
          },
        });
        break;
      }

      case 'charge.dispute.closed': {
        const dispute = event.data.object;
        const piId = typeof dispute.payment_intent === 'string'
          ? dispute.payment_intent
          : dispute.payment_intent?.id || null;

        // Lost: the money is gone and the negative row written when the dispute
        // opened is already correct. Won: the bank returns it, so that negative
        // row has to be undone or the books stay short for ever.
        if (piId && dispute.status === 'won') {
          await recordMoneyOut({
            paymentIntentId: piId,
            chargeId: typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id || null,
            exactAmountCents: dispute.amount,
            tag: disputeWonTag(dispute.id),
            reversal: true,
            description: 'Dispute won, money returned',
            source: 'webhook_dispute_won',
          });
        }

        logger.info({ disputeId: dispute.id, status: dispute.status }, 'Dispute closed');
        break;
      }

      case 'payment_intent.payment_failed': {
        const pi = event.data.object;
        const feeType = pi.metadata?.type;
        const apptId = pi.metadata?.appointment_id || null;
        const isPolicyFee = feeType === 'no_show_fee' || feeType === 'late_cancel_fee';

        // EVERY off-session charge in policy-fees.js treats a 'processing'
        // PaymentIntent as success and writes a status:'completed' transaction
        // before Stripe has confirmed anything. This case only ever handled the
        // two policy-fee kinds, so a remaining balance or a reschedule deposit
        // that later failed left a completed row in the books for money that
        // never arrived.
        //
        // Scoped to those optimistic charges on purpose. A Checkout deposit
        // writes its row only AFTER payment succeeds, and a client whose first
        // card is declined and second card works produces a payment_failed and
        // a success on the SAME PaymentIntent, so a blanket update here would
        // mark a good payment failed if Stripe retried the failure event.
        if (OPTIMISTIC_CHARGE_TYPES.has(feeType)) {
          const { error: txErr } = await supabase.from('transactions')
            .update({ status: 'failed' })
            .eq('stripe_payment_intent_id', pi.id);
          if (txErr) {
            logger.error({ err: txErr, paymentIntentId: pi.id }, 'Failed charge: could not mark the transaction failed');
            Sentry.captureMessage('Failed charge still counted as income', {
              level: 'error',
              tags: { area: 'payments', check: 'failed_charge_rollback' },
              extra: { paymentIntentId: pi.id, feeType: feeType || null, appointmentId: apptId, dbError: txErr.message },
            });
          }
        }

        if (isPolicyFee && apptId) {
          // policy_fee_charged_at is the REAL idempotency anchor
          // (services/policy-fees.js refuses outright when it is non-null).
          // Clearing only no_show_fee_charged / late_cancel_charged left the
          // appointment permanently stuck at 'already_charged', so a fee that
          // failed could never be collected, by any path, ever again.
          //
          // Guarded on the PaymentIntent id: if a LATER charge succeeded and
          // re-stamped the anchor, this stale failure event must not wipe it,
          // which would be the double-charge this anchor exists to prevent.
          const { data: appt, error: readErr } = await supabase
            .from('appointments')
            .select('id, policy_fee_payment_intent_id')
            .eq('id', apptId)
            .maybeSingle();

          if (readErr) {
            logger.error({ err: readErr, appointment_id: apptId }, 'Failed policy fee: appointment unreadable, not rolling back');
            Sentry.captureMessage('Failed policy fee left locked: appointment unreadable', {
              level: 'error',
              tags: { area: 'payments', check: 'failed_charge_rollback' },
              extra: { appointmentId: apptId, paymentIntentId: pi.id, dbError: readErr.message },
            });
          } else if (appt && (!appt.policy_fee_payment_intent_id || appt.policy_fee_payment_intent_id === pi.id)) {
            const { error: apptErr } = await supabase.from('appointments')
              .update({
                policy_fee_charged_at: null,
                policy_fee_amount_cents: null,
                policy_fee_payment_intent_id: null,
                ...(feeType === 'no_show_fee'
                  ? { no_show_fee_charged: false, no_show_fee_cents: null, no_show_fee_payment_intent: null }
                  : { late_cancel_charged: false }),
              })
              .eq('id', apptId);
            if (apptErr) {
              logger.error({ err: apptErr, appointment_id: apptId, feeType }, 'Failed policy fee: rollback failed');
              Sentry.captureMessage('Failed policy fee left locked as already_charged', {
                level: 'error',
                tags: { area: 'payments', check: 'failed_charge_rollback' },
                extra: { appointmentId: apptId, paymentIntentId: pi.id, feeType, dbError: apptErr.message },
              });
            }
          }

          logger.warn({ appointment_id: apptId, feeType }, 'Policy fee charge failed');
        } else if (feeType === 'reschedule_deposit' && apptId) {
          // chargeRescheduleDeposit sets deposit_paid / deposit_status='paid'
          // the moment Stripe says 'processing'. We deliberately do NOT clear
          // those here: the same fields also carry the ORIGINAL deposit this
          // client may well have paid weeks ago, and clearing them would tell
          // Ellie to collect money she already has. A human decides.
          logger.warn({ appointment_id: apptId }, 'Reschedule deposit charge failed after being recorded as paid');
          Sentry.captureMessage('Reschedule deposit failed after the appointment was marked paid', {
            level: 'error',
            tags: { area: 'payments', check: 'failed_charge_rollback' },
            extra: { appointmentId: apptId, paymentIntentId: pi.id, amountPence: pi.amount || null },
          });
        } else if (feeType) {
          logger.warn({ appointment_id: apptId, feeType, paymentIntentId: pi.id }, 'Off-session charge failed');
        }
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const beauticianId = sub.metadata?.beautician_id;

        // This read used to be `sub.metadata?.plan_id`, a key nothing has ever
        // written, so it was undefined on every event and the write below fell
        // back to 'florrie'. Renewal, card update, trial ending: any of them
        // silently demoted a Team salon out of /team, /rota, /locations and
        // /staff-performance. The key now comes from the same constant the
        // checkout writes, and an unreadable plan is a shout, not a downgrade.
        const { plan, problem, found } = readPlanFromMetadata(sub.metadata);

        // A card form that was opened and never finished. Not a subscriber,
        // not a plan, not even a stripe id worth remembering. See
        // lib/subscription-status.js isCardlessDraft.
        if (beauticianId && isCardlessDraft(sub)) {
          logger.info({ beauticianId, subscriptionId: sub.id, eventType: event.type }, 'Cardless draft subscription, leaving the account untouched');
          break;
        }

        if (beauticianId) {
          const updates = {
            subscription_stripe_id: sub.id,
            // Through the translation table, never Stripe's own word. Writing
            // 'unpaid' or 'canceled' straight into a column whose CHECK only
            // knows 'cancelled' failed silently for months and left dead
            // subscriptions reading 'active'. See lib/subscription-status.js.
            subscription_status: internalStatusFor(sub.status),
            subscription_current_period_end: sub.current_period_end
              ? new Date(sub.current_period_end * 1000).toISOString()
              : null,
          };

          if (plan) {
            updates.subscription_plan = plan;
          } else {
            // Leave subscription_plan exactly as it is. Whatever she is on now
            // was written by a path that knew the answer; this event does not.
            logger.error(
              { beauticianId, subscriptionId: sub.id, problem, found, eventType: event.type },
              'Subscription plan unreadable from metadata, leaving the stored plan alone'
            );
            Sentry.captureMessage('Subscription webhook could not read the plan', {
              level: 'error',
              tags: { area: 'billing', check: 'subscription_plan_metadata' },
              extra: {
                beauticianId,
                subscriptionId: sub.id,
                eventType: event.type,
                problem,
                found: found || null,
                expectedKey: PLAN_METADATA_KEY,
              },
            });
          }

          const { error: subErr } = await supabase
            .from('beauticians')
            .update(updates)
            .eq('id', beauticianId);
          if (subErr) {
            // This error went unread for the whole life of the webhook. The
            // write that fails here is the one that decides whether a salon
            // pays, so it is an error and a Sentry event, not a log line.
            logger.error({ err: subErr, beauticianId, subscriptionId: sub.id, updates, eventType: event.type }, 'Subscription status update failed');
            Sentry.captureException(subErr, {
              tags: { area: 'billing', check: 'subscription_status_write' },
              extra: { beauticianId, subscriptionId: sub.id, stripeStatus: sub.status, updates, eventType: event.type },
            });
          }
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const beauticianId = sub.metadata?.beautician_id;
        if (beauticianId) {
          // Only the subscription on file can end the account's plan. A draft
          // that Stripe cancels at trial end, or an old subscription replaced
          // by a newer one, must not cancel a salon that is paying.
          const { data: current } = await supabase
            .from('beauticians')
            .select('subscription_stripe_id')
            .eq('id', beauticianId)
            .maybeSingle();
          if (current?.subscription_stripe_id && current.subscription_stripe_id !== sub.id) {
            logger.info({ beauticianId, subscriptionId: sub.id, onFile: current.subscription_stripe_id }, 'Deleted subscription is not the one on file, ignoring');
            break;
          }
          // subscription_plan is deliberately left alone: the app tells an
          // ex-subscriber their plan ended and a trialist their trial ended,
          // and resetting the plan to 'trial' here made both read the same.
          const { error: delErr } = await supabase
            .from('beauticians')
            .update({
              subscription_status: internalStatusFor('canceled'),
              subscription_stripe_id: null,
            })
            .eq('id', beauticianId);
          if (delErr) {
            logger.error({ err: delErr, beauticianId, subscriptionId: sub.id }, 'Subscription cancellation could not be written');
            Sentry.captureException(delErr, {
              tags: { area: 'billing', check: 'subscription_status_write' },
              extra: { beauticianId, subscriptionId: sub.id, eventType: event.type },
            });
          }
        }
        break;
      }

      // The salon's own Florrie subscription invoice. One shared handler in
      // services/dunning.js, also called from /api/billing/webhook, so it does
      // not matter which of the two mounted webhook URLs Stripe is pointed at.
      case 'invoice.payment_failed':
      case 'invoice.paid':
      case 'invoice.payment_succeeded': {
        await handleDunningEvent(event);
        break;
      }

      case 'account.updated': {
        const account = event.data.object;
        if (account.metadata?.beautician_id) {
          const complete = account.charges_enabled && account.payouts_enabled;
          await supabase
            .from('beauticians')
            .update({ stripe_onboarding_complete: complete })
            .eq('id', account.metadata.beautician_id);
        }
        break;
      }

      // Fired when stripe_balance.stripe_transfers capability status changes
      // (e.g. pending → active after KYC, or active → restricted after a review).
      // The thin event carries the account ID in related_object and the capability
      // details in data.capability — no need to re-fetch the full account.
      case 'v2.core.account[configuration.recipient].capability_status_updated': {
        const accountId = event.related_object?.id;
        const capability = event.data?.capability;
        const capabilityName = capability?.name;   // e.g. 'stripe_balance.stripe_transfers'
        const capabilityStatus = capability?.status; // 'active' | 'pending' | 'restricted'

        if (!accountId) break;

        // Only flip onboarding_complete on the transfers capability
        // (other capabilities may fire too — ignore them here)
        if (capabilityName === 'stripe_balance.stripe_transfers') {
          const complete = capabilityStatus === 'active';

          await supabase
            .from('beauticians')
            .update({ stripe_onboarding_complete: complete })
            .eq('stripe_account_id', accountId);

          logger.info({ accountId, capabilityStatus }, 'v2 Connect recipient capability updated');
        }
        break;
      }

      default:
        // Unhandled event type — log but don't error
        break;
    }

    if (paymentClaim) {
      await completePaymentEvent(event, paymentClaim);
    } else {
      await supabase.from('stripe_events').update({
        beautician_id: event.data.object.metadata?.beautician_id || null,
        data: event.data.object,
      }).eq('id', event.id);
    }
    res.json({ received: true });
  } catch (err) {
    logger.error({ err, eventId: event.id, type: event.type }, 'Webhook processing failed');
    if (paymentClaim) {
      await releasePaymentEvent(event, paymentClaim).catch(releaseError =>
        logger.error({ err: releaseError, eventId: event.id }, 'Payment claim release failed; lease will expire'));
      return res.status(503).json({ received: true, processed: false });
    }
    res.json({ received: true, processed: false });
  }
});

export default router;
