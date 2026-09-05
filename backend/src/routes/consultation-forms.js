import { Router } from 'express';
import crypto from 'crypto';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { sendSMS } from '../services/notifications.js';
import logger from '../lib/logger.js';
import { handleQueryError } from '../lib/queries.js';
import { requireOwned } from '../lib/ownership.js';
import { missingConsultationFields, consultationCoverage } from '../lib/consultation-care.js';
import { shapeResponse } from '../lib/consultation-answers.js';
import {
  DEFAULT_BOOKING_QUESTIONS,
  DEFAULT_BOOKING_FORM_NAME,
  groupAnswersByForm,
  splitDefaultAnswers,
  mapDefaultAnswersToFields,
} from '../lib/client-notes.js';
import {
  createConsultationFormSchema,
  submitConsultationFormSchema
} from '../lib/schemas.js';
import { authorship } from '../lib/authorship.js';

const router = Router();
const FRONTEND_URL = process.env.FRONTEND_URL;

// ═══════════════════════════════════════════════
// BEAUTICIAN FORM MANAGEMENT (auth required)
// ═══════════════════════════════════════════════

/**
 * GET /api/consultation-forms
 * List all forms for the authenticated beautician.
 */
router.get('/', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('consultation_forms')
    .select('*, consultation_form_fields(count)')
    .eq('beautician_id', req.beautician.id)
    .eq('is_active', true)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ err: error }, 'Failed to fetch consultation forms');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ forms: data || [] });
});

/**
 * GET /api/consultation-forms/:id
 * Get a single form with all its fields.
 */
router.get('/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('consultation_forms')
    .select('*, consultation_form_fields(*)')
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Form not found' });

  // Sort fields by sort_order
  if (data.consultation_form_fields) {
    data.consultation_form_fields.sort((a, b) => a.sort_order - b.sort_order);
  }

  res.json({ form: data });
});

/**
 * POST /api/consultation-forms
 * Create a new consultation form with fields.
 */
async function saveTemplate(req, res) {
  const parsed = (req.params.id ? createConsultationFormSchema.partial() : createConsultationFormSchema).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Check the form name and questions before saving.' });
  if (req.params.id && !await requireOwned(req, res, [{ table: 'consultation_forms', id: req.params.id }])) return;
  const { data: id, error } = await supabase.rpc('save_consultation_template', {
    p_owner: req.beautician.id, p_id: req.params.id || null, p_form: parsed.data,
  });
  if (error) {
    logger.error({ err: error }, 'Failed to save consultation template');
    return res.status(500).json({ error: 'Could not save this template. Your existing form and responses have been kept.' });
  }
  const { data: form, error: readError } = await supabase.from('consultation_forms')
    .select('*, consultation_form_fields(*)').eq('id', id).eq('beautician_id', req.beautician.id).single();
  if (handleQueryError(readError, res, 'read saved consultation template')) return;
  res.status(req.params.id ? 200 : 201).json({ form });
}
router.post('/', requireAuth, saveTemplate);
router.patch('/:id', requireAuth, saveTemplate);

/**
 * DELETE /api/consultation-forms/:id
 * Soft-delete (deactivate) a form.
 */
router.delete('/:id', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('consultation_forms')
    .update({ is_active: false, is_default: false })
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id);

  if (error) {
    logger.error({ err: error }, 'Failed to delete consultation form');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ success: true });
});

/**
 * The join that makes a submission readable.
 *
 * The answers blob is keyed by field id, so without the field definitions it
 * is a wall of uuids. signature_data is selected only so the row knows whether
 * one exists: the blob itself never leaves in a list payload.
 */
const RESPONSE_SELECT =
  'id, form_id, client_id, appointment_id, status, completed_at, created_at, answers, signature_data, form_snapshot, ' +
  'consultation_forms(name, consent_text, consultation_form_fields(id, type, label, options, sort_order))';

/**
 * GET /api/consultation-forms/responses/list?client_id=&appointment_id=
 *
 * Every completed submission, newest first, already paired up with the
 * questions that produced it. The pairing happens here rather than in the app
 * so the flagging rules are tested once, server side, instead of living in a
 * component nobody can run in isolation.
 *
 * Health data, so: authenticated, scoped to this beautician on the query
 * itself, and any id that arrived in the request is checked against this
 * account before a single answer is read.
 */
