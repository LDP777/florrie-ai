import { describe, expect, it } from 'vitest';
import { checkLockfileIntegrity, REQUIRED_PLATFORM_PACKAGES } from '../../../scripts/lib/lockfile-integrity.mjs';

function fixture() {
  const frontendManifest = { dependencies: { react: '^19.0.0' }, devDependencies: { vite: '^6.0.0' } };
  const backendManifest = { dependencies: { express: '^4.0.0' }, devDependencies: { vitest: '^3.0.0' } };
  const rootLock = { packages: {
    frontend: structuredClone(frontendManifest),
    backend: structuredClone(backendManifest),
    'node_modules/react': { version: '19.2.8' },
    'node_modules/vite': { version: '6.1.0' },
    'node_modules/express': { version: '4.22.2' },
    'node_modules/vitest': { version: '3.2.4' },
    ...Object.fromEntries(REQUIRED_PLATFORM_PACKAGES.map(name => [`node_modules/${name}`, { version: '1.0.0' }])),
  } };
  const backendLock = { packages: {
    '': structuredClone(backendManifest),
    'node_modules/express': { version: '4.22.2' },
    'node_modules/vitest': { version: '3.2.4' },
  } };
  return { rootLock, frontendManifest, backendManifest, backendLock };
}

describe('active installation lockfiles', () => {
  it('accepts the root workspace plus backend Docker lock without a frontend copy', () => {
    expect(checkLockfileIntegrity(fixture())).toEqual([]);
  });

  it('rejects a frontend standalone copy so nightly cannot mistake it for production', () => {
    expect(checkLockfileIntegrity({ ...fixture(), frontendStandaloneExists: true }))
      .toEqual([expect.stringContaining('frontend/package-lock.json is unsupported')]);
  });

  it.each(['dependencies', 'devDependencies', 'optionalDependencies'])('catches frontend %s drift before installation', group => {
    const data = fixture();
    data.frontendManifest[group] = { ...(data.frontendManifest[group] || {}), added: '^1.0.0' };
    expect(checkLockfileIntegrity(data)).toContain(`package-lock.json (frontend workspace) is out of sync: ${group}.added`);
  });

  it('detects removed declarations left in the workspace lock', () => {
    const data = fixture();
    delete data.frontendManifest.dependencies.react;
    expect(checkLockfileIntegrity(data)).toContain('package-lock.json (frontend workspace) is out of sync: dependencies.react');
  });

  it('detects a missing workspace manifest', () => {
    const data = fixture();
    delete data.rootLock.packages.frontend;
    expect(checkLockfileIntegrity(data)).toContain('package-lock.json (frontend workspace) is missing its frontend manifest entry');
  });

  it('accepts a workspace-local direct version rather than requiring hoisting', () => {
    const data = fixture();
    data.rootLock.packages['frontend/node_modules/react'] = data.rootLock.packages['node_modules/react'];
    delete data.rootLock.packages['node_modules/react'];
    expect(checkLockfileIntegrity(data)).toEqual([]);
  });

  it('rejects an unrelated nested copy that cannot resolve from the workspace', () => {
    const data = fixture();
    data.rootLock.packages['node_modules/other/node_modules/react'] = data.rootLock.packages['node_modules/react'];
    delete data.rootLock.packages['node_modules/react'];
    expect(checkLockfileIntegrity(data)).toContain('package-lock.json (frontend workspace) is missing a resolved direct dependency: react');
  });

  it('rejects a direct entry without a resolution', () => {
    const data = fixture();
    data.rootLock.packages['node_modules/react'] = {};
    expect(checkLockfileIntegrity(data)).toContain('package-lock.json (frontend workspace) is missing a resolved direct dependency: react');
  });

  it('keeps the Mac platform safeguard used by Xcode Cloud', () => {
    const data = fixture();
    delete data.rootLock.packages['node_modules/@rollup/rollup-darwin-arm64'];
    expect(checkLockfileIntegrity(data)).toContain('package-lock.json is missing platform binary: @rollup/rollup-darwin-arm64');
  });

  it('still rejects backend standalone dev drift even though Docker omits dev installs', () => {
    const data = fixture();
    data.backendLock.packages[''].devDependencies.vitest = '^2.0.0';
    expect(checkLockfileIntegrity(data)).toContain('backend/package-lock.json is out of sync: devDependencies.vitest');
  });

  it('checks the backend root graph as well as the standalone graph', () => {
    const data = fixture();
    delete data.rootLock.packages['node_modules/express'];
    expect(checkLockfileIntegrity(data)).toContain('package-lock.json (backend workspace) is missing a resolved direct dependency: express');
  });
});
