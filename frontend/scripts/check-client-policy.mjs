import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import http from 'node:http';
import { launch } from './lib/browser.mjs';
import { bundleSupabaseUrl, fetchStubSource, sessionSeedSource } from './lib/fixtures.mjs';

const dist = new URL('../dist', import.meta.url).pathname;
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer((request, response) => {
  let file = join(dist, (request.url || '/').split('?')[0]);
  if (!existsSync(file) || !extname(file)) file = join(dist, 'index.html');
  try { response.setHeader('content-type', mime[extname(file)] || 'application/octet-stream'); response.end(readFileSync(file)); }
  catch { response.statusCode = 404; response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await launch();
const screenshots = process.env.FLORRIE_VISUAL_OUT;
if (screenshots) mkdirSync(screenshots, { recursive: true });

async function fixture({ bookingPolicy, currentPolicy = bookingPolicy, pagePath = '/book/policy-demo/manage/synthetic-token' }) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  // All app reads below are synthetic. Block any real remote traffic as well.
  await context.route('**/*', route => new URL(route.request().url()).origin === origin && route.request().method() === 'GET'
    ? route.continue() : route.abort());
  await context.addInitScript(fetchStubSource());
  await context.addInitScript(sessionSeedSource(bundleSupabaseUrl(dist)));
  await context.addInitScript(({ bookingPolicy, currentPolicy }) => {
    const base = window.fetch;
    window.__policyRequests = [];
    window.__blockedPolicyWrites = [];
    const profile = { id: 'b1', auth_id: 'b1', email: 'owner@fictional-salon.test', first_name: 'Mara',
      business_name: 'Fictional Salon', timezone: 'Europe/London', booking_slug: 'policy-demo',
      onboarding_completed_at: '2026-06-01T10:00:00Z', trial_ends_at: '2099-01-01T00:00:00Z', plan: 'pro',
      stripe_onboarding_complete: true, payment_settings: { require_deposit: false }, booking_policy: currentPolicy };
    const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), {
      status, headers: { 'Content-Type': 'application/json' },
    }));
    const treatment = { id: 'synthetic-brow', name: 'Fixture brow treatment', price_cents: 4500, duration_minutes: 60 };
    window.fetch = (input, options = {}) => {
      const url = typeof input === 'string' ? input : input?.url || '';
      const method = String(options.method || input?.method || 'GET').toUpperCase();
      const path = new URL(url, location.origin).pathname;
      window.__policyRequests.push({ path, method });
      if (method !== 'GET') {
        window.__blockedPolicyWrites.push({ path, method });
        return json({ error: 'This read-only policy fixture refuses writes.' }, 405);
      }
      if (path.includes('/rest/v1/beauticians')) return json(profile);
      if (path.endsWith('/api/booking/policy-demo/policy')) return json({ policy: currentPolicy, name: 'Fictional Salon' });
      if (path.endsWith('/api/booking/policy-demo/manage/synthetic-token')) return json({
        appointment: { id: 'synthetic-booking', status: 'confirmed', startsAt: '2090-10-16T12:00:00Z', endsAt: '2090-10-16T13:00:00Z',
          depositPaid: true, treatment, treatments: [treatment], totalDurationMinutes: 60, totalPriceCents: 4500,
          client: { name: 'Fixture Client' }, beautician: { name: 'Fictional Salon', brandColor: '#92405e' } },
        policy: bookingPolicy, patchTests: [], needsPatchTest: false, pendingForms: [],
        patchTest: { required: false, certainty: 'recorded' },
        payment: { depositPaidCents: 900, remainingCents: 3600, bankDetails: null },
      });
      if (path.endsWith('/api/booking/policy-demo/manage/synthetic-token/preparation')) return json({
        preparation: { confirmed: true, required: false, patch: { state: 'not_required', required: false, can_complete: true }, forms: [] },
      });
      if (path.endsWith('/api/booking/policy-demo/manage/synthetic-token/reschedule/slots')) return json({ slots: [], dates: [] });
      if (path.endsWith('/api/appointments/deposits')) return json({ deposits: [] });
      return base(input, options);
    };
  }, { bookingPolicy, currentPolicy });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + pagePath);
  return { context, page, errors };
}

async function assertReadOnly({ page, errors }) {
  assert.deepEqual(await page.evaluate(() => window.__blockedPolicyWrites), [], 'Viewing policy or opening confirmation must never change a booking or charge a card');
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'Policy should fit a mobile screen');
}

const basePolicy = { cancellation_notice_hours: 48, late_cancel_charge_percent: 0, no_show_charge_percent: 100,
  lateCancelFeeCents: 0, withinCancellationWindow: true, cardOnFile: true, hoursUntil: 12,
  cancellation_message: 'Deposits are non-refundable. Please contact the salon if you need help.' };

