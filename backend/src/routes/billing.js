import { Router } from 'express';
import Stripe from 'stripe';
import * as Sentry from '@sentry/node';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';
import { verifyWebhook } from '../lib/stripe-webhook-secret.js';
import { internalStatusFor, isCardlessDraft } from '../lib/subscription-status.js';
import { teamSeatQuantity } from '../lib/team-seats.js';
import { handleDunningEvent } from '../services/dunning.js';
import { claimBillingEvent, completeBillingEvent, releaseBillingEvent } from '../services/billing-webhook-events.js';

const router = Router();

/**
 * Save a freshly created Stripe customer id on the beautician row and READ
 * the result. Both checkout paths below used to fire this update and look
 * away. When it failed the customer still existed in Stripe, so the checkout
 * carried on and nobody noticed; the next checkout then created a SECOND
 * Stripe customer, and the monthly overage invoice items (services/
 * whatsapp-metering.js) attached to whichever one the row named, which could
 * be the orphan with no subscription to ride on. The checkout URL is still
 * returned when this fails, because the customer is real; the failure is
 * shouted so it is fixed before the next month's overage goes astray.
 */
async function persistStripeCustomerId(beauticianId, stripeCustomerId, where) {
  const { error } = await supabase
    .from('beauticians')
    .update({ stripe_customer_id: stripeCustomerId })
    .eq('id', beauticianId);
  if (error) {
    logger.error({ err: error, beauticianId, stripeCustomerId, where }, 'stripe_customer_id was created in Stripe but could not be saved on the beautician');
  }
  return { error: error || null };
}

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
 * Why a plan could not be sold, said to the right person.
 *
 * "Invalid plan selected" was returned both for a plan name that does not
 * exist AND for a server with no STRIPE_PRICE_* set, and the app showed it
 * verbatim on the expired-trial screen: a locked-out customer told she had
 * picked a bad plan, with no way to pay. A missing price id is our problem,
 * and the copy says so.
 */
function planProblem(plan, interval) {
  const priceKey = interval === 'annual' ? `${plan}_annual` : plan;
  if (!plan || !Object.prototype.hasOwnProperty.call(PRICE_IDS, priceKey)) {
    return { status: 400, error: 'Invalid plan selected', priceKey };
  }
  if (!PRICE_IDS[priceKey]) {
    logger.error({ plan, interval, priceKey }, `Stripe price id for ${priceKey} is not set (STRIPE_PRICE_*). Nobody can subscribe to this plan until it is.`);
    return { status: 503, error: 'Billing is not switched on for this plan yet. Email hello@florrie.ai and we will sort it straight away.', priceKey };
  }
  return { status: 0, error: null, priceKey };
}

/**
 * The subscription this account already has, if it has one that counts.
 * Creating a second one is how "Add team features" charged £29 + £44.
 * @returns {Promise<object|null>} the Stripe subscription, or null
 */
async function liveSubscriptionFor(beautician) {
  const id = beautician?.subscription_stripe_id;
  if (!id || !stripe) return null;
  try {
    const sub = await stripe.subscriptions.retrieve(id);
    return ['active', 'trialing', 'past_due', 'unpaid'].includes(sub.status) ? sub : null;
  } catch (err) {
    logger.warn({ err, subscriptionId: id }, 'Could not verify the existing subscription; refusing to create another');
    const error = new Error('We could not check your current subscription. Please try again.');
    error.code = 'subscription_lookup_unavailable';
    throw error;
  }
}

/**
 * Move an existing subscription onto a different price instead of opening a
 * second one. Proration is Stripe's default; the customer pays the difference.
 */
async function switchPlan(sub, priceId, metadata, quantity = 1) {
  const item = sub.items?.data?.[0];
  return stripe.subscriptions.update(sub.id, {
    items: [{ id: item.id, price: priceId, quantity }],
    metadata,
    proration_behavior: 'create_prorations',
  });
}

/**
 * Cancel this customer's abandoned card-form subscriptions before making a
 * new one, so reopening the modal does not leave a trail of drafts behind.
 */
