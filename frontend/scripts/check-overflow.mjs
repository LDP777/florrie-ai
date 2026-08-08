/**
 * Find text the phone cannot show.
 *
 * "So much text is hidden now" was the report, and the two screenshots that
 * came with it showed titles under the Back pill — fixed, and checked by
 * check-chrome.mjs. But that is one way for text to disappear and it is not the
 * only one. Content wider than 390px is silently cropped by the shell's
 * overflow-x: hidden, and a `whiteSpace: nowrap` on a long label clips without
 * a scrollbar or a warning of any kind.
 *
 * So this renders every page at a real iPhone width and asks the browser which
 * boxes stick out past it, and which text nodes are clipped by their own
 * container. No opinion involved: getBoundingClientRect against the viewport,
 * scrollWidth against clientWidth.
 *
 * First paint only — fetch is stubbed, so a page in its loading state has
 * little to overflow. It catches static chrome, headers, tab strips and
 * anything laid out before data arrives.
 *
 *   node scripts/check-overflow.mjs            # every page
 *   node scripts/check-overflow.mjs Settings   # one
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { installDomStub } from './lib/dom-stub.mjs';
import http from 'node:http';
import { launch } from './lib/browser.mjs';

const SRC = new URL('../src', import.meta.url).pathname;
const WIDTH = 390;
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
  stdin: { contents: entry, resolveDir: SRC, sourcefile: 'ov.jsx', loader: 'jsx' },
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', logLevel: 'silent',
  external: ['react', 'react-dom', 'react-dom/server', 'react-router-dom'],
  define: {
    'process.env.NODE_ENV': '"production"',
    'import.meta.env': JSON.stringify({ DEV: false, PROD: true, MODE: 'production',
      VITE_SUPABASE_URL: 'http://localhost/stub', VITE_SUPABASE_ANON_KEY: 'stub', VITE_API_URL: 'http://localhost/stub' }),
  },
});

installDomStub();

const harness = new URL('../.overflow-harness.mjs', import.meta.url).pathname;
writeFileSync(harness, bundled.outputFiles[0].text);
let markup;
try { markup = (await import(pathToFileURL(harness).href)).render(); }
finally { try { unlinkSync(harness); } catch {} }

const css = readFileSync(join(SRC, 'index.css'), 'utf8');
const indexHtml = readFileSync(new URL('../index.html', import.meta.url).pathname, 'utf8');
const headBits = [...indexHtml.matchAll(/<link[^>]+fonts\.(googleapis|gstatic)[^>]*>/g)].map(m => m[0]).join('\n');
const rootVars = (/<style>([\s\S]*?)<\/style>/.exec(indexHtml) || [, ''])[1];

const server = http.createServer((req, res) => {
  const name = decodeURIComponent(req.url.slice(1));
  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html><meta charset=utf-8>${headBits}<style>${rootVars}</style><style>${css}</style>
<style>html,body{margin:0;width:${WIDTH}px;font-family:var(--font-body)}</style>
<div id=root>${markup[name] ?? ''}</div>`);
}).listen(0);
const port = server.address().port;

const browser = await launch();
const page = await browser.newPage({ viewport: { width: WIDTH, height: 844 } });

const findings = [];
for (const name of names) {
  await page.goto(`http://127.0.0.1:${port}/${encodeURIComponent(name)}`, { waitUntil: 'networkidle' });
  const bad = await page.evaluate((W) => {
    const out = [];
    const label = el => {
      const t = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 46);
      return `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''}${t ? ` "${t}"` : ''}`;
    };
    for (const el of document.querySelectorAll('#root *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;

      // 1. sticks out past the right edge of the phone
      if (r.right > W + 1) {
        // A deliberately scrollable strip is fine — that is a tab rail.
        const s = getComputedStyle(el.parentElement || el);
        const scrollable = /auto|scroll/.test(s.overflowX);
        if (!scrollable) out.push({ kind: 'past the right edge', by: Math.round(r.right - W), what: label(el) });
      }

      // 2. its own text is wider than it is, with nothing to reveal it
      if (el.children.length === 0 && el.scrollWidth > el.clientWidth + 1) {
        const s = getComputedStyle(el);
        const hidden = s.overflow === 'hidden' || s.overflowX === 'hidden';
        const ellipsis = s.textOverflow === 'ellipsis';
        if (hidden && !ellipsis) out.push({ kind: 'clipped with no ellipsis', by: el.scrollWidth - el.clientWidth, what: label(el) });
      }
    }
    // De-duplicate: a wide child usually drags its parents out too, and one
    // report per real problem is the difference between a check people read
    // and a wall people skip.
    const seen = new Set();
    return out.filter(o => { const k = o.kind + o.what; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 6);
  }, WIDTH);
  for (const b of bad) findings.push({ page: name, ...b });
}

await browser.close();
server.close();

if (findings.length) {
  const byPage = {};
  for (const f of findings) (byPage[f.page] ||= []).push(f);
  console.log(`${findings.length} overflow(s) at ${WIDTH}px across ${Object.keys(byPage).length} page(s):`);
  for (const [p, list] of Object.entries(byPage)) {
    console.log(`  ${p}`);
    for (const f of list) console.log(`    ${f.kind} by ${f.by}px — ${f.what}`);
  }
} else {
  console.log(`✓ overflow: nothing renders past ${WIDTH}px and no text is clipped without an ellipsis`);
}
process.exit(0);
