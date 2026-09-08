// Production-bundle checks with synthetic account data and blocked external traffic.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import http from 'node:http';
import { launch } from './lib/browser.mjs';
import { webkit } from '@playwright/test';
import { fetchStubSource, sessionSeedSource, bundleSupabaseUrl } from './lib/fixtures.mjs';
const dist = new URL('../dist', import.meta.url).pathname;
const server = http.createServer((req, res) => {
  let file = join(dist, (req.url || '/').split('?')[0]);
  if (!existsSync(file) || !extname(file)) file = join(dist, 'index.html');
  res.setHeader('content-type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' })[extname(file)] || 'application/octet-stream');
  try { res.end(readFileSync(file)); } catch { res.statusCode = 404; res.end(); }
}).listen(0);
const browser = process.env.EFFECTS_BROWSER === 'webkit' ? await webkit.launch() : await launch();
const origin = `http://127.0.0.1:${server.address().port}`;
const shots = process.env.EFFECTS_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
async function context(options = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, ...options });
  await ctx.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await ctx.addInitScript(fetchStubSource());
  await ctx.addInitScript(sessionSeedSource(bundleSupabaseUrl(dist)));
  await ctx.addInitScript(() => {
    const now = new Date();
    localStorage.setItem(`florrie_catchup_${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`, '1');
    const base = window.fetch;
    const json = data => Promise.resolve(new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }));
    const agents = [{ id: 'front_desk', name: 'Front Desk', actionsThisWeek: 24, statusLine: 'Appointment reminder delivered', lastActionAt: '2026-09-08T08:30:00Z', checks: [{ name: 'reminders', state: 'recent', last_success_at: '2026-09-08T08:30:00Z' }] }];
    window.__effects = { writes: 0, briefReads: 0, statusReads: 0 };
    window.fetch = (input, options = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/agents/brief')) { window.__effects.briefReads++; return json({ checked_at: '2026-09-08T08:30:00Z', partial: false, permissions: { auto_reply_enabled: false }, activity: { completed: 24, failed: 0, pending_approval: 3 }, learning: { human_samples: 105, client_profiles: 50, saved_corrections: 8 }, insights_available: true, insights: [{ id: 'pattern', title: 'Thursdays bring your regulars back', summary: 'Your Thursday visits are mostly repeat clients.', evidence: 'Based on completed bookings in the last eight weeks.', link_to: '/analytics', action_label: 'Explore your bookings' }], agents }); }
      if (url.includes('/api/agents/status')) { window.__effects.statusReads++; return json({ agents }); }
      if (url.includes('/api/florrie-thinks')) return json({ cards: [{ id: 'need', type: 'lead', icon: 'message', summary: 'A client reply is ready for your review.', action_label: 'Open thread', link_to: '/inbox', evidence: { label: 'Asked this morning', link_to: '/inbox' } }] });
      if (url.includes('/api/voice/command') && options.method === 'POST') { window.__effects.writes++; return new Promise(resolve => { window.__effects.resolveVoice = () => resolve(new Response(JSON.stringify({ reply: 'Your next appointment is at 1pm.' }), { headers: { 'content-type': 'application/json' } })); }); }
      return base(input, options);
    };
  });
  return ctx;
}
try {
  const ctx = await context(); const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/today`);
  await page.locator('.today-team-teaser').waitFor();
  assert.ok(await page.locator('.today-team-teaser').evaluate(el => el.getBoundingClientRect().top >= document.querySelector('.today-layout').getBoundingClientRect().bottom), 'the collapsed widget follows the whole working day');
  assert.equal(await page.evaluate(() => __effects.statusReads), 0, 'the bottom widget does not fetch during the first view of the diary');
  assert.equal(await page.getByRole('tab', { name: 'Day', exact: true }).evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(146, 64, 94)', 'Today keeps its original plum selection');
  assert.equal(await page.getByRole('tab', { name: 'Day', exact: true }).evaluate(el => getComputedStyle(el).color), 'rgb(255, 255, 255)', 'Today keeps white selected text');
  if (shots) await page.screenshot({ path: join(shots, 'today.png') });
  await page.locator('.today-team-teaser').scrollIntoViewIfNeeded();
  await page.locator('.today-team-teaser canvas').waitFor();
  await page.getByRole('button', { name: 'Explore Florrie’s team', exact: true }).click();
  await page.getByText('Appointment reminder delivered', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Collapse Florrie’s team', exact: true }).click();
  if (shots) await page.screenshot({ path: join(shots, 'today-bottom.png') });
  await page.getByRole('button', { name: 'Open your brief', exact: true }).click();
  await page.getByRole('heading', { name: 'Florrie’s brief' }).waitFor();
  await page.locator('.brief-hero canvas').waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.fl-liquid-surface svg rect')].some(el => el.getBoundingClientRect().height > 20));
  await page.getByRole('tab', { name: 'The team', exact: true }).click();
  await page.getByRole('button', { name: 'Explore Guardian', exact: true }).click();
  await page.getByText('Completed count unavailable', { exact: false }).waitFor();
  await page.getByRole('tab', { name: 'Learning', exact: true }).click();
  await page.getByText('105', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => __effects.briefReads), 1, 'view switches reuse the brief');
  await page.getByRole('tab', { name: 'Your brief', exact: true }).click();
  await page.getByRole('tab', { name: 'Your brief', exact: true }).press('End');
  await page.getByRole('tab', { name: 'Learning', exact: true }).press('Home');
  await page.waitForFunction(() => {
    const button = document.querySelector('.brief-view-tabs [aria-selected="true"]')?.getBoundingClientRect();
    const rect = document.querySelector('.brief-view-tabs .fl-liquid-surface svg rect')?.getBoundingClientRect();
    return button && rect && Math.abs((button.left + button.width / 2) - (rect.left + rect.width / 2)) < 3;
  });
  if (shots) {
    await page.evaluate(() => document.getElementById('app-scroll').scrollTo(0, 0));
    await page.locator('.brief-hero canvas').waitFor();
    await page.screenshot({ path: join(shots, 'brief.png') });
  }
  await page.getByRole('button', { name: 'Talk it through with Florrie', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Message Florrie', exact: true });
  await input.fill('What does today look like?');
  await input.evaluate(el => { window.__effects.input = el; });
  await page.locator('.fl-voice-composer .fl-effect-beam').waitFor();
  assert.equal(await input.evaluate(el => el === window.__effects.input), true, 'effect load retains the original input');
  assert.equal(await input.inputValue(), 'What does today look like?');
  await input.press('Enter');
  await page.locator('[data-orb-state="working"] canvas').first().waitFor();
  assert.equal(await page.evaluate(() => __effects.writes), 1, 'one submitted command');
  await page.evaluate(() => __effects.resolveVoice());
  await page.getByText('Your next appointment is at 1pm.', { exact: true }).waitFor();
  assert.equal(await page.locator('.fl-voice-processing').count(), 0, 'work indicator stops when request finishes');
  assert.deepEqual(errors, []);
  await ctx.close();
  const reduced = await context({ reducedMotion: 'reduce' }); const calm = await reduced.newPage();
  await calm.goto(`${origin}/insights`);
  await calm.locator('.brief-view-tabs .fl-liquid-static').waitFor();
  assert.equal(await calm.locator('.fl-liquid-surface').count(), 0, 'reduced motion uses a static selection');
  await calm.goto(`${origin}/voice`); await calm.getByRole('textbox', { name: 'Message Florrie' }).fill('Keep this draft');
  assert.equal(await calm.locator('.fl-effect-beam').count(), 0, 'reduced motion has no animated beam');
  await reduced.close();
  const fallback = await context();
  const beamFile = readdirSync(join(dist, 'assets')).find(name => name.endsWith('.js') && name.startsWith('index.es-') && readFileSync(join(dist, 'assets', name), 'utf8').includes('data-beam-bloom'));
  assert.ok(beamFile, 'real border-beam package is bundled separately');
  await fallback.route(`**/${beamFile}`, route => route.abort());
  const safe = await fallback.newPage(); await safe.goto(`${origin}/voice`);
  const failedEffect = safe.waitForEvent('requestfailed', { predicate: request => request.url().endsWith('/' + beamFile) });
  const retained = safe.getByRole('textbox', { name: 'Message Florrie' });
  await retained.evaluate(el => { window.__retainedInput = el; });
  await retained.fill('My writing must stay');
  await failedEffect;
  await safe.waitForFunction(() => document.querySelector('[data-effect-active="true"]') && !document.querySelector('.fl-effect-overlay .fl-effect-beam'));
  await safe.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await retained.inputValue(), 'My writing must stay');
  assert.equal(await retained.evaluate(el => el === window.__retainedInput), true, 'failed decoration cannot replace the draft input');
  await fallback.close();
  console.log('✓ Libraries.dev: bottom-of-Today widget, original plum selection, real orb/canvas and liquid surface, reusable brief, stable input, actual working state, reduced motion and failed-effect fallback');
} finally { await browser.close(); server.close(); }
