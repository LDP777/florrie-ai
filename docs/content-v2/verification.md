# Content v2 verification

Built on branch `content-v2` from main `d49b083`. All browser and database fixtures use fictional salons. Provider requests are intercepted. No production migration, flag change, post, booking change or client message was made.

## Automated results

| Check | Result |
| --- | --- |
| Backend Vitest suite | 4,558 tests passed across 257 files |
| Frontend production build | Passed, including existing primitive, icon, copy, render and other build guards |
| Chromium and WebKit | 26 grouped journeys passed at 320 x 568, 375 x 667, 390 x 844 and 430 x 932 |
| Accessibility | No axe WCAG A/AA violations on home, deck, change sheet, item sheet and first visit in either engine |
| Navigation, request handling and image sharing | 21 Node tests passed |
| Artwork | Server renderer tests and browser PNG geometry, fonts, full-photo preservation and error checks passed |
| Migration | PGlite runs the additive migration twice; existing drafts and approvals survive, hashes match Node, RLS and flag protection hold |
| Existing thoughtful-time SQL checks | Passed |
| Lockfile consistency | Mac/Linux binaries and workspace/standalone manifests pass |
| iOS | Capacitor sync and unsigned Release build for `iphoneos` passed with Xcode |

The five-tap journey checks three posts without typing or scrolling. Additional journeys cover photo-only and words-only changes, Undo, saved deck position, preparation reload, fact changes, withdrawn permission, reconnect, failed publishing, manual posting, privacy, autosave conflicts and exact-post handoffs. The test session deliberately omits `auth_id` from the owner profile, matching the public backend response.

Backend tests cover resumable preparation, owner isolation, source-column validation, exact-version approval, changed prices and times, consent withdrawal, learned voice rules, provider idempotency, lost-response reconciliation, reconnect, approved offer terms and measured versus inferred bookings. An approved post with no material hash cannot bypass the v2 publisher.

## Code review

| Area | Assessment |
| --- | --- |
| Security | Owner-scoped routes, service-only new tables, protected feature flag, salon-owned image paths and claim-bound publishing are covered by tests. |
| Correctness | Approval is invalidated when material content changes. An uncertain provider response keeps its claim until reconciled. Saved preparation steps retain their post IDs after interruption. |
| Performance | Preparation and publishing use bounded worker batches; browser polling runs only when needed. Artwork uses bundled fonts with a dedicated cache. |
| Maintainability | Existing availability, voice, consent and attribution services remain the source of truth. The old page remains behind the flag for rollback. |

## Real iPhone checks still open

The user chose to continue with automated checks while the Mac was locked. The unsigned build proves compilation, not a physical-device journey or TestFlight distribution. Before pilot rollout, check Safari and a newly archived native build on a real iPhone: safe areas, sticky actions above the home indicator, 16px inputs, close/reopen persistence, reconnect handoff and Save Image. Meta Advanced Access, salon connections and optional Google API access also remain rollout checks, as described in [README](README.md).

## Screenshots

These are the implemented app at 390 x 844, using the supplied fictional salon artwork. Both engines are included. The preview source and fake provider are excluded from the PR.

| State | Chromium | WebKit |
| --- | --- | --- |
| Home | [01](screens/chromium-01-home.png) | [01](screens/webkit-01-home.png) |
| Review | [02](screens/chromium-02-review-1.png) | [02](screens/webkit-02-review-1.png) |
| Checked facts | [02 facts](screens/chromium-02-review-1-facts.png) | [02 facts](screens/webkit-02-review-1-facts.png) |
| Change | [04](screens/chromium-04-change-sheet.png) | [04](screens/webkit-04-change-sheet.png) |
| Less salesy | [06](screens/chromium-06-less-salesy.png) | [06](screens/webkit-06-less-salesy.png) |
| Done | [07](screens/chromium-07-done.png) | [07](screens/webkit-07-done.png) |
| Home after approval | [08](screens/chromium-08-home-after.png) | [08](screens/webkit-08-home-after.png) |
| Changed fact | [10](screens/chromium-10-fact-changed-review.png) | [10](screens/webkit-10-fact-changed-review.png) |
| Permission withdrawn | [11](screens/chromium-11-permission-withdrawn.png) | [11](screens/webkit-11-permission-withdrawn.png) |
| Failed | [14](screens/chromium-14-failed.png) | [14](screens/webkit-14-failed.png) |
| Signed out | [15](screens/chromium-15-signed-out.png) | [15](screens/webkit-15-signed-out.png) |
| Privacy | [18](screens/chromium-18-privacy.png) | [18](screens/webkit-18-privacy.png) |
| First visit | [19](screens/chromium-19-first-visit.png) | [19](screens/webkit-19-first-visit.png) |
| Preparing | [20](screens/chromium-20-preparing.png) | [20](screens/webkit-20-preparing.png) |
| Reel plan | [22](screens/chromium-22-reel-plan.png) | [22](screens/webkit-22-reel-plan.png) |
| Results | [23](screens/chromium-23-results.png) | [23](screens/webkit-23-results.png) |
| Offers | [24](screens/chromium-24-offers.png) | [24](screens/webkit-24-offers.png) |
| Voice | [25](screens/chromium-25-voice.png) | [25](screens/webkit-25-voice.png) |
