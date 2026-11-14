// Actual owner components; synthetic private sentinels and intercepted requests only.
import assert from 'node:assert/strict';
import http from 'node:http';
import { build } from 'esbuild';
import { launch } from './lib/browser.mjs';

const root = new URL('../', import.meta.url).pathname;
const bundle = await build({
  stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {MemoryRouter} from 'react-router-dom';
    import {ClientPrivacyProvider,ClientPrivacyToggle} from './src/contexts/ClientPrivacyContext.jsx';
    import ContentAssistant from './src/components/ContentAssistant.jsx';
    import ContentDirection from './src/components/ContentDirection.jsx';
    import ContentResults from './src/components/ContentResults.jsx';
    import ContentStudioHome,{PostPreview} from './src/components/ContentStudioHome.jsx';
    import GoogleReviews from './src/components/GoogleReviews.jsx';
    import ReplyLearning from './src/components/ReplyLearning.jsx';
    import ClientCareRecord from './src/components/ClientCareRecord.jsx';
    import AppointmentPreparation from './src/components/AppointmentPreparation.jsx';
    import ClientLookup from './src/components/ClientLookup.jsx';
    import MessagePreview from './src/components/MessagePreview.jsx';
    const secret='PRIVATE_SENTINEL';
    const owner={id:'salon-a',auth_id:'user-a',business_name:'Demo Salon',booking_slug:'demo'};
    const post={id:'post-a',caption:secret+' caption',image_url:'https://private.invalid/'+secret+'.jpg',status:'draft',post_type:'general',media_kind:'feed'};
    const run={id:'run-a',request_id:'request-a',status:'ready',brief:{goal:'show_work',focus:secret+' brief'},created_at:'2026-11-14T10:00:00Z',stages:[
      {id:'strategy',status:'complete',output:{summary:secret+' strategy',posts:[{id:'idea-a',title:secret+' title',angle:secret+' angle',format:'feed'}]}},
      {id:'writing',status:'complete',output:{hooks:[secret+' hook'],posts:[{id:'idea-a',title:secret+' heading',caption:secret+' story',format:'story',source_note:secret+' source'}]}},
      {id:'reels',status:'complete',output:{title:secret+' reel',hook:secret+' hook',shots:[{shot:secret+' shot',spoken:secret+' spoken',on_screen:secret+' overlay'}],needs:[secret+' need'],caption:secret+' reel caption'}},
    ]};
    const board={prepared:[{post_id:post.id,post,source:{type:'gallery'},needs:[],reason:secret+' reason'}],opportunities:[],unavailable:[],results:{available:true,campaigns:[{confirmed:3}]}};
    const care={responses:[{id:'response-a',form_name:'Consultation',completed_at:'2026-11-14T10:00:00Z',has_signature:true,consent_text:secret+' consent',pairs:[{field_id:'allergy',type:'text',question:'Any allergies?',answer:secret+' medical answer',answered:true}],worth_knowing:[secret+' clinical note']}],requests:[],templates:[{id:'form-a',name:'Consultation'}]};
    const json=body=>new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
    window.fixture={requests:[],callbacks:[],copied:[],listeners:new Set(),kind:'message',
      session(){return {access_token:'fixture-a',user:{id:'user-a'}};},
      request:async(path,options={})=>{fixture.requests.push({path,method:options.method||'GET'});if(path==='/api/knowledge/learning')return {suggestions:[{id:'suggestion-a',status:'pending',title:secret+' topic',content:secret+' learned answer',evidence:secret+' original reply',category:'faq'}]};throw Error('Unexpected learning request '+path);},
      mount(kind){this.kind=kind;this.root ||= createRoot(document.getElementById('root'));this.root.render(<MemoryRouter><ClientPrivacyProvider><ClientPrivacyToggle/><main>{({
        message:<MessagePreview text={secret+' message'} salonName="Demo Salon"/>,
        photo:<PostPreview post={post}/>,
        lookup:<ClientLookup onChange={value=>fixture.callbacks.push(value)}/>,
        care:<ClientCareRecord clientId="client-a" data={care}/>,
        preparation:<AppointmentPreparation appointmentId="appointment-a" clientId="client-a"/>,
        reviews:<GoogleReviews ownerId={owner.id} salonName={owner.business_name}/>,
        learning:<ReplyLearning request={fixture.request} entries={[]} onSaved={value=>fixture.callbacks.push(value)}/>,
        results:<ContentResults ownerId={owner.id} posts={[post]}/>,
        direction:<ContentDirection treatments={[]} planning={false} note={secret+' preparation note'} drafts={2} scheduled={1} onPlan={()=>{}} onCompose={()=>{}} onGallery={()=>{}} onDrafts={()=>{}} onCalendar={()=>{}}/>,
        studio:<ContentStudioHome drafts={[post]} scheduled={[]} treatments={[]} onCompose={()=>{}} onDrafts={()=>{}} onGallery={()=>{}} onCalendar={()=>{}} planning={false} onPlan={()=>{}} note={secret+' studio note'}/>,
        assistant:<ContentAssistant owner={owner} onPost={value=>fixture.callbacks.push(value)} onPrepared={value=>fixture.callbacks.push(value)} onPosts={()=>{}} onPhotos={()=>{}} onResults={()=>{}} onCompose={value=>fixture.callbacks.push(value)}/>,
      })[kind]}</main></ClientPrivacyProvider></MemoryRouter>);},
    };
    window.fetch=async(input,options={})=>{
      const url=new URL(String(input),location.origin),path=url.pathname,method=options.method||'GET';
      fixture.requests.push({path,method,body:options.body});
      if(method!=='GET')throw Error('Unexpected write '+method+' '+path);
      if(path==='/api/clients')return json({data:[{id:'client-a',first_name:secret,last_name:'Client',email:secret+'@example.test',phone:'07700900123'}],pagination:{has_next:false}});
      if(path==='/api/consultation-forms/responses/response-a')return json({response:{signature_data:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="50"><text y="30">'+secret+'</text></svg>')}});
      if(path==='/api/consultation-forms/preparation/appointment-a')return json({preparation:{confirmed:true,required:true,patch:{required:false,can_complete:true},forms:[{id:'form-a',name:secret+' consultation',status:'received',completed_at:'2026-11-14T10:00:00Z',available:true}]}});
      if(path==='/api/google-reviews/status')return json({available:true,connected:true,location:{name:'accounts/a/locations/a',title:'Demo Salon'}});
      if(path==='/api/google-reviews/reviews')return json({fetched_at:'2026-11-14T10:00:00Z',reviews:[{name:'accounts/a/locations/a/reviews/a',reviewId:'a',starRating:'FIVE',reviewer:{displayName:secret+' reviewer'},comment:secret+' review',reviewReply:{comment:secret+' reply'},fingerprint:'fixture'}]});
      if(path==='/api/content/results')return json({explanation:'Appointments made through tracked links.',campaigns:[{campaign_id:'campaign-a',post_id:post.id,caption:secret+' caption',confirmed:3,pending:1,cancelled:0,booking_value_cents:12000,url:'https://florrie.test/book/demo?campaign='+secret}]});
      if(path==='/api/content/assistant')return json(board);
      if(path==='/api/content/team')return json({available:true,run,recent_runs:[run],has_more:false});
      throw Error('Unexpected request '+path);
    };
    Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>fixture.copied.push(text)},configurable:true});
  `},
  bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',outfile:'fixture.js',
  define:{'process.env.NODE_ENV':'"development"','import.meta.env':'{}'},
  plugins:[{name:'privacy-fixtures',setup(b){
    b.onResolve({filter:/\/lib\/(supabase|config|storage)\.js$/},args=>({path:args.path.split('/').pop(),namespace:'fixture'}));
    b.onResolve({filter:/^@capacitor\/(core|browser)$/},args=>({path:args.path.split('/').pop(),namespace:'fixture'}));
    b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({loader:'js',contents:{
      'config.js':'export const API_BASE="";',
      'supabase.js':'export const supabase={auth:{getSession:async()=>({data:{session:fixture.session()}}),onAuthStateChange:fn=>{fixture.listeners.add(fn);return {data:{subscription:{unsubscribe:()=>fixture.listeners.delete(fn)}}};}}};',
      'storage.js':'export const PUBLIC_BUCKET="fixture";export const objectPath=()=>"fixture";export const publicUrl=()=>"";export async function uploadFile(){throw Error("Unexpected upload");}',
      core:'export const Capacitor={isNativePlatform:()=>false};',
      browser:'export const Browser={open:async()=>{throw Error("Unexpected external browser")}};',
    }[path]}));
  }}],
});
const js=bundle.outputFiles.find(file=>file.path.endsWith('.js')).text;
const css=bundle.outputFiles.filter(file=>file.path.endsWith('.css')).map(file=>file.text).join('\n');
const server=http.createServer((req,res)=>{
  res.setHeader('content-type',req.url==='/fixture.js'?'text/javascript':'text/html');
  res.end(req.url==='/fixture.js'?js:'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><div id="root"></div><script src="/fixture.js"></script></html>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await launch();
let checks=0;
try {
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const origin=`http://127.0.0.1:${server.address().port}`;
  await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin)return route.continue();if(url.hostname==='private.invalid')return route.fulfill({status:200,contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="pink"/></svg>'});return route.abort();});
  const start=async kind=>{await page.goto(origin);await page.evaluate(kind=>{localStorage.clear();fixture.mount(kind);},kind);};
  const eye=()=>page.getByRole('button',{name:'Hide client details',exact:true});
  const conceal=async()=>{await eye().click();await page.waitForFunction(()=>document.querySelector('[aria-label="Hide client details"]').getAttribute('aria-pressed')==='true');};
  const reveal=async()=>{await eye().click();await page.waitForFunction(()=>document.querySelector('[aria-label="Hide client details"]').getAttribute('aria-pressed')==='false');};
  const absent=async()=>{
    const dom=await page.locator('body').evaluate(body=>body.outerHTML);
    assert.ok(!dom.includes('PRIVATE_SENTINEL'),'Private sentinel leaked into rendered markup, attributes or input values');
  };
  const noWrites=async()=>assert.equal(await page.evaluate(()=>fixture.requests.filter(r=>r.method!=='GET').length),0);

  await start('message');await page.getByText('PRIVATE_SENTINEL message',{exact:true}).waitFor();
  await conceal();await absent();await page.getByText('Message hidden',{exact:true}).waitFor();await reveal();await page.getByText('PRIVATE_SENTINEL message',{exact:true}).waitFor();checks++;

  await start('photo');await page.locator('img[src*="PRIVATE_SENTINEL"]').waitFor({state:'attached'});await conceal();await absent();assert.equal(await page.locator('img').count(),0);await reveal();await page.locator('img[src*="PRIVATE_SENTINEL"]').waitFor({state:'attached'});checks++;

  await start('lookup');await page.getByText('PRIVATE_SENTINEL Client',{exact:true}).waitFor();await page.getByRole('searchbox').fill('PRIVATE_SENTINEL');await conceal();await absent();assert.equal(await page.getByRole('searchbox').count(),0);await reveal();assert.equal(await page.getByRole('searchbox').inputValue(),'PRIVATE_SENTINEL');await noWrites();checks++;

  await start('care');await page.locator('details > summary').click();await page.getByText('PRIVATE_SENTINEL medical answer',{exact:true}).waitFor();await page.getByRole('button',{name:'View signature',exact:true}).click();await page.getByRole('img',{name:'Client signature',exact:true}).waitFor();await conceal();await absent();assert.equal(await page.locator('img,input,select').count(),0);assert.equal(await page.getByRole('button',{name:'Send form by text'}).count(),0);await reveal();await page.locator('details > summary').click();await page.getByText('PRIVATE_SENTINEL medical answer',{exact:true}).waitFor();await noWrites();checks++;

  await start('preparation');await page.locator('summary').click();await page.getByText(/PRIVATE_SENTINEL consultation/).waitFor();await conceal();await absent();assert.equal(await page.locator('a[href*="clientId"]').count(),0);await reveal();await page.getByText(/PRIVATE_SENTINEL consultation/).waitFor();await noWrites();checks++;

  await start('reviews');await page.getByText('PRIVATE_SENTINEL reviewer',{exact:true}).waitFor();await page.getByRole('button',{name:'Write my own',exact:true}).click();await page.getByRole('textbox',{name:'Google review reply',exact:true}).fill('PRIVATE_SENTINEL unsaved review reply');await conceal();await absent();assert.equal(await page.locator('textarea').count(),0);assert.equal(await page.getByRole('button',{name:'Approve & publish reply'}).count(),0);await reveal();assert.equal(await page.getByRole('textbox',{name:'Google review reply',exact:true}).inputValue(),'PRIVATE_SENTINEL unsaved review reply');await noWrites();checks++;

  await start('learning');await page.getByLabel('Answer for future clients',{exact:true}).fill('PRIVATE_SENTINEL edited learned answer');await conceal();await absent();assert.equal(await page.getByRole('form',{name:'Review a learned answer'}).count(),0);await reveal();assert.equal(await page.getByLabel('Answer for future clients',{exact:true}).inputValue(),'PRIVATE_SENTINEL edited learned answer');await noWrites();checks++;

  await start('results');await page.getByRole('heading',{name:'PRIVATE_SENTINEL caption',exact:true}).waitFor();await page.getByRole('button',{name:'Show this booking link',exact:true}).click();await page.getByRole('textbox',{name:'Post booking link',exact:true}).waitFor();await conceal();await absent();assert.equal(await page.getByRole('button',{name:'Copy link',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Show this booking link',exact:true}).count(),0);await page.getByText('Confirmed bookings',{exact:true}).waitFor();assert.doesNotMatch(await page.locator('main').innerText(), /£120(?:\.00)?\b/, 'Content booking values are hidden');await page.getByText('Awaiting payment',{exact:true}).waitFor();await reveal();assert.match(await page.locator('main').innerText(), /£120\.00/);assert.match(await page.getByRole('textbox',{name:'Post booking link',exact:true}).inputValue(),/PRIVATE_SENTINEL/);assert.equal(await page.evaluate(()=>fixture.copied.length),0);await noWrites();checks++;

  await start('direction');await page.getByText('PRIVATE_SENTINEL preparation note',{exact:true}).waitFor();await conceal();await absent();await page.getByRole('heading',{name:'What should your content do?',exact:true}).waitFor();await reveal();await page.getByText('PRIVATE_SENTINEL preparation note',{exact:true}).waitFor();checks++;

  await start('studio');await page.getByRole('button',{name:'Plan 3 posts',exact:true}).click();await page.getByText('PRIVATE_SENTINEL studio note',{exact:true}).waitFor();await conceal();await absent();await page.getByRole('heading',{name:'Start with something you have.',exact:true}).waitFor();await reveal();await page.getByText('PRIVATE_SENTINEL studio note',{exact:true}).waitFor();checks++;

  await start('assistant');await page.getByText('PRIVATE_SENTINEL strategy',{exact:true}).waitFor();await page.getByRole('tab',{name:'Writing',exact:true}).click();await page.getByRole('textbox',{name:'Story words',exact:true}).fill('PRIVATE_SENTINEL edited story');await conceal();await absent();assert.equal(await page.locator('img,textarea').count(),0);assert.equal(await page.getByRole('button',{name:'Review caption',exact:false}).count(),0);await page.getByRole('heading',{name:'Your team.',exact:true}).waitFor();await reveal();assert.equal(await page.getByRole('textbox',{name:'Story words',exact:true}).inputValue(),'PRIVATE_SENTINEL edited story');await noWrites();checks++;

  await page.getByRole('tab',{name:'Reels',exact:true}).click();await page.getByRole('heading',{name:'PRIVATE_SENTINEL reel',exact:true}).waitFor();await conceal();await absent();assert.equal(await page.getByRole('button',{name:'Review Reel caption',exact:false}).count(),0);await reveal();await page.getByRole('heading',{name:'PRIVATE_SENTINEL reel',exact:true}).waitFor();await noWrites();checks++;

  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:checks,components:11,providerRequests:0,checks:'Conceal/reveal, sensitive attributes and photos, private links and copy controls, retained edit state, aggregates/static UI and zero unintended writes'}));
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
