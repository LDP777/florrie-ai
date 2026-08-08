/**
 * Tap target test — real hit testing, in a browser, at real coordinates.
 *
 * The 44px floor is the one accessibility rule in this app that a human will
 * feel every single day: Ellie uses it one-handed between clients. It is also
 * the rule that is easiest to *claim* to have fixed. A class name in the markup
 * proves nothing — the expansion can be clipped by an ancestor's overflow, sit
 * off-centre, or steal the neighbouring control's taps, and in all three cases
 * the diff looks correct and the app is worse.
 *
 * So this renders the real stylesheet and asks the browser what is under the
 * finger, at points a finger would actually land on.
 *
 *   node scripts/check-tap-targets.mjs
 */
import { launch } from './lib/browser.mjs';
import { readFileSync } from 'node:fs';
import http from 'node:http';

const CSS = readFileSync(new URL('../src/index.css', import.meta.url).pathname, 'utf8');

// A filter row of small chips, the shape that made the old expansion harmful:
// four 28px chips 8px apart, exactly what Inbox and Clients render.
const html = `<!doctype html><meta charset=utf-8>
<style>${CSS}</style>
<style>
  body { margin: 0; padding: 60px 20px; font: 14px system-ui; }
  .row { display: flex; gap: 8px; align-items: center; }
  .chip { height: 28px; padding: 0 12px; border: 0; border-radius: 999px; background: #eee; font-size: 12px; }
  .col { display: flex; flex-direction: column; gap: 6px; width: 120px; margin-top: 40px; }
  .stack { height: 30px; border: 0; background: #ddd; }
  .clipped { overflow: hidden; margin-top: 40px; height: 60px; }
  /* The hard case for the "overhang only reaches the gap" claim: narrow icon
     buttons packed 4px apart, as in the calendar toolbar. */
  .tools { display: flex; gap: 4px; margin-top: 40px; }
  .tool { width: 32px; height: 32px; border: 0; padding: 0; background: #ccc; }
</style>
<div class="row">
  <button id="c1" class="chip fl-tap">All</button>
  <button id="c2" class="chip fl-tap">Unread</button>
  <button id="c3" class="chip fl-tap">Needs you</button>
  <button id="c4" class="chip">Bare</button>
</div>
<div class="col">
  <button id="s1" class="stack fl-tap--h">One</button>
  <button id="s2" class="stack fl-tap--h">Two</button>
</div>
<div class="clipped"><button id="k1" class="chip fl-tap">Clipped</button></div>
<div class="tools">
  <button id="t1" class="tool fl-tap"></button>
  <button id="t2" class="tool fl-tap"></button>
  <button id="t3" class="tool fl-tap"></button>
</div>
<div class="tools">
  <button id="x1" class="tool"></button>
  <button id="x2" class="tool"></button>
</div>
`;

const server = http.createServer((_, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(html);
}).listen(0);
const port = server.address().port;

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.goto(`http://127.0.0.1:${port}/`);

const fail = [];
const check = (label, ok, detail = '') => { if (!ok) fail.push(label + (detail ? ` — ${detail}` : '')); };

/** What element does a tap at this point actually reach? */
const hit = (x, y) => page.evaluate(([x, y]) => {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  // A ::after belongs to its element, so elementFromPoint already reports the
  // button rather than the pseudo. Walk up for safety.
  const btn = el.closest('button');
  return btn ? btn.id : el.tagName.toLowerCase();
}, [x, y]);

const box = id => page.evaluate((id) => {
  const r = document.getElementById(id).getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
}, id);

// 1. The visible chip is genuinely under 44px. If this fails the fixture drifted
//    and every assertion below is meaningless.
const c2 = await box('c2');
check('fixture chip is under 44px', c2.h < 44, `is ${c2.h}px`);

// 2. A tap 18px above the chip's centre — outside the visible 28px box, inside
//    the 44px floor — still reaches the chip.
check('tap above the chip reaches it', await hit(c2.cx, c2.cy - 18) === 'c2',
  `got ${await hit(c2.cx, c2.cy - 18)}`);
check('tap below the chip reaches it', await hit(c2.cx, c2.cy + 18) === 'c2',
  `got ${await hit(c2.cx, c2.cy + 18)}`);

// 3. THE REGRESSION THIS EXISTS FOR. A tap on the visible face of the chip to
//    the LEFT must reach that chip, not its neighbour's invisible overhang.
const c1 = await box('c1');
check('left neighbour keeps its own right edge',
  await hit(c1.x + c1.w - 2, c1.cy) === 'c1',
  `got ${await hit(c1.x + c1.w - 2, c1.cy)}`);
