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
 updateUser:async value=>{fixture.updates.push(value);return {error:fixture.updateError?{message:'Synthetic update failure'}:null}},
 signOut:()=>{fixture.signouts++;return fixture.signOutHang?new Promise(()=>{}):Promise.resolve({error:null})}
};
fixture.emit=()=>fixture.listeners.forEach(cb=>cb('PASSWORD_RECOVERY',session));
function Harness(){const location=useLocation(),navigate=useNavigate();return <><output data-testid="path">{location.pathname}</output><button onClick={()=>navigate('/today')}>Leave reset page</button>{location.pathname==='/update-password'&&<UpdatePassword supabase={{auth}}/>}</>}
createRoot(document.getElementById('root')).render(<React.StrictMode><BrowserRouter><Harness/></BrowserRouter></React.StrictMode>);
`;
const result=await build({stdin:{contents:entry,resolveDir:root,loader:'jsx'},bundle:true,write:false,format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"test"'}});
const server=http.createServer((req,res)=>{res.setHeader('content-type',req.url==='/fixture.js'?'text/javascript':'text/html');res.end(req.url==='/fixture.js'?result.outputFiles[0].text:'<div id="root"></div><script src="/fixture.js"></script>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
 browser=await launch();const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 await page.addInitScript(()=>{const original=window.setTimeout;window.setTimeout=(fn,delay,...args)=>original(fn,delay===8000?40:delay===500?10:delay===2500?40:delay,...args);});
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
 await page.getByTestId('path').filter({hasText:'/login'}).waitFor({timeout:1500});
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
 assert.deepEqual(errors,[]);
 console.log('PASS: recovery-session rejection/timeout/retry, stale reads, late recovery event, retained failed edits, no update retry, successful return despite stalled sign-out, expired link and cleanup');
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
