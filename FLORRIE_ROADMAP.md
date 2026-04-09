# Florrie Roadmap
> Last updated: 2026-04-09. Verified against actual codebase.

---

## What's solid right now

- Public booking page (`/book/ellindigo`) — live, real Supabase data, spinner fix done, 14/14 E2E tests passing
- Client manage link (`/book/:slug/manage/:token`) — cancel, reschedule, resend payment all fully wired to real backend endpoints with late-cancel fee logic and conflict checking
- 68 routes total — 7 public, 61 authenticated with plan gating and lazy loading
- All 64 dashboard pages wired to real API
- ContentAutopilot — drafts, posting, caption generation, AI suggestions all real. `/api/content/caption` calls Claude, `/api/content/suggestions` pulls from appointment history
- RebookReminders "Send nudge" — fixed, calls `/api/notifications/send-sms` and `/api/notifications/send-email` for real
- PatchTests "Send reminder" — fixed, calls `/api/notifications/send-reminder` for real
- 33 migrations applied through 033 + 3 date-stamped ones (Instagram DM, Instagram columns, WhatsApp number registration, VAT, credit priority rules all done)
- Error sanitisation, RLS, Sentry, BetterStack uptime monitoring
- Migration 030 applied (booking_policy, management_token, client_email, client_portal_tokens, patch_test treatment_category)

---

## 1. Immediate — unblock revenue

**Stripe activation** — email sitting in Gmail. Business profile + bank details. Nothing gets paid until this is done.

**Railway plan upgrade** — $3.87 / 18 days left on trial. Backend pauses when credit runs out. Upgrade to Starter ($5/mo) before it hits zero.

---

## 2. Client portal — two gaps remain

The manage page is more complete than expected. Cancel, reschedule (with conflict checking), resend payment all work. Two things are still missing:

### 2a. Patch test auto-booking

Current state: the manage page shows patch test status with a badge (pending/passed/failed) but clients can't take any action. The message is "Your beautician will contact you to arrange this before your appointment" — which puts the work back on Ellie.

Smart flow needed:

**When a new client books a treatment with `requires_patch_test = true`:**
1. System auto-creates a 10-minute "Patch Test" appointment in Ellie's calendar
2. Slot constraints: at least 24h before the main appointment, within working hours, no conflicts
3. Best slot is picked automatically and shown in the client's manage link
4. Client sees: "Before your brow appointment on [Thu 16 Apr], you need a quick 10-min patch test. We've pencilled in [Wed 15 Apr at 11:00] — confirm this works or pick another time"
5. Ellie sees the patch test block in her calendar and gets a notification
6. If client doesn't confirm within 48h of main appointment — flag to Ellie, optional auto-cancel

What this needs:
- `POST /api/booking/:slug/manage/:token/patch-test/confirm` — client confirms the auto-suggested slot
- `GET /api/booking/:slug/manage/:token/patch-test/slots` — returns 2-3 alternative times
- Same slot-generation logic as the main booking (working hours + existing appointments)
- Migration 034: `patch_tests.appointment_id`, `patch_tests.suggested_at`, `patch_tests.confirmed_at`

### 2b. Consultation forms inline

Currently: manage page shows pending forms with "Complete" links that redirect to `/form/:token`. This works but feels disconnected — clients bounce away from the manage page. The better version embeds the form directly in the manage page so the whole pre-appointment experience is in one place. This is a polish item, not a blocker.

---

## 3. Content AI — the gaps

ContentAutopilot is more complete than expected. The real gaps are:

### 3a. Multi-stream support (personal vs sponsor)

Nothing in the codebase separates content streams. Everything posts to one Instagram account. Ellie's situation: she has her own personal content (unlimited, her voice) and 8 mandatory posts/month for BuffBrows (sponsor, different product, potentially different hashtags and CTA).

Database needs a `content_streams` table:

```
content_streams:
  id, beautician_id,
  name (e.g. "Ellindigo Brows", "BuffBrows"),
  type: personal | sponsor | campaign,
  monthly_target: int (null for personal, 8 for BuffBrows),
  brand_guidelines: jsonb (tone, hashtags, dos/don'ts, product mentions),
  active: boolean
```

