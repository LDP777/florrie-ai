// Real SMS page and real session/GET helpers; every API request is synthetic.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { build } from 'esbuild';
import { launch } from './lib/browser.mjs';
const root = new URL('../', import.meta.url).pathname;
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import SMSConfig from './src/pages/SMSConfig.jsx';
window.fixture={token:'expired-sdk-token',refreshes:0,requests:[],faults:{},pending:{},
 config:{bird_configured:true,sms_originator:'Demo Salon',sms_inbound_number:'+447700900123',sms_channel_id:'11111111-1111-4111-8111-111111111111',two_way:true,schema_split:true,sms_enabled:true,channel:'email'},
 usage:{sms_sent:7,whatsapp_sent:4,total_sent:11,free_limit:120,remaining:109,overage_total_pence:0,month:'2026-09-01'},
 prefs:{channel:'email',reminder_1h:false,rebook_nudge:false},
 mount(){this.root ||= createRoot(document.getElementById('root'));this.root.render(<React.StrictMode><BrowserRouter><SMSConfig/></BrowserRouter></React.StrictMode>);}
};
localStorage.setItem('sb-fixture-auth-token',JSON.stringify({access_token:'stale-storage-token'}));
window.fetch=async(url,options={})=>{
 const path=new URL(url,location.origin).pathname;
 const method=options.method||'GET';
 const key=method+' '+path;
 fixture.requests.push({path,method,authorization:options.headers.Authorization,body:options.body?JSON.parse(options.body):null});
 const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
 const fault=fixture.faults[key];
 if(fault==='hang') return new Promise(resolve=>{fixture.pending[key]=resolve;});
 if(fault==='offline') throw TypeError('synthetic offline');
 if(fault==='empty') return reply({});
 if(fault) return reply({error:'Synthetic request failure'},fault);
 if(options.headers.Authorization==='Bearer expired-sdk-token') return reply({},401);
 if(method==='GET'&&path==='/api/notifications/sms/config') return reply(fixture.config);
 if(method==='GET'&&path==='/api/whatsapp/status') return reply({usage:fixture.usage});
 if(method==='GET'&&path==='/api/notifications/preferences') return reply({client_reminder_prefs:fixture.prefs});
 if(method==='PUT'&&path==='/api/notifications/sms/config'){
   fixture.config={...fixture.config,...JSON.parse(options.body)};
   return reply({success:true,...fixture.config});
 }
 if(method==='POST'&&path==='/api/notifications/sms/test') {
   fixture.usage={...fixture.usage,sms_sent:fixture.usage.sms_sent+1,total_sent:fixture.usage.total_sent+1,remaining:fixture.usage.remaining-1};
   return reply({success:true,messageId:'synthetic-only'});
 }
 throw Error('Unexpected request: '+key);
};
if(!location.search.includes('defer')) fixture.mount();
`;
const bundle = await build({
  stdin: { contents: entry, resolveDir: root, loader: 'jsx' }, bundle: true, write: false,
  format: 'iife', platform: 'browser', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
  plugins: [{ name: 'synthetic-session', setup(b) {
    b.onResolve({ filter: /\/lib\/(supabase|config)\.js$/ }, args => ({ path: args.path.split('/').pop(), namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ loader: 'js', contents: args.path === 'config.js' ? 'export const API_BASE="";' : `export const supabase={auth:{
      async getSession(){if(window.fixture.sessionHang)return new Promise(()=>{});return {data:{session:{access_token:window.fixture.token}}};},
      async refreshSession(){window.fixture.refreshes++;await new Promise(r=>setTimeout(r,20));window.fixture.token='refreshed-sdk-token';return {data:{session:{access_token:window.fixture.token}}};}
    }};` }));
  } }],
});
const server = http.createServer((req,res) => {
  const script=req.url==='/fixture.js';
  res.setHeader('content-type',script?'text/javascript':'text/html');
  res.end(script?bundle.outputFiles[0].text:'<meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--text-primary:#241B17;--text-secondary:#574A42;--accent:#92405e;--bg-card:#fffcfa;--bg-subtle:#f5ede7;--border:#e8dcd3;--radius-lg:20px;--radius-md:14px;}body{margin:0;background:#faf7f3;}button,input{font:inherit;}a{display:inline-flex;box-sizing:border-box;}button:disabled{opacity:.5}</style><div id="root"></div><script src="/fixture.js"></script>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
 const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 browser=await launch(existsSync(chrome)?{executablePath:chrome}:{});
 const page=await browser.newPage({viewport:{width:390,height:844}});
 const origin='http://127.0.0.1:'+server.address().port;
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 const start=async(setup)=>{
   await page.goto(origin+'/?defer');
   if(setup)await page.evaluate(setup);
   await page.evaluate(()=>fixture.mount());
 };
 await start();
 await page.getByText('Your preferred reminder channel is Email.',{exact:true}).waitFor();
 await page.getByText('11 / 120',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>fixture.refreshes),1,'parallel failed GETs share one session refresh');
 assert.equal(await page.evaluate(()=>fixture.requests.some(r=>r.authorization.includes('stale-storage'))),false);
 assert.equal(await page.evaluate(()=>fixture.requests.some(r=>r.path.endsWith('/sms/usage'))),false,'no legacy weekly meter');
 await page.getByRole('tab',{name:'Message examples',exact:true}).click();
 assert.equal(await page.getByRole('region',{name:'1-hour reminder'}).getByText('Off',{exact:true}).count(),1);
 await page.getByRole('tab',{name:'Settings',exact:true}).click();
 assert.equal(await page.getByLabel('Dedicated reply number',{exact:true}).isVisible(),false,'advanced routing starts collapsed');
 await page.getByLabel('Business name in messages').fill('New Salon');
 await page.evaluate(()=>{fixture.faults['PUT /api/notifications/sms/config']=500;});
 await page.getByRole('button',{name:'Save SMS settings'}).click();
 await page.getByRole('alert').filter({hasText:'couldn’t confirm the save'}).waitFor();
 assert.equal(await page.getByLabel('Business name in messages').inputValue(),'New Salon');
 assert.equal(await page.evaluate(()=>fixture.config.sms_originator),'Demo Salon');
 await page.evaluate(()=>{delete fixture.faults['PUT /api/notifications/sms/config'];});
 await page.getByRole('button',{name:'Save SMS settings'}).click();
 await page.getByText('SMS settings saved.',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('Business name in messages').inputValue(),'New Salon');
 assert.equal(await page.getByRole('button',{name:'Save SMS settings'}).isDisabled(),true);
 const writes=await page.evaluate(()=>fixture.requests.filter(r=>r.method==='PUT'));
 assert.deepEqual(writes.map(w=>w.body),[{sms_originator:'New Salon'},{sms_originator:'New Salon'}]);
 assert.equal(await page.evaluate(()=>fixture.config.channel),'email');
 assert.equal(await page.evaluate(()=>fixture.config.sms_enabled),true);
 assert.equal(await page.getByRole('link',{name:'Reminder preferences'}).getAttribute('href'),'/settings?section=notifications');
 assert.equal(await page.getByRole('link',{name:'Plan and billing'}).getAttribute('href'),'/settings?section=payments');
 for (const name of ['Reminder preferences','Plan and billing']) {
   const box = await page.getByRole('link',{name}).boundingBox();
   assert.ok(box.height >= 44, `${name} has a 44px tap target`);
 }
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'no mobile horizontal overflow');
 if(process.env.SMS_SCREENSHOT) await page.screenshot({path:process.env.SMS_SCREENSHOT,fullPage:true});
 // A failed independent read must not discard an edited form or promise active reminders.
 await start(()=>{fixture.faults['GET /api/whatsapp/status']=500;fixture.faults['GET /api/notifications/preferences']=500;});
 await page.getByRole('button',{name:'Retry message usage'}).waitFor();
 assert.equal(await page.getByText('£0.00',{exact:true}).count(),0,'unknown is not zero');
 await page.getByRole('tab',{name:'Message examples'}).click();
 assert.equal(await page.getByText('Status unavailable',{exact:true}).count(),4);
 await page.getByRole('tab',{name:'Settings',exact:true}).click();
 await page.getByLabel('Business name in messages').fill('Kept Draft');
 await page.evaluate(()=>{delete fixture.faults['GET /api/whatsapp/status'];});
 await page.getByRole('button',{name:'Retry message usage'}).click();
 await page.getByText('11 / 120',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('Business name in messages').inputValue(),'Kept Draft');
 await page.getByRole('tab',{name:'Overview',exact:true}).click();
 await page.evaluate(()=>{delete fixture.faults['GET /api/notifications/preferences'];fixture.prefs={channel:'email'};});
 await page.getByRole('button',{name:'Retry reminder preferences'}).click();
 await page.getByText('Your preferred reminder channel is Email.',{exact:true}).waitFor();
 await page.getByRole('tab',{name:'Settings',exact:true}).click();
 assert.equal(await page.getByLabel('Business name in messages').inputValue(),'Kept Draft');
 await page.getByRole('tab',{name:'Message examples'}).click();
 assert.equal(await page.getByRole('region',{name:'1-hour reminder'}).getByText('Off',{exact:true}).count(),1,'missing 1-hour setting is off');
 // API success with unavailable usage is not silently rendered as an empty month.
 await start(()=>{fixture.usage=null;fixture.faults['GET /api/notifications/sms/config']=500;});
 await page.getByRole('button',{name:'Retry SMS setup',exact:true}).waitFor();
 await page.getByRole('button',{name:'Retry message usage'}).waitFor();
 assert.equal(await page.getByText('Check SMS sending with a test',{exact:true}).count(),0);
 await page.evaluate(()=>{delete fixture.faults['GET /api/notifications/sms/config'];});
 await page.getByRole('button',{name:'Retry SMS setup',exact:true}).click();
 await page.getByText('Check SMS sending with a test',{exact:true}).waitFor();
 // Older schema cannot let a sender-name edit overwrite a live reply number.
 await start(()=>{fixture.config.schema_split=false;});
 await page.getByRole('tab',{name:'Settings',exact:true}).click();
 await page.getByText(/Sending details are read-only/).waitFor();
 assert.equal(await page.getByLabel('Business name in messages').isDisabled(),true);
 // Ambiguous test send is never automatically repeated or described as delivered.
 await start();
 await page.getByRole('tab',{name:'Settings',exact:true}).click();
 await page.getByLabel('Your phone number',{exact:true}).fill('+447700900000');
 await page.evaluate(()=>{fixture.faults['POST /api/notifications/sms/test']='offline';});
 await page.getByRole('button',{name:'Send test SMS'}).click();
 await page.getByText(/Check the phone before sending another/).waitFor();
 assert.equal(await page.evaluate(()=>fixture.requests.filter(r=>r.method==='POST').length),1);
 assert.equal(await page.getByLabel('Your phone number').inputValue(),'+447700900000');
 await page.evaluate(()=>{delete fixture.faults['POST /api/notifications/sms/test'];});
 await page.getByRole('button',{name:'Send test SMS'}).click();
 await page.getByText(/Test accepted for sending/).waitFor();
 await page.getByText('12 / 120',{exact:true}).waitFor();
 assert.equal(await page.getByText(/confirm it arrived/).count(),1);
 assert.equal(await page.evaluate(()=>fixture.requests.filter(r=>r.method==='POST').length),2,'only explicit second click resends');
 // A session lock cannot leave this page permanently loading.
 await page.clock.install();
 await start(()=>{fixture.sessionHang=true;});
 await page.clock.runFor(10_001);
 await page.getByRole('button',{name:'Retry SMS setup',exact:true}).waitFor();
 await page.evaluate(()=>{fixture.sessionHang=false;});
 await page.getByRole('button',{name:'Retry SMS setup',exact:true}).click();
 await page.clock.runFor(50);
 await page.getByText('Check SMS sending with a test',{exact:true}).waitFor();
 assert.deepEqual(errors,[]);
 console.log('PASS: SMS session refresh and timeout recovery; unknown usage/preferences; retained edits; narrow saves; channel preservation; safe legacy setup; explicit-only test sends; mobile real-page rendering');
} finally { await browser?.close();await new Promise(resolve=>server.close(resolve)); }
