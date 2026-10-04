// Actual Integrations page and OAuth/session helpers; synthetic API and native bridge.
import assert from 'node:assert/strict';
import http from 'node:http';
import { build } from 'esbuild';
import { launch } from './lib/browser.mjs';
const root = new URL('../', import.meta.url).pathname;
const bundle = await build({
  stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {BrowserRouter} from 'react-router-dom';
    import Integrations from './src/pages/Integrations.jsx';
    window.fixture={native:true,token:'expired-sdk-token',refreshes:0,requests:[],opened:[],popups:[],listeners:new Set(),profileRefreshes:0,
      profile:{id:'demo',instagram_page_id:'demo-ig'},status:{token_valid:true,webhook_subscribed:true,echoes_subscribed:null},statusCode:200,
      connectUrl:'https://www.instagram.com/oauth/authorize?client_id=fixture&state=synthetic',connectCode:200,
      mount(){this.root ||= createRoot(document.getElementById('root'));this.root.render(<React.StrictMode><BrowserRouter><Integrations/></BrowserRouter></React.StrictMode>);}
    };
    window.open=(...args)=>{fixture.popups.push(args);return null;};
    window.fetch=async(input,options={})=>{
      const url=new URL(typeof input==='string'?input:input.url,location.origin);
      const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
      fixture.requests.push({path:url.pathname,search:url.search,method:options.method||'GET',authorization:options.headers?.Authorization});
      if(url.pathname==='/api/notifications/sms/config')return reply({});
      if(url.pathname==='/api/instagram/status'){
        if(fixture.statusHang)return new Promise(resolve=>{fixture.finishStatus=resolve;});
        if(options.headers?.Authorization==='Bearer expired-sdk-token')return reply({},401);
        return reply(fixture.status,fixture.statusCode);
      }
      if(url.pathname==='/api/instagram/connect'){
        if(fixture.connectHang)return new Promise(resolve=>{fixture.finishConnect=resolve;});
        return reply(fixture.connectCode===503?{error:'synthetic unavailable'}:{url:fixture.connectUrl},fixture.connectCode);
      }
      throw Error('Unexpected request: '+url.pathname);
    };
  ` },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
  plugins: [{ name: 'synthetic-auth-and-device', setup(b) {
    b.onResolve({ filter: /\/lib\/(supabase|config|platform)\.js$/ }, args => ({path:args.path.split('/').pop(),namespace:'fixture'}));
    b.onResolve({ filter: /^@capacitor\/browser$/ }, () => ({path:'browser',namespace:'fixture'}));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({path}) => ({loader:'js',contents:{
      'config.js':'export const API_BASE="https://api.florrie.test";',
      'platform.js':'export const isNativeApp=()=>fixture.native;',
      browser:'export const Browser={async open({url}){fixture.opened.push(url);if(fixture.browserFails)throw Error("Could not open the system browser. Try again.");},async addListener(name,callback){fixture.listeners.add(callback);return{async remove(){fixture.listeners.delete(callback);}};}};',
      'supabase.js':`const refresh=async()=>{fixture.profileRefreshes++;if(fixture.returnProfile)fixture.profile=fixture.returnProfile;};export const useBeautician=()=>({beautician:fixture.profile,loading:false,refresh});export const supabase={auth:{
        async getSession(){if(fixture.sessionHang)return new Promise(()=>{});return {data:{session:{access_token:fixture.token}}};},
        async refreshSession(){fixture.refreshes++;fixture.token='fresh-sdk-token';return {data:{session:{access_token:fixture.token}}};}
      }};`,
    }[path]}));
  }}],
});
const server=http.createServer((req,res)=>{
  const script=req.url==='/fixture.js';res.setHeader('content-type',script?'text/javascript':'text/html');
  res.end(script?bundle.outputFiles[0].text:'<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/fixture.js"></script>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  browser=await launch();const page=await browser.newPage({viewport:{width:390,height:844}});
  const origin=`http://127.0.0.1:${server.address().port}`;const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const start=async(setup,value)=>{await page.goto(origin);if(setup)await page.evaluate(setup,value);await page.evaluate(()=>fixture.mount());};
  const expand=()=>page.getByText('Instagram',{exact:true}).click();
  await start();await expand();await page.getByText('Page ID',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>fixture.refreshes),1,'status refreshes the expired SDK session');
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  assert.equal(new URL(page.url()).pathname+new URL(page.url()).search,'/settings?section=connections','the connected Instagram card manages its connection in the Connections section');

  await start(()=>{fixture.profile.instagram_page_id=null;fixture.token='fresh-sdk-token';});await expand();
  await page.getByRole('button',{name:'Connect Instagram →',exact:true}).click();
  await page.waitForFunction(()=>fixture.opened.length===1);
  assert.deepEqual(await page.evaluate(()=>fixture.popups),[],'native OAuth never uses a WebView popup');
  assert.equal(await page.evaluate(()=>fixture.requests.find(r=>r.path==='/api/instagram/connect').search),'?platform=native');
  assert.equal(await page.getByRole('button',{name:'Connect Instagram →',exact:true}).isEnabled(),true);

  // First connection returns through browserFinished; the original page must
  // update without signing out, navigating away or changing reply settings.
  await page.evaluate(()=>{fixture.returnProfile={id:'demo',instagram_page_id:'new-demo-ig'};for(const callback of fixture.listeners)callback();});
  await page.getByText('Page ID',{exact:true}).waitFor();
  assert.equal(await page.getByText('new-demo-ig',{exact:true}).count(),1);
  assert.ok(await page.evaluate(()=>fixture.profileRefreshes>0));
  // Incoming-message access is required. Instagram Login does not support
  // the separate owner-echo field, so that field cannot decide readiness.
  await start(()=>{fixture.token='fresh-sdk-token';fixture.status.webhook_subscribed=false;});
  await expand();await page.getByText('Setup incomplete',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Review Instagram connection'}).waitFor();
  assert.equal(await page.getByText('Connected',{exact:true}).count(),0,'missing incoming-message subscription is never connected');
  await page.evaluate(()=>{fixture.status.webhook_subscribed=true;});
  await page.getByRole('button',{name:'Retry connection check'}).click();
  await page.getByText('Page ID',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>fixture.opened.length),0,'checking incoming-message readiness must not reopen OAuth');

  for(const echoes of [false,null,'absent']){
    await start(value=>{
      fixture.token='fresh-sdk-token';
      if(value==='absent')delete fixture.status.echoes_subscribed;
      else fixture.status.echoes_subscribed=value;
    },echoes);
    await expand();await page.getByText('Page ID',{exact:true}).waitFor();
    assert.equal(await page.getByText('Connected',{exact:true}).count(),1,`unsupported owner echoes (${echoes}) must not block a valid message connection`);
    assert.equal(await page.getByText('Setup incomplete',{exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:'Review Instagram connection'}).count(),0,'unsupported owner echoes do not need an impossible reconnect');
    assert.equal(await page.evaluate(()=>fixture.requests.some(request=>request.method!=='GET')),false,'status checks never write connection or account settings');
    assert.equal(await page.evaluate(()=>fixture.opened.length),0);
  }

  await start(()=>{fixture.token='fresh-sdk-token';fixture.status.webhook_subscribed=null;fixture.status.echoes_subscribed=null;});await expand();
  await page.getByText('Could not check',{exact:true}).waitFor();
  assert.equal(await page.getByText('Connected',{exact:true}).count(),0,'unknown app identity is not ready');

  await start(()=>{fixture.statusCode=503;fixture.token='fresh-sdk-token';});await expand();
  await page.getByRole('button',{name:'Retry connection check'}).waitFor();
  await page.evaluate(()=>{fixture.statusCode=200;});
  await page.getByRole('button',{name:'Retry connection check'}).click();
  await page.getByText('Page ID',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>fixture.opened.length),0,'retry is read-only and does not reopen OAuth');

  for(const mode of ['unavailable','invalid-url','browser-failure']){
    await start(()=>{fixture.profile.instagram_page_id=null;fixture.token='fresh-sdk-token';});await expand();
    await page.evaluate(mode=>{if(mode==='unavailable')fixture.connectCode=503;if(mode==='invalid-url')fixture.connectUrl='https://untrusted.test/';if(mode==='browser-failure')fixture.browserFails=true;},mode);
    await page.getByRole('button',{name:'Connect Instagram →',exact:true}).click();
    await page.getByRole('alert').waitFor();
    assert.equal(await page.getByRole('button',{name:'Connect Instagram →',exact:true}).isEnabled(),true);
    assert.equal(await page.evaluate(()=>fixture.opened.length),mode==='browser-failure'?1:0);
  }

  await page.clock.install();
  await start(()=>{fixture.statusHang=true;fixture.token='fresh-sdk-token';});await expand();
  await page.clock.runFor(15001);
  await page.getByRole('button',{name:'Retry connection check'}).waitFor();
  await page.evaluate(()=>{fixture.statusHang=false;});
  await page.getByRole('button',{name:'Retry connection check'}).click();
  await page.getByText('Page ID',{exact:true}).waitFor();
  // A late result from the timed-out read cannot undo the successful retry.
  await page.evaluate(()=>fixture.finishStatus(new Response(JSON.stringify({needs_reconnect:true}),{status:200})));
  await page.clock.runFor(1);
  assert.equal(await page.getByText('Page ID',{exact:true}).count(),1);
  await start(()=>{fixture.profile.instagram_page_id=null;fixture.token='fresh-sdk-token';fixture.connectHang=true;});await expand();
  await page.getByRole('button',{name:'Connect Instagram →',exact:true}).click();await page.clock.runFor(15001);
  await page.getByRole('alert').filter({hasText:'too long'}).waitFor();
  await page.evaluate(()=>fixture.finishConnect(new Response(JSON.stringify({url:fixture.connectUrl}),{status:200})));
  await page.clock.runFor(1);
  assert.equal(await page.evaluate(()=>fixture.opened.length),0,'late OAuth response cannot open after the timeout');
  assert.equal(await page.evaluate(()=>fixture.requests.some(r=>r.method!=='GET')),false,'no connection or account writes in the rehearsal');
  assert.deepEqual(errors,[]);
  console.log('PASS: Integrations native system-browser handoff, URL/error/timeout protection, SDK refresh, read-only status retry, late-response safety and exact Settings destination, native return refresh, required incoming-message subscription and unsupported owner-echo handling');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
