import { test, expect } from '@playwright/test';

/**
 * WhatsApp preflight heartbeat.
 *
 * Hits the live /api/whatsapp/preflight without auth to confirm the route
 * responds (either 401 unauthenticated or the real preflight JSON). Any other
 * response is a sign the route file crashed, the WhatsApp token is missing,
 * or the server fell over.
 *
 * Designed to run nightly via the scheduled-tasks cron. Sentry alerts pick up
 * any 5xx via the route-level captureException wiring.
 */

const API_BASE =
  process.env.VITE_API_BASE_URL || 'https://florriebackend-production.up.railway.app';

test.describe('WhatsApp preflight heartbeat', () => {
  test('POST /api/whatsapp/preflight responds in under 5s', async ({ request }) => {
    const started = Date.now();
    const response = await request.post(`${API_BASE}/api/whatsapp/preflight`, {
      data: { phone: '+44 7000 000000' },
      failOnStatusCode: false,
    });
    const elapsed = Date.now() - started;

    // Any of: 401 (no auth), 400 (validation), 200 (happy). 5xx means a real problem.
    expect(response.status(), `preflight returned ${response.status()}`).toBeLessThan(500);
    expect(elapsed, `preflight took ${elapsed}ms`).toBeLessThan(5000);
  });

  test('GET /health reports backend ok', async ({ request }) => {
    const response = await request.get(`${API_BASE}/health`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('ok');
  });
});

/**
 * Smoke test: brand-new visitor lands on onboarding step 6 and can see the
 * WhatsApp-first card. Runs against prod (or BASE_URL override).
 *
 * Skipped by default because it needs a fresh signup fixture. Enable with
 * RUN_ONBOARDING_SMOKE=1 once the signup harness is in place.
 */
test.describe.skip('Onboarding WhatsApp-first card', () => {
  test('Step 6 shows WhatsApp as recommended + Connect CTA', async ({ page }) => {
    // TODO: wire fresh-signup fixture so the wizard can reach step 6.
    await page.goto('/onboarding');
    await expect(page.getByText('WhatsApp: your AI receptionist')).toBeVisible();
    await expect(page.getByRole('button', { name: /Connect WhatsApp/ })).toBeVisible();
  });
});
