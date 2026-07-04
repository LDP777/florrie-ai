# Nightly Health Check — 2026-07-04

> **Status: NEEDS ATTENTION** — API unreachable, critical schema drift, high-severity vulnerabilities
>
> Labels: `health-check`, `automated`, `needs-attention`

---

## 1. API Health

| | |
|---|---|
| **Endpoint** | https://api.florrie.ai/health |
| **Result** | ❌ FAIL — connection refused (curl exit 56, HTTP 000) |

The production API is not responding. The `/health` endpoint is completely unreachable — no TCP connection was established. This could indicate the server is down, a DNS failure, or a firewall/networking change.

**Action required:** Check server status, PM2/systemd process, and recent deploy logs.

---

## 2. Frontend Build

| | |
|---|---|
| **Result** | ✅ PASS — built in 6.70s, no errors |
| **Command** | `cd frontend && npm install && npm run build` |

All 80+ page chunks compiled cleanly. No TypeScript or bundler errors.

---

## 3. Database Schema Drift

**Result: ❌ CRITICAL — multiple tables/columns missing from `supabase/migrations/`**

### Critical severity

**`consultation_forms`, `consultation_form_fields`, `consultation_responses` — tables absent from supabase/migrations/**

These three tables exist only in the orphaned `backend/src/migrations/009_consultation_forms.sql` file and were never promoted into `supabase/migrations/`. Every query in `consultation-forms.js` (13 `.from('consultation_forms')` calls), plus references in `booking.js`, `setup.js`, and `agent-status.js`, will hard-fail at runtime.

*Fix:* Promote `backend/src/migrations/009_consultation_forms.sql` into `supabase/migrations/` as a new numbered migration.

---

**`referrals` — schema collision between migrations 007 and 023**

Migration `007_all_features.sql` created `referrals` with columns `referrer_id`, `referred_id`, `referrer_reward_cents`, `referred_reward_cents`. Migration `023_referrals.sql` then issued `CREATE TABLE IF NOT EXISTS referrals` with a completely different schema — but the `IF NOT EXISTS` guard made it a silent no-op. The `referrals.js` route uses the 023-era column names (`referred_client_id`, `referral_code`, `reward_type`, `reward_value_cents`) which don't exist on the actual table.

*Fix:* Replace migration 023's CREATE TABLE with `ALTER TABLE referrals ADD COLUMN IF NOT EXISTS ...` for each new column.

### High severity

| Issue | Details |
|---|---|
| `messages.status` | Column never added via any migration; `notifications.js` and `consultation-forms.js` insert `status: 'sent'/'failed'` |
| `add_ons` extra columns | `category`, `suggest_with`, `auto_suggest` exist only in orphan `backend/src/migrations/010_add_ons_extended.sql`; `features.js` inserts all three |
| `client_memberships` / `membership_plans` | Routes use wrong table names — subscription rows inserted into the plan-definition table; `membership_plans` (referenced in `booking.js`) does not exist in any migration |

### Medium severity

| Issue | Details |
|---|---|
| `product_inventory` | `026_retail_products.sql` has a FK referencing `product_inventory(id)` but that table is never created — migration fails on clean deploy |
| `working_hours` in 027 | `027_multi_location.sql` runs `ALTER TABLE working_hours` but `working_hours` is a JSONB column on `beauticians`, not a table |

### Low severity

| Issue | Details |
|---|---|
| `plans.price_annual_cents` | Used in `20260403_update_plan_tiers.sql` INSERT but column never added via ALTER TABLE |

---

## 4. Dead Code Scan

**Result: ⚠️ 25 unused .jsx files found**

### Pages — no route, no import

These 9 pages have no import and no active route anywhere in `frontend/src/`:

- `frontend/src/pages/AIInsights.jsx`
- `frontend/src/pages/ChurnPrevention.jsx`
- `frontend/src/pages/ClientIntelDashboard.jsx`
- `frontend/src/pages/ClientSegments.jsx`
- `frontend/src/pages/Dashboard.jsx`
- `frontend/src/pages/DemandForecast.jsx`
- `frontend/src/pages/Feedback.jsx`
- `frontend/src/pages/Policies.jsx`
- `frontend/src/pages/RevenueGoals.jsx`

> Note: `App.jsx` (comment at line 422–423) explicitly records that the client-intelligence stack (`AIInsights`, `ClientIntelDashboard`, `ClientSegments`, `ChurnPrevention`, `DemandForecast`) was intentionally hidden on 2026-06-16. Files kept for potential restoration.

### Pages — dead lazy imports (variable imported but never rendered in a Route)

- `frontend/src/pages/ApprovalQueue.jsx` — `/approval-queue` redirects to `/outbox`
- `frontend/src/pages/CommsLog.jsx` — `/comms` redirects to `/inbox`
- `frontend/src/pages/WeeklyDigest.jsx` — `/digest` redirects to `/analytics`

### Components — not imported anywhere

- `frontend/src/components/PageScaffold.jsx`
- `frontend/src/components/Turnstile.jsx` (`BookingPage.jsx` uses its own inline `TurnstileWidget`)

### Components — only referenced by the unused `Dashboard.jsx`

- `frontend/src/components/AgentAvatars.jsx`
- `frontend/src/components/SetupChecklist.jsx`
- `frontend/src/components/SpotlightSearch.jsx`

### UI library — barrel file never imported

The entire `frontend/src/components/ui/` sub-library was built but `ui/index.js` is never imported anywhere:

- `Badge.jsx`, `Button.jsx`, `Card.jsx`, `EmptyState.jsx`, `Input.jsx`, `Skeleton.jsx`, `Toast.jsx`, `Toggle.jsx`

---

## 5. Dependency Audit

### Frontend (`frontend/`) — 28 vulnerabilities (12 high, 15 moderate, 1 low)

| Package | Severity | Issue | Fix |
|---|---|---|---|
| `xlsx` | **HIGH** | Prototype Pollution (GHSA-4r6h-8v6p-xvw6) + ReDoS (GHSA-5pgg-2g8v-p4x9) | ⚠️ **No fix available** |
| `ws` | **HIGH** | Uninitialized memory disclosure + Memory exhaustion DoS | `npm audit fix` |
| `vite` | **HIGH** | `server.fs.deny` bypass on Windows (GHSA-fx2h-pf6j-xcff) | `npm audit fix` |
| `launch-editor` | **HIGH** | NTLMv2 hash disclosure on Windows (GHSA-v6wh-96g9-6wx3) | `npm audit fix` |

> The `xlsx` vulnerability has no upstream fix. Evaluate replacing with an alternative (e.g. `exceljs`, `papaparse` for CSV-only flows).

### Backend (`backend/`) — 24 vulnerabilities (2 high, 22 moderate)

| Package | Severity | Issue | Fix |
|---|---|---|---|
| `ws` | **HIGH** | Uninitialized memory disclosure + Memory exhaustion DoS (GHSA-58qx-3vcg-4xpx, GHSA-96hv-2xvq-fx4p) | `npm audit fix` |
| `form-data` | moderate | CRLF injection via unescaped multipart field names (GHSA-hmw2-7cc7-3qxx) | `npm audit fix` |
| `qs` / `body-parser` / `express` | moderate | DoS via null entries in comma-format arrays (GHSA-q8mj-m7cp-5q26) | `npm audit fix` |

---

## Summary

| Check | Status |
|---|---|
| API Health | ❌ **DOWN** — connection refused |
| Frontend Build | ✅ Pass |
| Schema Drift | ❌ **Critical** — 3 missing tables, referrals schema collision, 5 more high/medium issues |
| Dead Code | ⚠️ 25 unused .jsx files (9 intentionally hidden, 16 unintentional) |
| Dependency Audit (frontend) | ⚠️ 12 high vulns incl. `xlsx` with no fix |
| Dependency Audit (backend) | ⚠️ 2 high vulns, fixable via `npm audit fix` |

### Recommended immediate actions

1. **Investigate why `api.florrie.ai` is unreachable** — server process may be down
2. **Fix `referrals` schema collision** — active production data is being written to wrong columns
3. **Promote `backend/src/migrations/009_consultation_forms.sql`** to `supabase/migrations/` — consultation form endpoints are dead
4. **Run `npm audit fix`** in both `frontend/` and `backend/` to clear the fixable high-severity vulns
5. **Evaluate `xlsx` replacement** — no upstream fix available for the prototype pollution / ReDoS vulnerabilities