router.get('/responses/list', requireAuth, async (req, res) => {
  const { client_id, appointment_id } = req.query;

  // The ids come from the request, so they are somebody's guess until proven
  // otherwise. A wrong-tenant client_id must not return that tenant's
  // allergies.
  if (!await requireOwned(req, res, [
    { table: 'clients', id: client_id },
    { table: 'appointments', id: appointment_id },
  ])) return;

  let query = supabase
    .from('consultation_responses')
    .select(RESPONSE_SELECT)
    .eq('beautician_id', req.beautician.id)
    .eq('status', 'completed')
    .order('completed_at', { ascending: false });

  if (client_id) query = query.eq('client_id', client_id);
  if (appointment_id) query = query.eq('appointment_id', appointment_id);

  const { data, error } = await query;
  // Checked, always. An unchecked select here returns null on one wrong
  // column name and the section renders "no consultation form yet" for a
  // client who filled one in, which is the worst possible lie on this screen.
  if (handleQueryError(error, res, 'fetch consultation responses')) return;

  let requestsQuery = supabase.from('consultation_responses')
    .select('id, form_id, client_id, appointment_id, status, completed_at, created_at, expires_at, form_snapshot, consultation_forms(name)')
    .eq('beautician_id', req.beautician.id).in('status', ['pending', 'expired']).order('created_at', { ascending: false });
  if (client_id) requestsQuery = requestsQuery.eq('client_id', client_id);
  if (appointment_id) requestsQuery = requestsQuery.eq('appointment_id', appointment_id);
  const [{ data: requests, error: requestError }, { data: templates, error: templateError }] = await Promise.all([
    requestsQuery, supabase.from('consultation_forms').select('id, name, is_default').eq('beautician_id', req.beautician.id).eq('is_active', true).order('name'),
  ]);
  if (handleQueryError(requestError || templateError, res, 'read consultation requests')) return;
  res.json({
    responses: (data || []).map(shapeResponse),
    requests: (requests || []).map(r => ({ id: r.id, form_id: r.form_id, client_id: r.client_id,
      appointment_id: r.appointment_id, form_name: r.form_snapshot?.name || r.consultation_forms?.name || 'Consultation form',
      status: r.completed_at ? 'answers_removed' : r.status === 'expired' || (r.expires_at && new Date(r.expires_at) < new Date()) ? 'expired' : 'pending',
      sent_at: r.created_at, expires_at: r.expires_at })),
    templates: templates || [],
    form_available: (templates || []).length > 0,
  });
});

/**
 * GET /api/consultation-forms/responses/:id
 *
 * One submission, including the signature image. Fetched on demand rather
 * than shipped with every list, because a base64 png per row turns a client
 * profile into a megabyte of scribble she did not ask to download.
 */
router.get('/responses/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('consultation_responses')
    .select(RESPONSE_SELECT)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .maybeSingle();

  if (error) {
    logger.error({ err: error }, 'Failed to fetch consultation response');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  if (!data) return res.status(404).json({ error: 'Response not found' });

  res.json({
    response: { ...shapeResponse(data), signature_data: data.signature_data || null },
  });
});

/**
 * GET /api/consultation-forms/for-appointment/:appointmentId
 *
 * Everything the appointment sheet needs in one call: does anything booked
 * today require a consultation, is there a form on file for this client, and
 * what did they answer that is worth knowing before they sit down.
 *
 * The form is looked up by CLIENT, not by appointment. A regular fills one in
 * once, at their first booking, and it is still the form on file two years
 * later. Scoping to appointment_id would tell her "nothing on file" for every
 * client she has.
 */
