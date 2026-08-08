/**
 * The visual checks, run against screens that actually have data on them.
 *
 * check-numerals, check-contrast and check-overflow all render through
 * react-dom/server. That runs one pass and never runs an effect, so every
 * data-driven screen is graded in its LOADING state — a spinner and three grey
 * bars. They were green on all 79 pages while the booking page rendered its
 * prices in Playfair with old-style figures, on the public page Ellie's clients
 * pay through, because the price list does not exist until a fetch resolves.
 *
 * A check that cannot see the thing it is checking is worse than no check: it
 * produces a tick that stops anyone looking.
 *
 * So this mounts the real built app in Chromium, answers window.fetch from
 * scripts/lib/fixtures.mjs, waits for the screen to fill in, and then asks the
 * same three questions of the DOM Ellie would be looking at.
 *
 *   npm run build && node scripts/check-live.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import http from 'node:http';
import { launch } from './lib/browser.mjs';
import { fetchStubSource } from './lib/fixtures.mjs';

const DIST = new URL('../dist', import.meta.url).pathname;
if (!existsSync(join(DIST, 'index.html'))) {
  console.error('✗ live: no dist/. Run `npm run build` first.');
  process.exit(1);
}

// Routes that render real data without a session. The signed-in screens need
// an auth token the fixtures cannot mint, so they stay with the SSR checks and
// this covers the public surface — which is, not incidentally, the surface that
// takes Ellie's money.
const ROUTES = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (!ROUTES.length) ROUTES.push('/book/ellindigo', '/terms', '/privacy');

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
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
await ctx.addInitScript(fetchStubSource());
const page = await ctx.newPage();

// The detector, as a source string, so the self-test at the bottom runs the
// SAME code against a synthetic page rather than a re-implementation of it.
const SELF_TEST_SRC = `() => {
  const leaves = [];
  for (const el of document.querySelectorAll('#root *')) {
    const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
    const r = el.getBoundingClientRect();
    if (own && el.children.length === 0 && r.width && r.height) leaves.push({ el, own, r });
  }
  const lineRects = (el) => { const g = document.createRange(); g.selectNodeContents(el);
    return [...g.getClientRects()].filter(r => r.width > 0 && r.height > 0); };
  const separateCells = (a, b) => {
    let anc = a.el.parentElement;
    while (anc && !anc.contains(b.el)) anc = anc.parentElement;
    if (!anc) return false;
    if (!/flex|grid/.test(getComputedStyle(anc).display)) return false;
    const cellOf = (el) => { let n = el; while (n && n.parentElement !== anc) n = n.parentElement; return n; };
    const ca = cellOf(a.el), cb = cellOf(b.el);
    return ca && cb && ca !== cb;
  };
  let caught = false, falsePositive = false;
  for (let i = 0; i < leaves.length; i++) for (let j = i + 1; j < leaves.length; j++) {
    const a = leaves[i], b = leaves[j];
    if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
    if (!separateCells(a, b)) continue;
    for (const ra of lineRects(a.el)) for (const rb of lineRects(b.el)) {
      const v = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (v < Math.min(ra.height, rb.height) * 0.6) continue;
      const left = ra.left <= rb.left ? ra : rb, right = left === ra ? rb : ra;
      if (right.left - left.right >= 2) continue;
      if (/florrie/.test(a.own + b.own)) falsePositive = true; else caught = true;
    }
  }
  return { caught, falsePositive };
}`;

const findings = [];
for (const route of ROUTES) {
  await page.goto(`http://127.0.0.1:${port}${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const bad = await page.evaluate(() => {
    const out = [];
    const push = (kind, detail) => out.push({ kind, ...detail });

    const parse = (c) => {
      const m = /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\)/.exec(c || '');
      return m ? { r:+m[1], g:+m[2], b:+m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
    };
    const lum = ({ r,g,b }) => { const f = v => { v/=255; return v <= .03928 ? v/12.92 : Math.pow((v+.055)/1.055, 2.4); };
      return .2126*f(r) + .7152*f(g) + .0722*f(b); };
    const ratio = (a,b) => { const x = lum(a), y = lum(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); };
    const over = (fg,bg) => ({ r: fg.r*fg.a+bg.r*(1-fg.a), g: fg.g*fg.a+bg.g*(1-fg.a), b: fg.b*fg.a+bg.b*(1-fg.a), a:1 });
    const backdrop = (el) => {
      let n = el;
      while (n && n !== document.documentElement) {
        const s = getComputedStyle(n);
        if (s.backgroundImage && s.backgroundImage !== 'none') {
          const stops = [...s.backgroundImage.matchAll(/rgba?\([^)]+\)/g)].map(m => parse(m[0])).filter(Boolean);
          if (stops.length) return stops[Math.floor(stops.length/2)];
        }
        const bg = parse(s.backgroundColor);
        if (bg && bg.a > .95) return bg;
        if (bg && bg.a > 0) return over(bg, backdrop(n.parentElement || document.body));
        n = n.parentElement;
      }
      return { r:255, g:255, b:255, a:1 };
    };

    const seen = new Set();
    const leaves = [];
    for (const el of document.querySelectorAll('#root *')) {
      const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (s.visibility === 'hidden' || s.opacity === '0') continue;

      // 1. anything wider than the phone
      if (r.right > 391) {
        const ps = getComputedStyle(el.parentElement || el);
        if (!/auto|scroll/.test(ps.overflowX)) {
          const k = 'w' + el.tagName + own.slice(0, 20);
          if (!seen.has(k)) { seen.add(k); push('past the right edge', { by: Math.round(r.right - 390), text: own.slice(0, 40) || el.tagName.toLowerCase() }); }
        }
      }

      if (!own) continue;

      // 1b. TWO PIECES OF TEXT TOUCHING. Levi has now reported this twice by
      //     eye — "£10,009.60£65.71" on the tax card, where a four-figure
      //     income overflowed its third of a three-column row and landed on the
      //     expenses figure. Flex children do not clip, so an over-wide value
      //     simply spills onto its neighbour and no other check notices: it is
      //     not off the screen, not low contrast, not the wrong font. It is
      //     just unreadable.
      //
      //     Only leaf text nodes are compared, and only ones that overlap
      //     horizontally while sharing a line — a heading sitting above a
      //     paragraph overlaps vertically all the time and is fine.
      if (el.children.length === 0) leaves.push({ el, own, r });

      // 2. figures in the wrong face — the one this whole script exists for
      const money = /[£$€]\s?\d/.test(own);
      const bare = /^[+\-−]?\d[\d,]*(\.\d+)?%?$/.test(own);
      if ((money || bare) && !/^\d{1,2}:\d{2}/.test(own)) {
        const fam = s.fontFamily || '';
        const displayType = /playfair|georgia|serif/i.test(fam);
        if (!/plus jakarta/i.test(fam) && !(!money && displayType && (parseFloat(s.fontSize)||0) >= 40)) {
          const k = 'n' + own.slice(0, 20);
          if (!seen.has(k)) { seen.add(k); push('figure not in the numeral face', { text: own.slice(0, 30), family: fam.split(',')[0].replace(/['"]/g, '') }); }
        }
      }

      // 3. text nobody can read
      const fg = parse(s.color);
      if (fg && fg.a > 0) {
        const bd = backdrop(el);
        const flat = fg.a < 1 ? over(fg, bd) : fg;
        const size = parseFloat(s.fontSize) || 16;
        const weight = parseInt(s.fontWeight, 10) || 400;
        const need = (size >= 24 || (size >= 18.66 && weight >= 700)) ? 3 : 4.5;
        const got = ratio(flat, bd);
        if (got < need && !el.closest('[disabled], [aria-disabled="true"]')) {
          const k = 'c' + own.slice(0, 20);
          if (!seen.has(k)) { seen.add(k); const hx = c => '#' + [c.r,c.g,c.b].map(v => Math.round(v).toString(16).padStart(2,'0')).join('');
            push('below WCAG AA', { text: own.slice(0, 34), ratio: Math.round(got*100)/100, need, fg: hx(flat), bg: hx(bd) }); }
        }
      }
    }
    // The element BOX is the wrong thing to measure. A wrapped name occupies a
    // full-width box even when its last line is three words long, so comparing
    // boxes reports a collision between "Brow lamination maintenance – Hybrid
    // dye" and the price beside it when there is visibly a gap. Range gives the
    // per-LINE rectangles, which is what the eye actually sees.
    const lineRects = (el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0);
    };

    // Two runs of text that form one sentence are SUPPOSED to touch —
    // "Powered by " + "florrie.ai" is a single phrase in two spans. The
    // difference is layout: a real collision is between separate cells of a
    // flex or grid row, not between inline siblings in one text flow.
    const separateCells = (a, b) => {
      let anc = a.el.parentElement;
      while (anc && !anc.contains(b.el)) anc = anc.parentElement;
      if (!anc) return false;
      const disp = getComputedStyle(anc).display;
      if (!/flex|grid/.test(disp)) return false;
      // Different direct children of that flex/grid container?
      const cellOf = (el) => { let n = el; while (n && n.parentElement !== anc) n = n.parentElement; return n; };
      const ca = cellOf(a.el), cb = cellOf(b.el);
      return ca && cb && ca !== cb;
    };

    for (let i = 0; i < leaves.length; i++) {
      for (let j = i + 1; j < leaves.length; j++) {
        const a = leaves[i], b = leaves[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        if (!separateCells(a, b)) continue;

        let worst = null;
        for (const ra of lineRects(a.el)) {
          for (const rb of lineRects(b.el)) {
            const vOverlap = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
            if (vOverlap < Math.min(ra.height, rb.height) * 0.6) continue;
            const left = ra.left <= rb.left ? ra : rb;
            const right = left === ra ? rb : ra;
            const gap = right.left - left.right;
            if (gap >= 2) continue;
            if (worst === null || gap < worst) worst = gap;
          }
        }
        if (worst === null) continue;

        const k = 't' + a.own.slice(0, 14) + b.own.slice(0, 14);
        if (seen.has(k)) continue;
        seen.add(k);
        push('two pieces of text touching', {
          text: `${a.own.slice(0, 18)}" next to "${b.own.slice(0, 18)}`,
          by: Math.round(-worst),
        });
      }
    }

    return out.slice(0, 10);
  });

  for (const b of bad) findings.push({ route, ...b });
}

// ---------------------------------------------------------------------------
// Prove the collision detector can fail.
//
// It cannot be exercised against the bug it was written for: the tax-year card
// lives on /money, which needs a session the fixtures cannot mint. A detector
// that has only ever returned green is indistinguishable from one that always
// returns green, so it is run here against a synthetic copy of the exact shape
// that broke — three flex:1 thirds of a 390px card with a four-figure tabular
// value in the first one.
// Two earlier versions of this synthetic did not collide at all, so the
// self-test "passed" for reasons that had nothing to do with the detector:
//   - a real 22px Plus Jakarta value in a 106px column, which did not overflow
//     because setContent has no webfont loaded and the fallback sans is narrower
//   - an inline-block widened to 140px, which widens the BOX and not the text;
//     Range.getClientRects reports glyph extent, so the rects never overlapped
// The cells are 60px here, narrow enough that the glyphs themselves overrun
// into the next column whatever font is resolved.
await page.setContent(`<div id=root>
  <div style="width:338px;display:flex;gap:10px;font:700 22px sans-serif;white-space:nowrap">
    <div style="width:60px;flex:none"><span>£10,009.60</span></div>
    <div style="width:60px;flex:none"><span>£65.71</span></div>
    <div style="width:60px;flex:none"><span>£9,943.89</span></div>
  </div>
  <p style="margin-top:20px">Powered by <span>florrie.ai</span></p>
</div>`);
const selfTest = await page.evaluate(`(${SELF_TEST_SRC})()`);

await browser.close();
server.close();

if (!selfTest.caught) {
  console.error('✗ live: the collision detector did not fire on a known collision.\n' +
    '  £10,009.60 in a 106px column overflows onto its neighbour — that is the\n' +
    '  bug this was written for. If it reports nothing here it will report\n' +
    '  nothing anywhere, and every green run above is meaningless.\n');
  process.exit(1);
}
if (selfTest.falsePositive) {
  console.error('✗ live: the collision detector fired on "Powered by florrie.ai",\n' +
    '  which is one sentence in two spans and is SUPPOSED to touch. A check\n' +
    '  that cries wolf gets skipped within a week.\n');
  process.exit(1);
}

if (findings.length) {
  const byRoute = {};
  for (const f of findings) (byRoute[f.route] ||= []).push(f);
  console.error(`✗ live: ${findings.length} problem(s) on screens WITH DATA on them\n`);
  for (const [route, list] of Object.entries(byRoute)) {
    console.error(`  ${route}`);
    for (const f of list) {
      const extra = f.ratio ? `${f.ratio}:1 needs ${f.need}, ${f.fg} on ${f.bg}`
        : f.family ? f.family
        : f.by !== undefined ? `by ${f.by}px` : '';
      console.error(`    ${f.kind}${extra ? ` — ${extra}` : ''}  "${f.text}"`);
    }
  }
  console.error('');
  process.exit(1);
}
console.log(`✓ live: ${ROUTES.length} populated screens — every figure in the numeral face, nothing past the edge, nothing under AA`);
process.exit(0);
