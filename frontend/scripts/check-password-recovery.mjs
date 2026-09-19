// Actual reset-page lifecycle with synthetic auth only. No email or account writes.
import assert from 'node:assert/strict';
import http from 'node:http';
import { build } from 'esbuild';
import { launch } from './lib/browser.mjs';
const root = new URL('../', import.meta.url).pathname;
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter,useLocation,useNavigate} from 'react-router-dom';
import UpdatePassword from './src/pages/UpdatePassword.jsx';
window.fixture={mode:new URLSearchParams(location.search).get('mode')||'reject',reads:0,updates:[],signouts:0,listeners:new Set(),late:[]};
const fixture=window.fixture;
const session={access_token:'fictional-recovery',user:{id:'fictional-owner'}};
const auth={
 onAuthStateChange(cb){fixture.listeners.add(cb);return {data:{subscription:{unsubscribe(){fixture.listeners.delete(cb)}}}}},
 getSession(){fixture.reads++;if(fixture.mode==='reject')return Promise.reject(new Error('Synthetic reset-session outage'));if(fixture.mode==='hang')return new Promise(resolve=>fixture.late.push(resolve));return Promise.resolve({data:{session:fixture.mode==='empty'?null:session}})},
 updateUser:async value=>{fixture.updates.push(value);if(fixture.updateHang)return new Promise(resolve=>{fixture.finishUpdate=resolve});return {error:fixture.updateError?{message:'Synthetic update failure'}:null}},
 signOut:()=>{fixture.signouts++;if(fixture.signOutHang)return new Promise(()=>{});fixture.mode='empty';fixture.listeners.forEach(cb=>cb('SIGNED_OUT',null));return Promise.resolve({error:null})}
};
window.fixtureAuth=auth;
fixture.emit=()=>fixture.listeners.forEach(cb=>cb('PASSWORD_RECOVERY',session));
function Harness(){const location=useLocation(),navigate=useNavigate();return <><output data-testid="path">{location.pathname}</output><button onClick={()=>navigate('/today')}>Leave reset page</button>{location.pathname==='/update-password'&&<UpdatePassword supabase={{auth}}/>}</>}
createRoot(document.getElementById('root')).render(<React.StrictMode><BrowserRouter><Harness/></BrowserRouter></React.StrictMode>);
`;
const result=await build({stdin:{contents:entry,resolveDir:root,loader:'jsx'},bundle:true,write:false,format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"test"'}});
const actualAppEntry=`import React from 'react';import {createRoot} from 'react-dom/client';import {BrowserRouter} from 'react-router-dom';import App from './src/App.jsx';
${entry.slice(entry.indexOf('window.fixture='),entry.indexOf('function Harness'))}
window.fetch=async()=>({ok:true,json:async()=>({inbox:0,approvals:0})});
createRoot(document.getElementById('root')).render(<React.StrictMode><BrowserRouter><App/></BrowserRouter></React.StrictMode>);`;
const stubs={
 supabase:`export const supabase={auth:Object.fromEntries(['getSession','onAuthStateChange','updateUser','signOut'].map(name=>[name,(...args)=>window.fixtureAuth[name](...args)]))};export const useBeautician=()=>({beautician:{id:'fictional-owner',onboarding_completed_at:'2026-09-01',subscription_status:'active'}});`,
 config:'export const API_BASE="";',platform:'export const isIOSNative=()=>true;export const isNativeApp=()=>false;',native:'export const hapticTap=()=>{};',voicePref:'export const isVoiceEnabled=()=>true;',theme:'export const useTheme=()=>({});',
};
const realApp=await build({stdin:{contents:actualAppEntry,resolveDir:root,loader:'jsx'},bundle:true,write:false,format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"test"','import.meta.env':'{}'},plugins:[{name:'actual-app-recovery',setup(b){
 b.onResolve({filter:/\/lib\/(supabase|config|platform|native|voicePref|theme)\.(js|jsx)$/},args=>({path:args.path.split('/').pop().replace(/\.jsx?$/,''),namespace:'stub'}));
 b.onLoad({filter:/.*/,namespace:'stub'},args=>({contents:stubs[args.path],loader:'js'}));
 b.onResolve({filter:/^\.\/pages\/.*\.jsx$/},args=>args.path.endsWith('/UpdatePassword.jsx')?undefined:({path:args.path.split('/').pop().replace('.jsx',''),namespace:'page'}));
 b.onLoad({filter:/.*/,namespace:'page'},args=>({contents:`import React from 'react';export default ()=>React.createElement('h1',null,${JSON.stringify(args.path)});`,loader:'js',resolveDir:root}));
 b.onResolve({filter:/FlorrieEffects\.jsx$/},args=>({path:args.path,namespace:'component'}));
 b.onResolve({filter:/^\.\/(components|contexts)\//},args=>args.path.endsWith('/Button.jsx')?undefined:({path:args.path,namespace:'component'}));
 b.onLoad({filter:/.*/,namespace:'component'},()=>({contents:'export const FlorrieOrb=()=>null;export const iconName=x=>x;export const CoachProvider=({children})=>children;export default ({children})=>children||null;',loader:'js'}));
}}]});
const server=http.createServer((req,res)=>{const script=req.url==='/fixture.js'||req.url==='/app.js';res.setHeader('content-type',script?'text/javascript':'text/html');res.end(script?(req.url==='/app.js'?realApp:result).outputFiles[0].text:`<div id="root"></div><script src="${req.url.includes('real=1')?'/app.js':'/fixture.js'}"></script>`);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
 browser=await launch();const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 await page.addInitScript(()=>{const original=window.setTimeout;window.setTimeout=(fn,delay,...args)=>original(fn,[8000,15000].includes(delay)?40:delay===500?10:delay,...args);});
 const origin=`http://127.0.0.1:${server.address().port}`;
 await page.goto(origin+'/update-password');
 await page.getByRole('button',{name:'Try again',exact:true}).waitFor({timeout:1500});
 assert.deepEqual(errors,[],'rejected session read must be handled');
 await page.evaluate(()=>{fixture.mode='session'});
 await page.getByRole('button',{name:'Try again',exact:true}).click();
 await page.getByRole('heading',{name:'Choose a new password'}).waitFor();
 await page.getByLabel('New password',{exact:true}).fill('FictionalPass9!');
 await page.getByLabel('Confirm password',{exact:true}).fill('DifferentPass9!');
 await page.getByRole('button',{name:'Update password',exact:true}).click();
 await page.getByText("Passwords don't match.",{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>fixture.updates.length),0);
 await page.getByLabel('Confirm password',{exact:true}).fill('FictionalPass9!');
 await page.evaluate(()=>{fixture.updateError=true});
 await page.getByRole('button',{name:'Update password',exact:true}).click();
 await page.getByText('Something went wrong. Please request a new reset link.',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('New password',{exact:true}).inputValue(),'FictionalPass9!');
 await page.evaluate(()=>{fixture.updateError=false;fixture.signOutHang=true});
 await page.getByRole('button',{name:'Update password',exact:true}).click();
 await page.getByRole('button',{name:'Return to Florrie',exact:true}).waitFor({timeout:1500});
 assert.equal(new URL(page.url()).pathname,'/update-password','unconfirmed sign-out must not promise login');
 assert.equal(await page.evaluate(()=>fixture.updates.length),2,'one failed and one successful update, no automatic retry');
 assert.equal(await page.evaluate(()=>fixture.signouts),1);
 await page.goto(origin+'/update-password');
 await page.evaluate(()=>{fixture.mode='hang'});
 await page.getByRole('button',{name:'Try again',exact:true}).waitFor({timeout:1500});
 await page.getByRole('button',{name:'Try again',exact:true}).click();
 await page.getByRole('button',{name:'Try again',exact:true}).waitFor({timeout:1500});
 await page.evaluate(()=>fixture.emit());
 await page.getByRole('heading',{name:'Choose a new password'}).waitFor();
 await page.evaluate(()=>fixture.late.forEach(resolve=>resolve({data:{session:null}})));
 await page.getByRole('heading',{name:'Choose a new password'}).waitFor();
 await page.getByRole('button',{name:'Leave reset page',exact:true}).click();
 await page.waitForFunction(()=>fixture.listeners.size===0);
 assert.equal(await page.evaluate(()=>fixture.listeners.size),0,'unmount releases listeners');
 await page.goto(origin+'/update-password?mode=empty');
 await page.getByText('This reset link is unavailable or has expired.',{exact:false}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Update password',exact:true}).count(),0);
 // Exercise the real App auth redirect, not just a page-local navigate stub.
 const fill=async()=>{await page.getByLabel('New password',{exact:true}).fill('FictionalPass9!');await page.getByLabel('Confirm password',{exact:true}).fill('FictionalPass9!');};
 await page.goto(origin+'/update-password?mode=session&real=1');
 await fill();await page.evaluate(()=>{fixture.signOutHang=true});
 await page.getByRole('button',{name:'Update password',exact:true}).click();
 await page.getByRole('button',{name:'Return to Florrie',exact:true}).waitFor();
 assert.equal(new URL(page.url()).pathname,'/update-password');
 await page.getByRole('button',{name:'Return to Florrie',exact:true}).click();
 await page.getByRole('heading',{name:'Hub',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>fixture.signouts),1);
 await page.goto(origin+'/update-password?mode=session&real=1');
 await fill();await page.getByRole('button',{name:'Update password',exact:true}).click();
 await page.getByRole('heading',{name:'Login',exact:true}).waitFor();
 assert.equal(new URL(page.url()).pathname,'/login');
 await page.goto(origin+'/update-password?mode=session&real=1');
 await fill();await page.evaluate(()=>{fixture.updateHang=true});
 await page.getByRole('button',{name:'Update password',exact:true}).click();
 await page.getByRole('heading',{name:'Change not confirmed',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Update password',exact:true}).count(),0,'unknown outcome blocks another mutation');
 assert.equal(await page.evaluate(()=>fixture.updates.length),1);
 assert.equal(await page.evaluate(()=>fixture.signouts),0,'unknown outcome cannot sign out the owner');
 await page.evaluate(()=>fixture.finishUpdate({error:null}));
 await page.getByRole('heading',{name:'Change not confirmed',exact:true}).waitFor();
 await page.getByRole('button',{name:'Return to Florrie',exact:true}).click();
 await page.getByRole('heading',{name:'Hub',exact:true}).waitFor();
 assert.deepEqual(errors,[]);
 console.log('PASS: recovery read retry/stale/late events, retained edits, expired link; real App confirmed sign-out to login, stalled sign-out to usable app, uncertain update prevents retry/sign-out and ignores late result');
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
