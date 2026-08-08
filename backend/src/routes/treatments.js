import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';
import {
  treatmentSchema,
  treatmentUpdateSchema
} from '../lib/schemas.js';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * GET /api/treatments
 * List all treatments for the authenticated beautician.
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('treatments')
      .select('*')
      .eq('beautician_id', req.beautician.id)
      .order('sort_order', { ascending: true });

    if (error) {
      logger.error({ err: error }, 'Failed to fetch treatments for beautician');
      return res.status(500).json({ error: 'Something went wrong' });
    }
    res.json({ treatments: data });
  } catch (err) {
    logger.error({ err }, 'Unexpected error fetching treatments');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * POST /api/treatments
 * Create a new treatment.
 */
router.post('/', requireAuth, async (req, res) => {
  try {
    const parsed = treatmentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    const { data, error } = await supabase
      .from('treatments')
      .insert({ beautician_id: req.beautician.id, ...parsed.data })
      .select()
      .single();

    if (error) {
      logger.error({ err: error }, 'Failed to create treatment');
      return res.status(500).json({ error: 'Something went wrong' });
    }
    res.status(201).json({ treatment: data });
  } catch (err) {
    logger.error({ err }, 'Unexpected error creating treatment');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * PATCH /api/treatments/reorder
 *
 * Ellie asked for this: "it's bugging me that the brow wax is the second
 * option, I want it at the bottom." treatments.sort_order has existed since the
 * initial schema and both this list and the public booking page already order
 * by it, but nothing ever WROTE it, so every row sat at the default 0 and the
 * order was whatever Postgres happened to return.
 *
 * Takes the full ordered list of ids for one category and writes the index to
 * each. Declared BEFORE /:id, or Express matches "reorder" as an id.
 *
 * Body: { ids: [uuid, ...] }
 */
router.patch('/reorder', requireAuth, async (req, res) => {
  try {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200) {
      return res.status(400).json({ error: 'Send an array of treatment ids' });
    }
    if (!ids.every(id => typeof id === 'string' && UUID_RE.test(id))) {
      return res.status(400).json({ error: 'Send an array of treatment ids' });
    }
    if (new Set(ids).size !== ids.length) {
      return res.status(400).json({ error: 'Duplicate treatment ids' });
    }

    // Every id must belong to this beautician. Checked up front rather than
    // per-update, so a foreign id cannot reorder somebody else's price list.
    const { data: owned, error: ownErr } = await supabase
      .from('treatments')
      .select('id')
      .eq('beautician_id', req.beautician.id)
      .in('id', ids);

    if (ownErr) {
      logger.error({ err: ownErr }, 'Failed to verify treatment ownership for reorder');
      return res.status(500).json({ error: 'Something went wrong' });
    }
    if (!owned || owned.length !== ids.length) {
      return res.status(404).json({ error: 'Treatment not found' });
    }

    // Supabase has no multi-row update with differing values, so these go in
    // parallel. Each is scoped to the beautician a second time, belt and braces.
    const results = await Promise.all(
      ids.map((id, index) =>
        supabase
          .from('treatments')
          .update({ sort_order: index })
          .eq('id', id)
          .eq('beautician_id', req.beautician.id)
      )
    );

    const failed = results.find(r => r.error);
    if (failed) {
      logger.error({ err: failed.error }, 'Failed to write treatment sort order');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    res.json({ ok: true, count: ids.length });
  } catch (err) {
    logger.error({ err }, 'Unexpected error reordering treatments');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * PATCH /api/treatments/:id
 * Update a treatment.
 */
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const parsed = treatmentUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const updates = parsed.data;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const { data, error } = await supabase
      .from('treatments')
      .update(updates)
      .eq('id', req.params.id)
      .eq('beautician_id', req.beautician.id)
      .select()
      .single();

    if (error) {
      logger.error({ err: error }, 'Failed to update treatment');
      return res.status(500).json({ error: 'Something went wrong' });
    }
    res.json({ treatment: data });
  } catch (err) {
    logger.error({ err }, 'Unexpected error updating treatment');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * DELETE /api/treatments/:id
 * Soft-delete (deactivate) a treatment.
 */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase
      .from('treatments')
      .update({ is_active: false, booking_enabled: false })
      .eq('id', req.params.id)
      .eq('beautician_id', req.beautician.id);

    if (error) {
      logger.error({ err: error }, 'Failed to delete treatment');
      return res.status(500).json({ error: 'Something went wrong' });
    }
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Unexpected error deleting treatment');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

export default router;
