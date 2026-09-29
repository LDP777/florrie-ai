import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import { contentRequest } from '../lib/content-workflow.js';
import Button from './ui/Button.jsx';
import Icon from './ui/Icon.jsx';

export default function ContentResults({ ownerId, posts=[], initialPostId='' }) {
  const [data,setData]=useState(null),[error,setError]=useState(''),[selected,setSelected]=useState(initialPostId || ''),[link,setLink]=useState(''),[busy,setBusy]=useState(false),[copied,setCopied]=useState(false);
  const generation=useRef(0),actionGeneration=useRef(0),locked=useRef(false);
  const [refreshing,setRefreshing]=useState(true),[updatedAt,setUpdatedAt]=useState(null),[loadFailed,setLoadFailed]=useState(false);
  const availablePosts=posts.filter(post=>post.post_type!=='gallery');
  const validSelected=availablePosts.some(post=>post.id===selected);
  async function request(path,options={},isCurrent=()=>true) {
    const {data}=await supabase.auth.getSession();
    if(!isCurrent()) throw new Error('Content context changed.');
    return contentRequest(`${API_BASE}/api/content${path}`,{token:data?.session?.access_token,...options});
  }
  async function load() {
    const run=++generation.current;setError('');setRefreshing(true);setLoadFailed(false);
    try {
      const d=await request('/results',{},()=>run===generation.current);
      if(run===generation.current){setData(d);setUpdatedAt(new Date().toISOString());}
    } catch(e) {if(run===generation.current){setError(e.message);setLoadFailed(true);}}
    finally {if(run===generation.current)setRefreshing(false);}
  }
  useEffect(()=>{actionGeneration.current++;locked.current=false;setBusy(false);setData(null);setUpdatedAt(null);setLink('');setSelected(initialPostId || '');load();return()=>{generation.current++;actionGeneration.current++;};},[ownerId,initialPostId]);
  useEffect(()=>{if(selected&&!validSelected){actionGeneration.current++;locked.current=false;setBusy(false);setSelected('');setLink('');setCopied(false);}},[selected,validSelected]);
  async function prepare() {
    if(locked.current||!validSelected)return;const action=++actionGeneration.current;locked.current=true;setBusy(true);setError('');setLoadFailed(false);setCopied(false);
    try{const r=await request(`/${selected}/booking-link`,{method:'POST'},()=>action===actionGeneration.current);if(action!==actionGeneration.current)return;setLink(r.url);await load();}catch(e){if(action===actionGeneration.current)setError(e.message);}finally{if(action===actionGeneration.current){locked.current=false;setBusy(false);}}
  }
  const total=key=>(data?.campaigns||[]).reduce((n,r)=>n+Number(r[key]||0),0);
  const money=cents=>new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP'}).format(cents/100);
  return <section className="fl-content-results" aria-labelledby="content-results-title">
    <header><span className="fl-workspace-eyebrow">From interest to an appointment</span><h2 id="content-results-title">What led to a booking?</h2><p>Give a post its own booking link. See the appointments made through it.</p></header>
    <div className="fl-results-refresh"><span>{updatedAt ? <>Updated <time dateTime={updatedAt}>{new Date(updatedAt).toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</time></> : 'Your last 90 days'}</span><Button variant="quiet" disabled={refreshing||busy} onClick={load}><Icon name="refresh" size={15}/>{refreshing ? 'Refreshing…' : 'Refresh results'}</Button></div>
    {error&&<div className="fl-reputation-error" role="alert">{error}{loadFailed&&data&&<p>Your last loaded results are still shown below.</p>}<Button variant="quiet" disabled={refreshing||busy} onClick={load}>Retry results</Button></div>}
    {data&&<div className="fl-result-numbers"><div><strong>{total('confirmed')}</strong><span>Confirmed bookings</span></div><div><strong>{total('pending')}</strong><span>Awaiting payment</span></div><div><strong>{money(total('booking_value_cents'))}</strong><span>Booked appointment value</span></div></div>}
    <div className="fl-link-builder"><label>Choose a saved post<select aria-label="Results post" value={validSelected?selected:''} disabled={busy} onChange={e=>{setSelected(e.target.value);setLink('');setCopied(false);}}><option value="">Choose a post</option>{availablePosts.map(p=><option key={p.id} value={p.id}>{(p.caption||'Untitled post').slice(0,85)}</option>)}</select></label><Button disabled={busy||!validSelected} onClick={prepare}>{busy?'Preparing…':'Get booking link'}</Button>
      {link&&<div className="fl-content-link"><input aria-label="Post booking link" value={link} readOnly onFocus={e=>e.target.select()}/><Button variant="secondary" onClick={async()=>{try{await navigator.clipboard.writeText(link);setCopied(true);}catch{setError('Select the link and copy it to your clipboard.');}}}>{copied?'Copied':'Copy link'}</Button><p>Use this link in your bio, a Story link sticker or your campaign. A link in an Instagram caption is not clickable.</p></div>}
    </div>
    {!data&&!error&&<p role="status">Loading booking results…</p>}
    {data&&<><p className="fl-studio-note">{data.explanation}</p>
      {!data.campaigns.length?<p>No links measured yet. Choose a saved post above to get started.</p>:<div className="fl-result-list">{data.campaigns.map(r=><article key={r.campaign_id}><h3>{r.caption||'Deleted post'}</h3><div className="fl-result-detail"><span><strong>{r.confirmed}</strong> confirmed</span><span><strong>{r.pending}</strong> awaiting payment</span><span><strong>{r.cancelled}</strong> cancelled, moved or missed</span><span><strong>{money(r.booking_value_cents)}</strong> booked value</span></div>{r.url&&availablePosts.some(post=>post.id===r.post_id)&&<button className="fl-result-link" onClick={()=>{setLink(r.url);setSelected(r.post_id);setCopied(false);}}>Show this booking link</button>}</article>)}</div>}
    </>}
  </section>;
}
