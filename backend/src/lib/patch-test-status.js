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
 * The whole truthful picture for one client, in one round trip.
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
export async function patchTestPicture(supabase, beauticianId, clientId, logger = null) {
  if (!clientId || !beauticianId) return { state: 'none', when: null, row: null };

  const { data, error } = await supabase
    .from('patch_tests')
    .select('id, status, result, test_date, confirmed_at, appointment_id, appointments(starts_at, status)')
    .eq('beautician_id', beauticianId)
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(10);

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
 * }>} kind is one of recorded | result | attended | treatment | adverse |
 *   none | unknown. `ok` is true only for the four that satisfy the
 *   requirement. `unknown` means the lookup failed and NOTHING may be
 *   claimed either way, which is not the same as "she has none".
 */
export async function patchTestEvidence(supabase, beauticianId, clientId, opts = {}) {
  const { expiryMonths = 6, asOf = null, logger = null } = opts;
  const windowTo = wallDate(asOf) || todayWall();
  const windowFrom = patchTestWindowStart(windowTo, expiryMonths);
  const base = { ok: false, kind: 'none', when: null, pending: false, completedVisits: 0, windowFrom, windowTo };

  if (!clientId || !beauticianId) return base;

  const [ptRes, apptRes] = await Promise.all([
    supabase
      .from('patch_tests')
      .select('id, status, result, test_date, confirmed_at, appointment_id, appointments(starts_at, status)')
      .eq('beautician_id', beauticianId)
      .eq('client_id', clientId)
      .order('test_date', { ascending: false })
      .limit(20),
    supabase
      .from('appointments')
      .select('id, starts_at, status, treatment_id, extra_treatment_ids')
      .eq('beautician_id', beauticianId)
      .eq('client_id', clientId)
      .eq('status', 'completed')
      .order('starts_at', { ascending: false })
      .limit(100),
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

  const rows = ptRes.data || [];
  const completed = apptRes.data || [];

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
