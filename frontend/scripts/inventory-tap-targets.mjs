/**
 * Tap target inventory.
 *
 * Apple's HIG and WCAG 2.5.5 both put the floor at 44px. The audit found most
 * of the app's interactive elements below it, but "most" was a regex guess.
 * This parses the JSX and computes the real height of every tappable thing from
 * its inline styles, so the fix list is the actual list.
 *
 * Height is derived the way the browser derives it:
 *   explicit height/minHeight wins
 *   else padding-block * 2 + line box (fontSize * 1.3, floored at 16px default)
 *
 * A control that is *inside* another control does not count — the parent is
 * what the thumb hits.
 *
 *   node scripts/inventory-tap-targets.mjs [--json]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
const traverse = _traverse.default || _traverse;

const SRC = new URL('../src', import.meta.url).pathname;
const MIN = 44;

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.jsx')) out.push(p);
  }
  return out;
};

const INTERACTIVE = new Set(['button', 'a', 'input', 'select', 'textarea', 'label']);

/** Literal number out of a style value: 8, '8px', but not `${x}px` or a var(). */
function num(node) {
  if (!node) return null;
  if (node.type === 'NumericLiteral') return node.value;
  if (node.type === 'StringLiteral') {
    const m = /^(-?[\d.]+)px$/.exec(node.value.trim());
    if (m) return parseFloat(m[1]);
    const n = parseFloat(node.value);
    return Number.isFinite(n) && /^[\d.]+$/.test(node.value.trim()) ? n : null;
  }
  if (node.type === 'UnaryExpression' && node.operator === '-') {
    const v = num(node.argument);
    return v === null ? null : -v;
  }
  return null;
}

/** Pull a flat map of statically-known style properties off a style={{...}}. */
function styleProps(attr) {
  const out = {};
  if (!attr || attr.value?.type !== 'JSXExpressionContainer') return out;
  const collect = (obj) => {
    if (obj?.type !== 'ObjectExpression') return;
    for (const p of obj.properties) {
      if (p.type === 'SpreadElement') continue;
      const key = p.key?.name || p.key?.value;
      if (!key) continue;
      out[key] = p.value;
    }
  };
  const e = attr.value.expression;
  if (e.type === 'ObjectExpression') collect(e);
  else if (e.type === 'ConditionalExpression') { collect(e.consequent); collect(e.alternate); }
  return out;
}

/** Shorthand padding -> [block, inline]. Accepts 8, '8px 12px', '4px 8px 4px'. */
function padding(s) {
  let block = null, inline = null;
  const p = s.padding;
  if (p) {
    const n = num(p);
    if (n !== null) { block = n; inline = n; }
    else if (p.type === 'StringLiteral') {
      const parts = p.value.trim().split(/\s+/).map(v => parseFloat(v));
      if (parts.every(Number.isFinite)) {
        if (parts.length === 1) { block = parts[0]; inline = parts[0]; }
        else if (parts.length === 2) { block = parts[0]; inline = parts[1]; }
        else if (parts.length === 3) { block = (parts[0] + parts[2]) / 2; inline = parts[1]; }
        else if (parts.length === 4) { block = (parts[0] + parts[2]) / 2; inline = (parts[1] + parts[3]) / 2; }
      }
    }
  }
  const pt = num(s.paddingTop), pb = num(s.paddingBottom);
  const pv = num(s.paddingBlock) ?? num(s.paddingVertical);
  if (pv !== null) block = pv;
  if (pt !== null || pb !== null) block = ((pt ?? block ?? 0) + (pb ?? block ?? 0)) / 2;
  const pl = num(s.paddingLeft), pr = num(s.paddingRight);
  const ph = num(s.paddingInline) ?? num(s.paddingHorizontal);
  if (ph !== null) inline = ph;
  if (pl !== null || pr !== null) inline = ((pl ?? inline ?? 0) + (pr ?? inline ?? 0)) / 2;
  return [block, inline];
}

