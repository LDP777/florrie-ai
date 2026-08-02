/**
 * Does this row belong to the beautician making the request?
 *
 * WHY THIS EXISTS
 * Twenty two handlers took a foreign id straight out of the request body and
 * inserted it, scoping only the row they were WRITING to the caller. The id
 * itself was never checked. Two of them then handed the other tenant's data
 * straight back:
 *
 *   POST /api/features/consultations  selected
 *     '*, clients(first_name, last_name, email), treatments(name)'
 *   POST /api/features/waitlist       selected the client's phone as well
 *
 * So posting another salon's client_id returned that salon's client's name,
 * email and phone. Not a leak you would ever see in a log: the response looks
 * like a perfectly ordinary 201.
 *
 * RLS DOES NOT SAVE YOU HERE. The backend connects with the Supabase SERVICE
 * key, which bypasses row level security by design. Every policy in
 * 005_rls_policies.sql is invisible to this process. Tenant isolation on the
 * write path is exactly and only the checks written in these route handlers.
 *
 * WHY 404 AND NOT 403
 * A 403 confirms the row exists and belongs to somebody else. A 404 says
 * nothing. From outside, "there is no such client" and "that client is not
 * yours" must be indistinguishable, or the API becomes an enumeration oracle:
 * fire ids at it and the status code tells you which ones are real.
 */
import { supabase } from '../config.js';
import logger from './logger.js';

/** Thrown when the check itself could not be completed. */
export class OwnershipCheckFailed extends Error {
  constructor(table, cause) {
    super(`Ownership check failed for ${table}: ${cause?.message || 'unknown error'}`);
    this.name = 'OwnershipCheckFailed';
    this.table = table;
    this.cause = cause;
  }
}

// 22P02 = invalid input syntax. A body field that is not a uuid at all cannot
// possibly be owned, so it is a plain "no", not an internal error.
function isMalformedId(error) {
  if (!error) return false;
  return error.code === '22P02' || /invalid input syntax/i.test(error.message || '');
}

/**
 * True only when the row exists AND belongs to this beautician.
 *
 * Supabase returns errors in the result object rather than throwing, so an
 * unchecked result reads as `data === null`, which would look identical to
 * "not owned". That is the wrong way round: a broken query must never be
 * allowed to decide an authorisation question in either direction, so it
 * throws instead.
 *
 * @param {string} table
 * @param {string} id row id from the request
 * @param {string} beauticianId req.beautician.id, never anything from the body
 * @param {object} [opts]
 * @param {string} [opts.column] tenant column, if it is not beautician_id
 * @returns {Promise<boolean>}
 * @throws {OwnershipCheckFailed} when the query itself failed
 */
export async function assertOwned(table, id, beauticianId, { column = 'beautician_id' } = {}) {
  if (!id || !beauticianId) return false;

  const { data, error } = await supabase
    .from(table)
    .select('id')
    .eq('id', id)
    .eq(column, beauticianId)
    .maybeSingle();

  if (error) {
    if (isMalformedId(error)) return false;
    throw new OwnershipCheckFailed(table, error);
  }
  return Boolean(data);
}

/**
 * Route-level guard. Checks every reference and answers the request itself if
 * any of them fails, so a handler is one line:
 *
 *   if (!await requireOwned(req, res, [
 *     { table: 'clients', id: client_id },
 *     { table: 'treatments', id: treatment_id },
 *   ])) return;
 *
 * A null or undefined id is skipped: optional foreign keys are the caller's
 * business, and the handler has already rejected the ones it requires.
 *
 * @returns {Promise<boolean>} true when everything checked out and the handler
 *   should carry on. False means a response has already been sent.
 */
export async function requireOwned(req, res, refs) {
  const beauticianId = req.beautician?.id;
  if (!beauticianId) {
    // Should be impossible behind requireAuth. Fail closed rather than
    // treating "no tenant" as "any tenant".
    res.status(401).json({ error: 'Not authenticated' });
    return false;
  }

  for (const ref of refs) {
    if (ref.id === undefined || ref.id === null || ref.id === '') continue;

    let owned;
    try {
      owned = await assertOwned(ref.table, ref.id, beauticianId, { column: ref.column });
    } catch (err) {
      logger.error({ err, table: ref.table }, 'Ownership check failed');
      res.status(500).json({ error: 'Something went wrong' });
      return false;
    }

    if (!owned) {
      logger.warn(
        { table: ref.table, beauticianId, path: req.originalUrl },
        'Rejected a reference to a row this account does not own',
      );
      // Deliberately vague. See the note on 404 at the top of this file.
      res.status(404).json({ error: 'Not found' });
      return false;
    }
  }

  return true;
}
