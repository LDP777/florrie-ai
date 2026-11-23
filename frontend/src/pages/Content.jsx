import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import { isIOSNative } from '../lib/platform.js';
import { contentRequest } from '../lib/content-workflow.js';
import { contentV2Destination, readContentHandoff } from '../lib/content-navigation.js';
import { uploadFile, objectPath, publicUrl, PUBLIC_BUCKET } from '../lib/storage.js';
import { shareContentImage } from '../lib/content-share.js';
import { useClientPrivacy } from '../contexts/ClientPrivacyContext.jsx';
import Button from '../components/ui/Button.jsx';
import Icon from '../components/ui/Icon.jsx';
import ContentHome from '../components/content/ContentHome.jsx';
import ContentReviewDeck from '../components/content/ContentReviewDeck.jsx';
import ContentSheet from '../components/content/ContentSheet.jsx';
import { ChangeSheet, TimeSheet, ItemSheet, PostYourselfSheet, PhotosSheet, OffersSheet, VoiceSheet, ConnectionsSheet, ResultsSheet, PastPostsSheet } from '../components/content/ContentSheets.jsx';
import { asArray, needsChecking, postImage, postTitle, readLocal, saveLocal } from '../components/content/content-view.js';

export default function Content({ owner, authId }) { return owner && authId ? <ContentForOwner key={`${owner.id}:${authId}`} owner={owner} authId={authId}/> : <p role="status">Loading your content...</p>; }
function ContentForOwner({ owner, authId }) {
  const { hidden } = useClientPrivacy(), navigate=useNavigate(), location=useLocation();
  const [home,setHome]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[busy,setBusy]=useState(false),[cache,setCache]=useState({});
  const [deck,setDeck]=useState(null),[editing,setEditing]=useState(false),[sheet,setSheet]=useState(null),[sheetData,setSheetData]=useState(null),[sheetLoading,setSheetLoading]=useState(false),[sheetError,setSheetError]=useState('');
  const [toast,setToast]=useState(null),[announcement,setAnnouncement]=useState('');
  const privacy=useRef(hidden);privacy.current=hidden;
  const active=useRef(true),epoch=useRef(0),locked=useRef(false),loads=useRef(0),sheetGeneration=useRef(0),handoff=useRef(''),toastTimer=useRef(null),latestHome=useRef(null);
  const deckKey=`florrie:content-v2:deck:${owner.id}`,pendingKey=`florrie:content-v2:preparation:${owner.id}`;
  const notify=useCallback((message,action=null)=>{if(privacy.current)return;setToast({message,action});setAnnouncement(message);clearTimeout(toastTimer.current);toastTimer.current=setTimeout(()=>setToast(null),7500);},[]);
  const request=useCallback(async (path,options={},external=false)=>{
    const generation=epoch.current;
    let timer;
    const auth=await Promise.race([supabase.auth.getSession(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Your sign-in check is taking too long. Please try again.')),10000);})]).finally(()=>clearTimeout(timer));
    if (!active.current || generation!==epoch.current) throw new Error('Your account changed. Reopen Content.');
    if(auth.error||!auth.data?.session?.access_token||auth.data.session.user?.id!==authId)throw new Error('Sign in again to open your saved content.');
    const result=await contentRequest(`${API_BASE}${external?path:`/api/content/v2${path}`}`,{token:auth.data.session.access_token,...options});
    if (!active.current || generation!==epoch.current) throw new Error('Your account changed. Reopen Content.');
    return result;
  },[authId]);
  function remember(post){if(post?.id)setCache(previous=>({...previous,[post.id]:post}));return post;}
  function rememberHome(data){const posts=[...asArray(data.posts_to_check),...asArray(data.coming_up),...asArray(data.reel_plans)];setCache(previous=>({...previous,...Object.fromEntries(posts.map(post=>[post.id,post]))}));latestHome.current=data;setHome(data);}
  const refresh=useCallback(async(showLoading=false)=>{const seq=++loads.current;if(showLoading)setLoading(true);try{const data=await request('/home',{timeoutMs:25000});if(!Array.isArray(data.posts_to_check)||!Array.isArray(data.coming_up))throw new Error("Florrie couldn't load your saved posts. Try again.");if(Number(data.counts?.total)===0){try{data.first_photos=await request('/photos');}catch{data.first_photos=null;}}if(active.current&&seq===loads.current){rememberHome(data);setError('');}}catch(err){if(active.current&&seq===loads.current)setError(err.message);}finally{if(active.current&&seq===loads.current)setLoading(false);}},[request]);
  useEffect(()=>{active.current=true;refresh(true);const subscription=supabase.auth.onAuthStateChange?.((event,session)=>{if(event==='SIGNED_OUT'||session?.user?.id&&session.user.id!==authId){epoch.current++;setHome(null);setCache({});setDeck(null);setSheet(null);setError('Your account changed. Reopen Content for your signed-in salon.');}});return()=>{active.current=false;epoch.current++;clearTimeout(toastTimer.current);subscription?.data?.subscription?.unsubscribe();};},[refresh,authId]);
  useEffect(()=>{const visible=()=>{if(document.visibilityState==='visible')refresh();};document.addEventListener('visibilitychange',visible);const timer=setInterval(async()=>{if(document.visibilityState!=='visible')return;const data=latestHome.current;if(['queued','running'].includes(data?.preparation?.status)){try{const preparation=await request(`/preparations/${data.preparation.id}`,{timeoutMs:12000});if(active.current){setHome(old=>({...old,preparation}));latestHome.current={...latestHome.current,preparation};if(['done','failed'].includes(preparation.status))refresh();}}catch(err){if(active.current)setError(err.message);}}else if(asArray(data?.coming_up).some(post=>post.state==='Posting'||post.state==='publishing'))refresh();},2500);return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',visible);};},[request,refresh]);
  useEffect(()=>{if(hidden){setDeck(null);setSheet(null);setEditing(false);setToast(null);setAnnouncement('Client details hidden.');}},[hidden]);
  function persistDeck(value){setDeck(value);saveLocal(deckKey,value);}
  function closeDeck(){setDeck(null);setEditing(false);if(deck?.index>=deck?.ids.length)saveLocal(deckKey,null);refresh();}
  function openDeck(first=null){if(hidden)return;const ids=asArray(latestHome.current?.posts_to_check).map(post=>post.id);if(first&&!ids.includes(first))ids.unshift(first);if(!ids.length)return;persistDeck({ids,index:Math.max(0,first?ids.indexOf(first):0),approved:[]});setSheet(null);}
  async function openPost(id){try{const result=await request(`/posts/${id}`);const post=remember(result.post||result);if(needsChecking(post))openDeck(post.id);else{setSheet({type:'item',postId:post.id});setSheetError('');}}catch(err){notify(err.message);}}
  async function prepare(requestValue,askText=null){if(hidden||locked.current)return false;locked.current=true;setBusy(true);setError('');let pending=readLocal(pendingKey);const same=pending&&JSON.stringify(pending.request)===JSON.stringify(requestValue)&&pending.text===askText;if(!same)pending={request_id:crypto.randomUUID(),request:requestValue,text:askText};saveLocal(pendingKey,pending);try{const data=await request(askText?'/ask':'/preparations',{method:'POST',body:askText?{request_id:pending.request_id,text:askText}:{request_id:pending.request_id,request:requestValue}});saveLocal(pendingKey,null);if(data.needs==='photos'){openSheet('photos',{picking:true});return true;}setHome(previous=>({...previous,preparation:data}));latestHome.current={...latestHome.current,preparation:data};setSheet(null);refresh();return true;}catch(err){if(err.status===409){const running=err.data?.preparation||err.data?.running;if(running){setHome(previous=>({...previous,preparation:running}));latestHome.current={...latestHome.current,preparation:running};saveLocal(pendingKey,null);}refresh();}setError(err.message);return false;}finally{locked.current=false;setBusy(false);}}
  useEffect(()=>{if(!home||hidden)return;const key=`${location.key}:${location.search}`;if(handoff.current===key)return;handoff.current=key;const input=readContentHandoff(location.state,location.search),destination=contentV2Destination(input,home.posts_to_check);
    if(input.postId){openPost(input.postId);return;}
    if(destination.preparation){prepare(destination.preparation);navigate(location.pathname,{replace:true,state:null});return;}
    if(destination.sheet){openSheet(destination.sheet);return;}
    if(destination.deck){openDeck();return;}
    const saved=readLocal(deckKey);if(saved?.ids?.length&&Number.isInteger(saved.index)&&saved.index<saved.ids.length){const existing=new Set([...home.posts_to_check,...home.coming_up].map(post=>post.id));if(existing.has(saved.ids[saved.index]))setDeck(saved);else saveLocal(deckKey,null);}
  },[home!==null,location.key,hidden]);
  async function mutate(post,action,body={}){if(hidden||locked.current)return null;locked.current=true;setBusy(true);try{const data=await request(`/posts/${post.id}${action&&action!=='delete'?`/${action}`:''}`,{method:action==='delete'?'DELETE':action?'POST':'PATCH',body});const updated=remember(data.post||data);refresh();return {...data,post:updated};}catch(err){notify(err.message);if(err.status===409){try{const data=await request(`/posts/${post.id}`);remember(data.post||data);}catch{/* Keep the prior post visible until a fresh read succeeds. */}refresh();}return null;}finally{locked.current=false;setBusy(false);}}
  async function revise(post,instruction){const data=await mutate(post,'revise',{instruction});if(data){setSheet(null);notify(data.note || 'Your change is saved.',{label:'Undo',run:()=>undo(data.post)});}return data?.post;}
  async function undo(post){const data=await mutate(post,'undo');if(data)notify('Change undone.');}
  async function approve(post){const data=await mutate(post,'approve',{expected_hash:post.material_hash});if(data?.learned_rules?.length){const rule=data.learned_rules[0];notify(rule.kind==='replace'?`Noted. Next time Florrie will write "${rule.to_text}" instead of "${rule.from_text}".`:'Noted. Florrie will use this writing style next time.',{label:'Undo',run:()=>forgetRule(rule.id)});}else if(data?.note)notify(data.note);return data?.post;}
  async function deletePost(post,advance=false){const data=await mutate(post,'delete');if(data){setSheet(null);if(advance)persistDeck({...deck,index:deck.index+1});notify('Post set aside.',{label:'Undo',run:async()=>{const result=await mutate(post,'restore');if(result)notify('Post restored.');}});}return data;}
  async function saveCaption(post,caption,expected_version,hashtags){const data=await request(`/posts/${post.id}`,{method:'PATCH',body:{caption,expected_version,hashtags},keepalive:document.visibilityState==='hidden'}).catch(async err=>{if(err.status===409){const latest=await request(`/posts/${post.id}`);remember(latest.post||latest);}throw err;});const updated=remember(data.post||data);return updated;}
  async function setTime(post,at){const data=await mutate(post,'timing',{at});if(data){setSheet(null);notify('Time changed. Your approval still stands.');}}
  async function openSheet(type,extra={}){setSheet({type,...extra});setSheetData(null);setSheetError('');const route={photos:'/photos',offers:'/offers',voice:'/voice',results:'/results?days=30',past:'/posts?status=posted'}[type];if(!route)return;const generation=++sheetGeneration.current;setSheetLoading(true);try{const data=await request(route);if(generation===sheetGeneration.current)setSheetData(data);}catch(err){if(generation===sheetGeneration.current)setSheetError(err.message);}finally{if(generation===sheetGeneration.current)setSheetLoading(false);}}
  function closeSheet(){sheetGeneration.current++;setSheet(null);setSheetError('');}
  async function copy(text){try{await navigator.clipboard.writeText(text);notify('Copied.');}catch{notify("Couldn't copy it. Select the words and copy them yourself.");}}
  async function updatePhoto(id,changes){if(locked.current||hidden)return;locked.current=true;setBusy(true);try{await request('/photos',{method:'PATCH',body:{id,...changes}});const data=await request('/photos');setSheetData(data);refresh();}catch(err){setSheetError(err.message);notify(err.message);}finally{locked.current=false;setBusy(false);}}
  async function uploadPhotos(files){if(locked.current||hidden)return;locked.current=true;setBusy(true);setSheetError('');try{for(const file of files){if(!/^image\//.test(file.type)||file.size>20*1024*1024)throw new Error('Choose an image under 20MB.');const path=objectPath(owner.id,'gallery',`${crypto.randomUUID()}-${file.name}`);await uploadFile({bucket:PUBLIC_BUCKET,path,file});const image_url=publicUrl(path);if(!image_url)throw new Error('Could not read the saved image. Try again.');await request('/photos',{method:'POST',body:{image_url,after_url:image_url,permission_status:'pending'}});}setSheetData(await request('/photos'));refresh();}catch(err){setSheetError(err.message);}finally{locked.current=false;setBusy(false);}}
  async function forgetRule(id){try{await request(`/voice/${id}`,{method:'DELETE'});setSheetData(await request('/voice'));refresh();notify('Writing rule forgotten.');}catch(err){notify(err.message);}}
  async function connect(channel='instagram') {
    const provider=channel==='google'?'google':'instagram';
    if(locked.current)return;
    locked.current=true;setBusy(true);
    try {
      const native=isIOSNative();
      const data=await request(provider==='google'?`/api/google-reviews/connect${native?'?platform=native':''}`:`/api/instagram/connect?${native?'platform=native':'return_to=connections'}`,{},true);
      const url=new URL(data.url);
      const valid=provider==='google'?url.hostname==='accounts.google.com':url.hostname==='www.instagram.com'&&url.pathname==='/oauth/authorize';
      if(url.protocol!=='https:'||url.username||url.password||!valid)throw new Error('Could not open a verified connection link. Try again from Connections.');
      if(native){const {Browser}=await import('@capacitor/browser');await Browser.open({url:url.href});}else window.location.assign(url.href);
    } catch(err){notify(err.message);}finally{locked.current=false;setBusy(false);}
  }
  async function disconnect(channel){if(locked.current)return;locked.current=true;setBusy(true);try{await request(channel==='google'?'/api/google-reviews/disconnect':'/api/instagram/disconnect',{method:'POST'},true);refresh();notify(`${channel==='google'?'Google Business Profile':'Instagram'} disconnected.`);}catch(err){notify(err.message);}finally{locked.current=false;setBusy(false);}}
  async function share(post){try{await shareContentImage(postImage(post));}catch(err){notify(err.message);}}
  const post=sheet?.postId?cache[sheet.postId]:null;
  const sheetProps={busy,onClose:closeSheet};
  return <main className="fl-content-studio cv2-page">
    {loading&&!home?<><header className="fl-content-heading"><h1>Content</h1></header><div className="cv2-card cv2-loading" role="status">Loading your saved posts...</div></>:home?<ContentHome data={home} busy={busy} onReview={()=>openDeck()} onPrepare={()=>prepare({type:'week'})} onAsk={text=>prepare(null,text)} onIdea={idea=>idea.type==='show_work'||/show off/i.test(idea.label||'')?openSheet('photos',{picking:true}):idea.request?prepare(idea.request):prepare(null,idea.text||idea.label)} onOpen={item=>{remember(item);setSheet({type:'item',postId:item.id});}} onSheet={openSheet} onConnect={connect} onPhotoUpdate={updatePhoto} onConsent={id=>navigate(`/photo-consent?clientId=${encodeURIComponent(id)}`)}/>:null}
    {error&&<div className="cv2-error" role="alert"><p>{hidden?'Could not refresh your content.':error}</p><Button variant="secondary" onClick={()=>refresh(true)}>Try again</Button></div>}
    {deck&&!hidden&&<ContentReviewDeck posts={Object.values(cache)} ids={deck.ids} index={deck.index} approved={deck.approved||[]} owner={owner} busy={busy} onClose={closeDeck} onAdvance={item=>persistDeck({...deck,index:deck.index+1,approved:item?[...(deck.approved||[]),item]:(deck.approved||[])})} onApprove={approve} onChange={item=>setSheet({type:'change',postId:item.id})} onTime={item=>setSheet({type:'time',postId:item.id})} onRevise={revise} onUndo={undo} onDelete={deletePost} onSave={saveCaption} onConnect={connect} connected={home?.connections?.instagram?.connected&&!home?.connections?.instagram?.needs_reconnect} editing={editing} setEditing={setEditing}/>}
    {sheet&&sheetLoading?<ContentSheet title="Loading" onClose={closeSheet}><p role="status">Loading your saved details...</p></ContentSheet>:sheet&&sheetError&&!sheetData&&!post?<ContentSheet title="Couldn't load this" onClose={closeSheet}><p role="alert">{sheetError}</p><Button variant="secondary" onClick={()=>openSheet(sheet.type,sheet)}>Try again</Button></ContentSheet>:<>
      {sheet?.type==='change'&&post&&<ChangeSheet {...sheetProps} post={post} onRevise={instruction=>revise(post,instruction)} onEdit={()=>{setEditing(true);closeSheet();}} onTime={()=>setSheet({type:'time',postId:post.id})} onDelete={()=>deletePost(post,!!deck)}/>}
      {sheet?.type==='time'&&post&&<TimeSheet {...sheetProps} post={post} onTime={at=>setTime(post,at)}/>}
      {sheet?.type==='item'&&post&&<ItemSheet {...sheetProps} post={post} owner={owner} onTime={()=>setSheet({type:'time',postId:post.id})} onCopy={copy} onSelf={()=>setSheet({type:'self',postId:post.id})} onConnect={connect} onAction={async action=>{if(action==='delete')return deletePost(post);const data=await mutate(post,action);if(data){if(action==='move-back'){closeSheet();openDeck(post.id);}else notify(action==='retry'?'Florrie will check this post and try again.':'Post updated.');}}}/>}
      {sheet?.type==='self'&&post&&<PostYourselfSheet {...sheetProps} post={post} onShare={()=>share(post)} onCopy={copy} onPosted={async()=>{const data=await mutate(post,'posted-by-owner');if(data){setSheet({type:'item',postId:post.id});notify('Marked as posted by you.');}}}/>}
      {sheet?.type==='photos'&&<PhotosSheet {...sheetProps} data={sheetData} picking={sheet.picking} onUpload={uploadPhotos} onUpdate={updatePhoto} onConsent={id=>navigate(`/photo-consent?clientId=${encodeURIComponent(id)}`)} onPrepare={photo_ids=>prepare({type:'show_work',photo_ids})}/>}
      {sheet?.type==='offers'&&<OffersSheet {...sheetProps} data={sheetData}/>}
      {sheet?.type==='voice'&&<VoiceSheet {...sheetProps} data={sheetData} onForget={forgetRule}/>}
      {sheet?.type==='connections'&&<ConnectionsSheet {...sheetProps} connections={home?.connections} onConnect={connect} onDisconnect={disconnect}/>}
      {sheet?.type==='results'&&<ResultsSheet {...sheetProps} data={sheetData} onPost={openPost}/>}
      {sheet?.type==='past'&&<PastPostsSheet {...sheetProps} data={sheetData} onOpen={item=>{remember(item);setSheet({type:'item',postId:item.id});}}/>}
    </>}
    {sheetError&&(sheetData||post)&&<div className="cv2-toast cv2-error-toast"><span>{hidden?'Could not save this change.':sheetError}</span><Button variant="quiet" onClick={()=>setSheetError('')} aria-label="Dismiss error"><Icon name="x" size={18}/></Button></div>}
    {toast&&<div className="cv2-toast"><span>{toast.message}</span>{toast.action&&<Button variant="quiet" onClick={()=>{const action=toast.action;setToast(null);action.run();}}>{toast.action.label}</Button>}</div>}
    <span className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</span>
  </main>;
}
