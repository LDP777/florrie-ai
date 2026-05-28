# Cron Job Setup, Florrie Backend

All Florrie cron jobs run as Railway-native cron services in the **florrie**
production project. Each job is a one-shot Node script under `src/jobs/`.

Two of these (`cleanup-stripe-events`, `bill-surplus-sms`) used to live as
Cowork scheduled tasks hitting an HTTP endpoint over the public internet, but
the Cowork outbound proxy returns HTTP 403 on api.florrie.ai. Moved them to
in-process Railway cron so the work happens against the local Supabase
connection without leaving the VPC.

| Job | Script | Schedule | What it does |
|-----|--------|----------|---------------|
| Comeback engine | `node src/jobs/comeback.js` | `0 8 * * *` (08:00 UTC daily) | Re-engages clients dormant 42+ days |
| Stripe events cleanup | `node src/jobs/cleanup-stripe-events.js` | `0 3 * * 0` (Sun 03:00 UTC) | Deletes `stripe_events` rows older than 90 days |
| Bill surplus SMS | `node src/jobs/bill-surplus-sms.js` | `0 4 * * 1` (Mon 04:00 UTC) | Creates Stripe invoice items for unbilled SMS surplus |

## Adding a Railway cron service

For each job above, in the Railway dashboard:

1. Open the **florrie** production project
2. **+ New** → **Empty Service** → name it `cron-<job-name>` (e.g. `cron-stripe-cleanup`)
3. **Settings** → **Source**: link to the same GitHub repo as `florrie-backend`, root `/backend`
4. **Settings** → **Build**: use the existing Dockerfile (same image as the API)
5. **Settings** → **Deploy**:
   - **Custom Start Command**: `node src/jobs/<script>.js`
   - **Cron Schedule**: paste the cron expression from the table above (Railway uses standard 5-field cron)
   - **Restart Policy**: `Never` (one-shot)
6. **Variables** → reference variables from `florrie-backend` so the job sees the same `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `STRIPE_SECRET_KEY`, `BIRD_*`, etc. (Railway variable references avoid copy-paste drift.)
7. Deploy. The first run will trigger immediately, subsequent runs follow the cron schedule.

## Local testing

Each script can be run directly. It loads `.env` from `backend/.env`.

```bash
cd backend
node src/jobs/cleanup-stripe-events.js
node src/jobs/bill-surplus-sms.js
node src/jobs/comeback.js
```

Each script exits with code 0 on success, 1 on failure, so Railway logs the
correct status.

## Idempotency

All three jobs are safe to rerun:

- **Comeback** checks `client_nudges` for recent entries within the rebooking window.
- **Stripe cleanup** uses a date filter, re-running just deletes the same already-deleted slice.
- **SMS billing** filters on `billed = false` and flips the row to `billed = true` once invoiced. A second run finds nothing to process.

## Monitoring

- All scripts log via Pino. Railway captures stdout per cron run.
- Errors are caught by the script wrapper and logged before exit. Sentry will pick them up if `SENTRY_DSN` is set on the cron service.
- For the comeback engine specifically: `node src/jobs/comeback.js` prints
  `Comeback engine done. {sent} sent, {skipped} skipped, {failed} failed`.

## Why not external cron-as-a-service?

EasyCron, cron-job.org, and friends all hit the public api.florrie.ai endpoint over the open internet. That works but adds:

- Another shared secret to rotate (`CRON_SECRET`)
- A third-party in the request path
- Latency and failure modes outside Railway's monitoring

Native Railway cron runs in the same VPC as the API, shares env vars by reference, and shows up in the same Railway dashboard. Less moving parts.
