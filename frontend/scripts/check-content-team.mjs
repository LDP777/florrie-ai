// Actual ContentTeam component, fictional salons, intercepted APIs. No provider traffic.
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { build } from 'esbuild';
import { launch } from './lib/browser.mjs';

const root = new URL('../', import.meta.url).pathname;
const output = process.env.VISUAL_OUTPUT_DIR;
if (output) mkdirSync(output, { recursive: true });
const bundle = await build({
  stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {MemoryRouter} from 'react-router-dom';
    import ContentTeam from './src/components/ContentTeam.jsx';
    const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
    const owner=id=>({id,auth_id:'user-'+id,business_name:id==='salon-a'?'Fictional Brow Studio':'Second Fictional Salon',booking_slug:id,treatments:[{id:'22222222-2222-4222-8222-222222222222',name:'Signature brows'}]});
    const capabilities=[
      {id:'strategy',name:'Strategy',state:'available',description:'Plans from your salon facts.'},
      {id:'writing',name:'Writing',state:'available',description:'Draft captions for your approval.'},
      {id:'reels',name:'Reels',state:'available',description:'Filming plans, not finished videos.'},
      {id:'results',name:'Results',state:'unavailable',description:'Instagram results are not connected.'},
    ];
    function run(status='queued',request_id='11111111-1111-4111-8111-111111111111',brief={goal:'bookings',focus:'Show what a brow visit includes.',treatment_id:null}) {
      const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',idea=id+':idea:1',source_refs=['treatment:22222222-2222-4222-8222-222222222222'];
      const outputs={
        strategy:{summary:'A week centred on your saved brow service.',posts:[{id:idea,title:'What the visit includes',angle:'Explain the saved treatment facts',format:'feed',source_note:'Your saved brow treatment',source_refs}]},
        writing:{posts:[{id:idea,title:'What the visit includes',caption:'Your brow visit starts with a consultation. Explore the treatment before choosing your appointment.',format:'feed',source_note:'Your saved brow treatment',source_refs}],hooks:['A closer look at your next brow visit']},
        reels:{id:id+':reel:1',title:'Inside your brow visit',hook:'A closer look at your brow appointment',shots:[{shot:'Film your clean treatment setup',spoken:'Every visit starts with a consultation.',on_screen:'Your brow visit'}],caption:'A little look at how your brow visit begins.',needs:['Film the listed shots with your own footage.','Review the facts before filming.'],source_refs},
      };
      return {id,request_id,status,brief,created_at:'2026-10-15T10:00:00.000Z',updated_at:'2026-10-15T10:01:00.000Z',retryable:status==='failed',...(status==='failed'?{error:'Writing could not finish. Your strategy is saved.'}:{}),stages:['strategy','writing','reels'].map((id,index)=>({id,status:status==='ready'?'complete':status==='failed'?(index===0?'complete':index===1?'failed':'waiting'):status==='running'?(index===0?'running':'waiting'):'waiting',output:status==='ready'||(status==='failed'&&index===0)?outputs[id]:null,...(status==='failed'&&index===1?{error:'Writing could not finish.'}:{})}))};
    }
    const metadata=run=>({id:run.id,request_id:run.request_id,status:run.status,brief:run.brief,created_at:run.created_at,updated_at:run.updated_at});
    const s=window.fixture={owner:owner('salon-a'),authOwner:'salon-a',authListeners:new Set(),sessionReads:0,owners:{},requests:[],callbacks:[],available:true,capabilities,run,holdGet:false,holdPost:false,holdSession:false,unknownPost:false,malformedGet:false,malformedPost:false,readFailure:false,postFailure:false,
      account(id=this.owner.id){return this.owners[id] ||= {run:null,history:[]};},
      session(id=this.authOwner){return id?{access_token:'fixture-'+id,user:{id:'user-'+id}}:null;},
      changeAuth(id){this.authOwner=id;for(const callback of this.authListeners)callback(id?'SIGNED_IN':'SIGNED_OUT',this.session());},
      mount(){this.root ||= createRoot(document.getElementById('root'));this.root.render(<MemoryRouter><ContentTeam owner={this.owner} board={this.board||{business_name:this.owner.business_name,prepared:[],opportunities:[],unavailable:[],prepare_capacity:3,results:{available:false,days:90,campaigns:[]}}} loading={false} busy={false} stage="" error="" note="" canPrepare={true} onPrepare={()=>this.callbacks.push({type:'prepare',owner:this.owner.id})} onRefresh={()=>this.callbacks.push({type:'refresh',owner:this.owner.id})} onPost={post=>this.callbacks.push({type:'post',post,owner:this.owner.id})} onPosts={()=>this.callbacks.push({type:'posts',owner:this.owner.id})} onPhotos={()=>this.callbacks.push({type:'photos',owner:this.owner.id})} onResults={()=>this.callbacks.push({type:'results',owner:this.owner.id})} onCompose={post=>{this.callbacks.push({type:'compose',post,owner:this.owner.id});document.getElementById('opened-caption').textContent=post.caption;}}><section aria-label="Existing prepared posts"><p>Your saved posts remain available.</p></section></ContentTeam></MemoryRouter>);},
      switchOwner(){this.owner=owner('salon-b');this.authOwner='salon-b';this.mount();},
      leave(){this.root.render(<p>Another page</p>);},
    };
    window.fetch=async(input,options={})=>{
      const url=new URL(typeof input==='string'?input:input.url,location.origin),path=url.pathname;
      const method=(options.method||'GET').toUpperCase(),body=options.body?JSON.parse(options.body):null;
      const authorization=new Headers(options.headers).get('Authorization');
      const who=authorization?.replace('Bearer fixture-','');
      s.requests.push({path,search:url.search,method,body,owner:who});
      if(!['salon-a','salon-b'].includes(who))throw Error('Missing fixture owner authentication');
      const account=s.account(who);
      if(path==='/api/content/team'&&method==='GET'){
        const response=()=>s.readFailure?json({error:'Could not check your content team just now.'},503):s.malformedGet?json({available:true,run:{status:'mystery'}}):json({available:s.available,run:account.run,recent_runs:account.history.slice(0,20).map(metadata),has_more:account.history.length>20,next_offset:account.history.length>20?20:null,capabilities:s.capabilities,...(!s.available?{reason:'Saved team briefs are not available yet.'}:{})});
        if(s.holdGet){s.holdGet=false;return new Promise(resolve=>{s.releaseGet=()=>resolve(response());});}
        return response();
      }
      if(path==='/api/content/team/runs'&&method==='GET'){
        const offset=Number(url.searchParams.get('offset')||0),limit=Number(url.searchParams.get('limit')||20);
        return json({runs:account.history.slice(offset,offset+limit).map(metadata),has_more:account.history.length>offset+limit,next_offset:account.history.length>offset+limit?offset+limit:null});
      }
      if(/^\\/api\\/content\\/team\\/runs\\/[^/]+$/.test(path)&&method==='GET'){
        const id=decodeURIComponent(path.split('/').pop()),selected=account.history.find(item=>item.id===id)||[account.run].find(item=>item?.id===id);
        const response=()=>selected?json({run:selected}):json({error:'Saved brief not found.'},404);
        if(s.holdHistory){s.holdHistory=false;return new Promise(resolve=>{s.releaseHistory=()=>resolve(response());});}
        return response();
      }
      if(path==='/api/content/team/runs'&&method==='POST'){
        if(s.postFailure)return json({error:'Could not save this brief.'},503);
        account.run=run('queued',body.request_id,{goal:body.goal,focus:body.focus,treatment_id:body.treatment_id});
        const response=()=>s.malformedPost?json({accepted:true},202):json({run:account.run},202);
        if(s.holdPost){s.holdPost=false;return new Promise(resolve=>{s.releasePost=()=>resolve(response());});}
        if(s.unknownPost){s.unknownPost=false;throw new TypeError('The response was interrupted.');}
        return response();
      }
      if(/^\\/api\\/content\\/team\\/runs\\/[^/]+\\/retry$/.test(path)&&method==='POST'){
        const id=decodeURIComponent(path.split('/').at(-2));
        const previous=account.history.find(item=>item.id===id)||[account.run].find(item=>item?.id===id);
        if(!previous)return json({error:'Saved brief not found.'},404);
        account.run={...previous,status:'queued',retryable:false};
        account.history=account.history.map(item=>item.id===id?account.run:item);
        return json({run:account.run},202);
      }
      throw Error('Unexpected request '+method+' '+path);
    };
  ` },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  outfile: 'fixture.js', loader: { '.svg':'dataurl', '.png':'dataurl' },
  define: { 'process.env.NODE_ENV':'"development"', 'import.meta.env':'{}' },
  plugins:[{name:'fictional-owner',setup(b){
    b.onResolve({filter:/\/lib\/(supabase|config)\.js$/},args=>({path:basename(args.path),namespace:'fixture'}));
    b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({loader:'js',contents:{
      'config.js':'export const API_BASE="";',
      'supabase.js':'export const supabase={auth:{getSession:async()=>{fixture.sessionReads++;const session=fixture.session();if(fixture.neverSession)return new Promise(()=>{});if(fixture.holdSession){fixture.holdSession=false;return new Promise(resolve=>{fixture.releaseSession=()=>resolve({data:{session}});});}return {data:{session}};},onAuthStateChange:callback=>{fixture.authListeners.add(callback);return {data:{subscription:{unsubscribe:()=>fixture.authListeners.delete(callback)}}};}}};',
    }[path]}));
  }}],
});
const index=readFileSync(join(root,'index.html'),'utf8');
const tokens=[...index.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(match=>match[1]).join('\n');
const styles=['src/index.css','src/styles/content-assistant.css','src/styles/content-team.css','src/styles/content-studio.css']
  .filter(path=>existsSync(join(root,path))).map(path=>readFileSync(join(root,path),'utf8').replace(/@import\s+url\([^;]+;/g,'')).join('\n');
const css=bundle.outputFiles.filter(file=>file.path.endsWith('.css')).map(file=>file.text).join('\n');
const js=bundle.outputFiles.find(file=>file.path.endsWith('.js')).text;
const fontDir=process.env.VISUAL_FONT_DIR;
const fontCss=fontDir&&existsSync(join(fontDir,'fonts.css'))?readFileSync(join(fontDir,'fonts.css'),'utf8'):'';
const server=http.createServer((req,res)=>{
  const path=(req.url||'/').split('?')[0];
  if(path==='/fixture.js'){res.setHeader('content-type','text/javascript');return res.end(js);}
  if(path.startsWith('/fonts/')&&fontDir&&/^\/fonts\/[a-zA-Z0-9._-]+$/.test(path)){
    const file=join(fontDir,basename(path));
    if(existsSync(file)){res.setHeader('content-type','font/woff2');return res.end(readFileSync(file));}
  }
  res.setHeader('content-type','text/html');
  res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+tokens+'\n'+styles+'\n'+css+'\n'+fontCss+'\nbody{margin:0}#root{max-width:1180px;margin:0 auto;padding:20px 16px 90px}#opened-caption:empty{display:none}</style><div id="root"></div><output id="opened-caption" aria-label="Opened draft caption"></output><script src="/fixture.js"></script></html>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await launch(),origin=`http://127.0.0.1:${server.address().port}`;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function fixture({width=390,setup,clock=false}={}) {
  const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'});
  const external=[],errors=[];
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(external.push(new URL(route.request().url()).origin),route.abort()));
  const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  if(clock)await page.clock.install();
  await page.goto(origin);if(setup)await page.evaluate(setup);await page.evaluate(()=>fixture.mount());
  const close=async()=>{assert.deepEqual(errors,[],'No page errors');assert.deepEqual(external,[],'No external network requests');await context.close();};
  return {context,page,close};
}
const writes=page=>page.evaluate(()=>fixture.requests.filter(request=>request.method!=='GET'));
async function openBrief(page) {
  await page.getByRole('button',{name:'Brief my team',exact:true}).click();
  await page.getByRole('textbox',{name:/^What would you like to focus on\?/}).fill('Show what a brow visit includes.');
}
async function screenshot(page,name) {
  await page.evaluate(()=>document.fonts.ready);
  if(output)await page.screenshot({path:join(output,name+'.png'),fullPage:true,style:'#opened-caption{display:none!important}'});
}
async function fits(page) {
  const overflow=await page.evaluate(()=>({pageWidth:document.documentElement.scrollWidth,width:innerWidth,offenders:[...document.querySelectorAll('#root *')].filter(element=>element.getBoundingClientRect().right>innerWidth+1).slice(0,8).map(element=>({tag:element.tagName,className:element.className,right:element.getBoundingClientRect().right,text:element.textContent.slice(0,70)}))}));
  if(overflow.pageWidth>overflow.width&&output)await page.screenshot({path:join(output,'content-team-overflow.png'),fullPage:true});
  assert.ok(overflow.pageWidth<=overflow.width,'No horizontal page overflow: '+JSON.stringify(overflow));
  const small=await page.locator('#root button:not(:disabled),#root input,#root textarea,#root select,#root a,#root summary').evaluateAll(elements=>elements.filter(element=>element.getClientRects().length).map(element=>({name:element.getAttribute('aria-label')||element.textContent.trim(),rect:element.getBoundingClientRect(),after:getComputedStyle(element,'::after')})).filter(({rect,after})=>Math.max(rect.width,parseFloat(after.width)||0)<44||Math.max(rect.height,parseFloat(after.height)||0)<44).map(({name,rect})=>({name,width:rect.width,height:rect.height})));
  assert.deepEqual(small,[],'Visible controls meet a 44px tap target');
}

