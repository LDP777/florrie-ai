import { insertPaymentReceipt } from '../lib/payment-receipt.js';
import Stripe from 'stripe';
import * as Sentry from '@sentry/node';
import { supabase } from '../config.js';
import { totalApplicationFee } from '../lib/platform-fees.js';
import { PRICE_SETTLED_TYPES, isSettledPriceRow } from '../lib/money-guards.js';
import { supersedeAssumedTakings } from '../lib/takings.js';
import logger from '../lib/logger.js';

/**
 * Policy fees: auto-charge late-cancellation and no-show fees off-session.
 *
 * The booking deposit Checkout already saves the card
 * (setup_future_usage 'off_session' + a platform Stripe customer per client).
 * This service charges that saved card when a client breaks the policy:
 *
 *   chargePolicyFee(appointmentId, 'late_cancel')  - cancel inside the notice window
 *   chargePolicyFee(appointmentId, 'no_show')      - marked no_show by the beautician
 *
 * Consent rule: we only charge when the beautician's policy has a fee
 * configured (> 0 percent). No policy fee configured = no charge, ever.
 *
 * Idempotency: appointments.policy_fee_charged_at is the guard. Non-null
 * means already charged; we never charge the same appointment twice. The
 * Stripe call also carries idempotency key policyfee_{appointmentId}_{kind}
 * so even a double call inside the same instant cannot double-charge.
 *
 * Money flow mirrors the existing deposit/no-show charges exactly:
 * platform-account PaymentIntent with transfer_data.destination to the
 * beautician's Connect account and application_fee_amount for Florrie.
 *
 * Never throws. Callers fire-and-forget; failures land in ai_actions so the
 * beautician sees them in the "What Florrie did" feed.
 */

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const KIND_LABELS = {
  late_cancel: 'late cancellation fee',
  no_show: 'no-show fee',
};

function poundsLabel(cents) {
  return `£${(cents / 100).toFixed(2)}`;
}

async function logAction({ appt, kind, actionType, outcome, summary, details }) {
  try {
    await supabase.from('ai_actions').insert({
      beautician_id: appt.beautician_id,
      client_id: appt.client_id || null,
      appointment_id: appt.id,
      action_type: actionType,
      digital_employee: 'money',
      summary,
      details: { kind, ...details },
      confidence: 1.0,
      autonomous: true,
      outcome,
      notification_sent: false,
    });
  } catch (err) {
    logger.warn({ err, appointmentId: appt.id }, 'policy fee ai_actions log failed');
  }
}

/**
 * Compute the policy fee for an appointment without charging it.
 * Returns { feeCents, percent } - feeCents is 0 when no fee applies.
 * Shared by the charge path and the manage-page preview.
 */
export function computePolicyFee(appointment, policy, kind, { creditedCents } = {}) {
  const pol = policy || {};
  let percent;
  if (kind === 'late_cancel') {
    percent = Number(pol.late_cancel_charge_percent) || 0;
  } else {
    // No dedicated no-show percent exists in the policy yet; a no-show is at
    // least as severe as a late cancel, so fall back to that percent.
    percent = Number(pol.no_show_charge_percent ?? pol.late_cancel_charge_percent) || 0;
  }
  percent = Math.max(0, Math.min(100, percent));
  if (percent <= 0) return { feeCents: 0, percent: 0 };

  const priceCents = appointment.price_cents || 0;
  let feeCents = Math.round(priceCents * percent / 100);

  feeCents = Math.max(0, feeCents - (creditedCents ?? legacyPaidCredit(appointment)));
  return { feeCents, percent };
}

function legacyPaidCredit(appointment) {
  if (!appointment.deposit_paid || appointment.deposit_status === 'refunded') return 0;
  if (appointment.payment_type === 'full') return Math.max(0, Number(appointment.price_cents) || 0);
  // Older bookings have the schema's default zero in deposit_amount_cents.
  // A verified paid deposit must still credit their original deposit_cents.
  return Math.max(0, Number(appointment.deposit_amount_cents) || Number(appointment.deposit_cents) || 0);
}

