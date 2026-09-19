// Real Schedule component, synthetic reads and intercepted offers only.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { launch } from './lib/browser.mjs';
const root = new URL('../', import.meta.url).pathname;
const store = `
import {useState,useEffect} from 'react';
let owner={id:'owner-a',booking_slug:'fictional-salon',working_hours:{mon:{start:'09:00',end:'17:00'}}}; const listeners=new Set();
window.fixture={queries:[],offers:[],coreFail:false,ideasFail:false,defer:false,waiters:[],copyFail:false,clipboard:[],fastTimeout:false};
window.fixture.setOwner=id=>{owner={...owner,id};listeners.forEach(fn=>fn(owner));};
export function useBeautician(){const [value,setValue]=useState(owner);useEffect(()=>{listeners.add(setValue);return()=>listeners.delete(setValue)},[]);return {beautician:value,loading:false,refresh:async()=>{}};}
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{if(window.fixture.copyFail)throw Error('Denied');window.fixture.clipboard.push(text);}}});
const realFetch=window.fetch;window.fetch=async(input,opts)=>{
 if(String(input).includes('/api/features/gap-fill-suggestions'))return new Response(JSON.stringify(window.fixture.ideasFail?{error:'failed'}:{suggestions:[]}),{status:window.fixture.ideasFail?503:200});
 if(String(input).includes('/api/suggestions/fill-gap')){window.fixture.offers.push(JSON.parse(opts.body));return new Response(JSON.stringify({code:'gap_unavailable',error:'That time is no longer free. Refresh Schedule to see the current gaps.'}),{status:409});}
 return realFetch(input,opts);
};
export const supabase={auth:{getSession:async()=>({data:{session:{access_token:'fixture-only'}}})},from(table){let selected='',filters=[];const q={select(x){selected=x;return q;},eq(k,v){filters.push(['eq',k,v]);return q;},gte(k,v){filters.push(['gte',k,v]);return q;},lt(k,v){filters.push(['lt',k,v]);return q;},or(x){filters.push(['or',x]);return q;},order(){return q;},limit(){return q;},abortSignal(){return q;},then(resolve,reject){
 const ownerId=filters.find(x=>x[0]==='eq'&&x[1]==='beautician_id')?.[2];
 window.fixture.queries.push({table,selected,filters,ownerId});
 const history=selected.includes('clients('),future=selected==='client_id,status';
 const data=table==='treatments'?[{id:'t1',name:'Fictional brows',duration_minutes:30,price_cents:3000,is_active:true}]:table==='hours_exceptions'?[{date:'2026-09-21',type:'amended',start_time:'12:00',end_time:'13:00'}]:history||future?[]:ownerId==='owner-b'?[{id:'b',starts_at:'2026-09-21T09:00:00Z',ends_at:'2026-09-21T17:00:00Z',status:'confirmed'}]:[{id:'a',starts_at:'2026-09-21T10:00:00Z',ends_at:'2026-09-21T11:00:00Z',duration_minutes:0,status:'confirmed'}];
 const result={data,error:window.fixture.coreFail&&table==='hours_exceptions'?{message:'Synthetic blocked-time read failed'}:null};
 if(window.fixture.defer&&table==='appointments'&&!history&&!future)return new Promise(r=>window.fixture.waiters.push(()=>r(result))).then(resolve,reject);
 return Promise.resolve(result).then(resolve,reject);
}};return q;}};
`;
const entry = `import React from 'react';import {createRoot} from 'react-dom/client';import {BrowserRouter} from 'react-router-dom';import Schedule from './src/pages/SmartSchedule.jsx';import {ThemeProvider} from './src/lib/theme.jsx';import './src/index.css';createRoot(document.getElementById('root')).render(<ThemeProvider><BrowserRouter><Schedule/></BrowserRouter></ThemeProvider>);`;
const out = await build({ stdin: { contents: entry, resolveDir: root, loader: 'jsx' }, bundle: true, write: false, outfile: '/tmp/florrie-schedule-fixture/app.js', format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'import.meta.env': JSON.stringify({ DEV: false, VITE_API_URL: '' }) }, plugins: [{ name: 'fixtures', setup(b) { b.onResolve({ filter: /\/lib\/supabase\.js$/ }, () => ({ path: 'store', namespace: 'fixture' })); b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: store, resolveDir: root })); } }] });
const server = http.createServer((req, res) => {
  const file = out.outputFiles.find(f => f.path.endsWith(req.url));
  if (file) { res.setHeader('content-type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript'); return res.end(file.text); }
  res.setHeader('content-type', 'text/html'); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>');
}).listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const browser = await launch();
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'UTC' });
  await ctx.route('**/*', r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
  await ctx.addInitScript(() => {
    const OriginalDate = Date;
    window.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : ['2026-09-21T08:00:00Z'])); } static now() { return new OriginalDate('2026-09-21T08:00:00Z').getTime(); } };
    const timer = window.setTimeout; window.setTimeout = (fn, delay, ...args) => timer(fn, delay === 15000 && window.fixture?.fastTimeout ? 30 : delay, ...args);
  });
  const page = await ctx.newPage(); const errors = []; page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin);
  await page.getByText('1h booked', { exact: true }).waitFor();
  await page.getByText('1h blocked', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /12:00 to 13:00/ }).count(), 0);
  const queries = await page.evaluate(() => window.fixture.queries);
  assert.ok(queries.find(q => q.table === 'appointments' && q.filters.some(f => f[0] === 'lt')));
  assert.ok(queries.find(q => q.table === 'hours_exceptions' && q.filters.some(f => f[0] === 'or')));

  await page.getByRole('button', { name: /09:00 to 10:00/ }).click();
  await page.getByRole('button', { name: 'Offer this gap to matching clients', exact: true }).click();
  await page.getByText('That time is no longer free.', { exact: false }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.fixture.offers), [{ date: '2026-09-21', start_time: '09:00', end_time: '10:00' }]);
  assert.equal(await page.getByText(/Offered to/).count(), 0);

  await page.getByRole('button', { name: 'Fill Ideas', exact: true }).click();
  await page.getByText('No client ideas to show', { exact: true }).waitFor();
  await page.evaluate(() => { window.fixture.copyFail = true; });
  await page.getByRole('button', { name: 'Copy booking link', exact: true }).click();
  await page.getByText('Could not copy the booking link.', { exact: false }).waitFor();
  assert.equal(await page.getByText('Booking link copied', { exact: true }).count(), 0);
  await page.evaluate(() => { window.fixture.copyFail = false; });
  await page.getByRole('button', { name: 'Copy booking link', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.fixture.clipboard), ['https://florrie.ai/book/fictional-salon']);

  await page.evaluate(() => { window.fixture.ideasFail = true; });
  await page.getByRole('button', { name: 'Refresh schedule', exact: true }).first().click();
  await page.getByText('Could not check client ideas and history.', { exact: false }).waitFor();
  assert.equal(await page.getByText('No client ideas to show', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Gaps', exact: true }).click();
  await page.getByRole('button', { name: /09:00 to 10:00/ }).waitFor();

  await page.evaluate(() => { window.fixture.coreFail = true; });
  await page.getByRole('button', { name: 'Refresh schedule', exact: true }).click();
  await page.getByText('Could not check your schedule and blocked time.', { exact: false }).waitFor();
  assert.equal(await page.getByText(/Fully booked|% booked|No bookable gaps/).count(), 0);
  await page.evaluate(() => { window.fixture.coreFail = false; window.fixture.ideasFail = false; });
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByText('1h booked', { exact: true }).waitFor();

  // A slow old-owner response cannot replace the newer owner's schedule.
  await page.evaluate(() => { window.fixture.defer = true; });
  await page.getByRole('button', { name: 'Refresh schedule', exact: true }).click();
  await page.waitForFunction(() => window.fixture.waiters.length === 1);
  await page.evaluate(() => { window.fixture.defer = false; window.fixture.setOwner('owner-b'); });
  await page.getByText('7h booked', { exact: true }).waitFor();
  await page.evaluate(() => { window.fixture.waiters.splice(0).forEach(fn => fn()); });
  await page.waitForTimeout(50);
  assert.equal(await page.getByText('1h booked', { exact: true }).count(), 0);
  await page.getByText('7h booked', { exact: true }).waitFor();

  await page.evaluate(() => { window.fixture.fastTimeout = true; window.fixture.defer = true; });
  await page.getByRole('button', { name: 'Refresh schedule', exact: true }).click();
  await page.getByText('Could not check your schedule and blocked time.', { exact: false }).waitFor();
  await page.evaluate(() => { window.fixture.fastTimeout = false; window.fixture.defer = false; window.fixture.setOwner('owner-a'); });
  await page.getByText('1h booked', { exact: true }).waitFor();
  for (const width of [320, 390, 820]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Overflow at ${width}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  mkdirSync('/tmp/florrie-smart-schedule-check', { recursive: true });
  await page.screenshot({ path: '/tmp/florrie-smart-schedule-check/phone.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: blocked-time truth, exact offer payload/conflict, honest errors/retry, optional ideas failure, clipboard rejection, stale response, timeout and phone layout');
  await ctx.close();
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
