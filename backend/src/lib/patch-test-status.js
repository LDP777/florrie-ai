/**
 * One definition of "this client still owes a patch test", and one honest
 * account of what the data can and cannot tell you.
 *
 * WHY THIS FILE EXISTS
 * The rule lived inside routes/appointments.js as clientNeedsPatchTest, which
 * meant anything else that wanted to ask had to import a router to get at it.
 * The Florrie-thinks feed already did. The voice tools would have been the
 * third caller, and a rule with three callers and one home inside an HTTP
 * route is a rule that grows a second copy.
 *
 * WHAT confirmed_at ACTUALLY MEANS, WHICH IS NOT WHAT IT SOUNDS LIKE
 * It is set when the CLIENT BOOKS THE SLOT (routes/booking.js:1806 and :1820,
 * alongside `status: 'pending' // awaiting result`). It means an appointment
 * exists. It does not mean she turned up, and it certainly does not mean she
 * passed.
 *
 * Since the owner can now record a patch test herself (see RECORDED_BY_OWNER
 * below), confirmed_at carries one more case: a row with confirmed_at set and
 * appointment_id NULL is one Ellie wrote, not one a client booked. Both mean
 * the same operational thing to every reader in this codebase, which is the
 * only thing any of them use confirmed_at for: THIS PATCH TEST IS SETTLED,
 * NOT OUTSTANDING. What tells the two apart is status plus appointment_id
 * plus test_date, and nothing reads confirmed_at for anything finer.
 *
 * NOTHING RECORDS A RESULT. patch_tests.result has 'pass', 'fail' and
 * 'reaction' in its CHECK constraint and says 'pending' on all 22 rows in
 * production; so does status. expires_at is null on every row, so there is no
 * such thing as an expired patch test either. The only movement in the data is
 * whether a slot got booked and whether that appointment reached 'completed'.
 *
 * So: a caller may say a patch test is BOOKED, or that the client CAME IN for
 * one, and may never say passed, cleared, valid or expired. Florrie told a
 * client a false time once already. She is not doing it about a patch test.
 */

/**
 * Does this client have a patch test on record with NO slot booked?
 *
 * Fails soft to false. Its callers use it to choose a wording or surface a
 * reminder, and a missing reminder is a downgrade while a false "you still
 * owe a patch test" sent to a client who has had one is a wrong message.
 * Anything that needs to tell the difference between "no slot booked",
 * "booked for Tuesday" and "came in last week" wants patchTestPicture below.
 *
 * @param {object} supabase
 * @param {string} beauticianId
 * @param {string} clientId
 * @param {object} [logger]
 * @returns {Promise<boolean>}
 */
export async function needsPatchTest(supabase, beauticianId, clientId, logger = null) {
  if (!clientId || !beauticianId) return false;

  const { data, error } = await supabase
    .from('patch_tests')
    .select('id')
    .eq('client_id', clientId)
    .eq('beautician_id', beauticianId)
    .is('confirmed_at', null)
    .limit(1);

  if (error) {
    logger?.warn?.({ err: error, clientId }, 'patch-test lookup failed');
    return false;
  }
  return (data || []).length > 0;
}

/**
 * The same question for a whole list of clients, in one round trip.
 *
 * A per client loop over a day's bookings is one query per appointment, and
 * the voice tools ask this about everyone booked in a week.
 *
 * @returns {Promise<{outstanding: Set<string>, failed: boolean}>} failed is
 *   true when the lookup itself did not work, so a caller can say "I could
 *   not check" instead of "nobody needs one", which are opposite answers.
 */
export async function clientsOwingPatchTest(supabase, beauticianId, clientIds = [], logger = null) {
  const ids = [...new Set((clientIds || []).filter(Boolean))];
  if (ids.length === 0) return { outstanding: new Set(), failed: false };

  const { data, error } = await supabase
    .from('patch_tests')
    .select('client_id')
    .eq('beautician_id', beauticianId)
    .in('client_id', ids)
    .is('confirmed_at', null);

  if (error) {
    logger?.warn?.({ err: error }, 'bulk patch-test lookup failed');
    return { outstanding: new Set(), failed: true };
  }
  return { outstanding: new Set((data || []).map(r => r.client_id)), failed: false };
}

