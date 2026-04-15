import { Router } from 'express';
import Stripe from 'stripe';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { notifyBookingConfirmed } from '../services/notifications.js';
import { cleanupStripeEvents } from '../services/stripe-cleanup.js';
import { calculatePlatformFee, getFeeDescription } from '../lib/platform-fees.js';
import logger from '../lib/logger.js';

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
    const platformFee = calculatePlatformFee(amount_cents);

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
  const { appointment_id, amount_cents } = req.body;

  if (!appointment_id) {
    return res.status(400).json({ error: 'appointment_id is required' });
  }

  // Verify beautician has Stripe Connect set up before attempting off-session charge
  if (!req.beautician.stripe_account_id || !req.beautician.stripe_onboarding_complete) {
    return res.status(400).json({ error: 'Complete Stripe setup before charging no-show fees' });
  }

  try {
    // Get appointment with client details
    const { data: appointment, error: fetchError } = await supabase
      .from('appointments')
      .select('*, clients(id, first_name, last_name, stripe_customer_id, phone)')
      .eq('id', appointment_id)
      .eq('beautician_id', req.beautician.id)
      .single();

    if (fetchError || !appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    if (appointment.status !== 'no_show') {
      return res.status(400).json({ error: 'Appointment must be marked as no-show first' });
    }

    // Validate amount doesn't exceed a reasonable cap
    const feeCents = amount_cents || appointment.deposit_cents || appointment.price_cents;
    const maxChargeable = (appointment.price_cents || 0) * 2;
    if (feeCents > maxChargeable) {
      return res.status(400).json({ error: `Amount exceeds reasonable limit (${maxChargeable} cents)` });
    }

    const client = appointment.clients;
    if (!client?.stripe_customer_id) {
      return res.status(400).json({
        error: 'Client has no saved payment method. No-show fee cannot be charged automatically.',
        suggest: 'Send a payment link instead.',
      });
    }
    if (!feeCents || feeCents <= 0) {
      return res.status(400).json({ error: 'No valid amount to charge' });
    }

    const platformFee = calculatePlatformFee(feeCents);

    // Get saved payment methods for the customer
    const paymentMethods = await stripe.paymentMethods.list({
      customer: client.stripe_customer_id,
      type: 'card',
    });

    if (!paymentMethods.data.length) {
      return res.status(400).json({
        error: 'Client has no saved card on file. Send a payment link instead.',
      });
    }

    // Charge the most recent card
    const paymentIntent = await stripe.paymentIntents.create({
      amount: feeCents,
      currency: 'gbp',
      customer: client.stripe_customer_id,
      payment_method: paymentMethods.data[0].id,
      confirm: true,
      off_session: true,
      application_fee_amount: platformFee,
      transfer_data: {
        destination: req.beautician.stripe_account_id,
      },
      description: `No-show fee — ${client.first_name} ${client.last_name || ''}`.trim(),
      metadata: {
        appointment_id,
        beautician_id: req.beautician.id,
        client_id: client.id,
        type: 'no_show_fee',
        platform_fee_cents: platformFee,
      },
    });

    // Record the transaction
    await supabase.from('transactions').insert({
      beautician_id: req.beautician.id,
      appointment_id,
      client_id: client.id,
      amount_cents: feeCents,
      type: 'no_show_fee',
      status: paymentIntent.status === 'succeeded' ? 'completed' : 'pending',
      stripe_payment_intent_id: paymentIntent.id,
      payment_method: 'card',
    });

    // Update appointment with no-show fee info
    await supabase.from('appointments').update({
      no_show_fee_cents: feeCents,
      no_show_fee_charged: paymentIntent.status === 'succeeded',
      no_show_fee_payment_intent: paymentIntent.id,
    }).eq('id', appointment_id);

    res.json({
      success: paymentIntent.status === 'succeeded',
      payment_intent_id: paymentIntent.id,
      amount_cents: feeCents,
      status: paymentIntent.status,
    });
  } catch (err) {
    // Handle card declined or authentication required
    if (err.code === 'authentication_required') {
      return res.status(402).json({
        error: 'Client card requires authentication. Send a payment link instead.',
        code: 'authentication_required',
      });
    }
    if (err.type === 'StripeCardError') {
      return res.status(402).json({
        error: 'Card declined. Please try another payment method.',
        code: err.code,
      });
    }
    logger.error({ err }, 'No-show charge error');
    res.status(500).json({ error: 'Failed to charge no-show fee' });
  }
});

