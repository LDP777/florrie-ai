import { useEffect, useRef, useState } from 'react';
import Button from '../ui/Button.jsx';
import { parseHashtags } from '../../lib/content-workflow.js';
import Icon from '../ui/Icon.jsx';
import { useClientPrivacy } from '../../contexts/ClientPrivacyContext.jsx';
import { ContentDialog } from './ContentSheet.jsx';
import ContentPostPreview, { FactsCard } from './ContentPostPreview.jsx';
import { asArray,isBlocked,postTime,postTitle,readLocal,saveLocal,when } from './content-view.js';

function CaptionEditor({ post, ownerId, onSave, onReady }) {
  const key = `florrie:content-v2:edit:${ownerId}:${post.id}:${post.version}`;
  const latestKey = `florrie:content-v2:edit:${ownerId}:${post.id}:latest`;
  const recovered = readLocal(latestKey) || readLocal(key);
  const initial = recovered?.text ?? post.caption ?? '';
  const initialTags = recovered?.hashtags ?? asArray(post.hashtags).join(' ');
  const tagsFromText = value => parseHashtags(value.split(/\s+/).filter(Boolean).map(tag => tag.startsWith('#') ? tag : `#${tag}`).join(' '));
  const [text,setText] = useState(initial), [hashtags,setHashtags] = useState(initialTags);
  const [state,setState] = useState('Saved'), [error,setError] = useState('');
  const current = useRef({text:initial,hashtags:initialTags,caption:post.caption,savedTags:JSON.stringify(asArray(post.hashtags)),version:post.version,key});
  const saving = useRef(null), blocked = useRef(false), mounted = useRef(true), textRef = useRef(null);
  const saveRef = useRef(onSave); saveRef.current = onSave;
  async function flush() {
    if (blocked.current) throw new Error('Your words are kept here. Check the latest saved post, then save your edit.');
    if (saving.current) { await saving.current; return flush(); }
    const value = {...current.current};
    const tags = tagsFromText(value.hashtags);
    if (value.text === value.caption && JSON.stringify(tags) === value.savedTags) {
      saveLocal(value.key,null); saveLocal(latestKey,null); return true;
    }
    setState('Saving...'); setError('');
    saving.current = saveRef.current(value.text,value.version,tags).then(postSaved => {
      if (!postSaved) throw new Error('Could not save your words. They are still here.');
      current.current.caption = postSaved.caption;
      current.current.savedTags = JSON.stringify(asArray(postSaved.hashtags));
      current.current.version = postSaved.version;
      saveLocal(value.key,null);
      if (current.current.text === value.text && current.current.hashtags === value.hashtags) {
        saveLocal(latestKey,null); if (mounted.current) setState('Saved');
      }
      return true;
    }).catch(err => {
      blocked.current = true;
      if(mounted.current) {
        setState('Not saved');
        setError(err.status===409 ? 'This post changed elsewhere. Your words are kept here. Review the saved version before replacing it.' : err.message);
      }
      throw err;
    }).finally(()=>{saving.current=null;});
    return saving.current;
  }
  const flushRef = useRef(flush); flushRef.current=flush;
  useEffect(()=> { onReady(() => flushRef.current()); return () => onReady(null); },[]);
  useEffect(()=>{ mounted.current=true; textRef.current?.focus(); return()=>{mounted.current=false;}; },[]);
  useEffect(()=>{
    current.current.text=text; current.current.hashtags=hashtags;
    const dirty=text!==current.current.caption || JSON.stringify(tagsFromText(hashtags))!==current.current.savedTags;
    if(dirty){
      const unsent={text,hashtags,version:current.current.version};
      saveLocal(key,unsent); saveLocal(latestKey,unsent); setState('Unsaved changes');
    }else{saveLocal(key,null);saveLocal(latestKey,null);}
    const timer=setTimeout(()=>{if(!blocked.current) flushRef.current().catch(()=>{});},350);
    return()=>clearTimeout(timer);
  },[text,hashtags]);
  useEffect(()=>{
    const flushHidden=()=>{if(document.visibilityState==='hidden') flushRef.current().catch(()=>{});};
    const flushPage=()=>flushRef.current().catch(()=>{});
    document.addEventListener('visibilitychange',flushHidden); window.addEventListener('pagehide',flushPage);
    return()=>{document.removeEventListener('visibilitychange',flushHidden);window.removeEventListener('pagehide',flushPage);};
  },[]);
  return <section className="cv2-editor">
    <label htmlFor="cv2-caption">Your caption</label>
    <textarea ref={textRef} id="cv2-caption" value={text} maxLength={2200} onChange={event=>setText(event.target.value)}/>
    <label htmlFor="cv2-hashtags">Hashtags</label>
    <input id="cv2-hashtags" value={hashtags} maxLength={400} placeholder="#brows #lashlift" onChange={event=>setHashtags(event.target.value)}/>
    <small>Separate each hashtag with a space.</small>
    <p role="status">{state}</p>
    {error && <div className="cv2-inline-error"><p>{error}</p>
      {post.version !== current.current.version && <p>Saved version: {post.caption}<br/>{asArray(post.hashtags).join(' ')}</p>}
      <Button variant="secondary" onClick={()=>{current.current.version=post.version;current.current.caption=post.caption;current.current.savedTags=JSON.stringify(asArray(post.hashtags));blocked.current=false;flushRef.current().catch(()=>{});}}>Save my words over this version</Button>
    </div>}
  </section>;
}
export default function ContentReviewDeck({ posts, ids,index,approved,owner,busy,onClose,onAdvance,onApprove,onChange,onTime,onRevise,onUndo,onDelete,onSave,onConnect,connected,editing,setEditing }) {
  const { hidden } = useClientPrivacy();
  const [justApproved,setJustApproved] = useState(false);
  const flush = useRef(null), timer=useRef(null);
  const post=posts.find(item=>item.id===ids[index]);
  const done=index>=ids.length;
  useEffect(()=>{if(hidden)onClose();},[hidden,onClose]);
  useEffect(()=>{setJustApproved(false);setEditing(false);return()=>clearTimeout(timer.current);},[post?.id]);
  if(hidden)return null;
  async function approve(){if(busy||justApproved)return;const result=await onApprove(post);if(result){setJustApproved(true);timer.current=setTimeout(()=>onAdvance(result),450);}}
  async function finishEditing(){try{await flush.current?.();setEditing(false);}catch{/* The editor shows the saved text and error. */}}
  return <ContentDialog labelId="cv2-deck-heading" onClose={onClose} focusKey={post?.id || 'done'} className="cv2-review-deck">
    {done ? <div className="cv2-done"><span className="cv2-done-mark"><Icon name="check" size={28}/></span><h2 id="cv2-deck-heading" tabIndex={-1} data-dialog-heading>{approved.length?`${approved.length} ${approved.length===1?'post approved':'posts approved'}`:'Review finished'}</h2><ul>{approved.map(item=><li key={item.id}><Icon name="check-circle" size={18}/><span><strong>{postTitle(item)}</strong><small>{when(postTime(item))}</small></span></li>)}</ul>{!approved.length?<p>No posts were approved.</p>:!connected ? <><p>Connect Instagram so these can go out</p><Button variant="secondary" onClick={onConnect}>Connect Instagram</Button></> : <p>Florrie checks prices and times again just before each one goes out.</p>}<Button fullWidth size="lg" onClick={onClose}>Done</Button></div> : post ? <>
      <header className="cv2-deck-head">
        <Button variant="secondary" icon aria-label="Close and come back later" onClick={onClose}><Icon name="x" size={20}/></Button>
        <h2 id="cv2-deck-heading" tabIndex={-1} data-dialog-heading aria-live="polite">{index+1} of {ids.length}</h2>
        <div className="cv2-deck-tools">
          <Button variant="quiet" className="cv2-delete-draft" disabled={busy||editing||justApproved} onClick={()=>onDelete(post,true)}><Icon name="trash" size={17}/>Delete draft</Button>
          <Button variant="secondary" icon aria-label="Skip for now" disabled={busy||editing} onClick={()=>onAdvance(null)}><Icon name="arrow-right" size={20}/></Button>
        </div>
      </header>
      <div className="cv2-progress" aria-hidden="true">{ids.map((id,i)=><span key={id} className={approved.some(item=>item.id===id)?'is-done':i===index?'is-current':''}/>)}</div>
      <div className="cv2-deck-scroll"><div className="cv2-purpose"><span className="cv2-eyebrow">{post.purpose?.eyebrow || 'Prepared for you'}</span><h3>{postTitle(post)}</h3></div>
        {post.change_note && <div className={`cv2-change-notice${isBlocked(post)?' is-danger':''}`}><strong>{isBlocked(post)?"This can't go out as it is":post.change_note.was_approved?'Changed since you approved it':'Florrie updated this'}</strong>{asArray(post.change_note.reasons).map(reason=><p key={reason}>{reason}</p>)}{!isBlocked(post)&&<p>The change is highlighted. Approve it again when you're happy.</p>}</div>}
        {editing ? <CaptionEditor key={post.id} post={post} ownerId={owner.id} onSave={(caption,version,hashtags)=>onSave(post,caption,version,hashtags)} onReady={fn=>{flush.current=fn;}}/> : <ContentPostPreview post={post} owner={owner}/>}
        {(post.last_revision || post.can_undo) && <div className="cv2-revision"><span>{typeof post.last_revision==='string'?post.last_revision:post.last_revision?.note || 'Your change is saved.'}</span><Button variant="quiet" size="sm" disabled={busy} onClick={()=>onUndo(post)}>Undo</Button></div>}
        <FactsCard post={post} busy={busy} onFix={instruction=>onRevise(post,instruction)}/>
        <div className="cv2-timing"><Icon name="clock" size={19}/><div><strong>Goes out {when(postTime(post))}</strong><p>{post.timing?.reason || post.timing_reason}</p><Button variant="quiet" size="sm" onClick={()=>onTime(post)} disabled={busy}>Change time</Button></div></div>
      </div>
      <footer className="cv2-deck-actions">{editing ? <Button fullWidth size="lg" onClick={finishEditing}>Done editing</Button> : <><Button variant="secondary" size="lg" disabled={busy||justApproved} onClick={()=>onChange(post)}>Change</Button>{isBlocked(post) ? <Button size="lg" disabled={busy} onClick={()=>asArray(post.alternatives).length?onRevise(post,'other_photo'):onDelete(post,true)}>{asArray(post.alternatives).length?'Use a different photo':"Don't post this one"}</Button> : <Button size="lg" disabled={busy||justApproved} onClick={approve}>{justApproved ? <><Icon name="check" size={18}/>Approved</> : busy ? 'Saving...' : 'Approve'}</Button>}</>}</footer>
    </> : <div className="cv2-done"><h2 id="cv2-deck-heading" tabIndex={-1} data-dialog-heading>This post is no longer here</h2><Button onClick={()=>onAdvance(null)}>Continue checking</Button><Button variant="quiet" onClick={onClose}>Close</Button></div>}
  </ContentDialog>;
}