router.get('/for-appointment/:appointmentId', requireAuth, async (req, res) => {
  const { data: appt, error: apptErr } = await supabase
    .from('appointments')
    .select('id, client_id, treatment_id, extra_treatment_ids')
    .eq('id', req.params.appointmentId)
    .eq('beautician_id', req.beautician.id)
    .maybeSingle();

  if (apptErr) {
    logger.error({ err: apptErr }, 'Failed to fetch appointment for consultation lookup');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });

  // Extras count. A brow tint added on the day can be the treatment that
  // needs the consultation, and it lives in extra_treatment_ids, not
  // treatment_id.
  const treatmentIds = [
    appt.treatment_id,
    ...(Array.isArray(appt.extra_treatment_ids) ? appt.extra_treatment_ids : []),
  ].filter(Boolean);

  let requiresConsultation = false;
  let treatments = [];
  if (treatmentIds.length > 0) {
    const { data: treats, error: tErr } = await supabase
      .from('treatments')
      .select('id, requires_consultation, consultation_form_id')
      .in('id', treatmentIds)
      .eq('beautician_id', req.beautician.id);
    // A failed lookup must not read as "no consultation needed". Better to
    // fail the call and show her nothing than to quietly reassure her.
    if (handleQueryError(tErr, res, 'fetch treatments for consultation lookup')) return;
    treatments = treats || [];
    requiresConsultation = treatments.some(t => t.requires_consultation === true);
  }

  let response = null;
  let missingFormIds = treatments.filter(t => t.requires_consultation).map(t => t.consultation_form_id).filter(Boolean);
  if (appt.client_id) {
    const { data: rows, error: rErr } = await supabase
      .from('consultation_responses')
      .select(RESPONSE_SELECT)
      .eq('beautician_id', req.beautician.id)
      .eq('client_id', appt.client_id)
      .eq('status', 'completed')
      .order('completed_at', { ascending: false });
    if (handleQueryError(rErr, res, 'fetch consultation response for appointment')) return;
    const coverage = consultationCoverage(treatments, rows || []);
    missingFormIds = coverage.missing.map(t => t.consultation_form_id).filter(Boolean);
    if (coverage.covered && (rows || []).length) {
      const relevant = (rows || []).find(r => !coverage.required.length || coverage.required.some(t => !t.consultation_form_id || t.consultation_form_id === r.form_id));
      if (relevant) response = shapeResponse(relevant);
    }
  }

  // A form that has been SENT and not yet filled in was invisible here: the
  // lookup above only asks for status 'completed'. So the card said "there is
  // nothing on file for Shauna" and offered a primary "Send them the form"
  // button an hour after one had gone out.
  //
  // That is the other half of Ellie sending Shauna two. The first half was a
  // TypeError reporting a 500 for a text that had already arrived; even with
  // that fixed, nothing on this screen would have told her a form was already
  // waiting. She would have had no reason not to tap it again.
  let pending = null;
  let requests = [];
  if (!response && appt.client_id) {
    let pendingQuery = supabase
      .from('consultation_responses')
      .select('id, created_at, expires_at, form_id, status')
      .eq('beautician_id', req.beautician.id)
      .eq('client_id', appt.client_id)
      .in('status', ['pending', 'expired']).is('completed_at', null)
      .order('created_at', { ascending: false });
    if (missingFormIds.length) pendingQuery = pendingQuery.in('form_id', missingFormIds);
    const { data: pendingRows, error: pErr } = await pendingQuery;
    if (handleQueryError(pErr, res, 'fetch pending consultation for appointment')) return;
    requests = pendingRows || [];
    const row = requests[0];
    if (row) {
      // No token. It is the only credential guarding special-category health
      // data, and this endpoint's answer ends up in a client-side state object.
      pending = {
        sent_at: row.created_at,
        expires_at: row.expires_at,
        expired: row.status === 'expired' || (row.expires_at ? new Date(row.expires_at).getTime() < Date.now() : false),
      };
    }
  }

  const { data: templates, error: templatesError } = await supabase.from('consultation_forms')
    .select('id, name, is_default').eq('beautician_id', req.beautician.id).eq('is_active', true);
  if (handleQueryError(templatesError, res, 'read available consultation templates')) return;
  const needed = missingFormIds.length ? missingFormIds : (templates || []).filter(t => t.is_default).map(t => t.id);
  const missingForms = response ? [] : needed.map(id => {
    const template = (templates || []).find(t => t.id === id);
    const request = requests.find(r => r.form_id === id);
    const activeRequest = request && request.status === 'pending' && (!request.expires_at || new Date(request.expires_at) > new Date());
    return { form_id: id, form_name: template?.name || 'Unavailable template',
      status: activeRequest ? 'awaiting_response' : !template ? 'template_unavailable' : request ? 'link_expired' : 'not_requested' };
  });
  res.json({
    requires_consultation: requiresConsultation,
    response,
    pending,
    missing_forms: missingForms,
    form_available: missingForms.some(f => f.status === 'not_requested' || f.status === 'link_expired'),
  });
});

