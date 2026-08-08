/**
 * The palette has to be readable before anything painted with it can be.
 *
 * Nine of the fourteen contrast failures found on the second sweep were not
 * page bugs at all. `--success: #3F7D5C` on `--success-bg: #E9F0EB` measures
 * 4.22:1 — the design system's OWN status pair, below AA, used across forty-two
 * files. Fixing the five pages the browser sweep happened to flag would have
 * left the identical failure on every page it did not reach, and every page
 * written next week.
 *
 * check-live can only grade a pairing it actually finds rendered. This grades
 * the pairing wherever it is declared, so a token that is unreadable is caught
 * the moment it is written rather than whenever a route that uses it gets added
 * to a sweep.
 *
 * Pairs are matched by name: `--x` (and `--x-text`) are assumed to be written
 * ON `--x-bg`, which is the convention theme.jsx already follows.
 *
 *   node scripts/check-tokens.mjs
 */
import { readFileSync } from 'node:fs';
import { contrast } from '../src/lib/brand-colour.js';

const SRC = new URL('../src/lib/theme.jsx', import.meta.url).pathname;
const src = readFileSync(SRC, 'utf8');

/** The light and dark blocks, so a dark-mode token is judged on dark ground. */
function themes() {
  const out = [];
  // Each theme is an object literal of '--token': '#value' pairs. Splitting on
  // the exported names rather than brace-counting keeps this readable and is
  // enough: the file has exactly two.
  const marks = [...src.matchAll(/const\s+(\w*(?:LIGHT|DARK|light|dark)\w*)\s*=\s*\{/g)];
  if (!marks.length) return out;
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i].index;
    const to = i + 1 < marks.length ? marks[i + 1].index : src.length;
    const body = src.slice(from, to);
    const vars = {};
    for (const m of body.matchAll(/'(--[a-z0-9-]+)'\s*:\s*'([^']+)'/g)) vars[m[1]] = m[2];
    out.push({ name: marks[i][1], vars });
  }
  return out;
}

const isHex = (v) => /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(String(v).trim());

/**
 * Only tokens that are INK get graded, and only against the ground they are
 * actually written on. That distinction is the whole design of this check.
 *
 * A first version graded every hex against the card colour and produced
 * seventeen findings, of which zero were real: `--card` against itself at
 * 1:1, `--card-border` at 1.31:1, `--on-accent` — which is white, and is by
 * definition never written on the page. Seventeen non-findings is worse than
 * no check, because the next person to see it turns it off.
 *
 * So the scope is stated rather than inferred: a token is graded when it has
 * a companion `-bg` naming its own ground, or when it is one of the handful of
 * tokens that are written straight onto the page.
 */
const ON_PAGE = new Set([
  '--text-primary', '--text-secondary', '--text-muted', '--text-tertiary',
  '--accent', '--success', '--warning', '--danger', '--gold', '--gold-text',
  '--on-surface', '--on-surface-variant', '--link',
]);

const problems = [];
const checked = [];
for (const { name, vars } of themes()) {
  const page = isHex(vars['--bg-card']) ? vars['--bg-card']
    : isHex(vars['--bg']) ? vars['--bg'] : null;

  for (const [token, value] of Object.entries(vars)) {
    if (!isHex(value)) continue;
    // Grounds, not ink. `--card` has a `--card-bg` companion, which made the
    // name-pairing rule grade the card colour against itself at 1:1.
    if (/^--(bg|card|surface|tone|border|outline|shadow|overlay|scrim)/.test(token)) continue;
    if (/-(bg|border|fill|wash|dim|light|fixed|container)$/.test(token)) continue;

    const base = token.replace(/-text$/, '');
    const own = vars[`${base}-bg`];
    const bg = isHex(own) ? own : (ON_PAGE.has(token) ? page : null);
    if (!bg) continue;

    const got = contrast(value, bg);
    checked.push(`${name} ${token}`);
    if (got < 4.5) problems.push({ theme: name, token, value, bg, ratio: Math.round(got * 100) / 100 });
  }
}

if (!checked.length) {
  console.error('✗ tokens: parsed no themes out of src/lib/theme.jsx.\n' +
    '  A check that grades nothing reports green forever. The theme objects are\n' +
    '  probably no longer named *LIGHT*/*DARK*, or no longer object literals.\n');
  process.exit(1);
}

// Prove the grader can fail, for the same reason: this file's whole job is to
// go red, and it has no natural failing case once the palette is fixed.
if (contrast('#3F7D5C', '#E9F0EB') >= 4.5 || contrast('#386F52', '#E9F0EB') < 4.5) {
  console.error('✗ tokens: the contrast maths disagrees with the pair this check was\n' +
    '  written for — #3F7D5C on #E9F0EB is 4.22:1 and must fail, #386F52 is\n' +
    '  5.09:1 and must pass. If that is not what it computes, nothing below means anything.\n');
  process.exit(1);
}

if (problems.length) {
  console.error(`✗ tokens: ${problems.length} palette pair(s) below WCAG AA\n`);
  for (const p of problems) {
    console.error(`  ${p.theme}  ${p.token}: ${p.value} on ${p.bg} — ${p.ratio}:1, needs 4.5`);
  }
  console.error('\n  These are tokens, so every page using them is unreadable, including\n' +
    '  the ones no sweep visits. Fix the palette, not the pages.\n');
  process.exit(1);
}
console.log(`✓ tokens: ${checked.length} palette pairs, all at or above WCAG AA`);
