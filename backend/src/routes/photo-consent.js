import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import logger from '../lib/logger.js';
import {
  createPhotoConsentSchema,
  revokePhotoConsentSchema
} from '../lib/schemas.js';

const router = Router();

// Default consent window. The page can show this as the expiry and prompt a
// renewal once it passes. Twelve months matches the page's default setting.
const CONSENT_MONTHS = 12;

/**
 * GET /api/photo-consent
 * List every photo consent for the signed-in beautician, newest first.
 * The page reads { data } and pulls the client's name off the joined row.
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('photo_consents')
      .select('*, clients(first_name, last_name)')
      .eq('beautician_id', req.beautician.id)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error({ err: error }, 'Failed to list photo consents');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    const rows = (data || []).map((c) => ({
      ...c,
      client_name: c.clients?.first_name || null,
    }));

    res.json({ data: rows });
  } catch (err) {
    logger.error({ err }, 'List photo consents error');
    res.status(500).json({ error: 'Failed to list consents' });
  }
});

/**
 * GET /api/photo-consent/client/:clientId
 * Every photo consent for one client. Namespaced under /client so it can never
 * shadow the list route above.
 */
router.get('/client/:clientId', requireAuth, async (req, res) => {
  try {
    const { clientId } = req.params;

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
      logger.error({ err: error }, 'Failed to get client photo consents');
      return res.status(500).json({ error: 'Something went wrong' });
    }
    res.json({ data: data || [] });
  } catch (err) {
    logger.error({ err }, 'Get client photo consents error');
    res.status(500).json({ error: 'Failed to get consents' });
  }
});

/**
 * POST /api/photo-consent
 * Request photo consent from a client.
 * Body: {
 *   client_id: uuid,
 *   permitted_uses: string[],   // e.g. ['portfolio', 'booking-page']
 *   method?: 'digital' | 'paper',
 *   notes?: string              // the message sent to the client
 * }
 * Creates a 'pending' record. Returns { data } shaped like a list row.
 */
router.post('/', requireAuth, validate(createPhotoConsentSchema), async (req, res) => {
  try {
    const { client_id, permitted_uses, method, notes } = req.body;

    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('id, first_name')
      .eq('id', client_id)
      .eq('beautician_id', req.beautician.id)
      .single();

    if (clientError || !client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const nowIso = new Date().toISOString();
    const expires = new Date();
    expires.setMonth(expires.getMonth() + CONSENT_MONTHS);

    const consent = {
      beautician_id: req.beautician.id,
      client_id,
      status: 'pending',
      permitted_uses,
      method: method || null,
      notes: notes || null,
      expires_at: expires.toISOString(),
      created_at: nowIso,
      updated_at: nowIso,
    };

    const { data, error } = await supabase
      .from('photo_consents')
      .insert([consent])
      .select('*')
      .single();

    if (error) {
      logger.error({ err: error }, 'Failed to create photo consent');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    res.status(201).json({ data: { ...data, client_name: client.first_name } });
  } catch (err) {
    logger.error({ err }, 'Create photo consent error');
    res.status(500).json({ error: 'Failed to create consent' });
  }
});

/**
 * PATCH /api/photo-consent/:id/revoke
 * Withdraw a consent: status -> 'declined', clear the permitted uses, stamp
 * revoked_at. Body: { notes?: string }. Returns { data }.
 */
router.patch('/:id/revoke', requireAuth, validate(revokePhotoConsentSchema), async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

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
      status: 'declined',
      granted: false,
      permitted_uses: [],
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
      .select('*')
      .single();

    if (error) {
      logger.error({ err: error }, 'Failed to revoke photo consent');
      return res.status(500).json({ error: 'Something went wrong' });
    }
    res.json({ data });
  } catch (err) {
    logger.error({ err }, 'Revoke photo consent error');
    res.status(500).json({ error: 'Failed to revoke consent' });
  }
});

export default router;
