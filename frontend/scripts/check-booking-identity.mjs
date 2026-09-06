import assert from 'node:assert/strict';
import http from 'node:http';
import { build } from 'esbuild';
import { launch } from './lib/browser.mjs';

const { outputFiles } = await build({
  stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import Verification from './src/components/BookingEmailVerification.jsx'; import {bookingHeaders} from './src/lib/booking-auth.js'; window.headers=bookingHeaders; createRoot(document.getElementById('root')).render(<Verification onVerified={email=>window.proof=email}/>);`, resolveDir: new URL('..', import.meta.url).pathname, loader: 'jsx' },
  bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"test"', 'import.meta.env.VITE_SUPABASE_URL': '"https://fixture.invalid"', 'import.meta.env.VITE_SUPABASE_ANON_KEY': '"fixture"' },
  plugins: [{ name: 'synthetic-auth', setup(builder) {
    builder.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: 'auth', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export function createClient(url,key,options) {
      window.authOptions=options;
      let listener=()=>{}; let session=null;
      return {auth:{
        getSession:async()=>({data:{session}}),
        onAuthStateChange:cb=>{listener=cb;return {data:{subscription:{unsubscribe(){}}}}},
        signInWithOtp:async request=>{window.requests.push(request);return {error:window.failSend?{message:'transport failed'}:null}},
        verifyOtp:async request=>{window.verifications.push(request);if(window.failVerify)return {error:{message:'bad code'},data:{session:null}};session={access_token:'public-token',user:{email:request.email,email_confirmed_at:'2026-09-06'}};listener('SIGNED_IN',session);return {data:{session}}},
        signOut:async()=>{session=null;listener('SIGNED_OUT',null);return {error:null}}
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
try {
  const page = await browser.newPage();
  await page.addInitScript(() => { window.requests=[];window.verifications=[];window.failSend=true;window.failVerify=true; localStorage.setItem('owner-auth-sentinel','untouched'); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByLabel('Email for your booking').fill('Client@Example.com');
  await page.getByRole('button',{name:'Get verification code'}).click();
  await page.getByRole('alert').filter({hasText:'request failed'}).waitFor();
  assert.equal(await page.getByText('Check your inbox for a verification code.').count(),0);
  assert.equal(await page.evaluate(()=>window.proof),'');
  assert.equal((await page.evaluate(()=>window.headers())).Authorization,undefined);
  await page.evaluate(()=>{window.failSend=false});
  await page.getByRole('button',{name:'Get verification code'}).click();
  await page.getByText('Check your inbox for a verification code.').waitFor();
  assert.equal(await page.getByRole('button',{name:/Request another code in/}).isDisabled(),true);
  await page.getByLabel('Verification code').fill('123456');
  await page.getByRole('button',{name:'Verify email',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'could not be verified'}).waitFor();
  assert.equal(await page.getByLabel('Verification code').inputValue(),'123456');
  await page.evaluate(()=>{window.failVerify=false});
  await page.getByRole('button',{name:'Verify email',exact:true}).click();
  await page.getByText('Email verified: client@example.com').waitFor();
  assert.equal(await page.evaluate(()=>window.proof),'client@example.com');
  assert.equal((await page.evaluate(()=>window.headers())).Authorization,'Bearer public-token');
  await page.getByRole('button',{name:'Use another email'}).click();
  await page.getByLabel('Email for your booking').waitFor();
  assert.equal(await page.evaluate(()=>window.proof),'');
  assert.equal((await page.evaluate(()=>window.headers())).Authorization,undefined);
  assert.deepEqual(await page.evaluate(()=>window.authOptions.auth),{storageKey:'florrie-booking-auth',detectSessionInUrl:false,persistSession:true});
  assert.equal(await page.evaluate(()=>localStorage.getItem('owner-auth-sentinel')),'untouched');
  assert.equal(await page.evaluate(()=>window.requests[0].options.data.account_type),'booking_client');
  console.log('✓ Public booking identity: failed request, retry, cooldown, invalid code, verified headers, account change, isolated auth storage');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
