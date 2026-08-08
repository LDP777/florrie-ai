/**
 * The floating chrome and the space reserved for it must agree.
 *
 * Ellie's screenshots showed "Settings" and "How Florrie helped" rendered
 * underneath the word "Back". The Back pill is position:fixed over the scroll
 * region, so it covers the top 56px of every secondary screen, and nothing
 * reserved that space. PageHeader padded 60px to dodge it — but only nine
 * screens import PageHeader, and PageScaffold, which was written to solve this
 * exact problem and says so in its docblock, has zero imports.
 *
 * The band is reserved once in App.jsx now. This keeps the two numbers tied
 * together: move the pill and the reservation must move with it, or the build
 * fails rather than the title quietly slides under it again.
 *
 * Also catches the second half of the same screenshot: a page rendering its own
 * back button while the global one floats over it, which is two identical
 * affordances 14px apart.
 *
 *   node scripts/check-chrome.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = new URL('../src', import.meta.url).pathname;
const app = readFileSync(join(SRC, 'App.jsx'), 'utf8');
const fail = [];

// --- 1. geometry ------------------------------------------------------------
// The pill: top: calc(env(safe-area-inset-top, 0px) + Npx), height: H
const pill = app.slice(app.indexOf('function FloatingBack'));
const topPx = /top:\s*'calc\(env\(safe-area-inset-top,\s*0px\)\s*\+\s*(\d+)px\)'/.exec(pill);
const heightPx = /height:\s*(\d+)\s*,/.exec(pill);
const reserved = /paddingTop:\s*showBackPill\s*\n?\s*\?\s*'calc\(var\(--shell-top\)\s*\+\s*(\d+)px\)'/.exec(app);

if (!topPx) fail.push('cannot find the Back pill top offset in App.jsx');
if (!heightPx) fail.push('cannot find the Back pill height in App.jsx');
if (!reserved) fail.push('the scroll region no longer reserves a band for the Back pill (paddingTop: showBackPill ? ...)');

if (topPx && heightPx && reserved) {
  const need = Number(topPx[1]) + Number(heightPx[1]);
  const got = Number(reserved[1]);
  if (got < need) {
    fail.push(
      `the Back pill occupies ${need}px (top ${topPx[1]} + height ${heightPx[1]}) ` +
      `but only ${got}px is reserved — page titles will render underneath it`);
  }
}

// --- 2. one condition, not two ---------------------------------------------
// The pill's visibility and its reservation must come from the same expression.
if (!/const showBackPill\s*=/.test(app)) {
  fail.push('showBackPill is gone; the pill and its reserved band can drift apart again');
}
if (/\{showNav && location\.pathname !== '\/calendar\/full' && <FloatingBack/.test(app)) {
  fail.push('FloatingBack is rendered from its own condition again instead of showBackPill');
}

// --- 3. no page ships a second back button ---------------------------------
// Pages the global pill does not cover are allowed their own.
const OWN_BACK_OK = new Set([
  'pages/CalendarFull.jsx',    // pill suppressed on this route
  'pages/Onboarding.jsx',      // pre-auth, no shell chrome
  'pages/Login.jsx',
  'pages/BookingPage.jsx',     // public client-facing page, no app shell
  'pages/ClientPortal.jsx',
  'pages/ConsultationFormPublic.jsx',
  'pages/UpdatePassword.jsx',
]);

const walk = (dir, out = []) => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.jsx')) out.push(p);
  }
  return out;
};

for (const file of walk(join(SRC, 'pages'))) {
  const rel = relative(SRC, file);
  if (OWN_BACK_OK.has(rel)) continue;
  const code = readFileSync(file, 'utf8');
  const m = /aria-label=["']Back["']/.exec(code);
  if (!m) continue;
  const line = code.slice(0, m.index).split('\n').length;
  fail.push(`${rel}:${line} renders its own Back button while the shell floats one over it`);
}

if (fail.length) {
  console.error(`✗ chrome: ${fail.length} problem(s)\n  ` + fail.join('\n  ') + '\n');
  process.exit(1);
}
console.log(`✓ chrome: the Back pill's ${Number(topPx[1]) + Number(heightPx[1])}px band is reserved, one visibility condition, no duplicate back buttons`);
