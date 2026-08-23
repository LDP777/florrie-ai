/**
 * No em dashes in anything a person reads.
 *
 * The house rule is old and it has been asked for more times than any other
 * note, and it kept coming back because it was enforced by asking. Two things
 * hold it now: `deDash()` at every send choke point (backend/src/lib/text.js),
 * which cleans a message on its way out whatever wrote it, and this, which
 * catches the copy the choke point never sees — a subject line rendered in the
 * app, a button label, an error toast, a spoken reply read back to her.
 *
 * Comments and log lines are deliberately NOT graded. Nobody reads them but us,
 * failing a build over a dash in a `//` line is the fastest way to get a check
 * deleted, and the rule was never about those. So this walks the AST and grades
 * string literals and template chunks only, minus the ones handed to a logger.
 *
 * Both halves of the product are scanned: nearly all client-facing copy is
 * backend (SMS, WhatsApp, email bodies) and grading only frontend/src would
 * miss the strings that actually reach a client.
 *
 *   node scripts/check-em-dash.mjs
 *   node scripts/check-em-dash.mjs --record   (re-record the baseline)
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from '@babel/parser';

const ROOT = new URL('../..', import.meta.url).pathname;
const ROOTS = [join(ROOT, 'backend/src'), join(ROOT, 'frontend/src')];
const EM = '—';

function files(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.[jt]sx?$/.test(e)) out.push(p);
  }
  return out;
}

/**
 * A logger call's message is not copy. `logger.warn({ err }, 'WhatsApp send
 * blocked — quota issue')` is a line in a log file, and the rule has never been
 * about those. Collected by node, not by line text, so a multi-line call or a
 * template inside one is excluded as reliably as a single-line one. Sentry
 * counts: `Sentry.captureMessage(...)` is a page to us, never a line she reads.
 */
const LOG_CALLEE = /^(logger|console|log|Sentry)$/;
function isLogCall(node) {
  if (node?.type !== 'CallExpression') return false;
  const c = node.callee;
  if (c?.type === 'MemberExpression') {
    const base = c.object?.type === 'MemberExpression' ? c.object.object : c.object;
    return base?.type === 'Identifier' && LOG_CALLEE.test(base.name);
  }
  return c?.type === 'Identifier' && LOG_CALLEE.test(c.name);
}

/** The dash plus a little either side, so a finding is recognisable on sight. */
function excerpt(text) {
  const i = text.indexOf(EM);
  const slice = text.slice(Math.max(0, i - 28), i + 29).replace(/\s+/g, ' ').trim();
  return slice;
}

const findings = [];
let strings = 0;
let skippedLogs = 0;

for (const root of ROOTS) {
  for (const file of files(root)) {
    const code = readFileSync(file, 'utf8');
    if (!code.includes(EM)) continue;
    let ast;
    try { ast = parse(code, { sourceType: 'module', plugins: ['jsx'], errorRecovery: true }); }
    catch { continue; }

    const rel = relative(ROOT, file);
    (function walk(node, inLog) {
      if (!node || typeof node !== 'object') return;
      const logged = inLog || isLogCall(node);

      if (node.type === 'StringLiteral' || node.type === 'JSXText') {
        const value = node.type === 'JSXText' ? node.value : node.value;
        if (typeof value === 'string' && value.includes(EM)) {
          strings++;
          if (logged) skippedLogs++;
          else findings.push({ file: rel, line: node.loc.start.line, text: excerpt(value) });
        }
      }
      if (node.type === 'TemplateLiteral') {
        for (const q of node.quasis) {
          const raw = q.value.cooked ?? q.value.raw;
          if (raw.includes(EM)) {
            strings++;
            if (logged) skippedLogs++;
            else findings.push({ file: rel, line: q.loc.start.line, text: excerpt(raw) });
          }
        }
      }

      for (const k of Object.keys(node)) {
        if (k === 'loc' || k === 'leadingComments' || k === 'trailingComments' || k === 'innerComments') continue;
        const v = node[k];
        if (Array.isArray(v)) v.forEach(n => walk(n, logged));
        else if (v && typeof v.type === 'string') walk(v, logged);
      }
    })(ast.program, false);
  }
}