try {
  for(const width of [390,1024]) {
    const {page,close}=await fixture({width});
    await page.getByRole('button',{name:'Brief my team',exact:true}).waitFor();
    assert.deepEqual(await writes(page),[],'Opening Content never generates or writes');
    assert.match(await page.locator('.fl-team-hero h2').evaluate(el=>getComputedStyle(el).fontFamily),/Playfair Display/,'Existing display font is retained');
    assert.match(await page.locator('.fl-team-hero-copy > p').evaluate(el=>getComputedStyle(el).fontFamily),/Plus Jakarta Sans/,'Existing body font is retained');
    await fits(page);await screenshot(page,`content-team-home-${width}`);
    await openBrief(page);
    assert.deepEqual(await writes(page),[],'Choosing a brief remains local until explicit save');
    const start=page.getByRole('button',{name:'Start content brief',exact:true});
    await page.evaluate(()=>fixture.holdPost=true);
    await start.evaluate(button=>{button.click();button.click();});
    await page.waitForFunction(()=>!!fixture.releasePost);
    const requests=await writes(page);
    assert.equal(requests.length,1,'Duplicate click submits once');
    assert.equal(requests[0].path,'/api/content/team/runs');assert.match(requests[0].body.request_id,uuid);
    assert.equal(requests[0].body.focus,'Show what a brow visit includes.');
    assert.equal(requests[0].owner,'salon-a');
    await page.evaluate(()=>fixture.releasePost());
    await page.getByRole('button',{name:'Check progress',exact:true}).waitFor();
    await screenshot(page,`content-team-working-${width}`);
    await page.evaluate(()=>fixture.account().run=fixture.run('ready',fixture.account().run.request_id,fixture.account().run.brief));
    await page.getByRole('button',{name:'Check progress',exact:true}).click();
    await page.getByRole('tab',{name:'Writing',exact:true}).click();
    await page.getByRole('button',{name:'Review caption',exact:true}).first().click();
    await page.getByRole('status',{name:'Opened draft caption'}).waitFor();
    const opened=await page.evaluate(()=>fixture.callbacks.find(callback=>callback.type==='compose'));
    assert.match(opened.post.caption,/consultation/);assert.equal(opened.owner,'salon-a');
    assert.equal((await writes(page)).length,1,'Review only opens a draft; no publishing, scheduling or extra generation');
    await page.getByRole('tab',{name:'Reels',exact:true}).click();
    await page.getByText('YOUR FILMING PLAN',{exact:true}).waitFor();
    assert.equal(await page.locator('video').count(),0,'A filming plan is not presented as finished footage');
    await page.getByRole('button',{name:'Review Reel caption',exact:true}).click();
    assert.equal((await writes(page)).length,1);
    await fits(page);await screenshot(page,`content-team-ready-${width}`);
    assert.equal(await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches),true);
    const animations=await page.evaluate(()=>document.getAnimations().filter(animation=>animation.playState==='running'&&animation.effect?.getTiming().iterations===Infinity).length);
    assert.equal(animations,0,'Reduced-motion mode has no continuously running decoration');
    await close();console.log(`PASS Content Team explicit brief, dedupe, saved progress, review-only outputs and ${width}px layout`);
  }
  {
    const {page,close}=await fixture({setup:()=>{fixture.account().run=fixture.run('queued');}});
    await page.getByText('Your brief is saved and waiting for the team.',{exact:false}).waitFor();
    assert.deepEqual(await writes(page),[],'A saved active run resumes with reads only');
    await page.evaluate(()=>fixture.account().run=fixture.run('ready'));
    await page.getByText('Your brief is ready',{exact:true}).waitFor({timeout:10000});
    assert.equal((await writes(page)).length,0,'Progress polling cannot generate replacement work');
    await page.evaluate(()=>fixture.leave());await page.getByText('Another page',{exact:true}).waitFor();
    await page.evaluate(()=>fixture.mount());
    await page.getByText('Your brief is ready',{exact:true}).waitFor();
    assert.equal((await writes(page)).length,0,'Remount recovers saved work without POST');
    await page.getByRole('tab',{name:'Strategy',exact:true}).focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.getByRole('tab',{name:'Writing',exact:true}).getAttribute('aria-selected'),'true');
    assert.equal(await page.getByRole('tab',{name:'Writing',exact:true}).evaluate(el=>el===document.activeElement),true);
    await page.keyboard.press('End');
    assert.equal(await page.getByRole('tab',{name:'Reels',exact:true}).getAttribute('aria-selected'),'true');
    await page.keyboard.press('Home');
    assert.equal(await page.getByRole('tab',{name:'Strategy',exact:true}).getAttribute('aria-selected'),'true');
    await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('tabpanel').evaluate(el=>el===document.activeElement),true,'Tab reaches the active panel');
    await page.getByRole('tab',{name:'Writing',exact:true}).click();
    await page.getByRole('button',{name:'Review caption',exact:true}).focus();await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(()=>fixture.callbacks.filter(item=>item.type==='compose').length),1,'Review is keyboard accessible');
    assert.deepEqual(await writes(page),[]);
    await close();console.log('PASS durable polling and remount recovery, keyboard tabs and review');
  }
  for(const failure of ['unknownPost','malformedPost']) {
    const {page,close}=await fixture({setup:()=>{fixture.account().run=null;}});
    await openBrief(page);await page.evaluate(flag=>fixture[flag]=true,failure);
    await page.getByRole('button',{name:'Start content brief',exact:true}).click();
    await page.getByRole('button',{name:'Retry this same brief',exact:true}).waitFor();
    const sent=(await writes(page))[0].body;
    assert.ok(await page.getByRole('textbox',{name:/^What would you like to focus on\?/}).isDisabled(),'An uncertain request keeps its exact brief');
    assert.equal(await page.evaluate(()=>Object.values(sessionStorage).some(value=>value.includes(fixture.account().run.request_id))),true,'Request identity survives interrupted responses');
    assert.equal(await page.getByText('Your brief is ready',{exact:true}).count(),0,'Unknown response cannot claim completion');
    await page.getByRole('button',{name:'Check progress',exact:true}).click();
    await page.getByText('Your brief is saved and waiting for the team.',{exact:false}).waitFor();
    assert.equal((await writes(page)).length,1,'Recovery reads the accepted run rather than creating another');
    assert.equal(await page.evaluate(id=>Object.values(sessionStorage).some(value=>value.includes(id)),sent.request_id),false,'Confirmed request clears the pending receipt');
    await close();console.log(`PASS ${failure} recovery keeps request identity and confirms saved work`);
  }
  {
    const {page,close}=await fixture();await openBrief(page);
    await page.evaluate(()=>fixture.postFailure=true);
    await page.getByRole('button',{name:'Start content brief',exact:true}).click();
    await page.getByRole('button',{name:'Retry this same brief',exact:true}).waitFor();
    await page.getByRole('button',{name:'Check progress',exact:true}).click();
    await page.getByRole('button',{name:'Retry this same brief',exact:true}).waitFor();
    await page.evaluate(()=>fixture.postFailure=false);
    await page.getByRole('button',{name:'Retry this same brief',exact:true}).click();
    await page.getByText('Your brief is saved and waiting for the team.',{exact:false}).waitFor();
    const sent=await writes(page);assert.equal(sent.length,2);assert.deepEqual(sent[1].body,sent[0].body,'Explicit retry reuses UUID and exact brief');
    await close();console.log('PASS retry after failed save reuses the same brief and UUID');
  }
  {
    const {page,close}=await fixture({setup:()=>{fixture.account().run=fixture.run('failed');}});
    await page.getByText('Writing could not finish. Your strategy is saved.',{exact:true}).waitFor();
    await page.getByText('A week centred on your saved brow service.',{exact:true}).waitFor();
    assert.deepEqual(await writes(page),[],'Viewing failed work does not retry it');
    await page.getByRole('button',{name:'Retry unfinished work',exact:true}).evaluate(button=>{button.click();button.click();});
    await page.getByText('Your brief is saved and waiting for the team.',{exact:false}).waitFor();
    const sent=await writes(page);assert.equal(sent.length,1);assert.match(sent[0].path,/\/runs\/[^/]+\/retry$/);assert.deepEqual(sent[0].body,{});
    assert.equal(await page.evaluate(()=>fixture.account().run.stages[0].status),'complete','Retry retains completed strategy');
    await close();console.log('PASS failed stage retry is explicit, deduplicated and preserves completed work');
  }
  for(const failure of ['readFailure','malformedGet','malformedReady','unavailable']) {
    const {page,close}=await fixture();
    await page.evaluate(flag=>{
      if(flag==='unavailable')fixture.available=false;
      else if(flag==='malformedReady')fixture.account().run={...fixture.run('queued'),status:'ready'};
      else fixture[flag]=true;
      fixture.leave();
    },failure);
    await page.getByText('Another page',{exact:true}).waitFor();await page.evaluate(()=>fixture.mount());
    if(failure==='unavailable')await page.getByText('The new team is not available yet',{exact:true}).waitFor();
    else await page.getByRole('alert').waitFor();
    await page.getByRole('button',{name:'See all posts',exact:true}).click();
    await page.getByRole('button',{name:'Prepare my next posts',exact:true}).click();
    await page.getByText('Your work is the starting point.',{exact:true}).click();
    await page.getByText('Booking results could not be checked.',{exact:true}).waitFor();
    assert.equal(await page.getByText(/0 confirmed through tracked post links/).count(),0,'Missing results cannot become zero bookings');
    assert.equal(await page.getByText('Your brief is ready',{exact:true}).count(),0,'Unavailable/malformed work cannot claim readiness');
    assert.deepEqual(await writes(page),[],'Manual navigation remains independent of unavailable team work');
    assert.deepEqual(await page.evaluate(()=>fixture.callbacks.map(item=>item.type)),['posts','prepare','photos']);
    await close();console.log(`PASS ${failure} keeps existing content controls usable and results honest`);
  }
  {
    const {page,close}=await fixture();
    for(const confirmed of [null,undefined,'unknown',-1]) {
      await page.evaluate(value=>{fixture.board={prepared:[],opportunities:[],unavailable:[],results:{available:true,days:90,campaigns:[{id:'campaign-a',confirmed:value}]}};fixture.mount();},confirmed);
      await page.getByText('Booking results could not be checked.',{exact:true}).waitFor();
      assert.equal(await page.getByText(/confirmed through tracked post links/).count(),0,'Missing/invalid campaign metrics cannot become zero');
    }
    for(const confirmed of [0,2]) {
      await page.evaluate(value=>{fixture.board.results.campaigns[0].confirmed=value;fixture.mount();},confirmed);
      await page.getByText(`${confirmed} confirmed through tracked post links in 90 days.`,{exact:true}).waitFor();
    }
    assert.deepEqual(await writes(page),[]);await close();console.log('PASS unknown booking metrics stay unknown while verified zero and positive counts display');
  }
  for(const held of ['holdGet','holdPost','holdSession']) {
    const {page,close}=await fixture({setup:held==='holdPost'?undefined:()=>{fixture.holdGet=true;}});
    if(held==='holdPost'){
      await openBrief(page);await page.evaluate(()=>fixture.holdPost=true);
      await page.getByRole('button',{name:'Start content brief',exact:true}).click();await page.waitForFunction(()=>!!fixture.releasePost);
    } else if(held==='holdSession') {
      await page.waitForFunction(()=>!!fixture.releaseGet);await page.evaluate(()=>fixture.releaseGet());
      await page.getByRole('button',{name:'Brief my team',exact:true}).waitFor();
      await page.evaluate(()=>{fixture.leave();fixture.holdSession=true;});await page.getByText('Another page',{exact:true}).waitFor();
      await page.evaluate(()=>fixture.mount());await page.waitForFunction(()=>!!fixture.releaseSession);
    } else await page.waitForFunction(()=>!!fixture.releaseGet);
    await page.evaluate(()=>fixture.switchOwner());
    await page.waitForFunction(()=>fixture.requests.some(request=>request.owner==='salon-b'));
    await page.evaluate(kind=>fixture[kind==='holdGet'?'releaseGet':kind==='holdPost'?'releasePost':'releaseSession'](),held);
    await page.getByRole('button',{name:'Brief my team',exact:true}).waitFor();
    assert.equal(await page.getByText('Your brief is saved and waiting for the team.',{exact:false}).count(),0,'Previous salon state cannot appear for the new salon');
    assert.equal(await page.evaluate(()=>fixture.callbacks.length),0);
    assert.ok((await writes(page)).every(request=>request.owner==='salon-a'),'Late old work cannot write as the new salon');
    await close();console.log(`PASS owner switch isolates ${held} completion`);
  }
  {
    const {page,close}=await fixture();await openBrief(page);await page.evaluate(()=>fixture.holdPost=true);
    await page.getByRole('button',{name:'Start content brief',exact:true}).click();await page.waitForFunction(()=>!!fixture.releasePost);
    await page.evaluate(()=>fixture.leave());await page.getByText('Another page',{exact:true}).waitFor();
    await page.evaluate(()=>fixture.releasePost());
    assert.equal(await page.getByText('Your brief is saved and waiting for the team.',{exact:false}).count(),0);
    assert.equal(await page.evaluate(()=>fixture.callbacks.length),0,'Leaving cannot open a composer or prepare assets');
    assert.equal((await writes(page)).length,1);
    await close();console.log('PASS late brief response after navigation has no page or publishing side effects');
  }
  {
    const {page,close}=await fixture({setup:()=>{fixture.authOwner='salon-b';}});
    await page.getByRole('alert').filter({hasText:'Your account changed.'}).waitFor();
    assert.deepEqual(await page.evaluate(()=>fixture.requests),[],'An SDK identity mismatch cannot make even a read for stale owner props');
    assert.equal(await page.getByRole('button',{name:'Brief my team',exact:true}).count(),0);
    await close();console.log('PASS SDK user identity must match the displayed salon before requests');
  }
  for(const situation of ['displayed','read','write']) {
    const {page,close}=await fixture({setup:situation==='read'?()=>{fixture.holdGet=true;fixture.account().run=fixture.run('ready');}:situation==='displayed'?()=>{fixture.account().run=fixture.run('ready');}:undefined});
    if(situation==='displayed'){
      await page.getByRole('tab',{name:'Writing',exact:true}).click();
      await page.getByText('Your brow visit starts with a consultation. Explore the treatment before choosing your appointment.',{exact:true}).waitFor();
    } else if(situation==='read')await page.waitForFunction(()=>!!fixture.releaseGet);
    else {
      await openBrief(page);await page.evaluate(()=>fixture.holdPost=true);
      await page.getByRole('button',{name:'Start content brief',exact:true}).click();await page.waitForFunction(()=>!!fixture.releasePost);
    }
    await page.evaluate(()=>fixture.changeAuth('salon-b'));
    await page.getByRole('alert').filter({hasText:'Your account changed.'}).waitFor();
    if(situation==='read')await page.evaluate(()=>fixture.releaseGet());
    if(situation==='write')await page.evaluate(()=>fixture.releasePost());
    assert.equal(await page.getByRole('tab',{name:'Writing',exact:true}).count(),0,'Prior owner work is removed without waiting for props to catch up');
    assert.equal(await page.getByRole('button',{name:'Start content brief',exact:true}).count(),0);
    assert.equal(await page.evaluate(()=>fixture.callbacks.length),0);
    assert.ok((await page.evaluate(()=>fixture.requests)).every(request=>request.owner==='salon-a'),'Auth change cannot send a request with B token under A owner');
    assert.equal((await writes(page)).length,situation==='write'?1:0,'Late responses cannot start any additional write');
    await close();console.log(`PASS SDK auth event invalidates ${situation} work without owner-prop change`);
  }
  for(const during of ['load','save']) {
    const {page,close}=await fixture({clock:true,setup:during==='load'?()=>{fixture.neverSession=true;}:undefined});
    if(during==='save'){
      await openBrief(page);await page.evaluate(()=>fixture.neverSession=true);
      await page.getByRole('button',{name:'Start content brief',exact:true}).click();
    }
    await page.waitForFunction(()=>fixture.sessionReads>0);
    await page.clock.fastForward(10001);
    await page.getByRole('alert').filter({hasText:'taking too long'}).waitFor();
    assert.deepEqual(await writes(page),[],'A stalled session does not send a write');
    assert.equal(await page.getByRole('button',{name:'Saving your brief…',exact:true}).count(),0,'Bounded session check releases busy state');
    await close();console.log(`PASS stalled session ${during} exits after the bounded deadline`);
  }
  {
    const {page,close}=await fixture({setup:()=>{
      const older=fixture.run('ready');older.id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';older.brief={...older.brief,focus:'Earlier saved salon plan'};older.created_at='2026-10-14T10:00:00.000Z';older.stages[1].output.posts[0].caption='Earlier saved caption, ready for another look.';
      fixture.account().run=fixture.run('queued');fixture.account().history=[fixture.account().run,older];
    }});
    const previous=page.getByRole('combobox',{name:'Saved briefs',exact:true});
    await previous.selectOption('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    await page.getByText('Earlier saved salon plan',{exact:true}).waitFor();
    await page.getByRole('tab',{name:'Writing',exact:true}).click();
    await page.getByRole('button',{name:'Review caption',exact:true}).click();
    await page.getByRole('status',{name:'Opened draft caption'}).waitFor();
    assert.equal(await page.getByRole('status',{name:'Opened draft caption'}).textContent(),'Earlier saved caption, ready for another look.');
    assert.deepEqual(await writes(page),[],'Reading/reviewing history does not create a replacement brief');
    assert.ok(await page.getByRole('button',{name:'Brief my team',exact:true}).isDisabled(),'Viewing history cannot hide an active team run');
    await page.getByRole('button',{name:'Check progress',exact:true}).click();
    await page.getByText('Earlier saved salon plan',{exact:true}).waitFor();
    assert.ok(await page.getByRole('button',{name:'Brief my team',exact:true}).isDisabled());
    await close();console.log('PASS earlier saved brief remains reviewable without replacing active work');
  }
  {
    const {page,close}=await fixture({setup:()=>{
      const older=fixture.run('failed');older.id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';older.brief={...older.brief,focus:'Earlier unfinished campaign'};older.created_at='2026-10-14T10:00:00.000Z';
      fixture.account().run=fixture.run('ready');fixture.account().history=[fixture.account().run,older];
    }});
    const previous=page.getByRole('combobox',{name:'Saved briefs',exact:true});
    await previous.selectOption('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    await page.getByText('Earlier unfinished campaign',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Retry unfinished work',exact:true}).click();
    await page.getByText('Your brief is saved and waiting for the team.',{exact:false}).waitFor();
    const sent=await writes(page);assert.equal(sent.length,1);assert.equal(sent[0].path,'/api/content/team/runs/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/retry');
    await page.evaluate(()=>{
      const account=fixture.account(),older=account.history.find(item=>item.id==='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
      const completed={...fixture.run('ready',older.request_id,older.brief),id:older.id,created_at:older.created_at};
      completed.stages[1].output.posts[0].caption='The earlier campaign is finished and stays ready for review.';
      account.history=account.history.map(item=>item.id===older.id?completed:item);
      // Once the older retry finishes, the API defaults to the newer ready brief.
      account.run=account.history.find(item=>item.id!==older.id);
    });
    await page.getByRole('button',{name:'Check progress',exact:true}).click();
    await page.getByText('Your brief is ready',{exact:true}).waitFor();
    await page.getByText('Earlier unfinished campaign',{exact:true}).waitFor();
    assert.equal(await previous.inputValue(),'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Completing older work cannot replace the selected brief');
    await page.getByRole('tab',{name:'Writing',exact:true}).click();
    await page.getByRole('button',{name:'Review caption',exact:true}).click();
    await page.getByRole('status',{name:'Opened draft caption'}).waitFor();
    assert.equal(await page.getByRole('status',{name:'Opened draft caption'}).textContent(),'The earlier campaign is finished and stays ready for review.');
    assert.equal((await writes(page)).length,1,'The completed historical retry needs no extra generation');
    assert.ok((await page.evaluate(()=>fixture.requests)).filter(request=>request.method==='GET'&&request.path.endsWith('/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).length>=2,'Progress checks the selected saved brief itself');
    await close();console.log('PASS retried earlier brief finishes visibly even when the API defaults back to a newer ready brief');
  }
  {
    const {page,close}=await fixture({setup:()=>{
      fixture.account().run=fixture.run('ready');
      const post=fixture.account().run.stages[1].output.posts[0];post.format='story';post.caption='Your brow visit starts with a consultation. Explore our treatments before choosing your appointment.';
      fixture.drawnText=[];const original=CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText=function(text,...args){fixture.drawnText.push(text);return original.call(this,text,...args);};
    }});
    await page.getByRole('tab',{name:'Writing',exact:true}).click();
    await page.getByRole('textbox',{name:'Story heading',exact:true}).fill('A little look at your brow visit');
    await page.getByRole('textbox',{name:'Story words',exact:true}).fill('We start with a consultation so you can explore the treatment before choosing your appointment.');
    assert.equal(await page.getByRole('textbox',{name:'Story words',exact:true}).getAttribute('maxlength'),'240');
    await fits(page);
    await page.getByRole('button',{name:'Review caption',exact:true}).click();
    await page.waitForFunction(()=>fixture.callbacks.some(item=>item.type==='compose'));
    const image=await page.evaluate(async()=>{
      const post=fixture.callbacks.find(item=>item.type==='compose').post,file=post.imageFile;
      if(!(file instanceof File))return {isFile:false,format:post.format};
      const bitmap=await createImageBitmap(file),bytes=[...new Uint8Array(await file.slice(0,8).arrayBuffer())];
      const result={isFile:true,format:post.format,title:post.title,caption:post.caption,name:file.name,type:file.type,size:file.size,width:bitmap.width,height:bitmap.height,bytes,text:fixture.drawnText.join(' ').replace(/\s+/g,' ')};
      bitmap.close();return result;
    });
    assert.equal(image.isFile,true,'Story review hands off a finished local PNG, not an invisible text-only caption');
    assert.equal(image.format,'story');assert.equal(image.type,'image/png');assert.match(image.name,/\.png$/);
    assert.deepEqual([image.width,image.height],[1080,1920]);assert.ok(image.size>1000);assert.deepEqual(image.bytes,[137,80,78,71,13,10,26,10]);
    assert.equal(image.title,'A little look at your brow visit');
    assert.equal(image.caption,'We start with a consultation so you can explore the treatment before choosing your appointment.');
    assert.ok(image.text.includes(image.title),'The actual Story pixels contain the edited heading');
    assert.ok(image.text.includes(image.caption),'The actual Story pixels contain the edited caption');
    await screenshot(page,'content-team-story-edited-390');
    assert.deepEqual(await writes(page),[],'Story rendering does not upload, save, schedule or publish');
    await close();console.log('PASS Story review renders edited heading and words into a 1080×1920 PNG before composer handoff');
  }
  {
    const {page,close}=await fixture({setup:()=>{
      const current=fixture.run('ready');current.stages[1].output.posts[0].format='story';
      const older=fixture.run('ready');older.id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';older.brief={...older.brief,focus:'Another saved campaign'};
      fixture.account().run=current;fixture.account().history=[current,older];
    }});
    await page.getByRole('tab',{name:'Writing',exact:true}).click();
    await page.evaluate(()=>fixture.holdSession=true);
    await page.getByRole('button',{name:'Review caption',exact:true}).click();
    await page.waitForFunction(()=>!!fixture.releaseSession);
    await page.getByRole('combobox',{name:'Saved briefs',exact:true}).selectOption('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    await page.getByText('Another saved campaign',{exact:true}).waitFor();
    await page.evaluate(()=>fixture.releaseSession());
    await page.getByText('Preparing your draft for review…',{exact:true}).waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>fixture.callbacks.length),0,'Changing the selected brief cancels a pending Story handoff');
    assert.deepEqual(await writes(page),[]);
    await close();console.log('PASS selecting another brief prevents a late Story image opening the wrong composer');
  }
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