/**
 * POST /api/consultation-forms/send
 * Body: { client_id, appointment_id? }
 *
 * Sends the client the same form link the booking flow sends, using the same
 * sender. There is deliberately no second implementation of "text them a
 * form": one sender means one set of rules about which form, how long the
 * link lives, and what gets logged.
 */
router.post('/send', requireAuth, async (req, res) => {
  const { client_id, appointment_id, form_id } = req.body || {};
  if (!client_id) return res.status(400).json({ error: 'Which client?' });

  if (!await requireOwned(req, res, [
    { table: 'clients', id: client_id },
    { table: 'appointments', id: appointment_id },
    { table: 'consultation_forms', id: form_id },
  ])) return;

  const { data: client, error: cErr } = await supabase
    .from('clients')
    .select('id, first_name, phone')
    .eq('id', client_id)
    .eq('beautician_id', req.beautician.id)
    .maybeSingle();

  if (handleQueryError(cErr, res, 'fetch client for consultation form send')) return;
  if (!client) return res.status(404).json({ error: 'Not found' });
  if (!client.phone) {
    return res.status(400).json({ error: 'No mobile number on file for this client, so there is nowhere to send it.' });
  }

  // The treatment decides which form: a treatment-specific one wins over the
  // default, and that rule lives in the sender.
  let treatmentId = null;
  let extraTreatmentIds = [];
  if (appointment_id) {
    const { data: appt, error: aErr } = await supabase
      .from('appointments')
      .select('id, client_id, treatment_id, extra_treatment_ids')
      .eq('id', appointment_id)
      .eq('beautician_id', req.beautician.id)
      .maybeSingle();
    if (handleQueryError(aErr, res, 'fetch appointment for consultation form send')) return;
    if (!appt || appt.client_id !== client_id) return res.status(400).json({ error: 'This booking belongs to a different client.' });
    treatmentId = appt.treatment_id || null;
    extraTreatmentIds = appt.extra_treatment_ids || [];
  }

  try {
    const sent = await sendConsultationFormSMS({
      beauticianId: req.beautician.id,
      clientId: client.id,
      appointmentId: appointment_id || null,
      clientPhone: client.phone,
      clientFirstName: client.first_name || 'there',
      treatmentId, extraTreatmentIds, formId: form_id, skipCompleted: !!appointment_id && !form_id,
      beauticianName: req.beautician.business_name || req.beautician.first_name || 'your beautician',
    });

    if (!sent) {
      return res.status(400).json({
        error: 'No consultation form set up yet. Build one and mark it as your default, then you can send it.',
      });
    }
    if (sent.already_completed) return res.status(409).json({ error: 'The required forms are already on this client’s record.' });
    if (sent.already_pending) return res.status(409).json({ error: 'This client already has an active request for this form. Check their consultation records.', already_pending: true });
    // Ids only. The answers do not exist yet, and the token never gets logged.
    logger.info({ clientId: client.id }, 'Consultation form sent from the app');
    res.json({ sent: true });
  } catch (err) {
    logger.error({ err }, 'Failed to send consultation form');
    res.status(500).json({ error: 'Could not send the form just now. Try again in a moment.' });
  }
});

// ═══════════════════════════════════════════════
// PUBLIC FORM ACCESS (no auth — token-based)
// ═══════════════════════════════════════════════

/**
 * GET /api/consultation-forms/public/:token
 * Load a consultation form by token. No auth required.
 * Returns the form structure + client name for personalisation.
 */
