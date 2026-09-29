// Actual Google Reviews component; all accounts, requests and replies are fictional.
import assert from 'node:assert/strict';
import http from 'node:http';
import { build } from 'esbuild';
import { launch } from './lib/browser.mjs';

const root = new URL('../', import.meta.url).pathname;
const bundle = await build({
  stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import GoogleReviews from './src/components/GoogleReviews.jsx';
    window.fixture={owner:'salon-a',native:true,opened:[],listeners:new Set(),requests:[],
      status:{available:true,connected:false},locations:[{name:'accounts/1/locations/1',title:'North Studio',address:'1 Example Street'},{name:'accounts/1/locations/2',title:'South Studio',address:'2 Example Street'}],
      mount(){this.root ||= createRoot(document.getElementById('root'));this.root.render(<React.StrictMode><GoogleReviews ownerId={this.owner} salonName={this.owner==='salon-a'?'Salon A':'Salon B'}/></React.StrictMode>);}
    };
    window.fetch=async(input,options={})=>{
      const url=new URL(String(input),location.origin),path=url.pathname.replace('/api/google-reviews','');
      const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
      fixture.requests.push({path,search:url.search,method:options.method||'GET',body:options.body?JSON.parse(options.body):null,authorization:options.headers?.Authorization});
      if(path==='/status')return json(fixture.status);
      if(path==='/connect')return json({url:fixture.invalidUrl?'https://untrusted.test/':'https://accounts.google.com/o/oauth2/v2/auth?client_id=fictional&state=fictional&prompt=consent+select_account'});
      if(path==='/locations')return fixture.failLocations?json({error:'Could not load business profiles.'},503):json({locations:fixture.locations});
      if(path==='/location'){
        if(fixture.failSelection)return json({error:'The Google connection changed. Reload and choose your business again.'},409);
        fixture.status.location=fixture.locations.find(l=>l.name===JSON.parse(options.body).name);
        return json({location:fixture.status.location});
      }
      if(path==='/reviews'){
        if(fixture.failReviews)return json({error:'Reviews could not be refreshed.'},503);
        const loc=fixture.status.location;
        return json({fetched_at:new Date().toISOString(),reviews:[{name:loc.name+'/reviews/r1',reviewId:'r1',starRating:'FIVE',reviewer:{displayName:'Fictional reviewer'},comment:'Review for '+loc.title,fingerprint:'fingerprint-'+loc.name,reviewReply:fixture.reply?{comment:fixture.reply}:null}]});
      }
      if(path==='/reviews/r1/draft'){
        if(fixture.holdDraft)return new Promise(resolve=>{fixture.finishDraft=()=>resolve(json({draft:'Late draft from previous salon',fingerprint:'old'}));});
        return json({draft:'Thank you for your kind feedback.',fingerprint:'fingerprint-'+fixture.status.location.name});
      }
      if(path==='/reviews/r1/reply'){
        if(fixture.failReply)return json({error:'The reply result is uncertain. Reload Google reviews before trying again.'},503);
        fixture.reply=JSON.parse(options.body).text;return json({reply:{comment:fixture.reply}});
      }
      if(path==='/disconnect'){fixture.status={available:true,connected:false};return json({disconnected:true});}
      throw Error('Unexpected request '+path);
    };
  ` },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
  plugins: [{ name: 'fictional-account-and-google', setup(b) {
    b.onResolve({ filter: /\/lib\/(supabase|config)\.js$/ }, args => ({path:args.path.split('/').pop(),namespace:'fixture'}));
    b.onResolve({ filter: /^@capacitor\/(core|browser)$/ }, args => ({path:args.path.split('/').pop(),namespace:'fixture'}));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({path}) => ({loader:'js',contents:{
      'config.js':'export const API_BASE="https://api.florrie.test";',
      core:'export const Capacitor={isNativePlatform:()=>fixture.native};',
      browser:'export const Browser={async open({url}){fixture.opened.push(url);},async addListener(name,callback){fixture.listeners.add(callback);return{async remove(){fixture.listeners.delete(callback);}};}};',
      'supabase.js':'export const supabase={auth:{async getSession(){if(fixture.holdSession)return new Promise(resolve=>{fixture.finishSession=()=>resolve({data:{session:{access_token:"fixture-salon-a"}}});});return {data:{session:{access_token:"fixture-"+fixture.owner}}};}}};',
    }[path]}));
  }}],
});
const server=http.createServer((req,res)=>{const js=req.url==='/fixture.js';res.setHeader('content-type',js?'text/javascript':'text/html');res.end(js?bundle.outputFiles[0].text:'<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/fixture.js"></script>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await launch();
try {
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const origin=`http://127.0.0.1:${server.address().port}`;
  await page.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
  const start=async setup=>{await page.goto(origin);if(setup)await page.evaluate(setup);await page.evaluate(()=>fixture.mount());};
  const connected=()=>{fixture.status={available:true,connected:true,location:fixture.locations[0]};};
  const ready=()=>page.getByRole('button',{name:'Change business',exact:true}).waitFor();

  await start();await page.getByText('Connect the Google account that manages Salon A, then choose its Business Profile.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Connect Google Business Profile',exact:true}).click();
  await page.waitForFunction(()=>fixture.opened.length===1);
  assert.equal(await page.evaluate(()=>fixture.requests.find(r=>r.path==='/connect').search),'?platform=native');
  await page.evaluate(()=>{fixture.status={available:true,connected:true};for(const callback of fixture.listeners)callback();});
  await page.getByRole('button',{name:'Use South Studio, 2 Example Street',exact:true}).click();
  await page.getByText('Review for South Studio',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>fixture.requests.filter(r=>r.path==='/location').length),1);
  await page.getByRole('button',{name:'Change business',exact:true}).click();
  assert.ok(await page.getByRole('button',{name:'Use South Studio, 2 Example Street',exact:true}).isDisabled());
  await page.getByRole('button',{name:'Keep current business',exact:true}).click();
  await page.getByText('Review for South Studio',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Change business',exact:true}).click();
  await page.getByRole('button',{name:'Use North Studio, 1 Example Street',exact:true}).click();
  await page.getByText('Review for North Studio',{exact:true}).waitFor();
  assert.equal(await page.getByText('Review for South Studio',{exact:true}).count(),0);

  await page.evaluate(()=>fixture.failLocations=true);await page.getByRole('button',{name:'Change business',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Could not load business profiles.'}).waitFor();
  await page.evaluate(()=>fixture.failLocations=false);await page.getByRole('button',{name:'Retry',exact:true}).click();
  await page.getByRole('button',{name:'Use South Studio, 2 Example Street',exact:true}).waitFor();
  await page.evaluate(()=>fixture.failSelection=true);await page.getByRole('button',{name:'Use South Studio, 2 Example Street',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'The Google connection changed.'}).waitFor();
  assert.equal(await page.evaluate(()=>fixture.status.location.title),'North Studio','a refused selection does not replace the current business');
  await page.getByRole('button',{name:'Keep current business',exact:true}).click();

  await page.getByRole('button',{name:'Draft a reply',exact:true}).click();
  const reply=page.getByRole('textbox',{name:'Google review reply',exact:true});
  const approval=page.getByRole('checkbox',{name:'I approve these exact words as a public reply on Google.'});
  await reply.fill('My approved wording');await approval.check();await reply.fill('My edited wording');
  assert.ok(await page.getByRole('button',{name:'Approve & publish reply',exact:true}).isDisabled());
  await approval.check();await page.evaluate(()=>fixture.failReply=true);
  await page.getByRole('button',{name:'Approve & publish reply',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'uncertain'}).waitFor();
  assert.equal(await reply.inputValue(),'My edited wording');assert.ok(await approval.isDisabled());
  assert.equal(await page.evaluate(()=>fixture.requests.filter(r=>r.path.endsWith('/reply')).length),1);
  await page.evaluate(()=>fixture.failReply=false);await page.getByRole('button',{name:'Retry',exact:true}).click();
  assert.equal(await reply.inputValue(),'My edited wording');assert.equal(await approval.isChecked(),false);
  await approval.check();await page.getByRole('button',{name:'Approve & publish reply',exact:true}).click();
  await page.getByText('My edited wording',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>fixture.requests.filter(r=>r.path.endsWith('/reply')).map(r=>r.body.text)),['My edited wording','My edited wording']);
  await page.getByRole('button',{name:'Disconnect reviews',exact:true}).click();
  await page.getByRole('button',{name:'Connect Google Business Profile',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>fixture.requests.filter(r=>r.path==='/disconnect').length),1);
  assert.equal(await page.getByText('Review for North Studio',{exact:true}).count(),0);

  await start(()=>{fixture.status={available:true,connected:true};fixture.locations=[];});
  await page.getByText('No Business Profiles found in this Google account.',{exact:false}).waitFor();
  await page.getByRole('button',{name:'Use another Google account',exact:true}).click();
  await page.waitForFunction(()=>fixture.opened.length===1);
  assert.equal(await page.evaluate(()=>fixture.requests.some(r=>r.path==='/location')),false);

  await start(()=>{fixture.status={available:true,connected:false,reconnect_required:true,check_error:'Reconnect Google to continue.'};});
  await page.getByRole('button',{name:'Reconnect Google',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Connect Google Business Profile',exact:true}).count(),0);
  await page.getByRole('button',{name:'Reconnect Google',exact:true}).click();await page.waitForFunction(()=>fixture.opened.length===1);
  await start(()=>{fixture.status={available:true,connected:true,location:fixture.locations[0],check_error:'Google connections need attention from Florrie. Try again later.'};});
  await page.getByRole('alert').filter({hasText:'need attention from Florrie'}).waitFor();
  assert.equal(await page.evaluate(()=>fixture.requests.some(r=>r.path==='/reviews')),false,'provider setup errors do not masquerade as an empty review list');

  await start(connected);await ready();await page.getByText('Review for North Studio',{exact:true}).waitFor();
  await page.evaluate(()=>{fixture.status.location=fixture.locations[1];fixture.failReviews=true;});
  await page.getByRole('button',{name:'Refresh from Google',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Reviews could not be refreshed.'}).waitFor();
  assert.equal(await page.getByText('Review for North Studio',{exact:true}).count(),0,'old business reviews cannot remain under a different business heading');

  await start(connected);await page.getByText('Review for North Studio',{exact:true}).waitFor();
  await page.evaluate(()=>fixture.holdDraft=true);await page.getByRole('button',{name:'Draft a reply',exact:true}).click();
  await page.waitForFunction(()=>!!fixture.finishDraft);
  await page.evaluate(()=>{fixture.owner='salon-b';fixture.status={available:true,connected:false};fixture.mount();});
  await page.getByText('Connect the Google account that manages Salon B, then choose its Business Profile.',{exact:true}).waitFor();
  await page.evaluate(()=>fixture.finishDraft());
  assert.equal(await page.getByRole('textbox',{name:'Google review reply',exact:true}).count(),0,'late reply draft stays out of the next salon');
  assert.ok(await page.getByRole('button',{name:'Connect Google Business Profile',exact:true}).isEnabled());

  await start(connected);await page.getByText('Review for North Studio',{exact:true}).waitFor();
  await page.evaluate(()=>fixture.holdSession=true);await page.getByRole('button',{name:'Draft a reply',exact:true}).click();
  await page.waitForFunction(()=>!!fixture.finishSession);
  await page.evaluate(()=>{fixture.holdSession=false;fixture.owner='salon-b';fixture.status={available:true,connected:false};fixture.mount();});
  await page.getByText('Connect the Google account that manages Salon B, then choose its Business Profile.',{exact:true}).waitFor();
  await page.evaluate(()=>fixture.finishSession());
  assert.equal(await page.evaluate(()=>fixture.requests.some(r=>r.path.endsWith('/draft'))),false,'late authentication cannot dispatch an old-salon action');

  await page.clock.install();await start();await page.getByRole('button',{name:'Connect Google Business Profile',exact:true}).waitFor();
  await page.evaluate(()=>fixture.holdSession=true);await page.getByRole('button',{name:'Connect Google Business Profile',exact:true}).click();
  await page.clock.runFor(15001);await page.getByRole('alert').filter({hasText:'Sign-in took too long'}).waitFor();
  await page.evaluate(()=>fixture.finishSession());await page.clock.runFor(1);
  assert.equal(await page.evaluate(()=>fixture.requests.some(r=>r.path==='/connect')),false,'timed-out auth cannot open OAuth later');
  assert.deepEqual(errors,[]);
  console.log('PASS Google self-service: native OAuth, per-salon account/profile choices, change/cancel, empty accounts, revoked/provider states, exact reply approval, uncertain-result recovery, disconnect, owner isolation and bounded auth');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
