import { Router } from 'express';
import { supabase } from '../index.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';

const router = Router();

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
    const { name, description, duration_minutes, buffer_minutes, price_cents,
            deposit_cents, category, product_cost_cents, contraindications } = req.body;

    if (!name || !duration_minutes || price_cents === undefined) {
      return res.status(400).json({ error: 'Name, duration, and price are required' });
    }

    const { data, error } = await supabase
      .from('treatments')
      .insert({
        beautician_id: req.beautician.id,
        name,
        description: description || null,
        duration_minutes,
        buffer_minutes: buffer_minutes || 0,
        price_cents,
        deposit_cents: deposit_cents || 0,
        category: category || null,
        product_cost_cents: product_cost_cents || 0,
        contraindications: contraindications || []
      })
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
 * PATCH /api/treatments/:id
 * Update a treatment.
 */
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const allowedFields = [
      'name', 'description', 'duration_minutes', 'buffer_minutes',
      'price_cents', 'deposit_cents', 'deposit_percent', 'category', 'product_cost_cents',
      'contraindications', 'is_active', 'booking_enabled', 'sort_order',
      'requires_consultation', 'consultation_form_id'
    ];

    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
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
