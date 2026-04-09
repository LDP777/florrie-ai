import { Router } from 'express';
import Stripe from 'stripe';
import { supabase } from '../index.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';

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

    const { plan, interval, embedded } = req.body;
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
        metadata: {
          beautician_id: beautician.id,
          plan,
          interval: interval || 'monthly',
        },
      },
      allow_promotion_codes: true,
    };

    if (embedded) {
      sessionParams.ui_mode = 'embedded';
      sessionParams.return_url = `${APP_URL}/pricing?session_id={CHECKOUT_SESSION_ID}&success=1`;
    } else {
      sessionParams.success_url = `${APP_URL}/pricing?session_id={CHECKOUT_SESSION_ID}&success=1`;
      sessionParams.cancel_url = `${APP_URL}/pricing?cancelled=1`;
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

  try {
    if (endpointSecret && sig) {
      event = stripe.webhooks.constructEvent(req.rawBody || req.body, sig, endpointSecret);
    } else if (endpointSecret) {
      // Reject if secret is configured but no signature provided
      return res.status(503).json({ error: 'Webhook signature verification failed' });
    } else {
      event = req.body;
    }
  } catch (err) {
    logger.error({ err }, 'Webhook signature verification failed');
    return res.status(400).json({ error: 'Webhook signature invalid' });
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
              stripe_subscription_id: session.subscription,
            })
            .eq('id', beauticianId);
          logger.info({ beauticianId, plan }, 'Subscription activated');
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const beauticianId = sub.metadata?.beautician_id;
        const plan = sub.metadata?.plan;
        if (beauticianId) {
          const status = sub.status === 'active' ? 'active' : sub.status === 'past_due' ? 'past_due' : sub.status;
          const updates = {
            subscription_status: status,
            subscription_current_period_end: sub.current_period_end
              ? new Date(sub.current_period_end * 1000).toISOString()
              : null,
          };
          // Update plan if metadata contains it (upgrade/downgrade)
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
              stripe_subscription_id: null,
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