router.get('/public/:token', async (req, res) => {
  const { data: response, error } = await supabase
    .from('consultation_responses')
    .select('id, status, expires_at, form_id, form_snapshot, consultation_forms(name, consent_text, consultation_form_fields(*)), clients(first_name), beauticians(business_name, first_name, brand_color, logo_url)')
    .eq('token', req.params.token)
    .maybeSingle();

  // Logged, never with the token: the token IS the credential guarding this
  // form. The client still sees the same "not found", because an unreadable
  // token and a wrong token must look identical from outside.
  if (error) logger.warn({ err: error }, 'Public consultation form lookup failed');
  if (!response) return res.status(404).json({ error: 'Form not found or link has expired' });

  if (response.status === 'completed') return res.json({ completed: true });

  // Check expiry
  if (response.expires_at && new Date(response.expires_at) < new Date()) {
    await supabase
      .from('consultation_responses')
      .update({ status: 'expired' })
      .eq('id', response.id).eq('status', 'pending');
    return res.status(410).json({ error: 'This form link has expired. Please contact your beautician for a new link.' });
  }

  // Already completed
  if (response.status === 'completed') {
    return res.json({ completed: true, message: 'You have already submitted this form. Thank you!' });
  }

  // Sort fields
  const form = response.form_snapshot || response.consultation_forms;
  if (form?.consultation_form_fields) {
    form.consultation_form_fields.sort((a, b) => a.sort_order - b.sort_order);
  }

  res.json({
    form: {
      name: form.name,
      consent_text: form.consent_text,
      fields: form.consultation_form_fields || [],
    },
    client_name: response.clients?.first_name || null,
    beautician: {
      name: response.beauticians?.business_name || response.beauticians?.first_name,
      brand_color: response.beauticians?.brand_color,
      logo: response.beauticians?.logo_url,
    },
  });
});

/**
 * POST /api/consultation-forms/public/:token/submit
 * Submit a completed consultation form. No auth required.
 */
router.post('/public/:token/submit', validate(submitConsultationFormSchema), async (req, res) => {
  const { answers, signature_data } = req.body;

  // Load response
  const { data: response } = await supabase
    .from('consultation_responses')
    .select('id, status, expires_at, form_id, form_snapshot')
    .eq('token', req.params.token)
    .single();

  if (!response) return res.status(404).json({ error: 'Form not found' });
  if (response.status === 'completed') return res.status(400).json({ error: 'Form already submitted' });
  if (response.status !== 'pending') return res.status(410).json({ error: 'This form link is no longer active.' });
  if (response.expires_at && new Date(response.expires_at) < new Date()) {
    return res.status(410).json({ error: 'Form link has expired' });
  }

  let fields = response.form_snapshot?.consultation_form_fields;
  if (!fields) {
    const { data, error } = await supabase.from('consultation_form_fields').select('id, type, required, label').eq('form_id', response.form_id);
    if (handleQueryError(error, res, 'read required consultation questions')) return;
    fields = data;
  }
  const missingFields = missingConsultationFields(fields, answers, signature_data).map(f => f.label);

  if (missingFields.length > 0) {
    return res.status(400).json({
      error: 'Please complete all required fields',
      missing: missingFields,
    });
  }

  // Save
  const { data: saved, error } = await supabase
    .from('consultation_responses')
    .update({
      answers,
      signature_data,
      status: 'completed',
      completed_at: new Date().toISOString(),
    })
    .eq('id', response.id).eq('status', 'pending').select('id').maybeSingle();

  if (error) return res.status(500).json({ error: 'Failed to save form' });
  if (!saved) return res.status(409).json({ error: 'This form has already changed. Refresh to check its status.' });

  res.json({ success: true, message: 'Thank you, your form has been submitted.' });
});

// ═══════════════════════════════════════════════
// SEND FORM LINK (used internally after booking)
// ═══════════════════════════════════════════════

/**
 * Send a consultation form SMS to a client.
 * Called internally by the booking route for first-time clients.
 *
 * @param {{beauticianId: string, clientId: string, appointmentId: string, clientPhone: string, clientFirstName: string, treatmentId: string, beauticianName: string}} opts
 * @param {string} opts.beauticianId - UUID of the beautician
 * @param {string} opts.clientId - UUID of the client
 * @param {string} opts.appointmentId - UUID of the appointment
 * @param {string} opts.clientPhone - phone number to send SMS to
 * @param {string} opts.clientFirstName - client's first name for personalization
 * @param {string} opts.treatmentId - UUID used to find treatment-specific form
 * @param {string} opts.beauticianName - beautician's name for SMS personalization
 * @returns {Promise<{id: string, form_id: string, token: string, status: string, expires_at: string, created_at: string}|null>} consultation response record or null if no form configured
 */
