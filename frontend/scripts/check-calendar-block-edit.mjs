// Actual built calendar, fictional appointments, blocked provider traffic.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import http from 'node:http';
import { launch } from './lib/browser.mjs';
import { bundleSupabaseUrl } from './lib/fixtures.mjs';
import { calendarFixtureSource } from './lib/calendar-fixtures.mjs';
const dist = new URL('../dist/', import.meta.url).pathname;
const output = process.env.CALENDAR_SCREENSHOT_DIR;
if (output) mkdirSync(output, { recursive: true });
const server = http.createServer((req, res) => {
  let file = join(dist, (req.url || '/').split('?')[0]);
  if (!existsSync(file) || !extname(file)) file = join(dist, 'index.html');
  res.setHeader('content-type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' })[extname(file)] || 'application/octet-stream');
  try { res.end(readFileSync(file)); } catch { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await launch();
const errors = [], checks = [];
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'UTC', reducedMotion: 'reduce' });
  await context.addInitScript(calendarFixtureSource(bundleSupabaseUrl(dist), 'overlap').replaceAll("'2026-08-08T09:00:00Z'", "'2026-08-08T14:15:00Z'") + `
  (()=>{
    const base=window.fetch,json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
    const appt=(id,date,time,end,status='confirmed')=>({id,client_id:'c1',beautician_id:'b1',treatment_id:'t4',starts_at:date+'T'+time+':00Z',ends_at:date+'T'+end+':00Z',duration_minutes:60,status,price_cents:4500,clients:{first_name:'Priya',last_name:'Secretson'},treatments:{id:'t4',name:'Lash lift & tint',duration_minutes:60,price_cents:4500}});
    window.calendarEditFixture={reads:0,requests:[],unexpectedWrites:[],failSave:true,failDelete:true,
      appointments:[appt('a2','2026-08-08','11:00','12:00'),appt('overlap','2026-08-08','11:30','12:30'),appt('later','2026-08-08','14:30','15:30'),appt('tomorrow','2026-08-09','16:00','17:00'),appt('cancelled','2026-08-09','08:00','09:00','cancelled')],
      blocks:[{id:'private-block',beautician_id:'b1',date:'2026-08-08',end_date:null,type:'amended',is_closed:false,start_time:'11:30:00',end_time:'12:30:00',reason:'personal',note:'SENSITIVE-NOTE school pickup'}]};
    window.fetch=async(input,options={})=>{
      const u=new URL(typeof input==='string'?input:input.url,location.href),s=calendarEditFixture,m=options.method||'GET';
      if(m!=='GET'&&m!=='HEAD'&&m!=='OPTIONS'){
        const request={path:u.pathname,method:m,body:options.body?JSON.parse(options.body):null};s.requests.push(request);
        if(u.pathname==='/api/hours-exceptions/private-block'&&m==='PATCH'){
          if(s.failSave)return json({error:'Synthetic edit failure'},500);
          const block=s.blocks.find(b=>b.id==='private-block');Object.assign(block,request.body,{is_closed:request.body.type==='closed'});return json({exception:block});
        }
        if(u.pathname==='/api/hours-exceptions/private-block'&&m==='DELETE'){
          if(s.failDelete)return json({error:'Synthetic removal failure'},500);s.blocks=[];return json({success:true});
        }
        s.unexpectedWrites.push(request);return json({error:'Unexpected write blocked'},409);
      }
      if(u.pathname==='/api/hours-exceptions')return json({exceptions:s.blocks});
      if(u.pathname==='/rest/v1/appointments'){
        if((u.searchParams.get('select')||'').includes('clients('))s.reads++;
        const bounds=u.searchParams.getAll('starts_at');return json(s.appointments.filter(a=>bounds.every(b=>b.startsWith('gte.')?a.starts_at>=b.slice(4):b.startsWith('lte.')?a.starts_at<=b.slice(4):true)));
      }
      return base(input,options);
    };
  })();`);
  await context.route('**/*', route => route.request().url().startsWith(origin) || route.request().url().startsWith('data:') ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  const ready = async () => { await page.locator('.calendar-timeline').waitFor(); await page.waitForFunction(() => !document.querySelector('.calendar-day-summary')?.textContent.includes('Loading')); };
  const snap = async name => { if (output) await page.screenshot({ path: join(output, name + '.png') }); };
  const pass = name => { checks.push(name); console.log('✓ ' + name); };
  const scroll = () => page.locator('.calendar-timeline').evaluate(el => el.scrollTop);
  const view = name => page.getByRole('group', { name: 'Calendar view', exact: true }).getByRole('button', { name, exact: true });
  await page.goto(origin + '/calendar/week?date=2026-08-08&view=day'); await ready();
  await page.waitForFunction(() => Math.abs(document.querySelector('.calendar-timeline').scrollTop - 900) < 2);
  assert.ok(Math.abs(await scroll() - 900) < 2, 'Today opens at 14:15 rather than the first 11:00 appointment');
  await page.locator('.calendar-timeline').evaluate(el => { el.scrollTop = 200; });
  const before = await page.evaluate(() => calendarEditFixture.reads);
  await page.evaluate(() => { history.pushState({}, '', location.href + '&refresh=1'); dispatchEvent(new PopStateEvent('popstate')); });
  await page.waitForFunction(previous => calendarEditFixture.reads > previous && !document.querySelector('.calendar-day-summary')?.textContent.includes('Loading'), before);
  assert.equal(await scroll(), 200, 'A data refresh preserves manual timeline scroll');
  await view('Day').click(); await ready();
  await page.waitForFunction(() => Math.abs(document.querySelector('.calendar-timeline').scrollTop - 900) < 2);
  await page.getByRole('button', { name: /^Sunday 9 August,/ }).click(); await ready();
  await page.waitForFunction(() => Math.abs(document.querySelector('.calendar-timeline').scrollTop - 1096) < 2);
  assert.ok(Math.abs(await scroll() - 1096) < 2, 'Another day opens at its first live booking, ignoring a cancelled morning slot');
  await page.locator('.calendar-date-actions').getByRole('button', { name: 'Today', exact: true }).click(); await ready();
  await page.waitForFunction(() => Math.abs(document.querySelector('.calendar-timeline').scrollTop - 900) < 2);
  pass('Day and Today focus the useful time; other dates find their first booking; refresh preserves manual scroll');

  const booking = page.getByRole('button', { name: 'Priya Secretson, 11:00, Lash lift & tint, Booked', exact: true });
  await booking.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
  const bookingHit=await booking.evaluate(el => { const r = el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2); return {receivesPointer:el.contains(hit),rect:r.toJSON(),hit:hit?.outerHTML.slice(0,400)}; });
  await snap('calendar-overlap-hit');
  assert.equal(bookingHit.receivesPointer, true, 'Overlapping block does not steal booking taps: '+JSON.stringify(bookingHit));
  await booking.click(); const details = page.getByRole('dialog', { name: 'Booking details', exact: true }); await details.waitFor(); await page.keyboard.press('Escape'); await details.waitFor({ state: 'hidden' });
  const blockRow = page.locator('.calendar-time-block'); await blockRow.scrollIntoViewIfNeeded();
  assert.ok((await blockRow.boundingBox()).height >= 44);
  await snap('calendar-personal-block-row');
  await blockRow.click(); const block = page.getByRole('dialog', { name: 'Time block', exact: true });
  await block.getByText('SENSITIVE-NOTE school pickup', { exact: true }).waitFor();
  await block.getByRole('button', { name: 'Edit blocked time', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit blocked time', exact: true }); await editor.waitFor();
  assert.equal(await editor.getByLabel('From', { exact: true }).inputValue(), '11:30');
  assert.equal(await editor.getByLabel('Note (optional)', { exact: true }).inputValue(), 'SENSITIVE-NOTE school pickup');
  await editor.getByLabel('To', { exact: true }).fill('10:00'); await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
  await editor.getByRole('alert').waitFor(); assert.equal(await page.evaluate(() => calendarEditFixture.requests.length), 0);
  await editor.getByLabel('Date', { exact: true }).fill('2026-08-09');
  await editor.getByLabel('End date (optional)', { exact: true }).fill('2026-08-10');
  await editor.getByLabel('From', { exact: true }).fill('13:00'); await editor.getByLabel('To', { exact: true }).fill('14:00');
  await editor.getByRole('button', { name: 'Training', exact: true }).click();
  await editor.getByLabel('Note (optional)', { exact: true }).fill('SENSITIVE-NOTE training\nBring the kit');
  await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
  await editor.getByRole('alert').filter({ hasText: 'Synthetic edit failure' }).waitFor();
  assert.equal(await editor.getByLabel('Note (optional)', { exact: true }).inputValue(), 'SENSITIVE-NOTE training\nBring the kit');
  assert.equal(await page.evaluate(() => calendarEditFixture.blocks[0].date), '2026-08-08');
  await snap('calendar-personal-block-edit');
  await page.evaluate(() => { calendarEditFixture.failSave = false; });
  await editor.getByRole('button', { name: 'Save changes', exact: true }).click(); await block.waitFor();
  await block.getByText('SENSITIVE-NOTE training\nBring the kit', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => calendarEditFixture.requests.at(-1).body), { date: '2026-08-09', end_date: '2026-08-10', type: 'amended', reason: 'training', note: 'SENSITIVE-NOTE training\nBring the kit', start_time: '13:00', end_time: '14:00' });
  assert.equal(await page.evaluate(() => calendarEditFixture.appointments.length), 5);
  pass('Overlapping bookings and blocks both open; editing validates, retains failed edits, saves exact fields without touching bookings');
  await block.getByRole('button', { name: 'Close time block', exact: true }).click();
  assert.equal(await page.locator('.calendar-time-block').count(), 0, 'Moved block leaves its old day');
  await page.getByRole('button', { name: /^Sunday 9 August,/ }).click(); await ready(); await blockRow.waitFor();
  await blockRow.click(); await block.getByRole('button', { name: 'Remove this block', exact: true }).click();
  await block.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.evaluate(() => calendarEditFixture.requests.filter(r => r.method === 'DELETE').length), 0);
  await block.getByRole('button', { name: 'Remove this block', exact: true }).click(); await block.getByRole('button', { name: 'Remove', exact: true }).click();
  await block.getByRole('alert').filter({ hasText: 'Synthetic removal failure' }).waitFor(); assert.equal(await page.evaluate(() => calendarEditFixture.blocks.length), 1);
  await page.evaluate(() => { calendarEditFixture.failDelete = false; }); await block.getByRole('button', { name: 'Remove', exact: true }).click();
  await block.waitFor({ state: 'hidden' }); assert.equal(await page.locator('.calendar-time-block').count(), 0);
  assert.deepEqual(await page.evaluate(() => calendarEditFixture.unexpectedWrites), []);
  pass('Removal needs confirmation, Cancel performs no write, and failed removal retains the block until retry succeeds');

  await page.goto(origin + '/calendar/week?date=2026-08-08&view=day'); await ready();
  const eye = page.getByRole('button', { name: 'Hide client details', exact: true }); await eye.click(); await blockRow.click();
  await block.waitFor(); assert.equal(await block.getByRole('button', { name: 'Edit blocked time', exact: true }).isDisabled(), true);
  assert.equal(await block.getByRole('button', { name: 'Remove this block', exact: true }).isDisabled(), true);
  assert.ok(!(await page.locator('body').innerText()).includes('SENSITIVE-NOTE'));
  await block.getByRole('button', { name: 'Close time block', exact: true }).click(); await eye.click();
  await blockRow.click(); await block.getByRole('button', { name: 'Edit blocked time', exact: true }).click(); await editor.waitFor();
  await page.evaluate(() => { const key = 'florrie:hide-client-details:v1'; localStorage.setItem(key, 'true'); dispatchEvent(new StorageEvent('storage', { key, newValue: 'true' })); });
  await page.getByText('Show client details to change blocked time.', { exact: false }).waitFor();
  assert.ok(!(await page.locator('body').innerText()).includes('SENSITIVE-NOTE'));
  assert.equal(await page.locator('textarea,input[type="date"],input[type="time"]').count(), 0);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => calendarEditFixture.requests), []);
  assert.deepEqual(errors, []);
  pass('Privacy hides notes and editor inputs, blocks edits/removal and keeps Close available with no requests');
  if (output) writeFileSync(join(output, 'calendar-feedback-report.json'), JSON.stringify({ checks, errors }, null, 2) + '\n');
  console.log('Calendar block/focus checks passed: ' + checks.length + ' groups');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
