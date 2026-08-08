/**
 * Darken the INK of a badge that declares its own background, and nothing else.
 *
 * check-swatches found 60 colour pairs under AA. About two thirds are the same
 * shape: dark-ish text on a pale tint — #F44336 on #FFEBEE, #B8860B on #FFF5E6,
 * #4A90D9 on #EEF4FC — status chips pasted from a Material palette that were
 * never measured against the tint they sit on.
 *
 * For those, the fix is unambiguous and invisible: keep the tint, keep the hue
 * and the saturation, move the lightness of the TEXT until it clears 5:1.
 * lib/brand-colour.js already does exactly this, and it is what was done to the
 * brand colour on the booking page.
 *
 * Deliberately narrow. It will not touch:
 *   - white (or near-white) on a colour, where the fix is to darken the
 *     BACKGROUND and that is a visible design decision, not a correction
 *   - anything where the text is already the lighter of the two
 *   - a hex that is a var() fallback, since the token is what actually renders
 *     and moving the fallback would put the two out of step
 *
 * Edits are spliced at AST offsets so formatting survives, and every file is
 * re-parsed before it is written — a codemod that emits something unparseable
 * has happened here before.
 *
 *   node scripts/codemod-swatches.mjs --dry
 *   node scripts/codemod-swatches.mjs
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from '@babel/parser';
import { contrast, readableOn } from '../src/lib/brand-colour.js';

const SRC = new URL('../src', import.meta.url).pathname;
const DRY = process.argv.includes('--dry');
/** Darkening a fill is visible; darkening ink is not. Opt in explicitly. */
const BACKGROUNDS = process.argv.includes('--backgrounds');
const BRAND_EXEMPT = new Set(['#25d366']);   // WhatsApp green

function files(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.jsx?$/.test(e)) out.push(p);
  }
  return out;
}

const HEX_ONLY = /^#[0-9a-f]{6}$|^#[0-9a-f]{3}$/i;
const keyOf = (p) => (p.key?.name || p.key?.value || '').toString();
const BG = /^(background|backgroundColor|bg|bgColor|bgColour)$/;
const FG = /^(color|colour|textColor|textColour|fg)$/;
/**
 * Is the ink darker than its ground? That, not "is it a light colour", is what
 * decides whether darkening the ink helps. A first pass asked whether the text
 * was closer to white than to black, which calls #F44336 "light" — it sits
 * almost exactly between the two — and so skipped fifty-seven of the sixty
 * pairs this was written to fix.
 */
const darkerThan = (fg, bg) => contrast(fg, '#ffffff') > contrast(bg, '#ffffff');

/**
 * The literal NODES, not the hex strings — an edit needs an offset.
 * Only whole-value hexes: `'#F44336'` yes, `'var(--x, #F44336)'` no, because
 * rewriting a fallback leaves it disagreeing with the token it stands in for.
 */
function litsIn(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'StringLiteral') {
    if (HEX_ONLY.test(node.value.trim())) out.push(node);
    return out;
  }
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'leadingComments' || k === 'trailingComments') continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach(n => litsIn(n, out));
    else if (v && typeof v.type === 'string') litsIn(v, out);
  }
  return out;
}

/** Same branch-to-branch walk as check-swatches, but carrying nodes. */
function pairUp(bgNode, fgNode, out) {
  const cond = (n) => n && n.type === 'ConditionalExpression';
  if (cond(bgNode) && cond(fgNode)) {
    pairUp(bgNode.consequent, fgNode.consequent, out);
    pairUp(bgNode.alternate, fgNode.alternate, out);
    return;
  }
  if (cond(bgNode)) { pairUp(bgNode.consequent, fgNode, out); pairUp(bgNode.alternate, fgNode, out); return; }
  if (cond(fgNode)) { pairUp(bgNode, fgNode.consequent, out); pairUp(bgNode, fgNode.alternate, out); return; }
  // The background may be a var() or a gradient; its hex is still what renders
  // behind the text, so it is read loosely. Only the FOREGROUND has to be a
  // bare literal, because only the foreground gets rewritten.
  const bgHexes = [];
  (function scan(n) {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'StringLiteral') {
      // Offsets inside the string, so a stop inside a gradient can be
      // rewritten without disturbing the rest of the declaration.
      for (const m of n.value.matchAll(/#[0-9a-f]{6}\b/gi)) {
        bgHexes.push({ hex: m[0], node: n, at: m.index, isWhole: n.value.trim() === m[0] });
      }
      return;
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(scan); else if (v && typeof v.type === 'string') scan(v);
    }
  })(bgNode);
  for (const b of bgHexes) for (const f of litsIn(fgNode)) out.push([b, f]);
}