const findings = [];
const files = walk(SRC);

for (const file of files) {
  const rel = relative(SRC, file);
  const code = readFileSync(file, 'utf8');
  let ast;
  try {
    ast = parse(code, { sourceType: 'module', plugins: ['jsx'] });
  } catch (err) {
    console.error(`  ! could not parse ${rel}: ${err.message}`);
    continue;
  }

  traverse(ast, {
    JSXOpeningElement(path) {
      const nameNode = path.node.name;
      const tag = nameNode.type === 'JSXIdentifier' ? nameNode.name : null;
      if (!tag) return;

      const attrs = path.node.attributes.filter(a => a.type === 'JSXAttribute');
      const has = n => attrs.find(a => a.name?.name === n);

      const isTag = INTERACTIVE.has(tag);
      const clickable = !!has('onClick') || !!has('onPointerDown');
      if (!isTag && !clickable) return;

      // Our own primitives own their sizing; that is the point of them.
      if (/^(Button|Toggle|Input|DragHandle|Card)$/.test(tag)) return;

      // A hidden file input behind a label is not a tap target.
      const styleAttr = has('style');
      const s = styleProps(styleAttr);
      const disp = s.display?.value;
      if (disp === 'none') return;
      if (tag === 'input') {
        const t = has('type');
        const tv = t?.value?.type === 'StringLiteral' ? t.value.value : null;
        if (tv === 'hidden') return;
      }

      // Nested inside another interactive element? The outer one is the target.
      // Start above this element's own JSXElement — the first parent of an
      // opening element is the element it opens, which would otherwise match
      // itself and silently empty the whole report.
      let anc = path.parentPath?.parentPath;
      let nested = false;
      while (anc) {
        if (anc.node.type === 'JSXElement') {
          const an = anc.node.openingElement?.name;
          const at = an?.type === 'JSXIdentifier' ? an.name : null;
          if (at && (INTERACTIVE.has(at) || at === 'Button')) { nested = true; break; }
        }
        anc = anc.parentPath;
      }
      if (nested) return;

      const h = num(s.height) ?? num(s.minHeight);
      const w = num(s.width) ?? num(s.minWidth);
      const [pBlock, pInline] = padding(s);
      const fs = num(s.fontSize);

      let computed = null, basis = '';
      if (h !== null) { computed = h; basis = 'height'; }
      else if (pBlock !== null) {
        const line = Math.round((fs ?? 16) * 1.3);
        computed = pBlock * 2 + line;
        basis = `padding ${pBlock}×2 + line ${line}`;
      }
      // No height and no padding: cannot tell statically, and most are text
      // links inside prose. Skip rather than guess.
      if (computed === null) return;

      let width = null;
      if (w !== null) width = w;
      else if (pInline !== null && (tag === 'button' || clickable)) width = null; // text-driven

      const tooShort = computed < MIN;
      const tooNarrow = width !== null && width < MIN;
      if (!tooShort && !tooNarrow) return;

      findings.push({
        file: rel,
        line: path.node.loc.start.line,
        tag,
        height: computed,
        width,
        basis,
        fontSize: fs,
        hasAria: !!has('aria-label'),
      });
    },
  });
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(findings, null, 2));
} else {
  const byFile = {};
  for (const f of findings) (byFile[f.file] ||= []).push(f);
  const ranked = Object.entries(byFile).sort((a, b) => b[1].length - a[1].length);
  console.log(`${findings.length} tap targets under ${MIN}px across ${ranked.length} files\n`);
  for (const [file, list] of ranked.slice(0, 25)) {
    console.log(`  ${String(list.length).padStart(3)}  ${file}`);
  }
  const dist = {};
  for (const f of findings) {
    const b = f.height < 24 ? '<24' : f.height < 32 ? '24-31' : f.height < 40 ? '32-39' : '40-43';
    dist[b] = (dist[b] || 0) + 1;
  }
  console.log('\n  by height:', JSON.stringify(dist));
}
