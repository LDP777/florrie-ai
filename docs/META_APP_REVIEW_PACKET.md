# Meta App Review — Submission Packet

**Status:** Ready to submit once Business Verification clears (currently "In review").
**Target:** Path B — Embedded Signup (per-beautician WABAs, Tech Provider).
**Owner:** Levi
**Last updated:** 2026-04-21

Everything Meta asks for, pre-written. Open the App Review form, paste each block into the matching field. Every URL on this page is live.

---

## 1. Permissions we're requesting

Advanced Access for three permissions:

- `whatsapp_business_management` — manage the beautician's WABA (subscribe the webhook, read phone-number status).
- `whatsapp_business_messaging` — send and receive messages on the beautician's behalf.
- `business_management` — read the minimum Business Manager fields needed to finish onboarding (business id, WABA id).

Everything else stays on Standard Access. We do not need `pages_messaging`, `pages_read_engagement`, ads permissions, or any catalog scope.

---

## 2. App + business identifiers

| Field                      | Value                                                   |
|----------------------------|---------------------------------------------------------|
| App ID                     | (pull from developers.facebook.com → Florrie app)       |
| App name                   | Florrie                                                 |
| Business portfolio         | Florrie.ai (id 1586786175730389)                        |
| Legal entity               | FLORRIE.AI LTD                                          |
| Business verification      | In review (resubmitted 2026-04-21)                      |
| Registered address         | Matches Companies House                                 |
| Tech Provider status       | Applying (first submission)                             |

---

## 3. Public URLs Meta will crawl

All live now. Do not change paths before review closes.

| What Meta wants          | URL                                          |
|--------------------------|----------------------------------------------|
| Marketing site           | https://florrie.ai                           |
| App login                | https://app.florrie.ai                       |
| Privacy policy           | https://florrie.ai/privacy                   |
| Terms of service         | https://florrie.ai/terms                     |
| Data deletion request    | https://florrie.ai/privacy#delete            |
| In-app privacy           | https://app.florrie.ai/privacy               |
| In-app terms             | https://app.florrie.ai/terms                 |
| Support                  | hello@florrie.ai                             |

**Before submitting:** verify `/privacy` explicitly mentions Meta + WhatsApp Cloud API data handling. Current copy only names Supabase, Stripe, and Bird — add the WhatsApp paragraph below.

---

## 4. Privacy policy addendum (paste into `/privacy`)

Add this section to `PrivacyPolicy.jsx` before submitting. Meta rejects policies that don't explicitly name the data they receive.

> **WhatsApp Business messaging**
>
> When a beautician connects their WhatsApp Business Account to Florrie, we exchange messages with their clients on their behalf using Meta's WhatsApp Business Cloud API. Specifically:
>
> - We receive inbound client messages (text, media, voice notes) forwarded from Meta's servers to our backend at api.florrie.ai.
> - We send outbound messages (appointment confirmations, reminders, replies drafted by the beautician or the Florrie AI) via the Cloud API.
> - We store message content, timestamps, and phone numbers in our EU-hosted Supabase database so beauticians can review conversation history and so our AI can produce contextually relevant replies.
> - We retain messages for the life of the beautician's account. On account deletion, we purge all message content within 30 days.
> - We do not share WhatsApp message content with any third party except the infrastructure providers named above (Supabase for storage, Meta for delivery). We never sell WhatsApp data. We never use WhatsApp data to train models owned by anyone other than the beautician's own account.
> - The beautician can disconnect at any time from Settings → WhatsApp, which revokes the sharing permission and stops message ingestion immediately.

Make sure the section has an anchor (`<section id="whatsapp">`) so Meta can deep-link if they want.

---

## 5. Data-handling description (paste into App Review form)

Meta's form asks "How will you use each permission?" Keep it tight, concrete, and tied to a user-visible outcome. One paragraph per permission.

**`whatsapp_business_management`**
Florrie uses this permission to subscribe our webhook to the beautician's WhatsApp Business Account after they complete Embedded Signup, so we can receive inbound messages and delivery receipts. We also read phone-number metadata (display name, quality rating, messaging limit) to show status in our Settings page. We never write to the WABA beyond subscribing the webhook.

**`whatsapp_business_messaging`**
Florrie sends appointment reminders, confirmations, and AI-drafted client replies on behalf of the beautician, and receives inbound client messages the beautician can respond to from our app. The beautician reviews and approves AI-drafted replies before they send unless they've explicitly opted into auto-reply. Outbound content is limited to transactional service messages and client-initiated session replies — no marketing broadcast messages.

**`business_management`**
Used only during Embedded Signup to read the WABA id and phone-number id that Meta's hosted modal just provisioned, so we can persist the right identifiers against the beautician's account. No other Business Manager data is read, and we never write.

---

## 6. Use case description (paste into "Tell us about your integration")

Florrie is a WhatsApp-first AI receptionist for independent beauticians. Each beautician runs a one-person business (lashes, brows, nails, hair) and uses WhatsApp as their primary client channel. Florrie sits between the beautician and their clients:

- Clients message the beautician's WhatsApp business number as they normally would.
- Florrie's AI triages the message, books the appointment into the beautician's calendar, sends a confirmation, and handles rescheduling, cancellations, and aftercare.
- The beautician approves AI-drafted replies from our app (app.florrie.ai) or lets auto-reply handle the long tail.
- Payments go through Stripe, not WhatsApp.

We're migrating from a shared WABA under FLORRIE.AI LTD to Embedded Signup so each beautician gets their own WABA. This unlocks per-beautician messaging limits, removes the 25-number cap, and reduces our exposure to cross-tenant issues.