check('left neighbour keeps its centre',
  await hit(c1.cx, c1.cy) === 'c1', `got ${await hit(c1.cx, c1.cy)}`);
const c3 = await box('c3');
check('right neighbour keeps its left edge',
  await hit(c3.x + 2, c3.cy) === 'c3', `got ${await hit(c3.x + 2, c3.cy)}`);

// 4. The expansion is centred, not lopsided. Equal reach either side.
const reach = async (id, dir) => {
  const b = await box(id);
  let d = 0;
  while (d < 60 && await hit(b.cx + dir * (b.w / 2 + d), b.cy) === id) d += 2;
  return d;
};
const [l, r] = [await reach('c2', -1), await reach('c2', 1)];
check('hit area is centred horizontally', Math.abs(l - r) <= 4, `reaches ${l}px left, ${r}px right`);

// 5. The axis-limited variants do only their own axis, so a tight column does
//    not have every row overlapping the next.
const s1 = await box('s1'), s2 = await box('s2');
check('column rows do not swallow each other',
  await hit(s2.cx, s2.cy) === 's2' && await hit(s1.cx, s1.cy) === 's1');
check('fl-tap--h does not expand vertically',
  await hit(s1.cx, s1.y - 8) !== 's1', 'vertical overhang present on an h-only target');

// 6. Narrow controls packed tightly — a 32px toolbar at a 36px pitch, which is
//    the case that killed the both-axes version of this utility. Every visible
//    face must still belong to its own button, including the middle one, which
//    would be overlapped from both sides.
for (const id of ['t1', 't2', 't3']) {
  const b = await box(id);
  check(`${id} keeps its centre`, await hit(b.cx, b.cy) === id, `got ${await hit(b.cx, b.cy)}`);
  check(`${id} keeps its left edge`, await hit(b.x + 1, b.cy) === id, `got ${await hit(b.x + 1, b.cy)}`);
  check(`${id} keeps its right edge`, await hit(b.x + b.w - 1, b.cy) === id, `got ${await hit(b.x + b.w - 1, b.cy)}`);
}
// The 4px gap between them stays dead, and that is the honest outcome. A row
// with a 36px pitch cannot hold 44px targets; widening the tap area sideways
// would only take the width off the neighbour. Recording it here so the next
// person does not "fix" it by reaching for min-width and quietly reintroducing
// the overlap.
const t1b = await box('t1'), t2b = await box('t2');
const inGap = await hit((t1b.x + t1b.w + t2b.x) / 2, t1b.cy);
check('the gap stays neutral rather than being stolen by either side',
  inGap !== 't1' && inGap !== 't2', `got ${inGap}`);

// And the proof for the warning on .fl-tap--box: used between tight siblings it
// really does eat their faces. If this ever stops failing to overlap, the CSS
// note above has gone stale.
const overlap = await page.evaluate(() => {
  const [a, b] = [document.getElementById('x1'), document.getElementById('x2')];
  a.className = 'tool fl-tap--box'; b.className = 'tool fl-tap--box';
  const rb = b.getBoundingClientRect();
  const ra = a.getBoundingClientRect();
  // a point on a's own visible right edge
  const el = document.elementFromPoint(ra.x + ra.width - 1, ra.y + ra.height / 2);
  return { stolenBy: el?.id || el?.tagName, gap: rb.x - (ra.x + ra.width) };
});
check('fl-tap--box between tight siblings overlaps them (the documented misuse)',
  overlap.stolenBy === 'x2', `gap ${overlap.gap}px, edge went to ${overlap.stolenBy}`);

// 7. An ancestor with overflow:hidden clips the overhang, so the class is a lie
//    there. Assert the failure mode exists, so the rule in the CSS comment is
//    not folklore — anyone applying fl-tap inside a clipped container should
//    know it does nothing.
const k1 = await box('k1');
const clippedReachesOut = await hit(k1.cx, k1.y - 10) === 'k1';
check('overflow:hidden is known to clip the expansion (documented, not fixed)',
  clippedReachesOut === false,
  'the fixture no longer demonstrates clipping; update the CSS note');

await browser.close();
server.close();

if (fail.length) {
  console.error(`✗ tap targets: ${fail.length} failure(s)\n  ` + fail.join('\n  '));
  process.exit(1);
}
console.log('✓ tap targets: 44px reached above, below and either side; neighbours keep their own taps; axis variants stay on their axis');
