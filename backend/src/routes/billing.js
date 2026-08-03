import { Router } from 'express';
import Stripe from 'stripe';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';
import { verifyWebhook } from '../lib/stripe-webhook-secret.js';

const router = Router();

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

// Price IDs for each plan — set these in .env
// Monthly and annual variants (annual = 10 months, i.e. 2 months free)
// Price IDs — set these in .env when Stripe products are created
const PRICE_IDS = {
  florrie: process.env.STRIPE_PRICE_FLORRIE || '',
  florrie_team: process.env.STRIPE_PRICE_FLORRIE_TEAM || '',
  florrie_annual: process.env.STRIPE_PRICE_FLORRIE_ANNUAL || '',
  florrie_team_annual: process.env.STRIPE_PRICE_FLORRIE_TEAM_ANNUAL || '',
};

const APP_URL = process.env.APP_URL || 'https://app.florrie.ai';

/**
 * POST /api/billing/create-checkout
 * Creates a Stripe Checkout Session for the given plan.
 */
router.post('/create-checkout', requireAuth, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: 'Billing is not configured yet. Please contact support.' });
    }

    const { plan, interval, embedded, trial } = req.body;
    // Support both monthly and annual: plan='florrie', interval='annual' → key='florrie_annual'
    const priceKey = interval === 'annual' ? `${plan}_annual` : plan;
    if (!plan || !PRICE_IDS[priceKey]) {
      return res.status(400).json({ error: 'Invalid plan selected' });
    }

    const beautician = req.beautician;
    let stripeCustomerId = beautician.stripe_customer_id;

    // Create Stripe customer if needed
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: beautician.email,
        metadata: {
          beautician_id: beautician.id,
          business_name: beautician.business_name || '',
        },
      });
      stripeCustomerId = customer.id;

      await supabase
        .from('beauticians')
        .update({ stripe_customer_id: stripeCustomerId })
        .eq('id', beautician.id);
    }

    // Build session params — embedded mode uses client_secret + return_url,
    // redirect mode uses success_url + cancel_url
    const sessionParams = {
      customer: stripeCustomerId,
      mode: 'subscription',
      line_items: [{ price: PRICE_IDS[priceKey], quantity: 1 }],
      metadata: {
        beautician_id: beautician.id,
        plan,
        interval: interval || 'monthly',
      },
      subscription_data: {
        // Card is captured now; first charge is deferred 14 days. Onboarding
        // passes trial:true so the beautician starts in a trialing subscription.
        ...(trial ? { trial_period_days: 14 } : {}),
        metadata: {
          beautician_id: beautician.id,
          plan,
          interval: interval || 'monthly',
        },
      },
      // Force Stripe to collect a card even when the first invoice is 0 (trial),
      // so we have a payment method on file the moment the trial ends.
      ...(trial ? { payment_method_collection: 'always' } : {}),
      allow_promotion_codes: true,
    };

    // Onboarding card capture returns to the app home; pricing-page upgrades
    // return to the pricing page as before.
    const successPath = trial ? '/?billing=success' : '/pricing?session_id={CHECKOUT_SESSION_ID}&success=1';
    const cancelPath = trial ? '/?billing=cancelled' : '/pricing?cancelled=1';
    if (embedded) {
      sessionParams.ui_mode = 'embedded';
      sessionParams.return_url = `${APP_URL}${successPath}`;
    } else {
      sessionParams.success_url = `${APP_URL}${successPath}`;
      sessionParams.cancel_url = `${APP_URL}${cancelPath}`;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    if (embedded) {
      res.json({ clientSecret: session.client_secret });
    } else {
      res.json({ url: session.url });
    }
  } catch (error) {
    logger.error({ err: error }, 'Failed to create checkout session');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * POST /api/billing/create-subscription-intent
 * Creates a Stripe Subscription in incomplete state and returns the
 * PaymentIntent clientSecret for use with Stripe Payment Element.
 *
 * Flow:
 *   1. Create/get Stripe customer
 *   2. Create subscription with payment_behavior='default_incomplete'
 *   3. Return clientSecret from latest_invoice.payment_intent
 *   4. Frontend confirms payment via stripe.confirmPayment()
 *   5. On success, subscription becomes active (webhook updates DB)
 */
router.post('/create-subscription-intent', requireAuth, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: 'Billing is not configured yet. Please contact support.' });
    }

    const { plan, interval } = req.body;
    const priceKey = interval === 'annual' ? `${plan}_annual` : plan;
    if (!plan || !PRICE_IDS[priceKey]) {
      return res.status(400).json({ error: 'Invalid plan selected' });
    }

    const beautician = req.beautician;
    let stripeCustomerId = beautician.stripe_customer_id;

    // Create Stripe customer if needed
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: beautician.email,
        metadata: {
          beautician_id: beautician.id,
          business_name: beautician.business_name || '',
        },
      });
      stripeCustomerId = customer.id;

      await supabase
        .from('beauticians')
        .update({ stripe_customer_id: stripeCustomerId })
        .eq('id', beautician.id);
    }

    // Create subscription in incomplete state — payment collected via Payment Element
    const subscription = await stripe.subscriptions.create({
      customer: stripeCustomerId,
      items: [{ price: PRICE_IDS[priceKey] }],
      payment_behavior: 'default_incomplete',
      payment_settings: {
        payment_method_types: ['card'],
        save_default_payment_method: 'on_subscription',
      },
      expand: ['latest_invoice.payment_intent'],
      metadata: {
        beautician_id: beautician.id,
        plan,
        interval: interval || 'monthly',
      },
    });

    const paymentIntent = subscription.latest_invoice.payment_intent;

    res.json({
      clientSecret: paymentIntent.client_secret,
      subscriptionId: subscription.id,
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to create subscription intent');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * POST /api/billing/portal
 * Creates a Stripe Customer Portal session for managing subscription.
 */
router.post('/portal', requireAuth, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: 'Billing is not configured yet.' });
    }

    const stripeCustomerId = req.beautician.stripe_customer_id;
    if (!stripeCustomerId) {
      return res.status(400).json({ error: 'No billing account found. Please subscribe to a plan first.' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${APP_URL}/pricing`,
    });

    res.json({ url: session.url });
  } catch (error) {
    logger.error({ err: error }, 'Failed to create portal session');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * POST /api/billing/webhook
 * Stripe webhook handler — updates subscription status in Supabase.
 */
router.post('/webhook', async (req, res) => {
  if (!stripe) return res.status(200).json({ received: true });

  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;

  if (endpointSecret) {
    // Same multi-secret rule as /api/stripe/webhook: two endpoints, two
    // secrets, one variable. See lib/stripe-webhook-secret.js.
    const verified = verifyWebhook({
      stripe, payload: req.rawBody || req.body, signature: sig, rawSecret: endpointSecret,
    });
    if (!verified.event) {
      logger.error({ reason: verified.reason, secretsTried: verified.secretsTried }, 'Billing webhook signature verification failed');
      // 400 not 5xx, so Stripe does not flag and disable the endpoint.
      return res.status(400).json({ error: 'Webhook signature invalid' });
    }
    event = verified.event;
  } else {
    event = req.body;
  }

  // Idempotency: dedupe via the shared stripe_events table (same as
  // /api/stripe/webhook). If both webhook URLs are configured in Stripe, the
  // first to record the event id wins and the second skips, so a subscription
  // event is never processed twice.
  try {
    const { error: insErr } = await supabase
      .from('stripe_events')
      .insert({ id: event.id, type: event.type, processed_at: new Date().toISOString() });
    if (insErr && insErr.code === '23505') {
      return res.json({ received: true, duplicate: true });
    }
  } catch (err) {
    logger.error({ err, eventId: event.id }, 'billing webhook: stripe_events insert threw, processing anyway');
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const beauticianId = session.metadata?.beautician_id;
        const plan = session.metadata?.plan;
        if (beauticianId && plan) {
          await supabase
            .from('beauticians')
            .update({
              subscription_plan: plan,
              subscription_status: 'active',
              subscription_stripe_id: session.subscription,
            })
            .eq('id', beauticianId);
          logger.info({ beauticianId, plan }, 'Subscription activated');
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const beauticianId = sub.metadata?.beautician_id;
        // M2: routes/stripe.js is the canonical subscription webhook. This
        // handler is kept so a Stripe dashboard pointing here doesn't 404, but
        // its status/plan mapping is aligned with stripe.js so that if BOTH
        // URLs are configured the double-write converges instead of flip-
        // flopping (e.g. trialing -> active). Long-term: remove one webhook URL
        // in the Stripe dashboard.
        const plan = sub.metadata?.plan || sub.metadata?.plan_id;
        if (beauticianId) {
          const status = sub.status === 'active' || sub.status === 'trialing' ? 'active' : sub.status;
          const updates = {
            subscription_status: status,
            subscription_current_period_end: sub.current_period_end
              ? new Date(sub.current_period_end * 1000).toISOString()
              : null,
          };
          if (plan) updates.subscription_plan = plan;
          await supabase
            .from('beauticians')
            .update(updates)
            .eq('id', beauticianId);
          logger.info({ beauticianId, plan, status }, 'Subscription updated');
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
          logger.info({ beauticianId }, 'Subscription cancelled');
        }
        break;
      }
    }
  } catch (error) {
    logger.error({ err: error, eventType: event.type }, 'Webhook handler error');
  }

  res.json({ received: true });
});

export default router;
