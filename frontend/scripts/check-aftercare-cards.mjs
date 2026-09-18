// Actual Aftercare page + Supabase client against an isolated local HTTP fixture.
// No production credentials, delivery, model calls or knowledge writes.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { build } from 'esbuild';
import { launch } from './lib/browser.mjs';

const root=new URL('../',import.meta.url).pathname;
const owner='00000000-0000-0000-0000-000000000001';
const other='00000000-0000-0000-0000-000000000002';
const original={id:'00000000-0000-0000-0000-000000000010',beautician_id:owner,treatment_name:'Fictional brow care',icon:'flower',instructions:[{title:'Owner step one',text:'Existing owner guidance in full.',reference:'Retain this metadata'},{title:'Owner step two',text:'A second saved instruction.'}],products:['Existing product one','Existing product two'],personal_note:'Existing personal note',auto_send:true,send_after_hours:72,rebook_nudge_days:56,archived_at:null,created_at:'2026-01-01T00:00:00.000Z',updated_at:'2026-01-01T00:00:00.000Z'};
let counter=0;
const stamp=()=>new Date(Date.UTC(2026,0,2,0,0,++counter)).toISOString();
const state={rows:[structuredClone(original),{...structuredClone(original),id:'00000000-0000-0000-0000-000000000011',treatment_name:'Archived example',archived_at:'2026-01-01T12:00:00Z'},{...structuredClone(original),id:'00000000-0000-0000-0000-000000000012',beautician_id:other,treatment_name:'Other salon private guidance'}],writes:[],requests:[],failWrite:false,failRead:false,missing:false};
const store=`import {createClient} from '@supabase/supabase-js';export const supabase=createClient(location.origin,'fixture',{auth:{persistSession:false,autoRefreshToken:false}});const owner={id:'${owner}',business_name:'Fictional salon'};export const useBeautician=()=>({beautician:owner,loading:false});`;
const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import {BrowserRouter,useLocation} from 'react-router-dom';import {ThemeProvider} from './src/lib/theme.jsx';import Aftercare from './src/pages/Aftercare.jsx';import './src/index.css';function Harness(){const l=useLocation();return l.pathname==='/knowledge'?<h1>Approved answers</h1>:<Aftercare/>;}createRoot(document.getElementById('root')).render(<ThemeProvider><BrowserRouter><Harness/></BrowserRouter></ThemeProvider>);`;
const bundle=await build({stdin:{contents:entry,resolveDir:root,loader:'jsx'},bundle:true,write:false,outfile:'/tmp/florrie-aftercare-fixture/app.js',format:'iife',platform:'browser',jsx:'automatic',define:{'import.meta.env':'{}'},plugins:[{name:'fixture-owner',setup(b){
 b.onResolve({filter:/\/lib\/supabase\.js$/},()=>({path:'store',namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:store,loader:'js',resolveDir:root}));
}}]});
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://fixture.invalid');
 if(url.pathname.startsWith('/rest/')){
  state.requests.push({method:req.method,path:url.pathname,query:Object.fromEntries(url.searchParams)});
  const json=(body,status=200)=>{res.statusCode=status;res.setHeader('content-type','application/json');res.end(JSON.stringify(body));};
  if(url.pathname!=='/rest/v1/aftercare_cards')return json({message:'Unexpected data access'},500);
  if(state.missing)return json({code:'PGRST205',message:'Table not found'},404);
  if(req.method==='GET'){
   if(state.failRead)return json({code:'XX000',message:'Synthetic load failure'},500);
   if(url.searchParams.get('beautician_id')!==`eq.${owner}`)return json({message:'Missing owner filter'},400);
   return json(state.rows.filter(row=>row.beautician_id===owner));
  }
  let body='';for await(const part of req)body+=part;const input=JSON.parse(body);
  if(state.failWrite)return json({code:'XX000',message:'Synthetic rejected write'},500);
  if(req.method==='POST'){
   assert.equal(input.beautician_id,owner);assert.equal(input.auto_send,false);
   const row={id:'00000000-0000-0000-0000-000000000020',send_after_hours:1,rebook_nudge_days:28,archived_at:null,created_at:stamp(),updated_at:stamp(),...input};
   state.rows.push(row);state.writes.push({method:'POST',input});return json(row,201);
  }
  if(req.method==='PATCH'){
   const filters=Object.fromEntries(url.searchParams);
   assert.equal(filters.beautician_id,`eq.${owner}`);assert.ok(filters.id);assert.ok(filters.updated_at);
   const row=state.rows.find(row=>filters.id===`eq.${row.id}`&&filters.beautician_id===`eq.${row.beautician_id}`&&filters.updated_at===`eq.${row.updated_at}`);
   if(!row)return json({code:'PGRST116',message:'No matching record'},406);
   state.writes.push({method:'PATCH',input,filters});Object.assign(row,input,{updated_at:stamp()});return json(row);
  }
  return json({message:'Unexpected operation'},400);
 }
 const file=bundle.outputFiles.find(f=>f.path.endsWith(url.pathname));
 if(file){res.setHeader('content-type',url.pathname.endsWith('.css')?'text/css':'text/javascript');return res.end(file.text);}
 res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>');
}).listen(0,'127.0.0.1');
await new Promise(resolve=>server.once('listening',resolve));
const browser=await launch();
try {
 const origin=`http://127.0.0.1:${server.address().port}`;
 const ctx=await browser.newContext({viewport:{width:390,height:844}});
 await ctx.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 const page=await ctx.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(`${origin}/aftercare`);
 const card=page.getByRole('article',{name:'Fictional brow care',exact:true});await card.waitFor();
 assert.equal(await page.getByText('Other salon private guidance',{exact:true}).count(),0);
 assert.equal(await page.getByRole('article',{name:'Archived example',exact:true}).count(),0);
 await card.getByRole('button',{name:'Preview',exact:true}).click();
 const preview=page.getByRole('dialog',{name:'Guidance preview'});
 await preview.getByText('Existing owner guidance in full.',{exact:true}).waitFor();
 await preview.getByText('Existing personal note',{exact:true}).waitFor();
 await preview.getByText('Preview only',{exact:true}).waitFor();
 await preview.getByRole('button',{name:'Close preview',exact:true}).click();
 await card.getByRole('button',{name:'Edit',exact:true}).click();
 const editor=page.getByRole('form',{name:'Edit care card',exact:true});
 assert.equal(await editor.getByLabel('Treatment name',{exact:true}).inputValue(),'Fictional brow care');
 assert.equal(await editor.getByLabel('Step 2 instruction',{exact:true}).inputValue(),'A second saved instruction.');
 assert.equal(await editor.getByLabel('Recommended product 2',{exact:true}).inputValue(),'Existing product two');
 assert.equal(await editor.getByLabel('Personal note',{exact:true}).inputValue(),'Existing personal note');
 assert.equal(await editor.getByRole('button',{name:'Use flower icon',exact:true}).getAttribute('aria-pressed'),'true');
 await editor.getByLabel('Step 1 instruction',{exact:true}).fill('Owner-approved correction for this draft.');
 state.failWrite=true;await editor.getByRole('button',{name:'Save changes',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'Your instructions are still here'}).waitFor();
 assert.equal(await editor.getByLabel('Step 1 instruction',{exact:true}).inputValue(),'Owner-approved correction for this draft.');
 assert.equal(state.writes.length,0);assert.deepEqual(state.rows[0],original);
 await editor.getByRole('button',{name:'Cancel',exact:true}).click();
 await card.getByText('Existing owner guidance in full.',{exact:true}).waitFor();
 await card.getByRole('button',{name:'Edit',exact:true}).click();
 await editor.getByLabel('Step 1 instruction',{exact:true}).fill('Owner correction for this draft.');
 state.failWrite=false;await editor.getByRole('button',{name:'Save changes',exact:true}).click();
 await page.getByRole('status').filter({hasText:'Care card saved'}).waitFor();
 const saved=state.rows[0];
 assert.equal(saved.auto_send,true);assert.equal(saved.send_after_hours,72);assert.equal(saved.rebook_nudge_days,56);
 assert.equal(saved.instructions[0].reference,'Retain this metadata');assert.deepEqual(saved.products,original.products);
 assert.deepEqual(Object.keys(state.writes[0].input).sort(),['icon','instructions','personal_note','products','treatment_name']);
 await page.reload();await card.getByText('Owner correction for this draft.',{exact:true}).waitFor();
 console.log('PASS: preview/edit loads saved guidance; failed edits preserve draft and stored content; successful edits persist with tenant/version filters and retain delivery preferences');

 state.failWrite=true;await card.getByRole('button',{name:'Archive',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'It is still where it was'}).waitFor();await card.waitFor();
 state.failWrite=false;await card.getByRole('button',{name:'Archive',exact:true}).click();
 await page.getByRole('status').filter({hasText:'Care card archived'}).waitFor();assert.equal(await card.count(),0);
 assert.deepEqual(Object.keys(state.writes.at(-1).input),['archived_at']);
 await page.getByRole('button',{name:'Archived',exact:true}).click();await card.waitFor();
 await card.getByRole('button',{name:'Preview',exact:true}).click();
 await preview.getByText('Owner correction for this draft.',{exact:true}).waitFor();await preview.getByRole('button',{name:'Close preview',exact:true}).click();
 await card.getByRole('button',{name:'Restore',exact:true}).click();
 await page.getByRole('status').filter({hasText:'restored'}).waitFor();
 await page.getByRole('button',{name:'Saved cards',exact:true}).click();await card.waitFor();
 await page.reload();await card.waitFor();assert.equal(state.rows[0].archived_at,null);
 assert.equal(state.rows.length,3);assert.equal(state.rows[0].personal_note,'Existing personal note');
 console.log('PASS: failed archive keeps the card; archive/restore survives reload and retains full guidance without deletion');

 await card.getByRole('button',{name:'Edit',exact:true}).click();
 await editor.getByLabel('Personal note',{exact:true}).fill('Unsaved note on this device');
 state.rows[0].personal_note='Newer note from another device';state.rows[0].updated_at=stamp();
 const writesBefore=state.writes.length;await editor.getByRole('button',{name:'Save changes',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'changed elsewhere'}).waitFor();
 assert.equal(await editor.getByLabel('Personal note',{exact:true}).inputValue(),'Unsaved note on this device');
 assert.equal(state.writes.length,writesBefore);assert.equal(state.rows[0].personal_note,'Newer note from another device');
 mkdirSync('/tmp/florrie-aftercare-check',{recursive:true});await page.screenshot({path:'/tmp/florrie-aftercare-check/editor-phone.png',fullPage:true});
 for(const width of [320,390,820,1280]){await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`aftercare overflow at ${width}`);}
 await editor.getByRole('button',{name:'Cancel',exact:true}).click();await page.reload();
 await card.getByRole('button',{name:'Preview',exact:true}).click();await preview.getByText('Newer note from another device',{exact:true}).waitFor();await preview.getByRole('button',{name:'Close preview',exact:true}).click();

 await page.getByRole('button',{name:'+ New Care Card',exact:true}).click();
 const create=page.getByRole('form',{name:'New care card',exact:true});
 await create.getByLabel('Treatment name',{exact:true}).fill('New fictional card');await create.getByLabel('Step 1 title',{exact:true}).fill('A fictional step');await create.getByLabel('Step 1 instruction',{exact:true}).fill('Owner-authored draft guidance.');
 state.failWrite=true;await create.getByRole('button',{name:'Save Card',exact:true}).click();await page.getByRole('alert').waitFor();assert.equal(await create.getByLabel('Treatment name',{exact:true}).inputValue(),'New fictional card');
 state.failWrite=false;await create.getByRole('button',{name:'Save Card',exact:true}).click();await page.getByRole('article',{name:'New fictional card',exact:true}).waitFor();
 assert.equal(state.rows.at(-1).auto_send,false);assert.equal(state.rows.at(-1).archived_at,null);
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/florrie-aftercare-check/saved-phone.png',fullPage:true});
 console.log('PASS: concurrent edit is rejected without losing draft; new cards save with automatic sending off');

 state.failRead=true;await page.reload();await page.getByText('Could not load your care cards. Try again.',{exact:true}).waitFor();assert.equal(await page.getByText('No care cards yet',{exact:true}).count(),0);
 state.failRead=false;await page.getByRole('button',{name:'Try again',exact:true}).click();await card.waitFor();
 state.missing=true;await page.reload();await page.getByText('Care-card storage is not ready yet. You can still open your approved answers in Florrie’s knowledge.',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'+ New Care Card',exact:true}).count(),0);
 await page.getByRole('link',{name:'Open Florrie’s knowledge',exact:true}).click();await page.getByRole('heading',{name:'Approved answers',exact:true}).waitFor();
 assert.ok(state.requests.every(req=>req.path==='/rest/v1/aftercare_cards'&&req.method!=='DELETE'));
 assert.deepEqual(errors,[]);
 console.log('PASS: missing storage reports unavailable and links approved answers; failed reads never look empty; no knowledge/delivery/delete calls occurred');
 await ctx.close();
} finally {await browser.close();server.close();}
