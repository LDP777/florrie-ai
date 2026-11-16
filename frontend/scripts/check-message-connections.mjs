import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import http from 'node:http';
import { launch } from './lib/browser.mjs';
import { fetchStubSource, sessionSeedSource, bundleSupabaseUrl } from './lib/fixtures.mjs';
const dist = new URL('../dist', import.meta.url).pathname;
const server = http.createServer((req, res) => {
  let file = join(dist, req.url.split('?')[0]); if (!existsSync(file) || !extname(file)) file = join(dist, 'index.html');
  res.setHeader('content-type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' })[extname(file)] || 'application/octet-stream'); res.end(readFileSync(file));
}).listen(0);
const browser = await launch(), origin = `http://127.0.0.1:${server.address().port}`;
try {
  for (const mode of ['unavailable','available','connected','reconnect','disconnect-failed','status-failed']) {
    const context = await browser.newContext({ viewport: { width: mode === 'connected' ? 320 : 390, height: 844 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.addInitScript(fetchStubSource()); await context.addInitScript(sessionSeedSource(bundleSupabaseUrl(dist)));
    await context.addInitScript(mode => {
      const base = window.fetch; window.__emailWrites = [];
      let c = ['connected','reconnect','disconnect-failed'].includes(mode) ? { email: 'long-business-address@example.test', provider: 'microsoft', status: mode === 'reconnect' ? 'reconnect' : 'connected', ai_drafts: false, client_emails_only: true, last_synced_at: null } : null;
      window.fetch = async (input, options = {}) => {
        const url = String(input), path = url.split('/api/email/')[1];
        if (!path) return base(input, options);
        if (path === 'status') return Response.json(mode === 'status-failed' ? { error: 'Connection unavailable. Try again.' } : { providers: [{ id: 'google', available: mode !== 'unavailable' }, { id: 'microsoft', available: mode !== 'unavailable' }], connection: c }, { status: mode === 'status-failed' ? 503 : 200 });
        window.__emailWrites.push({ path, body: JSON.parse(options.body || '{}') });
        if (path === 'start') return Response.json({ error: 'Sign-in could not start. Try again.' }, { status: 503 });
        if (path === 'disconnect') { if (mode === 'disconnect-failed') return Response.json({ error: 'Disconnect not confirmed. Try again.' }, { status: 503 }); c = null; return Response.json({ disconnected: true }); }
        if (path === 'check') { c.last_synced_at = new Date().toISOString(); return Response.json({ imported: 1, more: false }); }
        if (path === 'preferences') { c = { ...c, ...JSON.parse(options.body) }; return Response.json({ saved: true }); }
        return Response.json({});
      };
    }, mode);
    const page = await context.newPage(); await page.goto(`${origin}/connections`);
    await page.getByRole('heading', { name: 'Your messages, together' }).waitFor();
    if (mode === 'status-failed') await page.getByRole('alert').filter({ hasText: 'Connection unavailable' }).waitFor();
    else if (mode === 'unavailable') { await page.getByText('Email sign-in is awaiting provider setup and approval.', { exact: false }).waitFor(); assert.equal(await page.getByRole('button', { name: 'Connect Gmail', exact: true }).isEnabled(), false); }
    else if (['available','reconnect'].includes(mode)) {
      await page.getByRole('button', { name: mode === 'available' ? 'Connect Gmail' : 'Reconnect Outlook / Hotmail', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Sign-in could not start' }).waitFor();
      assert.equal((await page.evaluate(() => window.__emailWrites))[0].body.ai_drafts, false);
    } else {
      await page.getByRole('button', { name: 'Check inbox now', exact: true }).click(); await page.getByRole('status').filter({ hasText: '1 new email added' }).waitFor();
      await page.getByLabel('Let Florrie prepare draft replies', { exact: false }).check(); await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'preferences saved' }).waitFor();
      if (mode === 'connected' && process.env.CONNECTIONS_SCREENSHOT) await page.screenshot({ path: process.env.CONNECTIONS_SCREENSHOT, fullPage: true });
      await page.getByRole('button', { name: 'Disconnect email', exact: true }).click();
      assert.equal((await page.evaluate(() => window.__emailWrites.filter(w => w.path === 'disconnect'))).length, 0, 'first click only opens confirmation');
      await page.getByRole('button', { name: 'Disconnect email', exact: true }).click();
      if (mode === 'disconnect-failed') { await page.getByRole('alert').filter({ hasText: 'Disconnect not confirmed' }).waitFor(); assert.equal(await page.getByText('long-business-address@example.test', { exact: true }).count(), 1); }
      else await page.getByRole('status').filter({ hasText: 'Email disconnected' }).waitFor();
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, mode + ' fits the screen');
    assert.equal(await page.getByText('Something went wrong', { exact: true }).count(), 0);
    console.log('PASS message connections: ' + mode); await context.close();
  }
} finally { await browser.close(); server.close(); }
