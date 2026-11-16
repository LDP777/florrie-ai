import {expect,it,vi} from 'vitest';
vi.mock('../../src/config.js',()=>({supabase:{}}));
import {createSalonEmail} from '../../src/services/salon-email.js';
function fixture({response='accepted',saveFails=false,allowed=true}={}) {
 const box={id:'box',beautician_id:'owner',address:'demo@inbox.florrie.ai',status:'active'};
 const env={SALON_EMAIL_ENABLED:'true',SALON_EMAIL_DOMAIN_VERIFIED:'true',SALON_EMAIL_DOMAIN:'inbox.florrie.ai',SALON_EMAIL_SALONS:'owner',RESEND_API_KEY:'test',SALON_EMAIL_WEBHOOK_SECRET:'secret'};
 let state=null,sends=0,attempt=0;
 const db={
  from(table){
   const q={select(){return q;},eq(){return q;},maybeSingle:async()=>({data:table==='salon_mailboxes'?box:table==='messages'?{id:'inbound'}:{reply_allowed:allowed,sender_email:'client@example.com',reply_email:'client@example.com',internet_message_id:'<abc@example.com>',subject:'Booking'}}),single:async()=>({data:table==='salon_email_replies'?{attempt}:{id:'outbound',send_status:'sent'}})};return q;
  },
  rpc:vi.fn(async(name,p)=>{
   if(name==='prepare_salon_email_reply'){if(state&&state!=='failed')return{data:null};state='sending';attempt++;return{data:'outbound'};}
   if(name==='finish_salon_email_reply'){if(saveFails)return{error:{message:'failed save'}};state=p.p_status;return{data:true};}
   throw new Error('Unexpected RPC');
  }),
 };
 const keys=[];
 const fetchImpl=async(_url,opts)=>{
  sends++;keys.push(opts.headers['Idempotency-Key']);
  const payload=JSON.parse(opts.body);expect(payload.from).toContain('demo@inbox.florrie.ai');expect(payload.to).toEqual(['client@example.com']);expect(payload.headers['In-Reply-To']).toBe('<abc@example.com>');
  if(response==='timeout')throw new Error('timeout');
  if(response==='rejected')return Response.json({error:'rejected'},{status:422});
  return Response.json({id:'receipt'});
 };
 const service=createSalonEmail({db,fetchImpl,env});
 return {run:()=>service.reply({beautician:{id:'owner',business_name:'Demo'},clientId:'client',messageId:'inbound',body:'Approved reply',author:'human'}),get sends(){return sends;},get state(){return state;},keys};
}
it('records acceptance before showing a sent reply',async()=>{const s=fixture();await expect(s.run()).resolves.toMatchObject({send_status:'sent'});expect(s.state).toBe('accepted');await expect(s.run()).rejects.toThrow('already been sent');expect(s.sends).toBe(1);});
it('preserves an uncertain send and prevents a duplicate',async()=>{const s=fixture({response:'timeout'});await expect(s.run()).rejects.toThrow('could not confirm');expect(s.state).toBe('unknown');await expect(s.run()).rejects.toThrow('awaiting confirmation');expect(s.sends).toBe(1);});
it('does not resend after a lost database receipt',async()=>{const s=fixture({saveFails:true});await expect(s.run()).rejects.toThrow('storage unavailable');await expect(s.run()).rejects.toThrow('awaiting confirmation');expect(s.sends).toBe(1);});
it('retries an explicit rejection with a fresh attempt key',async()=>{const s=fixture({response:'rejected'});await expect(s.run()).rejects.toThrow('not accepted');await expect(s.run()).rejects.toThrow('not accepted');expect(s.keys).toEqual(['salon-reply/outbound/1','salon-reply/outbound/2']);});
it('does not send to a recipient needing verification',async()=>{const s=fixture({allowed:false});await expect(s.run()).rejects.toThrow('sender verification');expect(s.sends).toBe(0);});
