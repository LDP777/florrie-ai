// Real owner app routes with fictional records. All provider requests are intercepted.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { launch } from './lib/browser.mjs';
import { bundleSupabaseUrl } from './lib/fixtures.mjs';
import { calendarFixtureSource } from './lib/calendar-fixtures.mjs';

const dist = new URL('../dist/', import.meta.url).pathname;
const output = process.env.PRIVACY_SCREENSHOT_DIR;
if (output) mkdirSync(output, { recursive: true });
const server = http.createServer((req, res) => {
  let file = join(dist, decodeURIComponent((req.url || '/').split('?')[0]));
  if (!existsSync(file) || !extname(file)) file = join(dist, 'index.html');
  res.setHeader('content-type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' })[extname(file)] || 'application/octet-stream');
  try { res.end(readFileSync(file)); } catch { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await launch();
const checks = [], errors = [], external = [], geometry = {};
const sensitive = /Priya|Secretson|privateclient@example\.test|07700900987|priya_secret_handle|SENSITIVE-CONSULTATION|SENSITIVE-MESSAGE|SENSITIVE-NOTE|SENSITIVE-DRAFT/;
const fixture = calendarFixtureSource(bundleSupabaseUrl(dist), 'populated') + `
(() => {
  localStorage.setItem('florrie_milestones_seen', JSON.stringify(['booking_1','gaps_10','messages_100','messages_500','actions_500','actions_1000']));
  localStorage.setItem('florrie_catchup_2026-08-08', '1');
  const base = window.fetch;
  const client = { id:'c1', beautician_id:'b1', first_name:'Priya', last_name:'Secretson', email:'privateclient@example.test', phone:'07700900987', instagram_username:'priya_secret_handle', has_instagram:true, has_whatsapp:true, has_phone:true, has_email:true, messaging_autonomy:null, notes:'SENSITIVE-NOTE client care information', preferences:{note:'SENSITIVE-CONSULTATION'}, total_visits:9, total_spend_cents:36000, last_visit_at:'2026-08-07T10:00:00Z', archived:false, archived_at:null };
  const message = {id:'11111111-1111-4111-8111-111111111111', client_id:'c1', direction:'inbound', body:'SENSITIVE-MESSAGE from Priya privateclient@example.test', content:'SENSITIVE-MESSAGE from Priya', created_at:'2026-08-08T08:59:00Z', channel:'whatsapp', status:'delivered', image_url:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', can_teach:true, actions:[{id:'action-1',ok:true,summary:'SENSITIVE-NOTE appointment booked for Priya',created_at:'2026-08-08T08:58:00Z'}]};
  const appointment={id:'a2',client_id:'c1',beautician_id:'b1',treatment_id:'t4',starts_at:'2026-08-08T11:00:00Z',ends_at:'2026-08-08T12:00:00Z',duration_minutes:60,status:'confirmed',price_cents:4500,deposit_cents:900,deposit_paid:true,clients:client,treatments:{id:'t4',name:'Lash lift & tint',duration_minutes:60,price_cents:4500},beautician_notes:'SENSITIVE-NOTE private treatment notes',ai_booked:true};
  const paymentState=new URLSearchParams(location.search).get('payment-state');
  if(paymentState==='full')Object.assign(appointment,{payment_type:'full',deposit_paid:true,deposit_status:'paid'});
  if(paymentState==='unpaid')Object.assign(appointment,{deposit_paid:false});
  if(paymentState==='pending-full')Object.assign(appointment,{payment_type:'full',deposit_paid:false,status:'pending'});
  if(paymentState==='refunded')Object.assign(appointment,{payment_type:'full',deposit_paid:true,deposit_status:'refunded'});
  if(paymentState==='assumed')Object.assign(appointment,{status:'completed',deposit_paid:false});
  const clientPayments={deposits_total_cents:5798,per_appointment:[
    {appointment_id:'full-paid',starts_at:appointment.starts_at,treatment:'Lash lift & tint',status:'confirmed',paid_in_full:true,deposit_paid:true,deposit_cents:4499,balance_cents:0,balance_settled:true},
    {appointment_id:'deposit-paid',starts_at:appointment.starts_at,treatment:'Brow tint',status:'confirmed',paid_in_full:false,deposit_paid:true,deposit_cents:1299,balance_cents:3200,balance_settled:false},
    {appointment_id:'deposit-unpaid',starts_at:appointment.starts_at,treatment:'Brow lamination',status:'pending',paid_in_full:false,deposit_paid:false,deposit_cents:1799,balance_cents:4500,balance_settled:false},
  ]};
  const deposits=['held','awaiting','applied','refunded','forfeited'].map((status,i)=>({id:'deposit-'+i,status,client:'Priya Secretson',treatment:'Lash lift & tint',amount:[1299,1799,3199,4499,5199][i],takenDate:'2026-08-07',appointmentDate:'2026-08-08',appointmentTime:'11:00',method:'card'}));
  const cancellations=[{...appointment,id:'cancel-unpaid',starts_at:'2026-08-07T11:00:00Z',status:'cancelled',cancellation_reason:'auto_cancelled_unpaid',deposit_paid:false,price_cents:5199,deposit_cents:1799},{...appointment,id:'cancel-paid',starts_at:'2026-08-07T14:00:00Z',status:'no_show',cancellation_reason:'SENSITIVE-NOTE',deposit_paid:true,price_cents:7499,deposit_cents:3199}];
  window.privacyFixture={client,message,appointment,writes:[],reads:[],flash:[],responseClient:JSON.stringify(client)};
  const inspectFrame=()=>{if(localStorage.getItem('florrie:hide-client-details:v1')==='true' && /Priya|Secretson|privateclient@example\\.test|SENSITIVE-/.test(document.body?.innerText||'')) privacyFixture.flash.push(document.body.innerText);requestAnimationFrame(inspectFrame);};requestAnimationFrame(inspectFrame);
  const json = (body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
  window.fetch=async(input,opts={})=>{
    const u=new URL(typeof input==='string'?input:input.url,location.href),method=(opts.method||'GET').toUpperCase(),p=u.pathname;
    privacyFixture.reads.push({path:p,method});
    if(!['GET','HEAD','OPTIONS'].includes(method)) { privacyFixture.writes.push({path:p,method}); localStorage.setItem('privacy-test-writes',JSON.stringify([...JSON.parse(localStorage.getItem('privacy-test-writes')||'[]'),{path:p,method}])); return json({error:'Mutations disabled in privacy regression'},409); }
    if(p==='/rest/v1/clients')return json(u.searchParams.get('id')?client:[client]);
    if(p==='/rest/v1/appointments')return json(location.pathname==='/cancellations'?cancellations:[appointment]);
    if(p==='/rest/v1/messages')return json([message]);
    if(p==='/rest/v1/client_tag_assignments')return json([{client_id:'c1',tag_id:'tag-1',client_tags:{id:'tag-1',name:'SENSITIVE-CONSULTATION',color:'#92405e'}}]);
    if(p==='/rest/v1/loyalty_config')return json(null);
    if(p==='/rest/v1/loyalty_points')return json([]);
    if(p==='/api/appointments')return json({data:[appointment]});
    if(p==='/api/hours-exceptions')return json({exceptions:location.search.includes('blocked-time=1')?[{id:'private-block',date:'2026-08-08',type:'blocked',start_time:'13:00',end_time:'14:00',reason:'Priya Secretson',note:'SENSITIVE-NOTE private block'}]:[]});
    if(p==='/api/clients/inactive-review')return json({count:0,candidates:[]});
    if(p==='/api/clients/c1/payments')return json(clientPayments);
    if(p==='/api/appointments/deposits')return json({deposits});
    if(p==='/api/inbox/threads')return json({threads:[{client_id:'c1',client_first_name:client.first_name,client_last_name:client.last_name,instagram_username:client.instagram_username,client_instagram_username:client.instagram_username,is_known_client:true,space:'clients',segment:'needs',unread_count:1,needs_attention:true,last_channel:'whatsapp',last_message_at:message.created_at,last_message_direction:'inbound',last_message_preview:message.body,last_inbound_preview:message.body,last_inbound_at:message.created_at,last_message_type:'client'}]});
    if(p==='/api/inbox/thread/c1')return json({client,messages:[message],meta:{visits:9,last_visit_at:'2026-08-07T10:00:00Z',next_appointment_at:appointment.starts_at},drafts:[{id:'draft-1',body:'SENSITIVE-DRAFT for Priya'}],default_channel:'whatsapp'});
    if(p==='/api/inbox/suggestions/c1')return json({suggestions:[{id:'suggestion-1',label:'SENSITIVE-DRAFT',text:'SENSITIVE-DRAFT to Priya'}]});
    if(p==='/api/outbound/pending')return json({pending:[]});
    if(p==='/api/escalations')return json({escalations:[]});
    if(p==='/api/activity/feed')return json({rows:[]});
    if(p==='/api/agents/counts')return json({inbox:1,approvals:0});
    if(p==='/api/appointments/a2/manage-link')return json({needs_patch_test:false,url:'https://example.test/privateclient@example.test'});
    if(p==='/api/appointments/a2/card')return json({hasCard:true,last4:'4242',takings_readable:true,uncollected_cents:paymentState==='full'||paymentState==='pending-full'?0:3600,settled_cents:0,assumed_cents:paymentState==='assumed'?4500:0});
    if(p==='/api/appointments/a2/preparation')return json({appointment,checklist:[],summary:{}});
    if(p.startsWith('/api/clients/c1/'))return json({submissions:[],patch_tests:[]});
    return base(input,opts);
  };
})();`;
try {
  const context=await browser.newContext({viewport:{width:390,height:844},timezoneId:'UTC',reducedMotion:'reduce'});
  await context.addInitScript(fixture);
  await context.route('**/*',route=>{
    if(route.request().url().startsWith(origin)||route.request().url().startsWith('data:'))return route.continue();
    external.push(route.request().url());return route.abort();
  });
  const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
  const eye=()=>page.getByRole('button',{name:'Hide client details',exact:true}).first();
  const snap=async name=>{if(output)await page.screenshot({path:join(output,name+'.png'),fullPage:false});};
  const noPII=async label=>{
    const exposed=await page.evaluate(()=>({text:document.body.innerText,attributes:[...document.querySelectorAll('*')].flatMap(e=>['title','aria-label','alt','href','src','value'].map(a=>e.getAttribute(a)||'')).join('\n'),inputs:[...document.querySelectorAll('input,textarea')].map(e=>e.value).join('\n')}));
    assert.ok(!sensitive.test(JSON.stringify(exposed)),label+' removes sensitive text, attributes and inputs');
    assert.ok(!/[£$€]\s*[0-9]/.test(JSON.stringify(exposed)),label+' conceals money amounts in text, attributes and inputs');
    assert.ok(!sensitive.test(await page.locator('body').ariaSnapshot()),label+' removes sensitive accessible text');
    assert.deepEqual(await page.evaluate(()=>privacyFixture.flash),[],label+' has no frame with sensitive text while hidden');
  };
  const setHidden=async hidden=>{if((await eye().getAttribute('aria-pressed'))!==String(hidden))await eye().click();await page.waitForFunction(value=>document.querySelector('.client-privacy-toggle')?.getAttribute('aria-pressed')===String(value),hidden);};
  const open=async path=>{await page.goto(origin+path);await eye().waitFor();};
  const pass=label=>{checks.push(label);console.log('✓ '+label);};

  await open('/calendar/week?date=2026-08-08&view=day');
  await page.locator('.calendar-booking-name').filter({hasText:'Priya Secretson'}).waitFor();
  await setHidden(true);await noPII('Calendar day');
  assert.ok(await page.locator('.calendar-booking-treatment').filter({hasText:'Lash lift & tint'}).count());
  assert.ok((await page.locator('.calendar-timeline').innerText()).includes('11:00'));
  geometry.calendar=await page.evaluate(()=>{
    const inspect=selector=>{
      const el=document.querySelector(selector), rect=el?.getBoundingClientRect(), css=el&&getComputedStyle(el);
      const hit=rect&&document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);
      return {rect:rect?.toJSON(),display:css?.display,visibility:css?.visibility,opacity:css?.opacity,receivesPointer:!!el&&el.contains(hit)};
    };
    return {eye:inspect('.client-privacy-toggle'),more:inspect('[aria-label="More features"]'),status:inspect('.client-privacy-status'),title:inspect('.diary-hub-header h1'),width:innerWidth,height:innerHeight};
  });
  for(const name of ['eye','more']){
    const control=geometry.calendar[name];
    assert.ok(control.rect.width>=44&&control.rect.height>=44,'Calendar '+name+' has a full touch target');
    assert.ok(control.rect.top>=0&&control.rect.left>=0&&control.rect.bottom<=geometry.calendar.height&&control.rect.right<=geometry.calendar.width,'Calendar '+name+' stays on screen');
    assert.notEqual(control.display,'none');assert.equal(control.visibility,'visible');assert.ok(Number(control.opacity)>0);
    assert.equal(control.receivesPointer,true,'Calendar '+name+' is not covered by another element');
  }
  assert.ok(geometry.calendar.status.rect.top>=0&&geometry.calendar.status.rect.bottom<=geometry.calendar.height,'Hidden-details status stays on screen');
  assert.ok(geometry.calendar.title.rect.top>=geometry.calendar.status.rect.bottom,'Calendar heading clears the privacy status');
  await snap('privacy-calendar-day-mobile');
  await snap('privacy-calendar-day-mobile-verified');
  pass('Day calendar hides client identity while dates, time and treatment remain visible');

  await page.getByRole('button',{name:/Client, 11:00, Lash lift/}).click();
  const sheet=page.getByRole('dialog',{name:'Booking details'});await sheet.waitFor();await noPII('Private booking sheet');
  assert.ok((await sheet.innerText()).includes('Lash lift & tint'));
  await sheet.getByText('Deposit paid',{exact:true}).waitFor();
  await snap('privacy-appointment-detail-mobile');
  assert.equal(await sheet.locator('textarea,input').count(),0);
  assert.equal(await sheet.getByRole('button',{name:/charge|send|copy|save/i}).count(),0);
  await page.keyboard.press('Escape');await sheet.waitFor({state:'hidden'});
  await page.getByRole('group',{name:'Calendar view'}).getByRole('button',{name:'Week',exact:true}).click();
  await page.locator('.calendar-week-row').waitFor();await noPII('Calendar week');
  await page.reload();await page.locator('.calendar-week-row').waitFor();assert.equal(await eye().getAttribute('aria-pressed'),'true');await noPII('Reloaded private calendar');
  pass('Appointment sheet is private and read-only; week navigation and reload retain hiding');

  await open('/calendar/full?date=2026-08-08');await page.getByRole('button',{name:/11:00 Client/}).waitFor();await noPII('Full calendar');
  assert.equal(await page.getByRole('button',{name:'Sync to my calendar',exact:true}).isDisabled(),true);
  await page.emulateMedia({media:'print'});await noPII('Printed private calendar');await page.emulateMedia({media:'screen'});
  await setHidden(false);await page.getByRole('button',{name:/11:00 Priya/}).waitFor();
  pass('Full calendar masks hover labels and restores the original client');

  await setHidden(true);await open('/calendar/week?date=2026-08-08&view=day&blocked-time=1');
  await page.getByRole('button',{name:'Blocked time, 13:00–14:00',exact:true}).click();await noPII('Private blocked time');
  assert.equal(await page.getByRole('button',{name:'Remove this block',exact:true}).isDisabled(),true);
  const closeBlock=page.getByRole('button',{name:'Close time block',exact:true});assert.equal(await closeBlock.isEnabled(),true);await closeBlock.click();
  await closeBlock.waitFor({state:'hidden'});await setHidden(false);
  pass('Private blocked-time notes stay hidden while Close remains usable and Remove is disabled');

  await open('/clients');await page.getByRole('button',{name:/Priya Secretson/}).first().waitFor();
  const search=page.getByPlaceholder('Search by name, phone, or email...');await search.fill('Priya');await setHidden(true);await noPII('Clients list and search');
  assert.equal(await page.getByPlaceholder('Client search hidden').inputValue(),'');
  assert.equal(await page.getByRole('button',{name:'More client actions'}).isDisabled(),true);
  await page.getByRole('button',{name:/^• Client/}).first().click();
  await page.getByText('Contact details, care records and messages hidden',{exact:false}).waitFor();await noPII('Private client profile');
  const paymentSummary=page.locator('.client-payments-summary');
  await paymentSummary.waitFor();
  for(const status of ['Paid in full','Deposit paid','Deposit unpaid'])assert.ok((await paymentSummary.innerText()).includes(status),'Private profile keeps '+status);
  assert.equal(await page.locator('a[href^="tel:"],a[href^="mailto:"]').count(),0);
  await snap('privacy-client-profile-mobile');
  // Close the actual profile overlay before using the shell control.
  await page.getByRole('button',{name:'×',exact:true}).last().click();
  await setHidden(false);assert.equal(await page.getByPlaceholder('Search by name, phone, or email...').inputValue(),'Priya');
  await page.getByRole('button',{name:/Priya Secretson/}).first().click();
  await page.getByRole('link',{name:/privateclient@example.test/}).waitFor();
  assert.equal(await page.evaluate(()=>JSON.stringify(privacyFixture.client)===privacyFixture.responseClient),true);
  pass('Clients conceals contacts, search and profile content; reveal restores original records and draft search');

  await open('/inbox');await page.locator('.inbox-row').filter({hasText:'Priya Secretson'}).waitFor();await setHidden(true);await noPII('Inbox list');
  assert.ok((await page.locator('.inbox-row').innerText()).includes('Message hidden'));
  await page.locator('.inbox-row').first().click();await page.locator('.fl-chat-history').waitFor();await noPII('Conversation');
  assert.equal(await page.locator('.fl-chat-history img').count(),0);
  assert.ok((await page.locator('.fl-chat-history').innerText()).includes('Message hidden'));
  assert.equal(await page.getByRole('button',{name:'Send',exact:true}).count(),0);
  const chatGeometry=await page.evaluate(()=>({
    composer:[...document.querySelectorAll('.client-private-section')].find(el=>el.textContent.includes('Show client details to write or send a reply.'))?.getBoundingClientRect().toJSON(),
    dock:document.querySelector('.fl-app-dock')?.getBoundingClientRect().toJSON(),
    statusHeight:parseFloat(getComputedStyle(document.querySelector('.app-shell')).getPropertyValue('--client-privacy-status-height')),
  }));
  assert.ok(chatGeometry.composer&&chatGeometry.dock,'Conversation and app dock are present');
  assert.ok(chatGeometry.statusHeight>0,'Privacy status is measured into the shell height');
  assert.ok(chatGeometry.composer.bottom<=chatGeometry.dock.top,'Private composer notice clears the floating navigation');
  await snap('privacy-chat-mobile');
  pass('Inbox and conversation hide names, handles, messages, attachments, drafts and action receipts');
  await page.setViewportSize({width:1280,height:900});
  // The resize handler mounts the desktop list after the existing chat is already visible.
  await page.locator('.inbox-row').first().waitFor({state:'visible'});
  await page.locator('.fl-client-chat').waitFor({state:'visible'});
  await page.locator('.fl-chat-history').waitFor();await noPII('Desktop Inbox and conversation');
  assert.ok(await page.locator('.inbox-row').count());assert.ok(await page.locator('.fl-client-chat').count());
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth));
  await snap('privacy-chat-desktop');await page.setViewportSize({width:390,height:844});await page.locator('.fl-chat-history').waitFor();
  pass('Desktop split Inbox and conversation keep both panes private without horizontal overflow');

  await setHidden(false);await page.getByRole('textbox',{name:'Reply via WhatsApp',exact:true}).waitFor();
  assert.ok((await page.locator('.fl-chat-history').innerText()).includes('SENSITIVE-MESSAGE'));
  assert.equal(await page.locator('.fl-chat-history img').count(),1);
  await page.getByRole('textbox',{name:'Reply via WhatsApp',exact:true}).fill('SENSITIVE-DRAFT to Priya');
  await setHidden(true);await noPII('Open composer on hide');await setHidden(false);
  assert.equal(await page.getByRole('textbox',{name:'Reply via WhatsApp',exact:true}).inputValue(),'SENSITIVE-DRAFT to Priya');
  await setHidden(true);await page.reload();await page.locator('.fl-chat-history').waitFor();await noPII('Reloaded private conversation');
  pass('Hiding an open draft does not clear it; revealing restores the conversation without sending');

  await open('/today');
  const morning=page.getByRole('dialog',{name:'Morning catch-up'});if(await morning.isVisible().catch(()=>false))await morning.getByRole('button',{name:'Got it'}).click();
  await page.locator('.today-next').waitFor();await noPII('Today summary');
  await page.locator('.today-disclosure').filter({hasText:"Today's appointments"}).locator('summary').click();await noPII('Expanded Today diary');
  assert.ok((await page.locator('.today-agenda').innerText()).includes('Lash lift & tint'));
  await snap('privacy-today-mobile');
  await setHidden(false);await page.locator('.today-next-name').filter({hasText:'Priya Secretson'}).waitFor();
  pass('Today includes hidden initials and accessible names, including expanded appointments');

  await setHidden(true);
  for(const [state,label] of [['full','Paid in full'],['unpaid','Deposit unpaid'],['pending-full','Deposit unpaid'],['refunded','Deposit refunded'],['assumed','Down as taken, not confirmed']]){
    await open('/calendar/week?date=2026-08-08&view=day&payment-state='+state);
    const booking=page.locator('.calendar-booking').first();await booking.waitFor();
    if(state==='pending-full'||state==='refunded')assert.ok(!(await booking.innerText()).includes('Paid'),'Unpaid or refunded full-payment requests are not labelled paid');
    await booking.click();const details=page.getByRole('dialog',{name:'Booking details'});await details.getByText(label,{exact:true}).waitFor();await noPII('Private '+state+' booking');
  }
  pass('Payment states stay visible; pending full-payment requests, refunds and assumed takings never appear Paid');

  await open('/deposits');await page.getByText('Currently Held',{exact:true}).waitFor();await noPII('Deposits held');
  await page.getByText('Held',{exact:true}).click();await page.getByText('Method',{exact:true}).waitFor();await noPII('Expanded deposit');
  assert.ok((await page.locator('body').innerText()).includes('Awaiting payment'));
  await page.getByRole('button',{name:/^History \(/}).click();
  for(const status of ['Applied','Refunded','Kept (policy)'])assert.ok((await page.locator('body').innerText()).includes(status));
  await noPII('Deposit history');await setHidden(false);await page.getByText('£31.99',{exact:true}).first().waitFor();await setHidden(true);
  pass('Deposit totals and individual amounts hide while held, awaiting, applied, refunded and kept states remain');

  await open('/cancellations');await page.getByText('Paid deposit:',{exact:false}).waitFor();await noPII('Cancellations');
  assert.ok((await page.locator('body').innerText()).includes('Deposit unpaid'));
  assert.ok((await page.locator('body').innerText()).includes('Paid deposit:'));
  await page.getByRole('button',{name:'Insights',exact:true}).click();await noPII('Cancellation insights');
  pass('Cancellation payment badges remain while lost value, deposits and insight totals hide');

  await open('/client-timeline');await page.getByText('Total Spent',{exact:true}).waitFor();
  await page.getByText('confirmed',{exact:true}).waitFor();await noPII('Client timeline');
  await setHidden(false);await page.getByText('£360.00',{exact:true}).waitFor();await setHidden(true);await noPII('Client timeline restored privacy');
  pass('Client timeline hides total spend and event amounts; reveal restores the original figures');

  await open('/today');await page.locator('.today-next').waitFor();
  const boxes=await page.evaluate(()=>({eye:document.querySelector('.client-privacy-toggle')?.getBoundingClientRect().toJSON(),title:document.querySelector('.diary-hub-header h1')?.getBoundingClientRect().toJSON(),more:document.querySelector('[aria-label="More features"]')?.getBoundingClientRect().toJSON(),width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));
  assert.ok(boxes.eye.width>=44&&boxes.eye.height>=44,'Eye is a 44px touch target');
  const overlaps=(a,b)=>a&&b&&a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
  assert.equal(overlaps(boxes.eye,boxes.title),false,'Eye does not cover heading');assert.equal(overlaps(boxes.eye,boxes.more),false,'Eye does not cover More');
  assert.ok(boxes.scroll<=boxes.width,'No mobile horizontal overflow');
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('privacy-test-writes')||'[]')),[]);
  assert.deepEqual(errors,[]);
  pass('Mobile eye, More and title fit without overlap; no writes or runtime errors');
  if(output)writeFileSync(join(output,'primary-report.json'),JSON.stringify({checks,errors,geometry,blockedExternalRequests:external.length},null,2)+'\n');
  console.log('Client privacy primary checks passed: '+checks.length+' groups');
} finally { await browser.close();await new Promise(resolve=>server.close(resolve)); }
