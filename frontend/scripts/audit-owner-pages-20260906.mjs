// Synthetic regressions for the owner launch audit. No live API traffic is allowed.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import http from 'node:http';
import { launch } from './lib/browser.mjs';
import { fetchStubSource, sessionSeedSource, bundleSupabaseUrl } from './lib/fixtures.mjs';
const dist = process.env.AUDIT_DIST || new URL('../dist', import.meta.url).pathname;
const server = http.createServer((req, res) => {
  let file = join(dist, (req.url || '/').split('?')[0]);
  if (!existsSync(file) || !extname(file)) file = join(dist, 'index.html');
  res.setHeader('content-type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[extname(file)] || 'application/octet-stream');
  try { res.end(readFileSync(file)); } catch { res.statusCode = 404; res.end(); }
}).listen(0);
const browser = await launch();
try {
  for (const mode of ['aftercare', 'price-list', 'inbox', 'hours']) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await ctx.addInitScript(fetchStubSource());
    await ctx.addInitScript(sessionSeedSource(bundleSupabaseUrl(dist)));
    await ctx.addInitScript(mode => {
      const base = window.fetch;
      window.__rejected = []; window.__allowWrite = false; window.__saved = [];
      const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
      window.fetch = (input, opts = {}) => {
        const url = String(input);
        const isCard = url.includes('/rest/v1/aftercare_cards');
        const isHours = url.includes('/rest/v1/hours_exceptions');
        const isClient = url.includes('/rest/v1/clients');
        if ((isCard && opts.method === 'POST') || (isClient && opts.method === 'PATCH') || (isHours && ['POST', 'DELETE'].includes(opts.method))) {
          if (!window.__allowWrite) { window.__rejected.push(url); return json({ message: 'Synthetic rejected write' }, 500); }
          if (opts.method === 'DELETE') { const deleted = window.__saved.map(row => ({ id: row.id })); window.__saved = []; return json(deleted); }
          const row = { id: isClient ? 'audit-client' : 'audit-saved', ...JSON.parse(opts.body) };
          window.__saved.push(row);
          return json(row);
        }
        if (isHours || isCard) return json(window.__saved);
        if (mode === 'price-list' && url.includes('/rest/v1/treatments')) return json([
          { id: 'audit1', name: 'Audit fractional brow', category: 'brows', price_cents: 1250, duration_minutes: 30 },
          { id: 'audit2', name: 'Audit imported lash', category: 'Lashes', price_cents: 2000, duration_minutes: 30 },
          { id: 'audit3', name: 'Audit custom treatment', category: 'Massage', price_cents: 3025, duration_minutes: 45 },
        ]);
        if (url.includes('/api/inbox/thread/')) return json({ client: { id: 'audit-client', first_name: 'Audit', last_name: 'Client', messaging_autonomy: null, phone: '+447700900123' }, messages: [], drafts: [], meta: null, default_channel: 'sms' });
        if (url.includes('/api/inbox')) return json({ threads: [], conversations: [], counts: {} });
        return base(input, opts);
      };
    }, mode);
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/${mode}${mode === 'inbox' ? '?client=audit-client' : ''}`);
    if (mode === 'aftercare') {
      await page.getByRole('button', { name: '+ New Care Card', exact: true }).click();
      await page.getByPlaceholder('e.g. Lash Lift & Tint').fill('Audit care card');
      await page.getByPlaceholder('e.g. First 24 hours').fill('Day one');
      await page.getByPlaceholder('What the client should do...').fill('Synthetic instructions');
      await page.getByRole('button', { name: 'Save Card', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Could not save this care card' }).waitFor();
      assert.equal(await page.getByPlaceholder('e.g. Lash Lift & Tint').inputValue(), 'Audit care card');
      assert.equal(await page.getByText('Audit care card', { exact: true }).count(), 0);
      await page.evaluate(() => { window.__allowWrite = true; });
      await page.getByRole('button', { name: 'Save Card', exact: true }).click();
      await page.getByText('Audit care card', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__saved[0].auto_send), false);
      await page.getByText('Automatic sending is not connected', { exact: false }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Enable', exact: true }).count(), 0);
      console.log('PASS: aftercare rejects without losing input; retry saves guidance without activating sending');
    } else if (mode === 'price-list') {
      await page.getByText('Audit fractional brow', { exact: true }).waitFor();
      await page.getByText('Audit imported lash', { exact: true }).waitFor();
      await page.getByText('Audit custom treatment', { exact: true }).waitFor();
      assert.equal(await page.getByText('£12.50', { exact: true }).count(), 1);
      assert.equal(await page.getByText('£30.25', { exact: true }).count(), 1);
      console.log('PASS: price list preserves exact pence, imported and custom categories');
    } else if (mode === 'inbox') {
      await page.getByRole('tab', { name: 'Me', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Could not save this preference' }).waitFor();
      assert.equal(await page.getByRole('tab', { name: 'Me', exact: true }).getAttribute('aria-selected'), 'false');
      assert.equal(await page.getByText(/You've taken over/).count(), 0);
      await page.evaluate(() => { window.__allowWrite = true; });
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      await page.getByText(/You've taken over/).waitFor();
      assert.equal(await page.getByRole('tab', { name: 'Me', exact: true }).getAttribute('aria-selected'), 'true');
      console.log('PASS: Inbox takeover stays unchanged after rejected write and confirms retry');
    } else {
      const day = new Date(); day.setDate(day.getDate() + 2);
      const dayKey = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
      await page.getByRole('button', { name: dayKey, exact: true }).click();
      await page.getByPlaceholder('Note (optional - e.g. Tenerife ☀️)').fill('Audit holiday');
      await page.getByRole('button', { name: 'Block this day', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Could not save this change' }).waitFor();
      assert.equal(await page.getByPlaceholder('Note (optional - e.g. Tenerife ☀️)').inputValue(), 'Audit holiday');
      await page.getByText('Coming up (0)', { exact: true }).waitFor();
      await page.evaluate(() => { window.__allowWrite = true; });
      await page.getByRole('button', { name: 'Block this day', exact: true }).click();
      await page.getByText('Coming up (1)', { exact: true }).waitFor();
      await page.evaluate(() => { window.__allowWrite = false; });
      await page.getByRole('button', { name: /^Remove / }).click();
      await page.getByRole('alert').filter({ hasText: 'Could not remove this change' }).waitFor();
      await page.getByText('Coming up (1)', { exact: true }).waitFor();
      await page.evaluate(() => { window.__allowWrite = true; });
      await page.getByRole('button', { name: /^Remove / }).click();
      await page.getByText('Coming up (0)', { exact: true }).waitFor();
      console.log('PASS: availability create/delete failures preserve real state; retries confirm changes');
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `${mode} must fit mobile width`);
    await ctx.close();
  }
  for (const [route, table, message] of [
    ['/hours', 'hours_exceptions', 'Could not load your availability.'],
    ['/aftercare', 'aftercare_cards', 'Could not load your care cards.'],
  ]) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await ctx.addInitScript(fetchStubSource());
    await ctx.addInitScript(sessionSeedSource(bundleSupabaseUrl(dist)));
    await ctx.addInitScript(table => {
      const base = window.fetch; window.__failRead = true;
      window.fetch = (input, opts) => window.__failRead && String(input).includes(`/rest/v1/${table}`)
        ? Promise.resolve(new Response(JSON.stringify({ message: 'Synthetic read failure' }), { status: 500, headers: { 'content-type': 'application/json' } }))
        : base(input, opts);
    }, table);
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}${route}`);
    await page.getByText(message, { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: '+ New Care Card', exact: true }).count(), 0);
    await page.evaluate(() => { window.__failRead = false; });
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await page.getByText(message, { exact: false }).waitFor({ state: 'hidden' });
    console.log(`PASS: ${route} load failure stays distinct from empty data; retry recovers`);
    await ctx.close();
  }

} finally { await browser.close(); server.close(); }
