/**
 * Cleanup service, handles stale bookings and expired data.
 *
 * Runs on an interval from index.js. Each function is idempotent
 * and safe to call multiple times.
 */
import Stripe from 'stripe';
import * as Sentry from '@sentry/node';
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { guardedSend } from '../lib/outbound-guard.js';
import { encrypt, decrypt, isEncrypted } from '../lib/crypto.js';
import { sendOnChannel } from './messaging.js';
import { pushTeamUpdate } from './push-notifications.js';


const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

/**
 * IS THE PAYMENT NEWS ACTUALLY REACHING US?
 *
 * On 5 August two of Ellie's clients turned up for appointments this thing had
 * released. Both had paid. The money had left their accounts. One of them
 * showed her the receipt on her phone.
 *
 * Nothing here was wrong on its own terms. It cancels bookings whose deposit is
 * not marked paid, and theirs was not marked paid, because
 * `checkout.session.completed` never arrived: two webhook endpoints sat on one
 * url with one signing secret between them, so every payment event failed
 * signature verification. stripe_events had ZERO rows for the life of the
 * account. Every deposit anybody paid looked unpaid, and this loop dutifully
 * gave their slots away.
 *
 * That is the bug worth fixing, not the four rows. `deposit_paid = false` means
 * two completely different things, "she did not pay" and "we never heard", and
 * this treated them as one. So before anything is cancelled, we ask whether we
 * are hearing from Stripe at all. If we are not, we cancel nothing and shout,
 * because a slot released in error costs a client their appointment and Ellie
 * her afternoon, while a slot held too long costs a few hours of diary.
 *
 * "Quiet day or deaf?" was originally answered from our own `transactions`
 * table, which cannot answer it: almost every row in there is written BY the
 * webhook. Kill the webhook and both readings go to zero together, the breaker
 * calls it a quiet day, and it releases paid bookings exactly as it did on
 * 5 August. Bookings taken through conversational booking or a resent payment
 * link leave no transaction row at all until the webhook lands, so the blind
 * spot is not hypothetical.
 *
 * The only witness that is independent of us is Stripe. So we ask Stripe
 * whether it has emitted anything in the last 24 hours. Stripe has events and
 * our `stripe_events` table has none of them is the outage signature, and it is
 * the exact shape the account was in for its entire life. Anything we cannot
 * read fails closed.
 *
 * @returns {Promise<{trustworthy: boolean, reason: string|null}>}
 */
async function paymentNewsIsArriving() {
  if (!stripe) return { trustworthy: true, reason: null };  // nothing to miss

  const dayAgoMs = Date.now() - 24 * 60 * 60 * 1000;
  const dayAgo = new Date(dayAgoMs).toISOString();

  const [events, payments] = await Promise.all([
    supabase.from('stripe_events').select('id', { count: 'exact', head: true }).gte('processed_at', dayAgo),
    supabase.from('transactions').select('id', { count: 'exact', head: true })
      .in('payment_method', ['card', 'card_online']).gte('created_at', dayAgo),
  ]);

  // Cannot tell: refuse to cancel rather than guess. An unreadable check is
  // exactly the state this incident happened in.
  if (events.error) return { trustworthy: false, reason: `stripe_events unreadable: ${events.error.message}` };

  // Events are landing. The webhook is alive, so deposit_paid means what it says.
  if ((events.count || 0) > 0) return { trustworthy: true, reason: null };

  // Kept as a cheap second signal even though it cannot be relied on alone:
  // card money in our books with no events beside it is still the outage.
  if (!payments.error && (payments.count || 0) > 0) {
    return { trustworthy: false, reason: `${payments.count} card payment(s) recorded in the last 24h but ZERO Stripe webhook events, so deposit_paid cannot be trusted` };
  }

  // Nothing of ours says anything. Ask the one party that knows.
  try {
    const recent = await stripe.events.list({ limit: 1, created: { gte: Math.floor(dayAgoMs / 1000) } });
    if (Array.isArray(recent?.data) && recent.data.length > 0) {
      return {
        trustworthy: false,
        reason: 'Stripe has emitted events in the last 24h and stripe_events recorded none of them, so the webhook is not reaching us and deposit_paid cannot be trusted',
      };
    }
  } catch (err) {
    // We could not even ask. That is not permission to start cancelling.
    logger.error({ err }, 'Cleanup breaker could not ask Stripe whether it has been sending events');
    return { trustworthy: false, reason: `could not ask Stripe for recent events: ${err?.message || 'unknown error'}` };
  }

  // Stripe has sent nothing either. Genuinely quiet, so the sweep may run.
  return { trustworthy: true, reason: null };
}

