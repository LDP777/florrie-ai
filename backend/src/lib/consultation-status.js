/**
 * One definition of "do we ask this client the health questions", and one
 * definition of "may we refuse to book her until she answers them".
 *
 * WHY THIS FILE EXISTS
 * At 01:18 on 27 August 2026 a client messaged: "hey I have a appointment on
 * the 3rd of September and I just went onto the website and it said about a
 * patch test do I need to book one in or not x". Investigating that surfaced
 * this, which is the same shape of mistake one table over.
 *
 * The booking page decided whether to ask about allergies, medication,
 * pregnancy and past adverse reactions from `recognisedClient?.found`, which
 * means only "a clients row matched on email or the last nine digits of the
 * phone". It read "we have a phone number for her" as "she has been here
 * before". The comment above it said the rule was "every first visit gets the
 * form"; the code implemented something else.
 *
 * THE MEASURED NUMBERS, from the pilot salon's live database
 *   1,151 clients in total
 *     926 imported from Timely
 *     854 have total_visits > 0
 *     277 have no history of any kind (total_visits = 0, last_visit_at NULL,
 *         no completed appointment): contacts in the old system who never
 *         actually came in
 * All 926 imported rows are `found`, so all 926 were waved through. And
 * because consultation_responses rows were only ever created by an inline
 * submission from a not-found client, by the form SMS that fires on the same
 * `found` test, or by the owner sending one by hand, no imported client could
 * have a form on file at all. The population with no allergy record was closer
 * to 926 than to 277.
 *
 * THE RULE, decided by the founder on 29 August 2026. It is HYBRID.
 *
 *   requires_consultation treatment
 *     ask unless a COMPLETED consultation_responses row exists for the form
 *     that treatment asks for. This is the rule
 *     services/conversational-booking.js has enforced since it was written,
 *     and hasCompletedConsultation below IS that function, moved here so the
 *     booking page, the /book gate, the manage page and Florrie cannot drift
 *     apart into four different answers.
 *
 *   every other treatment
 *     ask only when the client has no prior history, where prior history is
 *     lib/patch-test-status.js readPriorHistory (total_visits > 0, or an
 *     imported row carrying a last_visit_at) OR at least one completed
 *     appointment inside Florrie. Same notion the booking page already calls
 *     `returningClient`. Deliberately not a second definition.
 *
 * ASK IS NOT BLOCK, WITH ONE EXCEPTION
 * Being asked must not stop the booking. She sees the form, she can carry on
 * without finishing it, the form SMS goes out, and the 24 to 72 hour
 * pre-appointment reminder in services/autonomous-scheduler.js chases it.
 *
 * The exception is the client who is NOT IN THE DATABASE AT ALL. She has
 * never been able to book a requires_consultation treatment without the form
 * and she still cannot. That wall predates this change, it works, and nothing
 * here loosens it: `block` is true only when inDatabase is literally false.
 * An unreadable lookup is not a stranger, so it never blocks; it only asks.
 *
 * WHICH WAY EVERY UNKNOWN FALLS
 * Towards asking. A failed read of consultation_responses reads as "no form on
 * file", a failed read of the client row reads as "no prior history". Asking a
 * client who has already answered costs her one screen she can walk past.
 * Not asking the one client whose answer mattered is how somebody ends up in
 * the chair with an allergy nobody recorded.
 */

import { readPriorHistory } from './patch-test-status.js';

/** Nothing known, nothing asked of the database yet. */
const NO_STATUS = Object.freeze({
  needsConsultation: false,
  formOnFile: false,
  priorHistory: false,
  unknown: false,
});

/**
 * The whole rule, as a pure function, so it can be read in one sitting and
 * asserted against without a database.
 *
 * @param {object} facts
 * @param {boolean|null} facts.inDatabase is there a clients row for her? null
 *   means we could not find out, which is NOT the same as false and never
 *   blocks.
 * @param {boolean} facts.needsConsultation does any treatment being booked
 *   carry requires_consultation?
 * @param {boolean} facts.formOnFile is there a COMPLETED response for the form
 *   every consultation treatment on this booking asks for?
 * @param {boolean} facts.priorHistory has she been here before?
 * @param {boolean} [facts.unknown] a read we depend on failed
 * @returns {{ask: boolean, block: boolean, reason: string}}
 */
export function consultationVerdict({
  inDatabase = null, needsConsultation = false, formOnFile = false,
  priorHistory = false, unknown = false,
} = {}) {
  if (needsConsultation) {
    if (formOnFile) return { ask: false, block: false, reason: 'form_on_file' };
    // The only wall in this file. `=== false` on purpose: null means we do not
    // know whether she is in the book, and not knowing must not turn a regular
    // away from a booking she is entitled to make.
    if (inDatabase === false) return { ask: true, block: true, reason: 'stranger_consultation' };
    return { ask: true, block: false, reason: 'no_form_on_file' };
  }

  if (unknown) return { ask: true, block: false, reason: 'unknown' };
  if (priorHistory) return { ask: false, block: false, reason: 'returning_client' };
  return { ask: true, block: false, reason: 'no_prior_history' };
}

/**
 * Is there a completed consultation response for the form THIS treatment asks
 * for?
 *
 * Scoped to the form, because "any completed form, ever" is not a
 * consultation: a client who filled in a brow tint form in April would sail
 * through a lash lift booking with no allergy answers on file for it. A
 * treatment that requires a consultation but links no form falls back to "any
 * completed response", which is the best the data can say and is what
 * conversational-booking.js has always done.
 *
 * An error reads as "not on record", so a broken query asks rather than waves
 * through. PostgREST reports a bad select by RESOLVING with { data: null,
 * error }, so the error is read explicitly.
 *
 * @returns {Promise<boolean>}
 */
