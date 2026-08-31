import Anthropic from '@anthropic-ai/sdk';
import { cleanReply } from '../lib/text.js';
import { buildVoiceGuide } from './voice-profile.js';
import { ensureNoSlop } from '../lib/anti-slop.js';
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { getActivePromos, describePromo } from '../lib/promos.js';
import { nowInSalonWall } from '../lib/free-slots.js';

/**
 * Content Autopilot — the "Content" digital employee.
 *
 * This service:
 * 1. Takes a before/after photo and generates an on-brand caption
 * 2. Auto-drafts "last-minute availability" posts when calendar gaps appear
 * 3. Suggests hashtags based on treatment type and location
 * 4. Tracks which content drives bookings and adapts style over time
 *
 * Ellie's #1 wish. She takes before/after photos for every good result
 * but they sit in her camera roll. This closes that gap.
 */

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * One model call, with the photo, falling back to the same call without it.
 *
 * A vision call has more ways to fail than a text one: the url can 404 by the
 * time Anthropic reaches it, the file can be a format the API will not take,
 * it can be too large. None of those are reasons for the owner to end up
 * staring at an error instead of a caption, so the picture is the part that
 * gets dropped, not the caption.
 */
async function captionCall(request, { beauticianId, hasImage } = {}) {
  try {
    return await anthropic.messages.create(request);
  } catch (err) {
    if (!hasImage) throw err;
    logger.warn({ err, beauticianId }, 'Caption with the photo failed; writing one without it');
    const textOnly = {
      ...request,
      messages: request.messages.map(m => ({
        ...m,
        content: Array.isArray(m.content) ? m.content.filter(part => part.type !== 'image') : m.content,
      })),
    };
    return anthropic.messages.create(textOnly);
  }
}

/**
 * Generate a caption from an uploaded before/after photo.
 *
 * THE PHOTO IS ACTUALLY LOOKED AT NOW.
 *
 * 31 August 2026. This docstring said "Uses Claude Vision to understand the
 * image", `imageUrl` was the second parameter, and the word imageUrl appeared
 * nowhere else in the function. Every caption in the product was written from
 * the treatment name and nothing else, which is why they all read like the
 * templates: the model had no idea whether it was looking at brows, a set of
 * nails, or a photo of the salon door.
 *
 * The image is passed as a url source, the same shape routes/money.js already
 * uses in production for receipt scanning. Anthropic fetches the url from its
 * own servers, exactly as Meta does at publish time, so the url has to clear
 * the same bar: imageUrlProblem is reused rather than a second, subtly
 * different check. A blob:, a localhost address or a signed Supabase link is
 * skipped rather than sent to fail.
 *
 * And if the vision call fails for any reason, the caption is written without
 * the picture rather than not at all. A plainer caption is a small loss; an
 * error where a draft should be is the screen she is standing in front of.
 */
export async function generateCaption(beauticianId, imageUrl, treatmentType, additionalContext) {
  const { data: beautician } = await supabase
    .from('beauticians')
    .select('first_name, business_name, tone_model, brand_color, voice_profile')
    .eq('id', beauticianId)
    .single();

  if (!beautician) throw new Error('Beautician not found');

  // Get recent high-performing posts to learn from
  const { data: topPosts } = await supabase
    .from('content_posts')
    .select('caption, likes, comments, bookings_attributed')
    .eq('beautician_id', beauticianId)
    .eq('status', 'posted')
    .order('likes', { ascending: false })
    .limit(5);

  const performanceContext = topPosts?.length > 0
    ? `\nTop-performing captions for reference:\n${topPosts.map(p => `- "${p.caption}" (${p.likes} likes, ${p.comments} comments)`).join('\n')}`
    : '';

  const businessName = beautician.business_name || beautician.first_name;
  const toneNotes = beautician.tone_model?.formality || 'warm-professional';

  // Only a url Anthropic can actually fetch. See imageUrlProblem.
  const imageProblem = imageUrl ? imageUrlProblem(imageUrl) : 'no photo';
  const canSeePhoto = !imageProblem;
  if (imageUrl && imageProblem) {
    logger.info({ beauticianId, imageProblem }, 'Caption written without looking at the photo: the image url cannot be fetched');
  }

  const response = await captionCall({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    system: `You write Instagram captions for a beauty professional called ${businessName}.

STYLE RULES:
- Tone: ${toneNotes}. Not salesy, not corporate. Like a proud professional sharing their work.
- Length: 1-3 short sentences. Instagram, not an essay.
- First line is the hook. Make someone stop scrolling.
- End with a soft CTA (booking link, "DM me", or question to drive comments).
- NO generic filler ("transformation Tuesday", "obsessed", "slay"). Write like a real person.
- NO excessive emojis. One or two max, only if natural.
- British English.
- Never use em dashes (—) or en dashes (–). Use commas, full stops, colons or line breaks instead.

${buildVoiceGuide(beautician.voice_profile)}
${performanceContext}

Return ONLY the caption text. No quotes, no explanation, no hashtag suggestions (those come separately).`,
    messages: [{
      role: 'user',
      content: [
        ...(canSeePhoto ? [{ type: 'image', source: { type: 'url', url: imageUrl } }] : []),
        {
          type: 'text',
          text: canSeePhoto
            ? `Write an Instagram caption for this ${treatmentType || 'beauty treatment'} photo. Describe what you can actually see in it: the shape, the colour, the finish. Never describe anything that is not in the picture.${additionalContext ? ` Context: ${additionalContext}` : ''}`
            : `Write an Instagram caption for a ${treatmentType || 'beauty treatment'} before/after photo.${additionalContext ? ` Context: ${additionalContext}` : ''}`,
        },
      ],
    }],
  }, { beauticianId, hasImage: canSeePhoto });

  const caption = await ensureNoSlop(response.content[0].text, { neverSay: beautician.voice_profile?.never_say });

  // Generate hashtags separately
  const hashtags = await generateHashtags(treatmentType, businessName);

  return { caption, hashtags };
}

