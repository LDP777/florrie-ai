import { defineConfig, devices } from '@playwright/test';

/**
 * Florrie E2E test config.
 *
 * Run against prod:  npx playwright test
 * Run against local: BASE_URL=http://localhost:5173 npx playwright test
 *
 * First run:  npx playwright install chromium
 * Headed:     npx playwright test --headed
 * Debug:      npx playwright test --debug
 * UI mode:    npx playwright test --ui
 */

const BASE_URL = process.env.BASE_URL || 'https://florrie.ai';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // sequential — tests share a real DB/backend
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['list'],
  ],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Give the app time to respond — Railway cold starts can be slow
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    // Auth state setup — runs first, saves session to file
    {
      name: 'setup',
      testMatch: '**/auth.setup.ts',
    },
    // Main test suite — Chromium only for speed
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
    // Public booking page — no auth needed, can run in parallel
    {
      name: 'booking',
      testMatch: '**/booking.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    // Client manage page tests
    {
      name: 'manage',
      testMatch: '**/manage.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    // Dashboard and auth smoke tests
    {
      name: 'dashboard',
      testMatch: '**/dashboard.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    // API smoke tests
    {
      name: 'api',
      testMatch: '**/api.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    // Mobile smoke test
    {
      name: 'mobile',
      testMatch: '**/booking.spec.ts',
      use: { ...devices['iPhone 14'] },
    },
  ],
});