try {
  // A zero notice window does not erase the separate no-show policy or become 48 hours.
  const zero = await fixture({ bookingPolicy: { ...basePolicy, cancellation_notice_hours: 0,
    late_cancel_charge_percent: 100, withinCancellationWindow: false } });
  await zero.page.getByText('There is no advance cancellation notice period.', { exact: true }).waitFor();
  const zeroCard = zero.page.getByText('Cancellation policy', { exact: true }).locator('..');
  assert.match(await zeroCard.innerText(), /If you do not turn up, 100%/);
  assert.doesNotMatch(await zeroCard.innerText(), /48|Free cancellation|within the .*notice period|fee may apply if you cancel now/i);
  await zero.page.getByRole('button', { name: 'Cancel appointment', exact: true }).click();
  await zero.page.getByText('Are you sure you want to cancel?', { exact: true }).waitFor();
  assert.equal(await zero.page.getByText(/cancellation fee may be charged|fee on the card|late cancellation fee may apply/i).count(), 0);
  await zero.page.getByRole('button', { name: 'Keep booking', exact: true }).click();
  if (screenshots) await zeroCard.screenshot({ path: join(screenshots, 'client-policy-zero-notice-mobile.png') });
  await assertReadOnly(zero);
  await zero.context.close();
  console.log('✓ Manage booking: zero notice stays zero, 100% no-show fee remains visible, no false free/48-hour or cancellation-charge warning');

  // The API has already resolved the old booking snapshot. A newer owner policy
  // must not overwrite those old terms in the public manage screen.
  const originalNote = 'Original booking terms: the paid deposit is retained.';
  const history = await fixture({ bookingPolicy: { ...basePolicy, cancellation_message: originalNote },
    currentPolicy: { ...basePolicy, late_cancel_charge_percent: 100, cancellation_message: 'New bookings have a 100% late-cancellation fee.' } });
  const historyCard = history.page.getByText('Cancellation policy', { exact: true }).locator('..');
  await historyCard.getByText(originalNote, { exact: true }).waitFor();
  assert.match(await historyCard.innerText(), /48 hours/);
  assert.match(await historyCard.innerText(), /If you do not turn up, 100%/);
  assert.doesNotMatch(await historyCard.innerText(), /Cancellations within .*100%|New bookings|fee may apply if you cancel now|Free cancellation/i);
  await history.page.getByRole('button', { name: 'Cancel appointment', exact: true }).click();
  assert.equal(await history.page.getByText(/cancellation fee may be charged|fee on the card|late cancellation fee may apply/i).count(), 0);
  await assertReadOnly(history);
  await history.context.close();
  console.log('✓ Manage booking: original zero-fee snapshot and note remain distinct from the current 100% owner policy');

  // Fully credited fees are zero even when the nominal policy percent is positive.
  const covered = await fixture({ bookingPolicy: { ...basePolicy, late_cancel_charge_percent: 100, lateCancelFeeCents: 0 } });
  await covered.page.getByText('Cancellation policy', { exact: true }).waitFor();
  await covered.page.getByRole('button', { name: 'Cancel appointment', exact: true }).click();
  assert.equal(await covered.page.getByText(/cancellation fee may be charged|fee on the card|late cancellation fee may apply/i).count(), 0, 'A zero calculated fee must not acquire a percent-only warning');
  await covered.page.getByRole('button', { name: 'Keep booking', exact: true }).click();
  await covered.page.getByRole('button', { name: 'Reschedule appointment', exact: true }).click();
  assert.equal(await covered.page.getByText(/Rescheduling now may result in/i).count(), 0, 'A zero calculated fee must not acquire a reschedule warning');
  await assertReadOnly(covered);
  await covered.context.close();
  console.log('✓ Manage booking: a calculated zero fee produces no charge warning in cancel or reschedule confirmation');

  for (const notice of [48, 0]) {
    const deposits = await fixture({ bookingPolicy: basePolicy,
      currentPolicy: { ...basePolicy, cancellation_notice_hours: notice }, pagePath: '/deposits' });
    const card = deposits.page.getByText('Your booking policy', { exact: true }).locator('..');
    await card.getByText(/No-shows may be charged up to 100%/).waitFor();
    const text = await card.innerText();
    assert.doesNotMatch(text, /Late cancellations may be charged|Free cancellation|cancel for free/i);
    assert.match(text, notice === 0 ? /No advance cancellation notice period is set/ : /2 days notice/);
    if (notice === 0) assert.doesNotMatch(text, /48|2 days/);
    if (screenshots && notice === 48) await card.screenshot({ path: join(screenshots, 'deposit-policy-separate-fees-mobile.png') });
    await assertReadOnly(deposits);
    await deposits.context.close();
  }
  console.log('✓ Deposits: zero late-cancel and 100% no-show fees stay separate with 48-hour and zero-notice policies');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
