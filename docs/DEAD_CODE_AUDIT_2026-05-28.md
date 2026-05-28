# Dead-code audit, 2026-05-28

> Day 6 of the refactor sprint. After Days 1 to 5, the new IA is three tabs (Today, Inbox, Money) plus a /more route that catalogues every secondary page. Anything not reachable from that surface, plus the public booking, auth, and legal routes, is a candidate for archive.

This is a catalogue, not a cut. No deletions yet. Levi reviews, then we move candidates into `frontend/src/pages/_archive/` in a follow-up PR.

## Method

For each page under `frontend/src/pages/`, count inbound references from:

1. `App.jsx` (route mounted? redirect target? lazy import only?)
2. `pages/More.jsx` (the catalogue)
3. `pages/Hub.jsx` (Today landing)
4. `pages/Inbox.jsx`
5. `pages/MoneyTracker.jsx`
6. Any other live page via `<Link>`, `navigate()`, or `to=`
7. External entry points (public booking, login, signup, onboarding, data deletion, terms, privacy)

A page is **live** if it has at least one of those. A page is a **candidate for archive** if its only inbound references are from other already-dead pages or from the legacy SpotlightSearch component.

## Headline

- 83 page files under `frontend/src/pages/`.
- 7 candidates for archive (page files).
- 3 transitively-dead components.
- 5 dead routes mounted in `App.jsx` (Dashboard, Escalations, ApprovalQueue, APISettings, Feedback).
- 2 imports in `App.jsx` that never reach a Route element (WeeklyDigest, CommsLog).

## Live pages (do not touch)

These are reachable through the new IA or are legitimate external entry points.

### Bottom-nav primaries

| Page | Path | Inbound |
|---|---|---|
| Hub.jsx | `/`, `/hub`, `/today`, `/calendar`, `/calendar/week`, `/smart-schedule` | Bottom nav Today tab |
| Inbox.jsx | `/inbox` | Bottom nav Inbox tab + Hub TodaySummary + FloatingMic |
| MoneyTracker.jsx | `/money` | Bottom nav Money tab + UsagePanel |
| More.jsx | `/more` | FloatingMore button (top right) |

### Today sub-tabs

| Page | Path | Inbound |
|---|---|---|
| CalendarView.jsx | `/calendar` | Hub Week sub-tab embed + Dashboard nav refs |
| SmartSchedule.jsx | `/smart-schedule` | Hub Smart Schedule sub-tab embed |

### Catalogued in /more (every section)

| Page | Path | Inbound |
|---|---|---|
| ContentAutopilot.jsx | `/content` | More: AI team + Marketing |
| AIInsights.jsx | `/ai-insights` | More: AI team + Money |
| Compliance.jsx | `/compliance` | More: AI team + Compliance |
| ClientIntelDashboard.jsx | `/client-intel` | More: AI team |
| WaitlistPro.jsx | `/waitlist-pro` | More: Your Day; /waitlist redirect |
| DailyChecklist.jsx | `/checklist` | More: Your Day |
| EndOfDay.jsx | `/end-of-day` | More: Your Day |
| Notifications.jsx | `/notifications` | More: Your Day + Dashboard (dead) |
| HoursExceptions.jsx | `/hours` | More: Your Day |
| Clients.jsx | `/clients` | More: Clients + Dashboard + CalendarView + MoneyTracker + Conversation header |
| ChurnPrevention.jsx | `/churn` | More: Clients + ClientIntelDashboard |
| ClientSegments.jsx | `/segments` | More: Clients + ClientIntelDashboard |
| Loyalty.jsx | `/loyalty` | More: Clients |
| Reviews.jsx | `/reviews` | More: Clients + Dashboard (dead) |
| ClientMemberships.jsx | `/memberships` | More: Clients + ClientIntelDashboard |
| ClientTags.jsx | `/tags` | More: Clients + ClientIntelDashboard |
| PhotoConsent.jsx | `/photo-consent` | More: Clients |
| ClientImport.jsx | `/import`, `/clients/import` | More: Clients + Clients.jsx |
| Treatments.jsx | `/treatments` | More: Treatments |
| Aftercare.jsx | `/aftercare` | More: Treatments |
| Packages.jsx | `/packages` | More: Treatments |
| AddOns.jsx | `/addons` | More: Treatments |
| PriceList.jsx | `/price-list` | More: Treatments |
| AppointmentNotes.jsx | `/notes` | More: Treatments |
| PatchTests.jsx | `/patch-tests` | More: Compliance + Compliance.jsx |
| ConsultationFormBuilder.jsx | `/consultation-forms` | More: Compliance + Compliance.jsx |
| Analytics.jsx | `/analytics` | More: Money + redirects from /digest, /reports, /treatment-stats |
| Expenses.jsx | `/expenses` | More: Money |
| DepositTracker.jsx | `/deposits` | More: Money |
| RevenueGoals.jsx | `/goals` | More: Money |
| GiftVouchers.jsx | `/vouchers` | More: Money |
| PromoCodes.jsx | `/promos` | More: Money |
| ProductInventory.jsx | `/inventory` | More: Money |
| CancellationLog.jsx | `/cancellations` | More: Money |
| Campaigns.jsx | `/campaigns` | More: Marketing + ClientSegments |
| RebookReminders.jsx | `/rebook` | More: Marketing |
| Referrals.jsx | `/referrals` | More: Marketing |
| AutomationRules.jsx | `/automations` | More: Marketing + /sequences redirect |
| MessageTemplates.jsx | `/templates` | More: Marketing |
| Portfolio.jsx | `/portfolio` | More: Marketing |
| Messaging.jsx | `/messaging` | More: Messaging + Integrations + Clients |
| WhatsAppConfig.jsx | `/whatsapp` | More: Messaging + Hub WhatsApp pill + Settings + Inbox empty state |
| WhatsAppTemplates.jsx | `/whatsapp/templates` | WhatsAppConfig Templates tab |
| SMSConfig.jsx | `/sms` | More: Messaging + Settings |
| Settings.jsx | `/settings` | More: Settings |
| BusinessProfile.jsx | `/business` | More: Settings |
| Integrations.jsx | `/integrations` | More: Settings |
| Pricing.jsx | `/pricing` | More: Settings + PlanGate |
| Policies.jsx | `/policies` | More: Settings |
| ClientPortal.jsx | `/portal` | More: Settings |
| Team.jsx | `/team` | More: Settings |
| StaffRota.jsx | `/rota` | More: Settings |
| StaffPerformance.jsx | `/staff-performance` | More: Settings |
| MultiLocation.jsx | `/locations` | More: Settings |
| DemandForecast.jsx | `/demand` | Mounted route, plan-gated, but not currently in More catalogue (see review section) |
| ClientTimeline.jsx | `/client-timeline` | ClientIntelDashboard Quick Actions |
| VoiceCommander.jsx | `/voice` | Hub Ask Florrie pill + FloatingMic |

