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

export function PostPreview({ post, small = false }) {
  const [failedSource, setFailedSource] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const source = post?.image_url || null;
  const failed = !!source && failedSource === source;
  return <div className={`fl-studio-art ${small ? 'is-small' : ''} ${source && !failed ? 'has-photo' : ''}`}>
    {source && !failed
      ? <img key={`${source}:${attempt}`} src={source} alt="Saved post preview" onError={() => setFailedSource(source)} />
      : failed
        ? <Button variant="quiet" onClick={() => { setFailedSource(null); setAttempt(value => value + 1); }}><Icon name="image" size={20}/><span>Retry preview</span></Button>
        : <Icon name="camera" size={25} />}
  </div>;
}

export default function ContentStudioHome({ drafts, scheduled, treatments, error, onCompose, onDrafts, onGallery, onCalendar, planning, onPlan, note, blocked }) {
  const [campaignOpen, setCampaignOpen] = useState(false);
  return <section className="fl-content-home" aria-label="Content ideas">
    <div className="fl-studio-section-heading"><h2>Start with something you have.</h2><p>Pick one. Florrie will help you turn it into a post.</p></div>
    <div className="fl-studio-source-grid">
      <button type="button" onClick={onGallery}><Icon name="camera" size={22}/><span><strong>A treatment photo</strong><small>Choose a photo you’ve saved.</small></span><Icon name="chevron-right" size={16}/></button>
      <Link to="/reviews"><Icon name="star" size={22}/><span><strong>A client review</strong><small>Choose feedback you have permission to share.</small></span><Icon name="chevron-right" size={16}/></Link>
      <Link to="/smart-schedule"><Icon name="calendar" size={22}/><span><strong>An appointment to fill</strong><small>Find an opening in your diary.</small></span><Icon name="chevron-right" size={16}/></Link>
    </div>
    <div className="fl-studio-campaign-heading"><div><h2>Want to plan ahead?</h2><p>Choose a treatment and prepare three related drafts.</p></div><Button variant="secondary" aria-expanded={campaignOpen} aria-controls="studio-campaign" onClick={() => setCampaignOpen(value => !value)}>{campaignOpen ? 'Close plan' : 'Plan 3 posts'}<Icon name={campaignOpen ? 'minus' : 'plus'} size={16}/></Button></div>
    <div id="studio-campaign" hidden={!campaignOpen}><ContentDirection treatments={treatments} planning={planning} onPlan={onPlan} onCompose={onCompose} onGallery={onGallery} drafts={error ? null : drafts.length} scheduled={error ? null : scheduled.length} onDrafts={onDrafts} onCalendar={onCalendar} note={note} blocked={blocked}/></div>
  </section>;
}