export async function sendConsultationFormSMS({
  beauticianId, clientId, appointmentId, clientPhone, clientFirstName,
  treatmentId, beauticianName, extraTreatmentIds = [], formId: requestedFormId = null, skipCompleted = false,
}) {
  // Resolve an explicit choice, or every form required by this booking.
  let formIds = requestedFormId ? [requestedFormId] : [];
  if (!requestedFormId && (treatmentId || extraTreatmentIds.length)) {
    const { data: treatments, error } = await supabase.from('treatments').select('consultation_form_id')
      .eq('beautician_id', beauticianId).in('id', [treatmentId, ...extraTreatmentIds].filter(Boolean));
    if (error) throw error;
    formIds = [...new Set((treatments || []).map(t => t.consultation_form_id).filter(Boolean))];
  }
  if (!formIds.length) {
    const { data, error } = await supabase.from('consultation_forms').select('id')
      .eq('beautician_id', beauticianId).eq('is_default', true).eq('is_active', true).maybeSingle();
    if (error) throw error;
    if (data) formIds = [data.id];
  }
  if (!formIds.length) return null;
  if (skipCompleted) {
    const { data: completed, error } = await supabase.from('consultation_responses').select('form_id')
      .eq('beautician_id', beauticianId).eq('client_id', clientId).eq('status', 'completed').in('form_id', formIds);
    if (error) throw error;
    const done = new Set((completed || []).map(r => r.form_id));
    formIds = formIds.filter(id => !done.has(id));
    if (!formIds.length) return { already_completed: true };
  }
  const { data: available, error: availableError } = await supabase.from('consultation_forms').select('id')
    .eq('beautician_id', beauticianId).eq('is_active', true).in('id', formIds);
  if (availableError) throw availableError;
  if (available?.length !== formIds.length) return null;
  // Each extra treatment can ask a different set of questions.
  if (formIds.length > 1) {
    const sent = [];
    for (const id of formIds) sent.push(await sendConsultationFormSMS({ beauticianId, clientId, appointmentId,
      clientPhone, clientFirstName, beauticianName, formId: id }));
    return { ...sent[0], already_pending: sent.every(r => r.already_pending) };
  }
  const formId = formIds[0];
  const { data: waiting, error: waitingError } = await supabase.from('consultation_responses')
    .select('id, form_id, expires_at').eq('beautician_id', beauticianId).eq('client_id', clientId)
    .eq('form_id', formId).eq('status', 'pending').order('created_at', { ascending: false });
  if (waitingError) throw waitingError;
  const existing = (waiting || []).find(r => !r.expires_at || new Date(r.expires_at) > new Date());
  if (existing) return { id: existing.id, form_id: formId, already_pending: true };

  // 2. Create a response record with a unique token
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const { data: response, error } = await supabase
    .from('consultation_responses')
    .insert({
      form_id: formId,
      beautician_id: beauticianId,
      client_id: clientId,
      appointment_id: appointmentId,
      token,
      status: 'pending',
      expires_at: expiresAt.toISOString(),
    })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Failed to create consultation response');
    throw error;
  }

  // 3. Send SMS with link
  const formUrl = `${FRONTEND_URL}/form/${token}`;
  const smsBody = `Hi ${clientFirstName}, ${beauticianName} needs you to fill in a quick consultation form before your appointment. It takes about 2 minutes:\n\n${formUrl}`;

  try {
    const delivery = await sendSMS({ to: clientPhone, body: smsBody, beauticianId });
    if (!delivery) throw new Error('The text service did not accept this request');
  } catch (deliveryError) {
    const { error: cleanupError } = await supabase.from('consultation_responses').delete().eq('id', response.id).eq('status', 'pending').select('id').maybeSingle();
    if (cleanupError) logger.error({ err: cleanupError }, 'Could not remove unsent consultation request');
    throw deliveryError;
  }

  // Log message.
  //
  // This line used to end `.catch(() => {}); // non-fatal`, and it was the
  // most fatal line in the function. A Supabase query builder implements
  // then() and nothing else — no catch, no finally — so `.catch` is undefined
  // and calling it throws a TypeError, HERE, after the response row is written
  // and after the SMS has gone. The route turned that into a 500 and the sheet
  // said "Could not send the form just now."
  //
  // Ellie read that, and sent Shauna the form a second time. The text had
  // already arrived; she found it in the message history afterwards.
  //
  // Genuinely non-fatal now: PostgREST reports failure by RESOLVING with an
  // error rather than rejecting, so the way to not care about a write is to
  // read the error and decline to act on it, which is what this does.
  const { error: logErr } = await supabase.from('messages').insert({
    beautician_id: beauticianId,
    client_id: clientId,
    direction: 'outbound',
    channel: 'sms',
    content: smsBody,
    ...authorship('template'),
  });
  if (logErr) logger.warn({ err: logErr, clientId }, 'Consultation form SMS sent but not logged to the thread');

  // Do not log the token: it is the only credential guarding the public
  // consultation form (special-category health data).
  logger.info({ clientId, formId }, 'Consultation form SMS sent');
  return response;
}

