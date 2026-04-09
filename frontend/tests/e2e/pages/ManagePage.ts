import { Page, Locator } from '@playwright/test';

/**
 * Page object for /book/:slug/manage/:token
 * Client self-service management page for viewing and modifying appointments.
 * No auth required — accessed via management_token.
 */
export class ManagePage {
  readonly page: Page;
  readonly appointmentDetails: Locator;
  readonly cancelButton: Locator;
  readonly rescheduleButton: Locator;
  readonly confirmModal: Locator;
  readonly patchTestSection: Locator;
  readonly errorMessage: Locator;
  readonly loadingSpinner: Locator;

  constructor(page: Page) {
    this.page = page;
    this.appointmentDetails = page.locator('[data-testid="appointment-details"], .appointment-details, .manage-appointment').first();
    this.cancelButton = page.getByRole('button', { name: /cancel/i });
    this.rescheduleButton = page.getByRole('button', { name: /reschedule/i });
    this.confirmModal = page.locator('[role="dialog"], .modal, .confirm-modal').first();
    this.patchTestSection = page.locator('[data-testid="patch-test"], .patch-test-section').first();
    this.errorMessage = page.locator('text=/not found|invalid|expired|error|Something went wrong/i').first();
    this.loadingSpinner = page.locator('[data-testid="loading"], .spinner, .loading').first();
  }

  async navigate(slug: string, token: string) {
    await this.page.goto(`/book/${slug}/manage/${token}`);
    await this.page.waitForLoadState('networkidle');
  }

  async expectLoaded() {
    // Either the appointment details should be visible, or an error message
    // (but not a JS crash or blank page)
    const hasContent = await this.page.locator('body').textContent();
    if (!hasContent || hasContent.trim().length < 10) {
      throw new Error('Page appears to be blank or not loaded');
    }
  }

  async expectError() {
    await this.errorMessage.waitFor({ timeout: 10000 });
  }
}
