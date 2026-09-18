import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';

process.env.STRIPE_SECRET_KEY = 'sk_test_card_binding';
process.env.FRONTEND_URL = 'https://florrie.invalid';

const state = vi.hoisted(() => ({ session: null, setup: null, method: null, db: {}, writes: [], failRead: false, failWrite: false }));
vi.mock('stripe', () => ({ default: class {
  constructor() {
    this.checkout = { sessions: { retrieve: async () => {
      if (!state.session) throw new Error('No such fixture session');
      return state.session;
    } } };
    this.setupIntents = { retrieve: async () => state.setup };
    this.paymentMethods = { retrieve: async () => state.method };
  }
} }));
vi.mock('../../src/config.js', () => {
  const supabase = { from(table) {
    const filters = [];
    let update;
    const result = () => {
      if ((!update && state.failRead) || (update && state.failWrite)) {
        return { data: null, error: { code: '08006', message: 'Synthetic database failure' } };
      }
      const rows = (state.db[table] || []).filter(row => filters.every(([key, value]) => row[key] === value));
      if (update) {
        state.writes.push({ table, filters: [...filters], update });
        for (const row of rows) Object.assign(row, update);
      }
      return { data: rows, error: null };
    };
    const builder = {
      select() { return builder; },
      eq(key, value) { filters.push([key, value]); return builder; },
      update(value) { update = value; return builder; },
      single() { const r = result(); return Promise.resolve({ ...r, data: r.data?.[0] || null }); },
      maybeSingle() { return builder.single(); },
      then(resolve) { return Promise.resolve(result()).then(resolve); },
    };
    return builder;
  } };
  return { supabase, supabaseAdmin: supabase, supabaseAnon: supabase };
});
vi.mock('../../src/lib/logger.js', () => ({ default: { info() {}, warn() {}, debug() {}, error() {} } }));
vi.mock('@sentry/node', () => ({ captureMessage() {}, captureException() {} }));
vi.mock('../../src/services/notifications.js', () => ({ notifyBookingConfirmed: async () => ({}), sendEmail: async () => ({}) }));
vi.mock('../../src/services/booking-confirmed-alert.js', () => ({ announceBookingConfirmed: async () => ({}) }));
vi.mock('../../src/services/stripe-cleanup.js', () => ({ cleanupStripeEvents: async () => ({}) }));
vi.mock('../../src/services/policy-fees.js', () => ({ chargePolicyFee: async () => ({}) }));

