import { Page, expect } from '@playwright/test';

/**
 * Page object for /book/:slug
 * 4-step flow: Treatment → Date & Time → Your Details → Confirm
 * Public page — no auth required.
 */
export class BookingFlowPage {
  constructor(readonly page: Page) {}

  // ── Step indicators ──────────────────────────────────────────────

  get stepIndicator() {
    // Shows "Treatment", "Date & Time", "Your Details", "Confirm" tabs
    return this.page.locator('text=Treatment').first();
  }

  // ── Step 0: Treatment selection ──────────────────────────────────

  get treatmentCards() {
    // Each treatment renders as a clickable card with its name
    return this.page.locator('[style*="cursor: pointer"]').filter({ hasText: /£/ });
  }

  async selectFirstTreatment() {
    await this.treatmentCards.first().click();
  }

  async selectTreatmentByName(name: string) {
    await this.page.getByText(name, { exact: false }).first().click();
  }

  // ── Step 1: Date & time ──────────────────────────────────────────

  get dateButtons() {
    // Dates render as clickable buttons in a horizontal strip
    return this.page.locator('button').filter({ hasText: /Mon|Tue|Wed|Thu|Fri|Sat|Sun/ });
  }

  get timeSlotButtons() {
    return this.page.locator('button').filter({ hasText: /AM|PM/ });
  }

  async selectFirstAvailableDate() {
    const dates = this.dateButtons;
    const count = await dates.count();
    for (let i = 0; i < count; i++) {
      const btn = dates.nth(i);
      const isDisabled = await btn.isDisabled();
      if (!isDisabled) {
        await btn.click();
        return;
      }
    }
    throw new Error('No available dates found');
  }

  async selectFirstAvailableSlot() {
    const slots = this.timeSlotButtons;
    await expect(slots.first()).toBeVisible({ timeout: 8_000 });
    await slots.first().click();
  }

  // ── Step 2: Client details ───────────────────────────────────────

  get nameInput() {
    return this.page.getByPlaceholder('Your name *');
  }

  get phoneInput() {
    return this.page.getByPlaceholder('Phone number *');
  }

  get emailInput() {
    return this.page.getByPlaceholder('Email (optional)');
  }

  get notesInput() {
    return this.page.getByPlaceholder('Any notes for your appointment? (optional)');
  }

  async fillClientDetails(details: {
    name: string;
    phone: string;
    email?: string;
    notes?: string;
  }) {
    await this.nameInput.fill(details.name);
    await this.phoneInput.fill(details.phone);
    if (details.email) await this.emailInput.fill(details.email);
    if (details.notes) await this.notesInput.fill(details.notes);
  }

  // ── Navigation buttons ───────────────────────────────────────────

  get continueButton() {
    return this.page.getByRole('button', { name: /Continue|Next|Confirm booking/i }).last();
  }

  get backButton() {
    return this.page.getByRole('button', { name: /← Back/i });
  }

  async continue() {
    await this.continueButton.click();
  }

  async back() {
    await this.backButton.click();
  }

  // ── Step 3: Confirm ──────────────────────────────────────────────

  get confirmBookingButton() {
    return this.page.getByRole('button', { name: /Confirm booking/i });
  }

  get promoCodeInput() {
    return this.page.getByPlaceholder('Promo or gift voucher code');
  }

  // ── Success / error states ───────────────────────────────────────

  get successScreen() {
    return this.page.getByText(/You're booked|confirmed|Booking confirmed/i).first();
  }

  get errorMessage() {
    return this.page.locator('text=/Something went wrong|unavailable|no longer available/i').first();
  }

  // ── Helpers ──────────────────────────────────────────────────────

  async goto(slug: string) {
    await this.page.goto(`/book/${slug}`);
    await this.page.waitForLoadState('networkidle');
  }

  async expectBeauticianLoaded() {
    // The beautician's name or business name should be visible
    await expect(this.page.locator('h1, h2').first()).toBeVisible({ timeout: 10_000 });
  }

  async expectStep(stepName: 'Treatment' | 'Date & Time' | 'Your Details' | 'Confirm') {
    await expect(this.page.getByText(stepName).first()).toBeVisible();
  }
}
