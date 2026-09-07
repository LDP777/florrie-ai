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
  const ctx = await browser.newContext({viewport:{width:390,height:844}});
  await ctx.addInitScript(fetchStubSource());
  await ctx.addInitScript(sessionSeedSource(bundleSupabaseUrl(dist)));
  await ctx.addInitScript(() => {
    const base = window.fetch;
    window.__draftTest = {fail:true, caption:'Original caption', writes:[]};
    window.fetch = (input,opts={}) => {
      const url=String(input), method=opts.method||'GET';
      const json=(data,status=200)=>Promise.resolve(new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}}));
      if (/\/api\/content(?:\?|$)/.test(url)) return json({posts:[{id:'draft1',status:'draft',post_type:'general',caption:window.__draftTest.caption,created_at:'2026-09-07'}]});
      if(url.includes('/rest/v1/content_posts?') && ['PATCH','DELETE'].includes(method)) {
        window.__draftTest.writes.push(method);
        if(window.__draftTest.fail) return json({message:'Synthetic write refused'},500);
        if(method==='PATCH') { window.__draftTest.caption=JSON.parse(opts.body).caption;return json({id:'draft1',caption:window.__draftTest.caption}); }
        return Promise.resolve(new Response(null,{status:204}));
      }
      if(url.includes('/api/features/waitlist')) {
        const entry={id:'w1',client_id:'c1',status:'waiting',priority:'regular',created_at:'2026-09-06',clients:{first_name:'Waitlist',last_name:'Fixture'},treatments:{name:'Brows'}};
        if(method==='PATCH') {window.__draftTest.writes.push('offer');return json({waitlistEntry:{...entry,...JSON.parse(opts.body)}});}
        if(method==='POST') throw new Error('Unexpected message send');
        return json({waitlist:[entry]});
      }
      return base(input,opts);
    };
  });
  const page=await ctx.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/content`);
  await page.getByRole('button',{name:/Drafts/}).click();
  await page.getByRole('button',{name:'Edit',exact:true}).click();
  await page.getByRole('textbox',{name:'Draft caption'}).fill('Keep my revised caption');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Could not save this caption.'}).waitFor();
  assert.equal(await page.getByRole('textbox',{name:'Draft caption'}).inputValue(),'Keep my revised caption');
  await page.evaluate(()=>{window.__draftTest.fail=false;});
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Keep my revised caption',{exact:true}).waitFor();
  await page.evaluate(()=>{window.__draftTest.fail=true;});
  await page.getByRole('button',{name:'Discard',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Could not discard this draft.'}).waitFor();
  assert.ok(await page.getByText('Keep my revised caption',{exact:true}).count() > 0);
  await page.evaluate(()=>{window.__draftTest.fail=false;});
  await page.getByRole('button',{name:'Discard',exact:true}).click();
  await page.getByRole('button',{name:'Discard',exact:true}).waitFor({state:'hidden'});
  console.log('✓ Content: failed edit preserves caption; failed discard preserves draft; retries succeed');
  await page.goto(`http://127.0.0.1:${server.address().port}/waitlist`);
  await page.getByText('Waitlist Fixture',{exact:true}).click();
  await page.getByText(/It does not send a message or reserve an appointment/).waitFor();
  await page.getByRole('button',{name:'Record offer made',exact:true}).click();
  await page.getByText('Offer recorded',{exact:true}).first().waitFor();
  assert.deepEqual(await page.evaluate(()=>window.__draftTest.writes),['offer']);
  console.log('✓ Waitlist: recording an existing offer is labelled and does not call Notify');
  await ctx.close();
} finally { await browser.close(); server.close(); }
