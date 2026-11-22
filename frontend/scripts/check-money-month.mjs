// Fictional records, built app and blocked external traffic. No live writes.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import http from 'node:http';
import { appointmentMoneyReport } from '../../backend/src/lib/appointment-money.js';
import { launch } from './lib/browser.mjs';
import { webkit } from '@playwright/test';
import { fetchStubSource, sessionSeedSource, bundleSupabaseUrl } from './lib/fixtures.mjs';
const now = new Date('2026-11-22T10:00:00Z');
const booking = (id, day, price, status = 'completed') => ({ id, starts_at: `2026-${day}T10:00:00Z`, price_cents: price, status });
const diary = appointmentMoneyReport([
  booking('a', '11-05', 20000), booking('b', '11-19', 20000), booking('c', '11-25', 35000, 'confirmed'),
  booking('cancelled', '11-10', 90000, 'cancelled'), booking('no-show', '11-10', 98000, 'no_show'),
  booking('unpaid', '11-10', 88000, 'pending_deposit'), booking('older', '10-05', 12000), booking('later', '12-05', 24000, 'confirmed'),
], { now });
const empty = appointmentMoneyReport([], { now });
const dist = new URL('../dist', import.meta.url).pathname;
const output = process.env.VISUAL_OUTPUT_DIR;
if (output) mkdirSync(output, { recursive: true });
const server = http.createServer((req, res) => {
  let file = join(dist, (req.url || '/').split('?')[0]);
  if (!existsSync(file) || !extname(file)) file = join(dist, 'index.html');
  res.setHeader('content-type', ({ '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.woff2':'font/woff2' })[extname(file)] || 'text/html');
  try { res.end(readFileSync(file)); } catch { res.statusCode = 404; res.end(); }
}).listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const browser = await (process.env.MONEY_BROWSER === 'webkit' ? webkit.launch() : launch()), baseUrl = `http://127.0.0.1:${server.address().port}`;
async function fixture(mode = 'ready', width = 390) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await context.addInitScript(fetchStubSource());
  await context.addInitScript(sessionSeedSource(bundleSupabaseUrl(dist)));
  await context.addInitScript(({ diary, empty, mode }) => {
    const base = window.fetch;
    const state = window.moneyMonth = { mode, writes: [], reads: 0, fail: false };
    const rows = [
      { id:'nov-deposit', type:'deposit', status:'completed', amount_cents:7000, payment_method:'card_online', stripe_payment_intent_id:'pi_nov', created_at:'2026-11-18T12:00:00Z' },
      { id:'oct-work-paid-now', type:'payment', status:'completed', amount_cents:2000, payment_method:'cash', created_at:'2026-11-19T12:00:00Z', appointments:{ starts_at:'2026-10-05T10:00:00Z' } },
      { id:'oct-deposit', type:'deposit', status:'completed', amount_cents:4000, payment_method:'card_online', stripe_payment_intent_id:'pi_oct', created_at:'2026-10-01T12:00:00Z', appointments:{ starts_at:'2026-11-05T10:00:00Z' } },
      { id:'unrecorded', appointment_id:'a', type:'payment', status:'completed', payment_method:'completion_record', amount_cents:16000, created_at:'2026-11-05T12:00:00Z', appointments:{ starts_at:'2026-11-05T10:00:00Z' } },
    ];
    if(mode==='falling')rows.find(r=>r.id==='oct-deposit').amount_cents=40000;
    const json = (body, status = 200, count) => new Response(JSON.stringify(body), { status, headers: { 'content-type':'application/json', ...(count === undefined ? {} : { 'content-range': `*/${count}` }) } });
    window.fetch = async (input, options = {}) => {
      const path = new URL(String(input), location.href).pathname;
      if (options.method && !['GET','HEAD'].includes(options.method)) {
        state.writes.push(path);
        if (path !== '/api/money/receipts/unrecorded/payment-status') return json({error:'Unexpected write'},409);
        if (state.fail) return json({error:'Save not confirmed. Refresh your payments.'},503);
        const body=JSON.parse(options.body), tx=rows.find(r=>r.id==='unrecorded');
        if(body.expected_amount_cents!==tx.amount_cents)return json({error:'Payment changed'},409);
        Object.assign(tx,{payment_method:body.paid?'completion_record':'completion_unpaid',status:body.paid?'completed':'pending'});
        return json({transaction:tx});
      }
      if (path.endsWith('/transactions')) return json(rows, 200, rows.length);
      if (path.endsWith('/expenses')) return json([], 200, 0);
      if (path === '/api/money/reports') {
        state.reads++;
        if (state.mode === 'held') await new Promise(resolve => { state.release = resolve; });
        if (state.mode === 'error') return json({ error:'Temporary failure' }, 503);
        return json({ appointments: state.mode === 'malformed' ? {} : state.mode === 'empty' ? empty : diary, revenue:{ this_month_cents:9000, change_pct:null }, rebooking_rate:{ pct:null }, no_show_rate:{ pct:null } });
      }
      const result=await base(input, options);
      if(path.endsWith('/beauticians')) { const owners=await result.json(); return json(Array.isArray(owners)?owners.map(o=>({...o,completion_receipts_enabled:true})):owners); }
      return result;
    };
  }, { diary, empty, mode });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.setFixedTime(now);
  await page.goto(baseUrl + '/money');
  await page.getByRole('button', { name:'View payments', exact:true }).waitFor();
  return { context, page, errors };
}
try {
  for (const width of [320,390,430]) {
    const {context,page,errors}=await fixture('ready',width);
    const card=page.getByRole('region',{name:'Money received',exact:true});
    await card.getByRole('heading',{name:'£250.00',exact:true}).waitFor();
    await card.getByText('↑ 525%',{exact:true}).waitFor();
    await page.getByRole('button',{name:'View upcoming appointments'}).getByText('£350.00',{exact:true}).waitFor();
    assert.equal(await card.locator('details[open]').count(),0);
    assert.equal(await page.locator('.money-recent-row').count(),4);
    assert.match(await page.locator('.money-recent-row').first().innerText(),/19 Nov 2026/);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    if(output)await page.screenshot({path:join(output,`month-${width}.png`)});
    await page.getByRole('button',{name:'This Week',exact:true}).click();
    await card.getByRole('heading',{name:'£90.00',exact:true}).waitFor();
    await card.getByText('No previous total',{exact:true}).waitFor();
    await page.locator('.money-workspace').getByRole('button',{name:'Today',exact:true}).click();
    await card.getByRole('heading',{name:'£0.00',exact:true}).waitFor();
    assert.equal(await page.locator('.money-recent-row').count(),4,'Latest payments do not disappear on days with no receipts');
    await page.getByRole('button',{name:'See all',exact:true}).click();
    await page.getByRole('heading',{name:'Received',exact:true}).waitFor();
    assert.equal(await page.locator('.money-payment-row').count(),4,'See all includes all dates');
    await page.getByRole('button',{name:'Pulse',exact:true}).click();
    await page.getByRole('button',{name:'This Month',exact:true}).click();
    await page.getByRole('button',{name:'Hide client details',exact:true}).click();
    assert.doesNotMatch(await page.locator('.money-workspace').innerText(),/£250|£350|£90|525%/);
    assert.match(await page.locator('.money-recent').innerText(),/Paid on completion/);
    await page.getByRole('button',{name:'Hide client details',exact:true}).click();
    await page.getByRole('button',{name:'View payments',exact:true}).click();
    await page.getByRole('heading',{name:'Received',exact:true}).waitFor();
    assert.equal(await page.locator('.money-payment-row').count(),3,'Month drill-down follows receipt dates');
    const auto=page.locator('.money-payment-row').filter({hasText:'Paid on completion'});
    assert.equal(await page.getByRole('button',{name:'Mark unpaid',exact:true}).count(),1,'Only bookkeeping receipts can be marked unpaid');
    await auto.getByRole('button',{name:'Mark unpaid',exact:true}).click();
    await page.evaluate(()=>moneyMonth.fail=true);
    await auto.getByRole('group',{name:'Change payment status'}).getByRole('button',{name:'Mark unpaid',exact:true}).click();
    await auto.getByRole('alert').waitFor();
    await page.evaluate(()=>moneyMonth.fail=false);
    await auto.getByRole('group',{name:'Change payment status'}).getByRole('button',{name:'Mark unpaid',exact:true}).click();
    await page.getByRole('status').filter({hasText:'Marked unpaid'}).waitFor();
    await page.getByLabel('Income records').selectOption('review');
    await page.getByText('Unpaid',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Pulse',exact:true}).click();
    await card.getByRole('heading',{name:'£90.00',exact:true}).waitFor();
    await page.getByRole('button',{name:'Check unpaid payments',exact:true}).click();
    await page.getByRole('button',{name:'Undo unpaid',exact:true}).click();
    await page.getByRole('button',{name:'Restore payment',exact:true}).click();
    await page.getByRole('status').filter({hasText:'Payment recorded'}).waitFor();
    await page.getByRole('button',{name:'Tax',exact:true}).click();
    await page.getByRole('region',{name:'Tax year figures'}).getByText('£290.00',{exact:true}).first().waitFor();
    await page.getByText('Money received by month',{exact:true}).click();
    await page.getByText('£250.00',{exact:true}).waitFor();
    assert.deepEqual(await page.evaluate(()=>moneyMonth.writes),Array(3).fill('/api/money/receipts/unrecorded/payment-status'));
    assert.deepEqual(errors,[]);
    await context.close();console.log(`PASS ${width}px income, comparison, recent payments, privacy, unpaid/undo, retry and tax totals`);
  }
  {
    const {context,page}=await fixture('falling');
    await page.locator('.money-change--down').getByText('↓ 37.5%',{exact:true}).waitFor();
    assert.equal(await page.locator('.money-change--up').count(),0);
    await context.close();console.log('PASS lower income uses a downward comparison');
  }
  for(const mode of ['error','malformed','held','empty']) {
    const {context,page}=await fixture(mode);
    const card=page.getByRole('region',{name:'Money received',exact:true});
    await card.getByRole('heading',{name:'£250.00',exact:true}).waitFor();
    if(['error','malformed'].includes(mode)){
      await page.getByRole('button',{name:'Retry upcoming appointments',exact:true}).waitFor();
      await page.evaluate(()=>moneyMonth.mode='ready');
      await page.getByRole('button',{name:'Retry upcoming appointments',exact:true}).click();
    } else if(mode==='held') {
      await page.getByRole('status').filter({hasText:'Checking upcoming appointments'}).waitFor();
      await page.waitForFunction(()=>!!moneyMonth.release);await page.evaluate(()=>moneyMonth.release());
    }
    await page.getByRole('button',{name:'View upcoming appointments',exact:true}).waitFor();
    assert.deepEqual(await page.evaluate(()=>moneyMonth.writes),[]);
    await context.close();console.log(`PASS ${mode} diary keeps money usable`);
  }
} finally {await browser.close();server.close();}
