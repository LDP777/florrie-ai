import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import { contentRequest } from '../lib/content-workflow.js';
import Button from './ui/Button.jsx';

export default function ContentResults({ ownerId, posts=[] }) {
  const [data,setData]=useState(null),[error,setError]=useState(''),[selected,setSelected]=useState(''),[link,setLink]=useState(''),[busy,setBusy]=useState(false),[copied,setCopied]=useState(false);
  const generation=useRef(0),locked=useRef(false);
  async function request(path,options={}) {
    const {data}=await supabase.auth.getSession();
    return contentRequest(`${API_BASE}/api/content${path}`,{token:data?.session?.access_token,...options});
  }
  async function load() {const run=++generation.current;setError('');try{const d=await request('/results');if(run===generation.current)setData(d);}catch(e){if(run===generation.current)setError(e.message);}}
  useEffect(()=>{setData(null);setLink('');setSelected('');load();return()=>{generation.current++;};},[ownerId]);
  async function prepare() {
    if(locked.current)return;locked.current=true;setBusy(true);setError('');setCopied(false);
    try{const r=await request(`/${selected}/booking-link`,{method:'POST'});setLink(r.url);await load();}catch(e){setError(e.message);}finally{locked.current=false;setBusy(false);}
  }
  const total=key=>(data?.campaigns||[]).reduce((n,r)=>n+Number(r[key]||0),0);
  const money=cents=>new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP'}).format(cents/100);
  return <section className="fl-content-results" aria-labelledby="content-results-title">
    <header><span className="fl-workspace-eyebrow">From interest to an appointment</span><h2 id="content-results-title">What led to a booking?</h2><p>Give a post its own booking link. See the appointments made through it.</p></header>
    {error&&<div className="fl-reputation-error" role="alert">{error}<Button variant="quiet" onClick={load}>Retry results</Button></div>}
    {data&&<div className="fl-result-numbers"><div><strong>{total('confirmed')}</strong><span>Confirmed bookings</span></div><div><strong>{total('pending')}</strong><span>Awaiting payment</span></div><div><strong>{money(total('booking_value_cents'))}</strong><span>Booked appointment value</span></div></div>}
    <div className="fl-link-builder"><label>Choose a saved post<select value={selected} disabled={busy} onChange={e=>{setSelected(e.target.value);setLink('');setCopied(false);}}><option value="">Choose a post</option>{posts.filter(p=>p.post_type!=='gallery').map(p=><option key={p.id} value={p.id}>{(p.caption||'Untitled post').slice(0,85)}</option>)}</select></label><Button disabled={busy||!selected} onClick={prepare}>{busy?'Preparing…':'Get booking link'}</Button>
      {link&&<div className="fl-content-link"><input aria-label="Post booking link" value={link} readOnly onFocus={e=>e.target.select()}/><Button variant="secondary" onClick={async()=>{try{await navigator.clipboard.writeText(link);setCopied(true);}catch{setError('Select the link and copy it to your clipboard.');}}}>{copied?'Copied':'Copy link'}</Button><p>Use this link in your bio, a Story link sticker or your campaign. A link in an Instagram caption is not clickable.</p></div>}
    </div>
    {!data&&!error&&<p role="status">Loading booking results…</p>}
    {data&&<><p className="fl-studio-note">{data.explanation}</p>
      {!data.campaigns.length?<p>No links measured yet. Choose a saved post above to get started.</p>:<div className="fl-result-list">{data.campaigns.map(r=><article key={r.campaign_id}><h3>{r.caption||'Deleted post'}</h3><div className="fl-result-detail"><span><strong>{r.confirmed}</strong> confirmed</span><span><strong>{r.pending}</strong> awaiting payment</span><span><strong>{r.cancelled}</strong> cancelled, moved or missed</span><span><strong>{money(r.booking_value_cents)}</strong> booked value</span></div>{r.url&&r.post_id&&<button className="fl-result-link" onClick={()=>{setLink(r.url);setSelected(r.post_id);setCopied(false);}}>Show this booking link</button>}</article>)}</div>}
    </>}
  </section>;
}
