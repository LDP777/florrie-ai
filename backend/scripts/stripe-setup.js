#!/usr/bin/env node
/**
 * stripe-setup.js — Creates Florrie subscription products and prices in Stripe.
 *
 * Run once against your Stripe account:
 *   STRIPE_SECRET_KEY=sk_test_xxx node scripts/stripe-setup.js
 *
 * Then copy the output price IDs into your Railway env vars.
 *
 * Products created:
 *   - Florrie Starter (£39/mo, £390/yr)
 *   - Florrie Pro     (£59/mo, £590/yr)
 *   - Florrie Team    (£89/mo, £890/yr)
 */

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PLANS = [
  {
    name: 'Florrie Starter',
    envKey: 'STARTER',
    monthly: 3900,  // £39.00
    annual: 39000,  // £390.00
    features: ['50 clients', 'Online booking', 'SMS reminders', 'Receipt scanning', 'Basic reports'],
  },
  {
    name: 'Florrie Pro',
    envKey: 'PRO',
    monthly: 5900,  // £59.00
    annual: 59000,  // £590.00
    features: ['Unlimited clients', 'AI Front Desk', 'WhatsApp automation', 'Smart Schedule', 'Content Autopilot', 'Full analytics'],
  },
  {
    name: 'Florrie Team',
    envKey: 'TEAM',
    monthly: 8900,  // £89.00
    annual: 89000,  // £890.00
    features: ['Everything in Pro', 'Multi-location', 'Staff rota & KPIs', 'Up to 10 team members', 'Priority support'],
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
  console.log('Also ensure these are set:');
  console.log('STRIPE_SECRET_KEY=sk_live_xxx (or sk_test_xxx for testing)');
  console.log('STRIPE_WEBHOOK_SECRET=whsec_xxx');
  console.log('APP_URL=https://florrie-ai-frontend.vercel.app');
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
