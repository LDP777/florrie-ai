# PR: Audit fixes + Ellie UX

Open at: https://github.com/LDP777/florrie-ai/pull/new/claude/audit-fixes-and-ux-2026-06-16
Base: `main` ← Head: `claude/audit-fixes-and-ux-2026-06-16`

---

**Title:** Audit fixes + Ellie UX: double-charge, de-mock, cut surface, metering, webhooks

Three commits on this branch from the production audit (`docs/AUDIT_2026-06-15.md`) plus Ellie's requested UX work.

## Blocker
- No-show double-charge closed: `/api/stripe/charge-no-show` now routes through `chargePolicyFee` (idempotent + shared guard).

## High severity
- Atomic usage metering via Postgres functions (`064_atomic_metering.sql`); JS falls back to the old path until applied.
- `/api/billing/webhook`: `stripe_events` idempotency dedupe; 503-on-missing-signature changed to 400 (no Stripe flagging).
- `billMonthlySurplus`: optimistic per-row claim + revert on failure; per-boot run removed.
- Webhooks fail closed in production when the signing secret is unset (WhatsApp, Instagram, Twilio SMS).
- Consultation-form bearer token no longer logged (special-category data).
- De-mock: StaffPerformance, AutomationRules, ClientMemberships (real tables now), MultiLocation, Analytics, Campaigns, CancellationLog, PromoCodes, Reviews show real data or honest empty states.
- Dead buttons wired: rebook reminder (real endpoint), payment-link copy, Clients Message/Send Offer, WaitlistPro crash fix.
- Cut surface: hid orphan/duplicate routes, kept `/messaging`, surfaced ApprovalQueue, fixed `/import` dead link.
- BookingPage: signature field renders (typed-name e-signature).
- Onboarding: live booking-link first-win before WhatsApp; final-button bug fixed.

## Medium severity
- Cross-app honesty fixes, dead-button/unsaved-settings cleanup, reminder + webhook hardening, em-dash and iOS polish (see commit 3).

## Ellie UX
- One-tap complete + auto-advance; manual-booking overlap warning; Monzo app-load feel (launch haptic + count-up); Revenue today on Money tab; global Back button; booking-horizon setting.

## Action required after merge
- Apply `supabase/migrations/064_atomic_metering.sql` in Supabase to activate atomic metering.
