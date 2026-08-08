/**
 * The tap target ratchet.
 *
 * check-tap-targets.mjs proves the 44px mechanism works. This one proves it is
 * actually applied, and keeps it applied: it walks the source, measures every
 * interactive element it can measure, and fails if any of them is under the
 * floor without the fix.
 *
 * Same shape as check-primitives.mjs, and for the same reason — the audit's
 * finding was never "these 147 are wrong", it was "nothing stops the 148th".
 *
 *   node scripts/check-tap-inventory.mjs
 *   node scripts/check-tap-inventory.mjs --list     # every remaining site
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import { MIN, PSEUDO_OK, REPLACED, styleProps, measure, isTarget } from './lib/tap-metrics.mjs';
const traverse = _traverse.default || _traverse;

const SRC = new URL('../src', import.meta.url).pathname;
const LIST = process.argv.includes('--list');

const walk = (dir, out = []) => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.jsx')) out.push(p);
  }
  return out;
};

const bad = [];
let measured = 0, fixed = 0;

for (const file of walk(SRC)) {
  const rel = relative(SRC, file);
  if (rel.startsWith('components/ui/')) continue;
  const code = readFileSync(file, 'utf8');
  let ast;
  try { ast = parse(code, { sourceType: 'module', plugins: ['jsx'] }); }
  catch (err) { bad.push({ file: rel, line: 0, why: `does not parse: ${err.message}` }); continue; }

  traverse(ast, {
    JSXOpeningElement(path) {
      const nameNode = path.node.name;
      const tag = nameNode.type === 'JSXIdentifier' ? nameNode.name : null;
      if (!tag || (!PSEUDO_OK.has(tag) && !REPLACED.has(tag))) return;

      const attrs = path.node.attributes.filter(a => a.type === 'JSXAttribute');
      const has = n => attrs.find(a => a.name?.name === n);
      if (!isTarget(tag, has)) return;

      const props = styleProps(has('style'));
      const m = measure(props);
      if (!m || m.px === 0) return;   // unknowable, or collapsed
      measured++;
      if (m.px >= MIN) return;

      // Already carrying the fix?
      const cls = has('className');
      const clsText = cls ? code.slice(cls.value.start, cls.value.end) : '';
      if (PSEUDO_OK.has(tag) && /fl-tap|fl-btn/.test(clsText)) { fixed++; return; }

      bad.push({
        file: rel, line: path.node.loc.start.line, tag,
        px: m.px, basis: m.basis,
        why: REPLACED.has(tag)
          ? `${tag} is ${m.px}px and cannot use ::after — needs a real minHeight`
          : `${tag} is ${m.px}px and has no fl-tap`,
      });
    },
  });
}

if (LIST) {
  for (const b of bad) console.log(`${b.file}:${b.line}  ${b.why}`);
}

if (bad.length) {
  const byFile = {};
  for (const b of bad) (byFile[b.file] ||= []).push(b);
  console.error(
    `✗ tap targets: ${bad.length} interactive element(s) under ${MIN}px with no fix, ` +
    `across ${Object.keys(byFile).length} file(s)\n  ` +
    Object.entries(byFile).sort((a, b) => b[1].length - a[1].length).slice(0, 12)
      .map(([f, l]) => `${String(l.length).padStart(3)}  ${f}`).join('\n  ') +
    `\n\n  Run: node scripts/codemod-tap-targets.mjs --write\n` +
    `  Or add className="fl-tap" by hand. --list shows every site.\n`
  );
  process.exit(1);
}

console.log(`✓ tap targets: ${measured} measurable targets, ${fixed} lifted to ${MIN}px, none left short`);
