// Built app, real Canvas artwork, fictional salon, intercepted writes. No provider calls.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import http from 'node:http';
import { build } from 'esbuild';
import { launch } from './lib/browser.mjs';
import { bundleSupabaseUrl, fetchStubSource, sessionSeedSource } from './lib/fixtures.mjs';
const dist = new URL('../dist', import.meta.url).pathname;
// Isolate the actual parent's asynchronous workflow; the full-app cases below
// retain the real Team UI and Canvas-to-storage handoff.
const authBundle = await build({
  stdin: { resolveDir:new URL('..',import.meta.url).pathname, loader:'jsx', contents:`
    import React from 'react';import {createRoot} from 'react-dom/client';
    import ContentAssistant from './src/components/ContentAssistant.jsx';
    const owner={id:'salon-a',auth_id:'user-a',business_name:'Fictional Salon',booking_slug:'fictional'};
    const post={id:'11111111-1111-4111-8111-111111111111',beautician_id:owner.id,caption:'Ask us about your visit.',status:'draft',post_type:'general',media_kind:'feed',image_url:null};
    const s=window.parentFixture={authOwner:'a',listeners:new Set(),requests:[],uploads:[],callbacks:[],sessionReads:0,posts:[],
      board(){return {business_name:owner.business_name,booking_slug:owner.booking_slug,unavailable:[],opportunities:[{type:'knowledge',source_id:'one'}],prepare_capacity:1,prepared:this.posts.map(post=>({post_id:post.id,post,source:{type:'knowledge'},needs:post.image_url?[]:['photo'],artwork:{kind:'knowledge',title:'Your visit',body:post.caption}}))};},
      session(){return this.authOwner?{access_token:'fixture-'+this.authOwner,user:{id:'user-'+this.authOwner}}:null;},
      changeAuth(id){this.authOwner=id;for(const fn of this.listeners)fn(id?'SIGNED_IN':'SIGNED_OUT',this.session());},
      mount(){this.root ||=createRoot(document.getElementById('root'));this.root.render(<ContentAssistant owner={owner} onPrepared={posts=>this.callbacks.push({posts,auth:this.authOwner})} onPost={()=>{}} onPosts={()=>{}} onPhotos={()=>{}} onResults={()=>{}}/>);}
    };
    const json=body=>new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
    const wait=async(point)=>{if(s['hold'+point]){s['hold'+point]=false;await new Promise(resolve=>{s['release'+point]=resolve;});}};
    window.fetch=async(url,options={})=>{
      const path=new URL(url,location.origin).pathname,method=options.method||'GET';
      s.requests.push({path,method,auth:new Headers(options.headers).get('Authorization')});
      if(path==='/api/content/assistant'){await wait('Read');return json(s.board());}
      if(path==='/api/content/assistant/prepare'){s.posts=[{...post}];await wait('Prepare');return json(s.board());}
      if(path==='/api/content'&&method==='GET'){await wait('Readback');return json({posts:s.posts});}
      if(path==='/api/content/'+post.id&&method==='PATCH'){Object.assign(s.posts[0],JSON.parse(options.body));await wait('Patch');return json({post:s.posts[0]});}
      throw Error('Unexpected request '+path);
    };
  ` },
  bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',outfile:'parent-fixture.js',
  define:{'process.env.NODE_ENV':'"development"','import.meta.env':'{}'},loader:{'.svg':'dataurl','.png':'dataurl'},
  plugins:[{name:'isolated-parent',setup(b){
    b.onResolve({filter:/\/lib\/(supabase|storage|config)\.js$/},args=>({path:basename(args.path),namespace:'parent-fixture'}));
    b.onResolve({filter:/ContentTeam\.jsx$/},()=>({path:'team',namespace:'parent-fixture'}));
    b.onResolve({filter:/ContentStudioHome\.jsx$/},()=>({path:'preview',namespace:'parent-fixture'}));
    b.onLoad({filter:/.*/,namespace:'parent-fixture'},({path})=>({loader:'jsx',resolveDir:new URL('..',import.meta.url).pathname,contents:{
      'config.js':'export const API_BASE="";',
      'supabase.js':'export const supabase={auth:{getSession:async()=>{const s=parentFixture;s.sessionReads++;if(s.neverSession)return new Promise(()=>{});return {data:{session:s.session()}};},onAuthStateChange:fn=>{parentFixture.listeners.add(fn);return {data:{subscription:{unsubscribe:()=>parentFixture.listeners.delete(fn)}}};}}};',
      'storage.js':'export const PUBLIC_BUCKET="content-images";export const objectPath=(owner,kind,file)=>owner+"/"+kind+"/"+file;export const publicUrl=path=>"data:image/png;base64,iVBORw0KGgo=";export async function uploadFile({path,file}){const s=parentFixture;s.uploads.push({path,auth:s.authOwner,size:file.size});if(s.holdUpload){s.holdUpload=false;await new Promise(resolve=>{s.releaseUpload=resolve;});}return {path};}',
      team:'import React from "react";export default function Team(p){return <section><button disabled={p.busy||p.loading||!p.canPrepare} onClick={p.onPrepare}>Prepare</button><button disabled={p.busy||p.loading} onClick={p.onRefresh}>Refresh</button>{p.error&&<p role="alert">{p.error}</p>}<p role="status">{p.busy?"Preparing":p.loading?"Loading":p.note||"Ready"}</p>{p.children}</section>}',
      preview:'import React from "react";export function PostPreview(){return <span>Saved preview</span>}',
    }[path]}));
  }}],
});
const authScript=authBundle.outputFiles.find(file=>file.path.endsWith('.js')).text;
const server = http.createServer((req,res) => {
  if(req.url==='/parent-fixture.js'){res.setHeader('content-type','text/javascript');return res.end(authScript);}
  if(req.url==='/parent-fixture'){res.setHeader('content-type','text/html');return res.end('<!doctype html><html><meta charset="utf-8"><div id="root"></div><script src="/parent-fixture.js"></script></html>');}
  let file = join(dist,(req.url || '/').split('?')[0]);
  if (!existsSync(file) || !extname(file)) file=join(dist,'index.html');
  res.setHeader('content-type',({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.woff2':'font/woff2'})[extname(file)] || 'application/octet-stream');
  try {res.end(readFileSync(file));} catch {res.statusCode=404;res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await launch(), baseUrl=`http://127.0.0.1:${server.address().port}`;
const output=process.env.VISUAL_OUTPUT_DIR;
if(output)mkdirSync(output,{recursive:true});
async function fixture({width=390,readError=false,partial=false,saveError=false,delay=false}={}) {
  const context=await browser.newContext({viewport:{width,height:844},reducedMotion:'reduce'});
  let page;
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.hostname==='127.0.0.1')return route.continue();
    if(url.pathname.includes('/object/public/content-images/')) {
      const key=url.pathname.split('/content-images/')[1];
      const image=await page.evaluate(key=>window.__assistantCheck?.images[key],key);
      if(image)return route.fulfill({status:200,contentType:'image/png',body:Buffer.from(image,'base64')});
    }
    return route.abort();
  });
  await context.addInitScript(fetchStubSource());
  await context.addInitScript(sessionSeedSource(bundleSupabaseUrl(dist)));
  await context.addInitScript(({readError,partial,saveError,delay})=>{
    const base=window.fetch;
    const json=(body,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}}));
    const facts=[
      {type:'knowledge',source_id:'k1',title:'A little preparation.',reason:'Your saved preparation advice answers a question clients ask before their visit.',artwork:{kind:'knowledge',title:'A little preparation.',body:'Arrive with clean brows. Ask us if you are unsure about preparing for your visit.'}},
      {type:'treatment',source_id:'t1',title:'Signature brows',reason:'Explain your treatment using its saved salon description.',artwork:{kind:'treatment',title:'Signature brows',body:'A brow treatment shaped around your consultation.'}},
      {type:'booking',source_id:'current-diary',title:'A little time for you.',reason:'Your checked diary has room for a treatment. Invite clients to see the current times.',artwork:{kind:'booking',title:'A little time for you.',body:'Explore our treatments and check the booking page for current appointments.'}},
    ];
    const s=window.__assistantCheck={reads:0,writes:[],images:{},uploads:[],posts:[],readError,partial,saveError,delay,prepareCount:0};
    const board=()=>({business_name:'Florrie Demo Salon',booking_slug:'florrie-demo',checked_at:new Date().toISOString(),unavailable:s.partial?['diary']:[],prepare_capacity:Math.max(0,3-s.posts.length),prepared:s.posts.map((post,i)=>({post_id:post.id,post,source:{type:facts[i].type,id:facts[i].source_id},reason:facts[i].reason,artwork:facts[i].artwork,needs:post.image_url?[]:['photo']})),opportunities:s.posts.length?[]:facts.slice(0,s.partial?2:3),results:{available:true,days:90,campaigns:[]}});
    window.fetch=async(input,options={})=>{
      const url=typeof input==='string'?input:input.url,method=(options.method || 'GET').toUpperCase();
      const path=new URL(url,location.origin).pathname;
      if(path.endsWith('/api/content/assistant')){s.reads++;return s.readError?json({error:'Could not check content just now.'},503):json(board());}
      if(method==='POST'&&path.endsWith('/assistant/prepare')){
        s.writes.push({path,method});s.prepareCount++;
        if(s.delay)await new Promise(resolve=>{s.release=resolve;});
        if(!s.posts.length)s.posts=facts.slice(0,s.partial?2:3).map((fact,i)=>({id:`11111111-1111-4111-8111-11111111111${i}`,beautician_id:'b1',caption:fact.artwork.body,hashtags:[],image_url:null,status:'draft',post_type:'general',media_kind:'feed',created_at:new Date().toISOString()}));
        return json({...board(),created_post_ids:s.posts.map(p=>p.id),errors:[]});
      }
      if(path.includes('/storage/v1/object/content-images/')&&method==='POST') {
        const file=[...options.body.values()].find(value=>value instanceof Blob);
        const bytes=new Uint8Array(await file.arrayBuffer());
        const base64=await new Promise(resolve=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.readAsDataURL(file);});
        const key=path.split('/content-images/')[1];s.images[key]=base64;s.uploads.push({bytes:[...bytes.slice(0,24)],size:file.size});
        s.writes.push({path,method});return json({Key:`content-images/${key}`,Id:'fixture'});
      }
      if(path==='/api/content')return json({posts:s.posts});
      if(method==='PATCH'&&/\/api\/content\/[a-f0-9-]+$/.test(path)){
        const body=JSON.parse(options.body),post=s.posts.find(p=>path.endsWith(p.id));s.writes.push({path,method,body});
        if(s.saveError){s.saveError=false;return json({error:'A temporary save failure. Your design is still here.'},503);}
        if(body.expected_caption!==post.caption||post.image_url||!body.artwork_only)return json({error:'Post changed.'},409);
        post.image_url=body.image_url;return json({post});
      }
      if(path.includes('/api/content/streams'))return json({streams:[]});
      if(path.includes('/api/instagram/status'))return json({connected:true,token_valid:true});
      if(path.includes('/api/content/results'))return json({campaigns:[],days:90});
      if(path.includes('/rest/v1/content_posts'))return json([]);
      if(!['GET','HEAD'].includes(method)&&/\/api\/|\/rest\/|\/storage\//.test(path)){s.writes.push({path,method,unexpected:true});return json({error:'Unexpected write'},409);}
      return base(input,options);
    };
  },{readError,partial,saveError,delay});
  page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${baseUrl}/content`);
  try { await page.getByRole('region',{name:'Your content team',exact:true}).waitFor(); }
  catch(error) { throw new Error(error.message+'\nPage: '+(await page.locator('body').innerText()).slice(0,1600)+'\nErrors: '+JSON.stringify(errors)); }
  return {context,page,errors};
}
try {
  for(const phase of ['Read','Prepare','Readback','Upload','Patch']) {
    const context=await browser.newContext();await context.route('**/*',route=>new URL(route.request().url()).origin===baseUrl?route.continue():route.abort());
    const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`${baseUrl}/parent-fixture`);
    await page.evaluate(phase=>{parentFixture['hold'+phase]=true;parentFixture.mount();},phase);
    if(phase!=='Read')await page.getByRole('button',{name:'Prepare',exact:true}).click();
    await page.waitForFunction(phase=>!!parentFixture['release'+phase],phase);
    const before=await page.evaluate(()=>({requests:parentFixture.requests.length,uploads:parentFixture.uploads.length}));
    await page.evaluate(()=>parentFixture.changeAuth('b'));
    await page.getByRole('alert').filter({hasText:'Your account changed.'}).waitFor();
    await page.evaluate(phase=>parentFixture['release'+phase](),phase);
    await page.waitForTimeout(50);
    const after=await page.evaluate(()=>({requests:parentFixture.requests.length,uploads:parentFixture.uploads.length,callbacks:parentFixture.callbacks}));
    assert.deepEqual(after,{...before,callbacks:[]},'Auth change makes late '+phase+' work inert before the next request/upload/callback');
    assert.deepEqual(errors,[]);await context.close();console.log('PASS parent auth change invalidates '+phase+' without follow-on writes');
  }
  {
    const context=await browser.newContext();await context.route('**/*',route=>new URL(route.request().url()).origin===baseUrl?route.continue():route.abort());
    const page=await context.newPage();await page.goto(`${baseUrl}/parent-fixture`);
    await page.evaluate(()=>{parentFixture.authOwner='b';parentFixture.mount();});
    await page.getByRole('alert').filter({hasText:'Your account changed.'}).waitFor();
    assert.deepEqual(await page.evaluate(()=>parentFixture.requests),[],'Stale owner props cannot issue a request under another account');
    await context.close();console.log('PASS parent checks SDK identity even without an auth event');
  }
  for(const phase of ['load','prepare']) {
    const context=await browser.newContext();await context.route('**/*',route=>new URL(route.request().url()).origin===baseUrl?route.continue():route.abort());
    const page=await context.newPage();await page.clock.install();await page.goto(`${baseUrl}/parent-fixture`);
    await page.evaluate(phase=>{parentFixture.neverSession=phase==='load';parentFixture.mount();},phase);
    if(phase==='prepare') {await page.getByRole('button',{name:'Prepare',exact:true}).waitFor();await page.evaluate(()=>parentFixture.neverSession=true);await page.getByRole('button',{name:'Prepare',exact:true}).click();}
    await page.waitForFunction(()=>parentFixture.sessionReads>0);await page.clock.fastForward(10001);
    await page.getByRole('alert').filter({hasText:'taking too long'}).waitFor();
    assert.deepEqual(await page.evaluate(()=>parentFixture.requests.filter(item=>item.method!=='GET')),[]);
    assert.equal(await page.getByRole('status').textContent(),'Ready','Auth timeout releases the busy path');
    await context.close();console.log('PASS parent '+phase+' session wait is bounded');
  }
  if(process.env.CONTENT_ASSISTANT_AUTH_ONLY==='1') {
    console.log('PASS all focused ContentAssistant auth lifecycle cases');
  } else {
  for(const width of [320,390,1024]) {
    const {context,page,errors}=await fixture({width});
    const prepare=page.getByRole('button',{name:'Prepare my next posts',exact:true});await prepare.waitFor();
    assert.equal(await page.getByRole('button',{name:'For you',exact:true}).getAttribute('aria-pressed'),'true');
    assert.deepEqual(await page.evaluate(()=>window.__assistantCheck.writes),[],'Opening Content does not invoke AI or write');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Assistant fits phone');
    if(output)await page.screenshot({path:join(output,`assistant-before-${width}.png`),fullPage:true});
    await prepare.evaluate(button=>{button.click();button.click();});
    await page.getByText('3 posts are ready for you to review. Nothing has been published.',{exact:true}).waitFor({timeout:45000});
    assert.equal(await page.locator('[data-assistant-post]').count(),3);
    const result=await page.evaluate(()=>({prepareCount:window.__assistantCheck.prepareCount,uploads:window.__assistantCheck.uploads,writes:window.__assistantCheck.writes}));
    assert.equal(result.prepareCount,1,'Double-tap prepares once');assert.equal(result.uploads.length,3,'Three real PNGs uploaded');
    result.uploads.forEach(upload=>{assert.deepEqual(upload.bytes.slice(0,8),[137,80,78,71,13,10,26,10]);assert.ok(upload.size>1000);});
    assert.ok(result.writes.every(write=>!write.unexpected&&!/publish|schedule/.test(write.path)),'Preparation never publishes or schedules');
    assert.ok(result.writes.filter(write=>write.method==='PATCH').every(write=>write.body.artwork_only&&typeof write.body.expected_caption==='string'));
    await page.waitForFunction(()=>[...document.querySelectorAll('.fl-assistant-preview img')].every(img=>img.complete&&img.naturalWidth>0));
    if(output) {
      await page.screenshot({path:join(output,`assistant-prepared-${width}.png`),fullPage:true});
      await page.locator('[data-assistant-post]').first().evaluate(element=>element.scrollIntoView({block:'start'}));
      await page.screenshot({path:join(output,`assistant-post-${width}.png`),fullPage:true});
    }
    await page.getByRole('button',{name:'Review this post',exact:true}).first().click();
    await page.getByLabel('Draft caption',{exact:true}).waitFor();
    assert.equal(await page.getByLabel('Draft caption',{exact:true}).inputValue(),'Arrive with clean brows. Ask us if you are unsure about preparing for your visit.');
    assert.deepEqual(errors,[]);await context.close();console.log(`PASS assistant prepares real artwork, preserves review and fits ${width}px`);
  }
  {
    const {context,page}=await fixture({saveError:true,partial:true});
    await page.getByText('Some sources couldn’t be checked',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Prepare my next posts',exact:true}).click();
    await page.getByRole('button',{name:'Retry saving design',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.__assistantCheck.uploads.length),2);
    await page.getByRole('button',{name:'Retry saving design',exact:true}).click();
    await page.waitForFunction(()=>window.__assistantCheck.posts.every(post=>post.image_url));
    assert.equal(await page.evaluate(()=>window.__assistantCheck.uploads.length),2,'Retry does not re-upload an already uploaded design');
    assert.equal(await page.evaluate(()=>window.__assistantCheck.prepareCount),1,'Retry does not generate more captions');await context.close();console.log('PASS partial-source failure and failed image attachment recover without new drafts');
  }
  {
    const {context,page}=await fixture({delay:true});
    await page.getByRole('button',{name:'Prepare my next posts',exact:true}).click();
    await page.waitForFunction(()=>!!window.__assistantCheck.release);
    await page.getByRole('button',{name:'Your posts',exact:true}).first().click();
    await page.evaluate(()=>window.__assistantCheck.release());
    await page.waitForFunction(()=>window.__assistantCheck.posts.length===3);
    await page.getByRole('button',{name:'Photos',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.__assistantCheck.uploads.length),0,'Late preparation after navigation does not upload or attach images');await context.close();console.log('PASS late preparation cannot mutate another page');
  }
  {
    const {context,page}=await fixture({readError:true});
    await page.getByRole('button',{name:'Refresh prepared work',exact:true}).waitFor();
    await page.getByRole('button',{name:'Your posts',exact:true}).first().click();
    await page.getByRole('button',{name:'Create a post',exact:true}).waitFor();
    assert.deepEqual(await page.evaluate(()=>window.__assistantCheck.writes),[]);await context.close();console.log('PASS unavailable assistant leaves manual content accessible');
  }
  }
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
