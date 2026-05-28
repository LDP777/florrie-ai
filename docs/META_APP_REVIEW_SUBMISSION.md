# Meta App Review Submission Packet (v3, refactor-sprint UI)

**For:** Meta App `1472063194315529` (Florrie.ai)
**Updated:** 2026-05-28
**Source research:** [docs/META_APP_REVIEW_PITFALLS_2026.md](./META_APP_REVIEW_PITFALLS_2026.md)
**Supersedes:** v2 (2026-05-19). v2's UI step-by-steps walked through the pre-sprint cluttered Hub. v3 reflects the new 3-tab IA (Today / Inbox / Money + floating More).

**Critical:** the v1 of this document contained phrasing ("AI chief-of-staff that answers messages in the salon owner's voice") that matches Meta's banned general-purpose AI chatbot pattern, effective October 2025, enforced January 2026. Use ONLY the v3 copy below. Do not paste from older drafts.

---

## Pre-submit checklist (run through this BEFORE clicking Submit)

| # | Item | Why it matters |
|---|---|---|
| 1 | Tech Provider Amendment signed via Adobe Sign | Required for Tech Provider permission grants. Check the signatory email inbox. |
| 2 | Reviewer test account `meta-reviewer@florrie.ai` exists with a known password | Reviewers need to log in |
| 3 | 2FA disabled on the reviewer test account | Meta reviewers are in PH/IN. SMS 2FA fails silently. |
| 4 | Reviewer account already has Ellindigo WABA connected (Cloud API, status CONNECTED) | Reviewer cannot complete Embedded Signup because Twilio Partner Solution is not yet linked |
| 5 | Reviewer account has an OPEN 24-hour conversation in the new unified Inbox (TestClient or similar, last message <23 hours old) | So free-form send works for the reviewer without them needing to text the WABA first |
| 6 | At least 4 APPROVED templates on the WABA, including one named `test_template_for_deletion_demo` | Reviewer needs an empty-feel-safe template to delete in the demo |
| 7 | Privacy URL https://florrie.ai/privacy returns 200 in under 3 seconds and mentions data collection + deletion | Reviewer opens the URL |
| 8 | Terms URL https://florrie.ai/terms returns 200 in under 3 seconds | Reviewer opens the URL |
| 9 | Data Deletion URL https://florrie.ai/help/data-deletion returns 200, mentions email, 30-day timeline, GDPR | Reviewer opens the URL |
| 10 | App icon uploaded: 1024x1024 PNG, opaque (no transparency), no Meta/WhatsApp logos | Common silent fail |
| 11 | App in Live mode | Already done |
| 12 | App Domains includes florrie.ai | Common silent fail |
| 13 | Category = "Business and pages", Business Use = "Provide services to other businesses" | Common silent fail |
| 14 | Both videos recorded using the reviewer test account, NOT Ellie's real account | Reviewer cannot replicate flows on an account they don't have credentials for |
| 15 | Both videos have on-screen captions (Meta reviewers watch muted) | Without captions, intent is unclear, rejection rate spikes |
| 16 | Both videos are one continuous take, no edits | Cuts are a common rejection reason |
| 17 | Both videos under 50 MB MP4 (use HandBrake "Fast 720p30") | Some browsers reject uploads >50MB |
| 18 | Submission language uses "task-scoped automation", NOT "AI chief of staff" / "AI agent" / "AI assistant" | Meta banned general-purpose AI chatbot framing in Oct 2025 |
| 19 | New IA confirmed live: 3-tab bottom nav (Today, Inbox, Money) + floating More button visible on the reviewer account | v2 of this packet referenced an older Hub layout. v3 demos walk through the new tabs. |
| 20 | Service worker / PWA cache cleared on the reviewer browser session | Stale caches occasionally show the old Hub. Hard refresh before recording. |

---

## Settings -> Basic, paste these values

Open https://developers.facebook.com/apps/1472063194315529/settings/basic/ and confirm:

| Field | Value |
|---|---|
| App Display Name | Florrie |
| App Icon | 1024x1024 PNG (use `/Users/levipither/ai-company/projects/florrie-ai/frontend/public/favicon-1024.png`) |
| Privacy Policy URL | `https://florrie.ai/privacy` |
| Terms of Service URL | `https://florrie.ai/terms` |
| Data Deletion Instructions URL | `https://florrie.ai/help/data-deletion` |
| Category | Business and pages |
| Business Use | Provide services to other businesses |
| Business Account | Florrie.ai (verified 2026-05-07) |
| App Mode | Live |
| App Domains | florrie.ai |

