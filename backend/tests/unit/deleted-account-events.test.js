import { describe,it,expect,vi } from 'vitest';
vi.mock('../../src/config.js',()=>({supabase:{}}));
const { discardDeletedAccountEvent }=await import('../../src/services/deleted-account-events.js');
const event={id:'evt_late',type:'invoice.paid',data:{object:{customer:'cus_private',customer_email:'private@example.test'}}};
describe('deleted account webhook boundary',()=>{
 it('requires confirmed tombstone absence before permitting normal processing',async()=>{
  const write=vi.fn();
  const db={rpc:async()=>({data:false}),from:write};
  expect(await discardDeletedAccountEvent(event,db)).toBe(false);expect(write).not.toHaveBeenCalled();
 });
 it.each([{error:{message:'offline'}},{data:null},{}])('fails closed when deletion state is unreadable',async result=>{
  const write=vi.fn();await expect(discardDeletedAccountEvent(event,{rpc:async()=>result,from:write})).rejects.toBeDefined();expect(write).not.toHaveBeenCalled();
 });
 it('stores a dedupe tombstone without customer payload, and blocks processing',async()=>{
  const upsert=vi.fn(async()=>({error:null}));
  expect(await discardDeletedAccountEvent(event,{rpc:async()=>({data:true}),from:()=>({upsert})})).toBe(true);
  expect(upsert.mock.calls[0][0]).toMatchObject({id:'evt_late',data:{account_deleted:true}});
  expect(JSON.stringify(upsert.mock.calls)).not.toContain('private');
 });
 it('leaves Stripe free to retry if tombstone persistence fails',async()=>{
  await expect(discardDeletedAccountEvent(event,{rpc:async()=>({data:true}),from:()=>({upsert:async()=>({error:{message:'write failed'}})})})).rejects.toBeDefined();
 });
});
