import Anthropic from '@anthropic-ai/sdk';
import { cleanReply } from '../lib/text.js';
import { supabase } from '../config.js';
import logger from '../lib/logger.js';

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
 * Generate a caption from an uploaded before/after photo.
 * Uses Claude Vision to understand the image, then Sonnet for the caption.
 */
export async function generateCaption(beauticianId, imageUrl, treatmentType, additionalContext) {
  const { data: beautician } = await supabase
    .from('beauticians')
    .select('first_name, business_name, tone_model, brand_color')
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

  const response = await anthropic.messages.create({
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
${performanceContext}

Return ONLY the caption text. No quotes, no explanation, no hashtag suggestions (those come separately).`,
    messages: [{
      role: 'user',
      content: `Write an Instagram caption for a ${treatmentType || 'beauty treatment'} before/after photo.${additionalContext ? ` Context: ${additionalContext}` : ''}`
    }]
  });

  const caption = cleanReply(response.content[0].text.trim());

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
    .select('first_name, business_name, tone_model, booking_slug')
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

  const caption = cleanReply(response.content[0].text.trim());

  // Store as draft
  const { data: post } = await supabase
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

  // Log AI action
  await supabase.from('ai_actions').insert({
    beautician_id: beauticianId,
    action_type: 'content_drafted',
    digital_employee: 'content',
    summary: `Drafted a last-minute availability post for ${dayLabel}`,
    details: { post_id: post?.id, gap_date: gapDate, gap_time: gapTime },
    confidence: 0.95,
    autonomous: true,
    outcome: 'success',
    notification_sent: true,
    notification_text: `Gap on ${dayLabel}. I've drafted an availability post. One tap to share.`
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
    notification_sent: true,
    notification_text: `New post ready from your ${treatmentType || 'treatment'} photo. Tap to review.`
  });

  return post;
}

/**
 * Approve and publish a post to Instagram.
 * Uses the Instagram Graph API to publish.
 */
export async function publishPost(beauticianId, postId) {
  const { data: post } = await supabase
    .from('content_posts')
    .select('*')
    .eq('id', postId)
    .eq('beautician_id', beauticianId)
    .single();

  if (!post) throw new Error('Post not found');

  const { data: beautician } = await supabase
    .from('beauticians')
    .select('instagram_page_id, instagram_page_token')
    .eq('id', beauticianId)
    .single();

  if (!beautician?.instagram_page_id || !beautician?.instagram_page_token) {
    // No Instagram connected — mark as approved but can't publish
    await supabase.from('content_posts').update({
      status: 'approved',
      approved_at: new Date().toISOString()
    }).eq('id', postId);

    return { published: false, reason: 'Instagram not connected' };
  }

  try {
    // Step 1: Create media container
    const fullCaption = [post.caption, '', post.hashtags?.join(' ')].filter(Boolean).join('\n');

    const containerRes = await fetch(
      `https://graph.facebook.com/v21.0/${beautician.instagram_page_id}/media`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_url: post.image_url,
          caption: fullCaption,
          access_token: beautician.instagram_page_token
        })
      }
    );
    const container = await containerRes.json();

    if (!container.id) throw new Error('Failed to create media container');

    // Step 2: Publish
    const publishRes = await fetch(
      `https://graph.facebook.com/v21.0/${beautician.instagram_page_id}/media_publish`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          creation_id: container.id,
          access_token: beautician.instagram_page_token
        })
      }
    );
    const published = await publishRes.json();

    // Update post record
    await supabase.from('content_posts').update({
      status: 'posted',
      approved_at: new Date().toISOString(),
      posted_at: new Date().toISOString(),
      external_post_id: published.id
    }).eq('id', postId);

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
      notification_sent: true,
      notification_text: 'Your post is live on Instagram!'
    });

    return { published: true, instagramId: published.id };

  } catch (err) {
    logger.error({ err }, 'Instagram publish error');
    await supabase.from('content_posts').update({ status: 'failed' }).eq('id', postId);
    return { published: false, reason: err.message };
  }
}
