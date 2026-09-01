/**
 * A dependency can raise the Node version it needs, and nothing tells you.
 *
 * On 1 September the lockfile was regenerated to clear a critical `tar`
 * advisory. That floated @supabase/supabase-js from 2.101.1 to 2.112.4, whose
 * package.json says `"engines": { "node": ">=22.0.0" }`, because realtime-js
 * dropped its bundled `ws` fallback and now wants the native WebSocket that
 * Node 20 does not have. CI was pinned to Node 20. Forty six backend tests and
 * the whole frontend build died with:
 *
 *   Node.js detected but native WebSocket not found.
 *
 * npm had already said so. `npm install` printed EBADENGINE and it went
 * unread, which is the same mistake as an unread PostgREST `error`: the
 * machine knew, and nobody looked.
 *
 * So this compares the two numbers that have to agree and cannot be seen
 * together anywhere else:
 *
 *   - the LOWEST Node we actually run: every `node-version:` in the workflows,
 *     every `FROM node:<major>` in a Dockerfile, and the `engines.node` floor
 *     we declare for ourselves
 *   - the HIGHEST Node any installed dependency demands
 *
 * If a dependency needs more than the weakest thing we run on, that is the
 * failure, and it is reported here at install time with the package named
 * rather than three minutes later as a WebSocket error with no cause attached.
 */

/** Model a `node-version: 22` pin as the newest 22.x, which is what it installs. */
export const asRuntime = major => `${major}.999.999`;

/**
 * @param {object} input
 * @param {{source: string, major: number}[]} input.runtimes  where we declare a Node version
 * @param {{name: string, range: string}[]} input.deps        installed packages that declare engines.node
 * @param {(version: string, range: string) => boolean} input.satisfies  semver.satisfies
 * @param {(range: string) => string|null} [input.validRange]  semver.validRange
 * @returns {{ok: boolean, weakest: object|null, offenders: object[], checked: number}}
 */
export function analyseNodeFloor({ runtimes, deps, satisfies, validRange }) {
  if (!runtimes || runtimes.length === 0) {
    // Finding nothing means the scan is broken, not that everything agrees.
    return { ok: false, weakest: null, offenders: [], checked: 0, noRuntimes: true };
  }

  const weakest = runtimes.reduce((a, b) => (b.major < a.major ? b : a));
  const version = asRuntime(weakest.major);

  const offenders = [];
  let skipped = 0;
  for (const dep of deps) {
    // An unparseable range is the package's problem, not ours. Skip it rather
    // than failing a build on somebody else's typo. This has to be checked
    // explicitly: semver.satisfies does not throw on a malformed range, it
    // returns false, which is indistinguishable from a real incompatibility.
    if (validRange && !validRange(dep.range)) { skipped += 1; continue; }
    let supported;
    try {
      supported = satisfies(version, dep.range);
    } catch {
      skipped += 1;
      continue;
    }
    if (!supported) offenders.push({ ...dep, needs: dep.range });
  }

  return { ok: offenders.length === 0, weakest, offenders, checked: deps.length - skipped, skipped };
}

/** Every place a Node version is declared, so the message can name the file to edit. */
export function describeRuntimes(runtimes) {
  return runtimes
    .slice()
    .sort((a, b) => a.major - b.major || a.source.localeCompare(b.source))
    .map(r => `    Node ${r.major}  ${r.source}`)
    .join('\n');
}
