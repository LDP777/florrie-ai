/**
 * Take a picture of a screen.
 *
 * Every visual claim in this work so far has been an argument: the band is
 * reserved, the icons resolve, the figures inherit their size. Ellie's two
 * screenshots landed because nobody had looked. This renders a page's real
 * markup with the real stylesheet at real phone dimensions, draws the floating
 * chrome where the shell actually puts it, and writes a PNG.
 *
 * It is a first-paint picture: fetch is stubbed, so pages appear in their
 * loading or empty state. That is enough to see whether a title is underneath
 * the Back pill, whether an icon is a word, or whether a figure is the wrong
 * size — which is every regression that has reached her.
 *
 *   node scripts/shoot-screens.mjs Settings ValueBreakdown MoneyTracker
 *   node scripts/shoot-screens.mjs --all
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { installDomStub } from './lib/dom-stub.mjs';
import http from 'node:http';
import { launch } from './lib/browser.mjs';

const SRC = new URL('../src', import.meta.url).pathname;
const OUT = new URL('../shots', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const argv = process.argv.slice(2).filter(a => !a.startsWith('--'));
const ALL = process.argv.includes('--all');
const DARK = process.argv.includes('--dark');
const names = ALL
  ? readdirSync(join(SRC, 'pages')).filter(f => f.endsWith('.jsx')).map(f => f.replace('.jsx', ''))
  : (argv.length ? argv : ['Settings', 'ValueBreakdown', 'MoneyTracker', 'Treatments', 'Hub']);

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
    } catch (err) { out[NAMES[i]] = '<div style="padding:40px;color:#9E2B32">did not render: ' + String(err.message) + '</div>'; }
  }
  return out;
}
`;

const bundle = await build({
  stdin: { contents: entry, resolveDir: SRC, sourcefile: 'shoot.jsx', loader: 'jsx' },
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', logLevel: 'silent',
  external: ['react', 'react-dom', 'react-dom/server', 'react-router-dom'],
  define: {
    'process.env.NODE_ENV': '"production"',
    'import.meta.env': JSON.stringify({ DEV: false, PROD: true, MODE: 'production',
      VITE_SUPABASE_URL: 'http://localhost/stub', VITE_SUPABASE_ANON_KEY: 'stub', VITE_API_URL: 'http://localhost/stub' }),
  },
});

installDomStub();

const harness = new URL('../.shoot-harness.mjs', import.meta.url).pathname;
writeFileSync(harness, bundle.outputFiles[0].text);
let html;
try { html = (await import(pathToFileURL(harness).href)).render(); }
finally { try { unlinkSync(harness); } catch {} }

const css = readFileSync(join(SRC, 'index.css'), 'utf8');
const indexHtml = readFileSync(new URL('../index.html', import.meta.url).pathname, 'utf8');
// Reuse the app's own font links and :root token block so the picture uses the
// real typefaces rather than whatever the headless browser falls back to.
const headBits = [...indexHtml.matchAll(/<link[^>]+fonts\.(googleapis|gstatic)[^>]*>/g)].map(m => m[0]).join('\n');
const rootVars = (/<style>([\s\S]*?)<\/style>/.exec(indexHtml) || [, ''])[1];

// Dark mode is applied at runtime by theme.jsx writing to documentElement.style,
// which a static render never executes. So the token map is read out of the
// source and written into :root here — the same values, the same way round.
let darkCss = '';
if (DARK) {
  const theme = readFileSync(join(SRC, 'lib/theme.jsx'), 'utf8');
  const start = theme.indexOf('const darkTokens = {');
  const end = theme.indexOf('\n};', start);
  const body = theme.slice(start, end);
  const decls = [...body.matchAll(/'(--[\w-]+)':\s*'([^']*)'/g)].map(m => `${m[1]}:${m[2]}`).join(';');
  darkCss = `:root{${decls}} html,body{color-scheme:dark}`;
}

// The shell, as App.jsx builds it: the scroll region reserves the pill band,
// and the pills are fixed on top. Getting this wrong would make the picture
// lie in exactly the place the bug was.
// Root screens show only the More pill and get NO reserved band — App.jsx
// excludes them, because their headers are left-aligned and 60px there would
// just be dead cream above the greeting. Drawing the Back pill on Hub would
// make this tool lie in exactly the place the bug was.
const ROOT = new Set(['Hub', 'Inbox', 'MoneyTracker', 'ContentAutopilot', 'VoiceCommander', 'More', 'SmartSchedule', 'CalendarView']);
const page = (name, body) => `<!doctype html><meta charset=utf-8>
<meta name=viewport content="width=390,initial-scale=1">
${headBits}
<style>${rootVars}</style>
<style>${css}</style>
<style>${darkCss}</style>
<style>
  html,body{margin:0;background:var(--bg,#FBF6F1);font-family:var(--font-body);}
  #shell{position:relative;width:390px;min-height:844px;overflow:hidden;}
  #scroll{padding-top:60px;padding-bottom:146px;}
  .pill{position:fixed;top:12px;height:44px;display:flex;align-items:center;gap:6px;
    padding:0 12px;border-radius:999px;background:rgba(255,255,255,.98);
    border:1px solid rgba(146,64,94,.12);box-shadow:0 2px 8px rgba(146,64,94,.1);
    color:#92405e;font-size:12px;font-weight:600;z-index:900;}
  #back{left:14px} #more{right:14px}
  #label{position:fixed;bottom:0;left:0;right:0;background:#241B17;color:#FBF6F1;
    font:600 11px/28px ui-monospace,monospace;text-align:center;z-index:999;letter-spacing:.06em}
</style>
<div id=shell><div id=scroll style="padding-top:${ROOT.has(name) ? 0 : 60}px">${body}</div>
  ${ROOT.has(name) ? '' : '<div class="pill" id=back>‹ Back</div>'}<div class="pill" id=more>More</div>
  <div id=label>${name}${ROOT.has(name) ? ' · root, no back pill, no band' : ' · band reserved'}</div>
</div>`;

const server = http.createServer((req, res) => {
  const name = decodeURIComponent(req.url.slice(1)) || names[0];
  res.setHeader('content-type', 'text/html');
  res.end(page(name, html[name] ?? '<p>no such page</p>'));
}).listen(0);
const port = server.address().port;

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const pg = await ctx.newPage();

const written = [];
for (const name of names) {
  await pg.goto(`http://127.0.0.1:${port}/${encodeURIComponent(name)}`, { waitUntil: 'networkidle' });
  await pg.evaluate(() => document.fonts?.ready);
  const file = join(OUT, `${name}${DARK ? '-dark' : ''}.png`);
  await pg.screenshot({ path: file, fullPage: false });
  written.push(file);
}

await browser.close();
server.close();
console.log(`wrote ${written.length} screenshot(s) to shots/`);
for (const w of written) console.log('  ' + w);
process.exit(0);
