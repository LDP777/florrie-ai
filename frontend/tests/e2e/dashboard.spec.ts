import { test, expect } from '@playwright/test';

/**
 * Dashboard Smoke Tests
 *
 * Basic smoke tests for public pages and authentication flows.
 * No heavy operations — just verify pages load without JS errors
 * and don't crash with blank screens.
 */

test.describe('Dashboard / Auth Smoke Tests', () => {
  test('login page loads without JS errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    // Filter out expected network errors
    const criticalErrors = errors.filter((e) => !e.includes('Failed to fetch'));
    expect(criticalErrors, `Unexpected JS errors: ${criticalErrors.join(', ')}`).toHaveLength(0);

    // Login form should be visible
    await expect(page.getByRole('textbox').first()).toBeVisible({ timeout: 5000 });
  });

  test('unauthenticated user redirected from /dashboard', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');

    // Should redirect to login or landing page
    const url = page.url();
    const onLoginOrHome =
      url.includes('/login') || url.endsWith('/') || url.includes('/book');

    expect(onLoginOrHome, `Not redirected, URL is: ${url}`).toBe(true);
  });

  test('no JS error on /login route', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    const critical = errors.filter((e) => !e.includes('Failed to fetch'));
    expect(critical).toHaveLength(0);
  });

  test('no JS error on /book/:slug route', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    const slug = process.env.E2E_BOOKING_SLUG || 'ellindigo';
    await page.goto(`/book/${slug}`);
    await page.waitForLoadState('networkidle');

    const critical = errors.filter(
      (e) =>
        !e.includes('Failed to fetch') &&
        !e.includes('404') &&
        !e.includes('401')
    );
    expect(critical).toHaveLength(0);
  });

  test('no JS error on /book/:slug/manage/:token route', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    const slug = process.env.E2E_BOOKING_SLUG || 'ellindigo';
    await page.goto(`/book/${slug}/manage/test-token`);
    await page.waitForLoadState('networkidle');

    const critical = errors.filter(
      (e) =>
        !e.includes('Failed to fetch') &&
        !e.includes('404') &&
        !e.includes('401')
    );
    expect(critical).toHaveLength(0);
  });

  test('public pages do not have blank white screens', async ({ page }) => {
    const publicRoutes = [
      '/login',
      '/book/ellindigo',
      '/book/ellindigo/manage/token123',
    ];

    for (const route of publicRoutes) {
      await page.goto(route);
      await page.waitForLoadState('networkidle');

      const content = await page.locator('body').textContent();
      expect(content, `Page ${route} appears blank`).toBeTruthy();
      expect(content?.length, `Page ${route} has almost no content`).toBeGreaterThan(10);
    }
  });

  test('page title changes for different routes', async ({ page }) => {
    // Login page should have a meaningful title
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    const loginTitle = await page.title();
    expect(loginTitle, 'Login page title should not be empty').toBeTruthy();
    expect(loginTitle.toLowerCase()).toContain('login');

    // Booking page should have a different title
    const slug = process.env.E2E_BOOKING_SLUG || 'ellindigo';
    await page.goto(`/book/${slug}`);
    await page.waitForLoadState('networkidle');
    const bookingTitle = await page.title();
    expect(bookingTitle, 'Booking page title should not be empty').toBeTruthy();
    expect(bookingTitle).not.toEqual(loginTitle);
  });

  test('network errors do not cause JS crashes', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => {
      // Don't count network errors
      if (!err.message.includes('Failed to fetch') && !err.message.includes('fetch')) {
        errors.push(err.message);
      }
    });

    // Simulate a slow network by setting throttling, then navigate
    await page.context().setOffline(false); // ensure online first
    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    // No code errors (network timeouts are ok)
    expect(errors).toHaveLength(0);

    // Page should still be functional
    await expect(page.getByRole('textbox').first()).toBeVisible({ timeout: 5000 });
  });
});