/**
 * Find (or create) the form that backs the booking page's built in questions.
 *
 * The booking page asks five hard coded questions when a treatment needs a
 * consultation but has no form linked to it, and it posts the answers keyed by
 * short names rather than field ids. consultation_responses.form_id is NOT
 * NULL and every reader pairs answers to questions through
 * consultation_form_fields, so an answer with no form behind it cannot be
 * displayed by anything. A real form is the only way those answers become
 * readable, so one is created from the same list the page renders.
 *
 * It is a normal form afterwards: she can open it, edit it, add to it. The
 * re-keying matches on label, so editing a label unhooks that one question
 * rather than filing future answers under the wrong one.
 *
 * @param {string} beauticianId
 * @returns {Promise<{formId: string, fields: Array<{id: string, label: string}>}|null>}
 */
async function ensureDefaultBookingForm(beauticianId) {
  const { data: existing, error: findErr } = await supabase
    .from('consultation_forms')
    .select('id, consultation_form_fields(id, label)')
    .eq('beautician_id', beauticianId)
    .eq('name', DEFAULT_BOOKING_FORM_NAME)
    .order('created_at', { ascending: true })
    .limit(1);

  // Checked, always. An unchecked lookup here reads as "no form yet" and
  // quietly creates a second copy of the same form on every booking.
  if (findErr) {
    logger.error({ err: findErr, beauticianId }, 'Could not look up the booking questions form');
    return null;
  }

  if ((existing || []).length > 0) {
    return {
      formId: existing[0].id,
      fields: existing[0].consultation_form_fields || [],
    };
  }

  const { data: form, error: formErr } = await supabase
    .from('consultation_forms')
    .insert({
      beautician_id: beauticianId,
      name: DEFAULT_BOOKING_FORM_NAME,
      // Not the default form: is_default decides what gets texted to every
      // first time client, and this one exists to hold answers already given,
      // not to start sending anything new.
      is_default: false,
      is_active: true,
    })
    .select('id')
    .single();

  if (formErr || !form) {
    logger.error({ err: formErr, beauticianId }, 'Could not create the booking questions form');
    return null;
  }

  const fieldRows = DEFAULT_BOOKING_QUESTIONS.map((q, i) => ({
    form_id: form.id,
    type: q.type,
    label: q.label,
    options: [],
    required: false,
    sort_order: i,
  }));

  const { data: fields, error: fieldsErr } = await supabase
    .from('consultation_form_fields')
    .insert(fieldRows)
    .select('id, label');

  if (fieldsErr || !fields) {
    logger.error({ err: fieldsErr, beauticianId }, 'Could not create the booking questions fields');
    return null;
  }

  logger.info({ beauticianId, formId: form.id }, 'Created the booking questions form');
  return { formId: form.id, fields };
}

/**
 * Record consultation answers given during a booking.
 *
 * WHY THIS EXISTS
 * Found while surfacing consultation forms. The public booking page collects
 * consultation answers inline and used to store them as a JSON string in
 * appointments.client_notes, which meant they never reached
 * consultation_responses and no consultation surface could see them. This
 * writes the same row POST /public/:token/submit writes, so a form filled in
 * at booking and a form filled in from a text message end up as one readable
 * thing.
 *
 * Never throws and never blocks a booking. A booking that fails because a
 * consultation row could not be written would be a worse bug than the one
 * being fixed, so the caller is told what was not recorded and keeps it.
 *
 * Nothing here logs an answer. Ids and counts only.
 *
 * @param {object} args
 * @param {string} args.beauticianId
 * @param {string} args.clientId
 * @param {string} args.appointmentId
 * @param {object|null} args.answers keyed by field id, or by the booking
 *   page's built in question keys when no form is linked
 * @param {string[]} [args.formIds] forms linked to the treatments booked
 * @returns {Promise<{recorded: number, unrecorded: object, failed: boolean}>}
 *   unrecorded holds any answer that could not be filed, so the caller can
 *   keep it rather than lose it
 */