let changed = 0, skipped = 0, touchedFiles = 0;
const log = [];

for (const file of files(SRC)) {
  const code = readFileSync(file, 'utf8');
  if (!/#[0-9a-f]{6}/i.test(code)) continue;
  let ast;
  try { ast = parse(code, { sourceType: 'module', plugins: ['jsx'], errorRecovery: true }); } catch { continue; }

  const objects = [];
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ObjectExpression') objects.push(node);
    for (const k of Object.keys(node)) {
      if (k === 'loc') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === 'string') walk(v);
    }
  })(ast.program);

  const edits = [];
  for (const obj of objects) {
    const props = obj.properties.filter(p => p.type === 'ObjectProperty');
    const bgProp = props.find(p => BG.test(keyOf(p)));
    const fgProp = props.find(p => FG.test(keyOf(p)));
    if (!bgProp || !fgProp) continue;

    const combos = [];
    pairUp(bgProp.value, fgProp.value, combos);

    for (const [bgRef, node] of combos) {
      const bg = bgRef.hex;
      const fg = node.value.trim();
      if (contrast(fg, bg) >= 4.5) continue;

      if (darkerThan(fg, bg)) {
        // Dark ink on a pale tint: move the INK. Invisible change to the layout,
        // same hue, and it never touches a design decision.
        const next = readableOn(fg, bg, 5.0);
        if (next.toLowerCase() === fg.toLowerCase()) { skipped++; continue; }
        edits.push({ start: node.start + 1, end: node.end - 1, to: next, from: fg, bg, line: node.loc.start.line, what: 'ink' });
        continue;
      }

      // White on a pale fill: the FILL is what is wrong — white cannot be
      // darkened. Only with --backgrounds, because this one is visible: the
      // chip gets deeper. Requested separately so it can be reviewed as the
      // design change it is.
      if (!BACKGROUNDS) { skipped++; continue; }
      // Somebody else's brand colour is not ours to correct. #25D366 is
      // WhatsApp green and white-on-it is WhatsApp's own button; darkening it
      // to pass AA makes the button stop reading as WhatsApp, which is a worse
      // outcome than the contrast. Left in the baseline, deliberately.
      if (BRAND_EXEMPT.has(bg.toLowerCase())) { skipped++; continue; }
      const next = readableOn(bg, fg, 5.0);
      if (next.toLowerCase() === bg.toLowerCase()) { skipped++; continue; }
      // +1 for the opening quote of the string literal.
      const start = bgRef.node.start + 1 + bgRef.at;
      edits.push({ start, end: start + bg.length, to: next, from: bg, bg: fg, line: bgRef.node.loc.start.line, what: 'fill' });
    }
  }
  if (!edits.length) continue;

  // Right to left, so earlier offsets stay valid.
  edits.sort((a, b) => b.start - a.start);
  let out = code;
  const seen = new Set();
  for (const e of edits) {
    if (seen.has(e.start)) continue;      // same literal reached via two branches
    seen.add(e.start);
    out = out.slice(0, e.start) + e.to + out.slice(e.end);
    log.push(`  ${relative(SRC, file)}:${e.line}  ${e.what}: ${e.from} -> ${e.to}  (other side ${e.bg})`);
    changed++;
  }

  // Never write something that will not parse. This has bitten before: a hand
  // edit swallowed a trailing comma into a comment and the build failure was
  // masked by an unrelated ENOENT for four commits.
  try { parse(out, { sourceType: 'module', plugins: ['jsx'] }); }
  catch (err) {
    console.error(`✗ refusing to write ${relative(SRC, file)} — the result does not parse: ${err.message}`);
    process.exit(1);
  }

  if (!DRY) writeFileSync(file, out);
  touchedFiles++;
}

console.log(log.join('\n'));
console.log(`\n${DRY ? 'would darken' : 'darkened'} ${changed} text colour(s) across ${touchedFiles} file(s); ` +
  `left ${skipped} where the background is the thing to change`);
