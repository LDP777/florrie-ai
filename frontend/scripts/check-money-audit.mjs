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
    window.__moneyReads = 0; window.__moneyWrites = []; window.__failMoneyPage = localStorage.getItem('money-fail') === 'true';
    const rows = Array.from({ length: 1200 }, (_, i) => ({ id: `r${i}`, type: 'deposit', status: 'completed', amount_cents: 100, payment_method: 'card_online', stripe_payment_intent_id: `pi_${i}`, created_at: '2026-08-01T12:00:00Z' }));
    rows.push({ ...rows[0], id: 'duplicate', created_at: '2026-08-02T12:00:00Z' });
    rows.push({ id: 'assumed', type: 'payment', status: 'completed', amount_cents: 4500, created_at: '2026-08-01T12:00:00Z' });
    rows.push({ id: 'failed', type: 'payment', status: 'failed', amount_cents: 9000, created_at: '2026-08-01T12:00:00Z' });
    rows.push({ id: 'refund', type: 'refund', status: 'completed', amount_cents: -700, payment_method: 'card_online', created_at: '2026-08-01T12:00:00Z' });
    const costs = [{ id: 'expense', amount_cents: 600, tax_deductible: true, date: '2026-08-01', category: 'products', vendor: 'Fictional supplies' }];
    if (localStorage.getItem('money-fixture') === 'history') rows.push({ id: 'past', type: 'payment', status: 'completed', payment_method: 'cash', amount_cents: 100000000, created_at: '2025-08-01T12:00:00Z' });
    if (localStorage.getItem('money-fixture') === 'empty') { rows.length = 0; costs.length = 0; }
    window.__moneyRows = rows; window.__moneyCosts = costs;
    window.fetch = async (input, options = {}) => {
      const url = new URL(String(input), location.href);
      if (options.method && !['GET', 'HEAD'].includes(options.method)) window.__moneyWrites.push(url.pathname);
      if (/\/rest\/v1\/(transactions|expenses)$/.test(url.pathname)) {
        const tx = url.pathname.endsWith('/transactions');
        const all = tx ? rows : costs;
        if (options.method === 'POST') {
          {
            const row = JSON.parse(options.body);
            if (!window.__allowMoneyWrites || row.beautician_id !== 'b1') throw Error('Unexpected money write');
            const existing = all.find(r => r.id === row.id);
            if (existing) return new Response('{"code":"23505"}', { status: 409, headers: { 'content-type': 'application/json' } });
            const saved = { ...row, created_at: '2026-11-17T12:00:00Z' }; all.unshift(saved);
            if (window.__loseMoneyResponse) { window.__loseMoneyResponse = false; throw Error('Response lost after save'); }
            await new Promise(resolve => setTimeout(resolve, 100));
            return new Response(JSON.stringify(saved), { status: 201, headers: { 'content-type': 'application/json' } });
          }
        }
        if (url.searchParams.has('id')) {
          const row = all.find(r => r.id === url.searchParams.get('id').replace('eq.', '') && r.beautician_id === url.searchParams.get('beautician_id')?.replace('eq.', ''));
          return new Response(JSON.stringify(row || null), { headers: { 'content-type': 'application/json' } });
        }
        const offset = Number(url.searchParams.get('offset') || 0);
        if (tx) window.__moneyReads++;
        if (tx && offset >= 200 && window.__failMoneyPage) return new Response(JSON.stringify({ message: 'Synthetic page two failure' }), { status: 500, headers: { 'content-type': 'application/json' } });
        const data = all.slice(offset, offset + 200);
        return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', 'content-range': `${offset}-${offset + data.length - 1}/${all.length}` } });
      }
      if (url.pathname === '/api/money/ledger' && window.__failLedger) return new Response('{}', { status: 503 });
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
  await page.getByRole('region', { name: 'Tax year figures' }).waitFor();
  assert.equal(await page.getByText('Recorded receipts today', { exact: true }).count(), 0);
  assert.equal(await page.locator('[aria-label="Tax summary"] details[open]').count(), 0);
  assert.ok((await page.getByRole('region', { name: 'Tax summary' }).innerText()).split(/\s+/).length < 100, 'Tax starts with a compact summary');
  if (process.env.MONEY_AUDIT_SCREENSHOTS) {
    mkdirSync(process.env.MONEY_AUDIT_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: join(process.env.MONEY_AUDIT_SCREENSHOTS, 'tax-compact-mobile.png'), fullPage: true, animations: 'disabled' });
    await page.setViewportSize({ width: 320, height: 750 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: join(process.env.MONEY_AUDIT_SCREENSHOTS, 'tax-compact-small.png'), fullPage: true, animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByText('What’s included?', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(process.env.MONEY_AUDIT_SCREENSHOTS, 'tax-compact-details.png'), animations: 'disabled' });
  }
  await page.getByText('What’s included?', { exact: true }).click();
  await page.getByText('1201 counted transactions', { exact: false }).waitFor();
  await page.getByText('£1,193.00', { exact: true }).first().waitFor();
  await page.getByText('£1,187.00', { exact: true }).first().waitFor();
  assert.ok(await page.evaluate(() => window.__moneyReads >= 7));
  assert.equal(await page.getByText('Set aside this quarter', { exact: true }).count(), 0);
  assert.equal(await page.getByText('£3.45/week', { exact: false }).count(), 0);
  await page.getByText('Tax estimate', { exact: true }).click();
  await page.getByText('How the estimate works', { exact: true }).click();
  await page.getByText('Class 2 is not compulsory', { exact: false }).waitFor();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export for Accountant', exact: true }).click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /^florrie-\d{4}-\d{2}\.csv$/);
  assert.match(await page.evaluate(() => window.__exportAuth), /^Bearer /);
  assert.equal(await page.evaluate(() => window.__exportYear), '2026-27');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  if (process.env.MONEY_AUDIT_SCREENSHOTS) {
    mkdirSync(process.env.MONEY_AUDIT_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: join(process.env.MONEY_AUDIT_SCREENSHOTS, 'tax-mobile.png'), fullPage: true, animations: 'disabled' });
  }
  await page.getByRole('button', { name: 'Income', exact: true }).click();
  await page.getByRole('button', { name: /Show more records/ }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__moneyWrites), []);
  assert.deepEqual(errors, []);
  // A later page failing must not expose a plausible but incomplete total.
  await page.evaluate(() => { localStorage.setItem('money-fail', 'true'); });
  await page.reload();
  await page.getByText('Something went wrong loading your money data', { exact: false }).waitFor();
  assert.equal(await page.getByText('£1,193.00', { exact: true }).count(), 0);
  await page.evaluate(() => { window.__failMoneyPage = false; localStorage.removeItem('money-fail'); });
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByRole('button', { name: 'Tax', exact: true }).waitFor();
  // Retries and manual entries run only against this in-memory salon.
  await page.evaluate(() => { window.__allowMoneyWrites = true; });
  await page.getByRole('button', { name: 'Pulse', exact: true }).click();
  await page.getByText('+ log tip', { exact: true }).click();
  await page.getByPlaceholder('Amount (£)', { exact: true }).fill('-5');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Enter a positive amount' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__moneyWrites), []);
  await page.getByPlaceholder('Amount (£)', { exact: true }).fill('5');
  await page.getByRole('button', { name: 'Save', exact: true }).evaluate(b => { b.click(); b.click(); });
  await page.getByRole('status').filter({ hasText: 'Tip saved' }).waitFor();
  assert.equal(await page.evaluate(() => window.__moneyRows.filter(t => t.type === 'tip').length), 1);
  await page.getByText('Tips', { exact: true }).locator('..').getByText('£5', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Tax', exact: true }).click();
  await page.getByRole('region', { name: 'Tax year figures' }).getByText('£1,192.00', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Expenses', exact: true }).click();
  await page.getByRole('button', { name: 'Add Expense', exact: true }).click();
  await page.getByPlaceholder('0.00', { exact: true }).fill('2.50');
  await page.getByPlaceholder('e.g. Sally Beauty', { exact: true }).fill('Fictional brushes');
  await page.getByRole('button', { name: 'Save Expense', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Expense saved' }).waitFor();
  await page.getByRole('button', { name: 'Tax', exact: true }).click();
  await page.getByRole('region', { name: 'Tax year figures' }).getByText('£1,189.50', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Pulse', exact: true }).click();
  await page.getByText('+ log sale', { exact: true }).click();
  await page.getByPlaceholder('Amount (£)', { exact: true }).fill('12.50');
  await page.getByPlaceholder('Product name (optional)', { exact: true }).fill('Fictional aftercare');
  await page.evaluate(() => { window.__loseMoneyResponse = true; });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Response lost' }).waitFor();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Product sale saved' }).waitFor();
  assert.equal(await page.evaluate(() => window.__moneyRows.filter(t => t.type === 'product_sale').length), 1);
  await page.getByRole('button', { name: 'Tax', exact: true }).click();
  await page.getByRole('region', { name: 'Tax year figures' }).getByText('£1,202.00', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Hide client details', exact: true }).click();
  assert.doesNotMatch(await page.getByRole('region', { name: 'Tax summary' }).innerText(), /£[0-9,]+\.[0-9]{2}/);
  assert.equal(await page.getByRole('button', { name: 'Export for Accountant', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Hide client details', exact: true }).click();
  await page.getByText('Cash & bank receipts', { exact: true }).click();
  await page.getByRole('button', { name: 'Review payments', exact: true }).click();
  assert.equal(await page.getByLabel('Income records').inputValue(), 'review');
  assert.equal(await page.getByRole('button', { name: /Show more records/ }).count(), 0);
  await page.getByRole('button', { name: 'Ledger', exact: true }).click();
  await page.getByText('Recorded net total', { exact: true }).waitFor();
  await page.evaluate(() => { window.__failLedger = true; });
  await page.getByRole('button', { name: 'Expenses', exact: true }).last().click();
  await page.getByRole('button', { name: 'Try records again', exact: true }).waitFor();
  assert.equal(await page.getByText('Recorded net total', { exact: true }).count(), 0);
  await page.evaluate(() => { window.__failLedger = false; });
  await page.getByRole('button', { name: 'Try records again', exact: true }).click();
  await page.getByText('Recorded net total', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Tax', exact: true }).click();
  // Historical selection must affect the figures AND export, including zero/large states.
  await page.evaluate(() => { localStorage.setItem('money-fixture', 'history'); });
  await page.reload();
  await page.getByLabel('Tax year', { exact: true }).selectOption('2025-26');
  await page.getByRole('region', { name: 'Tax year figures' }).getByText('£1,000,000.00', { exact: true }).first().waitFor();
  await page.setViewportSize({ width: 320, height: 750 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  const historicExport = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export for Accountant', exact: true }).click();
  assert.equal((await historicExport).suggestedFilename(), 'florrie-2025-26.csv');
  assert.equal(await page.evaluate(() => window.__exportYear), '2025-26');
  await page.evaluate(() => { localStorage.setItem('money-fixture', 'empty'); });
  await page.reload();
  await page.getByRole('region', { name: 'Tax year figures' }).getByText('£0.00', { exact: true }).first().waitFor();
  await page.getByText('Money received by month', { exact: true }).click();
  await page.getByText('No payments recorded in this year.', { exact: true }).waitFor();
  await page.getByText('VAT & business setup', { exact: true }).click();
  await page.getByRole('button', { name: 'Update VAT settings', exact: true }).click();
  assert.match(page.url(), /settings\?section=profile$/);
  await page.getByText('Tax profile', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  await context.close();
  console.log('✓ Money: >1,200 records, duplicate/assumed/failed exclusions, refunds, tax illustration, authenticated export, overflow, page failure and retry; compact Tax, live totals after manual entries, duplicate-tap/lost-response protection, privacy, review filter, ledger retry and settings link. No live services.');
} finally { await browser.close(); server.close(); }
