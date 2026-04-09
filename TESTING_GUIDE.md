# Florrie E2E Testing Guide

## Test Suite Overview

Created comprehensive Playwright test suite with 4 test modules:

1. **booking.spec.ts** (14 tests) — Public booking flow (existing)
2. **manage.spec.ts** (6 tests) — Client manage page (NEW)
3. **dashboard.spec.ts** (9 tests) — Auth smoke tests (NEW)
4. **api.spec.ts** (11 tests) — API smoke tests (NEW)

Total: **40 tests** covering public pages, API endpoints, and error handling.

## Test Infrastructure

### Page Objects
- `BookingPage.ts` — /book/:slug booking flow
- `ManagePage.ts` — /book/:slug/manage/:token client portal
- `LoginPage.ts` — Auth (future)

### Configuration
- Playwright config: `frontend/playwright.config.ts`
- Multiple projects: setup, chromium, booking, manage, dashboard, api, mobile
- Base URL: configurable (prod: https://florrie.ai, local: http://localhost:5173)
- Action timeout: 15s, Navigation timeout: 30s (handles Railway cold starts)

### Running Tests

```bash
cd frontend

# Install browsers (first time only)
npx playwright install chromium

# Run all tests
npx playwright test --reporter=line

# Run specific test file
npx playwright test manage.spec.ts

# Run with headed browser (see it happen)
npx playwright test --headed

# Debug mode
npx playwright test --debug

# UI mode (interactive)
npx playwright test --ui
```

#### Against Local Dev Server
```bash
BASE_URL=http://localhost:5173 npx playwright test
```

#### Against Production
```bash
npx playwright test
# Uses BASE_URL=https://florrie.ai from config
```

## Test Breakdown

### 1. Booking Tests (booking.spec.ts)
- Treatment selection → Date/Time → Client details → Confirm flow
- Edge cases: invalid slug, cancelled payment, confirmed state
- Mobile rendering

**Status:** 14/14 passing (public pages, no auth)

### 2. Manage Page Tests (manage.spec.ts) — NEW
- Invalid token handling (graceful error)
- UUID-format token handling (API 404 resilience)
- Missing slug handling
- Mobile rendering
- No JS crashes on error states

**Coverage:** Token validation, API error handling, responsive design

### 3. Dashboard & Auth Tests (dashboard.spec.ts) — NEW
- Login page renders without JS errors
- Unauthenticated redirect from /dashboard
- Public routes don't crash (/login, /book/slug, /manage)
- Page titles change correctly
- Network resilience

**Coverage:** Auth flows, public page stability, redirect logic

### 4. API Smoke Tests (api.spec.ts) — NEW
- Health check (200 response, fast <2s)
- Booking API (200 for valid, 404 for invalid slug)
- Auth endpoints (proper 4xx for invalid credentials)
- Protected endpoints return 401 without auth
- API response formats (JSON content-type)
- Response time benchmarks

**Status:** Tests created; network disabled in test env (EAI_AGAIN error)

**To run API tests:** Must have external network access or mock responses

## Environment Variables

```bash
# Booking tests
E2E_BOOKING_SLUG=ellindigo        # default

# Auth setup (dashboard tests)
E2E_EMAIL=test@florrie-e2e.dev    # default
E2E_PASSWORD=<required>            # must be set

# Base URL
BASE_URL=http://localhost:5173    # local dev
BASE_URL=https://florrie.ai       # production (default)
```

## Key Test Patterns

### Error Handling
```javascript
const errors: string[] = [];
page.on('pageerror', (err) => errors.push(err.message));

// After test
const critical = errors.filter(e => 
  !e.includes('404') && 
  !e.includes('Failed to fetch')
);
expect(critical).toHaveLength(0);
```

### Page Object Pattern
```typescript
async goto(slug: string) {
  await this.page.goto(`/book/${slug}`);
  await this.page.waitForLoadState('networkidle');
}

async expectLoaded() {
  const content = await this.page.locator('body').textContent();
  expect(content?.length).toBeGreaterThan(10);
}
```

### API Testing
```typescript
const response = await request.get(`${API_BASE}/api/booking/${slug}`);
expect(response.status()).toBe(200);
const body = await response.json();
expect(body).toHaveProperty('beautician');
```

## CI/CD Integration

In GitHub Actions, add:

```yaml
- name: Run E2E tests
  run: |
    cd frontend
    npx playwright install chromium
    npx playwright test --reporter=html
    
- name: Upload test report
  if: always()
  uses: actions/upload-artifact@v3
  with:
    name: playwright-report
    path: frontend/playwright-report/
```

## Troubleshooting

### "Executable doesn't exist"
```bash
npx playwright install chromium
```

### "EAI_AGAIN" DNS errors in API tests
Network access required. Works locally and in CI with network access.

### Page navigation timeout
Increase `navigationTimeout` in playwright.config.ts for slow backends.

### Test failures on production
1. Check if `E2E_BOOKING_SLUG` points to an active beautician
2. Verify /login page has auth form (check for text changes)
3. Check if manage page URL structure matches `/book/:slug/manage/:token`

## Next Steps

1. **Set up E2E_PASSWORD** in CI/CD secrets for auth tests
2. **Mock API responses** for API tests if network is unavailable
3. **Add Visual Regression** tests using Playwright visual comparison
4. **Integrate with BetterStack** for production uptime monitoring
5. **Add Performance Budgets** to bundle analysis

## Files Created

- `frontend/tests/e2e/pages/ManagePage.ts` — Page object
- `frontend/tests/e2e/manage.spec.ts` — 6 tests
- `frontend/tests/e2e/dashboard.spec.ts` — 9 tests
- `frontend/tests/e2e/api.spec.ts` — 11 tests
- Updated `frontend/playwright.config.ts` — Added manage, dashboard, api projects
- Fixed `frontend/tests/e2e/auth.setup.ts` — ES module __dirname issue
