// Fictional records only. No card charges, messages or live account writes.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import http from 'node:http';
import { launch } from './lib/browser.mjs';
import { fetchStubSource, sessionSeedSource, bundleSupabaseUrl } from './lib/fixtures.mjs';
import { appointmentMoneyReport } from '../../backend/src/lib/appointment-money.js';
const dist = new URL('../dist', import.meta.url).pathname;
const output = process.env.VISUAL_OUTPUT_DIR;
if (output) mkdirSync(output, { recursive: true });
const server = http.createServer((req, res) => {
  let file = join(dist, (req.url || '/').split('?')[0]);
  if (!existsSync(file) || !extname(file)) file = join(dist, 'index.html');
  res.setHeader('content-type', ({'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'})[extname(file)] || 'text/html');
  try { res.end(readFileSync(file)); } catch { res.statusCode = 404; res.end(); }
}).listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const browser = await launch();
try {
  const context = await browser.newContext({ viewport: { width:390, height:844 }, reducedMotion:'reduce' });
  await context.route('**/*',route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await context.addInitScript(fetchStubSource());
  await context.addInitScript(sessionSeedSource(bundleSupabaseUrl(dist)));
  await context.addInitScript(diary => {
    const base=window.fetch;
    const rows=[
      { id:'00000000-0000-4000-8000-000000000004',beautician_id:'b1',appointment_id:'a1',type:'payment',status:'completed',payment_method:null,amount_cents:2400,created_at:'2026-11-18T11:00:00Z',appointments:{starts_at:'2026-11-18T10:00:00Z',clients:{first_name:'Fictional',last_name:'Client'},treatments:{name:'Brows'}} },
      { id:'deposit',beautician_id:'b1',type:'deposit',status:'completed',payment_method:'card_online',stripe_payment_intent_id:'pi_one',amount_cents:600,created_at:'2026-11-18T09:00:00Z',appointments:{clients:{first_name:'Fictional',last_name:'Client'}} },
      { id:'failed',type:'payment',status:'failed',amount_cents:1000,created_at:'2026-11-17T10:00:00Z' },
      { id:'duplicate',type:'deposit',status:'completed',payment_method:'card_online',stripe_payment_intent_id:'pi_one',amount_cents:600,created_at:'2026-11-18T10:00:00Z' },
    ];
    window.receiptFixture={rows,writes:[],fail:false,lose:false,confirmed:null};
    window.fetch=async(input,options={})=>{
      const u=new URL(String(input),location.origin),s=window.receiptFixture;
      const json=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json',...headers}});
      if(options.method && !['GET','HEAD'].includes(options.method))s.writes.push({path:u.pathname,method:options.method,body:options.body});
      if(u.pathname.endsWith('/transactions'))return json(rows,200,{'content-range':`0-${rows.length-1}/${rows.length}`});
      if(u.pathname.endsWith('/expenses'))return json([],200,{'content-range':'*/0'});
      if(u.pathname.includes('/api/money/receipts/')){
        const data=JSON.parse(options.body);
        if(s.fail)return json({error:'This booking has changed. Refresh and check it.'},409);
        if(s.confirmed && JSON.stringify(s.confirmed)!==JSON.stringify(data))return json({error:'Already recorded.'},409);
        s.confirmed=data;
        Object.assign(rows[0],{payment_method:data.payment_method,created_at:data.received_on+'T12:00:00Z'});
        await new Promise(resolve=>setTimeout(resolve,150));
        if(s.lose){s.lose=false;return json({error:'Save not confirmed. Check your records.'},503);}
        return json({transaction:rows[0]});
      }
      if(u.pathname==='/api/money/reports')return json({appointments:diary,revenue:{this_month_cents:s.confirmed?3000:600,change_pct:null},rebooking_rate:{pct:null},no_show_rate:{pct:null}});
      return base(input,options);
    };
  }, appointmentMoneyReport([{ id:'a1',starts_at:'2026-11-18T10:00:00Z',status:'completed',price_cents:3000 }], { now: new Date('2026-11-18T21:00:00Z') }));
  const page=await context.newPage();
  page.setDefaultTimeout(15000);
  await page.clock.setFixedTime(new Date('2026-11-18T21:00:00Z'));
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const url=`http://127.0.0.1:${server.address().port}`;
  await page.goto(url+'/money?tab=income');
  await page.getByRole('heading',{name:'Received',exact:true}).waitFor();
  assert.equal(await page.getByRole('navigation',{name:'More section'}).count(),0);
  assert.equal(await page.locator('.money-payment-row').count(),1,'Received excludes unknown, failed and duplicate entries');
  assert.equal(await page.getByText('Recorded receipts today',{exact:true}).count(),0);
  for(const width of [320,390,1024]){
    await page.setViewportSize({width,height:844});
    const title=await page.getByRole('heading',{name:'Money',exact:true}).boundingBox();
    const eye=await page.getByRole('button',{name:'Hide client details',exact:true}).boundingBox();
    const toolbar=await page.locator('.money-income-toolbar').boundingBox();
    assert.ok(title.y<eye.y+eye.height && title.x+title.width<eye.x,'Title uses the controls row without overlap');
    assert.ok(toolbar.y<160,'Income starts near the top of the viewport');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    if(output)await page.screenshot({path:join(output,`income-${width}.png`)});
  }
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'Record cash & bank payments'}).click();
  await page.getByRole('button',{name:'Record payment',exact:true}).click();
  const form=page.getByRole('form',{name:'Record a payment'});
  assert.equal(await form.getByRole('button',{name:'Record receipt',exact:true}).isDisabled(),true);
  await form.getByLabel('Paid by',{exact:true}).selectOption('cash');
  await form.getByLabel('Received on',{exact:true}).fill('2026-11-18');
  if(output)await page.screenshot({path:join(output,'record-receipt.png')});
  await page.getByRole('button',{name:'Hide client details',exact:true}).click();
  assert.equal(await form.count(),0);assert.doesNotMatch(await page.locator('.money-payments').innerText(),/Fictional|£24/);
  assert.match(await page.locator('.money-payments').innerText(),/Receipt not recorded/);
  assert.equal((await page.evaluate(()=>receiptFixture.writes)).length,0);
  await page.getByRole('button',{name:'Hide client details',exact:true}).click();
  assert.equal(await form.getByLabel('Paid by').inputValue(),'cash','Privacy preserves the unfinished form');
  await page.evaluate(()=>receiptFixture.fail=true);
  await form.getByRole('button',{name:'Record receipt',exact:true}).click();
  await form.getByRole('alert').waitFor();
  assert.equal(await form.getByLabel('Received on').inputValue(),'2026-11-18');
  await page.evaluate(()=>{receiptFixture.fail=false;receiptFixture.lose=true;});
  await form.getByRole('button',{name:'Record receipt',exact:true}).evaluate(b=>{b.click();b.click();});
  await form.getByRole('alert').filter({hasText:'Save not confirmed'}).waitFor();
  assert.equal((await page.evaluate(()=>receiptFixture.writes)).length,2,'Double click sends one request');
  await form.getByRole('button',{name:'Record receipt',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Receipt recorded'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Record payment',exact:true}).count(),0);
  await page.getByLabel('Income records').selectOption('received');
  assert.equal(await page.locator('.money-payment-row').count(),2);
  await page.getByRole('button',{name:'Pulse',exact:true}).click();
  await page.getByRole('button',{name:'View recorded payments',exact:true}).getByText('£30.00',{exact:true}).waitFor();
  await page.getByRole('heading',{name:'£30.00',exact:true}).waitFor();
  await page.getByText('Trends & breakdowns',{exact:true}).click();
  await page.getByText('Your numbers',{exact:true}).locator('..').getByText('£30.00',{exact:true}).waitFor();
  await page.getByText('Trends & breakdowns',{exact:true}).click();
  await page.getByRole('button',{name:'Pulse',exact:true}).getAttribute('aria-pressed').then(value=>assert.equal(value,'true'));
  await page.waitForTimeout(250);
  if(output)await page.screenshot({path:join(output,'pulse-390.png')});
  await page.getByRole('button',{name:'Tax',exact:true}).click();
  await page.getByRole('region',{name:'Tax year figures'}).getByText('£30.00',{exact:true}).first().waitFor();
  await page.goto(url+'/content');
  await page.getByRole('heading',{name:'Your content.',exact:true}).waitFor();
  for(const width of [320,390,1024]){
    await page.setViewportSize({width,height:844});
    const h=await page.getByRole('heading',{name:'Your content.',exact:true}).boundingBox(),eye=await page.getByRole('button',{name:'Hide client details',exact:true}).boundingBox();
    assert.ok(h.y<eye.y+eye.height && h.x+h.width<eye.x+1,'Content heading fits beside controls');
    assert.equal(await page.getByRole('navigation',{name:'More section'}).count(),0);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    if(output)await page.screenshot({path:join(output,`content-${width}.png`)});
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: compact Money/Content headers at 320/390/1024; received-only default; offline receipt method/date; privacy; conflict, double tap and lost-response retry; live Pulse/Tax totals. All writes intercepted.');
} finally { await browser.close();server.close(); }
