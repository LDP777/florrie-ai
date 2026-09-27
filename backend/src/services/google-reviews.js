import { createHash, randomBytes } from 'node:crypto';
import { encrypt, decrypt } from '../lib/crypto.js';
import { signOAuthState, inspectOAuthState } from '../lib/oauth-state.js';

const SCOPE = 'https://www.googleapis.com/auth/business.manage';
export const reviewFingerprint = r => createHash('sha256').update(JSON.stringify([r.name,r.comment,r.starRating,r.updateTime,r.reviewReply || null])).digest('hex');
const problem = (message,status=503) => Object.assign(new Error(message),{status});
const locationPattern = /^accounts\/[0-9]+\/locations\/[0-9]+$/;
const reviewIdPattern = /^[a-zA-Z0-9_-]{1,200}$/;

export function createGoogleReviews({ db, fetchImpl=fetch, env=process.env }) {
  const table=()=>db.from('google_review_connections');
  const ready=()=>env.GOOGLE_REVIEWS_ENABLED==='true' && !!env.GOOGLE_REVIEWS_CLIENT_ID && !!env.GOOGLE_REVIEWS_CLIENT_SECRET
    && /^https:\/\//.test(env.GOOGLE_REVIEWS_REDIRECT_URI||'') && !!env.OAUTH_STATE_SECRET;
  // Both API hosts share this handshake secret. Their older ENCRYPTION_KEYs differ.
  const key=()=>createHash('sha256').update(`florrie.google-reviews.tokens:${env.OAUTH_STATE_SECRET}`).digest('hex');
  async function row(owner) {
    const r=await table().select('*').eq('beautician_id',owner).maybeSingle();
    if(r.error) throw problem('Google review setup could not be checked. Try again.');
    return r.data;
  }
  async function json(url,options={}) {
    let response;
    try { response=await fetchImpl(url,{...options,signal:AbortSignal.timeout(15000)}); }
    catch { throw problem(options.method==='PUT' ? 'The reply result is uncertain. Reload Google reviews before trying again.' : 'Google took too long to respond. Try again.'); }
    let body;
    try {body=await response.json();} catch {throw problem('Google returned an unreadable response. Reload reviews before retrying.');}
    if(!response.ok) throw problem(response.status===401 ? 'Reconnect Google to continue.' : response.status===403 ? 'Google has not allowed access to these reviews. Check API access and your Business Profile permissions.' : 'Google could not complete this request. Try again.',response.status===401 ? 409:503);
    return body;
  }
  async function token(owner) {
    if(!ready()) throw problem('Google review connections are not available yet. Your review request link still works.');
    const saved=await row(owner);
    if(!saved?.tokens) throw problem('Connect your Google Business Profile first.',409);
    let value;
    try {value=decrypt(saved.tokens,key());} catch {throw problem('Reconnect Google to continue.',409);}
    if(value.expires_at>Date.now()+60000) return {access:value.access_token,saved};
    if(!value.refresh_token) throw problem('Reconnect Google to continue.',409);
    const refreshed=await json('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:env.GOOGLE_REVIEWS_CLIENT_ID,client_secret:env.GOOGLE_REVIEWS_CLIENT_SECRET,refresh_token:value.refresh_token,grant_type:'refresh_token'})});
    if(!refreshed.access_token || !Number.isFinite(refreshed.expires_in)) throw problem('Reconnect Google to continue.',409);
    const sealed=encrypt({...value,access_token:refreshed.access_token,expires_at:Date.now()+refreshed.expires_in*1000},key());
    const write=await table().update({tokens:sealed,updated_at:new Date().toISOString()}).eq('beautician_id',owner).eq('tokens',saved.tokens).select('beautician_id');
    if(write.error || !write.data?.length) throw problem('The Google connection changed. Reload before continuing.',409);
    return {access:refreshed.access_token,saved};
  }
  const auth = access => ({headers:{Authorization:`Bearer ${access}`}});
  async function paged(url,field,access) {
    let cursor,items=[];
    for(let page=0;page<10;page++) {
      const next=new URL(url); if(cursor) next.searchParams.set('pageToken',cursor);
      const body=await json(next.href,auth(access));
      if(body[field]!==undefined&&!Array.isArray(body[field])) throw problem('Google returned an incomplete account list.');
      items.push(...(body[field]||[])); cursor=body.nextPageToken;
      if(!cursor) return items;
    }
    throw problem('There are too many locations to load together. Contact Florrie support to finish setup.');
  }
  async function locations(owner) {
    const {access}=await token(owner);
    const accounts=await paged('https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=20','accounts',access);
    if(accounts.length>30) throw problem('Contact Florrie support to choose from this many Google accounts.');
    const found=[];
    for(const account of accounts) {
      if(!/^accounts\/[0-9]+$/.test(account.name)) continue;
      const list=await paged(`https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations?readMask=name,title,storefrontAddress&pageSize=100`,'locations',access);
      for(const item of list) if(/^locations\/[0-9]+$/.test(item.name)) found.push({name:`${account.name}/${item.name}`,title:item.title || 'Business profile',address:(item.storefrontAddress?.addressLines||[]).join(', ')});
    }
    return found;
  }
  async function context(owner) {
    const {access,saved}=await token(owner);
    if(!locationPattern.test(saved.location_name||'')) throw problem('Choose your Google Business Profile first.',409);
    return {access,location:saved.location_name};
  }
  async function review(owner,id) {
    if(!reviewIdPattern.test(id||'')) throw problem('Choose a Google review.',400);
    const {access,location}=await context(owner);
    const name=`${location}/reviews/${id}`;
    const result=await json(`https://mybusiness.googleapis.com/v4/${name}`,auth(access));
    if(result.name!==name) throw problem('Google returned a different review. Reload before replying.');
    return {review:result,access,name};
  }
  return {
    ready,
    async status(owner) {
      if(!ready()) return {available:false,connected:false,reason:'Google review connections are awaiting setup. You can still use your Google review request link.'};
      const saved=await row(owner);
      const status={available:true,connected:!!saved?.tokens,location:saved?.location_name?{name:saved.location_name,title:'Your Google Business Profile'}:null};
      if(saved?.tokens && locationPattern.test(saved.location_name||'')) {
        try {
          const {access}=await token(owner);
          const location=await json(`https://mybusinessbusinessinformation.googleapis.com/v1/${saved.location_name.split('/').slice(2).join('/')}?readMask=title`,auth(access));
          if(typeof location.title==='string') status.location.title=location.title;
        } catch { status.check_error='The saved Google connection could not be verified. Refresh or reconnect.'; }
      }
      return status;
    },
    async connect(owner,native=false) {
      if(!ready()) throw problem('Google review connections are not available yet.');
      const nonce=randomBytes(24).toString('hex');
      const written=await table().upsert({beautician_id:owner,oauth_nonce:nonce,oauth_expires_at:new Date(Date.now()+600000).toISOString()},{onConflict:'beautician_id'});
      if(written.error) throw problem('Could not start Google setup. Try again.');
      const state=signOAuthState({beauticianId:owner,purpose:'google-reviews',nonce,native});
      const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
      for(const [k,v] of Object.entries({client_id:env.GOOGLE_REVIEWS_CLIENT_ID,redirect_uri:env.GOOGLE_REVIEWS_REDIRECT_URI,response_type:'code',scope:SCOPE,access_type:'offline',prompt:'consent',state})) url.searchParams.set(k,v);
      return url.href;
    },
    async callback(code,state) {
      if(!ready()) throw problem('Google connection setup is unavailable.');
      const checked=inspectOAuthState(state);
      if(!checked.ok || checked.payload.purpose!=='google-reviews' || !checked.payload.nonce || !code || typeof code!=='string') throw problem('This Google sign-in expired. Start again in Florrie.',400);
      const {beauticianId:owner,nonce,native}=checked.payload;
      const used=`used:${nonce}`;
      const consumed=await table().update({oauth_nonce:used}).eq('beautician_id',owner).eq('oauth_nonce',nonce).gt('oauth_expires_at',new Date().toISOString()).select('beautician_id');
      if(consumed.error || consumed.data?.length!==1) throw problem('This Google sign-in was already used or expired.',409);
      const value=await json('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,client_id:env.GOOGLE_REVIEWS_CLIENT_ID,client_secret:env.GOOGLE_REVIEWS_CLIENT_SECRET,redirect_uri:env.GOOGLE_REVIEWS_REDIRECT_URI,grant_type:'authorization_code'})});
      if(!value.access_token || !value.refresh_token || !Number.isFinite(value.expires_in) || !String(value.scope||'').split(' ').includes(SCOPE)) throw problem('Google did not grant review access. Reconnect and allow Business Profile access.',409);
      const saved=await table().update({tokens:encrypt({...value,expires_at:Date.now()+value.expires_in*1000},key()),location_name:null,location_title:null,oauth_nonce:null,oauth_expires_at:null,updated_at:new Date().toISOString()}).eq('beautician_id',owner).eq('oauth_nonce',used).select('beautician_id');
      if(saved.error || saved.data?.length!==1) throw problem('Google access was not saved. Start again from Florrie.',409);
      return {native};
    },
    locations,
    async selectLocation(owner,name) {
      if(!locationPattern.test(name||'')) throw problem('Choose a business from your Google account.',400);
      const selected=(await locations(owner)).find(l=>l.name===name);
      if(!selected) throw problem('This business is not available in your connected Google account.',403);
      const saved=await table().update({location_name:name,location_title:null,updated_at:new Date().toISOString()}).eq('beautician_id',owner).select('beautician_id');
      if(saved.error || !saved.data?.length) throw problem('Could not save your business selection.');
      return selected;
    },
    async list(owner,cursor) {
      if(cursor && (typeof cursor!=='string'||cursor.length>2000)) throw problem('Reload reviews to continue.',400);
      const {access,location}=await context(owner);
      const url=new URL(`https://mybusiness.googleapis.com/v4/${location}/reviews`);
      url.searchParams.set('pageSize','25');url.searchParams.set('orderBy','updateTime desc');if(cursor)url.searchParams.set('pageToken',cursor);
      const data=await json(url.href,auth(access));
      if(data.reviews!==undefined&&!Array.isArray(data.reviews)) throw problem('Google returned an incomplete review list.');
      // Google content is read live, never saved, indexed or used to train Florrie.
      return {...data,reviews:(data.reviews||[]).map(r=>({...r,fingerprint:reviewFingerprint(r)})),fetched_at:new Date().toISOString()};
    },
    review,
    async reply(owner,id,text,fingerprint,approved) {
      if(approved!==true || typeof text!=='string' || !text.trim() || text.length>4096) throw problem('Review the reply and approve it before publishing.',400);
      const current=await review(owner,id);
      if(current.review.reviewReply?.comment===text.trim()) return {reply:current.review.reviewReply,already_posted:true};
      if(fingerprint!==reviewFingerprint(current.review)) throw problem('This review or its reply changed on Google. Reload and review it again.',409);
      const result=await json(`https://mybusiness.googleapis.com/v4/${current.name}/reply`,{...auth(current.access),method:'PUT',headers:{...auth(current.access).headers,'Content-Type':'application/json'},body:JSON.stringify({comment:text.trim()})});
      if(result.comment!==text.trim()) throw problem('Google has not confirmed this reply. Reload reviews to check.');
      return {reply:result};
    },
    async disconnect(owner) {
      const r=await table().delete().eq('beautician_id',owner);
      if(r.error) throw problem('Could not disconnect Google. Try again.');
      // Local disconnect does not revoke other Google products using the account.
      return {disconnected:true};
    },
  };
}
