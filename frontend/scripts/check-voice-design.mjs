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
      window.__voiceDesign = JSON.parse(sessionStorage.getItem('voice-design-ledger') || 'null')
        || { commands: [], executions: 0, starts: 0, diaryReads: [], failDiary: true };
      const remember = () => sessionStorage.setItem('voice-design-ledger', JSON.stringify({
        commands: __voiceDesign.commands, executions: __voiceDesign.executions,
        starts: __voiceDesign.starts, diaryReads: __voiceDesign.diaryReads, failDiary: __voiceDesign.failDiary,
      }));
      window.SpeechRecognition = class {
        start() { __voiceDesign.starts++; __voiceDesign.recognition = this; remember(); this.onstart?.(); }
        stop() {
          __voiceDesign.stopCalls = (__voiceDesign.stopCalls || 0) + 1;
          if (!__voiceDesign.deferStop) this.onend?.();
        }
        abort() { this.onend?.(); }
      };
      const base = window.fetch;
      const json = value => Promise.resolve(new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }));
      window.fetch = (input, options = {}) => {
        const url = typeof input === 'string' ? input : input?.url || '';
        const method = options.method || input?.method || 'GET';
        if (url.includes('/rest/v1/appointments') && method === 'HEAD') {
          __voiceDesign.diaryReads.push(url); remember();
          if (__voiceDesign.failDiary) return Promise.resolve(new Response(null, { status: 503 }));
          return Promise.resolve(new Response(null, { headers: { 'content-range': '0-7/8' } }));
        }
        if (url.includes('/api/voice/command')) {
          const command = JSON.parse(options.body);
          __voiceDesign.commands.push(command); remember();
          if (/^Prepare (?:another |unconfirmed )?demo message/.test(command.text)) {
            return json({ reply: 'Review this demo message before sending.', proposals: [{ tool: 'send_message', input: { client_name: 'Demo Client', message: 'Demo only.' } }] });
          }
          if (command.text === 'What did I earn this week?') {
            return json({ reply: 'Your recorded demo income this week is £240.', actions: [{ tool: 'get_revenue_summary', data: { total: 24000 } }] });
          }
          return json({ reply: 'You have eight appointments today. Your diary, payments and brief are ready to open.', actions: [
            { tool: 'check_schedule', data: { date: '2026-09-29', appointments: [] } },
            { tool: 'get_revenue_summary', data: {} },
            { tool: 'get_outstanding_payments', data: {} },
            { tool: 'get_florrie_brief', data: {} },
          ] });
        }
        if (url.includes('/api/voice/execute')) { __voiceDesign.executions++; remember(); return json({ result: 'Demo action confirmed.' }); }
        return base(input, options);
      };
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const commandCount = () => page.evaluate(() => __voiceDesign.commands.length);
    const fresh = async () => {
      await page.getByRole('button', { name: 'New conversation', exact: true }).click();
      await page.getByRole('button', { name: 'Start fresh', exact: true }).click();
      await page.getByRole('navigation', { name: 'Your salon shortcuts' }).waitFor();
    };
    const chooseTopic = async name => {
      const explore = page.getByRole('button', { name: 'More ways to ask', exact: true });
      if (await explore.getAttribute('aria-expanded') !== 'true') await explore.click();
      await page.getByRole('group', { name: 'Choose a topic', exact: true }).getByRole('button', { name, exact: true }).click();
    };
    const submit = async text => {
      await page.getByLabel('Message Florrie').fill(text);
      await page.getByLabel('Message Florrie').press('Enter');
    };
    const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No page overflow at ${width}`);
    await page.goto(`${origin}/voice`);
    await page.getByRole('link', { name: 'Schedule. Today’s diary is unavailable', exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Schedule. 0 appointments in your diary today', exact: true }).count(), 0, 'A failed diary read must not claim an empty day');
    assert.equal(await page.getByRole('button', { name: 'Tap to speak', exact: true }).isEnabled(), true, 'Diary failure does not block the commander');
    await page.evaluate(() => { __voiceDesign.failDiary = false; });
    await page.getByRole('button', { name: 'Retry diary summary', exact: true }).click();
    await page.getByRole('link', { name: 'Schedule. 8 appointments in your diary today', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Retry diary summary', exact: true }).count(), 0, 'Retry replaces the unavailable state with the recovered count');
    await page.evaluate(() => document.fonts.ready);
    await noOverflow();
    const diaryRead = await page.evaluate(() => __voiceDesign.diaryReads[0]);
    const diaryQuery = new URL(diaryRead).searchParams;
    assert.equal(diaryQuery.get('beautician_id'), 'eq.b1', 'Diary summary is scoped to the signed-in salon');
    assert.equal(diaryQuery.get('select'), 'id');
    assert.match(diaryQuery.get('status'), /cancelled.*no_show/);
    assert.equal(await page.locator('.fl-voice-emblem svg').count(), 1, 'Original flower remains visible');
    assert.equal(await page.locator('.fl-command-petal img').count(), 0, 'No native image preview target');
    assert.equal(await page.getByRole('button', { name: 'Tap to speak', exact: true }).evaluate(el => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))), false);
    await page.screenshot({ path: join(output, `voice-${width}.png`), fullPage: true, animations: 'disabled' });

    // The compact navigation uses real routes and carries no command side effects.
    assert.equal(await page.getByRole('group', { name: 'Choose a topic', exact: true }).count(), 0, 'Task groups are available through the composer rather than occupying the default deck');
    for (const [label, path] of [['Inbox', '/inbox'], ['Patch tests', '/patch-tests'], ['Schedule', '/calendar/week'], ['Money', '/money']]) {
      const link = page.getByRole('navigation', { name: 'Your salon shortcuts' }).getByRole('link', { name: new RegExp(`^${label}\\b`) });
      const target = new URL(await link.getAttribute('href'), origin);
      assert.equal(target.pathname, path);
      if (label === 'Schedule') {
        assert.equal(target.searchParams.get('view'), 'day', 'The diary summary opens its day view');
        assert.match(target.searchParams.get('date'), /^\d{4}-\d{2}-\d{2}$/, 'The diary summary includes its date');
      }
      await link.click();
      await page.waitForURL(target.href);
      await page.goBack();
      await page.getByRole('navigation', { name: 'Your salon shortcuts' }).waitFor();
    }
    for (const [label, draft] of [
      ['Ask about my day', 'What does today look like?'],
      ['Ask about my earnings', 'What did I earn this week?'],
    ]) {
      await page.getByRole('button', { name: label, exact: true }).click();
      assert.equal(await page.getByLabel('Message Florrie').inputValue(), draft);
      assert.equal(await commandCount(), 0, 'Composer shortcuts prepare drafts without submitting a command');
    }
    await page.getByLabel('Message Florrie').fill('');
    await chooseTopic('Business');
    assert.equal(await page.getByRole('navigation', { name: 'Your salon shortcuts' }).count(), 0, 'The task picker replaces the shortcut deck');
    await page.getByRole('button', { name: /^Check outstanding payments/ }).waitFor();
    await chooseTopic('Clients');
    await page.getByRole('button', { name: /^Find a client/ }).click();
    assert.equal(await page.getByLabel('Message Florrie').inputValue(), 'Tell me about ');
    await page.getByText('Add the client’s name, then send.', { exact: true }).waitFor();
    assert.equal(await commandCount(), 0, 'A client-name template prepares a draft without executing');
    await page.getByLabel('Message Florrie').fill('');
    await chooseTopic('Create');
    for (const [title, path, draft] of [
      ['Plan content that brings bookings', '/content', false],
      ['Continue a content draft', '/content', true],
      ['Work with your reviews', '/reviews', false],
    ]) {
      await page.getByRole('button', { name: new RegExp(`^${title}`) }).click();
      await page.waitForURL(`${origin}${path}`);
      if (draft) {
        const postsView = page.locator('.fl-studio-tabs').getByRole('button', { name: 'Your posts', exact: true });
        await postsView.waitFor();
        assert.equal(await postsView.getAttribute('aria-pressed'), 'true', 'Continue a draft opens Your posts');
        const draftsView = page.getByRole('group', { name: 'Post views', exact: true }).getByRole('button', { name: 'Drafts', exact: true });
        await draftsView.waitFor();
        assert.equal(await draftsView.getAttribute('aria-pressed'), 'true', 'Continue a draft opens Drafts rather than Scheduled or Published');
      }
      await page.goBack();
      await page.getByRole('button', { name: 'More ways to ask', exact: true }).waitFor();
      await chooseTopic('Create');
    }
    assert.equal(await commandCount(), 0, 'Create tasks open real workspaces instead of unsupported voice commands');

    // One tap runs an expressly selected read task and gives several valid next steps.
    await chooseTopic('My day');
    await page.getByRole('button', { name: /^Brief me on today/ }).click();
    await page.getByText('You have eight appointments today. Your diary, payments and brief are ready to open.', { exact: true }).waitFor();
    assert.equal(await commandCount(), 1);
    assert.equal(await page.evaluate(() => __voiceDesign.commands[0].text), 'What is my schedule today, and what needs my attention?');
    const results = page.locator('.fl-command-result-links').getByRole('button');
    assert.deepEqual(await results.allTextContents(), ['Open this day', 'Open Money', 'Open Florrie’s brief']);
    await noOverflow();
    if (width === 390) await page.screenshot({ path: join(output, 'voice-response.png'), fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: 'Open this day', exact: true }).click();
    await page.waitForURL(`${origin}/calendar/week?date=2026-09-29&view=day`);
    await page.goBack();
    await page.getByRole('button', { name: 'New conversation', exact: true }).waitFor();
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await page.getByRole('button', { name: 'Keep chat', exact: true }).click();
    assert.equal(await page.getByText('You have eight appointments today. Your diary, payments and brief are ready to open.', { exact: true }).count(), 1, 'Opening New conversation does not clear it without confirmation');
    await fresh();
    assert.equal(await page.locator('.fl-voice-messages p').count(), 0, 'Start fresh clears the transcript');

    // Actual keyboard behavior preserves Shift+Enter but sends Enter exactly once.
    const input = page.getByLabel('Message Florrie');
    await input.fill('Check my diary');
    await input.press('Shift+Enter');
    await input.pressSequentially('and care');
    assert.equal(await input.inputValue(), 'Check my diary\nand care');
    assert.equal(await commandCount(), 1);
    await input.press('Enter');
    await page.getByRole('button', { name: 'Open this day', exact: true }).waitFor();
    assert.equal(await commandCount(), 2);
    assert.equal(await page.evaluate(() => __voiceDesign.commands.at(-1).text), 'Check my diary\nand care');
    await fresh();

    // Interim words are visible; cancelling invalidates even an already-queued callback.
    await chooseTopic('My day');
    await page.getByRole('button', { name: 'Tap to speak', exact: true }).click();
    await page.getByRole('button', { name: 'Stop listening', exact: true }).waitFor();
    assert.ok(await input.isDisabled());
    assert.ok(await page.locator('.fl-command-toolbar').evaluate(toolbar => {
      const bounds = toolbar.getBoundingClientRect();
      const cancel = toolbar.querySelector('.fl-command-cancel')?.getBoundingClientRect();
      const stop = toolbar.querySelector('[aria-label="Stop listening"]')?.getBoundingClientRect();
      return cancel && stop && cancel.left >= bounds.left - 1 && stop.right <= bounds.right + 1
        && cancel.right <= stop.left + 1;
    }), `Recording Cancel and Stop controls fit without clipping or overlap at ${width}px`);
    assert.equal(await page.locator('.fl-command-wave i').first().evaluate(el => getComputedStyle(el).animationName), 'none', 'Reduced motion is respected');
    await page.evaluate(() => {
      const result = [{ transcript: 'What did I earn' }]; result.isFinal = false;
      __voiceDesign.recognition.onresult({ resultIndex: 0, results: [result] });
      __voiceDesign.lateResult = __voiceDesign.recognition.onresult;
    });
    await page.waitForFunction(() => document.querySelector('[aria-label="Message Florrie"]')?.value === 'What did I earn');
    assert.equal(await input.inputValue(), 'What did I earn');
    await noOverflow();
    if (width === 390) await page.screenshot({ path: join(output, 'voice-listening.png'), fullPage: true, animations: 'disabled' });
    // A real recogniser may deliver its final words well after stop() returns.
    await page.evaluate(() => { __voiceDesign.deferStop = true; });
    await page.getByRole('button', { name: 'Stop listening', exact: true }).click();
    assert.equal(await page.evaluate(() => __voiceDesign.stopCalls), 1, 'Stop reaches the recogniser');
    assert.equal(await page.getByRole('button', { name: 'Stop listening', exact: true }).isVisible(), true, 'Stop remains visible while the recogniser finalises');
    assert.equal(await page.getByRole('button', { name: 'Cancel recording', exact: true }).isEnabled(), true, 'Recording can still be cancelled during finalisation');
    assert.equal(await input.isDisabled(), true, 'Typing stays disabled until a final/end event or cancellation');
    assert.equal(await page.getByRole('button', { name: /^Brief me on today/ }).isDisabled(), true, 'Task controls stay disabled during finalisation');
    assert.equal(await page.getByRole('group', { name: 'Choose a topic', exact: true }).getByRole('button', { name: 'Clients', exact: true }).isDisabled(), true);
    assert.equal(await commandCount(), 2, 'Calling stop does not submit an interim transcript');
    await page.getByRole('button', { name: 'Cancel recording', exact: true }).click();
    await page.evaluate(() => {
      const result = [{ transcript: 'Cancelled speech must not send' }]; result.isFinal = true;
      __voiceDesign.lateResult({ resultIndex: 0, results: [result] });
      __voiceDesign.deferStop = false;
    });
    assert.equal(await commandCount(), 2, 'Cancelled recording sends nothing even if a final event arrives late');
    assert.equal(await input.inputValue(), '');
    await page.getByRole('button', { name: 'Tap to speak', exact: true }).click();
    await page.getByRole('button', { name: 'Stop listening', exact: true }).waitFor();
    await page.evaluate(() => {
      const result = [{ transcript: 'What did I earn this week?' }]; result.isFinal = true;
      __voiceDesign.recognition.onresult({ resultIndex: 0, results: [result] });
    });
    await page.getByText('Your recorded demo income this week is £240.', { exact: true }).waitFor();
    assert.equal(await commandCount(), 3);
    assert.equal(await page.evaluate(() => __voiceDesign.starts), 2);
    assert.equal(await page.locator('.fl-voice-messages').getByText('Voice', { exact: true }).count(), 1);

    // Preparing, declining and confirming remain distinct from one-tap read commands.
    await submit('Prepare demo message');
    await page.getByRole('button', { name: 'Yes, do it', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => __voiceDesign.executions), 0);
    await page.getByRole('button', { name: 'Leave it', exact: true }).click();
    assert.equal(await page.evaluate(() => __voiceDesign.executions), 0);
    await submit('Prepare another demo message');
    await page.getByRole('button', { name: 'Yes, do it', exact: true }).click();
    await page.getByText('Demo action confirmed.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => __voiceDesign.executions), 1);
    await submit('Prepare unconfirmed demo message');
    await page.getByRole('button', { name: 'Yes, do it', exact: true }).waitFor();
    if (width === 390) await page.screenshot({ path: join(output, 'voice-proposal.png'), fullPage: true, animations: 'disabled' });
    await page.reload();
    await page.getByText('Demo action confirmed.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Yes, do it', exact: true }).count(), 0, 'Neither completed nor unconfirmed historic proposals can run on reload');
    assert.equal(await page.getByRole('button', { name: 'Leave it', exact: true }).count(), 0);
    assert.equal(await page.locator('.fl-command-history-note').filter({ hasText: 'This earlier proposal is no longer active.' }).count(), 3);
    assert.equal(await page.evaluate(() => __voiceDesign.executions), 1, 'Reload does not repeat an action');
    await fresh();
    await noOverflow();
    assert.deepEqual(errors, []);
    await ctx.close();
    console.log(`✓ Voice ${width}px: scoped diary, task groups, working destinations, keyboard, voice/cancel, safe history and explicit action confirmation`);
  }
} finally { await browser.close(); server.close(); }
