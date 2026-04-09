import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../index.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';

const treatmentSchema = z.object({
  name: z.string().min(1).max(200).trim(),
  description: z.string().max(5000).nullable().optional(),
  duration_minutes: z.number().int().min(1).max(480),
  buffer_minutes: z.number().int().min(0).max(120).optional().default(0),
  price_cents: z.number().int().min(0),
  deposit_cents: z.number().int().min(0).optional().default(0),
  category: z.string().max(100).nullable().optional(),
  product_cost_cents: z.number().int().min(0).optional().default(0),
  contraindications: z.array(z.string().max(200)).max(20).optional().default([])
});

const treatmentUpdateSchema = z.object({
  name: z.string().min(1).max(200).trim().optional(),
  description: z.string().max(5000).nullable().optional(),
  duration_minutes: z.number().int().min(1).max(480).optional(),
  buffer_minutes: z.number().int().min(0).max(120).optional(),
  price_cents: z.number().int().min(0).optional(),
  deposit_cents: z.number().int().min(0).optional(),
  deposit_percent: z.number().min(0).max(100).optional(),
  category: z.string().max(100).nullable().optional(),
  product_cost_cents: z.number().int().min(0).optional(),
  contraindications: z.array(z.string().max(200)).max(20).optional(),
  is_active: z.boolean().optional(),
  booking_enabled: z.boolean().optional(),
  sort_order: z.number().int().min(0).optional(),
  requires_consultation: z.boolean().optional(),
  consultation_form_id: z.string().uuid().nullable().optional()
}).strict();

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
