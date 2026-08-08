/**
 * Text you cannot read.
 *
 * Contrast is the one visual property that is fully objective — WCAG gives a
 * formula, the browser gives the colours, and there is nothing to argue about.
 * It is also the one nobody checks, because in the light palette almost
 * everything passes and the eye stops looking.
 *
 * Dark mode is where it falls over. The dark token map exists, has never been
 * reachable in practice (theme.jsx starts at light, does not persist and does
 * not read prefers-color-scheme), and so has never been looked at. The first
 * two screens rendered in it showed the floating Back/More pills still painted
 * a hardcoded rgba(255,255,255,0.98), and the AI suggestion card's gradient
 * running to near-white underneath light-grey body text.
 *
 * So this measures every text node against what is actually painted behind it,
 * in both palettes.
 *
 * Honest limits:
 *   - the backdrop is resolved by walking up for the first non-transparent
 *     background. A gradient is sampled at the element's own midpoint, which is
 *     right for a flat run of text and approximate across a steep gradient.
 *   - first paint only, so loaded-state text is not covered.
 *   - it says nothing about whether a colour is TASTEFUL, only whether the
 *     words can be read.
 *
 *   node scripts/check-contrast.mjs             # both palettes, every page
 *   node scripts/check-contrast.mjs --dark      # dark only
 *   node scripts/check-contrast.mjs Campaigns   # one page
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

// WCAG 2.1 AA: 4.5:1 for body text, 3:1 for large text (>=24px, or >=18.66px
// bold). Below 3:1 is not a judgement call, it is unreadable.
const AA_BODY = 4.5;
const AA_LARGE = 3.0;

const argv = process.argv.slice(2).filter(a => !a.startsWith('--'));
const names = argv.length ? argv
  : readdirSync(join(SRC, 'pages')).filter(f => f.endsWith('.jsx')).map(f => f.replace('.jsx', ''));
const MODES = process.argv.includes('--dark') ? ['dark']
  : process.argv.includes('--light') ? ['light'] : ['light', 'dark'];

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
  stdin: { contents: entry, resolveDir: SRC, sourcefile: 'ct.jsx', loader: 'jsx' },
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', logLevel: 'silent',
  external: ['react', 'react-dom', 'react-dom/server', 'react-router-dom'],
  define: {
    'process.env.NODE_ENV': '"production"',
    'import.meta.env': JSON.stringify({ DEV: false, PROD: true, MODE: 'production',
      VITE_SUPABASE_URL: 'http://localhost/stub', VITE_SUPABASE_ANON_KEY: 'stub', VITE_API_URL: 'http://localhost/stub' }),
  },
});

installDomStub();

const harness = new URL('../.contrast-harness.mjs', import.meta.url).pathname;
writeFileSync(harness, bundled.outputFiles[0].text);
let markup;
try { markup = (await import(pathToFileURL(harness).href)).render(); }
finally { try { unlinkSync(harness); } catch {} }

const css = readFileSync(join(SRC, 'index.css'), 'utf8');
const indexHtml = readFileSync(new URL('../index.html', import.meta.url).pathname, 'utf8');
const headBits = [...indexHtml.matchAll(/<link[^>]+fonts\.(googleapis|gstatic)[^>]*>/g)].map(m => m[0]).join('\n');
const rootVars = (/<style>([\s\S]*?)<\/style>/.exec(indexHtml) || [, ''])[1];

// theme.jsx applies its token map at runtime by writing to documentElement.style,
// which a static render never runs. Read the map out of the source so the check
// cannot drift from the palette it is checking.
function tokenCss(which) {
  const theme = readFileSync(join(SRC, 'lib/theme.jsx'), 'utf8');
  const marker = which === 'dark' ? 'const darkTokens = {' : 'const lightTokens = {';
  const start = theme.indexOf(marker);
  if (start === -1) return '';
  const body = theme.slice(start, theme.indexOf('\n};', start));
  const decls = [...body.matchAll(/'(--[\w-]+)':\s*'([^']*)'/g)].map(m => `${m[1]}:${m[2]}`).join(';');
  return `:root{${decls}}`;
}

const server = http.createServer((req, res) => {
  const [name, mode] = decodeURIComponent(req.url.slice(1)).split('|');
  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html><meta charset=utf-8>${headBits}<style>${rootVars}</style><style>${css}</style>
<style>${tokenCss(mode)}</style>
<style>html,body{margin:0;width:${WIDTH}px;font-family:var(--font-body);background:var(--bg)}</style>
<div id=root>${markup[name] ?? ''}</div>`);
}).listen(0);
const port = server.address().port;

const browser = await launch();
const page = await browser.newPage({ viewport: { width: WIDTH, height: 844 } });

const findings = [];
for (const mode of MODES) {
  for (const name of names) {
    await page.goto(`http://127.0.0.1:${port}/${encodeURIComponent(name + '|' + mode)}`, { waitUntil: 'networkidle' });
    const bad = await page.evaluate(([AA_BODY, AA_LARGE]) => {
      const parse = (c) => {
        const m = /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\)/.exec(c || '');
        return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
      };
      const lum = ({ r, g, b }) => {
        const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const ratio = (fg, bg) => {
        const a = lum(fg), b2 = lum(bg);
        return (Math.max(a, b2) + 0.05) / (Math.min(a, b2) + 0.05);
      };
      const over = (fg, bg) => ({           // flatten a translucent colour onto its backdrop
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1,
      });

      // Walk up for the first thing that actually paints. A gradient is sampled
      // as its own mid-stop, which is right for a flat run of text and only
      // approximate across a steep one — noted in the report.
      const backdrop = (el) => {
        let n = el, approx = false;
        while (n && n !== document.documentElement) {
          const s = getComputedStyle(n);
          if (s.backgroundImage && s.backgroundImage !== 'none') {
            const stops = [...s.backgroundImage.matchAll(/rgba?\([^)]+\)/g)].map(m => parse(m[0])).filter(Boolean);
            if (stops.length) {
              approx = true;
              const mid = stops[Math.floor(stops.length / 2)];
              return { colour: mid, approx };
            }
          }
          const bg = parse(s.backgroundColor);
          if (bg && bg.a > 0.95) return { colour: bg, approx };
          if (bg && bg.a > 0) { const under = backdrop(n.parentElement || document.body); return { colour: over(bg, under.colour), approx: true }; }
          n = n.parentElement;
        }
        return { colour: { r: 255, g: 255, b: 255, a: 1 }, approx };
      };

      const out = [];
      const seen = new Set();
      for (const el of document.querySelectorAll('#root *')) {
        // Only elements that render their own text.
        const text = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' ').trim();
        if (!text) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const s = getComputedStyle(el);
        if (s.visibility === 'hidden' || s.opacity === '0') continue;
        // WCAG 1.4.3 exempts inactive controls, and it is right to: a greyed
        // day in a month picker is grey ON PURPOSE, and forcing it to 4.5:1
        // would make it look enabled. Without this the check reports the
        // disabled state of every calendar as a defect.
        if (el.closest('[disabled], [aria-disabled="true"], .is-disabled')) continue;

        const fg = parse(s.color);
        if (!fg) continue;
        // `color: transparent` is deliberate — a skeleton placeholder holding
        // layout, an icon-only label. Invisible on purpose is not a contrast
        // failure, and reporting it teaches people to ignore the report.
        if (fg.a === 0) continue;
        // Start the walk at the element ITSELF, not its parent. A button
        // paints its own background under its own label, and starting a level
        // up measured "Draft it for me" against the card behind the button —
        // reporting 1.13:1 for white-on-maroon, which is fine. Both of this
        // check's first two findings were that mistake.
        const bd = backdrop(el);
        const flat = fg.a < 1 ? over(fg, bd.colour) : fg;
        const size = parseFloat(s.fontSize) || 16;
        const weight = parseInt(s.fontWeight, 10) || 400;
        const large = size >= 24 || (size >= 18.66 && weight >= 700);
        const need = large ? AA_LARGE : AA_BODY;
        const got = ratio(flat, bd.colour);
        if (got >= need) continue;

        const key = `${text.slice(0, 30)}|${Math.round(got * 10)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const hex = c => '#' + [c.r, c.g, c.b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
        out.push({
          text: text.slice(0, 46), ratio: Math.round(got * 100) / 100, need,
          size: Math.round(size), approx: bd.approx,
          fg: hex(flat), bg: hex(bd.colour), rawColor: s.color,
        });
      }
      return out.sort((a, b) => a.ratio - b.ratio).slice(0, 6);
    }, [AA_BODY, AA_LARGE]);
    for (const b of bad) findings.push({ page: name, mode, ...b });
  }
}

await browser.close();
server.close();

// Below 3:1 nothing is arguable — that is not "a bit low", it is not readable.
const severe = findings.filter(f => f.ratio < 3);
const marginal = findings.filter(f => f.ratio >= 3);

if (findings.length) {
  const byMode = {};
  for (const f of findings) (byMode[f.mode] ||= []).push(f);
  console.error(`✗ contrast: ${findings.length} text node(s) below WCAG AA (${severe.length} below 3:1, which is unreadable)`);
  for (const [mode, list] of Object.entries(byMode)) {
    console.error(`\n  ${mode.toUpperCase()} — ${list.length}`);
    const byPage = {};
    for (const f of list) (byPage[f.page] ||= []).push(f);
    for (const [p, items] of Object.entries(byPage).slice(0, 14)) {
      console.error(`    ${p}`);
      for (const i of items.slice(0, 3)) {
        console.error(`      ${i.ratio}:1 (needs ${i.need}) ${i.size}px ${i.fg} on ${i.bg}${i.approx ? ' ~gradient' : ''} — "${i.text}"`);
      }
    }
  }
  console.error('');
  process.exit(severe.length ? 1 : 0);
}
console.log(`✓ contrast: every text node meets WCAG AA in ${MODES.join(' and ')}`);
process.exit(0);
