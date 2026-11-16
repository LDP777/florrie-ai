import { supabase } from '../config.js';
import logger from '../lib/logger.js';

export const FEE_FIELDS = 'policy_fee_charged_at,policy_fee_amount_cents,policy_fee_payment_intent_id';
const TYPES = ['client_cancellation_fee', 'policy_fee_charged', 'policy_fee_uncollectable'];
const REASONS = {
  no_card_on_file: 'No saved card is available. Arrange payment with the client.',
  stripe_not_onboarded: 'Check the salon’s Stripe connection.',
  card_declined: 'The card was declined. Arrange another payment method.',
  authentication_required: 'The client needs to authorise the payment.',
  requires_action: 'The client needs to authorise the payment.',
  requires_payment_method: 'The client needs to provide another payment method.',
};

/** A read-only display contract. It never starts or retries a payment. */
export function cancellationPaymentStatus(appt, action = null, receipts = []) {
  const fee = Number(appt.policy_fee_amount_cents);
  const at = appt.policy_fee_charged_at;
  const reference = appt.policy_fee_payment_intent_id;
  if (at && reference && Number.isFinite(Date.parse(at)) && Number.isInteger(fee) && fee > 0) {
    const refunded = receipts.filter(r => r.type === 'refund' && r.status === 'completed'
      && r.stripe_payment_intent_id === reference).reduce((sum, r) => sum + Math.abs(Number(r.amount_cents) || 0), 0);
    if (refunded) return { status: 'needs_attention', label: 'Needs attention', amountCents: fee,
      collectedAt: at, message: 'A refund is recorded against this fee. Check the payment before collecting anything else.' };
    return { status: 'collected', label: 'Collected', amountCents: fee, collectedAt: at,
      message: 'This fee is recorded as collected. No further payment has been taken for this cancellation.' };
  }
  if (action && (action.beautician_id !== appt.beautician_id || action.appointment_id !== appt.id)) action = null;
  const result = action?.details?.result || {};
  const reason = result.reason || action?.details?.reason || action?.details?.stripe_code;
  const amount = Number(action?.details?.fee_cents);
  const amountCents = Number.isInteger(amount) && amount > 0 ? amount : null;
  if (at || reason === 'already_charged' || action?.action_type === 'policy_fee_charged') {
    return { status: 'needs_attention', label: 'Needs attention', amountCents,
      message: 'An earlier payment is recorded, but its receipt is incomplete. Check Stripe before collecting anything else.' };
  }
  if (action?.outcome === 'escalated' || action?.outcome === 'failed') return {
    status: 'needs_attention', label: 'Needs attention', amountCents,
    message: REASONS[reason] || 'The payment could not be confirmed. Check Stripe before collecting anything else.',
  };
  if (reason === 'no_fee_configured') return { status: 'not_due', label: 'No additional fee', amountCents: 0,
    message: 'No additional cancellation payment is due.' };
  if (reference || action) return { status: 'pending', label: 'Pending', amountCents,
    message: 'Payment is awaiting confirmation. Do not collect it again while this is being checked.' };
  return null;
}

export async function readCancellationPaymentStatus(appt, { db = supabase } = {}) {
  const [actions, receipts] = await Promise.all([
    db.from('ai_actions').select('beautician_id,appointment_id,action_type,outcome,details,created_at')
      .eq('beautician_id', appt.beautician_id).eq('appointment_id', appt.id)
      .in('action_type', TYPES).order('created_at', { ascending: false }).limit(5),
    db.from('transactions').select('type,status,amount_cents,stripe_payment_intent_id')
      .eq('beautician_id', appt.beautician_id).eq('appointment_id', appt.id).eq('type', 'refund'),
  ]);
  if (actions.error || receipts.error) throw new Error('Could not check the cancellation payment');
  return cancellationPaymentStatus(appt, actions.data?.[0], receipts.data || []);
}

// A payment-status outage must not make a cancelled booking disappear or
// prevent cancellation of a booking whose duplicate-charge guard is set.
export async function readCancellationPaymentReceipt(appt) {
  try { return await readCancellationPaymentStatus(appt); }
  catch (err) {
    logger.warn({ err, appointmentId: appt.id }, 'Cancellation receipt payment status unavailable');
    return { status: 'unavailable', label: 'Status unavailable', amountCents: null,
      message: 'We could not check the payment status. Please contact the salon before making another payment.' };
  }
}

export function collectedFeeText(status) {
  if (status?.status !== 'collected') return null;
  const date = new Date(status.collectedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
  return `The £${(status.amountCents / 100).toFixed(2)} fee was already collected on ${date}. No additional payment will be taken for this cancellation.`;
}
