# Booking feedback backend handoff — 14 November 2026

Worktree: `/Users/levipither/ai-company/projects/florrie-booking-feedback-20261114`  
Branch: `codex/booking-feedback-20261114`  
Base: `61d562a3633ef30f6c48033bf063d24cc752e520`

The backend and public manage-page changes are implemented and tested locally. The initial changes are in local commit `e5dee1f`; the final payment safeguards are included in the follow-up commit. Nothing from this worktree has been pushed, deployed, or run against client records. The parent agent supplied the initial `ClientManagePage.jsx` changes; this subagent completed the frontend corrections and browser verification after ownership was handed back.

## Changes

- Initial booking confirmation now provides both the manage-booking and calendar links through SMS and the WhatsApp link follow-up. Email already provided both. Plain words follow the final WhatsApp URL so an approved-template suffix with missing whitespace cannot turn `/calendar` into `/calendarIf…`.
- Code-owned reminder copy links to booking details and preparation without promising late self-rescheduling.
- Rescheduling obeys the accepted notice period, including the exact boundary and salon timezone. A zero-hour policy stays valid. Clients can page between calendar months rather than being limited to the next 28 days; the salon's actual booking horizon still applies. Both ordinary and back-to-back slot modes use the month bounds.
- Cancelled manage links display a limited, read-only cancellation receipt within the existing link-expiry period. Cancelled links cannot reopen preparation, payment, or rescheduling actions.
- Cancellation and its notification/payment intents commit in one database transaction. A failed intent insert rolls back cancellation; an earlier cancellation by the owner cannot acquire the client's queued fee. Workers require the matching owner, appointment and committed cancellation timestamp. A five-minute worker retries failed delivery channels, preserves successful channel outcomes, and links to the correct calendar date and appointment.
- Late self-cancellation remains available. The existing fee percentage and notice period are unchanged. The calculation credits actual completed deposit and balance receipts, avoids counting deposit fields and their receipt twice, excludes assumed completion income and tips, and accounts for refund evidence. Older paid deposits with a default-zero `deposit_amount_cents` still credit the recorded `deposit_cents`. Unreadable or ambiguous payment history prevents a new charge until it can be checked.
- A separate, prospective cancellation-fee ledger preserves the agreed amount and payment request before attempting collection. Restart recovery only considers these new intents. It does not charge historic cancellations.
- Stripe recovery reuses the exact saved request and idempotency key. Unknown outcomes stop automatic creation after 23 hours; known PaymentIntents are retrieved rather than replaced. Only `succeeded` is recorded as paid. Processing, failed authentication, missing cards, declines and unresolved outcomes remain pending or need owner attention. Declines are not repeatedly charged.
- Successful payment with a failed database write is reconciled without creating a second payment or duplicate receipt.
- After cancellation commits, the HTTP receipt waits at most two seconds for the first fee outcome; slow Stripe requests continue in the background and return a truthful pending state. Push delivery does not delay the receipt. Free cancellations outside the notice period do not depend on fee-ledger reads.
- Outstanding-balance warnings use the same verified payment credit and one batched ledger read. Paid balances and ambiguous or unreadable debts are not shown as money the client owes.

Apply `supabase/migrations/20261114175653_client_cancellation_intents.sql` **before deploying this backend**. It creates a service-role-only RPC; it does not rewrite records or add columns. No additional dependencies are required. The untracked root `node_modules` symlink points to the existing launch-onboarding checkout and must not be committed.

The RPC uses the existing appointments columns from the base schema and migration 030: id, beautician_id, client_id, management_token (UUID), starts_at (timestamptz), price_cents, policy_snapshot (JSONB), status, cancelled_at and late_cancel_charged. It inserts the existing ai_actions fields, relying on migration 051's unrestricted action_type and the allowed front_desk/money employee values. Preflight these columns, constraints and the anon/authenticated/service_role roles; verify only service_role has execute permission after applying. The migration fixes search_path and uses 3-second lock and 30-second statement limits.

## Verification

- Final full backend suite: **215 files, 4,027 tests passed**, 14 November at 17:55 UTC. Log: `Codex-pa/work/florrie-headless/booking-feedback-backend-release-20261114.log`.
- **113 focused tests passed** before the final two free-cancellation/template-URL regressions, which are included in the full run. Log: `Codex-pa/work/florrie-headless/booking-feedback-payment-final-20261114.log`.
- SQL tests execute the actual migration through PGlite. They cover rerun, restricted execute privileges, token/owner checks, original-snapshot preconditions, failed-insert rollback, replay, prior owner cancellation and mismatched cancellation timestamps.
- Payment tests cover actual deposit/balance credit, restart recovery, exact request replay, processing payments, webhook races, expired idempotency keys, stale intents, missing cards, declines, payment-record repair and slow-provider responses. No real Stripe charges or messages were sent.
- Full frontend build passed with synthetic Supabase/API configuration; build log: `Codex-pa/work/florrie-headless/booking-feedback-frontend-build-20261114.log`.
- **15 new self-service browser groups passed**, plus **4 policy browser groups** after updating the zero-fee reschedule-cutoff expectation. Run after building with `npm run check:booking:self-service` from `frontend/`.
- Browser logs: `Codex-pa/work/florrie-headless/booking-feedback-browser-20261114.log` and `booking-feedback-policy-browser-20261114.log`.
- `git diff --check` passed.

## Frontend verification

The real built page was exercised on a 390px mobile viewport with all non-local network traffic blocked. Both ordinary and back-to-back availability modes can move from empty October to an offered November slot, preserving the exact wall-time string sent by the server. Checks also cover stale slot responses after closing/reopening, the latest allowed month, recovery when the starting appointment month is beyond a tightened horizon, availability retry, server cutoff/once-only conflicts, explicit remaining-fee consent, failed cancellation preserving the original booking, and a cancelled receipt with no mutation controls or private preparation data.

The UI now explains an already-used one-time move separately from the notice cutoff. Month-error bounds are consumed; an out-of-window starting month moves to the nearest valid month. Successful cancellation immediately becomes a limited receipt, so a failed follow-up read cannot erase confirmed success. Payment outcome text distinguishes collected, awaiting confirmation and salon-review states, without calling a pending payment charged. A transient initial load error offers Retry; an expired link remains unavailable.

Source: `frontend/scripts/check-booking-self-service.mjs`. The fixtures simulate reads and writes inside the browser; they never send messages, cancel real bookings or contact Stripe.

## Provider wording limitation

The approved WhatsApp `reminder_24h` template still includes “Reply if you need to reschedule.” Its fixed wording lives at Meta. The server now rejects late self-rescheduling, and code-owned SMS/email copy has been corrected. Updating that approved template needs a separate provider change; its local renderer was deliberately kept truthful to the current approved body.

## Payment references

Stripe documents that idempotency keys may be removed after at least 24 hours and that retries must use the same parameters: [Idempotent requests](https://docs.stripe.com/api/idempotent_requests). The new recovery path stops unknown-result creation retries after 23 hours.

Stripe distinguishes `processing` from `succeeded`: [PaymentIntent lifecycle](https://docs.stripe.com/payments/paymentintents/lifecycle). The implementation records payment only after `succeeded`.