### External / public / legal / auth (legitimately not in /more)

| Page | Path | Why it's kept |
|---|---|---|
| BookingPage.jsx | `/book/:slug`, `/book/:slug/confirmed` | Public booking link sent to clients |
| ClientManagePage.jsx | `/book/:slug/manage/:token` | Public magic-link booking management |
| TrainingBooking.jsx | `/training/:slug/:courseId` | Public training booking |
| ConsultationFormPublic.jsx | `/form/:token` | Public consultation form |
| Login.jsx | `/login` | Auth entry |
| UpdatePassword.jsx | `/update-password` | Auth flow |
| Onboarding.jsx | `/onboarding` | Post-signup flow |
| TermsPage.jsx | `/terms` | Legal |
| PrivacyPage.jsx | `/privacy` | Legal |
| PrivacyPolicy.jsx | `/privacy` (public route) | Legal, public version |
| DataDeletionPage.jsx | `/data-deletion`, `/help/data-deletion` | Meta App Review requirement |
| Support.jsx | `/support` | Public support page |
| NotFound.jsx | `*` | 404 catch-all |

---

## Candidates for archive (zero inbound from new IA)

These pages have a Route mounted in App.jsx but no inbound link from the new IA. Their only references are either non-existent or come from the legacy SpotlightSearch (which itself is dead, see Unreferenced utilities below).

### 1. Dashboard.jsx, `/dashboard`

- **Verdict:** archive
- **Why:** This is the pre-sprint Stitch reference Dashboard. The new IA replaces it entirely (Hub is the new landing, More holds the agent grid, ActivityFeed holds the activity stream). Zero inbound `Link to="/dashboard"` or `navigate('/dashboard')` calls. The only remaining mentions are inside the Dashboard.jsx file itself.
- **Risk:** none. No nav points here.
- **Notes:** Dashboard imports three components that become orphans if it goes: SpotlightSearch, AgentAvatars, SetupChecklist. Archive them together.

### 2. Escalations.jsx, `/escalations`

- **Verdict:** archive
- **Why:** Sole inbound reference is `components/SpotlightSearch.jsx` (a Dashboard child). Once Dashboard is gone, this page is unreachable. The "Florrie Needs You" surface is now covered by SuggestionCards on Today plus ActivityFeed entries flagged as needs_review.
- **Risk:** none.
- **Suggested merge target:** none. SuggestionCards + ActivityFeed cover the use case.

### 3. ApprovalQueue.jsx, `/approval-queue`

- **Verdict:** archive
- **Why:** Sole inbound reference is SpotlightSearch. Approval queue concept has been replaced by SuggestionCards (Yes / No / Tweak per suggestion is the new approval pattern).
- **Risk:** none.

### 4. APISettings.jsx, `/api-settings`

- **Verdict:** archive
- **Why:** Sole inbound reference is SpotlightSearch. No /api-settings entry in More. No marketing or pilot use case for surfacing developer API/webhook tools to salon owners (Florrie owns the integration logic, the salon owner does not).
- **Risk:** none. If we ever need to surface webhooks, do it inside Integrations.

