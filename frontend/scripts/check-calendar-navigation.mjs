import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import http from 'node:http';
import { launch } from './lib/browser.mjs';
import { bundleSupabaseUrl } from './lib/fixtures.mjs';
import { calendarFixtureSource } from './lib/calendar-fixtures.mjs';

// Drive the real built routes; every API call is answered by fictional data.
// No booking, message or payment is sent to a live service.
const dist = new URL('../dist', import.meta.url).pathname;
const server = http.createServer((req, res) => {
  let file = join(dist, (req.url || '/').split('?')[0]);
  if (!existsSync(file) || !extname(file)) file = join(dist, 'index.html');
  res.setHeader('content-type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' })[extname(file)] || 'application/octet-stream');
  try { res.end(readFileSync(file)); } catch { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await launch();
const screenshots = process.env.CALENDAR_SCREENSHOT_DIR;
if (screenshots) mkdirSync(screenshots, { recursive: true });
const origin = `http://127.0.0.1:${server.address().port}`;
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 393, height: 852 } });
  await context.addInitScript(calendarFixtureSource(bundleSupabaseUrl(dist), 'overlap') + `
    (() => {
      const base = window.fetch;
      window.calendarFixture = { hold: location.search.includes('hold=1'), fail: location.search.includes('fail=1'), reads: 0, release: [], writes: [] };
      window.fetch = async (input, options = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        const state = window.calendarFixture;
        const method = options.method || 'GET';
        if (['POST', 'PATCH', 'DELETE'].includes(method) && !url.pathname.startsWith('/auth/')) state.writes.push(url.pathname);
        if (url.pathname === '/rest/v1/appointments' && (url.searchParams.get('select') || '').includes('clients(')) {
          state.reads++;
          if (state.hold) await new Promise(resolve => state.release.push(resolve));
          if (state.fail) return new Response(JSON.stringify({ message: 'Synthetic diary outage' }), { status: 503 });
        }
        if (url.pathname === '/api/hours-exceptions') return new Response(JSON.stringify({ exceptions: [] }));
        const response = await base(input, options);
        if (url.pathname === '/rest/v1/appointments' && location.search.includes('new-booking=1') && !state.bookingCreated) {
          return new Response(JSON.stringify((await response.json()).filter(row => row.id !== 'a2')), { headers: { 'content-type': 'application/json' } });
        }
        return response;
      };
    })();
  `);
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  const view = name => page.getByRole('group', { name: 'Calendar view', exact: true }).getByRole('button', { name, exact: true });
  const open = async search => {
    await page.goto(`${origin}/calendar/week?${search}`);
    await page.addStyleTag({ content: ':root { --safe-top:59px; --shell-top:59px; --safe-bottom:34px; --shell-bottom:180px; }' });
  };
  const waitForView = async name => {
    await page.waitForFunction(label => {
      const group = document.querySelector('[aria-label="Calendar view"]');
      return [...(group?.querySelectorAll('button') || [])].some(button => button.textContent === label && button.getAttribute('aria-pressed') === 'true');
    }, name);
    await page.waitForFunction(() => !document.querySelector('.calendar-day-summary')?.textContent.includes('Loading'));
  };

  await open('date=2026-08-08&appt=a2');
  const sheet = page.getByRole('dialog', { name: 'Booking details' });
  await sheet.waitFor();
  await sheet.getByText('Priya K', { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.has('appt'), false, 'notification instruction is consumed');
  assert.equal(new URL(page.url()).searchParams.get('view'), 'day');
  const box = await sheet.boundingBox();
  assert.ok(box.y >= 59, 'booking sheet clears the status area');
  const focusWithin = await sheet.evaluate(el => el.contains(document.activeElement));
  assert.equal(focusWithin, true, 'dialog owns focus');
  if (screenshots) await page.screenshot({ path: join(screenshots, 'booking-details-393.png') });
  await sheet.getByRole('button', { name: 'Week view', exact: true }).click();
  await sheet.waitFor({ state: 'hidden' });
  await waitForView('Week');
  assert.equal(new URL(page.url()).searchParams.get('view'), 'week');
  await page.locator('.calendar-week-row').filter({ hasText: 'Priya K' }).click();
  await sheet.waitFor();
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'hidden' });
  await waitForView('Week');
  await page.waitForFunction(() => document.activeElement?.classList.contains('calendar-week-row'));
  if (screenshots) await page.screenshot({ path: join(screenshots, 'calendar-week-393.png') });
  console.log('✓ Booking notification opens once; Week survives fetch; booking sheet closes to the same week');

  await view('Day').click();
  await waitForView('Day');
  if (screenshots) await page.screenshot({ path: join(screenshots, 'calendar-day-393.png') });
  await page.getByRole('button', { name: 'Next week', exact: true }).click();
  await waitForView('Day');
  assert.equal(new URL(page.url()).searchParams.get('date'), '2026-08-15');
  await page.reload();
  await waitForView('Day');
  assert.equal(new URL(page.url()).searchParams.get('date'), '2026-08-15');
  await page.getByRole('tab', { name: 'Schedule', exact: true }).click();
  await page.getByRole('heading', { name: 'Your schedule', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Calendar', exact: true }).click();
  await waitForView('Day');
  assert.equal(new URL(page.url()).searchParams.get('date'), '2026-08-15');
  await page.getByRole('tab', { name: 'Today', exact: true }).click();
  await page.getByRole('tab', { name: 'Calendar', exact: true }).click();
  await waitForView('Day');
  assert.equal(new URL(page.url()).searchParams.get('date'), '2026-08-15');
  console.log('✓ Date and view survive reload, Today and Schedule; no return to the notification date');

  await open('date=2026-08-08&view=week&new-booking=1');
  await page.locator('.calendar-week-row').first().waitFor();
  const readsBefore = await page.evaluate(() => calendarFixture.reads);
  await page.evaluate(() => {
    calendarFixture.bookingCreated = true;
    history.pushState({ key: 'new-booking-notification' }, '', '/calendar/week?date=2026-08-08&appt=a2&new-booking=1');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await sheet.waitFor();
  await sheet.getByText('Priya K', { exact: true }).waitFor();
  assert.ok(await page.evaluate(() => calendarFixture.reads) > readsBefore, 'new notification rereads its already visible date');
  await sheet.getByRole('button', { name: 'Week view', exact: true }).click();
  await waitForView('Week');
  console.log('✓ New booking link on an already-open week refreshes before resolving its appointment');

  await open('date=2026-08-08&appt=missing-booking');
  await page.getByRole('status').filter({ hasText: 'This booking is no longer on this date.' }).waitFor();
  assert.equal(await sheet.count(), 0);
  await view('Week').click();
  await waitForView('Week');
  console.log('✓ Removed or moved notification target explains what happened and leaves the diary usable');

  await open('date=2026-08-08&view=day&appt=a2&hold=1');
  await view('Week').click();
  await page.evaluate(() => {
    calendarFixture.hold = false;
    calendarFixture.release.forEach(resolve => resolve());
  });
  await waitForView('Week');
  assert.equal(await sheet.count(), 0, 'late notification load cannot override manual navigation');
  assert.equal(new URL(page.url()).searchParams.has('appt'), false);
  console.log('✓ Switching to Week while a notification is still loading wins over its late response');

  await open('date=2026-08-08&appt=a2&fail=1');
  await page.getByRole('button', { name: /Could not load this week/ }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('appt'), 'a2', 'failed read retains the pending notification for retry');
  await page.evaluate(() => { calendarFixture.fail = false; });
  await page.getByRole('button', { name: /Could not load this week/ }).click();
  await sheet.waitFor();
  await sheet.getByRole('button', { name: 'Back to day', exact: true }).click();
  await waitForView('Day');
  await view('Week').click();
  await waitForView('Week');
  assert.deepEqual(await page.evaluate(() => calendarFixture.writes.filter(path => !path.includes('/push/') && !path.includes('/analytics/'))), []);
  console.log('✓ Notification read failure retries without losing its target; navigation performs no booking writes');

  for (const width of [320, 393, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.locator('.calendar-toolbar').evaluate(el => [...el.children].some(child => child.getBoundingClientRect().right > innerWidth));
    assert.equal(overflow, false, `calendar controls fit at ${width}px`);
    await view('Day').click();
    await waitForView('Day');
    if (screenshots) { await page.waitForTimeout(250); await page.screenshot({ path: join(screenshots, `calendar-day-${width}.png`) }); }
    await view('Week').click();
    await waitForView('Week');
  }
  assert.deepEqual(errors, []);
  console.log('✓ 320–1280px layouts fit; no uncaught page errors');
  await context.close();
} finally {
  await browser.close();
  server.close();
}
