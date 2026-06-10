# Florrie frontend surface cut list, 2026-06-10

Evidence base: `frontend/src/App.jsx` (routes, warm list, PlanGate), `frontend/src/pages/More.jsx` (the catalogue), grep of inbound `navigate()`/`Link` references across pages and components, line counts, `FRONTEND_AUDIT_2026-04-05.md` (real vs mock API), and `docs/DEAD_CODE_AUDIT_2026-05-28.md` (reachability audit). Backend route files verified present in `backend/src/routes/` on main. No code was changed.

## A. Summary

**83 page files. 15 are the product. 21 stay as cheap plumbing. 4 fold into other pages. 36 get parked out of nav. 7 are dead and safe to remove.**

| Class | Count | Approx LOC |
|---|---|---|
| CORE | 15 | ~17,100 |
| KEEP-CHEAP | 21 | ~11,700 |
| MERGE | 4 | ~1,500 |
| PARK | 36 | ~15,400 |
| DELETE | 7 | ~2,700 |
| **Total** | **83** | **~48,400** |

Current nav: bottom tabs Today / Inbox / Florrie (voice) / Content / Money, plus a floating More pill opening the full catalogue. Parking means removing a page's entry from `More.jsx` while keeping its route mounted, so deep links and cross-links keep working with zero risk.

Bonus finding: `frontend/src/pages/` contains an accidental snapshot of the whole repo from Mar 29 (`backend/`, `docs/`, `shared/`, `supabase/`, `DEPLOY.md`, `package.json`, `package-lock.json`, ~650KB). It is untracked by git, local cruft only. Safe to delete from disk whenever.

## B. CORE (15)

| Page | Route | Why it is the product |
|---|---|---|
| Hub.jsx | `/`, `/today`, `/calendar`, `/calendar/week`, `/smart-schedule` | Florrie thinks + What Florrie did, the agent loop's face |
| CalendarView.jsx | embedded in Hub Week tab | The diary; real bookings, Stripe no-show charging |
| Inbox.jsx | `/inbox` | Bottom-nav tab; every client message, the agent's main channel |
| Clients.jsx | `/clients` | Client directory and detail; the data the agent learns from |
| MoneyTracker.jsx | `/money` | Bottom-nav tab; money pulse, tax summary |
| ContentAutopilot.jsx | `/content` | Bottom-nav tab; gated, but primary nav real estate |
| VoiceCommander.jsx | `/voice` | Centre petal "Talk to Florrie"; the command interface |
| Settings.jsx | `/settings` | Account, Stripe Connect, calendar feed, channel cards |
| WhatsAppConfig.jsx | `/whatsapp` | The pilot's live channel; embedded signup, status, health |
| WhatsAppTemplates.jsx | `/whatsapp/templates` | Template pack; just rebuilt (cbc2926) |
| SMSConfig.jsx | `/sms` | Second channel; config, test send, usage meter |
| BookingPage.jsx | `/book/:slug` | The public revenue door |
| ClientManagePage.jsx | `/book/:slug/manage/:token` | Magic-link reschedule/cancel; closes the booking loop |
| More.jsx | `/more` | The nav itself; everything secondary routes through it |
| Onboarding.jsx | `/onboarding` | First-run; gates every new account |

## C. KEEP-CHEAP (21)

Real APIs, reachable, low churn. Leave alone, fix only when broken.

Auth and legal (8): **Login** (`/login`), **UpdatePassword** (`/update-password`), **TermsPage** (`/terms`), **PrivacyPage** (`/privacy` authed), **PrivacyPolicy** (`/privacy` public), **DataDeletionPage** (`/data-deletion`, Meta App Review requirement), **Support** (`/support`, public), **NotFound** (catch-all). Mostly static, ~1,400 LOC combined.

Operational (13):

| Page | Route | Why keep |
|---|---|---|
| SmartSchedule.jsx | Hub sub-tab | Embedded in Today; gated; works |
| Treatments.jsx | `/treatments` | Service catalogue; BookingPage depends on it |
| HoursExceptions.jsx | `/hours` | Write target of the bank-holiday proactive card |
| BusinessProfile.jsx | `/business` | Name/logo feed the booking page; real saves |
| Policies.jsx | `/policies` | Cancellation terms shown to clients; real table |
| Pricing.jsx | `/pricing` | Upgrade flow; PlanGate links here; iOS-stripped already |
| ClientImport.jsx | `/import` | CSV migrate; how every new pilot gets data in |
| ConsultationFormBuilder.jsx | `/consultation-forms` | Real CRUD API; compliance feature |
| ConsultationFormPublic.jsx | `/form/:token` | Public form submission; pairs with builder |
| PatchTests.jsx | `/patch-tests` | UK compliance; real table; beauty-niche differentiator |
| Analytics.jsx | `/analytics` | Redirect target of /digest, /reports, /treatment-stats; real data |
| Expenses.jsx | `/expenses` | Feeds tax summary in Money; real tables |
| Integrations.jsx | `/integrations` | Real connection state since commit 34ed2dc |

