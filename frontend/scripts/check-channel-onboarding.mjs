import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import http from 'node:http';
import { launch } from './lib/browser.mjs';
import { fetchStubSource, sessionSeedSource, bundleSupabaseUrl } from './lib/fixtures.mjs';
const dist = new URL('../dist', import.meta.url).pathname;
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  let file = join(dist, (req.url || '/').split('?')[0]);
  if (!existsSync(file) || !extname(file)) file = join(dist, 'index.html');
  try { res.setHeader('content-type', mime[extname(file)] || 'application/octet-stream'); res.end(readFileSync(file)); }
  catch { res.statusCode = 404; res.end(); }
}).listen(0);
const browser = await launch();

try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const mode of ['whatsapp', 'onboarding']) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await ctx.addInitScript(fetchStubSource());
    await ctx.addInitScript(sessionSeedSource(bundleSupabaseUrl(dist)));
    await ctx.addInitScript(mode => {
      const base = window.fetch;
      const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: {'Content-Type':'application/json'} });
      window.__connectionActions = [];
      window.__allowConnection = false;
      const profile = { id:'b1', auth_id:'b1', first_name:'Demo', business_name:'Demo salon', booking_slug:'demo-salon',
        onboarding_completed_at:mode === 'onboarding' ? null : '2026-01-01', trial_ends_at:'2099-01-01', timezone:'Europe/London' };
      window.fetch = async (input, opts = {}) => {
        const url = String(input);
        if (url.includes('/rest/v1/beauticians')) {
          if (opts.method === 'PATCH') {
            if (!window.__allowConnection) return json({ message:'Synthetic setup write rejected' }, 500);
            Object.assign(profile, JSON.parse(opts.body));
            window.__connectionActions.push('setup-saved');
          }
          return json(profile);
        }
        if (url.includes('/api/whatsapp/status')) return window.__allowConnection ? json({ connected:true, phone:'447700900001' }) : json({error:'Synthetic failed read'},500);
        if (url.includes('/api/whatsapp/') && opts.method && opts.method !== 'GET') {
          window.__connectionActions.push('unexpected-whatsapp-write'); return json({},500);
        }
        if (url.includes('/api/instagram/connect')) {
          window.__connectionActions.push('instagram-connect');
          return json({ url:'https://www.instagram.com/oauth/authorize?client_id=test' });
        }
        return base(input,opts);
      };
    }, mode);
    const page = await ctx.newPage();
    if (mode === 'whatsapp') {
      await page.goto(`${origin}/whatsapp`);
      await page.getByRole('alert').filter({hasText:'Could not check your WhatsApp connection'}).waitFor();
      assert.equal(await page.getByText('Not connected',{exact:true}).count(),0);
      assert.equal(await page.getByRole('button',{name:'Send verification code'}).count(),0);
      await page.evaluate(()=>{window.__allowConnection = true;});
      await page.getByRole('button',{name:'Retry',exact:true}).click();
      await page.getByText('Connected',{exact:true}).waitFor();
      assert.deepEqual(await page.evaluate(()=>window.__connectionActions),[]);
      console.log('PASS: WhatsApp read failure does not claim disconnection or offer registration; retry restores existing connection');
    } else {
      await page.goto(`${origin}/today`);
      await page.getByRole('button',{name:'Skip for now',exact:true}).click();
      await page.getByRole('button',{name:'Connect Instagram',exact:true}).waitFor();
      let left = false;
      await page.route('https://www.instagram.com/**', route=>{left=true;return route.abort();});
      await page.getByRole('button',{name:'Connect Instagram',exact:true}).click();
      await page.getByText('Could not save your setup. Try again.',{exact:true}).waitFor();
      assert.equal(left,false);
      await page.evaluate(()=>{window.__allowConnection = true;});
      await page.getByRole('button',{name:'Connect Instagram',exact:true}).click();
      await page.waitForURL(/instagram.com|chrome-error:/).catch(()=>{});
      assert.equal(left,true);
      console.log('PASS: new salon stays in setup after rejected save and can retry the Instagram handoff');
    }
    await ctx.close();
  }
} finally { await browser.close(); server.close(); }
