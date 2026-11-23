import { createHash } from 'node:crypto';

export const contentError = (message, status = 503, code = 'content_unavailable', extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
export const isUuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export const clone = value => JSON.parse(JSON.stringify(value));

// jsonb orders object keys by UTF-8 byte length, then bytes. Keep this in sync
// with the SQL migration so saved approvals survive the first application read.
export function postgresJson(value) {
  if (value == null) return 'null';
  if (Array.isArray(value)) return `[${value.map(postgresJson).join(', ')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort((a,b) => Buffer.byteLength(a)-Buffer.byteLength(b) || Buffer.compare(Buffer.from(a),Buffer.from(b)));
    return `{${keys.map(key => `${JSON.stringify(key)}: ${postgresJson(value[key])}`).join(', ')}}`;
  }
  return JSON.stringify(value);
}
export function materialHash(post) {
  return createHash('md5').update(postgresJson([post.caption || '', post.hashtags || [], post.media || null,
    post.image_url || '', post.link_url || '', post.platform || 'instagram', post.format || post.media_kind || 'feed'])).digest('hex');
}
export function ownerState(post, connections = {}) {
  if (post.kind === 'reel_plan') return 'To film';
  if (post.external_post_id || post.published_by_owner) return 'Posted';
  if (post.status === 'posted') return 'Needs a decision';
  if (post.publish_claimed_at || post.publish_uncertain_since) return 'Posting';
  if (post.status === 'failed') return "Didn't post";
  if (post.change_note?.kind === 'blocked' || post.facts?.some(f => f.status === 'block')) return 'Needs a decision';
  if (post.status === 'draft') return post.change_note ? 'Needs your OK again' : 'Ready to check';
  if (['approved','scheduled'].includes(post.status)) {
    if (!post.scheduled_for || post.held) return 'Approved, not scheduled';
    return connections[post.platform || 'instagram']?.connected ? 'Scheduled' : post.platform==='google'?'Waiting for Google':'Waiting for Instagram';
  }
  return 'Ready to check';
}
export function publicPost(post, connections) {
  const { history, ...safe } = post;
  return { ...safe, state: ownerState(post, connections), channel: post.platform,
    ...(post.status==='posted' && !post.external_post_id && !post.published_by_owner?{failure_reason:'Florrie has no confirmation that this post went out.'}:{}),
    timing: { at: post.scheduled_for, reason: post.timing_reason },
    can_undo: !!history?.length && !post.publish_claimed_at && !post.external_post_id && !post.published_by_owner,
    activity: (history || []).slice(-3).map(h => ({ at: h.at, note: h.note || 'Post updated' })) };
}
const SNAPSHOT_FIELDS = ['caption','hashtags','claims','media','image_url','purpose','alternatives','prepared_caption','prepared_hashtags','edited_by_owner','link_url','format','platform'];
export function snapshot(post, note, at) {
  return { ...Object.fromEntries(SNAPSHOT_FIELDS.map(key => [key,post[key] ?? null])), note, at };
}
export function materialUpdate(post, changes, note, at) {
  const next = { ...post, ...changes };
  const changed = materialHash(next) !== materialHash(post);
  return { ...changes, material_hash: materialHash(next),
    ...(changed ? { status:'draft', approved_at:null, approved_hash:null, publish_key:null,
      history:[...(post.history || []),snapshot(post,note,at)].slice(-30),
      change_note:{kind:'edit',reasons:[note],changes:[],at,was_approved:!!post.approved_hash} } : {}) };
}
export function assertEditable(post) {
  if (post.publish_claimed_at || post.publish_uncertain_since) throw contentError('This post is going out. Wait for Instagram to confirm it.',409);
  if (post.external_post_id || post.published_by_owner || post.status === 'posted') throw contentError('This post has already gone out.',409);
}
export const money = pence => `£${(Number(pence)/100).toFixed(Number(pence)%100 ? 2 : 0)}`;
export const weekday = day => new Intl.DateTimeFormat('en-GB',{weekday:'long',timeZone:'UTC'}).format(new Date(`${day.slice(0,10)}T12:00:00Z`));
export const dayMonth = day => new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'long',timeZone:'UTC'}).format(new Date(`${day.slice(0,10)}T12:00:00Z`));
export const clock = minutes => `${Math.floor(minutes/60)%12 || 12}${minutes%60 ? `.${String(minutes%60).padStart(2,'0')}` : ''}${minutes<720 ? 'am':'pm'}`;
export const minutes = time => Number(time.slice(0,2))*60+Number(time.slice(3,5));