/**
 * Generate relevant hashtags for a post.
 */
async function generateHashtags(treatmentType, businessName) {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 150,
    system: `Generate 8-12 Instagram hashtags for a beauty post. Mix of:
- Treatment-specific (e.g. #browlamination)
- Local/general beauty (e.g. #beautysalon #browspecialist)
- Trending but relevant (not spam)
Return hashtags only, space-separated, no explanation.`,
    messages: [{
      role: 'user',
      content: `Treatment: ${treatmentType || 'beauty treatment'}. Business: ${businessName}`
    }]
  });

  const raw = response.content[0].text.trim();
  return raw.split(/\s+/).filter(h => h.startsWith('#'));
}

/**
 * Draft a "last-minute availability" post when a calendar gap is detected.
 * Called by the Calendar agent when it spots cancellations or empty slots.
 */
export async function draftAvailabilityPost(beauticianId, gapDate, gapTime, treatmentSuggestions) {
  const { data: beautician } = await supabase
    .from('beauticians')
    .select('first_name, business_name, tone_model, booking_slug, voice_profile')
    .eq('id', beauticianId)
    .single();

  const businessName = beautician?.business_name || beautician?.first_name || 'the salon';
  const bookingLink = beautician?.booking_slug
    ? `florrie.ai/book/${beautician.booking_slug}`
    : null;

  const dayLabel = new Date(gapDate).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long'
  });

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    system: `Write a short, casual Instagram story or post announcing last-minute availability.
Business: ${businessName}
Tone: urgent but not desperate. Excited, like you're offering a treat.
Keep it to 1-2 sentences. British English. One emoji max.
Never use em dashes (—) or en dashes (–). Use commas, full stops, colons or line breaks instead.
${bookingLink ? `Include booking link: ${bookingLink}` : 'Tell them to DM to book.'}`,
    messages: [{
      role: 'user',
      content: `Availability opened up on ${dayLabel} around ${gapTime}.${treatmentSuggestions?.length ? ` Good for: ${treatmentSuggestions.join(', ')}.` : ''}`
    }]
  });

  const caption = await ensureNoSlop(response.content[0].text, { neverSay: beautician.voice_profile?.never_say });

  // Store as draft
  const { data: post, error: draftErr } = await supabase
    .from('content_posts')
    .insert({
      beautician_id: beauticianId,
      caption,
      platform: 'instagram',
      post_type: 'last_minute_availability',
      status: 'draft',
      hashtags: ['#lastminute', '#availabilitydrop', '#booknow']
    })
    .select()
    .single();

  // 31 August 2026: this error was unread, and the ai_actions row below then
  // told her a post had been drafted for a gap when nothing had been written
  // at all. She would go looking for it in Drafts and find an empty tab.
  if (draftErr) {
    logger.error({ err: draftErr, beauticianId, gapDate, gapTime },
      'Could not save the last-minute availability draft');
    throw new Error(`Could not draft the availability post: ${draftErr.message}`);
  }

  // Log AI action.
  //
  // notification_sent is gone rather than false: nothing in this function
  // sends a notification, and it said `true`. Nothing reads the column, so the
  // only thing the claim ever did was make the row untrue.
  await supabase.from('ai_actions').insert({
    beautician_id: beauticianId,
    action_type: 'content_drafted',
    digital_employee: 'content',
    summary: `Drafted a last-minute availability post for ${dayLabel}`,
    details: { post_id: post?.id, gap_date: gapDate, gap_time: gapTime },
    confidence: 0.95,
    autonomous: true,
    outcome: 'success',
  });

  return post;
}

