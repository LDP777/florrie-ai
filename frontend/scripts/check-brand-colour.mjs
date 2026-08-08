/**
 * A salon's brand colour must be readable whatever they pick.
 *
 * The booking page is the surface Ellie's clients pay through, and it colours
 * text with `beautician.brand_colour` straight from the database. Ellindigo's
 * #c76b8a measures 3.32:1 on cream — under AA — so "Treatment" and the footer
 * were both hard to read. The next salon might pick a pale peach.
 *
 *   node scripts/check-brand-colour.mjs
 */
import { build } from 'esbuild';
import { writeFileSync, unlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const out = await build({
  entryPoints: [new URL('../src/lib/brand-colour.js', import.meta.url).pathname],
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
});
const tmp = new URL('../.brand-test.mjs', import.meta.url).pathname;
writeFileSync(tmp, out.outputFiles[0].text);
const { readableOn, onBrand, contrast } = await import(pathToFileURL(tmp).href);
unlinkSync(tmp);

const CREAM = '#FBF6F1';
const fail = [];
const check = (label, ok, detail = '') => { if (!ok) fail.push(label + (detail ? ` — ${detail}` : '')); };

// The colours a beauty business actually picks: pinks, roses, dusty blues,
// sage, and the pale ones that cause the problem.
const BRANDS = ['#c76b8a', '#92405e', '#f4c2c2', '#ffd1dc', '#e8d5c4', '#a8c3b0',
  '#7a9cc6', '#d4af37', '#ffff66', '#000000', '#ffffff', '#8a6420'];

for (const brand of BRANDS) {
  const fixed = readableOn(brand, CREAM, 4.5);
  const got = contrast(fixed, CREAM);
  check(`${brand} reaches AA on cream (became ${fixed}, ${got.toFixed(2)}:1)`, got >= 4.49);
}

// A colour that already passes must come back untouched — a salon with a deep
// brand should see exactly the colour they chose, not a "corrected" one.
check('a passing colour is returned unchanged', readableOn('#92405e', CREAM, 4.5) === '#92405e',
  `got ${readableOn('#92405e', CREAM, 4.5)}`);

// Hue is preserved. Darkening a pink must not produce a brown.
const pinkFixed = readableOn('#c76b8a', CREAM, 4.5);
const [pr, pg, pb] = [1, 3, 5].map(i => parseInt(pinkFixed.slice(i, i + 2), 16));
check('a darkened pink is still a pink (red channel stays dominant)', pr > pg && pr > pb,
  `${pinkFixed} -> r${pr} g${pg} b${pb}`);

// Text ON the brand picks the readable side.
check('ink on a pale pink', onBrand('#f4c2c2') === '#241B17', `got ${onBrand('#f4c2c2')}`);
check('cream on a deep maroon', onBrand('#92405e') === '#FFFFFF', `got ${onBrand('#92405e')}`);
for (const brand of BRANDS) {
  const on = onBrand(brand);
  check(`text on ${brand} reaches 4.5 (${on})`, contrast(on, brand) >= 4.5,
    `${contrast(on, brand).toFixed(2)}:1`);
}

// Garbage in, garbage out — but not a crash, and not a silently wrong colour.
check('a non-hex value is passed through untouched', readableOn('rebeccapurple', CREAM) === 'rebeccapurple');
check('undefined does not throw', readableOn(undefined, CREAM) === undefined);

if (fail.length) {
  console.error(`✗ brand colour: ${fail.length} failure(s)\n  ` + fail.join('\n  '));
  process.exit(1);
}
console.log(`✓ brand colour: ${BRANDS.length} brand colours all reach AA on cream with their hue intact, and text on them is readable`);
process.exit(0);
