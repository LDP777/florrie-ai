import Stripe from 'stripe';
import { supabase } from '../config.js';
import { totalApplicationFee } from '../lib/platform-fees.js';
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
export function computePolicyFee(appointment, policy, kind) {
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

  // Deposit already paid counts towards the fee; never go negative.
  if (appointment.deposit_paid) {
    feeCents = Math.max(0, feeCents - (appointment.deposit_cents || 0));
  }
  return { feeCents, percent };
}

export async function chargePolicyFee(appointmentId, kind) {
  if (!KIND_LABELS[kind]) {
    logger.warn({ appointmentId, kind }, 'chargePolicyFee: unknown kind');
    return { charged: false, reason: 'unknown_kind' };
  }

  try {
    const { data: appt } = await supabase
      .from('appointments')
      .select(`
        id, beautician_id, client_id, status, price_cents, deposit_cents,
        deposit_paid, policy_snapshot, stripe_payment_method_id,
        policy_fee_charged_at,
        clients(id, first_name, last_name, stripe_customer_id),
        beauticians(id, business_name, first_name, booking_policy,
          stripe_account_id, stripe_onboarding_complete)
      `)
      .eq('id', appointmentId)
      .maybeSingle();

    if (!appt) return { charged: false, reason: 'not_found' };

    // HARD RULE: never charge twice.
    if (appt.policy_fee_charged_at) {
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
    const { feeCents, percent } = computePolicyFee(appt, policy, kind);

    // Consent rule: no configured fee (or nothing left after the deposit) = no charge.
    // Stripe's GBP minimum is 30p; below that there is nothing chargeable.
    if (!feeCents || feeCents < 30) {
      return { charged: false, reason: 'no_fee_configured' };
    }

    if (!stripe) return { charged: false, reason: 'stripe_not_configured' };

    const b = appt.beauticians;
    if (!b?.stripe_account_id || !b?.stripe_onboarding_complete) {
      await logAction({
        appt, kind,
        actionType: 'policy_fee_uncollectable',
        outcome: 'failure',
        summary: `Could not charge ${clientName} the ${poundsLabel(feeCents)} ${label}, Stripe payouts are not set up yet`,
        details: { fee_cents: feeCents, percent, reason: 'stripe_not_onboarded' },
      });
      return { charged: false, reason: 'stripe_not_onboarded' };
    }

    const customerId = appt.clients?.stripe_customer_id;
    let paymentMethodId = appt.stripe_payment_method_id || null;

    if (customerId && !paymentMethodId) {
      // Fall back to the customer's most recent saved card (same as charge-no-show).
      const methods = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
      paymentMethodId = methods.data?.[0]?.id || null;
    }

    if (!customerId || !paymentMethodId) {
      await logAction({
        appt, kind,
        actionType: 'policy_fee_uncollectable',
        outcome: 'failure',
        summary: `No card on file, could not charge the ${label} for ${clientName}`,
        details: { fee_cents: feeCents, percent, reason: 'no_card_on_file' },
      });
      return { charged: false, reason: 'no_card_on_file' };
    }

    // Destination charge: the platform pays Stripe's processing fee, so the
    // application fee must recover it on top of Florrie's cut or this payment
    // loses the platform money (the arrears leak).
    const platformFee = totalApplicationFee(feeCents);

    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create({
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
      }, {
        idempotencyKey: `policyfee_${appointmentId}_${kind}`,
      });
    } catch (err) {
      // Card declined / 3DS required: log it for the beautician, never throw.
      const declined = err?.code === 'authentication_required' || err?.type === 'StripeCardError';
      await logAction({
        appt, kind,
        actionType: 'policy_fee_uncollectable',
        outcome: 'failure',
        summary: declined
          ? `${clientName}'s card would not accept the ${poundsLabel(feeCents)} ${label} (${err.code || 'card declined'}). You could send a payment link instead`
          : `Charging ${clientName} the ${poundsLabel(feeCents)} ${label} failed, I will not retry automatically`,
        details: { fee_cents: feeCents, percent, stripe_code: err?.code || null, stripe_error: String(err?.message || '').slice(0, 200) },
      });
      if (!declined) logger.error({ err, appointmentId, kind }, 'policy fee charge failed');
      return { charged: false, reason: declined ? (err.code || 'card_declined') : 'stripe_error' };
    }

    const succeeded = paymentIntent.status === 'succeeded' || paymentIntent.status === 'processing';
    if (!succeeded) {
      await logAction({
        appt, kind,
        actionType: 'policy_fee_uncollectable',
        outcome: 'failure',
        summary: `The ${poundsLabel(feeCents)} ${label} for ${clientName} did not go through (status ${paymentIntent.status})`,
        details: { fee_cents: feeCents, percent, payment_intent_id: paymentIntent.id, status: paymentIntent.status },
      });
      return { charged: false, reason: paymentIntent.status };
    }

    // Mark charged (idempotency anchor) + audit fields.
    await supabase.from('appointments').update({
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

    // Money feed.
    await supabase.from('transactions').insert({
      beautician_id: appt.beautician_id,
      appointment_id: appt.id,
      client_id: appt.client_id || null,
      amount_cents: feeCents,
      type: kind === 'no_show' ? 'no_show_fee' : 'late_cancel_fee',
      status: 'completed',
      stripe_payment_intent_id: paymentIntent.id,
      payment_method: 'card_online',
    });

    await logAction({
      appt, kind,
      actionType: 'policy_fee_charged',
      outcome: 'success',
      summary: `Charged ${clientName} a ${poundsLabel(feeCents)} ${label}`,
      details: { fee_cents: feeCents, percent, payment_intent_id: paymentIntent.id, platform_fee_cents: platformFee },
    });

    logger.info({ appointmentId, kind, feeCents, paymentIntentId: paymentIntent.id }, 'Policy fee charged');
    return { charged: true, feeCents, paymentIntentId: paymentIntent.id };
  } catch (err) {
    logger.error({ err, appointmentId, kind }, 'chargePolicyFee unexpected failure');
    return { charged: false, reason: 'error' };
  }
}

/**
 * Charge a fresh deposit to the saved card when a client reschedules inside the
 * notice window and the beautician's policy requires a new deposit for the new
 * slot (booking_policy.require_deposit_on_late_reschedule). Off-session, mirrors
 * the policy-fee money flow exactly (platform PaymentIntent with transfer_data +
 * application_fee).
 *
 * Returns:
 *   { charged:true, depositCents }                 - taken
 *   { charged:false, reason:'no_deposit' }         - this booking has no deposit, nothing to take (caller proceeds)
 *   { charged:false, reason:<other> }              - could NOT take it; caller should BLOCK the reschedule
 *
 * Never throws.
 */
export async function chargeRescheduleDeposit(appointmentId, newStartIso) {
  try {
    const { data: appt } = await supabase
      .from('appointments')
      .select(`
        id, beautician_id, client_id, price_cents, deposit_cents,
        stripe_payment_method_id,
        clients(id, first_name, last_name, stripe_customer_id),
        beauticians(id, business_name, first_name, stripe_account_id, stripe_onboarding_complete)
      `)
      .eq('id', appointmentId)
      .maybeSingle();

    if (!appt) return { charged: false, reason: 'not_found' };

    const depositCents = appt.deposit_cents || 0;
    // Stripe's GBP minimum is 30p; nothing meaningful to take below that.
    if (depositCents < 30) return { charged: false, reason: 'no_deposit' };

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
    if (!customerId || !paymentMethodId) {
      return { charged: false, reason: 'no_card_on_file' };
    }

    // Same as every destination charge: recover Stripe's processing fee too.
    const platformFee = totalApplicationFee(depositCents);
    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create({
        amount: depositCents,
        currency: 'gbp',
        customer: customerId,
        payment_method: paymentMethodId,
        confirm: true,
        off_session: true,
        application_fee_amount: platformFee,
        transfer_data: { destination: b.stripe_account_id },
        description: `Reschedule deposit, ${clientName}`,
        metadata: {
          appointment_id: appt.id,
          beautician_id: appt.beautician_id,
          client_id: appt.client_id || '',
          type: 'reschedule_deposit',
          platform_fee_cents: platformFee,
        },
      }, {
        idempotencyKey: `resched_deposit_${appointmentId}_${String(newStartIso).slice(0, 16)}`,
      });
    } catch (err) {
      const declined = err?.code === 'authentication_required' || err?.type === 'StripeCardError';
      if (!declined) logger.error({ err, appointmentId }, 'reschedule deposit charge failed');
      return { charged: false, reason: declined ? (err.code || 'card_declined') : 'stripe_error' };
    }

    const ok = paymentIntent.status === 'succeeded' || paymentIntent.status === 'processing';
    if (!ok) return { charged: false, reason: paymentIntent.status };

    // Record the new deposit + mark the new slot's deposit paid.
    await supabase.from('appointments').update({
      deposit_paid: true,
      deposit_status: 'paid',
      stripe_payment_method_id: paymentMethodId,
    }).eq('id', appointmentId);

    await supabase.from('transactions').insert({
      beautician_id: appt.beautician_id,
      appointment_id: appt.id,
      client_id: appt.client_id || null,
      amount_cents: depositCents,
      type: 'deposit',
      status: 'completed',
      stripe_payment_intent_id: paymentIntent.id,
      payment_method: 'card_online',
    });

    logger.info({ appointmentId, depositCents, paymentIntentId: paymentIntent.id }, 'Reschedule deposit charged');
    return { charged: true, depositCents, paymentIntentId: paymentIntent.id };
  } catch (err) {
    logger.error({ err, appointmentId }, 'chargeRescheduleDeposit unexpected failure');
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
    const { data: prior, error: priorError } = await supabase
      .from('transactions')
      .select('id')
      .eq('appointment_id', appt.id)
      .in('type', ['payment', 'full_payment', 'payment_link'])
      .limit(1);
    // If the guard itself cannot be read, refuse to charge. Charging blind is
    // exactly the double-charge this guard exists to prevent.
    if (priorError) return { charged: false, reason: 'guard_unreadable' };
    if (prior && prior.length) return { charged: false, reason: 'already_charged' };

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
    const { error: txErr } = await supabase.from('transactions').insert({
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
      logger.error({ err: txErr, appointmentId, paymentIntentId: paymentIntent.id, amountCents },
        'CHARGED BUT NOT RECORDED: balance taken from the card but the transaction insert failed');
    }

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

    const { error: txErr } = await supabase.from('transactions').insert({
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
      logger.error({ err: txErr, appointmentId, paymentIntentId: paymentIntent.id, amount },
        'CHARGED BUT NOT RECORDED: card charged but the transaction insert failed');
    }

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
