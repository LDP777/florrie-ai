import { supabase } from '../config.js';

export async function contentReadyThought(beautician, { db = supabase, now = () => new Date() } = {}) {
  if (!beautician.content_v2) return [];
  const query = db.from('content_posts').select('id', { count: 'exact' })
    .eq('beautician_id', beautician.id).eq('status', 'draft').neq('post_type', 'gallery')
    .neq('kind', 'reel_plan').is('deleted_at', null).is('publish_claimed_at', null)
    .order('created_at', { ascending: false }).limit(1);
  const { data, count, error } = await (typeof query.abortSignal === 'function' ? query.abortSignal(AbortSignal.timeout(6000)) : query);
  if (error) throw new Error('Could not check the posts waiting for approval.');
  if (!count || !data?.[0]) return [];
  const title = `${count} ${count === 1 ? 'post ready' : 'posts ready'} to check`;
  const link = '/content?view=drafts';
  return [{ id: `content-ready-${data[0].id}`, type: 'content_ready', icon: 'image', title,
    summary: title, action_label: `Check ${count} ${count === 1 ? 'post' : 'posts'}`,
    evidence: { facts: [`${count} saved ${count === 1 ? 'post needs' : 'posts need'} your approval.`, 'Nothing goes out until you approve it.'], link_to: link },
    action: { kind: 'navigate' }, link_to: link, priority_band: 2, urgency: 20, impact_pence: 0,
    expires_at: new Date(now().getTime() + 3600000).toISOString(), expires_frame: 'utc' }];
}
