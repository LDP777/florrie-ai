import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import http from 'node:http';
import { launch } from './lib/browser.mjs';
import { fetchStubSource, sessionSeedSource, bundleSupabaseUrl } from './lib/fixtures.mjs';
import { signupPage } from '../../backend/src/lib/whatsapp-signup-page.js';
const dist = new URL('../dist', import.meta.url).pathname;
const html = signupPage({appId:'123',configId:'456',version:'v21.0'},'test-nonce');
const server = http.createServer((req,res)=>{
  if(req.url.startsWith('/api/whatsapp/embedded')) {res.setHeader('content-type','text/html');res.end(html);return;}
  let file=join(dist,req.url.split('?')[0]); if(!existsSync(file)||!extname(file))file=join(dist,'index.html');
  res.setHeader('content-type',({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'})[extname(file)]||'application/octet-stream');res.end(readFileSync(file));
}).listen(0);
const browser=await launch();
const origin=`http://127.0.0.1:${server.address().port}`;
try {
  for(const available of [false,true]){
    const ctx=await browser.newContext({viewport:{width:390,height:844}});
    await ctx.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
    await ctx.addInitScript(fetchStubSource());
    await ctx.addInitScript(sessionSeedSource(bundleSupabaseUrl(dist)));
    await ctx.addInitScript(available=>{
      const base=window.fetch; window.__writes=[];
      const json=d=>new Response(JSON.stringify(d),{headers:{'Content-Type':'application/json'}});
      window.fetch=async(input,opts={})=>{
        const url=String(input);
        if(url.includes('/api/whatsapp/status'))return json({connected:false,activation_state:null});
        if(url.includes('/api/whatsapp/embedded/availability'))return json({available});
        if(url.includes('/api/whatsapp/embedded/start')){window.__writes.push(url);return new Response(JSON.stringify({error:'Setup is temporarily unavailable. Try again.'}),{status:503,headers:{'Content-Type':'application/json'}});}
        if(opts.method && opts.method!=='GET')window.__writes.push(url);
        return base(input,opts);
      };
    },available);
    const page=await ctx.newPage(); await page.goto(`${origin}/whatsapp`);
    await page.getByLabel('A separate business number',{exact:true}).check();
    if(!available){await page.getByText('Self-service setup is being checked before release.',{exact:false}).waitFor();assert.equal(await page.getByRole('button',{name:'Continue with Meta'}).count(),0);}
    else {await page.getByRole('button',{name:'Continue with Meta',exact:true}).click();await page.getByRole('alert').filter({hasText:'Setup is temporarily unavailable'}).waitFor();assert.equal(await page.getByRole('button',{name:'Continue with Meta'}).isEnabled(),true);}
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.equal(await page.evaluate(()=>window.__writes.filter(u=>!u.includes('/embedded/start')).length),0);
    await ctx.close();
  }
  console.log('PASS mobile settings: honest rollout, failed handoff recoverable, no account writes or horizontal overflow');
  for(const mode of ['details-first','code-first','cancel','foreign-origin','expired','sdk-failure','account-only','business-app','grant-only','invalid-details','unconfirmed','code-without-details','details-without-code','login-throws','duplicate-events','business-app-approved']){
    const ctx=await browser.newContext({viewport:{width:390,height:844}});let completions=0;
    await ctx.route('**/*',async route=>{
      const url=route.request().url();
      if(url.endsWith('/embedded/session'))return route.fulfill({status:mode==='expired'?410:200,json:mode==='expired'?{error:'This setup link expired. Start again from Florrie.'}:{platform:'native',mode:mode==='business-app-approved'?'business_app':'cloud_api'}});
      if(url.endsWith('/embedded/complete')){completions++;return route.fulfill({json:mode==='unconfirmed'?{}:{connected:true}});}
      if(url.startsWith('https://connect.facebook.net/')){
        if(mode==='sdk-failure')return route.abort();
        return route.fulfill({contentType:'text/javascript',body:`window.FB={init:()=>{},login:(cb,options)=>{window.__metaOptions=options;window.__metaCallback=cb;if(${JSON.stringify(mode)}==='login-throws')throw new Error('test');}};window.fbAsyncInit();`});
      }
      if(new URL(url).origin!==origin)return route.abort();return route.continue();
    });
    const page=await ctx.newPage();if(mode==='code-without-details')await page.clock.install();await page.goto(`${origin}/api/whatsapp/embedded#${'a'.repeat(64)}`);
    const status=page.getByRole('status');
    if(mode==='expired'){await status.filter({hasText:'expired'}).waitFor();}
    else if(mode==='sdk-failure'){await status.filter({hasText:'Meta could not load'}).waitFor();}
    else {
      await page.getByRole('button',{name:'Continue with Meta'}).click();
      if(mode==='business-app-approved'){
        await page.evaluate(()=>{dispatchEvent(new MessageEvent('message',{origin:'https://www.facebook.com',data:{type:'WA_EMBEDDED_SIGNUP',event:'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',data:{waba_id:'100'}}}));window.__metaCallback({authResponse:{code:'app-code'}});});
        await status.filter({hasText:'WhatsApp connected.'}).waitFor();
      }else if(mode==='login-throws'){
        await status.filter({hasText:'Meta could not open'}).waitFor();
      }else if(['account-only','business-app','grant-only','invalid-details'].includes(mode)){
        await page.evaluate(mode=>{
          const events={'account-only':'FINISH_ONLY_WABA','business-app':'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING','grant-only':'FINISH_GRANT_ONLY_API_ACCESS','invalid-details':'FINISH'};
          dispatchEvent(new MessageEvent('message',{origin:'https://www.facebook.com',data:{type:'WA_EMBEDDED_SIGNUP',event:events[mode],data:{}}}));
          window.__metaCallback({authResponse:{code:'late-code'}});
        },mode);
        const expected={'account-only':'without a phone number','business-app':'not enabled yet','grant-only':'without completing','invalid-details':'did not return a verified'};
        await status.filter({hasText:expected[mode]}).waitFor();
      }else if(mode==='code-without-details'){
        await page.evaluate(()=>window.__metaCallback({authResponse:{code:'test-code'}}));
        await status.filter({hasText:'Waiting for your business number'}).waitFor();
        await page.clock.fastForward(10001);
        await status.filter({hasText:'in time'}).waitFor();
        await page.evaluate(()=>dispatchEvent(new MessageEvent('message',{origin:'https://www.facebook.com',data:{type:'WA_EMBEDDED_SIGNUP',event:'FINISH',data:{waba_id:'100',phone_number_id:'200'}}})));
      }else if(mode==='details-without-code'){
        await page.evaluate(()=>dispatchEvent(new MessageEvent('message',{origin:'https://www.facebook.com',data:{type:'WA_EMBEDDED_SIGNUP',event:'FINISH',data:{waba_id:'100',phone_number_id:'200'}}})));
        await status.filter({hasText:'Click Finish in the Meta window'}).waitFor();
      }else if(mode==='cancel'){
        await page.evaluate(()=>{dispatchEvent(new MessageEvent('message',{origin:'https://www.facebook.com',data:JSON.stringify({type:'WA_EMBEDDED_SIGNUP',event:'CANCEL'})}));window.__metaCallback({authResponse:{code:'late-code'}});});
        await status.filter({hasText:'not completed'}).waitFor();
      }else {
        await page.evaluate(mode=>{
          const message=()=>dispatchEvent(new MessageEvent('message',{origin:mode==='foreign-origin'?'https://www.facebook.com.attacker.invalid':'https://www.facebook.com',data:JSON.stringify({type:'WA_EMBEDDED_SIGNUP',event:'FINISH',data:{waba_id:'100',phone_number_id:'200'}})}));
          const callback=()=>window.__metaCallback({authResponse:{code:'test-code'}});
          if(mode==='code-first'){callback();message();}else{message();callback();}if(mode==='duplicate-events'){message();callback();}
        },mode);
        if(mode==='unconfirmed')await status.filter({hasText:'could not confirm this connection'}).waitFor();else if(mode!=='foreign-origin')await status.filter({hasText:'WhatsApp connected.'}).waitFor();
      }
    }
    if(!['expired','sdk-failure'].includes(mode)){const options=await page.evaluate(()=>window.__metaOptions);assert.deepEqual(options.extras,mode==='business-app-approved'?{setup:{},featureType:'whatsapp_business_app_onboarding',sessionInfoVersion:'3'}:{setup:{}});assert.equal(options.override_default_response_type,true);}
    assert.equal(completions,['code-first','details-first','unconfirmed','duplicate-events','business-app-approved'].includes(mode)?1:0,mode);
    assert.equal(new URL(page.url()).hash,'');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    console.log('PASS Meta bridge: '+mode);
    await ctx.close();
  }
  console.log('PASS mobile Meta bridge: both callback orders, cancellation, untrusted origin, expiry, SDK failure, secret removed from URL');
}finally{await browser.close();server.close();}
