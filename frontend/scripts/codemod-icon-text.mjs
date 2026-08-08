/**
 * Fix icon names that are being rendered as words.
 *
 * This is fallout from my own emoji migration, and it is the worst kind of
 * regression: it built, it passed every check, and it put the literal words
 * "card", "phone", "pound", "wallet" down the side of the Payments screen
 * where four icons used to be. Ellie saw it before any test did.
 *
 * The cause is that the migration understood JSX and did not understand data.
 * Where an emoji sat in an options array —
 *
 *     { key: 'cash', label: 'Cash', icon: '💷' }
 *
 * — it correctly rewrote the value to 'pound', but the render site four
 * hundred lines away is `<span>{method.icon}</span>`, which now prints the
 * name. 42 sites across 25 screens.
 *
 * Two shapes need different answers:
 *
 *  - normal elements get `<Icon name={iconName(expr)} inline />`, which keeps
 *    the surrounding span's font-size because Icon reads style.fontSize.
 *  - <option> cannot contain an SVG at all. Browsers render option children as
 *    plain text, so an icon there is not achievable and never was; the emoji
 *    only ever worked because it was a character. Those drop the glyph and
 *    keep the label, which is what a native select can show.
 *
 *   node scripts/codemod-icon-text.mjs           # report
 *   node scripts/codemod-icon-text.mjs --write
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
const traverse = _traverse.default || _traverse;

const SRC = new URL('../src', import.meta.url).pathname;
const WRITE = process.argv.includes('--write');
const KEY = /^(icon|emoji|glyph|symbol|iconName)$/i;

const walk = (dir, out = []) => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.jsx')) out.push(p);
  }
  return out;
};

let wrapped = 0, dropped = 0, files = 0;
const notes = [];

for (const file of walk(SRC)) {
  const rel = relative(SRC, file);
  const code = readFileSync(file, 'utf8');
  let ast;
  try { ast = parse(code, { sourceType: 'module', plugins: ['jsx'] }); }
  catch { notes.push(`${rel}: does not parse`); continue; }

  const edits = [];
  let needsIcon = false;

  traverse(ast, {
    JSXExpressionContainer(path) {
      if (path.parent.type !== 'JSXElement') return;      // children position only
      const e = path.node.expression;

      let prop = null;
      if (e.type === 'MemberExpression' && e.property?.name) prop = e.property.name;
      else if (e.type === 'Identifier') prop = e.name;
      if (!prop || !KEY.test(prop)) return;

      const parentTag = path.parent.openingElement?.name?.name;
      if (parentTag === 'Icon') return;

      const expr = code.slice(e.start, e.end);

      if (parentTag === 'option') {
        // Drop the glyph and any single space that followed it.
        let end = path.node.end;
        const after = code.slice(end, end + 2);
        if (after.startsWith(' ')) end += 1;
        edits.push({ start: path.node.start, end, text: '' });
        dropped++;
        notes.push(`${rel}:${path.node.loc.start.line}  <option> cannot hold an icon; dropped ${expr}`);
        return;
      }

      edits.push({
        start: path.node.start,
        end: path.node.end,
        text: `<Icon name={iconName(${expr})} inline />`,
      });
      needsIcon = true;
      wrapped++;
    },
  });

  if (!edits.length) continue;
  files++;
  if (!WRITE) continue;

  let out = code;
  edits.sort((a, b) => b.start - a.start);
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);

  // Make sure Icon and iconName are actually in scope. Half a fix is worse
  // than none: it would swap a wrong word for a blank screen.
  if (needsIcon) {
    const hasDefault = /import\s+Icon\s*(,|from)/.test(out);
    const hasNamed = /\biconName\b[^\n]*from\s*['"][^'"]*Icon['"]/.test(out) ||
                     /import\s+Icon\s*,\s*\{[^}]*iconName[^}]*\}/.test(out);
    if (!hasDefault || !hasNamed) {
      const depth = rel.split('/').length - 1;
      const path0 = rel.startsWith('components/ui/') ? './Icon'
        : (depth === 0 ? './components/ui/Icon' : '../'.repeat(depth) + 'components/ui/Icon');
      const existing = out.match(/^import\s+Icon\s*(?:,\s*\{([^}]*)\})?\s*from\s*(['"])([^'"]+)\2;?\s*$/m);
      if (existing) {
        const names = new Set((existing[1] || '').split(',').map(s => s.trim()).filter(Boolean));
        names.add('iconName');
        out = out.replace(existing[0], `import Icon, { ${[...names].join(', ')} } from '${existing[3]}';`);
      } else {
        const lastImport = [...out.matchAll(/^import .*$/gm)].pop();
        const line = `import Icon, { iconName } from '${path0}';`;
        out = lastImport
          ? out.slice(0, lastImport.index + lastImport[0].length) + '\n' + line + out.slice(lastImport.index + lastImport[0].length)
          : line + '\n' + out;
      }
    }
  }

  try { parse(out, { sourceType: 'module', plugins: ['jsx'] }); }
  catch (err) { notes.push(`${rel}: REFUSED, would not parse (${err.message})`); continue; }
  writeFileSync(file, out);
}

console.log(`${WRITE ? 'fixed' : 'would fix'} ${wrapped} icon(s) rendered as text, dropped ${dropped} from <option>, across ${files} files`);
for (const n of notes) console.log('  ' + n);
