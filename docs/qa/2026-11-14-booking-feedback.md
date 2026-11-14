# Booking feedback backend handoff — 14 November 2026

Worktree: `/Users/levipither/ai-company/projects/florrie-booking-feedback-20261114`  
Branch: `codex/booking-feedback-20261114`  
Base: `61d562a3633ef30f6c48033bf063d24cc752e520`

The backend and public manage-page changes are implemented and tested locally. Nothing from this worktree has been committed, pushed, deployed, or run against client records. The parent agent supplied the initial `ClientManagePage.jsx` changes; this subagent completed the frontend corrections and browser verification after ownership was handed back.

## Changes

- Initial booking confirmation now provides both the manage-booking and calendar links through SMS and the WhatsApp link follow-up. Email already provided both.
- Code-owned reminder copy links to booking details and preparation without promising late self-rescheduling.
- Rescheduling obeys the accepted notice period, including the exact boundary and salon timezone. A zero-hour policy stays valid. Clients can page between calendar months rather than being limited to the next 28 days; the salon's actual booking horizon still applies. Both ordinary and back-to-back slot modes use the month bounds.
- Cancelled manage links display a limited, read-only cancellation receipt within the existing link-expiry period. Cancelled links cannot reopen preparation, payment, or rescheduling actions.
- Cancellation notifications are recorded before changing the appointment. A five-minute worker retries failed delivery channels, preserves successful channel outcomes, and links to the correct calendar date and appointment.
- Late self-cancellation remains available. The existing fee percentage and notice period are unchanged. The calculation credits the recorded deposit actually paid; a fully paid appointment has no remaining fee.
- A separate, prospective cancellation-fee ledger preserves the agreed amount and payment request before attempting collection. Restart recovery only considers these new intents. It does not charge historic cancellations.
- Stripe recovery reuses the exact saved request and idempotency key. Unknown outcomes stop automatic creation after 23 hours; known PaymentIntents are retrieved rather than replaced. Only `succeeded` is recorded as paid. Processing, failed authentication, missing cards, declines and unresolved outcomes remain pending or need owner attention. Declines are not repeatedly charged.
- Successful payment with a failed database write is reconciled without creating a second payment or duplicate receipt.

No database migration or additional dependencies are required. The untracked root `node_modules` symlink points to the existing launch-onboarding checkout and must not be committed.

## Verification

- Full backend suite: **213 files, 3,993 tests passed**, 14 November at 17:23 UTC.
- After the final fee-status wording/logging refinement: **50 focused cancellation-fee and reschedule tests passed**.
- `git diff --check` passed.
- Full backend log: `Codex-pa/work/florrie-headless/booking-feedback-backend-20261114.log`.
- Full frontend build passed with synthetic Supabase/API configuration; build log: `Codex-pa/work/florrie-headless/booking-feedback-frontend-build-20261114.log`.
- **15 new self-service browser groups passed**, plus the **4 existing policy browser groups** after updating the zero-fee reschedule-cutoff expectation. Run after building with `npm run check:booking:self-service` from `frontend/`.
- Browser logs: `Codex-pa/work/florrie-headless/booking-feedback-browser-20261114.log` and `booking-feedback-policy-browser-20261114.log`.
- The fee suite passed **12 tests** after adding an explicit regression that `payment_type=full` without actual paid evidence does not credit an unpaid appointment.

New tests cover cutoff/timezone boundaries, month paging, stale horizon input, cancelled receipts, repeat cancellation, durable delivery, partial channel retries, actual deposit credit, restart recovery, exact request replay, processing payments, webhook races, expired idempotency keys, stale intents, missing cards, declines and payment-record repair. No real Stripe charges or messages were sent.

## Frontend verification

The real built page was exercised on a 390px mobile viewport with all non-local network traffic blocked. Both ordinary and back-to-back availability modes can move from empty October to an offered November slot, preserving the exact wall-time string sent by the server. Checks also cover stale slot responses after closing/reopening, the latest allowed month, recovery when the starting appointment month is beyond a tightened horizon, availability retry, server cutoff/once-only conflicts, explicit remaining-fee consent, failed cancellation preserving the original booking, and a cancelled receipt with no mutation controls or private preparation data.

The UI now explains an already-used one-time move separately from the notice cutoff. Month-error bounds are consumed; an out-of-window starting month moves to the nearest valid month. Successful cancellation immediately becomes a limited receipt, so a failed follow-up read cannot erase confirmed success. Payment outcome text distinguishes collected, awaiting confirmation and salon-review states, without calling a pending payment charged. A transient initial load error offers Retry; an expired link remains unavailable.

Source: `frontend/scripts/check-booking-self-service.mjs`. The fixtures simulate reads and writes inside the browser; they never send messages, cancel real bookings or contact Stripe.

## Provider wording limitation

The approved WhatsApp `reminder_24h` template still includes “Reply if you need to reschedule.” Its fixed wording lives at Meta. The server now rejects late self-rescheduling, and code-owned SMS/email copy has been corrected. Updating that approved template needs a separate provider change; its local renderer was deliberately kept truthful to the current approved body.

## Payment references

Stripe documents that idempotency keys may be removed after at least 24 hours and that retries must use the same parameters: [Idempotent requests](https://docs.stripe.com/api/idempotent_requests). The new recovery path stops unknown-result creation retries after 23 hours.

Stripe distinguishes `processing` from `succeeded`: [PaymentIntent lifecycle](https://docs.stripe.com/payments/paymentintents/lifecycle). The implementation records payment only after `succeeded`.
