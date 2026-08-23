/**
 * The cron endpoints were open to the world whenever CRON_SECRET was unset.
 *
 * Both routes did this:
 *
 *     const cronKey = req.headers['x-cron-key'];
 *     if (cronKey !== process.env.CRON_SECRET) return res.status(401)...
 *
 * With no header and no secret that reads `undefined !== undefined`, which is
 * false, so the handler ran. And CRON_SECRET is in neither REQUIRED_ENV nor
 * OPTIONAL_ENV in index.js, so the server never warned that it was missing.
 * Anybody who knew the path could POST /api/notifications/process-reminders
 * and fire the 24 hour reminder pass for every tenant, over and over, burning
 * the SMS allowance and re-texting clients who had already been told.
 *
 * The rule these pin: there is no combination of inputs that runs the work
 * without a configured secret AND a matching header.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';

const ran = { reminders: 0, cleanup: 0 };

vi.mock('../../src/lib/logger.js', () => ({ default: { info() {}, warn() {}, error() {}, debug() {}, fatal() {} } }));
vi.mock('@sentry/node', () => ({ captureMessage() {}, captureException() {}, setUser() {} }));
vi.mock('../../src/config.js', () => {
  const b = { select: () => b, eq: () => b, insert: () => b, update: () => b,
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => ({ data: null, error: null }),
    then: (r) => Promise.resolve({ data: [], error: null }).then(r) };
  const supabase = { from: () => b };
  return { supabase, supabaseAnon: supabase, supabaseAdmin: supabase };
});
vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.beautician = { id: 'biz-1' }; next(); },
}));
vi.mock('../../src/services/notifications.js', () => ({
  processReminders: async () => { ran.reminders += 1; return { sent: 99 }; },
  sendSMS: async () => ({}), sendEmail: async () => ({}),
  notifyBookingConfirmed: async () => ({}),
}));
vi.mock('../../src/services/sms-metering.js', () => ({ getSMSUsage: async () => ({}) }));
vi.mock('../../src/services/stripe-cleanup.js', () => ({
  cleanupStripeEvents: async () => { ran.cleanup += 1; return { deleted: 7 }; },
}));
vi.mock('../../src/services/push-notifications.js', () => ({ pushBookingConfirmed: async () => {} }));
vi.mock('../../src/services/policy-fees.js', () => ({ chargePolicyFee: async () => ({}) }));
vi.mock('stripe', () => ({ default: class { constructor() { return { accounts: {}, refunds: {}, paymentIntents: {}, applicationFees: {} }; } } }));

const { default: notificationRouter } = await import('../../src/routes/notifications.js');
const { default: stripeRouter } = await import('../../src/routes/stripe.js');

const app = express();
app.use(express.json());
app.use('/api/notifications', notificationRouter);
app.use('/api/stripe', stripeRouter);
const server = createServer(app);
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;

const post = (path, headers = {}) => fetch(`http://127.0.0.1:${PORT}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: '{}',
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const ENDPOINTS = [
  ['the 24 hour reminder pass', '/api/notifications/process-reminders', 'reminders'],
  ['the stripe event cleanup', '/api/stripe/cleanup-events', 'cleanup'],
];

let saved;
beforeEach(() => { saved = process.env.CRON_SECRET; ran.reminders = 0; ran.cleanup = 0; });
afterEach(() => {
  if (saved === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = saved;
});

describe.each(ENDPOINTS)('%s', (_name, path, counter) => {
  it('refuses an anonymous caller when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET;
    const r = await post(path);
    expect(r.status).not.toBe(200);
    expect(ran[counter]).toBe(0);
  });

  it('refuses a caller who sends the literal string "undefined"', async () => {
    delete process.env.CRON_SECRET;
    const r = await post(path, { 'x-cron-key': 'undefined' });
    expect(r.status).not.toBe(200);
    expect(ran[counter]).toBe(0);
  });

  it('refuses when CRON_SECRET is set to an empty string', async () => {
    process.env.CRON_SECRET = '';
    const r = await post(path);
    expect(r.status).not.toBe(200);
    expect(ran[counter]).toBe(0);
  });

  it('refuses when CRON_SECRET is whitespace only', async () => {
    process.env.CRON_SECRET = '   ';
    const r = await post(path, { 'x-cron-key': '   ' });
    expect(r.status).not.toBe(200);
    expect(ran[counter]).toBe(0);
  });

  it('says 503, not 401, when the server is the thing that is misconfigured', async () => {
    delete process.env.CRON_SECRET;
    const r = await post(path);
    // A 401 sends whoever runs the cron hunting for a wrong key when the real
    // problem is that nobody set the variable.
    expect(r.status).toBe(503);
  });

  it('refuses a wrong key when CRON_SECRET is set', async () => {
    process.env.CRON_SECRET = 'real-secret';
    const r = await post(path, { 'x-cron-key': 'wrong' });
    expect(r.status).toBe(401);
    expect(ran[counter]).toBe(0);
  });

  it('refuses a missing key when CRON_SECRET is set', async () => {
    process.env.CRON_SECRET = 'real-secret';
    const r = await post(path);
    expect(r.status).toBe(401);
    expect(ran[counter]).toBe(0);
  });

  it('lets the real cron through', async () => {
    process.env.CRON_SECRET = 'real-secret';
    const r = await post(path, { 'x-cron-key': 'real-secret' });
    expect(r.status).toBe(200);
    expect(ran[counter]).toBe(1);
  });
});

describe('requireCronKey on its own', () => {
  it('compares keys of different lengths without throwing', async () => {
    const { requireCronKey } = await import('../../src/middleware/security.js');
    process.env.CRON_SECRET = 'a-long-secret-value';
    let status = 0;
    const res = { status(c) { status = c; return res; }, json() { return res; } };
    requireCronKey({ headers: { 'x-cron-key': 'x' }, ip: '1.2.3.4', path: '/p' }, res, () => { status = 200; });
    expect(status).toBe(401);
  });
});
