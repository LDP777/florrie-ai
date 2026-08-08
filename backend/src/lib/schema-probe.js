import logger from './logger.js';

/**
 * Ask the database what columns it actually has, rather than what the
 * migrations folder says it should.
 *
 * The Money page's ledger has been returning 500 for Ellie. The cause is one
 * line: `020_hmrc_categories.sql` was written, committed, and never applied to
 * production, so `expenses.hmrc_category` does not exist. PostgREST rejects the
 * WHOLE select when one column in the list is unknown, so a column nobody was
 * even looking at took down the ledger, the Tax tab, the CSV export, the MTD
 * submission and the add-expense form.
 *
 * Migrations here are applied by hand — see the docs/APPLY_IN_SUPABASE_*.sql
 * convention — which means "the code and the schema are in step" is an
 * assumption, not a guarantee, and it is the kind of assumption that fails
 * silently at deploy time and loudly at 9am on a Tuesday.
 *
 * So: probe once, cache, and let the callers ask for a column list that is
 * true of this database. The feature degrades (expenses show without their
 * HMRC category) instead of the page dying. When the migration is applied the
 * probe picks it up on the next refresh with no deploy.
 */

const TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // `${table}.${column}` -> { present, checkedAt }

/**
 * Does this table really have this column?
 *
 * Never throws and never blocks a request on a failure: if the probe itself
 * errors we assume the column is ABSENT, because absent is the safe answer —
 * omitting a column loses a field, requesting a missing one loses the page.
 */
export async function hasColumn(supabase, table, column) {
  const key = `${table}.${column}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.checkedAt < TTL_MS) return hit.present;

  let present = false;
  try {
    // One column, one row. An unknown column fails here in exactly the same
    // way it would fail in the real query, which is what makes this a valid
    // probe rather than a guess.
    //
    // A GET, deliberately, not the { head: true } this used to pass.
    // head:true makes supabase-js send HTTP HEAD
    // (@supabase/postgrest-js PostgrestQueryBuilder: `const method = head ?
    // 'HEAD' : 'GET'`), and a HEAD response has NO BODY — so postgrest-js
    // falls into its `catch` and hands back `{ message: '' }` for a 400 that
    // really did say "column expenses.hmrc_category does not exist". An empty
    // message matches none of the patterns below, so a genuinely missing
    // column was being logged as an unrelated failure and returned uncached:
    // the right answer, reached the wrong way, re-probed on every single
    // request instead of once per five minutes.
    const { error } = await supabase.from(table).select(column).limit(1);
    present = !error;
    if (error && !/column|does not exist|schema cache/i.test(error.message || '')) {
      // Something other than a missing column — a network blip, a policy. Do
      // not cache that as "absent" for five minutes.
      logger.warn({ err: error, table, column }, 'schema probe failed for a reason other than a missing column');
      return false;
    }
    if (!present) {
      logger.warn({ table, column }, 'column is missing from the live database; the feature that uses it will degrade');
    }
  } catch (err) {
    logger.warn({ err, table, column }, 'schema probe threw');
    return false;
  }

  cache.set(key, { present, checkedAt: Date.now() });
  return present;
}

/**
 * Build a select list containing only columns this database actually has.
 *
 *   const cols = await selectable(supabase, 'expenses', BASE, ['hmrc_category']);
 */
export async function selectable(supabase, table, always, optional) {
  const kept = [];
  for (const col of optional) {
    if (await hasColumn(supabase, table, col)) kept.push(col);
  }
  return [...always, ...kept].join(', ');
}

/** Drop keys the database does not have, so an insert cannot 400 on one field. */
export async function writable(supabase, table, row, optional) {
  const out = { ...row };
  for (const col of optional) {
    if (!(col in out)) continue;
    if (!(await hasColumn(supabase, table, col))) delete out[col];
  }
  return out;
}

/** Tests only. */
export function __resetSchemaProbeCache() { cache.clear(); }
