#!/usr/bin/env node
/**
 * stripe-setup.js — Creates Florrie subscription products and prices in Stripe.
 *
 * Run once against your live Stripe account:
 *   STRIPE_SECRET_KEY=sk_live_xxx node scripts/stripe-setup.js
 *
 * Then copy the output price IDs into your Railway env vars.
 *
 * Products created:
 *   - Florrie       (£29/mo, £290/yr — 2 months free)
 *   - Florrie Team  (£44/mo, £440/yr — £29 base + £15/seat)
 */

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PLANS = [
  {
    name: 'Florrie',
    envKey: 'FLORRIE',
    monthly: 2900,   // £29.00/mo
    annual: 29000,   // £290.00/yr (2 months free)
    features: [
      'Unlimited clients',
      'Online booking page',
      'AI Front Desk (120 msgs/mo)',
      'SMS & WhatsApp reminders',
      'Smart scheduling',
      'Analytics & tax dashboard',
    ],
  },
  {
    name: 'Florrie Team',
    envKey: 'FLORRIE_TEAM',
    monthly: 4400,   // £44.00/mo (£29 + £15/seat)
    annual: 44000,   // £440.00/yr
    features: [
      'Everything in Florrie',
      'Multi-location support',
      'Staff rota & KPIs',
      'Up to 10 team members',
      'Priority support',
    ],
  },
];

async function main() {
  console.log('Creating Florrie subscription products in Stripe...\n');
  const envVars = {};

  for (const plan of PLANS) {
    // Create product
    const product = await stripe.products.create({
      name: plan.name,
      metadata: { florrie_plan: plan.envKey.toLowerCase() },
      marketing_features: plan.features.map(f => ({ name: f })),
    });

    console.log(`Created product: ${plan.name} (${product.id})`);

    // Create monthly price
    const monthlyPrice = await stripe.prices.create({
      product: product.id,
      unit_amount: plan.monthly,
      currency: 'gbp',
      recurring: { interval: 'month' },
      metadata: { florrie_plan: plan.envKey.toLowerCase(), interval: 'monthly' },
    });

    console.log(`  Monthly: ${monthlyPrice.id} (£${(plan.monthly / 100).toFixed(2)}/mo)`);
    envVars[`STRIPE_PRICE_${plan.envKey}`] = monthlyPrice.id;

    // Create annual price
    const annualPrice = await stripe.prices.create({
      product: product.id,
      unit_amount: plan.annual,
      currency: 'gbp',
      recurring: { interval: 'year' },
      metadata: { florrie_plan: plan.envKey.toLowerCase(), interval: 'annual' },
    });

    console.log(`  Annual:  ${annualPrice.id} (£${(plan.annual / 100).toFixed(2)}/yr)`);
    envVars[`STRIPE_PRICE_${plan.envKey}_ANNUAL`] = annualPrice.id;

    console.log('');
  }

  console.log('='.repeat(60));
  console.log('Copy these into Railway environment variables:\n');
  for (const [key, value] of Object.entries(envVars)) {
    console.log(`${key}=${value}`);
  }
  console.log('');
  console.log('Also set:');
  console.log('STRIPE_SECRET_KEY=sk_live_xxx');
  console.log('STRIPE_WEBHOOK_SECRET=whsec_xxx  (from Stripe webhook dashboard after registering endpoint)');
  console.log('APP_URL=https://app.florrie.ai');
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
