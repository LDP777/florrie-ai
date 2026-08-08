/**
 * Grade every colour pair the source declares in one place.
 *
 * check-live grades what is painted, which is the truth — but only for the
 * states its fixtures can produce. It found `#B8860B` on the photo-consent
 * card at 3.18:1. A source scan then turned up FORTY-SEVEN distinct hexes used
 * as text colours that fall under AA on cream, in files the sweep either does
 * not reach or reaches in a state where that badge is not on screen. Stock
 * Material amber, `#F44336`, `#FF9800`, `#25D366` — colours that read as
 * "obviously green" or "obviously red" and so never get looked at twice.
 *
 * Blindly grading every hex against the card colour is wrong, though: half of
 * those are white text on a coloured chip, which is fine, and this check going
 * off on `color: '#FFFFFF'` would get it deleted within a day.
 *
 * So it only grades pairs the source states TOGETHER — a style object or a
 * `style={{...}}` that sets both a background and a colour. That covers the
 * badge and chip definitions, which is where nearly all of these live, and it
 * never has to guess what is behind anything.
 *
 *   node scripts/check-swatches.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from '@babel/parser';
import { contrast, readableOn } from '../src/lib/brand-colour.js';

const SRC = new URL('../src', import.meta.url).pathname;

function files(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.jsx?$/.test(e)) out.push(p);
  }
  return out;
}

const HEX = /^#[0-9a-f]{3}(?:[0-9a-f]{6})?$|^#[0-9a-f]{6}$/i;

/**
 * Every hex literal reachable inside a value expression, in source order.
 * A badge is routinely written as `bg: a ? '#X' : '#Y', color: a ? '#P' : '#Q'`,
 * so both sides have to be collected rather than just the simple case.
 * `var(--token, #fallback)` counts: the fallback is what renders when the
 * token is missing, and it is the value that drifts.
 */
