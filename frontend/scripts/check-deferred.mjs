/**
 * Prove the deferred chunks still arrive.
 *
 * PostHog and Sentry were moved behind first paint, which took 340 KB and
 * ~110 ms off the boot Ellie waits through. The risk in that change is not a
 * crash — it is silence. If the scheduling is wrong the chunks simply never
 * load, no error is thrown, and the first anyone knows is a dashboard that has
 * been empty for a month.
 *
 * That is not hypothetical. Two implementations of afterPaint() shipped past a
 * green build and a passing render check while loading NEITHER chunk:
 * requestIdleCallback (absent on iOS, and discarded by the boot redirect), and
 * waiting for `load` (which never fires when the Google Fonts request stalls).
 * Both were caught only by watching the network.
 *
 * So this loads the real build and watches.
 *
 *   npm run build && node scripts/check-deferred.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import http from 'node:http';
import { launch } from './lib/browser.mjs';

const DIST = new URL('../dist', import.meta.url).pathname;
if (!existsSync(join(DIST, 'index.html'))) {
  console.error('✗ deferred: no dist/. Run `npm run build` first.');
  process.exit(1);
}

// Whether a chunk is EXPECTED to load has nothing to do with whether its file
// exists. vite.config declares posthog and sentry in manualChunks, so both
// chunks are emitted on every build regardless of configuration — but the code
// only imports them when a key or DSN is present. Keying the precondition off
// the filename made this fail in CI, where the build runs without a PostHog
// key: the chunk was there, nothing imported it, and the check called that a
// scheduling bug. It was correct behaviour.
//
// So the precondition is the KEY, read out of the built bundle.
const { readdirSync } = await import('node:fs');
const assets = readdirSync(join(DIST, 'assets'));
// Only the APP chunk. Vite inlines import.meta.env values there, and scanning
// the vendor chunks instead matches the Sentry SDK's own references to
// sentry.io — which reported a DSN as configured on a build that had none.
const bundleJs = assets.filter(f => /^index-.*\.js$/.test(f))
  .map(f => readFileSync(join(DIST, 'assets', f), 'utf8')).join('\n');

const expect = [
  { name: 'posthog', re: /posthog.*\.js$/, configured: /["']phc_[A-Za-z0-9_-]+["']/.test(bundleJs) },
  { name: 'sentry', re: /sentry.*\.js$/, configured: /https:\/\/[a-z0-9]+@[a-z0-9.]*sentry\.io/.test(bundleJs) },
].filter(e => assets.some(f => e.re.test(f)) && e.configured);

if (!expect.length) {
  console.log('… deferred: this build has no PostHog key and no Sentry DSN, so neither');
  console.log('  chunk is meant to load. Nothing to prove — set VITE_POSTHOG_KEY and');
  console.log('  VITE_SENTRY_DSN to exercise the deferral properly.');
  process.exit(0);
}

const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
const server = http.createServer((req, res) => {
  const p = (req.url || '/').split('?')[0];
  let f = join(DIST, p === '/' ? 'index.html' : p);
  if (!existsSync(f) || p === '/') f = join(DIST, 'index.html');
  try { res.setHeader('content-type', MIME[extname(f)] || 'application/octet-stream'); res.end(readFileSync(f)); }
  catch { res.statusCode = 404; res.end(''); }
}).listen(0);

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const seen = new Set();
page.on('response', r => {
  const n = r.url().split('/').pop().split('?')[0];
  if (/\.js$/.test(n)) seen.add(n);
});

// /terms renders without a session. Booting at / bounces to the marketing page
// and that hard navigation cancels the pending imports — which is a fact about
// an unauthenticated test, not about the app, and would make this check fail
// for the wrong reason every time.
await page.goto(`http://127.0.0.1:${server.address().port}/terms`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);

await browser.close();
server.close();

const missing = expect.filter(e => ![...seen].some(n => e.re.test(n)));
if (missing.length) {
  console.error(`✗ deferred: ${missing.map(m => m.name).join(' and ')} never loaded after first paint.\n` +
    `  The chunk is in the build but nothing fetched it, so it is scheduled wrong.\n` +
    `  See src/lib/after-paint.js — two previous attempts failed exactly here.\n`);
  process.exit(1);
}
console.log(`✓ deferred: ${expect.map(e => e.name).join(' and ')} load after first paint, not before it`);
process.exit(0);
