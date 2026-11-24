// Exercise the real App route boundary, public training pages and Login.
// All identities and course data are fictional; external requests are blocked.
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { build } from 'esbuild';
import { webkit } from '@playwright/test';
import { launch } from './lib/browser.mjs';

const root = new URL('../', import.meta.url).pathname;
const entry = `
import React from 'react';import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';import App from './src/App.jsx';
const mode=new URLSearchParams(location.search).get('fixture')||'guest';
const s=window.fixture={mode,authReads:0,profileReads:0,signups:0,signins:0,requests:[],listeners:window.fixtureAuthListeners};
s.session=mode==='guest'?null:{user:{id:mode},access_token:'fictional-token'};
s.owner=mode==='owner'?{id:'owner',owner_access_approved:true,onboarding_completed_at:'2026-09-01',subscription_status:'active'}:{owner_access_approved:false};
const trainer={business_name:'Fictional Studio',booking_slug:'fictional'};
const dates=[{id:'11111111-1111-4111-8111-111111111111',date:'2027-01-04',date_label:'Monday 4 January 2027'},
{id:'22222222-2222-4222-8222-222222222222',date:'2027-01-18',date_label:'Monday 18 January 2027'}].map(x=>({...x,name:'Brow training',description:'Our practical course.',price:450,deposit:0,spots_left:2,is_full:false,start_time:'09:00',duration:'Full day',status:'active',includes:[]}));
window.fetch=async(input,options={})=>{
 const path=new URL(typeof input==='string'?input:input.url,location.origin).pathname;
 s.requests.push({path,method:options.method||'GET'});
 if(path==='/api/auth/ensure-profile')return new Response(JSON.stringify({code:'SALON_ACCESS_REQUIRED'}),{status:403});
 if(!path.startsWith('/api/courses/'))return new Response('{}',{status:200});
 if(path.includes('/missing'))return new Response(JSON.stringify({error:'Course not found'}),{status:404});
 const catalogue=path==='/api/courses/fictional';
 return new Response(JSON.stringify(catalogue?{beautician:trainer,courses:[{...dates[0],dates}]}:{beautician:trainer,course:dates[0],dates,date_selection_required:true}),{status:200});
};
createRoot(document.getElementById('root')).render(<React.StrictMode><BrowserRouter><App/></BrowserRouter></React.StrictMode>);
`;
const stubs = {
  config: 'export const API_BASE="";',
  platform: 'export const isIOSNative=()=>false;export const isNativeApp=()=>false;',
  native: 'export const hapticTap=()=>{};',
  voicePref: 'export const isVoiceEnabled=()=>true;',
  theme: 'export const useTheme=()=>({});',
};
const sdk = `
window.fixtureAuthListeners=new Set();
export function createClient(){return {auth:{
 getSession:async()=>{fixture.authReads++;return {data:{session:fixture.session}};},
 onAuthStateChange(fn){window.fixtureAuthListeners.add(fn);return {data:{subscription:{unsubscribe(){window.fixtureAuthListeners.delete(fn);}}}};},
 signOut:async()=>{fixture.session=null;for(const fn of window.fixtureAuthListeners)fn('SIGNED_OUT',null);},
 signUp:async()=>{fixture.signups++;throw Error('Unexpected signup');},
 signInWithPassword:async()=>{fixture.signins++;if(!fixture.nextSignIn)return {error:{message:'Synthetic sign-in failure'}};
   const id=fixture.nextSignIn;
   fixture.owner=id==='owner'?{id,owner_access_approved:true,onboarding_completed_at:'2026-09-01',subscription_status:'active'}:{owner_access_approved:false};
   fixture.session={user:{id},access_token:'fictional-token'};
   for(const fn of window.fixtureAuthListeners)fn('SIGNED_IN',fixture.session);
   return {data:{session:fixture.session},error:null};}
 },from(table){
   if(table!=='beauticians')throw Error('Unexpected table '+table);
   const query={select(){return query;},eq(){return query;},async maybeSingle(){fixture.profileReads++;return {data:fixture.owner.owner_access_approved?fixture.owner:null,error:fixture.profileFailure?{message:'Synthetic network failure'}:null};}};
   return query;
 }};}
`;
const bundle = await build({
  stdin: { contents: entry, resolveDir: root, loader: 'jsx' }, bundle: true, write: false,
  outfile: 'fixture.js', format: 'iife', platform: 'browser', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': JSON.stringify({VITE_SUPABASE_URL:'https://auth.invalid',VITE_SUPABASE_ANON_KEY:'fictional'}) },
  plugins: [{ name: 'student-access-fixture', setup(b) {
    b.onResolve({ filter: /\/lib\/(config|platform|native|voicePref|theme)\.(js|jsx)$/ }, args => ({ path: args.path.split('/').pop().replace(/\.jsx?$/, ''), namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js' }));
    b.onResolve({filter:/^@supabase\/supabase-js$/},()=>({path:'sdk',namespace:'sdk'}));
    b.onLoad({filter:/.*/,namespace:'sdk'},()=>({contents:sdk,loader:'js'}));
    b.onResolve({ filter: /^\.\/pages\/.*\.jsx$/ }, args => /\/(TrainingCatalogue|TrainingBooking|Login)\.jsx$/.test(args.path) ? undefined : ({ path: args.path.split('/').pop().replace('.jsx', ''), namespace: 'page' }));
    b.onLoad({ filter: /.*/, namespace: 'page' }, args => ({ contents: `import React from 'react';export default ()=>React.createElement('h1',null,${JSON.stringify(args.path)});`, loader: 'js', resolveDir: root }));
    b.onResolve({ filter: /FlorrieEffects\.jsx$/ }, args => ({ path: args.path, namespace: 'component' }));
    b.onResolve({ filter: /^\.\/(components|contexts)\// }, args => ['/Button.jsx', '/ClientPrivacyContext.jsx', '/SalonAccessClosed.jsx'].some(path => args.path.endsWith(path)) ? undefined : ({ path: args.path, namespace: 'component' }));
    b.onLoad({ filter: /.*/, namespace: 'component' }, () => ({ contents: 'export const FlorrieOrb=()=>null;export const iconName=x=>x;export const CoachProvider=({children})=>children;export default ({children})=>children||null;', loader: 'js' }));
  } }],
});
const assets = Object.fromEntries(bundle.outputFiles.map(file => ['/' + file.path.split('/').pop(), file.text]));
const server = http.createServer((req, res) => {
  if (req.url in assets) { res.setHeader('content-type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(assets[req.url]); return; }
  res.setHeader('content-type', 'text/html');
  res.end('<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = process.env.FLORRIE_BROWSER === 'webkit' ? await webkit.launch() : await launch(existsSync(chrome) ? { executablePath: chrome } : {});
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(7000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const publicOnly = async () => {
    assert.deepEqual(await page.evaluate(() => ({ auth:fixture.authReads, profile:fixture.profileReads, writes:fixture.requests.filter(r=>r.method!=='GET') })), { auth:0, profile:0, writes:[] });
    assert.equal(await page.getByText('Business name', { exact:true }).count(), 0);
  };
  for (const mode of ['guest', 'student', 'owner']) {
    await page.goto(`${origin}/training/fictional?fixture=${mode}`);
    await page.getByRole('heading', { name:'Learn with us', exact:true }).waitFor();
    await page.getByText('2 dates available', { exact:false }).waitFor();
    await publicOnly();
    await page.getByRole('link', { name:'View course & dates' }).click();
    await page.getByText('Choose your training date', { exact:true }).waitFor();
    assert.equal(await page.getByRole('radio').count(), 2);
    await page.getByRole('radio').nth(1).check();
    assert.equal(await page.getByRole('radio').nth(1).isChecked(), true);
    await publicOnly();
    await page.goto(`${origin}/training/fictional/11111111-1111-4111-8111-111111111111?fixture=${mode}`);
    await page.getByRole('radio').nth(1).waitFor();
    await publicOnly();
  }
  for (const path of ['/book/fictional', '/book/fictional/confirmed', '/book/fictional/manage/token', '/form/token', '/privacy', '/terms', '/support', '/data-deletion', '/help/data-deletion']) {
    await page.goto(origin+path+'?fixture=student');
    await page.getByRole('heading').waitFor();
    await publicOnly();
  }
  await page.goto(origin+'/training/missing?fixture=student');
  await page.getByRole('alert').waitFor();
  await publicOnly();
  for (const path of ['/onboarding', '/courses', '/today', '/signup']) {
    await page.goto(origin+path+'?fixture=student');
    await page.getByRole('heading', { name:'Salon access is invite only', exact:true }).waitFor();
    assert.equal(await page.getByText('Onboarding', { exact:true }).count(), 0);
  }
  await page.goto(origin+'/signup');
  await page.getByRole('heading', { name:'Salon access is invite only', exact:true }).waitFor();
  await page.goto(origin+'/login?mode=signup');
  await page.getByRole('heading', { name:'Welcome back', exact:true }).waitFor();
  assert.equal(await page.getByRole('button', { name:/Create account|Sign up/ }).count(), 0);
  await page.locator('input[type=email]').fill('fictional@example.invalid');
  await page.locator('input[type=password]').fill('fictional-password');
  await page.getByRole('button', { name:'Sign in', exact:true }).click();
  assert.deepEqual(await page.evaluate(()=>({signins:fixture.signins,signups:fixture.signups})),{signins:1,signups:0});
  await page.getByRole('button', { name:'Forgot password?' }).click();
  await page.getByRole('heading', { name:'Reset your password' }).waitFor();
  await page.getByRole('button', { name:'Back to Sign In' }).click();
  await page.getByRole('heading', { name:'Welcome back' }).waitFor();
  await page.goto(origin+'/today?fixture=owner');
  await page.getByRole('heading', { name:'Hub', exact:true }).waitFor();
  // A normal sign-in must load the approved profile without a reload; signing
  // into an unapproved account afterwards must never reuse that owner profile.
  await page.goto(origin+'/login');
  await page.getByRole('heading', { name:'Welcome back' }).waitFor();
  await page.evaluate(()=>{fixture.nextSignIn='owner';fixture.profileFailure=true;});
  await page.locator('input[type=email]').fill('owner@example.invalid');
  await page.locator('input[type=password]').fill('fictional-password');
  await page.getByRole('button', { name:'Sign in', exact:true }).click();
  await page.getByRole('heading', { name:'Couldn’t load your salon', exact:true }).waitFor();
  await page.evaluate(()=>{fixture.profileFailure=false;});
  await page.getByRole('button', {name:'Try again',exact:true}).click();
  await page.getByRole('heading', { name:'Hub', exact:true }).waitFor();
  await page.evaluate(()=>{history.replaceState(null,'','/today');window.dispatchEvent(new PopStateEvent('popstate'));});
  await page.evaluate(()=>{fixture.session=null;for(const fn of fixture.listeners)fn('SIGNED_OUT',null);});
  // Stay in this same mounted app so a previous owner's cache cannot leak.
  await page.getByRole('heading', { name:'Welcome back' }).waitFor();
  await page.evaluate(()=>{fixture.nextSignIn='student';});
  await page.locator('input[type=email]').fill('student@example.invalid');
  await page.locator('input[type=password]').fill('fictional-password');
  await page.getByRole('button', { name:'Sign in', exact:true }).click();
  await page.getByRole('heading', { name:'Salon access is invite only', exact:true }).waitFor();
  assert.equal(await page.getByRole('heading', {name:'Onboarding',exact:true}).count(),0);
  assert.deepEqual(errors, []);
  console.log('PASS: actual App public course list/detail, date selection, guest/client/owner sessions, no owner auth/provisioning on public routes, missing-course error, booking/manage/forms/legal routes, closed signup/onboarding, existing owner sign-in and recovery.');
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
