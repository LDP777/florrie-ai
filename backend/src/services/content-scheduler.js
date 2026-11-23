/**
 * Publish approved posts when their chosen time arrives. V2 rechecks facts,
 * keeps approvals while disconnected, and reconciles uncertain dispatches.
 * The publisher owns the atomic claim used by both worker and owner actions.
 */
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { publishPost, markPostFailed } from './content-autopilot.js';

export async function publishScheduledPosts() {
  const now = new Date().toISOString();

  const { data: due, error } = await supabase
    .from('content_posts')
    .select('*')
    .in('status', ['scheduled', 'approved'])
    .lte('scheduled_for', now)
    .limit(20);

  if (error) {
    logger.warn({ err: error }, 'content scheduler: due query failed');
    return { published: 0, failed: 0 };
  }
  if (!due?.length) return { published: 0, failed: 0 };

  let published = 0;
  let failed = 0;

  for (const post of due) {
    try {
      if (post.kind === 'reel_plan' || post.post_type === 'gallery' || post.held) continue;
      if (post.material_hash) {
        const { publishContentV2Post } = await import('./content-v2/publish.js');
        const result = await publishContentV2Post(post.beautician_id, post.id);
        if (!result.legacy) {
          if (result.published && !result.already_posted) published++;
          else if (!result.published && !result.not_connected && !result.posting && !result.needs_approval) failed++;
          continue;
        }
      }
      // No photo attached by post time: back to drafts rather than a failed
      // publish (Instagram image posts need an image). She sees it waiting.
      if (!post.image_url) {
        const missingImage = await supabase.from('content_posts')
          .update({ status: 'draft' })
          .eq('id', post.id)
          .eq('beautician_id', post.beautician_id)
          .eq('status', 'scheduled');
        if (missingImage.error) throw missingImage.error;
        logger.info({ postId: post.id }, 'content scheduler: no image at post time, returned to drafts');
        continue;
      }
      // Keep the legacy scheduler transition; publishPost takes its own claim.
      const { data: claimed, error: claimError } = await supabase
        .from('content_posts')
        .update({ status: 'approved' })
        .eq('id', post.id)
        .eq('beautician_id', post.beautician_id)
        .eq('status', post.status)
        .select('id');
      if (claimError) throw claimError;
      if (!claimed?.length) continue; // another run got it

      const result = await publishPost(post.beautician_id, post.id);
      if (result?.published) {
        published++;
      } else {
        logger.warn({ postId: post.id, reason: result?.reason }, 'content scheduler: post did not publish');
        if (result?.not_connected) continue;
        failed++;
      }
    } catch (err) {
      failed++;
      logger.warn({ err, postId: post.id }, 'content scheduler: publish threw');
      // V2 owns its claim and uncertain dispatch. A read failure must never
      // release that claim and allow a second provider request.
      if (!post.material_hash) await markPostFailed(post.id, err?.message || 'Publishing threw');
    }
  }

  if (published || failed) {
    logger.info({ published, failed }, 'content scheduler: run complete');
  }
  return { published, failed };
}