/** Quote against the owner's actual ledger before starting a new charge.
 * A deposit field and its receipt describe the same payment. Cash/card/transfer
 * balance receipts count too; completion-only assumptions and tips do not. */
export async function quotePolicyFee(appointment, policy, kind, { db = supabase } = {}) {
  const gross = computePolicyFee(appointment, policy, kind, { creditedCents: 0 });
  if (!gross.feeCents) return { ...gross, creditedCents: 0 };
  const ownerId = appointment.beautician_id || appointment.beauticians?.id;
  if (!appointment.id || !ownerId) throw new Error('Could not verify payment ownership');
  const { data, error } = await db.from('transactions')
    .select('id,type,amount_cents,status,payment_method,stripe_payment_intent_id')
    .eq('beautician_id', ownerId).eq('appointment_id', appointment.id)
    .eq('status', 'completed')
    .in('type', ['deposit', ...PRICE_SETTLED_TYPES, 'refund']);
  if (error || !Array.isArray(data)) throw new Error('Could not check payments already received');
  return quotePolicyFeeFromRows(appointment, policy, kind, data);
}

/** Use a previously owner-scoped ledger read when checking several visits. */
export function quotePolicyFeeFromRows(appointment, policy, kind, data) {
  if (!Array.isArray(data)) throw new Error('Could not check payments already received');
  const rows = data.filter(row => row.status === 'completed');
  const receipts = rows.filter(row => row.type === 'deposit' || isSettledPriceRow(row));
  const bookingReceipts = receipts.filter(row => ['deposit', 'full_payment', 'payment_link'].includes(row.type));
  const legacyCredit = legacyPaidCredit(appointment);
  const amount = row => Number(row.amount_cents) || 0;
  const ledgerCredit = receipts.reduce((total, row) => total + Math.max(0, amount(row)), 0);
  // Payment links may cover a deposit or a balance. If a legacy deposit has
  // no separate receipt, do not guess whether it is part of the link payment.
  if (legacyCredit > 0 && bookingReceipts.length > 0
      && bookingReceipts.every(row => row.type === 'payment_link')
      && ledgerCredit < (Number(appointment.price_cents) || 0)) {
    throw new Error('The recorded payments need review before a cancellation fee can be quoted');
  }
  const refunds = rows.filter(row => row.type === 'refund').reduce((total, row) => total + amount(row), 0);
  const creditedCents = Math.max(0, ledgerCredit + (bookingReceipts.length ? 0 : legacyCredit) + refunds);
  return { ...computePolicyFee(appointment, policy, kind, { creditedCents }), creditedCents };
}