/**
 * Create a content post from an uploaded photo.
 * Generates caption + hashtags and saves as draft for one-tap approval.
 */
export async function createPostFromPhoto(beauticianId, imageUrl, treatmentType, context) {
  const { caption, hashtags } = await generateCaption(
    beauticianId, imageUrl, treatmentType, context
  );

  const { data: post, error } = await supabase
    .from('content_posts')
    .insert({
      beautician_id: beauticianId,
      image_url: imageUrl,
      caption,
      hashtags,
      platform: 'instagram',
      post_type: 'before_after',
      status: 'draft'
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create post: ${error.message}`);

  // Log AI action
  await supabase.from('ai_actions').insert({
    beautician_id: beauticianId,
    action_type: 'content_drafted',
    digital_employee: 'content',
    summary: `Drafted a ${treatmentType || 'before/after'} post. One tap to approve.`,
    details: { post_id: post.id, treatment: treatmentType },
    confidence: 0.92,
    autonomous: true,
    outcome: 'success',
    // No notification_sent: nothing here sends one. See draftAvailabilityPost.
  });

  return post;
}

/**
 * Why an image_url that WE can see is not good enough.
 *
 * Instagram does not receive the picture from us. We hand it a url and Meta's
 * servers fetch it themselves, from the public internet, with no cookies, no
 * Authorization header and none of our session. So three kinds of url look
 * perfectly fine in the app and fail at Meta:
 *
 *   - a blob: or data: url, which only exists in her browser
 *   - localhost or a private address, which Meta cannot reach
 *   - a Supabase SIGNED url (/object/sign/... plus a ?token=), which is
 *     time limited and tied to a signature. The public equivalent is
 *     /object/public/...
 *
 * All three come back from Meta as a container stuck in ERROR with a message
 * about the media, several seconds after the tap, which is the worst possible
 * moment for it to happen. Caught here instead, before anything is created.
 */
export function imageUrlProblem(imageUrl) {
  const raw = String(imageUrl || '').trim();
  if (!raw) return 'This post has no photo attached, so Instagram has nothing to publish.';

  let u;
  try {
    u = new URL(raw);
  } catch {
    return 'The photo link on this post is not a valid web address.';
  }

  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return 'The photo has not finished uploading yet, so Instagram cannot fetch it. Re-attach the photo and try again.';
  }

  const host = u.hostname.toLowerCase();
  const privateHost =
    host === 'localhost' ||
    host.endsWith('.local') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === '::1';
  if (privateHost) {
    return 'The photo is on an address only this server can reach. Instagram fetches the image itself, so it needs a public link.';
  }

  if (/\/object\/sign\//.test(u.pathname) || u.searchParams.has('token')) {
    return 'The photo link is a private, signed link that expires. Instagram fetches the image itself and cannot use one. The content-images bucket needs to be public.';
  }

  return null;
}

/**
 * Wait for Instagram to finish ingesting the container.
 *
 * The publish step is NOT allowed to run the instant the container is created.
 * Meta downloads the image asynchronously, and a container that is still
 * IN_PROGRESS answers media_publish with an error, while one that is ERROR or
 * EXPIRED answers with a different one. The old code published immediately and
 * read neither, so a container that never finished still marked the post
 * "posted" with an undefined external id: a draft that looks published and is
 * not on the profile. On camera that is the re-record.
 *
 * Returns { ok, statusCode, error }.
 */
export async function waitForContainer(containerId, token, { attempts = 12, delayMs = 2000, sleep } = {}) {
  const pause = sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
  let last = null;

  for (let i = 0; i < attempts; i++) {
    let data = {};
    try {
      const res = await fetch(
        `https://graph.instagram.com/v21.0/${containerId}?fields=status_code,status`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      data = await res.json().catch(() => ({}));
      if (!res.ok) {
        last = data?.error?.message || `HTTP ${res.status}`;
        // A rejected status read is not proof the container is bad, so keep
        // asking rather than binning a post that may be seconds from ready.
        await pause(delayMs);
        continue;
      }
    } catch (err) {
      last = 'Could not reach Instagram while checking the photo upload';
      await pause(delayMs);
      continue;
    }

    const code = data.status_code;
    if (code === 'FINISHED') return { ok: true, statusCode: code, error: null };
    if (code === 'ERROR' || code === 'EXPIRED') {
      return { ok: false, statusCode: code, error: data.status || `Instagram could not process the photo (${code})` };
    }
    last = data.status || code || 'still uploading';
    if (i < attempts - 1) await pause(delayMs);
  }

  return { ok: false, statusCode: 'TIMEOUT', error: `Instagram is still processing the photo (${last}). Try again in a moment.` };
}

