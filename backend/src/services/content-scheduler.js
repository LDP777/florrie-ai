/**
 * Content scheduler
 *
 * Publishes content_posts whose status is 'scheduled' when their
 * scheduled_for time arrives. Until now 'scheduled' was a status the UI
 * could set but nothing ever executed, so scheduled posts sat forever.
 *
 * Runs every 5 minutes from index.js. Each post is atomically claimed
 * (status scheduled -> approved) before publishing so overlapping runs can
 * never double-post. Failures mark the post 'failed' for the UI to surface.
 */
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { publishPost } from './content-autopilot.js';

export async function publishScheduledPosts() {
  const now = new Date().toISOString();

  const { data: due, error } = await supabase
    .from('content_posts')
    .select('id, beautician_id, scheduled_for, image_url')
    .eq('status', 'scheduled')
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
      // No photo attached by post time: back to drafts rather than a failed
      // publish (Instagram image posts need an image). She sees it waiting.
      if (!post.image_url) {
        await supabase.from('content_posts')
          .update({ status: 'draft' })
          .eq('id', post.id)
          .eq('status', 'scheduled');
        logger.info({ postId: post.id }, 'content scheduler: no image at post time, returned to drafts');
        continue;
      }
      // Atomic claim: only proceed if WE flipped it out of 'scheduled'.
      const { data: claimed } = await supabase
        .from('content_posts')
        .update({ status: 'approved' })
        .eq('id', post.id)
        .eq('status', 'scheduled')
        .select('id');
      if (!claimed?.length) continue; // another run got it

      const result = await publishPost(post.beautician_id, post.id);
      if (result?.published) {
        published++;
      } else {
        // publishPost marks 'approved' when Instagram is not connected and
        // 'failed' on API errors; both are honest end states. Log the why.
        logger.warn({ postId: post.id, reason: result?.reason }, 'content scheduler: post did not publish');
        failed++;
      }
    } catch (err) {
      failed++;
      logger.warn({ err, postId: post.id }, 'content scheduler: publish threw');
      await supabase.from('content_posts').update({ status: 'failed' }).eq('id', post.id);
    }
  }

  if (published || failed) {
    logger.info({ published, failed }, 'content scheduler: run complete');
  }
  return { published, failed };
}
