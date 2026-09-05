# More review · 5 September 2026

Local work on Florrie’s More navigation, client care, setup and team screens. This report records source review and targeted checks. It does not establish that all 44 destinations work end to end against production services.

## Route inventory

The new catalogue retains all 44 original destinations. Search covers labels, descriptions, paths and aliases, including Guardian and Form Builder. Native iOS excludes Plans & billing from the catalogue and recent links.

| Group | Destinations |
|---|---|
| Appointments | Calendar (`/calendar/week`)<br>Waitlist (`/waitlist-pro`)<br>Hours & time off (`/hours`)<br>Cancellations (`/cancellations`)<br>End of Day (`/end-of-day`)<br>Notifications (`/notifications`) |
| Client care | Clients (`/clients`)<br>Client checks (`/compliance`)<br>Consultation forms (`/consultation-forms`)<br>Patch tests (`/patch-tests`)<br>Photo consent (`/photo-consent`)<br>Aftercare (`/aftercare`)<br>Import clients (`/import`) |
| Messages | Inbox (`/inbox`)<br>Drafts & approvals (`/outbox`)<br>WhatsApp (`/whatsapp`)<br>SMS (`/sms`)<br>Message templates (`/whatsapp/templates`) |
| Services & sales | Treatments (`/treatments`)<br>Add-ons (`/addons`)<br>Price List (`/price-list`)<br>Training courses (`/packages`)<br>Memberships (`/memberships`)<br>Vouchers (`/vouchers`)<br>Promo Codes (`/promos`)<br>Loyalty (`/loyalty`) |
| Money & reports | Money (`/money`)<br>Analytics (`/analytics`)<br>Expenses (`/expenses`)<br>Deposits (`/deposits`) |
| Marketing | Content Autopilot (`/content`)<br>Campaigns (`/campaigns`)<br>Rebook (`/rebook`)<br>Reviews & feedback (`/reviews`) |
| Team | Team members (`/team`)<br>Staff rota (`/rota`)<br>Team performance (`/staff-performance`)<br>Locations (`/locations`) |
| Business setup | Setup guide (`/setup`)<br>Settings (`/settings`)<br>Booking page (`/portal`)<br>Automations (`/automations`)<br>Florrie’s knowledge (`/knowledge`)<br>Plans & billing (`/pricing`) |

## Behaviour changed

- More puts Client checks and Consultation forms one tap away, groups tools by task, and provides search, expandable groups and six recent destinations. Saved history rejects malformed, duplicate, retired and platform-hidden entries.
- Booking page keeps its public link and sharing actions. Its setup links lead to the actual treatment, opening-hours and booking-policy controls.
- Team writes confirmed changes before updating the list and open member. It retains failed input, shows pending/error states, and uses subscription constants for the monthly list-price estimate. Creating a profile does not claim to send an invitation or change a bill.
- Staff rota includes Sunday and adjusts scheduled hours for salon closures, amended hours and legacy time-off records. Inactive staff contribute no hours; malformed schedules make totals unavailable. Regular-hours edits save to team_members. Salon exceptions use the existing Hours & time off page.
- Google Calendar and Instagram disconnects require successful HTTP responses and show pending/error states.
- Notifications keeps failed approval counts unknown. Read updates change local state only after successful writes, and bulk updates use the returned row IDs.

## Features with limits

| Area | Current limit |
|---|---|
| Custom automation rules | The executor is absent. Creation and template controls have been removed; the screen explains availability. |
| Follow-up sequences | Only after-appointment enrolment works. New sequences save paused. Birthday, dormant-client and manual triggers are unsupported. The executor does not use the old channel selector or interpolate the advertised personalisation tokens. |
| Sequence pause | Stops new enrolments. Already enrolled clients can still receive remaining steps. |
| Sequence reports | Stored sent/opened/replied counters lack a maintained execution path; the screen no longer presents them as measured performance. Activity contains general recorded Florrie actions. |
| Booking-page cosmetics | The public page does not consume booking_policy.portal. Removed toggles and mock branding controls did not change the public page. |
| Team performance | Individual revenue, bookings, ratings and comparisons are unavailable. The page explains this and links to business analytics, team profiles and rota. |
| Team billing | Prices shown are a monthly list-price estimate from the shared subscription constants, not a fetched invoice or confirmation of a billing change. |

## Verification

- Compared the 44 catalogue paths with the original More source and current App routes: no removed, duplicate or unmatched original destinations.
- Executed catalogue assertions for Guardian, consultation/form-builder, income and outbox searches; whitespace, no matches, iOS exclusion, malformed storage, stale labels and duplicate history.
- Executed rota assertions for Sunday/week boundaries, inactive staff, full closures, amended hours, partial legacy time off and invalid schedule handling.
- Passed icons, icon usage, tap inventory, primitive-button ratchet, brand colours, chrome and request-deduplication checks.
- Passed first-render checks for More, AutomationRules, ClientPortal, Team, StaffRota, StaffPerformance, Settings and Notifications.
- Built with Vite and ran check-live against those eight routes using intercepted fixture data. Checks passed for text contrast, numeric fonts and page overflow. This did not test live SMS, billing, OAuth disconnection or all save/failure interactions. Later changes only clarified copy, the rota metric name, and approval-response validation; the eight-page render check passed again.
- Independent consultation review ran 57 tests across consultation-care, consultation-care-routes and consultation-answers. The signature component also passed an isolated render after its undefined field reference was fixed.

## Consultation release prerequisites and review findings

Apply supabase/migrations/20260905_consultation_evidence_snapshots.sql before deploying the new backend. Reads now select form_snapshot, and template writes call save_consultation_template. Deploying the backend first breaks consultation reads and saves. The migration captures the currently available question definitions for older responses; it cannot reconstruct definitions already lost before this release.

The snapshot trigger and transactional editor preserve issued wording through template edits. The reviewed routes scope owner reads and explicit client/form/appointment references, reject mismatched client bookings, and keep signature images out of list responses. Public submission uses the issued snapshot and conditionally changes a pending response, preventing a second submission from overwriting the first.

The independent review findings were fixed and regression-tested: the populated signature component no longer references an undefined field; Calendar now offers only outstanding configured forms, including extra treatments, and does not offer duplicate active requests; public link expiry only updates a pending response so a concurrent completed submission remains intact.

No push or deployment formed part of this review.
