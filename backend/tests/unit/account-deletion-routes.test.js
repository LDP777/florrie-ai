import { describe,it,expect,vi,beforeAll,afterAll,beforeEach } from 'vitest';
import express from 'express';
const fake=vi.hoisted(()=>({ request:vi.fn(),status:vi.fn(),publicStatus:vi.fn(),createUser:vi.fn(),from:vi.fn() }));
vi.mock('../../src/services/account-deletion.js',()=>({accountDeletion:fake}));
vi.mock('../../src/config.js',()=>({supabase:{from:fake.from,auth:{admin:{createUser:fake.createUser}}},supabaseAnon:{auth:{getUser:async token=>token==='owner-token'?{data:{user:{id:'owner-id'}}}:{error:{message:'invalid'}}}}}));
vi.mock('../../src/services/email-sequences.js',()=>({triggerSequence:vi.fn()}));
const {default:router}=await import('../../src/routes/auth.js');
let server,base;
beforeAll(async()=>{const app=express();app.use(express.json());app.use('/api/auth',router);server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}/api/auth`;});
afterAll(()=>new Promise(resolve=>server.close(resolve)));
beforeEach(()=>{vi.clearAllMocks();fake.status.mockResolvedValue(null);});
const call=(path,options={})=>fetch(base+path,{...options,headers:{'content-type':'application/json',authorization:'Bearer owner-token',...options.headers}});
describe('truthful account endpoints',()=>{
 it('keeps incomplete cleanup at 202 and does not report success',async()=>{
  fake.request.mockResolvedValue({id:'d1',completed:false,status:'pending'});
  const response=await call('/account',{method:'DELETE',body:JSON.stringify({confirm:'DELETE',auth_id:'victim-id'})});
  expect(response.status).toBe(202);expect((await response.json()).success).toBe(false);
  expect(fake.request).toHaveBeenCalledWith({id:'owner-id'});
 });
 it('completion requires the completed service result',async()=>{
  fake.request.mockResolvedValue({id:'d1',completed:true,status:'completed'});
  const response=await call('/account',{method:'DELETE',body:'{"confirm":"DELETE"}'});
  expect(response.status).toBe(200);expect((await response.json()).success).toBe(true);
 });
 it('does not start work without a verified identity and confirmation',async()=>{
  expect((await call('/account',{method:'DELETE',body:'{}'})).status).toBe(400);
  expect((await call('/account',{method:'DELETE',headers:{authorization:'Bearer invalid'},body:'{"confirm":"DELETE"}'})).status).toBe(401);
  expect(fake.request).not.toHaveBeenCalled();
 });
 it('a returned service failure remains unavailable, not successful',async()=>{
  fake.request.mockRejectedValue(new Error('checkpoint failed'));
  expect((await call('/account',{method:'DELETE',body:'{"confirm":"DELETE"}'})).status).toBe(503);
 });
 it('existing deletion blocks profile recreation before any profile lookup',async()=>{
  fake.status.mockResolvedValue({id:'d1',completed:false,status:'pending'});
  const response=await call('/ensure-profile',{method:'POST'});
  expect(response.status).toBe(409);expect((await response.json()).code).toBe('ACCOUNT_DELETION_REQUESTED');expect(fake.from).not.toHaveBeenCalled();
 });
 it('unknown deletion state blocks profile creation instead of bypassing it',async()=>{
  fake.status.mockRejectedValue(new Error('db unavailable'));
  expect((await call('/ensure-profile',{method:'POST'})).status).toBe(503);expect(fake.from).not.toHaveBeenCalled();
 });
 it('unused public signup cannot create a preverified user',async()=>{
  expect((await call('/signup',{method:'POST',body:JSON.stringify({email:'fake@example.test',password:'password123'})})).status).toBe(410);
  expect(fake.createUser).not.toHaveBeenCalled();
 });
 it('status recovery works after auth deletion using only the scoped token',async()=>{
  fake.publicStatus.mockResolvedValue({id:'d1',completed:true,status:'completed'});
  const response=await call('/account/deletion-status',{headers:{authorization:'','X-Deletion-Token':'a'.repeat(43)}});
  expect(response.status).toBe(200);expect((await response.json()).deletion.completed).toBe(true);expect(response.headers.get('cache-control')).toBe('no-store');
 });
});
