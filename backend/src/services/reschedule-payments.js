import Stripe from 'stripe';
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { totalApplicationFee } from '../lib/platform-fees.js';

const ACTIVE = ['pending', 'refund_pending'];
export function createReschedulePayments({ db, stripe, log = logger }) {
  async function readOperation(id) {
    const result = await db.from('reschedule_payment_operations').select('*').eq('id', id).single();
    if (result.error || !result.data) throw new Error('Reschedule payment state unavailable');
    return result.data;
  }
  async function write(id, values, expected = ACTIVE) {
    const result = await db.from('reschedule_payment_operations')
      .update({ ...values, updated_at: new Date().toISOString() }).eq('id', id).in('status', expected).select('id');
    if (result.error || !result.data?.length) throw new Error('Reschedule payment state changed');
  }
  async function rpc(name, id) {
    const result = await db.rpc(name, { p_operation: id });
    if (result.error) throw new Error(`${name} failed`);
    return result.data;
  }
  // Only recovery refunds. It never retries a charge or moves an appointment.
  // The row exists BEFORE confirmation and stores the PI BEFORE any charge.
  async function recover(id) {
    let op = await readOperation(id);
    if (op.status === 'complete') return { state: 'moved' };
    if (!ACTIVE.includes(op.status)) return { state: op.status };
    if (!await rpc('claim_reschedule_refund', id)) {
      return { state: (await readOperation(id)).status === 'complete' ? 'moved' : 'pending' };
    }
    // Re-read after the claim: a request may have persisted the PI between
    // our first read and the database lock. Once claimed, pending-only writes
    // cannot attach a new PI, so this is now a stable recovery identity.
    op = await readOperation(id);
    if (!op.payment_intent_id) {
      await write(id, { status: 'failed' }, ['refund_pending']);
      return { state: 'failed' };
    }
    if (!stripe) throw new Error('Stripe unavailable for reschedule recovery');
    const pi = await stripe.paymentIntents.retrieve(op.payment_intent_id, { expand: ['latest_charge'] });
    if (pi.status === 'succeeded') {
      const refunds = await stripe.refunds.list({ payment_intent: pi.id, limit: 100 });
      if (refunds.has_more) throw new Error('Reschedule refund history needs review');
      if (refunds.data.some(refund => ['pending', 'requires_action'].includes(refund.status))) return { state: 'pending' };
      const refunded = refunds.data.filter(refund => refund.status === 'succeeded')
        .reduce((total, refund) => total + refund.amount, 0);
      const failedAttempts = refunds.data.filter(refund => ['failed', 'canceled'].includes(refund.status)).length;
      if (refunded < op.amount_cents) {
        const refund = await stripe.refunds.create({
          payment_intent: pi.id, amount: op.amount_cents - refunded,
          reverse_transfer: true, refund_application_fee: true,
          metadata: { reschedule_operation_id: id },
        }, { idempotencyKey: `reschedule_compensation_${id}_${refunded}_${failedAttempts}` });
        // Pending refunds are retried from provider state, never labelled returned.
        if (refund.status !== 'succeeded') return { state: 'pending' };
      }
      await rpc('finish_reschedule_refund', id);
      return { state: 'refunded' };
    }
    if (pi.status !== 'canceled') {
      // Some asynchronous processing states cannot be cancelled yet. A failure
      // leaves refund_pending for the next recovery run, preserving the evidence.
      const canceled = await stripe.paymentIntents.cancel(pi.id, {}, { idempotencyKey: `reschedule_cancel_${id}` });
      if (canceled.status !== 'canceled') throw new Error('Reschedule payment cancellation not confirmed');
    }
    await write(id, { status: 'failed' }, ['refund_pending']);
    return { state: 'failed' };
  }
  async function perform(appointmentId, oldStart, newStart, newEnd) {
    if (!stripe) return { state: 'failed', reason: 'stripe_not_configured' };
    const read = await db.from('appointments').select(`id,beautician_id,client_id,deposit_cents,stripe_payment_method_id,
      clients(stripe_customer_id),beauticians(stripe_account_id,stripe_onboarding_complete)`)
      .eq('id', appointmentId).single();
    if (read.error || !read.data) return { state: 'pending', reason: 'unavailable' };
    const appt = read.data;
    if ((appt.deposit_cents || 0) < 30) return { state: 'no_deposit' };
    if (!appt.beauticians?.stripe_onboarding_complete || !appt.beauticians?.stripe_account_id) return { state: 'failed', reason: 'stripe_not_onboarded' };
    const customer = appt.clients?.stripe_customer_id;
    let method = appt.stripe_payment_method_id;
    if (customer && !method) method = (await stripe.paymentMethods.list({ customer, type: 'card' })).data?.[0]?.id;
    if (!customer || !method) return { state: 'failed', reason: 'no_card_on_file' };
    const prepared = await db.rpc('prepare_reschedule_payment', {
      p_appointment: appointmentId, p_old_start: oldStart, p_new_start: newStart, p_new_end: newEnd,
      p_expected_client: appt.client_id, p_expected_beautician: appt.beautician_id,
      p_expected_payment_method: appt.stripe_payment_method_id || null, p_expected_amount: appt.deposit_cents,
    }).single();
    if (prepared.error || !prepared.data) return { state: 'pending', reason: 'busy_or_changed' };
    const op = prepared.data;
    try {
      // Creation cannot charge: confirmation is a separate call made only after
      // the provider ID is durable. A crash can leave an unconfirmed PI, not an
      // untraceable debit. Recovery never recreates an old charge after key expiry.
      const pi = await stripe.paymentIntents.create({
        amount: op.amount_cents, currency: 'gbp', customer, payment_method: method,
        confirm: false, application_fee_amount: totalApplicationFee(op.amount_cents),
        transfer_data: { destination: appt.beauticians.stripe_account_id },
        metadata: { appointment_id: appointmentId, beautician_id: op.beautician_id,
          client_id: op.client_id || '', type: 'reschedule_deposit', reschedule_operation_id: op.id },
        description: 'Deposit for rescheduled appointment',
      }, { idempotencyKey: `reschedule_prepare_${op.id}` });
      await write(op.id, { payment_intent_id: pi.id, payment_method_id: method }, ['pending']);
      const confirmed = await stripe.paymentIntents.confirm(pi.id, { off_session: true }, { idempotencyKey: `reschedule_confirm_${op.id}` });
      if (confirmed.status === 'succeeded' && await rpc('finish_paid_reschedule', op.id)) return { state: 'moved' };
    } catch (err) {
      log.warn({ err, operationId: op.id }, 'Reschedule payment needs recovery');
    }
    try { return await recover(op.id); }
    catch (err) {
      log.error({ err, operationId: op.id }, 'Reschedule compensation pending; retained for retry');
      return { state: 'pending', operationId: op.id };
    }
  }
  async function retry() {
    const result = await db.from('reschedule_payment_operations').select('id')
      .in('status', ACTIVE).lt('created_at', new Date(Date.now() - 10 * 60_000).toISOString())
      .order('updated_at', { ascending: true }).limit(50);
    if (result.error) throw new Error('Could not read reschedule recovery queue');
    let failed = 0;
    for (const op of result.data || []) {
      try { const result = await recover(op.id); if (result.state === 'pending') failed++; }
      catch (err) { failed++; log.error({ err, operationId: op.id }, 'Reschedule compensation retry failed'); }
    }
    if (failed) throw new Error(`${failed} reschedule payments still need recovery`);
  }
  // Own failed-move refunds so the generic charge.refunded aggregate writer
  // cannot race this operation's transaction. Successful moves retain the
  // ordinary refund route and its existing accounting.
  async function handlesRefund(operationId) {
    if (!operationId) return false;
    const op = await readOperation(operationId);
    if (op.status === 'complete') return false;
    await recover(operationId);
    return true;
  }
  return { perform, recover, retry, handlesRefund };
}
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const service = createReschedulePayments({ db: supabase, stripe });
export const performPaidReschedule = service.perform;
export const retryReschedulePayments = service.retry;
export const handlesRescheduleRefund = service.handlesRefund;
