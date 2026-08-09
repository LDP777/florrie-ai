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
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { launch } from './lib/browser.mjs';
import { fetchStubSource, sessionSeedSource, WRONG_SCREEN_PROBE } from './lib/fixtures.mjs';

const DIST = new URL('../dist', import.meta.url).pathname;
if (!existsSync(join(DIST, 'index.html'))) {
  console.error('✗ live: no dist/. Run `npm run build` first.');
  process.exit(1);
}

// The public surface AND the signed-in screens Ellie actually lives on. The
// latter used to be out of reach — the tax card that rendered
// "£10,009.60£65.71" is on /money, behind the auth gate, so nothing but the
// SSR pass ever looked at it and the SSR pass sees a spinner.
const ROUTES = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (!ROUTES.length) ROUTES.push(
  // Public
  '/book/ellindigo', '/terms', '/privacy',
  // The five tabs, then everything reachable from More that holds real data.
  // Routes are cheap here — about two seconds each — and the whole point is
  // that a screen nobody has looked at closely is exactly where an unreadable
  // colour survives.
  '/', '/inbox', '/content', '/money', '/more',
  '/calendar', '/calendar/week', '/clients', '/treatments', '/price-list',
  '/expenses', '/deposits', '/analytics', '/end-of-day', '/checklist',
  '/campaigns', '/automations', '/aftercare', '/loyalty', '/packages',
  '/promos', '/memberships', '/milestones', '/referrals', '/reviews',
  '/outbox', '/escalations', '/notifications', '/messaging', '/comms',
  '/hours', '/policies', '/business', '/integrations', '/inventory',
  '/patch-tests', '/compliance', '/portfolio', '/knowledge', '/import',
  '/rebook', '/waitlist', '/team', '/notes', '/cancellations',
  // The other half of the app. App.jsx declares 103 routes; the list above
  // reached 50 of them, and "a screen nobody has looked at closely" describes
  // these far better than it describes /money. Everything static and
  // signed-in goes in — the ones left out are parameterised on a token
  // (/form/:token, /book/:slug/manage/:token), the wizards (/setup,
  // /onboarding) and the sign-in pair, which are checked by the guards above
  // rather than by the assertions.
  '/hub', '/today', '/value', '/approval-queue', '/digest', '/week-review',
  '/settings', '/api-settings', '/pricing', '/reports', '/templates',
  '/sequences', '/consultation-forms', '/photo-consent', '/client-timeline',
  '/smart-schedule', '/waitlist-pro', '/rota', '/addons', '/tags',
  '/treatment-stats', '/staff-performance', '/vouchers', '/voice',
  '/whatsapp', '/whatsapp/templates', '/sms', '/portal', '/locations',
  '/calendar/full', '/support', '/data-deletion',
  '/book/ellindigo/confirmed',
);

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
// The storage key supabase-js uses is derived from the project ref in the URL,
// so the seed has to use the SAME url this dist was built against. Reading it
// out of the bundle rather than assuming it means the seed cannot silently
// drift out of step with the build again.
const bundleUrl = (() => {
  const { readdirSync } = require('node:fs');
  for (const f of readdirSync(join(DIST, 'assets'))) {
    if (!/^supabase-.*\.js$/.test(f) && !/^index-.*\.js$/.test(f)) continue;
    const m = /https:\/\/[a-z0-9-]+\.supabase\.co/.exec(readFileSync(join(DIST, 'assets', f), 'utf8'));
    if (m) return m[0];
  }
  return 'https://placeholder.supabase.co';
})();
await ctx.addInitScript(sessionSeedSource(bundleUrl));
const page = await ctx.newPage();

/**
 * How far right an element is actually PAINTED, as a source string so the
 * self-test at the bottom exercises the same code the sweep runs.
 *
 * An ancestor with overflow-x of hidden, clip, auto or scroll clips its
 * descendants at its own padding edge. `hidden` matters as much as `scroll`
 * here — arguably more, since a decorative blur circle hung off the corner of
 * a card is always inside `overflow: hidden` and always overhangs its box.
 *
 * Positioning complicates it, so it is handled rather than ignored:
 *   - a `fixed` element is laid out against the viewport and is not clipped
 *     by scrolling ancestors at all
 *   - an `absolute` element is clipped only from its containing block upward.
 *     A static ancestor in between does not clip it — which is exactly why
 *     `right: -64px` inside a plain div DOES overhang the screen and inside a
 *     `position: relative` card does not.
 */
