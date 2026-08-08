/**
 * Render every page and see whether it actually runs.
 *
 * This exists because of a specific incident. A sweep of mine deleted a const
 * from Icon.jsx, every call to iconName() threw ReferenceError, and Hub was a
 * white screen for seven minutes. esbuild passed. `vite build` passed. A bare
 * reference to a missing identifier is valid syntax; it only fails when the
 * line runs, and nothing in the pipeline ran a single line of a page.
 *
 * The route sweep that was supposed to cover this only ever reached /login,
 * because every other route redirects without a session. So it proved nothing
 * and reported success, which is worse than having no check at all.
 *
 * This renders each page module through react-dom/server inside a router and
 * the app's providers, with fetch and Supabase stubbed. A page that throws on
 * its first render fails the build.
 *
 * What it does NOT prove: anything behind an interaction, a loaded state, or a
 * conditional branch that needs data. It catches the class that has actually
 * bitten — a module-scope or first-render reference that does not exist.
 *
 *   node scripts/check-render.mjs
 */
import { build } from 'esbuild';
import { readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { installDomStub } from './lib/dom-stub.mjs';

const SRC = new URL('../src', import.meta.url).pathname;
const PAGES = readdirSync(join(SRC, 'pages')).filter(f => f.endsWith('.jsx'));

// One bundle containing every page plus a harness, so we pay the bundling cost
// once rather than 79 times.
const entry = `
import React from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { CoachProvider } from './contexts/CoachContext.jsx';
${PAGES.map((f, i) => `import P${i} from './pages/${f}';`).join('\n')}

const NAMES = ${JSON.stringify(PAGES)};
const PAGES = [${PAGES.map((_, i) => `P${i}`).join(', ')}];

export function run() {
  const results = [];
  const only = process.env.RENDER_ONLY ? process.env.RENDER_ONLY.split(',') : null;
  for (let i = 0; i < PAGES.length; i++) {
    if (only && !only.includes(NAMES[i])) continue;
    if (process.env.RENDER_TRACE) console.error('  ...' + NAMES[i]);
    const Page = PAGES[i];
    try {
      if (typeof Page !== 'function') {
        results.push({ name: NAMES[i], ok: false, err: 'default export is not a component' });
        continue;
      }
      renderToString(
        React.createElement(MemoryRouter, { initialEntries: ['/'] },
          React.createElement(CoachProvider, null,
            React.createElement(Page, {})))
      );
      results.push({ name: NAMES[i], ok: true });
    } catch (err) {
      results.push({ name: NAMES[i], ok: false, err: String(err && err.message || err), stack: String(err && err.stack || '').split('\\n').slice(0, 4).join(' | ') });
    }
  }
  return results;
}
`;

const out = await build({
  stdin: { contents: entry, resolveDir: SRC, sourcefile: 'harness.jsx', loader: 'jsx' },
  bundle: true, write: false, format: 'esm', platform: 'node',
  jsx: 'automatic', logLevel: 'silent',
  external: ['react', 'react-dom', 'react-dom/server', 'react-router-dom'],
  define: {
    'process.env.NODE_ENV': '"production"',
    'import.meta.env': JSON.stringify({
      DEV: false, PROD: true, MODE: 'production',
      VITE_SUPABASE_URL: 'http://localhost/stub',
      VITE_SUPABASE_ANON_KEY: 'stub',
      VITE_API_URL: 'http://localhost/stub',
    }),
  },
});

// Minimal browser surface. Anything a page touches at module scope or on its
// first render has to exist, but must not do real work.
installDomStub();

// Written to a real file rather than a data: URL, because a data: module
// cannot resolve bare specifiers like "react" — the externals would all fail
// to load and the whole check would report an import error instead of a render.
const harness = new URL('../.render-harness.mjs', import.meta.url).pathname;
writeFileSync(harness, out.outputFiles[0].text);
let results;
try {
  const mod = await import(pathToFileURL(harness).href);
  results = mod.run();
} finally {
  try { unlinkSync(harness); } catch { /* best effort */ }
}

const failed = results.filter(r => !r.ok);
const passed = results.length - failed.length;

// A page that needs props or context we did not supply is not a defect; a page
// that cannot resolve an identifier is. Separate the two, and only fail on the
// second, or this check becomes noise everyone learns to ignore.
const REAL = /is not defined|is not a function|Cannot read propert(y|ies) of undefined \(reading '[^']*'\)|default export is not a component/;
const real = failed.filter(f => REAL.test(f.err));
const environmental = failed.filter(f => !REAL.test(f.err));

console.log(`  rendered ${passed}/${results.length} pages`);
if (environmental.length) {
  console.log(`  ${environmental.length} need context this harness does not provide (not failures):`);
  for (const f of environmental.slice(0, 8)) console.log(`    ${f.name}: ${f.err.slice(0, 90)}`);
}

if (real.length) {
  console.error(`\n✗ render: ${real.length} page(s) throw on first render\n  ` +
    real.map(f => `${f.name}: ${f.err}\n      ${f.stack || ''}`).join('\n  ') + '\n');
  process.exit(1);
}
console.log(`✓ render: all ${passed} pages render without a missing identifier`);
// Pages register intervals and listeners at import time, so node has live
// handles and will not exit on its own. The check is finished; say so.
process.exit(0);
