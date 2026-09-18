import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';

process.env.STRIPE_SECRET_KEY = 'sk_test_checkout_ownership';
process.env.FRONTEND_URL = 'https://florrie.invalid';

// Keep the real authentication middleware, ownership helper and route. Only
// provider clients are replaced; every record below belongs to this fixture.
const state = vi.hoisted(() => ({ salons: [], appointments: [], writes: [], appointmentReadError: null }));
const createCheckout = vi.hoisted(() => vi.fn(async () => ({
  id: 'cs_fixture', url: 'https://checkout.invalid/fixture', payment_intent: 'pi_fixture',
})));
vi.mock('stripe', () => ({ default: class {
  constructor() { this.checkout = { sessions: { create: createCheckout } }; }
} }));
vi.mock('../../src/config.js', () => {
  const supabase = {
    from(table) {
      const filters = [];
      let update;
      const result = () => {
        if (table === 'appointments' && !update && state.appointmentReadError) {
          return { data: null, error: state.appointmentReadError };
        }
        const rows = (table === 'beauticians' ? state.salons : state.appointments)
          .filter(row => filters.every(([field, value]) => row[field] === value));
        if (update) {
          state.writes.push({ table, filters: [...filters], update });
          for (const row of rows) Object.assign(row, update);
        }
        return { data: rows, error: null };
      };
      const builder = {
        select() { return builder; },
        eq(field, value) { filters.push([field, value]); return builder; },
        update(value) { update = value; return builder; },
        single() { const r = result(); return Promise.resolve({ ...r, data: r.data?.[0] || null }); },
        maybeSingle() { return builder.single(); },
        then(resolve) { return Promise.resolve(result()).then(resolve); },
      };
      return builder;
    },
  };
  return { supabase, supabaseAdmin: supabase, supabaseAnon: { auth: {
    getUser: async token => token === 'owner-token'
      ? { data: { user: { id: 'owner-auth' } }, error: null }
      : { data: { user: null }, error: { message: 'Invalid test token' } },
  } } };
});
vi.mock('../../src/lib/logger.js', () => ({ default: { info() {}, warn() {}, debug() {}, error() {} } }));
vi.mock('@sentry/node', () => ({ captureMessage() {}, captureException() {} }));
vi.mock('../../src/services/notifications.js', () => ({ notifyBookingConfirmed: async () => ({}), sendEmail: async () => ({}) }));
vi.mock('../../src/services/booking-confirmed-alert.js', () => ({ announceBookingConfirmed: async () => ({}) }));
vi.mock('../../src/services/stripe-cleanup.js', () => ({ cleanupStripeEvents: async () => ({}) }));
vi.mock('../../src/services/policy-fees.js', () => ({ chargePolicyFee: async () => ({}) }));

const { default: stripeRouter } = await import('../../src/routes/stripe.js');
const { idempotencyGuard } = await import('../../src/middleware/security.js');
const app = express();
app.use(express.json());
app.use('/api/stripe', idempotencyGuard, stripeRouter);
const server = createServer(app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
afterAll(() => new Promise(resolve => server.close(resolve)));

const request = async (overrides = {}, token = 'owner-token') => {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/stripe/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ appointment_id: 'owner-appointment', beautician_id: 'owner-salon', amount_cents: 1000, ...overrides }),
  });
  return { status: response.status, body: await response.json() };
};

beforeEach(() => {
  createCheckout.mockClear();
  state.appointmentReadError = null;
  state.writes = [];
  state.salons = [
    { id: 'owner-salon', auth_id: 'owner-auth', stripe_account_id: 'acct_owner', stripe_onboarding_complete: true, subscription_plan: 'florrie', subscription_status: 'active' },
    { id: 'other-salon', auth_id: 'other-auth', stripe_account_id: 'acct_other', stripe_onboarding_complete: true },
  ];
  state.appointments = [
    { id: 'owner-appointment', beautician_id: 'owner-salon', deposit_amount_cents: 600, deposit_status: 'unpaid' },
    { id: 'other-appointment', beautician_id: 'other-salon', deposit_amount_cents: 900, deposit_status: 'paid' },
  ];
});

describe('authenticated booking checkout stays within the signed-in salon', () => {
  it('preserves the owner checkout, its fee and its deposit update', async () => {
    const otherBefore = { ...state.appointments[1] };
    const response = await request({ description: 'Fictional booking deposit' });
    expect(response).toEqual({ status: 200, body: { url: 'https://checkout.invalid/fixture', session_id: 'cs_fixture' } });
    expect(createCheckout).toHaveBeenCalledTimes(1);
    const params = createCheckout.mock.calls[0][0];
    expect(params.payment_intent_data).toMatchObject({
      application_fee_amount: 50, transfer_data: { destination: 'acct_owner' },
      metadata: { appointment_id: 'owner-appointment', beautician_id: 'owner-salon' },
    });
    expect(params.metadata).toEqual({ appointment_id: 'owner-appointment', beautician_id: 'owner-salon' });
    expect(params.line_items[0].price_data).toMatchObject({ unit_amount: 1000, product_data: { name: 'Fictional booking deposit' } });
    expect(state.appointments[0]).toMatchObject({ deposit_amount_cents: 1000, deposit_status: 'pending', stripe_payment_intent_id: 'pi_fixture' });
    expect(state.appointments[1]).toEqual(otherBefore);
    expect(state.writes[0].filters).toContainEqual(['beautician_id', 'owner-salon']);
  });

  it.each([
    ['another salon destination', { beautician_id: 'other-salon' }],
    ['another salon appointment', { appointment_id: 'other-appointment' }],
    ['both foreign identifiers', { beautician_id: 'other-salon', appointment_id: 'other-appointment' }],
    ['a nonexistent appointment', { appointment_id: 'missing-appointment' }],
    ['a nonexistent salon', { beautician_id: 'missing-salon' }],
  ])('rejects %s without creating a session or changing a booking', async (_label, body) => {
    const before = structuredClone(state.appointments);
    expect(await request(body)).toEqual({ status: 404, body: { error: 'Not found' } });
    expect(createCheckout).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
    expect(state.appointments).toEqual(before);
  });

  it.each([null, 'invalid-token'])('rejects an unauthenticated or invalid session (%s)', async token => {
    expect((await request({}, token)).status).toBe(401);
    expect(createCheckout).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
  });

  it('fails closed if ownership cannot be checked', async () => {
    state.appointmentReadError = { code: '08006', message: 'Synthetic database failure' };
    expect((await request()).status).toBe(500);
    expect(createCheckout).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
  });

  it('treats a malformed appointment ID like a missing one', async () => {
    state.appointmentReadError = { code: '22P02', message: 'invalid input syntax for type uuid' };
    expect(await request({ appointment_id: 'not-a-uuid' })).toEqual({ status: 404, body: { error: 'Not found' } });
    expect(createCheckout).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
  });
});
