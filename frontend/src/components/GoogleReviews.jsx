import { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import { contentRequest } from '../lib/content-workflow.js';
import Button from './ui/Button.jsx';
import Icon from './ui/Icon.jsx';

export default function GoogleReviews({ ownerId }) {
  const [status,setStatus]=useState(null),[data,setData]=useState(null),[locations,setLocations]=useState([]);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[editor,setEditor]=useState(null);
  const generation=useRef(0),locked=useRef(false);
  async function request(path,options={}) {
    const {data}=await supabase.auth.getSession();
    return contentRequest(`${API_BASE}/api/google-reviews${path}`,{token:data?.session?.access_token,...options});
  }
  async function load() {
    const run=++generation.current; setError('');
    try {
      const s=await request('/status');if(run!==generation.current)return;setStatus(s);if(s.check_error)setError(s.check_error);
      if(s.connected&&s.location) {const d=await request('/reviews');if(run===generation.current)setData(d);}
      else {setData(null);if(s.connected){const l=await request('/locations');if(run===generation.current)setLocations(l.locations||[]);}}
    }catch(e){if(run===generation.current)setError(e.message);}
  }
  useEffect(()=>{setStatus(null);setData(null);setEditor(null);load();return()=>{generation.current++;};},[ownerId]);
  useEffect(()=>{
    if(!Capacitor.isNativePlatform())return;
    let disposed=false,handle;
    import('@capacitor/browser').then(({Browser})=>Browser.addListener('browserFinished',()=>load())).then(h=>{if(disposed)h.remove();else handle=h;});
    return()=>{disposed=true;handle?.remove();};
  },[ownerId]);
  async function act(fn) {
    if(locked.current)return;locked.current=true;setBusy(true);setError('');
    try{await fn();}catch(e){setError(e.message);}finally{locked.current=false;setBusy(false);}
  }
  async function connect() {
    const native=Capacitor.isNativePlatform();
    const {url}=await request(`/connect${native?'?platform=native':''}`);
    const parsed=new URL(url);
    if(parsed.origin!=='https://accounts.google.com'||parsed.pathname!=='/o/oauth2/v2/auth'||parsed.username||parsed.password)throw new Error('Could not open a verified Google connection link.');
    if(native){const {Browser}=await import('@capacitor/browser');await Browser.open({url});}
    else window.location.assign(url);
  }
  return <section className="fl-reputation-panel" aria-labelledby="google-reviews-title">
    <div className="fl-reputation-heading"><div><span className="fl-workspace-eyebrow">Your public reputation</span><h2 id="google-reviews-title">Google reviews</h2><p>{status?.location?.title||'Read the feedback. Choose your words. Approve each reply.'}</p></div><Icon name="star" size={25}/></div>
    {error&&<div className="fl-reputation-error" role="alert">{error}<Button variant="quiet" onClick={load} disabled={busy}>Retry</Button></div>}
    {!status&&!error&&<p role="status">Checking Google connection…</p>}
    {status?.available===false&&<p className="fl-studio-note">Google imports and replies are awaiting connection setup. Your review request link below still works.</p>}
    {status?.available&&!status.connected&&<><p>Connect the Google account that manages your salon, then choose its Business Profile.</p><Button disabled={busy} onClick={()=>act(connect)}>Connect Google Business Profile</Button></>}
    {status?.connected&&!status.location&&<div className="fl-reputation-locations"><p>Choose the business whose reviews you want to manage.</p>{locations.map(l=><button key={l.name} disabled={busy} onClick={()=>act(async()=>{await request('/location',{method:'POST',body:{name:l.name}});await load();})}><strong>{l.title}</strong><small>{l.address}</small></button>)}{!locations.length&&!error&&<p>No locations loaded. Check that this Google account manages your salon.</p>}</div>}
    {status?.connected&&<div className="fl-studio-actions"><Button variant="quiet" disabled={busy} onClick={load}>Refresh from Google</Button><Button variant="quiet" disabled={busy} onClick={()=>act(connect)}>Reconnect Google</Button><Button variant="quiet" disabled={busy} onClick={()=>act(async()=>{await request('/disconnect',{method:'POST'});setEditor(null);await load();})}>Disconnect reviews</Button></div>}
    {data&&<>
      <p className="fl-studio-note">Read from Google {new Date(data.fetched_at).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}. Review text stays separate from your Florrie training notes and marketing posts.</p>
      {!data.reviews?.length&&<p>No Google reviews found for this business.</p>}
      {(data.reviews||[]).map(review=>{
        const id=review.reviewId||review.name?.split('/').pop();
        return <article className="fl-google-imported-review" key={review.name||id}>
          <div className="fl-review-byline"><strong>{review.reviewer?.displayName||'Google reviewer'}</strong><span>{({ONE:1,TWO:2,THREE:3,FOUR:4,FIVE:5})[review.starRating]||'Unrated'} / 5</span></div>
          <p className="fl-review-quote">{review.comment||'This review contains a rating only.'}</p>
          {review.reviewReply&&<div className="fl-review-existing"><strong>Reply on Google</strong><p>{review.reviewReply.comment}</p></div>}
          {editor?.id===id?<div className="fl-review-editor">
            <label>Review your reply<textarea aria-label="Google review reply" rows={4} maxLength={4096} value={editor.text} disabled={busy} onChange={e=>setEditor({...editor,text:e.target.value,approved:false})}/></label>
            <label className="fl-review-consent"><input type="checkbox" checked={editor.approved} disabled={busy} onChange={e=>setEditor({...editor,approved:e.target.checked})}/> I approve these exact words as a public reply on Google.</label>
            <div className="fl-studio-actions"><Button disabled={busy||!editor.approved||!editor.text.trim()} onClick={()=>act(async()=>{await request(`/reviews/${encodeURIComponent(id)}/reply`,{method:'POST',body:{text:editor.text,fingerprint:editor.fingerprint,approved:true}});setEditor(null);await load();})}>{busy?'Working…':'Approve & publish reply'}</Button><Button variant="quiet" disabled={busy} onClick={()=>setEditor(null)}>Cancel</Button></div>
          </div>:<div className="fl-studio-actions"><Button variant="secondary" disabled={busy} onClick={()=>act(async()=>{const r=await request(`/reviews/${encodeURIComponent(id)}/draft`,{method:'POST'});setEditor({id,text:r.draft,fingerprint:r.fingerprint,approved:false});})}>Draft a reply</Button><Button variant="quiet" disabled={busy} onClick={()=>setEditor({id,text:review.reviewReply?.comment||'',fingerprint:review.fingerprint,approved:false})}>Write my own</Button></div>}
        </article>;
      })}
      {data.nextPageToken&&<Button variant="secondary" disabled={busy} onClick={()=>act(async()=>{const next=await request(`/reviews?cursor=${encodeURIComponent(data.nextPageToken)}`);setData({...next,reviews:[...new Map([...data.reviews,...next.reviews].map(r=>[r.name,r])).values()]});})}>Load more Google reviews</Button>}
    </>}
  </section>;
}
