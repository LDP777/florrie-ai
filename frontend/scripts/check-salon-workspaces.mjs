// Real app bundle, synthetic salon and intercepted provider calls only.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import http from 'node:http';
import { launch } from './lib/browser.mjs';
import { fetchStubSource, sessionSeedSource, bundleSupabaseUrl } from './lib/fixtures.mjs';
const dist = new URL('../dist', import.meta.url).pathname;
const server = http.createServer((req, res) => {
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
    const ctx = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
    await ctx.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await ctx.addInitScript(fetchStubSource());
    await ctx.addInitScript(sessionSeedSource(bundleSupabaseUrl(dist)));
    await ctx.addInitScript(() => {
      const base = window.fetch;
      const json = (value, status = 200) => Promise.resolve(new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }));
      window.__studio = { plans: [], saves: [], failSave: true, posts: [], reviewDrafts: [], failReviewSave: true };
      window.fetch = (input, opts = {}) => {
        const url = String(input), method = opts.method || 'GET', fixture = window.__studio;
        if (url.includes('/api/google-reviews/status')) return json({available:false,connected:false});
        if (url.includes('/api/content/review-draft')) {
          const body=JSON.parse(opts.body);fixture.reviewDrafts.push(body);
          if(fixture.failReviewSave)return json({error:'Could not save the review draft. Check Drafts before trying again.'},503);
          const post={id:'55555555-5555-4555-8555-555555555555',caption:`“${body.expected_text}”`,status:'draft',post_type:'testimonial',created_at:new Date().toISOString()};fixture.posts.push(post);return json({post},201);
        }
        if (url.includes('/api/content/plan-week')) {
          fixture.plans.push(JSON.parse(opts.body));
          fixture.posts = [1, 2, 3].map(i => ({id:`post-${i}`,caption:`Draft ${i} about Signature brows`,status:'draft',post_type:'general',created_at:new Date().toISOString()}));
          return json({ posts: fixture.posts });
        }
        if (/\/api\/content(?:\?|$)/.test(url)) return json({ posts: fixture.posts });
        if (url.includes('/api/content/streams')) return json({ streams: [] });
        if (url.includes('/api/instagram/status')) return json({ connected: true, token_valid: true });
        if (url.includes('/rest/v1/treatments')) return json([{ id:'t1',name:'Signature brows',is_active:true }]);
        if (url.includes('/rest/v1/reviews')) return json([
          {id:'r1',rating:5,comment:'A thoughtful visit and exactly the shape I hoped for.',is_public:true,created_at:'2026-09-20T12:00:00Z'},
          {id:'r2',rating:4,comment:'Private feedback must stay private.',is_public:false,created_at:'2026-09-21T12:00:00Z'},
        ]);
        if (url.includes('/rest/v1/beauticians') && method === 'PATCH') {
          const body = JSON.parse(opts.body); fixture.saves.push(body);
          return fixture.failSave ? json({message:'Synthetic save failure'},503) : json({id:'b1',...body});
        }
        return base(input, opts);
      };
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const route of ['more','voice','content','reviews']) {
      await page.goto(`http://127.0.0.1:${server.address().port}/${route}`);
      await page.locator(({more:'.more-shortcut-grid',voice:'.fl-command-stack',content:'.fl-content-studio',reviews:'.fl-google-review'})[route]).waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${route} overflows at ${width}`);
      assert.equal(await page.getByText('Something went wrong', {exact:true}).count(), 0);
      if (output) await page.screenshot({path:join(output,`${route}-${width}.png`),fullPage:route !== 'voice'});
      if (width !== 390) continue;
      if (route === 'more') {
        assert.equal(await page.locator('.more-category-toggle[aria-expanded=true]').count(), 0);
        await page.getByLabel('Search More tools').fill('google');
        await page.locator('.more-tool').filter({hasText:'Reviews & feedback'}).waitFor();
        await page.getByLabel('Clear search').click();
        await page.getByRole('button',{name:'Expand all',exact:true}).click();
        assert.equal(await page.locator('.more-tool:visible').count(),45);
        await page.getByRole('button',{name:'Collapse all',exact:true}).click();
      }
      if (route === 'voice') {
        await page.getByRole('button',{name:'More ways to ask',exact:true}).click();
        await page.getByRole('button',{name:'Clients',exact:true}).click();
        await page.getByRole('button',{name:/^Find a client/}).click();
        assert.equal(await page.getByLabel('Message Florrie').inputValue(),'Tell me about ');
        assert.ok(await page.locator('.fl-voice-emblem svg').count());
      }
      if (route === 'content') {
        await page.getByRole('button',{name:'Your posts',exact:true}).click();
        assert.equal((await page.evaluate(() => window.__studio.plans)).length, 0);
        await page.getByRole('button',{name:'Get ideas',exact:true}).click();
        await page.getByRole('button',{name:'Plan 3 posts',exact:true}).click();
        await page.getByRole('button',{name:/^Help clients choose/}).click();
        await page.getByLabel('Plan treatment').selectOption('t1');
        await page.getByRole('button',{name:'Start with one post',exact:true}).click();
        await page.locator('summary').filter({hasText:'Help me write'}).click();
        assert.equal(await page.getByLabel('Caption treatment').inputValue(),'Signature brows');
        assert.match(await page.getByLabel('Caption brief').inputValue(),/missing treatment facts/);
        await page.getByRole('button',{name:'Cancel',exact:true}).click();
        await page.getByRole('button',{name:'Get ideas',exact:true}).click();
        await page.getByRole('button',{name:'Plan 3 posts',exact:true}).click();
        await page.getByRole('button',{name:/^Build trust/}).click();
        await page.getByLabel('Plan treatment').selectOption('t1');
        await page.getByRole('button',{name:'Draft this plan',exact:true}).click();
        await page.locator('[data-content-post="post-1"] .fl-content-draft-summary').getByText('Draft 1 about Signature brows',{exact:true}).waitFor();
        assert.deepEqual(await page.evaluate(() => window.__studio.plans),[{goal:'trust',treatment_id:'t1',post_count:3}]);
      }
      if (route === 'reviews') {
        const field = page.getByLabel('Google review link',{exact:true});
        await field.fill('https://example.com/not-google');
        await page.getByRole('button',{name:'Save review link',exact:true}).click();
        assert.equal((await page.evaluate(() => window.__studio.saves)).length,0);
        await field.fill('https://g.page/r/demo-salon/review');
        await page.getByRole('button',{name:'Save review link',exact:true}).click();
        await page.getByRole('alert').filter({hasText:'Could not confirm the save'}).waitFor();
        assert.equal(await field.inputValue(),'https://g.page/r/demo-salon/review');
        await page.evaluate(() => window.__studio.failSave = false);
        await page.getByRole('button',{name:'Save review link',exact:true}).click();
        await page.getByText('Review link saved',{exact:true}).waitFor();
        assert.equal(await page.getByRole('link',{name:'Check your link ↗',exact:true}).getAttribute('href'),'https://g.page/r/demo-salon/review');
        assert.equal(await page.getByRole('button',{name:'Turn into a post',exact:true}).count(),1);
        await page.getByRole('button',{name:'Turn into a post',exact:true}).click();
        assert.ok(await page.getByRole('button',{name:'Prepare a review post',exact:true}).isDisabled());
        await page.getByRole('checkbox',{name:'I have permission to use this review in my marketing.'}).check();
        await page.getByRole('button',{name:'Prepare a review post',exact:true}).click();
        await page.getByRole('alert').filter({hasText:'Could not save the review draft'}).waitFor();
        assert.ok(await page.getByRole('checkbox',{name:'I have permission to use this review in my marketing.'}).isChecked());
        await page.evaluate(()=>window.__studio.failReviewSave=false);
        await page.getByRole('button',{name:'Prepare a review post',exact:true}).click();
        await page.getByLabel('Draft caption',{exact:true}).waitFor();
        assert.equal(await page.getByLabel('Draft caption',{exact:true}).inputValue(),'“A thoughtful visit and exactly the shape I hoped for.”','the permitted review opens in the editable draft');
        assert.equal((await page.evaluate(()=>window.__studio.reviewDrafts))[1].marketing_permission,true);
      }
      console.log(`✓ ${route} ${width}px: layout and workflow`);
    }
    assert.deepEqual(errors,[]);
    await ctx.close();
  }
} finally { await browser.close(); server.close(); }
