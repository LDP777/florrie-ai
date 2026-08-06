import { Router } from 'express';
import Stripe from 'stripe';
import * as Sentry from '@sentry/node';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOwned } from '../lib/ownership.js';
import { notifyBookingConfirmed } from '../services/notifications.js';
import { pushBookingConfirmed } from '../services/push-notifications.js';
import { cleanupStripeEvents } from '../services/stripe-cleanup.js';
import { totalApplicationFee, getFeeDescription } from '../lib/platform-fees.js';
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

  // Get the beautician's Stripe account
  const { data: beautician } = await supabase
    .from('beauticians')
    .select('stripe_account_id, stripe_onboarding_complete, business_name')
    .eq('id', beautician_id)
    .single();

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
      await supabase
        .from('beauticians')
        .update({ stripe_customer_id: customerId })
        .eq('id', req.beautician.id);
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
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
 * POST /api/stripe/refund
 * Refunds a payment (full or partial).
 * The beautician can refund from their dashboard.
 * Florrie's platform fee is also refunded proportionally (reverse_transfer).
 */
router.post('/refund', requireAuth, requireStripe, async (req, res) => {
  const { appointment_id, amount_cents, reason } = req.body;

  if (!appointment_id) {
    return res.status(400).json({ error: 'appointment_id is required' });
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

    // Build refund params
    const refundParams = {
      payment_intent: appointment.stripe_payment_intent_id,
      reverse_transfer: true,       // refund the beautician's portion
      refund_application_fee: true,  // refund Florrie's platform fee too
    };

    // Partial refund if amount specified
    if (amount_cents && amount_cents > 0) {
      refundParams.amount = amount_cents;
    }

    if (reason) {
      refundParams.reason = reason === 'duplicate' ? 'duplicate'
        : reason === 'fraudulent' ? 'fraudulent'
        : 'requested_by_customer';
      refundParams.metadata = { reason_text: reason };
    }

    const refund = await stripe.refunds.create(refundParams);

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
      source: 'app_refund_route',
    });

    // Update appointment deposit status if fully refunded
    if (!amount_cents || amount_cents >= (appointment.deposit_cents || appointment.price_cents)) {
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
 * Protected by x-cron-key header (same as process-reminders).
 * Can be called by: cron job, admin endpoint, Supabase Edge Function.
 */
router.post('/cleanup-events', async (req, res) => {
  const cronKey = req.headers['x-cron-key'];
  if (cronKey !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Invalid cron key' });
  }

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

  // Idempotency — use the unique event id to detect duplicates.
  try {
    const { error: insertError } = await supabase
      .from('stripe_events')
      .insert({ id: event.id, type: event.type, processed_at: new Date().toISOString() });

    if (insertError && insertError.code === '23505') {
      // Duplicate event ID — already processed
      return res.json({ received: true, status: 'already_processed' });
    }
    if (insertError) {
      // A hiccup on the dedupe/logging table must NOT fail the webhook: returning
      // non-2xx here makes Stripe retry forever and flag the endpoint as broken
      // (which is exactly the "trouble sending requests" email). The signature is
      // already verified, so process the event best-effort and let any genuine
      // duplicate be caught by the per-record guards downstream.
      logger.error({ err: insertError, eventId: event.id }, 'Could not record stripe event, processing anyway');
    }
  } catch (err) {
    logger.error({ err, eventId: event.id }, 'stripe_events insert threw, processing anyway');
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode !== 'payment') break;

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
          await supabase.from('payment_links')
            .update({ status: 'paid', paid_at: new Date().toISOString() })
            .eq('stripe_session_id', session.id);

          // Record transaction
          await supabase.from('transactions').insert({
            beautician_id: beauticianId,
            appointment_id: appointmentId || null,
            client_id: clientId || null,
            amount_cents: session.amount_total,
            type: 'payment_link',
            status: 'completed',
            stripe_payment_intent_id: session.payment_intent,
            payment_method: 'card_online',
          });

          // If linked to an appointment, update its status
          if (appointmentId) {
            await supabase.from('appointments')
              .update({ deposit_status: 'paid', deposit_paid: true, status: 'confirmed' })
              .eq('id', appointmentId);
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

          // Mark deposit as paid AND confirm the appointment (was 'pending' waiting for payment)
          await supabase
            .from('appointments')
            .update({ deposit_status: 'paid', deposit_paid: true, status: 'confirmed' })
            .eq('id', appointmentId);

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

          // Tell the beautician the money landed. The push at booking time
          // said "deposit not paid yet"; this is the confirming second beat.
          (async () => {
            try {
              const { data: appt } = await supabase
                .from('appointments')
                .select('id, starts_at, clients(first_name), treatments(name)')
                .eq('id', appointmentId)
                .maybeSingle();
              if (!appt) return;
              // Wall-time convention: read the display time off the string.
              const day = String(appt.starts_at || '').slice(0, 10);
              const time = String(appt.starts_at || '').slice(11, 16);
              const dateLabel = day
                ? `${new Date(`${day}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} at ${time}`
                : 'their appointment';
              await pushBookingConfirmed(
                beauticianId,
                appt.clients?.first_name || 'A client',
                appt.treatments?.name || 'their treatment',
                dateLabel,
                { appointmentId, apptDate: appt.starts_at }
              );
            } catch (err) {
              logger.warn({ err }, 'Deposit-paid push failed (non-fatal)');
            }
          })();
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
        const planId = sub.metadata?.plan_id;
        const beauticianId = sub.metadata?.beautician_id;

        if (beauticianId) {
          await supabase
            .from('beauticians')
            .update({
              subscription_plan: planId || 'florrie',
              subscription_stripe_id: sub.id,
              subscription_status: sub.status === 'active' || sub.status === 'trialing' ? 'active' : sub.status,
              subscription_current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
            })
            .eq('id', beauticianId);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const beauticianId = sub.metadata?.beautician_id;
        if (beauticianId) {
          await supabase
            .from('beauticians')
            .update({
              subscription_plan: 'trial',
              subscription_status: 'cancelled',
              subscription_stripe_id: null,
            })
            .eq('id', beauticianId);
        }
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

    // Enrich the already-inserted event record with full data
    await supabase.from('stripe_events').update({
      beautician_id: event.data.object.metadata?.beautician_id || null,
      data: event.data.object,
    }).eq('id', event.id);

    res.json({ received: true });
  } catch (err) {
    // The event row was already inserted above, so a Stripe retry would just hit
    // the duplicate guard and skip reprocessing — a 500 here wouldn't recover the
    // event, it would only get the endpoint flagged as failing. Acknowledge so
    // Stripe stops retrying, and log loudly so we can reconcile from the event row.
    logger.error({ err, eventId: event.id, type: event.type }, 'Webhook processing error (acknowledged, needs reconcile)');
    res.json({ received: true, processed: false });
  }
});

export default router;