/**
 * The patch-test record and any linked appointments for one client.
 *
 * Returns a `state`, never a verdict:
 *   none        no patch test on record at all
 *   unbooked    on record, no slot booked
 *   booked      slot booked, that appointment has not been completed yet
 *   attended    slot booked and the appointment reached 'completed'
 *   unknown     the lookup failed, so nothing may be claimed either way
 *
 * `attended` is as far as the data goes. Seven of Ellie's patch-test
 * appointments are completed and not one of the 22 rows has ever had a result
 * written to it, so "she came in on the 14th" is true and "she passed" is not.
 */
// Production has appointment_id but no PostgREST relationship to appointments.
// Read links explicitly, with both salon and client ownership, rather than
// making every patch-test lookup depend on an optional foreign key.
async function readPatchTestRows(supabase, beauticianId, clientId, orderBy, limit) {
  const result = await supabase.from('patch_tests')
    .select('id, status, result, test_date, confirmed_at, appointment_id')
    .eq('beautician_id', beauticianId).eq('client_id', clientId)
    .order(orderBy, { ascending: false }).limit(limit);
  if (result.error) return result;
  const rows = result.data || [];
  const ids = [...new Set(rows.map(row => row.appointment_id).filter(Boolean))];
  if (!ids.length) return { data: rows, error: null };
  const linked = await supabase.from('appointments').select('id, starts_at, status')
    .eq('beautician_id', beauticianId).eq('client_id', clientId).in('id', ids);
  if (linked.error) return { data: null, error: linked.error };
  const byId = new Map((linked.data || []).map(appointment => [appointment.id, appointment]));
  return { data: rows.map(row => ({ ...row, appointments: byId.get(row.appointment_id) || null })), error: null };
}

export async function patchTestPicture(supabase, beauticianId, clientId, logger = null) {
  if (!clientId || !beauticianId) return { state: 'none', when: null, row: null };

  const { data, error } = await readPatchTestRows(supabase, beauticianId, clientId, 'created_at', 10);

  // Checked, always. An unchecked error here reads as "no patch test on
  // record", which is the reassuring answer, and she is holding a tint brush.
  if (error) {
    logger?.warn?.({ err: error, clientId }, 'patch-test picture lookup failed');
    return { state: 'unknown', when: null, row: null };
  }

  const rows = data || [];
  if (rows.length === 0) return { state: 'none', when: null, row: null };

  // The owner recorded one herself: no slot, no appointment, her word for it.
  // It reports as 'attended' rather than as a sixth state on purpose. The
  // states here are a public vocabulary - voice-consultation.js keys a line
  // off each one - and 'attended' already means exactly this: she came in on
  // that day. A new key would have handed the voice tools an undefined
  // sentence, and a client sat in the chair would have been told nothing.
  const recorded = rows.find(r => r.status === RECORDED_BY_OWNER && r.test_date);
  if (recorded) {
    return { state: 'attended', when: recorded.test_date, row: recorded };
  }

  const attended = rows.find(r => (
    (r.confirmed_at && r.appointments?.status === 'completed') || r.result === 'pass'
  ));
  if (attended) {
    return {
      state: 'attended',
      when: attended.appointments?.starts_at || attended.test_date || null,
      row: attended,
    };
  }

  const booked = rows.find(r => r.confirmed_at);
  if (booked) {
    return { state: 'booked', when: booked.appointments?.starts_at || booked.confirmed_at, row: booked };
  }

  return { state: 'unbooked', when: null, row: rows[0] };
}