---

## Permission 1: whatsapp_business_messaging

### How will your app use this permission?

Paste this verbatim into the permission request form:

```
Florrie is a UK SaaS for independent beauty salon owners. Each salon
owner connects her own WhatsApp Business number to Florrie through Meta
Embedded Signup under Twilio as our BSP. Florrie operates as an
Independent Tech Provider in Meta's Tech Provider Program, not as a
Solution Partner. Each salon owner retains full ownership of her own
WhatsApp Business Account; Florrie holds scoped Cloud API access granted
via Embedded Signup consent and cannot access any WABA without that
explicit consent.

This permission is required so Florrie's backend can:

1. Receive customer-initiated WhatsApp messages from the salon's clients
   via the /messages webhook and surface them in the salon owner's
   Florrie inbox.
2. Send free-form replies from the salon owner to her client inside the
   24-hour customer service window, on her behalf, using POST
   /{phone_number_id}/messages.
3. Send Meta-approved Utility templates outside the 24-hour window:
   booking confirmation, 24-hour appointment reminder, and post-
   appointment review request. All templates are pre-approved by Meta
   and the salon owner explicitly opts in to send them.
4. Read message status webhooks (delivered, read, failed) to update the
   conversation thread state in the salon owner's inbox.

Florrie's automation is task-scoped to beauty salon appointment
management: bookings, reminders, no-show follow-ups, and review
requests. Florrie is not a general-purpose AI chatbot and does not
offer open-domain conversational AI on WhatsApp. All AI-generated
replies are constrained to the salon's appointment lifecycle and stay
inside Meta's WhatsApp Business Messaging Policy.
```

### Step-by-step instructions to test

Paste this verbatim:

```
Reviewer test account: meta-reviewer@florrie.ai
Password: [in the reviewer notes field below]
Test from: any country, the account is not geo-restricted. 2FA is
disabled on this account for review.

Pre-condition: the test account already has the Ellindigo WhatsApp
Business number (+44 7903 881459) connected via Cloud API, and the new
unified Inbox already contains one open conversation with "TestClient"
so the 24-hour window is open. Reviewer does not need to complete
Embedded Signup; the connection is pre-staged.

To test:

1. Open https://florrie.ai/login and sign in with the credentials above.
2. After login, the reviewer lands on /today. This is the new Today
   screen: greeting, today summary card (revenue, next client, messages
   waiting), activity feed, and three bottom-nav tabs (Today, Inbox,
   Money) plus a floating More button top-right.
3. Tap the Inbox tab in the bottom nav. URL becomes /inbox. The unified
   Inbox lists one row per client across WhatsApp + SMS, sorted by last
   message. Tap the TestClient row. The conversation view opens with
   the recent inbound WhatsApp message visible.
4. The reply box auto-selects WhatsApp as the channel because the last
   inbound message was on WhatsApp. Compose a short message and click
   Send. The success state will display the Meta message ID.
5. The message will be delivered to the recipient phone within ~3
   seconds.

This exercises: POST /{phone_number_id}/messages (free-form send) and
the inbound /messages webhook (the TestClient message arriving in the
new unified Inbox).

If the Inbox row for TestClient is missing for any reason, the
reviewer can text the Ellindigo number (+44 7903 881459) from their
own phone to open a fresh 24-hour window, then refresh /inbox and
proceed from step 3.

Alternative read+send path through /whatsapp (if Inbox cannot be
exercised): from /today tap the floating More button (top-right pill),
then Messaging -> WhatsApp. The /whatsapp connection panel shows the
connected WABA, phone number, quality rating, and messaging tier (this
panel reads via Cloud API and exercises whatsapp_business_messaging on
the read side). The same page has a "Send a message" panel for
free-form or template sends.
```

---

## Permission 2: whatsapp_business_management

### How will your app use this permission?

Paste verbatim:

