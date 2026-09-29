// Real app and interaction checks; fictional data and no external traffic.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import http from 'node:http';
import { launch } from './lib/browser.mjs';
import { fetchStubSource, sessionSeedSource, bundleSupabaseUrl } from './lib/fixtures.mjs';

const dist = new URL('../dist', import.meta.url).pathname;
const output = process.env.VISUAL_OUTPUT_DIR || '/tmp/florrie-voice-design';
mkdirSync(output, { recursive: true });
const server = http.createServer((req, res) => {
  let file = join(dist, (req.url || '/').split('?')[0]);
  if (!existsSync(file) || !extname(file)) file = join(dist, 'index.html');
  res.setHeader('content-type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' })[extname(file)] || 'application/octet-stream');
  try { res.end(readFileSync(file)); } catch { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await launch();
try {
  for (const width of [320, 390, 1024]) {
    const ctx = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
    await ctx.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await ctx.addInitScript(fetchStubSource());
    await ctx.addInitScript(sessionSeedSource(bundleSupabaseUrl(dist)));
    await ctx.addInitScript(() => {
      localStorage.setItem('florrie_voice_enabled', '1');
      window.__voiceDesign = { commands: [], executions: 0, starts: 0 };
      window.SpeechRecognition = class {
        start() { __voiceDesign.starts++; __voiceDesign.recognition = this; this.onstart?.(); }
        stop() { this.onend?.(); }
        abort() { this.onend?.(); }
      };
      const base = window.fetch;
      const json = value => Promise.resolve(new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }));
      window.fetch = (input, options = {}) => {
        const url = String(input);
        if (url.includes('/api/voice/command')) {
          __voiceDesign.commands.push(JSON.parse(options.body));
          return json({ reply: 'Review this demo message before sending.', proposals: [{ tool: 'send_message', input: { client_name: 'Demo Client', message: 'Demo only.' } }] });
        }
        if (url.includes('/api/voice/execute')) { __voiceDesign.executions++; return json({ result: 'Demo action confirmed.' }); }
        return base(input, options);
      };
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/voice`);
    await page.getByRole('navigation', { name: 'Your salon shortcuts' }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No page overflow at ${width}`);
    assert.equal(await page.locator('.fl-voice-emblem svg').count(), 1, 'Original flower remains visible');
    assert.equal(await page.locator('.fl-command-petal img').count(), 0, 'No native image preview target');
    assert.equal(await page.getByRole('button', { name: 'Tap to speak', exact: true }).evaluate(el => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))), false);
    await page.screenshot({ path: join(output, `voice-${width}.png`), fullPage: true, animations: 'disabled' });
    for (const [label, path] of [['Inbox', '/inbox'], ['Patch tests', '/patch-tests'], ['Schedule', '/smart-schedule'], ['Money', '/money']]) {
      const link = page.getByRole('navigation', { name: 'Your salon shortcuts' }).getByRole('link', { name: new RegExp(`^${label}`) });
      assert.equal(await link.getAttribute('href'), path);
      await link.click();
      await page.waitForURL(`${origin}${path}`);
      await page.goBack();
      await page.getByRole('navigation', { name: 'Your salon shortcuts' }).waitFor();
    }
    await page.getByRole('button', { name: 'Ask about my day', exact: true }).click();
    assert.equal(await page.getByLabel('Message Florrie').inputValue(), 'What does today look like?');
    await page.getByRole('button', { name: 'Ask about my earnings', exact: true }).click();
    assert.equal(await page.getByLabel('Message Florrie').inputValue(), 'What did I earn this week?');
    await page.getByRole('button', { name: 'More ways to ask', exact: true }).click();
    await page.locator('#fl-command-ideas').getByRole('button', { name: /^Content/ }).click();
    assert.equal(await page.getByLabel('Message Florrie').inputValue(), 'Help me draft a post about my work');
    assert.equal(await page.getByRole('button', { name: 'More ways to ask', exact: true }).getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => __voiceDesign.commands.length), 0, 'Questions prepare text without running commands');
    await page.getByLabel('Message Florrie').fill('');
    await page.getByRole('button', { name: 'Tap to speak', exact: true }).click();
    await page.getByRole('button', { name: 'Stop listening', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => __voiceDesign.starts), 1);
    assert.ok(await page.getByLabel('Message Florrie').isDisabled());
    assert.equal(await page.locator('.fl-command-wave i').first().evaluate(el => getComputedStyle(el).animationName), 'none', 'Reduced motion is respected');
    if (width === 390) await page.screenshot({ path: join(output, 'voice-listening.png'), fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: 'Stop listening', exact: true }).click();
    await page.getByLabel('Message Florrie').fill('Prepare a demo message');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText('Review this demo message before sending.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => __voiceDesign.executions), 0, 'Proposals still require confirmation');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (width === 390) await page.screenshot({ path: join(output, 'voice-proposal.png'), fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: 'Leave it', exact: true }).click();
    assert.equal(await page.evaluate(() => __voiceDesign.executions), 0);
    await page.getByLabel('Message Florrie').fill('Prepare another demo message');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByRole('button', { name: 'Yes, do it', exact: true }).click();
    await page.getByText('Demo action confirmed.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => __voiceDesign.executions), 1);
    assert.deepEqual(errors, []);
    await ctx.close();
    console.log(`✓ Voice ${width}px: shortcuts, draft-only questions, typing, voice, reduced motion and explicit action confirmation`);
  }
} finally { await browser.close(); server.close(); }
