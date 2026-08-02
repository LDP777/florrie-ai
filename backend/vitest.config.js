/**
 * Vitest config.
 *
 * The 110 tests in tests/unit were written against vitest, but vitest was not
 * a dependency of anything: not backend/package.json, not the root, not the
 * lockfile. They only ever ran because somebody typed `npx -y vitest`, which
 * silently downloads whatever the latest version happens to be that day. And
 * `npm test` ran `node --test tests/unit/`, which errored immediately on the
 * vitest imports. A test suite nobody can run with the documented command is
 * not a test suite.
 *
 * Deliberately plain. These are pure logic tests over pure modules: no
 * database, no HTTP, no DOM. Nothing here should need a plugin.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js'],
    environment: 'node',
    // config.js constructs the Supabase clients at import time, so the env has
    // to exist before any module graph is loaded. See tests/setup.js.
    setupFiles: ['./tests/setup.js'],
    // Explicit imports in every file. Globals hide where `expect` came from.
    globals: false,
    // Any unit test slower than this is doing something it should not.
    testTimeout: 10_000,
  },
});