function hexesIn(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'StringLiteral') {
    const v = node.value.trim();
    if (HEX.test(v)) out.push(v);
    else for (const m of v.matchAll(/#[0-9a-f]{6}\b/gi)) out.push(m[0]);
    return out;
  }
  if (node.type === 'TemplateLiteral') { for (const q of node.quasis) for (const m of q.value.raw.matchAll(/#[0-9a-f]{6}\b/gi)) out.push(m[0]); }
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'leadingComments' || k === 'trailingComments') continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach(n => hexesIn(n, out));
    else if (v && typeof v.type === 'string') hexesIn(v, out);
  }
  return out;
}

/**
 * Match branch to branch, not hex to hex.
 *
 * A selected/unselected button is one condition written twice:
 *
 *   background: selected ? brand    : '#F0ECE8',
 *   color:      selected ? '#fff'   : 'var(--text-secondary)',
 *
 * Flattening both sides to lists of hexes and zipping them pairs '#F0ECE8'
 * with '#fff' — a combination that never renders — and reports white on pale
 * beige at 1.18:1. Seven of the first hundred findings were this, and a
 * seventh of a report being fiction is enough to get the whole thing ignored.
 *
 * Walking the two expressions in step instead means the consequent of one is
 * only ever compared with the consequent of the other. Where only one side
 * branches, that branch is compared against the whole of the other, which is
 * correct: the unbranched value renders under both.
 */
function pairUp(bgNode, fgNode, out) {
  const cond = (n) => n && (n.type === 'ConditionalExpression');
  if (cond(bgNode) && cond(fgNode)) {
    pairUp(bgNode.consequent, fgNode.consequent, out);
    pairUp(bgNode.alternate, fgNode.alternate, out);
    return;
  }
  if (cond(bgNode)) { pairUp(bgNode.consequent, fgNode, out); pairUp(bgNode.alternate, fgNode, out); return; }
  if (cond(fgNode)) { pairUp(bgNode, fgNode.consequent, out); pairUp(bgNode, fgNode.alternate, out); return; }
  for (const b of hexesIn(bgNode)) for (const f of hexesIn(fgNode)) out.push([b, f]);
}

const keyOf = (p) => (p.key?.name || p.key?.value || '').toString();
const BG = /^(background|backgroundColor|bg|bgColor|bgColour)$/;
const FG = /^(color|colour|textColor|textColour|fg)$/;

const findings = [];
let pairs = 0;

for (const file of files(SRC)) {
  const code = readFileSync(file, 'utf8');
  if (!/#[0-9a-f]{6}/i.test(code)) continue;
  let ast;
  try { ast = parse(code, { sourceType: 'module', plugins: ['jsx'], errorRecovery: true }); }
  catch { continue; }

  const objects = [];
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ObjectExpression') objects.push(node);
    for (const k of Object.keys(node)) {
      if (k === 'loc') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
  })(ast.program);

  for (const obj of objects) {
    const props = obj.properties.filter(p => p.type === 'ObjectProperty');
    const bgProp = props.find(p => BG.test(keyOf(p)));
    const fgProp = props.find(p => FG.test(keyOf(p)));
    if (!bgProp || !fgProp) continue;

    const bgs = hexesIn(bgProp.value);
    const fgs = hexesIn(fgProp.value);
    if (!bgs.length || !fgs.length) continue;

    const combos = [];
    pairUp(bgProp.value, fgProp.value, combos);

    for (const [bg, fg] of combos) {
      pairs++;
      const got = contrast(fg, bg);
      if (got >= 4.5) continue;
      // Which end to move. White on a mid-tone chip fails because the CHIP is
      // too pale — suggesting a darker white is nonsense, and a suggestion
      // that is nonsense is how a report gets skimmed instead of read.
      const light = (h) => contrast(h, '#000000') > contrast(h, '#ffffff');
      const suggest = light(fg) && light(bg)
        ? `darken the background to ${readableOn(bg, fg, 5.0)}`
        : `${readableOn(fg, bg, 5.0)}`;
      findings.push({
        file: relative(SRC, file), line: fgProp.loc.start.line,
        fg, bg, ratio: Math.round(got * 100) / 100, suggest,
      });
    }
  }
}

// This check has no failing case left once the palette is fixed, and a grader
// that only ever returns green is indistinguishable from one that is broken.
const probe = contrast('#B8860B', '#FFF5E6');
if (!(probe > 2.5 && probe < 4.5)) {
  console.error('✗ swatches: the contrast maths disagrees with the pair this was written\n' +
    `  for — #B8860B on #FFF5E6 is about 3:1 and must fail. It computed ${probe.toFixed(2)}.\n`);
  process.exit(1);
}
if (!pairs) {
  console.error('✗ swatches: found no background/colour pairs at all in src/.\n' +
    '  There are dozens. The AST walk has stopped matching, and a check that\n' +
    '  grades nothing reports green forever.\n');
  process.exit(1);
}

/**
 * A ratchet, not a gate.
 *
 * There were 83 of these on the day this was written, across thirty-odd files,
 * and several are design decisions rather than slips — white on the brand pink
 * is on nearly every primary button in the app. Failing the build on all of
 * them means the build is red until someone finds a day, which in practice
 * means the check gets deleted. Failing on anything NEW means the number can
 * only go down, and it goes down while other work happens.
 *
 * Keyed on file + colours, deliberately not on line number: moving a button
 * fifteen lines down a file is not a new defect, and a baseline that churns on
 * every unrelated edit is a baseline nobody re-records honestly.
 */
const BASELINE = new URL('./swatches-baseline.json', import.meta.url).pathname;
const key = (f) => `${f.file} ${f.fg.toLowerCase()} on ${f.bg.toLowerCase()}`;

let known = [];
try { known = JSON.parse(readFileSync(BASELINE, 'utf8')).known || []; } catch {}
const knownSet = new Set(known);

if (process.argv.includes('--record')) {
  const { writeFileSync } = await import('node:fs');
  const list = [...new Set(findings.map(key))].sort();
  writeFileSync(BASELINE, JSON.stringify({
    note: 'Colour pairs below WCAG AA that predate check-swatches. New ones fail CI; this list may only shrink.',
    known: list,
  }, null, 2) + '\n');
  console.log(`recorded ${list.length} known pair(s) to swatches-baseline.json`);
  process.exit(0);
}

const fresh = findings.filter(f => !knownSet.has(key(f)));
const stillThere = new Set(findings.map(key));
const fixed = known.filter(k => !stillThere.has(k));

if (fresh.length) {
  const byFile = {};
  for (const f of fresh) (byFile[f.file] ||= []).push(f);
  console.error(`✗ swatches: ${fresh.length} NEW colour pair(s) below WCAG AA (${pairs} pairs checked, ${known.length} known)\n`);
  for (const [file, list] of Object.entries(byFile)) {
    console.error(`  ${file}`);
    for (const f of list) console.error(`    :${f.line}  ${f.fg} on ${f.bg} — ${f.ratio}:1, needs 4.5   try ${f.suggest}`);
  }
  console.error('\n  Prefer a semantic token (--success / --warning / --danger) over a new hex:\n' +
    '  a token is graded by check:tokens forever, a hex is graded once, here.\n' +
    '  If one of these is genuinely intended, say why in a comment and re-record\n' +
    '  with `npm run check:swatches -- --record`.\n');
  process.exit(1);
}

if (fixed.length) {
  console.error(`✗ swatches: ${fixed.length} baseline entr(y/ies) no longer fail — re-record so they cannot come back:\n`);
  for (const k of fixed) console.error(`    ${k}`);
  console.error('\n  npm run check:swatches -- --record\n');
  process.exit(1);
}

console.log(`✓ swatches: ${pairs} declared colour pairs, no new failures (${known.length} known, tracked in swatches-baseline.json)`);
