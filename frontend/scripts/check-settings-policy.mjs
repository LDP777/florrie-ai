import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import http from 'node:http';
import { launch } from './lib/browser.mjs';
import { bundleSupabaseUrl, fetchStubSource, sessionSeedSource } from './lib/fixtures.mjs';

const dist = new URL('../dist', import.meta.url).pathname;
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };
const server = http.createServer((request, response) => {
  let file = join(dist, (request.url || '/').split('?')[0]);
  if (!existsSync(file) || !extname(file)) file = join(dist, 'index.html');
  try { response.setHeader('content-type', mime[extname(file)] || 'application/octet-stream'); response.end(readFileSync(file)); }
  catch { response.statusCode = 404; response.end(); }
}).listen(0);
const browser = await launch();
const note = 'Please give 48 hours notice.\nLate cancellations and no-shows are charged at the full treatment price.';
const initialPolicy = { cancellation_notice_hours: 48, late_cancel_charge_percent: 0, no_show_charge_percent: 100,
  cancellation_message: note, reschedule_once: true, min_booking_hours: 2, max_advance_days: 60 };

async function fixture(policy) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript(fetchStubSource());
  await context.addInitScript(sessionSeedSource(bundleSupabaseUrl(dist)));
  await context.addInitScript(policy => {
    const base = window.fetch;
    window.__policyWrites = [];
    window.__profile = { id: 'b1', auth_id: 'b1', email: 'owner@fictional-salon.test', first_name: 'Mara',
      last_name: 'Demo', business_name: 'Fictional Salon', timezone: 'Europe/London',
      onboarding_completed_at: '2026-06-01T10:00:00Z', trial_ends_at: '2099-01-01T00:00:00Z', plan: 'pro',
      stripe_onboarding_complete: true, payment_settings: { require_deposit: false }, booking_policy: policy };
    const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    window.fetch = async (input, options = {}) => {
      const url = typeof input === 'string' ? input : input?.url || '';
      const method = String(options.method || input?.method || 'GET').toUpperCase();
      if (url.includes('/rest/v1/beauticians')) {
        if (method === 'PATCH') {
          const body = JSON.parse(options.body);
          window.__policyWrites.push(body);
          Object.assign(window.__profile, body);
          return json(window.__profile);
        }
        return json(window.__profile);
      }
      return base(input, options);
    };
  }, policy);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/settings?section=policy`);
  await page.getByRole('slider', { name: /late.cancel/i }).waitFor();
  return { context, page, pageErrors };
}

try {
  const { context, page, pageErrors } = await fixture(initialPolicy);
  const lateFee = page.getByRole('slider', { name: /late.cancel/i });
  const noShowFee = page.getByText('No-show charge', { exact: true }).locator('xpath=following-sibling::div[1]').getByRole('slider');
  const noteField = page.getByRole('textbox', { name: /cancellation note/i });
  assert.equal(await lateFee.inputValue(), '0');
  assert.equal(await noShowFee.inputValue(), '100');
  assert.equal(await noteField.inputValue(), note);
  assert.equal(await page.getByText('No charge applies for late cancellations.', { exact: false }).count(), 0);
  assert.equal(await page.getByText('You always confirm each charge yourself before any money is taken.', { exact: false }).count(), 0);
  const notePreview = page.locator('p').filter({ hasText: 'Late cancellations and no-shows are charged at the full treatment price.' });
  await notePreview.waitFor();
  assert.ok((await notePreview.textContent()).includes(note));
  assert.ok(['pre-wrap', 'pre-line', 'break-spaces'].includes(await notePreview.evaluate(element => getComputedStyle(element).whiteSpace)), 'Preview must preserve the salon’s line breaks');
  assert.deepEqual(await page.evaluate(() => window.__policyWrites), [], 'Opening Settings must not change the fee or policy');

  await noteField.focus();
  const review = page.getByRole('button', { name: /review.*(?:late.cancel|fee)/i });
  await review.click();
  assert.equal(await lateFee.evaluate(element => document.activeElement === element), true, 'Review must focus the real fee control');
  assert.equal(await lateFee.inputValue(), '0');
  assert.deepEqual(await page.evaluate(() => window.__policyWrites), [], 'Reviewing or leaving an unchanged note must not save');
  const bounds = await lateFee.boundingBox();
  assert.ok(bounds && bounds.y >= 0 && bounds.y < 844, 'Reviewed fee control should be in the mobile viewport');

  if (process.env.FLORRIE_VISUAL_OUT) {
    mkdirSync(process.env.FLORRIE_VISUAL_OUT, { recursive: true });
    await notePreview.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(process.env.FLORRIE_VISUAL_OUT, 'settings-policy-note-mobile.png') });
    await review.click();
  }

  // One deliberate keyboard step is an explicit change to the numeric rule.
  await lateFee.press('ArrowRight');
  await page.waitForFunction(() => window.__policyWrites.length === 1 && window.__profile.booking_policy.late_cancel_charge_percent === 10);
  assert.deepEqual(await page.evaluate(() => window.__policyWrites), [{ booking_policy: { ...initialPolicy, late_cancel_charge_percent: 10 } }]);
  await page.getByText('Late cancellations within this window may be charged 10% of the appointment value.', { exact: false }).waitFor();
  assert.equal(await noShowFee.inputValue(), '100');
  assert.equal(await noteField.inputValue(), note);
  const editedNote = `${note}\nPlease contact the salon if you need help.`;
  await noteField.fill(editedNote);
  await review.click();
  await page.waitForFunction(() => window.__policyWrites.length === 2);
  assert.deepEqual(await page.evaluate(() => window.__policyWrites[1]), {
    booking_policy: { ...initialPolicy, late_cancel_charge_percent: 10, cancellation_message: editedNote },
  });
  assert.equal(await lateFee.inputValue(), '10');
  assert.equal(await noShowFee.inputValue(), '100');
  assert.deepEqual(pageErrors, []);
  await context.close();
  console.log('✓ Mobile policy: written terms stay visible; zero does not promise free cancellation; review only focuses; one deliberate edit saves the correct policy');

  const missingPolicy = { ...initialPolicy };
  delete missingPolicy.late_cancel_charge_percent;
  const fallback = await fixture(missingPolicy);
  assert.equal(await fallback.page.getByRole('slider', { name: /late.cancel/i }).inputValue(), '0', 'An unset fee must match the backend’s zero default');
  assert.deepEqual(await fallback.page.evaluate(() => window.__policyWrites), []);
  assert.equal(await fallback.page.getByText('No charge applies for late cancellations.', { exact: false }).count(), 0);
  assert.deepEqual(fallback.pageErrors, []);
  await fallback.context.close();
  console.log('✓ Unset late-cancellation fee displays zero without silently saving a new policy');
} finally {
  await browser.close();
  server.close();
}
