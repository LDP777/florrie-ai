// Actual Settings page and Calendar helpers; no live accounts or OAuth calls.
import assert from 'node:assert/strict';
import http from 'node:http';
import { build } from 'esbuild';
import { launch } from './lib/browser.mjs';
const root = new URL('../', import.meta.url).pathname;
const bundle = await build({
  stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';import {BrowserRouter} from 'react-router-dom';
    import Settings from './src/pages/Settings.jsx';
    window.fixture={owner:'salon-a',profile:{id:'salon-a',first_name:'Alex'},opened:[],listeners:new Set(),requests:[],refreshes:0,connected:false,failStatus:new URLSearchParams(location.search).has('fail-status')};
    window.fetch=async(input,options={})=>{
      const url=new URL(String(input),location.origin),path=url.pathname;
      const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
      fixture.requests.push({path,search:url.search});
      if(path==='/api/gcal/connect'){
        const answer=()=>json({url:'https://accounts.google.com/o/oauth2/v2/auth?client_id=fictional&state=signed'});
        if(fixture.holdConnect)return new Promise(resolve=>{fixture.finishConnect=()=>resolve(answer());});
        return answer();
      }
      if(path==='/api/gcal/status'){
        if(fixture.holdStatus)return new Promise(resolve=>{fixture.finishStatus=value=>resolve(json(value));});
        return fixture.failStatus?json({error:'Unavailable'},503):json({connected:fixture.connected});
      }
      return json({});
    };
    createRoot(document.getElementById('root')).render(<React.StrictMode><BrowserRouter><Settings/></BrowserRouter></React.StrictMode>);
  ` },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
  plugins: [{ name: 'fictional-calendar', setup(b) {
    b.onResolve({ filter: /\/lib\/(supabase|config|platform)\.js$/ }, args => ({ path: args.path.split('/').pop(), namespace: 'fixture' }));
    b.onResolve({ filter: /^@capacitor\/browser$/ }, () => ({ path: 'browser', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ loader: 'js', resolveDir: root, contents: {
      'config.js': 'export const API_BASE="https://api.florrie.test";',
      'platform.js': 'export const isNativeApp=()=>true;export const isIOSNative=()=>true;',
      browser: 'export const Browser={async open({url}){fixture.opened.push(url);},async addListener(name,callback){fixture.listeners.add(callback);return{async remove(){fixture.listeners.delete(callback);}};}};',
      'supabase.js': `import {useState,useCallback} from 'react';export const supabase={auth:{async getSession(){return{data:{session:{access_token:'fixture-'+fixture.owner}}};}}};export const updateRow=async()=>{throw Error('Unexpected profile write');};export const useBeautician=()=>{const[,tick]=useState(0);fixture.rerender=()=>tick(v=>v+1);const refresh=useCallback(async()=>{fixture.refreshes++;fixture.profile={...fixture.profile,google_calendar_connected:fixture.connected};tick(v=>v+1);},[]);return{beautician:fixture.profile,loading:false,refresh};};`,
    }[path] }));
  } }],
});
const server = http.createServer((req, res) => {
  const js = req.url === '/fixture.js'; res.setHeader('Content-Type', js ? 'text/javascript' : 'text/html');
  res.end(js ? bundle.outputFiles[0].text : '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/fixture.js"></script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const start = async () => { await page.goto(origin + '/settings?section=calendar'); await page.getByRole('button', { name: 'Connect', exact: true }).waitFor(); };
  const connect = async count => { await page.getByRole('button', { name: 'Connect', exact: true }).click(); await page.waitForFunction(count => fixture.opened.length === count, count); };
  const finish = () => page.evaluate(() => { for (const callback of fixture.listeners) callback(); });

  await start(); await connect(1);
  assert.equal(new URL(page.url()).pathname, '/settings');
  assert.equal(await page.evaluate(() => fixture.requests.find(r => r.path === '/api/gcal/connect').search), '?platform=native');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(30);
  assert.equal(await page.evaluate(() => fixture.requests.filter(r => r.path === '/api/gcal/status').length), 0, 'foregrounding while the Google sheet remains open must not finish the attempt');
  await finish(); await page.getByText('Google Calendar is not connected yet.', { exact: false }).waitFor();
  await finish();
  assert.equal(await page.evaluate(() => fixture.requests.filter(r => r.path === '/api/gcal/status').length), 1);
  assert.equal(await page.getByText('Google Calendar connected', { exact: true }).count(), 0);

  await connect(2); await page.evaluate(() => { fixture.holdStatus = true; }); await finish(); await finish();
  await page.waitForFunction(() => !!fixture.finishStatus);
  assert.equal(await page.getByText('Google Calendar connected', { exact: true }).count(), 0);
  await page.evaluate(() => { fixture.connected = true; fixture.finishStatus({ connected: true }); });
  await page.getByRole('button', { name: 'Disconnect', exact: true }).waitFor();
  await page.getByText('Google Calendar connected', { exact: true }).waitFor();

  await start(); await connect(1); await page.evaluate(() => { fixture.failStatus = true; }); await finish();
  await page.getByRole('alert').filter({ hasText: 'Could not confirm your calendar connection' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Connect', exact: true }).isEnabled(), true);

  await start(); await connect(1); await page.evaluate(() => { fixture.holdStatus = true; }); await finish();
  await page.waitForFunction(() => !!fixture.finishStatus);
  await page.evaluate(() => { fixture.owner = 'salon-b'; fixture.profile = { id: 'salon-b', first_name: 'Bea' }; fixture.rerender(); });
  await page.getByRole('button', { name: 'Connect', exact: true }).waitFor();
  await page.evaluate(() => fixture.finishStatus({ connected: true }));
  await page.waitForTimeout(30);
  assert.equal(await page.getByText('Google Calendar connected', { exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => fixture.refreshes), 0);

  await start(); await page.evaluate(() => { fixture.holdConnect = true; });
  await page.getByRole('button', { name: 'Connect', exact: true }).click(); await page.waitForFunction(() => !!fixture.finishConnect);
  await page.evaluate(() => { fixture.owner = 'salon-b'; fixture.profile = { id: 'salon-b', first_name: 'Bea' }; fixture.rerender(); });
  await page.getByRole('button', { name: 'Connect', exact: true }).waitFor();
  await page.evaluate(() => fixture.finishConnect()); await page.waitForTimeout(30);
  assert.deepEqual(await page.evaluate(() => fixture.opened), []);
  await page.goto(origin + '/settings?gcal=success');
  await page.getByText('Google Calendar is not connected yet.', { exact: false }).waitFor();
  assert.equal(await page.getByText('Google Calendar connected', { exact: true }).count(), 0, 'a success query parameter cannot prove the signed-in salon is connected');
  await page.goto(origin + '/settings?gcal=success&fail-status=1');
  await page.getByRole('alert').filter({ hasText: 'Could not confirm your calendar connection' }).waitFor();
  assert.equal(await page.getByText('Google Calendar connected', { exact: true }).count(), 0);
  assert.equal(new URL(page.url()).search, '?section=calendar');
  assert.deepEqual(errors, []);
  console.log('PASS: real Settings native Calendar handoff, cancellation, confirmed status, duplicate returns, failed status and owner changes before opening/while returning');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
