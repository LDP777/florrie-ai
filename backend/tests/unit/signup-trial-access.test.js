import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';

const state = vi.hoisted(() => ({ db: null, race: null, writes: [], welcome: vi.fn() }));
const AUTH_ID = '00000000-0000-4000-8000-000000000001';
const DAY = 86400000;
const future = () => new Date(Date.now() + 3 * DAY).toISOString();
const past = () => new Date(Date.now() - DAY).toISOString();
const quote = name => {
  if (!/^[a-z_]+$/.test(name)) throw new Error('Unsupported test identifier');
  return `"${name}"`;
};

// Run the route's actual inserts/reads through SQL, including the database's
// defaults and unique constraint. Only the PostgREST transport is replaced.
function from(table) {
  let operation = 'select', payload, sort;
  const filters = [];
  async function settle(single = false) {
    const values = [];
    const parameter = value => { values.push(value); return `$${values.length}`; };
    let sql;
    if (operation === 'insert') {
      if (state.race) {
        const raced = state.race;
        state.race = null;
        await insertLegacy(raced);
      }
      const keys = Object.keys(payload);
      sql = `INSERT INTO ${quote(table)} (${keys.map(quote)}) VALUES (${keys.map(k => parameter(payload[k]))}) RETURNING *`;
    } else {
      sql = operation === 'update'
        ? `UPDATE ${quote(table)} SET ${Object.keys(payload).map(k => `${quote(k)}=${parameter(payload[k])}`)}`
        : `SELECT * FROM ${quote(table)}`;
      if (filters.length) sql += ` WHERE ${filters.map(([k, v]) => `${quote(k)}=${parameter(v)}`).join(' AND ')}`;
      if (operation === 'update') sql += ' RETURNING *';
      else if (sort) sql += ` ORDER BY ${quote(sort)}`;
    }
    if (operation !== 'select') state.writes.push({ table, operation, payload });
    try {
      const { rows } = await state.db.query(sql, values);
      return { data: single ? rows[0] || null : rows, error: null };
    } catch (error) { return { data: null, error: { code: error.code, message: error.message } }; }
  }
  const builder = {
    select: () => builder,
    insert: data => { operation = 'insert'; payload = data; return builder; },
    update: data => { operation = 'update'; payload = data; return builder; },
    eq: (key, value) => { filters.push([key, value]); return builder; },
    order: key => { sort = key; return builder; },
    maybeSingle: () => settle(true),
    single: () => settle(true),
    then: (resolve, reject) => settle().then(resolve, reject),
  };
  return builder;
}

vi.mock('../../src/config.js', () => ({
  supabase: { from },
  supabaseAnon: { auth: { getUser: async token => token === 'fixture-token'
    ? { data: { user: { id: AUTH_ID, email: 'owner@trial-proof.invalid', user_metadata: { first_name: 'Demo' } } } }
    : { data: {}, error: { message: 'Invalid token' } } } },
}));
vi.mock('../../src/services/account-deletion.js', () => ({ accountDeletion: { status: async () => null } }));
vi.mock('../../src/services/email-sequences.js', () => ({ triggerSequence: state.welcome }));
const { default: authRoutes } = await import('../../src/routes/auth.js');
const { default: treatmentRoutes } = await import('../../src/routes/treatments.js');
const { paywall } = await import('../../src/middleware/require-plan.js');
const { withTrialWindow } = await import('../../src/middleware/auth.js');
let server, base;

beforeAll(async () => {
  state.db = new PGlite();
  // Relevant columns/defaults and status constraint from the read-only
  // production schema capture on 2026-09-16. A fresh insert really is free/trial.
  await state.db.exec(`CREATE TABLE beauticians (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), auth_id uuid UNIQUE,
    email text, first_name text, last_name text, business_name text,
    subscription_plan text DEFAULT 'free',
    subscription_status text DEFAULT 'trial' CHECK (subscription_status IN
      ('trial','active','past_due','cancelled','trialing','canceled','unpaid','incomplete','incomplete_expired','paused')),
    trial_ends_at timestamptz, created_at timestamptz DEFAULT now()
  );
  CREATE TABLE treatments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), beautician_id uuid, sort_order integer DEFAULT 0);`);
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  // Same mount order as index.js: the paywall resolves the owner before the router.
  app.use('/api/treatments', paywall, treatmentRoutes);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
}, 15000);
afterAll(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await state.db?.close();
});
beforeEach(async () => {
  await state.db.exec('TRUNCATE beauticians, treatments');
  state.race = null;
  state.writes = [];
  state.welcome.mockReset().mockResolvedValue(undefined);
});
async function call(path, options = {}) {
  const response = await fetch(base + path, { ...options, headers: {
    authorization: 'Bearer fixture-token', 'content-type': 'application/json', ...options.headers,
  } });
  return { status: response.status, body: await response.json() };
}
const ensure = () => call('/api/auth/ensure-profile', { method: 'POST' });
async function insertLegacy(fields = {}) {
  const row = { auth_id: AUTH_ID, email: 'owner@trial-proof.invalid', ...fields };
  const keys = Object.keys(row);
  const result = await state.db.query(`INSERT INTO beauticians (${keys.map(quote)}) VALUES (${keys.map((_, i) => `$${i + 1}`)}) RETURNING *`, Object.values(row));
  return result.rows[0];
}

