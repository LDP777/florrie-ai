/**
 * Raise every tap target to the 44px floor.
 *
 * Two different fixes, because one of them does not work everywhere:
 *
 *  - <button>, <a>, <label> get `fl-tap`, which expands the hit area with a
 *    pseudo-element and leaves the design exactly where it is.
 *  - <input>, <select>, <textarea> get a real minHeight, because they are
 *    replaced elements and ::after does not render on them at all. Verified in
 *    a browser rather than assumed: the pseudo-element expansion on an input
 *    reaches nothing, and a tap 7px above it lands on <html>. Those 25 fields
 *    are 20-33px today, which is under a thumb regardless of the standard, so
 *    growing them is the right visual answer as well as the only one available.
 *
 * Formatting is preserved by splicing the source text at AST-derived offsets
 * rather than regenerating the file. This codebase is hand-formatted JSX with
 * inline style objects; running it through a generator would produce a diff
 * nobody could review.
 *
 *   node scripts/codemod-tap-targets.mjs          # report
 *   node scripts/codemod-tap-targets.mjs --write
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import { MIN, PSEUDO_OK, REPLACED, num, styleProps, measure, isTarget } from './lib/tap-metrics.mjs';
const traverse = _traverse.default || _traverse;

const SRC = new URL('../src', import.meta.url).pathname;
const WRITE = process.argv.includes('--write');

const walk = (dir, out = []) => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.jsx')) out.push(p);
  }
  return out;
};

let touched = 0, skipped = [];
const summary = { class: 0, minHeight: 0, height: 0, files: new Set() };

for (const file of walk(SRC)) {
  const rel = relative(SRC, file);
  if (rel.startsWith('components/ui/')) continue;
  const code = readFileSync(file, 'utf8');
  let ast;
  try { ast = parse(code, { sourceType: 'module', plugins: ['jsx'] }); }
  catch { skipped.push(`${rel} (parse)`); continue; }

  /** @type {{start:number,end:number,text:string}[]} */
  const edits = [];

  traverse(ast, {
    JSXOpeningElement(path) {
      const nameNode = path.node.name;
      const tag = nameNode.type === 'JSXIdentifier' ? nameNode.name : null;
      if (!tag) return;
      const isPseudo = PSEUDO_OK.has(tag);
      const isReplaced = REPLACED.has(tag);
      if (!isPseudo && !isReplaced) return;

      const attrs = path.node.attributes.filter(a => a.type === 'JSXAttribute');
      const has = n => attrs.find(a => a.name?.name === n);
      if (!isTarget(tag, has)) return;

      const styleAttr = has('style');
      const props = styleProps(styleAttr);
      const styleObj = styleAttr?.value?.type === 'JSXExpressionContainer' &&
        styleAttr.value.expression.type === 'ObjectExpression' ? styleAttr.value.expression : null;

      const m = measure(props);
      if (!m || m.px === 0 || m.px >= MIN) return;

      if (isPseudo) {
        const cls = has('className');
        if (!cls) {
          const at = nameNode.end;
          edits.push({ start: at, end: at, text: ' className="fl-tap"' });
        } else if (cls.value.type === 'StringLiteral') {
          if (/\bfl-tap\b/.test(cls.value.value)) return;
          edits.push({ start: cls.value.end - 1, end: cls.value.end - 1, text: ' fl-tap' });
        } else if (cls.value.type === 'JSXExpressionContainer') {
          const e = cls.value.expression;
          if (e.type === 'TemplateLiteral') {
            if (/fl-tap/.test(code.slice(e.start, e.end))) return;
            edits.push({ start: e.end - 1, end: e.end - 1, text: ' fl-tap' });
          } else {
            if (/fl-tap/.test(code.slice(e.start, e.end))) return;
            edits.push({ start: e.start, end: e.start, text: '`fl-tap ${' });
            edits.push({ start: e.end, end: e.end, text: '}`' });
          }
        } else return;
        summary.class++;
      } else {
        // A replaced element: give it real height.
        if (props.height && num(props.height.value) !== null) {
          edits.push({ start: props.height.value.start, end: props.height.value.end, text: String(MIN) });
          summary.height++;
        } else if (props.minHeight && num(props.minHeight.value) !== null) {
          edits.push({ start: props.minHeight.value.start, end: props.minHeight.value.end, text: String(MIN) });
          summary.minHeight++;
        } else if (styleObj) {
          const at = styleObj.start + 1;
          edits.push({ start: at, end: at, text: ` minHeight: ${MIN},` });
          summary.minHeight++;
        } else if (!styleAttr) {
          const at = nameNode.end;
          edits.push({ start: at, end: at, text: ` style={{ minHeight: ${MIN} }}` });
          summary.minHeight++;
        } else return;
      }
      touched++;
      summary.files.add(rel);
    },
  });

  if (!edits.length) continue;
  if (!WRITE) continue;
  edits.sort((a, b) => b.start - a.start);
  let out = code;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  // Never write a file we just broke.
  try { parse(out, { sourceType: 'module', plugins: ['jsx'] }); }
  catch (err) { skipped.push(`${rel} (would not parse after edit: ${err.message})`); continue; }
  writeFileSync(file, out);
}

console.log(`${WRITE ? 'patched' : 'would patch'} ${touched} targets across ${summary.files.size} files`);
console.log(`  fl-tap class: ${summary.class}   minHeight added: ${summary.minHeight}   height raised: ${summary.height}`);
if (skipped.length) {
  console.log(`  skipped:\n    ` + skipped.join('\n    '));
  process.exitCode = 1;
}
