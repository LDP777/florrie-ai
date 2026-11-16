export function signupPage(config, nonce) {
  // Config comes only from validated server environment, never request parameters.
  const settings = JSON.stringify({appId:config.appId,configId:config.configId,version:config.version}).replace(/</g,'\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect WhatsApp · Florrie</title>
<style nonce="${nonce}">body{margin:0;background:#FBF6F1;color:#241B17;font:16px/1.6 system-ui,sans-serif}main{max-width:30rem;margin:8vh auto;padding:24px}h1{font:36px Georgia,serif;color:#92405E}button,a{font:inherit}button{border:0;border-radius:18px;background:#92405E;color:white;padding:16px 24px;min-height:52px;cursor:pointer}button:disabled{opacity:.5}a{color:#92405E}#status{min-height:3rem}small{display:block;margin-top:24px}</style></head>
<body><main><h1>Connect your WhatsApp</h1><p>Choose your business and number securely with Meta. Only the account you authorise will connect to your salon.</p><p id="mode-note">Use a separate business number for this setup. Keep your existing WhatsApp account and chat history.</p><button id="connect" disabled>Loading Meta…</button><p id="status" role="status" aria-live="polite"></p><a id="back" href="https://florrie.ai/whatsapp">Back to Florrie</a><small>Replies use your current Florrie settings. Review whether Florrie drafts or sends replies before connecting.</small></main>
<script nonce="${nonce}">
const config=${settings};
let signupMode='cloud_api';
let secret=location.hash.slice(1), code=null, details=null, busy=false, timer=null, pairTimer=null, sdkTimer=null, generation=0, active=false;
history.replaceState(null,'',location.pathname);
const button=document.getElementById('connect'), status=document.getElementById('status'), back=document.getElementById('back');
const validId=value=>typeof value==='string'&&/^[0-9]{1,40}$/.test(value);
function say(text){status.textContent=text;}
function stop(text){
  active=false;generation++;clearTimeout(timer);clearTimeout(pairTimer);
  secret='';code=null;details=null;button.hidden=true;say(text);
}
async function request(path,body){const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),path==='complete'?120000:15000);try{const r=await fetch('/api/whatsapp/embedded/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret,...body}),signal:controller.signal});const d=await r.json();if(!r.ok)throw new Error(d.error||'Could not finish connecting. Return to Florrie and try again.');return d;}catch(e){if(e.name==='AbortError')throw new Error('The connection check took too long. Return to Florrie to check your connection before trying again.');throw e;}finally{clearTimeout(deadline);}}
async function finish(){
  if(!active||busy||!code||!details)return;
  busy=true;button.disabled=true;clearTimeout(timer);clearTimeout(pairTimer);
  say('Checking your number and finishing the connection…');
  try{
    const result=await request('complete',{code,waba_id:details.waba_id,phone_number_id:details.phone_number_id});
    if(result?.connected!==true)throw new Error('Florrie could not confirm this connection. Return to Florrie to check its status.');
    stop('WhatsApp connected. Return to Florrie to see your connection.');
  }catch(e){stop(e.message);}
}
window.addEventListener('message',event=>{
  if(!['https://www.facebook.com','https://web.facebook.com'].includes(event.origin)||!active||busy)return;
  let m;try{m=typeof event.data==='string'?JSON.parse(event.data):event.data;}catch{return;}
  if(m?.type!=='WA_EMBEDDED_SIGNUP')return;
  if(m.event==='FINISH'){
    if(!validId(m.data?.waba_id)||!validId(m.data?.phone_number_id)){
      stop('Meta did not return a verified account and number. Return to Florrie and start again.');return;
    }
    details=m.data;
    // Meta can send the asset IDs when the final popup closes, without a code.
    // Only clicking Finish supplies the code needed to complete the connection.
    if(!code)say('Click Finish in the Meta window to complete your connection. If you closed it, return to Florrie and start again.');
    void finish();
  }else if(m.event==='FINISH_ONLY_WABA'){
    stop('Meta saved a business account without a phone number. Return to Florrie and connect a number to finish setup.');
  }else if(m.event==='FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'){
    if(signupMode==='business_app'&&validId(m.data?.waba_id)&&(!m.data.phone_number_id||validId(m.data.phone_number_id))){details=m.data;if(!code)say('Click Finish in the Meta window to complete your connection.');void finish();return;}
    stop('This connection needs the existing WhatsApp Business app setup, which Florrie has not enabled yet. Keep your account and chats; return to Florrie for help.');
  }else if(m.event==='FINISH_GRANT_ONLY_API_ACCESS'){
    stop('Meta granted access without completing this number setup. Return to Florrie to check your connection before trying again.');
  }else if(m.event==='CANCEL'||m.event==='ERROR'){
    stop('Setup was not completed. Return to Florrie to check your connection and try again.');
  }
});
button.addEventListener('click',()=>{
  code=null;details=null;busy=false;active=true;button.disabled=true;
  const run=++generation;say('Finish the steps in the Meta window.');
  timer=setTimeout(()=>stop('This setup took too long. Return to Florrie and connect again.'),10*60*1000);
  try{
    FB.login(response=>{
      if(run!==generation||!active||busy)return;
      const value=response?.authResponse?.code;
      if(typeof value!=='string'||value.length<8||value.length>8192){stop('Meta sign-in was not completed. Return to Florrie to try again.');return;}
      // Ignore repeated callbacks; the code expires after 30 seconds.
      if(code)return;
      code=value;
      if(!details){
        say('Meta sign-in finished. Waiting for your business number…');
        pairTimer=setTimeout(()=>stop('Meta did not return your business number in time. Return to Florrie and start again.'),10000);
      }
      void finish();
    },{config_id:config.configId,response_type:'code',override_default_response_type:true,extras:signupMode==='business_app'?{setup:{},featureType:'whatsapp_business_app_onboarding',sessionInfoVersion:'3'}:{setup:{}}});
  }catch{stop('Meta could not open. Return to Florrie and try again.');}
});
window.fbAsyncInit=()=>{clearTimeout(sdkTimer);FB.init({appId:config.appId,autoLogAppEvents:false,xfbml:false,version:config.version});if(secret){button.disabled=false;button.textContent='Continue with Meta';}};
(async()=>{try{if(!/^[a-f0-9]{64}$/.test(secret))throw new Error('This link is incomplete. Return to Florrie to start again.');const s=await request('session',{});signupMode=s.mode==='business_app'?'business_app':'cloud_api';if(signupMode==='business_app')document.getElementById('mode-note').textContent='Keep using your WhatsApp Business app and number. Meta will ask you to approve the connection in your app and choose whether to share chat history.';if(s.platform==='native'){back.textContent='Close this window to return to Florrie';back.removeAttribute('href');}const script=document.createElement('script');script.src='https://connect.facebook.net/en_US/sdk.js';script.async=true;const failed=()=>{clearTimeout(sdkTimer);secret='';button.hidden=true;say('Meta could not load. Return to Florrie and try again.');};script.onerror=failed;sdkTimer=setTimeout(failed,20000);document.head.append(script);}catch(e){say(e.message);button.hidden=true;}})();
</script></body></html>`;
}
