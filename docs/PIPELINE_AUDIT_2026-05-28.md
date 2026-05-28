# Florrie pipeline audit, 2026-05-28

End-to-end audit of every system that runs without a human watching it. Done
right after the 6-day refactor sprint, before pilot resumes.

## 1. Green lights

These are wired end-to-end and would catch real failure today.

- **Railway API health**, `/health` at `backend/src/index.js:171` returns
  `{status, service, version}`. `railway.json` has `healthcheckPath: /health`
  and `restartPolicyType: ON_FAILURE` with 10 retries. Confirmed in
  `Dockerfile` HEALTHCHECK too.
- **All five webhooks fail closed in production.** Re-verified at
  `backend/src/routes/webhooks.js` (WhatsApp, Twilio SMS, Bird SMS),
  `backend/src/routes/instagram-webhooks.js`, `backend/src/routes/stripe.js`,
  `backend/src/routes/billing.js`. Every handler checks its signature secret
  and returns `503 Webhook secret not configured` in prod if absent, refusing
  to process unauthenticated payloads.
- **Stripe raw-body wiring is correct.** `index.js:151-156` mounts
  `express.raw` on `/api/stripe/webhook` and `/api/billing/webhook` BEFORE
  `express.json`. Stripe's `constructEvent` gets the bytes it actually signed.
- **Meta webhooks use raw bytes for HMAC.** `index.js:163-168` stashes
  `req.rawBody` via the `verify` callback so WhatsApp + Instagram signature
  checks don't break on JSON re-serialisation.
- **CRON_SECRET is enforced** on the two HTTP-trigger cron routes
  (`/api/stripe/cleanup-events`, `/api/notifications/process-reminders`),
  both return 401 if missing or wrong.
- **In-process cron is healthy.** Six setInterval loops in
  `backend/src/index.js:250-368` cover reminders (1h), stale booking cleanup
  (5m), autonomous cycle (2h), predictive nudges (24h), email queue (15m),
  trial expiry (24h), WhatsApp registration retries (5m). Each is wrapped in
  try/catch so one failure doesn't kill the loop. All also fire once on
  startup with a stagger so deploys don't drop queued work.
- **Frontend Sentry** filters out the noisy stale-bundle errors
  (`Maximum call stack size exceeded`, share-AbortError, ResizeObserver
  loops). Good signal hygiene.
- **iOS / Capacitor pipeline parity.** Single source of truth in
  `capacitor.config.ts`. `App.entitlements` has both `applesignin` and
  `aps-environment=production`. `Info.plist` has correct bundle setup.
- **Build prerequisites in clean state.** Vite + tailwind 4 + React 19,
  Vercel rewrites correctly exclude `/landing.html`, the API runtime caches
  correctly via `NetworkFirst` with 5-min TTL.

## 2. Fixed inline

Five things landed in this commit. All small, all safe, all verified by
`node --check`.

1. **`backend/src/jobs/comeback.js`**, the Railway daily comeback cron read
   `SUPABASE_SERVICE_ROLE_KEY`. Every other file in the codebase
   (`config.js`, `index.js` REQUIRED_ENV, `lib/crypto.js`) reads
   `SUPABASE_SERVICE_KEY`. The cron would only run if Levi happened to
   provision the Railway service with the legacy name. Fixed: try
   `SUPABASE_SERVICE_KEY` first, fall back to
   `SUPABASE_SERVICE_ROLE_KEY`, so neither old nor new Railway setups
   break. Also added the missing `Comeback engine done. ...` summary log
   the CRON_SETUP doc promised, and stripped two em dashes (file rule).

2. **`backend/CRON_SETUP.md`**, doc told future-you to reference
   `SUPABASE_SERVICE_ROLE_KEY` from `florrie-backend` to the cron services.
   That variable does not exist on the API service, so any cron service
   set up from this doc would have launched dead. Updated to
   `SUPABASE_SERVICE_KEY`.

3. **`backend/tests/unit/whatsapp-phone.test.js`**, the test stub set
   `SUPABASE_SERVICE_ROLE_KEY` instead of `SUPABASE_SERVICE_KEY`. The
   route under test reads through `config.js` which looks at
   `SUPABASE_SERVICE_KEY`, so the stub had no effect. Aligned both.

4. **`frontend/capacitor.config.json`** deleted. Two configs co-existed
   at the frontend root, a `.ts` file (current, matches what `cap sync`
   writes into `ios/App/App/capacitor.config.json`) and a `.json` (older,
   wrong appName `"Florrie"` vs `"florrie.ai"`, wrong background colour
   `#1a0a0f` vs `#FAF8F5`, missing iOS + StatusBar sections). Capacitor
   prefers the TS file when both exist, so the JSON was dead. Removing
   it kills a long-standing source of "which config does Capacitor read"
   confusion.

