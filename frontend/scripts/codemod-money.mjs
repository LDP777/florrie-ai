/**
 * Move money figures onto <Money>, but only where the unit proves itself.
 *
 * There are 208 lines with a £ on them and one import of <Money>. The tempting
 * move is to convert all 208. Do not: this codebase mixes pence and pounds, and
 * the boundary is often nowhere near the render. EndOfDay.jsx renders a figure
 * in pounds only because a memo three functions earlier did `avgTicket / 100`.
 * A codemod that guesses wrong there does not produce a wonky margin, it tells
 * Ellie she earned £12.25 in a week when she earned £1,225.30.
 *
 * So this converts exactly the shapes that carry their own proof, in one
 * expression, with no tracing required:
 *
 *   £{expr.toFixed(2)}            -> <Money amount={expr} />        (pounds)
 *   £{(expr / 100).toFixed(2)}    -> <Money pence={expr} />         (pence)
 *   £{(expr/100).toFixed(0)}      -> <Money pence={expr} round />
 *
 * `.toFixed(2)` sitting directly after a £ is the proof: the author already
 * decided this value is pounds at this point. Everything else is left alone,
 * and check-money.mjs records how many remain so the number can only fall.
 *
 *   node scripts/codemod-money.mjs           # report
 *   node scripts/codemod-money.mjs --write
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from '@babel/parser';

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

// £{ ... .toFixed(2) }  — balanced to the matching brace, so a nested {} in the
// expression does not truncate it.
function findSites(code) {
  const out = [];
  let i = 0;
  while ((i = code.indexOf('£{', i)) !== -1) {
    let j = i + 2, depth = 1, quote = null;
    while (j < code.length && depth > 0) {
      const c = code[j];
      if (quote) { if (c === quote && code[j - 1] !== '\\') quote = null; }
      else if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '{') depth++;
      else if (c === '}') depth--;
      j++;
    }
    if (depth !== 0) break;
    out.push({ start: i, end: j, expr: code.slice(i + 2, j - 1).trim() });
    i = j;
  }
  return out;
}

let converted = 0, left = 0, filesTouched = 0;
const samples = [];

for (const file of walk(SRC)) {
  const rel = relative(SRC, file);
  if (rel.startsWith('components/ui/')) continue;
  const code = readFileSync(file, 'utf8');
  if (!code.includes('£{')) continue;

  const edits = [];
  for (const site of findSites(code)) {
    const e = site.expr;

    // The hand-rolled "drop the pence when it is a whole number" idiom:
    //   X % 100 === 0 ? (X / 100).toFixed(0) : (X / 100).toFixed(2)
    // which is exactly what <Money round /> does. Worth matching explicitly,
    // because otherwise the pounds rule below latches onto the trailing
    // .toFixed(2) of the false branch and emits a mangled ternary — which is
    // what it did, and what the post-edit parse check refused to write.
    let m = /^\(?\s*([\s\S]+?)\s*\)?\s*%\s*100\s*===\s*0\s*\?[\s\S]*?\.toFixed\(\s*0\s*\)\s*:[\s\S]*?\.toFixed\(\s*2\s*\)$/.exec(e);
    if (m) {
      edits.push({ ...site, text: `<Money pence={${m[1]}} round />` });
      if (samples.length < 6) samples.push(`${rel}: round-if-whole idiom  ->  <Money pence={${m[1]}} round />`);
      continue;
    }

    // Any other conditional is not safely convertible: the two branches may be
    // in different units, and there is no way to tell from here. `?.` and `??`
    // both contain a question mark and neither is a conditional, so strip them
    // before deciding — otherwise every optional-chained price is skipped.
    if (e.replace(/\?\?/g, '').replace(/\?\./g, '').includes('?')) { left++; continue; }

    // pence: (X / 100).toFixed(2)   or   (X/100).toFixed(0)
    m = /^\(\s*([\s\S]+?)\s*\/\s*100\s*\)\.toFixed\(\s*([02])\s*\)$/.exec(e);
    if (m) {
      const round = m[2] === '0' ? ' round' : '';
      edits.push({ ...site, text: `<Money pence={${m[1]}}${round} />` });
      if (samples.length < 6) samples.push(`${rel}: £{${e}}  ->  <Money pence={${m[1]}}${round} />`);
      continue;
    }
    // pounds: X.toFixed(2)
    m = /^([\s\S]+?)\.toFixed\(\s*2\s*\)$/.exec(e);
    if (m && !/\/\s*100\s*\)?\s*$/.test(m[1])) {
      edits.push({ ...site, text: `<Money amount={${m[1]}} />` });
      if (samples.length < 6) samples.push(`${rel}: £{${e}}  ->  <Money amount={${m[1]}} />`);
      continue;
    }
    left++;
  }

  if (!edits.length) continue;
  filesTouched++;
  converted += edits.length;
  if (!WRITE) continue;

  let out = code;
  edits.sort((a, b) => b.start - a.start);
  for (const ed of edits) out = out.slice(0, ed.start) + ed.text + out.slice(ed.end);

  if (!/^import Money from/m.test(out)) {
    const depth = rel.split('/').length - 1;
    const path0 = depth === 0 ? './components/ui/Money' : '../'.repeat(depth) + 'components/ui/Money';
    const lastImport = [...out.matchAll(/^import .*$/gm)].pop();
    const line = `import Money from '${path0}';`;
    out = lastImport
      ? out.slice(0, lastImport.index + lastImport[0].length) + '\n' + line + out.slice(lastImport.index + lastImport[0].length)
      : line + '\n' + out;
  }

  try { parse(out, { sourceType: 'module', plugins: ['jsx'] }); }
  catch (err) { console.log(`  REFUSED ${rel}: ${err.message}`); continue; }
  writeFileSync(file, out);
}

console.log(`${WRITE ? 'converted' : 'would convert'} ${converted} money figures across ${filesTouched} files`);
console.log(`  left alone (unit not provable in the expression): ${left}`);
for (const s of samples) console.log('    ' + s);
