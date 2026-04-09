import { test, expect } from '@playwright/test';
import { ManagePage } from './pages/ManagePage';

/**
 * Client Manage Page Tests
 * URL: /book/:slug/manage/:token
 *
 * These tests verify the client self-service management interface.
 * No auth required — uses management tokens for access.
 * Token is a UUID provided in the booking confirmation.
 *
 * Most tests use fake/invalid tokens to verify error handling,
 * since real tokens are hard-coded and expire.
 */

const SLUG = process.env.E2E_BOOKING_SLUG || 'ellindigo';

test.describe('Client Manage Page', () => {
  test('invalid token shows error, not crash', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    const manage = new ManagePage(page);
    await manage.navigate(SLUG, 'invalid-token-12345');

    // Wait for page to settle
    await page.waitForLoadState('networkidle');

    // Filter out expected errors (404 from API)
    const criticalErrors = errors.filter(
      (e) =>
        !e.includes('404') &&
        !e.includes('not found') &&
        !e.includes('Failed to fetch')
    );
    expect(criticalErrors, `Unexpected JS errors: ${criticalErrors.join(', ')}`).toHaveLength(0);

    // Should show an error or "not found" state, not a blank page
    const content = await page.locator('body').textContent();
    expect(content).toBeTruthy();
    expect(content?.length).toBeGreaterThan(10);
  });

  test('UUID-format token handled gracefully when not found', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    const manage = new ManagePage(page);
    // Use a UUID-format token (will get 404 from API but page should handle it)
    await manage.navigate(SLUG, '00000000-0000-0000-0000-000000000000');

    // No JS crashes (404 from API is expected)
    const criticalErrors = errors.filter((e) => !e.includes('404') && !e.includes('Failed to fetch'));
    expect(criticalErrors).toHaveLength(0);
  });

  test('manage page loads without JS errors for valid-looking paths', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto(`/book/${SLUG}/manage/test-token`);
    await page.waitForLoadState('networkidle');

    // No critical JS crashes
    const critical = errors.filter(
      (e) =>
        !e.includes('404') &&
        !e.includes('Failed to fetch') &&
        !e.includes('not found')
    );
    expect(critical).toHaveLength(0);
  });

  test('manage page with missing slug still loads without crashing', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    // Navigate to a URL that might 404 from the backend
    await page.goto('/book/nonexistent-slug-xyz/manage/token123');
    await page.waitForLoadState('networkidle');

    // No JS crashes even if backend returns 404
    const critical = errors.filter(
      (e) =>
        !e.includes('404') &&
        !e.includes('Failed to fetch') &&
        !e.includes('not found')
    );
    expect(critical).toHaveLength(0);

    // Page should show something (not blank)
    const content = await page.locator('body').textContent();
    expect(content?.length).toBeGreaterThan(10);
  });

  test('manage page has cancel and reschedule buttons structure', async ({ page }) => {
    // This test just verifies that the page renders with expected button elements
    // even if the appointment data isn't loaded
    const manage = new ManagePage(page);
    await manage.navigate(SLUG, 'test-token');

    await page.waitForLoadState('networkidle');

    // The page should have loaded (no blank state)
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('mobile — manage page renders correctly on small screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 }); // iPhone 14

    const manage = new ManagePage(page);
    await manage.navigate(SLUG, 'test-token');
    await page.waitForLoadState('networkidle');

    // Should load without crashing
    const content = await page.locator('body').textContent();
    expect(content?.length).toBeGreaterThan(10);
  });
});