/** The message Meta actually sent, rather than a shrug. */
function metaError(body, res, fallback) {
  return body?.error?.error_user_msg
    || body?.error?.message
    || (res && !res.ok ? `Instagram returned HTTP ${res.status}` : null)
    || fallback;
}

/**
 * Approve and publish a post to Instagram.
 * Uses the Instagram Graph API to publish.
 */
export async function publishPost(beauticianId, postId) {
  const { data: post, error: postErr } = await supabase
    .from('content_posts')
    .select('*')
    .eq('id', postId)
    .eq('beautician_id', beauticianId)
    .maybeSingle();

  if (postErr) {
    logger.error({ err: postErr, beauticianId, postId }, 'Instagram publish: could not read the post');
    return { published: false, reason: 'Could not read that post just now. Try again in a moment.' };
  }
  if (!post) throw new Error('Post not found');

  // NOTHING PUBLISHES TWICE.
  //
  // 31 August 2026. This function read post.status and post.external_post_id
  // and then ignored both. Two ways that reached the profile twice:
  //
  //   - the 'posted' update at the end had its error unread, so a write that
  //     failed left the row on 'approved', which ContentAutopilot.jsx shows in
  //     Drafts with a live "Approve & Post" button underneath it. One tap and
  //     the same photo and caption go up again.
  //   - a restart, a retry or a double tap between media_publish returning and
  //     that update landing did the same thing with no failure at all.
  //
  // Public duplicates on a salon's own Instagram grid are not recoverable by
  // us: she has to go and delete one. So the check is first, and it trusts
  // external_post_id as much as status, because an id means Meta has it.
  if (post.status === 'posted' || post.external_post_id) {
    logger.info({ postId, beauticianId, status: post.status, externalPostId: post.external_post_id || null },
      'Instagram publish refused: this post is already on Instagram');
    return {
      published: true,
      already_posted: true,
      instagramId: post.external_post_id || null,
      reason: 'This one is already on Instagram.',
    };
  }

  const isStory = post.media_kind === 'story';
  const { data: beautician, error: beauticianErr } = await supabase
    .from('beauticians')
    .select('instagram_page_id, instagram_page_token')
    .eq('id', beauticianId)
    .single();

  // A failed read and a disconnected account are not the same thing, and
  // telling her to reconnect Instagram when the database hiccupped sends her
  // round an OAuth flow that fixes nothing.
  if (beauticianErr) {
    logger.error({ err: beauticianErr, beauticianId, postId }, 'Instagram publish: could not read the connection');
    return { published: false, reason: 'Could not check your Instagram connection just now. Try again in a moment.' };
  }

  if (!beautician?.instagram_page_id || !beautician?.instagram_page_token) {
    // No Instagram connected — mark as approved but can't publish
    const { error: approveErr } = await supabase.from('content_posts').update({
      status: 'approved',
      approved_at: new Date().toISOString()
    }).eq('id', postId);
    if (approveErr) {
      logger.error({ err: approveErr, postId, beauticianId }, 'Could not mark an unpublishable post approved');
    }

    return {
      published: false,
      not_connected: true,
      reason: 'Instagram is not connected, so this was saved as approved rather than posted. Connect Instagram in Settings, AI tab.',
    };
  }

  // Nothing below can rescue a photo Instagram cannot fetch, and every one of
  // these failures is cheaper to say now than after a container exists.
  const urlProblem = imageUrlProblem(post.image_url);
  if (urlProblem) {
    logger.warn({ postId, beauticianId, imageUrl: post.image_url }, `Instagram publish blocked: ${urlProblem}`);
    await markPostFailed(postId, urlProblem);
    return { published: false, reason: urlProblem };
  }

  const token = beautician.instagram_page_token;

  // Atomic claim, taken immediately before the first call to Meta. Mirrors the
  // claim in services/content-scheduler.js: only the caller whose UPDATE
  // actually matched a row is allowed to carry on. Two overlapping publishes
  // of the same post (the cron and a tap, or two taps) therefore create one
  // container, not two.
  //
  // A claim older than STALE_CLAIM_MS is reclaimable, because a process that
  // died mid-publish must not lock a post out of ever being published again.
  const claim = await claimForPublish(postId, beauticianId);
  if (!claim.claimed) {
    logger.warn({ postId, beauticianId, reason: claim.reason }, 'Instagram publish: another publish of this post is already in flight');
    return { published: false, reason: 'This post is already being published. Give it a moment.' };
  }

  try {
    // Step 1: Create media container
    const fullCaption = [post.caption, '', post.hashtags?.join(' ')].filter(Boolean).join('\n');

    // graph.instagram.com, NOT graph.facebook.com: accounts connect via
    // Instagram Business Login (June 2026 rewrite) whose user tokens only
    // work on the instagram.com graph host, same as sendInstagramDM.
    //
    // The path segment is the id we stored at connect time, and that id has
    // been wrong before. `me` resolves to whoever the token belongs to and
    // therefore cannot be wrong, so it is the retry: one wrong number in the
    // database must not be the reason a recording session fails.
    const createBody = JSON.stringify({
      image_url: post.image_url,
      // Stories: same two-step flow with media_type STORIES; captions
      // are not rendered on stories so they are omitted.
      ...(isStory ? { media_type: 'STORIES' } : { caption: fullCaption })
    });

    let container = null;
    let containerErr = null;
    let target = null;

    for (const candidate of [beautician.instagram_page_id, 'me']) {
      const res = await fetch(
        `https://graph.instagram.com/v21.0/${candidate}/media`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: createBody,
        }
      );
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.id) {
        container = body;
        target = candidate;
        if (candidate === 'me') {
          logger.warn({ beauticianId, storedId: beautician.instagram_page_id },
            'Instagram publish: the stored instagram_page_id was rejected, published against /me instead. That id is wrong for this token.');
        }
        break;
      }
      containerErr = metaError(body, res, 'Instagram would not accept the photo');
      logger.warn({ beauticianId, postId, candidate, err: body?.error || res.status }, 'Instagram publish: media container rejected');
    }

    if (!container?.id) throw new Error(containerErr || 'Failed to create media container');

    // Step 1b: Instagram downloads the image on its own time. Publishing
    // before it has finished is what left posts marked "posted" that were
    // never on the profile.
    const ready = await waitForContainer(container.id, token);
    if (!ready.ok) throw new Error(ready.error || 'Instagram could not process the photo');

    // Step 2: Publish
    const publishRes = await fetch(
      `https://graph.instagram.com/v21.0/${target}/media_publish`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          creation_id: container.id
        })
      }
    );
    const published = await publishRes.json().catch(() => ({}));

    // The old code read neither the status nor the id and marked the post
    // 'posted' regardless, so a rejected publish produced a row that claimed
    // to be live with external_post_id undefined.
    if (!publishRes.ok || !published.id) {
      throw new Error(metaError(published, publishRes, 'Instagram accepted the photo but would not publish it'));
    }

    // Update post record.
    //
    // The error on this update was unread until 31 August 2026, and this is
    // the single most dangerous unread error on the page: the post IS on
    // Instagram at this point. A failed write here leaves the row saying
    // 'approved', which the Drafts tab renders with a live "Approve & Post"
    // button, and the next tap posts it to her grid a second time.
    //
    // The claim is deliberately NOT released in this branch, precisely so that
    // a second attempt is refused rather than duplicating the post.
    const { error: postedErr } = await supabase.from('content_posts').update({
      status: 'posted',
      approved_at: new Date().toISOString(),
      posted_at: new Date().toISOString(),
      external_post_id: published.id
    }).eq('id', postId);

    if (postedErr) {
      logger.error({ err: postedErr, postId, beauticianId, instagramId: published.id },
        'PUBLISHED TO INSTAGRAM BUT COULD NOT MARK THE POST POSTED. The post is live and the row still says it is not. Set status=posted and external_post_id by hand before anyone taps publish again.');
    }

    // Log action
    await supabase.from('ai_actions').insert({
      beautician_id: beauticianId,
      action_type: 'content_posted',
      digital_employee: 'content',
      summary: `Published a post to Instagram`,
      details: { post_id: postId, instagram_id: published.id },
      confidence: 1.0,
      autonomous: false,
      outcome: 'success',
      // No notification_sent: nothing here sends one. See draftAvailabilityPost.
    });

    return { published: true, instagramId: published.id };

  } catch (err) {
    logger.error({ err, postId, beauticianId }, 'Instagram publish error');
    // Nothing reached the profile, so let her try again once she has fixed
    // whatever it was.
    await releasePublishClaim(postId);
    await markPostFailed(postId, err.message);
    return { published: false, reason: err.message };
  }
}

