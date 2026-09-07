# Florrie: intelligence and promise audit, 7 September 2026

This release connects the evidence behind Today, Insights and Voice Commander, repairs ongoing client learning and makes background work easier to verify. Ellie’s login, billing exemptions, client data and messaging preferences are unchanged.

## What changed

- New `/insights` page, linked from Today and More, shows outcomes, approval counts, writing samples, client profiles, background check timestamps and business patterns. Missing reads appear as unavailable. Sampled activity is labelled.
- Voice Commander can request the same brief and priorities through a read-only tool. An Insights handoff fills an editable prompt; it does not submit a command. The model receives the evidence in its tool-result text, not merely in UI metadata.
- Client learning previously used an upsert conflict target absent from the schema. New writes use a stable tenant/client primary key, retain existing row IDs and update only derived visit fields. Same-day treatments count as one visit. Fifty due profiles per salon are refreshed per hourly pass.
- The hourly voice job checks for new human-authored writing before rebuilding. Edited drafts contribute structural style corrections after successful delivery. A learning outage does not delay or fail a sent reply. Existing measured vocabulary and contextual examples remain the main voice source; recent edits can override greeting, case, kiss and emoji habits.
- Weekly coaching runs independently of automatic replies. It uses completed bookings: no fabricated occupancy, cross-client treatment combinations or revenue forecasts presented as facts.
- Failed or pending actions no longer count as successes in agent summaries and cumulative activity totals. Daily scans retain real timestamps and are separated from completed actions. Historical activity is unchanged.
- Today priorities report partial failures and persist a dismissal before hiding it. No assumed £35 opportunity value when the price is unknown.

## Promise assessment

| Promise | Evidence and shipped behaviour | Limits / remaining proof |
| --- | --- | --- |
| Works while the app is closed | Server scheduler, persistent job ledger, leases and due-based recovery. Read-only production inspection confirmed current reminder, content, booking-confirmation and heartbeat runs. | A successful service run does not prove each message was delivered. Existing older handlers sometimes catch individual failures; UI explicitly distinguishes these checks from action outcomes. |
| Agentic, shared business context | Tool-calling voice orchestration, shared diary/client/preferences, outbound guard, background jobs. New shared brief and priorities join the same sources across surfaces. | These are coordinated services and model tools, not six independent reasoning minds. No competitive benchmark proves market superiority. |
| Learns the owner’s idiolect | Existing human-authorship filtering, measured style, screened examples, model-assisted vocabulary avoidance. Now hourly change checks and immediate saved edit hints. Production before release: 77 human samples, last built 5 September. | Quality depends on suitable writing and owner feedback. Not continuous model training or a guarantee clients cannot distinguish AI. Fewer than the minimum suitable samples retains the existing/neutral voice. |
| Learns client habits | Repaired primary-key persistence and hourly bounded refresh; actual completed visit rhythms, consistency, favourite service and average visit value. | Derived patterns are estimates, not treatment suitability judgments or a complete lifetime analysis. Launch batch limits: 500 owners; 1,000 clients and 5,000 completed appointments scanned per salon. Larger accounts need pagination before wider scale. |
| “Florrie thinks” | Owned live evidence for leads, balances, patch tests, gaps, missing prices and lapsed regulars; expiry, ranking, linked actions, persistent dismissal. Same priorities available to Voice. | Helpers for optional gap/client matching can still return no result on a source problem. Decisions that send, book or charge remain on their owning surfaces with fresh guards. |
| “Florrie does” | Outcome-labelled activity and links; verified job timestamps; completed counts exclude heartbeat checks. | Past failures stay visible as history. They are not automatically unresolved current incidents. Ledger coverage still needs a provider-by-provider reconciliation audit. |
| Useful business insights | Completed booking trend, popular days, same-client adjacent treatments, explicitly labelled service-specific price scenarios. Same calculations power weekly coaching. | No invented demand, occupancy, profit or incremental revenue. Eight-week lookback; large samples are labelled. |
| Replies and bookings | Existing channel adapters, front-desk context, appointment tools and confirmation guards. Existing behaviour tests retained. | Ellie’s automatic-reply setting was OFF before release and stays OFF. Channel connection, provider availability and approval preferences apply. No live client messages were sent as a test. |
| Rebooking and filling gaps | Existing predictive/rebook jobs, free-slot checks and shared outbound guard. Repaired client profiles can feed existing enabled workflows. | A suggestion does not prove an incremental booking. Review-request trigger was preserved rather than enabling a new outbound worker during this release. |
| Content creation and scheduled posts | Previous deployed build 742 adds photo/brief/treatment-aware drafting, explicit acceptance, schedule changes and gallery reuse; existing behaviour suite passed again. | Provider publishing is conditional on valid connection/media. No live post was published as a test. Remaining pagination/media-format backlog is separate. |
| Money and deposits | Existing Stripe and booking confirmation flows, settlement guards and reconciliation jobs. This release does not change charging. | Full provider settlement and recovery proof is a separate operational check, not established by an Insights count. |
| Guardian and client care | Existing patch-test, consultation and consent records and dedicated pages; shared priorities link to checks. | Record keeping does not certify treatment safety or replace owner review. |
| Connected inbox and existing number | Existing WhatsApp/SMS/email adapters and unified threads. | Sender eligibility and setup vary. Landing copy now states this instead of promising every number works unchanged. |
| Privacy and commercial claims | Owner-scoped reads, no raw voice examples or correction text in the brief, existing export/deletion tools. | Removed blanket compliance and unverified competitor-price/indistinguishability claims. Current commercial plan pricing was not changed in this release. |

Authoritative landing source: `frontend/public/landing.html`, the unauthenticated app destination. `landing-v2.html` and `landing/index.html` are older variants, outside this deployment path.

## Verification

- Candidate brief read against production data: 1,025 ms, all queried sources available, three live priorities. No writes or provider sends.
- Production schema accepted all new read fields and the success-only activity filter before deployment.
- 2,454 backend tests passed locally, including new visit, insight, tenant boundary, missing-source, persistence and send-versus-learning checks. The standalone PGlite SQL test is left to CI’s installed dependency.
- Full frontend build passed, including auth, loading, render and design checks. New page rendered successfully.
- More, care, content, inbox and voice browser suites passed with isolated fixtures. New Insights test covers partial evidence, failed dismissal/retry, phone overflow and editable Voice handoff. External requests are blocked.
- No login resets, subscription changes, automatic-reply changes, real client messages or social posts used in verification.

## Release and rollback

Push the verified commit to `main`, then check GitHub CI, Railway’s exact deployed commit and `/health`. Verify new job ledger runs and saved profile timestamps after their staggered starts. Add the processed iPhone build to the existing internal Team group and save release notes.

Rollback is a code revert to the preceding deployment. No schema migration is required. Derived client profiles and voice updates may remain; no appointments, clinical notes, owner permissions or historical actions are rewritten by this release.
