import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase, useBeautician } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import { emailRequest } from '../lib/email-connect.js';
import Button from './ui/Button.jsx';
import Icon from './ui/Icon';

export default function SalonEmailCard() {
 const {beautician}=useBeautician();
 const [data,setData]=useState(null),[error,setError]=useState(''),[copied,setCopied]=useState(false);
 const version=useRef(0),addressInput=useRef(null);
 const refresh=useCallback(async()=>{
  const call=++version.current;
  if(!beautician?.id) return;
  try {
   const result=await emailRequest({api:API_BASE,auth:supabase.auth,path:'salon/status'});
   if(call===version.current) {setData(result);setError('');}
  } catch(e) {if(call===version.current)setError(e.message);}
 },[beautician?.id]);
 useEffect(()=>{setData(null);setCopied(false);void refresh();return()=>{version.current++;};},[refresh]);
 async function copy() {
  try {await navigator.clipboard.writeText(data.address);setCopied(true);}
  catch {addressInput.current?.focus();addressInput.current?.select();setCopied(false);}
 }
 return <section className="mc-card mc-salon" aria-labelledby="salon-email-heading">
  <div className="mc-heading"><span className="mc-icon"><Icon name="mail" size={23}/></span><div><p className="mc-eyebrow">Included with Florrie</p><h2 id="salon-email-heading">Your salon email</h2><p>A home for booking emails and client replies.</p></div></div>
  {error ? <div role="alert" className="mc-alert">{error} <button onClick={refresh}>Try again</button></div> : !data ? <p role="status" className="mc-detail">Preparing your email…</p> : data.available ? <>
   <div className="mc-email-address"><label htmlFor="salon-email-address">Your address</label><textarea ref={addressInput} id="salon-email-address" rows={2} readOnly value={data.address} onClick={e=>e.target.select()}/><Button variant="secondary" disabled={data.status!=='active'} onClick={copy}>{copied?'Copied':'Copy address'}</Button></div>
   <p className="mc-detail">Clients see {beautician?.business_name||'your salon name'} when you email them. Their replies arrive in your Florrie Inbox, alongside their appointments.</p>
   <div className="mc-email-steps"><span><Icon name="check" size={17}/> No extra email login</span><span><Icon name="chat" size={17}/> Reply from Florrie</span></div>
   {data.status!=='active' && <p role="status" className="mc-note">Your address is paused. Contact Florrie support before sharing it.</p>}
   {data.pending>0 && <p role="status" className="mc-note">{data.pending} incoming {data.pending===1?'email needs':'emails need'} checking. If they do not appear in Inbox, contact Florrie support.</p>}
   <Link className="mc-action" to="/inbox">Open your Inbox <span aria-hidden="true">→</span></Link>
   <p className="mc-detail">You review and send replies. Attachments cannot be opened in Florrie yet.</p>
  </> : <p className="mc-note">We’re preparing Florrie email for your salon. Your current booking emails continue as usual. Your address will appear here when sending and receiving are ready.</p>}
 </section>;
}
