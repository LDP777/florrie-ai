import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../src/config.js', () => ({ supabase: {} }));
import { createEmailConnections } from '../../src/services/email-connections.js';
import { encrypt } from '../../src/lib/crypto.js';
afterEach(() => vi.unstubAllEnvs());
function fixture({ response = 'accepted', ownerAnswered = false, accountKey = 'google:owner@example.com', saveFails = false } = {}) {
  for (const [key,value] of Object.entries({ EMAIL_CONNECTIONS_KEY: 'ab'.repeat(32), EMAIL_GOOGLE_ENABLED:'true', EMAIL_GOOGLE_CLIENT_ID:'id', EMAIL_GOOGLE_CLIENT_SECRET:'secret', EMAIL_GOOGLE_REDIRECT_URI:'https://api.florrie.ai/api/email/callback/google', EMAIL_CONNECTIONS_SALONS:'' })) vi.stubEnv(key,value);
  let attempt, sends = 0;
  const c = { id:'connection', beautician_id:'owner', provider:'google', account_subject:'owner@example.com', email:'owner@example.com', generation:'g', lease_token:'lease', credentials:encrypt({owner:'owner',provider:'google',subject:'owner@example.com',access_token:'token',expires_at:Date.now()+600000},process.env.EMAIL_CONNECTIONS_KEY) };
  const link = { account_key:accountKey, sender_email:'client@example.com', reply_email:'client@example.com', provider_message_id:'incoming',thread_id:'thread',internet_message_id:'<message@example.com>',subject:'Question' };
  const db = {
    rpc:vi.fn(async (name,p) => {
      if(name==='claim_email_connection')return {data:[c]};
      if(name==='prepare_mailbox_reply') { if(attempt && attempt!=='failed') return {data:null}; attempt='sending';return {data:'outgoing'}; }
      if(name==='finish_mailbox_reply') { if(saveFails)return {error:{message:'offline'}}; attempt=p.p_status;return {data:true}; }
      throw Error('Unexpected RPC');
    }),
    from(table) {
      let query = { select(){return query;},update(){return query;},eq(){return query;},maybeSingle:async()=>({data:table==='email_message_links'?link:table==='messages'?{id:'incoming',client_id:'client',created_at:'2026-11-16T10:00:00Z'}:{id:c.id}}),single:async()=>({data:{id:'outgoing',send_status:'sent'}}) }; return query;
    }
  };
  const fetchImpl = vi.fn(async (url,opts) => {
    if(opts.method!=='POST') return Response.json({messages:ownerAnswered?[{id:'manual',internalDate:String(Date.parse('2026-11-16T11:00:00Z')),labelIds:['SENT']}]:[]});
    sends++;
    if(response==='timeout') throw Error('Connection lost after send');
    if(response==='rejected') return Response.json({error:{message:'Rejected'}},{status:400});
    return Response.json({id:'provider-sent'});
  });
  const service = createEmailConnections({db,fetchImpl});
  return {run:()=>service.reply({owner:'owner',clientId:'client',messageId:'incoming',body:'Reply approved by the salon'}),db,get sends(){return sends;},get attempt(){return attempt;}};
}
it('does not repeat a send after a transport timeout',async()=>{
 const s=fixture({response:'timeout'}); await expect(s.run()).rejects.toThrow('unconfirmed'); expect(s.attempt).toBe('unknown');
 await expect(s.run()).rejects.toThrow('already_sent'); expect(s.sends).toBe(1);
});
it('allows retry after an explicit provider rejection',async()=>{
 const s=fixture({response:'rejected'}); await expect(s.run()).rejects.toThrow('provider_rejected'); expect(s.attempt).toBe('failed');
 await expect(s.run()).rejects.toThrow('provider_rejected'); expect(s.sends).toBe(2);
});
it('does not repeat an accepted reply when its database receipt could not be saved',async()=>{
 const s=fixture({saveFails:true}); await expect(s.run()).rejects.toThrow('unconfirmed'); await expect(s.run()).rejects.toThrow('already_sent'); expect(s.sends).toBe(1);
});
it('leaves a conversation alone when its owner already replied in Gmail',async()=>{
 const s=fixture({ownerAnswered:true}); await expect(s.run()).rejects.toThrow('owner_replied'); expect(s.sends).toBe(0); expect(s.attempt).toBeUndefined();
});
it('cannot reply to a thread imported from a different mailbox',async()=>{
 const s=fixture({accountKey:'google:other@example.com'}); await expect(s.run()).rejects.toThrow('thread_unavailable'); expect(s.sends).toBe(0);
});
it('records provider acceptance before returning a successful reply',async()=>{
 const s=fixture(); await expect(s.run()).resolves.toMatchObject({id:'outgoing',send_status:'sent'});expect(s.attempt).toBe('accepted');expect(s.sends).toBe(1);
});
