import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';
import { KNOWLEDGE_CATEGORIES } from '../lib/knowledge.js';

const router = Router();

/**
 * The knowledge base: Ellie's own notes (aftercare, policies, treatment
 * explainers, prep) that the AI front desk quotes instead of guessing.
 *
 * Migration 019 is run by hand, so every route here has to survive the
 * table not existing yet: reads answer with needs_migration instead of
 * erroring, writes answer 503 with a plain explanation, nothing crashes.
 */

// 42P01 = relation does not exist, 42703 = column does not exist. Either
// means migration 019 has not been run yet.
//
// 23514 = a CHECK constraint refused the row, and for this table that means one
// thing: the category column's CHECK is older than KNOWLEDGE_CATEGORIES. That
// is exactly what saving an 'arrival' note does before migration 022 is run by
// hand, and without this line the owner gets "Something went wrong" on the one
// note the 27 August fix asks her to write. Same family of answer as the other
// two: a migration nobody has run yet, said plainly.
const isPreMigration = (error) =>
  error && (error.code === '42P01' || error.code === '42703' || error.code === '23514');

const MIGRATION_MESSAGE = 'That kind of note is not switched on yet for this account. Nothing is lost, try again once it is enabled.';

function validateFields({ category, title, content }, { partial = false } = {}) {
  if (category !== undefined || !partial) {
    if (!KNOWLEDGE_CATEGORIES.includes(category)) {
      return `category must be one of: ${KNOWLEDGE_CATEGORIES.join(', ')}`;
    }
  }
  if (title !== undefined || !partial) {
    if (!title || typeof title !== 'string' || !title.trim()) return 'title is required';
    if (title.length > 120) return 'title must be 120 characters or fewer';
  }
  if (content !== undefined || !partial) {
    if (!content || typeof content !== 'string' || !content.trim()) return 'content is required';
    if (content.length > 5000) return 'content must be 5000 characters or fewer';
  }
  return null;
}

/**
 * GET /api/knowledge
 * List the beautician's own entries, active first, then by category.
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('knowledge_entries')
      .select('*')
      .eq('beautician_id', req.beautician.id)
      .order('is_active', { ascending: false })
      .order('category', { ascending: true })
      .order('created_at', { ascending: false });

    if (isPreMigration(error)) {
      return res.json({ entries: [], needs_migration: true });
    }
    if (error) {
      logger.error({ err: error }, 'Failed to fetch knowledge entries');
      return res.status(500).json({ error: 'Something went wrong' });
    }
    res.json({ entries: data || [] });
  } catch (err) {
    logger.error({ err }, 'List knowledge entries error');
    res.status(500).json({ error: 'Failed to list knowledge entries' });
  }
});

/**
 * POST /api/knowledge
 * Create an entry. Body: { category, title, content }
 */
router.post('/', requireAuth, async (req, res) => {
  try {
    const { category, title, content } = req.body || {};
    const invalid = validateFields({ category, title, content });
    if (invalid) return res.status(400).json({ error: invalid });

    const { data, error } = await supabase
      .from('knowledge_entries')
      .insert([{
        beautician_id: req.beautician.id,
        category,
        title: title.trim(),
        content: content.trim(),
      }])
      .select()
      .single();

    if (isPreMigration(error)) {
      return res.status(503).json({ error: MIGRATION_MESSAGE });
    }
    if (error) {
      logger.error({ err: error }, 'Failed to create knowledge entry');
      return res.status(500).json({ error: 'Something went wrong' });
    }
    res.status(201).json({ entry: data });
  } catch (err) {
    logger.error({ err }, 'Create knowledge entry error');
    res.status(500).json({ error: 'Failed to create knowledge entry' });
  }
});

/**
 * PATCH /api/knowledge/:id
 * Update an entry (category, title, content, is_active). Owner scoped.
 */
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { category, title, content, is_active } = req.body || {};
    const invalid = validateFields({ category, title, content }, { partial: true });
    if (invalid) return res.status(400).json({ error: invalid });

    const updates = { updated_at: new Date().toISOString() };
    if (category !== undefined) updates.category = category;
    if (title !== undefined) updates.title = title.trim();
    if (content !== undefined) updates.content = content.trim();
    if (is_active !== undefined) updates.is_active = Boolean(is_active);

    const { data, error } = await supabase
      .from('knowledge_entries')
      .update(updates)
      .eq('id', req.params.id)
      .eq('beautician_id', req.beautician.id)
      .select()
      .single();

    if (isPreMigration(error)) {
      return res.status(503).json({ error: MIGRATION_MESSAGE });
    }
    if (error || !data) {
      if (error?.code === 'PGRST116') return res.status(404).json({ error: 'Entry not found' });
      logger.error({ err: error }, 'Failed to update knowledge entry');
      return res.status(500).json({ error: 'Something went wrong' });
    }
    res.json({ entry: data });
  } catch (err) {
    logger.error({ err }, 'Update knowledge entry error');
    res.status(500).json({ error: 'Failed to update knowledge entry' });
  }
});

/**
 * DELETE /api/knowledge/:id
 * Soft delete: is_active = false. The row stays so nothing Ellie wrote is
 * ever lost; retrieval only reads active entries.
 */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase
      .from('knowledge_entries')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('beautician_id', req.beautician.id);

    if (isPreMigration(error)) {
      return res.status(503).json({ error: MIGRATION_MESSAGE });
    }
    if (error) {
      logger.error({ err: error }, 'Failed to delete knowledge entry');
      return res.status(500).json({ error: 'Something went wrong' });
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'Delete knowledge entry error');
    res.status(500).json({ error: 'Failed to delete knowledge entry' });
  }
});

export default router;
