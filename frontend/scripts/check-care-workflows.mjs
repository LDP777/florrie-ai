import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import http from 'node:http';
import { launch } from './lib/browser.mjs';
import { fetchStubSource, sessionSeedSource, bundleSupabaseUrl } from './lib/fixtures.mjs';
const dist = new URL('../dist', import.meta.url).pathname;
const server = http.createServer((req,res) => {
  let file=join(dist,(req.url||'/').split('?')[0]);
  if(!existsSync(file)||!extname(file)) file=join(dist,'index.html');
  res.setHeader('content-type',({'.js':'text/javascript','.css':'text/css','.html':'text/html'})[extname(file)]||'application/octet-stream');
  try{res.end(readFileSync(file));}catch{res.statusCode=404;res.end();}
}).listen(0);
const browser=await launch();
const errors=[];
const shots=process.env.CARE_SCREENSHOT_DIR;
if (shots) mkdirSync(shots,{recursive:true});
try {
  const ctx=await browser.newContext({viewport:{width:390,height:844}});
  await ctx.addInitScript(fetchStubSource());
  await ctx.addInitScript(sessionSeedSource(bundleSupabaseUrl(dist)));
  await ctx.addInitScript(() => {
    const base=window.fetch;
    const person={id:'care-client',beautician_id:'b1',first_name:'Care',last_name:'Fixture',phone:'07700900111',total_visits:4,total_spend_cents:4000};
    window.__care={failRecords:true,failSignature:true,failSubmit:true,submissions:[],sends:[]};
    const signatureCanvas=document.createElement('canvas');signatureCanvas.width=280;signatureCanvas.height=70;
    const ink=signatureCanvas.getContext('2d');ink.font='italic 28px cursive';ink.fillStyle='#241B17';ink.fillText('Care Fixture',12,44);
    const signature=signatureCanvas.toDataURL('image/png');
    const answer={id:'completed',form_id:'brow',form_name:'Brow consultation',completed_at:'2026-08-01T12:00:00Z',has_signature:true,consent_text:'Original consent wording',pairs:[{field_id:'allergies',type:'text',question:'Any allergies?',answer:'Latex',answered:true}],worth_knowing:['Latex recorded']};
    window.fetch=(input,opts={}) => {
      const url=String(input), method=opts.method||'GET';
      const json=(body,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}}));
      if(url.includes('/rest/v1/clients?')) return json([person]);
      if(url.includes('/rest/v1/appointments?')||url.includes('/rest/v1/messages?')||url.includes('/rest/v1/loyalty_points?')) return json([]);
      if(url.includes('/api/consultation-forms/responses/list')) {
        if(window.__care.failRecords) return json({error:'Synthetic record read failure'},500);
        return json({responses:[answer],requests:[{id:'pending',form_id:'waiting',form_name:'Awaiting consultation',status:'pending',sent_at:'2026-09-01T12:00:00Z',expires_at:'2099-01-01'},{id:'expired',form_id:'expired',form_name:'Expired consultation',status:'expired',sent_at:'2020-01-01',expires_at:'2020-01-08'},...window.__care.sends.map((s,i)=>({id:`sent-${i}`,form_id:s.form_id,form_name:'New consultation',status:'pending',sent_at:'2026-09-05',expires_at:'2099-01-01'}))],templates:[{id:'new',name:'New consultation',is_default:true},{id:'waiting',name:'Awaiting consultation'}]});
      }
      if(url.includes('/api/consultation-forms/responses/completed')) return window.__care.failSignature?json({error:'Synthetic signature failure'},500):json({response:{signature_data:signature}});
      if(url.endsWith('/api/consultation-forms/send')&&method==='POST'){window.__care.sends.push(JSON.parse(opts.body));return json({sent:true});}
      if(url.includes('/api/consultation-forms/public/care-token')) {
        if(method==='POST'){window.__care.submissions.push(JSON.parse(opts.body));return window.__care.failSubmit?json({error:'Synthetic save failure; try again.'},500):json({success:true});}
        return json({form:{name:'Care consultation',consent_text:'Please review these answers.',fields:[{id:'allergy',type:'text',label:'Any allergies?',required:true},{id:'signature',type:'signature',label:'Client signature',required:true}]},client_name:'Care',beautician:{name:'Fixture Salon',brand_color:'#92405e'}});
      }
      return base(input,opts);
    };
  });
  const page=await ctx.newPage();page.on('pageerror',error=>errors.push(error.message));
  const origin=`http://127.0.0.1:${server.address().port}`;
  await page.goto(`${origin}/clients`);
  await page.getByRole('button',{name:/Care Fixture/}).click();
  await page.getByText('Could not load consultation records.',{exact:true}).waitFor();
  await page.evaluate(()=>{window.__care.failRecords=false;});
  await page.getByRole('button',{name:'Retry records',exact:true}).click();
  await page.getByText('Brow consultation',{exact:true}).waitFor();
  await page.getByText(/Link expired/).waitFor();
  await page.getByText(/Awaiting response/).waitFor();
  await page.locator('summary').filter({hasText:'Brow consultation'}).click();
  await page.getByText('Latex',{exact:true}).waitFor();
  await page.getByText('Original consent wording',{exact:true}).waitFor();
  await page.getByRole('button',{name:'View signature',exact:true}).click();
  await page.getByText('Could not load the signature. Try again.',{exact:true}).waitFor();
  await page.evaluate(()=>{window.__care.failSignature=false;});
  await page.getByRole('button',{name:'View signature',exact:true}).click();
  await page.getByAltText('Client signature',{exact:true}).waitFor();
  if (shots) {
    await page.locator('section[aria-label="Client care records"]').screenshot({path:join(shots,'care-client-record-390.png')});
    await page.setViewportSize({width:1280,height:900});
    await page.locator('section[aria-label="Client care records"]').screenshot({path:join(shots,'care-client-record-1280.png')});
    await page.setViewportSize({width:390,height:844});
  }
  await page.getByLabel('Send a form',{exact:true}).selectOption('waiting');
  assert.equal(await page.getByRole('button',{name:'Already awaiting a response',exact:true}).isDisabled(),true);
  await page.getByLabel('Send a form',{exact:true}).selectOption('new');
  await page.getByRole('button',{name:'Send form by text',exact:true}).click();
  await page.getByRole('button',{name:'Already awaiting a response',exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.__care.sends),[{client_id:'care-client',form_id:'new'}]);
  await page.getByRole('button',{name:'Patch tests',exact:true}).click();
  assert.equal(new URL(page.url()).searchParams.get('clientId'),'care-client');
  await page.goBack();
  if (!await page.getByRole('button',{name:'Photo consent',exact:true}).count()) await page.getByRole('button',{name:/Care Fixture/}).click();
  await page.getByRole('button',{name:'Photo consent',exact:true}).click();
  assert.equal(new URL(page.url()).searchParams.get('clientId'),'care-client');
  console.log('✓ Client record: load retry, pending/expired, original answers/consent, signature retry, chosen-template send and patch-test identity');
  await page.goto(`${origin}/form/care-token`);
  await page.getByLabel('Any allergies?',{exact:false}).fill('Latex');
  await page.getByRole('button',{name:'Submit Form',exact:true}).click();
  await page.getByText('Please complete all required fields marked with *',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.__care.submissions.length),0);
  const canvas=page.locator('canvas[aria-label="Client signature"]');
  await canvas.scrollIntoViewIfNeeded();const box=await canvas.boundingBox();
  await page.mouse.move(box.x+20,box.y+30);await page.mouse.down();await page.mouse.move(box.x+70,box.y+55,{steps:8});await page.mouse.up();
  if (shots) {
    await page.screenshot({path:join(shots,'care-public-signature-390.png'),fullPage:true});
    await page.setViewportSize({width:1280,height:900});
    await page.screenshot({path:join(shots,'care-public-signature-1280.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
  }
  await page.getByRole('button',{name:'Submit Form',exact:true}).click();
  await page.getByText('Synthetic save failure; try again.',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Any allergies?',{exact:false}).inputValue(),'Latex');
  assert.equal(await page.getByRole('button',{name:'Clear signature',exact:true}).count(),1);
  const sent=await page.evaluate(()=>window.__care.submissions[0]);assert.equal(sent.answers.allergy,'Latex');assert.match(sent.signature_data,/^data:image\/png;base64,/);
  await page.evaluate(()=>{window.__care.failSubmit=false;});
  await page.getByRole('button',{name:'Submit Form',exact:true}).click();
  await page.getByText('All done!',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.__care.submissions.length),2);
  assert.deepEqual(errors,[]);
  console.log('✓ Public form: populated signature renders, required signature prevents unsigned submit, failed save keeps answers/signature, retry completes');
  await ctx.close();
} finally {await browser.close();server.close();}