export async function chargePolicyFee(appointmentId, kind, { recovery = null } = {}) {
  if (!KIND_LABELS[kind]) {
    logger.warn({ appointmentId, kind }, 'chargePolicyFee: unknown kind');
    return { charged: false, reason: 'unknown_kind' };
  }

  try {
    const { data: appt } = await supabase
      .from('appointments')
      .select(`
        id, beautician_id, client_id, status, price_cents, deposit_cents, deposit_amount_cents,
        deposit_paid, deposit_status, payment_type, policy_snapshot, stripe_payment_method_id,
        policy_fee_charged_at, policy_fee_payment_intent_id,
        clients(id, first_name, last_name, stripe_customer_id),
        beauticians(id, business_name, first_name, booking_policy,
          stripe_account_id, stripe_onboarding_complete)
      `)
      .eq('id', appointmentId)
      .maybeSingle();

    if (!appt) return { charged: false, reason: 'not_found' };

    // HARD RULE: never charge twice.
    if (appt.policy_fee_charged_at && !recovery?.request) {
      return { charged: false, reason: 'already_charged' };
    }

    const clientName = `${appt.clients?.first_name || 'the client'} ${appt.clients?.last_name || ''}`.trim();
    const label = KIND_LABELS[kind];

    // The snapshot is frozen at booking time and is what the client agreed to,
    // so it wins. EXCEPT no_show_charge_percent, which is a newer setting: old
    // snapshots simply don't have the key, and without this fall-through a fee
    // Ellie sets today would never apply to a single existing booking.
    const snapshot = appt.policy_snapshot || {};
    const live = appt.beauticians?.booking_policy || {};
    const policy = appt.policy_snapshot
      ? { ...snapshot, ...(snapshot.no_show_charge_percent === undefined && live.no_show_charge_percent !== undefined
            ? { no_show_charge_percent: live.no_show_charge_percent } : {}) }
      : live;
    const priorRequest = recovery?.request || null;
    const computed = priorRequest ? null : await quotePolicyFee(appt, policy, kind);
    const feeCents = priorRequest?.params?.amount ?? computed.feeCents;
    const percent = priorRequest?.percent ?? computed.percent;
    if (!priorRequest && recovery?.expectedFeeCents != null && feeCents !== recovery.expectedFeeCents) {
      return { charged: false, reason: 'fee_changed' };
    }

    // Consent rule: no configured fee (or nothing left after the deposit) = no charge.
    // Stripe's GBP minimum is 30p; below that there is nothing chargeable.
    if (!feeCents || feeCents < 30) {
      return { charged: false, reason: 'no_fee_configured' };
    }

    if (!stripe) return { charged: false, reason: 'stripe_not_configured' };

    const b = appt.beauticians;
    if (!priorRequest && !appt.policy_fee_payment_intent_id && (!b?.stripe_account_id || !b?.stripe_onboarding_complete)) {
      await logAction({
        appt, kind,
        actionType: 'policy_fee_uncollectable',
        // Was 'failure', which the CHECK from 001_initial_schema.sql does not
        // allow: success, pending, failed, escalated. Every one of these four
        // inserts was rejected 23514 and swallowed by its own catch, so the
        // record of a policy fee that could not be charged has never once
        // existed. Same typo, same day, as the one in notifications.js.
        outcome: 'failed',
        summary: `Could not charge ${clientName} the ${poundsLabel(feeCents)} ${label}, Stripe payouts are not set up yet`,
        details: { fee_cents: feeCents, percent, reason: 'stripe_not_onboarded' },
      });
      return { charged: false, reason: 'stripe_not_onboarded' };
    }

    const customerId = priorRequest?.params?.customer || appt.clients?.stripe_customer_id;
    let paymentMethodId = priorRequest?.params?.payment_method || appt.stripe_payment_method_id || null;

    if (customerId && !paymentMethodId) {
      // Fall back to the customer's most recent saved card (same as charge-no-show).
      const methods = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
      paymentMethodId = methods.data?.[0]?.id || null;
    }

    if (!customerId || !paymentMethodId) {
      await logAction({
        appt, kind,
        actionType: 'policy_fee_uncollectable',
        outcome: 'failed',
        summary: `No card on file, could not charge the ${label} for ${clientName}`,
        details: { fee_cents: feeCents, percent, reason: 'no_card_on_file' },
      });
      return { charged: false, reason: 'no_card_on_file' };
    }

    // Destination charge: the platform pays Stripe's processing fee, so the
    // application fee must recover it on top of Florrie's cut or this payment
    // loses the platform money (the arrears leak).
    const platformFee = priorRequest?.params?.application_fee_amount ?? totalApplicationFee(feeCents);

    let paymentIntent;
    try {
      const params = priorRequest?.params || {
        amount: feeCents,
        currency: 'gbp',
        customer: customerId,
        payment_method: paymentMethodId,
        confirm: true,
        off_session: true,
        application_fee_amount: platformFee,
        transfer_data: { destination: b.stripe_account_id },
        description: `${kind === 'no_show' ? 'No-show' : 'Late cancellation'} fee, ${clientName}`,
        metadata: {
          appointment_id: appt.id,
          beautician_id: appt.beautician_id,
          client_id: appt.client_id || '',
          type: kind === 'no_show' ? 'no_show_fee' : 'late_cancel_fee',
          policy_fee_kind: kind,
          platform_fee_cents: platformFee,
        },
      };
      const idempotencyKey = priorRequest?.idempotencyKey || `policyfee_${appointmentId}_${kind}`;
      const knownIntent = priorRequest?.paymentIntentId || appt.policy_fee_payment_intent_id;
      if (knownIntent) {
        // A known payment is reconciled with GET. Never create a replacement
        // because the provider is still processing it or our receipt write failed.
        paymentIntent = await stripe.paymentIntents.retrieve(knownIntent);
      } else {
        // Stripe can prune API-v1 idempotency keys after 24 hours. Leave an
        // hour of margin; an unknown older outcome needs the owner's review.
        if (priorRequest && (!Number.isFinite(Date.parse(priorRequest.firstAttemptAt)) || Date.now() - Date.parse(priorRequest.firstAttemptAt) >= 23 * 3600000)) {
          return { charged: false, reason: 'idempotency_expired' };
        }
        if (recovery && !priorRequest) await recovery.persist({ params, idempotencyKey, percent, firstAttemptAt: new Date().toISOString() });
        paymentIntent = await stripe.paymentIntents.create(params, { idempotencyKey });
      }
      if (recovery) await recovery.persist({ ...(priorRequest || {}), params, idempotencyKey, percent,
        firstAttemptAt: priorRequest?.firstAttemptAt || new Date().toISOString(), paymentIntentId: paymentIntent.id });
    } catch (err) {
      // Card declined / 3DS required: log it for the beautician, never throw.
      const declined = err?.code === 'authentication_required' || err?.type === 'StripeCardError';
      if (declined || !recovery) await logAction({
        appt, kind,
        actionType: 'policy_fee_uncollectable',
        outcome: 'failed',
        summary: declined
          ? `${clientName}'s card would not accept the ${poundsLabel(feeCents)} ${label} (${err.code || 'card declined'}). You could send a payment link instead`
          : `Charging ${clientName} the ${poundsLabel(feeCents)} ${label} failed, I will not retry automatically`,
        details: { fee_cents: feeCents, percent, stripe_code: err?.code || null, stripe_error: String(err?.message || '').slice(0, 200) },
      });
      if (!declined) logger.error({ err, appointmentId, kind }, 'policy fee charge failed');
      return { charged: false, reason: declined ? (err.code || 'card_declined') : 'stripe_error' };
    }

    const succeeded = paymentIntent.status === 'succeeded';
    if (paymentIntent.status === 'processing') {
      const pending = await supabase.from('appointments').update({ policy_fee_payment_intent_id: paymentIntent.id }).eq('id', appointmentId);
      if (pending.error) logger.error({ appointmentId, paymentIntentId: paymentIntent.id }, 'Could not save processing policy fee');
      return { charged: false, reason: 'processing', pending: true, paymentIntentId: paymentIntent.id };
    }
    if (!succeeded) {
      await logAction({
        appt, kind,
        actionType: 'policy_fee_uncollectable',
        outcome: 'failed',
        summary: `The ${poundsLabel(feeCents)} ${label} for ${clientName} did not go through (status ${paymentIntent.status})`,
        details: { fee_cents: feeCents, percent, payment_intent_id: paymentIntent.id, status: paymentIntent.status },
      });
      return { charged: false, reason: paymentIntent.status };
    }

    // Mark charged (idempotency anchor) + audit fields.
    const { error: apptErr } = await supabase.from('appointments').update({
      policy_fee_charged_at: new Date().toISOString(),
      policy_fee_amount_cents: feeCents,
      policy_fee_payment_intent_id: paymentIntent.id,
      ...(kind === 'no_show' && {
        no_show_fee_cents: feeCents,
        no_show_fee_charged: true,
        no_show_fee_payment_intent: paymentIntent.id,
      }),
      ...(kind === 'late_cancel' && { late_cancel_charged: true }),
    }).eq('id', appointmentId);

    if (apptErr) {
      // THE MOST DANGEROUS UNCHECKED WRITE IN THE CODEBASE, and it was silent.
      // policy_fee_charged_at is the ONLY thing that stops this client being
      // charged a second time: the guard at the top of this function reads it,
      // and Stripe's idempotency key only covers a 24 hour window. If this
      // write is rejected and nobody notices, tomorrow's no-show sweep charges
      // the same card the same fee again, and the client's first hint is her
      // statement.
      logger.error({ err: apptErr, appointmentId, kind, paymentIntentId: paymentIntent.id, feeCents },
        'CHARGED BUT NOT MARKED: policy fee taken but the idempotency anchor was not written, double charge possible');
      Sentry.captureException(new Error('CHARGED BUT NOT MARKED: policy fee idempotency anchor not written'), {
        level: 'fatal',
        tags: { area: 'payments', check: 'policy_fee_anchor' },
        extra: {
          appointmentId,
          kind,
          paymentIntentId: paymentIntent.id,
          feeCents,
          dbError: apptErr.message,
          dbCode: apptErr.code,
        },
      });
    }

    // Money feed. Same failure mode as chargeRemainingBalance: the card has
    // been charged, and an unchecked reject means the fee never appears in
    // Ellie's takings and nothing ever tells her.
    const { error: txErr } = await insertPaymentReceipt(supabase, {
      beautician_id: appt.beautician_id,
      appointment_id: appt.id,
      client_id: appt.client_id || null,
      amount_cents: feeCents,
      type: kind === 'no_show' ? 'no_show_fee' : 'late_cancel_fee',
      status: 'completed',
      stripe_payment_intent_id: paymentIntent.id,
      payment_method: 'card_online',
    });
    if (txErr) {
      logger.error({ err: txErr, appointmentId, kind, paymentIntentId: paymentIntent.id, feeCents },
        'CHARGED BUT NOT RECORDED: policy fee taken from the card but the transaction insert failed');
      Sentry.captureMessage('CHARGED BUT NOT RECORDED: policy fee', {
        level: 'error',
        tags: { area: 'payments', check: 'transaction_insert' },
        extra: {
          appointmentId,
          kind,
          paymentIntentId: paymentIntent.id,
          amountCents: feeCents,
          dbError: txErr.message,
          dbCode: txErr.code,
        },
      });
    }

    if (!recovery) await logAction({
      appt, kind,
      actionType: 'policy_fee_charged',
      outcome: 'success',
      summary: `Charged ${clientName} a ${poundsLabel(feeCents)} ${label}`,
      details: { fee_cents: feeCents, percent, payment_intent_id: paymentIntent.id, platform_fee_cents: platformFee },
    });

    logger.info({ appointmentId, kind, feeCents, paymentIntentId: paymentIntent.id }, 'Policy fee charged');
    return { charged: true, feeCents, paymentIntentId: paymentIntent.id, recorded: !apptErr && !txErr };
  } catch (err) {
    logger.error({ err, appointmentId, kind }, 'chargePolicyFee unexpected failure');
    return { charged: false, reason: 'error' };
  }
}

