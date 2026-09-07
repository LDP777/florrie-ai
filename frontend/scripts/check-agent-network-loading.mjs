// Exercise the real Today widget with delayed/failed reads and no external access.
import assert from 'node:assert/strict';
import http from 'node:http';
import { build } from 'esbuild';
import { launch } from './lib/browser.mjs';

const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import TodayAgentNetwork from './src/components/AgentNetwork.jsx';
window.fixture={reads:[],read(args){return new Promise((resolve,reject)=>this.reads.push({...args,resolve,reject}));}};
const root=createRoot(document.getElementById('root'));
window.mount=owner=>root.render(<MemoryRouter><div style={{height:1800}}>Your diary stays available</div><TodayAgentNetwork key={owner} beauticianId={owner}/></MemoryRouter>);
window.mount('owner-a');
`;
const stubs = {
  supabase: 'export const supabase={auth:{}};',
  config: 'export const API_BASE="";',
  'authenticated-json': 'export const readAuthenticatedJson=args=>window.fixture.read(args);',
};
const bundle = await build({
  stdin: { contents: entry, resolveDir: new URL('../', import.meta.url).pathname, loader: 'jsx' },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"test"' },
  plugins: [{ name: 'agent-network-stubs', setup(b) {
    b.onResolve({ filter: /\/lib\/(supabase|config|authenticated-json)\.js$/ }, args => ({
      path: args.path.split('/').pop().replace('.js', ''), namespace: 'test-stub',
    }));
    b.onLoad({ filter: /.*/, namespace: 'test-stub' }, args => ({ contents: stubs[args.path], loader: 'js' }));
  } }],
});
const server = http.createServer((req, res) => {
  const script = req.url === '/fixture.js';
  res.setHeader('content-type', script ? 'text/javascript' : 'text/html');
  res.end(script ? bundle.outputFiles[0].text : '<div id="root"></div><script src="/fixture.js"></script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(origin);
  await page.getByRole('heading', { name: 'Florrie at work' }).waitFor({ state: 'attached' });
  assert.equal(await page.evaluate(() => fixture.reads.length), 0, 'offscreen widget does not compete with diary loading');
  await page.getByRole('heading', { name: 'Florrie at work' }).scrollIntoViewIfNeeded();
  await page.waitForFunction(() => fixture.reads.length === 1);
  assert.equal(await page.evaluate(() => fixture.reads[0].url), '/api/agents/status', 'Today uses the light endpoint');
  await page.getByRole('button', { name: 'Explore Guardian', exact: true }).click();
  await page.getByRole('heading', { name: 'Guardian', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => fixture.reads.length), 1, 'role selection does not refetch');
  await page.evaluate(() => fixture.reads[0].reject(new Error('Offline')));
  await page.getByText('Recent work could not be checked.', { exact: true }).waitFor();
  assert.equal(await page.getByText('Recent background checks', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Refresh Florrie’s work' }).click();
  await page.waitForFunction(() => fixture.reads.length === 2);
  await page.evaluate(() => fixture.reads[1].resolve({ agents: [{ id: 'guardian', statusLine: 'Latest action needs attention', checks: [{ name: 'aftercare-followups', state: 'attention' }] }] }));
  await page.getByText('Latest action needs attention', { exact: true }).waitFor();
  await page.getByText('Check needs attention', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Refresh Florrie’s work' }).click();
  await page.waitForFunction(() => fixture.reads.length === 3);
  await page.evaluate(() => window.mount('owner-b'));
  await page.getByRole('heading', { name: 'Front Desk', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Florrie at work' }).scrollIntoViewIfNeeded();
  await page.waitForFunction(() => fixture.reads.length === 4);
  await page.evaluate(() => {
    fixture.reads[3].resolve({ agents: [{ id: 'front_desk', statusLine: 'New owner work', checks: [] }] });
    fixture.reads[2].resolve({ agents: [{ id: 'front_desk', statusLine: 'Obsolete private activity', checks: [] }] });
  });
  await page.getByText('New owner work', { exact: true }).waitFor();
  assert.equal(await page.getByText('Obsolete private activity', { exact: true }).count(), 0, 'old account response is discarded');
  assert.deepEqual(errors, []);
  console.log('✓ Agent widget: deferred read, no selection requests, failed status stays unknown, retry and account isolation');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
