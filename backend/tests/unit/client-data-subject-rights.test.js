/**
 * Per-client subject access and erasure.
 *
 * Until these routes existed the owner's honest answer to "send me everything
 * you hold on me" was four owner-wide CSVs, and to "delete my data" was that
 * she could not. Both routes are scoped to the signed-in salon (another
 * tenant's client id is a 404, never a 403, see lib/ownership.js), export is
 * all-or-nothing, and erasure anonymises rather than deleting the money and
 * the diary: appointments and transactions are financial records with their
 * own retention basis.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = { rows: {}, errors: {}, deletes: [], updates: [] };

function matches(row, filters) {
  return filters.every(([op, col, val]) => {
    if (op === 'eq') return row[col] === val;
    if (op === 'in') return val.includes(row[col]);
    if (op === 'gt') return row[col] > val;
    return true;
  });
}

function builder(table) {
  const filters = [];
  let op = 'select';
  let patch = null;
  let columns = '*';
  let lim = null;
  const settle = () => {
    const err = state.errors[table];
    if (err) return { data: null, error: err };
    const all = state.rows[table] || [];
    if (op === 'select') {
      // The schema probe asks for one column; an unknown one errors like PostgREST.
      if (table === 'clients' && ['deleted_at', 'archived_at', 'stripe_customer_id'].includes(columns)) {
        return state.clientColumns.includes(columns)
          ? { data: [], error: null }
          : { data: null, error: { code: '42703', message: `column clients.${columns} does not exist` } };
      }
      let rows = all.filter(r => matches(r, filters));
      if (lim) rows = rows.slice(0, lim);
      return { data: rows, error: null };
    }
    if (op === 'delete') {
      const gone = all.filter(r => matches(r, filters));
      state.deletes.push({ table, count: gone.length });
      state.rows[table] = all.filter(r => !matches(r, filters));
      return { data: null, error: null };
    }
    if (op === 'update') {
      state.updates.push({ table, patch });
      const hit = all.filter(r => matches(r, filters));
      for (const r of hit) Object.assign(r, patch);
      return { data: hit, error: null };
    }
    throw new Error(`unexpected op ${op}`);
  };
  const b = {
    select(cols) { if (cols) columns = cols; return b; },
    update(p) { op = 'update'; patch = p; return b; },
    delete() { op = 'delete'; return b; },
    eq(c, v) { filters.push(['eq', c, v]); return b; },
    in(c, v) { filters.push(['in', c, v]); return b; },
    gt(c, v) { filters.push(['gt', c, v]); return b; },
    order() { return b; },
    limit(n) { lim = n; return b; },
    single() {
      return Promise.resolve(settle()).then(r => {
        if (r.error) return r;
        const one = (r.data || [])[0];
        return one ? { data: one, error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
      });
    },
    maybeSingle() { return Promise.resolve(settle()).then(r => (r.error ? r : { data: (r.data || [])[0] || null, error: null })); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({ supabase: { from: builder } }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth: (req, _res, next) => next() }));
vi.mock('../../src/services/client-intelligence.js', () => ({ refreshAllIntelligence: async () => ({}) }), { virtual: true });

const mod = await import('../../src/routes/clients.js');

function handlerFor(path, method) {
  const layer = mod.default.stack.find(l => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function call(path, method, { id, beauticianId = 'b1' }) {
  const req = { params: { id }, body: {}, beautician: { id: beauticianId }, originalUrl: `/api/clients/${id}` };
  let status = 200;
  let payload = null;
  const res = {
    status(s) { status = s; return res; },
    json(p) { payload = p; return res; },
    set() { return res; },
  };
  await handlerFor(path, method)(req, res);
  return { status, payload };
}

const FUTURE = new Date(Date.now() + 70 * 24 * 3600 * 1000).toISOString();
const PAST = new Date(Date.now() - 70 * 24 * 3600 * 1000).toISOString();

// lib/schema-probe.js caches "does clients.deleted_at exist" for five
// minutes per process. Each test moves the clock past that, so a probe result
// from one test cannot leak into the next.
let clock = Date.now();
beforeEach(() => {
  clock += 6 * 60 * 1000;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  state.errors = {};
  state.deletes = [];
  state.updates = [];
  state.clientColumns = ['archived_at', 'stripe_customer_id'];
  state.rows = {
    clients: [
      { id: 'c1', beautician_id: 'b1', first_name: 'Shauna', last_name: 'Byrne', email: 's@example.com', phone: '07700900001', whatsapp_id: 'wa1', instagram_id: 'ig1', notes: 'allergic to latex' },
      { id: 'c2', beautician_id: 'b2', first_name: 'Other', last_name: 'Tenant' },
    ],
    appointments: [
      { id: 'a1', beautician_id: 'b1', client_id: 'c1', status: 'completed', starts_at: PAST },
    ],
    messages: [
      { id: 'm1', beautician_id: 'b1', client_id: 'c1', content: 'hi' },
      { id: 'm2', beautician_id: 'b1', client_id: 'other', content: 'not hers' },
    ],
    transactions: [
      { id: 't1', beautician_id: 'b1', client_id: 'c1', amount_cents: 8000 },
    ],
    consultation_responses: [
      { id: 'r1', beautician_id: 'b1', client_id: 'c1', token: 'secret', status: 'completed', answers: { allergies: 'latex' }, signature_data: 'data:png' },
    ],
    client_intelligence: [{ id: 'ci1', client_id: 'c1' }],
  };
});

describe('GET /api/clients/:id/export', () => {
  it('returns the whole pack, answers included, scoped to the client', async () => {
    const { status, payload } = await call('/:id/export', 'get', { id: 'c1' });
    expect(status).toBe(200);
    expect(payload.client.first_name).toBe('Shauna');
    expect(payload.appointments.map(a => a.id)).toEqual(['a1']);
    expect(payload.messages.map(m => m.id)).toEqual(['m1']);
    expect(payload.transactions.map(t => t.id)).toEqual(['t1']);
    expect(payload.consultation_responses[0].answers).toEqual({ allergies: 'latex' });
    expect(payload.consultation_responses[0]).not.toHaveProperty('token');
  });

  it("404s on another tenant's client", async () => {
    const { status } = await call('/:id/export', 'get', { id: 'c2' });
    expect(status).toBe(404);
  });

  it('refuses a partial pack: one table read failing is a 500, not a smaller export', async () => {
    state.errors.transactions = { code: '42703', message: 'column transactions.client_id does not exist' };
    const { status, payload } = await call('/:id/export', 'get', { id: 'c1' });
    expect(status).toBe(500);
    expect(payload).not.toHaveProperty('appointments');
  });
});

describe('DELETE /api/clients/:id', () => {
  it("404s on another tenant's client and changes nothing", async () => {
    const { status } = await call('/:id', 'delete', { id: 'c2' });
    expect(status).toBe(404);
    expect(state.deletes).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  it('409s while a future confirmed appointment exists', async () => {
    state.rows.appointments.push({ id: 'a2', beautician_id: 'b1', client_id: 'c1', status: 'confirmed', starts_at: FUTURE });
    const { status, payload } = await call('/:id', 'delete', { id: 'c1' });
    expect(status).toBe(409);
    expect(payload.error).toMatch(/Cancel it first/);
    expect(state.deletes).toEqual([]);
    expect(state.rows.clients[0].first_name).toBe('Shauna');
  });

  it('a future CANCELLED appointment does not block erasure', async () => {
    state.rows.appointments.push({ id: 'a2', beautician_id: 'b1', client_id: 'c1', status: 'cancelled_by_client', starts_at: FUTURE });
    const { status } = await call('/:id', 'delete', { id: 'c1' });
    expect(status).toBe(200);
  });

  it('anonymises the row, deletes messages, clears answers, and keeps appointments and transactions', async () => {
    const { status, payload } = await call('/:id', 'delete', { id: 'c1' });
    expect(status).toBe(200);
    expect(payload.erased).toBe(true);

    const c = state.rows.clients.find(r => r.id === 'c1');
    expect(c.first_name).toBe('Deleted client');
    for (const col of ['last_name', 'email', 'phone', 'whatsapp_id', 'instagram_id', 'notes', 'stripe_customer_id']) {
      expect(c[col], col).toBeNull();
    }
    expect(c.archived_at).toBeTruthy();
    // deleted_at does not exist in this database, so it was not written.
    expect(c).not.toHaveProperty('deleted_at');
    expect(payload.deleted_at_recorded).toBe(false);

    // Her messages are gone; the other client's are not.
    expect(state.rows.messages.map(m => m.id)).toEqual(['m2']);
    // Answers cleared, row kept.
    expect(state.rows.consultation_responses[0].answers).toBeNull();
    expect(state.rows.consultation_responses[0].signature_data).toBeNull();
    expect(state.rows.consultation_responses).toHaveLength(1);
    // Money and diary survive.
    expect(state.rows.appointments).toHaveLength(1);
    expect(state.rows.transactions).toHaveLength(1);
    expect(state.deletes.map(d => d.table)).not.toContain('appointments');
    expect(state.deletes.map(d => d.table)).not.toContain('transactions');
  });

  it('stamps deleted_at when the column exists', async () => {
    state.clientColumns.push('deleted_at');
    const { payload } = await call('/:id', 'delete', { id: 'c1' });
    expect(payload.deleted_at_recorded).toBe(true);
    expect(state.rows.clients[0].deleted_at).toBeTruthy();
  });

  it('stops before anonymising when the message delete fails, so the owner can retry', async () => {
    state.errors.messages = { code: 'XX000', message: 'boom' };
    const { status } = await call('/:id', 'delete', { id: 'c1' });
    expect(status).toBe(500);
    expect(state.rows.clients[0].first_name).toBe('Shauna');
  });
});
