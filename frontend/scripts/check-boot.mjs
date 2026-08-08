/**
 * How long before Ellie sees anything.
 *
 * She opens this app between clients, on mobile data, dozens of times a day.
 * Boot time is not a vanity metric here — it is the difference between
 * glancing at the next appointment and putting the phone down.
 *
 * Serves the real dist/ over a throttled connection and reports First
 * Contentful Paint plus how many bytes of JavaScript had to arrive before it.
 *
 *   npm run build && node scripts/check-boot.mjs
 *   node scripts/check-boot.mjs --fast     # no throttling, for a quick A/B
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import http from 'node:http';
import { launch } from './lib/browser.mjs';

const DIST = new URL('../dist', import.meta.url).pathname;
if (!existsSync(join(DIST, 'index.html'))) {
  console.error('✗ boot: no dist/. Run `npm run build` first.');
  process.exit(1);
}

const FAST = process.argv.includes('--fast');

// A pessimistic-but-real mobile connection: what a salon on the edge of decent
// 4G actually gets, not what a laptop on office wifi gets.
const NETWORK = { downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8, latency: 150 };

const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const path = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = join(DIST, path === '/' ? 'index.html' : path);
  if (!existsSync(file) || path === '/') file = join(DIST, 'index.html');
  try {
    const body = readFileSync(file);
    res.setHeader('content-type', MIME[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch { res.statusCode = 404; res.end(''); }
}).listen(0);
const port = server.address().port;

const browser = await launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();

if (!FAST) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, ...NETWORK });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });   // a phone, not a laptop
}

const rawJs = [];
page.on('response', async (r) => {
  if (!/\.js(\?|$)/.test(r.url())) return;
  try { rawJs.push({ name: r.url().split('/').pop().split('?')[0], size: (await r.body()).length }); }
  catch { /* redirect or aborted */ }
});

const t0 = Date.now();
// Go straight to the route the app settles on. Booting at / triggers a FULL
// page reload to /login, which resets the performance timeline — the first
// version of this measured an empty timeline and cheerfully reported 0 KB.
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
// The app redirects to /login on boot, which tears down the execution context
// mid-evaluate. Let the client-side navigation settle first, then read the
// timings — performance entries survive a same-document route change.
await page.waitForLoadState('networkidle').catch(() => {});
await page.waitForTimeout(400);

// The app hard-reloads to /login during boot, so an evaluate started before
// that lands mid-navigation. Retry once on the far side rather than pretending
// a destroyed context is a measurement of zero.
const readPaint = () => page.evaluate(() => new Promise((resolve) => {
  const read = () => {
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    const nav = performance.getEntriesByType('navigation')[0];
    if (fcp) resolve({ fcp: Math.round(fcp.startTime), domContentLoaded: Math.round(nav?.domContentLoadedEventEnd || 0), load: Math.round(nav?.loadEventEnd || 0) });
    else setTimeout(read, 50);
  };
  read();
  setTimeout(() => resolve({ fcp: -1, domContentLoaded: -1, load: -1 }), 8000);
}));

let paint;
try { paint = await readPaint(); }
catch {
  await page.waitForLoadState('load').catch(() => {});
  await page.waitForTimeout(300);
  paint = await readPaint();
}

// Render-blocking is read from index.html's own modulepreload set, not from
// timings. Two earlier attempts got this wrong in opposite directions:
// stamping Date.now() in a response listener measures when NODE finished
// reading the body (async, lands after FCP, reported 0 KB), and reading
// performance.getEntriesByType('resource') after boot finds an empty timeline
// because the app does a FULL page reload to /login, which resets it.
//
// The preload set is deterministic and is exactly what the browser must have
// before it can run the app, so it is the honest answer to "what does she wait
// for".
const indexHtml = readFileSync(join(DIST, 'index.html'), 'utf8');
const preloaded = new Set([...indexHtml.matchAll(/(?:modulepreload|module)"?[^>]*(?:href|src)="\/?(assets\/[^"]+\.js)"/g)].map(m => m[1].split('/').pop()));
const js = rawJs.map(j => ({ ...j, blocksPaint: preloaded.has(j.name) }));

const beforePaint = js.filter(j => j.blocksPaint);
const totalJs = js.reduce((a, j) => a + j.size, 0);
const paintJs = beforePaint.reduce((a, j) => a + j.size, 0);

await browser.close();
server.close();

const kb = n => `${Math.round(n / 1024)} KB`;
console.log(`boot${FAST ? ' (unthrottled)' : ' on a throttled 4G phone (1.6 Mbps, 150ms RTT, 4x CPU)'}`);
console.log(`  first contentful paint   ${paint.fcp} ms`);
console.log(`  DOM content loaded       ${paint.domContentLoaded} ms`);
console.log(`  load                     ${paint.load} ms`);
console.log(`  javascript before paint  ${kb(paintJs)} across ${beforePaint.length} files`);
console.log(`  javascript total         ${kb(totalJs)} across ${js.length} files`);
console.log(`\n  heaviest, in order:`);
for (const j of js.slice().sort((a, b) => b.size - a.size).slice(0, 8)) {
  console.log(`    ${String(kb(j.size)).padStart(8)}  ${j.name}${j.blocksPaint ? '   ← before paint' : ''}`);
}
process.exit(0);
