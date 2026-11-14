import { createHash, randomUUID } from 'node:crypto';
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { isCancelledBooking } from '../lib/booking-management-access.js';
import { chargePolicyFee } from './policy-fees.js';

const ACTION = 'client_cancellation_fee';
const HOUR = 3600000;
const REVIEW_REASON = {
  no_card_on_file: 'No saved card is available.',
  stripe_not_onboarded: 'Stripe payouts need attention.',
  card_declined: 'The saved card was declined.',
  authentication_required: 'The client needs to authorise the payment.',
  requires_action: 'The client needs to authorise the payment.',
  requires_payment_method: 'The client needs to provide another payment method.',
  fee_changed: 'The booking or amount already paid has changed.',
  stale_intent: 'The payment was not started promptly.',
  idempotency_expired: 'The payment outcome is unknown. Check Stripe before collecting anything.',
};
export function cancellationFeeId(appointmentId) {
  const h=createHash('sha256').update(`client-cancellation-fee:${appointmentId}`).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
export async function queueClientCancellationFee(appt, feeCents) {
  if (feeCents < 30) return;
  const {error}=await supabase.from('ai_actions').insert({
    id:cancellationFeeId(appt.id),appointment_id:appt.id,beautician_id:appt.beautician_id,client_id:appt.client_id || null,
    action_type:ACTION,digital_employee:'money',outcome:'pending',autonomous:true,notification_sent:false,
    summary:`Late-cancellation payment of £${(feeCents/100).toFixed(2)} queued`,
    details:{version:1,fee_cents:feeCents,queued_at:new Date().toISOString(),attempt_id:randomUUID()},
  });
  if(error && error.code!=='23505')throw new Error('Could not record the cancellation payment');
}

export async function settleClientCancellationFee(appointmentId) {
  try {
    const id=cancellationFeeId(appointmentId);
    const [{data:row,error},{data:appt,error:apptError}]=await Promise.all([
      supabase.from('ai_actions').select('*').eq('id',id).maybeSingle(),
      supabase.from('appointments').select('id,status').eq('id',appointmentId).maybeSingle(),
    ]);
    if(error || apptError)throw new Error('Could not read cancellation payment');
    if(!row || row.details?.version!==1 || !isCancelledBooking(appt))return {charged:false,reason:'not_queued'};
    if(row.outcome==='success' || row.outcome==='escalated')return row.details?.result || {charged:false,reason:'already_handled'};
    if(Date.parse(row.details?.lease_until)>Date.now())return {charged:false,reason:'in_progress'};
    const attemptId=randomUUID();
    let details={...row.details,attempt_id:attemptId,lease_until:new Date(Date.now()+2*60000).toISOString(),last_attempt_at:new Date().toISOString()};
    const claim=await supabase.from('ai_actions').update({details}).eq('id',id).eq('details->>attempt_id',row.details.attempt_id).select('id');
    if(claim.error || !claim.data?.length)return {charged:false,reason:'in_progress'};
    const persist=async request=>{
      // firstAttemptAt is immutable once any request could have reached Stripe.
      details={...details,request:{...request,firstAttemptAt:details.request?.firstAttemptAt || request.firstAttemptAt}};
      const saved=await supabase.from('ai_actions').update({details}).eq('id',id).eq('details->>attempt_id',attemptId).select('id');
      if(saved.error || !saved.data?.length)throw new Error('Payment request could not be recorded');
    };
    // A stale, never-attempted intent must not surprise the client with a
    // charge days later. Known requests use the Stripe reconciliation path.
    const stale=!details.request && (!Number.isFinite(Date.parse(details.queued_at)) || Date.now()-Date.parse(details.queued_at)>HOUR);
    const result=stale ? {charged:false,reason:'stale_intent'} : await chargePolicyFee(appointmentId,'late_cancel',{
      recovery:{expectedFeeCents:details.fee_cents,request:details.request || null,persist},
    });
    const complete=(result.charged && result.recorded!==false) || ['already_charged','no_fee_configured'].includes(result.reason);
    const retry=!complete && (result.pending || (result.charged && result.recorded===false) || ['stripe_error','error','stripe_not_configured'].includes(result.reason));
    const review=!complete && !retry;
    const saved=await supabase.from('ai_actions').update({
      outcome:complete?'success':review?'escalated':'pending',
      summary:complete && result.charged ? `Late-cancellation payment of £${(details.fee_cents/100).toFixed(2)} collected`
        : review ? `Please review the £${(details.fee_cents/100).toFixed(2)} late-cancellation payment. ${REVIEW_REASON[result.reason] || 'The payment could not be confirmed.'}`
        : 'Late-cancellation payment is awaiting confirmation',
      details:{...details,result,lease_until:null,needs_review:review},
    }).eq('id',id).eq('details->>attempt_id',attemptId);
    if(saved.error)throw new Error('Could not record cancellation payment outcome');
    return {...result,needsReview:review};
  } catch(err) {
    logger.error({err,appointmentId},'Cancellation payment will be checked again');
    return {charged:false,reason:'retry_pending'};
  }
}

export async function retryClientCancellationFees() {
  const {data,error}=await supabase.from('ai_actions').select('appointment_id')
    .eq('action_type',ACTION).eq('details->>version','1').eq('outcome','pending')
    .gte('created_at',new Date(Date.now()-7*24*HOUR).toISOString())
    .order('details->>last_attempt_at',{ascending:true,nullsFirst:true}).limit(100);
  if(error)throw new Error('Could not read cancellation payments');
  for(const row of data || [])await settleClientCancellationFee(row.appointment_id);
  return {attempted:data?.length || 0};
}
