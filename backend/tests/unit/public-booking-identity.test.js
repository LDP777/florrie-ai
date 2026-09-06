import { beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';

const state = vi.hoisted(() => ({ queries: [], user: null, authError: null, rows: {}, errors: {}, writes: 0 }));
vi.mock('../../src/config.js', () => {
  function from(table) {
    const filters = []; const ranges = [];
    const query = { table, filters };
    state.queries.push(query);
    const result = () => ({ data: (state.rows[table] || []).filter(row => filters.every(([key, value]) => row[key] === value) && ranges.every(([key,value]) => row[key] > value)), error: state.errors[table] || null });
    const builder = {
      select() { return builder; }, eq(key, value) { filters.push([key, value]); return builder; },
      ilike(key, value) { query.emailPattern = value; filters.push([key, value.replace(/\\([\\%_])/g, '$1').toLowerCase()]); return builder; },
      gt(key,value) { query.greaterThan = [key,value]; ranges.push([key,value]); return builder; }, gte() { return builder; }, lte() { return builder; },
      in() { return builder; }, not() { return builder; }, neq() { return builder; }, order() { return builder; }, limit() { return builder; },
      maybeSingle() { const r = result(); return Promise.resolve({ data: r.data[0] || null, error: r.error }); },
      single() { return builder.maybeSingle(); },
      insert() { state.writes++; throw new Error('Unexpected mutation'); }, update() { state.writes++; throw new Error('Unexpected mutation'); },
      then(resolve) { return Promise.resolve(result()).then(resolve); },
    };
    return builder;
  }
  return { supabase: { from }, supabaseAnon: { auth: { getUser: async () => ({ data: { user: state.user }, error: state.authError }) } } };
});
vi.mock('../../src/lib/logger.js', () => ({ default: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } }));
vi.mock('../../src/services/outstanding-balance.js', () => ({ getOutstandingBalanceCents: async () => ({ owesCents: 0 }) }));
const { default: router } = await import('../../src/routes/booking.js');
const { requireBookingIdentity, exactEmailPattern } = await import('../../src/lib/booking-identity.js');
const { managementLinkActive } = await import('../../src/lib/booking-management-access.js');
const app = express(); app.use(express.json()); app.use('/api/booking', router);
app.post('/proof', requireBookingIdentity, (req,res) => res.json({ email: req.body.client_email }));
const server = createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
afterAll(() => new Promise(resolve => server.close(resolve)));
const request = async (path, body, token) => {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
};
beforeEach(() => {
  state.errors = {}; state.queries = []; state.user = null; state.authError = null; state.writes = 0;
  state.rows = { beauticians: [{ id: 'salon', booking_slug: 'test' }], clients: [
    { id: 'owner-client', beautician_id: 'salon', email: 'owner@example.com', first_name: 'Owner', phone: '07700000001' },
    { id: 'victim-client', beautician_id: 'salon', email: 'victim@example.com', first_name: 'Victim', phone: '07700000002' },
  ] };
});

describe('public booking proof boundary', () => {
  for (const endpoint of ['lookup-client', 'check-packages', 'check-member', 'book']) {
    it(`${endpoint} rejects invented email/phone/package claims before reading records`, async () => {
      const result = await request(`/api/booking/test/${endpoint}`, { email: 'victim@example.com', phone: '000000002', client_package_id: 'victim-package' });
      expect(result.status).toBe(401); expect(state.queries).toHaveLength(0); expect(state.writes).toBe(0);
      expect(JSON.stringify(result.body)).not.toContain('victim');
    });
  }
  it('unconfirmed or invalid sessions cannot reveal membership or package data', async () => {
    state.user = { id: 'public-auth', email: 'owner@example.com' };
    expect((await request('/api/booking/test/check-packages', { phone: '000000002' }, 'unconfirmed')).status).toBe(401);
    state.user.email_confirmed_at = new Date().toISOString(); state.authError = { message: 'invalid' };
    expect((await request('/api/booking/test/check-member', { phone: '000000002' }, 'invalid')).status).toBe(401);
    expect(state.queries).toHaveLength(0);
  });
  it('verified identity ignores a different typed email and phone', async () => {
    state.user = { id: 'public-auth', email: 'Owner@Example.com', email_confirmed_at: new Date().toISOString() };
    const proof = await request('/proof', { client_email: 'victim@example.com' }, 'verified');
    expect(proof.body.email).toBe('owner@example.com');
    const result = await request('/api/booking/test/check-packages', { email: 'victim@example.com', phone: '000000002' }, 'verified');
    expect(result.status).toBe(200);
    expect(state.queries.find(q => q.table === 'clients').emailPattern).toBe('owner@example.com');
    expect(state.queries.find(q => q.table === 'client_packages').filters).toContainEqual(['client_id', 'owner-client']);
    expect(state.writes).toBe(0);
  });
  it('lookup returns only the verified client despite another client’s phone', async () => {
    state.user = { id: 'public-auth', email: 'owner@example.com', email_confirmed_at: new Date().toISOString() };
    const response = await request('/api/booking/test/lookup-client', { email: 'victim@example.com', phone: '07700000002' }, 'verified');
    expect(response.status).toBe(200);
    expect(response.body.client.clientId).toBe('owner-client');
    expect(JSON.stringify(response.body)).not.toContain('victim');
  });
  it('failed client reads cannot masquerade as a new client or missing benefits', async () => {
    state.user = { id: 'public-auth', email: 'owner@example.com', email_confirmed_at: new Date().toISOString() };
    state.errors.clients = { message: 'database unavailable' };
    for (const endpoint of ['lookup-client', 'check-packages', 'check-member']) {
      const response = await request(`/api/booking/test/${endpoint}`, {}, 'verified');
      expect(response.status).toBe(503);
    }
    expect(state.writes).toBe(0);
  });
  it('email wildcard characters cannot match other addresses', () => {
    expect(exactEmailPattern('A_B%tag@example.com')).toBe('a\\_b\\%tag@example.com');
  });
});

