// Real React/router lifecycle regressions with stubbed native/auth providers.
// No external network, account creation, email or device authentication.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import http from 'node:http';
import { launch } from './lib/browser.mjs';
const root = new URL('../', import.meta.url).pathname;
const stubs = {
  '@capacitor/app': `export const App={addListener:async(_,fn)=>{window.fixture.receive=fn;return {remove:async()=>{}}},getLaunchUrl:async()=>{window.fixture.launchReads++;return {url:window.fixture.launch}}};`,
  '@capacitor/browser': `export const Browser={close:async()=>{},open:async()=>{}};`,
  '@capacitor-community/apple-sign-in': `export const SignInWithApple={};`,
  platform: `export const isIOSNative=()=>true;`,
  supabase: `export const supabase={auth:{exchangeCodeForSession:async(code)=>{window.fixture.exchanges++;if(window.fixture.exchanges>1)return {error:new Error('used')};return {data:{session:{user:{id:'test'}}}}},signInWithPassword:async()=>({error:null})}};`,
};
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter,useNavigate,useLocation} from 'react-router-dom';
import Bridge from './src/components/NativeAuthBridge.jsx';
import Login from './src/pages/Login.jsx';
import {supabase} from './src/lib/supabase.js';
window.fixture={exchanges:0,launchReads:0,launch:location.search.includes('cold')?'ai.florrie.app://auth/callback?code=fixture':null};
function Harness(){const nav=useNavigate(),loc=useLocation();return <><Bridge/><output data-testid="path">{loc.pathname+loc.search}</output><button onClick={()=>nav('/settings')}>Go settings</button><button onClick={()=>nav('/login?auth_error=1')}>Report auth error</button>{loc.pathname==='/login'&&<Login supabase={supabase}/>}</>}
createRoot(document.getElementById('root')).render(<React.StrictMode><BrowserRouter><Harness/></BrowserRouter></React.StrictMode>);
`;
const bundle = await build({ stdin:{contents:entry,resolveDir:root,loader:'jsx'},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',define:{'import.meta.env':JSON.stringify({VITE_SUPABASE_URL:'https://fixture.invalid',VITE_SUPABASE_ANON_KEY:'fixture'})},plugins:[{
 name:'native-test-stubs',setup(b){
  b.onResolve({filter:/^@capacitor\/(app|browser)$|^@capacitor-community\/apple-sign-in$/},args=>({path:args.path,namespace:'test-stub'}));
  b.onResolve({filter:/\/lib\/(platform|supabase)\.js$/},args=>({path:args.path.includes('platform')?'platform':'supabase',namespace:'test-stub'}));
  b.onLoad({filter:/.*/,namespace:'test-stub'},args=>({contents:stubs[args.path],loader:'js'}));
 }}] });
const server=http.createServer((req,res)=>{
 res.setHeader('content-type',req.url.startsWith('/fixture.js')?'text/javascript':'text/html');
 res.end(req.url.startsWith('/fixture.js')?bundle.outputFiles[0].text:'<div id="root"></div><script src="/fixture.js"></script>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
 browser=await launch(process.env.BROWSER_EXECUTABLE ? {executablePath:process.env.BROWSER_EXECUTABLE} : {});const page=await browser.newPage();const failures=[];
 page.on('pageerror',error=>failures.push(error.message));
 await page.route('https://fixture.invalid/**',route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}));
 const origin=`http://127.0.0.1:${server.address().port}`;
 await page.goto(`${origin}/login`);
 await page.locator('input[type=password]').waitFor();
 assert.equal(await page.locator('input[type=password]').count(),1,'email login retains password during provider outage');
 await page.getByRole('button',{name:'Report auth error'}).click();
 await page.getByText('That sign-in link could not be completed. Please try again.',{exact:true}).waitFor();
 await page.goto(`${origin}/login?cold=1`);
 await page.getByTestId('path').filter({hasText:'/today'}).waitFor();
 await page.getByRole('button',{name:'Go settings'}).click();
 await page.getByTestId('path').filter({hasText:'/settings'}).waitFor();
 // Allow router effects and native promise callbacks to complete after the
 // route change; a replay would navigate back to login and increment exchanges.
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.equal(await page.getByTestId('path').textContent(),'/settings');
 assert.deepEqual(await page.evaluate(()=>({exchanges:fixture.exchanges,launchReads:fixture.launchReads})),{exchanges:1,launchReads:1});
 await page.evaluate(()=>fixture.receive({url:fixture.launch}));
 assert.equal(await page.evaluate(()=>fixture.exchanges),1,'warm duplicate after navigation keeps the same seen-code set');
 assert.deepEqual(failures,[]);
 console.log('PASS: provider outage email fallback; same-route auth error; cold callback and route changes exchange once; warm duplicate stays consumed');
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