// ═══════════════════════════════════════════════
// REFUNDS
// ═══════════════════════════════════════════════

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

    // Record refund transaction (negative amount)
    const refundedAmount = refund.amount;
    await supabase.from('transactions').insert({
      beautician_id: req.beautician.id,
      appointment_id,
      amount_cents: -refundedAmount,
      type: 'refund',
      status: 'completed',
      stripe_payment_intent_id: appointment.stripe_payment_intent_id,
      payment_method: 'card',
    });

    // Update appointment deposit status if fully refunded
    if (!amount_cents || amount_cents >= (appointment.deposit_cents || appointment.price_cents)) {
      await supabase.from('appointments').update({
        deposit_status: 'refunded',
        deposit_paid: false,
      }).eq('id', appointment_id);
    }

    res.json({
      success: true,
      refund_id: refund.id,
      amount_cents: refundedAmount,
      status: refund.status,
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

  try {
    const platformFee = calculatePlatformFee(amount_cents);
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

  let event;
  try {
    // req.rawBody is set by Express raw body middleware (see index.js)
    event = stripe.webhooks.constructEvent(req.rawBody || req.body, sig, webhookSecret);
  } catch (err) {
    logger.error({ err }, 'Webhook signature verification failed');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // Idempotency — use UPSERT for atomic duplicate detection
  try {
    const { error: insertError } = await supabase
      .from('stripe_events')
      .insert({ id: event.id, type: event.type, processed_at: new Date().toISOString() });

    if (insertError && insertError.code === '23505') {
      // Duplicate event ID — already processed
      return res.json({ received: true, status: 'already_processed' });
    }
    if (insertError) {
      throw insertError;
    }
  } catch (err) {
    if (err.code !== '23505') {
      logger.error({ err }, 'Failed to record stripe event');
      throw err;
    }
    return res.json({ received: true, status: 'already_processed' });
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
            payment_method: 'card',
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

          // Log the transaction with correct type
          await supabase.from('transactions').insert({
            beautician_id: beauticianId,
            appointment_id: appointmentId,
            client_id: clientId || null,
            amount_cents: session.amount_total,
            type: paymentType === 'full' ? 'full_payment' : 'deposit',
            status: 'completed',
            stripe_payment_intent_id: session.payment_intent,
            payment_method: 'card',
          });

          // If client paid, store their Stripe customer for faster future payments
          if (session.customer && clientId) {
            await supabase
              .from('clients')
              .update({ stripe_customer_id: session.customer })
              .eq('id', clientId);
          }

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

          // Mark enrollment as deposit_paid
          await supabase.from('course_enrollments')
            .update({
              payment_status: 'deposit_paid',
              amount_paid_cents: session.amount_total,
              stripe_payment_intent_id: session.payment_intent,
            })
            .eq('id', enrollmentId);

          // Log the transaction
          if (courseBeauticianId) {
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
        const charge = event.data.object;
        if (charge.metadata?.appointment_id) {
          logger.info({ appointment_id: charge.metadata.appointment_id, amount: charge.amount_refunded }, 'Charge refunded via webhook');
        }
        break;
      }

      case 'payment_intent.payment_failed': {
        const pi = event.data.object;
        if (pi.metadata?.type === 'no_show_fee') {
          // Update transaction status
          await supabase.from('transactions')
            .update({ status: 'failed' })
            .eq('stripe_payment_intent_id', pi.id);

          await supabase.from('appointments')
            .update({ no_show_fee_charged: false })
            .eq('id', pi.metadata.appointment_id);

          logger.warn({ appointment_id: pi.metadata.appointment_id }, 'No-show fee charge failed');
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
    logger.error({ err }, 'Webhook processing error');
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;