Scale today: one pilot beautician (Ellie, ellindigo). Target for Q3 2026: 50 beauticians.

---

## 7. Screencast / walkthrough video

Meta needs a 2–4 minute screen recording that shows the permission being used end-to-end. Record with OBS or QuickTime at 1080p, no background audio, narration optional.

**Shot list (record in this order, stop-and-start is fine):**

1. **0:00–0:20 — Log in.** Open https://app.florrie.ai, log in as Ellie (test credentials below). Land on the Hub.
2. **0:20–0:35 — Navigate to WhatsApp settings.** Click "WhatsApp" in the sidebar. Show the Connect CTA.
3. **0:35–1:20 — Click Connect.** The Embedded Signup modal opens. Sign in to Facebook (Meta's test account — do NOT use a personal account). Pick the test WABA. Pick the number. Verify.
4. **1:20–1:45 — Land back in Florrie.** Page shows "WhatsApp connected" + the number. Show the Settings → WhatsApp page with the quality rating, messaging limit, and disconnect button.
5. **1:45–2:30 — Inbound message demo.** Send a test message from a separate WhatsApp account (Levi's personal phone) to the connected number. Show it appear in Florrie's Messages view within a few seconds. Show the AI draft reply.
6. **2:30–3:00 — Outbound message demo.** Approve the AI draft. Show the message arrive on the client phone.
7. **3:00–3:30 — Disconnect.** Click "Disconnect WhatsApp" in Settings. Confirm. Show the Connect CTA reappear. End recording.

Export as MP4, upload to a private YouTube link (unlisted). Paste the link into the review form.

**Do not show:** real client phone numbers, real production data, API keys, or Ellie's actual WABA.

---

## 8. Test credentials for Meta reviewer

Create a dedicated test account in Florrie before submitting. Do NOT give reviewer access to Ellie's account.

| Field           | Value                                    |
|-----------------|------------------------------------------|
| Login URL       | https://app.florrie.ai                   |
| Email           | meta-reviewer@florrie.ai (create)        |
| Password        | (generate; store in 1Password)           |
| Test WABA       | "Test WhatsApp Business Account" (id 1279846344245554) |
| Test number     | Allocate one from the WABA for the demo  |

In the review form there's a "Test user credentials" box — paste email + password. Meta will log in and click around.

---

## 9. Screens Meta always asks for

Capture these once, stash in `docs/app-review-screens/`:

- `01-login.png` — login screen
- `02-hub.png` — Hub after login
- `03-connect-cta.png` — WhatsApp page with "Connect" button before signup
- `04-embedded-signup-modal.png` — screenshot of the Meta modal itself
- `05-connected.png` — Settings showing connected number, quality rating, disconnect button
- `06-inbound-message.png` — Messages view with an inbound WhatsApp message
- `07-outbound-approved.png` — AI draft reply approved + sent
- `08-privacy-policy.png` — /privacy with the WhatsApp section visible
- `09-data-deletion.png` — privacy deletion section

Name them literally that. Meta's form accepts up to 10 images.

---

## 10. Business verification state (reference)

Needed to be green before App Review will even read the submission:

- Legal name: FLORRIE.AI LTD ✓ (matches Companies House)
- Registered address: ✓ (matches Companies House, fixed 2026-04-20)
- Business portfolio: Florrie.ai (id 1586786175730389) ✓
- Security Centre: In review (as of 2026-04-21; auto-triggered fresh review after address edit)
- WABA 1 (Florrie, 1458055882486306): Currency GBP, Timezone Europe/London ✓
- WABA 2 (Test, 1279846344245554): Currency GBP, Timezone Europe/London ✓

Meta auto-rolls Security Centre review, WABA review, and Tech Provider review into one queue once Business Verification is green.

---

## 11. Pre-submit checklist

Do these before hitting submit. Each should take 5–10 minutes.

- [ ] Privacy policy updated with WhatsApp section (`/privacy`)
- [ ] Terms of service mentions "messages via Meta WhatsApp Cloud API"
- [ ] `/privacy#delete` anchor works and explains data deletion process
- [ ] Create `meta-reviewer@florrie.ai` test account in Florrie
- [ ] Pre-populate test account with a dummy client + one appointment so the Hub isn't empty
- [ ] Record 3-minute walkthrough, upload unlisted YouTube
- [ ] Capture the 9 screenshots
- [ ] Confirm Business Verification is "Verified" (not "In review") — App Review may decline to start otherwise
- [ ] Pre-read the form at https://developers.facebook.com/apps → Florrie app → App Review
- [ ] Submit

---

## 12. After submit

Meta's average turnaround for Advanced Access on WhatsApp permissions is 3–10 business days. They will either approve, decline with a reason, or ask for more info. If declined:

- Read the reason. Most declines are "data handling unclear" or "video doesn't show permission in use".
- Update the packet, resubmit. No penalty for resubmitting.
- Do not email Meta support chasing — it won't speed it up.

While waiting, the Path A bridge (Ellie on her own WABA shared with Florrie) is the fallback that gets her live without waiting on Meta.

---

## References

- App Review overview: https://developers.facebook.com/docs/app-review
- WhatsApp permissions matrix: https://developers.facebook.com/docs/whatsapp/cloud-api/permissions
- Data handling guidelines: https://developers.facebook.com/docs/development/release/data-use
- Embedded Signup scoping: docs/META_EMBEDDED_SIGNUP_SCOPING.md
