import { useState } from 'react';
import Button from '../ui/Button.jsx';
import Icon from '../ui/Icon.jsx';
import { useClientPrivacy } from '../../contexts/ClientPrivacyContext.jsx';
import { ContentImage } from './ContentPostPreview.jsx';
import { asArray, isBlocked, money, postTime, postTitle, shortTitle, stateLabel, when } from './content-view.js';
const STEPS = ['Checking your diary','Choosing photos you can use','Writing in your words','Checking prices, times and permissions','Choosing when each one goes out'];

export function ReadyCard({ posts, onReview }) {
  const { hidden } = useClientPrivacy();
  const changed = posts.filter(post => post.change_note).length;
  return <section className="cv2-card cv2-ready" aria-labelledby="cv2-ready-title"><span className="cv2-eyebrow">{changed ? `${changed} changed since you saw it` : 'Prepared for you'}</span>
    <h2 id="cv2-ready-title">{changed === posts.length ? <>{posts.length} {posts.length === 1 ? 'post needs' : 'posts need'} your <em>OK</em> again</> : <>{posts.length} {posts.length === 1 ? 'post' : 'posts'} <em>ready</em> to check</>}</h2>
    <ul className="cv2-thumbnails">{posts.slice(0,3).map(post => <li key={post.id}><div className="cv2-thumb-image"><ContentImage post={post}/>{post.change_note && <span className="cv2-thumb-badge">{isBlocked(post) ? 'Needs you' : 'Changed'}</span>}</div><span>{hidden ? 'Post' : shortTitle(post)}</span></li>)}</ul>
    <Button fullWidth size="lg" onClick={onReview} disabled={hidden}>{hidden ? 'Show client details to check posts' : `Check ${posts.length} ${posts.length === 1 ? 'post' : 'posts'}`}</Button><p className="cv2-ready-foot">Nothing goes out until you approve it.</p>
  </section>;
}
export function PreparingCard({ preparation }) {
  const { hidden } = useClientPrivacy();
  return <section className="cv2-card cv2-ready" aria-labelledby="cv2-preparing-title" aria-busy="true"><span className="cv2-eyebrow">Working on it</span><h2 id="cv2-preparing-title">Preparing <em>{hidden ? 'your posts' : preparation.label || 'your posts'}</em></h2>
    <ol className="cv2-steps">{STEPS.map((label,index) => { const done = index < Number(preparation.step || 0); const detail = preparation.details?.steps?.[index]; return <li key={label} className={done ? 'is-done' : index === Number(preparation.step || 0) ? 'is-now' : ''}><span className="cv2-step-dot" aria-hidden="true">{done && <Icon name="check" size={13}/>}</span><span>{label}{done && !hidden && detail?.result && <small>{detail.result}</small>}<span className="sr-only">{done ? ', done' : ', waiting'}</span></span></li>; })}</ol><p className="cv2-muted">You can leave this screen. Each finished step is saved.</p>
  </section>;
}
export function FirstVisitCard({ onPhotos, onPrepare, busy, photoData, onPhotoUpdate, onConsent }) {
  const { hidden } = useClientPrivacy();
  return <section className="cv2-card cv2-ready"><span className="cv2-eyebrow">Let's start</span><h2>Your first <em>posts</em>, ready in a minute</h2><p>Florrie already knows your treatments, prices and diary. Add a few photos of your work if you have some to hand.</p><FirstPhotos data={photoData} busy={busy} onUpdate={onPhotoUpdate} onConsent={onConsent}/><Button variant="secondary" fullWidth onClick={onPhotos} disabled={hidden || busy}><Icon name="camera" size={18}/>Add photos</Button><Button fullWidth size="lg" onClick={onPrepare} disabled={hidden || busy}>Prepare my posts</Button><p className="cv2-ready-foot">No photos to hand? Florrie can start from your diary and offers. Nothing is posted until you approve it.</p></section>;
}
function FirstPhotos({data,busy,onUpdate,onConsent}) {
  const {hidden}=useClientPrivacy();
  if(hidden||!asArray(data?.photos).length)return null;
  return <ul className="cv2-first-photos">{data.photos.slice(-3).map(photo=><li key={photo.id}><ContentImage post={photo}/><div><div className="cv2-chips" role="group" aria-label="Which treatment is this?">{asArray(data.treatments).map(t=><Button key={t.id} variant="chip" disabled={busy} aria-pressed={photo.treatment_id===t.id} onClick={()=>onUpdate(photo.id,{treatment_id:t.id})}>{t.name}</Button>)}</div><Button variant="chip" disabled={busy} aria-pressed={photo.permission_status==='no_client'} onClick={()=>onUpdate(photo.id,{permission_status:'no_client',client_id:null,consent_id:null})}>No client in it</Button><label htmlFor={`cv2-first-client-${photo.id}`}>Or choose the client</label><select id={`cv2-first-client-${photo.id}`} value={photo.client_id||''} disabled={busy} onChange={event=>onUpdate(photo.id,{client_id:event.target.value||null,permission_status:'pending'})}><option value="">Choose a client</option>{asArray(data.clients).map(client=><option key={client.id} value={client.id}>{[client.first_name,client.last_name].filter(Boolean).join(' ')}</option>)}</select><small>{photo.permission_status==='granted'?'Client said yes':photo.permission_status==='no_client'?'No client in it':'Needs permission'}</small>{photo.client_id&&photo.permission_status!=='granted'&&<Button variant="quiet" size="sm" onClick={()=>onConsent(photo.client_id)}>Ask for permission</Button>}</div></li>)}</ul>;
}
export function CaughtUpCard({ next }) { return <section className="cv2-card cv2-ready"><span className="cv2-eyebrow">All caught up</span><h2>Nothing to <em>check</em></h2><p className="cv2-muted">{next ? `Your next post goes out ${when(postTime(next))}. ` : ''}Ask Florrie below when you want more.</p></section>; }
export function AskFlorrie({ disabled, ideas, onAsk, onIdea }) {
  const [text,setText] = useState('');
  async function submit(event) { event.preventDefault(); if (await onAsk(text.trim())) setText(''); }
  return <section className="cv2-section"><h2>Ask Florrie</h2><form onSubmit={submit} className="cv2-ask"><label className="sr-only" htmlFor="cv2-ask">Ask for a post in your own words</label><input id="cv2-ask" placeholder="Ask for a post in your own words" value={text} onChange={event=>setText(event.target.value)} maxLength={1000} disabled={disabled}/><Button type="submit" variant="tonal" icon aria-label="Ask Florrie" disabled={disabled || !text.trim()}><Icon name="arrow-up" size={20}/></Button></form><div className="cv2-chips">{asArray(ideas).slice(0,3).map((idea,index) => <Button key={idea.id || index} variant="chip" disabled={disabled} onClick={()=>onIdea(idea)}><Icon name="sparkles" size={15}/>{idea.label || idea.text}</Button>)}</div></section>;
}
export function ItemRows({ posts, onOpen }) {
  const { hidden } = useClientPrivacy();
  return <ul className="cv2-item-list">{posts.map(post=><li key={post.id}><Button variant="quiet" className="cv2-item-row" onClick={()=>onOpen(post)}><ContentImage post={post}/><span className="cv2-item-copy"><strong>{hidden ? 'Post details hidden' : postTitle(post)}</strong><small>{when(postTime(post) || post.posted_at)}</small><span className={`cv2-state ${post.status === 'failed' ? 'is-danger' : ''}`}>{stateLabel(post)}</span></span><Icon name="chevron-right" size={18}/></Button></li>)}</ul>;
}
export function ComingUpList({ posts,onOpen,onPast }) { return <section className="cv2-section"><h2>{posts.length && posts.every(post=>post.status==='posted') ? 'Posted this week' : 'Coming up'}</h2>{posts.length ? <ItemRows posts={posts} onOpen={onOpen}/> : <p className="cv2-muted">Approved posts will appear here.</p>}<Button variant="quiet" onClick={onPast}>Past posts<Icon name="chevron-right" size={16}/></Button></section>; }
export function ReelPlans({ posts,onOpen }) { return posts.length ? <section className="cv2-section"><h2>To film</h2><ItemRows posts={posts.map(post=>({...post,state:'To film'}))} onOpen={onOpen}/></section> : null; }
export function ResultsLine({ result,onOpen }) {
  const { hidden } = useClientPrivacy();
  const count = result?.bookings ?? result?.count ?? 0;
  return <section className="cv2-section"><h2>Results</h2><Button variant="quiet" className="cv2-results-line" onClick={onOpen}><span className="cv2-result-number">{count}</span><span><strong>{count === 1 ? 'booking' : 'bookings'} through your post links</strong><small>{count ? `${hidden ? '••••' : money(result?.value_pence)} in the last 30 days. Measured.` : 'In the last 30 days. Every post has its own link.'}</small></span><Icon name="chevron-right" size={18}/></Button></section>;
}
export function ToolsGrid({ counts,connected,onOpen }) { return <section className="cv2-tools" aria-label="Content tools">{[['photos','image','Photos',`${counts?.photos ?? 0} you can use`],['offers','tag','Offers',`${counts?.offers ?? 0} approved`],['voice','edit','How you write',`${counts?.voice_rules ?? 0} learned`],['connections','link','Connections',`Instagram ${connected ? 'on' : 'off'}`]].map(([id,icon,label,detail])=><Button key={id} variant="quiet" className="cv2-tool" onClick={()=>onOpen(id)}><Icon name={icon} size={20}/><span>{label}<small>{detail}</small></span></Button>)}</section>; }
export function Notice({ title,children,danger=false }) { return <div className={`cv2-notice${danger ? ' is-danger' : ''}`}><Icon name="alert-triangle" size={18}/><div><strong>{title}</strong>{children}</div></div>; }
export default function ContentHome({ data, busy,onReview,onPrepare,onAsk,onIdea,onOpen,onSheet,onConnect,onPhotoUpdate,onConsent }) {
  const { hidden } = useClientPrivacy();
  const posts = asArray(data.posts_to_check).filter(post=>post.post_type!=='gallery');
  const coming = asArray(data.coming_up).filter(post=>post.post_type!=='gallery');
  const waiting = coming.filter(post=>stateLabel(post)==='Waiting for Instagram');
  const failed = coming.filter(post=>post.status==='failed');
  const ig = data.connections?.instagram || {};
  const running = ['queued','running'].includes(data.preparation?.status);
  const first = Number(data.counts?.total || 0) === 0 && !posts.length && !coming.length && !asArray(data.reel_plans).length;
  return <><header className="fl-content-heading"><h1>Content</h1></header>
    {waiting.length > 0 && <Notice title={ig.needs_reconnect ? 'Instagram signed you out' : "Instagram isn't connected"}><p>{waiting.length} approved {waiting.length===1?'post is':'posts are'} safe and will go out as soon as you reconnect.</p><Button variant="secondary" onClick={onConnect}>{ig.needs_reconnect?'Reconnect Instagram':'Connect Instagram'}</Button></Notice>}
    {failed.length > 0 && <Notice danger title={failed.length===1 ? "A post didn't go out" : `${failed.length} posts didn't go out`}><p>Nothing was posted. You can try again or post it yourself.</p><Button variant="secondary" onClick={()=>onOpen(failed[0])}>See what happened</Button></Notice>}
    {running ? <PreparingCard preparation={data.preparation}/> : posts.length ? <ReadyCard posts={posts} onReview={onReview}/> : first ? <FirstVisitCard onPhotos={()=>onSheet('photos')} onPrepare={onPrepare} busy={busy} photoData={data.first_photos} onPhotoUpdate={onPhotoUpdate} onConsent={onConsent}/> : <CaughtUpCard next={coming.find(post=>stateLabel(post)==='Scheduled')}/>}
    {data.preparation?.status==='failed' && <Notice danger title="Florrie couldn't finish these posts"><p>{hidden ? 'Show client details for the reason.' : data.preparation.error}</p><Button variant="secondary" disabled={busy||hidden} onClick={onPrepare}>Try preparing again</Button></Notice>}
    <AskFlorrie disabled={busy||running||hidden} ideas={data.ideas} onAsk={onAsk} onIdea={onIdea}/>
    {!first && <ComingUpList posts={coming} onOpen={onOpen} onPast={()=>onSheet('past')}/>}
    <ReelPlans posts={asArray(data.reel_plans)} onOpen={onOpen}/>
    <ResultsLine result={data.results_summary} onOpen={()=>onSheet('results')}/>
    <ToolsGrid counts={data.counts} connected={ig.connected && !ig.needs_reconnect} onOpen={onSheet}/>
  </>;
}