/**
 * Charge a client's REMAINING balance (treatment price minus the deposit they
 * already paid) to their saved card. The fallback for when a client doesn't pay
 * the balance by bank transfer. Off-session, same money flow as deposit/fees.
 *
 * Persistent double-charge guard: a deposit booking only has a 'deposit'
 * transaction until the balance is taken; once we charge the balance we record a
 * 'payment' transaction, so the presence of a 'payment' row = already charged.
 *
 * Returns { charged:true, amountCents } or { charged:false, reason }. Never throws.
 */
export async function chargeRemainingBalance(appointmentId) {
  try {
    const { data: appt } = await supabase
      .from('appointments')
      .select(`
        id, beautician_id, client_id, price_cents, deposit_cents, deposit_paid,
        payment_type,
        stripe_payment_method_id,
        clients(id, first_name, last_name, stripe_customer_id),
        beauticians(id, business_name, first_name, stripe_account_id, stripe_onboarding_complete)
      `)
      .eq('id', appointmentId)
      .maybeSingle();

    if (!appt) return { charged: false, reason: 'not_found' };

    // A pay-in-full booking has NO remainder, whatever price minus deposit
    // says. deposit_cents still carries the standard deposit figure on these
    // rows, so the arithmetic below would happily invoice a fully paid client
    // for price minus 10 pounds. That is how Ellie's client who had paid in
    // full showed as "charge 10 to card", one tap from a double charge.
    if (appt.payment_type === 'full') {
      return { charged: false, reason: 'paid_in_full' };
    }

    const priceCents = appt.price_cents || 0;
    const depositPaidCents = appt.deposit_paid ? (appt.deposit_cents || 0) : 0;
    const amountCents = Math.max(0, priceCents - depositPaidCents);
    if (amountCents < 30) return { charged: false, reason: 'nothing_due' };

    // Already charged or already settled? full_payment counts: a client who
    // paid everything at booking must trip this guard, and until now did not.
    //
    // ASSUMED ROWS DO NOT COUNT. 27 August 2026: the salon owner asked how to
    // charge a card after a booking says completed, and the answer was that she
    // could not. Completing a booking writes a type 'payment' row with no
    // method and no payment intent (lib/takings.js) purely to make the Money
    // tab add up, so this guard refused every completed appointment with
    // "already charged" for money that had never touched a card. Only a row
    // with a Stripe intent, or a cash/transfer she keyed in herself, is
    // evidence that the price is settled. See isSettledPriceRow.
    const { data: prior, error: priorError } = await supabase
      .from('transactions')
      .select('id, type, amount_cents, payment_method, stripe_payment_intent_id')
      .eq('appointment_id', appt.id)
      .in('type', PRICE_SETTLED_TYPES);
    // If the guard itself cannot be read, refuse to charge. Charging blind is
    // exactly the double-charge this guard exists to prevent.
    if (priorError) return { charged: false, reason: 'guard_unreadable' };
    if ((prior || []).some(isSettledPriceRow)) return { charged: false, reason: 'already_charged' };

    if (!stripe) return { charged: false, reason: 'stripe_not_configured' };

    const b = appt.beauticians;
    if (!b?.stripe_account_id || !b?.stripe_onboarding_complete) {
      return { charged: false, reason: 'stripe_not_onboarded' };
    }

    const clientName = `${appt.clients?.first_name || 'the client'} ${appt.clients?.last_name || ''}`.trim();
    const customerId = appt.clients?.stripe_customer_id;
    let paymentMethodId = appt.stripe_payment_method_id || null;
    if (customerId && !paymentMethodId) {
      const methods = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
      paymentMethodId = methods.data?.[0]?.id || null;
    }
    if (!customerId || !paymentMethodId) return { charged: false, reason: 'no_card_on_file' };

    // Same as every destination charge: recover Stripe's processing fee too.
    const platformFee = totalApplicationFee(amountCents);
    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: 'gbp',
        customer: customerId,
        payment_method: paymentMethodId,
        confirm: true,
        off_session: true,
        application_fee_amount: platformFee,
        transfer_data: { destination: b.stripe_account_id },
        description: `Remaining balance, ${clientName}`,
        metadata: {
          appointment_id: appt.id,
          beautician_id: appt.beautician_id,
          client_id: appt.client_id || '',
          type: 'remaining_balance',
          platform_fee_cents: platformFee,
        },
      }, {
        idempotencyKey: `balance_${appointmentId}`,
      });
    } catch (err) {
      const declined = err?.code === 'authentication_required' || err?.type === 'StripeCardError';
      if (!declined) logger.error({ err, appointmentId }, 'remaining balance charge failed');
      return { charged: false, reason: declined ? (err.code || 'card_declined') : 'stripe_error' };
    }

    const ok = paymentIntent.status === 'succeeded' || paymentIntent.status === 'processing';
    if (!ok) return { charged: false, reason: paymentIntent.status };

    // MUST be checked. This row is also the double-charge guard above, so a
    // silent insert failure means the card was charged AND the guard never
    // engages, which is how you charge someone twice.
    const { error: txErr } = await insertPaymentReceipt(supabase, {
      beautician_id: appt.beautician_id,
      appointment_id: appt.id,
      client_id: appt.client_id || null,
      amount_cents: amountCents,
      type: 'payment',
      status: 'completed',
      stripe_payment_intent_id: paymentIntent.id,
      payment_method: 'card_online',
    });
    if (txErr) {
      // Money has left the client's card and the books do not know. This is
      // the incident that ran for weeks: a CHECK constraint rejected the row,
      // Supabase reported it in the result object, and the only trace was a
      // log line nobody read. This row is also the double-charge guard, so a
      // silent failure here can lead to charging the same person twice.
      logger.error({ err: txErr, appointmentId, paymentIntentId: paymentIntent.id, amountCents },
        'CHARGED BUT NOT RECORDED: balance taken from the card but the transaction insert failed');
      Sentry.captureMessage('CHARGED BUT NOT RECORDED: remaining balance', {
        level: 'error',
        tags: { area: 'payments', check: 'transaction_insert' },
        extra: {
          appointmentId,
          paymentIntentId: paymentIntent.id,
          amountCents,
          dbError: txErr.message,
          dbCode: txErr.code,
        },
      });
    }

    // The money is now real, so the guess that stood in for it must go, or the
    // same GBP 45 sits in her books twice. Only after a clean insert: if the
    // row above failed we still have the assumed row, and that is strictly
    // better than an empty ledger for money that has left a card.
    if (!txErr) await supersedeAssumedTakings(appt.id, amountCents);

    logger.info({ appointmentId, amountCents, paymentIntentId: paymentIntent.id }, 'Remaining balance charged');
    return { charged: true, amountCents, paymentIntentId: paymentIntent.id };
  } catch (err) {
    logger.error({ err, appointmentId }, 'chargeRemainingBalance unexpected failure');
    return { charged: false, reason: 'error' };
  }
}

