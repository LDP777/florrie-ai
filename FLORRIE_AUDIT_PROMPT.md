# Florrie — Full App Audit Prompt

Paste everything below the line into a fresh Cowork/Claude Code session. Run it on Opus.
It is deliberately demanding. The goal is a brutally honest, evidence-backed audit of the
whole product, not a pat on the back.

---

## Your role

You are a senior product engineer, product designer, and growth lead rolled into one,
auditing Florrie: a live SaaS for solo beauticians (lash/brow/nail techs) that charges
£29/mo and has to become a product that can generate millions a year. The owner is
non-technical-facing in the app; the end users are busy, mobile-first salon owners like
the pilot user Ellie (business name "Ellindigo"). Treat this as a real production system
with real users and real money flowing through it.

Audit first. Do not fix things as you go (a messy half-fix mid-audit hides problems).
Produce the report, then we run a separate, prioritised fix pass.

## Non-negotiables

1. **Verify everything in the actual code or by using the running app. Assume nothing
   works until you have proof.** A page that renders is not a page that works. For every
   claim, cite evidence: a `file:line`, a reproduction, or a screenshot.
2. **No false reassurance.** Your job is to find what is broken, half-built, inconsistent,
   confusing, off-brand, insecure, or missing for scale. If a whole area is weak, say so
   plainly. Rank by honesty, not politeness.
3. **Do NOT touch the JARVIS system.** Read `~/ai-company/CLAUDE.md` first. Only Florrie
   lives in `~/ai-company/projects/florrie-ai`. Never modify the repo root agent files.
4. **This is an audit, not a refactor.** Don't change code. If you must run the app or
   write throwaway test scripts, keep them out of the repo.
5. **Brand rule: no em dashes** anywhere in copy you write or recommend. Florrie copy uses
   plain punctuation.

## Step 0 — Load context (do this before judging anything)

Read, in this order, and take notes:
- `~/ai-company/projects/florrie-ai/CLAUDE.md` (if present) and the repo `README`.
- `frontend/src/App.jsx` — the full route table.
- `frontend/src/lib/` — supabase client, config, theme/design tokens, any design system.
- `backend/src/index.js` — middleware, route mounting, cron/intervals, env requirements.
- `backend/src/routes/` — every route file (skim each).
- `supabase/migrations/` — the data model and RLS policies (read the latest few in full).
- Any `docs/` files and the most recent project memory / status notes you can find, so you
  inherit the known issues instead of rediscovering them.

Write a one-paragraph summary of the tech stack, the data model, and the intended core
user journey before you start auditing. If your mental model is wrong, the audit is wrong.

## Step 1 — Build the map

Produce a complete inventory the rest of the audit hangs off:
- **Every route** in `App.jsx` (path → component).
- **Every navigation affordance** the user can actually reach: the bottom tab bar, the
  "More" menu, in-page links, deep links, and any redirects.
- Cross-reference the two lists and flag:
  - **Orphan pages**: a component/route with no way to reach it from the UI.
  - **Dead links**: a nav item or button that points at a route that does not exist or
    renders nothing.
  - **Duplicate / overlapping** destinations doing the same job.
- **Every frontend data call** (supabase queries + `fetch(API_BASE...)`) mapped to the
  **backend route** and **table** it depends on. Flag any call with no matching endpoint,
  any endpoint with no caller, and any endpoint missing auth.

Output this as a table. It is the audit's backbone.

## Step 2 — Page-by-page functional audit

Go through every page one at a time. Do not batch-skim. For each page, answer:
- **Loads with real data?** Or does it show mock/hardcoded/placeholder data pretending to
  be real? (Florrie has had this: pages that look live but render static stubs. Hunt for it.)
- **Every button and action wired?** Each control must call a real handler that hits a real,
  working endpoint and reflects the result. List any button that does nothing, logs an
  error, or silently fails.
- **States covered?** Loading, empty, error, and success states all present and sensible.
  Empty states should feel intentional, not broken.
- **Does it do what it claims** (and what the landing page promises)? Note over-claims.
- **Console clean?** No errors/warnings when you exercise it.
- **Mobile-correct?** Tap targets, safe areas (iOS notch/home bar), no overflow, no tiny
  text. This is a phone app first.

