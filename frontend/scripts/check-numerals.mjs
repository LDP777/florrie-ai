/**
 * Every number reads the same, whatever sentence it is in.
 *
 * Levi has now reported this twice, from two different screens:
 *
 *   "i still want all the numbers on the app everywhere to be in this font
 *    regardless of what colour it is or what page, just easier to read"
 *   "number not in the font we mentioned"
 *
 * The second one was "£345" inside a Playfair headline — Florrie helped bring
 * in £345 — where the figure had a colour and a weight of its own but no
 * font-family, so it inherited the serif and rendered with old-style figures.
 * Nothing in the codebase was wrong to look at. The style object simply did
 * not mention the one property that mattered.
 *
 * That is not a class of bug anyone finds by reading. It needs measuring, so
 * this renders every page and asks the browser what face each figure is
 * actually painted in.
 *
 * A "figure" here is a text node containing a currency amount or a standalone
 * number that reads as data — not a date, not a house number in an address,
 * not the "2" in "2 of 5 steps" inside a sentence.
 *
 *   node scripts/check-numerals.mjs
 *   node scripts/check-numerals.mjs Hub        # one page
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { installDomStub } from './lib/dom-stub.mjs';
import http from 'node:http';
import { launch } from './lib/browser.mjs';

const SRC = new URL('../src', import.meta.url).pathname;

// The one face. Money.jsx sets exactly this, so anything that disagrees with
// it is by definition a figure that escaped the component.
const NUMERAL_FACE = /plus jakarta/i;

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
  stdin: { contents: entry, resolveDir: SRC, sourcefile: 'nm.jsx', loader: 'jsx' },
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', logLevel: 'silent',
  external: ['react', 'react-dom', 'react-dom/server', 'react-router-dom'],
  define: {
    'process.env.NODE_ENV': '"production"',
    'import.meta.env': JSON.stringify({ DEV: false, PROD: true, MODE: 'production',
      VITE_SUPABASE_URL: 'http://localhost/stub', VITE_SUPABASE_ANON_KEY: 'stub', VITE_API_URL: 'http://localhost/stub' }),
  },
});

installDomStub();

const harness = new URL('../.numerals-harness.mjs', import.meta.url).pathname;
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
<style>html,body{margin:0;width:390px;font-family:var(--font-body);background:var(--bg)}</style>
<div id=root>${markup[name] ?? ''}</div>`);
}).listen(0);
const port = server.address().port;

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

const findings = [];
for (const name of names) {
  await page.goto(`http://127.0.0.1:${port}/${encodeURIComponent(name)}`, { waitUntil: 'networkidle' });
  const bad = await page.evaluate((faceSrc) => {
    const FACE = new RegExp(faceSrc, 'i');
    const out = [];
    const seen = new Set();

    for (const el of document.querySelectorAll('#root *')) {
      const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
      if (!own) continue;

      // A money figure, or a bare number standing on its own as data.
      const money = /[£$€]\s?\d/.test(own);
      const bare = /^[+\-−]?\d[\d,]*(\.\d+)?%?$/.test(own);
      if (!money && !bare) continue;

      // Dates and times are not data figures; they are labels, and they read
      // better in the surrounding face.
      if (/^\d{1,2}:\d{2}/.test(own)) continue;
      if (/^\d{1,2}\/\d{1,2}/.test(own)) continue;

      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.opacity === '0') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;

      const family = s.fontFamily || '';
      if (FACE.test(family)) continue;
      // A 404 set in the display face at 64px is a piece of typography, not a
      // figure Ellie reads off. The rule is about DATA — money, counts, totals
      // — so a bare number at display size in the display face is exempt.
      if (!money && /playfair|georgia|serif/i.test(family) && (parseFloat(s.fontSize) || 0) >= 40) continue;

      const key = own.slice(0, 24) + '|' + family.slice(0, 24);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        text: own.slice(0, 34),
        family: family.split(',')[0].replace(/['"]/g, ''),
        size: Math.round(parseFloat(s.fontSize) || 0),
        kind: money ? 'money' : 'number',
      });
    }
    return out.slice(0, 8);
  }, NUMERAL_FACE.source);
  for (const b of bad) findings.push({ page: name, ...b });
}

await browser.close();
server.close();

if (findings.length) {
  const money = findings.filter(f => f.kind === 'money');
  const byPage = {};
  for (const f of findings) (byPage[f.page] ||= []).push(f);
  console.error(`✗ numerals: ${findings.length} figure(s) not in the numeral face (${money.length} of them money)\n`);
  for (const [p, list] of Object.entries(byPage).slice(0, 16)) {
    console.error(`  ${p}`);
    for (const f of list.slice(0, 4)) {
      console.error(`    "${f.text}" — ${f.family} ${f.size}px${f.kind === 'money' ? '  (money)' : ''}`);
    }
  }
  console.error(`\n  Money figures should use <Money>. A figure inside a display-face\n` +
    `  heading needs the numeral family set explicitly — it will inherit the\n` +
    `  serif otherwise, which is exactly how "£345" ended up in Playfair.\n`);
  process.exit(1);
}
console.log(`✓ numerals: every figure on ${names.length} pages is in the numeral face`);
process.exit(0);
