// Real Today effects with controlled responses; no account or external requests.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { build } from 'esbuild';
import { launch } from './lib/browser.mjs';

const root = new URL('../', import.meta.url).pathname;
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {TodaySummary} from './src/components/TodayCards.jsx';
window.fixture={diary:[],counts:[],navigations:[],read({url}){
  const type=url.includes('/api/agents/counts')?'counts':'diary';
  return new Promise((resolve,reject)=>this[type].push({url,resolve,reject}));
}};
createRoot(document.getElementById('root')).render(<TodaySummary
  beautician={{id:'fixture-owner',timezone:'Europe/London'}}
  onNav={path=>window.fixture.navigations.push(path)}/>);
`;
const stubs = {
  supabase: 'export const supabase={auth:{}};',
  config: 'export const API_BASE="";',
  'authenticated-json': 'export const readAuthenticatedJson=args=>window.fixture.read(args);',
};
const bundle = await build({
  stdin: { contents: entry, resolveDir: root, loader: 'jsx' },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"test"' },
  plugins: [{ name: 'today-loading-stubs', setup(b) {
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
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const executablePath = process.env.BROWSER_EXECUTABLE || (existsSync(chrome) ? chrome : undefined);
  browser = await launch(executablePath ? { executablePath } : {});
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const mount = async name => {
    await page.goto(`${origin}/${name}`);
    await page.waitForFunction(() => fixture.diary.length === 1 && fixture.counts.length === 1);
  };

  await mount('slow-counts');
  await page.evaluate(() => fixture.diary[0].resolve({ data: [] }));
  await page.getByRole('heading', { name: 'Room to breathe', exact: true }).waitFor();
  assert.equal(await page.getByText('Open inbox · count unavailable', { exact: true }).isVisible(), true);
  await page.evaluate(() => fixture.counts[0].resolve({ inbox: 3 }));
  await page.getByText('3 messages need you', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => fixture.diary.length), 1, 'a later badge must not reload the diary');

  await mount('failed-counts');
  await page.evaluate(() => {
    fixture.diary[0].resolve({ data: [] });
    fixture.counts[0].reject(new Error('Badge service unavailable'));
  });
  await page.getByRole('heading', { name: 'Room to breathe', exact: true }).waitFor();
  assert.equal(await page.getByText('Open inbox · count unavailable', { exact: true }).isVisible(), true);

  await mount('diary-retry');
  await page.evaluate(() => fixture.diary[0].reject(new Error('Your connection is taking too long. Please try again.')));
  await page.getByRole('status').filter({ hasText: 'Your connection is taking too long.' }).waitFor();
  await page.getByRole('button', { name: 'Open calendar', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => fixture.navigations), ['/calendar/week']);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.waitForFunction(() => fixture.diary.length === 2 && fixture.counts.length === 2);
  await page.locator('[aria-label="Loading your day"]').waitFor();
  await page.evaluate(() => {
    fixture.counts[0].resolve({ inbox: 99 });
    fixture.diary[1].resolve({ data: [] });
    fixture.counts[1].resolve({ inbox: 7 });
  });
  await page.getByRole('heading', { name: 'Room to breathe', exact: true }).waitFor();
  await page.getByText('7 messages need you', { exact: true }).waitFor();
  assert.equal(await page.getByText('99 messages need you', { exact: true }).count(), 0, 'obsolete badge response must not replace the latest result');
  assert.deepEqual(errors, []);
  console.log('PASS: diary renders before slow counts; failed badge stays unknown; diary timeout opens calendar; Retry loads fresh data and ignores obsolete badge results');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
