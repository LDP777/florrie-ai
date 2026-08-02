# Staging Environment Setup

One-time setup. Once done, every PR can be validated before it touches production.

---

## Architecture

```
main branch       → florrie-api (Railway)      + florrie.vercel.app
staging branch    → florrie-api-staging (Railway) + florrie-staging.vercel.app
```

Both point at separate Supabase projects (or Supabase branches on Pro plan).
Staging always uses Stripe test keys.

---

## Step 1 — Create the staging branch

```bash
git checkout -b staging
git push origin staging
```

---

## Step 2 — Railway staging service

1. Open the Florrie project in [railway.com](https://railway.com)
2. Click **+ New Service** → **GitHub Repo** → select `florrie-ai`
3. Set root directory: `backend`
4. Set the service name to `florrie-api-staging`
5. Under **Settings → Branches**, set deploy branch to `staging`
6. Copy all env vars from the production service into this one, then change:
   - `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_KEY` → staging Supabase project
   - `STRIPE_SECRET_KEY` → `sk_test_xxx` (never `sk_live` in staging)
   - `STRIPE_WEBHOOK_SECRET` → staging webhook secret from Stripe dashboard
   - `FRONTEND_URL` → `https://florrie-staging.vercel.app`
   - `NODE_ENV` → `staging`
   - `GOOGLE_REDIRECT_URI` → `https://florrie-api-staging.up.railway.app/api/gcal/callback`

Reference: `backend/.env.staging.example`

---

## Step 3 — Vercel staging deployment

1. Open the Florrie project in [vercel.com](https://vercel.com)
2. Go to **Settings → Git** → under **Production Branch** confirm it's `main`
3. Vercel automatically builds preview deployments for every branch — the `staging`
   branch will get a stable URL like `florrie-git-staging-xxx.vercel.app`
4. Set a custom alias: **Domains** → add `florrie-staging.vercel.app`
5. Add environment variables for the staging deployment scope:
   - `VITE_API_URL` → `https://florrie-api-staging.up.railway.app`
   - `VITE_SENTRY_DSN` → staging Sentry DSN (optional)

---

## Step 4 — Supabase staging project

Option A (free): Create a separate Supabase project called `florrie-staging`.
Run migrations against it with the runner, which is the only supported way:
`DATABASE_URL=$STAGING_DB_URL node backend/scripts/migrate.js up --force-empty`
(`--force-empty` because a genuinely fresh database has an empty ledger and
the runner otherwise refuses, in case you meant to baseline production.)
See `docs/MIGRATIONS.md`.

Option B (Pro plan): Use Supabase Branch Databases — a staging database branch
is created automatically from `main` and stays in sync with schema changes.

---

## Workflow going forward

```
feature branch → PR to staging → test on staging → PR to main → production
```

Before merging any PR to `main`:
1. Merge it to `staging` first
2. Open `florrie-staging.vercel.app`, log in, test the affected feature
3. Check Railway staging logs for errors
4. Only then merge to `main`

---

## Running the load test against staging

```bash
cd backend
npx artillery run tests/load/smoke.yml --environment production \
  --overrides '{"config":{"target":"https://florrie-api-staging.up.railway.app"}}'
```

Expected: p95 < 500ms on /health, < 2s on AI routes, 0 5xx errors.