// A publish that has been claimed for longer than this is assumed dead, not in
// flight. Generous: waitForContainer alone can spend 24 seconds.
const STALE_CLAIM_MS = 10 * 60 * 1000;

/**
 * Take the publish claim, or say why we could not.
 *
 * publish_claimed_at arrives in migration 20260831_backend025. Where that has
 * not been applied the update is rejected whole by PostgREST, and the honest
 * answer then is to carry on: the status / external_post_id check above is the
 * primary guard and it still holds. Refusing to publish because a nice-to-have
 * column is missing would be a worse product than publishing without the
 * belt to go with the braces.
 */
async function claimForPublish(postId, beauticianId) {
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
  const { data, error } = await supabase
    .from('content_posts')
    .update({ publish_claimed_at: new Date().toISOString() })
    .eq('id', postId)
    .eq('beautician_id', beauticianId)
    .or(`publish_claimed_at.is.null,publish_claimed_at.lt.${staleBefore}`)
    .select('id');

  if (error) {
    logger.warn({ err: error, postId },
      'Could not take the publish claim (is content_posts.publish_claimed_at there?); relying on the status check alone');
    return { claimed: true, reason: 'claim_column_missing' };
  }
  if (!data?.length) return { claimed: false, reason: 'already_claimed' };
  return { claimed: true, reason: 'claimed' };
}

