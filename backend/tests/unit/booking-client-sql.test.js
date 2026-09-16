import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { resolveBookingClient } from '../../src/lib/booking-client.js';

const SALON = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const payload = (over = {}) => ({ beautician_id: SALON, first_name: 'Test', email: 'new@example.invalid', phone: '+447700900016', status: 'new', ...over });
let pg;
let beforeInsert;
let forcedReadError;
let insertCount;

// Execute the resolver's queries against real Postgres constraints, not a mock
// that accepts every insert. Hooks simulate a competing request and outages.
function from(table) {
  if (table !== 'clients') throw new Error('Unexpected table');
  let fields = '*', row;
  const filters = [], values = [];
  const builder = {
    select(spec) { fields = spec; return builder; },
    insert(value) { row = value; return builder; },
    eq(key, value) { values.push(value); filters.push(`${key} = $${values.length}`); return builder; },
    ilike(key, value) { values.push(value); filters.push(`${key} ILIKE $${values.length}`); return builder; },
    async maybeSingle() {
      if (!row && forcedReadError) return { data: null, error: forcedReadError };
      try {
        let result;
        if (row) {
          insertCount++;
          if (beforeInsert) await beforeInsert(row, insertCount);
          const keys = Object.keys(row);
          result = await pg.query(`INSERT INTO clients (${keys.join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING ${fields}`, Object.values(row));
        } else {
          result = await pg.query(`SELECT ${fields} FROM clients WHERE ${filters.join(' AND ')}`, values);
        }
        if (result.rows.length > 1) return { data: null, error: { code: 'PGRST116' } };
        return { data: result.rows[0] || null, error: null };
      } catch (error) { return { data: null, error }; }
    },
    single() { return builder.maybeSingle(); },
  };
  return builder;
}
const api = { from };
const insert = async row => {
  const result = await from('clients').insert(row).select('*').single();
  if (result.error) throw result.error;
  return result.data;
};

beforeAll(async () => {
  pg = new PGlite();
  const source = await readFile(new URL('../../../supabase/migrations/001_initial_schema.sql', import.meta.url), 'utf8');
  const clients = source.match(/CREATE TABLE clients \([\s\S]*?\n\);/)[0].replaceAll('uuid_generate_v4()', 'gen_random_uuid()');
  await pg.exec(`CREATE TABLE beauticians (id uuid PRIMARY KEY); ${clients}
    ALTER TABLE clients ADD COLUMN stripe_customer_id text, ADD COLUMN archived_at timestamptz, ADD COLUMN blocked_at timestamptz;
    INSERT INTO beauticians VALUES ('${SALON}'), ('${OTHER}');`);
}, 30000);
afterAll(async () => { await pg?.close(); });
beforeEach(async () => { await pg.exec('DELETE FROM clients'); beforeInsert = null; forcedReadError = null; insertCount = 0; });

describe('public booking client identity with real unique constraints', () => {
  it('reproduces the phone rejection, then lets the new verified email create an isolated record', async () => {
    const old = await insert(payload({ email: 'old@example.invalid', stripe_customer_id: 'cus_private', notes: 'Private history', marketing_consent: false }));
    const rejected = await from('clients').insert(payload()).select('*').single();
    expect(rejected.error.code).toBe('23505');
    expect(rejected.error.constraint).toBe('clients_beautician_id_phone_key');
    const result = await resolveBookingClient(api, payload({ marketing_consent: true }));
    expect(result.created).toBe(true);
    expect(result.contactReview).toBe(true);
    expect(result.client.id).not.toBe(old.id);
    expect(result.client.stripe_customer_id).toBeNull();
    expect(result.client.phone).toBeNull();
    expect((await pg.query('SELECT * FROM clients WHERE id=$1', [old.id])).rows[0]).toEqual(old);
  });

  it('reuses only a tenant-scoped, case-insensitive exact verified email', async () => {
    const old = await insert(payload({ email: 'Owner+_tag%1@example.invalid', stripe_customer_id: 'cus_owner' }));
    await insert(payload({ beautician_id: OTHER, email: old.email, stripe_customer_id: 'cus_other' }));
    const result = await resolveBookingClient(api, payload({ email: 'OWNER+_TAG%1@example.invalid', phone: '+447700900099' }));
    expect(result.created).toBe(false);
    expect(result.client.id).toBe(old.id);
    expect(result.client.stripe_customer_id).toBe('cus_owner');
  });

  it('does not treat email wildcard characters as proof of another identity', async () => {
    await insert(payload({ email: 'ab@example.invalid', phone: null }));
    const result = await resolveBookingClient(api, payload({ email: 'a_@example.invalid' }));
    expect(result.created).toBe(true);
  });

  it('recovers when a concurrent request creates the email before the first insert', async () => {
    beforeInsert = async (row, count) => {
      if (count === 1) await pg.query('INSERT INTO clients (beautician_id,first_name,email,phone) VALUES ($1,$2,$3,$4)', [SALON, 'Concurrent', row.email, row.phone]);
    };
    const result = await resolveBookingClient(api, payload());
    expect(result.error).toBeUndefined();
    expect(result.created).toBe(false);
    expect((await pg.query('SELECT count(*)::int n FROM clients')).rows[0].n).toBe(1);
  });

  it('recovers when two changed-email requests race at the isolated insert', async () => {
    await insert(payload({ email: 'old@example.invalid' }));
    insertCount = 0;
    beforeInsert = async (row, count) => {
      if (count === 2) await pg.query('INSERT INTO clients (beautician_id,first_name,email,preferences) VALUES ($1,$2,$3,$4)', [SALON, 'Concurrent', row.email, row.preferences]);
    };
    const result = await resolveBookingClient(api, payload());
    expect(result.error).toBeUndefined();
    expect(result.created).toBe(false);
    expect(result.contactReview).toBe(true);
    expect((await pg.query('SELECT count(*)::int n FROM clients')).rows[0].n).toBe(2);
  });

  it('does not bypass a block even if the blocked email was inserted concurrently', async () => {
    beforeInsert = async (row, count) => {
      if (count === 1) await pg.query('INSERT INTO clients (beautician_id,first_name,email,blocked_at) VALUES ($1,$2,$3,now())', [SALON, 'Blocked', row.email]);
    };
    expect((await resolveBookingClient(api, payload())).status).toBe(403);
  });

  it('stops on an unavailable database without trying to create a new client', async () => {
    forcedReadError = { code: '57014', message: 'sensitive server detail' };
    const result = await resolveBookingClient(api, payload());
    expect(result.status).toBe(503);
    expect(JSON.stringify(result)).not.toContain('sensitive server detail');
    expect(insertCount).toBe(0);
  });

  it('does not reinterpret non-unique insert errors as a contact conflict', async () => {
    const result = await resolveBookingClient(api, payload({ first_name: null }));
    expect(result.status).toBe(503);
    expect(result.diagnostic).toEqual({ code: '23502', stage: 'insert' });
    expect(insertCount).toBe(1);
  });

  it('retains blocked-client checks when the legacy archived column is missing', async () => {
    await insert(payload({ blocked_at: '2026-09-01T00:00:00Z' }));
    await pg.exec('ALTER TABLE clients DROP COLUMN archived_at');
    try { expect((await resolveBookingClient(api, payload())).status).toBe(403); }
    finally { await pg.exec('ALTER TABLE clients ADD COLUMN archived_at timestamptz'); }
  });
});
