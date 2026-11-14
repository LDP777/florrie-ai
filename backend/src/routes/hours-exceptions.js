import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';
import { exceptionRangeError } from '../lib/hours-exception-range.js';

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

    // Shared with POST /api/features/hours-exceptions, which writes the same
    // table. Two copies of this rule is how one door ended up without it.
    const endDate = typeof end_date === 'string' && end_date.trim() ? end_date.trim() : null;
    const rangeError = exceptionRangeError(date, endDate);
    if (rangeError) return res.status(400).json({ error: rangeError });

    // Build the insertion object
    const exc = {
      beautician_id: req.beautician.id,
      date,
      type,
      // The legacy is_closed column DEFAULTS TO TRUE, so it must be set
      // explicitly: an 'amended' time-range block left it true and the
      // calendar rendered every partial block as a full-day closure.
      is_closed: type === 'closed',
      reason,
      note: note || null,
      notify_clients: notify_clients !== false,
      created_at: new Date().toISOString(),
    };

    // Add optional fields. A blank end_date is a single day, not an empty range.
    if (endDate) exc.end_date = endDate;
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
 * PATCH /api/hours-exceptions/:id
 * Edit a block without replacing its identity or touching existing bookings.
 * Availability readers use the same hours_exceptions row immediately.
 */
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const body = req.body;
    const fields = ['date', 'end_date', 'type', 'reason', 'note', 'start_time', 'end_time'];
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length || Object.keys(body).some(key => !fields.includes(key))) {
      return res.status(400).json({ error: 'Choose the date, time, reason or note to update.' });
    }
    const { data: existing, error: readError } = await supabase.from('hours_exceptions')
      .select('*').eq('id', req.params.id).eq('beautician_id', req.beautician.id).maybeSingle();
    if (readError) {
      logger.error({ err: readError }, 'Failed to read hours exception before update');
      return res.status(500).json({ error: 'Could not check this block. Please try again.' });
    }
    if (!existing) return res.status(404).json({ error: 'Exception not found' });
    const value = (key, fallback = existing[key]) => Object.hasOwn(body, key) ? body[key] : fallback;
    const validDate = date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
      && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
    const date = value('date');
    const endDate = value('end_date') == null || value('end_date') === '' ? null : value('end_date');
    if (!validDate(date) || (endDate !== null && !validDate(endDate))) return res.status(400).json({ error: 'Choose a valid date.' });
    const rangeError = exceptionRangeError(date, endDate);
    if (rangeError) return res.status(400).json({ error: rangeError });
    const type = value('type', existing.type || (existing.is_closed ? 'closed' : 'amended'));
    if (!['closed', 'amended', 'extended'].includes(type)) return res.status(400).json({ error: 'type must be closed, amended, or extended' });
    const reason = value('reason');
    const note = value('note');
    if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 120) return res.status(400).json({ error: 'Choose a reason of up to 120 characters.' });
    if (note != null && (typeof note !== 'string' || note.length > 2000)) return res.status(400).json({ error: 'Notes can contain up to 2,000 characters.' });
    let start = null, end = null;
    if (type !== 'closed') {
      start = value('start_time', existing.start_time || existing.custom_start);
      end = value('end_time', existing.end_time || existing.custom_end);
      const validTime = time => typeof time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time);
      if (!validTime(start) || !validTime(end) || start.slice(0, 5) >= end.slice(0, 5)) {
        return res.status(400).json({ error: 'Choose an end time after the start time.' });
      }
    }
    const patch = {
      date, end_date: endDate, type, is_closed: type === 'closed', reason: reason.trim(), note: note?.trim() || null,
      start_time: start, end_time: end,
      // Keep legacy readers in agreement when changing between a range and all day.
      custom_start: start, custom_end: end,
    };
    const { data, error } = await supabase.from('hours_exceptions').update(patch)
      .eq('id', req.params.id).eq('beautician_id', req.beautician.id).select('*').maybeSingle();
    if (error) {
      logger.error({ err: error }, 'Failed to update hours exception');
      return res.status(500).json({ error: 'Could not save this block. Please try again.' });
    }
    if (!data) return res.status(404).json({ error: 'Exception not found' });
    res.json({ exception: data });
  } catch (err) {
    logger.error({ err }, 'Update hours exception error');
    res.status(500).json({ error: 'Could not save this block. Please try again.' });
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
