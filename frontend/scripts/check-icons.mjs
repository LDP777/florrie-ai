/**
 * Icon set smoke test.
 *
 * `vite build` and `esbuild` both parse Icon.jsx happily with an undefined
 * identifier in it, because a bare reference is valid syntax and only fails when
 * the line runs. That is exactly how `FROM_EMOJI is not defined` reached
 * production: the build was green, and every route a headless check can reach
 * without a session redirects to /login, where nothing calls iconName().
 *
 * So this actually evaluates the module and calls the thing.
 *
 *   node scripts/check-icons.mjs
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const SRC = new URL('../src/components/ui/Icon.jsx', import.meta.url).pathname;

const result = await build({
  entryPoints: [SRC],
  bundle: true,
  write: false,
  format: 'esm',
  jsx: 'transform',
  jsxFactory: 'h',
  jsxFragment: 'Fragment',
  banner: { js: 'const h = (t, p, ...c) => ({ t, p, c }); const Fragment = "F";' },
  logLevel: 'silent',
});

const code = result.outputFiles[0].text;
const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

const { default: Icon, iconName, ICON_NAMES } = mod;

const fail = [];
const check = (label, ok) => { if (!ok) fail.push(label); };

// 1. Every icon name renders. A name in ICON_NAMES that produces null means a
//    path went missing.
for (const name of ICON_NAMES) {
  check(`Icon renders "${name}"`, Icon({ name }) !== null);
}

// 2. iconName resolves each class of input it is asked about in production:
//    an icon name, a Material Symbols name, an emoji, junk, and nothing.
const cases = [
  ['calendar', 'calendar'],        // already an icon name
  ['arrow_back_ios_new', 'chevron-left'], // Material, from a nav table
  ['\u{1F337}', 'flower'],         // emoji, from a server-sent card
  ['\u{1F4C5}', 'calendar'],
  ['⚠️', 'alert-triangle'],
  ['totally_made_up', 'flower'],   // stale value from an old build
  [undefined, 'flower'],
  [null, 'flower'],
  ['', 'flower'],
];
for (const [input, expected] of cases) {
  let got;
  try { got = iconName(input); } catch (err) { got = 'THREW: ' + err.message; }
  check(`iconName(${JSON.stringify(input)}) -> ${expected}, got ${got}`, got === expected);
}

// 3. Every mapping target must be a real glyph, or a call site silently renders
//    nothing.
const src = readFileSync(SRC, 'utf8');
const names = new Set(ICON_NAMES);
for (const mapName of ['FROM_EMOJI', 'FROM_MATERIAL']) {
  const start = src.indexOf(`const ${mapName} = {`);
  check(`${mapName} exists`, start !== -1);
  if (start === -1) continue;
  const body = src.slice(start, src.indexOf('\n};', start));
  for (const [, target] of body.matchAll(/:\s*'([a-z][\w-]*)'/g)) {
    check(`${mapName} -> "${target}" is a real glyph`, names.has(target));
  }
}

// 4. The props the migration relies on must survive a refactor.
check('color prop applies', Icon({ name: 'calendar', color: 'red' }).p.style.color === 'red');
check('inline prop applies', Icon({ name: 'calendar', inline: true }).p.style.display === 'inline-block');
check('filled renders a second path', Icon({ name: 'calendar', filled: true }).c.length === 2);
check('style.fontSize sets the size', Icon({ name: 'calendar', style: { fontSize: 30 } }).p.width === 30);
check('unknown name renders nothing', Icon({ name: 'nope' }) === null);

if (fail.length) {
  console.error(`✗ icon set: ${fail.length} failure(s)\n  ` + fail.join('\n  '));
  process.exit(1);
}
console.log(`✓ icon set: ${ICON_NAMES.length} glyphs, all render; iconName resolves names, Material names, emoji and junk`);
