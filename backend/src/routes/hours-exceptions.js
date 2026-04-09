import { Router } from 'express';
import { supabase } from '../index.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';

const router = Router();

/**
 * GET /api/hours-exceptions
 * List all hour exceptions for the authenticated beautician
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('hours_exceptions')
      .select('*')
      .eq('beautician_id', req.beautician.id)
      .order('date', { ascending: false });

    if (error) {
      logger.error({ err: error }, 'Failed to fetch hours exceptions');
      return res.status(500).json({ error: 'Something went wrong' });
    }
    res.json({ exceptions: data || [] });
  } catch (err) {
    logger.error({ err }, 'List hours exceptions error');
    res.status(500).json({ error: 'Failed to list exceptions' });
  }
});

/**
 * POST /api/hours-exceptions
 * Create a new hours exception
 * Body: {
 *   date: "2026-03-28",
 *   end_date?: "2026-03-30" (for multi-day closures),
 *   type: "closed" | "amended" | "extended",
 *   reason: "holiday" | "sick" | "personal" | "training" | "bank_holiday" | "event" | "other",
 *   note?: "Spring holiday",
 *   start_time?: "10:00" (required for amended/extended, not allowed for closed),
 *   end_time?: "14:00" (required for amended/extended, not allowed for closed),
 *   notify_clients?: boolean
 * }
 */
router.post('/', requireAuth, async (req, res) => {
  try {
    const { date, end_date, type, reason, note, start_time, end_time, notify_clients } = req.body;

    // Validation
    if (!date) return res.status(400).json({ error: 'date is required' });
    if (!type || !['closed', 'amended', 'extended'].includes(type)) {
      return res.status(400).json({ error: 'type must be closed, amended, or extended' });
    }
    if (!reason) return res.status(400).json({ error: 'reason is required' });

    // Build the insertion object
    const exc = {
      beautician_id: req.beautician.id,
      date,
      type,
      reason,
      note: note || null,
      notify_clients: notify_clients !== false,
      created_at: new Date().toISOString(),
    };

    // Add optional fields
    if (end_date) exc.end_date = end_date;
    if (type !== 'closed') {
      exc.start_time = start_time || null;
      exc.end_time = end_time || null;
    }

    const { data, error } = await supabase
      .from('hours_exceptions')
      .insert([exc])
      .select()
      .single();

    if (error) {
      logger.error({ err: error }, 'Failed to create hours exception');
      return res.status(500).json({ error: 'Something went wrong' });
    }
    res.status(201).json({ exception: data });
  } catch (err) {
    logger.error({ err }, 'Create hours exception error');
    res.status(500).json({ error: 'Failed to create exception' });
  }
});

/**
 * DELETE /api/hours-exceptions/:id
 * Remove an hours exception
 */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { data: existing } = await supabase
      .from('hours_exceptions')
      .select('id')
      .eq('id', req.params.id)
      .eq('beautician_id', req.beautician.id)
      .single();

    if (!existing) {
      return res.status(404).json({ error: 'Exception not found' });
    }

    const { error } = await supabase
      .from('hours_exceptions')
      .delete()
      .eq('id', req.params.id)
      .eq('beautician_id', req.beautician.id);

    if (error) {
      logger.error({ err: error }, 'Failed to delete hours exception');
      return res.status(500).json({ error: 'Something went wrong' });
    }
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Delete hours exception error');
    res.status(500).json({ error: 'Failed to delete exception' });
  }
});

export default router;
