import Button from './ui/Button.jsx';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import { contentRequest } from '../lib/content-workflow.js';
import { PrivateText, PrivateSection } from '../contexts/ClientPrivacyContext.jsx';

const labels = {scheduled:'Scheduled',processing:'Sending',approval:'Needs approval',sent:'Sent',held:'Not sent',unconfirmed:'Check send result',legacy:'Earlier request'};
const reasons = {
  quiet_hours:'Waiting until daytime.', no_consent:'No permission for review requests is recorded.', opted_out:'This client has opted out.',
  autonomy_off:'Review requests are switched off.', salon_paused:'Client messages are paused.',
  frequency_cap:'A recent message or approval is already recorded.', frequency:'A recent message or approval is already recorded.',
  monthly_cap:'This client has reached the monthly message limit.', allowance_reserved:'The remaining allowance is reserved for booking messages.',
  expired:'The request expired. It will not send.', visit_not_eligible:'The visit changed or is no longer eligible.',
  no_contact:'No usable contact details for their preferred channel.', channel_window_closed:'The messaging window has closed. Review the conversation before contacting them.',
  approval_save_failed:'The approval could not be saved. Nothing was sent.',
};
export function reviewRequestDescription(row) {
  if (row.state === 'sent') return 'The provider accepted the message. This does not confirm it was read.';
  if (row.state === 'approval') return 'Review the message in Outbox before it sends.';
  if (row.state === 'unconfirmed') return 'The send result is uncertain. Check the conversation before sending another request.';
  if (row.state === 'processing') return 'Florrie is checking and sending this request.';
  if (row.state === 'legacy') return 'An older request without a complete send record. It will not be retried automatically.';
  if (reasons[row.reason]) return reasons[row.reason];
  return row.state === 'scheduled' ? 'Eligible two hours after you mark the visit complete. Sending checks still apply.' : 'Sending checks did not pass. Open the conversation to review it.';
}
export default function ReviewRequests({ ownerId }) {
  const [state,setState] = useState({status:'loading',requests:[]});
  const [refresh,setRefresh] = useState(0);
  const [expanded,setExpanded] = useState(false);
  useEffect(() => {
    let active = true;
    let timer;
    setState({status:'loading',requests:[]});
    (async()=>{
      try {
        const session = await Promise.race([supabase.auth.getSession(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Sign-in is taking too long. Try again.')),10000);})]);
        clearTimeout(timer);
        if (!active) return;
        if (session.error) throw new Error('Sign in again to see review requests.');
        const result = await contentRequest(`${API_BASE}/api/google-reviews/requests`,{token:session.data?.session?.access_token,timeoutMs:15000});
        if (!Array.isArray(result.requests)) throw new Error('Review requests could not be loaded.');
        if (active) setState({status:'ready',requests:result.requests});
      } catch(error) { if(active)setState({status:'error',requests:[],error:error.message}); }
      finally { clearTimeout(timer); }
    })();
    return ()=>{active=false;clearTimeout(timer);};
  },[ownerId,refresh]);
  const panel = {margin:'16px 20px',padding:18,border:'1px solid var(--border, #eaded6)',borderRadius:20,background:'var(--surface, #fffaf7)'};
  const link = {color:'var(--accent, #92405e)',fontSize:13,fontWeight:600};
  return <section aria-label="Review request activity" style={panel}>
    <div style={{display:'flex',gap:12,justifyContent:'space-between',alignItems:'baseline'}}>
      <h2 style={{fontSize:20,margin:0}}>Review requests</h2>
      <Button variant="quiet" size="sm" style={link} disabled={state.status==='loading'} onClick={()=>setRefresh(n=>n+1)}>Refresh</Button>
    </div>
    <p style={{fontSize:13,lineHeight:1.55,color:'var(--text-muted)',margin:'8px 0 14px'}}>After you mark a visit complete, Florrie checks consent and your sending preferences. Your saved Google review link works without connecting Google.</p>
    {state.status==='loading' && <p role="status">Checking recent requests…</p>}
    {state.status==='error' && <p role="alert" style={{fontSize:13}}>{state.error} Use Refresh to try again.</p>}
    {state.status==='ready' && !state.requests.length && <p style={{fontSize:13,color:'var(--text-muted)'}}>No review requests yet. New eligible visits will appear here when you mark them complete.</p>}
    {(expanded?state.requests:state.requests.slice(0,4)).map(row=><article key={row.id} style={{padding:'13px 0',borderTop:'1px solid var(--border, #eaded6)'}}>
      <div style={{display:'flex',gap:12,justifyContent:'space-between',flexWrap:'wrap'}}>
        <strong style={{fontSize:14}}><PrivateText>{row.client_name}</PrivateText></strong>
        <span style={{fontSize:12,color:'var(--accent, #92405e)',fontWeight:600}}>{labels[row.state] || 'Check request'}</span>
      </div>
      <p style={{fontSize:12,lineHeight:1.5,color:'var(--text-muted)',margin:'6px 0'}}>{reviewRequestDescription(row)}</p>
      {row.state==='scheduled' && row.send_at && <p style={{fontSize:12,margin:'4px 0 8px'}}>Next check: {new Date(row.send_at).toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</p>}
      <PrivateSection placeholder="Show client details to open this request.">
        {row.state==='approval' ? <Link style={link} to="/outbox">Review in Outbox →</Link> : row.client_id && <Link style={link} to={`/inbox?client=${encodeURIComponent(row.client_id)}`}>Open conversation →</Link>}
      </PrivateSection>
    </article>)}
    {state.requests.length>4 && <Button variant="quiet" size="sm" style={link} onClick={()=>setExpanded(v=>!v)}>{expanded?'Show fewer':'Show recent requests'}</Button>}
  </section>;
}