5. **`frontend/vite.config.js`**, the production build emits a
   `chunks larger than 500 kB` warning every deploy. The main chunk
   sits at 656 KB (Sentry + Replay + Supabase + xlsx + React all bundled
   together). Added `rollupOptions.output.manualChunks` to split out
   five known-heavy libs (`sentry`, `posthog`, `xlsx`, `react-vendor`,
   `supabase`). Raised `chunkSizeWarningLimit` to 750 KB so the build
   stops warning on the post-split sizes. Stripped three em dashes in
   the manifest strings while in there.

Em-dash sweep across every file in this commit, the unicode codepoint U+2014 returns
0 on each of: comeback.js, whatsapp-phone.test.js, CRON_SETUP.md,
vite.config.js, this audit file.

## 3. Needs Levi

These need a Railway / Vercel / Apple console action and can't be done
from code.

1. **Verify the three Railway cron services exist.** Per
   `backend/CRON_SETUP.md`, there should be three services in the
   florrie production project: `cron-comeback`, `cron-stripe-cleanup`,
   `cron-bill-surplus-sms`. Each one points at `node src/jobs/<name>.js`
   and inherits env vars by reference. Check Railway dashboard. If
   `cron-comeback` was set up with `SUPABASE_SERVICE_ROLE_KEY` instead
   of `SUPABASE_SERVICE_KEY`, the new fallback covers it, but the cleaner
   move is to delete the legacy var.

2. **Migration 050 + seed 049 confirmation.** Per session memory both
   were applied, but the only programmatic way to verify is a
   `SELECT * FROM information_schema.tables WHERE table_name = 'florrie_decisions'`
   in the Supabase SQL editor. If `florrie_decisions` is missing, the
   Day 4 suggestion-card response logging silently no-ops via the RLS
   policy.

3. **Bird brand resubmit.** Still pending per session memory (ticket
   8caa0d7b). Outbound SMS through Bird is the failure mode if a pilot
   client gets a Bird-routed message before brand passes.

4. **Bundle-size win is theoretical until next Vercel deploy.** The
   manualChunks change is configuration only, nothing in dist yet. Push
   triggers Vercel, watch the build log on the first deploy to confirm
   the main chunk drops below 400 KB and the warning disappears.

5. **Twilio Tech Provider application** (separate workstream, mentioned
   in scaling-direction memory). Not pipeline-critical for the pilot,
   but blocks WhatsApp scaling past Florrie's WABA tier-1 quota.

## 4. Risks for the next 30 days

1. **No CI gate.** There is no `.github/workflows/` directory at all.
   No build check on PR, no test runner on push, no security audit on
   merge. A bad commit that breaks `vite build` will only surface when
   Vercel tries to deploy it. The one Playwright test suite at
   `frontend/tests/e2e/` requires a real production target, so it's
   not a pre-merge check anyway. Worth a 30-line GitHub Action that
   runs `npm run build` on both backend and frontend on every push to
   main, even if nothing else.

2. **In-process crons die with the API.** Every scheduled task except
   the three Railway cron services runs as `setInterval` in the API
   process. If the API restarts every 47 minutes (Railway free tier
   used to do this), the 24h-interval jobs may never fire. Move the
   long-interval jobs (predictive nudges, trial expiry) to Railway
   cron services. The hourly + 5-minute jobs are fine in-process.

3. **PWA service worker + Vite chunk hashing.** The new manualChunks
   change will invalidate every user's cached bundle on next deploy.
   This is what triggered the `Maximum call stack size exceeded`
   pile-up in Sentry weeks ago (now filtered, but the underlying
   stale-SW staleness mechanism is identical). Pre-warn Ellie that
   she needs one hard reload after the next deploy. Existing PWA cache
   memory note `project_florrie_pwa_cache_staleness` is the playbook.

4. **No test of the webhook signature paths.** All five webhook
   handlers have signature verification, but none of them are covered
   by a unit test. A bad refactor of `index.js`'s raw-body middleware
   could silently drop the `req.rawBody` Buffer, and every webhook
   would start failing signature checks with no warning until Meta /
   Stripe / Bird called us. A 50-line node:test that POSTs a known
   payload + signature to each webhook would pay back the first time
   someone touches that middleware.

5. **Dead code drift.** `node_modules` was 407 MB in the working tree,
   the project rule says delete after one-off use. Untracked
   `migrate.js.bak` and `migration-parser.js.bak` were sitting in
   `backend/src/routes/` in the local checkout (not in git, fine on
   disk but trippy when grep-ing). Periodic `git clean -nd` would
   surface these.