/* ==========================================================================
 * EVIDENCE
 *
 * WHAT WENT WRONG, AND TO WHOM. Sophie moved her appointment on the manage
 * page on 26 August. The page then told her, flatly, that she needed a patch
 * test. She booked one. Ellie had to message her: "You don't need another
 * patch test I've cancelled it... she's been to me before". A slot in the
 * diary gone, a confused client, and the owner tidying up after her own
 * software.
 *
 * Two separate faults produced that.
 *
 * ONE: the test for a valid patch test could never be true. It read
 *   pt.status === 'passed'
 * and NOTHING in this codebase has ever written 'passed' to that column. The
 * word is not even in the schema's vocabulary: patch_tests.result carries the
 * CHECK (result IN ('pending','pass','fail','reaction')) from 007, and
 * patch_tests.status was bolted on by 078 as a bare `text DEFAULT 'pending'`
 * with no constraint at all. So the only thing keeping the demand away from
 * anybody was hasPendingPatchTest, which needs a patch_tests ROW TO EXIST.
 *
 * TWO, and this is the one that hurt: a client who had her patch test in the
 * chair, in person, has no row. Nothing was ever written for her. So the app
 * demanded one from her forever, and would have gone on demanding it after
 * she booked the wasted slot too, because that slot's appointment reaching
 * 'completed' was never read as evidence either.
 *
 * WHAT COUNTS AS EVIDENCE HERE, in the order it is trusted:
 *
 *   recorded   the salon owner recorded a patch test on a date she chose,
 *              with no slot booked. She is the authority; nobody else was
 *              in the room. Written by POST /api/appointments/patch-test-records.
 *   result     the schema's own recorded outcome, result = 'pass'. Written
 *              today only by POST /api/features/patch-tests when a human
 *              types it. `status === 'passed'` is accepted alongside it as a
 *              dead legacy spelling: nothing writes it, and reading it costs
 *              nothing.
 *   attended   a patch test row whose booked appointment reached 'completed'.
 *              She came in. This is the same fact patchTestPicture calls
 *              'attended', and it is as far as the row itself goes.
 *   treatment  a COMPLETED appointment for a treatment whose
 *              requires_patch_test is true. She cannot lawfully have had that
 *              treatment without a patch test, so she had one. This is an
 *              inference and it is labelled as one.
 *   adverse    result 'fail' or 'reaction'. Evidence, but of the opposite
 *              thing. Never a green light, and never a "go and book one"
 *              either: that is a conversation with the owner.
 *
 * WHAT IS STILL NOT CLAIMED. None of the above is a pass unless a human wrote
 * one. `ok` means "she does not owe a patch test for this booking", which is
 * a statement about the window and the record, not about her skin. The
 * boundary at the top of this file stands: this module may say a patch test
 * is BOOKED, that the client CAME IN, or that the owner RECORDED one, and may
 * never say passed, cleared, valid or expired off its own bat.
 *
 * DATES. patch_tests.test_date is a DATE and appointments.starts_at is SALON
 * WALL TIME in a UTC slot, so both are compared as 'YYYY-MM-DD' strings and
 * never as instants. confirmed_at and created_at are real instants and are
 * deliberately never used as the date of a test.
 * ======================================================================== */

/* ==========================================================================
 * PRIOR HISTORY: THE 673 WHO LOOKED LIKE FIRST TIMERS
 *
 * 27 AUGUST 2026, 01:18. A client of the pilot salon wrote:
 *
 *   "hey I have a appointment on the 3rd of September and I just went onto
 *    the website and it said about a patch test do I need to book one in or
 *    not x"
 *
 * She was right to ask, and the system was right about HER. She was imported
 * from Timely but carries total_visits = 0, last_visit_at NULL and no patch
 * test row, so she is a genuine first timer and she genuinely needs one. What
 * the database showed underneath that message is the defect:
 *
 *   1,151 clients. 926 imported from Timely. 854 carry a real total_visits > 0.
 *   673 of those 854 have ZERO appointments with status 'completed' inside
 *   Florrie, so every rule in this codebase believed each of them had never
 *   once sat in the chair. Only 52 of the 673 have a last_visit_at inside six
 *   months; the other 621 were last seen before the salon's own expiry window.
 *   277 clients have no history of any kind: total_visits = 0, last_visit_at
 *   NULL, no completed appointment. Those 277 are the true first timers.
 *
 * So 673 established regulars were indistinguishable from 277 true first
 * timers, because the Timely import writes clients.total_visits and
 * clients.last_visit_at and creates NO appointments, while every patch test
 * decision in this codebase counted Florrie-era completed appointments only.
 *
 * WHAT PRIOR HISTORY IS, AND WHAT IT IS NOT, AND THIS IS THE WHOLE POINT.
 * Prior history is evidence that somebody is a RETURNING CLIENT. It is NOT
 * evidence that she has ever had a patch test, and it is never converted into
 * one. It is deliberately absent from rowSignal and from SATISFYING below, so
 * it can never set `ok` and never set `kind`. All it may ever do is buy a
 * returning client out of being TOLD something this system does not know. The
 * ask then goes to the owner, who was in the room. A blanket "regulars never
 * need one" would be dangerous precisely here: 621 of the 673 were last seen
 * before the six month expiry, and the next thing they sit down for is a tint.
 *
 * THE TWO COLUMNS, AND HOW FAR EACH CAN BE TRUSTED.
 *   total_visits   written ONCE by the importer (routes/migrate.js:238) and
 *                  never incremented afterwards. No trigger touches it. It is
 *                  a fact about the OLD system, not a live counter, and it is
 *                  read here as nothing more than "there was a before".
 *   last_visit_at  written by the importer AND kept current by the trigger in
 *                  067_last_visit_accuracy.sql:22-25, which bumps it whenever
 *                  an appointment reaches 'completed'. It is the more
 *                  trustworthy of the two, so it is the one the window is
 *                  measured against.
 *   imported_from  which old system she came from, or NULL for somebody who
 *                  started inside Florrie.
 *
 * All three exist: clients is created with them in 001_initial_schema.sql at
 * :139, :143 and :151. That matters, because PostgREST rejects the WHOLE
 * select for one unknown column and reports it by RESOLVING with
 * { data: null, error }, which reads exactly like "she has no history".
 * ======================================================================== */

