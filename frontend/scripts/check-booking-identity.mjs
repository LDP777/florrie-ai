import assert from 'node:assert/strict';
import http from 'node:http';
import { build } from 'esbuild';
import { launch } from './lib/browser.mjs';

const pendingKey = 'florrie-booking-verification-pending';
const { outputFiles } = await build({
  stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import Verification from './src/components/BookingEmailVerification.jsx'; import BookingVerificationHelp from './src/components/BookingVerificationHelp.jsx'; import {bookingHeaders} from './src/lib/booking-auth.js'; import {createBookingAuthFetch} from './src/lib/booking-auth-fetch.js'; window.headers=bookingHeaders; window.timeoutRequest=()=>createBookingAuthFetch((_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason))),20)('https://fixture.invalid'); const root=createRoot(document.getElementById('root')); let key=0;window.remount=()=>root.render(<Verification key={++key} onVerified={email=>{window.proof=email;window.proofs.push(email)}} recoveryHelp={<BookingVerificationHelp businessName="Fictional Salon" treatments={[{name:'Hybrid Dye'},{name:'Brow shape'}]} startsAt="2026-10-13T11:00:00"/>}/>);window.remount();`, resolveDir: new URL('..', import.meta.url).pathname, loader: 'jsx' },
  bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"test"', 'import.meta.env.VITE_SUPABASE_URL': '"https://fixture.invalid"', 'import.meta.env.VITE_SUPABASE_ANON_KEY': '"fixture"' },
  plugins: [{ name: 'synthetic-auth', setup(builder) {
    builder.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: 'auth', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export function createClient(url,key,options) {
      window.authOptions=options;
      let listener=()=>{},session=null;
      window.emitSession=value=>{session=value;listener(value?'SIGNED_IN':'SIGNED_OUT',value)};
      return {auth:{
        getSession:async()=>{if(window.holdRead)return new Promise(resolve=>window.finishReads.push(resolve));return {data:{session}}},
        onAuthStateChange:cb=>{listener=cb;return {data:{subscription:{unsubscribe(){listener=()=>{}}}}}},
        signInWithOtp:async request=>{
          window.requests.push(request);
          if(window.sendMode==='hold')return new Promise(resolve=>{window.finishSend=resolve});
          if(window.sendMode==='network')await window.timeoutRequest();
          return {error:window.sendMode==='rate'?{status:429,message:'Too many requests'}:window.sendMode==='reject'?{status:400,message:'Request rejected'}:null};
        },
        verifyOtp:async request=>{
          window.verifications.push(request);
          if(window.verifyMode==='hold')return new Promise(()=>{});
          if(window.verifyMode==='invalid')return {error:{message:'invalid code'},data:{session:null}};
          session={access_token:'public-token',user:{email:window.verifyMode==='mismatch'?'another@example.com':request.email,...(window.verifyMode==='phone'?{confirmed_at:'2026-09-06',phone_confirmed_at:'2026-09-06'}:{email_confirmed_at:'2026-09-06'})}};
          if(!window.noVerifyEvent)listener('SIGNED_IN',session);
          return {data:{session}};
        },
        signOut:async()=>{window.signouts++;session=null;listener('SIGNED_OUT',null);return {error:null}}
      }};
    }`, loader: 'js' }));
  } }],
});
const server = http.createServer((req,res) => {
  if (req.url === '/bundle.js') { res.setHeader('Content-Type','text/javascript'); res.end(outputFiles[0].text); }
  else { res.setHeader('Content-Type','text/html'); res.end('<div id="root"></div><script src="/bundle.js"></script>'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await launch();
const errors=[];let externalCalls=0,writeCalls=0;
try {
  const context=await browser.newContext({timezoneId:'Pacific/Auckland'});
  const page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>{
    const request=route.request();
    if(request.method()!=='GET'){writeCalls++;return route.abort()}
    if(new URL(request.url()).hostname!=='127.0.0.1'){externalCalls++;return route.abort()}
    return route.continue();
  });
  await page.addInitScript(() => {
    window.requests=[];window.verifications=[];window.proofs=[];window.signouts=0;window.finishReads=[];
    window.sendMode='ok';window.verifyMode='invalid';window.clipboardFailure=false;window.copies=[];
    window.holdRead=new URLSearchParams(location.search).has('holdRead');
    localStorage.setItem('owner-auth-sentinel','untouched');
    const realNow=Date.now.bind(Date);window.clockOffset=0;Date.now=()=>realNow()+window.clockOffset;
    const realTimeout=window.setTimeout.bind(window);window.setTimeout=(callback,delay,...args)=>realTimeout(callback,delay===25000?60:delay,...args);
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{if(window.clipboardFailure)throw new Error('Synthetic clipboard failure');window.copies.push(value)}}});
  });
  const origin=`http://127.0.0.1:${server.address().port}`;
  const reset=async(path='')=>{await page.goto(origin+path);await page.evaluate(()=>sessionStorage.clear());await page.reload();await page.getByLabel('Email for your booking').waitFor()};
  const request=async(email=' Client@Example.com ')=>{await page.getByLabel('Email for your booking').fill(email);await page.getByRole('button',{name:'Get verification code',exact:true}).click()};
  const verify=async(code='12345678')=>{await page.getByLabel('Verification code',{exact:true}).fill(code);await page.getByRole('button',{name:'Verify email',exact:true}).click()};
  const pending=()=>page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)||'null'),pendingKey);

  // Help is an optional, manual request. It cannot reserve a slot or send a message.
  await reset();
  assert.equal(await page.locator('details textarea[readonly]').count(),1);
  assert.equal(await page.locator('details textarea[readonly]').isVisible(),false);
  await page.getByText('Still no code? Get help booking',{exact:true}).click();
  await page.getByText('not confirmed',{exact:true}).waitFor();await page.getByText('not reserved',{exact:true}).waitFor();
  const draft=await page.locator('details textarea[readonly]').inputValue();
  assert.match(draft,/Fictional Salon/);assert.match(draft,/Hybrid Dye \+ Brow shape on Tuesday, 13 October 2026 at 11:00/);
  assert.match(draft,/booking request; please confirm availability/);
  await page.getByRole('button',{name:'Copy booking request',exact:true}).click();
  await page.getByText('Copied. Paste this into your usual conversation with the salon.',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.copies),[draft]);
  assert.equal(await page.evaluate(()=>window.requests.length+window.verifications.length),0);
  await page.evaluate(()=>{window.clipboardFailure=true});
  await page.getByRole('button',{name:'Copy booking request',exact:true}).click();
  await page.getByText('Select and copy the message below, then send it in your usual conversation with the salon.',{exact:true}).waitFor();
  assert.equal(await page.locator('details textarea[readonly]').inputValue(),draft);

  // A refused or uncertain send never verifies identity and never hides code entry.
  await reset();await page.evaluate(()=>{window.sendMode='reject'});await request();
  await page.getByRole('alert').filter({hasText:'not accepted'}).waitFor();
  await page.getByLabel('Verification code',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.proof),'');
  assert.equal((await page.evaluate(()=>window.headers())).Authorization,undefined);
  assert.equal(await page.getByRole('button',{name:/Request another code in/}).isDisabled(),true);
  assert.equal((await page.evaluate(()=>window.requests[0])).email,'client@example.com');
  const stored=await pending();assert.deepEqual(Object.keys(stored).sort(),['email','requestedAt','resendAfter']);
  assert.equal(stored.email,'client@example.com');

  await reset();await page.evaluate(()=>{window.sendMode='network'});await request();
  await page.getByRole('alert').filter({hasText:'couldn’t confirm'}).waitFor();
  await page.getByLabel('Verification code',{exact:true}).waitFor();
  await page.evaluate(()=>{window.verifyMode='ok'});await verify();
  await page.getByText('Email verified: client@example.com',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.requests.length),1,'arriving code must be usable without another email request');
  assert.equal((await page.evaluate(()=>window.headers())).Authorization,'Bearer public-token');
  assert.equal(await pending(),null,'successful verification removes pending address metadata');
  await page.getByRole('button',{name:'Use another email',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.proof),'');
  assert.equal((await page.evaluate(()=>window.headers())).Authorization,undefined);

  // A reload/remount retains address and wait, never the code and never identity.
  await reset();await request();
  await page.getByRole('status').filter({hasText:'Code requested.'}).waitFor();
  await page.getByLabel('Verification code',{exact:true}).fill('12345678');
  await page.reload();
  await page.getByLabel('Verification code',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Email for your booking').inputValue(),'client@example.com');
  assert.equal(await page.getByLabel('Verification code',{exact:true}).inputValue(),'');
  assert.equal(await page.getByRole('button',{name:/Request another code in/}).isDisabled(),true);
  assert.equal(await page.evaluate(()=>window.requests.length),0,'reload must not resend');
  assert.equal(await page.evaluate(()=>window.proof),'');
  await page.evaluate(()=>window.remount());await page.getByLabel('Verification code',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.requests.length),0,'step remount must not resend');
  await page.getByLabel('Verification code',{exact:true}).fill('87654321');
  await page.evaluate(()=>{window.clockOffset=61000});
  await page.getByRole('button',{name:'Resend code',exact:true}).waitFor({timeout:2500});
  await page.getByRole('button',{name:'Resend code',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Code requested.'}).waitFor();
  assert.equal(await page.getByLabel('Verification code',{exact:true}).inputValue(),'87654321','manual resend must not erase entered code');
  await page.getByRole('button',{name:'Verify email',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'expired or is incorrect'}).waitFor();
  assert.equal(await page.getByLabel('Verification code',{exact:true}).inputValue(),'87654321');

  // Neither another account nor a phone-only confirmation proves this email.
  for(const mode of ['mismatch','phone']) {
    await reset();await request();await page.evaluate(value=>{window.verifyMode=value},mode);await verify();
    await page.getByRole('alert').filter({hasText:mode==='mismatch'?'verification changed':'could not be verified'}).waitFor();
    assert.equal(await page.evaluate(()=>window.proof),'');
    assert.equal(await page.getByText('Email verified:',{exact:false}).count(),0);
  }

  // A late session cannot replace an explicit address choice or retain stale proof.
  await reset();await request('first@example.com');
  await page.getByRole('button',{name:'Change email address',exact:true}).click();
  await page.getByLabel('Email for your booking').fill('second@example.com');
  const oldSession={access_token:'other-public-token',user:{email:'first@example.com',email_confirmed_at:'2026-09-06'}};
  await page.evaluate(value=>window.emitSession(value),oldSession);
  assert.equal(await page.getByLabel('Email for your booking').inputValue(),'second@example.com');
  assert.equal(await page.evaluate(()=>window.proof),'');
  assert.equal(await page.getByText('Email verified:',{exact:false}).count(),0);
  await request('second@example.com');await page.evaluate(()=>{window.verifyMode='ok'});await verify();
  await page.getByText('Email verified: second@example.com',{exact:true}).waitFor();
  await page.evaluate(value=>window.emitSession(value),oldSession);
  await page.getByRole('alert').filter({hasText:'verification changed'}).waitFor();
  assert.equal(await page.evaluate(()=>window.proof),'','changed SDK identity invalidates the old page proof');
  assert.equal(await page.getByLabel('Email for your booking').inputValue(),'second@example.com');
  assert.equal(await page.getByText('Email verified:',{exact:false}).count(),0);

  // SDK stalls are bounded, old completions and old session reads cannot win.
  await reset();await page.evaluate(()=>{window.sendMode='hold'});await request('first@example.com');
  await page.getByRole('alert').filter({hasText:'couldn’t confirm'}).waitFor();
  await page.getByRole('button',{name:'Change email address',exact:true}).click();
  await page.evaluate(()=>{window.sendMode='ok'});await request('second@example.com');
  await page.evaluate(()=>window.finishSend({error:null}));
  assert.equal((await pending()).email,'second@example.com');
  assert.equal(await page.getByLabel('Email for your booking').inputValue(),'second@example.com');
  assert.equal(await page.evaluate(()=>window.proof),'');
  await page.evaluate(()=>{window.verifyMode='hold'});await verify();
  await page.getByRole('alert').filter({hasText:'Verification could not be confirmed yet'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Verify email',exact:true}).isEnabled(),true);
  assert.equal(await page.getByLabel('Verification code',{exact:true}).inputValue(),'12345678');

  await reset('/?holdRead=1');
  await page.evaluate(()=>window.emitSession({access_token:'public-token',user:{email:'client@example.com',email_confirmed_at:'2026-09-06'}}));
  await page.getByText('Email verified: client@example.com',{exact:true}).waitFor();
  await page.evaluate(()=>window.finishReads.forEach(resolve=>resolve({data:{session:null}})));
  await page.getByText('Email verified: client@example.com',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.proof),'client@example.com','late empty startup read cannot erase a newer verified session');

  await reset();await page.evaluate(()=>{window.sendMode='rate'});await request();
  await page.getByRole('alert').filter({hasText:'Please wait before'}).waitFor();
  assert.equal(await page.getByRole('button',{name:/Request another code in/}).isDisabled(),true);
  assert.equal(await page.evaluate(()=>window.requests.length),1);
  assert.deepEqual(await page.evaluate(()=>window.authOptions.auth),{storageKey:'florrie-booking-auth',detectSessionInUrl:false,persistSession:true});
  assert.equal(await page.evaluate(()=>localStorage.getItem('owner-auth-sentinel')),'untouched');
  assert.equal(await page.evaluate(()=>window.requests[0].options.data.account_type),'booking_client');
  assert.equal(externalCalls,0);assert.equal(writeCalls,0);assert.deepEqual(errors,[]);
  console.log('PASS: booking identity stays verified-only; normalized email, refused/uncertain send code entry, reload/remount cooldown, no automatic resend, retained edits, bounded SDK waits, stale session/request guards; manual booking-help copy preserves salon wall time and never sends or reserves');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
