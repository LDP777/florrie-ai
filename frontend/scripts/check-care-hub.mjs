import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import http from 'node:http';
import { launch } from './lib/browser.mjs';
import { bundleSupabaseUrl } from './lib/fixtures.mjs';
import { careFixtureSource } from './lib/care-fixtures.mjs';
const dist = new URL('../dist', import.meta.url).pathname;
const output = process.env.CARE_SCREENSHOTS;
if (output) mkdirSync(output, { recursive: true });
const server = http.createServer((req, res) => {
  let file = join(dist, req.url.split('?')[0]);
  if (!existsSync(file) || !extname(file)) file = join(dist, 'index.html');
  try { res.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' }[extname(file)] || 'application/octet-stream'); res.end(readFileSync(file)); }
  catch { res.statusCode = 404; res.end(); }
}).listen(0);
const browser = await launch();
const base = `http://127.0.0.1:${server.address().port}`;
const errors = [];
async function context(scenario = 'populated', width = 390) {
  const ctx = await browser.newContext({ viewport: { width, height: width > 700 ? 1000 : 844 } });
  await ctx.addInitScript(careFixtureSource(bundleSupabaseUrl(dist), scenario));
  const page = await ctx.newPage(); page.on('pageerror', err => errors.push(err.message));
  return { ctx, page };
}
async function capture(page, name) {
  if (output) { await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: join(output, name), fullPage: false }); }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${name} overflows`);
}
try {
  const { ctx, page } = await context();
  await page.goto(`${base}/more`);
  await page.getByRole('heading', { name: 'More', exact: true }).waitFor();
  await capture(page, 'florrie-more-mobile.png');
  await page.getByRole('searchbox', { name: 'Search More tools' }).fill('guardian');
  await page.locator('.more-items').getByRole('link', { name: /Client checks/ }).click();
  await page.getByRole('heading', { name: 'Client checks', exact: true }).waitFor();
  await page.getByText('Sarah Whitfield-Barrowman', { exact: true }).waitFor();
  await capture(page, 'florrie-client-checks-mobile.png');
  await page.getByRole('button', { name: 'Client records', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Find a client' }).fill('Sarah');
  await page.getByRole('button', { name: /Sarah Miller/ }).waitFor();
  await page.getByRole('button', { name: /Sarah Whitfield-Barrowman/ }).waitFor();
  console.log('✓ Guardian search opens care hub; same-name client choices remain distinct');
  await page.goto(`${base}/patch-tests?clientId=c1`);
  await page.getByText('You recorded this one', { exact: true }).waitFor();
  assert.equal(await page.getByText('Sarah Miller', { exact: true }).count(), 0);
  assert.equal(await page.getByText('No slot booked yet', { exact: true }).count(), 0);
  await capture(page, 'florrie-patch-tests-mobile.png');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.evaluate(() => {
    const fetch = window.fetch;
    window.fetch = (input, options) => String(input).includes('/rest/v1/beauticians') && options?.method === 'PATCH' ? Promise.resolve(new Response('{"message":"Synthetic settings failure"}', { status: 500 })) : fetch(input, options);
  });
  await page.locator('select').first().selectOption('12');
  await page.getByText('The setting was not saved.', { exact: false }).waitFor();
  assert.equal(await page.locator('select').first().inputValue(), '6');
  console.log('✓ Patch evidence stays intact and failed setting rolls back');
  await page.goto(`${base}/patch-tests`);
  await page.getByRole('button', { name: 'Ask her to book one', exact: true }).first().waitFor();
  await page.evaluate(() => {
    const fetch = window.fetch;
    window.fetch = (input, options) => {
      if (String(input).includes('/api/notifications/send-reminder')) { window.__reminderBody = JSON.parse(options.body); return Promise.resolve(new Response('{"success":false,"error":"Synthetic reminder refusal"}', { status: 200 })); }
      return fetch(input, options);
    };
  });
  await page.getByRole('button', { name: 'Ask her to book one', exact: true }).first().click();
  await page.getByText('Synthetic reminder refusal', { exact: false }).waitFor();
  assert.equal(await page.evaluate(() => window.__reminderBody.client_id), 'c2');
  assert.equal(await page.getByText('Reminder accepted ✓', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Ask her to book one', exact: true }).first().isEnabled(), true);
  console.log('✓ Refused reminder stays retryable and uses client ID');
  await page.goto(`${base}/photo-consent?clientId=c3`);
  await page.getByRole('button', { name: 'Record a request', exact: true }).click();
  await page.getByText('Sarah Whitfield-Barrowman', { exact: true }).waitFor();
  await page.getByRole('checkbox', { name: 'Portfolio', exact: true }).check();
  await page.getByRole('button', { name: 'Save request record', exact: true }).click();
  await page.getByText('Request recorded. No message has been sent', { exact: false }).waitFor();
  await page.getByRole('button', { name: /Sarah Whitfield-Barrowman/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: /Sarah Miller/ }).count(), 0);
  await capture(page, 'florrie-photo-consent-mobile.png');
  console.log('✓ Photo request selects exact client without claiming delivery');
  await ctx.close();
  const failed = await context('error');
  await failed.page.goto(`${base}/compliance`);
  await failed.page.getByText('Unavailable', { exact: true }).waitFor();
  await failed.page.getByRole('button', { name: 'Try again', exact: true }).waitFor();
  assert.equal(await failed.page.getByText('No patch-test checks in this window', { exact: true }).count(), 0);
  await failed.ctx.close();
  console.log('✓ Failed Guardian read remains unknown');
  const patchFailure = await context();
  await patchFailure.ctx.addInitScript(() => {
    const base = window.fetch;
    window.fetch = (input, options) => String(input).includes('/api/appointments/patch-test-alerts')
      ? Promise.resolve(new Response('{"error":"Synthetic alerts failure"}', { status: 503 })) : base(input, options);
  });
  await patchFailure.page.goto(`${base}/patch-tests`);
  await patchFailure.page.getByRole('button', { name: 'Alerts unavailable', exact: true }).waitFor();
  assert.equal(await patchFailure.page.getByText('No checks in this window', { exact: true }).count(), 0);
  await patchFailure.page.getByRole('button', { name: 'All records', exact: true }).click();
  await patchFailure.page.getByRole('searchbox', { name: 'Search patch-test records', exact: true }).fill('Priya');
  await patchFailure.page.getByRole('button', { name: /Priya Kapoor/ }).waitFor();
  assert.equal(await patchFailure.page.getByRole('button', { name: /Sarah Miller/ }).count(), 0);
  await patchFailure.page.getByRole('searchbox', { name: 'Search patch-test records', exact: true }).fill('no such client');
  await patchFailure.page.getByText('No patch-test records match this search.', { exact: true }).waitFor();
  await patchFailure.ctx.close();
  console.log('✓ Failed upcoming checks retain searchable patch-test evidence without a false all-clear');
  const templates = await context();
  await templates.ctx.addInitScript(() => {
    const base = window.fetch;
    window.__formAudit = { failList: true, failLoad: true, saved: null };
    window.fetch = (input, options = {}) => {
      const url = new URL(String(input), location.href);
      const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
      if (url.pathname === '/api/consultation-forms' && window.__formAudit.failList) return json({ error: 'Synthetic list failure' }, 503);
      if (url.pathname === '/api/consultation-forms/form1') {
        if (options.method === 'PATCH') { window.__formAudit.saved = JSON.parse(options.body); return json({ error: 'Synthetic save failure' }, 500); }
        return window.__formAudit.failLoad ? json({ error: 'Synthetic template failure' }, 503) : json({ form: { id: 'form1', name: 'Original template', consent_text: 'Original wording', is_default: true, consultation_form_fields: [] } });
      }
      return base(input, options);
    };
  });
  await templates.page.goto(`${base}/consultation-forms`);
  await templates.page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  assert.equal(await templates.page.getByText('No forms yet', { exact: true }).count(), 0);
  await templates.page.evaluate(() => { window.__formAudit.failList = false; });
  await templates.page.getByRole('button', { name: 'Retry', exact: true }).click();
  await templates.page.getByRole('searchbox', { name: 'Search form templates', exact: true }).fill('Brow');
  await templates.page.getByRole('button', { name: /Brow & lash consultation/ }).click();
  await templates.page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  assert.equal(await templates.page.getByRole('textbox', { name: 'Form name', exact: true }).count(), 0);
  await templates.page.evaluate(() => { window.__formAudit.failLoad = false; });
  await templates.page.getByRole('button', { name: 'Retry', exact: true }).click();
  await templates.page.getByRole('textbox', { name: 'Form name', exact: true }).fill('Changed template');
  await templates.page.getByRole('button', { name: 'Save', exact: true }).click();
  await templates.page.getByText('Synthetic save failure', { exact: true }).waitFor();
  assert.equal(await templates.page.getByRole('textbox', { name: 'Form name', exact: true }).inputValue(), 'Changed template');
  await templates.page.evaluate(() => { history.pushState({}, '', '/consultation-forms/new'); dispatchEvent(new PopStateEvent('popstate')); });
  await templates.page.waitForFunction(() => document.querySelector('[aria-label="Form name"]')?.value === '');
  assert.equal(await templates.page.getByText('Synthetic save failure', { exact: true }).count(), 0);
  await templates.ctx.close();
  console.log('✓ Template failures stay honest, Retry recovers, failed saves retain edits and New starts clean');
  const desktop = await context('populated', 1280);
  await desktop.page.goto(`${base}/more`); await desktop.page.getByRole('heading', { name: 'More', exact: true }).waitFor();
  await capture(desktop.page, 'florrie-more-desktop.png');
  await desktop.page.goto(`${base}/compliance`); await desktop.page.getByText('Sarah Whitfield-Barrowman', { exact: true }).waitFor();
  await capture(desktop.page, 'florrie-client-checks-desktop.png');
  await desktop.ctx.close(); assert.deepEqual(errors, []);
  console.log('✓ Responsive snapshots, no page errors or document overflow');
} finally { await browser.close(); server.close(); }
