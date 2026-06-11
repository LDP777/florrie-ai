# Loyalty research, 2026-06-10

How salon and beauty loyalty actually works in the UK right now, and what Florrie should do about it.

## What the big platforms offer

- **Treatwell Rewards**: marketplace-level points, 3 points per £1 booked, 1,500 points = £10 voucher. The salon gets nothing out of it; it builds loyalty to Treatwell, not the beautician. Referral: £5 voucher each way after the friend's first completed appointment.
- **Booksy**: salon-owned points programmes with automated awarding, tiered levels (Silver/Gold/Platinum), birthday and anniversary offers, discount codes and happy-hour pricing. Aimed at shops with staff and front desks.
- **Fresha**: loyalty tools bundled into the £9.95/month per calendar plan since April 2025, points plus automated win-back messages.
- **Dedicated loyalty apps** (StampClub, Stamp Me, Perkstar, FaveCard, around £9 to £15/month): digital stamp cards in Apple/Google Wallet, automatic visit tracking, push reminders around 21 days after a visit.

## What independent lash and nail techs actually run

Mostly stamp cards, physical or digital: every 5th or 6th visit earns a free add-on (nail art, lash infill upgrade, brow wax). Referral perks are layered on top, typically a free add-on for both referrer and friend. Birthday treats are a small discount or add-on in the birthday month. The numbers that matter: top salons rebook around 69% of clients against a 40% industry average, and roughly 42% of returning clients drive 80% of revenue. The mechanic that moves rebooking is not the reward itself, it is the visible progress ("2 more visits to your free infill") plus a nudge at the natural rebook window.

## What works for a solo beautician, and what is overkill

Works:
- One simple earn rule (points per £1, or per visit) awarded automatically. Manual stamping gets forgotten.
- One clear reward with a visible threshold and progress bar.
- Surfacing the balance where decisions happen: at booking, in the client record, in reminders.
- A referral perk, because word of mouth is the main growth channel for solo techs.

Overkill for one person:
- Multi-tier ladders (Bronze to VIP) with different perks per tier.
- Points expiry rules, redemption catalogues with five reward types, wallet pass integrations.
- Anything that needs admin time per client per visit.

## Recommended mechanic set for Florrie

1. Points per £1 spent, awarded automatically when an appointment completes (already the schema's model: `points_per_pound`, `reward_threshold`, one reward).
2. One reward at one threshold, with progress shown on the client record and the loyalty page.
3. "This visit earns you points" on the public booking confirmation, so the scheme sells itself.
4. Later: referral bonus points (the `referrals` table already exists) and a birthday bonus. Skip tiers and expiry.

## Audit of the current implementation (gaps)

1. **No accrual anywhere.** Nothing in the backend ever writes to `loyalty_points`. The page says "clients earn points automatically when they visit" but no code path awards them. (Fixed in this change: completion endpoints now award points server-side, idempotently.)
2. **Loyalty.jsx is half static.** TIERS, REWARDS and EARN_RULES are hardcoded; the settings toggles are painted on and save nothing; the Members tab reads `client.loyalty_points` but the query returns rows with `points`, so it would render undefined; rows are per-transaction, not per-client.
3. **Schema mismatch in the page.** It falls back to `{ enabled, points_per_dollar }` but the table's columns are `is_active` and `points_per_pound`.
4. **Invisible elsewhere.** Clients page and public booking page showed nothing about loyalty. (Both fixed in this change.)
5. **PlanGate** wraps `/loyalty` with feature `loyalty`, which is `trial` tier, so in practice everyone has access; only `florrie_team` features are truly gated.
