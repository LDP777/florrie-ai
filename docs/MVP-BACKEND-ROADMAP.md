# Florrie MVP Backend Roadmap

**Goal:** Turn the 67-page frontend prototype into a charging product.
**Date:** 2026-03-27

---

## What Already Exists

The backend is further along than raw prototype stage. Here's the inventory:

**Database (Supabase/Postgres):** 14 tables across 2 migrations. beauticians, treatments, clients, appointments, waitlist, messages, transactions, expenses, ai_actions, campaigns, content_posts, client_intelligence, voice_notes, team_members. Row-level security on all tables. Indexes on all hot paths. Updated_at triggers. UK tax year helpers.

**Express API (10 route files):**
- `auth.js` — signup (creates auth user + beautician row), get/update profile
- `appointments.js` — CRUD with conflict detection, lateness padding, auto-complete with income transaction logging, public slot availability calculator
- `booking.js` — public booking page API (slug-based), find-or-create client on book
- `clients.js` — list with search/status filters, CRUD
- `treatments.js` — CRUD
- `money.js` — weekly pulse (income/expenses/profit/week-over-week), UK tax summary, expense CRUD, receipt OCR via Claude Vision
- `ai-actions.js` — activity feed
- `escalations.js` — AI escalation queue
- `webhooks.js` — WhatsApp Cloud API verification + inbound message handler
- `content.js` — content autopilot routes

**Services:** AI Front Desk (22KB — full message processing pipeline), Content Autopilot (10KB — social content generation).

**Frontend Supabase lib:** Client with auth, useBeautician() hook, fetchRows/insertRow/updateRow/deleteRow helpers, dev mode with Ellie's seed data.

**Not built yet:** Stripe checkout/billing, email/SMS delivery, Google Calendar sync, deployment config, multi-location schema, the 57 pages that still use mock data instead of the Supabase helpers.

---

## The Fastest Path to Revenue

You don't need all 67 pages talking to the backend to launch. You need 10 core pages wired to real data, payments working, and a way for clients to book online.

### Phase 1: Wire Core Pages to Supabase (Sprints B1-B3)

The API routes already exist. The frontend helpers already exist. The missing link is replacing mock useState data in each page with actual Supabase calls.

**Sprint B1 — Auth + Dashboard + Settings**
- Wire Login.jsx to Supabase Auth (email/password + magic link)
- Wire Dashboard.jsx to /api/money/pulse + /api/appointments (today's bookings)
- Wire Settings.jsx to /api/auth/me PATCH (profile, working hours, branding)
- Wire BusinessProfile.jsx to beauticians table
- Estimated: 1 session

**Sprint B2 — Calendar + Appointments**
- Wire CalendarView.jsx to /api/appointments with date range
- Wire the booking flow to /api/appointments POST (manual book)
- Wire appointment status changes (complete, cancel, no-show)
- Wire SmartSchedule.jsx to /api/appointments/slots
- Estimated: 1 session

**Sprint B3 — Clients + Treatments**
- Wire Clients.jsx to /api/clients (list, search, status filter)
- Wire client detail view (ClientTimeline, ClientTags)
- Wire Treatments.jsx to /api/treatments CRUD
- Wire PriceList.jsx to treatments table
- Wire Team.jsx to team_members table
- Estimated: 1 session

### Phase 2: Payments + Billing (Sprints B4-B5)

**Sprint B4 — Stripe Connect Onboarding**
- Add Stripe Connect onboarding flow (beautician creates connected account)
- Add deposit collection on booking page (Stripe Payment Intent)
- Wire MoneyTracker.jsx to /api/money/pulse (already built)
- Wire Expenses.jsx to /api/money/expenses (already built)
- Create subscription billing migration (plans table, Stripe subscription sync)
- Estimated: 1-2 sessions

**Sprint B5 — Subscription Tiers + Paywall**
- Define tiers: Free (5 clients), Starter £29/mo (50 clients), Pro £59/mo (unlimited + AI), Team £89/mo (+ staff seats)
- Stripe Checkout for plan upgrades
- Trial enforcement (14-day, then paywall)
- Feature gating in frontend (check subscription_status before rendering premium pages)
- Estimated: 1 session

### Phase 3: Client-Facing (Sprints B6-B7)

**Sprint B6 — Online Booking Widget**
- The public booking API already works (/api/booking/:slug)
- Build a standalone booking page at florrie.ai/book/:slug
- Responsive, branded (pulls beautician's brand_color/font/logo)
- Treatment picker → date picker → time slots → client details → confirm
- Estimated: 1 session

**Sprint B7 — Notifications + Reminders**
- Email delivery via Resend or Postmark (booking confirmations, reminders)
- SMS via Twilio (24h reminder, rebook nudges)
- WhatsApp already has webhook handler — add outbound message sending
- Wire Notifications.jsx to beautician.notification_prefs
- Cron job for 24h and 1h reminders (Supabase Edge Function or external cron)
- Estimated: 1-2 sessions

### Phase 4: Integrations (Sprints B8-B9)

**Sprint B8 — Google Calendar Sync**
- OAuth flow for Google Calendar
- Two-way sync: Florrie appointments → Google Calendar events and vice versa
- Block personal events as unavailable slots
- Estimated: 1 session

**Sprint B9 — Accounting + WhatsApp Send**
- Xero/QuickBooks OAuth for expense/income push
- WhatsApp outbound: send confirmations, reminders, campaigns via Cloud API
- Wire WhatsAppConfig.jsx to beautician's whatsapp settings
- Estimated: 1 session

### Phase 5: Launch Prep (Sprints B10-B12)

**Sprint B10 — Deploy + CI**
- Frontend: Vercel or Cloudflare Pages
- Backend: Railway or Fly.io (Express server)
- Supabase: production project with migration runner
- Environment variable management
- Custom domain setup (florrie.ai)
- Estimated: 1 session

**Sprint B11 — Remaining Page Wiring**
- Batch-wire the next 15 highest-value pages to Supabase
- Campaigns, Reviews, Loyalty, Aftercare, Inbox, Reports, Feedback, Referrals, etc.
- Pattern: replace useState mock data with useEffect + fetchRows()
- Estimated: 2-3 sessions

**Sprint B12 — QA + Soft Launch**
- End-to-end testing: signup → onboard → add treatments → client books → payment → complete → review
- Mobile responsiveness audit
- Error handling pass (loading states, empty states, API failures)
- Invite 3-5 beta beauticians (Ellie first)
- Estimated: 1-2 sessions

---

## Total Estimate

12 backend sprints. At 1-2 sessions per sprint, that's roughly 12-18 Cowork sessions to a launchable MVP. The first paying customer could be session 8 or 9 (after Stripe is live and booking works end-to-end).

## What You Can Skip For Now

These are real features but not MVP blockers. Build them after first revenue:
- Multi-location (add later when a salon chain signs up)
- AI Insights / Churn / Demand pages (impressive demo features, but need 3+ months of real data to be useful)
- Content Autopilot posting (draft mode works, actual Instagram posting needs Meta API review)
- Voice Commander (cool but not in the critical path)
- Import from Fresha/Timely (build when onboarding real users who need migration)

## Priority Order If You Can Only Do 5 Sprints

1. B1 (Auth + Dashboard + Settings) — without login, nothing works
2. B3 (Clients + Treatments) — the data salon owners enter first
3. B2 (Calendar + Appointments) — the thing they use 20x/day
4. B4 (Stripe Connect) — this is how you get paid
5. B6 (Online Booking Widget) — this is how their clients find them
