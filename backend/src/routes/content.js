import { Router } from 'express';
import { supabase } from '../index.js';
import { requireAuth } from '../middleware/auth.js';
import { createPostFromPhoto, publishPost, draftAvailabilityPost, generateCaption } from '../services/content-autopilot.js';
import logger from '../lib/logger.js';

const router = Router();

/**
 * GET /api/content
 * List content posts. ?status=draft for the approval queue.
 */
router.get('/', requireAuth, async (req, res) => {
  let query = supabase
    .from('content_posts')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false })
    .limit(30);

  if (req.query.status) {
    query = query.eq('status', req.query.status);
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
