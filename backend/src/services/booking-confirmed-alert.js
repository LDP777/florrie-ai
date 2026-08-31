/**
 * TELLING THE OWNER THAT A BOOKING BECAME REAL.
 *
 * 31 August 2026. The pilot salon owner said: "there is no notification for
 * when people book now, only when they try and haven't paid deposit yet." She
 * was right, and every word of it is a separate defect.
 *
 * The pending alert fires from routes/booking.js, unconditionally, off data
 * already in memory. It cannot miss. The confirmed alert fired from the payment
 * plumbing instead: two detached async IIFEs hanging off a Stripe Checkout
 * completion, each swallowing its own errors and throwing away the delivery
 * count. So a booking that never went near Stripe Checkout was silent by
 * construction:
 *
 *   - services/conversational-booking.js has never notified her once since it
 *     was written on 5 August. It imported no push helper at all, and its
 *     Checkout success_url pointed at the SPA rather than at
 *     /api/booking/confirm/:sessionId, so even the redirect fallback could not
 *     reach her.
 *   - the resent deposit link (routes/booking.js) built session metadata with
 *     no beautician_id, so the webhook pushed to `undefined` and matched zero
 *     devices.
 *   - services/cleanup.js rescues a booking Stripe says was paid and told her
 *     nothing, which is exactly the case where she most needs telling.
 *
 * So the alert moves here, to the TRANSITION rather than to the payment. Any
 * writer that moves an appointment into 'confirmed' announces it, once.
 *
 * IDEMPOTENCY, AND WHY IT IS THE STATUS TRANSITION.
 *
 * The webhook and the /confirm redirect race, and Stripe usually wins. The
 * only thing that used to stop two pushes was `if (appt && !appt.deposit_paid)`
 * in routes/booking.js, and that guard is one-shot: FOUR other writers set
 * deposit_paid true (routes/stripe.js twice, services/cleanup.js,
 * services/policy-fees.js), so whichever landed first disarmed it permanently.
 *
 * appointments has no "the owner has been told" column, and adding one means a
 * migration that production has to run by hand before the code that reads it
 * ships, which is the exact drift that caused this incident. So the claim is
 * made out of a column that is already there and already the truth:
 *
 *   UPDATE appointments SET status = 'confirmed'
 *    WHERE id = $1 AND status <> 'confirmed' RETURNING id
 *
 * Postgres takes a row lock and re-evaluates the predicate under READ
 * COMMITTED, so of two concurrent writers exactly ONE gets a row back. That
 * writer announces; the loser gets zero rows and stays quiet. It is the
 * transition itself, not a flag beside it, so it cannot drift out of step with
 * the booking and it needs no migration.
 *
 * Every caller therefore stops writing status:'confirmed' in its own update and
 * lets claimConfirmed do it. Their other fields (deposit_paid, deposit_status,
 * the payment intent) stay unconditional, because the loser of the race still
 * has real facts to record.
 *
 * WHERE A PUSH THAT REACHED NOBODY IS VISIBLE.
 *
 * sendPush has returned a `delivered` count since 27 August, and pushAtTheDoor
 * is the only caller that ever read it. Every booking push threw it away, so
 * "her phone buzzed" and "she has nothing registered and nothing happened" were
 * the same log line. Here the count is read and written to ai_actions in the
 * same shape services/ai-front-desk.js already uses on escalations
 * (details.alerted_by / details.alert_delivered), with outcome 'failed' when
 * nothing landed. No new table: the activity feed already exists, she already
 * reads it, and `outcome = 'failed' AND action_type = 'booking_confirmed'` is a
 * one-line query for "confirmed bookings nobody was told about".
 */
import * as Sentry from '@sentry/node';
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { pushBookingConfirmed } from './push-notifications.js';

// The one action_type this file writes. ai_actions.action_type lost its CHECK
// in migration 051 (values are partly generated at runtime), so this is free
// text, but it is READ by the ledger guard below and by anyone querying for
// bookings nobody heard about, so it lives in one constant.
export const BOOKING_CONFIRMED_ACTION = 'booking_confirmed';

/**
 * Claim the right to speak about this booking, by making the transition.
 *
 * Returns { won, reason }. won === true means THIS caller moved the row into
 * 'confirmed' and nobody else can have.
 *
 * On a read/write error it returns won:true with reason 'claim_unreadable'.
 * That is deliberate and it is the lesser of two bad answers: the incident this
 * file exists for is silence, a duplicate buzz is visible and recoverable, and
 * silence is not. The uncertainty is recorded on the ledger row so it is never
 * mistaken for a clean single delivery.
 */