/**
 * Ask Stripe directly whether this one was paid.
 *
 * Only reachable when the appointment carries a payment intent, which is the
 * case the booking page creates. Returns true only on a definite yes; anything
 * unreadable returns null so the caller can hold rather than guess.
 *
 * @returns {Promise<boolean|null>} true paid, false definitely not, null unknown
 */
async function stripeSaysPaid(paymentIntentId) {
  if (!stripe || !paymentIntentId) return null;
  try {
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (pi?.status === 'succeeded') return true;
    if (['canceled', 'requires_payment_method'].includes(pi?.status)) return false;
    return null;
  } catch (err) {
    logger.warn({ err, paymentIntentId }, 'Could not ask Stripe whether the deposit was paid');
    return null;
  }
}

/**
 * Find appointments that are 'pending' (waiting for deposit payment)
 * and have passed their payment_expires_at timestamp (or were created
 * more than 15 minutes ago if no expiry was set). Cancel them to free
 * the time slot for other clients, and send the client a friendly
 * "your slot was released, rebook here" message so an abandoned payment
 * screen doesn't silently lose the booking.
 *
 * Two things stop a release, both for the same reason: a slot must only be
 * taken away when nobody paid, and not-paid has to be distinguishable from
 * could-not-pay and from we-never-heard. paymentNewsIsArriving covers
 * we-never-heard for the whole sweep; the per-booking check on a salon with no
 * Stripe connection covers could-not-pay.
 */
