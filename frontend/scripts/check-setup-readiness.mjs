import assert from 'node:assert/strict';
import { build } from 'esbuild';
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { launch } from './lib/browser.mjs';
import { setupChecklist, replySettings } from '../../backend/src/lib/setup-readiness.js';
const root = new URL('../', import.meta.url).pathname;
const owner = {id:'salon-one',auth_id:'user-one',business_name:'Fictional Brow Studio',booking_policy:{cancellation_notice_hours:48,late_cancel_charge_percent:100}};
const status = {business:{name:true,hours:false,booking_slug:true,slug:'fictional-studio'},services:{bookable_count:2,incomplete_count:0,missing_forms:0,deposits:false},money:{stripe:false},channels:{test_receipt:false},replies:replySettings(owner)};
status.readiness = setupChecklist(status,owner);
const store = `
import {useState} from 'react';
window.fixture={owner:${JSON.stringify(owner)},status:${JSON.stringify(status)},received:false,failProof:false,failSetup:false,hold:false,requests:[],listeners:new Set()};
window.fetch=async(url,options={})=>{const parsed=new URL(url,location.origin);fixture.requests.push({path:parsed.pathname,method:options.method||'GET'});if(fixture.hold){fixture.hold=false;await new Promise(r=>fixture.release=r);}return Response.json(parsed.pathname.endsWith('/status')?fixture.status:{received:fixture.received,received_at:fixture.received?new Date().toISOString():null},{status:parsed.pathname.endsWith('/status')?(fixture.failSetup?503:200):(fixture.failProof?503:200)});};
export const supabase={auth:{getSession:async()=>({data:{session:{access_token:'fixture',user:{id:fixture.owner.auth_id}}}}),refreshSession:async()=>({data:{session:{access_token:'fixture',user:{id:fixture.owner.auth_id}}}}),onAuthStateChange:fn=>{fixture.listeners.add(fn);return {data:{subscription:{unsubscribe:()=>fixture.listeners.delete(fn)}}};}}};
export function useBeautician(){const [value,set]=useState(fixture.owner);fixture.changeOwner=()=>{fixture.owner={id:'salon-two',auth_id:'user-two'};for(const fn of fixture.listeners)fn('SIGNED_OUT',null);set(fixture.owner);};return {beautician:value};}
`;
const entry=`import React from 'react';import{createRoot}from'react-dom/client';import{BrowserRouter,useLocation}from'react-router-dom';import Setup from './src/pages/SetupHub.jsx';import Proof from './src/components/ChannelProof.jsx';import {supabase}from './src/lib/supabase.js';function App(){return useLocation().pathname==='/proof'?<Proof ownerId="salon-one" channel="instagram" auth={supabase.auth}/>:<Setup/>}createRoot(document.getElementById('root')).render(<BrowserRouter><App/></BrowserRouter>);`;
const bundle=await build({stdin:{contents:entry,resolveDir:root,loader:'jsx'},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',define:{'import.meta.env':'{}'},plugins:[{name:'fixture',setup(b){b.onResolve({filter:/\/lib\/(supabase|config)\.js$/},args=>({path:basename(args.path),namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({resolveDir:root,contents:path==='supabase.js'?store:'export const API_BASE="";',loader:'js'}));}}]});
const tokens=[...readFileSync(join(root,'index.html'),'utf8').matchAll(/<style>([\s\S]*?)<\/style>/g)].map(x=>x[1]).join('\n');
const css=readFileSync(join(root,'src/index.css'),'utf8').replace(/@import\s+url\([^;]+;/g,'');
const fontDir=process.env.VISUAL_FONT_DIR, fontCss=fontDir?readFileSync(join(fontDir,'fonts.css'),'utf8'):'';
const server=http.createServer((req,res)=>{
  if(req.url==='/bundle.js'){res.setHeader('content-type','text/javascript');return res.end(bundle.outputFiles[0].text);}
  if(req.url.startsWith('/fonts/')&&fontDir){const file=join(fontDir,basename(req.url));if(existsSync(file)){res.setHeader('content-type','font/woff2');return res.end(readFileSync(file));}}
  res.setHeader('content-type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+tokens+css+fontCss+'body{margin:0}#root{padding-bottom:60px}.mc-proof{padding:24px;max-width:580px;margin:auto}.mc-proof p{line-height:1.6}.mc-actions{display:flex;flex-wrap:wrap;gap:12px}</style><div id="root"></div><script src="/bundle.js"></script>');
}).listen(0);
const browser=await launch(),origin=`http://127.0.0.1:${server.address().port}`;
try {
  const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
  await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
  const page=await context.newPage();page.setDefaultTimeout(8000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/setup');await page.getByRole('heading',{name:'Make Florrie yours.'}).waitFor();
  await page.getByRole('link',{name:'Continue setup'}).waitFor();assert.equal(await page.getByRole('link',{name:'Continue setup'}).getAttribute('href'),'/settings?section=hours');
  await page.getByText(/48 hours’ notice. Late-cancellation fee: 100%/).waitFor();
  assert.equal(await page.evaluate(()=>fixture.requests.some(r=>r.method!=='GET')),false);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  if(process.env.SETUP_PROOF_DIR){mkdirSync(process.env.SETUP_PROOF_DIR,{recursive:true});await page.screenshot({path:join(process.env.SETUP_PROOF_DIR,'setup-mobile.png'),fullPage:true});}
  await page.evaluate(()=>{fixture.failSetup=true;});await page.getByRole('button',{name:'Refresh checks'}).click();await page.getByRole('alert').waitFor();assert.equal(await page.getByRole('link',{name:'Continue setup'}).count(),0);
  await page.evaluate(()=>{fixture.failSetup=false;fixture.status.readiness.items[1].state='unknown';});await page.getByRole('button',{name:'Try again'}).click();await page.getByText('Not checked',{exact:true}).waitFor();
  // A late response belonging to the old identity must not restore its screen.
  await page.evaluate(()=>{fixture.hold=true;});await page.getByRole('button',{name:'Refresh checks'}).click();await page.waitForFunction(()=>!!fixture.release);
  await page.evaluate(()=>{fixture.failSetup=true;fixture.changeOwner();fixture.release();});await page.getByRole('alert').waitFor();assert.equal(await page.getByText(/florrie.ai\/book\/fictional-studio/).count(),0);
  console.log('PASS: checklist explains next step, failed checks and cancellation terms; account changes discard late results');
  await page.goto(origin+'/proof');await page.getByRole('button',{name:'Start Instagram check'}).click();const code=await page.locator('code').innerText();assert.match(code,/^FLORRIE-[A-F0-9]{12}$/);
  await page.reload();assert.equal(await page.locator('code').innerText(),code);await page.getByRole('button',{name:'Check it arrived'}).click();await page.getByRole('status').filter({hasText:'haven’t received'}).waitFor();
  await page.evaluate(()=>{fixture.failProof=true;});await page.getByRole('button',{name:'Check it arrived'}).click();await page.getByRole('alert').waitFor();assert.equal(await page.getByRole('link',{name:'Open Inbox'}).count(),0);
  await page.evaluate(()=>{fixture.failProof=false;fixture.received=true;});await page.getByRole('button',{name:'Check it arrived'}).click();await page.getByRole('status').filter({hasText:'Test enquiry received'}).waitFor();await page.getByRole('link',{name:'Open Inbox'}).waitFor();
  if(process.env.SETUP_PROOF_DIR)await page.screenshot({path:join(process.env.SETUP_PROOF_DIR,'connection-proof-mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>fixture.requests.some(r=>r.method!=='GET')),false);
  await page.getByRole('button',{name:'Start a new check'}).click();assert.notEqual(await page.locator('code').innerText(),code);assert.equal(await page.getByRole('link',{name:'Open Inbox'}).count(),0);
  for(const width of [320,768,1280]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
  assert.deepEqual(errors,[]);console.log('PASS: enquiry challenge survives reload, distinguishes delayed delivery from errors and only shows success after evidence; no sends or settings writes');
  await context.close();
}finally{await browser.close();await new Promise(r=>server.close(r));}