async function cancelCardlessDrafts(stripeCustomerId, beauticianId) {
  try {
    const list = await stripe.subscriptions.list({ customer: stripeCustomerId, status: 'all', limit: 20 });
    for (const sub of list.data || []) {
      if (sub.metadata?.beautician_id !== beauticianId) continue;
      const draft = (sub.status === 'trialing' && !sub.default_payment_method && sub.trial_settings?.end_behavior?.missing_payment_method === 'cancel')
        || sub.status === 'incomplete';
      if (draft) {
        await stripe.subscriptions.cancel(sub.id).catch(err => logger.warn({ err, subscriptionId: sub.id }, 'Could not cancel a draft subscription'));
      }
    }
  } catch (err) {
    logger.warn({ err, stripeCustomerId }, 'Could not list subscriptions to clear drafts');
  }
}

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
    const problem = planProblem(plan, interval);
    if (problem.status) return res.status(problem.status).json({ error: problem.error });
    const { priceKey } = problem;

    const beautician = req.beautician;
    let stripeCustomerId = beautician.stripe_customer_id;

    // Already subscribed: change the plan on the subscription that exists, or
    // send her to the portal if it is the same one. Never a second checkout.
    const live = await liveSubscriptionFor(beautician);
    if (live) {
      const currentPrice = live.items?.data?.[0]?.price?.id;
      if (currentPrice === PRICE_IDS[priceKey]) {
        const portal = await stripe.billingPortal.sessions.create({ customer: live.customer, return_url: `${APP_URL}/pricing` });
        return res.json({ alreadySubscribed: true, url: portal.url });
      }
      const metadata = subscriptionMetadata({ beauticianId: beautician.id, plan, interval });
      const quantity = await teamSeatQuantity(supabase, beautician.id, plan);
      await switchPlan(live, PRICE_IDS[priceKey], metadata, quantity);
      return res.json({ switched: true, url: `${APP_URL}/pricing?switched=1` });
    }

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
      await persistStripeCustomerId(beautician.id, stripeCustomerId, 'create-checkout');
    }

    // Days of trial this account still has coming. Onboarding asks for a
    // trial on day 0 and gets the full 14. Coming back through the same door
    // on day 5 gets the 9 that are left, not a fresh 14: the trial is a
    // property of the account, not of the checkout you happen to open.
    // remainingTrialDays returns 0 for a trial that has run out, and 0 is
    // falsy: `|| TRIAL_DAYS` handed anyone re-entering onboarding after
    // expiry a fresh fourteen days. A fresh account with no trial recorded
    // still gets the full trial; that is the only fallback.
    const remaining = remainingTrialDays(beautician);
    const trialDays = trial ? (beautician.trial_ends_at ? remaining : TRIAL_DAYS) : 0;

    // Build session params — embedded mode uses client_secret + return_url,
    // redirect mode uses success_url + cancel_url
    const metadata = subscriptionMetadata({ beauticianId: beautician.id, plan, interval });
    // One seat per active staff member on the team plan. This has no effect
    // on the amount charged until the Stripe price is per-seat: the 'Florrie
    // Team' price created by backend/scripts/stripe-setup.js (around line 36)
    // is a flat £44, and Stripe multiplies a flat price by the quantity, so
    // lib/team-seats.js answers 1 until STRIPE_TEAM_PRICE_PER_SEAT is set
    // against a per-seat price. Set the flag and the staff count goes through.
    const quantity = await teamSeatQuantity(supabase, beautician.id, plan);
    const sessionParams = {
      customer: stripeCustomerId,
      mode: 'subscription',
      line_items: [{ price: PRICE_IDS[priceKey], quantity }],
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
    if (error.code === 'subscription_lookup_unavailable') return res.status(503).json({ error: error.message });
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
    const problem = planProblem(plan, interval);
    if (problem.status) return res.status(problem.status).json({ error: problem.error });
    const { priceKey } = problem;

    const beautician = req.beautician;
    let stripeCustomerId = beautician.stripe_customer_id;

    // Already paying: switch the plan on the subscription that exists rather
    // than opening a card form for a second one.
    const live = await liveSubscriptionFor(beautician);
    if (live) {
      const currentPrice = live.items?.data?.[0]?.price?.id;
      if (currentPrice === PRICE_IDS[priceKey]) {
        return res.status(409).json({ error: 'You are already on this plan.', alreadySubscribed: true });
      }
      const metadata = subscriptionMetadata({ beauticianId: beautician.id, plan, interval });
      const quantity = await teamSeatQuantity(supabase, beautician.id, plan);
      await switchPlan(live, PRICE_IDS[priceKey], metadata, quantity);
      return res.json({ switched: true });
    }

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
      await persistStripeCustomerId(beautician.id, stripeCustomerId, 'create-subscription-intent');
    }

    const trialDays = remainingTrialDays(beautician);

    // Reopening the modal, or toggling monthly/annual, used to leave a fresh
    // subscription behind each time. Clear the drafts first.
    await cancelCardlessDrafts(stripeCustomerId, beautician.id);

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
    if (error.code === 'subscription_lookup_unavailable') return res.status(503).json({ error: error.message });
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
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).json({ error: 'Billing webhook is not configured' });

  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const verified = verifyWebhook({
    stripe, payload: req.rawBody || req.body, signature: sig, rawSecret: endpointSecret,
  });
  if (!verified.event) {
    logger.error({ reason: verified.reason, secretsTried: verified.secretsTried }, 'Billing webhook signature verification failed');
    return res.status(400).json({ error: 'Webhook signature invalid' });
  }
  const event = verified.event;

  return handleBillingEvent(event, res);
});

const BILLING_EVENT_TYPES = new Set([
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
  'invoice.payment_failed', 'invoice.paid', 'invoice.payment_succeeded',
]);

export function isBillingEvent(event) {
  return BILLING_EVENT_TYPES.has(event?.type)
    || (event?.type === 'checkout.session.completed' && event.data?.object?.mode === 'subscription');
}

