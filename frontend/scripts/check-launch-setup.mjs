// Real React forms against isolated fixtures. No external accounts or deliveries.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import http from 'node:http';
import { launch } from './lib/browser.mjs';
const root = new URL('../', import.meta.url).pathname;
const store = `
const initial = {id:'salon-fixture',first_name:'',business_name:'',timezone:'Europe/London'};
window.fixture={profile:JSON.parse(sessionStorage.getItem('setup-profile')||JSON.stringify(initial)),rows:JSON.parse(sessionStorage.getItem('setup-rows')||'[]'),writes:[],failProfile:false,loseTreatmentResponse:false,authCalls:[]};
const persist=()=>{sessionStorage.setItem('setup-profile',JSON.stringify(window.fixture.profile));sessionStorage.setItem('setup-rows',JSON.stringify(window.fixture.rows));};
export const supabase={auth:{getSession:async()=>({data:{session:{access_token:'fixture',user:{id:'salon-fixture'}}}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signUp:async p=>{window.fixture.authCalls.push(['signup',p]);return {data:{user:{id:'new-user'},session:null}};},resetPasswordForEmail:async(...p)=>{window.fixture.authCalls.push(['reset',...p]);return {};},updateUser:async p=>{window.fixture.authCalls.push(['update',p]);return {};},signOut:async()=>{}},from:table=>{const b={select:()=>b,eq:()=>b,then:r=>Promise.resolve({count:window.fixture.rows.length,error:null}).then(r),upsert:async rows=>{window.fixture.writes.push({table,rows});for(const row of rows){const old=window.fixture.rows.find(r=>r.id===row.id);if(old)Object.assign(old,row);else window.fixture.rows.push(row);}persist();if(window.fixture.loseTreatmentResponse){window.fixture.loseTreatmentResponse=false;throw Error('Synthetic lost response');}return {error:null};}};return b;}};
export const useBeautician=()=>({beautician:window.fixture.profile,loading:false,refresh:async()=>{}});
export const updateRow=async(table,id,changes)=>{if(window.fixture.failProfile)throw Error('Synthetic failed save');window.fixture.writes.push({table,changes});Object.assign(window.fixture.profile,changes);persist();return window.fixture.profile;};
`;
const entry = `
import React from 'react';import {createRoot} from 'react-dom/client';import {BrowserRouter,useLocation} from 'react-router-dom';
import Onboarding from './src/pages/Onboarding.jsx';import Login from './src/pages/Login.jsx';import UpdatePassword from './src/pages/UpdatePassword.jsx';import {supabase} from './src/lib/supabase.js';
import Settings from './src/pages/Settings.jsx';import Pricing from './src/pages/Pricing.jsx';
function Harness(){const l=useLocation();return l.pathname==='/settings'?<Settings/>:l.pathname==='/pricing'?<Pricing/>:l.pathname==='/signup'?<Login supabase={supabase} initialMode="signup"/>:l.pathname==='/login'?<Login supabase={supabase}/>:l.pathname==='/update-password'?<UpdatePassword supabase={supabase}/>:<Onboarding onComplete={()=>{}}/>;}
createRoot(document.getElementById('root')).render(<BrowserRouter><Harness/></BrowserRouter>);
`;
const bundle = await build({stdin:{contents:entry,resolveDir:root,loader:'jsx'},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',define:{'import.meta.env':JSON.stringify({VITE_API_URL:'http://fixture.invalid',VITE_SUPABASE_URL:'http://fixture.invalid',VITE_SUPABASE_ANON_KEY:'fixture'})},plugins:[{name:'fixture-stores',setup(b){
 b.onResolve({filter:/\/lib\/supabase\.js$/},()=>({path:'store',namespace:'fixture'}));
 b.onResolve({filter:/\/lib\/platform\.js$/},()=>({path:'platform',namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='store'?store:'export const isIOSNative=()=>new URLSearchParams(location.search).get("native")==="ios";export const isNativeApp=isIOSNative;',loader:'js'}));
}}]});
const server=http.createServer((req,res)=>{res.setHeader('content-type',req.url==='/bundle.js'?'text/javascript':'text/html');res.end(req.url==='/bundle.js'?bundle.outputFiles[0].text:'<div id="root"></div><script src="/bundle.js"></script>');}).listen(0);
const browser=await launch();
try {
 const origin=`http://127.0.0.1:${server.address().port}`;
 const ctx=await browser.newContext({viewport:{width:390,height:844}});
 await ctx.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.fulfill({status:200,contentType:'application/json',body:'{}'}));
 const page=await ctx.newPage();
 await page.goto(`${origin}/signup`);
 await page.getByPlaceholder('you@example.com').fill('fictional@example.test');
 await page.getByPlaceholder('At least 8 characters').fill('fictional-test-password');
 await page.getByRole('button',{name:'Create account',exact:true}).click();
 await page.getByRole('heading',{name:'Check your email'}).waitFor();
 assert.equal(await page.evaluate(()=>window.fixture.authCalls[0][0]),'signup');
 console.log('PASS: new web signup waits for email verification before setup');
 await page.goto(`${origin}/login`);
 await page.getByRole('button',{name:'Forgot password?',exact:true}).click();
 await page.getByPlaceholder('you@example.com').fill('fictional@example.test');
 await page.getByRole('button',{name:'Send reset link',exact:true}).click();
 await page.getByRole('heading',{name:'Check your email'}).waitFor();
 assert.equal(await page.evaluate(()=>window.fixture.authCalls[0][2].redirectTo),`${origin}/update-password`);
 await page.goto(`${origin}/update-password`);
 await page.getByPlaceholder('At least 8 characters').fill('new-test-password');
 await page.getByPlaceholder('Type it again').fill('mismatched-password');
 await page.getByRole('button',{name:'Update password',exact:true}).click();
 await page.getByText("Passwords don't match.",{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.fixture.authCalls.length),0);
 await page.getByPlaceholder('Type it again').fill('new-test-password');
 await page.getByRole('button',{name:'Update password',exact:true}).click();
 await page.getByRole('heading',{name:'Password updated'}).waitFor();
 console.log('PASS: reset requests return to reset screen; mismatch does not update the account');
 await page.goto(`${origin}/onboarding`);
 await page.getByPlaceholder('e.g. Sophie', {exact:true}).fill('Alex');
 await page.getByPlaceholder('e.g. Sophie Lash Studio').fill('Fictional launch salon');
 await page.evaluate(()=>{window.fixture.failProfile=true;});
 await page.getByRole('button',{name:'Next',exact:true}).click();
 await page.getByText('Failed to save. Please try again.',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.fixture.writes.length),0);
 await page.evaluate(()=>{window.fixture.failProfile=false;});
 await page.getByRole('button',{name:'Next',exact:true}).click();
 await page.getByRole('heading',{name:'Your treatments'}).waitFor();
 await page.getByPlaceholder('e.g. Brow Lamination').fill('Signature brows');
 await page.getByPlaceholder('0.00').fill('35.25');
 await page.getByRole('button',{name:'+ Add another treatment',exact:true}).click();
 await page.getByPlaceholder('e.g. Brow Lamination').nth(1).fill('Brow wax');
 await page.getByPlaceholder('0.00').nth(1).fill('15');
 await page.evaluate(()=>{window.fixture.loseTreatmentResponse=true;});
 await page.getByRole('button',{name:'Next',exact:true}).click();
 await page.getByText('Failed to save treatments. Please try again.',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.fixture.rows.length),2);
 await page.getByRole('button',{name:'Next',exact:true}).click();
 await page.getByRole('heading',{name:'Working hours'}).waitFor();
 assert.deepEqual(await page.evaluate(()=>window.fixture.rows.map(r=>r.price_cents)),[3525,1500]);
 await page.reload();
 await page.getByRole('heading',{name:'Working hours'}).waitFor();
 assert.equal(await page.evaluate(()=>window.fixture.rows.length),2);
 console.log('PASS: rejected profile save retries; ambiguous treatment save and reload preserve two services without duplicates');
 await page.locator('input[type="time"]').nth(1).fill('08:00');
 await page.getByRole('button',{name:'Next',exact:true}).click();
 await page.getByText('Each working day needs a closing time after its opening time.',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.fixture.writes.some(w=>w.changes?.working_hours)),false);
 await page.locator('input[type="time"]').nth(1).fill('17:00');
 await page.getByRole('button',{name:'Next',exact:true}).click();
 await page.getByRole('heading',{name:'Your booking link'}).waitFor();
 assert.deepEqual(await page.evaluate(()=>window.fixture.profile.working_hours.mon),{start:'09:00',end:'17:00'});
 console.log('PASS: invalid opening hours stay editable; corrected hours save before booking-link setup');
 // Exercise the actual Settings switch, including profiles from before the
 // preference column existed. Missing/null must render Off and enable on click.
 for (const preference of [undefined, null, false, true]) {
  await page.evaluate(preference=>sessionStorage.setItem('setup-profile',JSON.stringify({
   id:'salon-fixture',first_name:'Alex',business_name:'Fictional salon',
   marketing_emails_enabled:preference,
  })),preference);
  await page.goto(`${origin}/settings?section=notifications`);
  const emails=page.getByRole('switch',{name:'Emails from Florrie',exact:true});
  await emails.waitFor();
  assert.equal(await emails.getAttribute('aria-checked'),String(preference===true));
  assert.equal(await emails.innerText(),preference===true?'On':'Off');
  assert.equal(await page.evaluate(()=>window.fixture.writes.length),0);
  await emails.click();
  await page.getByRole('switch',{name:'Emails from Florrie',exact:true,checked:preference!==true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.fixture.writes),[
   {table:'beauticians',changes:{marketing_emails_enabled:preference!==true}},
  ]);
  await page.reload();
  await page.getByRole('switch',{name:'Emails from Florrie',exact:true,checked:preference!==true}).waitFor();
 }
 await page.evaluate(()=>{
  sessionStorage.setItem('setup-profile',JSON.stringify({id:'salon-fixture',first_name:'Alex',marketing_emails_enabled:false}));
 });
 await page.goto(`${origin}/settings?section=notifications`);
 await page.getByRole('switch',{name:'Emails from Florrie',exact:true,checked:false}).waitFor();
 await page.evaluate(()=>{window.fixture.failProfile=true;});
 await page.getByRole('switch',{name:'Emails from Florrie',exact:true}).click();
 await page.getByText('Could not save that. Check your connection and try again.',{exact:true}).waitFor();
 assert.equal(await page.getByRole('switch',{name:'Emails from Florrie',exact:true}).getAttribute('aria-checked'),'false');
 assert.equal(await page.evaluate(()=>window.fixture.writes.length),0);
 console.log('PASS: optional email switch requires explicit true, persists owner changes and leaves failed saves Off');
 for (const [plan,status,action] of [
  ['trial','trial','Choose a plan'],['florrie','active','Manage billing'],
  ['florrie_team','past_due','Update card'],['florrie','cancelled','Subscribe again'],
 ]) {
  await page.evaluate(({plan,status})=>sessionStorage.setItem('setup-profile',JSON.stringify({
   id:'salon-fixture',email:'fictional@example.test',first_name:'Alex',business_name:'Fictional salon',
   subscription_plan:plan,subscription_status:status,trial_ends_at:'2027-01-01T00:00:00Z',
  })),{plan,status});
  await page.goto(`${origin}/settings?section=account&native=ios`);
  await page.getByRole('heading',{name:'Subscription',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:/^(Choose a plan|Manage billing|Update card|Subscribe again)$/}).count(),0);
  assert.doesNotMatch(await page.locator('body').innerText(),/£|Update your card/);
  await page.getByText('fictional@example.test',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Delete account',exact:true}).waitFor();
  if(status==='past_due')await page.getByText('There is a payment issue with this subscription.',{exact:true}).waitFor();
  await page.goto(`${origin}/settings?section=account`);
  await page.getByRole('button',{name:action,exact:true}).click();
  assert.equal(new URL(page.url()).pathname,'/pricing');
 }
 await page.goto(`${origin}/pricing?native=ios`);
 await page.getByText('Subscription changes are not available in the iPhone app.',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:/Subscribe|subscription|billing|checkout/i}).count(),0);
 console.log('PASS: four iPhone account states preserve account details without billing dead ends; web actions still open pricing');
 // Browsing settings must not write any salon preferences.
 await page.goto(`${origin}/settings`);
 await page.getByRole('searchbox',{name:'Search settings'}).fill('Instagram');
 await page.getByRole('link',{name:/Connected apps/}).click();
 await page.getByRole('heading',{name:'Connected apps',exact:true}).waitFor();
 await page.getByText('Instagram',{exact:true}).waitFor();
 await page.getByText('WhatsApp Business',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.fixture.writes.length),0);
 await page.reload();
 await page.getByRole('heading',{name:'Connected apps',exact:true}).waitFor();
 await page.getByRole('combobox',{name:'Settings section'}).selectOption('ai');
 await page.getByRole('heading',{name:"Florrie's autopilot",exact:true}).waitFor();
 assert.equal(await page.getByRole('heading',{name:'Messaging channels',exact:true}).count(),0);
 await page.goBack();
 await page.getByRole('heading',{name:'Connected apps',exact:true}).waitFor();
 await page.getByRole('button',{name:'All settings',exact:true}).click();
 await page.getByRole('link',{name:/Business details/}).click();
 await page.getByRole('button',{name:'Edit First name',exact:true}).click();
 await page.getByRole('textbox',{name:'First name',exact:true}).fill('Alex revised');
 await page.evaluate(()=>{window.fixture.failProfile=true;});
 await page.getByRole('button',{name:'Save',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'Could not save that'}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'First name',exact:true}).inputValue(),'Alex revised');
 assert.equal(await page.evaluate(()=>window.fixture.writes.length),0);
 await page.evaluate(()=>{window.fixture.failProfile=false;});
 await page.getByRole('button',{name:'Save',exact:true}).click();
 await page.getByRole('button',{name:'Edit First name',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Edit First name',exact:true}).innerText(),'Alex revised');
 assert.deepEqual(await page.evaluate(()=>window.fixture.writes),[{table:'beauticians',changes:{first_name:'Alex revised'}}]);
 await page.goto(`${origin}/settings?section=notifications`);
 await page.getByRole('heading',{name:'Your notifications',exact:true}).waitFor();
 assert.equal(await page.getByRole('heading',{name:"Florrie's autopilot",exact:true}).count(),0);
 console.log('PASS: settings search, same-page navigation, reload and Back preserve sections; failed edits keep input and retry once');
 for (const [callback,section,title] of [
  ['ig=success&ig_detail=fixture-detail','connections','Connected apps'],
  ['gcal=error','calendar','Calendar sync'],
  ['stripe=refresh','payments','Payments'],
 ]) {
  await page.goto(`${origin}/settings?${callback}`);
  await page.getByRole('heading',{name:title,exact:true}).waitFor();
  assert.equal(new URL(page.url()).search,`?section=${section}`);
 }
 await page.evaluate(()=>sessionStorage.setItem('setup-profile',JSON.stringify({id:'salon-fixture',first_name:'Alex',instagram_page_id:'fictional-instagram'})));
 let failInstagram=true;
 await page.route('**/api/instagram/status',route=>route.fulfill({status:failInstagram?503:200,contentType:'application/json',body:JSON.stringify(failInstagram?{error:'Unavailable'}:{token_valid:true,page_name:'fictional_demo'})}));
 await page.goto(`${origin}/settings?section=connections`);
 await page.getByRole('button',{name:'Retry Instagram check',exact:true}).waitFor();
 await page.getByText('Could not check just now',{exact:true}).waitFor();
 assert.equal(await page.getByText(/Connected, @fictional_demo/).count(),0);
 failInstagram=false;
 await page.getByRole('button',{name:'Retry Instagram check',exact:true}).click();
 await page.getByText(/Connected, @fictional_demo/).waitFor();
 assert.equal(await page.evaluate(()=>window.fixture.writes.length),0);
 console.log('PASS: connection returns open the right settings and clear callback details; failed Instagram checks retry without false Connected');
 await page.evaluate(()=>sessionStorage.setItem('setup-profile',JSON.stringify({id:'salon-fixture',first_name:'Alex',booking_slug:'fictional-salon'})));
 await page.goto(`${origin}/settings?section=profile`);
 await page.getByRole('button',{name:'Edit Booking slug',exact:true}).click();
 await page.getByRole('textbox',{name:'Booking slug',exact:true}).fill('a');
 await page.getByRole('button',{name:'Save',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'at least 3 characters'}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'Booking slug',exact:true}).inputValue(),'a');
 await page.getByRole('textbox',{name:'Booking slug',exact:true}).fill('fictional-salon-new');
 page.once('dialog',dialog=>dialog.dismiss());
 await page.getByRole('button',{name:'Save',exact:true}).click();
 assert.equal(await page.getByRole('textbox',{name:'Booking slug',exact:true}).inputValue(),'fictional-salon-new');
 assert.equal(await page.evaluate(()=>window.fixture.writes.length),0);
 await page.evaluate(()=>{window.fixture.failProfile=true;});
 page.once('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Save',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'Could not save that'}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'Booking slug',exact:true}).inputValue(),'fictional-salon-new');
 await page.evaluate(()=>{window.fixture.failProfile=false;});
 page.once('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Save',exact:true}).click();
 await page.getByRole('button',{name:'Edit Booking slug',exact:true}).waitFor();
 assert.deepEqual(await page.evaluate(()=>window.fixture.writes),[{table:'beauticians',changes:{booking_slug:'fictional-salon-new'}}]);
 console.log('PASS: invalid, cancelled and failed booking-link edits keep the draft; confirmed retry writes once');
 await ctx.close();
} finally {await browser.close();server.close();}