describe('signup and legacy trial access with actual SQL defaults', () => {
  it('creates a canonical 14-day trial and opens treatments on the next authenticated request', async () => {
    const started = Date.now();
    const result = await ensure();
    expect(result.status).toBe(201);
    const stored = (await state.db.query('SELECT * FROM beauticians')).rows[0];
    expect(stored.subscription_plan).toBe('trial');
    expect(stored.subscription_status).toBe('trial');
    expect(new Date(stored.trial_ends_at).getTime()).toBeGreaterThanOrEqual(started + 14 * DAY);
    expect(new Date(stored.trial_ends_at).getTime()).toBeLessThanOrEqual(Date.now() + 14 * DAY);
    expect((await call('/api/treatments')).status).toBe(200);
    const repeated = await ensure();
    expect(repeated.status).toBe(200);
    expect(repeated.body.beautician.trial_ends_at).toBe(result.body.beautician.trial_ends_at);
    expect(state.welcome).toHaveBeenCalledTimes(1);
    expect(state.writes).toHaveLength(1);
  });

  it('recovers a current free/trial account without changing its row, deadline or welcome sequence', async () => {
    const end = future();
    const original = await insertLegacy({ trial_ends_at: end });
    expect(original.subscription_plan).toBe('free');
    expect(original.subscription_status).toBe('trial');
    for (const result of [await ensure(), await call('/api/auth/me')]) {
      expect(result.status).toBe(200);
      expect(result.body.beautician).toMatchObject({ subscription_plan: 'trial', subscription_status: 'trial', trial_ends_at: end });
    }
    expect((await call('/api/treatments')).status).toBe(200);
    expect((await state.db.query('SELECT * FROM beauticians')).rows[0]).toEqual(original);
    expect(state.writes).toHaveLength(0);
    expect(state.welcome).not.toHaveBeenCalled();
  });

  it('returns the same effective trial after a profile update', async () => {
    const end = future();
    await insertLegacy({ trial_ends_at: end });
    const result = await call('/api/auth/me', { method: 'PATCH', body: JSON.stringify({ business_name: 'Demo Salon' }) });
    expect(result.status).toBe(200);
    expect(result.body.beautician).toMatchObject({ subscription_plan: 'trial', trial_ends_at: end, business_name: 'Demo Salon' });
    expect(state.writes).toEqual([{ table: 'beauticians', operation: 'update', payload: { business_name: 'Demo Salon' } }]);
  });

  it('recovers a legacy insert race without starting a new trial or sending a second welcome', async () => {
    const end = future();
    state.race = { trial_ends_at: end };
    const result = await ensure();
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ created: false, beautician: { subscription_plan: 'trial', trial_ends_at: end } });
    expect((await call('/api/treatments')).status).toBe(200);
    expect(state.welcome).not.toHaveBeenCalled();
    expect((await state.db.query('SELECT count(*)::int AS n FROM beauticians')).rows[0].n).toBe(1);
  });

  it.each([1, 20])('anchors a missing legacy trial deadline to signup %i days ago', async daysAgo => {
    const created = new Date(Date.now() - daysAgo * DAY).toISOString();
    await insertLegacy({ created_at: created });
    const result = await ensure();
    expect(result.body.beautician.trial_ends_at).toBe(new Date(Date.parse(created) + 14 * DAY).toISOString());
    expect((await call('/api/treatments')).status).toBe(daysAgo < 14 ? 200 : 403);
    expect(state.writes).toHaveLength(0);
  });

  it('keeps an expired legacy trial expired even when its signup timestamp is recent', async () => {
    const end = past();
    await insertLegacy({ trial_ends_at: end });
    expect((await ensure()).body.beautician.trial_ends_at).toBe(end);
    const result = await call('/api/treatments');
    expect(result.status).toBe(403);
    expect(result.body.error).toBe('Trial expired');
    expect(state.writes).toHaveLength(0);
  });

  it.each(['active', 'cancelled', 'past_due', 'unpaid', 'paused', null])('does not promote unrelated free/%s accounts', async status => {
    const original = await insertLegacy({ subscription_status: status, trial_ends_at: future() });
    expect((await ensure()).body.beautician.subscription_plan).toBe('free');
    expect((await call('/api/treatments')).status).toBe(403);
    expect((await state.db.query('SELECT * FROM beauticians')).rows[0]).toEqual(original);
    expect(state.writes).toHaveLength(0);
  });

  it.each(['active', 'cancelled', 'past_due'])('leaves established paid/%s records unchanged', status => {
    const original = { subscription_plan: 'florrie', subscription_status: status, created_at: new Date().toISOString(), trial_ends_at: future() };
    expect(withTrialWindow(original)).toBe(original);
  });

  it('does not create a renewable trial when neither deadline nor signup timestamp is usable', async () => {
    await insertLegacy({ created_at: null });
    expect((await call('/api/treatments')).status).toBe(403);
    expect((await ensure()).body.beautician.trial_ends_at).toBeNull();
    expect(state.writes).toHaveLength(0);
  });
});
