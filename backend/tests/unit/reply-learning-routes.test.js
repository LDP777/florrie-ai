import { beforeAll, afterAll, beforeEach, it, expect, vi } from 'vitest';
import express from 'express';
const state = vi.hoisted(() => ({ learn: vi.fn(), rpc: vi.fn(), rows: [], error: null, filters: [] }));
vi.mock('../../src/services/reply-learning.js', () => ({ learnReply: state.learn }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth(req,res,next) { if(req.headers.authorization !== 'Bearer owner') return res.status(401).json({error:'Unauthorized'});req.beautician={id:'owner'};next(); } }));
vi.mock('../../src/config.js', () => ({ supabase: { rpc: state.rpc, from(table) {
  const filters=[];let updates;
  const q={ select:()=>q,order:()=>q,limit:()=>q,
   eq(k,v){filters.push(row=>row[k]===v);state.filters.push({table,k,v});return q;},
   in(k,v){filters.push(row=>v.includes(row[k]));return q;},
   update(v){updates=v;return q;},
   then(resolve){const rows=state.rows.filter(row=>filters.every(f=>f(row)));if(updates)rows.forEach(row=>Object.assign(row,updates));resolve({data:rows,error:state.error});},
  };return q;
} } }));
const { default: router } = await import('../../src/routes/reply-learning.js');
let server,base;
beforeAll(async()=>{const app=express();app.use(express.json());app.use('/learning',router);server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}/learning`;});
afterAll(()=>new Promise(r=>server.close(r)));
beforeEach(()=>{state.rows=[];state.filters=[];state.error=null;state.learn.mockReset();state.rpc.mockReset();});
const id='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const call=(path,body,method='POST',token='owner')=>fetch(base+path,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
it('requires authentication and scopes pending drafts to the current salon',async()=>{
 state.rows=[{id,beautician_id:'owner',status:'pending'},{id:'other',beautician_id:'victim',status:'pending'},{id:'done',beautician_id:'owner',status:'approved'}];
 expect((await call('',undefined,'GET','wrong')).status).toBe(401);
 const r=await call('',undefined,'GET');expect(r.headers.get('cache-control')).toBe('no-store');expect((await r.json()).suggestions.map(s=>s.id)).toEqual([id]);
});
it('takes the source owner from authentication, never request data',async()=>{
 state.learn.mockResolvedValue({id,status:'pending'});
 expect((await call(`/from-reply/${id}`,{beautician_id:'victim'})).status).toBe(200);
 expect(state.learn).toHaveBeenCalledExactlyOnceWith('owner',id);
 state.learn.mockResolvedValue(null);expect((await call(`/from-reply/${id}`,{})).status).toBe(404);
 expect((await call('/from-reply/bad',{})).status).toBe(400);
});
it('approves only via the atomic owner-scoped function and validates all input',async()=>{
 state.rpc.mockResolvedValue({data:[{id:'new',is_active:true}]});
 const body={category:'policy',title:' Vouchers ',content:' Twelve months. ',beautician_id:'victim',is_active:true};
 expect((await call(`/${id}/approve`,body)).status).toBe(200);
 expect(state.rpc).toHaveBeenCalledExactlyOnceWith('approve_knowledge_suggestion',{p_owner:'owner',p_id:id,p_category:'policy',p_title:'Vouchers',p_content:'Twelve months.',p_replace:null});
 for(const invalid of [{...body,content:''},{...body,title:'x'.repeat(121)},{...body,replace_entry_id:'bad'},{...body,category:'private'}])expect((await call(`/${id}/approve`,invalid)).status).toBe(400);
});
it('surfaces missing storage and conflicts without pretending to approve',async()=>{
 const body={category:'faq',title:'Topic',content:'Answer'};
 for(const [code,status] of [['PGRST202',503],['P0002',404],['22023',409]]){
 state.rpc.mockResolvedValue({error:{code}});expect((await call(`/${id}/approve`,body)).status).toBe(status);
 }
 state.error={code:'PGRST205'};expect((await call('',undefined,'GET')).status).toBe(503);
});
it('cannot dismiss another salon’s suggestion or an approved answer',async()=>{
 state.rows=[{id,beautician_id:'victim',status:'pending'}];expect((await call(`/${id}/dismiss`,{})).status).toBe(409);expect(state.rows[0].status).toBe('pending');
 state.rows=[{id,beautician_id:'owner',status:'approved'}];expect((await call(`/${id}/dismiss`,{})).status).toBe(409);
 state.rows[0].status='pending';expect((await call(`/${id}/dismiss`,{})).status).toBe(200);expect(state.rows[0].status).toBe('dismissed');
});
