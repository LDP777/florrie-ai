import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { createPostFromPhoto, publishPost, draftAvailabilityPost, generateCaption } from '../services/content-autopilot.js';
import logger from '../lib/logger.js';

const router = Router();

/**
 * GET /api/content
 * List content posts. ?status=draft for the approval queue. ?stream_id=uuid to filter by stream.
 */
router.get('/', requireAuth, async (req, res) => {
  let query = supabase
    .from('content_posts')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false })
    .limit(30);

  if (req.query.status) {
    const validStatuses = ['draft', 'approved', 'published', 'rejected', 'scheduled'];
    if (validStatuses.includes(req.query.status)) {
      query = query.eq('status', req.query.status);
    }
  }

  if (req.query.stream_id) {
    query = query.eq('stream_id', req.query.stream_id);
  }

  const { data, error } = await query;
  if (error) {
    logger.error({ err: error }, 'Failed to fetch content posts');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ posts: data });
});

/**
 * POST /api/content/generate
 * Upload a photo → get a draft post with caption + hashtags.
 * Body: { image_url, treatment_type?, context? }
 */
router.post('/generate', requireAuth, async (req, res) => {
  const { image_url, treatment_type, context } = req.body;

  if (!image_url) {
    return res.status(400).json({ error: 'image_url is required' });
  }

  try {
    const post = await createPostFromPhoto(
      req.beautician.id, image_url, treatment_type, context
    );
    res.status(201).json({ post });
  } catch (err) {
    logger.error({ err }, 'Content generation failed');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * GET /api/content/suggestions
 * Generate content suggestions based on recent appointments and treatments.
 * Returns a list of caption/post ideas ready to be created.
 */
router.get('/suggestions', requireAuth, async (req, res) => {
  try {
    // Get recent appointments (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const { data: recentAppointments, error: aptError } = await supabase
      .from('appointments')
      .select('*, treatments(name, duration_minutes), clients(first_name)')
      .eq('beautician_id', req.beautician.id)
      .eq('status', 'confirmed')
      .gte('ends_at', sevenDaysAgo.toISOString())
      .order('ends_at', { ascending: false })
      .limit(5);

    if (aptError) {
      logger.error({ err: aptError }, 'Failed to fetch recent appointments');
      return res.status(500).json({ error: 'Failed to fetch appointments' });
    }

    // Get beautician info for tone/brand context
    const { data: beautician, error: beautError } = await supabase
      .from('beauticians')
      .select('first_name, business_name, tone_model, brand_color')
      .eq('id', req.beautician.id)
      .single();

    if (beautError) {
      logger.error({ err: beautError }, 'Failed to fetch beautician');
      return res.status(500).json({ error: 'Failed to fetch profile' });
    }

    // Generate 3 content suggestions based on recent appointments
    const suggestions = [];

    if (!recentAppointments || recentAppointments.length === 0) {
      return res.json({
        suggestions: [],
        message: 'No recent appointments to suggest content from. Complete some appointments to get suggestions.'
      });
    }

    // Generate suggestions from top 3 most recent appointments
    for (let i = 0; i < Math.min(3, recentAppointments.length); i++) {
      const appt = recentAppointments[i];
      try {
        const treatmentName = appt.treatments?.name || 'treatment';
        const context = appt.clients?.first_name
          ? `Client: ${appt.clients.first_name}. Duration: ${appt.treatments?.duration_minutes || '?'} mins.`
          : '';

        const { caption, hashtags } = await generateCaption(
          req.beautician.id,
          null, // no image for suggestions
          treatmentName,
          context
        );

        suggestions.push({
          id: `suggestion_${i}`,
          treatment_type: treatmentName,
          caption,
          hashtags,
          created_at: new Date().toISOString(),
          appointment_id: appt.id,
          ready_to_post: true,
        });
      } catch (err) {
        logger.warn({ appointmentId: appt.id, err }, 'Failed to generate suggestion');
      }
    }

    res.json({
      suggestions,
      total: suggestions.length,
      message: suggestions.length === 0 ? 'Failed to generate suggestions. Try again later.' : undefined,
    });
  } catch (err) {
    logger.error({ err }, 'Content suggestions failed');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * POST /api/content/caption
 * Text-only caption generation — no image required.
 * Used by the compose flow when Florrie writes a caption from scratch.
 * Body: { post_type, treatment_type?, context? }
 */
router.post('/caption', requireAuth, async (req, res) => {
  const { post_type, treatment_type, context } = req.body;

  if (!post_type) {
    return res.status(400).json({ error: 'post_type is required' });
  }

  try {
    const additionalContext = [
      post_type !== 'before_after' ? `Post type: ${post_type}` : null,
      context || null,
    ].filter(Boolean).join('. ');

    const { caption, hashtags } = await generateCaption(
      req.beautician.id,
      null, // no image
      treatment_type || null,
      additionalContext || null,
    );

    res.json({ caption, hashtags });
  } catch (err) {
    logger.error({ err }, 'Caption generation failed');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * ─────────────────────────────────────────────────────────────────
 * STREAM ROUTES (must come before wildcard /:id routes)
 * ─────────────────────────────────────────────────────────────────
 */

/**
 * GET /api/content/streams
 * List all content streams for the authenticated beautician.
 */
router.get('/streams', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('content_streams')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .eq('active', true)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ err: error }, 'Failed to fetch content streams');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ streams: data });
});

/**
 * POST /api/content/streams
 * Create a new content stream.
 * Body: { name, type, monthly_target?, brand_notes? }
 */
router.post('/streams', requireAuth, async (req, res) => {
  const { name, type, monthly_target, brand_notes } = req.body;

  if (!name || !type) {
    return res.status(400).json({ error: 'name and type are required' });
  }

  const validTypes = ['personal', 'sponsor', 'campaign'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: 'type must be personal, sponsor, or campaign' });
  }

  const { data, error } = await supabase
    .from('content_streams')
    .insert({
      beautician_id: req.beautician.id,
      name,
      type,
      monthly_target: monthly_target || null,
      brand_notes: brand_notes || {},
    })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Failed to create content stream');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ stream: data });
});

/**
 * GET /api/content/streams/:id/progress
 * Get monthly progress for a sponsored stream.
 * Returns: { stream_id, monthly_target, posted_this_month, remaining, posts_this_month }
 */
router.get('/streams/:id/progress', requireAuth, async (req, res) => {
  // Fetch the stream
  const { data: stream, error: streamErr } = await supabase
    .from('content_streams')
    .select('*')
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .single();

  if (streamErr || !stream) {
    logger.error({ err: streamErr }, 'Failed to fetch content stream');
    return res.status(404).json({ error: 'Stream not found' });
  }

  // Get current month boundaries
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const monthStart = new Date(currentYear, currentMonth, 1).toISOString();
  const monthEnd = new Date(currentYear, currentMonth + 1, 0, 23, 59, 59).toISOString();

  // Fetch posts published/scheduled this month
  const { data: posts, error: postsErr } = await supabase
    .from('content_posts')
    .select('*')
    .eq('stream_id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .in('status', ['scheduled', 'posted'])
    .gte('created_at', monthStart)
    .lte('created_at', monthEnd)
    .order('created_at', { ascending: false });

  if (postsErr) {
    logger.error({ err: postsErr }, 'Failed to fetch stream posts');
    return res.status(500).json({ error: 'Something went wrong' });
  }

  const postedThisMonth = posts?.length || 0;
  const remaining = stream.monthly_target ? Math.max(0, stream.monthly_target - postedThisMonth) : null;

  res.json({
    stream_id: stream.id,
    monthly_target: stream.monthly_target,
    posted_this_month: postedThisMonth,
    remaining,
    posts_this_month: posts || [],
  });
});

/**
 * PUT /api/content/streams/:id
 * Update a content stream.
 */
router.put('/streams/:id', requireAuth, async (req, res) => {
  const { name, type, monthly_target, brand_notes, active } = req.body;
  const updates = {};

  if (name !== undefined) updates.name = name;
  if (type !== undefined) updates.type = type;
  if (monthly_target !== undefined) updates.monthly_target = monthly_target;
  if (brand_notes !== undefined) updates.brand_notes = brand_notes;
  if (active !== undefined) updates.active = active;

  const { data, error } = await supabase
    .from('content_streams')
    .update(updates)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Failed to update content stream');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ stream: data });
});

/**
 * DELETE /api/content/streams/:id
 * Delete a content stream (soft delete: set active = false).
 */
router.delete('/streams/:id', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('content_streams')
    .update({ active: false })
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id);

  if (error) {
    logger.error({ err: error }, 'Failed to delete content stream');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ success: true });
});

