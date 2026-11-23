import { describe,it,expect,vi } from 'vitest';

vi.mock('../../src/middleware/auth.js',()=>({requireAuth(req,res,next){
  if(!req.user || !req.beautician) return res.status(401).json({error:'Sign in first.'});
  return next();
}}));
import { createContentV2Router } from '../../src/routes/content-v2.js';

const owner='11111111-1111-4111-8111-111111111111',post='22222222-2222-4222-8222-222222222222',request='33333333-3333-4333-8333-333333333333';
function fixture() {
  const names=['home','prepare','preparation','ask','listPosts','getPost','connections','edit','revise','undo','approve','timing','action','results','photos','savePhoto','voice','forget','offers'];
  const service=Object.fromEntries(names.map(name=>[name,vi.fn(async()=>({ok:true}))]));
  service.getPost.mockResolvedValue({id:post,caption:'Saved words',status:'draft',version:1,material_hash:'checked'});
  service.connections.mockResolvedValue({instagram:{connected:true}});
  const router=createContentV2Router(service);
  const call=(method,url,body={},actor={id:owner,content_v2:true})=>new Promise((resolve,reject)=>{
    const req={method,url,headers:{},body,query:Object.fromEntries(new URL(url,'https://fixture.invalid').searchParams),
      ...(actor?{user:{id:'authenticated-user'},beautician:actor}:{})};
    const res={statusCode:200,status(status){this.statusCode=status;return this;},json(value){resolve({status:this.statusCode,body:value});return this;}};
    router.handle(req,res,error=>error?reject(error):resolve({status:404,body:{error:'No route'}}));
  });
  return {service,call};
}
describe('Content v2 route contracts',()=>{
  it('requires authentication and a server-controlled flag before accessing data',async()=>{
    const {service,call}=fixture();
    expect((await call('GET','/home',{},null)).status).toBe(401);
    expect((await call('GET','/home',{}, {id:owner,content_v2:false})).status).toBe(404);
    expect(service.home).not.toHaveBeenCalled();
    expect((await call('GET','/home')).status).toBe(200);expect(service.home).toHaveBeenCalledWith(owner);
  });
  it('takes the salon from authentication, never from a request body',async()=>{
    const {service,call}=fixture();
    await call('POST','/preparations',{beautician_id:post,request_id:request,request:{type:'week'}});
    expect(service.prepare).toHaveBeenCalledWith(owner,request,{type:'week'});
    await call('POST','/ask',{beautician_id:post,request_id:request,text:'Help fill Thursday'});
    expect(service.ask).toHaveBeenCalledWith(owner,request,'Help fill Thursday');
  });
  it('returns a handoff post with the approval hash and owner-facing state',async()=>{
    const {service,call}=fixture();const response=await call('GET',`/posts/${post}`);
    expect(service.getPost).toHaveBeenCalledWith(owner,post);
    expect(response.body.post).toMatchObject({id:post,state:'Ready to check',material_hash:'checked',version:1});
  });
  it('passes concurrency evidence through the editing and approval endpoints',async()=>{
    const {service,call}=fixture();
    await call('PATCH',`/posts/${post}`,{caption:'Owner words',expected_version:8});
    expect(service.edit).toHaveBeenCalledWith(owner,post,{caption:'Owner words',expected_version:8});
    await call('PATCH',`/posts/${post}`,{caption:'Owner words',hashtags:['#brows'],expected_version:9});
    expect(service.edit).toHaveBeenCalledWith(owner,post,{caption:'Owner words',hashtags:['#brows'],expected_version:9});
    await call('POST',`/posts/${post}/approve`,{expected_hash:'exact-approved-version'});
    expect(service.approve).toHaveBeenCalledWith(owner,post,'exact-approved-version');
  });
  it('returns 409 with the running preparation or changed post for recovery',async()=>{
    const {service,call}=fixture();
    service.prepare.mockRejectedValue(Object.assign(new Error('Already preparing.'),{status:409,code:'preparation_running',preparation:{id:request,step:2}}));
    const preparing=await call('POST','/preparations',{request_id:request,request:{type:'week'}});
    expect(preparing).toMatchObject({status:409,body:{preparation:{id:request,step:2},code:'preparation_running'}});
    service.edit.mockRejectedValue(Object.assign(new Error('Changed elsewhere.'),{status:409,post:{id:post,version:9}}));
    expect(await call('PATCH',`/posts/${post}`,{caption:'Unsent',expected_version:8})).toMatchObject({status:409,body:{post:{version:9}}});
  });
  it('validates IDs, result days and status before invoking a service',async()=>{
    const {service,call}=fixture();
    expect((await call('POST','/posts/not-an-id/approve')).status).toBe(400);
    expect((await call('GET','/results?days=500')).status).toBe(400);
    expect((await call('GET','/posts?status=imaginary')).status).toBe(400);
    expect((await call('PATCH','/photos',{id:'bad'})).status).toBe(400);
    expect(service.approve).not.toHaveBeenCalled();expect(service.results).not.toHaveBeenCalled();expect(service.savePhoto).not.toHaveBeenCalled();
  });
  it('routes revisions, timing, undo, publishing and soft deletion through the same owner',async()=>{
    const {service,call}=fixture();
    await call('POST',`/posts/${post}/revise`,{instruction:'less_salesy'});expect(service.revise).toHaveBeenCalledWith(owner,post,'less_salesy');
    await call('POST',`/posts/${post}/timing`,{at:null});expect(service.timing).toHaveBeenCalledWith(owner,post,null);
    await call('POST',`/posts/${post}/undo`);expect(service.undo).toHaveBeenCalledWith(owner,post);
    for(const action of ['move-back','retry','posted-by-owner','post-now','restore']) {
      await call('POST',`/posts/${post}/${action}`);expect(service.action).toHaveBeenLastCalledWith(owner,post,action);
    }
    await call('DELETE',`/posts/${post}`);expect(service.action).toHaveBeenLastCalledWith(owner,post,'remove');
  });
  it('does not expose internal database details for an unexpected failure',async()=>{
    const {service,call}=fixture();service.home.mockRejectedValue(new Error('private table/token detail'));
    const response=await call('GET','/home');expect(response.status).toBe(503);expect(JSON.stringify(response.body)).not.toContain('private');
  });
});
