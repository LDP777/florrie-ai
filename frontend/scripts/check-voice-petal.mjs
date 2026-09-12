// Exercise the shipped app with synthetic speech and no external traffic.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import http from 'node:http';
import { webkit } from '@playwright/test';
import { launch } from './lib/browser.mjs';
import { fetchStubSource, sessionSeedSource, bundleSupabaseUrl } from './lib/fixtures.mjs';

const dist = new URL('../dist', import.meta.url).pathname;
const server = http.createServer((req, res) => {
  let file = join(dist, (req.url || '/').split('?')[0]);
  if (!existsSync(file) || !extname(file)) file = join(dist, 'index.html');
  res.setHeader('content-type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' })[extname(file)] || 'application/octet-stream');
  try { res.end(readFileSync(file)); } catch { res.statusCode = 404; res.end(); }
}).listen(0);
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = process.env.VOICE_BROWSER === 'webkit' ? await webkit.launch() : await launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await ctx.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await ctx.addInitScript(fetchStubSource());
  await ctx.addInitScript(sessionSeedSource(bundleSupabaseUrl(dist)));
  await ctx.addInitScript(() => {
    localStorage.setItem('florrie_voice_enabled', '1');
    window.__petal = { starts: 0, aborts: 0, commands: 0, failStart: false };
    window.SpeechRecognition = class {
      start() {
        if (__petal.failStart) { __petal.failStart = false; throw new Error('Synthetic speech startup failure'); }
        __petal.starts++; __petal.active = this; this.onstart?.();
      }
      stop() { this.onend?.(); }
      abort() { __petal.aborts++; this.onend?.(); }
    };
    const fetch = window.fetch;
    window.fetch = (input, options = {}) => {
      if (String(input).includes('/api/voice/command') && options.method === 'POST') __petal.commands++;
      return fetch(input, options);
    };
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const petal = page.getByRole('button', { name: 'Talk to Florrie, hold to speak', exact: true });
  const starts = () => page.evaluate(() => __petal.starts);
  await page.goto(`${origin}/more`);
  await petal.waitFor();
  assert.equal(await petal.locator('img').count(), 0, 'The voice button cannot offer an image preview');
  assert.match(await petal.locator('[aria-hidden]').evaluate(el => getComputedStyle(el).backgroundImage), /florrie-petal\.svg/, 'The original flower remains');
  assert.equal(await petal.evaluate(el => {
    const style = getComputedStyle(el);
    return style.getPropertyValue('user-select') || style.getPropertyValue('-webkit-user-select');
  }), 'none');
  assert.equal(await petal.evaluate(el => getComputedStyle(el).touchAction), 'none');
  // Desktop WebKit does not implement this iOS-only property or its native menu.
  // Check the computed value only on a runtime that supports it; the image-free
  // target and contextmenu cancellation above are exercised in both engines.
  if (await page.evaluate(() => CSS.supports('-webkit-touch-callout', 'none'))) {
    assert.equal(await petal.evaluate(el => getComputedStyle(el).getPropertyValue('-webkit-touch-callout')), 'none');
  }
  assert.equal(await petal.evaluate(el => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))), false, 'The context menu is cancelled');

  await petal.click();
  await page.waitForURL('**/voice');
  await page.getByRole('textbox', { name: 'Message Florrie' }).waitFor();
  assert.equal(await starts(), 0, 'A normal tap opens the page without recording');
  await page.goBack();
  await petal.focus();
  await petal.press('Enter');
  await page.waitForURL('**/voice');
  assert.equal(await starts(), 0, 'Keyboard activation opens the page without recording');
  await petal.click({ delay: 850 });
  await page.getByRole('button', { name: 'Stop listening', exact: true }).waitFor();
  assert.equal(await starts(), 1, 'A hold starts recording once');
  await petal.click({ delay: 850 });
  assert.equal(await starts(), 1, 'A hold during recording does not open another microphone');
  await page.evaluate(() => { __petal.previous = __petal.active; });
  await page.getByRole('button', { name: 'Stop listening', exact: true }).click();
  await petal.click({ delay: 850 });
  assert.equal(await starts(), 2, 'Another hold on the same page starts again');
  await page.evaluate(() => __petal.previous.onend());
  await page.getByRole('button', { name: 'Stop listening', exact: true }).waitFor();
  await page.evaluate(() => __petal.active.onend());

  const point = await petal.boundingBox();
  await page.mouse.move(point.x + point.width / 2, point.y + point.height / 2);
  await page.mouse.down();
  await page.mouse.move(point.x + point.width / 2 + 35, point.y + point.height / 2);
  await page.waitForTimeout(850);
  await page.mouse.up();
  assert.equal(await starts(), 2, 'Dragging away cancels the hold');

  const touch = { pointerId: 17, pointerType: 'touch', isPrimary: true, button: 0, clientX: 190, clientY: 780 };
  await petal.dispatchEvent('pointerdown', touch);
  await petal.dispatchEvent('pointercancel', touch);
  await page.waitForTimeout(850);
  assert.equal(await starts(), 2, 'An interrupted touch does not start later');
  await petal.dispatchEvent('pointerdown', touch);
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.waitForTimeout(850);
  assert.equal(new URL(page.url()).pathname, '/inbox', 'Navigation cancels a pending hold');
  assert.equal(await starts(), 2);

  await page.goBack();
  await page.waitForURL('**/voice');
  assert.equal(await starts(), 2, 'Back does not replay a consumed hold');
  await page.evaluate(() => { localStorage.removeItem('florrie_voice_enabled'); window.dispatchEvent(new Event('florrie:voice-pref')); });
  await page.getByRole('button', { name: 'Turn on voice', exact: true }).waitFor();
  await petal.click({ delay: 850 });
  assert.equal(await starts(), 2, 'An explicit voice-off preference is respected');
  await page.getByRole('button', { name: 'Turn on voice', exact: true }).click();
  assert.equal(await starts(), 3, 'Visible opt-in starts voice on this device');
  await page.getByRole('button', { name: 'Stop listening', exact: true }).click();

  await page.evaluate(() => { __petal.failStart = true; });
  await petal.click({ delay: 850 });
  await page.getByText("Voice couldn't start. Try again or type your message.", { exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Message Florrie' }).isEnabled(), true);
  await page.getByRole('button', { name: 'Tap to speak', exact: true }).click();
  assert.equal(await starts(), 4, 'Startup failure can be retried with a direct tap');
  await page.evaluate(() => { __petal.active.onerror({ error: 'not-allowed' }); __petal.active.onend(); });
  await page.getByText('Microphone access denied.', { exact: false }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Message Florrie' }).isEnabled(), true, 'Permission denial keeps typing available');

  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await petal.click({ delay: 850 });
  await page.getByRole('button', { name: 'Stop listening', exact: true }).waitFor();
  assert.equal(await starts(), 5, 'A hold from another page starts voice');
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.waitForFunction(() => __petal.aborts === 1);
  assert.equal(await page.evaluate(() => __petal.aborts), 1, 'Leaving the commander closes the microphone');
  await petal.dispatchEvent('pointerdown', touch);
  await page.waitForFunction(() => __petal.starts === 6);
  await petal.dispatchEvent('pointerup', touch);
  await petal.dispatchEvent('click');
  await page.getByRole('button', { name: 'Stop listening', exact: true }).waitFor();
  assert.equal(await starts(), 6, 'Touch pointer hold also starts only once');
  assert.equal(await page.evaluate(() => __petal.commands), 0, 'Gestures alone do not submit commands');
  assert.deepEqual(errors, []);
  console.log('✓ Petal: tap, hold, repeat, movement/cancel/navigation, opt-in, startup recovery, permissions and microphone cleanup');
} finally {
  await browser?.close();
  server.close();
}