export async function recordBookingConsultation({
  beauticianId, clientId, appointmentId, answers, formIds = [],
}) {
  const blob = (answers && typeof answers === 'object' && !Array.isArray(answers)) ? answers : {};
  if (!beauticianId || !appointmentId || Object.keys(blob).length === 0) {
    return { recorded: 0, unrecorded: {}, failed: false };
  }

  try {
    // Idempotent: a booking that is retried, or a backfill run twice, must not
    // leave the same client with two copies of the same medical answers.
    const { data: already, error: alreadyErr } = await supabase
      .from('consultation_responses')
      .select('id')
      .eq('appointment_id', appointmentId)
      .eq('status', 'completed')
      .limit(1);

    if (alreadyErr) {
      logger.error({ err: alreadyErr, appointmentId }, 'Could not check for an existing consultation response');
      return { recorded: 0, unrecorded: blob, failed: true };
    }
    if ((already || []).length > 0) {
      return { recorded: 0, unrecorded: {}, failed: false };
    }

    // Only forms this account owns. The ids arrive from treatments that were
    // already scoped to her, but health data is not the place to assume that
    // holds one refactor from now.
    let forms = [];
    const wanted = [...new Set((formIds || []).filter(Boolean).map(String))];
    if (wanted.length > 0) {
      const { data: formRows, error: formsErr } = await supabase
        .from('consultation_forms')
        .select('id, consultation_form_fields(id, type)')
        .eq('beautician_id', beauticianId)
        .in('id', wanted);

      if (formsErr) {
        logger.error({ err: formsErr, appointmentId }, 'Could not load consultation forms for a booking');
        return { recorded: 0, unrecorded: blob, failed: true };
      }
      forms = (formRows || []).map(f => ({ id: f.id, fields: f.consultation_form_fields || [] }));
    }

    const { groups, unmatched } = groupAnswersByForm({ forms, answers: blob });
    const { defaults, leftover } = splitDefaultAnswers(unmatched);
    const unrecorded = { ...leftover };

    if (Object.keys(defaults).length > 0) {
      const backing = await ensureDefaultBookingForm(beauticianId);
      if (!backing) {
        Object.assign(unrecorded, defaults);
      } else {
        const mapped = mapDefaultAnswersToFields({ answers: defaults, fields: backing.fields });
        Object.assign(unrecorded, mapped.unmapped);
        if (Object.keys(mapped.answers).length > 0) {
          groups.push({ form_id: backing.formId, answers: mapped.answers, signature: null });
        }
      }
    }

    if (groups.length === 0) {
      return { recorded: 0, unrecorded, failed: false };
    }

    const completedAt = new Date().toISOString();
    const rows = groups.map(g => ({
      form_id: g.form_id,
      beautician_id: beauticianId,
      client_id: clientId || null,
      appointment_id: appointmentId,
      // token is UNIQUE NOT NULL and is the credential guarding the public
      // form. This row is already completed, so the link it unlocks only ever
      // says "you have already submitted this form".
      token: crypto.randomUUID(),
      answers: g.answers,
      signature_data: g.signature || null,
      status: 'completed',
      completed_at: completedAt,
      expires_at: null,
    }));

    const { data: inserted, error: insErr } = await supabase
      .from('consultation_responses')
      .insert(rows)
      .select('id');

    if (insErr) {
      logger.error({ err: insErr, appointmentId }, 'Could not save consultation answers given at booking');
      return { recorded: 0, unrecorded: blob, failed: true };
    }

    // Counts and ids. The answers themselves never reach a log line.
    logger.info(
      { appointmentId, clientId, responses: (inserted || []).length, unrecorded: Object.keys(unrecorded).length },
      'Consultation answers from a booking saved to consultation_responses'
    );

    return { recorded: (inserted || []).length, unrecorded, failed: false };
  } catch (err) {
    logger.error({ err, appointmentId }, 'Consultation answer write threw');
    return { recorded: 0, unrecorded: blob, failed: true };
  }
}

export default router;
