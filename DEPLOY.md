# Florrie.ai — Production Deployment Guide

A step-by-step guide to deploy Florrie.ai from scratch. This is designed for non-technical founders and walks through each platform setup in order.

**Estimated time:** 90 minutes (mostly waiting for email verifications)

---

## 1. Supabase Setup

Supabase is your database and authentication layer. All client data, bookings, and messages live here.

### 1.1 Create a Supabase Project

1. Go to **supabase.com** and sign up (or log in)
2. Click **New Project**
3. Enter project name: `florrie-production` (or similar)
4. Create a strong password and save it securely
5. Select region closest to your users (e.g., `eu-west-1` for UK)
6. Click **Create new project** and wait ~2 minutes

### 1.2 Copy Your Credentials

Once the project is ready:

1. Go to **Settings → API**
2. Copy and save these (you'll need them later):
   - **Project URL** — looks like `https://xxxxx.supabase.co`
   - **anon public key** — under "Project API keys"
   - **service_role key** — under "Project API keys" (keep this secret)

> ⚠️ **Important:** The `service_role` key is powerful. Never expose it in frontend code or commit it to git.

### 1.3 Run Database Migrations

Migrations set up your database schema. Run them in this exact order:

1. Click **SQL Editor** in the left sidebar
2. Click **New query**
3. Copy the entire content of `supabase/migrations/001_initial_schema.sql` from your local repo
4. Paste it into the SQL Editor and click **Run**
5. Wait for completion (should show "Success")
6. Repeat steps 2–5 for each migration file, in order:
   - `002_team_and_notifications.sql`
   - `003_stripe_and_subscriptions.sql`
   - `004_integrations.sql`

If any migration fails, check the error message and verify that the SQL is complete.

### 1.4 Enable Row Level Security (RLS)

RLS ensures beauticians only see their own data. This is critical for security.

#### Step 1: Enable RLS on All Tables

1. Go to **Authentication → Policies**
2. For each table below, click the table name and toggle **"Row Level Security Enabled"**

Tables to enable RLS on:
- `beauticians`
- `treatments`
- `clients`
- `appointments`
- `waitlist`
- `messages`
- `transactions`
- `expenses`
- `ai_actions`
- `campaigns`

#### Step 2: Create RLS Policies

For each table, you'll create policies that enforce: **only the beautician who owns the data can access it**.

> **Note:** These policies reference the relationship between tables. The `beautician_id` column in each table must match the authenticated user's ID in the `beauticians` table (via `auth.uid()`).

Use the SQL Editor to run the following policies. Copy each block, paste, and run:

```sql
-- beauticians table: only the user can read/update their own profile
CREATE POLICY "Beauticians can read their own profile"
ON beauticians FOR SELECT
USING (auth.uid() = auth_id);

CREATE POLICY "Beauticians can update their own profile"
ON beauticians FOR UPDATE
USING (auth.uid() = auth_id)
WITH CHECK (auth.uid() = auth_id);
```

```sql
-- treatments table: only the beautician who created the treatment can access it
CREATE POLICY "Beauticians can read their own treatments"
ON treatments FOR SELECT
USING (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
));

CREATE POLICY "Beauticians can create treatments"
ON treatments FOR INSERT
WITH CHECK (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
));

CREATE POLICY "Beauticians can update their own treatments"
ON treatments FOR UPDATE
USING (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
))
WITH CHECK (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
));

CREATE POLICY "Beauticians can delete their own treatments"
ON treatments FOR DELETE
USING (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
));
```

```sql
-- clients table
CREATE POLICY "Beauticians can read their own clients"
ON clients FOR SELECT
USING (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
));

CREATE POLICY "Beauticians can create clients"
ON clients FOR INSERT
WITH CHECK (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
));

CREATE POLICY "Beauticians can update their own clients"
ON clients FOR UPDATE
USING (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
))
WITH CHECK (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
));

CREATE POLICY "Beauticians can delete their own clients"
ON clients FOR DELETE
USING (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
));
```

```sql
-- appointments table
CREATE POLICY "Beauticians can read their own appointments"
ON appointments FOR SELECT
USING (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
));

CREATE POLICY "Beauticians can create appointments"
ON appointments FOR INSERT
WITH CHECK (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
));

CREATE POLICY "Beauticians can update their own appointments"
ON appointments FOR UPDATE
USING (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
))
WITH CHECK (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
));

CREATE POLICY "Beauticians can delete their own appointments"
ON appointments FOR DELETE
USING (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
));
```

```sql
-- waitlist table
CREATE POLICY "Beauticians can read their own waitlist"
ON waitlist FOR SELECT
USING (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
));

CREATE POLICY "Beauticians can create waitlist entries"
ON waitlist FOR INSERT
WITH CHECK (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
));

CREATE POLICY "Beauticians can update their own waitlist"
ON waitlist FOR UPDATE
USING (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
))
WITH CHECK (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
));

CREATE POLICY "Beauticians can delete their own waitlist"
ON waitlist FOR DELETE
USING (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
));
```

```sql
-- messages table
CREATE POLICY "Beauticians can read their own messages"
ON messages FOR SELECT
USING (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
));

CREATE POLICY "Beauticians can create messages"
ON messages FOR INSERT
WITH CHECK (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
));

CREATE POLICY "Beauticians can update their own messages"
ON messages FOR UPDATE
USING (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
))
WITH CHECK (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
));
```

```sql
-- transactions table
CREATE POLICY "Beauticians can read their own transactions"
ON transactions FOR SELECT
USING (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
));

CREATE POLICY "Beauticians can create transactions"
ON transactions FOR INSERT
WITH CHECK (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
));
```

```sql
-- expenses table
CREATE POLICY "Beauticians can read their own expenses"
ON expenses FOR SELECT
USING (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
));

CREATE POLICY "Beauticians can create expenses"
ON expenses FOR INSERT
WITH CHECK (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
));

CREATE POLICY "Beauticians can update their own expenses"
ON expenses FOR UPDATE
USING (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
))
WITH CHECK (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
));

CREATE POLICY "Beauticians can delete their own expenses"
ON expenses FOR DELETE
USING (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
));
```

```sql
-- ai_actions table
CREATE POLICY "Beauticians can read their own ai_actions"
ON ai_actions FOR SELECT
USING (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
));

CREATE POLICY "Service role can create ai_actions"
ON ai_actions FOR INSERT
WITH CHECK (true);
```

```sql
-- campaigns table
CREATE POLICY "Beauticians can read their own campaigns"
ON campaigns FOR SELECT
USING (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
));

CREATE POLICY "Beauticians can create campaigns"
ON campaigns FOR INSERT
WITH CHECK (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
));

CREATE POLICY "Beauticians can update their own campaigns"
ON campaigns FOR UPDATE
USING (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
))
WITH CHECK (beautician_id = (
  SELECT id FROM beauticians WHERE auth_id = auth.uid()
));
```

### 1.5 Configure Authentication

#### Email & Password

1. Go to **Authentication → Providers**
2. Click **Email**
3. Toggle **Enable Email provider** to ON
4. Under "Email Auth", uncheck **Confirm email** (for beta testing — enable this in production)
5. Save

#### Optional: Google OAuth

If you want users to sign in with Google:

1. Go to **console.cloud.google.com**
2. Create a new project named "Florrie"
3. Enable the **Google+ API**
4. Go to **Credentials → Create Credentials → OAuth 2.0 Client ID**
5. Application type: **Web application**
6. Authorized redirect URIs: add your Supabase callback URL
   - Get this from Supabase: **Authentication → Providers → Google**
   - Copy the "Redirect URL (for OAuth)"
   - Paste it into Google Console
7. Copy the **Client ID** and **Client Secret**
8. Back in Supabase, enable the Google provider and paste the credentials
9. Save

---

## 2. Stripe Setup

Stripe handles all payments. You never see credit card data — Stripe's Checkout handles it.

### 2.1 Create a Stripe Account

1. Go to **stripe.com** and sign up
2. Verify your email
3. Go to **Settings → Account Settings**
4. Accept the Stripe Service Agreement

### 2.2 Get API Keys

1. Go to **Developers → API Keys**
2. Toggle **Test Mode** to ON (to use test cards, not real charges)
3. Copy and save:
   - **Publishable key** (starts with `pk_test_`)
   - **Secret key** (starts with `sk_test_`)

### 2.3 Set Up Webhook

The webhook tells your backend when a customer pays or a subscription changes.

1. Go to **Developers → Webhooks**
2. Click **Add Endpoint**
3. Endpoint URL: `https://your-backend-url.com/api/stripe/webhook`
   - (You'll know your backend URL after step 4)
4. Select events to listen to:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `account.updated`
5. Click **Add Endpoint**
6. Copy the **Signing Secret** (starts with `whsec_`)
   - You'll use this as `STRIPE_WEBHOOK_SECRET`

### 2.4 Create Test Cards (for testing)

You can use these card numbers in test mode:

| Card Type       | Number           | CVC  | Expiry     |
|-----------------|------------------|------|------------|
| Visa            | 4242 4242 4242 4242 | any  | any future |
| Mastercard      | 5555 5555 5555 4444 | any  | any future |
| Declined card   | 4000 0000 0000 0002 | any  | any future |

---

## 3. Frontend Deployment (Vercel)

Vercel hosts your React frontend with automatic deploys from GitHub.

### 3.1 Push Code to GitHub

1. Create a GitHub repo for the project (if you haven't already)
2. Push the code:
   ```
   git remote add origin https://github.com/yourname/florrie-ai.git
   git push -u origin main
   ```

### 3.2 Import to Vercel

1. Go to **vercel.com** and sign up with GitHub
2. Click **Add New → Project**
3. Select your `florrie-ai` repository
4. Configure:
   - **Framework:** Vite (auto-detected)
   - **Root Directory:** `frontend/`
   - **Build Command:** `npm run build` (auto-filled)
   - **Output Directory:** `dist` (auto-filled)

### 3.3 Add Environment Variables

1. In Vercel, go to **Settings → Environment Variables**
2. Add these variables (from Supabase and Stripe):

| Variable | Value |
|----------|-------|
| `VITE_SUPABASE_URL` | Your Supabase Project URL |
| `VITE_SUPABASE_ANON_KEY` | Your Supabase Anon Public Key |
| `VITE_STRIPE_PUBLISHABLE_KEY` | Your Stripe Publishable Key (pk_test_...) |
| `VITE_API_URL` | Your backend URL (e.g., `https://florrie-api.railway.app`) |

> Note: Only the `VITE_*` variables are exposed to the frontend. The backend keys stay secret on your backend.

3. Click **Deploy** and wait ~3–5 minutes

### 3.4 Add Custom Domain

1. Go to **Settings → Domains**
2. Click **Add**
3. Enter `florrie.ai`
4. Follow Vercel's DNS instructions to point your domain

---

## 4. Backend Deployment (Railway or Fly.io)

The backend runs Node.js and handles API requests, Stripe webhooks, and AI logic.

### 4.1 Choose a Platform

**Railway** (recommended for beginners):
- Simple GitHub integration
- Free tier with $5/month credits
- Good for small deployments

**Fly.io** (alternative):
- More control
- Good global presence
- Slightly more complex

### Option A: Railway Deployment

1. Go to **railway.app** and sign up with GitHub
2. Click **New Project → GitHub Repo**
3. Select your `florrie-ai` repository
4. Railway auto-detects the Dockerfile in `backend/` and deploys
5. Wait ~2–3 minutes for deployment

#### Add Environment Variables (Railway)

1. Go to your project **Settings → Variables**
2. Add all variables from `.env.example`:

```
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_KEY=your-service-role-key

STRIPE_SECRET_KEY=sk_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx

WHATSAPP_TOKEN=your-token
WHATSAPP_PHONE_ID=your-phone-id
WHATSAPP_VERIFY_TOKEN=florrie-webhook-verify

INSTAGRAM_TOKEN=your-token

ANTHROPIC_API_KEY=your-anthropic-key

RESEND_API_KEY=re_xxx
FROM_EMAIL=Florrie <noreply@florrie.ai>

TWILIO_ACCOUNT_SID=ACxxx
TWILIO_AUTH_TOKEN=xxx
TWILIO_PHONE_NUMBER=+447700900000

GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxx
GOOGLE_REDIRECT_URI=https://your-backend-url/api/gcal/callback

CRON_SECRET=your-random-secret-here

PORT=3001
FRONTEND_URL=https://florrie.ai
NODE_ENV=production
```

3. The app restarts automatically with new variables

#### Get Your Backend URL (Railway)

1. Go to your project **Deployments**
2. Click the latest deployment
3. Copy the **Public URL** (looks like `https://xxx-production.up.railway.app`)
4. Use this as your `VITE_API_URL` in Vercel

### Option B: Fly.io Deployment

1. Install the Fly CLI: `npm install -g flyctl`
2. Go to your `backend/` directory
3. Run `fly launch`
   - Choose an app name (e.g., `florrie-api`)
   - Choose a region closest to your users
   - Don't create a PostgreSQL database (you're using Supabase)
4. Add environment variables:
   ```
   fly secrets set SUPABASE_URL=https://xxxxx.supabase.co
   fly secrets set STRIPE_SECRET_KEY=sk_test_xxx
   [... repeat for all variables ...]
   ```
5. Deploy: `fly deploy`

#### Get Your Backend URL (Fly.io)

Your URL is: `https://your-app-name.fly.dev`

---

## 5. Post-Deploy Checklist

Before inviting beta users, verify everything works:

- [ ] **Frontend loads:** Visit `https://florrie.ai` — should show login page
- [ ] **Sign up works:** Create an account with email — should redirect to onboarding
- [ ] **Onboarding completes:** Fill in basic details — should land on dashboard
- [ ] **Add a treatment:** Click "Add Treatment" and create one
- [ ] **Booking page works:** Visit `https://florrie.ai/book/your-slug` (your slug from onboarding) — should show your treatment
- [ ] **Stripe Connect:** Go to Settings → Payments → Connect Stripe and complete Stripe Connect flow
- [ ] **WhatsApp/SMS test:** Go to Communications → send a test message
- [ ] **Landing page:** Visit `https://florrie.ai/landing.html` — should show public landing page
- [ ] **Health check:** Visit `https://your-backend-url/health` — should return 200 OK

If any step fails:
1. Check the browser console for errors (right-click → Inspect → Console tab)
2. Check your backend logs (Railway: Deployments → View Logs; Fly.io: `fly logs`)
3. Verify all environment variables are set correctly
4. Check Supabase's SQL Editor for any RLS policy issues

---

## 6. Beta Launch

You're ready to invite beauticians. Here's the flow:

1. **Invite users:** Send them a link to `https://florrie.ai`
2. **They sign up:** Create account with email/password
3. **They onboard:** Fill in business name, treatments, availability
4. **They book:** Share their personal booking link with clients
5. **Clients book:** Use the booking page (no auth required)
6. **Payments flow:** Client pays via Stripe Checkout → money goes to their Stripe account

### Monitoring During Beta

1. **Supabase Dashboard:** Check real-time data in `beauticians`, `appointments`, `clients` tables
2. **Stripe Dashboard:** Verify payments appear in test mode
3. **Backend Logs:** Watch for errors in your deployment platform
4. **Feedback:** Ask beauticians about pain points, bugs, feature requests

---

## Troubleshooting

### "Cannot create appointments" error

**Cause:** RLS policies missing on `appointments` table
**Fix:** Run the appointments RLS policy SQL from section 1.4 again

### Stripe Webhook not firing

**Cause:** Webhook URL is wrong or endpoint is down
**Fix:**
1. Check Stripe Webhooks → find your endpoint
2. Click it and check "Recent Attempts" for errors
3. Verify your backend is running and accessible

### Frontend can't connect to backend

**Cause:** `VITE_API_URL` is wrong
**Fix:**
1. Verify the backend URL in Vercel environment variables
2. Test it in browser console: `fetch('https://your-backend-url/health')`
3. Check backend logs for CORS errors

### Users can see other beauticians' data

**Cause:** RLS policies not enabled
**Fix:**
1. Go to Supabase → Authentication → Policies
2. Toggle "Row Level Security Enabled" for each table
3. Verify all policy SQL ran without errors

---

## Next Steps

Once beta is live and stable:

1. **Production Stripe:** Switch from test mode to live keys
2. **Email confirmation:** Re-enable in Supabase (currently disabled for beta)
3. **Backup strategy:** Set up Supabase automated backups
4. **Monitoring:** Add error tracking (Sentry, LogRocket)
5. **Scale:** Set up CDN, caching, and database read replicas if needed

---

## Support

- **Supabase docs:** supabase.com/docs
- **Stripe docs:** stripe.com/docs
- **Vercel docs:** vercel.com/docs
- **Railway docs:** railway.app/docs
- **Fly.io docs:** fly.io/docs

Good luck!
