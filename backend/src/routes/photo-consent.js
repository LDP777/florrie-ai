import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../index.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import logger from '../lib/logger.js';

const router = Router();

const createPhotoConsentSchema = z.object({
  client_id: z.string().uuid('Invalid client ID'),
  consent_type: z.enum(['before_after', 'social_media', 'marketing', 'portfolio'], {
    errorMap: () => ({ message: 'consent_type must be one of: before_after, social_media, marketing, portfolio' }),
  }),
  granted: z.boolean().optional().default(false),
  signature_data: z.string().optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
});

const revokePhotoConsentSchema = z.object({
  notes: z.string().max(1000).optional().nullable(),
});

/**
 * GET /api/photo-consent/:clientId
 * Get all photo consents for a specific client
 */
router.get('/:clientId', requireAuth, async (req, res) => {
  try {
    const { clientId } = req.params;

    // Verify client belongs to this beautician
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('id')
      .eq('id', clientId)
      .eq('beautician_id', req.beautician.id)
      .single();

    if (clientError || !client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const { data, error } = await supabase
      .from('photo_consents')
      .select('*')
      .eq('beautician_id', req.beautician.id)
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error({ err: error }, 'Failed to complete photo consent operation');
      return res.status(500).json({ error: 'Something went wrong' });
    }
    res.json({ consents: data || [] });
  } catch (err) {
    logger.error({ err }, 'Get photo consents error');
    res.status(500).json({ error: 'Failed to get consents' });
  }
});

/**
 * POST /api/photo-consent
 * Create a new photo consent record
 * Body: {
 *   client_id: uuid,
 *   consent_type: 'before_after' | 'social_media' | 'marketing' | 'portfolio',
 *   granted?: boolean,
 *   signature_data?: string,
 *   notes?: string
 * }
 */
router.post('/', requireAuth, validate(createPhotoConsentSchema), async (req, res) => {
  try {
    const { client_id, consent_type, granted, signature_data, notes } = req.body;

    // Verify client belongs to this beautician
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('id')
      .eq('id', client_id)
      .eq('beautician_id', req.beautician.id)
      .single();

    if (clientError || !client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const consent = {
      beautician_id: req.beautician.id,
      client_id,
      consent_type,
      granted: granted || false,
      signature_data: signature_data || null,
      notes: notes || null,
      granted_at: granted ? new Date().toISOString() : null,
      created_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('photo_consents')
      .insert([consent])
      .select()
      .single();

    if (error) {
      logger.error({ err: error }, 'Failed to complete photo consent operation');
      return res.status(500).json({ error: 'Something went wrong' });
    }
    res.status(201).json({ consent: data });
  } catch (err) {
    logger.error({ err }, 'Create photo consent error');
    res.status(500).json({ error: 'Failed to create consent' });
  }
});

/**
 * PATCH /api/photo-consent/:id/revoke
 * Revoke a consent (set granted=false, revoked_at=now)
 */
router.patch('/:id/revoke', requireAuth, validate(revokePhotoConsentSchema), async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    // Verify consent belongs to this beautician
    const { data: existing, error: checkError } = await supabase
      .from('photo_consents')
      .select('id')
      .eq('id', id)
      .eq('beautician_id', req.beautician.id)
      .single();

    if (checkError || !existing) {
      return res.status(404).json({ error: 'Consent not found' });
    }

    const updates = {
      granted: false,
      revoked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (notes) {
      updates.notes = notes;
    }

    const { data, error } = await supabase
      .from('photo_consents')
      .update(updates)
      .eq('id', id)
      .eq('beautician_id', req.beautician.id)
      .select()
      .single();

    if (error) {
      logger.error({ err: error }, 'Failed to complete photo consent operation');
      return res.status(500).json({ error: 'Something went wrong' });
    }
    res.json({ consent: data });
  } catch (err) {
    logger.error({ err }, 'Revoke photo consent error');
    res.status(500).json({ error: 'Failed to revoke consent' });
  }
});

export default router;
