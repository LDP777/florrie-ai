import { test, expect } from '@playwright/test';
import { LoginPage } from './pages/LoginPage';

/**
 * Auth tests — login, signup, and validation.
 *
 * These run with the saved auth session for tests that need it,
 * but the login/signup tests themselves start unauthenticated.
 *
 * Setup: create a test account before running:
 *   E2E_EMAIL=test@florrie-e2e.dev
 *   E2E_PASSWORD=your-test-password
 */

const TEST_EMAIL = process.env.E2E_EMAIL || 'test@florrie-e2e.dev';
const TEST_PASSWORD = process.env.E2E_PASSWORD || '';

test.describe('Login page', () => {
  test('renders with email and password fields', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();

    await expect(login.emailInput).toBeVisible();
    await expect(login.passwordInput).toBeVisible();
    await expect(login.signInButton).toBeVisible();
    await expect(login.switchToSignupLink).toBeVisible();
    await expect(login.googleButton).toBeVisible();
  });

  test('shows error on wrong password', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();

    await login.login(TEST_EMAIL, 'definitely-wrong-password');

    // Supabase returns an error — we show it in the UI
    await expect(login.errorMessage).toBeVisible({ timeout: 8_000 });
  });

  test('shows error on empty submission', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();

    // HTML5 required validation fires before the form submits
    await login.signInButton.click();
    // Email input should still be focused / show browser validation
    await expect(login.emailInput).toBeFocused();
  });

  test('switches to signup mode', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();

    await login.switchToSignupLink.click();

    await expect(login.createAccountButton).toBeVisible();
    await expect(login.trialNote).toBeVisible();
    await expect(login.switchToLoginLink).toBeVisible();
  });

  test('switches back to login from signup', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();

    await login.switchToSignupLink.click();
    await login.switchToLoginLink.click();

    await expect(login.signInButton).toBeVisible();
    await expect(login.switchToSignupLink).toBeVisible();
  });

  test('signup with existing email shows error', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();

    // Try signing up with the test account that already exists
    await login.signup(TEST_EMAIL, 'somepassword123');

    // Should show an error — either "already exists" or redirect to confirm
    const errorVisible = await login.errorMessage.isVisible().catch(() => false);
    const confirmVisible = await login.confirmEmailScreen.isVisible().catch(() => false);
    expect(errorVisible || confirmVisible).toBeTruthy();
  });

  test('signup shows confirm email screen when email confirmation required', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();

    // Use a unique email that won't exist
    const uniqueEmail = `e2e-${Date.now()}@florrie-e2e.dev`;
    await login.signup(uniqueEmail, 'testpassword123');

    // Supabase may require email confirmation — if so, confirm screen shows
    // Or it auto-confirms and redirects to /onboarding — both are valid
    const confirmVisible = await login.confirmEmailScreen.isVisible({ timeout: 5_000 }).catch(() => false);
    const onOnboarding = page.url().includes('/onboarding');
    const onDashboard = !page.url().includes('/login');

    expect(confirmVisible || onOnboarding || onDashboard).toBeTruthy();
  });
});

test.describe('Successful login', () => {
  test.skip(!TEST_PASSWORD, 'Set E2E_PASSWORD to run login tests');

  test('valid credentials redirect to dashboard', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.login(TEST_EMAIL, TEST_PASSWORD);

    // Should land on dashboard (/) not /login
    await expect(page).not.toHaveURL(/\/login/);
    await page.waitForLoadState('networkidle');
  });

  test('landing page redirects logged-in user', async ({ page }) => {
    // After login, visiting /login should redirect away
    const login = new LoginPage(page);
    await login.goto();
    await login.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForURL(url => !url.pathname.includes('/login'));

    // Try going back to /login
    await page.goto('/login');
    await expect(page).not.toHaveURL(/\/login/);
  });
});

test.describe('Onboarding flow', () => {
  test.skip(!TEST_PASSWORD, 'Set E2E_PASSWORD to run onboarding tests');

  test('new account lands on onboarding', async ({ page }) => {
    // This test requires a brand new account — skip in CI unless you
    // provision a fresh Supabase user each run
    test.skip(true, 'Requires fresh account — run manually against a new test user');
  });

  test('onboarding step 1 — name and business name required', async ({ page }) => {
    // Navigate directly (assumes already logged in via saved session)
    await page.goto('/onboarding');
    await page.waitForLoadState('networkidle');

    // Step 1 should show
    await expect(page.getByText('Welcome to florrie.ai')).toBeVisible();

    // Try to proceed without filling fields
    const continueBtn = page.getByRole('button', { name: /Continue|Next/i });
    await continueBtn.click();

    // Should stay on step 1 or show validation
    await expect(page.getByText('Welcome to florrie.ai')).toBeVisible();
  });

  test('onboarding step 1 — fills and advances', async ({ page }) => {
    await page.goto('/onboarding');
    await page.waitForLoadState('networkidle');

    await page.getByLabel('Your first name').fill('Test');
    await page.getByLabel('Business name').fill('Test Brows');

    await page.getByRole('button', { name: /Continue|Next/i }).click();

    // Step 2: treatments
    await expect(page.getByText('Your treatments')).toBeVisible({ timeout: 5_000 });
  });
});
