// Actual Knowledge page against synthetic HTTP fixtures. No model/provider calls.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { launch } from './lib/browser.mjs';
const root = new URL('../', import.meta.url).pathname;
const store = `export const supabase={auth:{getSession:async()=>({data:{session:{access_token:'fixture'}}})}}; const owner={id:'fictional-owner'}; export const useBeautician=()=>({beautician:owner,loading:false});`;
const entry = `import React from 'react';import {createRoot} from 'react-dom/client';import Knowledge from './src/pages/Knowledge.jsx';import './src/index.css';import './src/pages/Knowledge.css';createRoot(document.getElementById('root')).render(<Knowledge/>);`;
const out = await build({stdin:{contents:entry,resolveDir:root,loader:'jsx'},bundle:true,write:false,outfile:'/tmp/knowledge-fixture/app.js',format:'iife',platform:'browser',jsx:'automatic',plugins:[{name:'fixtures',setup(b){
 b.onResolve({filter:/\/lib\/supabase\.js$/},()=>({path:'store',namespace:'fixture'}));
 b.onResolve({filter:/\/lib\/config\.js$/},()=>({path:'config',namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path==='store'?store:'export const API_BASE="";',loader:'js'}));
}}],define:{'import.meta.env':JSON.stringify({DEV:false})}});
const state={suggestions:[],failApproval:false,learningUnavailable:false,rows:[],writes:[],previews:[],failSave:false,failPreview:false,holdPreview:false};
const server=http.createServer(async(req,res)=>{
 let body='';for await(const chunk of req)body+=chunk;
 const json=data=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(data));};
 if(req.url.startsWith('/api/knowledge')){
  const input=body?JSON.parse(body):{};
  if(req.url==='/api/knowledge/learning') {
   if(state.learningUnavailable){res.statusCode=503;return json({error:'Learning is unavailable. Your approved answers still work.'});}
   return json({suggestions:state.suggestions});
  }
  if(req.url==='/api/knowledge/learning/discover') {
   state.suggestions=[{id:'lesson',status:'pending',category:'policy',title:'Gift voucher validity',content:'Gift vouchers last twelve months and cannot be exchanged for cash.',evidence:'Gift vouchers last twelve months and cannot be exchanged for cash.'}];
   return json({reviewing:1});
  }
  if(req.url==='/api/knowledge/learning/lesson/approve') {
   if(state.failApproval){res.statusCode=503;return json({error:'Could not approve that yet.'});}
   state.writes.push({method:'APPROVE',input}); const entry={id:'learned',is_active:true,...input};state.rows.push(entry);state.suggestions=[];return json({entry});
  }
  if(req.url==='/api/knowledge/learning/lesson/dismiss'){state.suggestions=[];return json({ok:true});}
  if(req.url==='/api/knowledge/preview'){
   state.previews.push(input);
   if(state.holdPreview)await new Promise(r=>setTimeout(r,200));
   if(state.failPreview){res.statusCode=503;return json({error:'Preview is temporarily unavailable.'});}
   const sources=state.rows.filter(r=>r.is_active);
   return json({reply:sources[0]?.content||'I’ll check that with you.',canAnswer:!!sources.length,reason:sources.length?'owner_note':'missing',sources:sources.map(({id,title,category})=>({id,title,category}))});
  }
  if(req.method==='GET')return json({entries:state.rows});
  if(state.failSave){res.statusCode=503;return json({error:'Synthetic save failure. Please try again.'});}
  state.writes.push({method:req.method,input});
  if(req.method==='POST'){const entry={id:`note-${state.rows.length}`,is_active:true,...input};state.rows.push(entry);return json({entry});}
  const entry=state.rows.find(r=>r.id===req.url.split('/').at(-1));Object.assign(entry,input);return json({entry});
 }
 const file=out.outputFiles.find(f=>f.path.endsWith(req.url));
 if(file){res.setHeader('content-type',req.url.endsWith('.css')?'text/css':'text/javascript');return res.end(file.text);}
 res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>');
}).listen(0,'127.0.0.1');
await new Promise(resolve=>server.once('listening',resolve));
const browser=await launch();
try {
 const origin=`http://127.0.0.1:${server.address().port}`;
 const ctx=await browser.newContext({viewport:{width:390,height:844}});
 await ctx.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);
 await page.getByRole('heading',{name:'Florrie’s knowledge',exact:true}).waitFor();
 await page.getByRole('button',{name:'How long should I leave between brow laminations?',exact:true}).click();
 assert.equal(await page.getByLabel('Your approved answer or guidance').inputValue(),'');
 assert.equal(state.writes.length,0);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.getByLabel('Client’s question').fill('Have you released November dates yet?');
 await page.getByRole('button',{name:'Preview Florrie’s reply',exact:true}).click();
 await page.getByText('Needs more guidance or a check',{exact:true}).waitFor();
 assert.equal(state.writes.length,0);
 await page.getByRole('button',{name:'Write an approved answer',exact:true}).click();
 assert.equal(await page.getByLabel('Question or topic').inputValue(),'Have you released November dates yet?');
 await page.getByLabel('Your approved answer or guidance').fill('Our diary opens two months ahead.');
 state.failSave=true;await page.getByRole('button',{name:'Save approved answer',exact:true}).click();
 await page.getByRole('alert').waitFor();
 assert.equal(await page.getByLabel('Your approved answer or guidance').inputValue(),'Our diary opens two months ahead.');
 assert.equal(state.writes.length,0);
 state.failSave=false;await page.getByRole('button',{name:'Save approved answer',exact:true}).click();
 await page.getByText('Approved answer saved. Try a client question to check the reply.',{exact:true}).waitFor();
 assert.equal(await page.locator('.fl-knowledge-result').count(),0);
 assert.equal(state.writes.length,1);
 await page.getByRole('button',{name:'Preview Florrie’s reply',exact:true}).click();
 await page.getByText('An answer from your guidance',{exact:true}).waitFor();
 assert.equal(await page.locator('.fl-knowledge-result blockquote').innerText(),'Our diary opens two months ahead.');
 await page.locator('.fl-knowledge-sources button').click();
 assert.equal(await page.getByLabel('Your approved answer or guidance').inputValue(),'Our diary opens two months ahead.');
 await page.getByLabel('Your approved answer or guidance').fill('New dates open on a rolling two-month basis.');
 await page.getByRole('button',{name:'Save approved answer',exact:true}).click();
 await page.getByText('Approved answer saved. Try a client question to check the reply.',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Pause answer',exact:true}).click();
 await page.getByText('Answer paused. Florrie will no longer use it for future replies.',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Preview Florrie’s reply',exact:true}).click();
 await page.getByText('No matching saved answer used.',{exact:true}).waitFor();
 await page.reload();await page.getByRole('button',{name:'Paused 1',exact:true}).click();
 await page.getByText('New dates open on a rolling two-month basis.',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Enable answer',exact:true}).click();
 await page.getByText('Answer enabled for future replies.',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Enabled 1',exact:true}).click();
 assert.equal(state.rows.length,1);assert.equal(state.rows[0].is_active,true);
 state.failPreview=true;await page.getByLabel('Client’s question').fill('When do new dates open?');
 await page.getByRole('button',{name:'Preview Florrie’s reply',exact:true}).click();
 await page.getByText('Preview is temporarily unavailable.',{exact:true}).waitFor();
 state.failPreview=false;state.holdPreview=true;await page.getByRole('button',{name:'Preview Florrie’s reply',exact:true}).click();
 await page.getByLabel('Client’s question').fill('A different question');
 await page.waitForTimeout(250);assert.equal(await page.locator('.fl-knowledge-result').count(),0);state.holdPreview=false;
 await page.getByLabel('Client’s question').fill('When do new dates open?');await page.getByRole('button',{name:'Preview Florrie’s reply',exact:true}).click();
 await page.getByText('An answer from your guidance',{exact:true}).waitFor();
 mkdirSync('/tmp/florrie-knowledge-check',{recursive:true});
 await page.screenshot({path:'/tmp/florrie-knowledge-check/phone.png',fullPage:true});
 for(const width of [320,390,820,1280]){
  await page.setViewportSize({width,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`overflow at ${width}`);
 }
 await page.screenshot({path:'/tmp/florrie-knowledge-check/desktop.png',fullPage:true});
 state.rows=[];await page.reload();
 await page.getByRole('button',{name:'Check my recent replies',exact:true}).click();
 const lesson=page.getByRole('form',{name:'Review a learned answer'});await lesson.waitFor();
 assert.equal(state.rows.length,0);
 await page.getByLabel('Client’s question').fill('Can a present be exchanged for money?');
 await page.getByRole('button',{name:'Preview Florrie’s reply',exact:true}).click();
 await page.getByText('Needs more guidance or a check',{exact:true}).waitFor();
 await lesson.getByLabel('Answer for future clients').fill('Vouchers last twelve months. They cannot be exchanged for cash.');
 state.failApproval=true;await lesson.getByRole('button',{name:'Approve for future replies',exact:true}).click();
 await page.getByText('Could not approve that yet.',{exact:true}).waitFor();
 assert.equal(await lesson.getByLabel('Answer for future clients').inputValue(),'Vouchers last twelve months. They cannot be exchanged for cash.');
 assert.equal(state.rows.length,0);
 state.failApproval=false;await lesson.getByRole('button',{name:'Approve for future replies',exact:true}).click();
 await page.getByText('Answer learned. Try the question below to check what the next client will hear.',{exact:true}).waitFor();
 assert.equal(state.rows.length,1);assert.equal(await page.getByLabel('Client’s question').inputValue(),'Gift voucher validity');
 await page.getByRole('button',{name:'Preview Florrie’s reply',exact:true}).click();
 await page.getByText('An answer from your guidance',{exact:true}).waitFor();
 assert.equal(await page.locator('.fl-knowledge-result blockquote').innerText(),state.rows[0].content);
 await page.getByRole('button',{name:'Check my recent replies',exact:true}).click();await lesson.waitFor();
 for(const width of [320,390,820,1280]) { await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`learning overflow at ${width}`); }
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/florrie-knowledge-check/learning-phone.png',fullPage:true});
 await lesson.getByRole('button',{name:'Keep this just in the conversation',exact:true}).click();await lesson.waitFor({state:'detached'});assert.equal(state.rows.length,1);
 state.learningUnavailable=true;await page.reload();await page.getByText('Learning is unavailable. Your approved answers still work.',{exact:false}).waitFor();
 await page.getByLabel('Client’s question').fill('How long do vouchers last?');await page.getByRole('button',{name:'Preview Florrie’s reply',exact:true}).click();await page.getByText('An answer from your guidance',{exact:true}).waitFor();
 assert.deepEqual(errors,[]);
 console.log('PASS: blank starters, private preview, failed save retained, explicit approval, source edit, pause/reload/resume, failed/stale preview, 320–1280px layout. Learning: unapproved drafts excluded, failed approval preserved, approval used in preview, dismiss and storage outage, responsive layout. Synthetic fixtures only; no AI delivery proof.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
