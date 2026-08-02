/**
 * Tenant isolation on the write path. The backend connects with the Supabase
 * SERVICE key, so RLS is bypassed and these checks are the only thing between
 * one salon and another salon's clients.
 *
 * The case that matters most is the third one: Supabase returns errors in the
 * result object rather than throwing, so an unchecked result reads as
 * `data === null`, which looks exactly like "not owned". A broken query must
 * never be allowed to answer an authorisation question in either direction.
 *
 * The supabase client is stubbed so this stays a pure logic test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = { row: null, error: null, calls: [] };

vi.mock('../../src/config.js', () => ({
  supabase: {
    from(table) {
      const call = { table, filters: {} };
      db.calls.push(call);
      const builder = {
        select() { return this; },
        eq(col, val) { call.filters[col] = val; return this; },
        maybeSingle() { return Promise.resolve({ data: db.error ? null : db.row, error: db.error }); },
      };
      return builder;
    },
  },
}));

vi.mock('../../src/lib/logger.js', () => ({
  default: { info() {}, warn() {}, error() {} },
}));

const { assertOwned, requireOwned, OwnershipCheckFailed } = await import('../../src/lib/ownership.js');

const MINE = 'beautician-1';

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

const req = { beautician: { id: MINE }, originalUrl: '/api/features/consultations' };

beforeEach(() => {
  db.row = null;
  db.error = null;
  db.calls = [];
});

describe('assertOwned', () => {
  it('is true when the row exists and belongs to this beautician', async () => {
    db.row = { id: 'client-1' };
    await expect(assertOwned('clients', 'client-1', MINE)).resolves.toBe(true);
    expect(db.calls[0].filters).toEqual({ id: 'client-1', beautician_id: MINE });
  });

  it('is false when no row comes back', async () => {
    db.row = null;
    await expect(assertOwned('clients', 'client-1', MINE)).resolves.toBe(false);
  });

  it('THROWS rather than answering when the query itself failed', async () => {
    // A failed CHECK, a dropped connection, a missing column. Any of these
    // returns data: null, which must not be read as "not owned" and certainly
    // must never be read as "owned".
    db.error = { code: '42703', message: 'column "beautician_id" does not exist' };
    await expect(assertOwned('clients', 'client-1', MINE)).rejects.toBeInstanceOf(OwnershipCheckFailed);
  });

  it('treats a malformed id as simply not owned', async () => {
    db.error = { code: '22P02', message: 'invalid input syntax for type uuid: "nope"' };
    await expect(assertOwned('clients', 'nope', MINE)).resolves.toBe(false);
  });

  it('never says yes without a tenant', async () => {
    db.row = { id: 'client-1' };
    await expect(assertOwned('clients', 'client-1', null)).resolves.toBe(false);
    await expect(assertOwned('clients', null, MINE)).resolves.toBe(false);
  });
});

describe('requireOwned', () => {
  it('lets the handler carry on when everything checks out', async () => {
    db.row = { id: 'x' };
    const res = fakeRes();
    const ok = await requireOwned(req, res, [
      { table: 'clients', id: 'client-1' },
      { table: 'treatments', id: 'treatment-1' },
    ]);
    expect(ok).toBe(true);
    expect(res.statusCode).toBe(null);
    expect(db.calls.map((c) => c.table)).toEqual(['clients', 'treatments']);
  });

  it('answers 404, not 403, for another salon id', async () => {
    // 403 would confirm the row exists and belongs to somebody else, which
    // turns the endpoint into an enumeration oracle.
    db.row = null;
    const res = fakeRes();
    const ok = await requireOwned(req, res, [{ table: 'clients', id: 'someone-elses-client' }]);
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('answers 500 when the check could not be completed, and does NOT proceed', async () => {
    db.error = { code: '08006', message: 'connection terminated' };
    const res = fakeRes();
    const ok = await requireOwned(req, res, [{ table: 'clients', id: 'client-1' }]);
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(500);
  });

  it('skips ids that were not sent, so optional foreign keys still work', async () => {
    const res = fakeRes();
    const ok = await requireOwned(req, res, [
      { table: 'appointments', id: undefined },
      { table: 'clients', id: null },
      { table: 'clients', id: '' },
    ]);
    expect(ok).toBe(true);
    expect(db.calls).toHaveLength(0);
  });

  it('stops at the first foreign id rather than checking the rest', async () => {
    db.row = null;
    const res = fakeRes();
    await requireOwned(req, res, [
      { table: 'clients', id: 'a' },
      { table: 'treatments', id: 'b' },
    ]);
    expect(db.calls.map((c) => c.table)).toEqual(['clients']);
  });

  it('fails closed when there is no authenticated beautician', async () => {
    db.row = { id: 'x' };
    const res = fakeRes();
    const ok = await requireOwned({ beautician: null }, res, [{ table: 'clients', id: 'client-1' }]);
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('honours a tenant column that is not beautician_id', async () => {
    db.row = { id: 'x' };
    const res = fakeRes();
    await requireOwned(req, res, [{ table: 'some_table', id: 'row-1', column: 'owner_id' }]);
    expect(db.calls[0].filters).toEqual({ id: 'row-1', owner_id: MINE });
  });
});
