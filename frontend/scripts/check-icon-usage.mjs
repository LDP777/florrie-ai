/**
 * Icon usage in the app, as opposed to check-icons.mjs which tests the module.
 *
 * Two failures, both of which shipped to Ellie and neither of which any
 * existing check could see, because both produce valid JSX that builds:
 *
 *  1. An icon NAME rendered as text. The emoji migration rewrote
 *     `{ icon: '💷' }` to `{ icon: 'pound' }` in a data array, but the render
 *     site is `<span>{method.icon}</span>` several hundred lines away, so the
 *     Payments screen listed the words card, phone, pound, wallet down its
 *     left edge.
 *  2. An icon name that does not exist. iconName() falls back to 'flower' by
 *     design — better a flower than a crash — which means a typo shows up as
 *     four identical flowers rather than as an error. Silent, and plausible
 *     enough to survive a glance.
 *
 *   node scripts/check-icon-usage.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import { build } from 'esbuild';
const traverse = _traverse.default || _traverse;

const SRC = new URL('../src', import.meta.url).pathname;
const KEY = /^(icon|emoji|glyph|symbol|iconName)$/i;

const bundled = await build({
  entryPoints: [join(SRC, 'components/ui/Icon.jsx')],
  bundle: true, write: false, format: 'esm', jsx: 'transform',
  jsxFactory: 'h', jsxFragment: 'F', logLevel: 'silent',
  banner: { js: 'const h=(t,p,...c)=>({t,p,c});const F="F";' },
});
const { iconName, ICON_NAMES } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
const NAMES = new Set(ICON_NAMES);

const walk = (dir, out = []) => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.jsx')) out.push(p);
  }
  return out;
};

const asText = [];
const unresolved = [];

for (const file of walk(SRC)) {
  const rel = relative(SRC, file);
  const code = readFileSync(file, 'utf8');
  let ast;
  try { ast = parse(code, { sourceType: 'module', plugins: ['jsx'] }); }
  catch { continue; }

  traverse(ast, {
    // 1. rendered as text
    JSXExpressionContainer(path) {
      if (path.parent.type !== 'JSXElement') return;
      const e = path.node.expression;
      let prop = null;
      if (e.type === 'MemberExpression' && e.property?.name) prop = e.property.name;
      else if (e.type === 'Identifier') prop = e.name;
      if (!prop || !KEY.test(prop)) return;
      if (path.parent.openingElement?.name?.name === 'Icon') return;
      asText.push(`${rel}:${path.node.loc.start.line}  {${code.slice(e.start, e.end)}} renders the name, not the icon`);
    },

    // 2. names that do not exist
    ObjectProperty(path) {
      const k = path.node.key?.name || path.node.key?.value;
      if (!KEY.test(k || '')) return;
      const v = path.node.value;
      if (v.type !== 'StringLiteral' || !v.value) return;
      // An emoji here is content, not a name; those are handled elsewhere.
      if (!/^[a-z][\w-]*$/.test(v.value)) return;
      if (NAMES.has(v.value)) return;
      const resolved = iconName(v.value);
      if (resolved === 'flower' && v.value !== 'flower') {
        unresolved.push(`${rel}:${v.loc.start.line}  ${k}: '${v.value}' is not a glyph and silently becomes a flower`);
      }
    },
  });
}

const fail = [...asText, ...unresolved];
if (fail.length) {
  console.error(
    `✗ icon usage: ${asText.length} name(s) rendered as text, ${unresolved.length} unresolved name(s)\n  ` +
    fail.join('\n  ') +
    `\n\n  For the first: node scripts/codemod-icon-text.mjs --write\n` +
    `  For the second: pick a real glyph, or add one to Icon.jsx.\n`
  );
  process.exit(1);
}
console.log(`✓ icon usage: no names rendered as text, every icon name resolves to a real glyph`);
