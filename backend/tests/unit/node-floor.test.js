/**
 * The check that would have caught the 1 September CI failure before the push.
 *
 * supabase-js 2.112.4 declares "engines": { "node": ">=22.0.0" }. CI was pinned
 * to node 20. Every automated signal we had said fine until the tests ran, and
 * then forty six of them failed with "native WebSocket not found", which names
 * neither the package nor the version that caused it.
 */
import { describe, it, expect } from 'vitest';
import semver from 'semver';
import { analyseNodeFloor, asRuntime, describeRuntimes } from '../../../scripts/lib/node-floor.mjs';

const satisfies = (v, r) => semver.satisfies(v, r);
const validRange = r => semver.validRange(r);
const run = (runtimes, deps) => analyseNodeFloor({ runtimes, deps, satisfies, validRange });

const CI_20 = { source: '.github/workflows/ci.yml:31', major: 20 };
const CI_22 = { source: '.github/workflows/ci.yml:53', major: 22 };
const DOCKER_22 = { source: 'backend/Dockerfile', major: 22 };
const SUPABASE = { name: '@supabase/supabase-js', version: '2.112.4', range: '>=22.0.0' };

describe('analyseNodeFloor', () => {
  it('fails when a dependency needs a newer node than the oldest runtime', () => {
    const result = run([CI_20, CI_22, DOCKER_22], [SUPABASE]);
    expect(result.ok).toBe(false);
    expect(result.offenders).toHaveLength(1);
    expect(result.offenders[0].name).toBe('@supabase/supabase-js');
  });

  it('blames the OLDEST runtime, not the newest, because the oldest is the real floor', () => {
    // Three of four jobs on 22 does not help the one still on 20.
    const result = run([CI_22, DOCKER_22, CI_20], [SUPABASE]);
    expect(result.weakest.major).toBe(20);
    expect(result.weakest.source).toBe('.github/workflows/ci.yml:31');
  });

  it('passes once every runtime has moved up', () => {
    const result = run([CI_22, DOCKER_22], [SUPABASE]);
    expect(result.ok).toBe(true);
    expect(result.offenders).toEqual([]);
  });

  it('models a bare major pin as the newest release of that major', () => {
    // `node-version: 22` installs the latest 22.x, so a package asking for
    // ^22.20 is satisfied by it. Treating the pin as 22.0.0 would be a false
    // alarm, and a check that cries wolf gets deleted.
    expect(asRuntime(22)).toBe('22.999.999');
    const napi = { name: '@napi-rs/lzma', version: '1.5.1', range: '^22.20 || ^24.12 || >=25' };
    expect(run([CI_22], [napi]).ok).toBe(true);
    expect(run([CI_20], [napi]).ok).toBe(false);
  });

  it('accepts a disjunction that includes our major', () => {
    const glob = { name: 'glob', version: '11.1.0', range: '20 || >=22' };
    expect(run([CI_20], [glob]).ok).toBe(true);
    expect(run([CI_22], [glob]).ok).toBe(true);
  });

  it('ignores a range it cannot parse rather than failing on somebody else broken metadata', () => {
    const junk = { name: 'weird-pkg', version: '1.0.0', range: 'not a semver range at all' };
    // semver.satisfies does NOT throw on a malformed range, it returns false,
    // which reads exactly like a real incompatibility. Without an explicit
    // validity check this fails a build and names an innocent package.
    const result = run([CI_22], [junk]);
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(1);
    expect(result.checked).toBe(0);
  });

  it('refuses to report a clean result when it found no runtimes to compare', () => {
    // The failure mode of every check like this: scanning nothing and calling
    // it agreement. Same rule as the nightly column drift check.
    const result = run([], [SUPABASE]);
    expect(result.ok).toBe(false);
    expect(result.noRuntimes).toBe(true);
  });

  it('lists every place a node version is declared, so the fix is not partial', () => {
    const text = describeRuntimes([CI_22, CI_20, DOCKER_22]);
    expect(text).toContain('.github/workflows/ci.yml:31');
    expect(text).toContain('.github/workflows/ci.yml:53');
    expect(text).toContain('backend/Dockerfile');
    // oldest first, because that is the one that has to move
    expect(text.indexOf('Node 20')).toBeLessThan(text.indexOf('Node 22'));
  });
});
