import { describe, it, expect } from 'vitest';
import { calculatePlatformFee, estimateStripeFee, feePreview } from '../../src/lib/platform-fees.js';

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

  it('preview of a zero or invalid amount is all zeros, never negative', () => {
    for (const bad of [0, -50, NaN, undefined]) {
      const f = feePreview(bad);
      expect(f.platform_fee_cents).toBe(0);
      expect(f.estimated_stripe_fee_cents).toBe(0);
      expect(f.estimated_net_cents).toBe(0);
    }
  });
});
