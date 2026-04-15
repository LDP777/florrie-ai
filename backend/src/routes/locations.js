import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import logger from '../lib/logger.js';
import {
  createLocationSchema,
  updateLocationSchema
} from '../lib/schemas.js';

const router = Router();

/**
 * GET /api/locations
 * List all locations for the authenticated beautician
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('locations')
      .select('*')
      .eq('beautician_id', req.beautician.id)
      .order('is_primary', { ascending: false })
      .order('created_at', { ascending: true });

    if (error) {
      logger.error({ err: error }, 'Failed to complete location operation');
      return res.status(500).json({ error: 'Something went wrong' });
    }
    res.json({ locations: data || [] });
  } catch (err) {
    logger.error({ err }, 'List locations error');
    res.status(500).json({ error: 'Failed to list locations' });
  }
});

/**
 * POST /api/locations
 * Create a new location
 * Body: {
 *   name: "Salon Name",
 *   address?: "123 Main St",
 *   phone?: "+441234567890",
 *   is_primary?: false,
 *   status?: "active" | "setup" | "archived"
 * }
 */
router.post('/', requireAuth, validate(createLocationSchema), async (req, res) => {
  try {
    const { name, address, phone, is_primary, status } = req.body;

    // If marking as primary, unset primary on all other locations
    if (is_primary) {
      await supabase
        .from('locations')
        .update({ is_primary: false })
        .eq('beautician_id', req.beautician.id);
    }

    const location = {
      beautician_id: req.beautician.id,
      name,
      address: address || null,
      phone: phone || null,
      is_primary: is_primary || false,
      status: status || 'active',
      created_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('locations')
      .insert([location])
      .select()
      .single();

    if (error) {
      logger.error({ err: error }, 'Failed to complete location operation');
      return res.status(500).json({ error: 'Something went wrong' });
    }
    res.status(201).json({ location: data });
  } catch (err) {
    logger.error({ err }, 'Create location error');
    res.status(500).json({ error: 'Failed to create location' });
  }
});

/**
 * PATCH /api/locations/:id
 * Update a location
 */
router.patch('/:id', requireAuth, validate(updateLocationSchema), async (req, res) => {
  try {
    const { id } = req.params;

    // Verify location belongs to this beautician
    const { data: existing, error: checkError } = await supabase
      .from('locations')
      .select('id')
      .eq('id', id)
      .eq('beautician_id', req.beautician.id)
      .single();

    if (checkError || !existing) {
      return res.status(404).json({ error: 'Location not found' });
    }

    // If marking as primary, unset primary on all others
    if (req.body.is_primary === true) {
      await supabase
        .from('locations')
        .update({ is_primary: false })
        .eq('beautician_id', req.beautician.id)
        .neq('id', id);
    }

    const updates = {
      ...req.body,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('locations')
      .update(updates)
      .eq('id', id)
      .eq('beautician_id', req.beautician.id)
      .select()
      .single();

    if (error) {
      logger.error({ err: error }, 'Failed to complete location operation');
      return res.status(500).json({ error: 'Something went wrong' });
    }
    res.json({ location: data });
  } catch (err) {
    logger.error({ err }, 'Update location error');
    res.status(500).json({ error: 'Failed to update location' });
  }
});

/**
 * DELETE /api/locations/:id
 * Remove a location
 */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Verify location belongs to this beautician
    const { data: existing, error: checkError } = await supabase
      .from('locations')
      .select('id, is_primary')
      .eq('id', id)
      .eq('beautician_id', req.beautician.id)
      .single();

    if (checkError || !existing) {
      return res.status(404).json({ error: 'Location not found' });
    }

    // Don't allow deleting if it's the primary location
    if (existing.is_primary) {
      return res.status(400).json({ error: 'Cannot delete primary location' });
    }

    const { error } = await supabase
      .from('locations')
      .delete()
      .eq('id', id)
      .eq('beautician_id', req.beautician.id);

    if (error) {
      logger.error({ err: error }, 'Failed to complete location operation');
      return res.status(500).json({ error: 'Something went wrong' });
    }
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Delete location error');
    res.status(500).json({ error: 'Failed to delete location' });
  }
});

/**
 * POST /api/locations/:id/set-default
 * Set a location as the active location for the current session.
 * Updates beauticians.default_location_id.
 */
router.post('/:id/set-default', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Verify location belongs to beautician
    const { data: loc, error: checkErr } = await supabase
      .from('locations')
      .select('id')
      .eq('id', id)
      .eq('beautician_id', req.beautician.id)
      .single();

    if (checkErr || !loc) {
      return res.status(404).json({ error: 'Location not found' });
    }

    const { error } = await supabase
      .from('beauticians')
      .update({ default_location_id: id })
      .eq('id', req.beautician.id);

    if (error) return res.status(500).json({ error: 'Failed to set default location' });
    res.json({ success: true, default_location_id: id });
  } catch (err) {
    logger.error({ err }, 'Set default location error');
    res.status(500).json({ error: 'Failed to set default location' });
  }
});

export default router;
