# Meta App Review Video Script (v4, masked-template UI)

**Updated:** 2026-05-31
**Source research:** [docs/META_APP_REVIEW_PITFALLS_2026.md](./META_APP_REVIEW_PITFALLS_2026.md)
**Supersedes:** v3 (2026-05-28). v3 was written against the old technical template screen (snake_case names, UTILITY/APPROVED badges, a Delete button). Since then the template UI was deliberately masked for beauticians: friendly names, plain-English status ("Ready to send" / "In review"), a "Remove" button, and a friendly Create modal. Video B below is rewritten to match the live UI. The underlying API calls (GET/POST/DELETE /message_templates) are unchanged, so the permission is still demonstrated, just through the production UI rather than a technical one.

**Why the UI is friendly, not technical:** Florrie's customers are solo beauticians, not developers, so the template manager hides Meta plumbing. This is the real shipped product. The whatsapp_business_management permission is proven by the create/list/remove actions and the network calls they fire, not by showing raw snake_case names on screen. If a reviewer queries it, the create modal still exposes the template name (snake_case), category and language, and the DevTools Network panel shows the live Graph API calls.

Two videos required, one per permission. Both ~90 seconds. Both must use the **reviewer test account** (meta-reviewer@florrie.ai), NOT Ellie's real account. Both must have on-screen captions (Meta reviewers watch muted).

The UI has changed since v2. The new IA is three bottom-nav tabs (Today, Inbox, Money), a floating More button top-right for the back-of-house catalogue, and a floating mic for voice. Both demos now route through the new tabs, not the old Hub feature cards.

---

## Pre-recording checklist (do once)

1. **Log into the reviewer account** (meta-reviewer@florrie.ai) in an **incognito Chrome window** at exactly 1280x720 viewport. Do NOT use Ellie's real account in the demo video.
2. **Confirm the templates are pre-staged** on the reviewer account's WABA. The real Meta names still need to exist (booking_confirmation, reminder_24h, generic_message), but on screen they now show as friendly labels (Booking confirmation, 24-hour reminder, Quick hello). Also create **test_template_for_deletion_demo** before recording so Video B has a safe row to delete, it will appear in the list as "Test Template For Deletion Demo / Your custom template" with a Remove button.
3. **Confirm the TestClient conversation is open** in the new unified Inbox (last inbound message timestamp within the last 23 hours). If not, send a WhatsApp from a personal phone to Ellindigo's number to open the window, then have the reviewer test account see it appear in `/inbox`.
4. **Have a second physical phone in hand** with WhatsApp installed, with a clean chat thread ready. Or use QuickTime + iPhone-over-USB mirroring on the same Mac for higher-quality recording.
5. **Mute system notifications.** Close all other tabs. Hide menubar work-app badges.
6. **Open a text editor with the captions ready to paste** as overlay during edit.
7. **Confirm the 3-tab bottom nav is visible** on the test account (Today, Inbox, Money plus the floating More pill top right). If anything is off, hard refresh the PWA and clear service-worker caches before recording.
8. **Test recording:** do a 10-second dry run, play back, verify cursor and text are sharp.

---

## Video A: whatsapp_business_messaging (target ~90 seconds)

Demonstrates: receive customer-initiated WhatsApp message via webhook -> reply from salon owner's Inbox -> message delivered end-to-end. Uses the new unified Inbox at `/inbox`.

### Shot list

**0:00 to 0:05, Title card (overlay)**
- Black screen with white text:
  - "Florrie, Meta App 1472063194315529"
  - "Permission demo: whatsapp_business_messaging"
  - "Use case: salon owner replies to client booking enquiries"

**0:05 to 0:20, Login + land on Today**
- Show https://florrie.ai/login (clean Chrome window).
- Type the reviewer email and password slowly so reviewer sees real input.
- Click Sign in.
- Land on the new Today screen (`/today`): greeting, today summary card (revenue, next client, messages waiting), activity feed, Ask Florrie pill, three bottom nav tabs.
- **Caption overlay:** "Business-facing UI: salon owner's Today dashboard. Three tabs: Today, Inbox, Money."

