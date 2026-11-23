import { createClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it } from 'vitest';
import { readReviewRequestSettings, saveReviewRequestSettings } from '../../src/services/review-request-settings.js';
import { completedVisitReviewLink } from '../../src/lib/review-visit.mjs';

let rows, failWrite, conflict;
const link = 'https://g.page/r/fictional/review';
function db() { return {from() {
  const predicates=[]; let payload;
  const q={select(){return q;},eq(k,v){predicates.push(r=>JSON.stringify(r[k])===(k==='autonomy'?v:JSON.stringify(v)));return q;},is(k,v){predicates.push(r=>r[k]==v);return q;},update(p){payload=p;return q;},async maybeSingle(){
    if(payload && failWrite) return {error:new Error('Offline')};
    if(payload && conflict) { rows[0].autonomy={...rows[0].autonomy,gap_fill:'off'}; if(conflict==='always')return {data:null};conflict=false; }
    const row=rows.find(r=>predicates.every(p=>p(r)));
    if(row && payload)Object.assign(row,payload);
    return {data:row?structuredClone(row):null};
  }};return q;
}}; }
beforeEach(()=>{rows=[{id:'salon',autonomy:{grounded_replies:false},google_review_link:link}];failWrite=false;conflict=false;});
describe('owner-controlled review automation',()=>{
  it('reports existing manual requests without implying automatic visits are enabled',async()=>{expect(await readReviewRequestSettings(db(),'salon')).toEqual({mode:'ask',startedAt:null,hasLink:true,paused:false});});
  it('requires a valid link and a supported mode',async()=>{
    await expect(saveReviewRequestSettings(db(),'salon','yes')).rejects.toMatchObject({status:400});rows[0].google_review_link=null;
    await expect(saveReviewRequestSettings(db(),'salon','auto')).rejects.toMatchObject({status:409});
    expect((await saveReviewRequestSettings(db(),'salon','off')).mode).toBe('off');
  });
  it('starts from now, preserves unrelated controls and resets activation when re-enabled',async()=>{
    const start=Date.parse('2026-11-23T10:00:00Z');
    expect((await saveReviewRequestSettings(db(),'salon','ask',start)).startedAt).toBe(new Date(start).toISOString());
    expect(rows[0].autonomy.grounded_replies).toBe(false);
    expect((await saveReviewRequestSettings(db(),'salon','auto',start+1000)).startedAt).toBe(new Date(start).toISOString());
    await saveReviewRequestSettings(db(),'salon','off',start+2000);
    expect((await saveReviewRequestSettings(db(),'salon','auto',start+3000)).startedAt).toBe(new Date(start+3000).toISOString());
  });
  it('never writes another salon and never reports success on storage failure',async()=>{
    await expect(saveReviewRequestSettings(db(),'other','auto')).rejects.toMatchObject({status:404});
    failWrite=true;await expect(saveReviewRequestSettings(db(),'salon','auto')).rejects.toThrow('Offline');expect(rows[0].autonomy.review_request).toBeUndefined();
  });
  it('preserves another settings edit during a concurrent save',async()=>{conflict=true;await saveReviewRequestSettings(db(),'salon','ask');expect(rows[0].autonomy).toMatchObject({review_request:'ask',gap_fill:'off',grounded_replies:false});});
  it('refuses persistent concurrent writes',async()=>{conflict='always';await expect(saveReviewRequestSettings(db(),'salon','ask')).rejects.toMatchObject({status:409});});
});
describe('public review button',()=>{
  const visit={status:'completed',starts_at:'2026-11-22T12:00:00Z',beauticians:{google_review_link:link},treatments:{name:'Brows'}};
  const now=Date.parse('2026-11-23T12:00:00Z');
  it('gives a completed visitor the salon’s validated Google link',()=>{expect(completedVisitReviewLink(visit,now)).toBe(link);});
  it.each(['confirmed','cancelled','no_show','pending'])('does not ask for a review for %s',status=>{expect(completedVisitReviewLink({...visit,status},now)).toBeNull();});
  it('does not invent a link or ask after a patch test or future visit',()=>{
    expect(completedVisitReviewLink({...visit,beauticians:{}},now)).toBeNull();
    expect(completedVisitReviewLink({...visit,treatments:{name:'Patch test'}},now)).toBeNull();
    expect(completedVisitReviewLink({...visit,starts_at:'2026-11-24T12:00:00Z'},now)).toBeNull();
  });
});


it('serializes the concurrency check as PostgREST JSON, using the real client',async()=>{
  const requests=[];
  const client=createClient('https://fixture.invalid','fixture-key',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(input,options)=>{
    const url=new URL(input);requests.push({method:options.method,filter:url.searchParams.get('autonomy')});
    if(options.method==='PATCH')return new Response(JSON.stringify({...rows[0],...JSON.parse(options.body)}),{status:200,headers:{'content-type':'application/json'}});
    return new Response(JSON.stringify(rows[0]),{status:200,headers:{'content-type':'application/json'}});
  }}});
  await saveReviewRequestSettings(client,'salon','ask');
  expect(requests.find(r=>r.method==='PATCH').filter).toBe('eq.{"grounded_replies":false}');
});