/**
 * ─────────────────────────────────────────────────────────────────
 * POST ROUTES (wildcard routes come after specific stream routes)
 * ─────────────────────────────────────────────────────────────────
 */

/**
 * PATCH /api/content/:id
 * Edit a draft post's caption or hashtags before publishing.
 */
router.patch('/:id', requireAuth, async (req, res) => {
  const { caption, hashtags } = req.body;
  const updates = {};
  if (caption !== undefined) updates.caption = caption;
  if (hashtags !== undefined) updates.hashtags = hashtags;

  const { data, error } = await supabase
    .from('content_posts')
    .update(updates)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Failed to update content post');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ post: data });
});

/**
 * POST /api/content/:id/schedule
 * Schedule a draft to publish itself at a chosen time. The content
 * scheduler cron (index.js, every 5 min) does the actual publishing.
 * Body: { scheduled_for: ISO timestamp } — or null to unschedule back to draft.
 */
router.post('/:id/schedule', requireAuth, async (req, res) => {
  const { scheduled_for } = req.body;

  if (scheduled_for === null) {
    const { data, error } = await supabase
      .from('content_posts')
      .update({ status: 'draft', scheduled_for: null })
      .eq('id', req.params.id)
      .eq('beautician_id', req.beautician.id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: 'Something went wrong' });
    return res.json({ post: data });
  }

  const when = new Date(scheduled_for);
  if (isNaN(when.getTime())) {
    return res.status(400).json({ error: 'scheduled_for must be a valid timestamp' });
  }
  if (when.getTime() < Date.now() - 60 * 1000) {
    return res.status(400).json({ error: 'That time has already passed' });
  }

  const { data, error } = await supabase
    .from('content_posts')
    .update({ status: 'scheduled', scheduled_for: when.toISOString() })
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Failed to schedule content post');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ post: data });
});

/**
 * POST /api/content/:id/publish
 * One-tap approve and publish to Instagram.
 */
router.post('/:id/publish', requireAuth, async (req, res) => {
  try {
    const result = await publishPost(req.beautician.id, req.params.id);
    res.json(result);
  } catch (err) {
    logger.error({ err }, 'Failed to publish content post');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * DELETE /api/content/:id
 * Discard a draft post.
 */
router.delete('/:id', requireAuth, async (req, res) => {
  await supabase
    .from('content_posts')
    .delete()
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .eq('status', 'draft');

  res.json({ success: true });
});

export default router;