describe('management token lifetime and appointment scope', () => {
  it('revokes cancelled links and expires links seven days after the appointment', async () => {
    for (const appointment of [
      { status: 'cancelled', starts_at: new Date(Date.now()+86400000).toISOString() },
      { status: 'completed', starts_at: new Date(Date.now()-8*86400000).toISOString() },
    ]) {
      state.rows.appointments = [{ ...appointment, id: 'old', management_token: 'old-token', beauticians: { booking_slug: 'test' } }];
      expect((await request('/api/booking/test/manage/old-token')).status).toBe(410);
      expect(state.queries.some(q => q.table === 'consultation_responses')).toBe(false);
    }
  });
  it('expired tokens cannot reach manage mutations or resend actions', async () => {
    state.rows.appointments = [{ id: 'old', status: 'completed', starts_at: new Date(Date.now()-8*86400000).toISOString(), management_token: 'old-token', beauticians: { booking_slug: 'test' } }];
    for (const action of ['cancel','reschedule','add-treatment','resend-confirmation']) {
      expect((await request(`/api/booking/test/manage/old-token/${action}`, {})).status).toBe(410);
    }
    expect(state.writes).toBe(0);
  });
  it('unavailable token lookup fails closed', async () => {
    state.errors.appointments = { message: 'timeout' };
    expect((await request('/api/booking/test/manage/token/cancel', {})).status).toBe(503);
    expect(state.writes).toBe(0);
  });
  it('does not accept a valid token under another salon slug', async () => {
    state.rows.appointments = [{ id: 'old', status: 'confirmed', starts_at: new Date(Date.now()+86400000).toISOString(), management_token: 'old-token', beauticians: { booking_slug: 'actual-salon' } }];
    expect((await request('/api/booking/test/manage/old-token')).status).toBe(404);
  });
  it('a current booking token reveals only that appointment’s unexpired pending forms', async () => {
    state.rows.appointments = [{ id: 'current', status: 'confirmed', starts_at: new Date(Date.now()+86400000).toISOString(), management_token: 'current-token', clients: { id: 'owner-client' }, beauticians: { id: 'salon', booking_slug: 'test' }, treatments: { name: 'Cut', duration_minutes: 30, price_cents: 1000 } }];
    const base = { client_id: 'owner-client', beautician_id: 'salon', status: 'pending', expires_at: new Date(Date.now()+86400000).toISOString() };
    state.rows.consultation_responses = [
      { ...base, id: 'allowed', appointment_id: 'current', token: 'current-form' },
      { ...base, id: 'future', appointment_id: 'future', token: 'future-secret' },
      { ...base, id: 'expired', appointment_id: 'current', token: 'expired-secret', expires_at: new Date(Date.now()-1000).toISOString() },
      { ...base, id: 'other-client', appointment_id: 'current', client_id: 'victim-client', token: 'victim-secret' },
    ];
    const response = await request('/api/booking/test/manage/current-token');
    expect(response.status).toBe(200);
    expect(response.body.pendingForms.map(form => form.id)).toEqual(['allowed']);
    expect(JSON.stringify(response.body)).not.toMatch(/future-secret|expired-secret|victim-secret/);
    expect(state.writes).toBe(0);
  });
  it('fails closed for missing dates and treats the exact expiry instant as expired', () => {
    expect(managementLinkActive({ status: 'confirmed' })).toBe(false);
    expect(managementLinkActive({ status: 'completed', ends_at: '2026-09-01T12:00:00Z' }, Date.parse('2026-09-08T12:00:00Z'))).toBe(false);
  });
});
