/**
 * THE REFERRALS ROUTE WAS WRITTEN AGAINST A TABLE THAT DOES NOT EXIST.
 *
 * Two migrations create this table and only one of them ever ran:
 *
 *   007_all_features.sql   CREATE TABLE IF NOT EXISTS referrals
 *                          (referrer_id, referred_id, referrer_reward_cents,
 *                           referred_reward_cents, referred_name/email/phone)
 *   023_referrals.sql      CREATE TABLE IF NOT EXISTS referrals
 *                          (referrer_client_id, referred_client_id,
 *                           referral_code, reward_type, reward_value_cents)
 *
 * IF NOT EXISTS means the second one is a no-op. 007 wins, and I confirmed that
 * against the live database on 23 August 2026: the table has 007's columns and
 * has never had a referral_code column at all. routes/referrals.js was written
 * entirely against 023, so every query it made was rejected by PostgREST for an
 * unknown column, the results were unchecked, and the whole feature reported
 * zeros and empty lists rather than an error. Nobody has ever been referred.
 *
 * 023 also put a UNIQUE index on referrals.referral_code while /track inserted
 * the same salon-level code on every row, so even on its own schema the second
 * referral would have collided.
 *
 * The fake below is the point of this file: it knows the REAL column list and
 * rejects a select or an insert naming anything else, exactly as PostgREST
 * does. A fake that accepts whatever you give it agrees with the bug, which is
 * how 1,200 other tests missed this.
 */
process.env.TZ = 'UTC';

import { describe, it, expect, beforeEach, vi } from 'vitest';

/** supabase/migrations/007_all_features.sql:203, confirmed against production. */
const REFERRALS_COLUMNS = [
  'id', 'beautician_id', 'referrer_id', 'referred_id',
  'referred_name', 'referred_email', 'referred_phone',
  'status', 'referrer_reward_cents', 'referred_reward_cents',
  'created_at', 'updated_at',
];

/** Columns 023 would have created. None of these exist. Naming one is the bug. */
const PHANTOM_COLUMNS = [
  'referrer_client_id', 'referred_client_id', 'referral_code',
  'reward_type', 'reward_value_cents', 'reward_issued_at', 'source',
];

const BEAUTICIAN_COLUMNS = [
  'id', 'first_name', 'last_name', 'business_name', 'booking_slug',
  'referral_enabled', 'referral_reward_type', 'referral_reward_value_cents',
];

const CLIENT_COLUMNS = ['id', 'beautician_id', 'first_name', 'last_name', 'email', 'phone'];

const COLUMNS = {
  referrals: REFERRALS_COLUMNS,
  beauticians: BEAUTICIAN_COLUMNS,
  clients: CLIENT_COLUMNS,
};

const state = { referrals: [], beauticians: [], clients: [] };
const rejected = [];

const undefinedColumn = (table, col) => ({
  code: '42703',
  message: `column ${table}.${col} does not exist`,
  details: null, hint: null,
});

/** PostgREST validates every column named and rejects the WHOLE statement. */
function checkColumns(table, spec) {
  const known = COLUMNS[table];
  if (!known || !spec || spec === '*') return null;
  for (const item of String(spec).split(',').map(s => s.trim()).filter(Boolean)) {
    if (item === '*' || item.includes('(')) continue;
    const col = item.includes(':') ? item.split(':').pop().trim() : item;
    if (!known.includes(col)) {
      rejected.push({ table, col });
      return undefinedColumn(table, col);
    }
  }
  return null;
}

