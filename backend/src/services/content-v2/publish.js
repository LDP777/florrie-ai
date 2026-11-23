import { supabase } from '../../config.js';
import logger from '../../lib/logger.js';

const RECONCILE_AFTER_MS = 10 * 60 * 1000;
const problem = message => Object.assign(new Error(message), { status: 503 });
const captionFor = post => [post.caption, '', post.hashtags?.join(' ')].filter(Boolean).join('\n');

// Claims never expire into another send. A worker that dies after dispatch is
// recovered by reading the provider before any retry can create another post.
export function createContentV2Publisher({ db = supabase, recheckPost, materialHash, publishLegacy,
  fetchImpl = (...args) => fetch(...args), now = () => new Date(), google } = {}) {
  const posts = () => db.from('content_posts');
  async function read(owner, id) {
    const result = await posts().select('*').eq('beautician_id', owner).eq('id', id).maybeSingle();
    if (result.error) throw problem('Could not read this post. Try again.');
    if (!result.data || result.data.deleted_at) throw Object.assign(new Error('This post is no longer available.'), { status: 404 });
    return result.data;
  }
  async function write(owner, post, patch) {
    const result = await posts().update(patch).eq('beautician_id', owner).eq('id', post.id)
      .eq('publish_key', post.publish_key).eq('publish_claimed_at', post.publish_claimed_at).select('*').maybeSingle();
    if (result.error || !result.data) throw problem('Could not save the publishing result. Florrie will check it again.');
    return result.data;
  }
  async function event(owner, post, summary) {
    const result = await db.from('ai_actions').insert({ beautician_id: owner, action_type: 'content_posted',
      digital_employee: 'content', summary, details: { post_id: post.id }, confidence: 1,
      autonomous: false, outcome: 'success' });
    if (result.error) logger.warn({ err: result.error, postId: post.id }, 'Content publishing activity could not be saved');
  }
  async function connection(owner) {
    const result = await db.from('beauticians').select('id,content_v2,instagram_page_id,instagram_page_token,instagram_token_expires_at')
      .eq('id', owner).maybeSingle();
    if (result.error || !result.data) throw problem('Could not check your publishing connection. Try again.');
    return result.data;
  }
  const connected = salon => !!salon.instagram_page_id && !!salon.instagram_page_token
    && (!salon.instagram_token_expires_at || Date.parse(salon.instagram_token_expires_at) > now().getTime());
  async function finished(owner, post, id, reconciled = false) {
    const saved = await write(owner, post, { status: 'posted', external_post_id: id,
      posted_at: now().toISOString(), publish_uncertain_since: null, publish_claimed_at: null, failure_reason: null });
    if (reconciled) await event(owner, post, `Checked with ${post.platform === 'google' ? 'Google' : 'Instagram'}: the post went out once.`);
    return { published: true, instagramId: id, externalId: id, reconciled, post: saved };
  }
  async function reconcile(owner, post, salon) {
    const started = Date.parse(post.publish_uncertain_since || post.publish_claimed_at);
    if (!post.publish_uncertain_since && now().getTime() - started < RECONCILE_AFTER_MS)
      return { published: false, posting: true, reason: 'This post is being published. Give it a moment.' };
    // Provider timestamps have second precision. Compare the whole dispatch
    // second so a response at 12:00:00 includes a claim at 12:00:00.500.
    const since = Math.floor(Date.parse(post.publish_claimed_at) / 1000) * 1000;
    let recent, complete = true;
    if (post.platform === 'google') {
      if (!google) return { published: false, posting: true, reason: 'Florrie needs to check the result with Google.' };
      const result = await google.recent(owner, since);
      recent = Array.isArray(result) ? result : result.posts;
      complete = Array.isArray(result) ? true : result.complete;
    } else {
      if (!connected(salon)) return { published: false, posting: true, not_connected: true,
        reason: 'Reconnect Instagram so Florrie can check whether this post went out.' };
      recent = [];
      let next = `https://graph.instagram.com/v21.0/${salon.instagram_page_id}/media?fields=id,caption,timestamp&limit=100`;
      for (let page = 0; next && page < 5; page++) {
        const response = await fetchImpl(next, {
          headers: { Authorization: `Bearer ${salon.instagram_page_token}` }, signal: AbortSignal.timeout(15000),
        });
        const data = await response.json();
        if (!response.ok || !Array.isArray(data.data)) throw problem('Instagram could not confirm this post yet. Florrie will check again.');
        recent.push(...data.data);
        next = data.paging?.next || null;
        complete = !next || data.data.some(item => Date.parse(item.timestamp) < since);
        if (complete) break;
        const pageUrl = new URL(next);
        if (pageUrl.protocol !== 'https:' || pageUrl.hostname !== 'graph.instagram.com' || pageUrl.username || pageUrl.password)
          throw problem('Instagram could not confirm this post yet. Florrie will check again.');
      }
    }
    const matches = recent.filter(item => item.id && item.caption === captionFor(post) && Date.parse(item.timestamp) >= since);
    if (matches.length === 1) return finished(owner, post, matches[0].id, true);
    if (!complete || matches.length > 1)
      return { published: false, posting: true, reason: 'Florrie is checking whether the post went out.' };
    if (now().getTime() - started < RECONCILE_AFTER_MS)
      return { published: false, posting: true, reason: 'Florrie is checking whether the post went out.' };
    const provider = post.platform === 'google' ? 'Google' : 'Instagram';
    const reason = `${provider} did not confirm it, and it is not on your profile. Nothing went out.`;
    const saved = await write(owner, post, { status: 'failed', failure_reason: reason,
      publish_claimed_at: null, publish_uncertain_since: null });
    return { published: false, reason, post: saved };
  }
  async function publish(owner, id) {
    let post = await read(owner, id);
    if (post.kind === 'reel_plan' || post.post_type === 'gallery')
      return { published: false, reason: 'This is a plan or a photo, not a post to publish.' };
    if (post.external_post_id || post.published_by_owner)
      return { published: true, already_posted: true, instagramId: post.external_post_id, post };
    const salon = await connection(owner);
    if (!salon.content_v2) return { published: false, legacy: !post.preparation_id, reason: 'Content v2 is not enabled for this salon.' };
    if (post.publish_claimed_at || post.publish_uncertain_since) return reconcile(owner, post, salon);
    post = await recheckPost(owner, id);
    const hash = materialHash(post);
    if (!post.approved_hash) return { published: false, needs_approval: true, reason: post.change_note?.reasons?.join(' ') || 'Check and approve this post before it goes out.' };
    if (post.approved_hash !== hash || post.material_hash !== hash) {
      const result = await posts().update({ status: 'draft', approved_at: null, approved_hash: null,
        change_note: { kind: 'facts', reasons: ['It changed after you approved it'], changes: [], at: now().toISOString(), was_approved: true } })
        .eq('beautician_id', owner).eq('id', id).eq('version', post.version).is('publish_claimed_at', null);
      if (result.error) throw problem('Could not return this post for you to check. Try again.');
      return { published: false, needs_approval: true, reason: 'It changed after you approved it' };
    }
    if (!['approved', 'scheduled'].includes(post.status) || post.held || post.facts?.some(fact => fact.status === 'block'))
      return { published: false, needs_approval: true, reason: 'Check and approve this post before it goes out.' };
    if (post.platform !== 'google' && !connected(salon))
      return { published: false, not_connected: true, reason: 'Waiting for Instagram. Your approval is safe.' };
    if (post.platform === 'google' && (!google || !(await google.status(owner)).connected))
      return { published: false, not_connected: true, reason: 'Waiting for Google. Your approval is safe.' };
    const key = `${post.id}:${post.approved_hash}:${post.platform || 'instagram'}`;
    const claim = await posts().update({ publish_key: key, publish_claimed_at: now().toISOString(),
      publish_attempts: (post.publish_attempts || 0) + 1, failure_reason: null })
      .eq('beautician_id', owner).eq('id', id).eq('version', post.version)
      .eq('approved_hash', post.approved_hash).in('status', ['approved', 'scheduled'])
      .is('publish_claimed_at', null).is('external_post_id', null).select('*').maybeSingle();
    if (claim.error) throw problem('Could not reserve this post for publishing. Try again.');
    if (!claim.data) return { published: false, posting: true, reason: 'This post changed or is already being published.' };
    post = claim.data;
    let sent = false;
    try {
      const beforePublish = async () => {
        if (!(await connection(owner)).content_v2)
          throw Object.assign(new Error('Content v2 is not enabled for this salon. Your approval is safe.'), { disabled: true });
        const checked = await recheckPost(owner, id, { publishing: true });
        if (!checked.approved_hash || checked.approved_hash !== materialHash(checked) || checked.facts?.some(fact => fact.status === 'block')) {
          throw Object.assign(new Error(checked.change_note?.reasons?.join(' ') || 'It changed after you approved it'), { needs_approval: true });
        }
        post = await write(owner, post, { publish_uncertain_since: now().toISOString() });
        sent = true;
      };
      const result = post.platform === 'google'
        ? await google.publish(owner, post, beforePublish)
        : await publishLegacy(owner, id, { v2: true, claimTaken: true, beforePublish });
      if (result.published && (result.instagramId || result.externalId))
        return await finished(owner, post, result.instagramId || result.externalId);
      if (result.uncertain) return { ...result, posting: true };
      if (result.needs_approval || result.disabled) {
        await write(owner, post, { publish_claimed_at: null, publish_uncertain_since: null });
        return result;
      }
      if (result.not_connected) {
        if (post.platform !== 'google') {
          const expired = await db.from('beauticians').update({ instagram_token_expires_at: now().toISOString() })
            .eq('id', owner).eq('instagram_page_token', salon.instagram_page_token);
          if (expired.error) logger.warn({ err: expired.error, owner }, 'Could not save that Instagram needs reconnecting');
        }
        await write(owner, post, { publish_claimed_at: null, publish_uncertain_since: null });
        return result;
      }
      const reason = result.reason || 'The provider could not publish this post. Try again.';
      await write(owner, post, { status: 'failed', failure_reason: reason,
        publish_claimed_at: null, publish_uncertain_since: null });
      return { published: false, reason };
    } catch (error) {
      if (error.needs_approval || error.disabled) {
        await write(owner, post, { publish_claimed_at: null, publish_uncertain_since: null });
        return { published: false, needs_approval: error.needs_approval === true, disabled: error.disabled === true, reason: error.message };
      }
      if (sent) {
        logger.warn({ err: error, postId: id }, 'Content publish needs provider reconciliation');
        return { published: false, posting: true, uncertain: true, reason: 'Florrie is checking whether the post went out.' };
      }
      await write(owner, post, { status: 'failed', failure_reason: error.message,
        publish_claimed_at: null, publish_uncertain_since: null });
      return { published: false, reason: error.message };
    }
  }
  return { publish, reconcile };
}

export async function publishContentV2Post(owner, id) {
  const [{ recheckPost }, { materialHash }, { publishPost }, { createGooglePosts }] = await Promise.all([
    import('./index.js'), import('./state.js'), import('../content-autopilot.js'), import('../google-posts.js'),
  ]);
  return createContentV2Publisher({ recheckPost, materialHash, publishLegacy: publishPost,
    google: createGooglePosts({ db: supabase }) }).publish(owner, id);
}