/**
 * Charge an arbitrary amount to a client's saved card, on Ellie's say-so.
 *
 * This is the general "take payment from their card" capability, as opposed to
 * the specific policy-fee and remaining-balance paths. She types the amount and
 * a reason, and confirms it herself; nothing here ever fires automatically.
 *
 * NOT idempotent across calls by design: she may legitimately charge the same
 * client twice (two treatments, a top-up). The confirm step in the UI is the
 * guard, and every charge is logged as its own transaction so her books and
 * Stripe agree.
 *
 * Returns { charged:true, amountCents, paymentIntentId } or { charged:false, reason }.
 * Never throws.
 */
export async function chargeCardAmount(appointmentId, amountCents, reason = '') {
  try {
    const amount = Math.round(Number(amountCents) || 0);
    if (!amount || amount < 30) return { charged: false, reason: 'amount_too_small' };
    // Guard rail: a mistyped amount should not empty someone's account.
    if (amount > 100000) return { charged: false, reason: 'amount_too_large' };

    const { data: appt } = await supabase
      .from('appointments')
      .select(`
        id, beautician_id, client_id, stripe_payment_method_id,
        clients(id, first_name, last_name, stripe_customer_id),
        beauticians(id, business_name, first_name, stripe_account_id, stripe_onboarding_complete)
      `)
      .eq('id', appointmentId)
      .maybeSingle();

    if (!appt) return { charged: false, reason: 'not_found' };
    if (!stripe) return { charged: false, reason: 'stripe_not_configured' };

    const b = appt.beauticians;
    if (!b?.stripe_account_id || !b?.stripe_onboarding_complete) {
      return { charged: false, reason: 'stripe_not_onboarded' };
    }

    const clientName = `${appt.clients?.first_name || 'the client'} ${appt.clients?.last_name || ''}`.trim();
    const customerId = appt.clients?.stripe_customer_id;
    let paymentMethodId = appt.stripe_payment_method_id || null;
    if (customerId && !paymentMethodId) {
      // The card Stripe saved at checkout (setup_future_usage 'off_session').
      const methods = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
      paymentMethodId = methods.data?.[0]?.id || null;
    }
    if (!customerId || !paymentMethodId) return { charged: false, reason: 'no_card_on_file' };

    // Same as every destination charge: recover Stripe's processing fee too.
    const platformFee = totalApplicationFee(amount);
    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: 'gbp',
        customer: customerId,
        payment_method: paymentMethodId,
        confirm: true,
        off_session: true,
        application_fee_amount: platformFee,
        transfer_data: { destination: b.stripe_account_id },
        description: reason ? `${reason}, ${clientName}` : `Charge, ${clientName}`,
        metadata: {
          appointment_id: appt.id,
          beautician_id: appt.beautician_id,
          client_id: appt.client_id || '',
          type: 'manual_charge',
          reason: reason || '',
          platform_fee_cents: platformFee,
        },
      });
    } catch (err) {
      const declined = err?.code === 'authentication_required' || err?.type === 'StripeCardError';
      if (!declined) logger.error({ err, appointmentId }, 'manual card charge failed');
      return { charged: false, reason: declined ? (err.code || 'card_declined') : 'stripe_error' };
    }

    const ok = paymentIntent.status === 'succeeded' || paymentIntent.status === 'processing';
    if (!ok) return { charged: false, reason: paymentIntent.status };

    const { error: txErr } = await insertPaymentReceipt(supabase, {
      beautician_id: appt.beautician_id,
      appointment_id: appt.id,
      client_id: appt.client_id || null,
      amount_cents: amount,
      type: 'payment',
      status: 'completed',
      stripe_payment_intent_id: paymentIntent.id,
      payment_method: 'card_online',
      description: reason || null,
    });
    if (txErr) {
      // Same failure mode as chargeRemainingBalance above: the card was
      // charged, the ledger write was rejected, and without this the loss is
      // only discoverable by accident weeks later.
      logger.error({ err: txErr, appointmentId, paymentIntentId: paymentIntent.id, amount },
        'CHARGED BUT NOT RECORDED: card charged but the transaction insert failed');
      Sentry.captureMessage('CHARGED BUT NOT RECORDED: manual card charge', {
        level: 'error',
        tags: { area: 'payments', check: 'transaction_insert' },
        extra: {
          appointmentId,
          paymentIntentId: paymentIntent.id,
          amountCents: amount,
          dbError: txErr.message,
          dbCode: txErr.code,
        },
      });
    }

    // Same retraction as the balance path. She types the amount here, so the
    // charge may be larger or smaller than what completion assumed; the plan
    // cancels the assumption pound for pound and never more than there was.
    if (!txErr) await supersedeAssumedTakings(appt.id, amount);

    logger.info({ appointmentId, amount, reason, paymentIntentId: paymentIntent.id }, 'Manual card charge taken');
    return { charged: true, amountCents: amount, paymentIntentId: paymentIntent.id };
  } catch (err) {
    logger.error({ err, appointmentId }, 'chargeCardAmount unexpected failure');
    return { charged: false, reason: 'unexpected_error' };
  }
}

