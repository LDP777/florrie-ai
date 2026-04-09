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
