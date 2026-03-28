import { Router } from 'express';
import Stripe from 'stripe';
import { supabase } from '../index.js';
import { requireAuth } from '../middleware/auth.js';
import { notifyBookingConfirmed } from '../services/notifications.js';
import { cleanupStripeEvents } from '../services/stripe-cleanup.js';
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
 * Creates a Stripe Connect Express account and returns the onboarding link.
 * The beautician completes KYC on Stripe's hosted page (not ours — PCI safe).
 */
router.post('/connect/onboard', requireAuth, requireStripe, async (req, res) => {
  try {
    let accountId = req.beautician.stripe_account_id;

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
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/stripe/connect/status
 * Check if the beautician's Stripe account is fully onboarded.
 */
router.get('/connect/status', requireAuth, requireStripe, async (req, res) => {
  const accountId = req.beautician.stripe_account_id;

  if (!accountId) {
    return res.json({ connected: false, onboarding_complete: false });
  }

  try {
    const account = await stripe.accounts.retrieve(accountId);
    const complete = account.charges_enabled && account.payouts_enabled;

    // Update our record if status changed
    if (complete !== req.beautician.stripe_onboarding_complete) {
      await supabase
        .from('beauticians')
        .update({ stripe_onboarding_complete: complete })
        .eq('id', req.beautician.id);
    }

    res.json({
      connected: true,
      onboarding_complete: complete,
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled,
      default_currency: account.default_currency,
    });
  } catch (err) {
    logger.error({ err }, 'Stripe status error');
    res.status(500).json({ error: err.message });
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
router.post('/checkout', requireStripe, async (req, res) => {
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
        // No platform fee on deposits — Florrie revenue comes from subscriptions
        transfer_data: {
          destination: beautician.stripe_account_id,
        },
        metadata: {
          appointment_id,
          beautician_id,
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
    res.status(500).json({ error: err.message });
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
        trial_period_days: req.beautician.subscription_plan === 'free' ? 14 : undefined,
        metadata: { beautician_id: req.beautician.id, plan_id },
      },
    });

    res.json({ url: session.url });
  } catch (err) {
    logger.error({ err }, 'Subscribe error');
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/stripe/portal
 * Opens the Stripe Customer Portal for managing subscription.
 */
router.post('/portal', requireAuth, requireStripe, async (req, res) => {
  const customerId = req.beautician.stripe_customer_id;
  if (!customerId) {
    return res.status(400).json({ error: 'No Stripe customer found' });
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${FRONTEND_URL}/settings`,
    });
    res.json({ url: session.url });
  } catch (err) {
    logger.error({ err }, 'Portal error');
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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

  // Idempotency — skip if we've already processed this event
  const { data: existing } = await supabase
    .from('stripe_events')
    .select('id')
    .eq('id', event.id)
    .maybeSingle();

  if (existing) {
    return res.json({ received: true, status: 'already_processed' });
  }

  try {
    switch (event.type) {
      // ── Payment completed (booking deposit) ──
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode === 'payment' && session.metadata?.appointment_id) {
          // Mark deposit as paid AND confirm the appointment (was 'pending' waiting for payment)
          await supabase
            .from('appointments')
            .update({ deposit_status: 'paid', deposit_paid: true, status: 'confirmed' })
            .eq('id', session.metadata.appointment_id);

          // Log the transaction
          await supabase.from('transactions').insert({
            beautician_id: session.metadata.beautician_id,
            appointment_id: session.metadata.appointment_id,
            amount_cents: session.amount_total,
            type: 'deposit',
            status: 'completed',
            stripe_payment_intent_id: session.payment_intent,
          });

          // If client paid, store their Stripe customer for faster future payments
          if (session.customer && session.metadata?.client_id) {
            await supabase
              .from('clients')
              .update({ stripe_customer_id: session.customer })
              .eq('id', session.metadata.client_id);
          }

          // Send booking confirmation now that payment is confirmed
          notifyBookingConfirmed(session.metadata.appointment_id).catch(err =>
            logger.warn({ err }, 'Post-payment confirmation notification failed (non-fatal)')
          );
        }
        break;
      }

      // ── Subscription created or updated ──
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const planId = sub.metadata?.plan_id;
        const beauticianId = sub.metadata?.beautician_id;

        if (beauticianId) {
          await supabase
            .from('beauticians')
            .update({
              subscription_plan: planId || 'starter',
              subscription_stripe_id: sub.id,
              subscription_status: sub.status === 'active' || sub.status === 'trialing' ? 'active' : sub.status,
              subscription_current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
            })
            .eq('id', beauticianId);
        }
        break;
      }

      // ── Subscription cancelled ──
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const beauticianId = sub.metadata?.beautician_id;
        if (beauticianId) {
          await supabase
            .from('beauticians')
            .update({
              subscription_plan: 'free',
              subscription_status: 'cancelled',
              subscription_stripe_id: null,
            })
            .eq('id', beauticianId);
        }
        break;
      }

      // ── Connect account updated ──
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

      default:
        // Unhandled event type — log but don't error
        break;
    }

    // Record event for idempotency
    await supabase.from('stripe_events').insert({
      id: event.id,
      type: event.type,
      beautician_id: event.data.object.metadata?.beautician_id || null,
      data: event.data.object,
    });

    res.json({ received: true });
  } catch (err) {
    logger.error({ err }, 'Webhook processing error');
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;
