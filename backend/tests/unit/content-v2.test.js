import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createContentV2Service } from '../../src/services/content-v2/index.js';
import { materialHash, postgresJson, ownerState } from '../../src/services/content-v2/state.js';
import { createWriter, validateWriting } from '../../src/services/content-v2/writer.js';
import { learnFromEdit, applyHashtagRules } from '../../src/services/content-v2/voice.js';
import { sanitizeBeautician } from '../../src/middleware/auth.js';
import { profileUpdateSchema } from '../../src/lib/schemas.js';

const migrationDir=fileURLToPath(new URL('../../../supabase/migrations/',import.meta.url));
// Read the actual migrations. A misspelled SELECT, filter or write column is
// rejected like PostgREST, including when a broad SELECT would otherwise hide it.
function schemaColumns() {
  const tables={};
  for(const name of readdirSync(migrationDir).filter(n=>n.endsWith('.sql')).sort()) {
    const sql=readFileSync(`${migrationDir}/${name}`,'utf8').replace(/--[^\n]*/g,'');
    for(const match of sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\);/gi)) {
      const set=tables[match[1]] ||= new Set();
      for(const line of match[2].split('\n')) {
        const column=/^\s*(\w+)\s+(?:uuid|text|varchar|char|int\w*|bigint|smallint|numeric|decimal|boolean|bool|jsonb?|timestamp\w*|date|time|real|double|float|bytea)/i.exec(line);
        if(column) set.add(column[1]);
      }
    }
    for(const match of sql.matchAll(/ALTER TABLE(?: IF EXISTS)?\s+(?:public\.)?(\w+)\s+([\s\S]*?);/gi)) {
      const set=tables[match[1]] ||= new Set();
      for(const add of match[2].matchAll(/ADD COLUMN(?: IF NOT EXISTS)?\s+(\w+)\s+/gi)) set.add(add[1]);
    }
  }
  return tables;
}
const COLUMNS=schemaColumns();
function fakeDatabase(seed) {
  const data=structuredClone(seed),errors=new Map(),operations=[];
  const fake={data,errors,operations,from(table){
    let predicates=[],op='select',values,fields='*',single=false,offset=0,end=Infinity,order,upsertOptions;
    let invalid=null;
    const validate=key=>{if(!COLUMNS[table]?.has(key)) invalid={code:'42703',message:`column ${table}.${key} does not exist`};};
    const builder={
      select(spec='*'){fields=spec;for(const key of spec.split(',').map(s=>s.trim()).filter(s=>s!=='*')) validate(key);return builder;},
      insert(v){op='insert';values=v;return builder;},upsert(v,o){op='upsert';values=v;upsertOptions=o;return builder;},update(v){op='update';values=v;return builder;},
      eq(k,v){validate(k);predicates.push(r=>r[k]===v);return builder;},is(k,v){validate(k);predicates.push(r=>(r[k] ?? null)===v);return builder;},
      in(k,v){validate(k);predicates.push(r=>v.includes(r[k]));return builder;},gte(k,v){validate(k);predicates.push(r=>r[k]>=v);return builder;},lte(k,v){validate(k);predicates.push(r=>r[k]<=v);return builder;},
      order(k,{ascending=true}={}){validate(k);order=[k,ascending];return builder;},range(a,b){offset=a;end=b+1;return builder;},limit(n){end=n;return builder;},
      maybeSingle(){single=true;return builder;},single(){single=true;return builder;},abortSignal(){return builder;},
      then(resolve,reject){return Promise.resolve().then(()=>{
        if(values) for(const row of Array.isArray(values)?values:[values]) for(const key of Object.keys(row)) validate(key);
        operations.push({table,op,values:structuredClone(values),fields});
        if(invalid) return {data:null,error:invalid};
        if(errors.has(table)) return {data:null,error:errors.get(table)};
        data[table] ||= [];
        let found=data[table].filter(r=>predicates.every(fn=>fn(r)));
        if(op==='insert' || op==='upsert') {
          found=[];
          for(const value of Array.isArray(values)?values:[values]) {
            const conflict=(upsertOptions?.onConflict || 'id').split(',');
            const old=data[table].find(r=>conflict.every(k=>r[k]===value[k]));
            if(old && op==='upsert' && upsertOptions?.ignoreDuplicates) continue;
            if(old && op==='insert') return {data:null,error:{code:'23505'}};
            const row={id:randomUUID(),created_at:'2026-11-22T12:00:00Z',...(table==='content_campaigns'?{token:randomUUID().replaceAll('-','')}:{}),...structuredClone(value)};
            if(old) Object.assign(old,row);else data[table].push(row);found.push(row);
          }
        } else if(op==='update') {for(const row of found) Object.assign(row,structuredClone(values));}
        if(order) found.sort((a,b)=>String(a[order[0]]).localeCompare(String(b[order[0]]))*(order[1]?1:-1));
        found=found.slice(offset,end).map(r=>fields==='*'?structuredClone(r):Object.fromEntries(fields.split(',').map(k=>[k,r[k]])));
        return {data:single?found[0] || null:found,error:null};
      }).then(resolve,reject);},
    };return builder;
  }};return fake;
}
const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const lash='33333333-3333-4333-8333-333333333333',brow='44444444-4444-4444-8444-444444444444';
const photoId='55555555-5555-4555-8555-555555555555',clientId='66666666-6666-4666-8666-666666666666',consentId='77777777-7777-4777-8777-777777777777';
const promoId='88888888-8888-4888-8888-888888888888';
const NOW=new Date('2026-11-22T12:00:00Z');
function fixture() {
  const working_hours=Object.fromEntries(['mon','tue','wed','thu','fri','sat','sun'].map(k=>[k,{start:'09:00',end:'18:00'}]));
  return {
    beauticians:[{id:owner,business_name:'Willow Beauty',booking_slug:'willow-beauty',timezone:'Europe/London',working_hours,booking_policy:{},voice_profile:{},content_v2:true,
      instagram_page_id:'ig-fictional',instagram_page_token:'test-only',instagram_page_name:'willowbeauty',instagram_token_expires_at:'2027-01-01T00:00:00Z'}],
    treatments:[{id:lash,beautician_id:owner,name:'Lash lift and tint',price_cents:5000,duration_minutes:60,buffer_minutes:0,is_active:true,booking_enabled:true,requires_patch_test:true},
      {id:brow,beautician_id:owner,name:'Brow lamination and tint',price_cents:4500,duration_minutes:60,buffer_minutes:0,is_active:true,booking_enabled:true,requires_patch_test:true,description:'Lasts 6 to 8 weeks.'}],
    content_posts:[{id:photoId,beautician_id:owner,post_type:'gallery',status:'draft',platform:'instagram',treatment_id:brow,client_id:clientId,consent_id:consentId,permission_status:'granted',
      before_url:`https://test.supabase.co/storage/v1/object/public/content-images/${owner}/gallery/before.jpg`,after_url:`https://test.supabase.co/storage/v1/object/public/content-images/${owner}/gallery/after.jpg`,
      image_url:`https://test.supabase.co/storage/v1/object/public/content-images/${owner}/gallery/after.jpg`,created_at:'2026-11-22T09:00:00Z'}],
    clients:[{id:clientId,beautician_id:owner,first_name:'Jess',last_name:'Fictional'}],
    photo_consents:[{id:consentId,beautician_id:owner,client_id:clientId,status:'granted',permitted_uses:['instagram'],granted_at:'2026-11-01T00:00:00Z'}],
    promo_codes:[{id:promoId,beautician_id:owner,title:'Festive lash lift',treatment_ids:[lash],discount_type:'fixed',discount_value:1000,appointments_from:'2026-12-01',appointments_to:'2026-12-24',
      valid_from:'2026-11-01T00:00:00Z',valid_until:'2026-12-20T23:59:59Z',terms:'One per client.',code:'FESTIVE10',is_active:true,current_uses:0,max_uses:null,marketing_approved_at:'2026-11-01T00:00:00Z'}],
    reviews:[],review_post_permissions:[],courses:[],content_voice_rules:[],content_preparations:[],content_campaigns:[],content_booking_sources:[],appointments:[],google_review_connections:[],
  };
}
let db,service,gaps,slots,clock;
beforeEach(()=>{
  db=fakeDatabase(fixture());clock=new Date(NOW);
  gaps=[{date:'2026-11-26',start:'14:00',end:'18:00',duration_minutes:240}];
  slots=[{date:'2026-11-26',time:'14:00',iso:'2026-11-26T14:00:00Z'},{date:'2026-11-26',time:'15:00',iso:'2026-11-26T15:00:00Z'}];
  service=createContentV2Service({db,now:()=>clock,autoKick:false,gapCalendar:async(o,date)=>({gaps:+date>+NOW+6*86400000?[]:gaps}),
    freeSlots:async()=>slots,calendarBlocks:async()=>({closedDays:new Set(),dateHours:new Map()}),
    writer:createWriter({env:{}}),renderArtwork:async(o,p)=>`https://test.supabase.co/storage/v1/object/public/content-images/${o}/generated/${p.id}.jpg`});
});
async function week() {
  const p=await service.prepare(owner,randomUUID(),{type:'week'});
  await service.processPreparation(p);
  return db.data.content_posts.filter(p=>p.post_type!=='gallery');
}
describe('Content v2 real-column workflow',()=>{
  it('rejects phantom columns rather than silently treating errors as empty rows',async()=>{
    const result=await db.from('treatments').select('price_pence');expect(result.error.code).toBe('42703');
    db.errors.set('treatments',{code:'42703'});
    await expect(service.home(owner)).rejects.toMatchObject({code:'storage_unavailable'});
  });
  it('creates a balanced week, one reel plan and tracked future times',async()=>{
    const posts=await week();expect(posts).toHaveLength(4);
    expect(posts.filter(p=>p.kind==='post').map(p=>p.purpose.type)).toEqual(['fill_gap','show_work','offer']);
    for(const post of posts) {
      expect(post.caption).not.toMatch(/[\u2013\u2014]/);expect(post.claims.length).toBeGreaterThan(0);expect(post.facts.length).toBeGreaterThan(0);
      expect(post.link_url).toContain('fl_content=');expect(Date.parse(post.scheduled_for)).toBeGreaterThan(+NOW);expect(post.material_hash).toBe(materialHash(post));
    }
    expect(db.data.content_preparations[0]).toMatchObject({status:'done',step:5,lease_token:null,lease_until:null});
    expect(db.data.content_preparations[0].details.steps.every(s=>s.status==='done')).toBe(true);
  });
  it('preserves idempotency and resumes after assets with the same post IDs',async()=>{
    const request=randomUUID(),p=await service.prepare(owner,request,{type:'week'});
    expect((await service.prepare(owner,request,{type:'week'})).id).toBe(p.id);
    const ctx=await service.context(owner);
    const {planPosts}=await import('../../src/services/content-v2/planner.js');
    const planned=planPosts(p.request,ctx).drafts.map(post=>({...post,preparation_id:p.id,image_url:'https://example.com/card.jpg'}));
    Object.assign(db.data.content_preparations[0],{step:2,details:{steps:p.details.steps,drafts:planned},post_ids:planned.map(p=>p.id)});
    const write=vi.fn(async post=>({caption:post.caption,hashtags:post.hashtags}));
    const resumed=createContentV2Service({db,now:()=>clock,autoKick:false,gapCalendar:async()=>({gaps}),freeSlots:async()=>slots,
      calendarBlocks:async()=>({closedDays:new Set(),dateHours:new Map()}),writer:{write},renderArtwork:()=>{throw new Error('assets must not rerun');}});
    await resumed.processPreparation(db.data.content_preparations[0]);
    expect(write).toHaveBeenCalledTimes(3);
    expect(db.data.content_posts.filter(p=>p.preparation_id).map(p=>p.id)).toEqual(planned.map(p=>p.id));
  });
  it('moves a booked 2pm claim to 3pm, revokes approval and blocks a full day',async()=>{
    const p=(await week()).find(p=>p.purpose.type==='fill_gap');await service.approve(owner,p.id,p.material_hash);
    gaps=[{date:'2026-11-26',start:'15:00',end:'18:00',duration_minutes:180}];slots=slots.slice(1);
    const moved=await service.recheckPost(owner,p.id);expect(moved.caption).toContain('from 3pm');expect(moved.caption).not.toContain('from 2pm');
    expect(moved.purpose.title).toContain('from 3pm');
    expect(moved.approved_hash).toBeNull();expect(moved.change_note.reasons).toContain('2pm on Thursday was booked');
    gaps=[];slots=[];const blocked=await service.recheckPost(owner,p.id);expect(blocked.change_note.kind).toBe('blocked');
    await expect(service.approve(owner,p.id,blocked.material_hash)).rejects.toMatchObject({status:409,code:'facts_blocked'});
  });
  it('replaces only the price words and keeps the rest of the caption',async()=>{
    const p=(await week()).find(p=>p.purpose.type==='show_work');await service.approve(owner,p.id,p.material_hash);
    db.data.treatments.find(t=>t.id===brow).price_cents=4800;
    const checked=await service.recheckPost(owner,p.id);expect(checked.caption).toBe(p.caption.replace('£45','£48'));expect(checked.approved_hash).toBeNull();
  });
  it('blocks withdrawn and expired consent at approval',async()=>{
    const p=(await week()).find(p=>p.purpose.type==='show_work');db.data.photo_consents[0].revoked_at=NOW.toISOString();
    await expect(service.approve(owner,p.id,p.material_hash)).rejects.toMatchObject({code:'facts_blocked'});
    db.data.photo_consents[0].revoked_at=null;db.data.photo_consents[0].expires_at='2026-11-21T00:00:00Z';
    await expect(service.approve(owner,p.id,p.material_hash)).rejects.toMatchObject({code:'facts_blocked'});
  });
  it('clears approval on owner editing, learns approved wording and refuses stale writes',async()=>{
    const p=(await week()).find(p=>p.purpose.type==='fill_gap');await service.approve(owner,p.id,p.material_hash);
    let current=await service.getPost(owner,p.id);
    const edited=await service.edit(owner,p.id,{caption:current.caption.replace('give me a message','send me a note'),expected_version:current.version});
    expect(edited.post.approved_hash).toBeNull();
    await expect(service.edit(owner,p.id,{caption:'Stale edit',expected_version:current.version})).rejects.toMatchObject({status:409});
    const accepted=await service.approve(owner,p.id,edited.post.material_hash);expect(accepted.learned_rules.some(r=>r.kind==='replace')).toBe(true);
    expect(learnFromEdit('Thursday costs £45.','Friday costs £48.')).toEqual([]);
  });
  it('changes image and wording independently, and Undo restores exactly',async()=>{
    const p=(await week()).find(p=>p.purpose.type==='show_work');
    const changed=await service.revise(owner,p.id,'other_photo');expect(changed.post.caption).toBe(p.caption);expect(changed.post.media.type).toBe('photo');
    const undo=await service.undo(owner,p.id);expect(undo.post.media).toEqual(p.media);expect(undo.post.caption).toBe(p.caption);
    const offer=(await service.getPost(owner,db.data.content_posts.find(p=>p.purpose?.type==='offer').id));
    const softer=await service.revise(owner,offer.id,'less_salesy');expect(softer.post.image_url).toBe(offer.image_url);
    for(const claim of offer.claims) expect(softer.post.caption).toContain(claim.text);
  });
  it('timing keeps approval, held posts wait, edits cannot touch a publish claim',async()=>{
    const p=(await week()).find(p=>p.purpose.type==='offer');await service.approve(owner,p.id,p.material_hash);
    const moved=await service.timing(owner,p.id,'2026-11-24T18:00:00+00:00');expect(moved.post.approved_hash).toBe(p.material_hash);
    const held=await service.timing(owner,p.id,null);expect(held.post.state).toBe('Approved, not scheduled');
    const stored=db.data.content_posts.find(row=>row.id===p.id);stored.publish_claimed_at=NOW.toISOString();
    await expect(service.edit(owner,p.id,{caption:'Changed',expected_version:stored.version})).rejects.toMatchObject({status:409});
  });
  it('does not learn from Florrie revisions after an owner edit',async()=>{
    const p=(await week()).find(p=>p.purpose.type==='offer');
    await service.edit(owner,p.id,{caption:p.caption.replace('Booking link is in my bio','Booking link is ready in my bio'),expected_version:p.version});
    const revised=await service.revise(owner,p.id,'less_salesy');expect(revised.post.edited_by_owner).toBe(false);
    const approved=await service.approve(owner,p.id,revised.post.material_hash);expect(approved.learned_rules).toEqual([]);
  });
  it('learns an approved owner reduction from three hashtags to one only once, with Undo and Forget',async()=>{
    const prepared=(await week()).find(p=>p.purpose.type==='show_work');
    const post=db.data.content_posts.find(p=>p.id===prepared.id);
    Object.assign(post,{hashtags:['#brows','#beauty','#browtint'],prepared_hashtags:['#brows','#beauty','#browtint']});post.material_hash=materialHash(post);
    let changed=await service.edit(owner,post.id,{caption:post.caption,hashtags:['brows'],expected_version:post.version});
    expect(changed.post.hashtags).toEqual(['#brows']);expect(db.data.content_voice_rules).toHaveLength(0);
    const undone=await service.undo(owner,post.id);expect(undone.post.hashtags).toEqual(['#brows','#beauty','#browtint']);
    changed=await service.edit(owner,post.id,{caption:post.caption,hashtags:['#brows'],expected_version:undone.post.version});
    const approved=await service.approve(owner,post.id,changed.post.material_hash);
    expect(approved.learned_rules).toMatchObject([{kind:'max_hashtags',value:'1',source_post_id:post.id}]);
    expect(applyHashtagRules(['#brows','#beauty','#browtint'],approved.learned_rules)).toEqual(['#brows']);
    const repeated=await service.approve(owner,post.id,approved.post.material_hash);expect(repeated.learned_rules).toEqual([]);expect(db.data.content_voice_rules).toHaveLength(1);
    await service.forget(owner,approved.learned_rules[0].id);expect((await service.voice(owner)).rules).toEqual([]);
    expect((await service.approve(owner,post.id,approved.post.material_hash)).learned_rules).toEqual([]);
    expect(applyHashtagRules(['#brows','#beauty','#browtint'],(await service.context(owner)).rules)).toHaveLength(3);
  });
  it('does not learn a hashtag reduction produced by an AI revision, even after an owner edit',async()=>{
    const prepared=(await week()).find(p=>p.purpose.type==='offer');
    const post=db.data.content_posts.find(p=>p.id===prepared.id);
    Object.assign(post,{hashtags:['#lashes','#beauty','#lashlift'],prepared_hashtags:['#lashes','#beauty','#lashlift']});post.material_hash=materialHash(post);
    await service.edit(owner,post.id,{caption:post.caption.replace('Booking link is in my bio','Booking link is ready in my bio'),expected_version:post.version});
    const revisionService=createContentV2Service({db,now:()=>clock,autoKick:false,gapCalendar:async()=>({gaps}),freeSlots:async()=>slots,
      calendarBlocks:async()=>({closedDays:new Set(),dateHours:[]}),writer:{write:async p=>({caption:p.caption,hashtags:['#lashes']})}});
    const revised=await revisionService.revise(owner,post.id,'Use one hashtag');expect(revised.post.edited_by_owner).toBe(false);expect(revised.post.prepared_hashtags).toEqual(['#lashes']);
    const approved=await revisionService.approve(owner,post.id,revised.post.material_hash);expect(approved.learned_rules).toEqual([]);
  });
  it('rejects invalid hashtag input without saving it',async()=>{
    const post=(await week()).find(p=>p.purpose.type==='show_work');
    await expect(service.edit(owner,post.id,{caption:post.caption,hashtags:['#good','not a hashtag'],expected_version:post.version})).rejects.toMatchObject({status:400});
    expect((await service.getPost(owner,post.id)).hashtags).toEqual(post.hashtags);
  });
  it('keeps Instagram and the post queue available when Google cannot load',async()=>{
    await week();db.errors.set('google_review_connections',{code:'08006'});
    const home=await service.home(owner);expect(home.posts_to_check).toHaveLength(3);expect(home.connections.instagram.connected).toBe(true);
    expect(home.connections.google).toMatchObject({connected:false,unavailable:true});
  });
  it('rebuilds a designed image when a checked availability claim changes',async()=>{
    db.data.content_posts=[];
    const p=(await week()).find(p=>p.purpose.type==='fill_gap');expect(p.media.layout.lines[0]).toBe('From 2pm');
    await service.approve(owner,p.id,p.material_hash);
    gaps=[{date:'2026-11-26',start:'15:00',end:'18:00',duration_minutes:180}];slots=slots.slice(1);
    const moved=await service.recheckPost(owner,p.id);expect(moved.media.layout.lines[0]).toBe('From 3pm');
    expect(moved.image_url).toMatch(/generated/);expect(moved.material_hash).toBe(materialHash(moved));expect(moved.approved_hash).toBeNull();
  });
  it('rebuilds artwork when the diary changes while the writer is working',async()=>{
    db.data.content_posts=[];const rendered=[];
    const prepareService=createContentV2Service({db,now:()=>clock,autoKick:false,gapCalendar:async()=>({gaps}),freeSlots:async()=>slots,
      calendarBlocks:async()=>({closedDays:new Set(),dateHours:[]}),renderArtwork:async(o,p)=>{
        const marker=p.media?.layout?.lines?.[0] || 'generic';rendered.push(marker);return `https://example.com/${encodeURIComponent(marker)}.jpg`;
      },writer:{write:async p=>{gaps=[{date:'2026-11-26',start:'15:00',end:'18:00',duration_minutes:180}];slots=slots.slice(-1);return {caption:p.caption,hashtags:p.hashtags};}}});
    const request=await prepareService.prepare(owner,randomUUID(),{type:'week'});await prepareService.processPreparation(request);
    const post=db.data.content_posts.find(p=>p.purpose?.type==='fill_gap');expect(post.caption).toContain('from 3pm');
    expect(post.image_url).toContain('From%203pm');expect(rendered).toContain('From 2pm');expect(rendered).toContain('From 3pm');
  });
  it('preserves a legacy text draft and supplies a real designed image',async()=>{
    const post={id:randomUUID(),beautician_id:owner,post_type:'general',platform:'instagram',status:'draft',caption:'My saved words',hashtags:[],version:1,claims:[],history:[]};
    db.data.content_posts.push(post);
    const checked=await service.recheckPost(owner,post.id);expect(checked.caption).toBe('My saved words');expect(checked.image_url).toContain('/generated/');
    expect(checked.material_hash).toBe(materialHash(checked));expect(checked.status).toBe('draft');
  });
  it('rechecks withdrawn photo permission before marking a manual post',async()=>{
    const p=(await week()).find(p=>p.purpose.type==='show_work');await service.approve(owner,p.id,p.material_hash);
    db.data.photo_consents[0].revoked_at=NOW.toISOString();
    await expect(service.action(owner,p.id,'posted-by-owner')).rejects.toMatchObject({status:409,code:'facts_blocked'});
    expect(db.data.content_posts.find(row=>row.id===p.id).published_by_owner).not.toBe(true);
  });
  it('blocks a patch test deadline that passed before the appointment can be advertised',async()=>{
    gaps=[{date:'2026-11-23',start:'14:00',end:'18:00',duration_minutes:240}];slots=[{date:'2026-11-23',time:'14:00',iso:'2026-11-23T14:00:00Z'}];
    const p=(await week()).find(p=>p.purpose.type==='fill_gap');
    expect(p.facts.some(f=>f.key==='patch' && f.status==='block')).toBe(true);
    await expect(service.approve(owner,p.id,p.material_hash)).rejects.toMatchObject({code:'facts_blocked'});
  });
  it('keeps another salon out of posts, consent and photos',async()=>{
    const p=(await week())[0];await expect(service.getPost(other,p.id)).rejects.toMatchObject({status:404});
    await expect(service.savePhoto(owner,{id:randomUUID(),permission_status:'no_client'})).rejects.toMatchObject({status:404});
    await expect(service.savePhoto(owner,{id:photoId,client_id:other})).rejects.toMatchObject({status:400});
  });
  it('separates tracked confirmed bookings, pending and cancelled from inference',async()=>{
    const p=(await week()).find(p=>p.purpose.type==='show_work');Object.assign(db.data.content_posts.find(r=>r.id===p.id),{external_post_id:'confirmed',status:'posted',posted_at:'2026-11-21T18:00:00Z'});
    const campaign=db.data.content_campaigns.find(c=>c.post_id===p.id);
    for(const [status,cents] of [['confirmed',4500],['pending',5000],['cancelled_by_client',5000]]) {
      const id=randomUUID();db.data.appointments.push({id,beautician_id:owner,status,price_cents:cents,created_at:'2026-11-22T09:00:00Z',treatment_id:brow});
      db.data.content_booking_sources.push({appointment_id:id,beautician_id:owner,campaign_id:campaign.id});
    }
    db.data.appointments.push({id:randomUUID(),beautician_id:owner,status:'confirmed',price_cents:4500,created_at:'2026-11-22T10:00:00Z',treatment_id:brow});
    const report=await service.results(owner);expect(report.total).toEqual({bookings:1,value_pence:4500,pending:1,cancelled:1});expect(report.inferred).toHaveLength(1);expect(report.inferred[0].label).toBe('Not measured');
  });
  it('exposes the rollout flag but rejects owner writes to it',()=>{
    expect(sanitizeBeautician({id:owner,content_v2:true,instagram_page_token:'secret'})).toEqual({id:owner,content_v2:true});
    expect(profileUpdateSchema.safeParse({content_v2:true}).success).toBe(false);
  });
  it('keeps first visit manual, then prepares one weekly set with a stable request ID',async()=>{
    expect((await service.prepareOpportunities()).started).toEqual([]);
    const posts=await week();
    for(const post of posts.filter(p=>p.kind==='post')) await service.approve(owner,post.id,post.material_hash);
    db.data.content_preparations[0].created_at='2026-11-15T11:00:00Z';
    const first=await service.prepareOpportunities();expect(first.started).toHaveLength(1);expect(first.started[0].type).toBe('week');
    const automatic=db.data.content_preparations.find(p=>p.request.automatic);expect(automatic.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await service.prepareOpportunities()).started).toEqual([]);
    automatic.status='done';
    expect((await service.prepareOpportunities()).started).toEqual([]);
  });
  it('does not prepare in the background for disabled salons or an unchecked backlog',async()=>{
    await week();
    expect((await service.prepareOpportunities()).started).toEqual([]);
    db.data.content_posts=db.data.content_posts.filter(p=>p.post_type==='gallery');
    db.data.beauticians[0].content_v2=false;
    expect((await service.prepareOpportunities()).started).toEqual([]);
  });
  it('prepares an unused permitted photo once after the current queue is checked',async()=>{
    const posts=await week();for(const post of posts.filter(p=>p.kind==='post')) await service.approve(owner,post.id,post.material_hash);
    const fresh={...db.data.content_posts.find(p=>p.id===photoId),id:randomUUID()};db.data.content_posts.push(fresh);
    const result=await service.prepareOpportunities();expect(result.started).toHaveLength(1);expect(result.started[0].type).toBe('show_work');
    const preparation=db.data.content_preparations.find(p=>p.request.automatic);expect(preparation.request.photo_ids).toEqual([fresh.id]);
    await service.processPreparation(preparation);
    expect((await service.prepareOpportunities()).started).toEqual([]);
  });
});
describe('writing and state invariants',()=>{
  it('rejects invented money, dropped claims, dashes and false weekdays then falls back after two attempts',async()=>{
    const post={caption:'Thursday from 2pm. It is £45.',claims:[{text:'from 2pm'},{text:'£45'}],hashtags:[]};
    for(const caption of ['Thursday from 2pm. £45 or £20.','Thursday. £45.','Thursday from 2pm. £45 \u2014 book.','Friday from 2pm. £45.']) expect(validateWriting({caption,hashtags:[]},post)).toBe(false);
    const model=vi.fn(async()=>({caption:'Friday costs £20.',hashtags:[]}));
    const result=await createWriter({model}).write(post,{profile:{},rules:[],posts:[]});expect(model).toHaveBeenCalledTimes(2);expect(result.caption).toBe(post.caption);
  });
  it('ignores timing in approval hash and never claims posted without evidence',()=>{
    const post={caption:'A post',hashtags:[],media:{type:'layout',layout:{kind:'offer',title:'Offer'}},platform:'instagram'};
    expect(materialHash({...post,scheduled_for:'2026-12-01T12:00:00Z'})).toBe(materialHash(post));
    expect(ownerState({...post,status:'posted'})).not.toBe('Posted');expect(ownerState({...post,external_post_id:'confirmed'})).toBe('Posted');
    expect(postgresJson({aa:'x',b:'y'})).toBe('{"b": "y", "aa": "x"}');
  });
});