**0:20 to 0:30, Open Inbox + show open conversation**
- Tap the Inbox tab in the bottom nav. URL changes to `/inbox`.
- The unified Inbox lists one row per client, mixed WhatsApp + SMS, sorted by last message. The TestClient row shows a recent inbound WhatsApp message.
- Tap the TestClient row. The conversation view opens with the recent inbound message visible, channel icon shown next to the bubble: "Hi, can I book Friday at 2pm please?"
- **Caption overlay:** "Customer-initiated message received via /messages webhook. 24-hour window open."

**0:30 to 0:50, Send reply (outbound demonstration)**
- The reply box at the bottom of the conversation auto-selects WhatsApp as the channel because the last inbound message was on WhatsApp.
- Type: "Hi Sarah, confirming your appointment for Friday 2pm. See you then. Ellie at Ellindigo."
- Click Send.
- The outbound bubble appears immediately (optimistic), then resolves to delivered status with the Meta message ID visible in the message metadata.
- **Caption overlay:** "POST /{phone_number_id}/messages with whatsapp_business_messaging."

**0:50 to 1:10, Show delivery on recipient phone**
- Cut to (or pan to) the recipient phone. The WhatsApp app shows the message just delivered, with the green double-tick.
- Hold steady for 6 seconds.
- **Caption overlay:** "Delivered end-to-end via Cloud API."

**1:10 to 1:20, Outro title card**
- Black screen with white text:
  - "Permission demo complete."
  - "whatsapp_business_messaging verified end-to-end."
  - "All sends inside 24-hour customer service window or Meta-approved Utility templates."

### Fallback if Ellie's Inbox is empty (no open 24-hour window)

If for any reason the reviewer cannot see an open conversation in `/inbox`, switch to the template-send fallback:

- After landing on Today, tap the floating More button (top-right pill).
- On More, tap WhatsApp (under Messaging) to navigate to `/whatsapp`.
- Scroll to the "Send a message" panel and use a pre-approved template (booking_confirmation) to send to the reviewer's test phone.
- Continue with the delivery-on-recipient-phone shot.

This still demonstrates POST /{phone_number_id}/messages and stays inside Meta's policy because templates are pre-approved Utility category.

---

## Video B: whatsapp_business_management (target ~90 seconds)

Demonstrates: list templates -> create a new template -> delete a template, through Florrie's production template manager at `/whatsapp/templates`. The UI uses friendly labels, the Graph API calls underneath are the permission in use.

### Shot list

**0:00 to 0:05, Title card**
- "Florrie, Meta App 1472063194315529"
- "Permission demo: whatsapp_business_management"
- "Use case: salon owner manages her own message templates"

**0:05 to 0:20, Login + navigate to Templates via More**
- Login as reviewer account (faster cut than Video A is fine).
- Land on Today.
- Tap the floating More button (top-right pill). The More catalogue opens at `/more`.
- Under Messaging, tap WhatsApp -> `/whatsapp` opens, then tap the Templates tab (it routes to `/whatsapp/templates`).
- Alternative direct route: type `/whatsapp/templates` in the URL bar. Either is acceptable, pick whichever reads cleaner.
- **Caption overlay:** "Template manager, behind More -> Messaging -> WhatsApp -> Templates."

**0:20 to 0:40, Show templates list (READ demonstration)**
- The page header reads "Message templates" with a "+ Create new template" button.
- The list shows the salon's templates as cards: a friendly name (e.g. "Quick hello", "Last-minute gap offer"), a one-line description, a plain-English status badge ("Ready to send" = Meta-approved, "In review" = pending), and a preview of the message body.
- **Caption overlay:** "GET /WABA_ID/message_templates via whatsapp_business_management."
- Optional: open DevTools Network panel briefly to show the live `message_templates` GET call. **Caption:** "Live Graph API call listing the salon's approved templates."

