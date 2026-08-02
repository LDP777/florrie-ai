import { describe, it, expect } from 'vitest';
import { calculatePlatformFee, estimateStripeFee, totalApplicationFee, feePreview } from '../../src/lib/platform-fees.js';

// The fee preview shown to Ellie BEFORE a charge must use the same maths as
// the charge paths, or the "you receive about" line would lie. These pin the
// documented model: Florrie 1.5% (min 5p, max £5) + Stripe est. 1.4% + 20p.
describe('platform fees', () => {
  it('takes 1.5% with a 5p floor and a £5 cap', () => {
    expect(calculatePlatformFee(1000)).toBe(15);    // £10 -> 15p
    expect(calculatePlatformFee(100)).toBe(5);      // £1 -> floor 5p
    expect(calculatePlatformFee(100000)).toBe(500); // £1000 -> capped at £5
    expect(calculatePlatformFee(0)).toBe(0);
  });

  it('estimates Stripe at 1.4% + 20p for UK cards', () => {
    expect(estimateStripeFee(1000)).toBe(34);  // the £10 example in the header comment
    expect(estimateStripeFee(0)).toBe(0);
  });

  it('preview nets off both fees and matches the £10 worked example', () => {
    const f = feePreview(1000);
    expect(f.platform_fee_cents).toBe(15);
    expect(f.estimated_stripe_fee_cents).toBe(34);
    expect(f.estimated_net_cents).toBe(951);  // "Beautician receives: £9.51"
  });

  it('exposes the model constants the app mirrors client-side', () => {
    const m = feePreview(1000).model;
    expect(m.platform_percent).toBe(1.5);
    expect(m.platform_min_cents).toBe(5);
    expect(m.platform_max_cents).toBe(500);
    expect(m.stripe_percent_estimate).toBe(1.4);
    expect(m.stripe_fixed_cents_estimate).toBe(20);
  });


  // On destination charges the platform pays Stripe's processing fee, so the
  // application fee must be Florrie's cut PLUS the Stripe estimate. Charging
  // only the 1.5% cut is how the platform balance went into arrears: a GBP 10
  // deposit collected 15p but cost ~34p in processing, minus 19p per booking.
  it('totalApplicationFee recovers the Stripe estimate on top of the platform cut', () => {
    expect(totalApplicationFee(1000)).toBe(49);   // £10 deposit: 15p Florrie + 34p Stripe
    expect(totalApplicationFee(10000)).toBe(310); // £100: £1.50 Florrie + £1.60 Stripe
  });

  it('totalApplicationFee never exceeds the charge amount itself', () => {
    // Stripe rejects application_fee_amount above the charge, so tiny amounts
    // cap at the amount and the platform eats the shortfall.
    expect(totalApplicationFee(10)).toBe(10); // 10p charge: 5p + 20p estimate would exceed it
    for (const amount of [10, 50, 100, 1000, 10000, 100000]) {
      expect(totalApplicationFee(amount)).toBeLessThanOrEqual(amount);
    }
  });

  it('totalApplicationFee is zero for zero or invalid amounts', () => {
    for (const bad of [0, -50, NaN, undefined]) {
      expect(totalApplicationFee(bad)).toBe(0);
    }
  });

  it('preview parts sum to the application fee actually taken', () => {
    // Preview shows platform + stripe separately; the charge paths deduct
    // totalApplicationFee. They must agree or the preview lies to her.
    for (const amount of [1000, 3500, 10000, 100000]) {
      const f = feePreview(amount);
      expect(f.platform_fee_cents + f.estimated_stripe_fee_cents).toBe(totalApplicationFee(amount));
      expect(f.estimated_net_cents).toBe(amount - totalApplicationFee(amount));
    }
  });

  it('preview of a zero or invalid amount is all zeros, never negative', () => {
    for (const bad of [0, -50, NaN, undefined]) {
      const f = feePreview(bad);
      expect(f.platform_fee_cents).toBe(0);
      expect(f.estimated_stripe_fee_cents).toBe(0);
      expect(f.estimated_net_cents).toBe(0);
    }
  });
});
