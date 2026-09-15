/**
 * Check that configured error reporting loads after first paint, while the
 * disabled product-analytics SDK is absent from the release build.
 * Run after the frontend build. No signed-in session or real data is used.
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

// A named vendor chunk can exist even when no DSN is configured. Inspect
// the application entry point so SDK-internal strings cannot imply a DSN.
const { readdirSync } = await import('node:fs');
const assets = readdirSync(join(DIST, 'assets'));
// Only the APP chunk. Vite inlines import.meta.env values there, and scanning
// the vendor chunks instead matches the Sentry SDK's own references to
// sentry.io — which reported a DSN as configured on a build that had none.
const bundleJs = assets.filter(f => /^index-.*\.js$/.test(f))
  .map(f => readFileSync(join(DIST, 'assets', f), 'utf8')).join('\n');

// Optional product analytics were disabled on 15 September 2026.
// A recording SDK must not return through a manually included vendor chunk.
if (assets.some(f => /posthog.*\.js$/.test(f))) {
  throw new Error('Optional analytics SDK is present in the release build');
}

const expect = [
  { name: 'sentry', re: /sentry.*\.js$/, configured: /https:\/\/[a-z0-9]+@[a-z0-9.]*sentry\.io/.test(bundleJs) },
].filter(e => assets.some(f => e.re.test(f)) && e.configured);

if (!expect.length) {
  console.log('… deferred: no Sentry DSN is configured; no reporting chunk should load.');
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