const { default: router } = await import('../../src/routes/stripe.js');
const app = express();
app.use(express.json());
app.use('/api/stripe', router);
const server = createServer(app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
afterAll(() => new Promise(resolve => server.close(resolve)));
const openReturn = async (query = '') => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/stripe/card-saved/cs_fixture${query}`, { redirect: 'manual' });
  return { status: r.status, location: r.headers.get('location'), body: await r.text() };
};

beforeEach(() => {
  state.session = {
    id: 'cs_fixture', mode: 'setup', status: 'complete', customer: 'cus_owner', setup_intent: 'seti_owner',
    metadata: { type: 'save_card', appointment_id: 'appt_owner', beautician_id: 'salon_owner', client_id: 'client_owner' },
  };
  state.setup = { id: 'seti_owner', status: 'succeeded', customer: 'cus_owner', payment_method: 'pm_owner' };
  state.method = { id: 'pm_owner', customer: 'cus_owner' };
  state.db = {
    appointments: [
      { id: 'appt_owner', beautician_id: 'salon_owner', client_id: 'client_owner', stripe_payment_method_id: null },
      { id: 'appt_other', beautician_id: 'salon_other', client_id: 'client_other', stripe_payment_method_id: 'pm_other' },
    ],
    clients: [
      { id: 'client_owner', beautician_id: 'salon_owner', stripe_customer_id: 'cus_owner' },
      { id: 'client_other', beautician_id: 'salon_other', stripe_customer_id: 'cus_other' },
    ],
  };
  state.writes = [];
  state.failRead = false;
  state.failWrite = false;
});

describe('public card-save return binds only the completed session’s own booking', () => {
  it.each(['', '?apt=appt_owner'])('preserves existing successful links (%s)', async query => {
    expect(await openReturn(query)).toMatchObject({ status: 302, location: 'https://florrie.invalid/card/saved' });
    expect(state.db.appointments[0].stripe_payment_method_id).toBe('pm_owner');
    expect(state.db.appointments[1].stripe_payment_method_id).toBe('pm_other');
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toMatchObject({ table: 'appointments', filters: [
      ['id', 'appt_owner'], ['beautician_id', 'salon_owner'], ['client_id', 'client_owner'],
    ] });
  });

  it('accepts expanded Stripe identifiers', async () => {
    state.session.customer = { id: 'cus_owner' };
    state.session.setup_intent = { id: 'seti_owner' };
    state.setup.customer = { id: 'cus_owner' };
    state.setup.payment_method = { id: 'pm_owner' };
    state.method.customer = { id: 'cus_owner' };
    expect((await openReturn()).location).toBe('https://florrie.invalid/card/saved');
    expect(state.db.appointments[0].stripe_payment_method_id).toBe('pm_owner');
  });

  it('rejects a foreign appointment in the return URL before any write', async () => {
    expect((await openReturn('?apt=appt_other')).status).toBe(400);
    expect(state.writes).toEqual([]);
    expect(state.db.appointments[1].stripe_payment_method_id).toBe('pm_other');
  });

  it.each([
    ['missing owner metadata', () => { delete state.session.metadata.beautician_id; }],
    ['a different session purpose', () => { state.session.metadata.type = 'booking'; }],
    ['payment rather than setup mode', () => { state.session.mode = 'payment'; }],
    ['foreign appointment metadata', () => { state.session.metadata.appointment_id = 'appt_other'; }],
    ['foreign salon metadata', () => { state.session.metadata.beautician_id = 'salon_other'; }],
    ['foreign client metadata', () => { state.session.metadata.client_id = 'client_other'; }],
    ['mismatched SetupIntent customer', () => { state.setup.customer = 'cus_other'; }],
    ['mismatched saved customer', () => { state.db.clients[0].stripe_customer_id = 'cus_changed'; }],
    ['mismatched client salon', () => { state.db.clients[0].beautician_id = 'salon_other'; }],
    ['a detached payment method', () => { state.method.customer = null; }],
    ['another customer’s payment method', () => { state.method.customer = 'cus_other'; }],
  ])('rejects %s', async (_label, mutate) => {
    mutate();
    const before = structuredClone(state.db);
    const result = await openReturn();
    expect(result.status).toBe(400);
    expect(result.location).toBe(null);
    expect(state.writes).toEqual([]);
    expect(state.db).toEqual(before);
  });

  it.each(['open', 'expired'])('does not claim success for a %s Checkout', async status => {
    state.session.status = status;
    expect((await openReturn()).location).toBe('https://florrie.invalid/card/cancelled');
    expect(state.writes).toEqual([]);
  });

  it('keeps cancellation separate from a successful save', async () => {
    state.setup.status = 'canceled';
    expect((await openReturn()).location).toBe('https://florrie.invalid/card/cancelled');
    expect(state.writes).toEqual([]);
  });

  it.each(['processing', 'requires_action', 'requires_payment_method', 'requires_confirmation'])('waits for a %s SetupIntent', async status => {
    state.setup.status = status;
    expect((await openReturn()).status).toBe(409);
    expect(state.writes).toEqual([]);
  });

  it.each(['failRead', 'failWrite'])('allows a later retry after %s without a false success', async key => {
    state[key] = true;
    expect((await openReturn()).status).toBe(503);
    expect(state.db.appointments[0].stripe_payment_method_id).toBe(null);
    state[key] = false;
    expect((await openReturn()).location).toBe('https://florrie.invalid/card/saved');
    expect(state.db.appointments[0].stripe_payment_method_id).toBe('pm_owner');
  });

  it('handles a provider read failure without claiming success', async () => {
    state.session = null;
    expect((await openReturn()).status).toBe(503);
    expect(state.writes).toEqual([]);
  });

  it('is safe to reopen the same completed return', async () => {
    await openReturn();
    const before = structuredClone(state.db);
    expect((await openReturn()).location).toBe('https://florrie.invalid/card/saved');
    expect(state.db).toEqual(before);
    expect(state.writes.every(write => write.table === 'appointments')).toBe(true);
  });
});
