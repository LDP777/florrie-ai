import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import http from 'node:http';
import { launch } from './lib/browser.mjs';
import { fetchStubSource, sessionSeedSource, bundleSupabaseUrl } from './lib/fixtures.mjs';
const dist = new URL('../dist', import.meta.url).pathname;
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  let file = join(dist, (req.url || '/').split('?')[0]);
  if (!existsSync(file) || !extname(file)) file = join(dist, 'index.html');
  try { res.setHeader('content-type', mime[extname(file)] || 'application/octet-stream'); res.end(readFileSync(file)); }
  catch { res.statusCode = 404; res.end(); }
}).listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const browser = await launch();
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  await context.addInitScript(fetchStubSource());
  await context.addInitScript(sessionSeedSource(bundleSupabaseUrl(dist)));
  await context.addInitScript(() => {
    const base = window.fetch;
    window.__moneyReads = 0; window.__moneyWrites = []; window.__failMoneyPage = false;
    const rows = Array.from({ length: 1200 }, (_, i) => ({ id: `r${i}`, type: 'deposit', status: 'completed', amount_cents: 100, payment_method: 'card_online', stripe_payment_intent_id: `pi_${i}`, created_at: '2026-08-01T12:00:00Z' }));
    rows.push({ ...rows[0], id: 'duplicate', created_at: '2026-08-02T12:00:00Z' });
    rows.push({ id: 'assumed', type: 'payment', status: 'completed', amount_cents: 4500, created_at: '2026-08-01T12:00:00Z' });
    rows.push({ id: 'failed', type: 'payment', status: 'failed', amount_cents: 9000, created_at: '2026-08-01T12:00:00Z' });
    rows.push({ id: 'refund', type: 'refund', status: 'completed', amount_cents: -700, payment_method: 'card_online', created_at: '2026-08-01T12:00:00Z' });
    window.fetch = async (input, options = {}) => {
      const url = new URL(String(input), location.href);
      if (options.method && !['GET', 'HEAD'].includes(options.method)) window.__moneyWrites.push(url.pathname);
      if (/\/rest\/v1\/(transactions|expenses)$/.test(url.pathname)) {
        const tx = url.pathname.endsWith('/transactions');
        const all = tx ? rows : [{ id: 'expense', amount_cents: 600, tax_deductible: true, date: '2026-08-01', category: 'products', vendor: 'Fictional supplies' }];
        const offset = Number(url.searchParams.get('offset') || 0);
        if (tx) window.__moneyReads++;
        if (tx && offset >= 200 && window.__failMoneyPage) return new Response(JSON.stringify({ message: 'Synthetic page two failure' }), { status: 500, headers: { 'content-type': 'application/json' } });
        const data = all.slice(offset, offset + 200);
        return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', 'content-range': `${offset}-${offset + data.length - 1}/${all.length}` } });
      }
      if (url.pathname === '/api/money/reports') return new Response('{}', { status: 503 });
      if (url.pathname === '/api/exports/tax-quarterly') {
        window.__exportAuth = options.headers?.Authorization;
        window.__exportYear = url.searchParams.get('year');
        return new Response('Recorded receipts,1193.00\n', { headers: { 'content-type': 'text/csv' } });
      }
      return base(input, options);
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.clock.setFixedTime(new Date('2026-11-17T12:00:00Z'));
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/money`);
  await page.getByRole('button', { name: 'Tax', exact: true }).click();
  await page.getByText('1201 counted transactions', { exact: false }).waitFor();
  await page.getByText('£1,193.00', { exact: true }).first().waitFor();
  await page.getByText('£1,187.00', { exact: true }).first().waitFor();
  assert.ok(await page.evaluate(() => window.__moneyReads >= 7));
  assert.equal(await page.getByText('Set aside this quarter', { exact: true }).count(), 0);
  assert.equal(await page.getByText('£3.45/week', { exact: false }).count(), 0);
  await page.getByText('Show illustration and assumptions', { exact: true }).click();
  await page.getByText('Compulsory Class 2 NI', { exact: true }).waitFor();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export for Accountant', exact: true }).click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /^florrie-\d{4}-\d{2}\.csv$/);
  assert.match(await page.evaluate(() => window.__exportAuth), /^Bearer /);
  assert.equal(await page.evaluate(() => window.__exportYear), '2026-27');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  if (process.env.MONEY_AUDIT_SCREENSHOTS) {
    mkdirSync(process.env.MONEY_AUDIT_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: join(process.env.MONEY_AUDIT_SCREENSHOTS, 'tax-mobile.png'), fullPage: true });
  }
  await page.getByRole('button', { name: 'Income', exact: true }).click();
  await page.getByRole('button', { name: /Show more records/ }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__moneyWrites), []);
  assert.deepEqual(errors, []);
  // A later page failing must not expose a plausible but incomplete total.
  await page.addInitScript(() => { window.__failMoneyPage = true; });
  await page.reload();
  await page.getByText('Something went wrong loading your money data', { exact: false }).waitFor();
  assert.equal(await page.getByText('£1,193.00', { exact: true }).count(), 0);
  await page.evaluate(() => { window.__failMoneyPage = false; });
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByRole('button', { name: 'Tax', exact: true }).waitFor();
  await context.close();
  console.log('✓ Money: >1,200 records, duplicate/assumed/failed exclusions, refunds, tax illustration, authenticated export, overflow, page failure and retry; no writes.');
} finally { await browser.close(); server.close(); }