/** Hand the claim back so a fixed post can be published on the next tap. */
async function releasePublishClaim(postId) {
  if (!postId) return;
  const { error } = await supabase
    .from('content_posts')
    .update({ publish_claimed_at: null })
    .eq('id', postId);
  if (error) {
    logger.warn({ err: error, postId }, 'Could not release the publish claim; it expires on its own after 10 minutes');
  }
}

/**
 * Mark a post failed, and say why in a place the UI can read.
 *
 * status goes first and on its own, because that column definitely exists and
 * a post that did not publish must never be left looking like one that did.
 * The reason is a second, best-effort write: failure_reason arrives in a
 * migration applied by hand, and PostgREST rejects the whole update if one
 * column is unknown, which would take the status write down with it.
 */
export async function markPostFailed(postId, reason) {
  if (!postId) return;
  const { error } = await supabase
    .from('content_posts')
    .update({ status: 'failed' })
    .eq('id', postId);
  if (error) {
    logger.error({ err: error, postId }, 'Could not mark content post failed');
    return;
  }
  const { error: reasonErr } = await supabase
    .from('content_posts')
    .update({ failure_reason: String(reason || '').slice(0, 500) })
    .eq('id', postId);
  if (reasonErr) {
    logger.warn({ err: reasonErr, postId, reason }, 'Could not save content_posts.failure_reason (is the column there?)');
  }

  // Nothing reached Instagram, so this post is publishable again the moment
  // she fixes whatever failed. Its own statement, for the same reason the
  // reason is: two optional columns from two hand-applied migrations must not
  // be able to take each other, or the status write, down with them.
  await releasePublishClaim(postId);
}

/**
 * Plan my week: one tap drafts a week of posts in HER voice, from real
 * salon data only (recent work, real reviews, real promos). Nothing is
 * invented and nothing publishes without her approval: each draft carries a
 * suggested day/time in scheduled_for but stays status 'draft' until she
 * approves it (POST /api/content/:id/schedule flips it live).
 */
