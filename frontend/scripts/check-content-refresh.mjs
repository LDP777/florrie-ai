// Built app with fictional posts and intercepted API calls. No provider writes.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import http from 'node:http';
import { launch } from './lib/browser.mjs';
import { bundleSupabaseUrl, fetchStubSource, sessionSeedSource } from './lib/fixtures.mjs';

const dist = new URL('../dist', import.meta.url).pathname;
const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII=', 'base64');
let photoAvailable = false, photoReads = 0;
const server = http.createServer((req, res) => {
  if (req.url === '/preview.png') {
    photoReads++;
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-type', 'image/png');
    res.statusCode = photoAvailable ? 200 : 404;
    res.end(photoAvailable ? photo : '');
    return;
  }
  let file = join(dist, (req.url || '/').split('?')[0]);
  if (!existsSync(file) || !extname(file)) file = join(dist, 'index.html');
  res.setHeader('content-type', ({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'})[extname(file)] || 'application/octet-stream');
  res.end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await launch();
const output = process.env.VISUAL_OUTPUT_DIR;
if (output) mkdirSync(output, { recursive: true });

try {
  for (const width of [320, 390, 1024]) {
    photoAvailable = false; photoReads = 0;
    const context = await browser.newContext({viewport:{width,height:844},timezoneId:'Europe/London',reducedMotion:'reduce'});
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await context.addInitScript(fetchStubSource());
    await context.addInitScript(sessionSeedSource(bundleSupabaseUrl(dist)));
    await context.addInitScript(() => {
      const base = window.fetch;
      const json = (body,status=200) => Promise.resolve(new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}}));
      const post = {id:'11111111-1111-4111-8111-111111111111',status:'draft',post_type:'general',caption:'A detail from our fictional salon.',image_url:`${window.location.origin}/preview.png`,created_at:new Date().toISOString()};
      window.__contentRefresh = {writes:[],resultReads:0,confirmed:2,value:6500,fail:false,hold:false,release:null};
      window.fetch = (input, options = {}) => {
        const url = typeof input === 'string' ? input : input.url;
        const fixture = window.__contentRefresh;
        const method = (options.method || 'GET').toUpperCase();
        if (!['GET','HEAD'].includes(method) && /\/api\/|\/rest\/v1\//.test(url)) {
          fixture.writes.push(url);
          return json({error:'No mutations expected in refresh checks'},409);
        }
        if (url.includes('/api/content/results')) {
          fixture.resultReads++;
          const response = () => fixture.fail ? json({error:'Booking results could not be loaded. Try again.'},503) : json({days:90,explanation:'Only bookings made through these links appear here. Booking value is not money collected.',campaigns:[{campaign_id:'c1',post_id:post.id,caption:post.caption,confirmed:fixture.confirmed,pending:1,cancelled:0,booking_value_cents:fixture.value}]});
          if (fixture.hold) return new Promise(resolve => {fixture.release = () => resolve(response());});
          return response();
        }
        if (/\/api\/content(?:\?|$)/.test(url)) return json({posts:[post],has_more:false,next_offset:null});
        if (url.includes('/api/content/streams')) return json({streams:[]});
        if (url.includes('/api/instagram/status')) return json({connected:true,token_valid:true});
        if (url.includes('/rest/v1/treatments') || url.includes('/rest/v1/content_posts')) return json([]);
        return base(input,options);
      };
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/content`);
    const savedPost = page.locator('#content-post-11111111-1111-4111-8111-111111111111');
    await savedPost.getByRole('button',{name:'Retry preview',exact:true}).waitFor();
    assert.equal(await page.getByText('Your photo belongs here',{exact:true}).count(),0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),`Failed photo overflows at ${width}px`);
    if(output) await page.screenshot({path:join(output,`content-photo-retry-${width}.png`),fullPage:true});
    const reads = photoReads;
    photoAvailable = true;
    await savedPost.getByRole('button',{name:'Retry preview',exact:true}).click();
    await page.waitForFunction(() => {const image=document.querySelector('#content-post-11111111-1111-4111-8111-111111111111 img[alt="Saved post preview"]');return image?.complete && image.naturalWidth>0;});
    assert.ok(photoReads > reads,'Retry must request the saved image again');
    assert.equal(await page.getByRole('button',{name:'Retry preview',exact:true}).count(),0);

    await page.getByRole('button',{name:'Results',exact:true}).click();
    await page.locator('.fl-result-numbers').getByText('£65.00',{exact:true}).waitFor();
    await page.getByLabel('Results post').selectOption('11111111-1111-4111-8111-111111111111');
    assert.ok(await page.locator('.fl-results-refresh time').getAttribute('datetime'));
    await page.evaluate(() => {window.__contentRefresh.confirmed=3;window.__contentRefresh.value=9500;window.__contentRefresh.hold=true;});
    await page.getByRole('button',{name:'Refresh results',exact:true}).click();
    await page.waitForFunction(() => typeof window.__contentRefresh.release === 'function');
    assert.ok(await page.getByRole('button',{name:'Refreshing…',exact:true}).isDisabled());
    assert.equal(await page.locator('.fl-result-numbers').getByText('£65.00',{exact:true}).count(),1,'Previous results stay visible while refreshing');
    await page.evaluate(() => {window.__contentRefresh.hold=false;window.__contentRefresh.release();});
    await page.locator('.fl-result-numbers').getByText('£95.00',{exact:true}).waitFor();
    assert.equal(await page.getByLabel('Results post').inputValue(),'11111111-1111-4111-8111-111111111111');
    const updated = await page.locator('.fl-results-refresh time').getAttribute('datetime');
    await page.evaluate(() => {window.__contentRefresh.fail=true;});
    await page.getByRole('button',{name:'Refresh results',exact:true}).click();
    await page.getByText('Your last loaded results are still shown below.',{exact:true}).waitFor();
    assert.equal(await page.locator('.fl-result-numbers').getByText('£95.00',{exact:true}).count(),1,'A failed refresh must not replace measured results with zero');
    assert.equal(await page.locator('.fl-results-refresh time').getAttribute('datetime'),updated,'Failure must not update the freshness time');
    if(output) await page.screenshot({path:join(output,`content-results-refresh-${width}.png`),fullPage:true});
    await page.evaluate(() => {window.__contentRefresh.fail=false;window.__contentRefresh.confirmed=4;window.__contentRefresh.value=13000;});
    await page.getByRole('button',{name:'Retry results',exact:true}).click();
    await page.locator('.fl-result-numbers').getByText('£130.00',{exact:true}).waitFor();
    assert.equal(await page.getByRole('alert').count(),0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),`Results refresh overflows at ${width}px`);
    assert.deepEqual(await page.evaluate(() => window.__contentRefresh.writes),[],'Refresh and image retry must not create, publish or schedule anything');
    assert.deepEqual(errors,[]);
    console.log(`PASS Content image retry, fresh results, retained selection and failure recovery at ${width}px`);
    await context.close();
  }
} finally {await browser.close();server.close();}
