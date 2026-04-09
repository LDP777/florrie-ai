# Cron Job Setup — Florrie Backend

## Client Comeback Engine

The comeback engine detects lapsed clients (42+ days since last visit) and sends personalised re-engagement SMS messages.

### Local Testing

Run the job directly:

```bash
cd backend
node src/jobs/comeback.js
```

### Railway Deployment

Add a cron job to your Railway project to run daily at 08:00 UTC:

1. **In Railway.app dashboard:**
   - Open your Florrie backend service
   - Click "Deploy" → "Cron" (or check the "Cron" tab if your plan supports it)
   - Create a new cron job with:
     - **Command:** `node src/jobs/comeback.js`
     - **Schedule:** `0 8 * * *` (08:00 UTC daily)

2. **Alternative: Use an external cron service:**
   - Set up a service like EasyCron, Cron Job, or AWS EventBridge
   - Configure it to send a POST request to your backend health endpoint
   - Example: `POST https://api.florrie.ai/cron/comeback`
   - Add an auth header: `X-Cron-Key: [CRON_SECRET from env]`

3. **Or use Supabase Edge Functions:**
   - Create an edge function that calls your backend
   - Deploy to Supabase's cron scheduler

### Idempotency

The job is idempotent — if it runs twice in one day, clients won't be nudged twice.

It checks the `client_nudges` table for recent nudges within the 42-day window. If a nudge was sent, it's skipped.

### SMS Provider

The job uses Bird API (configured in `.env` as `BIRD_API_KEY`, `BIRD_WORKSPACE_ID`, `BIRD_CHANNEL_ID`).

Ensure:
- Bird credentials are set in Railway env vars
- Your Bird account has an active SMS plan
- The `sms_enabled` flag is set to true for each beautician

### Monitoring

The job logs via Pino logger. Check Railway logs:
- "Comeback engine starting..."
- "✓ Nudged {firstName} ({phone})"
- "✗ Error nudging {phone}"
- "Comeback engine done. {count} sent, {count} skipped..."

All errors are logged to Sentry if configured.

### Tuning

To change the lapsed client threshold, edit `DEFAULT_REBOOKING_DAYS` in `backend/src/jobs/comeback.js`:

```javascript
const DEFAULT_REBOOKING_DAYS = 42; // Change this
```

Lower values = more frequent nudges. Higher values = only nudge truly dormant clients.
