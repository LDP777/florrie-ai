# Florrie Production Audit — 4 April 2026

Audit of florrie.ai against live production. Every page opened in Chrome, real API calls logged, issues fixed immediately, fixes pushed. Ellie can use the app Monday.

---

## Fixes Shipped (commit `12f3814`)

### 1. Dashboard crash — `countByEmployee is not iterable`
**File:** `frontend/src/pages/Dashboard.jsx`

The `/api/ai-actions/summary` endpoint returns `countByEmployee` and `latestByEmployee` as plain objects (`{ employeeName: { today, latest } }`). Dashboard was iterating both with `for...of` — which only works on arrays — causing a TypeError on every page load. Fixed by switching both loops to `Object.entries()`.

### 2. Agent status widget — 401 on every poll
**File:** `frontend/src/components/AgentAvatars.jsx`

`getToken()` was hardcoded to look for `sb-auth-token` in localStorage. Supabase stores the session under `sb-<project-ref>-auth-token` — in this case `sb-driyreevwogxngqyshtc-auth-token`. The auth header was always empty, so every `/api/agents/status` call returned 401 and the widget silently disappeared. Fixed with a regex pattern search: `Object.keys(localStorage).find(k => /^sb-.+-auth-token$/.test(k))`.

### 3. Same broken getToken() in 5 more files
**Files:** `LocationSelector.jsx`, `push.js`, `ClientImport.jsx`, `ConsultationFormBuilder.jsx`, `ContentAutopilot.jsx`

All had the same hardcoded key. None of these features would have worked for an authenticated user: location switching, push registration, CSV import, consultation form saving, content autopilot. All patched with the same pattern-based fix.

### 4. Loyalty page — blank screen on first load
**File:** `frontend/src/pages/Loyalty.jsx`

`loyalty_config` query used `.single()`, which throws error code `PGRST116` when the table has no row for this beautician. New accounts (including Ellie's) have no loyalty config yet. The page caught the error and re-threw it, rendering a blank white screen. Changed to `.maybeSingle()` so the fallback `{ enabled: true, points_per_dollar: 1 }` is reached instead.

---

## Pages Audited — Results

| Page | Status | Notes |
|------|--------|-------|
| Dashboard | ✅ Fixed & clean | Crash fixed, agent widget 401 fixed |
| Calendar | ✅ Clean | Appointments, drag/drop, day/week views working |
| Booking flow `/book/ellindigo` | ✅ Clean | All 4 steps work: treatment → date/time → details → confirm. Deposit shown correctly. Photo consent checkbox present. |
| Clients list | ✅ Clean | Search, profiles, visit history all loading |
| Client Import `/import` | ✅ Fixed | Platform picker (Fresha/Timely/Vagaro/Other) renders; getToken bug fixed so upload will auth correctly |
| Analytics | ✅ Clean | Revenue, no-show rate, utilisation, top clients, bookings chart all rendering |
| Referrals | ✅ Clean | Share links, top referrers, settings tabs all working |
| Gift Vouchers `/vouchers` | ✅ Clean | Create/Redeem/History tabs, empty state correct |
| WhatsApp Config | ✅ Clean | "Not connected" state, setup flow renders |
| Escalations | ✅ Clean | "All clear" empty state |
| Photo Consent | ✅ Clean | Stats, tabs, GDPR note all present |
| Consultations | ✅ Clean | Stats, Upcoming/Past/Settings tabs, empty state |
| Promo Codes `/promos` | ✅ Clean | Stats, Active/Past tabs, empty state |
| Loyalty | ✅ Fixed | Was blank screen; `.maybeSingle()` fix resolves it |
| Money/Invoices | ✅ Clean | (audited in prior session) |
| Stripe Connect | ⚠️ Expected 500 | Stripe Connect not enabled in Dashboard — not a code bug |
| Google Calendar | ⚠️ Missing env vars | `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` not set in Railway — connect button will fail |

---

## Known Gaps (not code bugs)

**Stripe Connect** — `stripe.accounts.create()` returns 500 because Stripe Connect isn't enabled on the account yet. The user-facing error message is generic and clean. Fix: enable Connect in the Stripe Dashboard.

**Google Calendar OAuth** — `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are not in Railway env vars. The gcal connect flow will fail. Fix: add those vars to Railway and ensure redirect URI `https://florrie.ai/gcal/callback` is registered in Google Cloud Console.

**Loyalty page (post-fix)** — once `.maybeSingle()` lands in production (next deploy), new accounts will see the default loyalty config rather than a blank screen. Existing loyalty_config rows are unaffected.

---

## Ghost Directory

There's a duplicate directory tree at `frontend/src/pages/frontend/src/` — looks like a botched copy-paste at some point. It's not imported by anything and won't affect builds, but it should be deleted to avoid confusion. The only remaining broken `getToken()` reference lives there.

---

## What Still Needs Manual Setup (Ellie's account)

1. Connect WhatsApp Business number via `/whatsapp`
2. Enable Stripe Connect (Stripe Dashboard → Connect)
3. Add Google Calendar credentials to Railway env vars

---

## Commit

`12f3814` — pushed to `main` → Vercel redeploy triggered automatically.