/**
 * 'YYYY-MM-DD' for a REAL INSTANT: last_visit_at and created_at are timestamptz
 * and mean a moment in time, which is the opposite of appointments.starts_at
 * (salon wall time parked in a UTC slot, read with a string slice). Parsing is
 * the correct read for an instant. The process is pinned to UTC by src/index.js,
 * so a London evening visit can land on the previous UTC day; against a three
 * to twelve MONTH window that is a rounding error, and it rounds towards the
 * visit looking slightly older, which is the side that asks rather than
 * reassures.
 */
export function instantDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** Nobody has been here before, as far as anything predating Florrie knows. */
const NO_PRIOR_HISTORY = Object.freeze({
  known: false, totalVisits: 0, lastVisit: null, importedFrom: null, failed: false,
});

/**
 * Has this client been here before, on history that predates Florrie?
 *
 * Named for what it is, not for what it licenses. It answers "returning client
 * or not"; it says nothing whatsoever about patch tests.
 *
 * `failed` is carried rather than swallowed for the reason the rest of this
 * file checks every error: not being able to tell a regular from a first timer
 * is exactly the thing that must not be guessed, and the guess that goes wrong
 * sends 673 established clients off to book a patch test at one in the morning.
 *
 * @returns {Promise<{known: boolean, totalVisits: number, lastVisit: string|null,
 *   importedFrom: string|null, failed: boolean}>}
 */
export async function readPriorHistory(supabase, beauticianId, clientId, logger = null) {
  if (!clientId || !beauticianId) return { ...NO_PRIOR_HISTORY };

  const { data, error } = await supabase
    .from('clients')
    .select('id, total_visits, last_visit_at, imported_from')
    .eq('id', clientId)
    .eq('beautician_id', beauticianId)
    .maybeSingle();

  if (error) {
    logger?.warn?.({ err: error, clientId }, 'prior-history lookup failed');
    return { ...NO_PRIOR_HISTORY, failed: true };
  }
  if (!data) return { ...NO_PRIOR_HISTORY };

  const totalVisits = Number(data.total_visits) || 0;
  const lastVisit = instantDate(data.last_visit_at);
  const importedFrom = data.imported_from || null;

  return {
    // total_visits > 0 is the importer's own mark and the one the 854 carry.
    // The second arm catches an imported row that arrived with a date but no
    // count: she still came from somewhere, and that somewhere saw her.
    known: totalVisits > 0 || (!!importedFrom && !!lastVisit),
    totalVisits,
    lastVisit,
    importedFrom,
    failed: false,
  };
}

/**
 * patch_tests.status for a test the owner recorded herself, with no slot.
 *
 * Legal today: 078 created `status` as unconstrained text, so this needs no
 * migration. It is deliberately not 'passed', not 'pass' and not 'completed'.
 * It says who said so and nothing more.
 */
export const RECORDED_BY_OWNER = 'recorded_by_owner';

/** 'YYYY-MM-DD' for a Date, a date string, or a wall timestamp. */
export function wallDate(value) {
  if (!value) return null;
  const s = value instanceof Date ? value.toISOString() : String(value);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : null;
}