let ids = 0;
function makeBuilder(table) {
  const filters = [];
  let pending = null;
  let err = null;
  let limit = Infinity;

  const rows = () => (state[table] || []).filter(r => filters.every(f => f(r)));

  const settle = () => {
    if (err) return { data: null, error: err };
    if (pending?.op === 'insert') {
      const payload = Array.isArray(pending.payload) ? pending.payload : [pending.payload];
      for (const p of payload) {
        for (const col of Object.keys(p)) {
          if (!COLUMNS[table].includes(col)) {
            rejected.push({ table, col });
            return { data: null, error: undefinedColumn(table, col) };
          }
        }
      }
      const created = payload.map(p => ({ id: `${table}_${++ids}`, created_at: new Date().toISOString(), ...p }));
      state[table].push(...created);
      return { data: created, error: null };
    }
    if (pending?.op === 'update') {
      for (const col of Object.keys(pending.payload)) {
        if (!COLUMNS[table].includes(col)) {
          rejected.push({ table, col });
          return { data: null, error: undefinedColumn(table, col) };
        }
      }
      const hit = rows();
      for (const r of hit) Object.assign(r, pending.payload);
      return { data: hit, error: null };
    }
    return { data: rows().slice(0, limit), error: null };
  };

  const b = {
    select(spec = '*') { err = err || checkColumns(table, spec); return b; },
    insert(p) { pending = { op: 'insert', payload: p }; return b; },
    update(p) { pending = { op: 'update', payload: p }; return b; },
    upsert(p) { pending = { op: 'insert', payload: p }; return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    neq(c, v) { filters.push(r => r[c] !== v); return b; },
    is(c, v) { filters.push(r => (r[c] ?? null) === v); return b; },
    in(c, v) { filters.push(r => v.includes(r[c])); return b; },
    or() { return b; },
    order() { return b; },
    limit(n) { limit = n; return Object.assign(Promise.resolve(settle()), b); },
    maybeSingle() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    single() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({
  supabase: { from: (t) => makeBuilder(t) },
  supabaseAnon: { from: (t) => makeBuilder(t) },
}));
vi.mock('../../src/lib/logger.js', () => ({
  default: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
}));

const BEAUTICIAN = '11111111-1111-1111-1111-111111111111';
const REFERRER   = '22222222-2222-2222-2222-222222222222';
const FRIEND     = '33333333-3333-3333-3333-333333333333';

const { default: router } = await import('../../src/routes/referrals.js');

/** Drive one route handler the way express would, without booting express. */
function findRoute(method, path) {
  const layer = router.stack.find(l => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method.toUpperCase()} ${path} on the referrals router`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function call(method, path, { body = {}, query = {}, beautician } = {}) {
  const handler = findRoute(method, path);
  const res = {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
  };
  await handler({ body, query, params: {}, beautician: beautician || { id: BEAUTICIAN } }, res, () => {});
  return res;
}

beforeEach(() => {
  state.referrals = [];
  state.clients = [];
  state.beauticians = [{
    id: BEAUTICIAN, first_name: 'Priya', last_name: 'K', business_name: 'Lash Rooms',
    booking_slug: 'lash-rooms', referral_enabled: true,
    referral_reward_type: 'discount', referral_reward_value_cents: 500,
  }];
  state.clients = [
    { id: REFERRER, beautician_id: BEAUTICIAN, first_name: 'Sam', last_name: 'B', email: 's@x.com', phone: '07700900001' },
    { id: FRIEND,   beautician_id: BEAUTICIAN, first_name: 'Ada', last_name: 'L', email: 'a@x.com', phone: '07700900002' },
  ];
  rejected.length = 0;
  ids = 0;
});

describe('the referrals route speaks the schema the database actually has', () => {
  it('records a referral instead of being rejected for an unknown column', async () => {
    const res = await call('post', '/track', {
      body: { beautician_id: BEAUTICIAN, ref: REFERRER, client_id: FRIEND, referred_name: 'Ada L' },
    });

    expect(rejected, `PostgREST refused: ${JSON.stringify(rejected)}`).toEqual([]);
    expect(res.statusCode).toBe(201);
    expect(state.referrals).toHaveLength(1);
    expect(state.referrals[0].referrer_id).toBe(REFERRER);
    expect(state.referrals[0].referred_id).toBe(FRIEND);
  });

  it('names no column that migration 023 would have created', async () => {
    await call('post', '/track', { body: { beautician_id: BEAUTICIAN, ref: REFERRER, client_id: FRIEND } });
    await call('get', '/');

    const phantoms = rejected.filter(r => PHANTOM_COLUMNS.includes(r.col));
    expect(phantoms, `023-shaped columns reached the database: ${JSON.stringify(phantoms)}`).toEqual([]);
  });

  it('lists referrals and their rewards rather than an empty list', async () => {
    await call('post', '/track', { body: { beautician_id: BEAUTICIAN, ref: REFERRER, client_id: FRIEND } });
    rejected.length = 0;

    const res = await call('get', '/');

    expect(rejected).toEqual([]);
    expect(res.statusCode).toBe(200);
    const listed = res.body?.referrals || res.body?.data || [];
    expect(listed.length).toBeGreaterThan(0);
  });

  it('does not let a client refer herself', async () => {
    const res = await call('post', '/track', {
      body: { beautician_id: BEAUTICIAN, ref: REFERRER, client_id: REFERRER },
    });
    expect(res.statusCode).toBe(400);
    expect(state.referrals).toHaveLength(0);
  });

  it('accepts the same referrer twice without colliding on a unique code', async () => {
    // 023 put a UNIQUE index on referral_code and /track wrote one salon-level
    // code on every row, so the second referral could never have been stored
    // even on the schema the code was written for.
    const other = '44444444-4444-4444-4444-444444444444';
    state.clients.push({ id: other, beautician_id: BEAUTICIAN, first_name: 'Jo', last_name: 'M' });

    await call('post', '/track', { body: { beautician_id: BEAUTICIAN, ref: REFERRER, client_id: FRIEND } });
    await call('post', '/track', { body: { beautician_id: BEAUTICIAN, ref: REFERRER, client_id: other } });

    expect(rejected).toEqual([]);
    expect(state.referrals).toHaveLength(2);
  });

  it('refuses a referrer that is not a client id, rather than querying with junk', async () => {
    const res = await call('post', '/track', {
      body: { beautician_id: BEAUTICIAN, ref: 'LASH20' },
    });
    expect(res.statusCode).toBe(404);
    expect(state.referrals).toHaveLength(0);
  });
});

describe('the source names no phantom referrals column', () => {
  it('never writes a 023 column name into a referrals query', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../src/routes/referrals.js', import.meta.url), 'utf8')
      // Comments explain the old names on purpose. Only code counts.
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

    const found = PHANTOM_COLUMNS.filter(c => new RegExp(`['"\`]${c}['"\`]|\\.${c}\\b`).test(src));
    expect(found, `these belong to a table that does not exist: ${found.join(', ')}`).toEqual([]);
  });
});
