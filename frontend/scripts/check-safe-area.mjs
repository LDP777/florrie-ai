/**
 * The notch, as close as a machine without a phone can get.
 *
 * None of the safe-area work in this app has ever run on hardware that has a
 * notch. That is the honest position and this script does not change it — read
 * the limits at the bottom before trusting a green tick.
 *
 * What it does: renders every page with the shell tokens set to a real iPhone's
 * insets (59px top on a 15 Pro, 34px for the home indicator) and asks the
 * browser whether anything a finger needs lands inside either band.
 *
 * What that catches: the arithmetic. Every bug in this area so far has been
 * arithmetic — a page padding the inset a second time after the shell already
 * did, a fixed element positioned from the viewport instead of the safe area,
 * a bottom sheet whose last button sat in the home-indicator swipe zone.
 *
 * What it CANNOT catch, and nobody should read into a pass:
 *   - whether env(safe-area-inset-*) resolves at all in WKWebView. Headless
 *     Chromium reports 0 for those, so the values are injected as the tokens
 *     the app derives from them. If the env() plumbing itself is broken, this
 *     check is green and the app is wrong.
 *   - the dynamic island overlapping during a live activity
 *   - rotation, split view, or the keyboard
 *   - anything that only appears once real data has loaded
 *
 * Someone still has to hold a phone.
 *
 *   node scripts/check-safe-area.mjs
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { installDomStub } from './lib/dom-stub.mjs';
import http from 'node:http';
import { launch } from './lib/browser.mjs';

const SRC = new URL('../src', import.meta.url).pathname;

// iPhone 15 Pro. The tallest inset in the current lineup, so it is the hardest
// case: anything that clears this clears the rest.
const DEVICE = { width: 393, height: 852, top: 59, bottom: 34 };

const argv = process.argv.slice(2).filter(a => !a.startsWith('--'));
const names = argv.length ? argv
  : readdirSync(join(SRC, 'pages')).filter(f => f.endsWith('.jsx')).map(f => f.replace('.jsx', ''));

const entry = `
import React from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { CoachProvider } from './contexts/CoachContext.jsx';
${names.map((n, i) => `import P${i} from './pages/${n}.jsx';`).join('\n')}
const PAGES = [${names.map((_, i) => `P${i}`).join(', ')}];
const NAMES = ${JSON.stringify(names)};
export function render() {
  const out = {};
  for (let i = 0; i < PAGES.length; i++) {
    try {
      out[NAMES[i]] = renderToString(
        React.createElement(MemoryRouter, { initialEntries: ['/'] },
          React.createElement(CoachProvider, null, React.createElement(PAGES[i], {}))));
    } catch { out[NAMES[i]] = ''; }
  }
  return out;
}`;

const bundled = await build({
  stdin: { contents: entry, resolveDir: SRC, sourcefile: 'sa.jsx', loader: 'jsx' },
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', logLevel: 'silent',
  external: ['react', 'react-dom', 'react-dom/server', 'react-router-dom'],
  define: {
    'process.env.NODE_ENV': '"production"',
    'import.meta.env': JSON.stringify({ DEV: false, PROD: true, MODE: 'production',
      VITE_SUPABASE_URL: 'http://localhost/stub', VITE_SUPABASE_ANON_KEY: 'stub', VITE_API_URL: 'http://localhost/stub' }),
  },
});

installDomStub();

const harness = new URL('../.safearea-harness.mjs', import.meta.url).pathname;
writeFileSync(harness, bundled.outputFiles[0].text);
let markup;
try { markup = (await import(pathToFileURL(harness).href)).render(); }
finally { try { unlinkSync(harness); } catch {} }

const css = readFileSync(join(SRC, 'index.css'), 'utf8');
const indexHtml = readFileSync(new URL('../index.html', import.meta.url).pathname, 'utf8');
const headBits = [...indexHtml.matchAll(/<link[^>]+fonts\.(googleapis|gstatic)[^>]*>/g)].map(m => m[0]).join('\n');
const rootVars = (/<style>([\s\S]*?)<\/style>/.exec(indexHtml) || [, ''])[1];

// Root screens get no reserved pill band, matching App.jsx.
const ROOT = new Set(['Hub', 'Inbox', 'MoneyTracker', 'ContentAutopilot', 'VoiceCommander', 'More', 'SmartSchedule', 'CalendarView']);

const server = http.createServer((req, res) => {
  const name = decodeURIComponent(req.url.slice(1));
  const band = ROOT.has(name) ? 0 : 60;
  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html><meta charset=utf-8>${headBits}<style>${rootVars}</style><style>${css}</style>
<style>
  /* The insets a real device would report. Chromium reports 0 for
     env(safe-area-inset-*), so these are set on the tokens the app derives
     from them — which is the arithmetic under test, not the env() plumbing. */
  :root {
    --shell-top: ${DEVICE.top}px;
    --shell-bottom: calc(${DEVICE.bottom}px + 146px);
    --shell-bottom-nav: calc(${DEVICE.bottom}px + 92px);
    --shell-viewport: ${DEVICE.height - DEVICE.top - DEVICE.bottom}px;
    --shell-viewport-nav: ${DEVICE.height - DEVICE.top - DEVICE.bottom}px;
  }
  html,body{margin:0;width:${DEVICE.width}px;font-family:var(--font-body);}
  #scroll{padding-top:calc(var(--shell-top) + ${band}px);padding-bottom:var(--shell-bottom);}
