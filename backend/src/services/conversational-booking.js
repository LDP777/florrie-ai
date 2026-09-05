/**
 * Booking a client in over the course of a conversation.
 *
 * WHY A NEW MODULE
 * ai-front-desk.js writes replies. routes/booking.js takes bookings. Neither
 * could do the other's job: the front desk has no way to write an appointment
 * or take a payment, and the booking route needs an HTTP request with a
 * Turnstile token and a fully specified booking in one shot. What sits between
 * them is a NEGOTIATION spread over several messages, and it has no natural
 * home in either file. It lives here, and it borrows rather than reimplements:
 * getFreeSlots for the diary, lib/booking-rules.js for the money and duration
 * arithmetic that routes/booking.js also uses, totalApplicationFee for the
 * platform fee, and the existing Stripe webhook for confirmation.
 *
 * THE RULE THIS FILE EXISTS TO OBEY
 * On 28 Jul 2026 Florrie told a client 4.30 on Thursday was free when it was
 * not. Every clock time that leaves this module came out of getFreeSlots and
 * is handed to the reply claims guard as an allowed time, and the ONE place
 * that claims a booking happened does so only after the insert returned a row.
 * If a diary lookup fails, Florrie says she could not check. She never says
 * nothing is free, because those are different sentences and only one of them
 * is true.
 *
 * WALL TIME
 * Slots, offers and appointments.starts_at are all in the wall frame: a Date
 * whose UTC fields ARE the salon clock. Nothing here converts to local time.
 */
import Stripe from 'stripe';
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import * as Sentry from '@sentry/node';
import { getFreeSlots, nowInSalonWall } from '../lib/free-slots.js';
import { safeReply, HOLDING_REPLY } from '../lib/reply-claims-guard.js';
import { hasCompletedConsultation } from '../lib/consultation-status.js';
import { totalApplicationFee } from '../lib/platform-fees.js';
import { apiPublicBase } from '../lib/public-url.js';
import { announceBookingConfirmed } from './booking-confirmed-alert.js';
import { alreadyBookedForThis } from '../lib/already-booked.js';
import { hasColumn } from '../lib/schema-probe.js';
import { treatmentSetLabel } from '../lib/appointment-treatments.js';
import {
  combineTreatments, resolveDepositCents, formatWallTime, describeSlot,
  matchTreatments, dayPreferenceFrom, chooseOffers, matchSlotChoice,
  isLive, looksLikeRejection,
  looksLikeABookingOpening, patchTestLine,
} from '../lib/booking-rules.js';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://florrie.ai';

// An unanswered offer is dead within a day. The diary has moved on by then,
// and a week old "the 4 one" landing on a fresh "hi" would book a slot nobody
// asked for. This is the whole reason the state has an expiry at all.
export const OFFER_TTL_MINUTES = 24 * 60;

// How long a held slot waits for its deposit. 30 minutes because that is the
// SHORTEST life Stripe will give a Checkout session, and the two clocks have
// to agree: if the hold outlived the link the client would find a dead page,
// and if the link outlived the hold someone could pay for a slot that had
// already been released to somebody else.
export const HOLD_MINUTES = 30;
/** Headroom over Stripe's 30 minute floor for a Checkout session expiry. */
export const SESSION_GRACE_MINUTES = 2;

// How far ahead to look for something to offer. Two weeks is enough to answer
// "any chance of lashes friday?" without turning the reply into a timetable.
const SCAN_DAYS = 14;

// Treatments needing a patch test cannot be booked inside 24 hours: the test
// has to happen first. Same number as the booking page gate and the client copy.
const PATCH_TEST_LEAD_HOURS = 24;

// Intents that mean this conversation is not a new booking. If one of these
// arrives mid negotiation the state is dropped and the normal reply path takes
// over, so "actually cancel it" is never read as picking a slot.
const ABANDON_INTENTS = new Set(['cancellation', 'complaint', 'reschedule']);

// "And a lip wax too": a second treatment added to the one being booked,
// rather than a change of mind.
const ADDING_ON = /\b(?:too|as well|also|add|and a|plus|on top|with it|with that)\b/i;

// Intents that can START a booking conversation from nothing.
const OPENING_INTENTS = new Set(['booking_request', 'availability_check']);

/** '£15', '£12.50'. Whole pounds lose the pence so the guard never sees 15:00. */
function money(cents) {
  const pounds = (cents || 0) / 100;
  return `£${Number.isInteger(pounds) ? pounds : pounds.toFixed(2)}`;
}

function joinWithOr(parts) {
  if (parts.length <= 1) return parts[0] || '';
  return `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`;
}

