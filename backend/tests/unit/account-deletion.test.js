import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/config.js',()=>({supabase:{}}));
const { createAccountDeletionService, deletionSnapshot, processDeletion, CleanupReviewRequired } = await import('../../src/services/account-deletion.js');
const { createDeletionOperations, deleteBilling, deleteStoredObjects } = await import('../../src/services/account-deletion-operations.js');

const user={id:'u1',identities:[{provider:'email'}]};
const profile={id:'b1',auth_id:'u1',stripe_customer_id:'cus_saved',subscription_stripe_id:'sub_saved',instagram_page_token:'private-token'};
let row, log, failCreate, failSave, operations, store, service;
beforeEach(()=>{
 row=null; log=[]; failCreate=false; failSave=()=>false;
 store={
  find:async id=>row?.auth_id===id?structuredClone(row):null,
  profile:async()=>profile,
  create:async payload=>{if(failCreate)throw new Error('write failed');row={id:'d1',status:'pending',completed_steps:{},manual_confirmations:{},...payload};log.push('intent');return structuredClone(row);},
  get:async()=>structuredClone(row),
  claim:async(_id,token)=>{if(row.lease_token||row.status==='completed')return null;row.lease_token=token;return structuredClone(row);},
  save:async(_id,token,patch)=>{if(failSave(patch))throw new Error('checkpoint failed');if(row.lease_token!==token)throw new Error('claim changed');Object.assign(row,structuredClone(patch));return structuredClone(row);},
  pending:async()=>row&&row.status!=='completed'?[{id:row.id}]:[],
 };
 operations=Object.fromEntries(['business','billing','storage','auth'].map(name=>[name,vi.fn(async()=>{log.push(name);})]));
 operations.providers={google:vi.fn(async()=>log.push('google'))};
 service=createAccountDeletionService({store,operations,encode:JSON.stringify,decode:JSON.parse});
});

describe('durable account deletion',()=>{
 it('saves recovery references before erasing the business and only reports complete after every cleanup step',async()=>{
  operations.business.mockImplementation(async snapshot=>{expect(JSON.parse(row.snapshot_encrypted).stripe_customer_id).toBe('cus_saved');expect(snapshot.subscription_stripe_id).toBe('sub_saved');log.push('business');});
  const result=await service.request(user);
  expect(log).toEqual(['intent','business','billing','storage','google','auth']);
  expect(result.completed).toBe(true);expect(result.status_token).toHaveLength(43);
  expect(row.snapshot_encrypted).toBeNull();expect(JSON.stringify(result)).not.toContain('private-token');
 });
 it('does nothing destructive if durable intent cannot be saved',async()=>{
  failCreate=true;await expect(service.request(user)).rejects.toThrow();expect(log).toEqual([]);expect(operations.business).not.toHaveBeenCalled();
 });
 it('keeps billing references and never claims completion after billing failure',async()=>{
  operations.billing.mockRejectedValueOnce(new Error('temporary Stripe failure'));
  expect((await service.request(user)).completed).toBe(false);
  expect(row.pending_step).toBe('billing');expect(row.snapshot_encrypted).toContain('sub_saved');expect(operations.auth).not.toHaveBeenCalled();
  expect((await service.request(user)).completed).toBe(true);expect(operations.business).toHaveBeenCalledTimes(1);expect(operations.billing).toHaveBeenCalledTimes(2);
 });
 it('a restart resumes failed storage without repeating completed billing',async()=>{
  operations.storage.mockRejectedValueOnce(new Error('storage unavailable'));
  await service.request(user);
  const result=await processDeletion('d1',{store,operations,decode:JSON.parse});
  expect(result.completed).toBe(true);expect(operations.billing).toHaveBeenCalledTimes(1);expect(operations.storage).toHaveBeenCalledTimes(2);
 });
 it('keeps incomplete auth deletion retryable',async()=>{
  operations.auth.mockRejectedValueOnce(new Error('admin returned error'));
  expect((await service.request(user)).completed).toBe(false);expect(row.pending_step).toBe('auth');
  expect((await service.request(user)).completed).toBe(true);expect(operations.auth).toHaveBeenCalledTimes(2);
 });
 it('a failed checkpoint repeats an idempotent operation instead of dropping it',async()=>{
  let rejected=false;failSave=patch=>{if(patch.completed_steps?.billing&&!rejected){rejected=true;return true;}return false;};
  expect((await service.request(user)).completed).toBe(false);
  expect((await service.request(user)).completed).toBe(true);expect(operations.billing).toHaveBeenCalledTimes(2);
 });
 it('a failed completion write leaves a recoverable request even after auth is gone',async()=>{
  let rejected=false;failSave=patch=>{if(patch.status==='completed'&&!rejected){rejected=true;return true;}return false;};
  expect((await service.request(user)).completed).toBe(false);expect(row.snapshot_encrypted).not.toBeNull();
  expect((await service.retryPending()).completed).toBe(1);expect(operations.auth).toHaveBeenCalledTimes(1);expect(row.snapshot_encrypted).toBeNull();
 });
 it('never invents provider revocation; operator evidence permits resuming its remaining steps',async()=>{
  operations.providers.apple=vi.fn(async()=>{throw new CleanupReviewRequired('Apple token unavailable');});
  const pending=await service.request(user);expect(pending.status).toBe('needs_review');expect(operations.auth).not.toHaveBeenCalled();
  row.manual_confirmations.apple={reference:'provider-console-audit-123'};
  expect((await service.request(user)).completed).toBe(true);expect(operations.providers.apple).toHaveBeenCalledTimes(1);
 });
 it('does not run a second cleanup while another worker owns the lease',async()=>{
  let unblock;operations.billing.mockImplementation(()=>new Promise(resolve=>{unblock=resolve;}));
  const first=service.request(user);await vi.waitFor(()=>expect(unblock).toBeTypeOf('function'));
  const second=await service.request(user);expect(second.completed).toBe(false);expect(operations.business).toHaveBeenCalledTimes(1);
  unblock();await first;
 });
});

