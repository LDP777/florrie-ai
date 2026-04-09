import { Page, expect } from '@playwright/test';

/**
 * Page object for /login — covers login, signup, and confirm modes.
 * Mirrors Login.jsx exactly: labels are "Email" and "Password",
 * buttons use their visible text.
 */
export class LoginPage {
  constructor(readonly page: Page) {}

  get emailInput() {
    return this.page.getByLabel('Email');
  }

  get passwordInput() {
    return this.page.getByLabel('Password');
  }

  get signInButton() {
    return this.page.getByRole('button', { name: 'Sign in' });
  }

  get createAccountButton() {
    return this.page.getByRole('button', { name: 'Create account' });
  }

  get switchToSignupLink() {
    return this.page.getByRole('button', { name: /Don't have an account\? Sign up/ });
  }

  get switchToLoginLink() {
    return this.page.getByRole('button', { name: /Already have an account\? Sign in/ });
  }

  get googleButton() {
    return this.page.getByRole('button', { name: /Continue with Google/ });
  }

  get errorMessage() {
    // Error is rendered as a <p> with red styling — target by likely text or location
    return this.page.locator('p').filter({ hasText: /Invalid|Something went wrong|already exists|required/i }).first();
  }

  get confirmEmailScreen() {
    return this.page.getByText('Check your email');
  }

  get trialNote() {
    return this.page.getByText('14-day free trial. No card required.');
  }

  async goto() {
    await this.page.goto('/login');
    await this.page.waitForLoadState('networkidle');
  }

  async login(email: string, password: string) {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.signInButton.click();
  }

  async signup(email: string, password: string) {
    await this.switchToSignupLink.click();
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.createAccountButton.click();
  }

  async expectError(text: string | RegExp) {
    await expect(this.errorMessage).toContainText(text instanceof RegExp ? text : text);
  }

  async expectConfirmEmailScreen() {
    await expect(this.confirmEmailScreen).toBeVisible();
  }

  async expectRedirectToDashboard() {
    await this.page.waitForURL(/\/$/, { timeout: 10_000 });
  }

  async expectRedirectToOnboarding() {
    await this.page.waitForURL('/onboarding', { timeout: 10_000 });
  }
}