/** Today, in the frame src/index.js pins the process to. */
export const todayWall = () => new Date().toISOString().slice(0, 10);

/**
 * The oldest date a patch test may carry and still cover `asOfDate`.
 *
 * Month arithmetic, not 182 days, because that is what her setting says:
 * beauticians.patch_test_expiry_months is CHECK (IN (3, 6, 12)). Overflow
 * rolls forward the way Date does (31 August less six months lands in early
 * March), which shortens the window by a day or two rather than lengthening
 * it. Erring short is erring towards asking, which is the safe side of a
 * regulation.
 */
export function patchTestWindowStart(asOfDate, expiryMonths = 6) {
  const day = wallDate(asOfDate) || todayWall();
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCMonth(dt.getUTCMonth() - (Number(expiryMonths) || 6));
  return dt.toISOString().slice(0, 10);
}

/** The date a patch_tests row is evidence FOR, or null if it names none. */
function rowDate(row) {
  return wallDate(row?.test_date) || wallDate(row?.appointments?.starts_at);
}

/** What one patch_tests row actually attests to, or null for "nothing yet". */
function rowSignal(row) {
  if (!row) return null;
  if (row.status === RECORDED_BY_OWNER) return 'recorded';
  // 'pass' is the CHECK constraint's word. 'passed' is the dead spelling the
  // manage page used to test for; kept readable, never written.
  if (row.result === 'pass' || row.status === 'passed') return 'result';
  if (row.result === 'fail' || row.result === 'reaction') return 'adverse';
  if (row.confirmed_at && row.appointments?.status === 'completed') return 'attended';
  return null;
}

/* The four things that actually satisfy the requirement. Prior history is NOT
 * one of them and must never be added: "she has been here before" is not "she
 * has had a patch test", and turning the first into the second is how 673
 * regulars would get silently cleared for a chemical tint on the strength of a
 * number the Timely importer wrote once in 2026 and never touched again. */
const SATISFYING = new Set(['recorded', 'result', 'attended', 'treatment']);

/**
 * Everything known about whether this client owes a patch test for a booking
 * on `asOf`, and how sure we are.
 *
 * @param {object} supabase
 * @param {string} beauticianId
 * @param {string} clientId
 * @param {object} [opts]
 * @param {number} [opts.expiryMonths=6]  beauticians.patch_test_expiry_months
 * @param {string|Date} [opts.asOf]       the date the test has to cover: the
 *   APPOINTMENT's wall date, not today. A test done in August covers a
 *   September booking and does not cover one next April, and the client is
 *   owed the truthful answer for the booking in front of her.
 * @returns {Promise<{
 *   ok: boolean, kind: string, when: string|null, pending: boolean,
 *   completedVisits: number, windowFrom: string, windowTo: string,
 *   priorHistory: {known: boolean, inWindow: boolean, totalVisits: number,
 *     lastVisit: string|null, importedFrom: string|null, failed: boolean},
 * }>} kind is one of recorded | result | attended | treatment | adverse |
 *   none | unknown. `ok` is true only for the four that satisfy the
 *   requirement. `unknown` means the lookup failed and NOTHING may be
 *   claimed either way, which is not the same as "she has none".
 *
 *   priorHistory says whether she is a RETURNING CLIENT, on history that
 *   predates Florrie. Read the block above before using it: it is not a patch
 *   test, it never sets `ok` or `kind`, and its only job is to stop the app
 *   asserting "you need a patch test" at one of the 673 regulars the Timely
 *   import left looking like first timers. `inWindow` means her last recorded
 *   visit falls inside this booking's patch test window, which is the 52; the
 *   other 621 were last seen before it and are the owner's question, not hers.
 */
