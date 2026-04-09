import { test, expect } from '@playwright/test';

/**
 * API Smoke Tests
 *
 * Direct API tests using Playwright request context.
 * Tests the backend endpoints without needing a browser.
 * These do not require a running dev server — they hit the live backend.
 */

const API_BASE =
  process.env.VITE_API_BASE_URL || 'https://florriebackend-production.up.railway.app';

test.describe('API Smoke Tests', () => {
  test('GET /health returns 200 with ok status', async ({ request }) => {
    const response = await request.get(`${API_BASE}/health`);
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body).toHaveProperty('status');
    expect(body.status).toBe('ok');
  });

  test('GET /api/booking/:slug returns 200 for valid beautician', async ({ request }) => {
    const slug = process.env.E2E_BOOKING_SLUG || 'ellindigo';
    const response = await request.get(`${API_BASE}/api/booking/${slug}`);

    expect(response.status()).toBe(200);
    const body = await response.json();

    // Should have beautician info
    expect(body).toHaveProperty('beautician');
    expect(body.beautician).toHaveProperty('name');
  });

  test('GET /api/booking/:slug returns 404 for invalid slug', async ({ request }) => {
    const response = await request.get(`${API_BASE}/api/booking/this-slug-does-not-exist-xyz`);
    expect(response.status()).toBe(404);
  });

  test('POST /api/auth/login with invalid credentials returns 4xx', async ({ request }) => {
    const response = await request.post(`${API_BASE}/api/auth/login`, {
      data: {
        email: 'notarealuser@test.dev',
        password: 'wrongpassword123',
      },
    });

    // Should reject bad credentials (400, 401, or 422)
    expect([400, 401, 422]).toContain(response.status());
  });

  test('GET /api/appointments without auth returns 401', async ({ request }) => {
    const response = await request.get(`${API_BASE}/api/appointments`, {
      headers: {
        // No Authorization header
      },
    });

    expect(response.status()).toBe(401);
  });

  test('GET /api/clients without auth returns 401', async ({ request }) => {
    const response = await request.get(`${API_BASE}/api/clients`, {
      headers: {
        // No Authorization header
      },
    });

    expect(response.status()).toBe(401);
  });

  test('GET /api/manage/:slug/:token returns 200 or 404 gracefully', async ({ request }) => {
    const slug = process.env.E2E_BOOKING_SLUG || 'ellindigo';
    const response = await request.get(`${API_BASE}/api/manage/${slug}/invalid-token`);

    // Should return 404 (not found) or 400 (bad token), not 500
    expect([400, 404]).toContain(response.status());
  });

  test('API returns JSON for all endpoints', async ({ request }) => {
    const endpoints = [
      '/health',
      `/api/booking/${process.env.E2E_BOOKING_SLUG || 'ellindigo'}`,
    ];

    for (const endpoint of endpoints) {
      const response = await request.get(`${API_BASE}${endpoint}`);

      if (response.ok) {
        const contentType = response.headers()['content-type'];
        expect(contentType).toContain('application/json');
      }
    }
  });

  test('API health check is fast (< 2 seconds)', async ({ request }) => {
    const startTime = Date.now();
    const response = await request.get(`${API_BASE}/health`);
    const duration = Date.now() - startTime;

    expect(response.status()).toBe(200);
    expect(duration).toBeLessThan(2000); // should be fast
  });

  test('API booking endpoint is fast (< 5 seconds)', async ({ request }) => {
    const slug = process.env.E2E_BOOKING_SLUG || 'ellindigo';
    const startTime = Date.now();
    const response = await request.get(`${API_BASE}/api/booking/${slug}`);
    const duration = Date.now() - startTime;

    if (response.ok) {
      expect(duration).toBeLessThan(5000); // reasonable response time
    }
  });
});
