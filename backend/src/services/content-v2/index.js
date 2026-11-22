import { randomUUID, createHash } from 'node:crypto';
import { supabase } from '../../config.js';
import logger from '../../lib/logger.js';
import { currentGapCalendar } from '../../lib/gap-availability.js';
import { nowInSalonWall, loadBlocks, getFreeSlots } from '../../lib/free-slots.js';
import { contentBookingUrl } from '../content-booking-results.js';
import { offerForMessaging } from '../../lib/promos.js';
import { contentError, isUuid, materialHash, materialUpdate, publicPost, assertEditable, snapshot } from './state.js';
import { checkFacts, validConsent, mediaPhotoIds, offerLive } from './facts.js';
import { planPosts, proposeTime, interpretRequest, contentIdeas } from './planner.js';
import { createWriter, reviseOffline } from './writer.js';
import { learnFromEdit, describeRule } from './voice.js';

const DAY=86400000,LEASE_MS=8*60000;
const STEP_LABELS=['Checking your diary','Choosing photos you can use','Writing in your words','Checking prices, times and permissions','Choosing when each one goes out'];
const PROFILE='id,business_name,booking_slug,timezone,working_hours,booking_policy,voice_profile,content_v2';
const REQUEST_TYPES=['week','fill_gap','show_work','offer','review','training','general'];
export function automaticRequestId(owner,key) {
  const hex=createHash('sha256').update(`${owner}:${key}`).digest('hex').slice(0,32);
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
export function validateRequest(value) {
  if(!value || typeof value!=='object' || !REQUEST_TYPES.includes(value.type)) throw contentError('Choose the kind of post you want.',400);
  const output={type:value.type};
  if(value.day!=null) {
    if(typeof value.day!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.day) || !Number.isFinite(Date.parse(`${value.day}T00:00:00Z`)) || new Date(`${value.day}T00:00:00Z`).toISOString().slice(0,10)!==value.day) throw contentError('Choose a valid date.',400);
    output.day=value.day;
  }
  if(value.photo_ids!=null) {
    if(!Array.isArray(value.photo_ids) || value.photo_ids.length>10 || value.photo_ids.some(id=>!isUuid(id))) throw contentError('Choose up to ten saved photos.',400);
    output.photo_ids=[...new Set(value.photo_ids)];
  }
  if(value.text!=null) {
    if(typeof value.text!=='string' || value.text.length>1000) throw contentError('Keep your request under 1,000 characters.',400);
    output.text=value.text.trim();
  }
  if(value.no_times===true) output.no_times=true;
  for(const key of ['promo_code_id','review_id']) if(value[key]!=null) {
    if(!isUuid(value[key])) throw contentError('Choose a saved offer or review.',400);
    output[key]=value[key];
  }
  return output;
}
export function createContentV2Service({db=supabase,now=()=>new Date(),gapCalendar=currentGapCalendar,calendarBlocks=loadBlocks,freeSlots=getFreeSlots,writer=createWriter(),renderArtwork,
  publish,autoKick=true}={}) {
  const checked=async(query,message='Could not load your content. Try again.')=>{
    const bounded=typeof query.abortSignal==='function'?query.abortSignal(AbortSignal.timeout(10000)):query;
    const {data,error}=await bounded;
    if(error) throw contentError(message,503,'storage_unavailable',{cause:error});
    return data;
  };
  async function rows(table,owner,apply=q=>q) {
    const all=[];
    for(let offset=0;offset<10000;offset+=500) {
      const data=await checked(apply(db.from(table).select('*').eq('beautician_id',owner)).range(offset,offset+499));
      if(!Array.isArray(data)) throw contentError('Could not read the saved content. Try again.');
      all.push(...data);if(data.length<500) return all;
    }
    throw contentError('There is too much content to load at once. Try a shorter date range.');
  }
  async function profile(owner) {
    const row=await checked(db.from('beauticians').select(PROFILE).eq('id',owner).maybeSingle());
    if(!row) throw contentError('Your salon could not be found.',404);
    return row;
  }
  async function enabled(owner) {
    const row=await profile(owner);
    if(!row.content_v2) throw contentError('This Content update is not enabled for your salon yet.',404);
    return row;
  }
  async function connections(owner) {
    const [instagramRead,googleRead]=await Promise.allSettled([
      checked(db.from('beauticians').select('instagram_page_id,instagram_page_name,instagram_page_token,instagram_token_expires_at').eq('id',owner).single()),
      checked(db.from('google_review_connections').select('location_name,tokens').eq('beautician_id',owner).maybeSingle())]);
    const salon=instagramRead.status==='fulfilled'?instagramRead.value:null,google=googleRead.status==='fulfilled'?googleRead.value:null;
    const expired=!!salon?.instagram_token_expires_at && Date.parse(salon.instagram_token_expires_at)<=+now();
    return {instagram:{connected:!!salon?.instagram_page_id && !!salon?.instagram_page_token && !expired,unavailable:instagramRead.status==='rejected',
      needs_reconnect:expired || (!!salon?.instagram_page_id && !salon?.instagram_page_token),username:salon?.instagram_page_name || ''},
      google:{connected:!!google?.tokens && !!google.location_name,unavailable:googleRead.status==='rejected'}};
  }
  async function context(owner) {
    const p=await profile(owner),stamp=now();
    // Use the same calendar reader as booking suggestions for both halves of
    // the ten-day planning window. Appointment strings stay in wall time.
    const [first,second,posts,treatments,consents,clients,offers,reviews,reviewPermissions,courses,rules,blocks]=await Promise.all([
      gapCalendar(owner,stamp),gapCalendar(owner,new Date(+stamp+7*DAY)),rows('content_posts',owner),rows('treatments',owner),
      rows('photo_consents',owner),rows('clients',owner),rows('promo_codes',owner),rows('reviews',owner),rows('review_post_permissions',owner),
      rows('courses',owner),rows('content_voice_rules',owner,q=>q.is('forgotten_at',null)),
      calendarBlocks(owner,new Date(+stamp-14*DAY),new Date(+stamp+14*DAY),{requireComplete:true})]);
    const wall=nowInSalonWall(p.timezone || 'Europe/London');
    // The injectable clock is converted with the same wall convention as the
    // shared helper, so deterministic tests do not depend on the machine date.
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:p.timezone || 'Europe/London',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(stamp).reduce((a,v)=>(a[v.type]=v.value,a),{});
    const wallDay=`${parts.year}-${parts.month}-${parts.day}`;
    const minNotice=Number(p.booking_policy?.min_booking_hours || 0), maxAdvance=Number(p.booking_policy?.max_advance_days || 0);
    const gaps=[...first.gaps,...second.gaps].filter(g=>g.date>=wallDay && g.date<=new Date(Date.parse(`${wallDay}T12:00:00Z`)+10*DAY).toISOString().slice(0,10));
    const fromWall=new Date(`${wallDay}T${parts.hour}:${parts.minute}:${parts.second}Z`);
    const slotsByTreatment={},durationReads=new Map();
    await Promise.all(treatments.filter(t=>t.is_active && t.booking_enabled!==false).map(async treatment=>{
      const duration=Number(treatment.duration_minutes)+Number(treatment.buffer_minutes || 0);
      if(!durationReads.has(duration)) durationReads.set(duration,freeSlots(owner,{workingHours:p.working_hours,timezone:p.timezone,durationMinutes:duration,
        fromWall,days:11,leadHours:Math.max(0,minNotice),maxSlots:2000,acceptSlot:slot=>!maxAdvance || Date.parse(slot.iso)<=+fromWall+maxAdvance*DAY}));
      slotsByTreatment[treatment.id]=await durationReads.get(duration);
    }));
    return {profile:p,now:stamp,wallDay,wallNow:wall,posts:posts.filter(p=>!p.deleted_at && p.post_type!=='gallery'),photos:posts.filter(p=>p.post_type==='gallery' && !p.deleted_at),
      treatments,consents,clients,offers,reviews,reviewPermissions,courses,rules,gaps,slotsByTreatment,dateHours:blocks.dateHours,closedDays:blocks.closedDays,minNotice,maxAdvance};
  }
  async function getPost(owner,id,{includeDeleted=false}={}) {
    let query=db.from('content_posts').select('*').eq('id',id).eq('beautician_id',owner);
    if(!includeDeleted) query=query.is('deleted_at',null);
    const post=await checked(query.maybeSingle());
    if(!post || post.post_type==='gallery') throw contentError('This post could not be found.',404);
    return post;
  }
  async function savePost(owner,post,changes,{allowClaim=false}={}) {
    const materialChanged=materialHash({...post,...changes})!==materialHash(post);
    const changesState=Object.entries(changes).some(([k,v])=>['status','approved_hash','scheduled_for','deleted_at','held'].includes(k) && JSON.stringify(v)!==JSON.stringify(post[k]));
    const patch={...changes,updated_at:now().toISOString(),version:(post.version || 1)+(materialChanged || changesState?1:0)};
    let query=db.from('content_posts').update(patch).eq('id',post.id).eq('beautician_id',owner).eq('version',post.version || 1);
    if(!allowClaim) query=query.is('publish_claimed_at',null);
    else if(post.publish_claimed_at) query=query.eq('publish_claimed_at',post.publish_claimed_at);
    const saved=await checked(query.select('*').maybeSingle(),'Could not save this post. Your words are still here.');
    if(!saved) throw contentError('This post changed elsewhere. Reload it before saving your words.',409,'version_conflict');
    return saved;
  }
  async function recheck(owner,id,ctx=null,{publishing=false}={}) {
    let post=await getPost(owner,id);
    if(post.external_post_id || post.published_by_owner || post.status==='posted' || (post.publish_claimed_at && !publishing)) return post;
    ctx ||= await context(owner);
    const hydration={};
    if(post.post_type==='testimonial' && !(post.claims || []).some(c=>c.kind==='quote')) {
      const permission=ctx.reviewPermissions.find(p=>p.post_id===post.id);
      const quote=/^“([\s\S]+)”(?:\s|$)/.exec(post.caption || '')?.[1];
      if(permission && quote) hydration.claims=[...(post.claims || []),{kind:'quote',review_id:permission.review_id,text:quote}];
      else hydration.claims=[...(post.claims || []),{kind:'quote',review_id:permission?.review_id || null,text:post.caption || 'Review'}];
    }
    if(!(post.alternatives || []).length && post.image_url && !post.media) {
      hydration.alternatives=[...ctx.photos.filter(p=>p.treatment_id && validConsent(p,ctx)).slice(0,3).map(p=>({type:'photo',photo_id:p.id,image_url:p.after_url || p.image_url})),
        {type:'layout',layout:{kind:'general',title:post.purpose?.title || 'Book your next appointment',lines:['Booking link in bio']}}];
    }
    post={...post,...hydration};
    const changes=checkFacts(post,ctx);
    Object.assign(changes,{...hydration,...changes});
    if(!post.media && !post.image_url && post.kind!=='reel_plan') {
      const media={type:'layout',layout:{kind:'general',title:post.purpose?.title || ctx.profile.business_name || 'Your next appointment',lines:['Booking link in bio']}};
      Object.assign(changes,materialUpdate(post,{...changes,media,image_url:null},'Added a designed image for this post.',now().toISOString()));
    }
    if((changes.media?.type==='layout' && changes.image_url===null) || (post.media && post.media.type!=='none' && !post.image_url)) {
      changes.image_url=await artwork(owner,{...post,...changes},ctx.profile);
      changes.material_hash=materialHash({...post,...changes});
    }
    if(publishing) {changes.publish_key=post.publish_key;changes.publish_claimed_at=post.publish_claimed_at;}
    if(!post.material_hash) changes.material_hash=materialHash({...post,...changes});
    return savePost(owner,post,changes,{allowClaim:publishing});
  }
  async function ensureLink(owner,post,p) {
    if(post.link_url) return post.link_url;
    await checked(db.from('content_campaigns').upsert({beautician_id:owner,post_id:post.id},{onConflict:'post_id',ignoreDuplicates:true}));
    const campaign=await checked(db.from('content_campaigns').select('token').eq('post_id',post.id).eq('beautician_id',owner).single());
    const link=contentBookingUrl(p.booking_slug,campaign.token);
    if(!link) throw contentError('Set up your booking page before preparing posts.',409,'booking_link_missing');
    return link;
  }
  async function artwork(owner,post,p) {
    if(post.kind==='reel_plan' || post.media?.type==='none') return null;
    if(renderArtwork) return renderArtwork(owner,post,p);
    const module=await import('./artwork.js');
    return module.renderContentV2Artwork(owner,post,p);
  }
  async function results(owner,days=30) {
    const from=new Date(+now()-days*DAY).toISOString();
    const [posts,campaigns,sources,appointments,treatments]=await Promise.all([rows('content_posts',owner),rows('content_campaigns',owner),
      rows('content_booking_sources',owner),rows('appointments',owner,q=>q.gte('created_at',from)),rows('treatments',owner)]);
    const measured=campaigns.map(c=>{
      const ids=new Set(sources.filter(s=>s.campaign_id===c.id).map(s=>s.appointment_id));
      const booked=appointments.filter(a=>ids.has(a.id)),confirmed=booked.filter(a=>['confirmed','in_progress','completed'].includes(a.status));
      return {post_id:c.post_id,title:posts.find(p=>p.id===c.post_id)?.purpose?.title || posts.find(p=>p.id===c.post_id)?.caption?.slice(0,80) || 'Your post',
        bookings:confirmed.length,value_pence:confirmed.reduce((n,a)=>n+Number(a.price_cents || 0),0),pending:booked.filter(a=>a.status==='pending').length,
        cancelled:booked.filter(a=>['cancelled','cancelled_by_client','cancelled_by_beautician','no_show','rescheduled'].includes(a.status)).length};
    });
    const attributed=new Set(sources.map(s=>s.appointment_id));
    const inferred=[];
    for(const a of appointments.filter(a=>!attributed.has(a.id) && ['confirmed','in_progress','completed'].includes(a.status))) {
      const p=posts.filter(p=>p.posted_at && (p.external_post_id || p.published_by_owner) && Date.parse(a.created_at)>=Date.parse(p.posted_at) && Date.parse(a.created_at)<=Date.parse(p.posted_at)+2*DAY)
        .find(p=>(p.claims || []).some(c=>c.treatment_id===a.treatment_id || c.treatment_ids?.includes(a.treatment_id)));
      if(p) inferred.push({post_id:p.id,title:p.purpose?.title || 'Your post',treatment:treatments.find(t=>t.id===a.treatment_id)?.name || 'treatment',when:a.created_at,label:'Not measured',
        explanation:`Florrie thinks "${p.purpose?.title || 'Your post'}" may have helped a ${treatments.find(t=>t.id===a.treatment_id)?.name || 'treatment'} booking made ${a.created_at.slice(0,10)}. It didn't come through the link, so it isn't counted above.`});
    }
    const total=measured.reduce((sum,row)=>({bookings:sum.bookings+row.bookings,value_pence:sum.value_pence+row.value_pence,pending:sum.pending+row.pending,cancelled:sum.cancelled+row.cancelled}),{bookings:0,value_pence:0,pending:0,cancelled:0});
    return {days,measured,total,inferred,explanation:'Instagram feed captions do not have clickable links. Florrie cannot change your bio link or add Story link stickers. Measured bookings come through Google Book buttons, links in replies and links you paste yourself. Booking value is not money collected.'};
  }
  async function home(owner) {
    await enabled(owner);
    const ctx=await context(owner),links=await connections(owner);
    const open=[];
    for(const post of ctx.posts) {
      if(!['posted'].includes(post.status) && !post.publish_claimed_at) {
        try {open.push(await recheck(owner,post.id,ctx));} catch(error) {if(error.status===409) open.push(await getPost(owner,post.id));else throw error;}
      } else open.push(post);
    }
    const visible=open.map(p=>publicPost(p,links));
    const check=visible.filter(p=>p.kind!=='reel_plan' && p.status==='draft' && !p.publish_claimed_at)
      .sort((a,b)=>Number(!!b.change_note)-Number(!!a.change_note) || String(a.created_at).localeCompare(String(b.created_at)));
    const rank={"Didn't post":0,Posting:1,'Waiting for Instagram':2,Scheduled:3,'Approved, not scheduled':4,Posted:5};
    const coming=visible.filter(p=>p.kind!=='reel_plan' && p.status!=='draft' && (p.state!=='Posted' || Date.parse(p.posted_at)>+now()-3*DAY))
      .sort((a,b)=>(rank[a.state] ?? 6)-(rank[b.state] ?? 6) || String(a.scheduled_for || a.posted_at).localeCompare(String(b.scheduled_for || b.posted_at)));
    const latest=(await rows('content_preparations',owner,q=>q.order('created_at',{ascending:false})))[0];
    const prep=latest && ['queued','running','failed'].includes(latest.status)?latest:null;
    const report=await results(owner,30);
    return {posts_to_check:check,coming_up:coming,reel_plans:visible.filter(p=>p.kind==='reel_plan'),preparation:prep,
      results_summary:report.total,connections:links,ideas:contentIdeas(ctx),counts:{total:ctx.posts.length,posts_to_check:check.length,coming_up:coming.length,
        photos:ctx.photos.filter(p=>p.treatment_id && validConsent(p,ctx)).length,offers:ctx.offers.filter(p=>offerLive(p,now())).length,voice_rules:ctx.rules.length}};
  }
  async function preparation(owner,id) {
    const row=await checked(db.from('content_preparations').select('*').eq('id',id).eq('beautician_id',owner).maybeSingle());
    if(!row) throw contentError('This preparation could not be found.',404);
    return row;
  }
  async function prepare(owner,requestId,request,{automatic=false}={}) {
    const salon=await enabled(owner);
    if(!contentBookingUrl(salon.booking_slug,'0'.repeat(32))) throw contentError('Set up your booking page before preparing posts.',409,'booking_link_missing');
    if(!isUuid(requestId)) throw contentError('Start this request again with a new request ID.',400);
    request=validateRequest(request);
    if(automatic) request.automatic=true;
    const existing=await checked(db.from('content_preparations').select('*').eq('beautician_id',owner).eq('request_id',requestId).maybeSingle());
    if(existing) return existing;
    const running=(await rows('content_preparations',owner,q=>q.in('status',['queued','running'])))[0];
    if(running) throw contentError('Florrie is already preparing your posts.',409,'preparation_running',{preparation:running});
    const label={week:'Preparing your posts',fill_gap:'Preparing your availability post',show_work:'Preparing a post from your photos',offer:'Preparing your offer',review:'Preparing a review post',training:'Preparing your training post',general:'Preparing your post'}[request.type];
    const {data,error}=await db.from('content_preparations').insert({id:randomUUID(),beautician_id:owner,request_id:requestId,request,label,status:'queued',step:0,
      details:{steps:STEP_LABELS.map(label=>({label,status:'pending',result:null}))},post_ids:[],notes:[],attempts:0,created_at:now().toISOString(),updated_at:now().toISOString()}).select('*').single();
    if(error) {
      if(error.code==='23505') {
        const rowsNow=await rows('content_preparations',owner);
        const same=rowsNow.find(p=>p.request_id===requestId);if(same) return same;
        throw contentError('Florrie is already preparing your posts.',409,'preparation_running',{preparation:rowsNow.find(p=>['queued','running'].includes(p.status))});
      }
      throw contentError('Could not start preparing your posts. Try again.');
    }
    if(autoKick) queueMicrotask(()=>processPreparation(data).catch(error=>logger.warn({err:error,preparationId:data.id},'Content preparation will resume with its worker')));
    return data;
  }
  async function ask(owner,requestId,text) {
    if(typeof text!=='string' || !text.trim() || text.length>1000) throw contentError('Tell Florrie what you would like to post, in under 1,000 characters.',400);
    const ctx=await context(owner);
    const request=interpretRequest(text,ctx) || await writer.interpret(text,ctx);
    if(request.needs_photos) return {needs:'photos'};
    return prepare(owner,requestId,{...request,text});
  }
  async function processPreparation(observed) {
    if(!observed || !['queued','running'].includes(observed.status) || (observed.lease_until && Date.parse(observed.lease_until)>+now())) return null;
    if(!(await profile(observed.beautician_id)).content_v2) return null;
    const token=randomUUID();
    const claimed=await checked(db.from('content_preparations').update({status:'running',attempts:observed.attempts+1,lease_token:token,lease_until:new Date(+now()+LEASE_MS).toISOString(),updated_at:now().toISOString()})
      .eq('id',observed.id).eq('beautician_id',observed.beautician_id).eq('updated_at',observed.updated_at).select('*').maybeSingle());
    if(!claimed) return null;
    let row=claimed;
    async function save(patch) {
      const next=await checked(db.from('content_preparations').update({updated_at:now().toISOString(),lease_until:new Date(+now()+LEASE_MS).toISOString(),...patch})
        .eq('id',row.id).eq('beautician_id',row.beautician_id).eq('lease_token',token).eq('status','running').select('*').maybeSingle());
      if(!next) throw contentError('This preparation is continuing elsewhere.',409,'lease_lost');
      row=next;
    }
    try {
      const ctx=await context(row.beautician_id);
      for(let stage=row.step;stage<5;stage++) {
        let drafts=row.details.drafts || [],notes=row.notes || [],result;
        if(stage===0) {
          const planned=planPosts(row.request,ctx);drafts=planned.drafts;notes=planned.notes;
          result=drafts.find(p=>p.purpose.type==='fill_gap')?.purpose.title || `${drafts.filter(p=>p.kind==='post').length} posts from your saved salon details`;
        } else if(stage===1) {
          result=`${new Set(drafts.flatMap(mediaPhotoIds)).size} photos with permission`;
          drafts=await Promise.all(drafts.map(async p=>({...p,image_url:await artwork(row.beautician_id,p,ctx.profile),preparation_id:row.id})));
        } else if(stage===2) {
          const written=[];
          for(const post of drafts) {
            const words=post.kind==='reel_plan'?{caption:post.caption,hashtags:post.hashtags}:await writer.write(post,ctx);
            written.push({...post,...words,prepared_caption:words.caption,prepared_hashtags:words.hashtags || []});
          }
          drafts=written;result=`${drafts.filter(p=>p.kind==='post').length} captions written`;
        } else if(stage===3) {
          const fresh=await context(row.beautician_id);
          drafts=await Promise.all(drafts.map(async post=>{
            const updated={...post,...checkFacts(post,fresh)};
            if(updated.media?.type!=='none' && updated.kind!=='reel_plan' && !updated.image_url) updated.image_url=await artwork(row.beautician_id,updated,fresh.profile);
            return updated;
          }));
          result='Prices, times and permissions checked';
        } else {
          const taken=ctx.posts.map(p=>p.scheduled_for).filter(Boolean),saved=[];
          for(const planned of drafts) {
            let post=await checked(db.from('content_posts').select('*').eq('id',planned.id).eq('beautician_id',row.beautician_id).maybeSingle());
            if(!post) {
              const timing=proposeTime(planned,ctx,taken);taken.push(timing.scheduled_for);
              const draft={...planned,...timing,material_hash:materialHash({...planned,...timing}),updated_at:now().toISOString()};
              const {data,error}=await db.from('content_posts').upsert(draft,{onConflict:'id',ignoreDuplicates:true}).select('*').maybeSingle();
              if(error) throw contentError('Could not save the prepared post. Florrie will try again.');
              post=data || await getPost(row.beautician_id,planned.id);
            }
            const link=await ensureLink(row.beautician_id,post,ctx.profile);
            if(post.link_url!==link) post=await savePost(row.beautician_id,post,{link_url:link,material_hash:materialHash({...post,link_url:link})});
            saved.push(post);
          }
          drafts=saved;result='Each post has a time and its own booking link';
        }
        const steps=STEP_LABELS.map((label,index)=>({label,status:index<=stage?'done':'pending',result:index===stage?result:row.details.steps?.[index]?.result || null}));
        await save({step:stage+1,details:{...row.details,drafts,steps},post_ids:drafts.map(p=>p.id),notes});
      }
      await save({status:'done',error:null,lease_token:null,lease_until:null});
      return row;
    } catch(error) {
      // A failed save can have committed. Leave the lease intact rather than
      // overwriting durable progress with an earlier in-memory snapshot.
      if(error.code==='lease_lost' || error.code==='storage_unavailable') throw error;
      if(row.attempts>=3 || error.status===409) {
        await save({status:'failed',error:error.message,lease_token:null,lease_until:null});
      }
      throw error;
    }
  }
  async function processPending() {
    const pending=await checked(db.from('content_preparations').select('*').in('status',['queued','running']).order('created_at',{ascending:true}).limit(20));
    for(const row of pending || []) {try{await processPreparation(row);}catch(error){logger.warn({err:error,preparationId:row.id},'Content preparation paused for retry');}}
    return {checked:pending?.length || 0};
  }
  async function edit(owner,id,{caption,expected_version,hashtags}) {
    if(typeof caption!=='string' || caption.length>2200 || !caption.trim()) throw contentError('Write a caption between 1 and 2,200 characters.',400);
    if(!Number.isSafeInteger(expected_version)) throw contentError('Reload this post before editing it.',400);
    if(hashtags!==undefined && (!Array.isArray(hashtags) || hashtags.length>30 || hashtags.some(tag=>typeof tag!=='string' || !/^#?[\p{L}\d_]{1,50}$/u.test(tag)))) {
      throw contentError('Use up to 30 hashtags, with letters, numbers or underscores.',400);
    }
    if(hashtags!==undefined) hashtags=[...new Map(hashtags.map(tag=>{const normalized=tag.startsWith('#')?tag:`#${tag}`;return [normalized.toLowerCase(),normalized];})).values()];
    const post=await getPost(owner,id);assertEditable(post);
    if(post.version!==expected_version) throw contentError('This post changed elsewhere. Your unsent words are still here.',409,'version_conflict',{post:publicPost(post)});
    const saved=await savePost(owner,post,materialUpdate(post,{caption,edited_by_owner:true,...(hashtags!==undefined?{hashtags}:{}),
      prepared_hashtags:post.prepared_hashtags || post.hashtags || []},'You edited the words',now().toISOString()));
    return {post:publicPost(saved,await connections(owner))};
  }
  async function revise(owner,id,instruction) {
    if(typeof instruction!=='string' || !instruction.trim() || instruction.length>300) throw contentError('Keep the change under 300 characters.',400);
    const post=await getPost(owner,id);assertEditable(post);
    const ctx=await context(owner);let changes,note;
    if(instruction==='other_photo') {
      const alternative=(post.alternatives || []).find(m=>mediaPhotoIds({media:m}).every(id=>ctx.photos.some(p=>p.id===id && validConsent(p,ctx,post.platform))));
      if(!alternative) throw contentError('Add another photo with permission first.',409);
      changes={media:alternative,alternatives:[...(post.alternatives || []).filter(m=>m!==alternative),post.media]};
      changes.image_url=await artwork(owner,{...post,...changes},ctx.profile);note='Changed the photo. Your words are the same.';
    } else {
      const offline=reviseOffline(post,instruction,ctx);
      if(offline) {const {note:message,...words}=offline;changes=words;note=message;}
      else {changes=await writer.write(post,ctx,instruction);note='Changed the wording. The checked facts are the same.';}
      if((changes.caption && changes.caption!==post.caption) || (changes.hashtags && JSON.stringify(changes.hashtags)!==JSON.stringify(post.hashtags))) {
        Object.assign(changes,{edited_by_owner:false,prepared_caption:changes.caption || post.caption,prepared_hashtags:changes.hashtags || post.hashtags || []});
      }
    }
    const patch=materialUpdate(post,changes,note,now().toISOString());
    patch.last_revision={note,at:now().toISOString()};
    let saved=await savePost(owner,post,patch);saved=await recheck(owner,saved.id,ctx);
    return {post:publicPost(saved,await connections(owner)),note};
  }
  async function undo(owner,id) {
    const post=await getPost(owner,id);assertEditable(post);
    const previous=post.history?.at(-1);if(!previous) throw contentError('There is no earlier change to restore.',409);
    const {at,note,...restored}=previous;
    let saved=await savePost(owner,post,{...restored,history:post.history.slice(0,-1),material_hash:materialHash({...post,...restored}),status:'draft',approved_at:null,approved_hash:null,
      change_note:null,last_revision:{note:'Restored the previous version.',at:now().toISOString()}});
    saved=await recheck(owner,saved.id);
    return {post:publicPost(saved,await connections(owner))};
  }
  async function approve(owner,id,expectedHash) {
    const post=await recheck(owner,id);assertEditable(post);
    if(post.kind==='reel_plan') throw contentError('This is a filming plan. There is no video to publish yet.',409);
    if(post.facts?.some(f=>f.status==='block')) throw contentError(post.facts.find(f=>f.status==='block').label,409,'facts_blocked',{post:publicPost(post)});
    if(typeof expectedHash!=='string' || expectedHash!==materialHash(post) || expectedHash!==post.material_hash) throw contentError('This post changed since you checked it. Approve the updated version.',409,'hash_changed',{post:publicPost(post)});
    const past=post.scheduled_for && Date.parse(post.scheduled_for)<=+now();
    const saved=await savePost(owner,post,{status:post.scheduled_for && !post.held?'scheduled':'approved',approved_at:now().toISOString(),approved_hash:post.material_hash,
      scheduled_for:past?new Date(+now()+10*60000).toISOString():post.scheduled_for,change_note:null,failure_reason:null});
    const learned=[];
    if(post.edited_by_owner && post.prepared_caption && (post.prepared_caption!==post.caption || JSON.stringify(post.prepared_hashtags)!==JSON.stringify(post.hashtags))) {
      const candidates=learnFromEdit(post.prepared_caption,post.caption,now().toISOString(),{beforeHashtags:post.prepared_hashtags,afterHashtags:post.hashtags});
      const existing=await rows('content_voice_rules',owner);
      const same=(a,b)=>a.kind===b.kind && (a.from_text || null)===(b.from_text || null) && (a.to_text || null)===(b.to_text || null) && (a.value ?? null)===(b.value ?? null);
      for(const rule of candidates.filter(r=>!existing.some(e=>same(e,r) && (!e.forgotten_at || e.source_post_id===post.id)))) {
        const {data,error}=await db.from('content_voice_rules').insert({...rule,beautician_id:owner,source_post_id:post.id}).select('*').single();
        if(error?.code==='23505') continue;
        if(error || !data) throw contentError('Your post is approved, but the writing preference could not be saved.');
        learned.push(data);
      }
    }
    return {post:publicPost(saved,await connections(owner)),learned_rules:learned,note:past?'That time had passed, so it will go out in 10 minutes.':undefined};
  }
  async function timing(owner,id,at) {
    if(at!==null && (typeof at!=='string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(at) || !Number.isFinite(Date.parse(at)))) throw contentError('Choose a date and time with its timezone.',400);
    const post=await getPost(owner,id);assertEditable(post);
    const saved=await savePost(owner,post,{scheduled_for:at?new Date(at).toISOString():null,held:at===null,
      ...(post.approved_hash?{status:at?'scheduled':'approved'}:{}),timing_reason:at?'The time you chose':'Held until you choose a time'});
    return {post:publicPost(saved,await connections(owner)),note:'Time changed. Your approval still stands.'};
  }
  async function action(owner,id,name) {
    let post=await getPost(owner,id,{includeDeleted:name==='restore'});assertEditable(post);
    if(name==='move-back') post=await savePost(owner,post,{status:'draft',approved_at:null,approved_hash:null,change_note:null});
    else if(name==='remove') {
      if(!['draft','approved','scheduled'].includes(post.status)) throw contentError('Only posts waiting for approval or publishing can be removed.',409);
      post=await savePost(owner,post,{deleted_at:now().toISOString(),status:'draft',approved_at:null,approved_hash:null});
    } else if(name==='restore') post=await savePost(owner,post,{deleted_at:null,status:'draft',approved_at:null,approved_hash:null});
    else if(name==='posted-by-owner') {
      post=await recheck(owner,id);assertEditable(post);
      if(post.kind==='reel_plan' || post.facts?.some(f=>f.status==='block')) throw contentError('Check the facts and permission before marking this post as posted.',409,'facts_blocked');
      if(!post.approved_hash || post.approved_hash!==materialHash(post)) throw contentError('Check and approve this post before marking it as posted.',409);
      post=await savePost(owner,post,{status:'posted',published_by_owner:true,posted_at:now().toISOString(),failure_reason:null});
    } else if(['retry','post-now'].includes(name)) {
      post=await recheck(owner,id);
      if(!post.approved_hash || post.approved_hash!==materialHash(post)) throw contentError('Check and approve this post before it goes out.',409);
      post=await savePost(owner,post,{status:'scheduled',scheduled_for:now().toISOString(),held:false});
      const send=publish || (await import('./publish.js')).publishContentV2Post;
      await send(owner,id);
      post=await getPost(owner,id);
    } else throw contentError('Choose a supported post action.',400);
    return {post:publicPost(post,await connections(owner))};
  }
  async function photos(owner) {
    const ctx=await context(owner);
    return {photos:ctx.photos.map(p=>({...p,permission_status:validConsent(p,ctx)?p.permission_status:p.permission_status==='no_client'?'pending':p.permission_status==='granted'?'withdrawn':p.permission_status})),
      treatments:ctx.treatments.filter(t=>t.is_active).map(({id,name})=>({id,name})),clients:ctx.clients.map(({id,first_name,last_name})=>({id,first_name,last_name}))};
  }
  function ownedImage(owner,value) {
    if(value==null) return null;
    try {
      const url=new URL(value),base=new URL(process.env.SUPABASE_URL);
      const path=decodeURIComponent(url.pathname);
      if(url.origin!==base.origin || !path.startsWith(`/storage/v1/object/public/content-images/${owner}/`) || path.split('/').includes('..') || url.username || url.password) throw new Error();
      return url.href;
    } catch {throw contentError('Upload this photo to your salon first.',400);}
  }
  async function savePhoto(owner,input) {
    const ctx=await context(owner),existing=input.id?ctx.photos.find(p=>p.id===input.id):null;
    if(input.id && !existing) throw contentError('This photo could not be found.',404);
    if(input.treatment_id!=null && !ctx.treatments.some(t=>t.id===input.treatment_id)) throw contentError('Choose a treatment from your price list.',400);
    if(input.client_id!=null && !ctx.clients.some(c=>c.id===input.client_id)) throw contentError('Choose one of your clients.',400);
    if(input.permission_status!=null && !['granted','no_client','pending','withdrawn'].includes(input.permission_status)) throw contentError('Choose the permission for this photo.',400);
    const client=input.client_id===undefined?existing?.client_id:input.client_id;
    const candidate=ctx.consents.find(c=>c.client_id===client && (!input.consent_id || c.id===input.consent_id) && c.status==='granted' && !c.revoked_at && (!c.expires_at || Date.parse(c.expires_at)>+now()) && c.permitted_uses?.includes('instagram'));
    let permission=input.permission_status || existing?.permission_status || 'pending';
    if(input.client_id && candidate && permission==='pending') permission='granted';
    if(permission==='granted' && !candidate) permission='pending';
    if(permission==='no_client' && client) throw contentError('Choose either a client or No client in it.',400);
    const patch={treatment_id:input.treatment_id===undefined?existing?.treatment_id || null:input.treatment_id,
      treatment_name:ctx.treatments.find(t=>t.id===(input.treatment_id || existing?.treatment_id))?.name || null,
      client_id:client || null,consent_id:permission==='granted'?candidate.id:null,permission_status:permission,updated_at:now().toISOString()};
    for(const key of ['image_url','before_url','after_url']) if(input[key]!==undefined) patch[key]=ownedImage(owner,input[key]);
    if(!existing) {
      if(!patch.image_url && !patch.after_url) throw contentError('Add a photo first.',400);
      Object.assign(patch,{id:randomUUID(),beautician_id:owner,platform:'instagram',post_type:'gallery',status:'draft',image_url:patch.after_url || patch.image_url,caption:'',created_at:now().toISOString()});
    }
    const photo=existing?await checked(db.from('content_posts').update(patch).eq('id',existing.id).eq('beautician_id',owner).eq('post_type','gallery').select('*').single()):await checked(db.from('content_posts').insert(patch).select('*').single());
    return {photo};
  }
  async function voice(owner) {return {rules:(await rows('content_voice_rules',owner,q=>q.is('forgotten_at',null))).map(r=>({...r,...describeRule(r)}))};}
  async function forget(owner,id) {
    const rule=await checked(db.from('content_voice_rules').update({forgotten_at:now().toISOString()}).eq('id',id).eq('beautician_id',owner).select('id').maybeSingle());
    if(!rule) throw contentError('This writing preference could not be found.',404);
    return {forgotten:true};
  }
  async function offers(owner) {
    const ctx=await context(owner);
    return {offers:ctx.offers.filter(p=>p.marketing_approved_at).map(p=>{
      const enriched={...p,treatments:ctx.treatments.filter(t=>p.treatment_ids?.includes(t.id))};
        return {...enriched,client_reply:offerForMessaging(enriched,{now:now()})?.client_reply || 'Check the treatment and dates for this offer before sharing it.'};
    })};
  }
  async function recheckDue() {
    const due=await checked(db.from('content_posts').select('id,beautician_id').in('status',['draft','approved','scheduled']).is('deleted_at',null).is('publish_claimed_at',null)
      .lte('scheduled_for',new Date(+now()+2*DAY).toISOString()).limit(100));
    for(const row of due || []) {
      try{if((await profile(row.beautician_id)).content_v2) await recheck(row.beautician_id,row.id);}catch(error){logger.warn({err:error,postId:row.id},'Content fact check will retry');}
    }
  }
  async function prepareOpportunities() {
    const salons=await checked(db.from('beauticians').select('id').eq('content_v2',true).order('id').limit(100));
    const started=[];
    for(const salon of salons || []) {
      try {
        const history=await rows('content_preparations',salon.id);
        const manual=history.filter(p=>p.status==='done' && p.request?.automatic!==true);
        if(!manual.length || history.some(p=>['queued','running'].includes(p.status))) continue;
        const ctx=await context(salon.id);
        if(ctx.posts.some(p=>p.kind!=='reel_plan' && (p.status==='draft' || p.status==='failed'))) continue;
        if(ctx.posts.filter(p=>p.kind!=='reel_plan' && ['approved','scheduled'].includes(p.status)).length>=7) continue;
        const latestWeek=history.filter(p=>p.status==='done' && p.request?.type==='week').sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)))[0];
        const latestManual=manual.sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)))[0];
        let request,key;
        if((latestWeek && +now()-Date.parse(latestWeek.created_at)>=7*DAY) || (!latestWeek && +now()-Date.parse(latestManual.created_at)>=DAY)) {
          const day=new Date(`${ctx.wallDay}T12:00:00Z`),offset=(day.getUTCDay()+6)%7;
          const week=new Date(+day-offset*DAY).toISOString().slice(0,10);
          request={type:'week'};key=`week:${week}`;
        } else {
          const coveredDays=new Set(ctx.posts.map(p=>p.purpose?.day));
          const gap=contentIdeas(ctx).find(i=>i.request.type==='fill_gap' && !coveredDays.has(i.request.day));
          const usedPhotos=new Set(ctx.posts.flatMap(mediaPhotoIds));
          const photo=ctx.photos.find(p=>p.treatment_id && validConsent(p,ctx) && !usedPhotos.has(p.id));
          const offer=ctx.offers.find(p=>offerLive(p,now()) && !ctx.posts.some(post=>post.claims?.some(c=>c.promo_code_id===p.id)));
          const review=ctx.reviews.find(r=>r.is_public && r.platform!=='google' && ctx.reviewPermissions.some(p=>p.review_id===r.id)
            && !ctx.posts.some(p=>p.claims?.some(c=>c.review_id===r.id)));
          if(gap) {request=gap.request;key=`gap:${request.day}`;}
          else if(photo) {request={type:'show_work',photo_ids:[photo.id]};key=`photo:${photo.id}`;}
          else if(offer) {request={type:'offer',promo_code_id:offer.id};key=`offer:${offer.id}:${offer.marketing_approved_at}`;}
          else if(review) {request={type:'review',review_id:review.id};key=`review:${review.id}`;}
        }
        if(!request) continue;
        const id=automaticRequestId(salon.id,key);
        if(history.some(p=>p.request_id===id)) continue;
        const preparation=await prepare(salon.id,id,request,{automatic:true});
        started.push({owner:salon.id,preparation_id:preparation.id,type:request.type});
      } catch(error) {
        if(error.code!=='preparation_running') logger.warn({err:error,owner:salon.id},'Content opportunity will be checked again');
      }
    }
    return {started};
  }
  return {home,context,connections,profile,enabled,getPost,recheckPost:recheck,results,prepare,preparation,ask,processPreparation,processPending,recheckDue,
    edit,revise,undo,approve,timing,action,photos,savePhoto,voice,forget,offers,prepareOpportunities,
    listPosts:async(owner,status)=>({posts:(await rows('content_posts',owner,q=>q.is('deleted_at',null).eq('status',status || 'posted'))).filter(p=>p.post_type!=='gallery').map(p=>publicPost(p))})};
}

export const contentV2=createContentV2Service();
export const recheckPost=(owner,id,options)=>contentV2.recheckPost(owner,id,null,options);
export const getContentHome=owner=>contentV2.home(owner);
export const startPreparation=(owner,requestId,request)=>contentV2.prepare(owner,requestId,request);
export const askContent=(owner,requestId,text)=>contentV2.ask(owner,requestId,text);
export const processContentPreparations=()=>contentV2.processPending();
export const recheckDueContent=()=>contentV2.recheckDue();
export const prepareContentOpportunities=()=>contentV2.prepareOpportunities();