```
Florrie uses this permission only to manage the salon owner's own WABA
assets that the salon owner has explicitly granted Florrie access to
through Embedded Signup. Specifically:

READ usage:
1. GET /{phone_number_id}, read the salon owner's connected phone
   number metadata (verified name, quality rating, messaging tier) so
   Florrie can display connection status in the salon owner's
   dashboard.
2. GET /{WABA_ID}/phone_numbers, list phone numbers on the WABA when
   the salon owner has more than one.
3. GET /{WABA_ID}/message_templates, list message templates so the
   salon owner can see which booking confirmations and reminders are
   APPROVED, PENDING_REVIEW, or REJECTED.
4. GET /{WABA_ID}?fields=health_status, read account health so the
   salon owner can act on any Meta-issued warnings before they affect
   delivery.

WRITE usage (always salon-owner-initiated through Florrie's UI):
5. POST /{WABA_ID}/message_templates, when the salon owner creates a
   new Utility template through Florrie's template editor.
6. DELETE /{WABA_ID}/message_templates, when the salon owner removes a
   template she no longer uses.

Florrie does NOT use this permission to:
- Modify Business Manager ownership or assets.
- Move phone numbers between WABAs.
- Change billing arrangements or credit lines.
- Take any action without the salon owner clicking through Florrie's
  UI.
```

### Step-by-step instructions to test

Paste verbatim:

```
Same login as Permission 1. Then:

1. After login the reviewer lands on /today. Tap the floating More
   button (top-right pill). The /more catalogue opens. Scroll to the
   Messaging section (or use the search input at the top of /more) and
   tap WhatsApp. The /whatsapp page opens.
2. Inside /whatsapp, switch to the Templates tab. A "Manage WhatsApp
   templates" link routes to /whatsapp/templates. Tap it. (Direct
   route also works: paste /whatsapp/templates into the URL bar.)
3. The page lists all templates on the connected WABA. The test
   account has 4 pre-staged templates: booking_confirmation,
   reminder_24h, generic_message, test_template_for_deletion_demo, all
   APPROVED. This list is loaded via GET /WABA_ID/message_templates.
4. Click any template to view its details (header, body, footer,
   variables).
5. Click "+ Create new template" in the top right. Fill in:
   Name: review_screencast_test
   Category: UTILITY
   Language: English (en)
   Body: "Hi {{name}}, thanks for visiting Ellindigo on {{date}}. We
   would love your feedback at {{review_link}}."
6. Click Create template. The new template appears with status
   PENDING_REVIEW. This exercises POST /WABA_ID/message_templates.
7. Scroll to the pre-staged test_template_for_deletion_demo template
   and click its Delete button. Confirm the prompt. The template
   disappears. This exercises DELETE /WABA_ID/message_templates.
```

---

## Reviewer Notes field (paste verbatim, keep under 1500 chars)

```
TEST ACCOUNT
- Email: meta-reviewer@florrie.ai
- Password: [insert real password]
- 2FA: disabled for review
- No geo restriction. Test from any country.

PRE-STAGED STATE
- WhatsApp number (Ellindigo, +44 7903 881459) already connected via
  Cloud API.
- 24-hour conversation window already open (TestClient conversation in
  the unified /inbox).
- 4 templates already on the WABA: booking_confirmation, reminder_24h,
  generic_message, test_template_for_deletion_demo.

UI NOTES
- After login the reviewer lands on /today. Three bottom-nav tabs
  (Today, Inbox, Money). Floating More pill top-right opens /more, a
  searchable catalogue of every back-of-house page.
- Templates live at /whatsapp/templates, reachable via More ->
  Messaging -> WhatsApp -> Templates, or directly by URL.

BUSINESS STATUS
- Business Verification cleared at Meta 2026-05-07.
- Operating as Independent Tech Provider under Meta's Tech Provider
  Program, with Twilio as our BSP for production rollout.
- Tech Provider Amendment signed via Adobe Sign on [insert date].

USE CASE
- UK SaaS for independent beauty salon owners.
- Task-scoped automation: bookings, reminders, post-appointment review
  requests. Not a general-purpose AI chatbot.
- Each salon owner retains ownership of her own WABA; Florrie has
  scoped Cloud API access via Embedded Signup consent.

TROUBLESHOOTING IF LOGIN FAILS
- Email levi@florrie.ai. We respond within 4 hours UK time.
```

---

## After approval lands

Once Meta approves both permissions:

1. Open Twilio Console at `https://console.twilio.com`.
2. Navigate to Messaging -> WhatsApp -> Senders -> "Apply for Tech Provider".
3. Twilio creates a Partner Solution and sends a request to Florrie's Meta app.
4. Accept the Partner Solution request in Meta App Dashboard -> WhatsApp -> Partner Solutions.
5. Twilio provides the `config_id` for Embedded Signup integration.
6. Sprint 1 build begins (Embedded Signup popup wired into florrie.ai).

Note: Florrie does NOT submit its App ID to Twilio. Twilio creates the Partner Solution request after Florrie's Meta App Review approves.
