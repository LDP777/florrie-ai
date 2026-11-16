import { createHash } from 'node:crypto';
import { googleReviewLink } from '../lib/google-review-link.mjs';
import { supabase } from '../config.js';
import { sendOnChannel } from './messaging.js';
import { evaluateOutbound, recordOutbound } from '../lib/outbound-guard.js';
import logger from '../lib/logger.js';
import { splitBillable } from '../lib/billable.js';

const HOUR = 3600000;
const VERSION = 'owner-completed-v2';
const COLUMNS = '*, clients(id, beautician_id, first_name, phone, email, whatsapp_id, instagram_id, preferred_channel, marketing_consent, marketing_opted_out_at, messaging_autonomy), treatments(name), beauticians(*)';
const retryable = new Set(['quiet_hours', 'frequency_unavailable', 'autonomy_unavailable', 'error_failsafe']);
const iso = ms => new Date(ms).toISOString();

function requestId(owner, appointment) {
  const h = createHash('sha256').update(`review-request:${owner}:${appointment}`).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
function wallNow(timezone, now) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone || 'Europe/London', year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23' }).formatToParts(new Date(now));
  const p = Object.fromEntries(parts.map(x => [x.type,x.value]));
  return Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
}
function eligible(appt, owner, client, now = Date.now()) {
  if (!appt || appt.beautician_id !== owner || appt.client_id !== client || appt.status !== 'completed'
    || appt.clients?.id !== client || appt.clients?.beautician_id !== owner) return false;
  const end = Date.parse(appt.ends_at || appt.starts_at);
  const age = wallNow(appt.beauticians?.timezone, now) - end;
  return Number.isFinite(age) && age >= 0 && age <= 72 * HOUR;
}
async function appointment(owner, id) {
  const result = await supabase.from('appointments').select(COLUMNS).eq('beautician_id', owner).eq('id', id).maybeSingle();
  if (result.error) throw result.error;
  return result.data;
}

// Called only by owner completion routes. No scan of historic or assumed visits.
export async function scheduleReviewRequest(owner, appointmentId, clientId) {
  if (!clientId) return { scheduled:false };
  const appt = await appointment(owner, appointmentId);
  if (!eligible(appt, owner, clientId) || wallNow(appt.beauticians?.timezone, Date.now()) - Date.parse(appt.ends_at || appt.starts_at) > 48 * HOUR) return { scheduled:false };
  const recent = await supabase.from('ai_actions').select('id').eq('beautician_id', owner)
    .eq('action_type', 'review_requested').eq('client_id', clientId)
    .gte('created_at', iso(Date.now() - 7 * 24 * HOUR)).limit(1);
  if (recent.error) throw recent.error;
  if (recent.data?.length) return { scheduled:false };
  const now = Date.now();
  const { error } = await supabase.from('ai_actions').insert({
    id:requestId(owner, appointmentId), beautician_id:owner, appointment_id:appointmentId,
    client_id:clientId, action_type:'review_requested', digital_employee:'marketing',
    summary:'Review request scheduled after owner-confirmed visit', confidence:1, autonomous:true,
    status:'scheduled', outcome:'pending',
    details:{ version:VERSION, appointment_id:appointmentId, send_at:iso(now + 2 * HOUR), expires_at:iso(now + 48 * HOUR), delivery_state:'scheduled' },
  });
  if (error && error.code !== '23505') throw error;
  return { scheduled:!error };
}

async function finish(action, state, reason, extra = {}) {
  const { error } = await supabase.from('ai_actions').update({
    status:'executed', outcome:state === 'sent' ? 'success' : state === 'approval' ? 'pending' : 'failed',
    summary:`Review request: ${state}`, details:{ ...action.details, delivery_state:state, reason, ...extra },
  }).eq('id',action.id).eq('beautician_id',action.beautician_id);
  if (error) throw error;
}
async function defer(action, reason) {
  const { error } = await supabase.from('ai_actions').update({ status:'scheduled', details:{...action.details,
    delivery_state:'scheduled', reason, send_at:iso(Date.now() + (reason === 'quiet_hours' ? HOUR : 15 * 60000)) },
  }).eq('id',action.id).eq('beautician_id',action.beautician_id);
  if (error) throw error;
}
export function reviewChannel(client) {
  const reachable = { sms:!!client.phone, email:!!client.email, whatsapp:!!(client.whatsapp_id || client.phone), instagram:!!client.instagram_id };
  if (client.preferred_channel) return reachable[client.preferred_channel] ? client.preferred_channel : null;
  return ['sms','email','whatsapp','instagram'].find(c => reachable[c]) || null;
}

