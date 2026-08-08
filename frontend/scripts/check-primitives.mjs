/**
 * The drift ratchet.
 *
 * The audit's root finding was that `components/ui/` existed and nothing
 * imported it: 847 hand-styled <button>s across 91 files against one <Button>.
 * Rewriting the primitives does not fix that on its own — the next feature
 * still rolls its own, because rolling your own is quicker than importing.
 *
 * So this counts the hand-styled elements per file and compares against a
 * committed baseline. The count may go DOWN freely. It may never go UP.
 *
 * That is deliberately not "convert everything now": 639 of those buttons are
 * genuine one-offs, and a codemod that guesses at them would ship 639 subtle
 * visual regressions to a live user. The ratchet lets the number fall as
 * screens are touched, while making the drift itself impossible to continue.
 *
 *   node scripts/check-primitives.mjs           # check
 *   node scripts/check-primitives.mjs --update  # re-record, only ever downward
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = new URL('../src', import.meta.url).pathname;
const BASELINE = new URL('./primitives-baseline.json', import.meta.url).pathname;
const UPDATE = process.argv.includes('--update');

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.jsx')) out.push(p);
  }
  return out;
};

// A hand-styled button: a raw <button> carrying its own style. A raw <button>
// with no style is fine — that is a reset, and Button would only get in the way.
//
// Scanned rather than regexed. A regex for "<button ... style=" misses every
// button whose tag contains a `>` inside a handler (`onClick={() => a > b}`),
// and this codebase has plenty — a naive pattern found 338 of the real 847,
// which would have left the ratchet full of holes to drift through.
function countStyledButtons(src) {
  let count = 0;
  let i = 0;
  while ((i = src.indexOf('<button', i)) !== -1) {
    const after = src[i + 7];
    if (after && !/[\s>/]/.test(after)) { i += 7; continue; }
    let j = i + 7, depth = 0, quote = null, end = -1;
    while (j < src.length) {
      const c = src[j];
      if (quote) { if (c === quote && src[j - 1] !== '\\') quote = null; }
      else if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) { end = j; break; }
      j++;
    }
    if (end === -1) break;
    if (/\bstyle\s*=/.test(src.slice(i, end))) count++;
    i = end + 1;
  }
  return count;
}

const counts = {};
let total = 0;
for (const file of walk(SRC)) {
  const rel = relative(SRC, file);
  // The primitives are allowed to style themselves; that is their job.
  if (rel.startsWith('components/ui/')) continue;
  const src = readFileSync(file, 'utf8');
  const n = countStyledButtons(src);
  if (n) { counts[rel] = n; total += n; }
}

if (UPDATE) {
  const prev = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : { files: {} };
  const merged = {};
  for (const [f, n] of Object.entries(counts)) {
    const was = prev.files?.[f];
    // Never ratchet a file upward, even with --update. If a file legitimately
    // grew, the fix is to use the primitive, not to raise the ceiling.
    merged[f] = was === undefined ? n : Math.min(was, n);
  }
  writeFileSync(BASELINE, JSON.stringify({
    note: 'Hand-styled <button> count per file. May only ever decrease. See scripts/check-primitives.mjs.',
    total: Object.values(merged).reduce((a, b) => a + b, 0),
    files: merged,
  }, null, 2) + '\n');
  console.log(`recorded baseline: ${Object.values(merged).reduce((a, b) => a + b, 0)} hand-styled buttons across ${Object.keys(merged).length} files`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error('✗ no baseline. Run: node scripts/check-primitives.mjs --update');
  process.exit(1);
}

const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
const regressions = [];
for (const [file, n] of Object.entries(counts)) {
  const allowed = base.files[file] ?? 0;
  if (n > allowed) regressions.push(`${file}: ${n} hand-styled buttons, baseline allows ${allowed}`);
}

if (regressions.length) {
  console.error(
    `✗ primitives: ${regressions.length} file(s) added hand-styled buttons\n  ` +
    regressions.join('\n  ') +
    `\n\n  Use <Button> from components/ui/Button.jsx.\n` +
    `  variants: primary | secondary | tonal | quiet | chip | danger\n` +
    `  sizes:    xs | sm | md | lg, or icon\n` +
    `  If the button genuinely cannot be expressed by the primitive, say so in\n` +
    `  the PR and re-record with --update.\n`
  );
  process.exit(1);
}

const improved = Object.entries(base.files).reduce(
  (a, [f, n]) => a + Math.max(0, n - (counts[f] ?? 0)), 0
);
console.log(
  `✓ primitives: ${total} hand-styled buttons (baseline ${base.total})` +
  (improved ? `, ${improved} fewer than baseline` : '') +
  `. None added.`
);
