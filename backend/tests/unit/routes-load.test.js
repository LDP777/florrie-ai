import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every router this server mounts must actually import.
 *
 * The bug this exists for: a patch landed
 * `import { selectable, writable } from '../lib/schema-probe.js'` INSIDE the
 * brace list of the multi-line ledger import in routes/money.js. That is a
 * SyntaxError, not a lint nit — index.js imports every router statically, so
 * the whole backend failed at boot and every /api/money endpoint was gone. The
 * app owner saw it as "the ledger doesn't work on the money page".
 *
 * 579 tests passed the whole time, because all of them test pure lib modules
 * and not one of them ever imported a route file. A suite that is green while
 * the server cannot start is not telling anyone the truth, so this is the
 * cheapest possible check that it can: import each router and see that a
 * router came back.
 *
 * It is not a substitute for route tests. It only catches the class of failure
 * that takes the whole file — a syntax error, a bad import specifier, a module
 * that throws at load — which is exactly the class that slipped through.
 */
const ROUTES_DIR = new URL('../../src/routes/', import.meta.url).pathname;
const files = readdirSync(ROUTES_DIR).filter(f => f.endsWith('.js')).sort();

describe('every route module loads', () => {
  it('finds the routes directory', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  // One case per file, so a failure names the file rather than the folder.
  it.each(files)('%s imports and exports a router', async (file) => {
    const mod = await import(join(ROUTES_DIR, file));
    // Express routers are functions with a .stack of layers. Checking for a
    // function is enough to catch "the module loaded but exported nothing",
    // which is the other way a mount silently becomes a 404.
    expect(typeof mod.default).toBe('function');
  });
});