export async function hasCompletedConsultation(supabase, {
  beauticianId, clientId, treatment, logger = null,
} = {}) {
  if (!beauticianId || !clientId) return false;

  let query = supabase
    .from('consultation_responses')
    .select('id')
    .eq('beautician_id', beauticianId)
    .eq('client_id', clientId)
    .eq('status', 'completed');
  if (treatment?.consultation_form_id) query = query.eq('form_id', treatment.consultation_form_id);

  const { data, error } = await query.limit(1);
  if (error) {
    logger?.warn?.({ err: error, beauticianId, clientId }, 'consultation lookup failed, treating as not on record');
    return false;
  }
  return (data || []).length > 0;
}

/**
 * Has she been here before?
 *
 * readPriorHistory is the pre-Florrie half (the importer's own total_visits
 * and last_visit_at). A completed appointment inside Florrie is the other
 * half. Together they are exactly what POST /lookup-client already answered
 * `returningClient` with, and that call site now reads this instead so the two
 * cannot drift.
 *
 * @returns {Promise<{known: boolean, failed: boolean, totalVisits: number, completedVisits: number}>}
 */
export async function hasPriorHistory(supabase, { beauticianId, clientId, logger = null } = {}) {
  if (!beauticianId || !clientId) {
    return { known: false, failed: false, totalVisits: 0, completedVisits: 0 };
  }

  const [history, completed] = await Promise.all([
    readPriorHistory(supabase, beauticianId, clientId, logger),
    supabase
      .from('appointments')
      .select('id', { count: 'exact', head: true })
      .eq('beautician_id', beauticianId)
      .eq('client_id', clientId)
      .eq('status', 'completed'),
  ]);

  if (completed.error) {
    logger?.warn?.({ err: completed.error, clientId }, 'completed-visit count failed');
  }

  const completedVisits = completed.error ? 0 : (completed.count || 0);
  return {
    known: !!history.known || completedVisits > 0,
    // Not knowing is carried, never swallowed. It falls towards asking.
    failed: !!history.failed || !!completed.error,
    totalVisits: history.totalVisits || 0,
    completedVisits,
  };
}

/**
 * The facts and the verdict for one client against one set of treatments.
 *
 * Every caller that decides whether to show, require, text or chase a
 * consultation form goes through here: the booking page (via
 * POST /lookup-client), the POST /book gate, the manage page's
 * change-treatment and add-treatment, and Florrie's DM booking.
 *
 * @param {object} supabase
 * @param {object} args
 * @param {string} args.beauticianId
 * @param {string|null} args.clientId
 * @param {Array<{requires_consultation?: boolean, consultation_form_id?: string|null}>} args.treatments
 * @param {boolean|null} [args.inDatabase] pass it explicitly where the caller
 *   knows better than the presence of an id: POST /book has just created the
 *   clients row for a first timer, so she has a clientId and is still a
 *   stranger.
 * @param {{known: boolean, failed: boolean}|null} [args.knownPriorHistory] a
 *   hasPriorHistory result the caller has already read for THIS client, so a
 *   caller that needs it anyway does not pay for it twice.
 * @param {object|null} [args.logger]
 * @returns {Promise<{ask: boolean, block: boolean, reason: string, needsConsultation: boolean,
 *   formOnFile: boolean, priorHistory: boolean, unknown: boolean}>}
 */
export async function readConsultationStatus(supabase, {
  beauticianId, clientId = null, treatments = [], inDatabase = null,
  knownPriorHistory = null, logger = null,
} = {}) {
  const list = (Array.isArray(treatments) ? treatments : [treatments]).filter(Boolean);
  const needsConsultation = list.some(t => t?.requires_consultation === true);
  const known = inDatabase === null ? (clientId ? true : false) : inDatabase;

  // A client who is not in the book cannot have anything on file and cannot
  // have been here before, so there is nothing to read. Stated rather than
  // queried, because POST /book calls this a millisecond after inserting her
  // clients row and a query would answer about a row that is hers by id and
  // brand new by history.
  if (!known || !clientId) {
    const facts = { ...NO_STATUS, needsConsultation };
    return { ...facts, ...consultationVerdict({ ...facts, inDatabase: false }) };
  }

  // Only the treatments that actually ask for a form are worth a query, and
  // EVERY one of them has to be covered: brows plus lashes with a completed
  // brow form and no lash form is not a client with her consultation done.
  const consultationTreatments = list.filter(t => t?.requires_consultation === true);
  const [onFile, history] = await Promise.all([
    consultationTreatments.length === 0
      ? Promise.resolve(true)
      : Promise.all(consultationTreatments.map(t =>
          hasCompletedConsultation(supabase, { beauticianId, clientId, treatment: t, logger })
        )).then(results => results.every(Boolean)),
    needsConsultation
      // The other arm of the hybrid rule does not apply to a consultation
      // treatment, so her history is not worth a round trip for one.
      ? Promise.resolve({ known: false, failed: false })
      : (knownPriorHistory || hasPriorHistory(supabase, { beauticianId, clientId, logger })),
  ]);

  const facts = {
    needsConsultation,
    formOnFile: needsConsultation ? onFile : false,
    priorHistory: !!history.known,
    unknown: !!history.failed,
  };
  return { ...facts, ...consultationVerdict({ ...facts, inDatabase: true }) };
}
