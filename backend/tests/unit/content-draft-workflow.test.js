import {beforeEach,describe,it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>({rows:[],appointments:[],fail:false,race:false,caption:vi.fn()}));
vi.mock('../../src/middleware/auth.js',()=>({requireAuth:(req,res,next)=>next()}));
vi.mock('../../src/lib/logger.js',()=>({default:{error:vi.fn(),warn:vi.fn()}}));
vi.mock('../../src/services/content-autopilot.js',()=>({createPostFromPhoto:vi.fn(),publishPost:vi.fn(),draftAvailabilityPost:vi.fn(),planWeek:vi.fn(),generateCaption:state.caption,imageUrlProblem:url=>typeof url==='string'&&url.startsWith('https://')?null:'Add a saved photo first.'}));
vi.mock('../../src/config.js',()=>({supabase:{from(table){
 const source=table==='appointments'?state.appointments:table==='beauticians'?[{id:'owner',first_name:'Ellie'}]:state.rows;
 let predicates=[],mode='read',updates,one=false;
 const q={gte(k,v){predicates.push(r=>r[k]>=v);return q;},lte(k,v){predicates.push(r=>r[k]<=v);return q;},order(){return q;},limit(){return q;},single(){one=true;return q;},or(){predicates.push(r=>r.post_type!=='gallery');return q;},select(){return q;},eq(k,v){predicates.push(r=>r[k]===v);return q;},neq(k,v){predicates.push(r=>r[k]!==v);return q;},is(k,v){predicates.push(r=>(r[k]??null)===v);return q;},in(k,v){predicates.push(r=>v.includes(r[k]));return q;},update(v){mode='update';updates=v;return q;},delete(){mode='delete';return q;},maybeSingle(){one=true;return q;},then(resolve){
  if(state.fail)return Promise.resolve({data:null,error:{message:'offline'}}).then(resolve);
  if(state.race&&mode==='update'){state.rows[0].publish_claimed_at='claimed';state.race=false;}
  const found=source.filter(r=>predicates.every(p=>p(r)));
  if(mode==='update')found.forEach(r=>Object.assign(r,updates));
  if(mode==='delete')state.rows=state.rows.filter(r=>!found.includes(r));
  return Promise.resolve({data:one?(found[0]??null):found.map(r=>({...r})),error:null,count:found.length}).then(resolve);
 }};return q;
}}}));
import router from '../../src/routes/content.js';
async function call(method,path,body={},id='p1'){
 const out={status:200};const res={status(n){out.status=n;return res;},json(v){out.body=v;return res;}};
 const route=router.stack.find(l=>l.route?.path===path&&l.route.methods[method]).route;
 for(const layer of route.stack){let next=false;await layer.handle({beautician:{id:'owner'},params:{id},body},res,()=>{next=true;});if(!next)break;}
 return out;
}
beforeEach(()=>{state.rows=[{id:'p1',beautician_id:'owner',post_type:'general',status:'draft',caption:'Original',image_url:'https://example.com/photo.jpg',external_post_id:null,publish_claimed_at:null}];state.fail=false;state.race=false;state.appointments=[];state.caption.mockReset().mockResolvedValue({caption:'A caption',hashtags:[]});});
describe('Content draft completion and scheduling',()=>{
 it('saves caption, hashtags and a replacement photo on the same draft',async()=>{const r=await call('patch','/:id',{caption:'Revised',hashtags:['#brows'],image_url:'https://example.com/new.jpg'});expect(r.status).toBe(200);expect(state.rows[0]).toMatchObject({id:'p1',caption:'Revised',image_url:'https://example.com/new.jpg',hashtags:['#brows']});});
 it.each(['posted','scheduled'])('cannot edit a %s post',async status=>{state.rows[0].status=status;expect((await call('patch','/:id',{caption:'Changed'})).status).toBe(409);expect(state.rows[0].caption).toBe('Original');});
 it('cannot change another salon’s draft',async()=>{state.rows[0].beautician_id='other';expect((await call('patch','/:id',{caption:'Changed'})).status).toBe(409);});
 it('does not put a published post back into scheduling or drafts',async()=>{state.rows[0].status='posted';state.rows[0].external_post_id='ig1';for(const scheduled_for of [null,'2099-07-01T12:00:00Z'])expect((await call('post','/:id/schedule',{scheduled_for})).status).toBe(409);expect(state.rows[0].status).toBe('posted');});
 it('requires a photo and a future timezone-aware time',async()=>{for(const scheduled_for of ['bad','2020-01-01T12:00:00Z','2099-01-01T12:00'])expect((await call('post','/:id/schedule',{scheduled_for})).status).toBe(400);state.rows[0].image_url=null;expect((await call('post','/:id/schedule',{scheduled_for:'2099-07-01T12:00:00Z'})).status).toBe(400);expect(state.rows[0].status).toBe('draft');});
 it('schedules, moves and returns a saved post to drafts',async()=>{expect((await call('post','/:id/schedule',{scheduled_for:'2099-07-01T13:00:00+01:00'})).status).toBe(200);expect(state.rows[0].scheduled_for).toBe('2099-07-01T12:00:00.000Z');expect((await call('post','/:id/schedule',{scheduled_for:'2099-07-02T13:00:00Z'})).status).toBe(200);expect((await call('post','/:id/schedule',{scheduled_for:null})).status).toBe(200);expect(state.rows[0]).toMatchObject({status:'draft',scheduled_for:null});});
 it('a worker taking the post during scheduling prevents the stale change',async()=>{state.race=true;expect((await call('post','/:id/schedule',{scheduled_for:'2099-07-01T12:00:00Z'})).status).toBe(409);expect(state.rows[0].status).toBe('draft');});
 it('protects gallery records and publishing claims from edits and deletion',async()=>{for(const change of [{post_type:'gallery'},{publish_claimed_at:'claimed'}]){Object.assign(state.rows[0],change);expect((await call('patch','/:id',{caption:'Changed'})).status).toBe(409);expect((await call('delete','/:id')).status).toBe(409);}});
 it('reports a failed save and delete without claiming success',async()=>{state.fail=true;expect((await call('patch','/:id',{caption:'Changed'})).status).toBe(503);expect((await call('delete','/:id')).status).toBe(503);expect(state.rows).toHaveLength(1);});
 it('discards a failed draft after the publish claim has been released',async()=>{state.rows[0].status='failed';expect((await call('delete','/:id')).status).toBe(200);expect(state.rows).toEqual([]);});
 it('legacy drafts with no type can still be edited',async()=>{state.rows[0].post_type=null;expect((await call('patch','/:id',{caption:'Revised'})).status).toBe(200);});
 it('an unreadable draft count does not generate another weekly plan',async()=>{state.fail=true;expect((await call('post','/plan-week')).status).toBe(503);});
 it('recent ideas use completed past appointments and avoid client identities',async()=>{
  const past=new Date(Date.now()-3600000).toISOString(),future=new Date(Date.now()+3600000).toISOString();
  state.appointments=[{id:'done',beautician_id:'owner',status:'completed',ends_at:past,treatments:{name:'Brows'},clients:{first_name:'Private name'}},{id:'future',beautician_id:'owner',status:'completed',ends_at:future},{id:'uncompleted',beautician_id:'owner',status:'confirmed',ends_at:past}];
  const result=await call('get','/suggestions');expect(result.status).toBe(200);expect(result.body.suggestions).toHaveLength(1);expect(result.body.suggestions[0]).toMatchObject({appointment_id:'done',ready_to_post:false});expect(state.caption.mock.calls[0][3]).not.toContain('Private name');
 });

 it('caption generation receives the chosen photo and treatment',async()=>{const out=await call('post','/caption',{post_type:'before_after',treatment_type:'Lash lift',context:'Soft finish',image_url:'https://example.com/lashes.jpg'});expect(out.status).toBe(200);expect(state.caption).toHaveBeenCalledWith('owner','https://example.com/lashes.jpg','Lash lift','Soft finish');});

});
