import { Router } from 'express';
import Stripe from 'stripe';
import { supabase } from '../index.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// ═══════════════════════════════════════════════
// STRIPE CONNECT — Beautician payment onboarding
// ═══════════════════════════════════════════════

/**
 * POST /api/stripe/connect/onboard
 * Creates a Stripe Connect Express account and returns the onboarding link.
 * The beautician completes KYC on Stripe's hosted page (not ours — PCI safe).
 */
router.post('/connect/onboard', requireAuth, async (req, res) => {
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
    console.error('Stripe Connect onboard error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/stripe/connect/status
 * Check if the beautician's Stripe account is fully onboarded.
 */
router.get('/connect/status', requireAuth, async (req, res) => {
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
    console.error('Stripe status error:', err);
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
router.post('/checkout', async (req, res) => {
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
    // Platform fee: 5% of the transaction
    const platformFee = Math.round(amount_cents * 0.05);

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
    console.error('Checkout session error:', err);
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
router.post('/subscribe', requireAuth, async (req, res) => {
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
    console.error('Subscribe error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/stripe/portal
 * Opens the Stripe Customer Portal for managing subscription.
 */
router.post('/portal', requireAuth, async (req, res) => {
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
    console.error('Portal error:', err);
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
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    // req.rawBody is set by Express raw body middleware (see index.js)
    event = stripe.webhooks.constructEvent(req.rawBody || req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
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
          await supabase
            .from('appointments')
            .update({ deposit_status: 'paid', deposit_paid: true })
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
    console.error('Webhook processing error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;
