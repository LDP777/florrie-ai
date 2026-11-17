// Real built app, fictional responses only. No external requests or sends.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import http from 'node:http';
import { launch } from './lib/browser.mjs';
import { fetchStubSource, sessionSeedSource, bundleSupabaseUrl } from './lib/fixtures.mjs';
const dist = new URL('../dist', import.meta.url).pathname;
const server = http.createServer((req,res) => {
  let file = join(dist, req.url.split('?')[0]); if (!existsSync(file) || !extname(file)) file = join(dist,'index.html');
  res.setHeader('content-type', ({ '.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml' })[extname(file)] || 'application/octet-stream'); res.end(readFileSync(file));
}).listen(0);
const browser = await launch(), origin = `http://127.0.0.1:${server.address().port}`;
try {
  for (const [mode,width] of [['confirm',390],['conflict',320],['stale',390],['snooze',1024],['draft',390],['privacy',390],['receipt',390]]) {
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    await context.route('**/*', r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
    await context.addInitScript(fetchStubSource()); await context.addInitScript(sessionSeedSource(bundleSupabaseUrl(dist)));
    await context.addInitScript(mode => {
      const base = window.fetch; window.__thoughtWrites = []; window.__thoughtHidden = false;
      if (mode === 'privacy') localStorage.setItem('florrie:hide-client-details:v1','true');
      const card = { id: 'holiday', type: 'holiday_habit', title: 'Keep your bank holiday?', summary: 'You chose time off on two recent bank holidays. Would you like to keep Christmas Day for yourself too?', consideration: 'There is still time to protect it before someone books.', evidence: { facts: ['Two explicit closures recorded.', 'No active bookings on this date.'], link_to: '/calendar/week?date=2026-12-25' }, action_label: 'Review the day', link_to: '/calendar/week?date=2026-12-25' };
      window.fetch = async (input,options = {}) => {
        const url = String(input), body = JSON.parse(options.body || '{}');
        if (options.method && options.method !== 'GET') window.__thoughtWrites.push({ url, body });
        if (url.includes('/api/florrie-thinks/prepare')) return Response.json(mode === 'draft'
          ? { id: 'holiday', kind: 'drafts', title: 'A thoughtful message', drafts: [{ client_id: 'fictional-nora', client_name: 'Nora', text: 'Hi Nora, I will be closed from 1 to 6 December. Let me know if you would like to arrange a visit around those dates.' }], link_to: '/inbox?client=fictional-nora' }
          : { id: 'holiday', kind: 'protect_time', title: card.title, preview: mode === 'conflict' ? 'One booking overlaps this time. Nothing will be moved.' : 'Protect Friday 25 December all day. You can edit or remove the block in your calendar.', conflict_count: mode === 'conflict' ? 1 : 0, confirmation_token: mode === 'conflict' ? null : 'fixture-confirmation', link_to: card.link_to });
        if (url.includes('/api/florrie-thinks/confirm')) { if (mode === 'stale') return Response.json({ error: 'The diary changed. Nothing was moved. Please check the diary.' }, { status: 409 }); window.__thoughtHidden = true; return Response.json({ ok: true, message: 'Your time on Fri 25 Dec is protected.', link_to: '/calendar/week?date=2026-12-25&view=day' }); }
        if (url.includes('/api/florrie-thinks')) return Response.json({ cards: window.__thoughtHidden ? [] : [card], checked_at: new Date().toISOString(), thinking: false });
        if (url.includes('/api/suggestions/respond')) { window.__thoughtHidden = true; return Response.json({ ok: true }); }
        if (url.includes('/api/inbox/thread/fictional-nora')) return Response.json({ client: { id: 'fictional-nora', first_name: 'Nora', last_name: 'Example', has_email: true }, messages: [], drafts: [], default_channel: 'email' });
        if (url.includes('/api/inbox/threads')) return Response.json({ threads: [] });
        if (url.includes('/api/activity/feed')) return Response.json({ rows: [1,2,3,4].map(i => ({ id: String(i), type: 'appointment_reminder', summary: i === 4 ? 'An identical message' : 'A recorded action', outcome: i === 1 ? 'failed' : 'success', state_label: i === 1 ? 'Could not finish' : 'Completed', created_at: new Date().toISOString() })), receipt: [{ icon: 'clock', text: '73 reminders sent' }, { icon: 'alert-triangle', text: '1 action could not finish' }], receipt_day: '2026-11-17' });
        return base(input,options);
      };
    }, mode);
    const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${origin}/today`);
    const section = page.getByRole('region', { name: 'Florrie thinks', exact: true });
    await section.waitFor();
    if (mode === 'privacy') {
      assert.equal(await section.getByText('Keep your bank holiday?', { exact: true }).count(),0);
      assert.equal(await section.getByRole('button',{name:'Review the day',exact:true}).isEnabled(),false);
    } else if (mode === 'snooze') {
      await section.locator('summary').filter({hasText:'Not now'}).click();
      await section.getByRole('button',{name:'Remind me in 4 hours',exact:true}).click();
      await page.waitForFunction(() => window.__thoughtHidden);
      const writes = await page.evaluate(() => window.__thoughtWrites.filter(w => w.url.includes('/api/suggestions/respond')));
      assert.equal(writes[0].body.choice,'later');
    } else if (mode === 'receipt') {
      await page.getByRole('button',{name:/View 4 recent updates/}).click();
      await page.getByText('73 reminders sent',{exact:true}).waitFor();
      await page.getByText('1 action could not finish',{exact:true}).waitFor();
    } else {
      await section.getByRole('button',{name:'Review the day',exact:true}).click();
      await section.getByText('Ready for you to review',{exact:true}).waitFor();
      assert.equal((await page.evaluate(() => window.__thoughtWrites.filter(w => w.url.includes('/confirm')))).length,0,'a preview must not apply changes');
      if (mode === 'draft') {
        await section.getByRole('button',{name:'Review in the conversation',exact:true}).click();
        const composer = page.locator('textarea').first(); await composer.waitFor();
        await page.waitForFunction(() => document.querySelector('textarea')?.value.startsWith('Hi Nora,'));
        assert.equal((await page.evaluate(() => window.__thoughtWrites.filter(w => w.url.includes('/inbox/send')))).length,0,'draft handoff must never send');
      } else if (mode === 'conflict') {
        assert.equal(await section.getByRole('button',{name:'Keep this day off',exact:true}).count(),0);
        await section.getByText('One booking overlaps this time. Nothing will be moved.').waitFor();
      } else {
        await section.getByRole('button',{name:'Keep this day off',exact:true}).click();
        if (mode === 'stale') await section.getByRole('alert').filter({hasText:'Nothing was moved'}).waitFor();
        else { await section.getByText('Your time on Fri 25 Dec is protected.',{exact:true}).waitFor(); assert.equal((await page.evaluate(() => window.__thoughtWrites.filter(w => w.url.includes('/confirm')))).length,1); }
      }
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${mode} fits ${width}px`);
    assert.deepEqual(errors,[]);
    if (mode === 'confirm' && process.env.THOUGHTS_SCREENSHOT) await page.screenshot({path:process.env.THOUGHTS_SCREENSHOT,fullPage:true});
    console.log('PASS thoughtful suggestions: '+mode); await context.close();
  }
} finally { await browser.close(); server.close(); }
