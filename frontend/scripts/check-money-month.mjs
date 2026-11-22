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
    const state = window.moneyMonth = { mode, writes: [], reads: 0 };
    const rows = [
      { id:'nov-deposit', type:'deposit', status:'completed', amount_cents:7000, payment_method:'card_online', stripe_payment_intent_id:'pi_nov', created_at:'2026-11-18T12:00:00Z' },
      { id:'oct-work-paid-now', type:'payment', status:'completed', amount_cents:2000, payment_method:'cash', created_at:'2026-11-19T12:00:00Z', appointments:{ starts_at:'2026-10-05T10:00:00Z' } },
      { id:'oct-deposit', type:'deposit', status:'completed', amount_cents:4000, payment_method:'card_online', stripe_payment_intent_id:'pi_oct', created_at:'2026-10-01T12:00:00Z', appointments:{ starts_at:'2026-11-05T10:00:00Z' } },
      { id:'unrecorded', appointment_id:'a', type:'payment', status:'completed', amount_cents:16000, created_at:'2026-11-05T12:00:00Z', appointments:{ starts_at:'2026-11-05T10:00:00Z' } },
    ];
    const json = (body, status = 200, count) => new Response(JSON.stringify(body), { status, headers: { 'content-type':'application/json', ...(count === undefined ? {} : { 'content-range': `*/${count}` }) } });
    window.fetch = async (input, options = {}) => {
      const path = new URL(String(input), location.href).pathname;
      if (options.method && !['GET','HEAD'].includes(options.method)) { state.writes.push(path); return json({ error:'Unexpected write' }, 409); }
      if (path.endsWith('/transactions')) return json(rows, 200, rows.length);
      if (path.endsWith('/expenses')) return json([], 200, 0);
      if (path === '/api/money/reports') {
        state.reads++;
        if (state.mode === 'held') await new Promise(resolve => { state.release = resolve; });
        if (state.mode === 'error') return json({ error:'Temporary failure' }, 503);
        return json({ appointments: state.mode === 'malformed' ? {} : state.mode === 'empty' ? empty : diary, revenue:{ this_month_cents:9000, change_pct:null }, rebooking_rate:{ pct:null }, no_show_rate:{ pct:null } });
      }
      return base(input, options);
    };
  }, { diary, empty, mode });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.setFixedTime(now);
  await page.goto(baseUrl + '/money');
  await page.getByRole('button', { name:'View recorded payments', exact:true }).waitFor();
  return { context, page, errors };
}
try {
  for (const width of [320, 390, 430]) {
    const { context, page, errors } = await fixture('ready', width);
    const card = page.getByRole('region', { name:'Appointment value', exact:true });
    await card.getByRole('heading', { name:'£750.00', exact:true }).waitFor();
    assert.equal(await page.getByRole('button', { name:'This Month', exact:true }).getAttribute('aria-pressed'), 'true');
    await card.getByText('£400.00', { exact:true }).waitFor();
    await card.getByText('£350.00', { exact:true }).waitFor();
    await page.getByRole('button', { name:'View recorded payments' }).getByText('£90.00', { exact:true }).waitFor();
    assert.equal(await card.locator('details[open]').count(), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    if (output) await page.screenshot({ path:join(output, `month-${width}.png`) });
    await page.getByRole('button', { name:'This Week', exact:true }).click();
    await card.getByRole('heading', { name:'£200.00', exact:true }).waitFor();
    await page.locator('.money-workspace').getByRole('button', { name:'Today', exact:true }).click();
    await card.getByRole('heading', { name:'£0.00', exact:true }).waitFor();
    await page.getByRole('button', { name:'This Month', exact:true }).click();
    await page.getByRole('button', { name:'Hide client details', exact:true }).click();
    assert.doesNotMatch(await page.locator('.money-workspace').innerText(), /£750|£400|£350|£90/);
    await page.getByRole('button', { name:'Hide client details', exact:true }).click();
    await page.getByRole('button', { name:'View recorded payments', exact:true }).click();
    await page.getByRole('heading', { name:'Received', exact:true }).waitFor();
    assert.equal(await page.locator('.money-payment-row').count(), 2, 'The month drill-down uses receipt dates, including payment for older work');
    await page.getByRole('button', { name:'All dates', exact:true }).click();
    await page.getByRole('button', { name:'All dates', exact:true }).waitFor({ state:'hidden' });
    assert.equal(await page.locator('.money-payment-row').count(), 3);
    await page.getByRole('button', { name:'Pulse', exact:true }).click();
    await page.getByRole('button', { name:'Record cash & bank payments', exact:true }).click();
    await page.getByRole('heading', { name:'To record', exact:true }).waitFor();
    assert.equal(await page.locator('.money-payment-row').count(), 1);
    await page.getByRole('button', { name:'Pulse', exact:true }).click();
    await page.getByRole('button', { name:'Open appointments in calendar', exact:true }).click();
    await page.waitForURL('**/calendar');
    assert.deepEqual(await page.evaluate(() => moneyMonth.writes), []);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS monthly diary/payment separation, period drill-down, privacy and ${width}px layout`);
  }
  for (const mode of ['error', 'malformed']) {
    const { context, page } = await fixture(mode);
    await page.getByRole('alert').filter({ hasText:'Couldn’t load your diary totals.' }).waitFor();
    await page.getByRole('button', { name:'View recorded payments' }).getByText('£90.00', { exact:true }).waitFor();
    assert.equal(await page.getByRole('region', { name:'Appointment value' }).getByRole('heading').count(), 0);
    await page.evaluate(() => { moneyMonth.mode = 'ready'; });
    await page.getByRole('button', { name:'Retry diary totals', exact:true }).click();
    await page.getByRole('heading', { name:'£750.00', exact:true }).waitFor();
    assert.deepEqual(await page.evaluate(() => moneyMonth.writes), []);
    await context.close(); console.log(`PASS ${mode} keeps receipts usable and diary unknown until retry succeeds`);
  }
  for (const mode of ['held', 'empty']) {
    const { context, page } = await fixture(mode);
    if (mode === 'held') {
      await page.getByRole('status').filter({ hasText:'Checking your diary…' }).waitFor();
      await page.waitForFunction(() => !!moneyMonth.release);
      assert.equal(await page.getByRole('heading', { name:'£0.00', exact:true }).count(), 0);
      await page.evaluate(() => moneyMonth.release());
      await page.getByRole('heading', { name:'£750.00', exact:true }).waitFor();
    } else await page.getByRole('heading', { name:'£0.00', exact:true }).waitFor();
    await context.close(); console.log(`PASS ${mode} has an honest diary total`);
  }
} finally { await browser.close(); server.close(); }