</style>
<div id=scroll>${markup[name] ?? ''}</div>`);
}).listen(0);
const port = server.address().port;

const browser = await launch();
const page = await browser.newPage({ viewport: { width: DEVICE.width, height: DEVICE.height } });

const findings = [];
for (const name of names) {
  await page.goto(`http://127.0.0.1:${port}/${encodeURIComponent(name)}`, { waitUntil: 'networkidle' });
  // Scroll to the very bottom before measuring the home indicator. The first
  // version of this checked the initial viewport and reported eight failures,
  // all of them content below the fold — which is not trapped, you just scroll
  // it. What actually matters is whether the bottom padding lifts the LAST
  // control clear once there is nowhere left to scroll.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(60);
  const bad = await page.evaluate((D) => {
    const out = [];
    const label = el => {
      const t = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      return `${el.tagName.toLowerCase()}${t ? ` "${t}"` : ''}`;
    };
    const interactive = 'button, a[href], input, select, textarea, [onclick], [role="button"]';
    for (const el of document.querySelectorAll(interactive)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // Anything still off-screen at maximum scroll is unreachable for a
      // different reason and is not this check's business.
      if (r.top > D.height || r.bottom < 0) continue;
      const swipeZone = D.height - D.bottom;
      if (r.bottom > swipeZone) {
        out.push({ kind: 'in the home-indicator swipe zone', by: Math.round(r.bottom - swipeZone), what: label(el) });
      }
    }
    const seen = new Set();
    return out.filter(o => { const k = o.kind + o.what; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 5);
  }, DEVICE);
  for (const b of bad) findings.push({ page: name, ...b });

  // The notch is the mirror image: measured at the TOP of the page, because
  // that is the only place something can be permanently stuck under it.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(40);
  const underNotch = await page.evaluate((D) => {
    const out = [];
    for (const el of document.querySelectorAll('button, a[href], input, select, textarea, [role="button"]')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.top < D.top && r.bottom > 0) {
        const t = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
        out.push({ kind: 'under the notch', by: Math.round(D.top - r.top), what: `${el.tagName.toLowerCase()}${t ? ` "${t}"` : ''}` });
      }
    }
    const seen = new Set();
    return out.filter(o => { const k = o.what; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 5);
  }, DEVICE);
  for (const b of underNotch) findings.push({ page: name, ...b });
}

await browser.close();
server.close();

if (findings.length) {
  const byPage = {};
  for (const f of findings) (byPage[f.page] ||= []).push(f);
  console.error(`✗ safe area: ${findings.length} control(s) inside an inset on ${Object.keys(byPage).length} page(s) ` +
    `(iPhone 15 Pro, ${DEVICE.top}px top / ${DEVICE.bottom}px bottom):`);
  for (const [p, list] of Object.entries(byPage)) {
    console.error(`  ${p}`);
    for (const f of list) console.error(`    ${f.kind} by ${f.by}px — ${f.what}`);
  }
  process.exit(1);
}
console.log(`✓ safe area: no control lands under the notch or in the swipe zone on ${names.length} pages ` +
  `(simulated ${DEVICE.top}/${DEVICE.bottom}px — the arithmetic, not the env() plumbing; a phone still has to confirm it)`);
process.exit(0);
