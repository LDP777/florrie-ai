import { beforeEach, it, expect, vi } from 'vitest';
const state=vi.hoisted(()=>({rows:[],current:{id:'id'},rpcError:null,readError:null,saveError:null,patches:[],send:vi.fn()}));
vi.mock('../../src/config.js',()=>({supabase:{
  rpc:()=>({abortSignal:async()=>({data:state.rows,error:state.rpcError})}),
  from:()=>{
    let writing=false;
    const q={select:()=>q,eq:()=>q,is:()=>q,not:()=>q,maybeSingle:()=>q,
      update:patch=>{writing=true;state.patches.push(patch);return q;},
      abortSignal:async()=>writing?{error:state.saveError}:{data:state.current,error:state.readError}};return q;
  },
}}));
vi.mock('../../src/services/notifications.js',()=>({sendEmail:state.send}));
vi.mock('../../src/lib/logger.js',()=>({default:{warn(){}}}));
import { processWaitlistWelcomes } from '../../src/services/waitlist-welcome.js';
import { waitlistWelcomeEmail } from '../../src/templates/waitlist-welcome.js';
const token='11111111-2222-3333-4444-555555555555';
beforeEach(()=>{
  vi.stubEnv('RESEND_API_KEY','test');state.rows=[{id:'signup-1',email:'test@example.com',unsubscribe_token:token,welcome_attempts:1,welcome_claim:'claim'}];
  state.current={id:'signup-1'};state.rpcError=null;state.readError=null;state.saveError=null;state.patches=[];state.send.mockReset().mockResolvedValue({id:'receipt-1'});
});
it('sends a stable deduplicated welcome and persists its provider receipt',async()=>{
  expect(await processWaitlistWelcomes()).toEqual({sent:1});
  expect(state.send).toHaveBeenCalledWith(expect.objectContaining({to:'test@example.com',replyTo:'levi@florrie.ai',idempotencyKey:'waitlist-welcome/v1/signup-1'}));
  expect(state.patches[0]).toMatchObject({welcome_status:'sent',welcome_message_id:'receipt-1',welcome_claim:null});
});
it('never sends when consent was withdrawn after claiming',async()=>{state.current=null;expect(await processWaitlistWelcomes()).toEqual({sent:0});expect(state.send).not.toHaveBeenCalled();});
it('fails closed when queue or consent storage is unavailable',async()=>{
  state.rpcError={};await expect(processWaitlistWelcomes()).rejects.toThrow();state.rpcError=null;state.readError={};await expect(processWaitlistWelcomes()).rejects.toThrow();expect(state.send).not.toHaveBeenCalled();
});
it('keeps a failed delivery queued and does not pretend it was sent',async()=>{
  state.send.mockResolvedValue(null);await expect(processWaitlistWelcomes()).rejects.toThrow('retry');
  expect(state.patches[0]).toMatchObject({welcome_status:'pending'});expect(state.patches[0]).not.toHaveProperty('welcome_sent_at');
});
it('raises receipt-storage failures for a safe idempotent retry',async()=>{state.saveError={};await expect(processWaitlistWelcomes()).rejects.toThrow('receipt');});
it('welcome includes text, individual one-click unsubscribe, privacy and no invented launch date',()=>{
  const m=waitlistWelcomeEmail(token);expect(m.html).toContain('role="presentation"');expect(m.html).toContain('favicon-192.png');
  expect(m.text).toContain('There’s nothing else you need to do');expect(m.headers['List-Unsubscribe']).toContain(token);
  expect(m.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  expect(()=>waitlistWelcomeEmail('bad')).toThrow();
});