## D. MERGE (4)

| Page | LOC | Fold into | Evidence |
|---|---|---|---|
| Messaging.jsx (`/messaging`) | 341 | Settings (Alerts tab already has the Messaging channels card) | Thin tab wrapper that imports WhatsAppConfig + SMSConfig wholesale. Inbound: More, Integrations:235, Clients:281 (bulk send). Re-point Clients bulk send to Inbox compose, keep `/messaging` as a redirect to `/settings` |
| ClientTimeline.jsx (`/client-timeline`) | 352 | Clients detail view | Only inbound outside More-era surfaces is ClientIntelDashboard:325. Real fetchRows (appointments, clients), same data Clients already loads |
| ClientIntelDashboard.jsx (`/client-intel`) | 461 | Clients (header stats strip) | In More "AI team" but it is a stats wrapper plus quick links to /churn, /segments, /memberships, /tags. Real fetchRows |
| Compliance.jsx (`/compliance`) | 300 | PatchTests (summary tiles at top) | Umbrella that reads patch_tests + consultation_forms and links to the two real pages. Duplicate layer over the More "Compliance" category |

Merges are the only class needing real work (~half a day each). Do them after the free wins, or downgrade any of them to PARK if not worth it.

## E. PARK (36)

Action per page: delete its line(s) in `More.jsx` CATEGORIES. Route stays mounted in App.jsx, so existing deep links and cross-links (ClientIntelDashboard quick actions, ClientSegments to /campaigns, Compliance links) keep working. Zero deletions, one file touched.

All of these have real Supabase/fetch calls (per the 2026-04-05 audit and fresh grep) except the two marked compute-only, which read real rows but persist nothing. "Inbound" counts references outside More.jsx/SpotlightSearch/App.jsx routes.

| Page | Route | Inbound | LOC | Note |
|---|---|---|---|---|
| AIInsights.jsx | `/ai-insights` | 1 (More dup) | 339 | Gated; Hub suggestion cards cover the value |
| AddOns.jsx | `/addons` | 0 | 405 | |
| Aftercare.jsx | `/aftercare` | 0 | 813 | Gated |
| AppointmentNotes.jsx | `/notes` | 0 | 350 | |
| AutomationRules.jsx | `/automations` | 0 | 608 | /sequences redirect kept |
| Campaigns.jsx | `/campaigns` | 2 | 601 | Gated; linked from ClientSegments (also parked) |
| CancellationLog.jsx | `/cancellations` | 0 | 341 | |
| ChurnPrevention.jsx | `/churn` | 3 | 385 | Gated; links from ClientIntelDashboard |
| ClientMemberships.jsx | `/memberships` | 1 | 281 | |
| ClientPortal.jsx | `/portal` | 0 | 354 | Magic-link admin; BookingPage itself unaffected |
| ClientSegments.jsx | `/segments` | 2 | 379 | Compute-only (local RFM, no persistence) |
| ClientTags.jsx | `/tags` | 1 | 456 | |
| DailyChecklist.jsx | `/checklist` | 1 | 1047 | |
| DemandForecast.jsx | `/demand` | 0 | 455 | Already absent from More; compute-only. Cheapest possible park |
| DepositTracker.jsx | `/deposits` | 0 | 319 | |
| EndOfDay.jsx | `/end-of-day` | 0 | 499 | |
| GiftVouchers.jsx | `/vouchers` | 0 | 654 | |
| Loyalty.jsx | `/loyalty` | 0 | 419 | Gated |
| MessageTemplates.jsx | `/templates` | 0 | 351 | WhatsAppTemplates covers the live channel |
| MultiLocation.jsx | `/locations` | 0 | 287 | Gated; zero multi-branch users |
| Notifications.jsx | `/notifications` | 1 | 258 | |
| Packages.jsx | `/packages` | 0 | 645 | Courses; pairs with TrainingBooking |
| PhotoConsent.jsx | `/photo-consent` | 0 | 417 | Real API; resurface when a pilot asks |
| Portfolio.jsx | `/portfolio` | 0 | 380 | |
| PriceList.jsx | `/price-list` | 0 | 497 | |
| ProductInventory.jsx | `/inventory` | 0 | 386 | |
| PromoCodes.jsx | `/promos` | 0 | 461 | |
| RebookReminders.jsx | `/rebook` | 0 | 557 | |
| Referrals.jsx | `/referrals` | 0 | 495 | |
| RevenueGoals.jsx | `/goals` | 0 | 327 | |
| Reviews.jsx | `/reviews` | 1 | 400 | |
| StaffPerformance.jsx | `/staff-performance` | 0 | 264 | Gated; solo-founder pilot has no staff |
| StaffRota.jsx | `/rota` | 0 | 546 | Gated |
| Team.jsx | `/team` | 0 | 435 | Gated |
| TrainingBooking.jsx | `/training/:slug/:courseId` | public | 406 | Public route, not in More anyway; parks with Packages |
| WaitlistPro.jsx | `/waitlist-pro` | 0 | 546 | /waitlist redirect kept |