// Both webhook URLs use this consumer, before either can claim a payment event.
export async function handleBillingEvent(event, res) {
  if (!isBillingEvent(event)) return res.json({ received: true, ignored: true });
  let claim;
  try {
    claim = await claimBillingEvent(event);
    if (claim.duplicate) return res.json({ received: true, duplicate: true });
  } catch (error) {
    logger.error({ err: error, eventId: event.id }, 'Billing webhook claim unavailable');
    return res.status(503).json({ error: 'Billing event is awaiting processing' });
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
          const { error: actErr } = await supabase
            .from('beauticians')
            .update({
              subscription_plan: plan,
              subscription_status: internalStatusFor('active'),
              subscription_stripe_id: session.subscription,
            })
            .eq('id', beauticianId);
          if (actErr) {
            logger.error({ err: actErr, beauticianId, plan, sessionId: session.id }, 'Subscription activation could not be written');
            throw actErr;
          } else {
            logger.info({ beauticianId, plan }, 'Subscription activated');
          }
        }
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const beauticianId = sub.metadata?.beautician_id;
        // Both webhook URLs delegate here, sharing the same claim and mapping.
        const { plan, problem, found } = readPlanFromMetadata(sub.metadata);
        if (problem) {
          logger.error(
            { beauticianId, subscriptionId: sub.id, problem, found },
            'Subscription webhook could not read the plan, leaving subscription_plan untouched'
          );
          Sentry.captureMessage('Subscription webhook could not read the plan', {
            level: 'error', tags: { area: 'billing', check: 'subscription_plan_metadata' },
            extra: { beauticianId, subscriptionId: sub.id, problem, found },
          });
        }
        if (beauticianId && isCardlessDraft(sub)) {
          logger.info({ beauticianId, subscriptionId: sub.id }, 'Cardless draft subscription, leaving the account untouched');
          break;
        }
        if (beauticianId) {
          // Through the translation table, never Stripe's own word: 'unpaid'
          // and 'canceled' violate the column's CHECK and the write failed
          // silently for months. See lib/subscription-status.js.
          const status = internalStatusFor(sub.status);
          const updates = {
            subscription_stripe_id: sub.id,
            subscription_status: status,
            subscription_current_period_end: sub.current_period_end
              ? new Date(sub.current_period_end * 1000).toISOString()
              : null,
          };
          if (plan) updates.subscription_plan = plan;
          const { error: updErr } = await supabase
            .from('beauticians')
            .update(updates)
            .eq('id', beauticianId);
          if (updErr) {
            logger.error({ err: updErr, beauticianId, subscriptionId: sub.id, stripeStatus: sub.status, updates }, 'Subscription status update failed');
            Sentry.captureException(updErr, {
              tags: { area: 'billing', check: 'subscription_status_write' },
              extra: { beauticianId, subscriptionId: sub.id, eventType: event.type },
            });
            throw updErr;
          } else {
            logger.info({ beauticianId, plan, status }, 'Subscription updated');
          }
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const beauticianId = sub.metadata?.beautician_id;
        if (beauticianId) {
          const { data: current, error: readErr } = await supabase
            .from('beauticians')
            .select('subscription_stripe_id')
            .eq('id', beauticianId)
            .maybeSingle();
          if (readErr) throw readErr;
          if (current?.subscription_stripe_id && current.subscription_stripe_id !== sub.id) {
            logger.info({ beauticianId, subscriptionId: sub.id, onFile: current.subscription_stripe_id }, 'Deleted subscription is not the one on file, ignoring');
            break;
          }
          // Plan left alone on purpose: see routes/stripe.js for why.
          const { error: delErr } = await supabase
            .from('beauticians')
            .update({
              subscription_status: internalStatusFor('canceled'),
              subscription_stripe_id: null,
            })
            .eq('id', beauticianId);
          if (delErr) {
            logger.error({ err: delErr, beauticianId, subscriptionId: sub.id }, 'Subscription cancellation could not be written');
            throw delErr;
          } else {
            logger.info({ beauticianId }, 'Subscription cancelled');
          }
        }
        break;
      }

      // Same shared handler as /api/stripe/webhook (services/dunning.js), so
      // an invoice event is handled whichever of the two URLs Stripe hits.
      case 'invoice.payment_failed':
      case 'invoice.paid':
      case 'invoice.payment_succeeded': {
        const result = await handleDunningEvent(event, { strict: true });
        if (result?.handled && (!result.statusWritten || (!result.marker?.written && !result.marker?.missing))) {
          throw new Error('Subscription invoice update incomplete');
        }
        break;
      }
    }
    await completeBillingEvent(event, claim);
  } catch (error) {
    logger.error({ err: error, eventId: event.id, eventType: event.type }, 'Billing event failed; awaiting retry');
    await releaseBillingEvent(event, claim).catch(releaseError => logger.error({ err: releaseError, eventId: event.id }, 'Billing claim release failed; lease will expire'));
    return res.status(503).json({ error: 'Billing event could not be processed' });
  }

  return res.json({ received: true });
}

export default router;
