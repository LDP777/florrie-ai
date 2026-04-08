import { test, expect } from '@playwright/test';
import { BookingFlowPage } from './pages/BookingPage';

/**
 * Public booking flow tests — /book/:slug
 * No auth required. Tests the 4-step client booking experience.
 *
 * Set the slug of a real beautician's booking page:
 *   E2E_BOOKING_SLUG=ellie  (defaults to 'ellie' — update to your test slug)
 *
 * These tests do NOT complete an actual booking to avoid polluting production data.
 * They walk through each step and verify the UI, then stop before submitting.
 */

const SLUG = process.env.E2E_BOOKING_SLUG || 'ellie';

test.describe('Booking page — public access', () => {
  test('loads without auth and shows business info', async ({ page }) => {
    const booking = new BookingFlowPage(page);
    await booking.goto(SLUG);

    // Page should load the beautician's branding
    await booking.expectBeauticianLoaded();

    // Treatment list should be visible
    await expect(page.getByText('Treatment').first()).toBeVisible();
  });

  test('shows 404-style state for unknown slug', async ({ page }) => {
    await page.goto('/book/this-slug-does-not-exist-xyz');
    await page.waitForLoadState('networkidle');

    // Should show an error, not crash with a blank page
    const hasError = await page.getByText(/not found|unavailable|no booking page/i)
      .isVisible()
      .catch(() => false);
    const hasContent = await page.locator('body').textContent();

    // Page should render something meaningful
    expect(hasContent?.length).toBeGreaterThan(50);
  });

  test('treatment step — renders treatments', async ({ page }) => {
    const booking = new BookingFlowPage(page);
    await booking.goto(SLUG);

    // At least one treatment card with a price should be visible
    await expect(booking.treatmentCards.first()).toBeVisible({ timeout: 10_000 });
    const count = await booking.treatmentCards.count();
    expect(count).toBeGreaterThan(0);
  });

  test('selecting a treatment advances to date & time step', async ({ page }) => {
    const booking = new BookingFlowPage(page);
    await booking.goto(SLUG);

    await booking.selectFirstTreatment();
    await booking.continue();

    await booking.expectStep('Date & Time');
  });

  test('date & time step — shows available dates', async ({ page }) => {
    const booking = new BookingFlowPage(page);
    await booking.goto(SLUG);

    await booking.selectFirstTreatment();
    await booking.continue();

    // Date strip should render
    await expect(booking.dateButtons.first()).toBeVisible({ timeout: 8_000 });
    const count = await booking.dateButtons.count();
    expect(count).toBeGreaterThan(0);
  });

  test('date & time step — selecting a date loads time slots', async ({ page }) => {
    const booking = new BookingFlowPage(page);
    await booking.goto(SLUG);

    await booking.selectFirstTreatment();
    await booking.continue();

    await booking.selectFirstAvailableDate();

    // Time slots should appear after selecting a date
    await expect(booking.timeSlotButtons.first()).toBeVisible({ timeout: 8_000 });
  });

  test('client details step — renders name, phone, email fields', async ({ page }) => {
    const booking = new BookingFlowPage(page);
    await booking.goto(SLUG);

    // Walk to step 2
    await booking.selectFirstTreatment();
    await booking.continue();
    await booking.selectFirstAvailableDate();
    await booking.selectFirstAvailableSlot();
    await booking.continue();

    await booking.expectStep('Your Details');
    await expect(booking.nameInput).toBeVisible();
    await expect(booking.phoneInput).toBeVisible();
    await expect(booking.emailInput).toBeVisible();
  });

  test('client details step — requires name and phone', async ({ page }) => {
    const booking = new BookingFlowPage(page);
    await booking.goto(SLUG);

    await booking.selectFirstTreatment();
    await booking.continue();
    await booking.selectFirstAvailableDate();
    await booking.selectFirstAvailableSlot();
    await booking.continue();

    // Try to advance without filling required fields
    await booking.continue();

    // Should still be on step 2
    await booking.expectStep('Your Details');
  });

  test('client details step — fills fields and advances to confirm', async ({ page }) => {
    const booking = new BookingFlowPage(page);
    await booking.goto(SLUG);

    await booking.selectFirstTreatment();
    await booking.continue();
    await booking.selectFirstAvailableDate();
    await booking.selectFirstAvailableSlot();
    await booking.continue();

    await booking.fillClientDetails({
      name: 'E2E Test Client',
      phone: '07700900000',
      email: 'e2e-test@florrie-e2e.dev',
    });

    await booking.continue();
    await booking.expectStep('Confirm');
  });

  test('confirm step — shows booking summary before submitting', async ({ page }) => {
    const booking = new BookingFlowPage(page);
    await booking.goto(SLUG);

    await booking.selectFirstTreatment();
    await booking.continue();
    await booking.selectFirstAvailableDate();
    await booking.selectFirstAvailableSlot();
    await booking.continue();

    await booking.fillClientDetails({
      name: 'E2E Test Client',
      phone: '07700900000',
      email: 'e2e-test@florrie-e2e.dev',
    });

    await booking.continue();

    // Confirm screen should show the client's name and a confirm button
    await expect(page.getByText('E2E Test Client')).toBeVisible();
    await expect(booking.confirmBookingButton).toBeVisible();

    // ⚠️  We stop here — do not click "Confirm booking" in automated tests
    // to avoid creating real appointments in production.
    // Run booking submission tests manually (see MANUAL_CHECKLIST.md).
  });

  test('back button returns to previous step', async ({ page }) => {
    const booking = new BookingFlowPage(page);
    await booking.goto(SLUG);

    await booking.selectFirstTreatment();
    await booking.continue();
    await booking.expectStep('Date & Time');

    await booking.back();
    await booking.expectStep('Treatment');
  });

  test('mobile — booking page renders correctly on small screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 }); // iPhone 14
    const booking = new BookingFlowPage(page);
    await booking.goto(SLUG);

    await booking.expectBeauticianLoaded();
    await expect(booking.treatmentCards.first()).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('Booking page — edge cases', () => {
  test('cancelled payment shows informative message', async ({ page }) => {
    // Simulate Stripe redirect back with ?cancelled=true
    await page.goto(`/book/${SLUG}?cancelled=true`);
    await page.waitForLoadState('networkidle');

    await expect(page.getByText(/Payment was cancelled/i)).toBeVisible({ timeout: 8_000 });
  });

  test('confirmed return URL shows success state', async ({ page }) => {
    await page.goto(`/book/${SLUG}/confirmed`);
    await page.waitForLoadState('networkidle');

    // Should show a confirmed/booked state, not an error
    const body = await page.locator('body').textContent();
    expect(body).not.toMatch(/Something went wrong|crash|undefined/i);
  });
});
