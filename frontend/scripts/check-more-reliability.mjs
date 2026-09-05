import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
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
}).listen(0);
const browser = await launch();
try {
  for (const [route, table, message] of [
    ['/vouchers', 'gift_vouchers', 'Could not load vouchers.'],
    ['/memberships', 'client_memberships', 'Could not load memberships.'],
    ['/end-of-day', 'transactions', 'Could not load today’s cash-up.'],
    ['/rebook', 'clients', 'Could not load rebooking history.'],
    ['/analytics', 'appointments', 'Could not load your analytics.'],
    ['/expenses', 'expenses', 'Could not load expenses and budgets.'],
    ['/cancellations', 'appointments', 'Could not load cancellations.'],
    ['/campaigns', 'campaigns', 'Could not load campaigns.'],
    ['/reviews', 'reviews', 'Could not load feedback.'],
    ['/addons', 'add_ons', 'Could not load add-ons and treatments.'],
    ['/treatments', 'treatments', 'Could not load treatments.'],
    ['/treatments', '/api/consultation-forms', 'Could not load consultation forms.'],
    ['/money', 'expenses', 'Something went wrong loading your money data'],
    ['/deposits', '/api/appointments/deposits', 'Could not load deposits.'],
  ]) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addInitScript(fetchStubSource());
    await ctx.addInitScript(sessionSeedSource(bundleSupabaseUrl(dist)));
    await ctx.addInitScript(table => {
      const base = window.fetch;
      window.__failMoreRead = true;
      window.fetch = (url, opts) => {
        if (window.__failMoreRead && String(url).includes(table.startsWith('/api/') ? table : `/rest/v1/${table}?`)) {
          return Promise.resolve(new Response(JSON.stringify({ message: 'Synthetic read failure', code: 'XX000' }), { status: 500, headers: { 'Content-Type': 'application/json' } }));
        }
        return base(url, opts);
      };
    }, table);
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}${route}`);
    await page.getByText(message, { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Close day', exact: true }).count(), 0);
    await page.evaluate(() => { window.__failMoreRead = false; });
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await page.getByText(message, { exact: false }).waitFor({ state: 'hidden' });
    await ctx.close();
    console.log(`✓ ${route}: read failure stays visible, retry recovers`);
  }
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(fetchStubSource());
  await ctx.addInitScript(sessionSeedSource(bundleSupabaseUrl(dist)));
  await ctx.addInitScript(() => {
    const base = window.fetch;
    window.fetch = (url, opts) => {
      if (String(url).includes('/rest/v1/gift_vouchers') && opts?.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({ message: 'Synthetic write failure' }), { status: 500, headers: { 'Content-Type': 'application/json' } }));
      }
      return base(url, opts);
    };
  });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/vouchers`);
  await page.getByRole('button', { name: '+ Create Voucher', exact: true }).click();
  await page.getByPlaceholder("Who's buying?").fill('Test buyer');
  await page.getByPlaceholder("Who's it for?").fill('Test recipient');
  await page.getByRole('button', { name: 'Create voucher', exact: true }).click();
  await page.getByText('Could not create this voucher.', { exact: false }).waitFor();
  assert.equal(await page.getByPlaceholder("Who's buying?").inputValue(), 'Test buyer');
  assert.equal(await page.getByRole('button', { name: 'Create voucher', exact: true }).isEnabled(), true);
  await ctx.close();
  console.log('✓ /vouchers: failed insert preserves form and does not show an active voucher');
} finally { await browser.close(); server.close(); }
