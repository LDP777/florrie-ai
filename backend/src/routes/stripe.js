import { Router } from 'express';
import Stripe from 'stripe';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { notifyBookingConfirmed } from '../services/notifications.js';
import { pushBookingConfirmed } from '../services/push-notifications.js';
import { cleanupStripeEvents } from '../services/stripe-cleanup.js';
import { totalApplicationFee, getFeeDescription } from '../lib/platform-fees.js';
import { chargePolicyFee } from '../services/policy-fees.js';
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
      payment_method: 'card_online',
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

  let event;
  try {
    // req.rawBody is set by Express raw body middleware (see index.js)
    event = stripe.webhooks.constructEvent(req.rawBody || req.body, sig, webhookSecret);
  } catch (err) {
    logger.error({ err }, 'Webhook signature verification failed');
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

          // Log the transaction with correct type
          await supabase.from('transactions').insert({
            beautician_id: beauticianId,
            appointment_id: appointmentId,
            client_id: clientId || null,
            amount_cents: session.amount_total,
            type: paymentType === 'full' ? 'full_payment' : 'deposit',
            status: 'completed',
            stripe_payment_intent_id: session.payment_intent,
            payment_method: 'card_online',
          });

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
        const charge = event.data.object;
        if (charge.metadata?.appointment_id) {
          logger.info({ appointment_id: charge.metadata.appointment_id, amount: charge.amount_refunded }, 'Charge refunded via webhook');
        }
        break;
      }

      case 'payment_intent.payment_failed': {
        const pi = event.data.object;
        const feeType = pi.metadata?.type;
        // Reconcile both policy-fee kinds. The policy-fees service marks the
        // appointment as charged (no_show_fee_charged / late_cancel_charged) and
        // writes a transaction before Stripe confirms — so a later payment_failed
        // must roll those flags back, otherwise the fee shows as collected when it
        // was not.
        if (feeType === 'no_show_fee' || feeType === 'late_cancel_fee') {
          // Mark the money-feed row as failed.
          await supabase.from('transactions')
            .update({ status: 'failed' })
            .eq('stripe_payment_intent_id', pi.id);

          const apptUpdate = feeType === 'no_show_fee'
            ? { no_show_fee_charged: false }
            : { late_cancel_charged: false };

          if (pi.metadata.appointment_id) {
            await supabase.from('appointments')
              .update(apptUpdate)
              .eq('id', pi.metadata.appointment_id);
          }

          logger.warn(
            { appointment_id: pi.metadata.appointment_id, feeType },
            'Policy fee charge failed',
          );
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
