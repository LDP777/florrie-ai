import { careCompareAndSet } from '../lib/consultation-booking-care.js';
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { readBookingPreparation, publicPreparation, ensureBookingConsultations, PREPARATION_APPOINTMENT_SELECT, salonWallInstant } from '../lib/booking-preparation.js';

const router = Router({ mergeParams: true });
async function load(req) {
  const { data, error } = await supabase.from('appointments').select(PREPARATION_APPOINTMENT_SELECT)
    .eq('management_token', req.params.token).maybeSingle();
  if (error) throw new Error('Could not read your booking');
  return data?.beauticians?.booking_slug === req.params.slug ? data : null;
}
router.get('/preparation', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const appt = await load(req);
    if (!appt) return res.status(404).json({ error: 'Booking not found' });
    res.json({ preparation: publicPreparation(await readBookingPreparation(supabase, appt)) });
  } catch (err) {
    logger.warn({ message: err.message }, 'Booking preparation read failed');
    res.status(503).json({ error: 'We could not check your preparation steps. Your booking is still available. Please try again.' });
  }
});
router.post('/consultations/:formId/start', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const appt = await load(req);
    if (!appt) return res.status(404).json({ error: 'Booking not found' });
    await ensureBookingConsultations(supabase, appt);
    const prep = await readBookingPreparation(supabase, appt);
    if (!prep.confirmed) return res.status(409).json({ error: 'Confirm your booking first. Your preparation steps will appear here afterwards.' });
    const form = prep.forms.find(f => f.id === req.params.formId);
    if (!form?.response || !form.available) return res.status(404).json({ error: 'This form is not available for this booking. Please contact your tech.' });
    if (form.status === 'received') return res.json({ completed: true });
    const row = form.response;
    const expired = row.status === 'expired' || (row.expires_at && Date.parse(row.expires_at) <= Date.now());
    const token = expired ? randomUUID() : row.token;
    const ends = salonWallInstant(appt.ends_at || appt.starts_at, appt.beauticians?.timezone);
    const { data, error } = await careCompareAndSet(supabase.from('consultation_responses').update({ token, status: 'pending',
      expires_at: new Date(Date.parse(ends) + 7*86400000).toISOString(),
      booking_care: { ...(row.booking_care || {}), version: 1, revision: (row.booking_care?.revision || 0) + 1 },
    }).eq('id', row.id).eq('token', row.token).eq('status', row.status), row).select('id').maybeSingle();
    if (error) throw new Error('Could not open your consultation');
    if (!data) return res.status(409).json({ error: 'This form has changed. Refresh your preparation steps.' });
    res.json({ token });
  } catch (err) {
    logger.warn({ message: err.message }, 'Booking consultation start failed');
    res.status(503).json({ error: 'We could not open your consultation. Please try again.' });
  }
});
export default router;
