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
 * WHERE THE PLAN NAME LIVES.
 *
 * A Stripe subscription is the only record of which plan somebody bought, and
 * it carries that name in metadata. This file wrote it under `plan`. The
 * webhook in routes/stripe.js read `plan_id`, got undefined every single time,
 * and fell back to `subscription_plan: 'florrie'`. So a Team subscriber was
 * downgraded out of /team, /rota, /locations and /staff-performance the next
 * time Stripe sent customer.subscription.updated, which it does for renewals,
 * card updates and trial endings. Nobody typed a downgrade. It just happened.
 *
 * The key is now a constant that both the writer and the reader import, and
 * the reader below refuses to guess. If the plan cannot be read, the webhook
 * leaves subscription_plan alone and shouts, because "I do not know what they
 * bought" must never resolve to "the cheaper one".
 */
export const PLAN_METADATA_KEY = 'plan';

/** Plan ids that may be written to beauticians.subscription_plan by billing. */
export const PAID_PLANS = ['florrie', 'florrie_team'];

/** Trial length for a fresh account, matching TIERS.trial.trial_days. */
export const TRIAL_DAYS = 14;

/**
 * The metadata blob that goes on both the Checkout Session and the
 * Subscription. One builder, so the two can never disagree.
 */
export function subscriptionMetadata({ beauticianId, plan, interval }) {
  return {
    beautician_id: beauticianId,
    [PLAN_METADATA_KEY]: plan,
    interval: interval || 'monthly',
  };
}

/**
 * Read the plan a subscription was sold under.
 *
 * @param {object} metadata subscription.metadata straight off the Stripe event
 * @returns {{plan: string|null, problem: string|null, found: string|null}}
 *   plan is non-null ONLY when the metadata names a plan we recognise.
 *   problem names what went wrong so the caller can log it loudly.
 */
export function readPlanFromMetadata(metadata) {
  const canonical = metadata?.[PLAN_METADATA_KEY];
  // plan_id is not a key this codebase has ever written. Accepting it costs
  // nothing and covers a subscription hand-made in the Stripe dashboard, but
  // it is still reported as drift rather than treated as normal.
  const legacy = metadata?.plan_id;
  const found = canonical ?? legacy ?? null;

  if (found == null || String(found).trim() === '') {
    return { plan: null, problem: 'missing', found: null };
  }
  const plan = String(found).trim();
  if (!PAID_PLANS.includes(plan)) {
    return { plan: null, problem: 'unknown_plan', found: plan };
  }
  if (canonical == null) {
    return { plan, problem: 'legacy_key', found: plan };
  }
  return { plan, problem: null, found: plan };
}

/**
 * Whole days left on this account's free trial.
 *
 * Upgrading early must never be a punishment. Tapping "upgrade" on day 3 of a
 * 14 day trial used to create a subscription with no trial at all, taking £29
 * on the spot and throwing away the 11 days already promised. Whatever is left
 * of trial_ends_at carries over, rounded UP so a part day is never confiscated.
 *
 * Returns 0 for an account that is already paying, has no trial recorded, or
 * whose trial has run out. 0 means "charge now", which is correct in all three.
 *
 * @param {object} beautician row with subscription_plan and trial_ends_at
 * @param {Date} [now]
 * @returns {number} 0..TRIAL_DAYS
 */