Give each page a status: Working / Works-but-rough / Broken / Mock / Dead, with the
evidence and the specific issues.

## Step 3 — Cross-cutting audits

Beyond individual pages, judge the system:

1. **Design & consistency.** Are colours/spacing/typography coming from design tokens or
   hardcoded ad hoc? Is the type system consistent (display vs body fonts)? Do components
   look like one product or five? Is the copy on-brand, warm, plain, and free of AI-slop
   and em dashes? Score the overall visual craft honestly against products people pay for.
2. **Core journeys, end to end.** Walk each and confirm every step actually works and
   connects: (a) sign up → onboarding → first value; (b) client books → confirmation →
   24h reminder → appointment → mark complete → rebook nudge; (c) inbound message →
   inbox → AI reply / manual reply; (d) deposit/payment → policy fee → payout. Note every
   break, dead end, or confusing handoff between pages.
3. **Onboarding & activation.** How fast does a new beautician reach first value? Where do
   they stall? Is the Setup Hub honest and complete? This is the single biggest lever on
   revenue: a product that can't activate users can't scale.
4. **The money loop.** Stripe subscription + Connect payouts, deposits, policy/no-show
   fees, usage metering/overage. Verify correctness and idempotency. Money bugs kill trust.
5. **Reliability.** Hunt for silent failures, missing idempotency (reminders/sends firing
   twice), unhandled errors, 500s reaching clients, webhooks that can be flagged/disabled.
   Flag anything that sends duplicate or wrong messages to a client.
6. **Security & privacy.** Auth on every endpoint, RLS enforced, no secrets in the client
   bundle, consent/PECR respected for marketing, no PII in logs or URLs.
7. **Performance.** Bundle size and code-splitting, slow or N+1 queries, perceived speed
   on a mid-range phone on mobile data.
8. **iOS / Capacitor.** Permissions (camera/mic/notifications), push delivery, safe-area
   layout, deep links, anything that behaves differently in the native shell vs the browser.

## Step 4 — The "millions a year" lens

Step back from bugs and judge it as a business. Answer directly:
- What would make a beautician pay for this and, more importantly, **keep paying**? Does the
  product deliver that moment, visibly and repeatedly?
- Where are the activation, retention, and expansion levers, and which are missing or weak?
- What are the trust-breakers that would cause churn or refunds?
- If you could only ship **five** changes to move revenue, what are they, ranked by
  impact-to-effort, and why?

## Method

- Use a task list / TODO and a persistent findings file so this can run across multiple
  sessions without losing work. Update them as you go.
- You may use subagents to audit pages in parallel, but you remain responsible for
  verifying their findings against the code. Do not trust a summary you didn't check.
- Where useful, actually run the app and click through (browser tools or the iOS simulator)
  and capture screenshots as evidence, especially for design and broken-state findings.
- Severity scale for every finding:
  - **Blocker** — broken core flow, money/data loss, or sends wrong things to clients.
  - **High** — significant broken or missing functionality, or a real activation/retention killer.
  - **Medium** — works but poor UX, inconsistency, or a scale risk.
  - **Low / Polish** — cosmetic or minor.

## Deliverable

Write one markdown report to `~/ai-company/projects/florrie-ai/docs/AUDIT_<date>.md`
containing:
1. **Executive summary** and a blunt verdict: is this ready to scale toward millions, and
   what are the gating issues?
2. **Scorecard** (1–10) per area: functionality, design, onboarding/activation, money loop,
   reliability, security, performance, iOS, growth-readiness.
3. **The route/page map** and the orphan/dead-link/missing-endpoint findings from Step 1.
4. **Per-page findings table** (page, status, issues, evidence).
5. **Cross-cutting findings** grouped by the Step 3 areas.
6. **Top 10 prioritised fixes**, ranked by impact-to-effort and tied to the revenue goal.
7. **Full severity-ranked backlog** of everything found.

Be specific, cite code, show evidence, and tell me the truth. I would rather hear that
half of it is broken than be told it's fine.
