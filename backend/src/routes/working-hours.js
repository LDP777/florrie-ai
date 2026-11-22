import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { loadDateHours } from '../lib/date-working-hours.js';
import { validHoursDate, validHoursTime } from '../lib/effective-hours.js';
import logger from '../lib/logger.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const { from, to } = req.query;
  if (!validHoursDate(from) || !validHoursDate(to) || to < from || Date.parse(to) - Date.parse(from) > 731 * 86400000) {
    return res.status(400).json({ error: 'Choose a date range of up to two years.' });
  }
  try { res.json({ dates: await loadDateHours(req.beautician.id, from, to) }); }
  catch (err) { logger.error({ err }, 'Read dated hours failed'); res.status(503).json({ error: err.message }); }
});

// One upsert is one transaction: multiple selected dates either all save or none do.
router.put('/dates', async (req, res) => {
  const { dates, start_time, end_time } = req.body || {};
  if (Object.keys(req.body || {}).some(key => !['dates', 'start_time', 'end_time'].includes(key))) {
    return res.status(400).json({ error: 'Only dates and opening times can be changed here.' });
  }
  if (!Array.isArray(dates) || !dates.length || dates.length > 60 || dates.some(date => !validHoursDate(date)) || new Set(dates).size !== dates.length) {
    return res.status(400).json({ error: 'Choose between 1 and 60 different dates.' });
  }
  if (!validHoursTime(start_time) || !validHoursTime(end_time) || end_time.slice(0, 5) <= start_time.slice(0, 5)) {
    return res.status(400).json({ error: 'Choose a finish time after your start time on the same day.' });
  }
  try {
    const { data, error } = await supabase.from('date_working_hours').upsert(dates.map(date => ({
      beautician_id: req.beautician.id, date, start_time, end_time, updated_at: new Date().toISOString(),
    })), { onConflict: 'beautician_id,date' }).select('date, start_time, end_time');
    if (error || data?.length !== dates.length) throw error || new Error('Save not confirmed');
    res.json({ dates: data });
  } catch (err) { logger.error({ err }, 'Save dated hours failed'); res.status(503).json({ error: 'Could not save these hours. Please try again.' }); }
});

router.delete('/dates/:date', async (req, res) => {
  if (!validHoursDate(req.params.date)) return res.status(400).json({ error: 'Choose a valid date.' });
  try {
    const { error } = await supabase.from('date_working_hours').delete()
      .eq('beautician_id', req.beautician.id).eq('date', req.params.date);
    if (error) throw error;
    res.json({ restored: req.params.date });
  } catch (err) { logger.error({ err }, 'Restore usual hours failed'); res.status(503).json({ error: 'Could not restore your usual hours. Please try again.' }); }
});
export default router;
