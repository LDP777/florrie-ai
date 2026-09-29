// Exercise the real Login page and Supabase verification SDK with synthetic
// auth responses. No real account, email, provider configuration or API writes.
import assert from 'node:assert/strict';
import http from 'node:http';
import { build } from 'esbuild';
import { launch } from './lib/browser.mjs';

const root = new URL('../', import.meta.url).pathname;
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter,useLocation,useNavigate} from 'react-router-dom';
import Login from './src/pages/Login.jsx';
const fixture=window.fixture={signups:[],signins:[],verifications:[],otherRequests:[],pending:[],mode:'success'};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const success=email=>({user:{id:'synthetic-new-owner',email,email_confirmed_at:'2026-09-29T19:30:00Z'},access_token:'synthetic-access-token',refresh_token:'synthetic-refresh-token',token_type:'bearer',expires_in:3600});
window.fetch=async(input,options={})=>{
 const url=String(input);
 if(url.endsWith('/auth/v1/settings'))return json({external:{}});
 if(!url.endsWith('/auth/v1/verify')){fixture.otherRequests.push(url);throw new Error('Unexpected synthetic auth request')}
 const body=JSON.parse(options.body);fixture.verifications.push(body);
 const result=()=>fixture.mode==='bad'?json({code:'otp_expired',msg:'Token has expired or is invalid'},403):json(success(fixture.mode==='wrong-email'?'someone-else@example.com':body.email));
 if(fixture.mode==='hang')return new Promise(resolve=>fixture.pending.push(()=>resolve(json(success(body.email)))));
 if(fixture.mode==='hang-body')return {status:200,statusText:'OK',headers:{},text:()=>new Promise(resolve=>fixture.pending.push(()=>resolve(JSON.stringify(success(body.email)))))};
 return result();
};
const supabase={auth:{
 signUp:async value=>{fixture.signups.push(value);return {data:{user:{id:'synthetic-new-owner',email:value.email},session:null},error:null}},
 signInWithPassword:async value=>{fixture.signins.push(value);return {error:null}},
}};
function Harness(){const location=useLocation(),navigate=useNavigate();return <><output data-testid="path">{location.pathname}</output><button onClick={()=>navigate('/elsewhere')}>Leave signup</button>{['/signup','/login'].includes(location.pathname)&&<Login supabase={supabase} initialMode={location.pathname==='/signup'?'signup':undefined}/>}</>}
createRoot(document.getElementById('root')).render(<React.StrictMode><BrowserRouter><Harness/></BrowserRouter></React.StrictMode>);
`;
const bundle = await build({ stdin:{contents:entry,resolveDir:root,loader:'jsx'}, bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',
  define:{'process.env.NODE_ENV':'"test"','import.meta.env':JSON.stringify({VITE_SUPABASE_URL:'https://fixture.invalid',VITE_SUPABASE_ANON_KEY:'synthetic-public-key'})},
  plugins:[{name:'signup-platform',setup(b){
    b.onResolve({filter:/\/lib\/platform\.js$/},()=>({path:'platform',namespace:'fixture'}));
    b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const isIOSNative=()=>new URLSearchParams(location.search).has("native");',loader:'js'}));
  }}],
});
const server=http.createServer((request,response)=>{
  const script=request.url==='/fixture.js';response.setHeader('content-type',script?'text/javascript':'text/html');
  response.end(script?bundle.outputFiles[0].text:'<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script src="/fixture.js"></script>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  browser=await launch();const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  await page.addInitScript(()=>{const original=window.setTimeout;window.setTimeout=(fn,delay,...args)=>original(fn,delay===15000?300:delay,...args);});
  const origin=`http://127.0.0.1:${server.address().port}`;
  const tick=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  async function signup(email='owner@example.com'){
    await page.goto(origin+'/signup');
    await page.locator('input[type=email]').fill(email);
    await page.locator('input[type=password]').fill('SyntheticPass9!');
    await page.getByRole('button',{name:'Create account',exact:true}).click();
    await page.getByRole('heading',{name:'Check your email',exact:true}).waitFor();
  }
  await signup();await tick();
  assert.deepEqual(await page.evaluate(()=>({signup:fixture.signups.length,verify:fixture.verifications.length,other:fixture.otherRequests})),{signup:1,verify:0,other:[]},'opening confirmation never requests another email or verification');
  const code=page.getByLabel('Email confirmation code',{exact:true});
  assert.equal(await code.getAttribute('autocomplete'),'one-time-code');
  assert.equal(await code.getAttribute('inputmode'),'numeric');
  await code.fill('123');assert.equal(await page.getByRole('button',{name:'Confirm email',exact:true}).isDisabled(),true);
  await code.fill('1234 5678');assert.equal(await code.inputValue(),'12345678','pasted code accepts all eight digits');
  await page.evaluate(()=>{fixture.mode='bad'});
  await page.getByRole('button',{name:'Confirm email',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'incorrect or has expired'}).waitFor();
  assert.equal(await code.inputValue(),'12345678','bad code remains editable');
  assert.equal(await page.getByText('owner@example.com',{exact:true}).count(),1,'current email remains visible');
  assert.deepEqual(await page.evaluate(()=>fixture.verifications.map(({email,token,type})=>({email,token,type}))),[{email:'owner@example.com',token:'12345678',type:'email'}]);
  await page.evaluate(()=>{fixture.mode='success'});
  await page.getByRole('button',{name:'Confirm email',exact:true}).click();
  await page.getByRole('heading',{name:'Email confirmed',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>localStorage.length),0,'code verification never persists an app or booking session');
  assert.deepEqual(await page.evaluate(()=>({signups:fixture.signups.length,signins:fixture.signins.length,other:fixture.otherRequests})),{signups:1,signins:0,other:[]});
  await page.getByRole('button',{name:'Sign in to continue',exact:true}).click();
  assert.equal(await page.locator('input[type=email]').inputValue(),'owner@example.com');
  assert.equal(await page.locator('input[type=password]').inputValue(),'');
  await page.locator('input[type=password]').fill('SyntheticPass9!');
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.waitForURL(origin+'/');assert.equal(await page.evaluate(()=>fixture.signins.length),1);

  for(const mode of ['hang','hang-body']){
    await signup();await page.evaluate(mode=>{fixture.mode=mode},mode);await code.fill('654321');
    await page.locator('form').evaluate(form=>{form.requestSubmit();form.requestSubmit()});
    await page.getByRole('alert').filter({hasText:'taking too long'}).waitFor();
    assert.equal(await page.evaluate(()=>fixture.verifications.length),1,'double submit starts one bounded verification');
    assert.equal(await code.inputValue(),'654321','timeout preserves a six digit code');
    assert.equal(await code.isDisabled(),false);
    await page.evaluate(()=>fixture.pending.forEach(resolve=>resolve()));await tick();
    assert.equal(await page.getByRole('heading',{name:'Email confirmed',exact:true}).count(),0,'late response or response body cannot confirm');
    assert.equal(await page.evaluate(()=>localStorage.length),0,'late SDK response cannot sign in');
  }

  await signup('first@example.com');await page.evaluate(()=>{fixture.mode='hang'});await code.fill('12345678');
  await page.getByRole('button',{name:'Confirm email',exact:true}).click();
  await page.getByRole('button',{name:'Back to Sign In',exact:true}).click();
  await page.locator('input[type=email]').fill('next@example.com');
  await page.evaluate(()=>fixture.pending.forEach(resolve=>resolve()));await tick();
  assert.equal(await page.getByRole('heading',{name:'Welcome back',exact:true}).count(),1);
  assert.equal(await page.locator('input[type=email]').inputValue(),'next@example.com');
  assert.equal(await page.evaluate(()=>localStorage.length),0,'changing account discards previous verification');

  await signup();await page.evaluate(()=>{fixture.mode='wrong-email'});await code.fill('1234567');
  await page.getByRole('button',{name:'Confirm email',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'could not confirm your email'}).waitFor();
  assert.equal(await code.inputValue(),'1234567');
  await page.evaluate(()=>{fixture.mode='hang'});
  await page.getByRole('button',{name:'Confirm email',exact:true}).click();
  await page.getByRole('button',{name:'Leave signup',exact:true}).click();
  await page.evaluate(()=>fixture.pending.forEach(resolve=>resolve()));await tick();
  assert.equal(new URL(page.url()).pathname,'/elsewhere');assert.equal(await page.evaluate(()=>localStorage.length),0);

  await page.goto(origin+'/signup?native=1');
  await page.getByRole('heading',{name:'Welcome back',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Create account',exact:true}).count(),0,'iOS still has no signup');
  assert.equal(await page.getByLabel('Email confirmation code',{exact:true}).count(),0);
  await page.goto(origin+'/login?auth_error=1');
  await page.getByText('That sign-in link could not be completed. Please try again.',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Email confirmation code',{exact:true}).count(),0,'existing email-link error path remains sign-in');
  assert.deepEqual(errors,[]);
  console.log('PASS: real Login/SDK signup code flow, 6–8 digits, invalid code, current email, explicit-only verification, successful confirmation and unchanged login, double tap, bounded network/body, cancellation/late responses, session isolation and hidden iOS signup');
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
