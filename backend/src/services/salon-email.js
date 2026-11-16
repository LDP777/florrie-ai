import { randomUUID } from 'node:crypto';
import { supabase } from '../config.js';
import { salonEmailConfig, mailboxLocalPart, normaliseSalonEmail, resendRequest, salonFrom } from '../lib/salon-email.js';
import { mailboxAddress } from '../lib/email-provider.js';
import logger from '../lib/logger.js';

const checked = r => { if(r.error) throw new Error('Salon email storage unavailable'); return r.data; };
export function createSalonEmail({ db=supabase, fetchImpl=fetch, env=process.env }={}) {
  async function mailbox(beautician, provision=false) {
    const config=salonEmailConfig(beautician.id,env);
    if (!config) return null;
    let box=checked(await db.from('salon_mailboxes').select('*').eq('beautician_id',beautician.id).maybeSingle());
    if (!box && provision) {
      const local=mailboxLocalPart(beautician);
      for(let i=0;i<3&&!box;i++) {
        const address=`${local}${i ? '-'+randomUUID().slice(0,8) : ''}@${config.domain}`;
        const insert=await db.from('salon_mailboxes').insert({beautician_id:beautician.id,address}).select('*').maybeSingle();
        if(insert.error && insert.error.code!=='23505') throw new Error('Mailbox could not be created');
        box=insert.data || checked(await db.from('salon_mailboxes').select('*').eq('beautician_id',beautician.id).maybeSingle());
      }
    }
    if (box && !box.address.endsWith('@'+config.domain)) throw new Error('Mailbox domain changed');
    return box;
  }
  async function status(beautician) {
    if(!salonEmailConfig(beautician.id,env)) return {available:false};
    const box=await mailbox(beautician,true);
    if(!box) throw new Error('Mailbox not ready');
    const waiting=await db.from('salon_email_events').select('email_id',{count:'exact',head:true}).contains('recipients',[box.address]).in('status',['pending','processing','review']);
    if(waiting.error) throw new Error('Inbox check unavailable');
    return {available:true,address:box.address,status:box.status,last_received_at:box.last_received_at,pending:waiting.count||0};
  }
  async function identity(beautician) {
    const box=await mailbox(beautician,true);
    return box?.status==='active' ? {from:salonFrom(beautician.business_name||beautician.first_name,box.address),replyTo:box.address} : null;
  }
  async function enqueue(event, webhookId) {
    const config=salonEmailConfig(null,env);
    if(!config) throw new Error('Salon email disabled');
    if(event.type!=='email.received') return;
    const id=event.data?.email_id;
    if(!/^[0-9a-f-]{36}$/i.test(id || '')) throw new Error('Invalid email event');
    const recipients=[...new Set((Array.isArray(event.data.to)?event.data.to:[]).map(mailboxAddress).filter(a=>a?.endsWith('@'+config.domain)))];
    if(!recipients.length || recipients.length>20) return;
    // Never overwrite a completed event when the provider retries a webhook.
    checked(await db.from('salon_email_events').upsert({email_id:id,webhook_id:webhookId,recipients},{onConflict:'email_id',ignoreDuplicates:true}));
  }
  async function process() {
    const config=salonEmailConfig(null,env); if(!config) return;
    // A process can stop after the provider accepted a reply but before saving its
    // receipt. Surface that uncertainty; never send again merely because it is old.
    const stale=checked(await db.from('salon_email_replies').select('outbound_id').eq('status','sending').lt('created_at',new Date(Date.now()-5*60000).toISOString()).limit(20));
    for(const row of stale||[]) checked(await db.rpc('finish_salon_email_reply',{p_outbound:row.outbound_id,p_status:'unknown',p_provider_id:null}));
    const lease=randomUUID();
    const events=checked(await db.rpc('claim_salon_email_events',{p_lease:lease}));
    for(const event of events||[]) {
      const finish=values=>db.from('salon_email_events').update({...values,lease_token:null,lease_until:null}).eq('email_id',event.email_id).eq('lease_token',lease);
      try {
        const boxes=checked(await db.from('salon_mailboxes').select('*').in('address',event.recipients).eq('status','active'));
        const eligible=(boxes||[]).filter(b=>b.beautician_id && salonEmailConfig(b.beautician_id,env));
        if(eligible.length!==1) { checked(await finish({status:eligible.length ? 'review':'ignored',error_code:eligible.length ? 'multiple_recipients':'no_active_recipient'})); continue; }
        const box=eligible[0];
        const data=await resendRequest(`/emails/receiving/${encodeURIComponent(event.email_id)}?html_format=cid`,{key:config.key},fetchImpl);
        if(data.id!==event.email_id || !(data.to||[]).map(mailboxAddress).includes(box.address)) throw new Error('Email recipient mismatch');
        const mail=normaliseSalonEmail(data,box.address);
        if(!mail) { checked(await finish({status:'ignored',error_code:'automatic_or_invalid'})); continue; }
        checked(await db.rpc('import_salon_email',{p_mailbox:box.id,p_email:event.email_id,p_lease:lease,p_mail:mail}));
      } catch {
        checked(await finish({status:event.attempts>=12?'review':'pending',error_code:'receive_incomplete',next_attempt_at:new Date(Date.now()+Math.min(3600000,30000*2**Math.min(event.attempts,7))).toISOString()}));
        logger.warn({emailId:event.email_id},'Salon email queued for recovery');
      }
    }
  }
  async function reply({beautician,clientId,messageId,body,author}) {
    const config=salonEmailConfig(beautician.id,env),box=await mailbox(beautician);
    if(!config || box?.status!=='active') throw new Error('Your Florrie email is unavailable. Try again shortly.');
    const m=checked(await db.from('messages').select('id').eq('id',messageId).eq('beautician_id',beautician.id).eq('client_id',clientId).eq('direction','inbound').eq('channel','email').maybeSingle());
    if(!m) throw new Error('Choose the email you want to reply to.');
    const link=checked(await db.from('salon_email_links').select('*').eq('message_id',m.id).eq('mailbox_id',box.id).maybeSingle());
    if(!link?.reply_allowed || link.sender_email!==link.reply_email) throw new Error('This email needs sender verification. Contact the client through a known channel.');
    const outbound=checked(await db.rpc('prepare_salon_email_reply',{p_owner:beautician.id,p_inbound:m.id,p_body:body,p_author:author}));
    if(!outbound) throw new Error('A reply has already been sent or is awaiting confirmation. Check the conversation before trying again.');
    const attempt=checked(await db.from('salon_email_replies').select('attempt').eq('outbound_id',outbound).single());
    let receipt;
    try {
      receipt=await resendRequest('/emails',{method:'POST',key:config.key,idempotencyKey:`salon-reply/${outbound}/${attempt.attempt}`,body:{
        from:salonFrom(beautician.business_name||beautician.first_name,box.address),to:[link.sender_email],reply_to:box.address,
        subject:/^re:/i.test(link.subject)?link.subject:`Re: ${link.subject}`,text:body,
        headers:{'In-Reply-To':link.internet_message_id,References:link.internet_message_id},
      }},fetchImpl);
      if(!receipt.id) throw new Error('Missing receipt');
    } catch(e) {
      const definitive=[400,401,403,404,422,429].includes(e.status);
      checked(await db.rpc('finish_salon_email_reply',{p_outbound:outbound,p_status:definitive?'failed':'unknown',p_provider_id:null}));
      throw new Error(definitive?'Your reply was not accepted. Try again shortly.':'We could not confirm whether your reply was sent. It has been saved for checking; please do not send it again.');
    }
    const saved=checked(await db.rpc('finish_salon_email_reply',{p_outbound:outbound,p_status:'accepted',p_provider_id:receipt.id}));
    if(!saved) throw new Error('Your reply is awaiting confirmation. Please do not send it again.');
    return checked(await db.from('messages').select('*').eq('id',outbound).eq('beautician_id',beautician.id).single());
  }
  return {status,identity,mailbox,enqueue,process,reply};
}
export const salonEmail=createSalonEmail();
export const processSalonEmails=()=>salonEmail.process();
