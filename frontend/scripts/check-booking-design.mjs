// Built booking journey, fictional clients and API responses. No real bookings or emails.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import http from 'node:http';
import { webkit } from '@playwright/test';
import { launch } from './lib/browser.mjs';
import { fetchStubSource } from './lib/fixtures.mjs';
const dist = new URL('../dist/', import.meta.url).pathname;
const output = process.env.BOOKING_DESIGN_SCREENSHOT_DIR;
if (output) mkdirSync(output, { recursive: true });
const server = http.createServer((req, res) => {
  let file = join(dist, (req.url || '/').split('?')[0]);
  if (!existsSync(file) || !extname(file)) file = join(dist, 'index.html');
  res.setHeader('content-type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' })[extname(file)] || 'application/octet-stream');
  try { res.end(readFileSync(file)); } catch { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = process.env.BOOKING_BROWSER === 'webkit' ? await webkit.launch() : await launch();
const errors=[];
const sentBookings=[];let checkoutVisits=0;
let page;
try {
  const context=await browser.newContext({viewport:{width:390,height:844},timezoneId:'Europe/London',reducedMotion:'reduce',isMobile:true,hasTouch:true});
  await context.exposeFunction('recordBooking',row=>sentBookings.push(row));
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.href==='https://checkout.stripe.com/c/pay/florrie-fixture'){checkoutVisits++;return route.fulfill({status:200,contentType:'text/html',body:'<p>Fictional checkout destination</p>'});}
    if(url.origin===origin || output && ['fonts.googleapis.com','fonts.gstatic.com'].includes(url.hostname)) return route.continue();
    return route.abort();
  });
  await context.addInitScript(fetchStubSource()+`
    (()=>{
      const RealDate=Date, now=RealDate.parse('2026-11-22T09:00:00Z');
      window.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
      const query=new URLSearchParams(location.search), scenario=query.get('scenario');
      const user={id:'fictional-client',email:'maya@example.test',email_confirmed_at:'2026-11-01T10:00:00Z',aud:'authenticated',role:'authenticated'};
      const session={access_token:'eyJhbGciOiJIUzI1NiJ9.'+btoa(JSON.stringify({sub:user.id,exp:4102444800})) + '.fixture',refresh_token:'fixture',expires_in:3600,expires_at:4102444800,token_type:'bearer',user};
      if(scenario==='fresh')localStorage.removeItem('florrie-booking-auth');else localStorage.setItem('florrie-booking-auth',JSON.stringify(session));
      const weekly=Object.fromEntries(['mon','tue','wed','thu','fri','sat'].map(day=>[day,{start:'10:00',end:'17:00'}]));
      const treatments=[{id:'t1',name:'Signature brows',description:'A shape, tint and finish tailored to you.',duration_minutes:30,price_cents:3000,deposit_percent:20,category:'Brows',requires_patch_test:scenario==='patch'},
        {id:'t2',name:'Brow lamination & hybrid stain',duration_minutes:60,price_cents:4500,deposit_percent:20,category:'Brows'},
        {id:'t3',name:'Lash lift & tint',duration_minutes:60,price_cents:4500,deposit_percent:20,category:'Lashes'}];
      window.bookingFixture={writes:[],requests:[],failMonth:false,failDay:false,failBook:false,holdDay:false,session};
      const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}}), base=window.fetch;
      window.fetch=async(input,options={})=>{
        const u=new URL(typeof input==='string'?input:input.url,location.href),p=u.pathname,method=options.method||'GET',state=bookingFixture;
        state.requests.push({path:p,method,search:u.search});
        if(p.endsWith('/auth/v1/otp')){state.writes.push({path:p,body:JSON.parse(options.body)});return json({});}
        if(p.endsWith('/auth/v1/verify'))return json(session);
        if(p.endsWith('/auth/v1/user'))return json(user);
        if(p==='/api/booking/ellindigo/page')return json({salon:{id:'fictional-salon',business_name:'Ellindigo',brand_color:'#92405e',working_hours:weekly,booking_policy:{max_advance_days:90,cancellation_notice_hours:48,late_cancel_charge_percent:100},stripe_onboarding_complete:true},treatments,addOns:[{id:'extra',name:'Brow conditioning',duration_minutes:15,price_cents:500}]});
        if(p==='/api/products/public/fictional-salon')return json([]);
        if(p==='/api/courses/ellindigo')return json({courses:[]});
        if(p==='/api/booking/ellindigo/reviews')return json({reviews:[]});
        if(p==='/api/booking/ellindigo/availability-range')return state.failMonth?json({},503):json({appointments:[{starts_at:'2026-11-23T10:00:00Z',duration_minutes:420}],closures:['2026-11-25'],blocks:[],date_hours:[]});
        if(p==='/api/booking/ellindigo/availability'){
          if(state.holdDay)await new Promise(resolve=>{window.finishDay=resolve});
          return state.failDay?json({},503):json({appointments:[{starts_at:u.searchParams.get('date')+'T13:00:00Z',duration_minutes:60}],blocks:[{start_time:'12:00',end_time:'12:30'}],closed:false,hours:{start:'10:00',end:'17:00'}});
        }
        if(p.endsWith('/check-member'))return json({is_member:false});
        if(p.endsWith('/check-packages'))return json({packages:[]});
        if(p.includes('/lookup-client'))return json({found:false,returningClient:false,consultation:{ask:false,block:false}});
        if(p==='/api/booking/ellindigo/book'){
          const row={path:p,body:JSON.parse(options.body),authorization:options.headers.Authorization};state.writes.push(row);await window.recordBooking(row);
          if(scenario==='checkout')return json({checkout_url:'https://checkout.stripe.com/c/pay/florrie-fixture'});
          return state.failBook?json({error:'That time has just been taken. Please choose another.'},409):json({booking:{manageUrl:'/book/ellindigo/manage/fictional-token',deposit_pending:false}});
        }
        if(p==='/api/booking/ellindigo/manage/fictional-token')return json({payment:{priceCents:3000,depositPaidCents:600,remainingCents:2400,paidInFull:false}});
        if(!['GET','HEAD','OPTIONS'].includes(method))return json({error:'Unexpected fixture write'},400);
        return base(input,options);
      };
    })();`);
  page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
  const snap=async name=>{if(output){await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(output,name+'.png'),fullPage:true});}};
  const fit=async label=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),label+' fits');
  const open=async(scenario='')=>{await page.goto(origin+'/book/ellindigo'+(scenario?'?scenario='+scenario:''));await page.getByRole('heading',{name:'Choose your treatment',exact:true}).waitFor();};
  const choose=async()=>{await page.getByRole('button',{name:/Signature brows 30 min/}).click();await page.getByRole('button',{name:'Continue to date & time',exact:true}).click();await page.getByRole('button',{name:'Thursday, 26 November 2026, Available',exact:true}).click();await page.getByRole('button',{name:'14:00',exact:true}).waitFor();};

  await open('fresh');
  assert.equal(await page.getByLabel('Email for your booking').isVisible(),false,'new clients can browse without opening verification');
  assert.equal(await page.getByRole('button',{name:'Continue to date & time',exact:true}).isDisabled(),true);
  for(const width of [320,390,430]){await page.setViewportSize({width,height:844});await fit('Treatments '+width);await snap('treatments-'+width);}
  await page.setViewportSize({width:390,height:844});await choose();
  await page.getByRole('button',{name:'See full calendar',exact:true}).click();
  await snap('calendar-390');
  assert.equal(await page.getByRole('button',{name:'Monday, 23 November 2026, Fully booked',exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'Wednesday, 25 November 2026, Closed',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Thursday, 26 November 2026, Available',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'12:00',exact:true}).count(),0,'personal block stays blocked');
  assert.equal(await page.getByRole('button',{name:'13:00',exact:true}).count(),0,'existing appointment stays blocked');
  await page.getByRole('button',{name:'14:00',exact:true}).click();
  await page.getByRole('heading',{name:'Pick a time',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'14:00',exact:true}).getAttribute('aria-pressed'),'true','selecting time does not advance');
  for(const width of [320,390,430]){await page.setViewportSize({width,height:844});await fit('Times '+width);await snap('times-'+width);}
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'See full calendar',exact:true}).click();
  await page.getByLabel('Jump to month').selectOption('2027-01');
  await page.getByRole('button',{name:'Thursday, 7 January 2027, Available',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Choose a time',exact:true}).isDisabled(),true,'changing month clears old selection');
  await page.getByRole('button',{name:'16:30',exact:true}).click();
  await page.getByRole('button',{name:'Continue · Thu 7 Jan, 16:30',exact:true}).click();
  await page.getByRole('heading',{name:'Your details',exact:true}).waitFor();
  if(await page.getByRole('button',{name:'Use another email',exact:true}).count()) await page.getByRole('button',{name:'Use another email',exact:true}).click();
  await page.getByLabel('Email for your booking').fill('maya@example.test');
  await page.getByRole('button',{name:'Get verification code',exact:true}).click();
  await page.getByLabel('Verification code',{exact:true}).fill('123456');
  await page.getByRole('button',{name:'Verify email',exact:true}).click();
  await page.getByText('Email verified: maya@example.test',{exact:true}).waitFor();
  await page.getByLabel('Your name',{exact:true}).fill('Maya Test');
  await page.getByPlaceholder('Phone number *',{exact:true}).fill('07700900123');
  await snap('details-390');await fit('Details');
  await page.getByRole('button',{name:'Review booking',exact:true}).click();
  await page.getByRole('heading',{name:'Confirm your booking',exact:true}).waitFor();
  await page.getByText(/48 hours/).waitFor();
  assert.equal(await page.getByRole('checkbox').first().isChecked(),false,'photo consent remains opt-in');
  assert.equal(await page.getByRole('checkbox').nth(1).isChecked(),false,'marketing remains opt-in');
  for(const width of [320,390,430]){await page.setViewportSize({width,height:844});await fit('Review '+width);await snap('review-'+width);}
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>{bookingFixture.failBook=true;});
  await page.getByRole('button',{name:'Pay £6.00 deposit',exact:true}).click();
  await page.getByText('That time has just been taken. Please choose another.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Back',exact:true}).click();
  assert.equal(await page.getByLabel('Your name',{exact:true}).inputValue(),'Maya Test','retry preserves entered details');
  await page.getByRole('button',{name:'Review booking',exact:true}).click();
  await page.evaluate(()=>{bookingFixture.failBook=false;});
  await page.getByRole('button',{name:'Pay £6.00 deposit',exact:true}).click();
  await page.getByRole('heading',{name:"You're booked",exact:true}).waitFor();
  assert.equal(await page.getByRole('link',{name:'Manage my booking',exact:true}).getAttribute('href'),'/book/ellindigo/manage/fictional-token');
  assert.match(await page.getByRole('link',{name:'Add to calendar',exact:true}).getAttribute('href'),/\/manage\/fictional-token\/calendar$/);
  await snap('confirmed-390');
  const booking=await page.evaluate(()=>bookingFixture.writes.filter(x=>x.path.endsWith('/book')).at(-1));
  assert.equal(booking.body.starts_at,'2027-01-07T16:30:00');assert.equal(booking.body.client_name,'Maya Test');assert.match(booking.authorization,/Bearer /);assert.equal(booking.body.photo_consent,false);

  // Slow and failed availability must never display the previous date's times.
  await open();await choose();await page.getByRole('button',{name:'14:00',exact:true}).click();
  await page.evaluate(()=>{bookingFixture.holdDay=true;});
  await page.getByRole('button',{name:'Friday, 27 November 2026, Available',exact:true}).click();
  await page.getByText('Checking available times…',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Choose a time',exact:true}).isDisabled(),true);
  assert.equal(await page.locator('.fl-booking-time').count(),0);
  await page.waitForFunction(()=>typeof finishDay==='function');
  await page.evaluate(()=>{bookingFixture.holdDay=false;bookingFixture.failDay=true;finishDay();});
  await page.getByRole('button',{name:'Try loading times again',exact:true}).waitFor();
  await page.evaluate(()=>{bookingFixture.failDay=false;});await page.getByRole('button',{name:'Try loading times again',exact:true}).click();
  await page.getByRole('button',{name:'14:00',exact:true}).waitFor();
  await page.evaluate(()=>{bookingFixture.failMonth=true;});
  await page.getByRole('button',{name:'See full calendar',exact:true}).click();await page.getByLabel('Jump to month').selectOption('2026-12');
  await page.getByRole('alert').filter({hasText:'couldn’t check'}).waitFor();
  assert.equal(await page.locator('.fl-booking-date:not(:disabled)').count(),0,'unknown month fails closed');
  await page.evaluate(()=>{bookingFixture.failMonth=false;});await page.getByRole('button',{name:'Try again',exact:true}).click();
  await page.getByRole('button',{name:'Thursday, 3 December 2026, Available',exact:true}).click();
  await page.getByRole('button',{name:'14:00',exact:true}).waitFor();

  // Add-on duration must fit in the diary, and changing treatment rechecks times.
  await page.getByRole('button',{name:'Change treatments',exact:true}).click();
  await page.getByRole('button',{name:/Brow conditioning/}).click();
  await page.getByRole('button',{name:'Continue to date & time',exact:true}).click();
  await page.getByRole('button',{name:'16:00',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'16:30',exact:true}).count(),0,'add-on cannot extend past closing');
  assert.equal(await page.getByRole('button',{name:'11:30',exact:true}).count(),0,'add-on cannot overlap personal block');
  await page.getByRole('button',{name:'Change treatments',exact:true}).click();
  await page.getByRole('button',{name:/Brow lamination & hybrid stain/}).click();
  await page.getByRole('button',{name:'Continue to date & time',exact:true}).click();
  await page.getByRole('button',{name:'15:00',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'16:00',exact:true}).count(),0,'combined services and add-on must fit');
  // Deposit/full payment handoffs preserve their choice; the Stripe destination is intercepted.
  for(const type of ['deposit','full']) {
    await open('checkout');await choose();await page.getByRole('button',{name:'14:00',exact:true}).click();
    await page.getByRole('button',{name:'Continue · Thu 26 Nov, 14:00',exact:true}).click();
    await page.getByLabel('Your name',{exact:true}).fill('Maya Test');await page.getByLabel('Phone number',{exact:true}).fill('07700900123');
    await page.getByText('Email verified: maya@example.test',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Review booking',exact:true}).click();
    if(type==='full')await page.getByRole('button',{name:'Pay in full (£30.00)',exact:true}).click();
    await page.getByRole('button',{name:type==='full'?'Pay £30.00':'Pay £6.00 deposit',exact:true}).click();
    await page.waitForURL('https://checkout.stripe.com/c/pay/florrie-fixture');
    assert.equal(sentBookings.at(-1).body.payment_type,type);assert.equal(sentBookings.at(-1).body.starts_at,'2026-11-26T14:00:00');
  }
  assert.equal(checkoutVisits,2);
  await open('patch');await choose();await page.getByText(/patch test at least 48 hours/).waitFor();
  await page.goto(origin+'/book/ellindigo/confirmed?mt=fictional-token');
  await page.getByText('To pay on the day',{exact:true}).waitFor();
  await page.getByRole('link',{name:'Manage my booking',exact:true}).waitFor();await snap('deposit-confirmed-390');
  assert.deepEqual(errors,[]);
  console.log('Passed: compact treatment/date journey, 320/390/430px, full calendar and year navigation, explicit time confirmation, email verification, details/retry, opt-ins, final payload and links, closed/booked dates, blocks, slow/failed availability, multi-treatment and add-on duration, deposit/full checkout handoffs, patch-test notice and payment receipt.');
} catch(error) { console.log('SCREEN:', await page?.locator('body').innerText()); console.log('PAGE ERRORS:', errors); if(output && page) await page.screenshot({path:join(output,'failure.png'),fullPage:true}); throw error; } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