Every `content_posts` row gets a `stream_id`. The UI shows streams as a tab switcher. Monthly progress tracked per stream ("5/8 BuffBrows posts this month — 3 to go").

### 3b. Content calendar

No calendar view exists — drafts are a flat list. A month-ahead grid is the single biggest UX improvement for planning:

- Weeks across the top, streams as rows (or a combined view)
- Each cell: empty / draft / scheduled / posted — colour coded
- Click any empty cell to create a post for that date
- Sponsor stream: auto-fill 8 slots spread through the month, highlighted in red if any remain in the last week

### 3c. Real Instagram posting

`/api/content/:id/publish` currently marks posts as published in the database and attempts the Instagram Graph API if credentials are connected. The Instagram connection flow (OAuth via Meta Business) needs building end-to-end so Ellie can connect once and Florrie posts on her behalf.

For now the fallback works fine: "Copy caption + open Instagram". Real posting is a V2 item once the content calendar and multi-stream are solid.

### 3d. Auto-triggers from bookings

The "last minute availability" template exists but nothing triggers it automatically. When a cancellation comes in, Florrie should auto-generate a draft availability post and surface it to Ellie's content queue ("A slot just opened on Thursday — want to post this?"). One tap approve, one tap post.

---

## 4. PromoCodes share button

The only remaining fake button. "Share" uses `navigator.share()` (native browser share sheet) with a clipboard fallback — it's not lying to the user, it just opens the OS share UI rather than doing anything Florrie-specific. This is low priority but cleaning it up to share to a specific channel (WhatsApp, Instagram DM) would be more useful.

---

## 5. Core features still unbuilt

In priority order:

**Client comeback engine** — detects clients who haven't rebooked after their usual interval. Sends a personalised message in Ellie's voice. The `tone_model` on each beautician is already populated. Needs a cron job that runs daily, compares `last_visit_at` against treatment rebooking intervals, and fires `/api/notifications/send-sms` with a personalised draft for Ellie to approve or auto-send.

**AI front desk** — handles WhatsApp/Instagram DMs autonomously. WhatsApp config and Instagram DM control tables exist (migrations 028, 032) and a whatsapp-config route exists. The intelligence layer (reading the message, deciding whether to book/rebook/answer/escalate, then responding in the beautician's voice) is the unbuilt part. Architecture needs careful design: Ellie sets a confidence threshold and anything below it surfaces in her escalations queue.

**Voice notes → actions** — Ellie says "rebook Sarah in 6 weeks, she wanted the tint combo" → Florrie creates the follow-up reminder, updates Sarah's notes. Whisper transcription + Claude action extraction. Big wow moment for early users. The VoiceCommander page exists as a shell.

**Smart pricing** — flags underpriced services based on cost-per-treatment and effective hourly rate. Pure analytics on existing appointment data. DemandForecast page shell exists.

---

## 6. Park for now

- Multi-location (migration 027 exists, Ellie is solo — revisit when she has a second location)
- iOS widget (post-launch)
- Stripe subscriptions for Florrie itself (need paying users first)
- Real Instagram posting API (fallback copy+paste works for now)
- Full WhatsApp AI autonomy (build comeback engine first as a simpler version)

---

## Suggested build order

| Sprint | Focus |
|--------|-------|
| Now (you) | Stripe activation + Railway upgrade — 10 mins, no code needed |
| Next | Patch test auto-booking (migration 034 + 2 backend endpoints + manage page UI) |
| Next | Content multi-stream (migration 035 + content_streams table + UI tab switcher) |
| Next | Content calendar (month grid view + sponsor stream progress tracker) |
| Next | Auto-trigger: cancellation → availability draft post surfaced to queue |
| Next | Client comeback engine (cron + personalised nudge with Ellie's tone_model) |
| Following | AI front desk architecture (WhatsApp + escalations queue) |
| Following | Voice notes → actions (VoiceCommander page, Whisper + Claude) |
| Following | Instagram OAuth for real auto-posting |
