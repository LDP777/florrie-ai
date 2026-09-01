/**
 * Fails the build when an installed dependency needs a newer Node than the
 * oldest one we run on. See scripts/lib/node-floor.mjs for why this exists.
 *
 *   node scripts/check-node-floor.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import { analyseNodeFloor, describeRuntimes, asRuntime } from './lib/node-floor.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rel = p => relative(ROOT, p) || '.';

/* ---------- 1. every Node version this project declares ---------- */

const runtimes = [];

// engines.node in each package.json we own
for (const pkg of ['package.json', 'backend/package.json', 'frontend/package.json', 'shared/package.json']) {
  const path = join(ROOT, pkg);
  if (!existsSync(path)) continue;
  const range = JSON.parse(readFileSync(path, 'utf8'))?.engines?.node;
  const major = range && semver.minVersion(range)?.major;
  if (major) runtimes.push({ source: `${pkg} engines.node`, major });
}

// node-version: NN in the GitHub workflows
const wfDir = join(ROOT, '.github/workflows');
if (existsSync(wfDir)) {
  for (const file of readdirSync(wfDir).filter(f => /\.ya?ml$/.test(f))) {
    const text = readFileSync(join(wfDir, file), 'utf8');
    text.split('\n').forEach((line, i) => {
      const m = line.match(/^\s*node-version:\s*['"]?(\d+)/);
      if (m) runtimes.push({ source: `.github/workflows/${file}:${i + 1}`, major: Number(m[1]) });
    });
  }
}

// FROM node:NN in any Dockerfile we ship
const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/^Dockerfile/.test(entry)) out.push(full);
  }
  return out;
};
for (const file of walk(ROOT)) {
  const m = readFileSync(file, 'utf8').match(/^FROM\s+node:(\d+)/m);
  if (m) runtimes.push({ source: rel(file), major: Number(m[1]) });
}

/* ---------- 2. every installed dependency that demands a Node version ---------- */

const deps = [];
const seen = new Set();
const collect = dir => {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (entry.startsWith('@')) { collect(full); continue; }
    let pkg;
    try { pkg = JSON.parse(readFileSync(join(full, 'package.json'), 'utf8')); } catch { continue; }
    const range = pkg?.engines?.node;
    if (range && pkg.name && !seen.has(pkg.name)) {
      seen.add(pkg.name);
      deps.push({ name: pkg.name, version: pkg.version, range });
    }
    collect(join(full, 'node_modules'));
  }
};
for (const nm of ['node_modules', 'backend/node_modules', 'frontend/node_modules']) {
  collect(join(ROOT, nm));
}

/* ---------- 3. the machine this is running on right now ---------- */

// Separate from the drift check above. That one asks whether the versions we
// DECLARE agree with each other; this asks whether the node actually executing
// is one of them. A developer on an old node gets told so here, in one line,
// rather than as a WebSocket error from inside a dependency ten minutes later.
const declaredFloor = runtimes.reduce((a, b) => (b.major < a.major ? b : a), { major: Infinity });
if (Number.isFinite(declaredFloor.major) && semver.major(process.version) < declaredFloor.major) {
  console.error(`✗ node floor: you are running node ${process.version}, and this project needs node ${declaredFloor.major} or newer.\n`);
  console.error('  Everything will appear to install fine and then fail somewhere unrelated:');
  console.error('  supabase-js needs a native WebSocket, which node 20 does not have, and what');
  console.error('  it prints is "native WebSocket not found" with no version anywhere in it.\n');
  console.error('    nvm install 22 && nvm use 22\n');
  process.exit(1);
}

/* ---------- 4. compare what we declare against what we installed ---------- */

const result = analyseNodeFloor({
  runtimes,
  deps,
  satisfies: (v, r) => semver.satisfies(v, r),
  validRange: r => semver.validRange(r),
});

if (result.noRuntimes) {
  console.error('✗ node floor: found no Node version declared anywhere, so nothing was compared.');
  console.error('  That is a broken check, not a clean result. Look at scripts/check-node-floor.mjs.');
  process.exit(1);
}

if (deps.length === 0) {
  console.log('✓ node floor: no dependencies installed yet, nothing to compare (run after npm ci)');
  process.exit(0);
}

if (!result.ok) {
  const { weakest, offenders } = result;
  console.error(`✗ node floor: ${offenders.length} installed package(s) need a newer Node than we run.\n`);
  console.error(`  The oldest Node this project runs on is ${weakest.major}, declared in:`);
  console.error(`    ${weakest.source}\n`);
  console.error('  These packages will not run on it:\n');
  for (const o of offenders.slice(0, 15)) {
    console.error(`    ${o.name}@${o.version}  needs node ${o.needs}`);
  }
  if (offenders.length > 15) console.error(`    ... and ${offenders.length - 15} more`);
  console.error(`
  npm already told you this during install, as an EBADENGINE warning. It
  scrolls past, and the symptom arrives much later looking like something
  else entirely: supabase-js 2.112.4 raised its floor to node 22, and what
  CI actually printed was "native WebSocket not found" in forty six tests.

  Fix it in one of two ways, deliberately:

    Raise the runtime, if the new floor is reasonable. Every place listed
    below has to move together, or the lowest one is still the real floor:

${describeRuntimes(runtimes)}

    Or hold the dependency back, if it is not. Pin it in the root
    package.json "overrides" and regenerate, then run this again.
`);
  process.exit(1);
}

console.log(
  `✓ node floor: ${result.checked} package(s) with a declared engine all run on node ` +
  `${result.weakest.major}, the oldest of the ${runtimes.length} runtimes this project declares`,
);
