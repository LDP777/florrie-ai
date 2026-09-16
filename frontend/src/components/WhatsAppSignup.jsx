import { useEffect, useState } from 'react';
import Button from './ui/Button.jsx';
import { API_BASE } from '../lib/config.js';
import { supabase } from '../lib/supabase.js';
import { isNativeApp } from '../lib/platform.js';
import { readAuthenticatedJson } from '../lib/authenticated-json.js';
import { startWhatsAppConnection } from '../lib/whatsapp-connect.js';

export default function WhatsAppSignup({ onReturn }) {
  const [availability,setAvailability] = useState(null);
  const [error,setError] = useState('');
  const [opening,setOpening] = useState(false);
  const [retry,setRetry] = useState(0);
  useEffect(()=>{
    let active=true;
    setError('');
    readAuthenticatedJson({auth:supabase.auth,url:`${API_BASE}/api/whatsapp/embedded/availability`})
      .then(d=>{if(active)setAvailability(d);})
      .catch(()=>{if(active)setError('Could not check WhatsApp setup. Try again.');});
    return()=>{active=false;};
  },[retry]);
  useEffect(()=>{
    const visible=()=>{if(document.visibilityState==='visible')onReturn();};
    document.addEventListener('visibilitychange',visible);
    let listener,cancelled=false;
    if(isNativeApp()) import('@capacitor/browser').then(async({Browser})=>{
      listener=await Browser.addListener('browserFinished',()=>onReturn());
      if(cancelled)await listener.remove();
    }).catch(()=>{});
    return()=>{cancelled=true;document.removeEventListener('visibilitychange',visible);void listener?.remove();};
  },[onReturn]);
  async function connect(){
    setOpening(true);setError('');
    try{await startWhatsAppConnection({api:API_BASE,native:isNativeApp(),getToken:async()=>{
      const {data:{session}}=await supabase.auth.getSession();return session?.access_token;
    }});}catch(e){setError(e.message);}finally{setOpening(false);}
  }
  return <section style={{background:'var(--surface, #FFFCF9)',border:'1px solid var(--border)',borderRadius:24,padding:24,marginTop:20}}>
    <h2 style={{fontFamily:'var(--font-serif)',margin:'0 0 12px'}}>Your WhatsApp, connected</h2>
    <p>Choose your business account and number with Meta, then return here. Your clients can message your salon from WhatsApp.</p>
    <p style={{color:'var(--text-muted)'}}>For this setup, use a separate business number that can receive a verification text or call. Keep your existing WhatsApp account and chats.</p>
    {error&&<p role="alert">{error}</p>}
    {availability?.available ? <Button onClick={connect} disabled={opening}>{opening?'Opening Meta…':'Continue with Meta'}</Button>
      : error ? <Button variant="secondary" onClick={()=>setRetry(n=>n+1)}>Retry</Button>
      : <p>{availability?'Self-service setup is being checked before release. You can keep using Florrie and return here when it is ready.':'Checking setup…'}</p>}
    <p style={{fontSize:13,color:'var(--text-muted)',marginBottom:0}}>Replies use your current Florrie settings. Review whether Florrie drafts or sends replies before connecting.</p>
  </section>;
}