// A grader that cannot fail is indistinguishable from a broken one. Prove the
// walk still sees a dash inside a string before trusting a green result.
const probe = (() => {
  const ast = parse('const a = "one — two"; logger.warn("three — four");', { sourceType: 'module' });
  let seen = 0;
  (function w(n, inLog) {
    if (!n || typeof n !== 'object') return;
    const l = inLog || isLogCall(n);
    if (n.type === 'StringLiteral' && n.value.includes(EM) && !l) seen++;
    for (const k of Object.keys(n)) {
      if (k === 'loc') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(x => w(x, l));
      else if (v && typeof v.type === 'string') w(v, l);
    }
  })(ast.program, false);
  return seen;
})();
if (probe !== 1) {
  console.error('✗ em dash: the scanner no longer finds a dash in a plain string, or no\n' +
    `  longer excludes a logger call. The probe saw ${probe} where it must see 1.\n`);
  process.exit(1);
}

/**
 * A ratchet, not a gate.
 *
 * What is left after the sweep is prompt text — the descriptions Claude reads
 * to pick a tool, and the front desk's system prompt. Those shape what the
 * model generates, so changing them is a behaviour change, not a punctuation
 * one, and it does not belong in the same commit as a comma. They are baselined
 * so the number can only go down.
 *
 * Keyed on file plus the words around the dash, not on line number: moving a
 * string down a file is not a new offence, and a baseline that churns on every
 * unrelated edit is one nobody re-records honestly.
 */
const BASELINE = new URL('./em-dash-baseline.json', import.meta.url).pathname;
const key = (f) => `${f.file} :: ${f.text}`;

let known = [];
try { known = JSON.parse(readFileSync(BASELINE, 'utf8')).known || []; } catch {}
const knownSet = new Set(known);

if (process.argv.includes('--record')) {
  const list = [...new Set(findings.map(key))].sort();
  writeFileSync(BASELINE, JSON.stringify({
    note: 'Em dashes in non-log strings that predate check-em-dash (prompt text, mostly). New ones fail CI; this list may only shrink.',
    known: list,
  }, null, 2) + '\n');
  console.log(`recorded ${list.length} known em dash(es) to em-dash-baseline.json`);
  process.exit(0);
}

const fresh = findings.filter(f => !knownSet.has(key(f)));
const stillThere = new Set(findings.map(key));
const fixed = known.filter(k => !stillThere.has(k));

if (fresh.length) {
  const byFile = {};
  for (const f of fresh) (byFile[f.file] ||= []).push(f);
  console.error(`✗ em dash: ${fresh.length} NEW em dash(es) in user-visible strings (${strings} dashed strings seen, ${skippedLogs} in log calls, ${known.length} known)\n`);
  for (const [file, list] of Object.entries(byFile)) {
    console.error(`  ${file}`);
    for (const f of list) console.error(`    :${f.line}  ${f.text}`);
  }
  console.error('\n  Rewrite it. A comma, a full stop or brackets almost always reads better\n' +
    '  than the dash did; a hyphen is a last resort. deDash() in backend/src/lib/text.js\n' +
    '  cleans messages on the way out, but it never sees a string rendered in the app.\n' +
    '  If one is genuinely intended, say why in a comment and re-record with\n' +
    '  `npm run check:em-dash -- --record`.\n');
  process.exit(1);
}

if (fixed.length) {
  console.error(`✗ em dash: ${fixed.length} baseline entr(y/ies) are gone. Re-record so they cannot come back:\n`);
  for (const k of fixed) console.error(`    ${k}`);
  console.error('\n  npm run check:em-dash -- --record\n');
  process.exit(1);
}

console.log(`✓ em dash: ${strings} dashed strings across backend/src and frontend/src, none new (${skippedLogs} in log calls, ${known.length} known, tracked in em-dash-baseline.json)`);
