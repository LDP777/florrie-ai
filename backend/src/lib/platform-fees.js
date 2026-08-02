/**
 * Platform fee configuration for Florrie.
 *
 * Florrie takes a small cut on every payment processed through the platform.
 * This is ON TOP of Stripe's own processing fee (1.4% + 20p for UK cards).
 *
 * Example on a £10 deposit:
 *   Stripe processing: ~34p  (1.4% + 20p)
 *   Florrie platform:  ~15p  (1.5%)
 *   Beautician receives: £9.51
 *
 * The application_fee_amount goes to Florrie's Stripe account.
 * The rest (minus Stripe processing) goes to the beautician's connected account.
 */

// Platform fee: 1.5% of total payment amount
const PLATFORM_FEE_PERCENT = 1.5;

// Minimum fee in pence (even on tiny payments, we take at least 5p)
const MIN_FEE_PENCE = 5;

// Maximum fee in pence (cap so high-value treatments don't sting)
const MAX_FEE_PENCE = 500; // £5 max

/**
 * Calculate the platform fee for a given payment amount.
 * @param {number} amountCents - Total payment in pence
 * @returns {number} Fee in pence (integer, rounded up)
 */
export function calculatePlatformFee(amountCents) {
  if (!amountCents || amountCents <= 0) return 0;

  const raw = Math.ceil(amountCents * PLATFORM_FEE_PERCENT / 100);
  return Math.min(MAX_FEE_PENCE, Math.max(MIN_FEE_PENCE, raw));
}


// Stripe's own processing charge for a standard UK consumer card, per the
// header comment above: 1.4% + 20p. We cannot know the exact fee before the
// charge (EU and international cards cost more), so everywhere this figure
// surfaces it is labelled an ESTIMATE. Kept here, next to the platform fee,
// so the two numbers that make up "what comes off a payment" live together.
const STRIPE_PERCENT_ESTIMATE = 1.4;
const STRIPE_FIXED_PENCE_ESTIMATE = 20;

/**
 * Estimated Stripe processing fee for a given amount (standard UK card).
 * @param {number} amountCents - Payment in pence
 * @returns {number} Estimated fee in pence
 */
export function estimateStripeFee(amountCents) {
  if (!amountCents || amountCents <= 0) return 0;
  return Math.round(amountCents * STRIPE_PERCENT_ESTIMATE / 100) + STRIPE_FIXED_PENCE_ESTIMATE;
}

/**
 * The application_fee_amount every destination charge must use.
 *
 * WHY both parts: client payments are destination charges, created on the
 * platform account with transfer_data to the beautician. Stripe takes its
 * processing fee from the PLATFORM, not from the beautician. If the
 * application fee only recovered Florrie's 1.5% cut, every booking would
 * lose money (on a GBP 10 deposit: collect 15p, pay Stripe ~34p, net
 * MINUS 19p). That exact leak put the platform balance in arrears, so the
 * application fee is Florrie's cut PLUS the estimated Stripe processing
 * fee. The Settings explainer already tells the beautician she pays both.
 *
 * The Stripe part is an ESTIMATE (standard UK card). International and
 * premium cards cost more; the platform absorbs that sliver rather than
 * over-charging the beautician on every domestic payment.
 *
 * Capped at the charge amount itself because Stripe rejects an
 * application_fee_amount greater than the charge.
 *
 * @param {number} amountCents - Charge amount in pence
 * @returns {number} application_fee_amount in pence
 */
export function totalApplicationFee(amountCents) {
  if (!amountCents || amountCents <= 0) return 0;
  const amount = Math.round(amountCents);
  return Math.min(amount, calculatePlatformFee(amount) + estimateStripeFee(amount));
}

/**
 * Fee preview for the app: everything needed to say "you receive about
 * £X after fees" BEFORE a charge is made. The two parts here sum to
 * totalApplicationFee (bar the tiny-amount cap), which is exactly what the
 * charge paths deduct, so the preview can never drift from what is actually
 * taken: her net really is amount minus platform fee minus Stripe estimate.
 * The `model` constants let the app preview a custom typed amount without a
 * round trip per keystroke.
 */
export function feePreview(amountCents) {
  const amount = Number.isFinite(amountCents) && amountCents > 0 ? Math.round(amountCents) : 0;
  const platform = calculatePlatformFee(amount);
  const stripeEst = estimateStripeFee(amount);
  return {
    amount_cents: amount,
    platform_fee_cents: platform,
    estimated_stripe_fee_cents: stripeEst,
    estimated_net_cents: Math.max(0, amount - platform - stripeEst),
    model: {
      platform_percent: PLATFORM_FEE_PERCENT,
      platform_min_cents: MIN_FEE_PENCE,
      platform_max_cents: MAX_FEE_PENCE,
      stripe_percent_estimate: STRIPE_PERCENT_ESTIMATE,
      stripe_fixed_cents_estimate: STRIPE_FIXED_PENCE_ESTIMATE,
    },
  };
}

/**
 * Return a human-readable fee description for the beautician.
 * Used in settings/onboarding to explain what Florrie charges.
 */
export function getFeeDescription() {
  return {
    percent: PLATFORM_FEE_PERCENT,
    min_pence: MIN_FEE_PENCE,
    max_pence: MAX_FEE_PENCE,
    summary: `${PLATFORM_FEE_PERCENT}% per transaction (min ${MIN_FEE_PENCE}p, max £${(MAX_FEE_PENCE / 100).toFixed(2)})`,
    stripe_note: 'Stripe processing fees (1.4% + 20p for UK cards) are charged separately by Stripe.',
  };
}