export async function processReviewRequests() {
  const due = await supabase.from('ai_actions').select('*').eq('action_type','review_requested')
    .eq('status','scheduled').eq('details->>version',VERSION).lte('details->>send_at',iso(Date.now()))
    .order('created_at',{ascending:true}).limit(20);
  if (due.error) throw due.error;
  let sent = 0;
  for (const action of due.data || []) {
    // Permanent claim: a crash during provider delivery must not cause a resend.
    const claim = await supabase.from('ai_actions').update({status:'processing', details:{...action.details,delivery_state:'processing',claimed_at:iso(Date.now())}})
      .eq('id',action.id).eq('beautician_id',action.beautician_id).eq('status','scheduled').select('id').maybeSingle();
    if (claim.error || !claim.data) continue;
    let attempted = false;
    try {
      if (!Number.isFinite(Date.parse(action.details?.expires_at)) || Date.parse(action.details.expires_at) <= Date.now()) {
        await finish(action,'held','expired'); continue;
      }
      const appt = await appointment(action.beautician_id,action.details?.appointment_id);
      if (!eligible(appt,action.beautician_id,action.client_id)) { await finish(action,'held','visit_not_eligible'); continue; }
      if (!splitBillable([appt.beauticians]).billable.length) { await finish(action,'held','plan_inactive'); continue; }
      if (appt.beauticians?.client_reminder_prefs?.paused === true) { await finish(action,'held','salon_paused'); continue; }
      const client = appt.clients;
      const channel = reviewChannel(client);
      if (!channel) { await finish(action,'held','no_contact'); continue; }
      const verdict = await evaluateOutbound({beauticianId:action.beautician_id,clientId:client.id,
        messageType:'review_request',channel,client,confirmedReviewVisit:true});
      if (verdict.decision === 'block') {
        if (retryable.has(verdict.reason)) await defer(action,verdict.reason);
        else await finish(action,'held',verdict.reason);
        continue;
      }
      const url = googleReviewLink(appt.beauticians);
      const body = `Hi ${client.first_name || 'there'}, thanks for visiting ${appt.beauticians?.business_name || 'us'} for ${appt.treatments?.name || 'your treatment'}. ${url ? `If you have a moment, please share your experience on Google: ${url}` : 'If you have a moment, reply with any feedback about your visit.'}`;
      if (verdict.decision === 'approve') {
        attempted = true; // Creating an approval is also a durable side effect.
        const outboundId = await recordOutbound({beauticianId:action.beautician_id,clientId:client.id,messageType:'review_request',channel,
          tier:'proactive',status:'pending_approval',reason:verdict.reason,body});
        await finish(action,outboundId ? 'approval' : 'held',outboundId ? verdict.reason : 'approval_save_failed',{outbound_id:outboundId,channel});
        continue;
      }
      if (['instagram','whatsapp'].includes(channel)) {
        const latest = await supabase.from('messages').select('created_at').eq('beautician_id',action.beautician_id)
          .eq('client_id',client.id).eq('channel',channel).eq('direction','inbound').order('created_at',{ascending:false}).limit(1).maybeSingle();
        if (latest.error) { await defer(action,'error_failsafe'); continue; }
        if (!latest.data || Date.now() - Date.parse(latest.data.created_at) >= 24 * HOUR) {
          await finish(action,'held','channel_window_closed',{channel}); continue;
        }
      }
      attempted = true;
      const result = await sendOnChannel({beautician:{...appt.beauticians,id:action.beautician_id},clientId:client.id,channel,body});
      const outboundId = await recordOutbound({beauticianId:action.beautician_id,clientId:client.id,messageType:'review_request',channel,
        tier:'proactive',status:result.ok ? 'sent':'blocked',reason:result.ok ? verdict.reason:'send_failed',body});
      await finish(action,result.ok ? 'sent':'unconfirmed',result.ok ? 'provider_accepted':'send_not_confirmed',{outbound_id:outboundId,channel});
      if (result.ok) sent++;
    } catch (err) {
      logger.error({err,actionId:action.id},'Review request processing failed');
      // Only pre-send reads can be retried. A failed status write leaves the claim visible.
      try { if (attempted) await finish(action,'unconfirmed','send_not_confirmed'); else await defer(action,'error_failsafe'); }
      catch (saveError) { logger.error({err:saveError,actionId:action.id},'Review request needs manual inspection'); }
    }
  }
  return {sent,total:due.data?.length || 0};
}

