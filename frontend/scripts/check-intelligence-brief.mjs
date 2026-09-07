// Isolated interaction checks; all external requests are blocked.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import http from 'node:http';
import { launch } from './lib/browser.mjs';
import { fetchStubSource, sessionSeedSource, bundleSupabaseUrl } from './lib/fixtures.mjs';
const dist = new URL('../dist', import.meta.url).pathname;
const server = http.createServer((req, res) => {
  let file = join(dist, (req.url || '/').split('?')[0]);
  if (!existsSync(file) || !extname(file)) file = join(dist, 'index.html');
  res.setHeader('content-type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[extname(file)] || 'application/octet-stream');
  try { res.end(readFileSync(file)); } catch { res.statusCode = 404; res.end(); }
}).listen(0);
const browser = await launch();
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await context.addInitScript(fetchStubSource());
  await context.addInitScript(sessionSeedSource(bundleSupabaseUrl(dist)));
  await context.addInitScript(() => {
    const base = window.fetch;
    const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }));
    window.__brief = { failDismiss: true, voices: 0 };
    window.fetch = (input, options = {}) => {
      const url = String(input);
      if (url.includes('/api/agents/brief')) return json({
        checked_at: '2026-09-07T21:30:00Z', partial: true,
        permissions: { auto_reply_enabled: false },
        activity: { completed: 12, failed: 1, pending_approval: null },
        learning: { human_samples: 77, saved_corrections: 2, client_profiles: 28, updated_at: '2026-09-07T21:00:00Z' },
        insights_available: true,
        insights: [{ id: 'pair', title: 'Two treatments clients book together', summary: 'Brows and lashes appeared together in 4 client visits.', evidence: 'Same client, same day', link_to: '/treatments', action_label: 'Review treatments' }],
        agents: [{ id: 'front_desk', name: 'Front Desk', statusLine: 'Latest action awaits review', actionsThisWeek: 4, checks: [{ name: 'reminders', state: 'unknown', last_success_at: null }], link_to: '/inbox' }],
      });
      if (url.includes('/api/florrie-thinks')) return json({ cards: [{ id: 'test-lead', type: 'lead', summary: 'A client reply is ready for your review.', action_label: 'Open thread', link_to: '/inbox?client=fixture', evidence: { label: 'Asked this morning', link_to: '/inbox?client=fixture' } }] });
      if (url.includes('/api/suggestions/respond')) return window.__brief.failDismiss ? json({ error: 'Offline' }, 503) : json({ ok: true });
      if (url.includes('/api/voice/') && options.method === 'POST') window.__brief.voices++;
      return base(input, options);
    };
  });
  const page = await context.newPage();
  const failures = []; page.on('pageerror', error => failures.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/insights`);
  await page.getByText('Automatic replies are off.', { exact: false }).waitFor();
  await page.getByText('Some sources could not be checked.', { exact: false }).waitFor();
  await page.getByText('A client reply is ready for your review.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Not now', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Could not save that choice' }).waitFor();
  assert.equal(await page.getByText('A client reply is ready for your review.', { exact: true }).count(), 1);
  await page.evaluate(() => window.__brief.failDismiss = false);
  await page.getByRole('button', { name: 'Not now', exact: true }).click();
  await page.getByText('No priorities found', { exact: false }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Insights fits a phone');
  await page.getByText('Background checks', { exact: true }).click();
  await page.getByText('Not recorded yet', { exact: true }).waitFor();
  if (process.env.INSIGHTS_SCREENSHOTS) {
    await page.evaluate(() => document.getElementById('app-scroll')?.scrollTo(0, 0));
    mkdirSync(process.env.INSIGHTS_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: join(process.env.INSIGHTS_SCREENSHOTS, 'insights-phone.png'), fullPage: true });
    await page.setViewportSize({ width: 1200, height: 1000 });
    await page.screenshot({ path: join(process.env.INSIGHTS_SCREENSHOTS, 'insights-desktop.png'), fullPage: true });
  }
  await page.getByRole('button', { name: 'Talk it through with Florrie', exact: true }).click();
  await page.waitForURL('**/voice');
  await page.locator('textarea,input').filter({ visible: true }).first().waitFor();
  const values = await page.locator('textarea,input').evaluateAll(nodes => nodes.map(n => n.value));
  assert.ok(values.some(v => v.includes('Read my Florrie brief')), 'Voice receives an editable draft');
  assert.equal(await page.evaluate(() => window.__brief.voices), 0, 'No voice command submits itself');
  assert.deepEqual(failures, []);
  await context.close();
  console.log('✓ Insights: partial evidence, permission visibility, dismissal failure/retry, phone layout, and editable voice handoff');
} finally { await browser.close(); server.close(); }