/**
 * Can this appointment's client be charged right now? Powers the UI so Ellie
 * knows BEFORE she tries, instead of finding out from an error.
 */
export async function getCardOnFile(appointmentId) {
  try {
    const { data: appt } = await supabase
      .from('appointments')
      .select('id, stripe_payment_method_id, clients(stripe_customer_id), beauticians(stripe_account_id, stripe_onboarding_complete)')
      .eq('id', appointmentId)
      .maybeSingle();
    if (!appt || !stripe) return { hasCard: false, reason: 'stripe_not_configured' };
    const b = appt.beauticians;
    if (!b?.stripe_account_id || !b?.stripe_onboarding_complete) return { hasCard: false, reason: 'stripe_not_onboarded' };

    if (appt.stripe_payment_method_id) return { hasCard: true };
    const customerId = appt.clients?.stripe_customer_id;
    if (!customerId) return { hasCard: false, reason: 'no_card_on_file' };

    const methods = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
    const card = methods.data?.[0];
    if (!card) return { hasCard: false, reason: 'no_card_on_file' };
    return { hasCard: true, brand: card.card?.brand || null, last4: card.card?.last4 || null };
  } catch (err) {
    logger.warn({ err, appointmentId }, 'getCardOnFile failed');
    return { hasCard: false, reason: 'lookup_failed' };
  }
}
