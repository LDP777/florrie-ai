import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import http from 'node:http';
import { launch } from './lib/browser.mjs';
import { bundleSupabaseUrl, fetchStubSource, sessionSeedSource } from './lib/fixtures.mjs';

// Runs the built public page. All records, mutations and provider responses
// are synthetic; every non-local network request is blocked at the browser.
const dist = new URL('../dist', import.meta.url).pathname;
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  let file = join(dist, (req.url || '/').split('?')[0]);
  if (!existsSync(file) || !extname(file)) file = join(dist, 'index.html');
  try { res.setHeader('content-type', mime[extname(file)] || 'application/octet-stream'); res.end(readFileSync(file)); }
  catch { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await launch();
const path = '/book/fixture-salon/manage/fixture-token';
let groups = 0;

async function fixture(options = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin && route.request().method() === 'GET' ? route.continue() : route.abort());
  await context.addInitScript(fetchStubSource());
  await context.addInitScript(sessionSeedSource(bundleSupabaseUrl(dist)));
  await context.addInitScript(options => {
    const base = window.fetch;
    const json = (value, status = 200) => Promise.resolve(new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }));
    const treatment = { id: 'fixture-treatment', name: 'Fixture brow treatment', price_cents: 4500, duration_minutes: 60 };
    let startsAt = options.startsAt || '2090-10-16T12:00:00';
    let cancelled = !!options.cancelled, reads = 0, slotReads = 0;
    window.__bookingRequests = [];
    const policy = { cancellation_notice_hours: 48, late_cancel_charge_percent: 100, no_show_charge_percent: 100,
      canReschedule: !options.late && !options.used, withinCancellationWindow: !!options.late,
      lateCancelFeeCents: options.late ? 3600 : 0, cardOnFile: options.cardOnFile !== false,
      reschedule_once: !!options.used, alreadyRescheduled: !!options.used,
      reschedule_between_only: options.mode === 'back_to_back', ...options.policy };
    const booking = () => ({ readOnly: cancelled,
      appointment: { id: 'fixture-appointment', status: cancelled ? 'cancelled' : 'confirmed', startsAt,
        endsAt: startsAt.slice(0, 10) + 'T13:00:00', depositPaid: true,
        treatment, treatments: [treatment], totalPriceCents: 4500, totalDurationMinutes: 60,
        // Sentinels intentionally remain in a cancelled fixture: its receipt
        // must not mount private client, payment or consultation panels.
        client: { name: 'Private fixture person', email: 'private-fixture@example.test' },
        beautician: { name: 'Fixture Salon', brandColor: '#92405e', phone: '+447700900000' } },
      policy, patchTests: [], needsPatchTest: false, pendingForms: [],
      patchTest: { required: false, certainty: 'not_required' },
      payment: { depositPaidCents: 900, remainingCents: 3600, bankDetails: { accountName: 'Private bank fixture', accountNumber: '12345678', sortCode: '112233' } },
    });
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.origin);
      const method = String(init.method || input?.method || 'GET').toUpperCase();
      const root = '/api/booking/fixture-salon/manage/fixture-token';
      if (!url.pathname.startsWith(root)) return base(input, init);
      window.__bookingRequests.push({ path: url.pathname, method, month: url.searchParams.get('month'), body: init.body ? JSON.parse(init.body) : null });
      if (url.pathname === root) {
        reads++;
        if (options.loadError && reads === 1) return json({ error: 'Fixture connection interrupted' }, options.loadError);
        if (cancelled && options.failReadAfterCancel && reads > 1) return json({ error: 'Refresh unavailable' }, 503);
        return json(booking());
      }
      if (url.pathname.endsWith('/preparation')) return json({ preparation: { confirmed: true, required: false, patch: { state: 'not_required', required: false, can_complete: true }, forms: [] } });
      if (url.pathname.endsWith('/reschedule/slots')) {
        slotReads++;
        const month = url.searchParams.get('month');
        const bounds = { earliestMonth: '2090-10', latestMonth: '2090-11' };
        if (month < bounds.earliestMonth || month > bounds.latestMonth) return json({ ...bounds, code: 'month_outside_booking_window', error: 'This month is outside the salon’s online booking window.' }, 400);
        if (options.slotError && slotReads === 1) return json({ ...bounds, error: 'Fixture availability temporarily unavailable' }, 503);
        if (options.race && slotReads === 1) {
          await new Promise(resolve => { window.__releaseStaleSlots = resolve; });
          window.__staleSlotsReturned = true;
          return json({ ...bounds, month, mode: options.mode || 'available', slots: ['2090-10-20T11:30:00'] });
        }
        const slots = options.emptyOctober && month === '2090-10' ? [] : [`${month}-20T10:30:00`];
        return json({ ...bounds, month, mode: options.mode || 'available', slots, durationMinutes: 60 });
      }
      if (url.pathname.endsWith('/reschedule') && method === 'POST') {
        if (options.moveError) return json({ code: options.moveError, error: options.moveError === 'reschedule_notice_window' ? 'Online rescheduling closes 48 hours before your appointment.' : 'This booking has already been moved once.' }, 409);
        startsAt = JSON.parse(init.body).new_starts_at;
        return json({ success: true, message: 'Your appointment has been moved.' });
      }
      if (url.pathname.endsWith('/cancel') && method === 'POST') {
        if (options.cancelError) return json({ error: 'Your booking has not been cancelled. Please try again.' }, 503);
        cancelled = true;
        return json({ success: true, isLateCancel: !!options.late, feeCents: options.late ? 3600 : 0,
          feeCollection: { charged: options.feeState === 'charged', pending: options.feeState === 'pending', needsReview: options.feeState === 'review' },
          message: 'Your appointment has been cancelled.' });
      }
      return json({ error: 'Unsupported synthetic request' }, 405);
    };
  }, options);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + path);
  return { page, context, errors };
}

