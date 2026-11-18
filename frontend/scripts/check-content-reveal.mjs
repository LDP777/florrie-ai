// Exercise the real effect lifecycle: no client snapshots, no blocked controls,
// no replay of saved work, and immediate cleanup when privacy/motion changes.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { launch } from './lib/browser.mjs';

const bundle = await build({
  stdin: { resolveDir: new URL('..', import.meta.url).pathname, loader: 'jsx', contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { ContentReveal } from './src/components/ContentPreparation.jsx';
    import { ClientPrivacyProvider, useClientPrivacy, PrivateText } from './src/contexts/ClientPrivacyContext.jsx';
    function Fixture() {
      const [event, setEvent] = useState(null), [reviews, setReviews] = useState(0);
      const { toggle } = useClientPrivacy();
      return <main>
        <button onClick={() => setEvent(value => (value || 0) + 1)}>Confirm saved result</button>
        <button onClick={toggle}>Privacy eye</button>
        <ContentReveal event={event} className="fl-content-ready">
          <div className="fl-content-ready-copy"><PrivateText>Fictional client caption</PrivateText>
            <button onClick={() => setReviews(value => value + 1)}>Review draft</button>
          </div>
        </ContentReveal>
        <output aria-label="Reviews opened">{reviews}</output>
      </main>;
    }
    createRoot(document.getElementById('root')).render(<ClientPrivacyProvider><Fixture/></ClientPrivacyProvider>);
  ` }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
});
const css = readFileSync(new URL('../src/styles/content-preparation.css', import.meta.url), 'utf8');
const server = http.createServer((req, res) => {
  if (req.url === '/fixture.js') { res.setHeader('content-type', 'text/javascript'); return res.end(bundle.outputFiles[0].text); }
  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--accent:#92405e;--accent-bg:#f6eaf0;--border:#e8ddd5;--font-body:Arial;--text-primary:#332c29}main{max-width:500px;margin:40px auto}button{min-height:44px}${css}</style><div id="root"></div><script src="/fixture.js"></script></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await launch();
try {
  for (const mode of ['motion', 'reduced', 'no-webgl', 'privacy', 'motion-change']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: mode === 'reduced' ? 'reduce' : 'no-preference' });
    const requests = [], errors = [];
    await context.route('**/*', route => {
      const url = route.request().url(); requests.push(url);
      return url.startsWith(origin + '/') ? route.continue() : route.abort();
    });
    await context.addInitScript(mode => {
      window.effectContexts = []; window.revealStates = [];
      const get = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type, ...args) {
        effectContexts.push(type);
        if (mode === 'no-webgl' && type.startsWith('webgl')) return null;
        return get.call(this, type, ...args);
      };
      new MutationObserver(records => {
        for (const record of records) if (record.attributeName === 'data-reveal-state') revealStates.push(record.target.dataset.revealState);
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-reveal-state'] });
    }, mode);
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.getByRole('button', { name: 'Review draft' }).waitFor();
    assert.deepEqual(await page.evaluate(() => effectContexts), [], 'Opening saved work does not initialise a GPU effect');
    await page.getByRole('button', { name: 'Confirm saved result' }).click();
    if (mode === 'reduced') {
      await page.getByRole('button', { name: 'Review draft' }).click();
      assert.deepEqual(await page.evaluate(() => effectContexts), [], 'Reduced motion does not initialise WebGL');
    } else {
      await page.waitForFunction(() => revealStates.includes('playing'));
      assert.equal(await page.getByRole('button', { name: 'Confirm saved result' }).evaluate(el => el === document.activeElement), true, 'The reveal does not move keyboard focus');
      if (mode === 'privacy') {
        await page.getByRole('button', { name: 'Privacy eye' }).click();
        assert.equal(await page.getByText('Fictional client caption', { exact: true }).count(), 0);
        assert.equal(await page.locator('[data-content-reveal] canvas').count(), 0, 'Privacy removes the canvas immediately');
        const contexts = await page.evaluate(() => effectContexts.length);
        await page.getByRole('button', { name: 'Privacy eye' }).click();
        assert.equal(await page.evaluate(() => effectContexts.length), contexts, 'Showing details does not replay a stale reveal');
      } else if (mode === 'motion-change') {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.waitForFunction(() => !document.querySelector('[data-content-reveal] canvas'));
      }
      await page.getByRole('button', { name: 'Review draft' }).click();
      await page.waitForFunction(() => document.querySelector('[data-content-reveal]')?.dataset.revealState === 'complete');
      assert.equal(await page.locator('[data-content-reveal] canvas').count(), 0, 'Finished effects release their canvas');
    }
    assert.equal(await page.getByLabel('Reviews opened').textContent(), '1', 'Review stays usable through the effect');
    assert.equal(await page.evaluate(() => effectContexts.includes('2d')), false, 'The effect never captures client DOM or images');
    assert.ok(requests.every(url => url.startsWith(origin + '/')), 'No remote assets or telemetry');
    assert.deepEqual(errors, []);
    await context.close(); console.log(`PASS Content reveal: ${mode}`);
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
