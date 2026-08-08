import { describe, it, expect, beforeEach } from 'vitest';
import { hasColumn, selectable, writable, __resetSchemaProbeCache } from '../../src/lib/schema-probe.js';

/**
 * The bug this exists for: `020_hmrc_categories.sql` was written and never
 * applied to production, so `expenses.hmrc_category` does not exist. PostgREST
 * rejects the ENTIRE select when one column in the list is unknown, so a column
 * nobody was reading took down the ledger, the Tax tab, the CSV export, the MTD
 * submission and the add-expense form at once. Ellie's Money page has been
 * returning 500.
 *
 * Migrations here are applied by hand, so "the schema matches the code" is an
 * assumption. These tests pin the behaviour that makes the assumption harmless.
 */

/** A Supabase double where a named set of columns simply does not exist. */
function fakeSupabase({ missing = [], failWith = null } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      return {
        select(cols, options) {
          const asked = String(cols).split(',').map(s => s.trim());
          calls.push({ table, cols: asked, options });
          const bad = asked.find(c => missing.includes(c));
          const result = failWith
            ? { error: { message: failWith } }
            : bad
              ? { error: { message: `column ${table}.${bad} does not exist` } }
              : { error: null };
          return { limit: () => result, ...result };
        },
      };
    },
  };
}

beforeEach(() => __resetSchemaProbeCache());

describe('hasColumn', () => {
  it('reports a column that exists', async () => {
    const db = fakeSupabase({ missing: [] });
    expect(await hasColumn(db, 'expenses', 'amount_cents')).toBe(true);
  });

  it('reports a column that the live database has never had', async () => {
    const db = fakeSupabase({ missing: ['hmrc_category'] });
    expect(await hasColumn(db, 'expenses', 'hmrc_category')).toBe(false);
  });

  it('asks the database once and then remembers', async () => {
    const db = fakeSupabase({ missing: ['hmrc_category'] });
    await hasColumn(db, 'expenses', 'hmrc_category');
    await hasColumn(db, 'expenses', 'hmrc_category');
    await hasColumn(db, 'expenses', 'hmrc_category');
    expect(db.calls).toHaveLength(1);
  });

  it('treats an unrelated failure as absent WITHOUT caching it', async () => {
    // A network blip must not pin the column to "missing" for five minutes and
    // strip it from every response until the process restarts.
    const db = fakeSupabase({ failWith: 'fetch failed' });
    expect(await hasColumn(db, 'expenses', 'hmrc_category')).toBe(false);
    await hasColumn(db, 'expenses', 'hmrc_category');
    expect(db.calls).toHaveLength(2);
  });

  it('probes with a GET, so the 400 actually carries a message to read', async () => {
    // head:true makes supabase-js send HTTP HEAD, and a HEAD response has no
    // body — postgrest-js then reports the 400 as { message: '' }. An empty
    // message matches none of the "is this a missing column" patterns, so a
    // column that really was missing got classified as an unrelated failure
    // and re-probed on every request instead of once per five minutes. The
    // classification is only as good as the message, and only a GET has one.
    const db = fakeSupabase({ missing: ['hmrc_category'] });
    await hasColumn(db, 'expenses', 'hmrc_category');
    expect(db.calls[0].options?.head).toBeFalsy();
  });

  it('never throws, whatever the client does', async () => {
    const exploding = { from() { throw new Error('client is gone'); } };
    await expect(hasColumn(exploding, 'expenses', 'hmrc_category')).resolves.toBe(false);
  });
});

describe('selectable', () => {
  it('drops only the missing column and keeps the rest of the ledger select', async () => {
    const db = fakeSupabase({ missing: ['hmrc_category'] });
    const cols = await selectable(db, 'expenses',
      ['id', 'amount_cents', 'vendor', 'category', 'date'], ['hmrc_category']);
    expect(cols).toBe('id, amount_cents, vendor, category, date');
    expect(cols).not.toContain('hmrc_category');
  });

  it('includes the column the moment the migration has been applied', async () => {
    const db = fakeSupabase({ missing: [] });
    const cols = await selectable(db, 'expenses', ['id', 'amount_cents'], ['hmrc_category']);
    expect(cols).toBe('id, amount_cents, hmrc_category');
  });
});

describe('writable', () => {
  it('strips a column the table does not have so the insert still lands', async () => {
    const db = fakeSupabase({ missing: ['hmrc_category'] });
    const row = await writable(db, 'expenses', {
      beautician_id: 'b1', amount_cents: 1299, category: 'products',
      hmrc_category: 'cost_of_goods', date: '2026-08-08',
    }, ['hmrc_category']);
    expect(row).toEqual({
      beautician_id: 'b1', amount_cents: 1299, category: 'products', date: '2026-08-08',
    });
  });

  it('leaves the row alone when the column is there', async () => {
    const db = fakeSupabase({ missing: [] });
    const row = await writable(db, 'expenses',
      { amount_cents: 1299, hmrc_category: 'cost_of_goods' }, ['hmrc_category']);
    expect(row.hmrc_category).toBe('cost_of_goods');
  });

  it('does not invent the key when the caller never set it', async () => {
    const db = fakeSupabase({ missing: [] });
    const row = await writable(db, 'expenses', { amount_cents: 1299 }, ['hmrc_category']);
    expect('hmrc_category' in row).toBe(false);
  });
});
