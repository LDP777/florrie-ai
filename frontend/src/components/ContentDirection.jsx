import { useState } from 'react';
import { Link } from 'react-router-dom';
import Button from './ui/Button.jsx';
import Icon from './ui/Icon.jsx';

const DIRECTIONS = [
  { id: 'show_work', title: 'Show your work', icon: 'camera', detail: 'Help someone picture their own result.', steps: ['Introduce the treatment', 'Show the detail in your work', 'Invite a booking'], capture: 'An unfiltered before and after, in the same light, with permission to share.', brief: 'Explain what makes this treatment distinctive. Use only the details I provide and what is visible in my photo. Do not invent results.' },
  { id: 'explain', title: 'Help clients choose', icon: 'message', detail: 'Answer the questions before they ask.', steps: ['Explain the treatment', 'Answer a common question', 'Explain the next step'], capture: 'A close-up of your tools or setup. Add the treatment facts you want clients to know.', brief: 'Help a new client understand this treatment. Ask me for missing treatment facts rather than making up preparation, suitability, or aftercare advice.' },
  { id: 'trust', title: 'Build trust', icon: 'star', detail: 'Show the care behind your work.', steps: ['Introduce your approach', 'Show how you care', 'Invite a conversation'], capture: 'Show a detail of your workspace and explain your approach. Share client quotes separately through Reviews, with permission.', brief: 'Introduce my approach to client care using only the facts I provide. Do not invent a review, rating, quote, or client story.' },
  { id: 'bookings', title: 'Encourage bookings', icon: 'calendar', detail: 'Give interest somewhere useful to go.', steps: ['Introduce a treatment', 'Show what the visit involves', 'Point to the booking page'], capture: 'A treatment photo and your booking link. Check the diary before mentioning a specific time.', brief: 'Invite clients to check my booking page for current availability. Do not claim a cancellation, specific opening, limited offer, or discount unless I provide it.' },
];

export default function ContentDirection({ treatments, planning, onPlan, onCompose, onGallery, drafts, scheduled, onDrafts, onCalendar, note, blocked }) {
  const [goal, setGoal] = useState('show_work');
  const [treatmentId, setTreatmentId] = useState('');
  const direction = DIRECTIONS.find(item => item.id === goal);
  return <section className="fl-content-direction" aria-labelledby="content-direction-title">
    <div className="fl-direction-intro"><span className="fl-workspace-eyebrow">Start with a purpose</span><h2 id="content-direction-title">What should your content do?</h2><p>Choose a focus. Build a small story across three posts.</p></div>
    <div className="fl-direction-options" aria-label="Content goal">{DIRECTIONS.map(item => <button type="button" key={item.id} aria-pressed={goal === item.id} onClick={() => setGoal(item.id)} disabled={planning}><Icon name={item.icon} size={21} /><span><strong>{item.title}</strong><small>{item.detail}</small></span>{goal === item.id && <Icon name="check" size={17} />}</button>)}</div>
    <div className="fl-direction-plan">
      <div className="fl-direction-plan-heading"><div><span className="fl-workspace-eyebrow">Your three-post plan</span><h3>{direction.title}</h3></div><label className="fl-studio-field">Treatment<select aria-label="Plan treatment" disabled={planning} value={treatmentId} onChange={e => setTreatmentId(e.target.value)}><option value="">Across my salon</option>{treatments.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label></div>
      <ol className="fl-content-sequence">{direction.steps.map((step, i) => <li key={step}><span aria-hidden="true">0{i + 1}</span><strong>{step}</strong></li>)}</ol>
      <div className="fl-content-capture"><Icon name="camera" size={19} /><div><strong>What to capture</strong><p>{direction.capture}</p></div></div>
      <div className="fl-studio-actions"><Button disabled={planning} onClick={() => onPlan({ goal, treatment_id: treatmentId || null, post_count: 3 })}>{planning ? 'Preparing your plan…' : 'Draft this plan'}</Button><Button variant="quiet" disabled={planning} onClick={() => onCompose({ type: goal === 'show_work' ? 'before_after' : 'general', treatment: treatments.find(t => t.id === treatmentId)?.name || '', brief: direction.brief })}>Start with one post</Button></div>
      <p className="fl-studio-note">Drafts use your salon’s saved information. Add photos and review the details before publishing.</p>
      {note && <p role="status" className="fl-studio-note">{note}</p>}{blocked && <Button variant="secondary" onClick={onDrafts}>Review my drafts</Button>}
    </div>
    <div className="fl-studio-paths">
      <button type="button" onClick={onGallery}><Icon name="camera" size={19} /><span><strong>Your photo library</strong><small>Give work from your camera roll a purpose</small></span><Icon name="chevron-right" size={17} /></button>
      <Link to="/reviews"><Icon name="star" size={19} /><span><strong>Reviews into reputation</strong><small>Set up Google requests and share real feedback</small></span><Icon name="chevron-right" size={17} /></Link>
    </div>
    <div className="fl-content-progress"><button type="button" onClick={onDrafts}><strong>{drafts ?? 'Check'}</strong> {drafts === null ? 'drafts' : 'posts to review'} <Icon name="arrow-right" size={16} /></button><button type="button" onClick={onCalendar}><strong>{scheduled ?? 'Check'}</strong> {scheduled === null ? 'schedule' : 'scheduled'} <Icon name="arrow-right" size={16} /></button></div>
  </section>;
}
