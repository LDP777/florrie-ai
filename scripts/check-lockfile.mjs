/**
 * The lockfile has to work on a Mac, and CI cannot tell you when it does not.
 *
 * On 19 August I deleted package-lock.json and let `npm install` regenerate it
 * — inside a Linux container. npm records only the optional dependencies that
 * apply to the platform it is running on, so the new lockfile lost every
 * darwin and win32 binary: 25 @rollup/rollup-* entries went down to the two
 * Linux ones, and the file shrank by 2,362 lines.
 *
 * CI stayed green, because CI is Linux. Vercel stayed green, because Vercel is
 * Linux. The web app deployed and worked. And `npm ci` on Levi's Mac fails
 * with "Cannot find module @rollup/rollup-darwin-arm64", which takes out his
 * local build and therefore the iOS build and therefore TestFlight.
 *
 * Every automated signal we had said fine. The only signal that mattered was a
 * person on a Mac saying "the latest build broke".
 *
 * So this asserts the platform matrix is intact. It is deliberately dumb: it
 * does not resolve anything or hit the network, it just checks that the
 * lockfile still knows about the machines this project is actually built on.
 *
 *   node scripts/check-lockfile.mjs
 */
import { readFileSync } from 'node:fs';

const LOCK = new URL('../package-lock.json', import.meta.url).pathname;

/**
 * Packages whose absence breaks a build on a real machine somebody uses.
 * darwin-arm64 is Levi's Mac and the iOS build; darwin-x64 is an Intel Mac.
 * The Linux ones are CI and Vercel, and are here so a lockfile regenerated on
 * a MAC is caught by the same check.
 */
const REQUIRED = [
  '@rollup/rollup-darwin-arm64',
  '@rollup/rollup-darwin-x64',
  '@rollup/rollup-linux-x64-gnu',
  '@esbuild/darwin-arm64',
  '@esbuild/linux-x64',
];

const raw = readFileSync(LOCK, 'utf8');
const lock = JSON.parse(raw);
const names = new Set(
  Object.keys(lock.packages || {})
    .map(k => k.replace(/^.*node_modules\//, ''))
    .filter(Boolean),
);

const missing = REQUIRED.filter(p => !names.has(p));

if (missing.length) {
  console.error('✗ lockfile: platform binaries are missing.\n');
  for (const m of missing) console.error(`    ${m}`);
  console.error(`
  This happens when package-lock.json is deleted and regenerated on one
  platform: npm only records the optional dependencies for the machine it ran
  on. CI will stay green — CI is Linux — and \`npm ci\` will fail on a Mac with
  "Cannot find module @rollup/rollup-darwin-arm64".

  Do not regenerate the lockfile to fix this. Restore it and update it in
  place, which preserves entries npm has no reason to touch:

      git checkout HEAD -- package-lock.json
      npm install --package-lock-only
`);
  process.exit(1);
}

console.log(`✓ lockfile: ${REQUIRED.length} platform binaries present, so it still installs on a Mac as well as on CI`);

// A root npm ci does not validate either standalone lock. Keep both deploy
// inputs current when adding a library, rather than discovering drift nightly.
// Include dev dependencies: npm ci validates them even with --omit=dev.
for (const workspace of ['backend', 'frontend']) {
  const manifest = JSON.parse(readFileSync(new URL(`../${workspace}/package.json`, import.meta.url), 'utf8'));
  const standalone = JSON.parse(readFileSync(new URL(`../${workspace}/package-lock.json`, import.meta.url), 'utf8'));
  for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const expected = manifest[group] || {};
    const declared = standalone.packages?.['']?.[group] || {};
    for (const name of new Set([...Object.keys(expected), ...Object.keys(declared)])) {
      if (expected[name] !== declared[name] || !standalone.packages?.[`node_modules/${name}`]) {
        throw new Error(`${workspace}/package-lock.json is out of sync: ${group}.${name}`);
      }
    }
  }
  if (workspace === 'frontend') {
    for (const name of REQUIRED) {
      if (!standalone.packages?.[`node_modules/${name}`]) {
        throw new Error(`frontend/package-lock.json is missing platform binary: ${name}`);
      }
    }
  }
  console.log(`✓ lockfile: ${workspace} standalone manifest and locked packages agree`);
}
