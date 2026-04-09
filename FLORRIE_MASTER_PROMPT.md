# Florrie.ai — Master Session Prompt

Copy this into any new Claude session to pick up full context on Florrie.ai. It covers product, tech, brand, competitors, marketing plan, and current build state.

---

## What Florrie Is

Florrie.ai is an AI salon operating system for solo beauticians and micro-salons (1-5 staff). Built by Levi Pither. Not a booking tool with AI bolted on. The AI runs the business: answers DMs, writes social content, tracks money, chases dormant clients, fills cancelled slots.

**One-liner:** "Your AI team — booking, money, content, and client management that runs itself."

**Target user:** Solo UK beauticians earning £30-60k/year. 50-100 active clients. Currently on Timely or Fresha. Frustrated by per-seat pricing, drowning in admin, posting inconsistently on Instagram, not tracking finances at all.

**Validated with Ellie** (Levi's partner, brow and lash specialist, 40+ clients/week). Her pain points ranked: (1) social content creation, (2) admin and money tracking, (3) clients drifting away silently.

---

## Tech Stack

| Layer | Tech |
|---|---|
| Frontend | React 19, Vite 6, CSS variables theme system, React Router 7 |
| Backend | Node.js, Express 4.21, Zod validation, Pino logging |
| Database | Supabase (PostgreSQL + Row-Level Security + Auth) |
| AI | Claude API (Anthropic SDK) for messaging, content, OCR, intelligence |
| Payments | Stripe Connect (Express accounts) + Checkout Sessions |
| Messaging | WhatsApp Cloud API, Twilio SMS, Resend email |
| Hosting | Frontend on Vercel, Backend on Railway (Docker), DB on Supabase |
| Repo | github.com/LDP777/florrie-ai (monorepo: /frontend + /backend) |

---

## Brand Identity — "Soft Luxury"

The aesthetic sits between Glossier and Aesop. Warm, feminine, premium. Not clinical, not cutesy.

### Colours
- **Primary accent:** Dusty rose `#C76B8A` (hover: `#B85D7B`)
- **Gold accent:** `#C9A96E` (for secondary emphasis, premium touches)
- **Background:** Soft cream `#FAF8F5`, white `#FFFFFF`
- **Text:** Warm charcoal `#2D2A26` (primary), warm grey `#7A756F` (secondary)
- **Accent panels:** Blush pink `#FFF0F3`, soft gold `#FDF8EE`
- **Gradient:** Rose-to-gold `#C76B8A → #D4899F → #C9A96E`
- **Danger/success:** `#DC2626` / `#16A34A`
- **Borders:** `#E8E4DF`

### Typography
- **Display:** Playfair Display (serif, elegant headings)
- **Body:** DM Sans (modern, clean)
- **Mono:** DM Mono (data, reporting)

### Visual Language
- Mobile-native (one-handed use between clients)
- Soft shadows, never harsh
- Frosted glass nav (iOS-style backdrop blur)
- Subtle animations (cubic-bezier easing)
- Every screen communicates its point in under 10 seconds

### Brand Voice
Learned from Ellie's actual client DMs:
- "Hey girl," / "Hey lovely," (warm, casual)
- Short replies (one sentence often enough)
- "&" not "and", "xx" sign-offs
- Never formal ("Yes no worries" beats "Of course, that's absolutely fine!")
- Reassuring around reschedules (no guilt)
- One emoji max per message

---

## Competitors

| Competitor | Price | What They Do | What They Don't |
|---|---|---|---|
| **Timely** | £25-85/mo (per-seat) | Booking, client records, reminders | No AI messaging, no content, no finance tracking, per-seat pricing frustrates solos |
| **Fresha** | £15-20 + 20% commission | Dominant UK booking platform | Commission model bleeds revenue, no AI, no bookkeeping |
| **GlossGenius** | £38/mo | Calendar, POS, marketing emails | No AI messaging, no receipt OCR, no reactivation, US-focused |
| **Vagaro** | £25-85/mo | Full-suite salon management | Complex, built for chains, no AI layer |

### Florrie's Differentiators
1. **AI Front Desk** — reads and answers WhatsApp/Instagram DMs in the beautician's voice
2. **Content Autopilot** — before/after photo detection, AI captions, one-tap posting
3. **Client Comeback Engine** — detects dormant clients, sends personalised reactivation
4. **Money Tracker + Receipt OCR** — auto-logs income from bookings, Claude Vision scans receipts
5. **Flat £50/mo pricing** — no per-seat scaling, no commission on payments
6. **96.8% gross margin** — Claude Haiku + Supabase = pennies per user

---

## Pricing & Revenue Model

**Subscription tiers (planned):**
- Free: 5 clients max (lead gen)
- Starter: £29/mo — 50 clients, core features
- Pro: £59/mo — unlimited clients, AI features, content autopilot
- Team: £89/mo — staff seats, multi-location

**Current target:** £50/mo flat rate during launch.

**Unit economics per user/month:**
- Claude API (Haiku + Sonnet + Vision): £0.63
- WhatsApp Business API: £0.80
- Supabase + Railway hosting: £0.13
- Whisper (voice): £0.02
- **Total cost: £1.58/user/month → 96.8% gross margin**

**Payment processing:** Stripe Connect. Deposits flow through Florrie's platform account and transfer to the beautician's connected Stripe Express account. No application fee on deposits in v1 (revenue comes from subscriptions, not transaction fees). Stripe's processing fee (1.4% + 20p UK cards) currently sits with the platform — need to evaluate moving this to the connected account for sustainability.

**Revenue targets:**
- 50 users: £2,500 MRR
- 200 users: £10,000 MRR (6-month target)
- 1,000 users: £50,000 MRR

---

## Features Built (March 2026)

71 pages across 9 categories. All deployed to production.

**Your Day:** Calendar, Smart Schedule, Daily Checklist, End of Day, Notifications
**Clients:** Database, Import (CSV/Fresha/Timely), Timeline, Tags, Waitlist
**Treatments:** Menu management, Consultation forms (custom builder), Patch tests, Aftercare sequences, Packages, Add-ons
**Money:** Revenue tracker (weekly pulse), Expenses with receipt OCR, Deposit collection, Cancellation log, Revenue goals, Gift vouchers, Client memberships
**Marketing:** Content Autopilot, Reviews, Referrals, Loyalty, Rebook reminders, Campaigns (SMS/email)
**Communications:** Unified inbox, AI escalations, WhatsApp integration, Message templates, Automations
**AI Intelligence:** Voice assistant, AI insights, Client segments, Churn prevention, Demand forecast
**Team:** Staff profiles, Rota, Working hours/closures
**Settings:** Branding, Stripe Connect onboarding, Integrations, Policies, Consent forms

**Public pages:** Booking page (`/book/:slug`), Consultation form (`/form/:token`)

---

## Current Build State (29 March 2026)

### What's Live
- Full React frontend on Vercel (`florrie-ai-frontend.vercel.app`)
- Express backend on Railway (`florriebackend-production.up.railway.app`)
- Supabase database with 14+ tables, RLS policies, migrations
- Public booking page working end-to-end (treatment → date → time → details → confirm)
- Percentage-based deposits implemented (frontend + backend)
- Consultation form system (builder + public form + SMS trigger for first-time clients)
- Stripe Connect Express onboarding flow
- Receipt OCR with Claude Vision
- Zod input validation on all routes
- Rate limiting, CORS, trust proxy configured

### What Needs Work
- 16 pages wired to Supabase, ~55 still on mock data
- WhatsApp sending needs Meta approval (using Twilio SMS as bridge)
- Google Calendar sync not built yet
- Content Autopilot in draft mode (doesn't post to Instagram yet)
- Landing page / marketing site not built
- No waitlist or signup flow for new users
- Multi-location schema not implemented
- Subscription billing / paywall enforcement not wired

---

## Marketing Plan — What Needs Building

### 1. Landing Page (florrie.ai)
Build a premium marketing site. Hero section that stops scrolling. Waitlist capture.

**Structure:**
- Hero: Bold headline + subhead + waitlist email capture + product screenshot/video
- Social proof: "Built with real beauticians" + Ellie testimonial
- Feature showcase: 3-4 hero features with screenshots (AI Front Desk, Content Autopilot, Money Tracker, Comeback Engine)
- Pricing section: Simple tier cards
- FAQ: Common objections (Is my data safe? Can I switch from Timely? How does the AI work?)
- Footer: Links, legal, social

**Design references to study:**
- [21st.dev](https://21st.dev) — Component library with beautiful hero sections
- [Glossier](https://glossier.com) — Soft luxury aesthetic, warm photography, minimal
- [Linear](https://linear.app) — Clean SaaS marketing, feature showcases, dark option
- [Raycast](https://raycast.com) — Developer tool with premium marketing
- [Cal.com](https://cal.com) — Scheduling tool with great landing page

### 2. Waitlist System
- Email capture on landing page
- Confirmation email via Resend
- Waitlist counter ("Join 247 beauticians waiting")
- Early access tiers (first 50 get lifetime discount)

### 3. Meta Ads Plan
**Target audience:**
- UK women, 22-45
- Interests: beauty industry, lash extensions, brow specialist, salon owner, self-employed
- Behaviours: small business owners, Instagram business page admins
- Lookalike: seed from Ellie's follower list

**Ad formats:**
- **Reels/Stories (primary):** Screen recordings of Florrie in action. "Watch this AI answer my DMs." "I haven't written an Instagram caption in 3 weeks." "My AI assistant tracked £2,400 in expenses I would have missed."
- **Carousel:** Before/after of a beautician's workflow. Slide 1: "6am: checking DMs manually." Slide 5: "6am: Florrie already replied to 4 enquiries while I slept."
- **Static image:** Product screenshot with bold stat. "Beauticians using Florrie save 8 hours/week on admin."

**Budget:** Start £20/day testing 3-4 creatives. Scale winners to £50-100/day.

**Funnel:** Ad → Landing page → Waitlist signup → Welcome email sequence → Early access invite → Onboarding → Paid conversion

### 4. Email Sequence (Post-Waitlist Signup)
- Day 0: "You're on the list" + what Florrie does (one paragraph, not a wall)
- Day 3: "Meet your AI team" + feature deep-dive
- Day 7: "What beauticians are saying" + Ellie testimonial
- Day 14: "Early access is opening" + urgency

### 5. Social Strategy
- Instagram: @florrie.ai — product demos, beautician stories, feature drops
- TikTok: Screen recordings, "things your booking app can't do" series
- LinkedIn: Levi's founder journey, AI in beauty industry angle

### 6. Content Marketing
- Blog: "How solo beauticians can save 8 hours/week with AI"
- Blog: "Timely vs Florrie: honest comparison"
- Blog: "The real cost of not tracking your salon finances"
- SEO targets: "best salon management software UK", "Timely alternative", "AI for beauticians"

### 7. Branding Kit Needed
- Logo variations (full, icon, wordmark, reversed)
- Colour palette (primary, secondary, accent, neutrals) — codified
- Typography pairings — specimen sheet
- Social media templates (Instagram post, Story, carousel frames)
- Email header/footer templates
- Business card / one-pager design
- App Store screenshots (when ready)
- Pitch deck template
- Brand guidelines PDF (one-pager: logo usage, colours, fonts, voice, dos/don'ts)

---

## Key Files in the Repo

```
florrie-ai/
├── DEPLOY.md                    — Production deployment guide
├── FLORRIE_MASTER_PROMPT.md     — This file
├── frontend/
│   ├── src/App.jsx              — All routes (71 pages)
│   ├── src/lib/theme.jsx        — Design tokens + CSS variables
│   ├── src/lib/config.js        — API_BASE config
│   ├── src/lib/supabase.js      — Auth + DB client
│   ├── src/pages/               — All page components
│   └── src/components/ui/       — Shared component library (8 components)
├── backend/
│   ├── src/index.js             — Express server, routes, middleware
│   ├── src/routes/              — 14 API route files
│   ├── src/services/            — AI Front Desk, Content Autopilot, cleanup
│   ├── src/middleware/          — Auth, rate limiting, validation
│   └── Dockerfile               — Railway deployment
├── docs/
│   ├── MVP-BACKEND-ROADMAP.md   — 12-sprint plan
│   ├── ellie-research-2026-03-24.md — Primary user research
│   └── ellie-tone-model.md      — AI voice calibration from real DMs
└── supabase/migrations/         — Database schema (14+ tables)
```

---

## What To Do With This Prompt

Drop this into a fresh Claude session and ask for any of:

- **"Build the Florrie landing page"** — Use 21st.dev components, hero section, waitlist, feature showcase
- **"Create the branding kit"** — Logo, colours, typography, social templates, brand guidelines PDF
- **"Plan the Meta ads"** — Audience targeting, creative briefs, budget allocation, funnel design
- **"Write the waitlist email sequence"** — 4-email nurture flow, on-brand voice
- **"Design the pitch deck"** — 10-12 slides, investor-ready, with unit economics
- **"Build the marketing site"** — Full React/Next.js site with SEO, blog, pricing page
- **"Create social content templates"** — Instagram post frames, Story templates, carousel layouts
- **"Write competitor comparison pages"** — "Florrie vs Timely", "Florrie vs Fresha" landing pages
- **"Draft the Product Hunt launch"** — Tagline, description, first comment, maker story

Each of these sessions should reference the brand identity section above for colours, fonts, voice, and aesthetic direction.