function joinWithAnd(parts) {
  if (parts.length <= 1) return parts[0] || '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

// ---------------------------------------------------------------------------
// What is being booked
// ---------------------------------------------------------------------------

/**
 * One booking, one or more treatments. "Brow wax and lip wax" is one
 * appointment with two treatments in it, which is what the booking page
 * writes (treatment_id plus extra_treatment_ids) and what the diary shows.
 * Everything below that needs a length, a price, a deposit or a name takes
 * the set, never a lone treatment, so two treatments cannot be quietly booked
 * as one.
 */
function bookingSet(primary, extras = []) {
  const all = [primary, ...(extras || [])].filter(Boolean);
  return {
    primary,
    extras: all.slice(1),
    all,
    label: treatmentSetLabel(primary?.name, all.slice(1).map(t => t.name)),
    spoken: joinWithAnd(all.map(t => t.name)),
  };
}

/** The set a stored conversation is about, from the ids it kept. */
function setFromState(state, treatments) {
  const primary = treatments.find(t => t.id === state.treatment_id);
  if (!primary) return null;
  const extraIds = Array.isArray(state.extra_treatment_ids) ? state.extra_treatment_ids : [];
  const extras = extraIds.map(id => treatments.find(t => t.id === id)).filter(Boolean);
  return bookingSet(primary, extras);
}

/**
 * "(£45, about an hour)". Said with the treatment on every offer, so a
 * client who asked for a tint and is being offered a lamination sees the
 * £40 and says so before a chair is wasted on it. Ellie caught the
 * maintenance mix-up on 4 September only because the reply named the
 * treatment; the price makes the same mistake visible to the client herself.
 */
function priceAndLength(set) {
  const { durationMinutes, priceCents } = combineTreatments(set.all);
  const parts = [];
  if (priceCents > 0) parts.push(money(priceCents));
  if (durationMinutes > 0) parts.push(roughLength(durationMinutes));
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function roughLength(minutes) {
  if (minutes < 60) return `about ${minutes} minutes`;
  if (minutes === 60) return 'about an hour';
  if (minutes === 90) return 'about an hour and a half';
  const hours = minutes / 60;
  if (Number.isInteger(hours)) return `about ${hours} hours`;
  return `about ${Math.round(hours * 2) / 2} hours`;
}

/**
 * Does booking_conversations remember the second and third treatment yet?
 * Migration 030 adds the column. Until it has run, a two-treatment ask is
 * handed to the owner with both treatments named rather than booked as one.
 */
async function canRememberExtras() {
  return hasColumn(supabase, 'booking_conversations', 'extra_treatment_ids');
}

// The client agreeing with a "did you mean X?" question. A bare "x" is a
// kiss, not a yes, so it is only allowed after the word.
const AFFIRMATIVE = /^\s*(?:yes|yeah|yep|yup|yes please|yeah please|please|correct|that'?s (?:it|right|the one)|that one|exactly|perfect|sure|ok|okay|go on then|👍|✅)\s*[!.x ]*$/i;
// Picking from a short list by position: "the second one", "2".
const ORDINAL = [
  [/^\s*(?:the\s+)?(?:first|1st|1)(?:\s+one)?(?:\s+please)?\s*[!.x ]*$/i, 0],
  [/^\s*(?:the\s+)?(?:second|2nd|2)(?:\s+one)?(?:\s+please)?\s*[!.x ]*$/i, 1],
  [/^\s*(?:the\s+)?(?:third|3rd|3)(?:\s+one)?(?:\s+please)?\s*[!.x ]*$/i, 2],
];

/**
 * Does this answer agree with the one candidate Florrie offered?
 */
function agreesWithOnly(message, offeredTreatments) {
  const list = Array.isArray(offeredTreatments) ? offeredTreatments.filter(c => c && c.treatment_id) : [];
  return list.length === 1 && AFFIRMATIVE.test(String(message || '')) ? list[0] : null;
}

/** Does this answer pick one of the offered candidates by position? */
function picksByPosition(message, offeredTreatments) {
  const list = Array.isArray(offeredTreatments) ? offeredTreatments.filter(c => c && c.treatment_id) : [];
  if (list.length < 2) return null;
  for (const [re, i] of ORDINAL) if (re.test(String(message || '')) && list[i]) return list[i];
  return null;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

async function loadClientRecord(beauticianId, inbound) {
  const { data, error } = await supabase
    .from('clients')
    .select('id, first_name, last_name, email, phone, stripe_customer_id, blocked_at')
    .eq('id', inbound.id)
    .eq('beautician_id', beauticianId)
    .maybeSingle();
  if (error) {
    // Unreadable client record means we cannot tell whether she is blocked, so
    // we do not book. Never fall back to the partial row we were handed.
    logger.error({ err: error, beauticianId, clientId: inbound.id }, 'Client lookup failed, not booking');
    return null;
  }
  return data || null;
}

const STATE_COLUMNS = 'id, beautician_id, client_id, step, treatment_id, offered, appointment_id, checkout_url, asked_count, expires_at';
const STATE_COLUMNS_WITH_EXTRAS = `${STATE_COLUMNS}, extra_treatment_ids`;

async function loadState(beauticianId, clientId) {
  const withExtras = await canRememberExtras();
  const { data, error } = await supabase
    .from('booking_conversations')
    .select(withExtras ? STATE_COLUMNS_WITH_EXTRAS : STATE_COLUMNS)
    .eq('beautician_id', beauticianId)
    .eq('client_id', clientId)
    .maybeSingle();

  // An unchecked destructure here would read a broken query as "no booking in
  // progress", which silently restarts a conversation the client is halfway
  // through. Treated as no state, but logged loudly rather than shrugged at.
  if (error) {
    logger.error({ err: error, beauticianId, clientId }, 'booking_conversations read failed');
    return null;
  }
  return isLive(data) ? data : null;
}

/**
 * Persist the negotiation. Returns false when it could not be written.
 *
 * That return value matters more than it looks. If the state cannot be stored,
 * the next message arrives with no memory of what was offered, so an offer we
 * cannot remember is an offer we cannot honour. Every caller treats a false
 * here as a reason to say nothing and hand the thread to Ellie, which is also
 * exactly what happens on the day this ships and before the migration is run.
 */
async function saveState(beauticianId, clientId, patch) {
  const expiresAt = patch.expires_at
    || new Date(Date.now() + OFFER_TTL_MINUTES * 60 * 1000).toISOString();
  const row = {
    beautician_id: beauticianId,
    client_id: clientId,
    offered: [],
    asked_count: 0,
    ...patch,
    expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  };
  // Before migration 030 the column does not exist and PostgREST would
  // refuse the whole upsert over it. Callers with extras to remember have
  // already checked canRememberExtras and handed over if it said no.
  if ('extra_treatment_ids' in row && !(await canRememberExtras())) delete row.extra_treatment_ids;
  const { error } = await supabase
    .from('booking_conversations')
    .upsert(row, { onConflict: 'beautician_id,client_id' });
  if (error) {
    logger.error({ err: error, beauticianId, clientId }, 'booking_conversations write failed');
    return false;
  }
  return true;
}

async function clearState(beauticianId, clientId) {
  const { error } = await supabase
    .from('booking_conversations')
    .delete()
    .eq('beautician_id', beauticianId)
    .eq('client_id', clientId);
  if (error) logger.warn({ err: error, beauticianId, clientId }, 'booking_conversations clear failed');
}

// ---------------------------------------------------------------------------
// The send boundary
// ---------------------------------------------------------------------------

/**
 * What a reply about a HELD slot is allowed to say, verified now.
 *
 * Ellie's drafts are guarded twice: once when Florrie writes them, once when
 * Ellie taps send (routes/escalations.js, routes/outbound.js). The second
 * guard recomputes free slots, and a slot Florrie just held is by definition
 * no longer free, so without this the "your deposit link" draft would be
 * refused at the moment she tried to send it.
 *
 * This does not relax the guard, it satisfies it: the time is read back off
 * the appointment row, and actionPerformed is true only because that row
 * exists and is still live. If the hold was released while the draft sat in
 * her inbox, this returns nothing and the guard refuses, which is correct.
 *
 * NARROW ON PURPOSE, and it was not narrow enough first time round. The window
 * has to be exactly the one draft that is about this hold, because whatever it
 * covers gets `actionPerformed: true`, which is the check that exists because
 * Florrie once told a client an appointment had moved when it had not. Two
 * things went wrong: `confirmed` was in the accepted status list, and the
 * conversation row lives for 24 hours, so for a whole day after a client paid,
 * any queued message to them (a comeback nudge, a gap-fill offer) inherited
 * permission to claim an action. Now it is `pending` only, and only while the
 * payment window is still open, which is the thirty-odd minutes the deposit
 * draft is actually worth sending in.
 */
export async function heldBookingClaimContext(beauticianId, clientId) {
  const empty = { allowedTimes: [], actionPerformed: false };
  if (!beauticianId || !clientId) return empty;

  const state = await loadState(beauticianId, clientId);
  if (!state?.appointment_id) return empty;
  // Only the step that produced the deposit draft. Any other step has no
  // action to claim.
  if (state.step !== 'held') return empty;

  const { data: appt, error } = await supabase
    .from('appointments')
    .select('id, starts_at, status, payment_expires_at')
    .eq('id', state.appointment_id)
    .eq('beautician_id', beauticianId)
    .maybeSingle();
  if (error) {
    logger.warn({ err: error, beauticianId }, 'held booking lookup failed, refusing the claim');
    return empty;
  }
  // 'pending' only. A confirmed booking needs no deposit draft, and the hold it
  // came from is spent.
  if (!appt || appt.status !== 'pending') return empty;
  // payment_expires_at is a real instant, not a wall-time slot, so it is
  // compared as one.
  if (appt.payment_expires_at && new Date(appt.payment_expires_at) <= new Date()) return empty;

  // Wall-time convention: the salon clock is already in the string.
  return { allowedTimes: [String(appt.starts_at).slice(11, 16)], actionPerformed: true };
}

// ---------------------------------------------------------------------------
// Composing, always through the guard
// ---------------------------------------------------------------------------

/**
 * Every reply this module produces goes through here.
 *
 * `fallback` is what to send if the guard refuses the preferred wording. It is
 * not a way round the guard: it is a strictly weaker sentence that names no
 * time at all. A refusal here means the composer and the guard disagree about
 * a time we ourselves verified, which is a bug worth an error line.
 */
function guarded(preferred, { allowedTimes = [], actionPerformed = false, fallback = HOLDING_REPLY, context = {} }) {
  const verdict = safeReply(preferred, { allowedTimes, actionPerformed });
  if (!verdict.rejected) return preferred;

  logger.error({
    ...context, reason: verdict.reason, offending: verdict.offending,
  }, 'Conversational booking composed a reply its own guard refused');

  const second = safeReply(fallback, { allowedTimes, actionPerformed });
  return second.rejected ? HOLDING_REPLY : fallback;
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * Advance the booking conversation with this client by one message.
 *
 * @returns {Promise<null|{reply: string, allowedTimes: string[],
 *          actionPerformed: boolean, handOver: boolean, step: string|null,
 *          appointmentId: string|null}>}
 *          null means "not my conversation", and the normal reply path runs.
 */
export async function advanceBookingConversation({ beautician, client: inbound, message, classification, context }) {
  if (!beautician?.id || !inbound?.id) return null;

  // The client row the webhooks hand over is not always complete, and two
  // fields here are load bearing: blocked_at decides whether she may book at
  // all, and stripe_customer_id decides whether she sees her saved card.
  const client = await loadClientRecord(beautician.id, inbound);
  if (!client) return null;

  // Ellie blocked this person. The booking page refuses them outright; here the
  // right move is simply not to be the one who books them, and let the normal
  // reply path (and Ellie) handle the conversation.
  if (client.blocked_at) return null;

  const state = await loadState(beautician.id, client.id);
  const intent = classification?.intent;

  if (state && ABANDON_INTENTS.has(intent)) {
    // Give the slot back. Dropping the state alone left a real pending
    // appointment sitting in her diary until the five minute cleanup noticed,
    // and if the client said "actually cancel it" the moment after the hold,
    // that is a slot blocked by a booking both parties have already abandoned.
    if (state.appointment_id) await releaseHold(state.appointment_id, 'client_abandoned_booking');
    await clearState(beautician.id, client.id);
    return null;
  }
  if (!state && !OPENING_INTENTS.has(intent)) return null;

  // The treatment menu is the thing every branch below depends on. If the
  // select failed, `treatments` is an empty array that looks exactly like a
  // salon with no treatments, and Florrie would confidently say she does not
  // offer lashes. Refuse instead.
  if (context?.treatmentsError) {
    logger.error({ err: context.treatmentsError, beauticianId: beautician.id }, 'Treatment menu unreadable, refusing to book');
    return handOver(HOLDING_REPLY);
  }

  // OPENING needs evidence in the words, not just a confident label. Checked
  // against Ellie's real history: the classifier calls "Amazing!x" a
  // booking_request at 0.95, and "Round about 515 xx" an availability_check at
  // 0.85, so the autonomy dial alone would start a booking machine on somebody
  // saying thanks. Continuing an existing conversation is exempt: once an offer
  // is on the table, "the 4 one" is a complete answer and the state is context.
  // See looksLikeABookingOpening in lib/booking-rules.js.
  if (!state && !looksLikeABookingOpening(message, bookableTreatments(context))) return null;

  // SHE IS ALREADY BOOKED FOR THIS. Do not offer her times for it.
  //
  // 1 September 2026: a client opened with "I've just booked in for a Korean
  // lash lift on the 9th Sept at 11am" and was offered 1.45pm or 2pm for a
  // Korean lash lift. Read as a customer, that says her booking did not go
  // through. The text gate above refuses "I'm booked" and "already booked" and
  // she wrote "I've just booked in", so it missed by one phrase, and the next
  // client would phrase it a third way. The diary does not have that problem.
  //
  // Returning null rather than speaking: the ordinary reply path can answer
  // from her real booking, which is the true and useful answer, and when it
  // cannot it escalates to Ellie. Either beats a slot list.
  if (!state) {
    const existing = alreadyBookedForThis({
      message,
      clientUpcoming: context?.clientUpcoming,
      treatments: bookableTreatments(context),
    });
    if (existing.booked) {
      logger.info(
        {
          beauticianId: beautician.id,
          clientId: client.id,
          appointmentId: existing.appointment?.id || null,
          treatment: existing.treatmentName,
        },
        'Booking conversation not opened: this client is already booked for the treatment she named',
      );
      return null;
    }
  }

  const salonNow = nowInSalonWall(beautician.timezone || 'Europe/London');

  try {
    if (state?.step === 'held') {
      return await handleHeld({ beautician, client, message, state, salonNow });
    }
    if (state?.step === 'awaiting_pick') {
      return await handlePick({ beautician, client, message, state, context, salonNow });
    }
    if (state?.step === 'awaiting_treatment') {
      return await handleTreatmentAnswer({ beautician, client, message, state, context, salonNow });
    }
    return await handleOpening({ beautician, client, message, classification, context, salonNow });
  } catch (err) {
    // Any thrown lookup lands here. A thrown diary read is precisely the case
    // where saying "nothing is free" would be a lie, so Florrie says she will
    // check and Ellie sees it.
    logger.error({ err, beauticianId: beautician.id, clientId: client.id }, 'Conversational booking failed, handing over');
    return handOver(HOLDING_REPLY);
  }
}

function handOver(reply, allowedTimes = []) {
  return { reply, allowedTimes, actionPerformed: false, handOver: true, step: null, appointmentId: null };
}

function speak(reply, { allowedTimes = [], actionPerformed = false, step = null, appointmentId = null } = {}) {
  return { reply, allowedTimes, actionPerformed, handOver: false, step, appointmentId };
}

// ---------------------------------------------------------------------------
// Step 1 and 2: which treatment
// ---------------------------------------------------------------------------

function bookableTreatments(context) {
  return (context?.treatments || []).filter(t => t && t.name);
}

async function handleOpening({ beautician, client, message, classification, context, salonNow }) {
  const treatments = bookableTreatments(context);
  if (!treatments.length) return null; // nothing to book, leave it to the normal reply

  const match = matchTreatments(message, treatments);

  if (match.treatment) {
    return await startFor({ beautician, client, message, match, context, salonNow, askedCount: 0 });
  }

  // "Are you free next week?" with no treatment named is a question, not a
  // booking. Answering it with a menu would be worse than the reply the normal
  // path already writes from the same verified slot list, so leave it alone.
  if (classification?.intent !== 'booking_request') return null;

  return await askWhichTreatment({ beautician, client, match, treatments, askedCount: 1, first: true });
}

/**
 * One question about the treatment. Three shapes:
 *   one candidate:   "Did you mean Brow Lamination & tint (£40)?"
 *   a few:           "Did you mean X, Y or Z?"
 *   none:            "What would you like: X, Y or Z?"
 * The candidates are kept in the state so "yes" and "the second one" can be
 * read as answers next time round.
 */
async function askWhichTreatment({ beautician, client, match, treatments, askedCount, first }) {
  const options = (match.ambiguous ? match.candidates : treatments).slice(0, 5);
  const offered = options.map(t => ({ treatment_id: t.id, name: t.name }));
  const saved = await saveState(beautician.id, client.id, { step: 'awaiting_treatment', treatment_id: null, offered, asked_count: askedCount });
  if (!saved) return handOver(HOLDING_REPLY);

  const name = first && client.first_name ? `Hi ${client.first_name}, ` : '';
  let reply;
  if (match.ambiguous && options.length === 1) {
    const only = options[0];
    reply = first
      ? `${name}happy to get you booked in. Just so I book the right thing, did you mean ${only.name}${priceAndLength(bookingSet(only))}?`
      : `Sorry, just so I book the right thing: did you mean ${only.name}${priceAndLength(bookingSet(only))}?`;
  } else {
    const list = joinWithOr(options.map(t => t.name));
    if (first) {
      reply = match.ambiguous
        ? `${name}happy to get you booked in. Did you mean ${list}?`
        : `${name}happy to get you booked in. What would you like: ${list}?`;
    } else {
      reply = `Sorry, just so I book the right thing: is it ${list}?`;
    }
  }
  // Guarded with an EMPTY allow-list. Nothing here has been verified against
  // the diary yet, so this reply is allowed to name no time whatsoever, and a
  // treatment called something like "4.30 Express Set" would be caught.
  return speak(guarded(reply, { context: { stage: first ? 'ask_treatment' : 'reask_treatment' } }), { step: 'awaiting_treatment' });
}

/**
 * She named one thing, or two. Two is a real booking when the conversation
 * can remember it; otherwise the owner takes it, told exactly what was asked
 * for, rather than Florrie booking half of it.
 */
async function startFor({ beautician, client, message, match, context, salonNow, askedCount }) {
  const set = bookingSet(match.treatment, match.extras);
  if (set.extras.length && !(await canRememberExtras())) {
    logger.warn({ beauticianId: beautician.id, treatments: set.all.map(t => t.name) }, 'Two-treatment booking asked for before migration 030; handing to the owner');
    return handOver(`${set.spoken} together, lovely. Let me check the book for the two of them and come straight back to you.`);
  }
  return await offerSlots({ beautician, client, message, set, context, salonNow, askedCount });
}

async function handleTreatmentAnswer({ beautician, client, message, state, context, salonNow }) {
  const treatments = bookableTreatments(context);

  const fromList = (c) => (c ? treatments.find(t => t.id === c.treatment_id) : null);

  // "Yes" to "did you mean X?".
  const agreed = fromList(agreesWithOnly(message, state.offered));
  if (agreed) {
    return await startFor({ beautician, client, message, match: { treatment: agreed, extras: [] }, context, salonNow, askedCount: state.asked_count || 0 });
  }

  const match = matchTreatments(message, treatments);
  if (match.treatment) {
    return await startFor({ beautician, client, message, match, context, salonNow, askedCount: state.asked_count || 0 });
  }

  // "The second one", when she named nothing.
  const positional = fromList(picksByPosition(message, state.offered));
  if (positional) {
    return await startFor({ beautician, client, message, match: { treatment: positional, extras: [] }, context, salonNow, askedCount: state.asked_count || 0 });
  }

  // One question, then Ellie. Asking a third time is how a bot argues with a
  // customer, and she can read the thread in two seconds.
  if ((state.asked_count || 0) >= 2) {
    await clearState(beautician.id, client.id);
    return handOver(HOLDING_REPLY);
  }

  return await askWhichTreatment({ beautician, client, match, treatments, askedCount: (state.asked_count || 0) + 1, first: false });
}

// ---------------------------------------------------------------------------
// Step 3: offer real times
// ---------------------------------------------------------------------------

/**
 * Does this booking need a patch test the client has not got, and may Florrie
 * SAY SO to her?
 *
 * This used to be `status !== 'completed'`, on a status computed by a block
 * that tested for the word 'passed' and could therefore never say 'completed'
 * about anybody. Every client got the patch test line and the 24 hour lead.
 *
 * Since 27 August 2026 the stance comes from lib/patch-test-status.js, and the
 * governing rule is that Florrie never tells a client she needs a patch test
 * unless it genuinely knows. Only the true first timer is told. A returning
 * client is not: the ask goes to the owner, on her Patch Tests page, and the
 * pending patch_tests row this function guards is still written for the client
 * it IS true of. An unrecognised or missing stance still returns true, so the
 * cautious answer remains the default.
 */
function needsPatchTest(set, context) {
  const list = set?.all || [set];
  if (!list.some(t => t?.requires_patch_test)) return false;
  const pt = context?.patchTest;
  if (!pt) return true;
  // 'completed' is the dead spelling this file used to compare against; it is
  // read here so nothing that still sends it regresses into being nagged.
  if (pt.status === 'satisfied' || pt.status === 'completed' || pt.status === 'booked') return false;
  // She has been here before. We do not know, so we do not say.
  if (pt.returningClient === true) return false;
  return true;
}

/**
 * Scoped to the form THIS treatment asks for, because "any completed form,
 * ever" is not a consultation. A client who filled in a brow tint form in
 * April would have sailed through a lash lift booking with no allergy answers
 * on file for it.
 *
 * The body of this function moved to lib/consultation-status.js on 29 August
 * 2026 and now has four callers instead of one. Florrie got this right while
 * the booking page was waving through all 926 imported clients on
 * `recognisedClient?.found`; rather than write a third copy of the rule, the
 * page and the /book gate were pointed at Florrie's. This wrapper stays so the
 * two call sites below read the way they always did.
 */
async function hasConsultationOnRecord(beauticianId, clientId, treatment) {
  return hasCompletedConsultation(supabase, { beauticianId, clientId, treatment, logger });
}

/** The first treatment in the set that wants a form she has not filled in. */
async function firstNeedingConsultation(beauticianId, clientId, set) {
  for (const t of set.all) {
    if (t.requires_consultation && !(await hasConsultationOnRecord(beauticianId, clientId, t))) return t;
  }
  return null;
}

/** The deposit for the whole set, the way the booking page works it out. */
function depositFor(set, beautician) {
  const { priceCents } = combineTreatments(set.all);
  return resolveDepositCents({
    treatments: set.all,
    paymentSettings: beautician.payment_settings || {},
    combinedPriceCents: priceCents,
  });
}

async function freeSlotsFor({ beautician, set, salonNow, extraLeadHours = 0 }) {
  const policy = beautician.booking_policy || {};
  const { totalMinutes } = combineTreatments(set.all);
  const leadHours = Math.max(1, policy.min_booking_hours || 0, extraLeadHours);
  const days = Math.max(1, Math.min(policy.max_advance_days || SCAN_DAYS, SCAN_DAYS));

  return getFreeSlots(beautician.id, {
    workingHours: beautician.working_hours,
    timezone: beautician.timezone || 'Europe/London',
    // The slot has to fit the treatment AND its cleanup buffer, or Florrie
    // offers a time that cannot actually be booked.
    durationMinutes: totalMinutes || 60,
    fromWall: salonNow,
    days,
    leadHours,
  });
}

async function offerSlots({ beautician, client, message, set, context, salonNow, askedCount = 0 }) {
  const patchTest = needsPatchTest(set, context);
  const slots = await freeSlotsFor({
    beautician, set, salonNow,
    extraLeadHours: patchTest ? PATCH_TEST_LEAD_HOURS : 0,
  });

  if (!slots.length) {
    await clearState(beautician.id, client.id);
    // True, and checked: the lookup succeeded and came back empty. A FAILED
    // lookup throws and never reaches this line.
    return handOver(`I've not got anything free for ${set.spoken} in the next couple of weeks. Let me have a look at what I can shuffle and come straight back to you.`);
  }

  const wanted = dayPreferenceFrom(message, salonNow);
  const { offers, narrowedToRequestedDays } = chooseOffers(slots, { dates: wanted, max: 3 });
  const allowedTimes = offers.map(s => s.time);
  const today = salonNow.toISOString().slice(0, 10);

  const saved = await saveState(beautician.id, client.id, {
    step: 'awaiting_pick',
    treatment_id: set.primary.id,
    extra_treatment_ids: set.extras.map(t => t.id),
    offered: offers.map(s => ({ iso: s.iso, date: s.date, time: s.time })),
    asked_count: askedCount,
    appointment_id: null,
    checkout_url: null,
  });
  // Offering times we will not remember offering is how "the 4 one" becomes
  // unanswerable. Say nothing rather than start something we cannot finish.
  if (!saved) return handOver(HOLDING_REPLY);

  const askedForADayIHaveNothingOn = Boolean(wanted?.length) && !narrowedToRequestedDays;
  // The treatment is named WITH its price and length. See priceAndLength.
  const what = `${set.spoken}${priceAndLength(set)}`;
  const lead = askedForADayIHaveNothingOn
    ? `I've not got anything left on the day you asked for, but for ${what} I've got`
    : `For ${what} I've got`;
  // A deposit is only mentioned when this treatment really takes one. See
  // patchTestLine: this sentence used to claim money was owed in every branch,
  // including the branch that exists because no deposit is taken.
  const patchLine = patchTestLine({
    patchTest,
    depositDue: depositFor(set, beautician) > 0,
  });

  const reply = `${lead} ${describeOffers(offers, today)}. Which one suits you?${patchLine}`;
  return speak(guarded(reply, { allowedTimes, context: { stage: 'offer', beauticianId: beautician.id } }), {
    allowedTimes, step: 'awaiting_pick',
  });
}

/** "Friday 7 August at 3.30pm, 4pm or 7pm", or one phrase per day if they differ. */
function describeOffers(offers, todayWallDate) {
  const dates = Array.from(new Set(offers.map(s => s.date)));
  if (dates.length === 1) {
    const day = describeSlot(offers[0], todayWallDate).split(' at ')[0];
    return `${day} at ${joinWithOr(offers.map(s => formatWallTime(s.time)))}`;
  }
  return joinWithOr(offers.map(s => describeSlot(s, todayWallDate)));
}

// ---------------------------------------------------------------------------
// Step 4 and 5: she picks, we hold, we take the deposit
// ---------------------------------------------------------------------------

async function handlePick({ beautician, client, message, state, context, salonNow }) {
  const offered = Array.isArray(state.offered) ? state.offered : [];
  const treatments = bookableTreatments(context);
  const set = setFromState(state, treatments);

  // The menu changed under us, or she named a different treatment entirely,
  // or she wants something ADDED: "oh and a lip wax too" keeps what she
  // already asked for and offers times that fit both.
  const reMatch = matchTreatments(message, treatments);
  if (reMatch.treatment && !(set && reMatch.treatment.id === set.primary.id && reMatch.extras.length === 0)) {
    const named = [reMatch.treatment, ...reMatch.extras];
    const adding = set && ADDING_ON.test(message) && named.some(t => !set.all.some(s => s.id === t.id));
    const match = adding
      ? { treatment: set.primary, extras: [...set.extras, ...named.filter(t => !set.all.some(s => s.id === t.id))].slice(0, 2) }
      : reMatch;
    return await startFor({ beautician, client, message, match, context, salonNow, askedCount: 0 });
  }
  if (!set) {
    await clearState(beautician.id, client.id);
    return handOver(HOLDING_REPLY);
  }

  const choice = matchSlotChoice(message, offered, { fromWall: salonNow });
  const today = salonNow.toISOString().slice(0, 10);

  if (choice.rejected || (choice.unclear && looksLikeRejection(message))) {
    return await offerMore({ beautician, client, state, set, context, salonNow, offered });
  }

  if (choice.ambiguous) {
    const allowedTimes = offered.map(s => s.time);
    const reply = `Just so I don't put you in the wrong one, did you mean ${joinWithOr(choice.candidates.map(s => describeSlot(s, today)))}?`;
    return speak(guarded(reply, { allowedTimes, context: { stage: 'ambiguous' } }), { allowedTimes, step: 'awaiting_pick' });
  }

  if (!choice.slot) {
    // She said something we cannot read as a choice. Ask once, then hand over.
    if ((state.asked_count || 0) >= 1) {
      await clearState(beautician.id, client.id);
      return handOver(HOLDING_REPLY);
    }
    const saved = await saveState(beautician.id, client.id, {
      step: 'awaiting_pick', treatment_id: set.primary.id, extra_treatment_ids: set.extras.map(t => t.id), offered,
      asked_count: (state.asked_count || 0) + 1,
    });
    if (!saved) return handOver(HOLDING_REPLY);
    const allowedTimes = offered.map(s => s.time);
    const reply = `Sorry, which one would you like: ${describeOffers(offered, today)}?`;
    return speak(guarded(reply, { allowedTimes, context: { stage: 'reask' } }), { allowedTimes, step: 'awaiting_pick' });
  }

  return await holdAndCharge({ beautician, client, set, slot: choice.slot, state, context, salonNow });
}

async function offerMore({ beautician, client, state, set, context, salonNow, offered }) {
  const slots = await freeSlotsFor({
    beautician, set, salonNow,
    extraLeadHours: needsPatchTest(set, context) ? PATCH_TEST_LEAD_HOURS : 0,
  });
  const alreadyOffered = new Set(offered.map(s => s.iso));
  const fresh = slots.filter(s => !alreadyOffered.has(s.iso));

  if (!fresh.length) {
    await clearState(beautician.id, client.id);
    return handOver("That's everything I've got free at the moment. Let me see what I can move around and come back to you.");
  }

  const { offers } = chooseOffers(fresh, { max: 3 });
  const allowedTimes = offers.map(s => s.time);
  const saved = await saveState(beautician.id, client.id, {
    step: 'awaiting_pick', treatment_id: set.primary.id, extra_treatment_ids: set.extras.map(t => t.id),
    offered: offers.map(s => ({ iso: s.iso, date: s.date, time: s.time })),
    asked_count: 0,
  });
  if (!saved) return handOver(HOLDING_REPLY);
  const reply = `No problem. I've also got ${describeOffers(offers, salonNow.toISOString().slice(0, 10))}. Any good?`;
  return speak(guarded(reply, { allowedTimes, context: { stage: 'offer_more' } }), { allowedTimes, step: 'awaiting_pick' });
}

/**
 * Hold the slot, then ask for the deposit.
 *
 * Order matters and is not negotiable: verify, hold, charge, THEN speak. The
 * reply is the only thing that says a booking happened, and it is written last
 * so it can only describe what already exists.
 */
async function holdAndCharge({ beautician, client, set, slot, state, context, salonNow }) {
  const today = salonNow.toISOString().slice(0, 10);
  const treatment = set.primary;
  const patchTest = needsPatchTest(set, context);

  // THE RACE. Between offering 3.30 and her answering an hour later, somebody
  // else may have taken it. Re-read the diary and look for this exact slot.
  const fresh = await freeSlotsFor({
    beautician, set, salonNow, extraLeadHours: patchTest ? PATCH_TEST_LEAD_HOURS : 0,
  });
  if (!fresh.some(s => s.iso === slot.iso)) {
    return await slotGone({ beautician, client, set, state, fresh, today });
  }

  // A treatment that needs consultation answers is not something to take a
  // deposit for over a DM. The booking page already collects the form properly,
  // so the client goes there, with the real time named.
  const needingForm = await firstNeedingConsultation(beautician.id, client.id, set);
  if (needingForm) {
    await clearState(beautician.id, client.id);
    const link = beautician.booking_slug ? `${FRONTEND_URL}/book/${beautician.booking_slug}` : null;
    const when = describeSlot(slot, today);
    const reply = link
      ? `${when} is free. There's a quick health form to fill in for that one, so grab it here and it will take you through it: ${link}`
      : `${when} is free. There's a quick health form to fill in for that one, I'll send it over now.`;
    return handOver(guarded(reply, { allowedTimes: [slot.time], context: { stage: 'consultation' } }), [slot.time]);
  }

  const { durationMinutes, bufferMinutes, totalMinutes, priceCents } = combineTreatments(set.all);
  const depositCents = depositFor(set, beautician);

  const stripeReady = Boolean(stripe && beautician.stripe_account_id && beautician.stripe_onboarding_complete);
  if (depositCents > 0 && !stripeReady) {
    // Holding a slot we have no way to take money for just means the slot dies
    // quietly in half an hour while the client believes she is booked. Send her
    // to the page that can finish the job instead.
    await clearState(beautician.id, client.id);
    const link = beautician.booking_slug ? `${FRONTEND_URL}/book/${beautician.booking_slug}` : null;
    const when = describeSlot(slot, today);
    const reply = link
      ? `${when} is free. Book it here and it's yours: ${link}`
      : `${when} is free, I'll get that booked in and come back to you.`;
    return handOver(guarded(reply, { allowedTimes: [slot.time], context: { stage: 'no_stripe' } }), [slot.time]);
  }

  const startsAt = slot.iso;
  const endsAt = new Date(new Date(slot.iso).getTime() + (totalMinutes || 60) * 60 * 1000).toISOString();
  const paymentExpiresAt = depositCents > 0
    ? new Date(Date.now() + (HOLD_MINUTES + SESSION_GRACE_MINUTES) * 60 * 1000).toISOString()
    : null;

  const { data: appointment, error: insertError } = await supabase
    .from('appointments')
    .insert({
      beautician_id: beautician.id,
      client_id: client.id,
      treatment_id: treatment.id,
      // The second and third treatment, exactly as the booking page stores
      // them, so the diary, the confirmation and the sheet all show the set.
      ...(set.extras.length ? { extra_treatment_ids: set.extras.map(t => t.id) } : {}),
      starts_at: startsAt,
      ends_at: endsAt,
      duration_minutes: durationMinutes || 60,
      buffer_minutes: bufferMinutes || 0,
      price_cents: priceCents || 0,
      deposit_cents: depositCents,
      deposit_amount_cents: depositCents,
      deposit_status: depositCents > 0 ? 'pending' : null,
      payment_type: 'deposit',
      payment_method: 'card',
      // booked_via matters twice over: it is in the CHECK constraint, and the
      // no-overlap exclusion deliberately skips 'manual' rows only, so this
      // booking is covered by both database guards exactly like a booking page
      // one. See migration 073.
      booked_via: 'ai_front_desk',
      ai_booked: true,
      status: depositCents > 0 ? 'pending' : 'confirmed',
      policy_snapshot: beautician.booking_policy || {},
      ...(paymentExpiresAt && { payment_expires_at: paymentExpiresAt }),
    })
    .select('id, starts_at, management_token, status')
    .single();

  if (insertError) {
    // 23505 = two active appointments sharing a start, 23P01 = the overlap
    // exclusion. Both mean somebody got there first in the last few
    // milliseconds. That is not an error, it is the answer.
    if (insertError.code === '23505' || insertError.code === '23P01') {
      return await slotGone({ beautician, client, set, state, fresh, today });
    }
    logger.error({ err: insertError, beauticianId: beautician.id }, 'Conversational booking hold failed');
    return handOver(HOLDING_REPLY);
  }

  // Mirrors the booking page: the pending patch test is created WITH the
  // booking, so the manage portal can offer test slots from second one.
  if (patchTest) {
    const { error: ptError } = await supabase.from('patch_tests').insert({
      client_id: client.id,
      beautician_id: beautician.id,
      appointment_id: appointment.id,
      status: 'pending',
    });
    if (ptError) logger.warn({ err: ptError, appointmentId: appointment.id }, 'Pending patch test insert failed (non-fatal)');
  }

  // Ellie's activity feed. Logged from here rather than from the reply path
  // because this is the only line that KNOWS a row was written; the front desk
  // used to log 'booking_created' for any booking-ish message, which claimed
  // something that had not happened.
  const { error: logError } = await supabase.from('ai_actions').insert({
    beautician_id: beautician.id,
    client_id: client.id,
    appointment_id: appointment.id,
    action_type: 'booking_created',
    digital_employee: 'front_desk',
    summary: `Held ${set.label} for ${client.first_name || 'a client'} on ${describeSlot({ date: startsAt.slice(0, 10), time: startsAt.slice(11, 16) }, today)}${depositCents > 0 ? ', waiting on the deposit' : ''}`,
    details: { appointment_id: appointment.id, treatment: set.label, deposit_cents: depositCents, source: 'conversational_booking' },
    confidence: 1.0,
    autonomous: false,
    outcome: 'success',
    notification_sent: false,
  });
  if (logError) logger.warn({ err: logError, appointmentId: appointment.id }, 'Booking action log failed (non-fatal)');

  const when = describeSlot({ date: startsAt.slice(0, 10), time: startsAt.slice(11, 16) }, today);
  // depositCents is what this booking actually charges: 0 on the branch just
  // below, which is the branch that used to tell a client with no deposit to
  // pay one. When there IS a deposit, the reply beside this already carries the
  // link, so saying it here too says it twice in four lines.
  const patchLine = patchTestLine({
    patchTest,
    depositDue: depositCents > 0,
    depositAlreadyMentioned: depositCents > 0,
  });

  // No deposit configured: the booking page confirms these outright, so this
  // one is confirmed too rather than inventing a different rule.
  if (depositCents === 0) {
    // A confirmed booking is real whether or not the state row saved, so this
    // one does not release: the client is genuinely booked in either way.
    await saveState(beautician.id, client.id, {
      step: 'held', treatment_id: treatment.id, extra_treatment_ids: set.extras.map(t => t.id), offered: [], appointment_id: appointment.id,
      checkout_url: null, asked_count: 0,
      expires_at: new Date(Date.now() + OFFER_TTL_MINUTES * 60 * 1000).toISOString(),
    });
    const { notifyBookingConfirmed } = await import('./notifications.js');
    notifyBookingConfirmed(appointment.id).catch(err =>
      logger.warn({ err, appointmentId: appointment.id }, 'Booking confirmation notification failed (non-fatal)'));

    // AND THE OWNER. This file has never told her about a single booking since
    // it was written on 5 August 2026: it imported no push helper at all, so a
    // client could book herself in over WhatsApp and the only person who did
    // not find out was the person whose diary it is. (31 August 2026, the
    // owner reported being told only about bookings that had not been paid
    // for.)
    //
    // claim:false because the row above was INSERTED already confirmed, so
    // there is no transition left to win. The ledger check inside
    // announceBookingConfirmed is what keeps it to one announcement.
    announceBookingConfirmed(appointment.id, {
      source: 'conversational_no_deposit',
      claim: false,
    }).catch(err =>
      logger.warn({ err, appointmentId: appointment.id }, 'Owner booking alert failed (non-fatal)'));
    const reply = `Lovely, I've got you in for ${set.spoken} on ${when}.${patchLine}`;
    return speak(
      guarded(reply, { allowedTimes: [slot.time], actionPerformed: true, fallback: `Lovely, that's you booked in for ${set.spoken}.`, context: { stage: 'confirmed_no_deposit' } }),
      { allowedTimes: [slot.time], actionPerformed: true, step: 'held', appointmentId: appointment.id },
    );
  }

  let checkoutUrl = null;
  try {
    checkoutUrl = await createDepositCheckout({ beautician, client, set, appointment, depositCents, when });
  } catch (err) {
    logger.error({ err, appointmentId: appointment.id }, 'Deposit checkout creation failed, releasing the hold');
  }

  if (!checkoutUrl) {
    // A hold with no way to pay is a slot quietly taken out of her diary and a
    // client who thinks she is booked. Give it back immediately.
    await releaseHold(appointment.id, 'ai_hold_no_payment_link');
    await clearState(beautician.id, client.id);
    return handOver(HOLDING_REPLY);
  }

  const saved = await saveState(beautician.id, client.id, {
    step: 'held', treatment_id: treatment.id, extra_treatment_ids: set.extras.map(t => t.id), offered: [],
    appointment_id: appointment.id, checkout_url: checkoutUrl, asked_count: 0,
    // The state outlives the hold on purpose: if she pays at minute 29 the
    // webhook confirms it, and if she does not, a later message still finds
    // the released booking rather than starting a confused new one.
    expires_at: new Date(Date.now() + OFFER_TTL_MINUTES * 60 * 1000).toISOString(),
  });
  if (!saved) {
    // Without this row nothing can verify the hold at the send boundary, so
    // Ellie could not send the link even though the slot is out of her diary.
    // Give it back rather than leave both of them stuck.
    await releaseHold(appointment.id, 'ai_hold_state_unwritable');
    return handOver(HOLDING_REPLY);
  }

  const reply = `Perfect, ${when} is held for you. Pop the ${money(depositCents)} deposit through here and it's yours: ${checkoutUrl} I'll hold it for ${HOLD_MINUTES} minutes.${patchLine}`;
  return speak(
    guarded(reply, {
      allowedTimes: [slot.time], actionPerformed: true,
      fallback: `Perfect, that's held for you. Pop the ${money(depositCents)} deposit through here and it's yours: ${checkoutUrl}`,
      context: { stage: 'held', appointmentId: appointment.id },
    }),
    { allowedTimes: [slot.time], actionPerformed: true, step: 'held', appointmentId: appointment.id },
  );
}

/** Give a slot back to the diary. Only ever called on a hold we just made. */
async function releaseHold(appointmentId, reason) {
  const { error } = await supabase.from('appointments').update({
    status: 'cancelled',
    cancellation_reason: reason,
    cancelled_at: new Date().toISOString(),
  }).eq('id', appointmentId).eq('status', 'pending');
  if (error) logger.error({ err: error, appointmentId, reason }, 'Could not release a hold; it will be swept by the stale-booking cleanup');
}

/**
 * The slot went between offering it and holding it.
 * Deliberately does NOT name the time that was lost: it is not free, so the
 * guard would refuse the sentence, and rightly.
 */
async function slotGone({ beautician, client, set, state, fresh, today }) {
  const { offers } = chooseOffers(fresh || [], { max: 3 });
  if (!offers.length) {
    await clearState(beautician.id, client.id);
    return handOver("I'm so sorry, that one has just gone and I've nothing else free right now. Let me have a look and come back to you.");
  }

  const allowedTimes = offers.map(s => s.time);
  const saved = await saveState(beautician.id, client.id, {
    step: 'awaiting_pick', treatment_id: set.primary.id, extra_treatment_ids: set.extras.map(t => t.id),
    offered: offers.map(s => ({ iso: s.iso, date: s.date, time: s.time })),
    asked_count: 0, appointment_id: null, checkout_url: null,
  });
  if (!saved) return handOver(HOLDING_REPLY);
  const reply = `I'm so sorry, that one has just gone. I've still got ${describeOffers(offers, today)}. Would one of those work?`;
  return speak(guarded(reply, { allowedTimes, context: { stage: 'slot_gone' } }), { allowedTimes, step: 'awaiting_pick' });
}

// ---------------------------------------------------------------------------
// After the hold
// ---------------------------------------------------------------------------

const ASKING_FOR_LINK = /\b(link|pay|paid|deposit|payment|didn'?t work|not working|again)\b/i;

async function handleHeld({ beautician, client, message, state, salonNow }) {
  const { data: appt, error } = await supabase
    .from('appointments')
    .select('id, starts_at, status, deposit_paid')
    .eq('id', state.appointment_id)
    .eq('beautician_id', beautician.id)
    .maybeSingle();

  if (error) {
    logger.warn({ err: error, beauticianId: beautician.id }, 'Held appointment lookup failed');
    return handOver(HOLDING_REPLY);
  }

  const today = salonNow.toISOString().slice(0, 10);
  const when = appt ? describeSlot({ date: String(appt.starts_at).slice(0, 10), time: String(appt.starts_at).slice(11, 16) }, today) : null;

  // Paid and confirmed: the Stripe webhook has already sent the real
  // confirmation, so there is nothing to add and the normal reply path is
  // better at small talk than a template is.
  if (appt && appt.status === 'confirmed') {
    await clearState(beautician.id, client.id);
    return null;
  }

  // The hold was released by the stale-booking cleanup. Say so, plainly.
  if (!appt || ['cancelled', 'cancelled_by_client', 'cancelled_by_beautician', 'no_show'].includes(appt.status)) {
    await clearState(beautician.id, client.id);
    return handOver("Sorry, that slot was only held for a short while and it's been released now because the deposit didn't come through. Send me a message and I'll find you another time.");
  }

  // Still pending. Re-send the same link, never a second hold.
  if (state.checkout_url && ASKING_FOR_LINK.test(message)) {
    const allowedTimes = [String(appt.starts_at).slice(11, 16)];
    const reply = `Here's that deposit link again for ${when}: ${state.checkout_url}`;
    return speak(
      guarded(reply, { allowedTimes, actionPerformed: true, fallback: `Here's that deposit link again: ${state.checkout_url}`, context: { stage: 'resend_link' } }),
      { allowedTimes, actionPerformed: true, step: 'held', appointmentId: appt.id },
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

/**
 * The deposit Checkout session.
 *
 * Same shape as the booking page's, on purpose: a destination charge with
 * totalApplicationFee as the application fee (Florrie's cut PLUS the estimated
 * Stripe processing fee, because on a destination charge the PLATFORM pays
 * Stripe, and collecting only the cut lost 19p a booking), the card saved for
 * later policy fees, and metadata.appointment_id so the EXISTING
 * checkout.session.completed handler confirms the booking and fires the normal
 * confirmation. No second "charge someone" path exists here.
 */
async function createDepositCheckout({ beautician, client, set, appointment, depositCents, when }) {
  let customerId = client.stripe_customer_id || null;
  if (!customerId) {
    const customer = await stripe.customers.create({
      name: [client.first_name, client.last_name].filter(Boolean).join(' ') || undefined,
      email: client.email || undefined,
      phone: client.phone || undefined,
      metadata: { client_id: client.id, beautician_id: beautician.id },
    });
    customerId = customer.id;
    const { error } = await supabase.from('clients').update({ stripe_customer_id: customerId }).eq('id', client.id);
    if (error) logger.warn({ err: error, clientId: client.id }, 'Could not store stripe_customer_id (non-fatal)');
  }

  const buildSession = (graceMinutes) => ({
    mode: 'payment',
    customer: customerId,
    // The link dies exactly when the hold does, so nobody can pay for a slot
    // the cleanup has already given back to somebody else.
    // Stripe: "It can be anywhere from 30 minutes to 24 hours after Checkout
    // Session creation", judged on STRIPE's clock when it receives the request.
    // Asking for exactly HOLD_MINUTES spends the network latency getting there
    // and lands under the floor, so any positive latency or backwards clock
    // skew rejects the session outright and the deposit link, which is the
    // whole point of this feature, never exists. The hold is extended by the
    // same grace so a released slot still cannot be paid for.
    expires_at: Math.floor(Date.now() / 1000) + (HOLD_MINUTES + graceMinutes) * 60,
    line_items: [{
      price_data: {
        currency: 'gbp',
        product_data: {
          name: `${set.label} deposit`,
          description: `${when} with ${beautician.business_name || beautician.first_name}`,
        },
        unit_amount: depositCents,
      },
      quantity: 1,
    }],
    payment_intent_data: {
      application_fee_amount: totalApplicationFee(depositCents),
      transfer_data: { destination: beautician.stripe_account_id },
      setup_future_usage: 'off_session',
      metadata: {
        appointment_id: appointment.id,
        beautician_id: beautician.id,
        client_id: client.id,
        platform_fee_cents: totalApplicationFee(depositCents),
        payment_type: 'deposit',
      },
    },
    // LAND ON OUR OWN CONFIRM ENDPOINT, not straight back on the SPA.
    //
    // This pointed at the frontend from the day the file was written, which
    // made the redirect fallback in routes/booking.js structurally unreachable
    // for every conversational booking: that route is what retrieves the
    // session, checks payment_status server side, records the deposit and
    // tells the owner. With the SPA as the success_url the ONLY thing that
    // could ever confirm one of these was the Stripe webhook, which is the very
    // thing that had died for six weeks. It forwards to the same confirmed
    // page afterwards, so the client sees no difference.
    //
    // Falls back to the SPA when no public API base is configured, because a
    // success_url built from nothing would break Checkout outright.
    success_url: apiPublicBase()
      ? `${apiPublicBase()}/api/booking/confirm/{CHECKOUT_SESSION_ID}?slug=${beautician.booking_slug}&mt=${appointment.management_token}`
      : `${FRONTEND_URL}/book/${beautician.booking_slug}/confirmed?mt=${appointment.management_token}`,
    cancel_url: `${FRONTEND_URL}/book/${beautician.booking_slug}`,
    metadata: {
      appointment_id: appointment.id,
      beautician_id: beautician.id,
      client_id: client.id,
      payment_type: 'deposit',
    },
  });

  // I could not reach Stripe from where this was written, so the expiry above
  // is reasoned from their documented range rather than watched. That is not a
  // good enough reason to let the one parameter I could not test take the
  // feature down silently, so it recovers: if Stripe complains about
  // expires_at, ask again with more room and stretch the hold to match, and
  // shout either way so a human hears about it the first time rather than the
  // hundredth.
  let session;
  try {
    session = await stripe.checkout.sessions.create(buildSession(SESSION_GRACE_MINUTES));
  } catch (err) {
    if (!/expires_at/i.test(err?.message || '')) throw err;

    const wider = SESSION_GRACE_MINUTES + 10;
    logger.error({ err, appointmentId: appointment.id, retryGraceMinutes: wider }, 'Stripe refused the Checkout expiry, retrying with more room');
    Sentry.captureMessage('Stripe rejected the conversational booking Checkout expiry', {
      level: 'error',
      tags: { area: 'payments', check: 'checkout_expires_at' },
      extra: { reason: err?.message, graceMinutes: SESSION_GRACE_MINUTES },
    });

    session = await stripe.checkout.sessions.create(buildSession(wider));
    // The link must never outlive the hold, so the hold moves with it.
    const { error: holdErr } = await supabase
      .from('appointments')
      .update({ payment_expires_at: new Date(Date.now() + (HOLD_MINUTES + wider) * 60 * 1000).toISOString() })
      .eq('id', appointment.id);
    if (holdErr) logger.error({ err: holdErr, appointmentId: appointment.id }, 'Checkout expiry widened but the hold did not follow');
  }

  // Pin the payment intent on the appointment the way the booking page does
  // (routes/booking.js). Without it the nightly Stripe reconciliation and the
  // refund path have no way back from a charge to the booking it paid for, so
  // an AI booked appointment would look like money with no counterpart.
  // Non-fatal: the deposit link is already valid and the webhook confirms on
  // metadata.appointment_id, not on this.
  if (session.payment_intent) {
    const { error: pinErr } = await supabase
      .from('appointments')
      .update({ stripe_payment_intent_id: session.payment_intent })
      .eq('id', appointment.id);
    if (pinErr) logger.warn({ err: pinErr, appointmentId: appointment.id }, 'could not pin the payment intent to the held appointment');
  }

  return session.url || null;
}
