import { useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from './ui/Icon.jsx';
import Button from './ui/Button.jsx';
import ContentDirection from './ContentDirection.jsx';

export function postReadiness(post) {
  if (post?.status === 'failed') return { label: 'Needs your attention', action: 'Fix this post', icon: 'warning' };
  if (post?.status === 'scheduled') return { label: 'Scheduled', action: 'Review schedule', icon: 'calendar' };
  if (!post?.image_url) return { label: 'Add a photo', action: 'Finish this post', icon: 'camera' };
  if (!post?.caption?.trim()) return { label: 'Needs a caption', action: 'Finish this post', icon: 'edit' };
  return { label: 'Ready to review', action: 'Review this post', icon: 'check' };
}

function PostPreview({ post, small = false }) {
  const [failed, setFailed] = useState(false);
  return <div className={`fl-studio-art ${small ? 'is-small' : ''} ${post?.image_url && !failed ? 'has-photo' : ''}`}>
    {post?.image_url && !failed
      ? <img src={post.image_url} alt="Saved post preview" onError={() => setFailed(true)} />
      : <><span className="fl-studio-art-mark"><Icon name="camera" size={small ? 22 : 29} /></span>{!small && <><span className="fl-studio-art-title">Made<br /><em>by you.</em></span><span className="fl-studio-art-note">{post ? 'Your photo belongs here' : 'Start with something real'}</span></>}</>}
  </div>;
}

export default function ContentStudioHome({ drafts, scheduled, treatments, gallery, complete, error, igStatus, igChecking, onPost, onCompose, onDrafts, onGallery, onCalendar, onResults, onRetry, planning, onPlan, note, blocked }) {
  const [campaignOpen, setCampaignOpen] = useState(false);
  const lead = drafts.find(post => post.status === 'failed') || drafts[0] || scheduled[0];
  const readiness = postReadiness(lead);
  const next = [...scheduled, ...drafts].filter(post => post.id !== lead?.id).slice(0, 3);
  const connection = igChecking ? 'Checking Instagram' : igStatus?.needs_reconnect ? 'Reconnect Instagram' : igStatus?.connected === false ? 'Connect Instagram' : igStatus?.connected && igStatus?.token_valid === true ? 'Instagram connected' : 'Check Instagram connection';
  return <section className="fl-content-home" aria-label="Content studio overview">
    <div className="fl-studio-topline"><span>Made from your salon</span><Link to="/settings"><Icon name="instagram" size={15}/>{connection}<Icon name="chevron-right" size={12}/></Link></div>
    <article className="fl-studio-feature">
      <PostPreview key={lead?.id || 'empty'} post={lead} />
      <div className="fl-studio-feature-copy">
        <span className="fl-workspace-eyebrow">{lead ? 'Your next post' : error ? 'Your studio' : 'A good place to begin'}</span>
        <h2>{lead ? lead.status === 'failed' ? 'Let’s get this one out.' : 'A little closer to posted.' : error ? 'Let’s bring your posts back.' : 'Make your work the story.'}</h2>
        <p className="fl-studio-feature-caption">{lead?.caption || (error ? 'Your posts could not be loaded. Retry to see your saved work.' : 'Bring a treatment, a photo or a real client review. Build something worth sharing.')}</p>
        {lead ? <><span className="fl-studio-readiness"><Icon name={readiness.icon} size={15}/>{readiness.label}{lead.status === 'scheduled' && lead.scheduled_for && ` · ${new Date(lead.scheduled_for).toLocaleDateString('en-GB', {day:'numeric',month:'short'})}`}</span><Button onClick={() => onPost(lead)}>{readiness.action}<Icon name="arrow-up-right" size={16}/></Button></>
          : error ? <Button onClick={onRetry}>Retry posts</Button> : <Button onClick={() => onCompose({type:'before_after',brief:'Explain the work in my photo using the treatment details I provide. Do not invent results or identify the client.'})}>Create your first post<Icon name="plus" size={16}/></Button>}
        <small>Nothing publishes until you approve it.</small>
      </div>
    </article>
    {(drafts.length > 0 || scheduled.length > 0) && <section className="fl-studio-up-next" aria-labelledby="studio-queue-title">
      <div className="fl-studio-section-heading"><h2 id="studio-queue-title">In the studio</h2><button type="button" onClick={onDrafts}>View posts<Icon name="arrow-right" size={15}/></button></div>
      <div className="fl-studio-queue">{(next.length ? next : [lead]).map(post => <button type="button" key={post.id} className="fl-studio-queue-item" onClick={() => onPost(post)}>
        <PostPreview key={post.id} post={post} small/><span><small>{post.status === 'scheduled' && post.scheduled_for ? new Date(post.scheduled_for).toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'}) : postReadiness(post).label}</small><strong>{post.caption || 'Untitled post'}</strong></span><Icon name="chevron-right" size={16}/>
      </button>)}</div>
      {!complete && <p className="fl-studio-note">Showing recently loaded posts. Open Posts to load older work.</p>}
    </section>}
    <section className="fl-studio-sources" aria-labelledby="studio-sources-title">
      <div className="fl-studio-section-heading"><div><span className="fl-workspace-eyebrow">Start with what you already have</span><h2 id="studio-sources-title">Your salon is the inspiration.</h2></div></div>
      <div className="fl-studio-source-grid">
        <button type="button" onClick={onGallery}><Icon name="camera" size={22}/><strong>Show your work</strong><span>Choose a treatment photo from your library.</span><span className="fl-studio-source-foot">Open photo library<Icon name="arrow-up-right" size={15}/></span></button>
        <Link to="/reviews"><Icon name="star" size={22}/><strong>Share their words</strong><span>Choose real feedback and confirm permission.</span><span className="fl-studio-source-foot">Open reviews<Icon name="arrow-up-right" size={15}/></span></Link>
        <Link to="/smart-schedule"><Icon name="calendar" size={22}/><strong>Make room for bookings</strong><span>Check the diary before promoting availability.</span><span className="fl-studio-source-foot">Open Schedule<Icon name="arrow-up-right" size={15}/></span></Link>
      </div>
    </section>
    <div className="fl-studio-campaign-heading"><div><span className="fl-workspace-eyebrow">One treatment. A connected story.</span><h2>A plan with a purpose.</h2><p>Introduce it, show your work, then give people a way to book.</p></div><Button variant="secondary" aria-expanded={campaignOpen} aria-controls="studio-campaign" onClick={() => setCampaignOpen(value => !value)}>{campaignOpen ? 'Close campaign' : 'Start a campaign'}<Icon name={campaignOpen ? 'minus' : 'plus'} size={16}/></Button></div>
    <div id="studio-campaign" hidden={!campaignOpen}><ContentDirection treatments={treatments} planning={planning} onPlan={onPlan} onCompose={onCompose} onGallery={onGallery} drafts={error ? null : drafts.length} scheduled={error ? null : scheduled.length} onDrafts={onDrafts} onCalendar={onCalendar} note={note} blocked={blocked}/></div>
    <button type="button" className="fl-studio-results-entry" onClick={onResults}><span className="fl-studio-results-icon"><Icon name="chart" size={23}/></span><span><strong>Follow the post through to a booking.</strong><small>Create a link for each post. See the appointments made through it.</small></span><Icon name="arrow-up-right" size={19}/></button>
    <p className="fl-studio-footnote"><Link to="/treatments">Treatment details</Link> inform your drafts. <Link to="/reviews">Reviews</Link> need permission. Your calendar remains the source for availability.</p>
  </section>;
}
