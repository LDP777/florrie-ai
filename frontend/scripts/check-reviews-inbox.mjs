// Real app bundle, fictional records, no external provider calls or sends.
import assert from 'node:assert/strict';
import { readFileSync,existsSync,mkdirSync } from 'node:fs';
import {join,extname} from 'node:path';
import http from 'node:http';
import {launch} from './lib/browser.mjs';
import {fetchStubSource,sessionSeedSource,bundleSupabaseUrl} from './lib/fixtures.mjs';
const dist=new URL('../dist',import.meta.url).pathname;
const server=http.createServer((req,res)=>{let file=join(dist,(req.url||'/').split('?')[0]);if(!existsSync(file)||!extname(file))file=join(dist,'index.html');res.setHeader('content-type',({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'})[extname(file)]||'application/octet-stream');res.end(readFileSync(file));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await launch();
try {
 for(const width of [320,390,1024]){
  const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'});
  await context.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
  await context.addInitScript(fetchStubSource());
  await context.addInitScript(sessionSeedSource(bundleSupabaseUrl(dist)));
  await context.addInitScript(()=>{
   const base=window.fetch;
   const json=(body,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}}));
   const at=new Date(Date.now()-25*60000).toISOString();
   const handoff={title:'Story context is missing',reason:'story_context:unavailable',action:'reply',action_label:'Read and reply',waiting_since:at};
   window.fixture={fail:true,writes:[],handoff};
   window.fetch=(input,options={})=>{
    const url=String(input);
    if(url.includes('/api/google-reviews/requests'))return fixture.fail?json({error:'Request history is unavailable.'},503):json({requests:[
     {id:'r1',client_id:'c1',client_name:'Fictional Morgan',state:'approval'},
     {id:'r2',client_id:'c1',client_name:'Fictional Jamie',state:'sent'},
     {id:'r3',client_id:'c1',client_name:'Fictional Alex',state:'unconfirmed'},
     {id:'r4',client_id:'c1',client_name:'Fictional Rowan',state:'held',reason:'no_consent'},
    ]});
    if(url.includes('/api/google-reviews/status'))return json({available:false,connected:false});
    if(url.includes('/api/inbox/threads'))return json({threads:[{client_id:'c1',client_first_name:'Fictional',client_last_name:'Morgan',space:'clients',segment:'needs',is_known_client:true,unread_count:1,needs_attention:true,last_message_direction:'inbound',last_message_preview:'When will December dates open?',last_message_at:at,last_inbound_at:at,last_channel:'sms',handoff}]});
    if(url.includes('/api/inbox/thread/c1'))return json({client:{id:'c1',first_name:'Fictional',last_name:'Morgan',has_phone:true},handoff:fixture.handoff,default_channel:'sms',drafts:[],messages:[{id:'m1',direction:'inbound',channel:'sms',body:'When will December dates open?',created_at:at}]});
    if(url.includes('/api/inbox/suggestions'))return json({suggestions:[]});
    if(url.includes('/api/inbox/send')){fixture.writes.push(url);return json({error:'Test forbids sends'},409);}
    return base(input,options);
   };
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const origin=`http://127.0.0.1:${server.address().port}`;
  await page.goto(origin+'/reviews');
  const activity=page.getByRole('region',{name:'Review request activity'});
  await activity.getByRole('alert').waitFor();
  assert.ok(!(await activity.innerText()).includes('No review requests yet'));
  await page.evaluate(()=>fixture.fail=false);await activity.getByRole('button',{name:'Refresh',exact:true}).click();
  await activity.getByText('Fictional Morgan',{exact:true}).waitFor();
  for(const label of ['Needs approval','Sent','Check send result','Not sent'])assert.ok((await activity.innerText()).includes(label));
  assert.ok((await activity.innerText()).includes('does not confirm it was read'));
  assert.equal(await activity.getByRole('link',{name:'Review in Outbox'}).getAttribute('href'),'/outbox');
  const eye=page.locator('.client-privacy-toggle');await eye.click();
  await page.waitForFunction(()=>document.querySelector('.client-privacy-toggle')?.getAttribute('aria-pressed')==='true');
  assert.ok(!(await activity.innerText()).includes('Fictional'));
  assert.equal(await activity.getByRole('link').count(),0);
  await eye.click();await activity.getByText('Fictional Morgan',{exact:true}).waitFor();
  await activity.getByRole('link',{name:'Open conversation'}).first().click();
  await page.waitForURL(/\/inbox\?client=c1/);
  const card=page.getByRole('complementary',{name:'Why this needs you'});await card.waitFor();
  assert.ok((await card.innerText()).includes('waiting 25m'));
  await card.getByRole('button',{name:'Read and reply',exact:true}).click();
  assert.equal(await page.locator('textarea').evaluate(el=>el===document.activeElement),true);
  assert.equal(await page.evaluate(()=>fixture.writes.length),0);
  await page.goto(origin+'/inbox');
  await page.getByText('Story context is missing',{exact:true}).first().waitFor();
  assert.ok(!(await page.locator('body').innerText()).includes('needs your yes or no'));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  if(process.env.VISUAL_OUTPUT_DIR){mkdirSync(process.env.VISUAL_OUTPUT_DIR,{recursive:true});await page.screenshot({path:join(process.env.VISUAL_OUTPUT_DIR,`inbox-${width}.png`),fullPage:true});}
  assert.deepEqual(errors,[]);
  await context.close();console.log(`✓ Reviews and Inbox at ${width}px: status, recovery, privacy and working next action; no sends`);
 }
} finally {await browser.close();server.close();}
