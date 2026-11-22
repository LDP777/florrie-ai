// Actual built app, fictional salon and intercepted writes. No live booking changes.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import http from 'node:http';
import { launch } from './lib/browser.mjs';
import { bundleSupabaseUrl } from './lib/fixtures.mjs';
import { calendarFixtureSource } from './lib/calendar-fixtures.mjs';
const dist = new URL('../dist/', import.meta.url).pathname;
const output = process.env.HOURS_SCREENSHOT_DIR;
if (output) mkdirSync(output, { recursive: true });
const server = http.createServer((req, res) => {
  let file = join(dist, (req.url || '/').split('?')[0]);
  if (!existsSync(file) || !extname(file)) file = join(dist, 'index.html');
  res.setHeader('content-type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' })[extname(file)] || 'application/octet-stream');
  try { res.end(readFileSync(file)); } catch { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`, browser = await launch();
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Europe/London', reducedMotion: 'reduce' });
  await context.addInitScript(calendarFixtureSource(bundleSupabaseUrl(dist), 'populated') + `
  (() => {
    const base = window.fetch, json = (body,status=200) => new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
    const weekly=Object.fromEntries(['mon','tue','wed','thu','fri'].map(day=>[day,{start:'09:00',end:'17:00'}]));
    window.hoursFixture={rows:JSON.parse(localStorage.getItem('hours-test-rows')||'[]'),failSave:true,failRead:false,writes:[],unexpected:[],weekly,blocks:[{id:'break',beautician_id:'b1',date:'2026-08-10',type:'amended',start_time:'17:00',end_time:'18:00',reason:'personal',note:'Private test note'}]};
    window.fetch=async(input,options={})=>{
      const u=new URL(typeof input==='string'?input:input.url,location.href),s=hoursFixture,method=options.method||'GET';
      if(u.pathname==='/api/working-hours'&&method==='GET')return s.failRead?json({error:'Synthetic unavailable hours'},503):json({dates:s.rows.filter(row=>row.date>=u.searchParams.get('from')&&row.date<=u.searchParams.get('to'))});
      if(u.pathname==='/api/working-hours/dates'&&method==='PUT'){
        const body=JSON.parse(options.body);s.writes.push(body);
        if(s.failSave)return json({error:'Could not save these hours. Please try again.'},503);
        const rows=body.dates.map(date=>({date,start_time:body.start_time,end_time:body.end_time}));
        s.rows=[...s.rows.filter(row=>!body.dates.includes(row.date)),...rows];localStorage.setItem('hours-test-rows',JSON.stringify(s.rows));return json({dates:rows});
      }
      if(u.pathname.startsWith('/api/working-hours/dates/')&&method==='DELETE'){
        const date=u.pathname.split('/').at(-1);s.rows=s.rows.filter(row=>row.date!==date);localStorage.setItem('hours-test-rows',JSON.stringify(s.rows));return json({restored:date});
      }
      if(u.pathname==='/api/hours-exceptions')return json({exceptions:s.blocks});
      if(u.pathname==='/rest/v1/hours_exceptions'){
        if(method==='PATCH'){const body=JSON.parse(options.body);s.writes.push(body);const row=s.blocks.find(row=>'eq.'+row.id===u.searchParams.get('id'));Object.assign(row,body);return json(row);}
        if(method==='DELETE'){const rows=s.blocks.filter(row=>'eq.'+row.id===u.searchParams.get('id'));s.blocks=s.blocks.filter(row=>!rows.includes(row));return json(rows.map(row=>({id:row.id})));}
        return json(s.blocks);
      }
      if(u.pathname==='/rest/v1/beauticians'){
        if(method==='PATCH'){const body=JSON.parse(options.body);s.writes.push(body);Object.assign(s.weekly,body.working_hours);}
        const response=await base(input,options);const profile=await response.json();return json({...profile,working_hours:s.weekly});
      }
      if(u.pathname==='/api/booking/ellindigo/page'){
        const response=await base(input,options),body=await response.json();return json({...body,salon:{...body.salon,working_hours:s.weekly}});
      }
      if(u.pathname==='/api/booking/ellindigo/availability-range')return json({appointments:[],closures:[],blocks:[],date_hours:s.rows});
      if(u.pathname==='/api/booking/ellindigo/availability'){
        const date=u.searchParams.get('date'),row=s.rows.find(row=>row.date===date);
        const key=['sun','mon','tue','wed','thu','fri','sat'][new Date(date+'T12:00:00Z').getUTCDay()];
        return json({appointments:[],blocks:s.blocks.filter(b=>b.date===date),closed:false,hours:row?{start:row.start_time,end:row.end_time}:s.weekly[key]||null});
      }
      if(!['GET','HEAD','OPTIONS'].includes(method)){s.unexpected.push({path:u.pathname,method});return json({error:'Unexpected write blocked'},409);}
      return base(input,options);
    };
  })();`);
  await context.route('**/*', route => route.request().url().startsWith(origin) || route.request().url().startsWith('data:') ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  const snap = async name => { if (output) await page.screenshot({ path: join(output, `${name}.png`) }); };
  const label = date => new Date(`${date}T12:00:00`).toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'});
  await page.goto(origin + '/settings?section=hours');
  await page.getByRole('tab',{name:'Specific dates'}).click();
  await page.getByRole('heading',{name:'Your hours',exact:true}).waitFor();
  const sunday=page.getByRole('button',{name:label('2026-08-09'),exact:true}); await sunday.waitFor();
  await page.waitForFunction(()=>!document.querySelector('.hours-day:not(:disabled)')?.disabled);
  await sunday.click(); await page.getByRole('button',{name:label('2026-08-10'),exact:true}).click();
  await snap('selected-dates'); await page.getByRole('button',{name:'Set hours',exact:true}).click();
  let sheet=page.getByRole('dialog',{name:'Hours for these days'}); await sheet.waitFor();
  await sheet.getByLabel('Finish time').fill('20:00');
  await sheet.getByText('Your personal blocks still apply within these hours.',{exact:false}).waitFor();
  await snap('date-hours-sheet');
  await sheet.getByRole('button',{name:'Save hours for 2 days'}).click();
  await sheet.getByRole('alert').waitFor(); assert.equal(await sheet.getByLabel('Finish time').inputValue(),'20:00');
  assert.equal(await page.evaluate(()=>hoursFixture.rows.length),0);
  await page.evaluate(()=>{hoursFixture.failSave=false;});
  await sheet.getByRole('button',{name:'Save hours for 2 days'}).click(); await sheet.waitFor({state:'hidden'});
  assert.deepEqual(await page.evaluate(()=>hoursFixture.rows.map(row=>row.date)),['2026-08-09','2026-08-10']);
  await page.getByText('Hours saved for 2 days.',{exact:true}).waitFor(); await snap('hours-saved');
  await page.getByRole('tab',{name:'Usual week'}).click();
  const mondayFinish=page.getByLabel('Monday finish');await mondayFinish.fill('18:00');
  assert.equal(await page.evaluate(()=>hoursFixture.writes.filter(row=>row.working_hours).length),0,'typing does not autosave half-edited hours');
  await page.getByRole('tab',{name:'Specific dates'}).click();await page.getByRole('tab',{name:'Usual week'}).click();
  assert.equal(await mondayFinish.inputValue(),'18:00','switching sections preserves the unsaved week');
  await page.getByRole('button',{name:'Save usual hours'}).click(); await page.getByText('Usual hours saved.',{exact:true}).waitFor();
  await snap('usual-week');
  for(const width of [320,390,430]){await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`No horizontal overflow at ${width}`);}
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('tab',{name:'Time off'}).click();
  await page.getByRole('button',{name:'2026-08-10',exact:true}).click();
  assert.equal(await page.getByLabel('Private note',{exact:true}).inputValue(),'Private test note');
  await page.getByLabel('Until',{exact:true}).fill('18:30');await page.getByLabel('Private note',{exact:true}).fill('School pickup');
  await snap('time-off-edit');
  await page.getByRole('button',{name:'Save blocked time',exact:true}).click();
  await page.getByText('School pickup',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>hoursFixture.blocks.length),1,'editing does not create duplicate blocks');
  assert.equal(await page.evaluate(()=>hoursFixture.blocks[0].end_time),'18:30');
  assert.equal(await page.evaluate(()=>hoursFixture.blocks[0].is_closed),false);
  for(const width of [320,390]){await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`Time off fits ${width}`);}
  await page.getByRole('button',{name:'Edit block Mon 10 Aug',exact:true}).click();
  await page.getByRole('button',{name:'Hide client details',exact:true}).click();
  assert.equal(await page.getByLabel('Private note',{exact:true}).count(),0,'privacy removes note inputs from the page');
  assert.equal(await page.getByText('School pickup',{exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Edit block Mon 10 Aug',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Hide client details',exact:true}).click();
  await page.goto(origin+'/calendar/week?date=2026-08-09&view=day');
  const hours=page.getByRole('button',{name:/Hours for this day · 09:00–20:00/});await hours.waitFor(); await snap('calendar-hours-shortcut');
  await hours.click();sheet=page.getByRole('dialog',{name:'Hours for this day'}); await sheet.waitFor();
  await sheet.getByRole('button',{name:'Use usual hours · closed'}).click();await sheet.waitFor({state:'hidden'});
  await page.getByRole('button',{name:/Hours for this day · Closed/}).waitFor();
  assert.deepEqual(await page.evaluate(()=>hoursFixture.rows.map(row=>row.date)),['2026-08-10']);
  await page.evaluate(()=>{hoursFixture.failRead=true;});
  await page.getByRole('button',{name:/Hours for this day · Closed/}).click();sheet=page.getByRole('dialog',{name:'Hours for this day'}); await sheet.getByRole('alert').waitFor();
  assert.equal(await sheet.getByRole('button',{name:'Save hours',exact:true}).isDisabled(),true,'failed read cannot save defaults');
  await page.keyboard.press('Escape');await sheet.waitFor({state:'hidden'});
  await page.evaluate(()=>{hoursFixture.failRead=false;localStorage.setItem('hours-test-rows',JSON.stringify([{date:'2026-08-09',start_time:'05:00',end_time:'23:30'}]));});
  await page.reload();await page.getByRole('button',{name:/Hours for this day · 05:00–23:30/}).waitFor();
  await page.locator('.calendar-timeline').getByText('05:00',{exact:true}).waitFor();
  await page.locator('.calendar-timeline').getByText('24:00',{exact:true}).waitFor();
  await page.evaluate(()=>localStorage.setItem('hours-test-rows',JSON.stringify([{date:'2026-08-09',start_time:'09:00',end_time:'20:00'},{date:'2026-08-10',start_time:'09:00',end_time:'20:00'}])));
  await page.goto(origin+'/book/ellindigo');
  await page.getByRole('button',{name:/Signature brows/}).click();
  await page.getByRole('button',{name:'Continue to date & time',exact:true}).click();
  await page.getByRole('button',{name:'9',exact:true}).click();
  await page.getByRole('button',{name:'19:30',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'20:00',exact:true}).count(),0,'treatment cannot finish after closing');
  assert.equal(await page.getByRole('button',{name:'16',exact:true}).isDisabled(),true,'the following Sunday stays closed');
  await page.getByRole('button',{name:'10',exact:true}).click();
  await page.getByRole('button',{name:'17:30',exact:true}).waitFor({state:'hidden'});
  await page.getByRole('button',{name:'19:30',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'17:30',exact:true}).count(),0,'personal break remains unavailable to clients');
  await snap('client-extra-hours');
  assert.deepEqual(await page.evaluate(()=>hoursFixture.unexpected),[]);
  assert.deepEqual(errors,[]);
  console.log('Passed: multiple dates, closed-day opening, save failure/retry, personal block editing, explicit weekly save, persistent hours, calendar shortcut, restore, early/late calendar bounds, client date and slot picker, unread-hours guard, 320/390/430px layout.');
} finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
