import { Router } from 'express';
import { supabase } from '../index.js';
import { requireAuth } from '../middleware/auth.js';
import { createPostFromPhoto, publishPost, draftAvailabilityPost } from '../services/content-autopilot.js';

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
  if (error) return res.status(500).json({ error: error.message });
  res.json({ posts: data });
});

/**
 * POST /api/content/generate
 * Upload a photo → get a draft post with caption + hashtags.
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
    res.status(500).json({ error: err.message });
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

  if (error) return res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: err.message });
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