export async function cleanupStaleBookings() {
  const now = new Date().toISOString();
  // Fallback cutoff for appointments without payment_expires_at
  const fallbackCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  // Two separate simple queries instead of one .or():
  // (a) payment_expires_at set and passed
  // (b) no payment_expires_at and created more than 15 min ago
  // Also: deposit_paid can be NULL on older rows, and SQL `!= true` silently
  // drops NULLs, which left those pending bookings in the diary forever.
  // NOTE: the column is google_event_id in prod. The old select named a
  // nonexistent google_calendar_event_id, PostgREST errored, and the error
  // was swallowed, so this cleanup NEVER cancelled anything since launch.
  const SELECT = 'id, beautician_id, client_id, starts_at, created_at, deposit_cents, deposit_paid, payment_expires_at, google_event_id, stripe_payment_intent_id, treatments(name), clients(first_name)';
  const unpaid = q => q.eq('status', 'pending').gt('deposit_cents', 0).or('deposit_paid.is.null,deposit_paid.eq.false');
  const [expiredRes, agedRes] = await Promise.all([
    unpaid(supabase.from('appointments').select(SELECT)).lt('payment_expires_at', now),
    unpaid(supabase.from('appointments').select(SELECT)).is('payment_expires_at', null).lt('created_at', fallbackCutoff),
  ]);

  if (expiredRes.error) logger.warn({ err: expiredRes.error }, 'Cleanup: expired query failed');
  if (agedRes.error) logger.warn({ err: agedRes.error }, 'Cleanup: aged query failed');

  const seen = new Set();
  const stale = [...(expiredRes.data || []), ...(agedRes.data || [])].filter(a => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });

  if (!stale.length) {
    return { cancelled: 0 };
  }

  // Nothing gets released while we are deaf to Stripe. See paymentNewsIsArriving.
  const trust = await paymentNewsIsArriving();
  if (!trust.trustworthy) {
    logger.error({ reason: trust.reason, wouldHaveCancelled: stale.length }, 'Cleanup HELD: cannot trust deposit_paid, no bookings released');
    Sentry.captureMessage('Stale booking cleanup held: payment news is not arriving', {
      level: 'error',
      tags: { area: 'payments', check: 'stale_cleanup_breaker' },
      extra: { reason: trust.reason, wouldHaveCancelled: stale.length },
    });
    return { cancelled: 0, held: true, reason: trust.reason };
  }

  // Beautician rows (slug, business name, channel creds) cached per run.
  const beauticianCache = new Map();
  async function getBeautician(id) {
    if (!beauticianCache.has(id)) {
      const { data } = await supabase.from('beauticians').select('*').eq('id', id).maybeSingle();
      beauticianCache.set(id, data || null);
    }
    return beauticianCache.get(id);
  }

  let cancelled = 0;
  let rescued = 0;
  let confirmedUnpayable = 0;
  for (const appt of stale) {
    // WAS THERE EVER A WAY TO PAY THIS?
    //
    // Same shape of question as the breaker above, one booking down. The
    // breaker asks whether the payment NEWS is reaching us; this asks whether
    // the payment could have been made at all. Both exist because
    // deposit_paid = false is not evidence of anything on its own.
    //
    // A salon with no Stripe Connect account has no Checkout session, no
    // payment link, nothing. Until the booking route was fixed it still wrote
    // deposit_cents from the migration 029 default and left the row 'pending',
    // so fifteen minutes later this loop cancelled a brand new salon's first
    // booking, texted the client that her deposit was not paid, and pushed the
    // owner that somebody had started a booking and not paid. Nobody was ever
    // asked for money. Releasing that slot and blaming the client for it is a
    // lie told twice.
    //
    // Only rows with no payment intent are read this way: a payment intent
    // means a Checkout session existed, so the money WAS askable and the
    // ordinary rules apply.
    if ((appt.deposit_cents || 0) > 0 && !appt.stripe_payment_intent_id) {
      const salon = await getBeautician(appt.beautician_id);
      if (!salon) {
        // Cannot read the salon, so cannot say whether anybody could have paid.
        // An unreadable check is not permission to cancel. Same rule as the breaker.
        logger.warn({ appointmentId: appt.id, beauticianId: appt.beautician_id },
          'Cleanup skipped: could not read the salon to see whether the deposit was ever payable');
        continue;
      }
      const couldTakePayment = Boolean(salon.stripe_account_id) && salon.stripe_onboarding_complete === true;
      if (!couldTakePayment) {
        // Wall-time convention: starts_at is salon wall time parked in a UTC
        // slot, so this compares it against a real instant and runs up to an
        // hour optimistic through BST. That slop points the safe way: a booking
        // that started half an hour ago still reads as ahead of us, and a
        // client who may be sitting in the chair keeps her appointment.
        const stillAhead = String(appt.starts_at || '') > new Date().toISOString();

        if (stillAhead) {
          // She asked for a real slot on a real page and nobody could take her
          // money. That is the salon's problem to settle in the chair, not a
          // reason to take the appointment away. Confirm it and say so.
          const { error: fixErr } = await supabase
            .from('appointments')
            .update({ status: 'confirmed' })
            .eq('id', appt.id)
            .eq('status', 'pending');

          if (fixErr) {
            logger.error({ err: fixErr, appointmentId: appt.id }, 'Could not confirm a booking whose deposit was never payable');
            continue;
          }
          confirmedUnpayable++;

          await supabase.from('ai_actions').insert({
            beautician_id: appt.beautician_id,
            action_type: 'booking_confirmed_deposit_unpayable',
            digital_employee: 'front_desk',
            summary: 'Confirmed a booking whose deposit could never be collected online',
            details: {
              appointment_id: appt.id,
              reason: 'salon_has_no_stripe_connection',
              deposit_cents: appt.deposit_cents,
            },
            client_id: appt.client_id,
            appointment_id: appt.id,
            confidence: 1.0,
            autonomous: true,
            outcome: 'success',
          });

          // The owner hears about it once, honestly, and can ask for the money
          // at the appointment.
          try {
            const time = String(appt.starts_at || '').slice(11, 16);
            const day = String(appt.starts_at || '').slice(0, 10);
            const dateLabel = day
              ? `${new Date(`${day}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}${time ? ` at ${time}` : ''}`
              : 'their slot';
            const name = appt.clients?.first_name || 'Someone';
            await pushTeamUpdate(appt.beautician_id, 'booking_confirmed',
              `${name}'s ${appt.treatments?.name || 'appointment'} on ${dateLabel} is confirmed. Card payments are not set up, so the £${((appt.deposit_cents || 0) / 100).toFixed(2)} deposit could not be taken online. Take it at the appointment, or connect Stripe to collect deposits up front.`,
              { url: '/calendar/week' });
          } catch (e) {
            logger.warn({ err: e, appointmentId: appt.id }, 'unpayable-deposit push failed (non-fatal)');
          }
          continue;
        }

        // Already been and gone. Confirming it now would hand it to the
        // auto-complete sweep, which marks past confirmed bookings completed
        // and books the takings, so a deposit nobody paid would turn into
        // revenue nobody took. It is cleared instead, with a reason that says
        // what actually happened, and in silence: there is no slot left to
        // release and nothing either of them can do about it now.
        const { error: clearErr } = await supabase
          .from('appointments')
          .update({
            status: 'cancelled',
            cancellation_reason: 'auto_cancelled_never_payable',
            cancelled_at: new Date().toISOString(),
          })
          .eq('id', appt.id)
          .eq('status', 'pending');
        if (clearErr) {
          logger.error({ err: clearErr, appointmentId: appt.id }, 'Could not clear a past booking whose deposit was never payable');
          continue;
        }
        cancelled++;
        logger.warn({ appointmentId: appt.id, beauticianId: appt.beautician_id },
          'Cleared a past booking whose deposit was never payable, nobody messaged');
        Sentry.captureMessage('Past booking cleared: its deposit was never payable', {
          level: 'warning',
          tags: { area: 'payments', check: 'stale_cleanup_never_payable' },
          extra: { appointmentId: appt.id, beauticianId: appt.beautician_id },
        });
        continue;
      }
    }

    // One last question before her slot goes. If Stripe says this was paid, the
    // booking is real and our copy of it was wrong: repair it instead, and do
    // not message the client to say a booking they paid for has been released.
    if (appt.stripe_payment_intent_id) {
      const paid = await stripeSaysPaid(appt.stripe_payment_intent_id);
      if (paid === true) {
        const { error: fixErr } = await supabase
          .from('appointments')
          .update({ deposit_paid: true, deposit_status: 'paid', status: 'confirmed' })
          .eq('id', appt.id)
          .eq('status', 'pending');
        logger.error({ appointmentId: appt.id, err: fixErr || undefined }, 'Cleanup RESCUED a paid booking that our records had as unpaid');
        Sentry.captureMessage('Stale cleanup found a paid deposit recorded as unpaid', {
          level: 'error',
          tags: { area: 'payments', check: 'stale_cleanup_rescue' },
          extra: { appointmentId: appt.id },
        });
        if (!fixErr) rescued++;
        continue;
      }
      if (paid === null) {
        // Could not tell. Leave it alone and come back in five minutes.
        logger.warn({ appointmentId: appt.id }, 'Cleanup skipped: Stripe could not confirm whether the deposit was paid');
        continue;
      }
    }

    const { error: updateErr } = await supabase
      .from('appointments')
      .update({
        status: 'cancelled',
        cancellation_reason: 'auto_cancelled_unpaid',
        cancelled_at: new Date().toISOString(),
      })
      .eq('id', appt.id)
      .eq('status', 'pending'); // double-check it's still pending (avoid race)

    if (!updateErr) {
      cancelled++;

      // Remove from Google Calendar if an event was created
      if (appt.google_event_id) {
        removeFromGoogleCalendar(appt.beautician_id, appt.google_event_id).catch(err =>
          logger.warn({ err, appointmentId: appt.id }, 'GCal removal failed (non-fatal)')
        );
      }

      // Log the AI action
      const { error: _logErr } = await supabase.from('ai_actions').insert({
        beautician_id: appt.beautician_id,
        action_type: 'booking_auto_cancelled',
        digital_employee: 'front_desk',
        summary: `Auto-cancelled unpaid booking, payment window expired`,
        details: {
          appointment_id: appt.id,
          reason: 'deposit_not_paid',
          expired_at: appt.payment_expires_at || 'no_expiry_set',
        },
        client_id: appt.client_id,
        appointment_id: appt.id,
        confidence: 1.0,
        autonomous: true,
        outcome: 'success',
      }); // non-fatal, ignore _logErr

      // Retention message: tell the client their slot was released and hand
      // them the rebook link, instead of leaving them thinking they booked.
      // Transactional (their own abandoned checkout), goes via the guard.
      // Only for FRESH cancellations (last 2h): old backlog rows being swept up
      // must not fire day-old "your slot was released" texts.
      //
      // This used to key off payment_expires_at alone, which is only written
      // when booking_policy.payment_buffer_enabled is on, and it is off by
      // default. So on a normal booking the window was never satisfied and an
      // auto-cancellation was completely silent: the client kept believing she
      // had an appointment and Ellie never learned the slot was free again.
      // created_at is on every row, so it is the fallback.
      const releasedFromMs = appt.payment_expires_at
        ? new Date(appt.payment_expires_at).getTime()
        : (appt.created_at ? new Date(appt.created_at).getTime() : 0);
      if (releasedFromMs && Date.now() - releasedFromMs < 2 * 60 * 60 * 1000) {
        sendSlotReleasedMessage(appt, getBeautician).catch(err =>
          logger.warn({ err, appointmentId: appt.id }, 'Slot-released message failed (non-fatal)')
        );
        // The ONE "deposit not completed" alert to the beautician - only when a
        // booking is actually abandoned, never up front. So she can nudge them.
        (async () => {
          try {
            const day = String(appt.starts_at || '').slice(0, 10);
            const time = String(appt.starts_at || '').slice(11, 16);
            const dateLabel = day ? `${new Date(`${day}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} at ${time}` : 'their slot';
            const name = appt.clients?.first_name || 'Someone';
            await pushTeamUpdate(appt.beautician_id, 'booking_pending',
              `${name} started booking ${appt.treatments?.name || 'an appointment'} for ${dateLabel} but didn't pay the deposit, so the slot has been released.`,
              { url: '/calendar/week' });
          } catch (e) { logger.warn({ err: e, appointmentId: appt.id }, 'abandon push failed (non-fatal)'); }
        })();
      }
    }
  }

  return { cancelled, rescued, confirmedUnpayable, checked: stale.length };
}