describe('provider and storage boundaries',()=>{
 it.each(['returned','thrown','malformed'])('does not treat %s auth deletion failure as success',async kind=>{
  const db={auth:{admin:{deleteUser:async()=>{if(kind==='thrown')throw new Error('offline');return kind==='returned'?{error:{message:'denied'}}:{};}}}};
  await expect(createDeletionOperations(db,{stripe:null}).auth({auth_id:'u1'})).rejects.toBeDefined();
 });
 it('allows retry after auth has already been removed',async()=>{
  const db={auth:{admin:{deleteUser:async()=>({error:{code:'user_not_found',status:404}})}}};
  await expect(createDeletionOperations(db,{stripe:null}).auth({auth_id:'u1'})).resolves.toBeUndefined();
 });
 it('a transient Stripe customer lookup does not lose or delete billing references',async()=>{
  const stripe={customers:{retrieve:vi.fn().mockRejectedValue(new Error('timeout')),del:vi.fn()}};
  await expect(deleteBilling(profile,stripe)).rejects.toThrow();expect(stripe.customers.del).not.toHaveBeenCalled();
 });
 it('requires server billing ownership metadata before deleting the customer',async()=>{
  const stripe={customers:{retrieve:async()=>({metadata:{beautician_id:'other'}}),del:vi.fn()}};
  await expect(deleteBilling({...profile,beautician_id:'b1'},stripe)).rejects.toBeInstanceOf(CleanupReviewRequired);expect(stripe.customers.del).not.toHaveBeenCalled();
 });
 it('customer deletion is confirmed and repeated deletion is idempotent',async()=>{
  const stripe={customers:{retrieve:vi.fn().mockResolvedValueOnce({metadata:{beautician_id:'b1'}}).mockResolvedValueOnce({deleted:true}),del:vi.fn(async()=>({deleted:true}))}};
  await deleteBilling({...profile,beautician_id:'b1'},stripe);await deleteBilling({...profile,beautician_id:'b1'},stripe);expect(stripe.customers.del).toHaveBeenCalledTimes(1);
 });
 it('storage removal checks returned errors and retries the actual inventory',async()=>{
  const remove=vi.fn().mockResolvedValueOnce({error:{message:'offline'}}).mockResolvedValueOnce({data:[]});
  const db={rpc:vi.fn().mockResolvedValueOnce({data:[{bucket_id:'private',name:'b1/photo'}]}).mockResolvedValueOnce({data:[{bucket_id:'private',name:'b1/photo'}]}).mockResolvedValueOnce({data:[]}),storage:{from:()=>({remove})}};
  await expect(deleteStoredObjects({auth_id:'u1',beautician_id:'b1'},db)).rejects.toBeDefined();
  await deleteStoredObjects({auth_id:'u1',beautician_id:'b1'},db);expect(remove).toHaveBeenNthCalledWith(2,['b1/photo']);
 });
 it('legacy Apple identity stays pending without a revocable token',async()=>{
  await expect(createDeletionOperations({}, {stripe:null}).providers.apple({identity_providers:['apple']})).rejects.toBeInstanceOf(CleanupReviewRequired);
 });
});

it('preserves an SMS-only channel and requires provider cleanup before completion', async()=>{
 const snapshot=deletionSnapshot({id:'b1',sms_channel_id:'channel-owned'},user);
 expect(snapshot.sms_channel_id).toBe('channel-owned');
 await expect(createDeletionOperations({}, {stripe:null}).providers.sms(snapshot)).rejects.toBeInstanceOf(CleanupReviewRequired);
});
