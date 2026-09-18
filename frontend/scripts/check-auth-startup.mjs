// Exercise the real App routing/effect with synthetic auth; all external traffic is blocked.
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
import App from './src/App.jsx';
window.fixture={requests:[],listeners:new Set(),signOuts:0,
 session:{user:{id:'fixture-owner'},access_token:'fixture-only-token'},
 event(event,session){for(const callback of this.listeners) callback(event,session);},
 resolve(index,session=this.session){this.requests[index].resolve({data:{session},error:null});}
};
window.fetch=async()=>({ok:true,json:async()=>({inbox:0,approvals:0})});
localStorage.setItem('fixture-auth-session','preserved');
createRoot(document.getElementById('root')).render(<React.StrictMode><BrowserRouter><App/></BrowserRouter></React.StrictMode>);
`;
const stubs = {
  supabase: `export const supabase={auth:{
    getSession(){return new Promise((resolve,reject)=>window.fixture.requests.push({resolve,reject}));},
    onAuthStateChange(fn){window.fixture.listeners.add(fn);return {data:{subscription:{unsubscribe(){window.fixture.listeners.delete(fn);}}}};},
    signOut(){window.fixture.signOuts++;throw Error('unexpected sign-out');}
  }};
  export const useBeautician=()=>({beautician:{id:'fixture-owner',onboarding_completed_at:'2026-09-01',subscription_status:'active'}});`,
  config: 'export const API_BASE="";',
  platform: 'export const isIOSNative=()=>true;export const isNativeApp=()=>false;',
  native: 'export const hapticTap=()=>{};',
  voicePref: 'export const isVoiceEnabled=()=>true;',
  theme: 'export const useTheme=()=>({});',
};
const bundle = await build({
  stdin: { contents: entry, resolveDir: root, loader: 'jsx' },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
  plugins: [{ name: 'auth-startup-fixture', setup(b) {
    b.onResolve({ filter: /\/lib\/(supabase|config|platform|native|voicePref|theme)\.(js|jsx)$/ }, args => ({
      path: args.path.split('/').pop().replace(/\.jsx?$/, ''), namespace: 'test-stub',
    }));
    b.onLoad({ filter: /.*/, namespace: 'test-stub' }, args => ({ contents: stubs[args.path], loader: 'js' }));
    b.onResolve({ filter: /^\.\/pages\/.*\.jsx$/ }, args => ({ path: args.path.split('/').pop().replace('.jsx', ''), namespace: 'test-page' }));
    b.onLoad({ filter: /.*/, namespace: 'test-page' }, args => ({ contents: `import React from 'react';export default ()=>React.createElement('h1',null,${JSON.stringify(args.path)});`, loader: 'js', resolveDir: root }));
    b.onResolve({ filter: /FlorrieEffects\.jsx$/ }, args => ({ path: args.path, namespace: 'test-component' }));
    b.onResolve({ filter: /^\.\/(components|contexts)\// }, args => args.path.endsWith('/Button.jsx') ? undefined : ({ path: args.path, namespace: 'test-component' }));
    b.onLoad({ filter: /.*/, namespace: 'test-component' }, () => ({ contents: 'export const FlorrieOrb=()=>null;export const iconName=x=>x;export const CoachProvider=({children})=>children;export default ({children})=>children||null;', loader: 'js' }));
  } }],
});
const server = http.createServer((req, res) => {
  const script = req.url === '/fixture.js';
  res.setHeader('content-type', script ? 'text/javascript' : 'text/html');
  res.end(script ? bundle.outputFiles[0].text : '<div id="root"></div><script src="/fixture.js"></script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const executablePath = process.env.BROWSER_EXECUTABLE || (existsSync(chrome) ? chrome : undefined);
  browser = await launch(executablePath ? { executablePath } : {});
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.clock.install();
  const mount = async path => {
    await page.goto(origin + path);
    await page.waitForFunction(() => fixture.requests.length === 1);
  };

  await mount('/today');
  await page.clock.runFor(16_501);
  await page.getByRole('heading', { name: 'Couldn’t open Florrie yet', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Login', exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => fixture.requests.length), 2);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.waitForFunction(() => fixture.requests.length === 3);
  await page.evaluate(() => fixture.resolve(2));
  await page.getByRole('heading', { name: 'Hub', exact: true }).waitFor();
  await page.evaluate(() => { fixture.resolve(0, null); fixture.resolve(1, null); });
  await page.getByRole('heading', { name: 'Hub', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => fixture.signOuts), 0);
  assert.equal(await page.evaluate(() => localStorage.getItem('fixture-auth-session')), 'preserved');

  await mount('/today');
  await page.evaluate(() => fixture.event('SIGNED_IN', fixture.session));
  await page.getByRole('heading', { name: 'Hub', exact: true }).waitFor();
  await page.evaluate(() => fixture.resolve(0, null));
  await page.getByRole('heading', { name: 'Hub', exact: true }).waitFor();
  await page.evaluate(() => fixture.event('SIGNED_OUT', null));
  await page.getByRole('heading', { name: 'Login', exact: true }).waitFor();

  await mount('/today');
  await page.evaluate(() => { fixture.event('INITIAL_SESSION', null); fixture.requests[0].reject(new Error('offline')); });
  await page.clock.runFor(501);
  await page.waitForFunction(() => fixture.requests.length === 2);
  await page.evaluate(() => fixture.requests[1].resolve({ data: { session: null }, error: { message: 'offline' } }));
  await page.getByRole('alert').waitFor();
  assert.equal(new URL(page.url()).pathname, '/today', 'transient failure must not navigate to login');
  await page.evaluate(() => fixture.event('TOKEN_REFRESHED', fixture.session));
  await page.getByRole('heading', { name: 'Hub', exact: true }).waitFor();

  await mount('/book/demo');
  await page.getByRole('heading', { name: 'BookingPage', exact: true }).waitFor();
  await page.clock.runFor(16_501);
  await page.getByRole('heading', { name: 'BookingPage', exact: true }).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0, 'owner auth failure must not block client booking');
  assert.deepEqual(errors, []);
  console.log('PASS: real App bounds stalled auth; Retry restores workspace; auth events release loading; stale reads cannot overwrite session; transient failures preserve route/storage; public booking stays open; StrictMode cleanup is safe');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
