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
    .select('id, test_date, confirmed_at, appointment_id, appointments(starts_at, status)')
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

  const attended = rows.find(r => r.confirmed_at && r.appointments?.status === 'completed');
  if (attended) {
    return { state: 'attended', when: attended.appointments?.starts_at || null, row: attended };
  }

  const booked = rows.find(r => r.confirmed_at);
  if (booked) {
    return { state: 'booked', when: booked.appointments?.starts_at || booked.confirmed_at, row: booked };
  }

  return { state: 'unbooked', when: null, row: rows[0] };
}