export async function planWeek(beauticianId) {
  const { data: beautician, error: beauticianErr } = await supabase
    .from('beauticians')
    .select('first_name, business_name, tone_model, voice_profile, booking_slug, timezone')
    .eq('id', beauticianId)
    .maybeSingle();
  if (beauticianErr) {
    logger.error({ err: beauticianErr, beauticianId }, 'planWeek: could not read the beautician');
    throw new Error('Could not draft the week, try again');
  }
  if (!beautician) throw new Error('Beautician not found');

  // Real material only.
  const twoWeeksAgo = new Date(Date.now() - 14 * 86400000).toISOString();
  const [apptsRes, reviewsRes, promosRes, topRes] = await Promise.all([
    supabase.from('appointments')
      .select('treatment_id, treatments(name)')
      .eq('beautician_id', beauticianId)
      .eq('status', 'completed')
      .gte('starts_at', twoWeeksAgo.slice(0, 10))
      .limit(100),
    supabase.from('reviews')
      .select('comment, rating')
      .eq('beautician_id', beauticianId)
      .gte('rating', 5)
      // A PRIVATE REVIEW IS NOT A TESTIMONIAL.
      //
      // 31 August 2026. reviews.is_public has existed since migration 007 and
      // this filter did not, so a five star review a client left privately,
      // or one Ellie had deliberately unpublished, could be quoted "lightly"
      // in a public Instagram caption by a machine, without anybody being
      // asked. There is no undo for that.
      .eq('is_public', true)
      .not('comment', 'is', null)
      .order('created_at', { ascending: false })
      .limit(3),
    // PROMOS: use the one function that already knows what "live" means.
    //
    // The query here filtered on is_active alone, so an offer that expired in
    // June, one that does not start until October, and one whose 20 uses were
    // all claimed last week were all equally eligible to be broadcast to her
    // whole following. lib/promos.js getActivePromos checks the valid_from and
    // valid_until window and max_uses against current_uses, and describePromo
    // formats it, and both were written for exactly this and used everywhere
    // else already.
    getActivePromos(beauticianId, 3),
    supabase.from('content_posts')
      .select('caption, likes')
      .eq('beautician_id', beauticianId)
      .eq('status', 'posted')
      .order('likes', { ascending: false })
      .limit(3),
  ]);

  const treatmentCounts = {};
  for (const a of apptsRes.data || []) {
    const n = a.treatments?.name;
    if (n) treatmentCounts[n] = (treatmentCounts[n] || 0) + 1;
  }
  const topTreatments = Object.entries(treatmentCounts).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, c]) => `${n} (${c} recent)`);
  const reviews = (reviewsRes.data || []).map(r => r.comment).filter(c => c && c.length > 20);
  // Already filtered, already only the live ones. No second, weaker check here.
  const promos = promosRes || [];
  const topCaptions = (topRes.data || []).map(pst => pst.caption).filter(Boolean);

  const businessName = beautician.business_name || beautician.first_name;
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1600,
    system: `You plan a week of Instagram posts for ${businessName}, an independent beauty professional. Respond with JSON only: an array of exactly 7 objects, each {"day": "mon|tue|wed|thu|fri|sat|sun", "post_type": "before_after|testimonial|last_minute_availability|promotion|general", "caption": "...", "hashtags": ["...", 3-6 tags]}.

MIX RULES:
- 2 or 3 before_after posts about her real recent work (treatments below).
- 1 testimonial ONLY if a real review is provided below; quote it lightly, never invent one.
- 1 last_minute_availability post pointing at her booking page florrie.ai/book/${beautician.booking_slug || 'book'}.
- 1 promotion ONLY if a real promo is listed below (never invent an offer or code); otherwise another before_after or general.
- 1 or 2 general posts: a tip, a myth-bust, or a behind-the-scenes line. Human, specific, zero filler.

CAPTION RULES:
- 1-3 short sentences, hook first, soft CTA last. British English.
- No "transformation Tuesday", no "obsessed", no "slay", no "treat yourself", no corporate voice.
- Never use em dashes or en dashes.
${buildVoiceGuide(beautician.voice_profile)}
${topCaptions.length ? `\nHer top-performing captions for rhythm reference:\n${topCaptions.map(c => `- "${c}"`).join('\n')}` : ''}`,
    messages: [{
      role: 'user',
      content: `Plan this week.\nRecent work: ${topTreatments.join(', ') || 'general beauty treatments'}.\nReal reviews available: ${reviews.length ? reviews.map(r => `"${r}"`).join(' | ') : 'none'}.\nReal promos running: ${promos.length ? promos.map(describePromo).join(', ') : 'none'}.`
    }]
  });

  let plan;
  try {
    const text = response.content[0].text.trim().replace(/^```json?\s*|\s*```$/g, '');
    plan = JSON.parse(text);
    if (!Array.isArray(plan)) throw new Error('not an array');
  } catch (err) {
    logger.error({ err }, 'planWeek: unparseable plan');
    throw new Error('Could not draft the week, try again');
  }

  // Suggested slot: the next occurrence of each day at 18:30 IN THE SALON'S
  // OWN CLOCK.
  //
  // 31 August 2026. This used to be `new Date()` plus `setHours(18, 30)`, which
  // is 18:30 in whatever timezone the container happens to be running in. The
  // container runs on UTC, so every "18:30" suggestion was really 19:30 in
  // British Summer Time, and worse, `d.getDay()` was read in container time
  // too, so between midnight and 01:00 BST the weekday itself was a day
  // behind and "Saturday" was scheduled for Friday.
  //
  // content_posts.scheduled_for is a REAL INSTANT (content-scheduler.js
  // compares it against new Date().toISOString()), not a wall time in a UTC
  // slot like appointments.starts_at. So the wall time is built in the salon
  // frame and then converted back to the instant it actually names.
  const dayIdx = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const salonTz = beautician.timezone || 'Europe/London';
  const created = [];
  const insertErrors = [];
  for (const item of plan.slice(0, 7)) {
    const target = dayIdx[item.day] ?? 1;
    const wall = nowInSalonWall(salonTz);
    let add = (target - wall.getUTCDay() + 7) % 7;
    if (add === 0) add = 7; // never "today in the past", always the coming one
    wall.setUTCDate(wall.getUTCDate() + add);
    wall.setUTCHours(18, 30, 0, 0);
    const scheduledFor = salonWallToInstant(wall, salonTz);

    const validTypes = ['before_after', 'last_minute_availability', 'promotion', 'testimonial', 'general'];
    const { data: post, error } = await supabase
      .from('content_posts')
      .insert({
        beautician_id: beauticianId,
        caption: await ensureNoSlop(item.caption, { neverSay: beautician.voice_profile?.never_say }),
        hashtags: Array.isArray(item.hashtags) ? item.hashtags.slice(0, 8) : [],
        platform: 'instagram',
        post_type: validTypes.includes(item.post_type) ? item.post_type : 'general',
        status: 'draft',
        scheduled_for: scheduledFor.toISOString(),
      })
      .select()
      .single();
    if (error) {
      // SWALLOWED UNTIL 31 AUGUST 2026, and then reported as a success.
      // Every insert could fail, `created` would be empty, and the owner was
      // told "0 posts drafted" on a green card with an ai_actions row saying
      // outcome: 'success'. Nothing anywhere said what had gone wrong.
      insertErrors.push(error.message || String(error));
      logger.error({ err: error, beauticianId, day: item.day, postType: item.post_type },
        'planWeek: could not save a drafted post');
      continue;
    }
    if (post) created.push(post);
  }

  await supabase.from('ai_actions').insert({
    beautician_id: beauticianId,
    action_type: 'content_drafted',
    // 'content', not 'content_creator'. ai_actions.digital_employee carries a
    // CHECK constraint (migration 051) listing front_desk, calendar, comeback,
    // content, money, scout, marketing, general. 'content_creator' is not on
    // it, so every plan-a-week run silently failed to log anything at all: the
    // insert error was never read.
    digital_employee: 'content',
    summary: created.length
      ? `Drafted ${created.length} posts for the week ahead`
      : 'Could not draft any posts for the week ahead',
    details: { post_ids: created.map(c => c.id), errors: insertErrors.slice(0, 7) },
    confidence: 1.0,
    autonomous: false,
    // ai_actions.outcome allows success | pending | failed | escalated. It said
    // 'success' unconditionally, including for a run that saved nothing.
    outcome: created.length ? 'success' : 'failed',
  });

  // Nothing was drafted and we know why: say so, rather than answering "0
  // posts drafted" on a card that looks like it worked.
  if (!created.length) {
    throw new Error(
      insertErrors.length
        ? `Could not save the drafted posts: ${insertErrors[0]}`
        : 'Could not draft the week, try again',
    );
  }

  return created;
}

/**
 * The real instant at which the salon's wall clock reads what `wall` says.
 *
 * `wall` is a Date in the WALL FRAME: its UTC fields are the salon's local
 * year, month, day, hour and minute (which is what nowInSalonWall in
 * lib/free-slots.js produces, and the convention appointments.starts_at is
 * stored in). This converts back the other way, to the instant that wall time
 * actually names, so it can be compared against a real clock.
 *
 * Solved by correction rather than by table lookup: guess that the wall time
 * IS the instant, read the guess back in the salon's timezone, and shift by
 * the difference. Two passes settle it even across a DST boundary, where the
 * offset at the guess differs from the offset at the answer. A third is run
 * for the pathological case and costs nothing.
 */
export function salonWallToInstant(wall, timezone = 'Europe/London') {
  const want = wall.getTime();
  let guess = new Date(want);
  for (let i = 0; i < 3; i++) {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(guess).reduce((a, x) => (a[x.type] = x.value, a), {});
    const readBack = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    const drift = want - readBack;
    if (drift === 0) break;
    guess = new Date(guess.getTime() + drift);
  }
  return guess;
}
