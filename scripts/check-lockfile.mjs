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
import { existsSync, readFileSync } from 'node:fs';
import { checkLockfileIntegrity, REQUIRED_PLATFORM_PACKAGES } from './lib/lockfile-integrity.mjs';

const readJson = path => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
try {
  const errors = checkLockfileIntegrity({
    rootLock: readJson('package-lock.json'),
    frontendManifest: readJson('frontend/package.json'),
    backendManifest: readJson('backend/package.json'),
    backendLock: readJson('backend/package-lock.json'),
    frontendStandaloneExists: existsSync(new URL('../frontend/package-lock.json', import.meta.url)),
  });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`✓ lockfile: ${REQUIRED_PLATFORM_PACKAGES.length} Mac/Linux platform binaries present`);
  console.log('✓ lockfile: frontend and backend workspace manifests agree with the root lock');
  console.log('✓ lockfile: backend standalone manifest and locked packages agree');
} catch (error) {
  console.error(`✗ lockfile integrity:\n${error.message}`);
  console.error('Update the active lock in place; do not delete and regenerate it, which can lose Mac platform binaries.');
  process.exitCode = 1;
}