### 5. Feedback.jsx, `/feedback`

- **Verdict:** archive
- **Why:** Zero inbound references anywhere in the codebase. Route mounted in App.jsx but nothing links to it. The Reviews page (`/reviews`, in More: Clients) covers client-feedback management.
- **Risk:** none.
- **Suggested merge target:** if any "send feedback to Florrie team" feature is needed, build it as a footer link on Settings; do not keep this page.

### 6. WeeklyDigest.jsx, no route mounted

- **Verdict:** archive
- **Why:** Imported at the top of App.jsx but no `<Route>` element references it. `/digest` redirects to `/analytics`. Completely dead.
- **Risk:** none. Remove the import line too.

### 7. CommsLog.jsx, no route mounted

- **Verdict:** archive
- **Why:** Imported at the top of App.jsx but no `<Route>` element references it. `/comms` redirects to `/inbox`. SpotlightSearch references `/comms` (also dead). The unified Inbox now covers message history per client.
- **Risk:** none. Remove the import line too.

---

## Candidates for review (live but worth a closer look)

### Messaging.jsx, `/messaging`

- **Verdict:** keep, but candidate for merge into Settings -> Messaging or fold into More
- **Why:** Currently lives as a tabbed wrapper around WhatsAppConfig + SMSConfig. The bottom-of-Settings already has the same messaging-channels card. /messaging is referenced from More, Integrations, and Clients (bulk send entry). Probably fine to keep for now but worth revisiting in v1.1.
- **Recommendation:** keep this sprint, revisit after pilot.

### Pricing.jsx, `/pricing`

- **Verdict:** keep
- **Why:** Plan upgrade flow. Referenced from More (Settings) and from PlanGate on every gated feature. Stripped from /more on native iOS for App Store 3.1.3 compliance.
- **Recommendation:** keep.

### DemandForecast.jsx, `/demand`

- **Verdict:** keep, but add to More catalogue
- **Why:** Route is mounted with a `demand_forecast` plan gate. Not currently in More.jsx's catalogue. If a Pro-tier user has access, they cannot discover it. Either add it to More: Money or archive.
- **Recommendation:** add to More: Money (one line) before next pilot onboarding.

---

## Unreferenced utilities

These are components in `frontend/src/components/` whose only consumers are dead-code candidates.

### 1. SpotlightSearch.jsx

- **Verdict:** archive (move alongside Dashboard)
- **Inbound:** `pages/Dashboard.jsx` only
- **Notes:** Once Dashboard is archived, SpotlightSearch is orphaned. Spotlight-style search is now solved by More.jsx's built-in search input.

### 2. AgentAvatars.jsx

- **Verdict:** archive (move alongside Dashboard)
- **Inbound:** `pages/Dashboard.jsx` only
- **Notes:** Agent grid is now on More.jsx under the "AI team" category.

### 3. SetupChecklist.jsx

- **Verdict:** archive (move alongside Dashboard)
- **Inbound:** `pages/Dashboard.jsx` only
- **Notes:** Setup checklist surface is now covered by Onboarding for first-run, and SuggestionCards prompts for any remaining setup gaps (e.g. connect WhatsApp).

---

## App.jsx cleanup hints (for the follow-up PR)

If Levi greenlights the archive list, App.jsx should also lose:

```js
// Imports to remove
const Dashboard       = lazy(() => import('./pages/Dashboard.jsx'));
const Escalations     = lazy(() => import('./pages/Escalations.jsx'));
const ApprovalQueue   = lazy(() => import('./pages/ApprovalQueue.jsx'));
const APISettings     = lazy(() => import('./pages/APISettings.jsx'));
const Feedback        = lazy(() => import('./pages/Feedback.jsx'));
const WeeklyDigest    = lazy(() => import('./pages/WeeklyDigest.jsx'));
const CommsLog        = lazy(() => import('./pages/CommsLog.jsx'));

// Routes to remove
<Route path="/dashboard"       element={<Dashboard />} />
<Route path="/escalations"     element={<Escalations />} />
<Route path="/approval-queue"  element={<ApprovalQueue />} />
<Route path="/api-settings"    element={<APISettings />} />
<Route path="/feedback"        element={<Feedback />} />
```

The two imports without routes (WeeklyDigest, CommsLog) are the lowest risk to delete first.

The `/comms` and `/sequences` redirect routes are fine to keep; they preserve deep links from old messages.

---

## Summary

- **7 pages flagged candidate for archive** (Dashboard, Escalations, ApprovalQueue, APISettings, Feedback, WeeklyDigest, CommsLog).
- **3 components transitively dead** (SpotlightSearch, AgentAvatars, SetupChecklist).
- **No deletions executed.** Levi reviews this list, then a follow-up PR moves them into `frontend/src/pages/_archive/` and `frontend/src/components/_archive/` and prunes the App.jsx imports.
- **Two routine cleanups suggested:** add `/demand` to More: Money so Pro users can find it; revisit `/messaging` as a candidate for merging with Settings after pilot.
