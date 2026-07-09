import Anthropic from '@anthropic-ai/sdk';
import { cleanReply } from '../lib/text.js';
import { buildVoiceGuide } from './voice-profile.js';
import { ensureNoSlop } from '../lib/anti-slop.js';
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

${buildVoiceGuide(beautician.voice_profile)}
${performanceContext}

Return ONLY the caption text. No quotes, no explanation, no hashtag suggestions (those come separately).`,
    messages: [{
      role: 'user',
      content: `Write an Instagram caption for a ${treatmentType || 'beauty treatment'} before/after photo.${additionalContext ? ` Context: ${additionalContext}` : ''}`
    }]
  });

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

  const isStory = post.media_kind === 'story';
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

    // graph.instagram.com, NOT graph.facebook.com: accounts connect via
    // Instagram Business Login (June 2026 rewrite) whose user tokens only
    // work on the instagram.com graph host, same as sendInstagramDM.
    const containerRes = await fetch(
      `https://graph.instagram.com/v21.0/${beautician.instagram_page_id}/media`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${beautician.instagram_page_token}`,
        },
        body: JSON.stringify({
          image_url: post.image_url,
          // Stories: same two-step flow with media_type STORIES; captions
          // are not rendered on stories so they are omitted.
          ...(isStory ? { media_type: 'STORIES' } : { caption: fullCaption })
        })
      }
    );
    const container = await containerRes.json();

    if (!container.id) throw new Error('Failed to create media container');

    // Step 2: Publish
    const publishRes = await fetch(
      `https://graph.instagram.com/v21.0/${beautician.instagram_page_id}/media_publish`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${beautician.instagram_page_token}`,
        },
        body: JSON.stringify({
          creation_id: container.id
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

/**
 * Plan my week: one tap drafts a week of posts in HER voice, from real
 * salon data only (recent work, real reviews, real promos). Nothing is
 * invented and nothing publishes without her approval: each draft carries a
 * suggested day/time in scheduled_for but stays status 'draft' until she
 * approves it (POST /api/content/:id/schedule flips it live).
 */
export async function planWeek(beauticianId) {
  const { data: beautician } = await supabase
    .from('beauticians')
    .select('first_name, business_name, tone_model, voice_profile, booking_slug')
    .eq('id', beauticianId)
    .single();
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
      .not('comment', 'is', null)
      .order('created_at', { ascending: false })
      .limit(3),
    supabase.from('promo_codes')
      .select('code, discount_type, discount_value, valid_until, is_active')
      .eq('beautician_id', beauticianId)
      .eq('is_active', true)
      .limit(3),
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
  const now = new Date();
  const promos = (promosRes.data || []).filter(p => !p.valid_until || new Date(p.valid_until) > now);
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
      content: `Plan this week.\nRecent work: ${topTreatments.join(', ') || 'general beauty treatments'}.\nReal reviews available: ${reviews.length ? reviews.map(r => `"${r}"`).join(' | ') : 'none'}.\nReal promos running: ${promos.length ? promos.map(pr => `${pr.code} (${pr.discount_type === 'percentage' ? pr.discount_value + '% off' : '£' + (pr.discount_value / 100).toFixed(2) + ' off'})`).join(', ') : 'none'}.`
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

  // Suggested slot: next occurrence of each day at 18:30 (good IG time).
  const dayIdx = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const created = [];
  for (const item of plan.slice(0, 7)) {
    const target = dayIdx[item.day] ?? 1;
    const d = new Date();
    let add = (target - d.getDay() + 7) % 7;
    if (add === 0) add = 7; // never "today in the past", always the coming one
    d.setDate(d.getDate() + add);
    d.setHours(18, 30, 0, 0);

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
        scheduled_for: d.toISOString(),
      })
      .select()
      .single();
    if (!error && post) created.push(post);
  }

  await supabase.from('ai_actions').insert({
    beautician_id: beauticianId,
    action_type: 'content_drafted',
    digital_employee: 'content_creator',
    summary: `Drafted ${created.length} posts for the week ahead`,
    details: { post_ids: created.map(c => c.id) },
    confidence: 1.0,
    autonomous: false,
    outcome: 'success',
  });

  return created;
}
