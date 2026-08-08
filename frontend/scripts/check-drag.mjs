/**
 * DragList behaviour test.
 *
 * Reordering is the one thing on this screen that is a GESTURE, and a gesture
 * cannot be verified by rendering a page and counting console errors. Three
 * separate bugs in this component all built, all parsed, all rendered, and all
 * failed the moment a finger moved:
 *
 *  - reordering the array mid-drag moved the captured DOM node, which released
 *    pointer capture and ended the drag after one swap
 *  - measuring against the live (moving) layout instead of a snapshot made the
 *    target index accumulate error
 *  - without touchAction:none the webview took the gesture as a scroll
 *
 * So this drives real PointerEvents with pointerType 'touch' and asserts on the
 * resulting order.
 *
 *   node scripts/check-drag.mjs
 */
import { build } from 'esbuild';
import { launch } from './lib/browser.mjs';
import http from 'node:http';

const FIXTURE = new URL('./fixtures/drag-list.fixture.jsx', import.meta.url).pathname;

const out = await build({
  entryPoints: [FIXTURE],
  bundle: true, write: false, format: 'esm', logLevel: 'silent',
  jsx: 'automatic',
  define: {
    'process.env.NODE_ENV': '"production"',
    'import.meta.env': '{"DEV":false,"PROD":true,"MODE":"production"}',
  },
});
const js = out.outputFiles[0].text;

const html = `<!doctype html><meta charset=utf-8><style>body{font:14px system-ui;margin:0;background:#FBF6F1}</style><div id=root></div><script type=module src=/b.js></script>`;
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/b.js')) { res.setHeader('content-type', 'text/javascript'); res.end(js); }
  else { res.setHeader('content-type', 'text/html'); res.end(html); }
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;

const browser = await launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
});
const page = await browser.newPage({ viewport: { width: 390, height: 700 }, hasTouch: true, isMobile: true });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);

const order = () => page.evaluate(() => window.__order());
const commits = () => page.evaluate(() => window.__commits());

const touchDrag = async (fromRow, toRow) => {
  await page.evaluate(async ({ fromRow, toRow }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const handle = document.querySelector(`[data-row="${fromRow}"] button`);
    const target = document.querySelector(`[data-row="${toRow}"]`);
    const a = handle.getBoundingClientRect(), z = target.getBoundingClientRect();
    const x = a.x + a.width / 2, y0 = a.y + a.height / 2, y1 = z.y + z.height / 2;
    const ev = (type, cy, node) => node.dispatchEvent(new PointerEvent(type, {
      pointerId: 1, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true,
      clientX: x, clientY: cy, button: 0, buttons: type === 'pointerup' ? 0 : 1,
    }));
    ev('pointerdown', y0, handle);
    for (let i = 1; i <= 26; i++) { ev('pointermove', y0 + (y1 - y0) * (i / 26), window); await sleep(12); }
    ev('pointerup', y1, window);
    await sleep(40);
  }, { fromRow, toRow });
  await page.waitForTimeout(300);
};

const fail = [];
const check = (label, ok) => { if (!ok) fail.push(label); };
const REST = ['Signature brows', 'Lamination Hybrid dye', 'Lamination Tint', 'Lamination & tint', 'Lamination & Hybrid stain', 'Hybrid stain'];

check('7 rows render', (await page.locator('[data-row]').count()) === 7);

// Ellie's actual ask: brow wax is second, she wants it at the bottom. One drag.
await touchDrag('Brow wax', 'Hybrid stain');
let a = await order();
check('one drag moves it to the bottom', a[a.length - 1] === 'Brow wax');
check('nothing lost or duplicated', a.length === 7 && new Set(a).size === 7);
check('the other rows keep their order', JSON.stringify(a.filter(x => x !== 'Brow wax')) === JSON.stringify(REST));
check('exactly one write, not one per row passed', (await commits()) === 1);

await touchDrag('Brow wax', 'Signature brows');
a = await order();
check('and back to the top in one drag', a[0] === 'Brow wax');
check('still nothing lost', a.length === 7 && new Set(a).size === 7);

// Down and back up must be a no-op, and must not write.
const before = await order();
const c0 = await commits();
await page.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const h = document.querySelector('[data-row="Brow wax"] button');
  const r = h.getBoundingClientRect();
  const x = r.x + r.width / 2, y0 = r.y + r.height / 2;
  const ev = (t, cy, n) => n.dispatchEvent(new PointerEvent(t, { pointerId: 3, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true, clientX: x, clientY: cy, button: 0 }));
  ev('pointerdown', y0, h);
  for (let i = 1; i <= 12; i++) { ev('pointermove', y0 + 200 * (i / 12), window); await sleep(10); }
  for (let i = 12; i >= 0; i--) { ev('pointermove', y0 + 200 * (i / 12), window); await sleep(10); }
  ev('pointerup', y0, window);
  await sleep(40);
});
await page.waitForTimeout(280);
check('there-and-back leaves the order alone', JSON.stringify(await order()) === JSON.stringify(before));
check('there-and-back does not write', (await commits()) === c0);

// Only the handle drags. If the row body did, scrolling would reorder her list.
const beforeBody = await order();
await page.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const row = document.querySelector('[data-row="Signature brows"]');
  const r = row.getBoundingClientRect();
  const x = r.x + r.width - 30, y0 = r.y + r.height / 2;
  const ev = (t, cy, n) => n.dispatchEvent(new PointerEvent(t, { pointerId: 4, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true, clientX: x, clientY: cy, button: 0 }));
  ev('pointerdown', y0, row);
  for (let i = 1; i <= 14; i++) { ev('pointermove', y0 + 250 * (i / 14), window); await sleep(10); }
  ev('pointerup', y0 + 250, window);
  await sleep(40);
});
await page.waitForTimeout(250);
check('dragging the row body does nothing', JSON.stringify(await order()) === JSON.stringify(beforeBody));
check('no page errors', errs.length === 0);

await browser.close();
server.close();

if (fail.length) {
  console.error(`✗ drag reorder: ${fail.length} failure(s)\n  ` + fail.join('\n  '));
  if (errs.length) console.error('  page errors: ' + errs.join('; '));
  process.exit(1);
}
console.log('✓ drag reorder: one gesture to the bottom and back, touch events, one write per move, row body inert');
