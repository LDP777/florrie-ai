# Fresh-salon launch rehearsal, 16 September 2026

Baseline: `6be2c94`. This rehearsal used local HTTP servers, React components, synthetic accounts and mocked providers. It made no production writes, real payments, emails, messages or push sends. The production-default Playwright E2E suite was not run: its default API/slug point at Ellie’s business.

## Repaired during the rehearsal

- Setup now saves the treatment list in one database request with stable row IDs. A retry after a lost response updates the same records. The old loop could save one treatment, fail on another and duplicate the first on retry. The browser regression exercises two treatments, a lost response, retry and page reload; both prices and the count remain correct.
- Setup rejects missing or reversed opening/closing times. The owner stays on Hours and can correct the input.
- Stripe Connect saves the account reference before returning its onboarding link. It checks database errors and protects a connection another request has attached. Concurrent/retried creation requests share a provider idempotency key. Existing connected accounts keep their current path.

Stripe can prune idempotency keys after at least 24 hours. This repair covers immediate retries and concurrent requests; it does not claim durable recovery of an orphaned Stripe account after an extended database outage. A saved account reference avoids that path on normal subsequent requests. See [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests).

## Results and remaining proof

| Area | Local result | External/device result still needed |
| --- | --- | --- |
| New web signup | Real Login UI calls signup and waits on verification when no session exists. Server profile/welcome and duplicate-account boundaries pass existing tests. | Ordinary signup to an owner-controlled unused mailbox; receive and open confirmation; verify one profile and correct first-run setup. The existing demo was admin-provisioned, so it does not prove this. |
| Password reset | Real UI uses the reset return path; rejects mismatched passwords and submits a corrected one. Existing native callback tests pass one-time exchange and route handling. | Receive actual reset email, follow the link, change password and sign in from web and iPhone. |
| Business/services/hours | Rejected business save stays editable. Two priced treatments survive ambiguous save/retry/reload without duplication. Invalid hours cause no write; corrected hours save. | Normal authenticated database save under production RLS, using a separate salon. Source RLS has own-row insert/update policies; no migration required. |
| Stripe Connect | Seven new HTTP regressions prove persistence failure, retry, concurrent first setup, changed connection, stale-reference failure, salon isolation and existing account reuse. | Separate Stripe sandbox account completes hosted onboarding. No test-mode provider credential or isolated environment was established in this task; no live credential was substituted. |
| Public booking/deposit | Existing tests pass checkout failure honesty, deposit settings, verified-client ownership and phone collision recovery. | Test-mode Checkout in the isolated environment, successful and declined payment, signed webhook and browser return. |
| Confirmed-booking alert | Existing HTTP/service tests pass webhook/redirect races, unpaid completion, delayed payment success, APNs-only delivery, failed delivery retry, cancelled-booking protection and one-time money recording. | Physical iPhone with demo salon token: exactly one confirmed-booking alert after sandbox deposit; distinguish pending-deposit alert; tap opens correct appointment. Fixture transport success does not prove APNs delivery. |
| Reschedule | Existing tests pass policy rules, closed-day rejection, paid-move recovery and conflict/refund cases. | Move the isolated paid booking from its manage link; confirm diary time, amount and exactly one customer confirmation with owner-approved test recipient. |
| Session/reload | Real browser checks pass stale-chunk one-reload recovery, preserved auth/drafts, Today timeout/retry and duplicate native callback handling. | Cold/warm TestFlight launch, Wi-Fi/mobile transition, background return, expired-session refresh and provider browser handoff on a physical iPhone. |
| Booking care | Separate agent owns the approved 48-hour staged care release. | Do not treat these tests as proof of that separately integrated release. |
| Instagram/WhatsApp | Existing local browser checks pass failure, retry, callback order, cancellation, stale secret, untrusted origin and disabled rollout. | Parent owns Meta review. WhatsApp still needs the spare verification-capable number and complete device round trip. |

Validation: all **2,601 backend tests in 157 files passed** with `TZ=UTC`; the full frontend build passed. `check:channels` (now including the fresh-setup rehearsal), native auth UI, browser chunk recovery and Today loading checks passed. The usual deferred spreadsheet chunk-size warning remains. No dependency install or schema migration was needed.

## App Store claim inventory

- Calendar, Today, client records/history, notes, connected-channel Inbox, deposits/payment records, expenses, consultation responses, patch tests and photo permissions have implemented screens and backing routes. Use fictional records for screenshots.
- Content draft creation, caption editing, owner approval/scheduling and Instagram publication exist. Instagram eligibility and permission review affect new accounts; do not advertise universal onboarding before review succeeds.
- The voice assistant proposes booking, rescheduling, cancellation, sends, expenses and setting changes for owner confirmation. Read-only tools can answer directly. A listing must not promise silent execution of any spoken instruction.
- Voice-profile learning uses a filtered, name-masked corpus and owner corrections. This supports tone-adaptation wording, not a claim that a model trains itself continually or becomes the best assistant in the market.
- Receipt scanning prefills expense details through AI and allows review. A client before/after photo capture/gallery workflow is not established by the PhotoConsent page; remove that claim unless a separate working flow is demonstrated.
- Opening/closing checklists exist in `DailyChecklist.jsx`; avoid promising an automatic end-of-day close. Long-press calendar movement needs exact-build device proof.
- Code still carries £29/month and 120 included messages, but this task did not verify the current Stripe price. Omit prices from the native listing.
- Native email signup is hidden; federated auth may create an account. Avoid describing the app as a strictly existing-account-only companion. Do not advertise a web purchase instruction inside the iPhone listing.
- Optional PostHog analytics/replay are disabled in current code; the September 6 audit’s description of active replay is stale. Diagnostics are separate and still need accurate privacy declarations.

Account deletion exists in Settings → Account → Delete account, requires confirmation plus `DELETE`, then uses `DELETE /api/auth/account` and the durable `/account-deletion` progress screen. Pending payment/provider cleanup can prevent immediate completion; do not promise universal instant erasure.

## Separate AI permission gap

Current privacy copy names Anthropic, but the owner flow has no explicit named-provider AI permission, versioned consent record or common gate before sending data. Generic Terms/Privacy text and autonomy switches do not establish that permission. Calls span voice, content, receipt OCR, classifiers, drafting and background tone/insight jobs. The parent is handling this blocker. A future consent gate must preserve diary/client/payment access and cover both foreground and background calls.