/**
 * "Your slot was released" note to the client after an unpaid booking
 * expires. WhatsApp first, then SMS, then email, whatever is on file.
 */
async function sendSlotReleasedMessage(appt, getBeautician) {
  if (!appt.client_id) return;
  const beautician = await getBeautician(appt.beautician_id);
  if (!beautician) return;

  const { data: client } = await supabase
    .from('clients')
    .select('id, first_name, phone, email, whatsapp_id')
    .eq('id', appt.client_id)
    .maybeSingle();
  if (!client) return;

  const channel = (client.whatsapp_id || client.phone) ? 'whatsapp'
    : client.phone ? 'sms'
    : client.email ? 'email'
    : null;
  if (!channel) return;

  // Wall-time convention: date and time read straight off the string.
  const day = String(appt.starts_at || '').slice(0, 10);
  const time = String(appt.starts_at || '').slice(11, 16);
  const dayLabel = day ? new Date(`${day}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) : 'your chosen day';
  const treatment = appt.treatments?.name || 'appointment';
  const slug = beautician.booking_slug;
  const rebookLine = slug ? ` You can rebook in seconds here: https://florrie.ai/book/${slug}` : '';
  const body = `Hi ${client.first_name || 'there'}, your ${treatment} booking for ${dayLabel}${time ? ` at ${time}` : ''} didn't complete because the deposit wasn't paid, so the slot has been released.${rebookLine}`;

  await guardedSend({
    beauticianId: appt.beautician_id,
    clientId: client.id,
    messageType: 'payment_link',
    channel,
    client,
    body,
    send: async () => {
      const result = await sendOnChannel({ beautician, clientId: client.id, channel, body, authoredBy: 'system' });
      return !!result?.ok;
    },
  });
}

/**
 * Remove a Google Calendar event when a booking is auto-cancelled.
 * Fetches the beautician's OAuth tokens and calls the GCal delete API.
 *
 * THE COLUMNS. There is one column, google_calendar_tokens, an encrypted JSONB
 * blob holding { access_token, refresh_token, expiry_date }
 * (supabase/migrations/004_integrations.sql:7). The two singular columns this
 * used to name, google_calendar_token and google_calendar_refresh_token, are
 * in no migration. PostgREST rejected the whole select, `b` came back null,
 * and the function returned at the first guard on every single call.
 *
 * That silence had a shape. The sweep cancelled the appointment and texted the
 * client that her slot was released, and the event stayed in Ellie's Google
 * Calendar looking booked. She then worked around a slot she believed was
 * taken, or booked over it and double-booked herself.
 *
 * Decryption and refresh follow routes/google-calendar.js getAccessToken,
 * which is the working implementation of the same thing. It is not exported
 * from a route module, so the shape is mirrored here rather than imported: the
 * blob may be an encrypted string or a legacy plain object, the refreshed
 * token is written back as the whole re-encrypted blob, and a refresh that
 * Google refuses disconnects the integration instead of leaving a dead token
 * in place to fail again every five minutes.
 */
async function removeFromGoogleCalendar(beauticianId, eventId) {
  const { data: b, error } = await supabase
    .from('beauticians')
    .select('google_calendar_tokens, google_calendar_id')
    .eq('id', beauticianId)
    .maybeSingle();

  if (error) {
    logger.warn({ err: error, beauticianId }, 'GCal token lookup failed');
    return;
  }
  if (!b?.google_calendar_tokens) return; // not connected, nothing to remove

  let tokens;
  try {
    const raw = b.google_calendar_tokens;
    tokens = (typeof raw === 'string' && isEncrypted(raw)) ? decrypt(raw) : raw;
  } catch (err) {
    logger.warn({ err, beauticianId }, 'GCal tokens could not be decrypted');
    return;
  }
  if (!tokens?.access_token) return;

  // Try with existing access token first
  let accessToken = tokens.access_token;
  const calendarId = b.google_calendar_id || 'primary';

  const del = async (token) => {
    return fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
    );
  };

  let res = await del(accessToken);

  // Token expired, try to refresh
  if (res.status === 401 && tokens.refresh_token) {
    const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
      }),
    });

    if (refreshRes.ok) {
      const refreshed = await refreshRes.json();
      accessToken = refreshed.access_token;

      // Persist the whole blob, re-encrypted. Writing a bare access_token to
      // google_calendar_token was the second half of the same bug: that column
      // does not exist, so the update was rejected and the refreshed token was
      // thrown away even in the world where the read had worked.
      const updated = {
        ...tokens,
        access_token: refreshed.access_token,
        expiry_date: Date.now() + (refreshed.expires_in || 3600) * 1000,
      };
      const { error: saveErr } = await supabase
        .from('beauticians')
        .update({ google_calendar_tokens: encrypt(updated) })
        .eq('id', beauticianId);
      if (saveErr) logger.warn({ err: saveErr, beauticianId }, 'GCal refreshed token not persisted');

      res = await del(accessToken);
    } else {
      // Google refused the refresh (revoked access, invalid_grant). Mark the
      // integration disconnected so Ellie is asked to reconnect, rather than
      // this failing quietly every five minutes forever.
      logger.warn({ beauticianId, status: refreshRes.status }, 'GCal refresh refused, disconnecting integration');
      await supabase
        .from('beauticians')
        .update({ google_calendar_tokens: null, google_calendar_connected: false })
        .eq('id', beauticianId);
      return;
    }
  }

  if (res.status === 204 || res.status === 404) {
    // 204 = deleted, 404 = already gone, both are fine
    logger.info({ beauticianId, eventId }, 'GCal event removed after auto-cancel');
  } else {
    const body = await res.text().catch(() => '');
    logger.warn({ beauticianId, eventId, status: res.status, body }, 'GCal delete returned unexpected status');
  }
}
