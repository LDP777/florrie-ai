import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import http from 'node:http';
import { launch } from './lib/browser.mjs';
import { fetchStubSource, sessionSeedSource, bundleSupabaseUrl } from './lib/fixtures.mjs';
const dist = new URL('../dist', import.meta.url).pathname;
const shots=process.env.CARE_SCREENSHOT_DIR;
if (shots) mkdirSync(shots,{recursive:true});
const server=http.createServer((req,res)=>{
  let file=join(dist,(req.url||'/').split('?')[0]);if(!existsSync(file)||!extname(file)) file=join(dist,'index.html');
  res.setHeader('content-type',({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'})[extname(file)]||'application/octet-stream');
  try{res.end(readFileSync(file));}catch{res.statusCode=404;res.end();}
}).listen(0);
const browser=await launch();const errors=[];
try {
  const ctx=await browser.newContext({viewport:{width:390,height:844}});
  await ctx.addInitScript(fetchStubSource());await ctx.addInitScript(sessionSeedSource(bundleSupabaseUrl(dist)));
  await ctx.addInitScript(()=>{
    const base=window.fetch;
    const state=window.__preparation={stage:'needed',answers:{},revision:0,outcome:null,completed:false,review:false,failDraft:true,failSubmit:true,failChecklist:false,submits:[],patchBookings:0};
    const slot='2030-09-13T09:00:00Z';const readyAt=new Date(Date.now()+86400000).toISOString();
    const patch=()=>({state:state.stage,required:true,can_complete:state.stage==='ready',booked_at:slot,ready_at:state.stage==='ready'?new Date(Date.now()-1000).toISOString():state.stage==='waiting'?readyAt:undefined,evidence:[],timezone:'Europe/London'});
    window.fetch=(input,opts={})=>{
      const url=String(input),method=opts.method||'GET';
      const json=(body,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}}));
      if(url.endsWith('/api/booking/salon/manage/manage/preparation')) return state.failChecklist?json({error:'Checklist temporarily unavailable. Your booking is still available.'},503):json({preparation:{confirmed:true,required:true,patch:patch(),forms:[{id:'brow-form',name:'Brow consultation',available:true,status:state.completed?'received':'pending',review_required:state.review}]}});
      if(url.endsWith('/api/booking/salon/manage/manage')) return json({appointment:{id:'booking',status:'confirmed',startsAt:'2030-09-16T12:00:00Z',endsAt:'2030-09-16T13:00:00Z',depositPaid:true,treatment:{id:'brow',name:'Signature brows',price_cents:3000,duration_minutes:60},treatments:[{id:'brow',name:'Signature brows'}],client:{name:'Care Fixture'},beautician:{name:'Fixture Salon',brandColor:'#92405e'}},policy:{},patchTests:state.stage==='needed'?[{id:'request',status:'pending',result:'pending',appointment_id:null,parent_appointment_id:'booking'}]:[{id:'patch',status:'pending',confirmed_at:'2030-09-11T10:00:00Z',suggested_slot:slot}],needsPatchTest:state.stage==='needed',patchTest:{required:true,certainty:state.stage==='needed'?'new_client':'recorded'},pendingForms:[]});
      if(url.endsWith('/patch-test/slots')) return json({slots:[slot],duration_minutes:10,lead_hours:48});
      if(url.endsWith('/patch-test/confirm')&&method==='POST'){assertFixture(JSON.parse(opts.body).slot===slot);state.stage='booked';state.patchBookings++;return json({success:true});}
      if(url.endsWith('/consultations/brow-form/start')) return json(state.completed?{completed:true}:{token:'care-form'});
      if(url.includes('/api/consultation-forms/public/care-form')) {
        if(url.endsWith('/draft')){if(state.failDraft)return json({error:'Synthetic save failure. Your answers are still here.'},503);const body=JSON.parse(opts.body);state.answers=body.answers;state.outcome=body.patch_outcome;state.review=body.patch_outcome==='reaction';state.revision++;return json({saved:true,revision:state.revision,preparation:patch(),review_required:state.review});}
        if(url.endsWith('/submit')){const body=JSON.parse(opts.body);state.submits.push(body);if(state.failSubmit)return json({error:'Synthetic final save failure. Please try again.'},503);state.completed=true;state.review=body.patch_outcome!=='no_reaction';return json({success:true,review_required:state.review});}
        return json(state.completed?{completed:true}:{form:{name:'Brow consultation',fields:[{id:'allergy',type:'text',label:'Any allergies?',required:true},{id:'sig',type:'signature',label:'Your signature',required:true}]},client_name:'Care',beautician:{name:'Fixture Salon',brand_color:'#92405e'},preparation:patch(),draft:{answers:state.answers,revision:state.revision,patch_outcome:state.outcome}});
      }
      return base(input,opts);
    };
    function assertFixture(ok){if(!ok)throw new Error('Unexpected patch-test slot');}
  });
  const page=await ctx.newPage();page.on('pageerror',err=>errors.push(err.message));
  const checklist=page.getByRole('region',{name:'Before your appointment',exact:true});
  await page.goto(`http://127.0.0.1:${server.address().port}/book/salon/manage/manage`);
  await checklist.getByRole('heading',{name:'Book your patch test',exact:true}).waitFor();
  await checklist.getByRole('button',{name:'Book your patch test',exact:true}).click();
  await page.getByRole('button',{name:'09:00',exact:true}).click();
  await page.getByRole('button',{name:'Confirm my patch test',exact:true}).click();
  await checklist.getByRole('heading',{name:'Patch test booked',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.__preparation.patchBookings),1);
  assert.equal(await checklist.getByRole('button',{name:'Complete consultation',exact:true}).count(),0);
  if(shots)await checklist.screenshot({path:join(shots,'booking-preparation-booked-390.png')});
  await checklist.getByRole('button',{name:'Save answers or report a concern',exact:true}).click();
  await page.getByLabel('Any allergies?',{exact:false}).fill('None');
  assert.equal(await page.getByRole('button',{name:'Sign after your waiting period',exact:true}).isDisabled(),true);
  assert.equal(await page.locator('canvas').count(),0);
  await page.getByRole('button',{name:'Save answers',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Synthetic save failure'}).waitFor();
  assert.equal(await page.getByLabel('Any allergies?',{exact:false}).inputValue(),'None');
  await page.evaluate(()=>{window.__preparation.failDraft=false;});
  await page.getByRole('button',{name:'Save answers',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Answers saved'}).waitFor();
  // A booked patch visit has no ready_at yet. Returning to the open draft
  // after the tech records it must update the waiting period without losing answers.
  await page.evaluate(()=>{window.__preparation.stage='waiting';window.dispatchEvent(new Event('focus'));});
  await page.getByText(/You can sign after/).waitFor();
  assert.equal(await page.getByLabel('Any allergies?',{exact:false}).inputValue(),'None');
  await page.getByRole('button',{name:'Back to my booking',exact:true}).click();
  await page.evaluate(()=>{window.__preparation.stage='waiting';window.dispatchEvent(new Event('focus'));});
  await checklist.getByRole('heading',{name:'Your 48-hour waiting period',exact:true}).waitFor();
  await checklist.getByRole('button',{name:'Save answers or report a concern',exact:true}).click();
  await page.getByLabel('Any allergies?',{exact:false}).waitFor();
  assert.equal(await page.getByLabel('Any allergies?',{exact:false}).inputValue(),'None');
  await page.evaluate(()=>{window.__preparation.stage='ready';window.dispatchEvent(new Event('focus'));});
  await page.getByRole('radio',{name:'I’m not sure',exact:true}).check();
  const canvas=page.getByLabel('Your signature',{exact:true});await canvas.waitFor();await canvas.scrollIntoViewIfNeeded();
  const box=await canvas.boundingBox();await page.mouse.move(box.x+20,box.y+30);await page.mouse.down();await page.mouse.move(box.x+80,box.y+60,{steps:8});await page.mouse.up();
  await page.getByRole('button',{name:'Submit Form',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Synthetic final save failure'}).waitFor();
  assert.equal(await page.getByLabel('Any allergies?',{exact:false}).inputValue(),'None');
  await page.evaluate(()=>{window.__preparation.failSubmit=false;});
  await page.getByRole('button',{name:'Submit Form',exact:true}).click();
  await page.getByRole('heading',{name:'Consultation received',exact:true}).waitFor();
  await page.getByRole('button',{name:'Back to my booking',exact:true}).click();
  await checklist.getByRole('heading',{name:'Consultation received',exact:true}).waitFor();
  await checklist.getByText('Your tech has been asked to review your answers before treatment.',{exact:true}).waitFor();
  const submitted=await page.evaluate(()=>window.__preparation.submits.at(-1));
  assert.equal(submitted.patch_outcome,'unsure');assert.equal(submitted.revision,1);assert.ok(submitted.signature_data.startsWith('data:image/png;base64,'));
  if(shots)await checklist.screenshot({path:join(shots,'booking-preparation-received-390.png')});
  await page.evaluate(()=>{window.__preparation.failChecklist=true;window.dispatchEvent(new Event('focus'));});
  await checklist.getByRole('button',{name:'Retry checklist',exact:true}).waitFor();
  await page.getByText('Signature brows',{exact:true}).waitFor();
  await page.evaluate(()=>{window.__preparation.failChecklist=false;});
  await checklist.getByRole('button',{name:'Retry checklist',exact:true}).click();
  await checklist.getByRole('heading',{name:'Consultation received',exact:true}).waitFor();
  for(const width of [390,1280]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);}
  assert.deepEqual(errors,[]);
  console.log('PASS: booking → suitable patch slot → booked → saved answers with failure/retry → 48-hour wait → outcome and signature → received/review flag; checklist failure keeps booking visible; mobile/desktop overflow');
  await ctx.close();
} finally {await browser.close();server.close();}
