import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import http from 'node:http';
import { launch } from './lib/browser.mjs';
import { bundleSupabaseUrl } from './lib/fixtures.mjs';
import { calendarFixtureSource } from './lib/calendar-fixtures.mjs';

// Real bundle and fictional appointments. External APIs are blocked; optional screenshots may load the existing Google Fonts.
const dist = new URL('../dist', import.meta.url).pathname;
const server = http.createServer((req, res) => {
  let path = join(dist, (req.url || '/').split('?')[0]);
  if (!existsSync(path) || !extname(path)) path = join(dist, 'index.html');
  res.setHeader('content-type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' })[extname(path)] || 'application/octet-stream');
  try { res.end(readFileSync(path)); } catch { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await launch();
const shots = process.env.BOOKING_SHEET_SCREENSHOT_DIR;
if (shots) mkdirSync(shots, { recursive: true });
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'UTC', permissions: ['clipboard-read', 'clipboard-write'] });
  await context.route('**/*', route => (new URL(route.request().url()).origin === origin || (shots && ['fonts.googleapis.com', 'fonts.gstatic.com'].includes(new URL(route.request().url()).hostname))) ? route.continue() : route.abort());
  await context.addInitScript(calendarFixtureSource(bundleSupabaseUrl(dist)) + `
    (() => {
      const base = window.fetch;
      const scenario = new URL(location.href).searchParams.get('scenario') || 'completed';
      const appointment = { id:'a2', client_id:'c2', beautician_id:'b1', treatment_id:'t4', starts_at:'2026-08-08T11:00:00Z', ends_at:'2026-08-08T12:30:00Z', duration_minutes:90,
        status:scenario==='cancelled'?'cancelled':scenario==='confirmed' || scenario==='full' ? 'confirmed' : 'completed', price_cents:8500, deposit_cents:1700, deposit_paid:scenario==='full', payment_type:scenario==='full'?'full':null,
        payment_method:'card', clients:{ first_name:'Alex', last_name:'Morgan' }, treatments:{id:'t4',name:'Korean lash lift',duration_minutes:90,price_cents:8500},
        beautician_notes:'Lash lift + hybrid stain. Prefers a natural finish.', created_at:'2026-08-01T20:45:00Z', booked_via:'manual', confirmation_sent_at:scenario==='confirmed'?null:'2026-08-01T20:45:00Z' };
      const writes=[];
      window.bookingSheetFixture={appointment,writes};
      const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
      window.fetch=async(input,options={})=>{
        const u=new URL(typeof input==='string'?input:input.url,location.href), p=u.pathname, method=options.method||'GET';
        if(['POST','PATCH','DELETE'].includes(method) && !p.startsWith('/auth/')){
          const body=options.body ? JSON.parse(options.body) : null; writes.push({path:p,method,body});
          if(p==='/rest/v1/appointments'){Object.assign(appointment,body);return json([appointment]);}
          if(p==='/api/appointments/a2'){Object.assign(appointment,body);return json({appointment});}
          if(p.endsWith('/send-manage-link'))return json({channel:'sms'});
          if(p.endsWith('/resend-confirmation'))return json({sent:true,channels:['SMS']});
          if(p==='/api/stripe/payment-link')return json({url:'https://example.test/fictional-payment'});
          if(p==='/api/stripe/save-card-link')return json({url:'https://example.test/fictional-card'});
          return json({error:'Unexpected test write'},400);
        }
        if(p==='/rest/v1/appointments')return json([appointment]);
        if(p==='/api/appointments')return json({data:[appointment]});
        if(p==='/api/appointments/a2/card')return json({hasCard:scenario==='confirmed',last4:scenario==='confirmed'?'4242':null,reason:'no_card_on_file',takings_readable:true,uncollected_cents:scenario==='full'?0:8500,settled_cents:scenario==='full'?8500:0,assumed_cents:scenario==='completed'?8500:0,fees:{amount_cents:8500,estimated_net_cents:8224}});
        if(p==='/api/appointments/a2/manage-link')return json({needs_patch_test:false,url:'https://example.test/fictional-booking'});
        if(p==='/api/clients/c2/outstanding-balance')return json({outstanding_cents:0,review_sources:[]});
        if(p==='/api/consultation-forms/preparation/a2')return json({preparation:{confirmed:true,required:true,patch:{required:true,state:'review',can_complete:false},forms:[{id:'form1',name:'Lash lift consultation',status:'awaiting_response',available:true,review_required:true}]}});
        if(p==='/api/consultation-forms/for-appointment/a2')return json({requires_consultation:true,form_available:false,pending:{expired:false},missing_forms:[{form_name:'Lash lift consultation',status:'awaiting_response'}]});
        return base(input,options);
      };
    })();`);
  const page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  page.on('dialog', dialog=>dialog.dismiss());
  page.setDefaultTimeout(10000);
  const sheet=page.getByRole('dialog',{name:'Booking details'});
  async function open(scenario='completed',width=390){
    await page.setViewportSize({width,height:844});
    await page.goto(`${origin}/calendar/week?date=2026-08-08&appt=a2&scenario=${scenario}`);
    await page.addStyleTag({content:':root{--safe-top:47px;--shell-top:47px;--safe-bottom:24px;}'});
    await sheet.getByRole('heading',{name:'Alex Morgan'}).waitFor();
    await sheet.getByText('Lash lift consultation: awaiting a response',{exact:true}).waitFor();
    await page.evaluate(()=>document.fonts.ready);
  }
  async function fit(label){
    const overflow=await sheet.evaluate(el=>el.scrollWidth>el.clientWidth+1);
    assert.equal(overflow,false,label+' fits the sheet');
  }
  await open();
  await sheet.getByText('Down as taken, not confirmed',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.bookingSheetFixture.writes.length),0,'opening never mutates a booking');
  await fit('390px completed');
  if(shots){
    await page.screenshot({path:join(shots,'appointment-390.png')});
    await sheet.locator('.booking-payments').scrollIntoViewIfNeeded();
    await page.screenshot({path:join(shots,'appointment-payments-390.png')});
    await sheet.locator('.booking-client-links').scrollIntoViewIfNeeded();
    await page.screenshot({path:join(shots,'appointment-links-390.png')});
  }
  const overview=sheet.locator('.booking-overview');
  await overview.getByRole('button',{name:'Change',exact:true}).first().click();
  await overview.getByRole('combobox').waitFor();
  await overview.getByRole('button',{name:'Cancel',exact:true}).click();
  await overview.getByRole('button',{name:'+ Add treatment',exact:true}).click();
  await overview.getByRole('combobox').waitFor();
  await overview.getByRole('button',{name:'Cancel',exact:true}).click();
  await overview.getByRole('button',{name:'Change',exact:true}).last().click();
  assert.ok(await overview.getByRole('option',{name:'1 h 30 min',exact:true}).count());
  await overview.getByRole('button',{name:'Cancel',exact:true}).click();
  await overview.getByRole('button',{name:'Move',exact:true}).click();
  assert.equal(await overview.locator('input[type="datetime-local"]').inputValue(),'2026-08-08T11:00');
  await fit('time editor');
  await overview.getByRole('button',{name:'Cancel',exact:true}).click();
  await overview.getByRole('button',{name:'Edit',exact:true}).click();
  await overview.getByRole('spinbutton').fill('85');
  await overview.getByRole('button',{name:'Save',exact:true}).click();
  await overview.getByRole('button',{name:'Edit',exact:true}).waitFor();
  console.log('✓ Treatment, add-treatment, duration, date/time and price controls remain usable');
  const payments=sheet.getByRole('region',{name:'Payments',exact:true});
  await payments.getByRole('button',{name:'Send payment link',exact:true}).click();
  await payments.getByText('Payment link ready',{exact:true}).waitFor();
  await payments.getByRole('button',{name:'Get a card-on-file link',exact:true}).click();
  await payments.getByRole('textbox').filter({visible:true}).first().waitFor();
  assert.equal(await page.evaluate(()=>window.bookingSheetFixture.writes.find(w=>w.path==='/api/stripe/payment-link').body.amount_cents),8500);
  await payments.getByRole('button',{name:'Charge £85.00 balance to card',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.bookingSheetFixture.writes.some(w=>w.path.endsWith('/charge-balance'))),false,'dismissed charge does nothing');
  await sheet.getByLabel('Appointment notes').fill('Fictional saved treatment note');
  await sheet.locator('.booking-notes').getByRole('button',{name:'Save',exact:true}).click();
  assert.ok(await page.evaluate(()=>window.bookingSheetFixture.writes.some(w=>w.body?.beautician_notes==='Fictional saved treatment note')));
  await sheet.getByRole('button',{name:'Copy booking link',exact:true}).click();
  await sheet.getByRole('button',{name:'Text link to client',exact:true}).click();
  await sheet.getByRole('button',{name:/Sent by text/}).waitFor();
  await sheet.locator('.booking-history > summary').click();
  await sheet.getByRole('button',{name:'Send the confirmation again',exact:true}).click();
  await sheet.getByText('Sent by SMS. It includes a calendar invite.',{exact:true}).waitFor();
  await sheet.getByRole('button',{name:'Delete appointment',exact:true}).click();
  await sheet.getByRole('button',{name:'Actually a no-show',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.bookingSheetFixture.writes.some(w=>w.method==='DELETE'||w.path.endsWith('/status'))),false,'destructive actions still need confirmation');
  console.log('✓ Notes save, booking links, confirmation, payment links and card links use their original routes; destructive confirmations remain');
  await sheet.locator('.booking-care summary').click();
  await sheet.getByText('Needs your review before treatment.',{exact:true}).waitFor();
  console.log('✓ Preparation warning and full checklist remain accessible');
  await open('confirmed');
  assert.ok(await sheet.locator('.booking-history').evaluate(el=>el.open),'missing confirmation stays visible');
  await sheet.getByRole('button',{name:'Charge their card ···· 4242',exact:true}).click();
  await sheet.getByPlaceholder('Amount, e.g. 15.00').fill('10');
  await sheet.getByPlaceholder("What's it for? (shows on her receipt)").fill('Fictional add-on');
  await sheet.getByRole('button',{name:'Cancel',exact:true}).click();
  await sheet.getByRole('button',{name:'Add a payment note or photo',exact:true}).click();
  await sheet.getByText('How they paid',{exact:true}).waitFor();
  await sheet.getByRole('button',{name:'Close booking details'}).click();
  await sheet.waitFor({state:'hidden'});
  await open('full');
  assert.equal(await sheet.getByRole('button',{name:/Charge £.*balance to card/}).count(),0,'fully paid booking has no balance charge');
  await sheet.getByText('Paid in full at booking',{exact:true}).waitFor();
  console.log('✓ Completion/photo flow, saved-card editor and fully-paid safeguards remain');
  await open('cancelled');
  assert.equal(await sheet.getByRole('region',{name:'Payments',exact:true}).count(),0,'cancelled booking has no empty collection section');
  await open('completed',320);await fit('320px');
  await overview.getByRole('button',{name:'Move',exact:true}).click();await fit('320px date editor');
  await open('completed',768);await fit('tablet');
  if(shots)await page.screenshot({path:join(shots,'appointment-768.png')});
  assert.deepEqual(errors,[]);
  console.log('✓ Mobile/tablet fit and no browser runtime errors');
} finally { await browser.close();await new Promise(resolve=>server.close(resolve)); }
