import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { launch } from './lib/browser.mjs';
import { bundleSupabaseUrl } from './lib/fixtures.mjs';
import { calendarFixtureSource } from './lib/calendar-fixtures.mjs';
const dist = new URL('../dist/', import.meta.url).pathname;
const output = process.env.CANCELLATION_SCREENSHOT_DIR;
if (output) mkdirSync(output, { recursive: true });
const server=http.createServer((req,res)=>{let f=join(dist,(req.url||'/').split('?')[0]);if(!existsSync(f)||!extname(f))f=join(dist,'index.html');res.setHeader('content-type',({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'})[extname(f)]||'application/octet-stream');try{res.end(readFileSync(f));}catch{res.statusCode=404;res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await launch();let groups=0;
async function check(hidden=false,fail=false){
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 await context.route('**/*',r=>new URL(r.request().url()).origin===origin&&r.request().method()==='GET'?r.continue():r.abort());
 await context.addInitScript(calendarFixtureSource(bundleSupabaseUrl(dist),'populated'));
 await context.addInitScript(({hidden,fail})=>{
  // The calendar fixture freezes August; these payment examples are November.
  // Align the clock so a recorded fee is not correctly rejected as future income.
  const CalendarDate=Date;
  window.Date=class extends CalendarDate {
   constructor(...args){super(...(args.length?args:['2026-11-17T12:00:00Z']));}
   static now(){return new CalendarDate('2026-11-17T12:00:00Z').getTime();}
  };
  localStorage.setItem('florrie:hide-client-details:v1',String(hidden));
  const old=window.fetch;let reads=0;window.__feeWrites=[];
  const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json',...(Array.isArray(v)?{'content-range':`0-${Math.max(0,v.length-1)}/${v.length}`}:{})}});
  const payments=[
   {appointmentId:'paid',clientName:'Fictional Alex',startsAt:'2026-11-17T12:45:00Z',payment:{status:'collected',label:'Collected',amountCents:2400,collectedAt:'2026-11-09T20:20:24Z',message:'This fee is recorded as collected. No further payment has been taken for this cancellation.'}},
   {appointmentId:'pending',clientName:'Fictional Morgan',startsAt:'2026-11-18T11:00:00Z',payment:{status:'pending',label:'Pending',amountCents:1200,message:'Payment is awaiting confirmation. Do not collect it again while this is being checked.'}},
   {appointmentId:'declined',clientName:'Fictional Jamie',startsAt:'2026-11-18T13:00:00Z',payment:{status:'needs_attention',label:'Needs attention',amountCents:1800,message:'The card was declined. Arrange another payment method.'}},
  ];
  window.fetch=async(input,opts={})=>{const u=new URL(typeof input==='string'?input:input.url,location.href);if(!['GET','HEAD','OPTIONS'].includes(opts.method||'GET')){window.__feeWrites.push(u.pathname);return json({},409);}
   if(u.pathname==='/api/appointments/cancellation-payments'){reads++;return fail&&reads===1?json({error:'Fixture unavailable'},503):json({payments});}
   if(u.pathname==='/rest/v1/transactions')return json([{id:'tx',type:'late_cancel_fee',amount_cents:2400,status:'completed',payment_method:'card_online',stripe_payment_intent_id:'pi_fixture',created_at:'2026-11-09T20:20:24Z',appointments:{clients:{first_name:'Fictional Alex'},treatments:{name:'Brow treatment'}}}]);
   return old(input,opts);
  };
 },{hidden,fail});
 const page=await context.newPage();page.setDefaultTimeout(12000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(origin+'/money?tab=income');
  await page.locator('summary').filter({hasText:'Cancellation fees'}).click();
  if(fail){await page.getByRole('alert').filter({hasText:'Couldn’t check cancellation payments'}).waitFor();assert.equal(await page.getByText('Cancellation fee · Collected',{exact:true}).count(),0);await page.getByRole('button',{name:'Refresh',exact:true}).click();}
  await page.getByText('Cancellation fee · Collected',{exact:true}).waitFor();
  await page.getByText('Cancellation fee · Pending',{exact:true}).waitFor();
  await page.getByText('Cancellation fee · Needs attention',{exact:true}).waitFor();
  assert.match(await page.locator('body').innerText(),/Collected on 9 November 2026/);
  assert.match(await page.locator('body').innerText(),/Cancellation fee · Card/);
  const body=await page.locator('body').innerText();if(hidden)assert.doesNotMatch(body,/Fictional|24\.00|12\.00|18\.00/);else assert.match(body,/Fictional Alex/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  assert.deepEqual(await page.evaluate(()=>window.__feeWrites),[]);assert.deepEqual(errors,[]);
  if(output&&!fail)await page.getByRole('region',{name:'Cancellation fees',exact:true}).evaluate(el=>el.scrollIntoView({block:'start'}));
  if(output&&!fail)await page.screenshot({path:join(output,hidden?'cancellation-payments-private.png':'cancellation-payments-mobile.png'),fullPage:true});
  groups++;console.log(`✓ Cancellation payment statuses: privacy=${hidden}, recovery=${fail}`);
 }finally{await context.close();}
}
try{await check();await check(true);await check(false,true);console.log(`${groups} cancellation payment browser groups passed.`);}finally{await browser.close();await new Promise(r=>server.close(r));}