export async function claimConfirmed(appointmentId, extraFields = {}) {
  if (!appointmentId) return { won: false, reason: 'no_appointment' };
  try {
    const { data, error } = await supabase
      .from('appointments')
      .update({ status: 'confirmed', ...extraFields })
      .eq('id', appointmentId)
      // The whole guard, in one predicate the database evaluates under a row
      // lock. Anything already confirmed has already been announced.
      .neq('status', 'confirmed')
      .select('id');

    if (error) {
      logger.error({ err: error, appointmentId },
        'Could not claim the booking-confirmed alert, telling her anyway rather than risking silence');
      Sentry.captureMessage('Booking confirmed alert claim unreadable', {
        level: 'warning',
        tags: { area: 'notifications', check: 'booking_confirmed_claim' },
        extra: { appointmentId, dbCode: error.code, dbError: error.message },
      });
      return { won: true, reason: 'claim_unreadable' };
    }
    if (!data?.length) return { won: false, reason: 'already_confirmed' };
    return { won: true, reason: 'transitioned' };
  } catch (err) {
    logger.error({ err, appointmentId }, 'Booking-confirmed claim threw, telling her anyway');
    return { won: true, reason: 'claim_unreadable' };
  }
}

/**
 * Has she already been told about this booking?
 *
 * The claim above is the atomic guard and this is the durable record of it.
 * It matters on its own for the paths that create an appointment ALREADY
 * confirmed (a zero-deposit conversational booking, a salon with no Stripe
 * connection): there is no transition to claim there, so the ledger is the only
 * thing standing between one announcement and two.
 *
 * Fails OPEN for the same reason claimConfirmed does.
 */
async function alreadyAnnounced(appointmentId) {
  try {
    const { data, error } = await supabase
      .from('ai_actions')
      .select('id')
      .eq('appointment_id', appointmentId)
      .eq('action_type', BOOKING_CONFIRMED_ACTION)
      .limit(1);
    if (error) {
      logger.warn({ err: error, appointmentId }, 'Booking-confirmed ledger unreadable, telling her anyway');
      return false;
    }
    return Boolean(data?.length);
  } catch (err) {
    logger.warn({ err, appointmentId }, 'Booking-confirmed ledger threw, telling her anyway');
    return false;
  }
}

/**
 * The date line she reads on the lock screen.
 *
 * starts_at is SALON WALL TIME parked in a UTC slot, so the day and the clock
 * are sliced straight off the string. Anything that went through a local Date
 * would tell her 11:30 for a 10:30 booking in BST.
 */
function labelFor(startsAt) {
  const day = String(startsAt || '').slice(0, 10);
  const time = String(startsAt || '').slice(11, 16);
  if (!day) return 'their appointment';
  const shown = new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', timeZone: 'UTC',
  });
  return time ? `${shown} at ${time}` : shown;
}

/**
 * Tell the owner a booking became real, at most once, and record whether she
 * actually heard it.
 *
 * @param {string} appointmentId
 * @param {object} opts
 * @param {string} opts.source     which path got here, kept on the ledger row
 * @param {boolean} opts.claim     make the status transition and only speak on
 *                                 winning it (default true). Pass false ONLY
 *                                 from a path that has just created the row
 *                                 already confirmed, where there is no
 *                                 transition to win.
 * @returns {Promise<{announced: boolean, delivered: number, channel: string, reason?: string}>}
 *          Never throws. Telling her is not allowed to break the booking.
 */
export async function announceBookingConfirmed(appointmentId, opts = {}) {
  // The outer guard is the contract. This is awaited inside the Stripe webhook,
  // and a throw there is a non-2xx, which makes Stripe retry the event forever
  // and eventually disable the endpoint. That is how the webhook died for six
  // weeks in the first place, and telling the owner about a booking is not
  // allowed to be the thing that does it again.
  try {
    return await announce(appointmentId, opts);
  } catch (err) {
    logger.error({ err, appointmentId, source: opts.source }, 'Booking-confirmed alert threw, swallowed');
    return { announced: false, delivered: 0, channel: 'none', reason: 'threw' };
  }
}