// An approval must recheck the visit and record its own provider result. Outbox's
// optimistic claim is not evidence that a provider accepted the message.
export async function beginReviewApproval(owner, outboundId) {
  const row = await supabase.from('ai_actions').select('*').eq('beautician_id',owner).eq('action_type','review_requested')
    .eq('details->>outbound_id',outboundId).limit(1).maybeSingle();
  if (row.error) throw row.error;
  if (!row.data || row.data.details?.version !== VERSION) return null;
  const appt = await appointment(owner,row.data.details.appointment_id);
  if (!(Date.parse(row.data.details.expires_at) > Date.now() && eligible(appt,owner,row.data.client_id))
    || !appt.clients.marketing_consent || appt.clients.marketing_opted_out_at || appt.beauticians?.client_reminder_prefs?.paused
    || appt.beauticians?.autonomy?.review_request === 'off') {
    await finish(row.data,'held','visit_or_permission_changed');
    throw new Error('This review request is no longer eligible. Skip this draft and check the visit and contact permissions.');
  }
  const claim = await supabase.from('ai_actions').update({status:'processing',details:{...row.data.details,delivery_state:'processing',claimed_at:iso(Date.now())}})
    .eq('beautician_id',owner).eq('id',row.data.id).eq('details->>delivery_state','approval').select('id').maybeSingle();
  if (claim.error) throw claim.error;
  if (!claim.data) throw new Error('This request was already handled or its send result needs checking. Open the conversation before sending again.');
  return row.data;
}
export async function finishReviewApproval(action, accepted) {
  if (action) await finish(action,accepted ? 'sent':'unconfirmed',accepted ? 'provider_accepted':'send_not_confirmed');
}

export async function listReviewRequests(owner) {
  const rows = await supabase.from('ai_actions').select('id,client_id,created_at,status,outcome,details,clients(beautician_id,first_name,last_name,marketing_consent,marketing_opted_out_at)')
    .eq('beautician_id',owner).eq('action_type','review_requested').order('created_at',{ascending:false}).limit(25);
  if (rows.error) throw rows.error;
  const ids = (rows.data || []).map(r=>r.details?.outbound_id).filter(Boolean);
  const outbound = ids.length ? await supabase.from('outbound_sends').select('id,status,reason').eq('beautician_id',owner).in('id',ids) : {data:[]};
  if (outbound.error) throw outbound.error;
  return {requests:(rows.data || []).map(row=>{
    const details = row.details || {};
    const linked = outbound.data?.find(r=>r.id === details.outbound_id);
    let state = details.version === VERSION ? details.delivery_state : row.outcome === 'success' ? 'sent' : 'legacy';
    if (state === 'processing' && Date.now() - Date.parse(details.claimed_at) > 10 * 60000) state = 'unconfirmed';
    if (state === 'approval') state = !linked ? 'unconfirmed' : linked.status === 'sent' ? 'unconfirmed' : linked.status === 'pending_approval' ? 'approval' : 'held';
    if (state === 'approval' && Date.parse(details.expires_at) <= Date.now()) state = 'held';
    return {id:row.id,client_id:row.client_id,client_name:row.clients?.beautician_id === owner ? [row.clients.first_name,row.clients.last_name].filter(Boolean).join(' ') || 'Client' : 'Client',
      created_at:row.created_at,send_at:details.send_at,state,reason:linked?.reason || details.reason || null,channel:details.channel || null};
  })};
}