async function check(label, options, run) {
  const f = await fixture(options);
  try {
    await run(f.page);
    assert.deepEqual(f.errors, [], 'No browser runtime errors');
    assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'Fits the mobile viewport');
    groups++;
    console.log(`✓ ${label}`);
  } finally { await f.context.close(); }
}

const writes = page => page.evaluate(() => window.__bookingRequests.filter(r => r.method !== 'GET'));
const open = page => page.getByRole('button', { name: 'Reschedule appointment', exact: true }).click();
async function choose(page) {
  await page.getByRole('button', { name: '10:30', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm my new time', exact: true }).click();
}

try {
  for (const mode of ['available', 'back_to_back']) {
    await check(`${mode}: empty October still reaches November; offered wall time is preserved`, { mode, emptyOctober: true }, async page => {
      await open(page);
      await page.getByText(/No suitable times are available this month/).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Previous month', exact: true }).isDisabled(), true);
      await page.getByRole('button', { name: 'Next month', exact: true }).click();
      await page.getByText('November 2090', { exact: true }).waitFor();
      await page.getByRole('button', { name: '10:30', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Next month', exact: true }).isDisabled(), true);
      await choose(page);
      await page.getByText('✓ Your appointment has been moved.', { exact: true }).waitFor();
      const sent = await writes(page);
      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0].body, { new_starts_at: '2090-11-20T10:30:00' });
    });
  }
  await check('First month outside a tightened horizon moves to the latest allowed month', { startsAt: '2090-12-16T12:00:00' }, async page => {
    await open(page);
    await page.getByText('November 2090', { exact: true }).waitFor();
    await page.getByRole('button', { name: '10:30', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Next month', exact: true }).isDisabled(), true);
    assert.deepEqual(await writes(page), []);
  });
  await check('Availability failures remain retryable and are not presented as an empty diary', { slotError: true }, async page => {
    await open(page);
    await page.getByText(/Fixture availability temporarily unavailable/).waitFor();
    assert.equal(await page.getByText(/No suitable times are available/).count(), 0);
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await page.getByRole('button', { name: '10:30', exact: true }).waitFor();
    assert.deepEqual(await writes(page), []);
  });
  await check('Closing and reopening invalidates a stale in-flight slot response', { race: true }, async page => {
    await open(page);
    await page.getByText('Finding available times…', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await open(page);
    await page.getByRole('button', { name: '10:30', exact: true }).waitFor();
    await page.evaluate(async () => { window.__releaseStaleSlots(); while (!window.__staleSlotsReturned) await new Promise(r => setTimeout(r, 0)); await new Promise(r => requestAnimationFrame(r)); });
    assert.equal(await page.getByRole('button', { name: '11:30', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '10:30', exact: true }).count(), 1);
  });
  for (const code of ['reschedule_notice_window', 'reschedule_used']) {
    await check(`Server ${code} conflict preserves the booking and closes the picker`, { moveError: code }, async page => {
      await open(page); await choose(page);
      await page.getByText(code === 'reschedule_used' ? /You've already moved this booking once/ : /Online rescheduling closes 48 hours/).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Confirm my new time', exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Cancel appointment', exact: true }).count(), 1);
      assert.equal((await writes(page)).length, 1);
    });
  }
  await check('Already-used moves explain the actual restriction', { used: true }, async page => {
    await page.getByText(/You've already moved this booking once/).waitFor();
    assert.equal(await page.getByText(/Online rescheduling closes/).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Reschedule appointment', exact: true }).count(), 0);
  });
  await check('Late cancellation requires explicit remaining-fee consent and failed writes preserve the booking', { late: true, cancelError: true }, async page => {
    await page.getByRole('button', { name: 'Cancel appointment', exact: true }).click();
    await page.getByText(/remaining fee after crediting what you have already paid/).waitFor();
    assert.deepEqual(await writes(page), [], 'Opening confirmation must not cancel or charge');
    await page.getByRole('button', { name: 'Keep booking', exact: true }).click();
    assert.deepEqual(await writes(page), [], 'Keeping booking must not cancel or charge');
    await page.getByRole('button', { name: 'Cancel appointment', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel and pay £36.00', exact: true }).click();
    await page.getByText('Your booking has not been cancelled. Please try again.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Cancel appointment', exact: true }).count(), 1);
    assert.equal(await page.getByText('Appointment cancelled', { exact: true }).count(), 0);
  });
  for (const feeState of ['charged', 'pending', 'review']) {
    await check(`Cancelled receipt reports ${feeState} payment truthfully and survives an unavailable follow-up read`, { late: true, feeState, failReadAfterCancel: true }, async page => {
      await page.getByRole('button', { name: 'Cancel appointment', exact: true }).click();
      await page.getByRole('button', { name: 'Cancel and pay £36.00', exact: true }).click();
      await page.getByText('Appointment cancelled', { exact: true }).waitFor();
      const text = await page.locator('body').innerText();
      assert.match(text, feeState === 'charged' ? /£36\.00 cancellation fee has been charged/ : feeState === 'pending' ? /£36\.00 cancellation payment is awaiting confirmation/ : /£36\.00 cancellation payment needs the salon's attention/);
      if (feeState !== 'charged') assert.doesNotMatch(text, /has been charged/);
      assert.doesNotMatch(text, /Private fixture person|Private bank fixture|12345678|Couldn't load/);
      assert.equal(await page.getByRole('button', { name: /cancel|reschedule|pay/i }).count(), 0);
      assert.equal((await writes(page)).length, 1);
    });
  }
  await check('Cancelled link is a limited read-only receipt with no care/payment reads', { cancelled: true }, async page => {
    await page.getByText('Appointment cancelled', { exact: true }).waitFor();
    const text = await page.locator('body').innerText();
    assert.doesNotMatch(text, /Private fixture person|private-fixture@example|Private bank fixture|12345678|Consultation|Patch test/);
    assert.equal(await page.getByRole('button').count(), 0);
    assert.equal(await page.getByRole('link', { name: 'Book another appointment', exact: true }).count(), 1);
    const requests = await page.evaluate(() => window.__bookingRequests);
    assert.equal(requests.length, 1);
    assert.deepEqual(await writes(page), []);
  });
  await check('Transient summary failure offers Retry instead of claiming the booking is missing', { loadError: 503 }, async page => {
    await page.getByText("Couldn't load your booking", { exact: true }).waitFor();
    assert.equal(await page.getByText('Booking link unavailable', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await page.getByRole('button', { name: 'Reschedule appointment', exact: true }).waitFor();
  });
  await check('Expired link has an unavailable message without booking mutations', { loadError: 410 }, async page => {
    await page.getByText('Booking link unavailable', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Try again', exact: true }).count(), 0);
    assert.deepEqual(await writes(page), []);
  });
  console.log(`${groups} booking self-service browser groups passed.`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
