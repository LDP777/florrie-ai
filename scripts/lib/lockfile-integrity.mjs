// Pure, offline checks for the two installation graphs used by this repository.
export const REQUIRED_PLATFORM_PACKAGES = [
  '@rollup/rollup-darwin-arm64',
  '@rollup/rollup-darwin-x64',
  '@rollup/rollup-linux-x64-gnu',
  '@esbuild/darwin-arm64',
  '@esbuild/linux-x64',
];

const DEPENDENCY_GROUPS = ['dependencies', 'devDependencies', 'optionalDependencies'];

function checkManifest(manifest, lock, workspace, label) {
  const errors = [];
  const declaration = lock.packages?.[workspace];
  if (!declaration) return [`${label} is missing its ${workspace || 'root'} manifest entry`];

  for (const group of DEPENDENCY_GROUPS) {
    const expected = manifest[group] || {};
    const declared = declaration[group] || {};
    for (const name of new Set([...Object.keys(expected), ...Object.keys(declared)])) {
      if (expected[name] !== declared[name]) {
        errors.push(`${label} is out of sync: ${group}.${name}`);
        continue;
      }
      // A workspace can resolve its own package first, or a hoisted root copy.
      // An unrelated package's nested dependency cannot satisfy this import.
      const paths = workspace
        ? [`${workspace}/node_modules/${name}`, `node_modules/${name}`]
        : [`node_modules/${name}`];
      const entry = paths.map(path => lock.packages?.[path]).find(Boolean);
      const linkedEntry = entry?.link && lock.packages?.[entry.resolved];
      if (!entry || (!entry.version && !linkedEntry?.version)) {
        errors.push(`${label} is missing a resolved direct dependency: ${name}`);
      }
    }
  }
  return errors;
}

export function checkLockfileIntegrity({
  rootLock,
  frontendManifest,
  backendManifest,
  backendLock,
  frontendStandaloneExists = false,
}) {
  const errors = [];
  const names = new Set(Object.keys(rootLock.packages || {})
    .map(path => path.replace(/^.*node_modules\//, '')));
  for (const name of REQUIRED_PLATFORM_PACKAGES) {
    if (!names.has(name)) errors.push(`package-lock.json is missing platform binary: ${name}`);
  }
  errors.push(...checkManifest(frontendManifest, rootLock, 'frontend', 'package-lock.json (frontend workspace)'));
  errors.push(...checkManifest(backendManifest, rootLock, 'backend', 'package-lock.json (backend workspace)'));
  errors.push(...checkManifest(backendManifest, backendLock, '', 'backend/package-lock.json'));
  if (frontendStandaloneExists) {
    errors.push('frontend/package-lock.json is unsupported: web, iOS and local frontend builds use the root workspace lock; remove the unused copy');
  }
  return errors;
}