const EDGE_SRC = `(() => {
  const clips = (s) => /hidden|clip|auto|scroll/.test(s.overflowX);
  const isContainingBlock = (s) =>
    s.position !== 'static' || s.transform !== 'none' || s.filter !== 'none' ||
    s.perspective !== 'none' || /paint|layout|strict|content/.test(s.contain || '');

  const visibleRight = (el, r) => {
    let right = (r || el.getBoundingClientRect()).right;
    const pos = getComputedStyle(el).position;
    if (pos === 'fixed') return right;
    let escaping = pos === 'absolute';
    for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (escaping) {
        // Not yet at the containing block: this ancestor cannot clip it.
        if (isContainingBlock(s)) escaping = false; else continue;
      }
      if (clips(s)) right = Math.min(right, n.getBoundingClientRect().right);
      if (s.position === 'fixed') break;
      if (s.position === 'absolute') escaping = true;
    }
    return right;
  };

  /** Enough of a path to find the thing in the source without a bisect. */
  const pathOf = (el) => {
    const bits = [];
    for (let n = el; n && n.id !== 'root' && bits.length < 4; n = n.parentElement) {
      const cls = typeof n.className === 'string' && n.className.trim()
        ? '.' + n.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
      bits.unshift(n.tagName.toLowerCase() + cls);
    }
    return bits.join(' > ');
  };

  /**
   * A headline that trails off mid-word. An ellipsis on a list row is what
   * ellipses are for; at display size it means the copy and the slot were
   * designed by different people.
   */
  const cutOff = (el) => {
    const s = getComputedStyle(el);
    return el.children.length === 0
      && parseFloat(s.fontSize) >= 20
      && s.textOverflow === 'ellipsis'
      && el.scrollWidth > el.clientWidth + 1;
  };

  return { visibleRight, pathOf, cutOff };
})()`;

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

// Routes that are SUPPOSED to render without a session.
const PUBLIC = new Set(['/terms', '/privacy', '/login', '/support', '/data-deletion']);
for (const r of ROUTES) if (r.startsWith('/book/')) PUBLIC.add(r);

