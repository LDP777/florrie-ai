/**
 * Render a screen the way Ellie sees it: mounted in a real browser, with data.
 *
 * shoot-screens.mjs renders through react-dom/server, which runs one pass and
 * never runs an effect, so every data-driven screen is captured in its LOADING
 * state. That is a real hole, not a nitpick: the booking page's prices were
 * rendering in Playfair with old-style figures on the page Ellie's clients pay
 * through, and check-numerals called all 79 pages clean, because the price list
 * does not exist until a fetch resolves. Levi found it by looking at his phone.
 *
 * This mounts the actual app bundle in Chromium with window.fetch answered from
 * scripts/lib/fixtures.mjs, so effects run and the screen fills in.
 *
 *   npm run build && node scripts/shoot-live.mjs /book/ellindigo
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import http from 'node:http';
import { launch } from './lib/browser.mjs';
import { fetchStubSource, sessionSeedSource, bundleSupabaseUrl, WRONG_SCREEN_PROBE } from './lib/fixtures.mjs';

const DIST = new URL('../dist', import.meta.url).pathname;
const OUT = new URL('../shots', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('✗ no dist/. Run `npm run build` first.');
  process.exit(1);
}

const routes = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (!routes.length) routes.push('/book/ellindigo');

const MIME = { '.js':'text/javascript', '.css':'text/css', '.html':'text/html', '.svg':'image/svg+xml',
  '.png':'image/png', '.woff2':'font/woff2', '.json':'application/json', '.ico':'image/x-icon' };

const server = http.createServer((req, res) => {
  const p = decodeURIComponent((req.url || '/').split('?')[0]);
  let f = join(DIST, p);
  if (!existsSync(f) || !extname(f)) f = join(DIST, 'index.html');
  try { res.setHeader('content-type', MIME[extname(f)] || 'text/html'); res.end(readFileSync(f)); }
  catch { res.statusCode = 404; res.end(''); }
}).listen(0);
const port = server.address().port;

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

// Before any app code runs. The app reads API_BASE at module scope, so the
// stub has to be in place before the bundle evaluates, not after.
await ctx.addInitScript(fetchStubSource());
// Read out of the BUILD, not out of the environment. The storage key
// supabase-js reads is derived from the project ref in this URL, so guessing
// it seeds a key nobody looks at, the app decides nobody is signed in, and
// every signed-in route is photographed as the sign-in form. That is what this
// line did until now: `node scripts/shoot-live.mjs /pricing` with no
// VITE_SUPABASE_URL exported produced a picture of the login page, captioned
// "pricing", with no warning of any kind.
await ctx.addInitScript(sessionSeedSource(bundleSupabaseUrl(DIST)));

const page = await ctx.newPage();
const PUBLIC = new Set(['/terms', '/privacy', '/login', '/support', '/data-deletion']);
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 120)));

const written = [];
for (const route of routes) {
  await page.goto(`http://127.0.0.1:${port}${route}`, { waitUntil: 'domcontentloaded' });
  // Effects, then their state updates, then paint.
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  const name = route.replace(/^\//, '').replace(/\//g, '-') || 'root';
  const file = join(OUT, `live-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });

  // Say so, loudly, rather than handing over a mislabelled picture. A wrong
  // screenshot is worse than a missing one: it gets looked at, believed, and
  // decisions get made off it.
  const wrong = await page.evaluate(`(${WRONG_SCREEN_PROBE})()`);
  written.push(wrong && !PUBLIC.has(route) ? `${file}   ⚠ this is ${wrong}, not ${route}` : file);
}

await browser.close();
server.close();

console.log(`wrote ${written.length} screenshot(s) of populated screens`);
for (const w of written) console.log('  ' + w);
if (errors.length) {
  console.log('\n  page errors while rendering (may be unrelated to the shot):');
  for (const e of [...new Set(errors)].slice(0, 5)) console.log('    ' + e);
}
process.exit(0);