**0:40 to 1:10, Create new template (CREATE demonstration)**
- Click "+ Create new template". A modal titled "Create WhatsApp template" opens.
- Fill in:
  - Template name: `review_screencast_test` (the field hint reads "Lowercase, no spaces. Spaces become underscores automatically.")
  - Category: Utility (dropdown, labelled "Utility (booking, reminders, receipts)")
  - Language: English
  - Body: `Hi {{1}}, thanks for visiting Ellindigo. We would love your feedback: {{2}}.` (the hint explains the `{{1}}`, `{{2}}` placeholders)
- Click Create template.
- Modal closes. The new template appears in the list with an amber "In review" badge.
- **Caption overlay:** "POST /WABA_ID/message_templates via whatsapp_business_management. New template submitted to Meta for approval (shown as In review)."

**1:10 to 1:25, Delete a template (DELETE demonstration)**
- Scroll to "Test Template For Deletion Demo" (the pre-staged `test_template_for_deletion_demo`, safe to delete).
- Click its Remove button.
- Confirm the deletion in the dialog.
- The card disappears from the list.
- **Caption overlay:** "DELETE /WABA_ID/message_templates via whatsapp_business_management."

**1:25 to 1:35, Outro title card**
- "Permission demo complete."
- "whatsapp_business_management verified: list, create, delete templates."
- "Salon owner controls all template actions through Florrie's UI."

### Note on the friendly labels (if a reviewer asks)
The on-screen names ("Quick hello") are display labels for a non-technical salon owner. The real Meta template name is preserved and used in every API call. The create modal shows the actual template name, category and language, and the Network panel shows the raw Graph API requests, so nothing is hidden from a reviewer who wants the technical detail.

---

## Recording and upload

- **Tool:** QuickTime Player (Mac, File -> New Screen Recording) or Loom. Record window only, not whole screen.
- **Resolution:** 1080p minimum.
- **One continuous take per video.** No cuts.
- **Add on-screen captions in post** using iMovie or Loom's built-in caption tool. Lower-third, white text on translucent dark background.
- **Export** as MP4 at "Fast 720p30" (HandBrake) or equivalent if file is over 50MB.
- **File names:** `florrie_whatsapp_business_messaging.mp4` and `florrie_whatsapp_business_management.mp4`.
- Upload one video per permission in the App Review form.

---

## If something fails on camera

- **Free-form send fails with 24h window error:** stop, send a WhatsApp from your second phone to Ellindigo, wait 5 seconds, restart the recording from the title card. If the Inbox is still empty after the reset, use the Video A template-send fallback.
- **Template create fails (name conflict):** change to `review_screencast_test_2`. Restart from the title card.
- **Bottom nav not visible (PWA cache):** hard refresh, then unregister the service worker via DevTools -> Application -> Service Workers. Reload, confirm Today / Inbox / Money are visible, then re-record.
- **Anything else:** stop, fix, re-record fresh. Do not splice.

---

## Resubmission backup plan

If Meta rejects:

1. **"Video does not show end-to-end flow"**, re-record showing the message arriving on the recipient phone for at least 6 seconds, hold the phone steady.
2. **"Use case unclear"**, confirm the title card and captions are visible. Add a one-line voiceover in post if Meta specifically asks for it (rare).
3. **"Test account does not work"**, confirm 2FA is fully disabled and the account is in the geo-permissive state. Reach Meta via Direct Support.
4. **"Use case appears AI-chatbot-like"**, rewrite the permission description to emphasize task-scoped automation more strongly. Cut any phrase that includes "AI assistant", "AI agent", "in the salon owner's voice", or anything implying open-domain conversation.

Resubmissions usually clear in 1 to 2 days because reviewers have your previous submission cached.