const findings = [];
const crashed = [];
for (const route of ROUTES) {
  await page.goto(`http://127.0.0.1:${port}${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(Number(process.env.LIVE_SETTLE || 700));

  // A signed-in route that quietly renders the LOGIN page is the worst possible
  // outcome here: every assertion below passes, on a screen nobody asked about,
  // and the report says green. That is exactly what happened the first time
  // this reached for /money — the session seed did not take and five of seven
  // "passing" screens were the sign-in form.
  // Shared with shoot-live.mjs, so a screenshot and a check can never disagree
  // about whether they are looking at the right screen.
  const wrongScreen = await page.evaluate(`(${WRONG_SCREEN_PROBE})()`);
  // A crash is per-route, so collect them and report the whole list at the
  // end — finding out about them one build at a time is its own kind of waste.
  // Login/onboarding stays fatal-fast: that means the HARNESS is broken and
  // every route after it is meaningless.
  if (wrongScreen && !PUBLIC.has(route) && wrongScreen.startsWith('the ERROR')) {
    crashed.push(route);
    continue;
  }
  if (wrongScreen && !PUBLIC.has(route)) {
    console.error(`✗ live: ${route} rendered ${wrongScreen}, not the screen.\n` +
      `  Every assertion below it would have passed, on a page nobody asked\n` +
      `  about, and the run would have reported green.\n` +
      `  Login/onboarding: the session seed is not being read — most likely the\n` +
      `  storage key ref does not match the VITE_SUPABASE_URL this dist was\n` +
      `  built with.\n` +
      `  Error boundary: the page threw. Open the route with shoot-live.mjs and\n` +
      `  read the page errors it prints; it is usually a fixture whose shape\n` +
      `  does not match the route it stands in for.\n`);
    await browser.close(); server.close();
    process.exit(1);
  }

  const bad = await page.evaluate((edgeSrc) => {
    const EDGE = new Function('return ' + edgeSrc)();
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

    const { visibleRight, pathOf, cutOff } = EDGE;

    const seen = new Set();
    const leaves = [];
    for (const el of document.querySelectorAll('#root *')) {
      const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (s.visibility === 'hidden' || s.opacity === '0') continue;

      // 1. anything wider than the phone — as PAINTED, not as laid out.
      //
      //     This used to look at the immediate parent only, and only for
      //     `auto|scroll`. Both halves were wrong, and both produced findings
      //     that cost an hour to chase and turned out to be nothing:
      //
      //       /checklist — a decorative 128px blur circle at `right: -64px`
      //       inside a `position: relative; overflow: hidden` card. Its box
      //       reaches x=430; not one pixel of it is painted past x=366,
      //       because `hidden` clips just as hard as `scroll` does. The old
      //       test only skipped `auto|scroll`, so it reported 40px of overflow
      //       on something the eye cannot see.
      //
      //       /notifications — the horizontal tab strip. The scroll container
      //       is the strip; the immediate parent of the icon is the BUTTON,
      //       which is `overflow: visible` like every button. Looking one
      //       level up finds nothing and reports the fourth tab as broken
      //       layout when it is a strip you swipe.
      //
      //     So: walk up, and clip the rect against every ancestor that clips.
      //     What is left is what Ellie can actually see off the edge.
      if (r.right > 391 && visibleRight(el, r) > 391) {
        const k = 'w' + el.tagName + own.slice(0, 20);
        if (!seen.has(k)) { seen.add(k); push('past the right edge', { by: Math.round(visibleRight(el, r) - 390), text: own.slice(0, 40) || el.tagName.toLowerCase(), where: pathOf(el) }); }
      }

      // 1c. A HEADLINE THAT TRAILS OFF. Levi's words: "the next bit having text
      //     too big for the capsule makes no sense." The Hub hero rendered
      //     "No clients book…" — a 27px display slot with
      //     nowrap/overflow-hidden/ellipsis on it, handed a sentence.
      //
      //     An ellipsis on a list row is fine; that is what it is for. On
      //     something set at display size it means the copy and the slot were
      //     designed by different people, and the fix is shorter copy or a
      //     different slot, never a smaller font.
      if (own && cutOff(el)) {
        const k = 'e' + own.slice(0, 20);
        if (!seen.has(k)) { seen.add(k); push('headline cut off mid-word', {
          text: own.slice(0, 40), by: el.scrollWidth - el.clientWidth, where: pathOf(el) }); }
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
    // A fixed or sticky element is SUPPOSED to sit over the page — the bottom
    // nav floats above whatever is scrolling under it, by design. Comparing it
    // against page text reports every screen as a collision, which is how this
    // produced "Florrie uses AI to" next to "2" overlapping by 280px.
    const floats = (el) => {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        const pos = getComputedStyle(n).position;
        if (pos === 'fixed' || pos === 'sticky' || pos === 'absolute') return true;
      }
      return false;
    };

    const separateCells = (a, b) => {
      if (floats(a.el) || floats(b.el)) return false;
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
  }, EDGE_SRC);

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

// ---------------------------------------------------------------------------
// Prove the right-edge rule still fires.
//
// It was just made MORE permissive — it now forgives anything a clipping
// ancestor swallows — and that is the direction in which a check quietly stops
// working. Four cases, in one 390px-wide page:
//   over    a plain overhang with nothing to clip it            MUST fire
//   clipped the /checklist blur circle: absolute, right:-64px,
//           inside position:relative + overflow:hidden          must NOT fire
//   strip   the /notifications tab strip: an icon two levels
//           inside a horizontal scroller                        must NOT fire
//   escaped absolute right:-64px inside a STATIC overflow:hidden
//           div — the ancestor is not its containing block, so
//           it really does hang off the screen                  MUST fire
await page.setContent(`<style>body{margin:0}</style>
<div id=root style="width:390px;overflow:visible">
  <div style="width:390px;position:relative;overflow:hidden;height:40px">
    <div data-case="clipped" style="position:absolute;top:0;right:0;width:128px;height:40px;margin-right:-64px"></div>
  </div>
  <div style="width:358px;overflow-x:auto;display:flex;white-space:nowrap">
    <button style="flex:0 0 auto;width:200px"><i data-case="strip" style="display:inline-block;width:18px;height:18px"></i></button>
    <button style="flex:0 0 auto;width:200px"><i data-case="strip2" style="display:inline-block;width:18px;height:18px"></i></button>
  </div>
  <div style="width:390px"><div data-case="over" style="width:440px;height:10px"></div></div>
  <div style="width:390px;overflow:hidden;height:40px">
    <div data-case="escaped" style="position:absolute;top:200px;right:0;width:128px;height:20px;margin-right:-64px"></div>
  </div>
  <div style="width:200px;margin-top:240px">
    <span data-cut="headline" style="display:block;font:700 27px sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">No clients booked today</span>
    <span data-cut="listrow" style="display:block;font:400 13px sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">A perfectly ordinary list row that is allowed to end in an ellipsis</span>
    <span data-cut="fits" style="display:block;font:700 27px sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Free day</span>
  </div>
</div>`);
const edgeTest = await page.evaluate((edgeSrc) => {
  const { visibleRight, cutOff } = new Function('return ' + edgeSrc)();
  const out = { cut: {} };
  for (const el of document.querySelectorAll('[data-case]')) {
    const r = el.getBoundingClientRect();
    out[el.dataset.case] = { box: Math.round(r.right), painted: Math.round(visibleRight(el, r)) };
  }
  for (const el of document.querySelectorAll('[data-cut]')) out.cut[el.dataset.cut] = cutOff(el);
  return out;
}, EDGE_SRC);

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

for (const [name, want] of [['headline', true], ['listrow', false], ['fits', false]]) {
  const got = edgeTest.cut[name];
  if (got === want) continue;
  console.error(want
    ? `✗ live: the cut-off-headline rule did not fire on "${name}" — 27px, nowrap,\n` +
      `  ellipsis, and wider than its box. That is the exact shape of the Hub hero\n` +
      `  rendering "No clients book…". If it forgives this it catches nothing.\n`
    : `✗ live: the cut-off-headline rule fired on "${name}". An ellipsis on a list\n` +
      `  row is what ellipses are for, and a headline that fits is not a defect.\n`);
  process.exit(1);
}

for (const [name, want] of [['over', 'over'], ['escaped', 'over'], ['clipped', 'in'], ['strip', 'in'], ['strip2', 'in']]) {
  const got = edgeTest[name];
  if (!got) { console.error(`✗ live: the right-edge self-test lost its "${name}" case.\n`); process.exit(1); }
  const fires = got.painted > 391;
  if (want === 'over' && !fires) {
    console.error(`✗ live: the right-edge rule did not fire on "${name}" — box reaches ${got.box}px,\n` +
      `  and it decided only ${got.painted}px of that is painted. Nothing clips it. If it\n` +
      `  forgives this it forgives everything, and every green run above means nothing.\n`);
    process.exit(1);
  }
  if (want === 'in' && fires) {
    console.error(`✗ live: the right-edge rule fired on "${name}", which is clipped by an\n` +
      `  ancestor and not visible past ${got.painted}px. That is the false positive this\n` +
      `  rule was rewritten to stop reporting.\n`);
    process.exit(1);
  }
}

if (crashed.length) {
  console.error(`✗ live: ${crashed.length} route(s) threw and rendered the error card:\n`);
  for (const r of crashed) console.error(`    ${r}`);
  console.error('\n  Every assertion on these passed, on a crash screen. Run\n' +
    `    node scripts/shoot-live.mjs ${crashed[0]}\n` +
    '  and read the page errors it prints — it is usually a fixture whose\n' +
    '  shape does not match the route it stands in for.\n');
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
      // "past the right edge — by 40px  div" is not a bug report, it is a
      // riddle. Two of these cost an hour each to trace back to an element.
      if (f.where) console.error(`      ${f.where}`);
    }
  }
  console.error('');
  process.exit(1);
}
console.log(`✓ live: ${ROUTES.length} populated screens — every figure in the numeral face, nothing past the edge, nothing under AA`);
process.exit(0);
