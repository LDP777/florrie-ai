import { test as setup } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Auth setup — logs in with a real test account and saves the session
 * so other tests can reuse it without re-logging in each time.
 *
 * Create a dedicated Florrie test account in Supabase before running:
 *   Email: test@florrie-e2e.dev
 *   Password: set via E2E_PASSWORD env var (required)
 *
 * This runs as the "setup" project before chromium tests.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const AUTH_FILE = path.join(__dirname, '../.auth/session.json');

setup('save auth session', async ({ page }) => {
  const email = process.env.E2E_EMAIL || 'test@florrie-e2e.dev';
  const password = process.env.E2E_PASSWORD;

  if (!password) {
    throw new Error('Set E2E_PASSWORD env var before running authenticated tests');
  }

  await page.goto('/login');
  await page.waitForLoadState('networkidle');

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Wait for redirect away from /login
  await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 15_000 });

  // Save session to disk — reused by authenticated tests
  await page.context().storageState({ path: AUTH_FILE });
  console.log(`Auth session saved for ${email}`);
});