async function announce(appointmentId, { source = 'unknown', claim = true } = {}) {
  if (!appointmentId) return { announced: false, delivered: 0, channel: 'none', reason: 'no_appointment' };

  let claimReason = 'created_confirmed';
  if (claim) {
    const claimed = await claimConfirmed(appointmentId);
    if (!claimed.won) {
      logger.debug({ appointmentId, source, reason: claimed.reason }, 'Booking-confirmed alert already claimed elsewhere');
      return { announced: false, delivered: 0, channel: 'none', reason: claimed.reason };
    }
    claimReason = claimed.reason;
  }

  if (await alreadyAnnounced(appointmentId)) {
    return { announced: false, delivered: 0, channel: 'none', reason: 'already_announced' };
  }

  // Every column here is verified against supabase/migrations: beautician_id,
  // client_id and starts_at come from 001_initial_schema.sql, and appointments
  // has exactly ONE foreign key to treatments and ONE to clients, so both
  // embeds are unambiguous. The error IS read, because PostgREST answers a bad
  // select by RESOLVING { data: null, error } and a swallowed one here would
  // put us straight back where we started.
  const { data: appt, error: readErr } = await supabase
    .from('appointments')
    .select('id, beautician_id, client_id, starts_at, clients(first_name), treatments(name)')
    .eq('id', appointmentId)
    .maybeSingle();

  if (readErr || !appt) {
    logger.error({ err: readErr || undefined, appointmentId, source },
      'Booking confirmed but the appointment could not be read, so the owner has NOT been told');
    Sentry.captureMessage('Booking confirmed and the owner was not told: appointment unreadable', {
      level: 'error',
      tags: { area: 'notifications', check: 'booking_confirmed_alert' },
      extra: { appointmentId, source, dbCode: readErr?.code, dbError: readErr?.message },
    });
    return { announced: false, delivered: 0, channel: 'none', reason: 'appointment_unreadable' };
  }

  const beauticianId = appt.beautician_id;
  if (!beauticianId) {
    // The resent-deposit bug in person: a push to an undefined salon matches no
    // devices and says nothing, quietly.
    logger.error({ appointmentId, source }, 'Booking confirmed with no beautician on the row, nobody can be told');
    return { announced: false, delivered: 0, channel: 'none', reason: 'no_beautician' };
  }

  const clientName = appt.clients?.first_name || 'A client';
  const treatmentName = appt.treatments?.name || 'their treatment';
  const dateLabel = labelFor(appt.starts_at);

  let result = null;
  try {
    result = await pushBookingConfirmed(beauticianId, clientName, treatmentName, dateLabel, {
      appointmentId,
      apptDate: appt.starts_at,
    });
  } catch (err) {
    logger.error({ err, appointmentId, beauticianId, source }, 'Booking-confirmed push threw');
  }

  // Three different outcomes that used to look identical in the logs:
  //   push      at least one device took it, she has been told
  //   suppressed she turned this notification off herself, which is a choice
  //              and not a failure
  //   none      it reached NOTHING. She has not been told and nobody knew.
  const suppressed = result?.suppressed || null;
  const delivered = result?.delivered || 0;
  const channel = suppressed ? 'suppressed' : delivered > 0 ? 'push' : 'none';
  const summaryLine = `${clientName} booked in: ${treatmentName}, ${dateLabel}. Deposit paid.`;

  const { error: logErr } = await supabase.from('ai_actions').insert({
    beautician_id: beauticianId,
    action_type: BOOKING_CONFIRMED_ACTION,
    digital_employee: 'front_desk',
    summary: `${clientName} is booked in for ${treatmentName}, ${dateLabel}`,
    details: {
      appointment_id: appointmentId,
      source,
      claim: claimReason,
      // Same two keys ai-front-desk.js writes on an escalation, on purpose:
      // one vocabulary for "how was she told, and did it land".
      alerted_by: channel,
      alert_delivered: delivered,
    },
    client_id: appt.client_id || null,
    appointment_id: appointmentId,
    confidence: 1.0,
    autonomous: true,
    // outcome only allows success|pending|failed|escalated (migration 001,
    // still enforced after 051 dropped the action_type list). Anything else is
    // rejected 23514 and swallowed. 'failed' is the honest word for a
    // notification that reached no device, and it is what makes
    // "confirmed bookings nobody heard about" a one-line query.
    outcome: channel === 'none' ? 'failed' : 'success',
    notification_sent: delivered > 0,
    notification_text: summaryLine,
  });
  if (logErr) logger.warn({ err: logErr, appointmentId }, 'Booking-confirmed ledger write failed (non-fatal)');

  if (channel === 'none') {
    logger.error({ appointmentId, beauticianId, source },
      'Booking confirmed and the push reached ZERO devices: she has not been told');
    Sentry.captureMessage('Booking confirmed and the owner was told nothing', {
      level: 'error',
      tags: { area: 'notifications', check: 'booking_confirmed_alert' },
      extra: { appointmentId, beauticianId, source, claim: claimReason },
    });
  } else {
    logger.info({ appointmentId, beauticianId, source, delivered, channel }, 'Booking-confirmed alert sent');
  }

  return { announced: true, delivered, channel, reason: claimReason };
}
