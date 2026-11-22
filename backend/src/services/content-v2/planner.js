import { randomUUID } from 'node:crypto';
import { salonWallToInstant } from '../content-autopilot.js';
import { money, weekday, dayMonth, clock, minutes } from './state.js';
import { validConsent, offerLive, offerTerms, patchDeadline, mediaPhotoIds } from './facts.js';
import { applyVoice, applyHashtagRules } from './voice.js';

const DAY=86400000;
const types={fill_gap:'last_minute_availability',show_work:'before_after',offer:'promotion',review:'testimonial'};
const DAYS=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
export function interpretRequest(text, context) {
  const value=text.toLowerCase();
  const day=DAYS.findIndex(d => new RegExp(`\\b${d}(?:\\b)|\\b${d.slice(0,3)}\\b`,'i').test(value));
  if (/fill|gap|quiet|free|space|slot|availability/.test(value) || (day>=0 && /help|post/.test(value))) {
    let date;
    if (day>=0) {
      const first=new Date(`${context.wallDay}T12:00:00Z`);
      let offset=(day-first.getUTCDay()+7)%7; if (!offset) offset=7;
      date=new Date(+first+offset*DAY).toISOString().slice(0,10);
    }
    return {type:'fill_gap',...(date?{day:date}:{})};
  }
  if (/next week|sort|plan|week/.test(value)) return {type:'week'};
  if (/offer|christmas|festive|promo|discount|deal/.test(value)) return {type:'offer'};
  if (/review|kind words|feedback/.test(value)) return {type:'review'};
  if (/course|training|masterclass/.test(value)) return {type:'training'};
  if (/these|this photo|show off|brows|lashes|photo|before|after|work/.test(value)) return {type:'show_work',needs_photos:/these|this photo/.test(value)};
  return null;
}
export function contentIdeas(context) {
  const covered=new Set(context.posts.filter(p=>!p.deleted_at).map(p=>p.purpose?.day));
  const gap=context.gaps.find(g=>g.duration_minutes>=60 && g.date>=plusDay(context.wallDay,2) && g.date<=plusDay(context.wallDay,10) && !covered.has(g.date));
  return [...(gap?[{id:`gap-${gap.date}`,label:`Help fill ${weekday(gap.date)}`,request:{type:'fill_gap',day:gap.date}}]:[]),
    {id:'photos',label:'Show off these brows',request:{type:'show_work',needs_photos:true}},
    {id:'week',label:"Sort next week's posts",request:{type:'week'}}];
}
export function plusDay(day,count) { return new Date(Date.parse(`${day}T12:00:00Z`)+count*DAY).toISOString().slice(0,10); }
const layout=(kind,title,lines=[],extra={}) => ({type:'layout',layout:{kind,title,headline:title,lines,...extra}});
const photoMedia=p=>({type:'photo',photo_id:p.id,image_url:p.after_url || p.image_url});
const priceClaim=t=>({kind:'price',treatment_id:t.id,pence:t.price_cents,text:money(t.price_cents)});
function usablePhotos(context,ids) {
  const recent=new Set(context.posts.filter(p=>Date.parse(p.posted_at || p.created_at)>+context.now-30*DAY).flatMap(mediaPhotoIds));
  return context.photos.filter(p=>!p.deleted_at && p.treatment_id && validConsent(p,context) && (ids?.length?ids.includes(p.id):!recent.has(p.id)))
    .filter(p=>context.treatments.some(t=>t.id===p.treatment_id && t.is_active));
}
export function planPosts(request,context) {
  const drafts=[],notes=[], pool=usablePhotos(context,request.photo_ids);
  const make=(type,purpose,caption,claims,media,alternatives=[]) => {
    const post={id:randomUUID(),beautician_id:context.profile.id,kind:'post',status:'draft',platform:'instagram',format:'feed',media_kind:'feed',
      post_type:types[type] || 'general',purpose:{type,...purpose},caption:applyVoice(caption,context.rules),claims,
      hashtags:applyHashtagRules(['#beauty'],context.rules),media,alternatives,version:1,history:[],facts:[],prepared_caption:null,
      image_url:media.type==='photo'?media.image_url:null,edited_by_owner:false,created_at:context.now.toISOString()};
    drafts.push(post); return post;
  };
  function fill() {
    if (request.no_times) return general(true);
    const gap=context.gaps.filter(g=>g.duration_minutes>=60 && g.date>context.wallDay && (!request.day || g.date===request.day))
      .sort((a,b)=>a.date.localeCompare(b.date) || b.duration_minutes-a.duration_minutes)[0];
    if (!gap) { notes.push('Your diary has no openings worth posting about on that date.'); return; }
    const treatments=context.treatments.filter(t=>t.is_active && t.booking_enabled!==false && t.price_cents>0 && t.duration_minutes+(t.buffer_minutes || 0)<=gap.duration_minutes
      && (!context.slotsByTreatment || context.slotsByTreatment[t.id]?.some(s=>s.date===gap.date && s.time>=gap.start && s.time<gap.end))).slice(0,2);
    if (!treatments.length) { notes.push('The free time is too short for your treatments.'); return; }
    const available=treatments.flatMap(t=>context.slotsByTreatment?.[t.id] || []).filter(s=>s.date===gap.date && s.time>=gap.start && s.time<gap.end).map(s=>minutes(s.time));
    const start=available.length?Math.min(...available):minutes(gap.start),from=`from ${clock(start)}`, deadline=treatments.some(t=>t.requires_patch_test)?patchDeadline(gap.date,start,context):null;
    const patch=deadline?`patch test by ${weekday(deadline)}`:null;
    const claims=[{kind:'free_from',day:gap.date,minutes:start,treatment_ids:treatments.map(t=>t.id),text:from},...treatments.map(t=>({...priceClaim(t),text:`a ${t.name.toLowerCase()} (${money(t.price_cents)})`})),
      ...(patch?[{kind:'patch_test',day:gap.date,minutes:start,text:patch}]:[])];
    const caption=[`${weekday(gap.date)} ${start<720?'morning':start<1020?'afternoon':'evening'} has opened up.`,
      `I've got space ${from} for ${treatments.map(t=>`a ${t.name.toLowerCase()} (${money(t.price_cents)})`).join(' or ')}.`,
      patch?`New to me? You'll need a quick ${patch}.`:null,'Booking link is in my bio, or give me a message x'].filter(Boolean).join(' ');
    const photos=pool.filter(p=>treatments.some(t=>t.id===p.treatment_id)),card=layout('availability',`${weekday(gap.date)} has space`,[`From ${clock(start)}`,...treatments.map(t=>t.name)]);
    make('fill_gap',{title:`Fills ${weekday(gap.date)} from ${clock(start)}`,eyebrow:`For ${weekday(gap.date)}'s free afternoon`,label:`${weekday(gap.date).slice(0,3)} gap`,day:gap.date},caption,claims,photos[0]?photoMedia(photos[0]):card,
      [...photos.slice(1).map(photoMedia),...(photos[0]?[card]:[])]);
  }
  function show() {
    const photo=pool[0];
    if (!photo) { notes.push('Add a photo, choose its treatment and confirm permission before Florrie uses it.'); return; }
    const treatment=context.treatments.find(t=>t.id===photo.treatment_id);
    const lasts=/\b\d+\s+(?:to\s+\d+\s+)?weeks?\b/i.exec(treatment.description || '')?.[0];
    const claims=[priceClaim(treatment),...(lasts?[{kind:'lasts',treatment_id:treatment.id,text:lasts}]:[])];
    const caption=[`${treatment.name}.`,lasts?`Lasts ${lasts} with a little aftercare.`:null,`It's ${money(treatment.price_cents)}, and the booking link is in my bio x`].filter(Boolean).join(' ');
    const card=layout('treatment',treatment.name,[money(treatment.price_cents)]);
    const media=photo.before_url && photo.after_url?layout('before_after',treatment.name,[],{photo_ids:[photo.id],before_url:photo.before_url,after_url:photo.after_url}):photoMedia(photo);
    make('show_work',{title:`${treatment.name}${photo.before_url?', before and after':''}`,eyebrow:'Shows off your work',label:treatment.name},caption,claims,media,
      [...(photo.before_url?[photoMedia(photo)]:[]),...pool.filter(p=>p.id!==photo.id && p.treatment_id===photo.treatment_id).map(photoMedia),card]);
  }
  function offer() {
    const promo=context.offers.find(p=>(!request.promo_code_id || p.id===request.promo_code_id) && offerLive(p,context.now) && offerTerms(p,context.treatments));
    if (!promo) return false;
    const terms=offerTerms(promo,context.treatments);
    const claims=['discount','price','range','book_by','code',...(terms.terms?['terms']:[])].map(field=>({kind:'offer',promo_code_id:promo.id,field,text:terms[field]}));
    claims.push({...priceClaim(terms.treatment),text:`instead of ${terms.old_price}`});
    const caption=`A little festive treat. ${terms.discount} a ${terms.treatment.name.toLowerCase()} for appointments ${terms.range}, so it's ${terms.price} instead of ${terms.old_price}. ${terms.book_by} with code ${terms.code}. ${terms.terms} Booking link is in my bio x`.replace(/\s+/g,' ');
    make('offer',{title:promo.title || `${terms.discount} ${terms.treatment.name}`,eyebrow:'Your approved offer',label:'Offer',promo_code_id:promo.id,book_by:promo.valid_until},caption,claims,
      layout('offer',`${terms.discount} ${terms.treatment.name.toLowerCase()}`,[`Appointments ${terms.range}`,`${terms.price} instead of ${terms.old_price}`,`${terms.book_by}`,`Code ${terms.code}`,terms.terms],{title:promo.title || 'Your offer'}),
      pool.filter(p=>promo.treatment_ids.includes(p.treatment_id)).map(photoMedia));
    return true;
  }
  function review() {
    const row=context.reviews.find(r=>(!request.review_id || r.id===request.review_id) && r.is_public && r.platform!=='google' && r.comment?.trim() && context.reviewPermissions.some(p=>p.review_id===r.id));
    if (!row) { notes.push('No reviews have permission to be shared yet.'); return; }
    const caption=`“${row.comment}” Thank you for sharing your experience. The booking link is in my bio.`;
    make('review',{title:'Kind words from a client',eyebrow:'Kind words',label:'Review',review_id:row.id},caption,[{kind:'quote',review_id:row.id,text:row.comment}],layout('quote',row.comment,[]));
  }
  function training() {
    const course=context.courses.find(c=>c.status==='active' && c.date>=context.wallDay);
    if (!course) { notes.push('You have no upcoming training dates set up.'); return; }
    const date=`${weekday(course.date)} ${dayMonth(course.date)}`,price=money(Math.round(Number(course.price)*100));
    make('training',{title:course.name,eyebrow:'Your next training date',label:'Training',course_id:course.id},`${course.name}, ${date}. ${price}. Give me a message for the details.`,
      [{kind:'course',course_id:course.id,field:'name',text:course.name},{kind:'course',course_id:course.id,field:'date',value:course.date,text:date},{kind:'course',course_id:course.id,field:'price',value:course.price,text:price}],layout('course',course.name,[date,price]));
  }
  function general(availability=false) {
    make('general',{title:availability?'Book your next appointment':'A little time for you',eyebrow:'Your booking page',label:'Booking'},'If you have been meaning to book your next treatment, the booking link is in my bio. You can check the current times there, or give me a message x',[],layout('general',context.profile.business_name || 'Your next appointment',['Find a time that suits you']));
  }
  if (request.type==='week') { fill(); show(); if (!offer()) review(); if(!drafts.length) general(); }
  else if(request.type==='fill_gap') fill(); else if(request.type==='show_work') show();
  else if(request.type==='offer') { if(!offer()) notes.push('You have no approved offers running.'); }
  else if(request.type==='review') review(); else if(request.type==='training') training(); else general();
  if(request.type==='week' && context.treatments.length) {
    const treatment=context.treatments.find(t=>t.is_active) || context.treatments[0];
    const caption=`${treatment.name}, ${money(treatment.price_cents)}. Booking link is in my bio.`;
    const reel={title:`${treatment.name} reveal`,length:'About 15 seconds',shots:[
      {instruction:'Film the treatment area before you start, with permission.',seconds:3,on_screen:'Before'},
      {instruction:'Film a detail of your tools at work.',seconds:3,on_screen:'In the chair'},
      {instruction:'Show the finished result in natural light.',seconds:5,on_screen:'After'},
      {instruction:'Point viewers to your booking link.',seconds:4,on_screen:`${treatment.name}, ${money(treatment.price_cents)}`,spoken:'Booking link is in my bio.'}],
      caption,needs:["Your client's OK to film for Instagram"]};
    drafts.push({id:randomUUID(),beautician_id:context.profile.id,kind:'reel_plan',status:'draft',platform:'instagram',format:'feed',media_kind:'feed',post_type:'general',
      purpose:{type:'reel',title:reel.title,eyebrow:'To film',label:'Reel plan'},caption,prepared_caption:caption,claims:[priceClaim(treatment)],hashtags:[],media:{type:'none'},alternatives:[],reel,version:1,history:[],facts:[],created_at:context.now.toISOString()});
  }
  return {drafts,notes};
}
export function proposeTime(post,context,taken=[]) {
  let day=plusDay(context.wallDay,1),time='12:30:00',reason='Spaced away from your other posts this week';
  if(post.purpose?.type==='fill_gap' && post.purpose.day) { day=plusDay(post.purpose.day,-3);time='19:30:00';reason=`3 evenings before ${weekday(post.purpose.day)}, so there is time to book and patch test`; }
  if(post.purpose?.type==='offer' && post.purpose.book_by) { day=plusDay(post.purpose.book_by.slice(0,10),-5);time='18:00:00';reason='Leaves plenty of time before the book-by date'; }
  if(day<context.wallDay) day=context.wallDay;
  const zone=context.profile.timezone || 'Europe/London';
  const dates=new Set(taken.filter(Boolean).map(at=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at))));
  while(dates.has(day)) day=plusDay(day,1);
  let at=salonWallToInstant(new Date(`${day}T${time}Z`),zone);
  if(+new Date(at)<=+context.now) { at=new Date(+context.now+10*60000).toISOString();reason='As soon as there is time to check and book'; }
  return {scheduled_for:new Date(at).toISOString(),timing_reason:reason};
}
