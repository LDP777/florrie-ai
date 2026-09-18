// Actual pages with synthetic records. No provider, payment or production access.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { build } from 'esbuild';
import { launch } from './lib/browser.mjs';
import { contrast } from '../src/lib/brand-colour.js';

const root = new URL('../', import.meta.url).pathname;
const store = `
const owner = {id:'fictional-salon'};
const initial = {
 plans:[{id:'basic',name:'Brow care',price_cents:3000,benefits:['Priority enquiries']},{id:'extra',name:'Extra care',price_cents:10000,benefits:[]}],
 members:[{id:'casey',membership_id:'basic',status:'active',clients:{first_name:'Casey',last_name:'Client'}},{id:'sam',membership_id:'extra',status:'paused',clients:{first_name:'Sam',last_name:'Client'}},{id:'unknown',membership_id:'extra',status:null,clients:{first_name:'Unknown',last_name:'Status'}}]
};
window.fixture={...JSON.parse(sessionStorage.getItem('membership-records')||JSON.stringify(initial)),writes:[],failRead:false,failCreate:false,failUpdate:false};
const persist=()=>sessionStorage.setItem('membership-records',JSON.stringify({plans:window.fixture.plans,members:window.fixture.members}));
export const useBeautician=()=>({beautician:owner,loading:false});
export const supabase={auth:{getSession:async()=>({data:{session:{access_token:'fixture'}}})}};
export const fetchRowsStrict=async(table,ownerId)=>{if(ownerId!==owner.id)throw Error('Wrong owner');if(window.fixture.failRead)throw Error('Synthetic load failure');return table==='client_memberships'?window.fixture.plans:window.fixture.members;};
export const insertRow=async(table,input)=>{if(window.fixture.failCreate)throw Error('Synthetic create failure');if(table!=='client_memberships'||input.beautician_id!==owner.id)throw Error('Unexpected write');const row={id:'created-plan',...input};window.fixture.writes.push({table,input});window.fixture.plans.push(row);persist();return row;};
export const updateRow=async(table,id,changes)=>{if(window.fixture.failUpdate)throw Error('Synthetic update failure');if(table!=='membership_subscriptions')throw Error('Unexpected write');window.fixture.writes.push({table,id,changes});const row=window.fixture.members.find(m=>m.id===id);Object.assign(row,changes);persist();return row;};
`;
const entry = `
import React from 'react';import {createRoot} from 'react-dom/client';import {BrowserRouter,useLocation} from 'react-router-dom';
import ClientMemberships from './src/pages/ClientMemberships.jsx';import SetupHub from './src/pages/SetupHub.jsx';import {ThemeProvider} from './src/lib/theme.jsx';import './src/index.css';
function Harness(){const l=useLocation();return l.pathname==='/setup'?<SetupHub/>:l.pathname==='/memberships'?<ClientMemberships/>:<div>Destination: {l.pathname}{l.search}</div>;}
createRoot(document.getElementById('root')).render(<ThemeProvider><BrowserRouter><Harness/></BrowserRouter></ThemeProvider>);
`;
const out = await build({
 stdin:{contents:entry,resolveDir:root,loader:'jsx'},bundle:true,write:false,outfile:'/tmp/florrie-membership-fixture/app.js',
 format:'iife',platform:'browser',jsx:'automatic',define:{'import.meta.env':JSON.stringify({DEV:false})},
 plugins:[{name:'fixtures',setup(b){
  b.onResolve({filter:/\/lib\/supabase\.js$/},()=>({path:'store',namespace:'fixture'}));
  b.onResolve({filter:/\/lib\/config\.js$/},()=>({path:'config',namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path==='store'?store:'export const API_BASE="";',loader:'js'}));
 }}],
});
let channels = {};
const requests = [];
const server = http.createServer((req,res)=>{
 requests.push({url:req.url,method:req.method});
 if(req.url==='/api/setup/status'||req.url==='/api/whatsapp/meta-templates/starter-pack'){
  res.setHeader('content-type','application/json');
  return res.end(JSON.stringify(req.url==='/api/setup/status'?{business:{},services:{},channels,clients:{},protection:{},money:{}}:{pack:[]}));
 }
 const file=out.outputFiles.find(f=>f.path.endsWith(req.url));
 if(file){res.setHeader('content-type',req.url.endsWith('.css')?'text/css':'text/javascript');return res.end(file.text);}
 res.setHeader('content-type','text/html');
 res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>');
}).listen(0,'127.0.0.1');
await new Promise(resolve=>server.once('listening',resolve));
const browser = await launch();
try {
 const origin=`http://127.0.0.1:${server.address().port}`;
 const ctx=await browser.newContext({viewport:{width:390,height:844}});
 await ctx.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 const page=await ctx.newPage();const errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 page.on('console',message=>{if(message.type()==='error'&&/cannot be a descendant|cannot contain a nested|hydration/i.test(message.text()))errors.push(message.text());});
 await page.goto(`${origin}/memberships`);
 await page.getByText('Active plan value',{exact:true}).waitFor();
 await page.getByText('Active plan value',{exact:true}).locator('..').getByText('£30.00',{exact:true}).waitFor();
 assert.doesNotMatch(await page.locator('body').innerText(),/Monthly Recurring|plans bill monthly|steady income/);
 await page.getByText('Florrie stores your plans and member statuses here. It does not collect recurring membership payments.',{exact:true}).waitFor();

 // Failure must retain owner input; success persists a plan without inventing a billing interval.
 await page.getByRole('button',{name:'+ Create New Plan',exact:true}).click();
 await page.getByLabel('Plan name',{exact:true}).fill('Fictional care plan');
 await page.getByLabel('Plan price in pounds',{exact:true}).fill('19.95');
 await page.getByLabel('Perks, one per line',{exact:true}).fill('A fictional perk');
 await page.evaluate(()=>{window.fixture.failCreate=true;});
 await page.getByRole('button',{name:'Create Plan',exact:true}).click();
 await page.getByText('Could not create this plan. Your details are still here.',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('Plan name',{exact:true}).inputValue(),'Fictional care plan');
 assert.equal(await page.evaluate(()=>window.fixture.writes.length),0);
 await page.evaluate(()=>{window.fixture.failCreate=false;});
 await page.getByRole('button',{name:'Create Plan',exact:true}).click();
 await page.getByText('Fictional care plan',{exact:true}).waitFor();
 assert.deepEqual(await page.evaluate(()=>window.fixture.writes),[{
  table:'client_memberships',input:{beautician_id:'fictional-salon',name:'Fictional care plan',price_cents:1995,benefits:[{type:'perk',label:'A fictional perk'}],is_active:true},
 }]);
 await page.reload();
 await page.getByText('Fictional care plan',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.fixture.plans.length),3);
 console.log('PASS: failed plan save retains details; successful save/reload preserves the stored price and perks without a billing promise');

 await page.getByRole('button',{name:'Members',exact:true}).click();
 const casey=page.locator('article').filter({hasText:'Casey Client'});
 const unknown=page.locator('article').filter({hasText:'Unknown Status'});
 await unknown.getByText('unknown',{exact:true}).waitFor();
 await casey.getByRole('button',{expanded:false}).click();
 await casey.getByText('Recorded next payment',{exact:true}).waitFor();
 assert.equal(await page.locator('button button').count(),0);
 await page.evaluate(()=>{window.fixture.failUpdate=true;});
 await casey.getByRole('button',{name:'Mark paused',exact:true}).click();
 await page.getByText('Could not update this membership. Please try again.',{exact:true}).waitFor();
 await casey.getByText('active',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.fixture.writes.length),0);
 await page.evaluate(()=>{window.fixture.failUpdate=false;});
 await casey.getByRole('button',{name:'Mark paused',exact:true}).click();
 await casey.getByText('paused',{exact:true}).waitFor();
 await page.getByText('Active plan value',{exact:true}).locator('..').getByText('£0.00',{exact:true}).waitFor();
 assert.deepEqual(await page.evaluate(()=>window.fixture.writes),[{table:'membership_subscriptions',id:'casey',changes:{status:'paused'}}]);
 await page.reload();await page.getByRole('button',{name:'Members',exact:true}).click();
 await casey.getByRole('button',{expanded:false}).click();
 await casey.getByRole('button',{name:'Mark active',exact:true}).click();
 await casey.getByText('active',{exact:true}).waitFor();
 await casey.getByRole('button',{name:'Mark cancelled',exact:true}).click();
 await casey.getByText('cancelled',{exact:true}).waitFor();
 const writes=await page.evaluate(()=>window.fixture.writes);
 assert.deepEqual(writes[0],{table:'membership_subscriptions',id:'casey',changes:{status:'active'}});
 assert.equal(writes[1].changes.status,'cancelled');
 assert.ok(Number.isFinite(Date.parse(writes[1].changes.cancelled_at)));
 assert.equal(await page.evaluate(()=>window.fixture.members.length),3);
 assert.equal(await casey.getByRole('button',{name:'Mark cancelled',exact:true}).count(),0);
 await page.reload();await page.getByRole('button',{name:'Members',exact:true}).click();
 await casey.getByText('cancelled',{exact:true}).waitFor();
 console.log('PASS: missing status stays unknown; rejected status change stays active; pause/resume/cancel persist records without deleting them');

 await page.locator('article').filter({hasText:'Sam Client'}).getByRole('button',{expanded:false}).click();
 const goldText=await page.getByText('Extra care',{exact:true}).first().evaluate(el=>getComputedStyle(el).color);
 const goldHex='#'+goldText.match(/\d+/g).slice(0,3).map(v=>Number(v).toString(16).padStart(2,'0')).join('');
 assert.ok(contrast(goldHex,'#FFFCF9')>=4.5,'plan text must remain readable on its card');
 mkdirSync('/tmp/florrie-membership-check',{recursive:true});
 await page.screenshot({path:'/tmp/florrie-membership-check/phone.png',fullPage:true});
 for(const width of [320,390,820,1280]){
  await page.setViewportSize({width,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`membership overflow at ${width}`);
 }
 await page.getByRole('button',{name:'How it works',exact:true}).click();
 await page.getByRole('heading',{name:'Your membership records',exact:true}).waitFor();
 await page.getByText('Florrie does not set up recurring charges, collect membership payments, or pause or cancel a payment arrangement. Arrange and manage those payments separately.',{exact:true}).waitFor();

 // A missing active plan must not contribute a fabricated zero to the total.
 await page.evaluate(()=>sessionStorage.setItem('membership-records',JSON.stringify({plans:[],members:[{id:'orphan',membership_id:'missing',status:'active',client_name:'Fictional missing plan'}]})));
 await page.reload();await page.getByText('Not available',{exact:true}).waitFor();
 await page.getByText('A plan or price is missing from an active record.',{exact:true}).waitFor();
 await page.evaluate(()=>sessionStorage.setItem('membership-records',JSON.stringify({plans:[],members:[]})));
 await page.reload();await page.getByRole('heading',{name:'No membership plans yet',exact:true}).waitFor();
 await page.getByRole('button',{name:'Members',exact:true}).click();
 await page.getByText('Existing membership records will appear here. This page does not enrol clients or take membership payments.',{exact:true}).waitFor();
 assert.equal(requests.filter(r=>r.method!=='GET').length,0);
 console.log('PASS: empty and incomplete records show their limits; no payment or provider request is made');

 // The checklist itself chooses the destination; root separately tests Settings sections.
 const links=[['Business name','profile'],['Opening hours','hours'],['Booking page link','profile'],['Deposits switched on','policy'],['A way for clients to reach you','connections'],['Auto-reply','ai'],['Card payments connected','payments']];
 for(const channelState of [{},{sms:true},{whatsapp:true,instagram:true}]){
  channels=channelState;
  for(const [label,section] of links){
   await page.goto(`${origin}/setup`);
   await page.getByRole('button',{name:new RegExp(`^${label},`)}).click();
   assert.equal(new URL(page.url()).pathname+new URL(page.url()).search,`/settings?section=${section}`);
  }
 }
 assert.deepEqual(errors,[]);
 console.log('PASS: seven setup tasks open their exact section for unconnected, SMS-only and WhatsApp/Instagram salons');
 await ctx.close();
} finally {await browser.close();server.close();}
