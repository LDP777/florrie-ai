import assert from 'node:assert/strict';
import http from 'node:http';
import { build } from 'esbuild';
import { launch } from './lib/browser.mjs';

// Bundle the real component with synthetic auth/provider boundaries, without
// rebuilding shared dist or connecting to production.
const { outputFiles } = await build({
  stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {MemoryRouter} from 'react-router-dom'; import ActivityFeed from './src/components/ActivityFeed.jsx'; createRoot(document.getElementById('root')).render(<MemoryRouter><ActivityFeed compact /></MemoryRouter>);`, resolveDir: new URL('..', import.meta.url).pathname, loader: 'jsx' },
  bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"test"' },
  plugins: [{ name: 'synthetic-boundaries', setup(builder) {
    builder.onResolve({ filter: /\/lib\/(supabase|config)\.js$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path.endsWith('config.js')
      ? `export const API_BASE = '';`
      : `export const supabase = {auth:{getSession:async()=>({data:{session:window.__token?{access_token:window.__token}:null}}),refreshSession:async()=>{window.__token='fresh';return {data:{session:{access_token:'fresh'}}};}}};`, loader: 'js' }));
  } }],
});
const server = http.createServer((req,res) => {
  if (req.url === '/bundle.js') { res.setHeader('Content-Type','text/javascript'); res.end(outputFiles[0].text); }
  else { res.setHeader('Content-Type','text/html'); res.end('<div id="root"></div><script src="/bundle.js"></script>'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await launch();
try {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.__token = 'old'; window.__fail = true; window.__auth = [];
    const original = window.fetch;
    window.fetch = (url, opts) => {
      if (!String(url).includes('/api/activity/feed')) return original(url, opts);
      window.__auth.push(opts.headers.Authorization);
      const status = opts.headers.Authorization === 'Bearer old' ? 401 : window.__fail ? 503 : 200;
      return Promise.resolve(new Response(JSON.stringify({ rows: [{ id: 'fixture', summary: 'Recovered activity', created_at: new Date().toISOString(), action_type: 'message_replied' }] }), { status }));
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByText('Could not load activity. Please try again.', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__auth.slice(0,2)), ['Bearer old', 'Bearer fresh']);
  await page.evaluate(() => { window.__fail = false; });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByText('Recovered activity', { exact: true }).waitFor();
  await page.evaluate(() => { window.__token = null; document.dispatchEvent(new Event('visibilitychange')); });
  await page.getByText('Your session is unavailable. Sign in again to load activity.', { exact: true }).waitFor();
  assert.equal(await page.getByText('Florrie just started.', { exact: false }).count(), 0);
  await page.evaluate(() => { window.__token = 'fresh'; document.dispatchEvent(new Event('visibilitychange')); });
  await page.getByText('Recovered activity', { exact: true }).waitFor();
  console.log('✓ Activity: stale token refresh, failed API retry, missing-session error and visibility recovery');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