export function remainingTrialDays(beautician, now = new Date()) {
  if (!beautician) return 0;
  // Somebody on a live paid subscription is not on a trial, whatever the date
  // column says.
  const plan = beautician.subscription_plan;
  if (PAID_PLANS.includes(plan) && beautician.subscription_status === 'active') return 0;

  const endsAt = beautician.trial_ends_at ? new Date(beautician.trial_ends_at) : null;
  if (!endsAt || Number.isNaN(endsAt.getTime())) return 0;

  const msLeft = endsAt.getTime() - now.getTime();
  if (msLeft <= 0) return 0;
  return Math.min(TRIAL_DAYS, Math.ceil(msLeft / 86400000));
}

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

    // Days of trial this account still has coming. Onboarding asks for a
    // trial on day 0 and gets the full 14. Coming back through the same door
    // on day 5 gets the 9 that are left, not a fresh 14: the trial is a
    // property of the account, not of the checkout you happen to open.
    const trialDays = trial ? (remainingTrialDays(beautician) || TRIAL_DAYS) : 0;

    // Build session params — embedded mode uses client_secret + return_url,
    // redirect mode uses success_url + cancel_url
    const metadata = subscriptionMetadata({ beauticianId: beautician.id, plan, interval });
    const sessionParams = {
      customer: stripeCustomerId,
      mode: 'subscription',
      line_items: [{ price: PRICE_IDS[priceKey], quantity: 1 }],
      metadata,
      subscription_data: {
        // Card is captured now; the first charge is deferred until the trial
        // she already has runs out.
        ...(trialDays > 0 ? { trial_period_days: trialDays } : {}),
        metadata,
      },
      // Force Stripe to collect a card even when the first invoice is 0 (trial),
      // so we have a payment method on file the moment the trial ends.
      ...(trialDays > 0 ? { payment_method_collection: 'always' } : {}),
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
 *   3. Return clientSecret + the mode the frontend must confirm in
 *   4. Frontend confirms with stripe.confirmPayment() (mode 'payment') or
 *      stripe.confirmSetup() (mode 'setup', i.e. there is a trial to honour)
 *   5. On success, subscription becomes active/trialing (webhook updates DB)
 *
 * THE TRIAL. This endpoint used to create the subscription with no trial at
 * all, while the onboarding checkout path passed one. So tapping upgrade on
 * the pricing page on day 3 charged £29 that minute and binned the 11 free
 * days she had been promised. The trial belongs to the account, so it is read
 * off the account here and carried onto the subscription. When there is a
 * trial, Stripe raises no invoice to pay, so there is no PaymentIntent: the
 * card is collected against the subscription's pending SetupIntent instead,
 * which is why the response says which one it is.
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

    const trialDays = remainingTrialDays(beautician);

    // Create subscription in incomplete state — card collected via Payment Element
    const subscription = await stripe.subscriptions.create({
      customer: stripeCustomerId,
      items: [{ price: PRICE_IDS[priceKey] }],
      payment_behavior: 'default_incomplete',
      payment_settings: {
        payment_method_types: ['card'],
        save_default_payment_method: 'on_subscription',
      },
      ...(trialDays > 0
        ? {
            trial_period_days: trialDays,
            // No card by the time the trial ends means no subscription, rather
            // than a subscription that quietly goes past_due.
            trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
          }
        : {}),
      expand: ['latest_invoice.payment_intent', 'pending_setup_intent'],
      metadata: subscriptionMetadata({ beauticianId: beautician.id, plan, interval }),
    });

    const paymentIntent = subscription.latest_invoice?.payment_intent || null;
    const setupIntent = subscription.pending_setup_intent || null;
    // With a trial the intent is a SetupIntent; without one it is a
    // PaymentIntent. Prefer whichever Stripe actually made rather than
    // assuming, so a price with a trial configured on it lands here too.
    const intent = paymentIntent
      ? { mode: 'payment', clientSecret: paymentIntent.client_secret }
      : setupIntent
        ? { mode: 'setup', clientSecret: setupIntent.client_secret }
        : null;

    if (!intent?.clientSecret) {
      logger.error(
        { subscriptionId: subscription.id, trialDays, beauticianId: beautician.id },
        'Subscription created with neither a PaymentIntent nor a SetupIntent to confirm'
      );
      return res.status(502).json({ error: 'Could not start the card form. Please try again.' });
    }

    res.json({
      clientSecret: intent.clientSecret,
      mode: intent.mode,
      subscriptionId: subscription.id,
      trialDays,
      trialEndsAt: subscription.trial_end
        ? new Date(subscription.trial_end * 1000).toISOString()
        : null,
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
        const { plan, problem, found } = readPlanFromMetadata(session.metadata);
        if (problem) {
          logger.error(
            { beauticianId, sessionId: session.id, problem, found },
            'Checkout completed but the plan could not be read from its metadata'
          );
        }
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
        const { plan, problem, found } = readPlanFromMetadata(sub.metadata);
        if (problem) {
          logger.error(
            { beauticianId, subscriptionId: sub.id, problem, found },
            'Subscription webhook could not read the plan, leaving subscription_plan untouched'
          );
        }
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