export async function patchTestEvidence(supabase, beauticianId, clientId, opts = {}) {
  const { expiryMonths = 6, asOf = null, logger = null } = opts;
  const windowTo = wallDate(asOf) || todayWall();
  const windowFrom = patchTestWindowStart(windowTo, expiryMonths);
  const base = {
    ok: false, kind: 'none', when: null, pending: false, completedVisits: 0,
    windowFrom, windowTo,
    priorHistory: { ...NO_PRIOR_HISTORY, inWindow: false },
  };

  if (!clientId || !beauticianId) return base;

  const [ptRes, apptRes, history] = await Promise.all([
    readPatchTestRows(supabase, beauticianId, clientId, 'test_date', 20),
    supabase
      .from('appointments')
      .select('id, starts_at, status, treatment_id, extra_treatment_ids')
      .eq('beautician_id', beauticianId)
      .eq('client_id', clientId)
      .eq('status', 'completed')
      .order('starts_at', { ascending: false })
      .limit(100),
    // The client row itself, which this function never used to read at all.
    // That omission IS the 27 August defect: 673 regulars imported from Timely
    // have no completed appointment inside Florrie, so counting appointments
    // alone made every one of them look like one of the 277 first timers.
    readPriorHistory(supabase, beauticianId, clientId, logger),
  ]);

  // Checked, both. PostgREST reports a bad select by RESOLVING with
  // { data: null, error }, so an unread error here is indistinguishable from
  // "she has never had a patch test" - the answer that sends her to book a
  // second one.
  if (ptRes.error || apptRes.error) {
    logger?.warn?.(
      { ptErr: ptRes.error, apptErr: apptRes.error, clientId },
      'patch-test evidence lookup failed',
    );
    return { ...base, kind: 'unknown' };
  }

  // A failed CLIENT read is 'unknown' for the same reason. Without that row we
  // cannot tell one of the 673 returning clients from one of the 277 who have
  // genuinely never been in, and those two get opposite messages. Not knowing
  // goes to the owner; it never goes to the client as an assertion.
  if (history.failed) {
    logger?.warn?.({ clientId }, 'patch-test evidence: prior history unreadable');
    return { ...base, kind: 'unknown' };
  }

  const rows = ptRes.data || [];
  const completed = apptRes.data || [];

  // Her last recorded visit against THIS booking's window. Same comparison the
  // patch test rows get: 'YYYY-MM-DD' strings, exclusive at the old end.
  const priorHistory = {
    ...history,
    inWindow: !!(history.known && history.lastVisit
      && history.lastVisit > windowFrom && history.lastVisit <= windowTo),
  };
  base.priorHistory = priorHistory;

  // A row that attests to nothing yet but shows a test is in hand: on record
  // with no slot ('pending'), or a slot booked and not yet attended. Not
  // evidence, but a reason not to ask her for another one.
  const pending = rows.some(r => !rowSignal(r) && (r.confirmed_at || r.status === 'pending'));

  const inWindow = rows
    .map(r => ({ signal: rowSignal(r), when: rowDate(r) }))
    .filter(r => r.signal && r.when && r.when > windowFrom && r.when <= windowTo)
    .sort((a, b) => (a.when < b.when ? 1 : -1));

  // The most recent thing on record wins. A reaction in July followed by a
  // recorded test in August means August; the other way round means the
  // reaction, and that is a conversation with the owner, not a booking link.
  const latest = inWindow[0];
  if (latest) {
    return {
      ...base,
      ok: SATISFYING.has(latest.signal),
      kind: latest.signal,
      when: latest.when,
      pending,
      completedVisits: completed.length,
    };
  }

  /* --- the inference: she was treated, so she was tested -----------------
   * A COMPLETED appointment for a treatment whose requires_patch_test is
   * true. Ellie would not lawfully have done that treatment otherwise, so the
   * patch test happened whether or not anybody wrote it down. Both places a
   * treatment can be on a booking count: treatment_id AND every id in
   * extra_treatment_ids, because a lash tint added as an extra needs a patch
   * test exactly as much as one booked as the main thing.
   */
  const windowed = completed.filter(a => {
    const day = wallDate(a.starts_at);
    return day && day > windowFrom && day <= windowTo;
  });

  const wanted = new Set();
  for (const a of windowed) {
    if (a.treatment_id) wanted.add(a.treatment_id);
    const extras = Array.isArray(a.extra_treatment_ids) ? a.extra_treatment_ids : [];
    for (const id of extras) if (id) wanted.add(id);
  }

  if (wanted.size > 0) {
    const { data: treats, error: tErr } = await supabase
      .from('treatments')
      .select('id, requires_patch_test')
      .eq('beautician_id', beauticianId)
      .in('id', [...wanted]);

    // Same rule as above: not knowing is not the same as knowing she has none.
    if (tErr) {
      logger?.warn?.({ err: tErr, clientId }, 'patch-test evidence: treatment lookup failed');
      return { ...base, kind: 'unknown', pending, completedVisits: completed.length };
    }

    const needsTest = new Set((treats || []).filter(t => t.requires_patch_test === true).map(t => t.id));
    if (needsTest.size > 0) {
      const proving = windowed
        .filter((a) => {
          const extras = Array.isArray(a.extra_treatment_ids) ? a.extra_treatment_ids : [];
          return needsTest.has(a.treatment_id) || extras.some(id => needsTest.has(id));
        })
        .sort((a, b) => (wallDate(a.starts_at) < wallDate(b.starts_at) ? 1 : -1));

      if (proving.length > 0) {
        return {
          ...base,
          ok: true,
          kind: 'treatment',
          when: wallDate(proving[0].starts_at),
          pending,
          completedVisits: completed.length,
        };
      }
    }
  }

  return { ...base, pending, completedVisits: completed.length };
}

