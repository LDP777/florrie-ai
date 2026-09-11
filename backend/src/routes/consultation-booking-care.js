import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { submitConsultationFormSchema } from '../lib/schemas.js';
import { readBookingPreparation, publicPreparation, PREPARATION_APPOINTMENT_SELECT } from '../lib/booking-preparation.js';
import { CARE_RESPONSE_SELECT, consultationBookingContext, updatedCare, careCompareAndSet } from '../lib/consultation-booking-care.js';

const router = Router();
export function notifyConsultationReview(response, care) {
  if (!care.review_required || (response.booking_care?.review_required && !response.booking_care?.reviewed_at)) return;
  void import('../services/push-notifications.js').then(({ pushTeamUpdate }) => pushTeamUpdate(response.beautician_id, 'consultation_review', 'A consultation needs your review. Open Guardian to read the client’s answers.',
    { url: `/compliance?tab=records&clientId=${encodeURIComponent(response.client_id)}` })).catch(() => {});
}
router.get('/preparation/:appointmentId', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('appointments').select(PREPARATION_APPOINTMENT_SELECT)
      .eq('id', req.params.appointmentId).eq('beautician_id', req.beautician.id).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Booking not found' });
    res.json({ preparation: publicPreparation(await readBookingPreparation(supabase, data)) });
  } catch { res.status(503).json({ error: 'Preparation could not be checked. Try again.' }); }
});
router.get('/reviews/pending', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('consultation_responses')
    .select('id, client_id, appointment_id, status, booking_care, clients(first_name, last_name)')
    .eq('beautician_id', req.beautician.id).eq('booking_care->>review_required', 'true')
    .is('booking_care->>reviewed_at', null).order('created_at', { ascending: false }).limit(100);
  if (error) return res.status(503).json({ error: 'Consultation reviews could not be loaded.' });
  const appointmentIds = [...new Set((data || []).map(r => r.appointment_id).filter(Boolean))];
  const bookings = appointmentIds.length ? await supabase.from('appointments').select('id, starts_at, status').eq('beautician_id', req.beautician.id).in('id', appointmentIds) : { data: [] };
  if (bookings.error) return res.status(503).json({ error: 'The bookings for these consultation reviews could not be checked.' });
  const byId = new Map((bookings.data || []).map(a => [a.id, a]));
  res.json({ reviews: (data || []).map(r => ({ id: r.id, client_id: r.client_id, appointment_id: r.appointment_id,
    client_name: [r.clients?.first_name, r.clients?.last_name].filter(Boolean).join(' ') || 'Client',
    starts_at: byId.get(r.appointment_id)?.starts_at, booking_status: byId.get(r.appointment_id)?.status, status: r.status,
    patch_outcome: r.booking_care?.patch_outcome })) });
});
router.post('/responses/:id/review', requireAuth, async (req, res) => {
  const { data: row, error } = await supabase.from('consultation_responses').select('id, booking_care')
    .eq('id', req.params.id).eq('beautician_id', req.beautician.id).maybeSingle();
  if (error) return res.status(503).json({ error: 'Could not load the review.' });
  if (!row) return res.status(404).json({ error: 'Response not found' });
  if (req.body?.revision !== row.booking_care?.revision) return res.status(409).json({ error: 'The client has updated this form. Read the latest answers first.' });
  const care = { ...row.booking_care, reviewed_at: new Date().toISOString(), reviewed_by: req.beautician.id, revision: (row.booking_care?.revision || 0) + 1 };
  const saved = await careCompareAndSet(supabase.from('consultation_responses').update({ booking_care: care })
    .eq('id', row.id).eq('beautician_id', req.beautician.id), row).select('id').maybeSingle();
  if (saved.error || !saved.data) return res.status(409).json({ error: 'The form changed. Refresh before marking it reviewed.' });
  res.json({ reviewed: true });
});
router.post('/public/:token/draft', validate(submitConsultationFormSchema), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { data: row, error } = await supabase.from('consultation_responses').select(CARE_RESPONSE_SELECT).eq('token', req.params.token).maybeSingle();
    if (error) throw error;
    if (!row) return res.status(404).json({ error: 'Form not found' });
    if (row.status !== 'pending' || Date.parse(row.expires_at) <= Date.now()) return res.status(410).json({ error: 'This link is no longer active. Open Manage my booking to check your form.' });
    const prep = await consultationBookingContext(supabase, row);
    if (!prep) return res.status(400).json({ error: 'This form does not support saved drafts.' });
    if (req.body.revision !== (row.booking_care?.revision || 0)) return res.status(409).json({ error: 'The form was updated elsewhere. Your answers are still here; reopen it to check the latest saved version.' });
    const care = updatedCare(row, req.body, prep);
    const result = await careCompareAndSet(supabase.from('consultation_responses').update({ answers: req.body.answers, booking_care: care })
      .eq('id', row.id).eq('status', 'pending'), row).select('id').maybeSingle();
    if (result.error) throw result.error;
    if (!result.data) return res.status(409).json({ error: 'The form changed. Your answers are still here. Please check its latest status.' });
    notifyConsultationReview(row, care);
    res.json({ saved: true, revision: care.revision, review_required: care.review_required, preparation: prep.patch });
  } catch (err) { res.status(err.status || 503).json({ error: err.status ? err.message : 'Could not save your answers. They are still here. Please try again.' }); }
});
export default router;
