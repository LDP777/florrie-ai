import { PATCH_TEST_LEAD_HOURS } from '../../lib/patch-test-policy.js';
import { wallDayHours } from '../../lib/free-slots.js';
import { money, weekday, clock, minutes, dayMonth, materialUpdate } from './state.js';

export function mediaPhotoIds(post) {
  const media = post.media || {};
  return [...new Set([...(media.photo_ids || media.layout?.photo_ids || media.layout?.photoIds || []),
    media.photo_id || media.photoId].filter(Boolean))];
}
export function validConsent(photo, context, channel = 'instagram') {
  if (photo.permission_status === 'no_client' && !photo.client_id) return true;
  if (photo.permission_status !== 'granted' || !photo.client_id || !photo.consent_id) return false;
  const consent = context.consents.find(c => c.id === photo.consent_id && c.client_id === photo.client_id);
  return !!consent && consent.status === 'granted' && !consent.revoked_at
    && (!consent.expires_at || Date.parse(consent.expires_at) > +context.now)
    && consent.permitted_uses?.includes(channel === 'google' ? 'google' : 'instagram');
}
export function offerLive(offer, now) {
  return !!offer?.marketing_approved_at && offer.is_active === true && Date.parse(offer.valid_from) <= +now
    && Date.parse(offer.valid_until) >= +now && (offer.max_uses == null || offer.current_uses < offer.max_uses);
}
export function offerTerms(offer, treatments) {
  const selected = treatments.filter(t => offer.treatment_ids?.includes(t.id));
  const treatment = selected[0];
  if (!treatment || !offer.appointments_from || !offer.appointments_to) return null;
  const discount = offer.discount_type === 'percentage' ? `${offer.discount_value}% off` : `${money(offer.discount_value)} off`;
  const reduced = Math.max(0, treatment.price_cents - (offer.discount_type === 'percentage'
    ? Math.round(treatment.price_cents * offer.discount_value / 100) : offer.discount_value));
  const from = offer.appointments_from, to = offer.appointments_to;
  const range = from.slice(0,7) === to.slice(0,7) ? `from ${Number(from.slice(8,10))} to ${dayMonth(to)}` : `from ${dayMonth(from)} to ${dayMonth(to)}`;
  return { discount, price:money(reduced), old_price:money(treatment.price_cents), range,
    book_by:`Book by ${dayMonth(offer.valid_until)}`, code:offer.code, terms:offer.terms || '', treatment, treatments:selected };
}
export function patchDeadline(day, start, context) {
  const date = new Date(Date.parse(`${day}T00:00:00Z`) + start * 60000 - PATCH_TEST_LEAD_HOURS*3600000);
  for (let i=0;i<14;i++) {
    const key = date.toISOString().slice(0,10);
    const hours = wallDayHours(context.profile.working_hours || {},date,context.dateHours);
    if (hours && hours.enabled !== false && hours.closed !== true && !context.closedDays?.has(key)) return key;
    date.setUTCDate(date.getUTCDate()-1);
  }
  return null;
}
export function checkFacts(post, context) {
  const stamp=context.now.toISOString(), facts=[], fixes=[], claims=structuredClone(post.claims || []);
  let caption=post.caption || '';
  const fact=(key,label,source,status='ok',detail='',extra={}) => facts.push({key,label,private_label:label.replace(/£\d+(?:\.\d{2})?/g,'••••'),source,status,detail,checked_at:stamp,...extra});
  const block=(key,label,source,privateLabel=label) => fact(key,label,source,'block','',{private_label:privateLabel});
  const fix=(index,text,claim,reason) => {
    const old=claims[index];
    caption=caption.replace(old.text,text); claims[index]={...old,...claim,text};
    fixes.push({from:old.text,to:text,reason});
  };
  for (let i=0;i<claims.length;i++) {
    const c=claims[i];
    if (!c.text || !caption.includes(c.text)) continue;
    const treatment=context.treatments.find(t => t.id === c.treatment_id);
    if (c.kind === 'price') {
      if (!treatment?.is_active) { block(`price:${c.treatment_id}`,'This treatment is no longer on your price list.','Price list'); continue; }
      const changed=treatment.price_cents !== c.pence;
      if (changed) fix(i,c.text.replace(money(c.pence),money(treatment.price_cents)),{pence:treatment.price_cents},`${treatment.name} is now ${money(treatment.price_cents)} on your price list`);
      fact(`price:${treatment.id}`,`${treatment.name} ${money(treatment.price_cents)}`,'Price list',changed?'changed':'ok',changed?`Was ${money(c.pence)}`:'');
    } else if (c.kind === 'free_from') {
      const selected=context.treatments.filter(t => c.treatment_ids?.includes(t.id) && t.is_active && t.booking_enabled !== false);
      const shortest=Math.min(...selected.map(t => Number(t.duration_minutes)+Number(t.buffer_minutes || 0)));
      const gap=context.gaps.filter(g => g.date === c.day && minutes(g.end)-Math.max(minutes(g.start),c.minutes)>=shortest)
        .sort((a,b) => a.start.localeCompare(b.start))[0];
      if (!gap || c.day < context.wallDay) { block('free',`${weekday(c.day)} is fully booked now, so this post would offer times that are gone.`,'Diary'); continue; }
      const slots=selected.flatMap(t=>context.slotsByTreatment?.[t.id] || []).filter(s=>s.date===c.day && minutes(s.time)>=c.minutes && s.time>=gap.start && s.time<gap.end);
      if(context.slotsByTreatment && !slots.length) { block('free',`${weekday(c.day)} is fully booked now, so this post would offer times that are gone.`,'Diary'); continue; }
      const start=slots.length?Math.min(...slots.map(s=>minutes(s.time))):Math.max(minutes(gap.start),c.minutes), changed=start!==c.minutes;
      if (changed) fix(i,`from ${clock(start)}`,{minutes:start},`${clock(c.minutes)} on ${weekday(c.day)} was booked`);
      fact('free',`Free ${weekday(c.day)} from ${clock(start)}`,'Diary',changed?'changed':'ok',changed?`${clock(c.minutes)} was booked`:'');
    } else if (c.kind === 'patch_test') {
      const free=claims.find(claim => claim.kind === 'free_from');
      const deadline=patchDeadline(free?.day || c.day,free?.minutes ?? c.minutes,context);
      if (!deadline) { block('patch','No working day is available for the patch test deadline.','Your patch test rule'); continue; }
      if(deadline<context.wallDay) { block('patch','The patch test deadline has passed. This opening is too soon for new clients who still need one.','Your patch test rule'); continue; }
      const text=`patch test by ${weekday(deadline)}`;
      const changed=text!==c.text;
      if (changed) fix(i,text,{day:free?.day || c.day,minutes:free?.minutes ?? c.minutes},'The patch test deadline moved with the time');
      fact('patch',`New clients: ${text}`,'Your patch test rule',changed?'changed':'ok');
    } else if (c.kind === 'lasts') {
      if (!treatment?.description?.includes(c.text)) block(`lasts:${c.treatment_id}`,'How long it lasts no longer matches your treatment description.','Treatment description');
      else fact(`lasts:${c.treatment_id}`,`Lasts ${c.text}`,'Treatment description');
    } else if (c.kind === 'offer') {
      const offer=context.offers.find(p => p.id===c.promo_code_id), terms=offer && offerTerms(offer,context.treatments);
      if (!offerLive(offer,context.now) || !terms || terms[c.field]!==c.text) block(`offer:${c.field}`,'This offer has ended or been withdrawn.','Your approved offer');
      else fact(`offer:${c.field}`,c.text,'Your approved offer');
    } else if (c.kind === 'quote') {
      const review=context.reviews.find(r => r.id===c.review_id);
      if (!review || review.is_public!==true || review.platform==='google' || review.comment!==c.text || !context.reviewPermissions.some(p=>p.review_id===c.review_id)) block('quote','The review is no longer available to share.','Reviews');
      else fact('quote','A client said yes to sharing this review','Reviews');
    } else if (c.kind === 'course') {
      const course=context.courses.find(row => row.id===c.course_id && row.status==='active');
      if (!course || (c.field==='date' && c.value!==course.date) || (c.field==='price' && Number(c.value)!==Number(course.price)) || (c.field==='name' && c.text!==course.name)) block('course','The training details changed. Check the next date before sharing.','Training');
      else fact(`course:${c.field}`,c.text,'Training');
    }
  }
  for (const id of mediaPhotoIds(post)) {
    const photo=context.photos.find(p => p.id===id && !p.deleted_at);
    if (!photo) { block(`photo:${id}`,'A photo in this post has been deleted.','Photos'); continue; }
    const name=context.clients.find(c => c.id===photo.client_id)?.first_name || 'Your client';
    if (!validConsent(photo,context,post.platform)) block(`photo:${id}`,`${name} withdrew permission for this photo.`,'Photo consent','A client withdrew permission for this photo.');
    else if (photo.permission_status==='no_client') fact(`photo:${id}`,'No client in this photo','Photos');
    else fact(`photo:${id}`,`${name} said yes to Instagram`,'Photo consent','ok','',{private_label:'A client said yes to Instagram'});
  }
  // Legacy photos have no permission record. Preserve the draft and ask once.
  if (post.image_url && !post.media && post.post_type!=='testimonial') block('photo:legacy','Confirm permission for this photo or use a different one.','Photo consent');
  const amounts=caption.match(/£\d+(?:\.\d{2})?/g) || [];
  for (const amount of new Set(amounts)) if (!claims.some(c => caption.includes(c.text) && c.text.includes(amount))) fact(`money:${amount}`,`${amount} is not on your price list or offers`,'Your edit','warn');
  const free=claims.find(c => c.kind==='free_from');
  if (free && !/patch test/i.test(caption) && context.treatments.some(t => free.treatment_ids?.includes(t.id) && t.requires_patch_test)) fact('patch-missing','New clients will need a patch test first','Your patch test rule','warn','',{fix:'patch'});
  if (post.link_url) fact('link','Bookings through this post are counted','Your booking link');
  const blocked=facts.filter(f => f.status==='block');
  const updates={facts,checked_at:stamp};
  let media=post.media,purpose=post.purpose;
  if(fixes.length) {
    const rewrite=value=>{
      if(Array.isArray(value)) return value.map(rewrite);
      if(value && typeof value==='object') return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,rewrite(v)]));
      if(typeof value!=='string') return value;
      let changed=value;
      for(const f of fixes) {
        changed=changed.replaceAll(f.from,f.to);
        if(f.from.startsWith('from ')) changed=changed.replaceAll(`From ${f.from.slice(5)}`,`From ${f.to.slice(5)}`);
        const before=f.from.match(/£\d+(?:\.\d{2})?/g),after=f.to.match(/£\d+(?:\.\d{2})?/g);
        if(before?.length===1 && after?.length===1) changed=changed.replaceAll(before[0],after[0]);
      }
      return changed;
    };
    if(media?.type==='layout') media=rewrite(media);
    purpose=rewrite(purpose);
  }
  if (fixes.length) Object.assign(updates,materialUpdate(post,{caption,claims,purpose,...(media!==post.media?{media,image_url:null}:{})},fixes.map(f=>f.reason).join('. '),stamp),
    {change_note:{kind:'facts',reasons:fixes.map(f=>f.reason),changes:fixes.map(({from,to})=>({from,to})),at:stamp,was_approved:!!post.approved_hash}});
  if (blocked.length) Object.assign(updates,{status:'draft',approved_at:null,approved_hash:null,
    change_note:{kind:'blocked',reasons:blocked.map(f=>f.label),changes:fixes,at:stamp,was_approved:!!post.approved_hash || !!post.change_note?.was_approved}});
  return updates;
}