## F. DELETE (7 pages + 3 components + local cruft)

All confirmed unreachable from the live IA. Sole inbound for four of them is `components/SpotlightSearch.jsx`, which is itself only imported by Dashboard. Matches the 2026-05-28 dead-code audit verdicts exactly; nothing has re-linked them since (fresh grep today).

| Page | LOC | Route to remove | App.jsx lines to touch | Why safe |
|---|---|---|---|---|
| Dashboard.jsx | 851 | `/dashboard` | import L16, route L333 | Pre-sprint landing; zero inbound; Hub replaced it |
| Escalations.jsx | 409 | `/escalations` | import L18, route L337, warm-list L181 | Only SpotlightSearch links here; SuggestionCards cover it |
| ApprovalQueue.jsx | 340 | `/approval-queue` | import L19, route L338 | Only SpotlightSearch; approval = Yes/No/Tweak cards now |
| APISettings.jsx | 214 | `/api-settings` | import L92, route L408 | Only SpotlightSearch; no salon-owner use case |
| Feedback.jsx | 392 | `/feedback` | import L57, route L371 | Zero inbound anywhere |
| WeeklyDigest.jsx | 301 | none mounted | import L34 only | Import with no Route; /digest already redirects to /analytics |
| CommsLog.jsx | 221 | none mounted | import L76 only | Import with no Route; /comms redirects to /inbox |

Orphaned components to remove with Dashboard: `components/SpotlightSearch.jsx`, `components/AgentAvatars.jsx`, `components/SetupChecklist.jsx` (each imported only by Dashboard, per the dead-code audit).

Also delete from disk (not a git change, it is untracked): the stale repo snapshot inside `frontend/src/pages/` (`backend/`, `docs/`, `shared/`, `supabase/`, `DEPLOY.md`, `package.json`, `package-lock.json`, `.gitignore`).

## G. Safe execution order

**Step 1, zero risk, no sign-off needed (~30 min):**
1. Delete the untracked snapshot dirs inside `frontend/src/pages/` (local disk hygiene only).
2. Remove the two route-less imports (WeeklyDigest, CommsLog) plus their files.
3. Remove the stale Escalations warm-list line (App.jsx L181).

**Step 2, near-zero risk, quick Levi nod (~1 hr):**
4. Delete the remaining five dead pages + three orphan components + their App.jsx imports/routes. Verify with `npm run build` and a grep for each filename.

**Step 3, needs Levi's sign-off on the list (~1 hr):**
5. Park the 36: edit `More.jsx` CATEGORIES only. Suggest keeping a single "Coming back later" note or nothing at all. Routes stay mounted, so if Ellie has a bookmark, it still works. Reversal is re-adding one line.

**Step 4, optional, discuss first per the discuss-before-building rule (2 to 3 half-days):**
6. The four merges. Each is independent; Messaging first (redirect plus re-point two links), Compliance second, the two client-intel merges only if Clients detail work is planned anyway.

After steps 1 to 3 the maintained surface drops from 83 pages (~48k LOC) to 40 pages (~30k LOC), and the visible app drops to roughly the 15 core pages plus a slim More.

## H. Estimated maintenance saved

Where page count currently costs time: design/theme sweeps (the em-dash sweep alone left ~423 instances across long-tail pages), API/schema changes rippling into pages nobody opens, regression checks before App Store builds, and security review surface (this week's anon lockdown had to consider every data-reading page).

- Deletes: ~2,700 LOC gone, plus SpotlightSearch's stale 80-entry index. ~1 hr/month.
- Parks: 36 pages out of every visual sweep, copy audit, and manual test pass. At even 10 minutes per page per month across these activities, ~5 to 6 hrs/month.
- Merges: ~1 hr/month plus fewer duplicate data paths to debug.

**Estimate: 6 to 8 hours/month saved**, plus the harder-to-price win that every future schema migration, theme change, and audit now touches a 40-page surface instead of 83. Faster builds and a smaller bundle warm list are side benefits.
