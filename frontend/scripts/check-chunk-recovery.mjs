import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import http from 'node:http';
import { launch } from './lib/browser.mjs';
import { fetchStubSource, sessionSeedSource, bundleSupabaseUrl } from './lib/fixtures.mjs';

const dist = new URL('../dist', import.meta.url).pathname;
let documents = 0;
let missing = 0;
let persistentFailure = false;
const server = http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (/\/WhatsAppConfig-[^/]+\.js$/.test(path) && (persistentFailure || missing === 0)) {
    missing++;
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Asset from an earlier deployment is no longer available');
    return;
  }
  let file = join(dist, path);
  if (!existsSync(file) || !extname(file)) { file = join(dist, 'index.html'); documents++; }
  res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' })[extname(file)] || 'application/octet-stream');
  res.end(readFileSync(file));
}).listen(0);
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await launch();
try {
  for (const failAgain of [false, true]) {
    documents = 0; missing = 0; persistentFailure = failAgain;
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.addInitScript(fetchStubSource());
    // Seed only the first document, so the recovery must retain the real auth storage.
    await context.addInitScript(`if (!sessionStorage.getItem('test-session-seeded')) {
      ${sessionSeedSource(bundleSupabaseUrl(dist))}
      sessionStorage.setItem('test-session-seeded', 'yes');
      localStorage.setItem('test-saved-draft', 'Keep this draft');
    }`);
    const page = await context.newPage();
    await page.goto(`${origin}/whatsapp`);
    if (failAgain) await page.getByRole('heading', { name: 'This page couldn’t load' }).waitFor();
    else await page.getByRole('heading', { name: 'WhatsApp Business', exact: true }).waitFor();
    assert.equal(documents, 2, 'one automatic reload, with no reload loop');
    assert.equal(await page.evaluate(() => localStorage.getItem('test-saved-draft')), 'Keep this draft');
    assert.equal(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('sb-') && key.endsWith('-auth-token'))), true);
    assert.equal(new URL(page.url()).pathname, '/whatsapp');
    if (failAgain) assert.equal(await page.getByRole('button', { name: 'Refresh page' }).isVisible(), true);
    await context.close();
  }
  console.log('PASS deployment recovery: one reload restores a missing page; repeated failure offers manual retry; auth and saved drafts retained');
} finally { await browser.close(); server.close(); }