/* ==========================================================================
 * ONE STANCE, FOR EVERY CALLER THAT TALKS TO A CLIENT
 *
 * There were four copies of this rule. ai-front-desk.js and
 * autonomous-scheduler.js each carried their own, and BOTH still tested
 * `pt.status === 'passed'`, a spelling nothing writes and the CHECK constraint
 * on patch_tests.result rejects with 23514. The practical consequence: the
 * owner could record a patch test herself, from the page built for exactly
 * that, and Florrie would still tell the client to go and book one.
 *
 * This turns evidence plus prior history into the one thing every caller
 * actually wants to know: MAY I SAY THIS OUT LOUD TO HER, and if not, who is
 * the right person to ask. It is the same three populations the whole 27
 * August 2026 fix is built on.
 *
 * @param {object|null} evidence  the result of patchTestEvidence, or null when
 *   there is no client to ask about (an unknown number messaging in).
 * @returns {{status: string, tellClient: boolean, askOwner: boolean,
 *   returningClient: boolean, evidence: string, evidenceDate: string|null}}
 *
 *   satisfied         a test is on record inside the window. Nothing to do.
 *   booked            one is booked and not attended yet. Do not ask twice.
 *   first_timer       no history of ANY kind. The 277. She is told plainly,
 *                     because it is true of her and she can act on it.
 *   returning_recent  prior history, last seen inside the window. The 52.
 *                     Nothing said to her, nobody chased.
 *   returning_stale   prior history, last seen before the window, or no usable
 *                     date. The 621. The client is told NOTHING; the owner is
 *                     asked, on the Patch Tests page.
 *   reaction          an adverse result is on record. Never a booking link.
 *   unknown           the lookup failed. Nothing may be claimed either way.
 *   unidentified      there is no client to be right or wrong about: an
 *                     unknown number messaging in. Not a first timer, because
 *                     that is a claim about somebody we have not matched. The
 *                     copy for this one states the CONDITION ("if it is your
 *                     first time with us") rather than asserting it at her,
 *                     the same register the public booking page now uses at
 *                     step 1, before anybody has been identified.
 *
 * `tellClient` is true for exactly one of them. That is the rule: Florrie never
 * tells a client she needs a patch test unless it genuinely knows.
 * ======================================================================== */
export function patchTestStance(evidence) {
  const base = {
    status: 'unknown', tellClient: false, askOwner: true,
    returningClient: false, evidence: 'unknown', evidenceDate: null,
  };
  if (!evidence) return { ...base, status: 'unidentified', askOwner: false };

  const prior = evidence.priorHistory || { known: false, inWindow: false };
  const returningClient = !!prior.known || (evidence.completedVisits || 0) > 0;
  const out = {
    ...base, returningClient, evidence: evidence.kind, evidenceDate: evidence.when || null,
  };

  if (evidence.kind === 'unknown') return out;
  if (evidence.ok) return { ...out, status: 'satisfied', askOwner: false };
  if (evidence.kind === 'adverse') return { ...out, status: 'reaction' };
  if (evidence.pending) return { ...out, status: 'booked', askOwner: false };
  if (prior.known && prior.inWindow) return { ...out, status: 'returning_recent', askOwner: false };
  if (returningClient) return { ...out, status: 'returning_stale' };
  return { ...out, status: 'first_timer', tellClient: true, askOwner: false };
}
